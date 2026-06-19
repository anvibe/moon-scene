Gizmo scene export
==================

This folder is a static site -- host it on any static file host
(GitHub Pages, Netlify, Vercel, S3, nginx, etc.) or run it locally with:

  npx serve .

Opening index.html directly via file:// will NOT work: the page loads
scene.json with fetch(), which browsers block for file:// pages.

Files
-----
index.html  - entry point; sets up the three.js import map
player.js   - scene loader / renderer (three.js, loaded from the unpkg CDN)
scene.json  - the exported scene graph, environment, and materials
assets/     - bundled 3D models (.glb), if the scene used any

Controls
--------
Viewer scenes: drag to orbit, scroll to zoom, right-click drag to pan.

Playable first-person scenes: WASD / arrow keys to move, click to capture
mouse-look, mouse / Space to shoot targets.
