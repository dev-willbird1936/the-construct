import * as THREE from "three";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";

// Basic tier: the clip as a 4D point cloud (backend/tools/make-cloud.py). Every
// frame's subject is lifted into one world and left where it stood; a shader
// compares each point's frame id with the playhead, so the present glows and
// the past is a faint trail. The recording camera and its live frame ride along.

const $ = (s) => document.querySelector(s);
const job = new URLSearchParams(location.search).get("job") || "";
const fail = (message) => { const el = $("#fail"); el.hidden = false; el.textContent = message; throw new Error(message); };
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(job)) fail("No point cloud selected. Open this page from a finished build.");

const BASE = `assets/cloud/${job}/`;
const get = async (url) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) fail(`Unable to load ${url} (HTTP ${response.status}).`);
  return response;
};
const meta = await get(BASE + "cloud.json").then((r) => r.json());
const bin = (name, Type) => get(BASE + name).then((r) => r.arrayBuffer()).then((b) => new Type(b));
const [envPos, envRgb, subPos, subRgb, subFid, clipBlob] = await Promise.all([
  bin("env.pos.f32", Float32Array), bin("env.rgb.u8", Uint8Array),
  bin("subject.pos.f32", Float32Array), bin("subject.rgb.u8", Uint8Array), bin("subject.fid.u16", Uint16Array),
  get(meta.clip).then((r) => r.blob()).catch(() => null),
]);
if (envPos.length !== meta.env * 3 || subPos.length !== meta.subject * 3) fail("This point cloud is incomplete.");

const times = meta.times;
const N = times.length;
const DURATION = Math.max(times[N - 1] - times[0], 0.1);
const aspect = meta.width / meta.height;
const fovX = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(meta.fovY / 2)) * aspect);
$("#info").textContent = `${meta.concept} · ${meta.subject.toLocaleString()} trail points · ${meta.fixed ? "fixed" : "moving"} camera`;

// ── Scene ────────────────────────────────────────────────────────────────

THREE.ColorManagement.enabled = false; // colours stay raw sRGB bytes end to end
const renderer = new THREE.WebGLRenderer({ canvas: $("#view"), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x020304, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const poses = meta.cameras.map((a) => {
  const m = new THREE.Matrix4().fromArray(a);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { p, q };
});
const pointAt = (arr, i) => new THREE.Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);

// A point's on-screen size follows its distance to the viewer; the base is the
// footage's own sample spacing at the typical distance the clip was filmed from.
function spacing(positions, owner, grid) {
  const d = [];
  for (let i = 0; i < positions.length / 3; i += 97) d.push(pointAt(positions, i).distanceTo(poses[owner(i)].p));
  d.sort((a, b) => a - b);
  return (2 * Math.tan(fovX / 2) * d[d.length >> 1]) / grid;
}
const subjectSize = spacing(subPos, (i) => subFid[i], meta.width * 2) * 1.7;
const envSize = spacing(envPos, () => 0, meta.width) * 1.6;

const frameId = Float32Array.from(subFid);
const subject = new THREE.BufferGeometry();
subject.setAttribute("position", new THREE.BufferAttribute(subPos, 3));
subject.setAttribute("color", new THREE.BufferAttribute(subRgb, 3, true));
subject.setAttribute("a_frameId", new THREE.BufferAttribute(frameId, 1));

const vertex = /* glsl */ `
  attribute float a_frameId;
  attribute vec3 color;
  uniform float u_currentTime, u_timeWindow, u_focal, u_size;
  varying float v_isPresent;
  varying vec3 v_color;
  void main() {
    v_isPresent = smoothstep(u_timeWindow, 0.0, abs(a_frameId - u_currentTime));
    v_color = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(u_size * u_focal / -mv.z * mix(1.0, 1.5, v_isPresent), 1.0, 48.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const fragment = /* glsl */ `
  uniform float u_natural;
  varying float v_isPresent;
  varying vec3 v_color;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
    vec3 trailColor = vec3(0.7, 0.25, 0.35);
    vec3 activeColor = vec3(0.2, 1.0, 1.0);
    // the footage's brightness rides on the tint so the subject keeps its form
    float luma = 0.45 + 1.1 * dot(v_color, vec3(0.3, 0.59, 0.11));
    vec3 tinted = mix(trailColor, activeColor, v_isPresent) * luma;
    vec3 finalColor = mix(tinted, v_color * mix(0.7, 1.15, v_isPresent), u_natural);
    float alpha = mix(mix(0.08, 0.16, u_natural), 0.5, v_isPresent);
    gl_FragColor = vec4(finalColor, alpha);
  }
`;
const uniforms = {
  u_currentTime: { value: 0 }, u_timeWindow: { value: 4 }, u_focal: { value: 800 },
  u_size: { value: subjectSize }, u_natural: { value: 0 },
};
const trail = new THREE.Points(subject, new THREE.ShaderMaterial({
  uniforms, vertexShader: vertex, fragmentShader: fragment,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
trail.frustumCulled = false;
scene.add(trail);

const env = new THREE.BufferGeometry();
env.setAttribute("position", new THREE.BufferAttribute(envPos, 3));
env.setAttribute("color", new THREE.BufferAttribute(envRgb, 3, true));
const envMaterial = new THREE.ShaderMaterial({
  uniforms: { u_focal: uniforms.u_focal, u_size: { value: envSize } },
  vertexShader: /* glsl */ `
    attribute vec3 color;
    uniform float u_focal, u_size;
    varying vec3 v_color;
    void main() {
      v_color = color;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = clamp(u_size * u_focal / -mv.z, 1.0, 24.0);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 v_color;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      if (dot(d, d) > 0.25) discard;
      gl_FragColor = vec4(v_color * 0.42, 1.0);
    }
  `,
});
const environment = new THREE.Points(env, envMaterial);
environment.frustumCulled = false;
scene.add(environment);

// ── The recording camera: a frustum with the live source frame on its image plane ──

const FD = 0.14;
const fh = Math.tan(THREE.MathUtils.degToRad(meta.fovY / 2)) * FD, fw = fh * aspect;
const corners = [[-fw, fh], [fw, fh], [fw, -fh], [-fw, -fh]].map(([x, y]) => new THREE.Vector3(x, y, -FD));
const lines = [];
corners.forEach((c, i) => lines.push(new THREE.Vector3(), c, c, corners[(i + 1) % 4]));
const rig = new THREE.Group();
rig.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lines), new THREE.LineBasicMaterial({ color: 0xffd9a8 })));
const video = $("#clip");
let videoTex = null;
if (clipBlob) {
  video.src = URL.createObjectURL(clipBlob);
  videoTex = new THREE.VideoTexture(video);
  videoTex.colorSpace = THREE.NoColorSpace;
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(fw * 2, fh * 2), new THREE.MeshBasicMaterial({ map: videoTex, side: THREE.DoubleSide }));
  pane.position.z = -FD;
  rig.add(pane);
}
scene.add(rig);

// ── Framing: start near the recording view, turned a little, so the trail reads ──

const centre = new THREE.Vector3();
let used = 0;
for (let i = 0; i < meta.subject; i += 31) { centre.add(pointAt(subPos, i)); used++; }
centre.divideScalar(Math.max(used, 1));
const eye = poses[N >> 1].p.clone().sub(centre);
const distance = Math.max(eye.length(), 0.5);
eye.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(40));
camera.position.copy(centre).addScaledVector(eye, distance * 2.1).add(new THREE.Vector3(0, distance * 0.35, 0));
controls.target.copy(centre);
controls.minDistance = distance * 0.1;
controls.maxDistance = distance * 8;
controls.update();

// ── Transport ────────────────────────────────────────────────────────────

let u = 0, playing = true, lastIndex = -1;
const play = $("#play"), scrub = $("#scrub");
const setPlaying = (on) => { playing = on; play.textContent = on ? "❚❚" : "▶"; };
play.onclick = () => setPlaying(!playing);
scrub.oninput = () => { u = +scrub.value; setPlaying(false); };
$("#window").oninput = (e) => { uniforms.u_timeWindow.value = +e.target.value; };
$("#natural").onchange = (e) => { uniforms.u_natural.value = e.target.checked ? 1 : 0; };
addEventListener("keydown", (e) => { if (e.code === "Space" && e.target === document.body) { e.preventDefault(); setPlaying(!playing); } });

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  uniforms.u_focal.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
addEventListener("resize", resize);
resize();

let last = performance.now();
requestAnimationFrame(function loop(now) {
  if (playing) u = (u + Math.max(0, now - last) / 1000 / DURATION) % 1;
  last = now;
  const f = u * (N - 1);
  const i = Math.min(N - 2, Math.floor(f)), k = f - i;
  uniforms.u_currentTime.value = f;
  rig.position.lerpVectors(poses[i].p, poses[Math.min(N - 1, i + 1)].p, k);
  rig.quaternion.slerpQuaternions(poses[i].q, poses[Math.min(N - 1, i + 1)].q, k);
  const nearest = Math.round(f);
  if (videoTex && nearest !== lastIndex && video.readyState >= 1) {
    lastIndex = nearest;
    video.currentTime = times[nearest];
  }
  scrub.value = u;
  $("#clock").textContent = `${(u * DURATION).toFixed(2)}s`;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
});
