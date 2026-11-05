import * as THREE from "three";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";
import { cloudColors } from "./cloud-colors.mjs";
import { frameCloud } from "./cloud-framing.mjs";

const params = new URLSearchParams(location.search);
const run = params.get("run"), job = params.get("job");
const api = (params.get("api") || "").replace(/\/$/, "");
const base = run && /^r[0-9a-f]+$/.test(run) ? `${api}/api/live/${run}/files/world/live/` : job && /^[a-f0-9-]+$/.test(job) ? `${api}/api/live/basic/${job}/files/` : null;
const fail = (message) => { const el = document.querySelector("#fail"); el.hidden = false; el.textContent = message; };
try {
  if (!base) throw new Error("No Basic cloud selected.");
  const get = async (name) => { const r = await fetch(base + name); if (!r.ok) throw new Error(`Unable to load ${name} (HTTP ${r.status}).`); return r; };
  const meta = await (await get("cloud.json")).json();
  const motion = await (await get("motion.json")).json();
  const bin = async (name, Type) => new Type(await (await get(name)).arrayBuffer());
  const [bgPos, bgRgb, trPos, trRgb] = await Promise.all([bin(meta.bg.pos, Float32Array), bin(meta.bg.rgb, Uint8Array), bin(meta.trail.pos, Float32Array), bin(meta.trail.rgb, Uint8Array)]);
  if (bgPos.length !== meta.bg.n * 3 || bgRgb.length !== bgPos.length || trPos.length !== meta.trail.n * 3 || trRgb.length !== trPos.length) throw new Error("This cloud is incomplete.");
  const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector("#view"), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(0x020304);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(meta.fovY, meta.aspect, 0.01, 200);
  const points = (pos, rgb, size) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(cloudColors(rgb), 3)); return new THREE.Points(g, new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true })); };
  scene.add(points(bgPos, bgRgb, 0.0075), points(trPos, trRgb, 0.014));
  const palette = [0xffc828, 0x3cdcff, 0xff5aa0, 0x78ff78, 0xc88cff, 0xff8c3c], centre = new THREE.Vector3();
  let pathCount = 0;
  motion.tracks.forEach((t, n) => { const pts = t.path.map((p) => new THREE.Vector3(...p)); if (!pts.length) return; pathCount += 1; const col = palette[n % palette.length]; scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col }))); const head = pts.at(-1), tail = pts[Math.max(0, pts.length - 1 - Math.round(pts.length * 0.15))], dir = head.clone().sub(tail); if (dir.length() > 1e-4) scene.add(new THREE.ArrowHelper(dir.normalize(), head, Math.max(0.12, t.length * 0.25), col, 0.05, 0.03)); centre.add(pts[Math.floor(pts.length / 2)]); });
  if (pathCount) centre.divideScalar(pathCount); else centre.set(0, 0, -1);
  const half = Math.tan(meta.fovY * Math.PI / 360), f = 0.25, corners = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => new THREE.Vector3(x * half * meta.aspect * f, y * half * f, -f)), seg = [];
  corners.forEach((c, i) => seg.push(new THREE.Vector3(), c, c, corners[(i + 1) % 4])); scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg), new THREE.LineBasicMaterial({ color: 0xffd9a8 })));
  const framing = frameCloud(bgPos, trPos, meta.fovY, innerWidth / innerHeight, centre);
  camera.far = framing.far; camera.position.copy(framing.position); camera.updateProjectionMatrix();
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.target.copy(framing.target); controls.update();
  document.querySelector("#info").textContent = `${meta.bg.n.toLocaleString()} scene points · ${meta.trail.ghosts.length} trail moments`;
  document.querySelector("#numbers").textContent = motion.tracks.map((t) => `Subject ${t.track}: ${t.label}\nHeading ${t.angle}° · walked ${t.pathLength} scene units · speed ${t.speed} scene units/s`).join("\n\n") + "\n\nDistances are relative to scene depth, not metres.";
  let touched = false;
  controls.addEventListener("start", () => { touched = true; });
  const resize = () => {
    if (innerWidth <= 0 || innerHeight <= 0) return;
    const frame = frameCloud(bgPos, trPos, meta.fovY, innerWidth / innerHeight, centre);
    renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight;
    if (!touched) { camera.position.copy(frame.position); controls.target.copy(frame.target); controls.update(); }
    camera.far = frame.far + camera.position.distanceTo(frame.position);
    camera.updateProjectionMatrix();
  }; addEventListener("resize", resize); resize(); renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
} catch (error) { fail(error.message); }
