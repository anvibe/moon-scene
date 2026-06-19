Gizmo scene export
==================

This folder is a static site -- host it on any static file host
(GitHub Pages, Netlify, Vercel, S3, nginx, etc.) or run it locally with:

  npx serve .

Opening index.html directly via file:// will NOT work: the page loads
scene.json with fetch(), which browsers block for file:// pages.

Files
-----
index.html   - entry point
runtime.js   - the game runtime (the real Gizmo editor render engine, in Play
               mode -- self-contained, no CDN or build step needed)
runtime.css  - runtime styles (HUD, banners)
scene.json   - the exported scene graph, environment, materials and scripts
assets/      - bundled 3D models (.glb/.fbx/.obj) and textures, if any

Controls
--------
WASD / arrow keys to move. First-person scenes: click to capture mouse-look,
mouse / Space to shoot. The on-screen HUD shows timers, score, laps and health
exactly as they appear when you press Play in the editor.
