import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------
// Materials (ported from src/lib/materials.ts)
// ---------------------------------------------------------------------------
const MATERIAL_PRESETS = {
  m_carpaint: { color: "#e74c3c", metalness: 0.6, roughness: 0.28 },
  m_asphalt: { color: "#3f3f46", metalness: 0.0, roughness: 0.95 },
  m_regolith: { color: "#9b9a97", metalness: 0.0, roughness: 1.0 },
  m_moonrock: { color: "#6e6d6a", metalness: 0.05, roughness: 0.9 },
  m_metal: { color: "#b8c0c8", metalness: 0.9, roughness: 0.32 },
};

function materialProps(materialId, registry) {
  if (!materialId) return null;
  if (registry && registry[materialId]) return registry[materialId];
  if (MATERIAL_PRESETS[materialId]) return MATERIAL_PRESETS[materialId];
  return null;
}

// ---------------------------------------------------------------------------
// Geometry (ported from src/components/viewport/geometry.tsx)
// ---------------------------------------------------------------------------
function makeGeometry(type) {
  switch (type) {
    case "sphere":
      return new THREE.SphereGeometry(0.6, 32, 32);
    case "plane":
      return new THREE.BoxGeometry(20, 0.05, 20);
    case "cylinder":
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
    case "cone":
      return new THREE.ConeGeometry(0.6, 1.2, 32);
    case "torus":
      return new THREE.TorusGeometry(0.6, 0.18, 16, 48);
    case "capsule":
      return new THREE.CapsuleGeometry(0.4, 0.8, 8, 16);
    case "cube":
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function isLoadableModel(url) {
  if (!url) return false;
  return /\.(glb|gltf)(\?.*)?$/i.test(url) || url.startsWith("blob:") || url.startsWith("data:");
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// ---------------------------------------------------------------------------
// Scene graph
// ---------------------------------------------------------------------------

let cameraInfo = null;
const objectById = new Map();
const sceneObjectById = new Map();
const mixers = []; // AnimationMixer for each GLB that has clips

function placeholderMesh(color) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: color ?? "#d4d4d8", metalness: 0.4, roughness: 0.4 })
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Downgrade MeshPhysicalMaterial → MeshStandardMaterial to stay within
// WebGL's MAX_TEXTURE_IMAGE_UNITS=16 limit. Physical materials with
// clearcoat/iridescence/transmission/sheen maps can require 20+ samplers.
function downgradeMaterial(mat) {
  if (!(mat && mat.isMeshPhysicalMaterial)) return mat;
  const std = new THREE.MeshStandardMaterial({
    color: mat.color,
    map: mat.map,
    normalMap: mat.normalMap,
    normalScale: mat.normalScale,
    roughnessMap: mat.roughnessMap,
    metalnessMap: mat.metalnessMap,
    aoMap: mat.aoMap,
    aoMapIntensity: mat.aoMapIntensity,
    emissive: mat.emissive,
    emissiveMap: mat.emissiveMap,
    emissiveIntensity: mat.emissiveIntensity,
    metalness: mat.metalness,
    roughness: mat.roughness,
    opacity: mat.opacity,
    transparent: mat.transparent,
    alphaMap: mat.alphaMap,
    side: mat.side,
    envMapIntensity: mat.envMapIntensity,
  });
  mat.dispose();
  return std;
}

function downgradeMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) {
      o.material = o.material.map(downgradeMaterial);
    } else {
      o.material = downgradeMaterial(o.material);
    }
  });
}

function applyMaterialOverride(root, materialId, registry) {
  const props = materialId ? materialProps(materialId, registry) : null;
  if (!props) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      if (!m) return;
      m.color = new THREE.Color(props.color);
      if ("metalness" in m) m.metalness = props.metalness;
      if ("roughness" in m) m.roughness = props.roughness;
      if (props.emissive) {
        m.emissive = new THREE.Color(props.emissive);
        m.emissiveIntensity = props.emissiveIntensity ?? 1;
      }
      m.needsUpdate = true;
    });
  });
}

function buildNode(obj, materialRegistry) {
  if (obj.visible === false) return null;

  const group = new THREE.Group();
  group.name = obj.id;
  objectById.set(obj.id, group);
  sceneObjectById.set(obj.id, obj);

  const [px, py, pz] = obj.transform.position;
  const [rx, ry, rz] = obj.transform.rotation;
  const [sx, sy, sz] = obj.transform.scale;
  group.position.set(px, py, pz);
  group.rotation.set(rx * D2R, ry * D2R, rz * D2R);
  group.scale.set(sx, sy, sz);

  const color = obj.color ?? "#d4d4d8";

  const camCfg = obj.components?.find((c) => c.type === "Camera")?.config;
  if (camCfg && !cameraInfo) {
    cameraInfo = {
      id: obj.id,
      fov: camCfg.fov ?? 50,
      near: camCfg.near ?? 0.1,
      far: camCfg.far ?? 1000,
    };
  }

  if (obj.type === "mesh" && obj.primitive) {
    const isPlane = obj.primitive === "plane";
    const mat = materialProps(obj.materialId, materialRegistry);
    const material = new THREE.MeshStandardMaterial({
      color: mat?.color ?? color,
      metalness: mat?.metalness ?? (isPlane ? 0.1 : 0.25),
      roughness: mat?.roughness ?? (isPlane ? 0.95 : 0.5),
      emissive: mat?.emissive ?? "#000000",
      emissiveIntensity: mat?.emissiveIntensity ?? 1,
    });
    const mesh = new THREE.Mesh(makeGeometry(obj.primitive), material);
    mesh.castShadow = !isPlane;
    mesh.receiveShadow = true;
    group.add(mesh);
  } else if (obj.type === "model") {
    const placeholder = placeholderMesh(color);
    group.add(placeholder);
    if (isLoadableModel(obj.assetUrl)) {
      gltfLoader.load(
        obj.assetUrl,
        (gltf) => {
          const model = gltf.scene;
          downgradeMaterials(model);
          model.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = true;
          });
          applyMaterialOverride(model, obj.materialId, materialRegistry);
          group.remove(placeholder);
          group.add(model);

          // Play all animations if the GLB has any
          if (gltf.animations && gltf.animations.length > 0) {
            const mixer = new THREE.AnimationMixer(model);
            gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
            mixers.push(mixer);
          }
        },
        undefined,
        () => {
          // Keep placeholder on load failure
        }
      );
    }
  } else if (obj.type === "light" && obj.light) {
    const intensity = obj.components?.find((c) => c.type === "Light")?.config?.intensity ?? 1;
    let light = null;
    switch (obj.light) {
      case "directional":
        light = new THREE.DirectionalLight(color, intensity * 1.4);
        light.castShadow = true;
        light.position.set(0, 0, 0);
        light.shadow.mapSize.set(2048, 2048);
        light.shadow.camera.near = 0.5;
        light.shadow.camera.far = 140;
        light.shadow.camera.left = -50;
        light.shadow.camera.right = 50;
        light.shadow.camera.top = 50;
        light.shadow.camera.bottom = -50;
        light.shadow.bias = -0.0004;
        break;
      case "point":
        light = new THREE.PointLight(color, intensity * 8, 30);
        light.castShadow = true;
        break;
      case "spot":
        light = new THREE.SpotLight(color, intensity * 10, 0, 0.5, 0.4);
        light.castShadow = true;
        break;
      case "ambient":
        light = new THREE.AmbientLight(color, intensity);
        break;
    }
    if (light) group.add(light);
  }

  for (const child of obj.children ?? []) {
    const childGroup = buildNode(child, materialRegistry);
    if (childGroup) group.add(childGroup);
  }

  return group;
}

function findWithComponent(objects, type) {
  for (const obj of objects ?? []) {
    if (obj.components?.some((c) => c.type === type)) return obj;
    const child = findWithComponent(obj.children, type);
    if (child) return child;
  }
  return null;
}

function collectDamageTargets(objects, playerId) {
  const out = [];
  const walk = (list) => {
    for (const obj of list ?? []) {
      const target =
        obj.id !== playerId &&
        (obj.components?.some((c) => c.type === "Health") || obj.components?.some((c) => c.type === "EnemyAI"));
      if (target) out.push(obj);
      walk(obj.children);
    }
  };
  walk(objects);
  return out;
}

function getComponent(obj, type) {
  return obj?.components?.find((c) => c.type === type)?.config ?? null;
}

function targetCentroid(targets) {
  const center = new THREE.Vector3();
  let count = 0;
  for (const target of targets) {
    const obj = objectById.get(target.id);
    if (!obj) continue;
    obj.updateWorldMatrix(true, false);
    center.add(obj.getWorldPosition(new THREE.Vector3()));
    count++;
  }
  return count ? center.multiplyScalar(1 / count) : null;
}

function addOverlay() {
  const root = document.createElement("div");
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;font:600 14px system-ui;color:white";
  root.innerHTML = `
    <div id="hud" style="position:absolute;left:16px;top:16px;display:flex;gap:8px"></div>
    <div id="crosshair" style="display:none;position:absolute;left:50%;top:50%;width:28px;height:28px;transform:translate(-50%,-50%)">
      <span style="position:absolute;left:13px;top:0;width:2px;height:8px;background:#fff"></span>
      <span style="position:absolute;left:13px;bottom:0;width:2px;height:8px;background:#fff"></span>
      <span style="position:absolute;left:0;top:13px;width:8px;height:2px;background:#fff"></span>
      <span style="position:absolute;right:0;top:13px;width:8px;height:2px;background:#fff"></span>
      <span style="position:absolute;left:11px;top:11px;width:6px;height:6px;border:1px solid #fff;border-radius:999px"></span>
    </div>
    <div id="help" style="position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:rgba(10,10,10,.72);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:9px 12px;color:#d4d4d8">
      WASD to move · click to look · mouse / Space to shoot
    </div>`;
  document.body.appendChild(root);
  return {
    hud: root.querySelector("#hud"),
    crosshair: root.querySelector("#crosshair"),
    setArmed(armed) {
      root.querySelector("#crosshair").style.display = armed ? "block" : "none";
      root.querySelector("#help").style.display = armed ? "block" : "none";
    },
    setHud(text) {
      this.hud.innerHTML = text
        ? `<div style="background:rgba(10,10,10,.72);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 10px">${text}</div>`
        : "";
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function main() {
  const res = await fetch("./scene.json");
  const data = await res.json();
  const sceneData = data.scene;
  const materialRegistry = data.materialRegistry ?? {};
  const renderSettings = data.renderSettings ?? {};
  const env = sceneData.environment ?? {};

  document.title = sceneData.name || "Gizmo Scene";

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Match the editor's tone mapping and exposure
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Math.pow(2, renderSettings.exposure ?? 0);

  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(env.background || "#0a0a0a");
  if (env.fog) {
    scene.fog = new THREE.Fog(env.background || "#0a0a0a", 24, 60);
  }

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.25;
  pmremGenerator.dispose();

  scene.add(new THREE.AmbientLight(0xffffff, env.ambientIntensity ?? 0.4));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0a0a0a, 0.3));

  for (const obj of sceneData.objects ?? []) {
    const node = buildNode(obj, materialRegistry);
    if (node) scene.add(node);
  }
  scene.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
  let target = new THREE.Vector3(0, 0, 0);

  if (cameraInfo) {
    camera.fov = cameraInfo.fov;
    camera.near = cameraInfo.near;
    camera.far = cameraInfo.far;
    camera.updateProjectionMatrix();
    const cameraNode = objectById.get(cameraInfo.id);
    if (cameraNode) {
      cameraNode.updateWorldMatrix(true, false);
      cameraNode.getWorldPosition(camera.position);
      cameraNode.getWorldQuaternion(camera.quaternion);
    }
    const forward = camera.getWorldDirection(new THREE.Vector3());
    target = camera.position.clone().addScaledVector(forward, 10);
  } else {
    camera.position.set(9, 7, 12);
  }

  const playerObj = findWithComponent(sceneData.objects, "PlayerController");
  const playerNode = playerObj ? objectById.get(playerObj.id) : null;
  const playerIsCamera = Boolean(playerObj && getComponent(playerObj, "Camera"));
  const weaponObj = playerObj && getComponent(playerObj, "Weapon") ? playerObj : findWithComponent(sceneData.objects, "Weapon");
  const weaponCfg = getComponent(weaponObj, "Weapon") ?? {};
  const hasWeapon = Boolean(playerObj && weaponObj);
  const damageTargets = collectDamageTargets(sceneData.objects, playerObj?.id ?? null).map((obj) => ({
    id: obj.id,
    hp: Math.max(1, getComponent(obj, "Health")?.hp ?? 1),
    alive: true,
  }));
  const overlay = addOverlay();
  overlay.setArmed(hasWeapon);
  overlay.setHud(hasWeapon && damageTargets.length ? `Targets 0/${damageTargets.length}` : "");

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2;
  controls.maxDistance = 80;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.enabled = !playerIsCamera;
  controls.update();

  if (playerIsCamera && playerNode) {
    playerNode.updateWorldMatrix(true, false);
    playerNode.getWorldPosition(camera.position);
    playerNode.getWorldQuaternion(camera.quaternion);
    const center = hasWeapon ? targetCentroid(damageTargets) : null;
    if (center) camera.lookAt(center);
    playerNode.quaternion.copy(camera.quaternion);
  }

  const keys = {};
  const clock = new THREE.Clock();
  let yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ").y;
  let pitch = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ").x;
  let lookActive = false;
  let fireHeld = false;
  let cooldown = 0;
  let targetsHit = 0;
  const raycaster = new THREE.Raycaster();

  window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
  });
  window.addEventListener("keyup", (e) => {
    keys[e.key.toLowerCase()] = false;
  });

  renderer.domElement.addEventListener("pointerdown", () => {
    fireHeld = true;
    if (playerIsCamera) renderer.domElement.requestPointerLock?.();
  });
  window.addEventListener("pointerup", () => {
    fireHeld = false;
  });
  document.addEventListener("pointerlockchange", () => {
    lookActive = document.pointerLockElement === renderer.domElement;
  });
  document.addEventListener("mousemove", (e) => {
    if (!lookActive || !playerIsCamera) return;
    yaw -= e.movementX * 0.0022;
    pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch - e.movementY * 0.0022));
  });

  function fireWeapon() {
    const range = Number.isFinite(weaponCfg.range) ? weaponCfg.range : 60;
    const damage = Number.isFinite(weaponCfg.damage) ? weaponCfg.damage : 1;
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
    raycaster.set(origin, direction);
    raycaster.far = range;
    let closest = null;
    for (const target of damageTargets) {
      if (!target.alive) continue;
      const node = objectById.get(target.id);
      if (!node || !node.visible) continue;
      const hit = raycaster.intersectObject(node, true)[0];
      if (hit && (!closest || hit.distance < closest.distance)) closest = { target, node, hit };
    }

    const end = closest?.hit.point ?? origin.clone().addScaledVector(direction, range);
    const geometry = new THREE.BufferGeometry().setFromPoints([origin, end]);
    const material = new THREE.LineBasicMaterial({ color: closest ? "#fef08a" : "#67e8f9", transparent: true, opacity: 0.85 });
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    setTimeout(() => {
      scene.remove(line);
      geometry.dispose();
      material.dispose();
    }, 70);

    if (!closest) return;
    closest.target.hp -= damage;
    if (closest.target.hp > 0) return;
    closest.target.alive = false;
    closest.node.visible = false;
    targetsHit++;
    overlay.setHud(`Targets ${targetsHit}/${damageTargets.length}`);
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);

    // Tick all GLB animation mixers
    for (const mixer of mixers) mixer.update(dt);

    if (playerIsCamera && playerNode) {
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      const speed = ((getComponent(playerObj, "PlayerController")?.speed ?? 6) * dt);
      const forward = camera.getWorldDirection(new THREE.Vector3());
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
      const move = new THREE.Vector3();
      if (keys.w || keys.arrowup) move.add(forward);
      if (keys.s || keys.arrowdown) move.sub(forward);
      if (keys.d || keys.arrowright) move.add(right);
      if (keys.a || keys.arrowleft) move.sub(right);
      if (move.lengthSq() > 0) camera.position.addScaledVector(move.normalize(), speed);
      playerNode.position.copy(camera.position);
      playerNode.quaternion.copy(camera.quaternion);
    } else {
      controls.update();
    }
    cooldown = Math.max(0, cooldown - dt);
    const triggerHeld = fireHeld || keys[" "] || keys.space || keys.spacebar;
    if (hasWeapon && triggerHeld && cooldown <= 0) {
      const fireRate = Number.isFinite(weaponCfg.fireRate) ? weaponCfg.fireRate : 6;
      cooldown = 1 / fireRate;
      fireWeapon();
    }
    renderer.render(scene, camera);
  });
}

main();
