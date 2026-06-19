import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// RectAreaLight needs its BRDF lookup tables initialised before it emits light.
RectAreaLightUniformsLib.init();

// Same CDN and preset→file mapping used by @react-three/drei <Environment preset="...">
const DREI_HDR_BASE = "https://raw.githack.com/pmndrs/drei-assets/456060a26bbeb8fdf79326f224b6d99b8bcce736/hdri/";
const HDRI_FILES = {
  apartment: "lebombo_1k.hdr",
  city:      "potsdamer_platz_1k.hdr",
  dawn:      "kiara_1_dawn_1k.hdr",
  forest:    "forest_slope_1k.hdr",
  lobby:     "st_fagans_interior_1k.hdr",
  night:     "dikhololo_night_1k.hdr",
  park:      "rooitou_park_1k.hdr",
  studio:    "studio_small_03_1k.hdr",
  sunset:    "venice_sunset_1k.hdr",
  warehouse: "empty_warehouse_01_1k.hdr",
};

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
const MATERIAL_PRESETS = {
  m_carpaint: { color: "#e74c3c", metalness: 0.6, roughness: 0.28 },
  m_asphalt:  { color: "#3f3f46", metalness: 0.0, roughness: 0.95 },
  m_regolith: { color: "#9b9a97", metalness: 0.0, roughness: 1.0  },
  m_moonrock: { color: "#6e6d6a", metalness: 0.05, roughness: 0.9 },
  m_metal:    { color: "#b8c0c8", metalness: 0.9, roughness: 0.32 },
};

function materialProps(materialId, registry) {
  if (!materialId) return null;
  if (registry?.[materialId]) return registry[materialId];
  if (MATERIAL_PRESETS[materialId]) return MATERIAL_PRESETS[materialId];
  return null;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
function makeGeometry(type) {
  switch (type) {
    case "sphere":   return new THREE.SphereGeometry(0.6, 32, 32);
    case "plane":    return new THREE.BoxGeometry(20, 0.05, 20);
    case "cylinder": return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
    case "cone":     return new THREE.ConeGeometry(0.6, 1.2, 32);
    case "torus":    return new THREE.TorusGeometry(0.6, 0.18, 16, 48);
    case "capsule":  return new THREE.CapsuleGeometry(0.4, 0.8, 8, 16);
    default:         return new THREE.BoxGeometry(1, 1, 1);
  }
}

function isLoadableModel(url) {
  if (!url) return false;
  return /\.(glb|gltf|fbx|obj)(\?.*)?$/i.test(url) || url.startsWith("blob:") || url.startsWith("data:");
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
const fbxLoader = new FBXLoader();
const objLoader = new OBJLoader();
const textureLoader = new THREE.TextureLoader();

function modelExtension(url) {
  return (url || "").split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "glb";
}

// Cubic ease used by the editor's cinematic shot transitions.
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// ---------------------------------------------------------------------------
// Material downgrade: MeshPhysicalMaterial → MeshStandardMaterial
// Physical materials can use 20+ texture units, exceeding the WebGL limit of 16.
// ---------------------------------------------------------------------------
function downgradeMaterial(mat) {
  if (!mat?.isMeshPhysicalMaterial) return mat;
  const std = new THREE.MeshStandardMaterial({
    color: mat.color,
    map: mat.map,
    normalMap: mat.normalMap,
    normalScale: mat.normalScale,
    roughnessMap: mat.roughnessMap,
    metalnessMap: mat.metalnessMap,
    emissive: mat.emissive,
    emissiveMap: mat.emissiveMap,
    emissiveIntensity: mat.emissiveIntensity,
    metalness: mat.metalness,
    roughness: mat.roughness,
    opacity: mat.opacity,
    transparent: mat.transparent,
    side: mat.side,
    envMapIntensity: mat.envMapIntensity,
  });
  mat.dispose();
  return std;
}

function downgradeMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material)
      ? o.material.map(downgradeMaterial)
      : downgradeMaterial(o.material);
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

// ---------------------------------------------------------------------------
// Scene graph
// ---------------------------------------------------------------------------
let cameraInfo = null;
const objectById = new Map();
const sceneObjectById = new Map();
const mixers = [];          // { mixer, speed }
const objectAnimations = []; // { node, cfg, basePosition, baseScale }
let shadowLightCount = 0; // only 1 directional light gets a shadow map

function placeholderMesh(color) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: color ?? "#d4d4d8", metalness: 0.4, roughness: 0.4 })
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Per-object clip registry — mirrors src/lib/animationRegistry so gameplay code
// (EnemyAI walk, player walk/idle) can cross-fade named clips on demand.
const clipRegistry = new Map(); // id -> { mixer, clips: Map<name,clip>, active, activeName }

function playClipById(id, name, fade = 0.15) {
  const entry = clipRegistry.get(id);
  if (!entry) return false;
  if (entry.activeName === name) return true;
  let clip = entry.clips.get(name);
  if (!clip) {
    for (const [key, c] of entry.clips) {
      if (key.toLowerCase().includes(name.toLowerCase())) { clip = c; break; }
    }
  }
  if (!clip) return false;
  const next = entry.mixer.clipAction(clip);
  next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
  if (entry.active && entry.active !== next) next.crossFadeFrom(entry.active, fade, false);
  entry.active = next;
  entry.activeName = name;
  return true;
}

// Registers a model's clips so they can be played later, and auto-plays the
// selected `activeClip` when `animation.playing` is true (matches the editor's
// GLTFModel/FBXModel: static unless playing, honouring loop/speed).
function setupClips(obj, model, clips) {
  if (!clips || clips.length === 0) return;

  const mixer = new THREE.AnimationMixer(model);
  const map = new Map();
  clips.forEach((c, i) => map.set(c.name || `Clip ${i + 1}`, c));
  const entry = { mixer, clips: map, active: null, activeName: null };
  clipRegistry.set(obj.id, entry);
  mixers.push({ mixer, speed: 1 }); // per-action speed handled via timeScale

  const a = obj.animation;
  if (a && a.playing === true) {
    const chosenName = (a.activeClip && map.has(a.activeClip)) ? a.activeClip : map.keys().next().value;
    const action = mixer.clipAction(map.get(chosenName));
    action.setLoop(a.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = a.loop === false;
    action.timeScale = a.speed ?? 1;
    action.reset().play();
    entry.active = action;
    entry.activeName = chosenName;
  }
}

function loadModel(obj, parent, placeholder, materialRegistry) {
  const url = obj.assetUrl;
  const ext = modelExtension(url);

  const onLoaded = (root, clips) => {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    downgradeMaterials(root);
    applyMaterialOverride(root, obj.materialId, materialRegistry);

    // Fractured model: render only the named sub-node, neutralising its local
    // transform (the wrapping group already carries the part's placement).
    if (obj.glbNodeName) {
      const node = root.getObjectByName(obj.glbNodeName);
      if (node) {
        node.position.set(0, 0, 0);
        node.rotation.set(0, 0, 0);
        node.scale.set(1, 1, 1);
        parent.remove(placeholder);
        parent.add(node);
        return;
      }
    }

    parent.remove(placeholder);
    parent.add(root);
    setupClips(obj, root, clips);
  };

  const onError = () => {}; // keep placeholder on failure

  if (ext === "fbx") {
    fbxLoader.load(url, (m) => onLoaded(m, m.animations ?? []), undefined, onError);
  } else if (ext === "obj") {
    objLoader.load(url, (m) => onLoaded(m, []), undefined, onError);
  } else {
    gltfLoader.load(url, (gltf) => onLoaded(gltf.scene, gltf.animations ?? []), undefined, onError);
  }
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

  // Looping transform animation (rotate / translate / scale) — driven per-frame.
  if (obj.objectAnimation?.enabled) {
    objectAnimations.push({
      node: group,
      cfg: obj.objectAnimation,
      basePosition: [px, py, pz],
      baseScale: [sx, sy, sz],
    });
  }

  const color = obj.color ?? "#d4d4d8";

  const camCfg = obj.components?.find((c) => c.type === "Camera")?.config;
  if (camCfg && !cameraInfo) {
    cameraInfo = { id: obj.id, fov: camCfg.fov ?? 50, near: camCfg.near ?? 0.1, far: camCfg.far ?? 1000 };
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
    // baseScale ("Apply Scale") and pivotOffset ("Center Pivot") are baked onto
    // a wrapper group inside the node, exactly like the editor's SceneNode.
    const wrapper = new THREE.Group();
    const [ox, oy, oz] = obj.pivotOffset ?? [0, 0, 0];
    const [bsx, bsy, bsz] = obj.baseScale ?? [1, 1, 1];
    wrapper.position.set(ox, oy, oz);
    wrapper.scale.set(bsx, bsy, bsz);
    group.add(wrapper);

    const placeholder = placeholderMesh(color);
    wrapper.add(placeholder);
    if (isLoadableModel(obj.assetUrl)) {
      loadModel(obj, wrapper, placeholder, materialRegistry);
    }

  } else if (obj.type === "sprite") {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: obj.color ?? "#ffffff",
        transparent: true,
        opacity: obj.spriteUrl ? 1 : 0.85,
        side: THREE.DoubleSide,
      })
    );
    group.add(mesh);
    if (obj.spriteUrl) {
      textureLoader.load(obj.spriteUrl, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        mesh.material.map = tex;
        mesh.material.alphaTest = 0.05;
        mesh.material.needsUpdate = true;
      });
    }

  } else if (obj.type === "light" && obj.light) {
    const lightCfg = obj.components?.find((c) => c.type === "Light")?.config ?? {};
    const intensity = lightCfg.intensity ?? 1;
    let light = null;
    switch (obj.light) {
      case "directional":
        light = new THREE.DirectionalLight(color, intensity * 1.4);
        if (shadowLightCount === 0) {
          light.castShadow = true;
          light.shadow.mapSize.set(2048, 2048);
          light.shadow.camera.near = 0.5;
          light.shadow.camera.far = 140;
          light.shadow.camera.left = -50;
          light.shadow.camera.right = 50;
          light.shadow.camera.top = 50;
          light.shadow.camera.bottom = -50;
          light.shadow.bias = -0.0004;
          shadowLightCount++;
        }
        break;
      case "point":
        // Point shadows use 6 texture units (cube map) — skip to stay under limit
        light = new THREE.PointLight(color, intensity * 8, 30);
        break;
      case "spot":
        light = new THREE.SpotLight(color, intensity * 10, 0, 0.5, 0.4);
        break;
      case "ambient":
        light = new THREE.AmbientLight(color, intensity);
        break;
      case "area": {
        const w = lightCfg.width ?? 4;
        const h = lightCfg.height ?? 2;
        light = new THREE.RectAreaLight(color, intensity * 6, w, h);
        break;
      }
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
      const isTarget = obj.id !== playerId &&
        (obj.components?.some((c) => c.type === "Health") || obj.components?.some((c) => c.type === "EnemyAI"));
      if (isTarget) out.push(obj);
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
  for (const t of targets) {
    const obj = objectById.get(t.id);
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
// Script runtime (mirrors src/lib/scriptRuntime.ts)
// ---------------------------------------------------------------------------
function stripTS(code) {
  let src = code;
  src = src.replace(/^[ \t]*import[^\n;]*;?[ \t]*$/gm, "");
  src = src.replace(/\b(public|private|protected|readonly)\s+/g, "");
  // Strip type assertions: (x as Type) → (x)
  src = src.replace(/\s+as\s+\w+(?:<[^>]*>)?(?:\[\])?/g, "");
  src = src.replace(
    /:\s*(?:[A-Z][\w.]*|number|string|boolean|any|unknown|void|never|object|symbol|bigint)(?:<[^>]*>)?(?:\[\])?/g,
    ""
  );
  src = src.replace(/export\s+default\s+/, "return ");
  src = src.replace(/\bexport\s+/g, "");
  return src;
}

function deriveTag(obj) {
  if (obj.components?.some((c) => c.type === "PlayerController")) return "Player";
  if (obj.components?.some((c) => c.type === "EnemyAI")) return "Enemy";
  if (obj.components?.some((c) => c.type === "Health")) return "Target";
  if (obj.components?.some((c) => c.type === "Collectible")) return "Collectible";
  return obj.name;
}

function makeScriptHandle(sceneObj, obj3d) {
  return {
    id: sceneObj.id,
    name: sceneObj.name,
    tag: deriveTag(sceneObj),
    transform: {
      position: [obj3d.position.x, obj3d.position.y, obj3d.position.z],
      rotation: [obj3d.rotation.x, obj3d.rotation.y, obj3d.rotation.z],
      scale:    [obj3d.scale.x,    obj3d.scale.y,    obj3d.scale.z   ],
    },
    get(type) { return sceneObj.components?.find((c) => c.type === type)?.config ?? {}; },
    destroy() { obj3d.visible = false; this.__destroyed = true; },
    __obj: obj3d,
    __destroyed: false,
  };
}

function syncIn(h) {
  const o = h.__obj;
  h.transform.position[0] = o.position.x; h.transform.position[1] = o.position.y; h.transform.position[2] = o.position.z;
  h.transform.rotation[0] = o.rotation.x; h.transform.rotation[1] = o.rotation.y; h.transform.rotation[2] = o.rotation.z;
  h.transform.scale[0]    = o.scale.x;    h.transform.scale[1]    = o.scale.y;    h.transform.scale[2]    = o.scale.z;
}

function syncOut(h) {
  const o = h.__obj;
  o.position.set(h.transform.position[0], h.transform.position[1], h.transform.position[2]);
  o.rotation.set(h.transform.rotation[0], h.transform.rotation[1], h.transform.rotation[2]);
  o.scale.set(h.transform.scale[0], h.transform.scale[1], h.transform.scale[2]);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function main() {
  const res = await fetch("./scene.json");
  const data = await res.json();
  const sceneData = data.scene;
  const materialRegistry = data.materialRegistry ?? {};
  const rs = data.renderSettings ?? {};
  const env = sceneData.environment ?? {};

  document.title = sceneData.name || "Gizmo Scene";

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Math.pow(2, rs.exposure ?? 0);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(env.background || "#0a0a0a");

  if (env.fog) {
    scene.fog = new THREE.FogExp2(env.fogColor || env.background || "#0a0a0a", env.fogDensity ?? 0.02);
  }

  // Ambient light from scene environment settings
  if ((env.ambientIntensity ?? 0) > 0) {
    scene.add(new THREE.AmbientLight(0xffffff, env.ambientIntensity));
  }
  // Hemisphere fill — matches the editor's <hemisphereLight intensity 0.3>.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0a0a0a, 0.3));

  // Load the same HDRI that Drei uses in the editor
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const hdriFile = HDRI_FILES[env.hdri] || HDRI_FILES.city;
  new RGBELoader().load(DREI_HDR_BASE + hdriFile, (hdrTexture) => {
    const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;
    hdrTexture.dispose();
    pmremGenerator.dispose();

    scene.environment = envMap;
    scene.environmentIntensity = env.hdriIntensity ?? 0.3;
    if (env.showHdriBackground) {
      scene.background = envMap;
      scene.backgroundIntensity = env.hdriIntensity ?? 0.3;
      // rotate the background to match editor rotation
      scene.backgroundRotation = new THREE.Euler(0, ((env.hdriRotation ?? 0) * Math.PI) / 180, 0);
    }
    scene.environmentRotation = new THREE.Euler(0, ((env.hdriRotation ?? 0) * Math.PI) / 180, 0);
  });

  // Vignette overlay — matches editor's vignette slider
  if ((rs.vignetteStrength ?? 0) > 0) {
    const vig = document.createElement("div");
    const s = rs.vignetteStrength ?? 0.5;
    vig.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:10;background:radial-gradient(ellipse at 50% 50%,transparent 40%,rgba(0,0,0,${s.toFixed(2)}) 100%)`;
    document.body.appendChild(vig);
  }

  // Color-grading via CSS filters — matches saturation/contrast/brightness sliders
  {
    const sat = 1 + (rs.saturation ?? 0);
    const con = 1 + (rs.contrast   ?? 0);
    const bri = 1 + (rs.brightness ?? 0);
    if (sat !== 1 || con !== 1 || bri !== 1) {
      renderer.domElement.style.filter = `saturate(${sat}) contrast(${con}) brightness(${bri})`;
    }
  }

  for (const obj of sceneData.objects ?? []) {
    const node = buildNode(obj, materialRegistry);
    if (node) scene.add(node);
  }
  scene.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
  let orbitTarget = new THREE.Vector3(0, 0, 0);

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
    orbitTarget = camera.position.clone().addScaledVector(forward, 10);
  } else {
    camera.position.set(9, 7, 12);
  }

  // ── Postprocessing ──────────────────────────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Ambient occlusion — the editor renders N8AO at intensity 3 by default, which
  // darkens contact areas and gives the scene depth. Without it the export looks
  // flat, bright and washed out, so approximate it with SSAOPass.
  if (rs.ssao !== false) {
    const ssao = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
    ssao.kernelRadius = 12;
    ssao.minDistance = 0.002;
    ssao.maxDistance = 0.12;
    composer.addPass(ssao);
  }

  if (rs.bloom !== false) {
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      (rs.bloomIntensity ?? 0.5) * 0.3,  // scale down: UnrealBloom is stronger than editor's postprocessing Bloom
      0.6,   // wider radius = softer glow
      0.2    // same luminanceThreshold as editor's <Bloom luminanceThreshold={0.2}>
    );
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  // ── Game components ─────────────────────────────────────────────────────────
  const playerObj = findWithComponent(sceneData.objects, "PlayerController");
  const playerNode = playerObj ? objectById.get(playerObj.id) : null;
  const playerIsCamera = Boolean(playerObj && getComponent(playerObj, "Camera"));
  const weaponObj = playerObj && getComponent(playerObj, "Weapon")
    ? playerObj
    : findWithComponent(sceneData.objects, "Weapon");
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

  // ── Enemy AI + shooting-gallery bob (mirrors PlayController) ────────────────
  const collectByComponent = (list, type, out = []) => {
    for (const o of list ?? []) {
      if (o.components?.some((c) => c.type === type)) out.push(o);
      collectByComponent(o.children, type, out);
    }
    return out;
  };
  // EnemyAI objects chase the player and play their "Walk" clip while moving.
  const enemies = collectByComponent(sceneData.objects, "EnemyAI")
    .map((o) => ({ id: o.id, node: objectById.get(o.id), speed: getComponent(o, "EnemyAI")?.speed ?? 4 }))
    .filter((e) => e.node);
  // Health targets that are NOT enemies gently bob in place, like the editor.
  const galleryBob = collectByComponent(sceneData.objects, "Health")
    .filter((o) => !o.components.some((c) => c.type === "EnemyAI"))
    .map((o, i) => { const node = objectById.get(o.id); return node ? { node, baseY: node.position.y, phase: i * 1.3 } : null; })
    .filter(Boolean);
  const _enemyDir = new THREE.Vector3();
  const _zAxis = new THREE.Vector3(0, 0, 1);

  // Third-person mode: PlayerController present but no Camera component on the player.
  // WASD moves the player; orbit controls orbit around them.
  const playerIsThirdPerson = Boolean(playerObj && playerNode && !playerIsCamera);

  // Orbit controls only for scenes without a player (free-look) or first-person
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2;
  controls.maxDistance = 80;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.enabled = !playerIsCamera && !playerIsThirdPerson;
  controls.update();

  if (playerIsCamera && playerNode) {
    // First-person: camera sits at the player's world position
    playerNode.updateWorldMatrix(true, false);
    playerNode.getWorldPosition(camera.position);
    playerNode.getWorldQuaternion(camera.quaternion);
    const center = hasWeapon ? targetCentroid(damageTargets) : null;
    if (center) camera.lookAt(center);
    playerNode.quaternion.copy(camera.quaternion);
  } else if (playerIsThirdPerson) {
    // Third-person: start camera above and behind the player (world +Z = behind)
    playerNode.updateWorldMatrix(true, false);
    const playerPos = playerNode.getWorldPosition(new THREE.Vector3());
    camera.position.set(playerPos.x, playerPos.y + 6, playerPos.z + 10);
    camera.lookAt(playerPos.x, playerPos.y, playerPos.z);
  } else {
    controls.target.copy(orbitTarget);
    controls.update();
  }

  // ── Cinematic camera shots (Animation panel timeline) ───────────────────────
  // Auto-plays the captured shot sequence when there's no interactive player.
  const shots = data.animationShots ?? [];
  const loopMode = data.animationLoop ?? "none";
  const cinematic = shots.length > 0 && !playerObj;
  let cineIdx = 0;      // shot we're currently transitioning into / holding
  let cinePlayhead = 0; // seconds elapsed within the current shot
  let cineDir = 1;      // 1 = forward, -1 = backward (ping-pong)
  let cineDone = false; // reached the end with loop disabled
  const cineTarget = new THREE.Vector3();

  const snapToShot = (i) => {
    const s = shots[i];
    if (!s) return;
    camera.position.set(...s.position);
    cineTarget.set(...s.target);
    camera.lookAt(cineTarget);
  };

  if (cinematic) {
    controls.enabled = false;
    if (Number.isFinite(shots[0].fov)) {
      camera.fov = shots[0].fov;
      camera.updateProjectionMatrix();
    }
    snapToShot(0);
  }

  const keys = {};
  const clock = new THREE.Clock();

  // ── Script system ──────────────────────────────────────────────────────────
  const rawScripts = data.scripts ?? [];
  let scriptTime = 0;
  const hudMap = {};
  let scriptHudEl = null;

  function setScriptHud(key, val) {
    hudMap[key] = String(val);
    if (!scriptHudEl) {
      scriptHudEl = document.createElement("div");
      scriptHudEl.style.cssText = "position:fixed;top:16px;right:16px;pointer-events:none;font:600 14px system-ui;color:white;z-index:50;display:flex;flex-direction:column;align-items:flex-end;gap:6px";
      document.body.appendChild(scriptHudEl);
    }
    scriptHudEl.innerHTML = Object.entries(hudMap).map(([, v]) =>
      `<div style="background:rgba(10,10,10,.75);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 12px">${v}</div>`
    ).join("");
  }

  const Gizmo = {
    get time() { return scriptTime; },
    ui: { set: setScriptHud },
    find(name) {
      for (const [id, obj] of sceneObjectById) {
        if (obj.name === name) {
          const node = objectById.get(id);
          if (!node) return null;
          const h = makeScriptHandle(obj, node);
          syncIn(h);
          return h;
        }
      }
      return null;
    },
    distance(a, b) {
      const pa = a.transform.position, pb = b.transform.position;
      return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    },
    direction(a, b) {
      const pa = a.transform.position, pb = b.transform.position;
      const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const len = Math.hypot(...d) || 1;
      return d.map((x) => x / len);
    },
    log: (...args) => console.log("[Script]", ...args),
  };
  const Input = { key: (k) => Boolean(keys[k?.toLowerCase()]) };

  function compileScript(code) {
    try {
      const body = '"use strict";\n' + stripTS(code);
      const factory = new Function("Gizmo", "Input", body);
      const exported = factory(Gizmo, Input);
      if (typeof exported === "function") return new exported();
      if (exported && typeof exported === "object") return exported;
    } catch (e) {
      console.warn("[Script compile]", e.message);
    }
    return null;
  }

  const scriptInstances = [];
  for (const script of rawScripts) {
    const instance = compileScript(script.code);
    if (!instance) continue;
    for (const objId of script.attachedTo ?? []) {
      const sceneObj = sceneObjectById.get(objId);
      const node = objectById.get(objId);
      if (!sceneObj || !node) continue;
      scriptInstances.push({ instance, sceneObj, node, handle: makeScriptHandle(sceneObj, node), started: false, triggered: false });
    }
  }

  // Call start() on all scripts once before the loop
  for (const si of scriptInstances) {
    syncIn(si.handle);
    try { si.instance.start?.(si.handle); } catch (e) { console.warn("[Script start]", e.message); }
    si.started = true;
    syncOut(si.handle);
  }

  let yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ").y;
  let pitch = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ").x;
  let lookActive = false;
  let fireHeld = false;
  let cooldown = 0;
  let targetsHit = 0;
  const raycaster = new THREE.Raycaster();

  window.addEventListener("keydown", (e) => { keys[e.key.toLowerCase()] = true; });
  window.addEventListener("keyup",   (e) => { keys[e.key.toLowerCase()] = false; });

  renderer.domElement.addEventListener("pointerdown", () => {
    fireHeld = true;
    if (playerIsCamera) renderer.domElement.requestPointerLock?.();
  });
  window.addEventListener("pointerup", () => { fireHeld = false; });
  document.addEventListener("pointerlockchange", () => {
    lookActive = document.pointerLockElement === renderer.domElement;
  });
  document.addEventListener("mousemove", (e) => {
    if (!lookActive || !playerIsCamera) return;
    yaw   -= e.movementX * 0.0022;
    pitch  = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch - e.movementY * 0.0022));
  });

  function fireWeapon() {
    const range  = Number.isFinite(weaponCfg.range)  ? weaponCfg.range  : 60;
    const damage = Number.isFinite(weaponCfg.damage) ? weaponCfg.damage : 1;
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const dir    = camera.getWorldDirection(new THREE.Vector3()).normalize();
    raycaster.set(origin, dir);
    raycaster.far = range;
    let closest = null;
    for (const t of damageTargets) {
      if (!t.alive) continue;
      const node = objectById.get(t.id);
      if (!node?.visible) continue;
      const hit = raycaster.intersectObject(node, true)[0];
      if (hit && (!closest || hit.distance < closest.distance)) closest = { target: t, node, hit };
    }
    const end = closest?.hit.point ?? origin.clone().addScaledVector(dir, range);
    const geo = new THREE.BufferGeometry().setFromPoints([origin, end]);
    const mat = new THREE.LineBasicMaterial({ color: closest ? "#fef08a" : "#67e8f9", transparent: true, opacity: 0.85 });
    const line = new THREE.Line(geo, mat);
    scene.add(line);
    setTimeout(() => { scene.remove(line); geo.dispose(); mat.dispose(); }, 70);
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
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    scriptTime += dt;

    for (const m of mixers) m.mixer.update(dt * m.speed);

    // ── Looping transform animations (rotate / translate / scale) ──────────────
    for (const a of objectAnimations) {
      const { node: g, cfg } = a;
      const axisIdx = cfg.axis === "x" ? 0 : cfg.axis === "y" ? 1 : 2;
      if (cfg.type === "rotate") {
        const angle = (scriptTime * cfg.speed * Math.PI) / 180;
        if (axisIdx === 0) g.rotation.x = angle;
        else if (axisIdx === 1) g.rotation.y = angle;
        else g.rotation.z = angle;
      } else if (cfg.type === "translate") {
        const delta = Math.sin(scriptTime * cfg.speed * Math.PI * 2) * cfg.amplitude;
        const base = [...a.basePosition];
        base[axisIdx] += delta;
        g.position.set(base[0], base[1], base[2]);
      } else if (cfg.type === "scale") {
        const delta = 1 + Math.sin(scriptTime * cfg.speed * Math.PI * 2) * cfg.amplitude;
        const [bx, by, bz] = a.baseScale;
        if (axisIdx === 0) g.scale.set(bx * delta, by, bz);
        else if (axisIdx === 1) g.scale.set(bx, by * delta, bz);
        else g.scale.set(bx, by, bz * delta);
      }
    }

    // ── Enemy AI: chase the player and play the "Walk" clip while moving ───────
    if (playerNode) {
      for (const e of enemies) {
        if (!e.node.visible) continue;
        _enemyDir.subVectors(playerNode.position, e.node.position);
        _enemyDir.y = 0;
        const dist = _enemyDir.length();
        if (dist > 1.2) {
          _enemyDir.normalize();
          e.node.position.addScaledVector(_enemyDir, e.speed * dt);
          e.node.quaternion.setFromUnitVectors(_zAxis, _enemyDir);
          playClipById(e.id, "Walk");
        }
      }
    }
    // Shooting-gallery targets bob in place.
    for (const g of galleryBob) {
      g.node.position.y = g.baseY + Math.sin(scriptTime * 2 + g.phase) * 0.3;
    }

    // ── User scripts ─────────────────────────────────────────────────────────
    for (const si of scriptInstances) {
      if (si.handle.__destroyed) { si.node.visible = false; continue; }
      syncIn(si.handle);
      try {
        si.instance.update?.(si.handle, dt);

        if (si.instance.onTriggerEnter && playerNode) {
          const dist = si.node.position.distanceTo(playerNode.position);
          const near = dist < 1.6;
          if (near && !si.triggered) {
            si.triggered = true;
            const playerSceneObj = sceneObjectById.get(playerObj?.id ?? "");
            if (playerSceneObj) {
              const other = makeScriptHandle(playerSceneObj, playerNode);
              syncIn(other);
              si.instance.onTriggerEnter(si.handle, other);
            }
          } else if (!near) {
            si.triggered = false;
          }
        }
      } catch (e) {
        console.warn("[Script update]", e.message);
      }
      if (!si.handle.__destroyed) syncOut(si.handle);
    }

    if (playerIsCamera && playerNode) {
      // ── First-person ────────────────────────────────────────────────────────
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      const speed = (getComponent(playerObj, "PlayerController")?.speed ?? 6) * dt;
      const forward = camera.getWorldDirection(new THREE.Vector3());
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
      const move = new THREE.Vector3();
      if (keys.w || keys.arrowup)    move.add(forward);
      if (keys.s || keys.arrowdown)  move.sub(forward);
      if (keys.d || keys.arrowright) move.add(right);
      if (keys.a || keys.arrowleft)  move.sub(right);
      if (move.lengthSq() > 0) camera.position.addScaledVector(move.normalize(), speed);
      playerNode.position.copy(camera.position);
      playerNode.quaternion.copy(camera.quaternion);
    } else if (playerIsThirdPerson) {
      // ── Third-person chase camera — matches Gizmo editor play mode ──────────
      const speed = (getComponent(playerObj, "PlayerController")?.speed ?? 6) * dt;
      const move = new THREE.Vector3();
      if (keys.w || keys.arrowup)    move.z -= 1;  // world-space: forward = -Z
      if (keys.s || keys.arrowdown)  move.z += 1;
      if (keys.d || keys.arrowright) move.x += 1;
      if (keys.a || keys.arrowleft)  move.x -= 1;
      if (move.lengthSq() > 0) {
        move.normalize();
        playerNode.position.addScaledVector(move, speed);
        playerNode.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), move);
      }
      // Smooth chase: lerp camera to fixed offset above/behind player
      const playerPos = playerNode.getWorldPosition(new THREE.Vector3());
      camera.position.lerp(new THREE.Vector3(playerPos.x, playerPos.y + 6, playerPos.z + 10), 0.08);
      camera.lookAt(playerPos.x, playerPos.y, playerPos.z);
    } else if (cinematic && !cineDone) {
      // ── Cinematic shot playback — mirrors AnimationPanel's transport ─────────
      cinePlayhead += dt;
      const shot = shots[cineIdx];
      const fromShot = cineDir === 1 ? shots[cineIdx - 1] : shots[cineIdx];
      const toShot   = cineDir === 1 ? shots[cineIdx]     : shots[cineIdx - 1];
      const transDuration = (cineDir === 1
        ? shot.duration
        : (shots[cineIdx - 1]?.duration ?? shot.duration)) || 0.0001;

      if (fromShot && toShot && shot.transition === "ease") {
        const t = easeInOut(Math.min(cinePlayhead / transDuration, 1));
        camera.position.lerpVectors(new THREE.Vector3(...fromShot.position), new THREE.Vector3(...toShot.position), t);
        cineTarget.lerpVectors(new THREE.Vector3(...fromShot.target), new THREE.Vector3(...toShot.target), t);
        camera.lookAt(cineTarget);
      }

      if (cinePlayhead >= transDuration) {
        cinePlayhead = 0;
        if (cineDir === 1) {
          const next = cineIdx + 1;
          if (next >= shots.length) {
            if (loopMode === "loop") { cineIdx = 0; snapToShot(0); }
            else if (loopMode === "ping-pong") { cineDir = -1; }
            else { cineDone = true; }
          } else {
            cineIdx = next;
            if (shots[next].transition === "cut") snapToShot(next);
          }
        } else {
          const prev = cineIdx - 1;
          if (prev < 0) { cineDir = 1; }
          else { cineIdx = prev; if (shots[prev].transition === "cut") snapToShot(prev); }
        }
      }
    } else {
      // ── No player — free orbit ────────────────────────────────────────────────
      controls.update();
    }

    cooldown = Math.max(0, cooldown - dt);
    const triggerHeld = fireHeld || keys[" "] || keys.space || keys.spacebar;
    if (hasWeapon && triggerHeld && cooldown <= 0) {
      const fireRate = Number.isFinite(weaponCfg.fireRate) ? weaponCfg.fireRate : 6;
      cooldown = 1 / fireRate;
      fireWeapon();
    }

    composer.render();
  });
}

main();
