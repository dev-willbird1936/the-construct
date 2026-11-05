import * as THREE from "three";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";
import { buildAtlasVolume, disposeVolume, loadVolume, setCut } from "./volume.js";
import { loadWorldLabs } from "./stable-worldlabs.mjs";

const TARGETS = [
  { name: "wolves2106504576-1", label: "Wolf 1", description: "Largest seed-frame mask", match: 0.994, crop: "382 × 131 px", size: "13 KB", note: "Only five slices remained after trailing empty frames were removed; this wolf left the tracked view quickly." },
  { name: "wolves2106504576-2", label: "Wolf 2", description: "Second-largest seed-frame mask", match: 0.978, crop: "631 × 100 px", size: "41 KB", note: "The longest usable track in this batch, with 55 retained poses." },
  { name: "wolves2106504576-3", label: "Wolf 3", description: "Smallest seed-frame mask", match: 0.944, crop: "17 × 15 px", size: "251 KB", note: "Low detail: the source wolf occupied only 17 × 15 pixels at the seed frame, then was enlarged into atlas cells." },
];

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const EMBED = params.has("embed");
if (EMBED) document.body.classList.add("embed");
const targetParam = params.has("target") ? Number(params.get("target")) : NaN;
const canvas = $("#volumeCanvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
THREE.ColorManagement.enabled = false;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0x020304, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
scene.add(camera);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.enablePan = false;
controls.enableZoom = true;
controls.minDistance = 4;
controls.maxDistance = 24;
let renderDirty = true;
let baseView = null;
controls.addEventListener("change", () => { renderDirty = true; });

let selected = Number.isInteger(targetParam) ? Math.max(0, Math.min(TARGETS.length - 1, targetParam)) : 1;
let volume = null;
let meta = null;
let playing = false;
let playhead = 0;
let lastFrame = performance.now();
let loadToken = 0;
let world = null;
let panoTexture = null;
let worldVisible = true;
let environmentReady = false;
let showFullStack = false;

function resetCamera(width = 6, height = 3, depth = 4.6) {
  if (world) {
    camera.fov = 60;
    controls.minDistance = 0.6;
    controls.maxDistance = 18;
    const target = volume ? volume.position.clone().add(new THREE.Vector3(0, height * 0.5, 0)) : new THREE.Vector3(0, 0.5, -1.5);
    controls.target.copy(target);
    camera.position.set(target.x, target.y + Math.max(1.5, height * 0.8), target.z + 2.2);
  } else {
    const maxDim = Math.max(width, height, depth);
    camera.fov = 45;
    controls.minDistance = 4;
    controls.maxDistance = 24;
    controls.target.set(0, 0, 0);
    camera.position.set(maxDim * 0.82, maxDim * 0.48, maxDim * 1.15);
  }
  camera.updateProjectionMatrix();
  camera.lookAt(controls.target);
  controls.update();
  baseView = { target: controls.target.clone(), offset: camera.position.clone().sub(controls.target) };
  renderDirty = true;
}

function resize() {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderDirty = true;
}
new ResizeObserver(resize).observe($("#stage"));
window.addEventListener("resize", resize);

function timeText(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

function renderIndex(index) {
  if (!volume || !meta?.count) return;
  const i = Math.max(0, Math.min(meta.count - 1, Math.round(index)));
  playhead = Number(meta.timestamps?.[i] ?? i / (meta.fps || 1));
  setCut(volume, showFullStack ? 1 : (i + 1) / meta.count);
  if (!showFullStack) {
    const start = Math.max(0, i - 1);
    for (let j = 0; j < start; j += 1) volume.children[j].visible = false;
    for (let j = start; j < i; j += 1) volume.children[j].material.opacity = 0.08;
  }
  $("#timeSlider").value = String(i);
  $("#clock").textContent = `${timeText(playhead)}s`;
  $("#sliceLabel").textContent = `slice ${i + 1} of ${meta.count} · captured t=${playhead.toFixed(3)}s`;
  renderDirty = true;
}

function indexAtTime(seconds) {
  const times = meta?.timestamps || [];
  let index = 0;
  while (index + 1 < times.length && times[index + 1] <= seconds) index += 1;
  return index;
}

function setWorldVisible(visible) {
  worldVisible = visible;
  if (world) {
    world.mesh.visible = visible;
    world.spark.visible = visible;
    if (world.contact) world.contact.visible = visible;
  }
  scene.background = panoTexture || new THREE.Color(0x020304);
  $("#worldToggle").setAttribute("aria-pressed", String(visible));
  $("#worldToggle").textContent = visible ? "3D splats · ON" : "3D splats · OFF";
  renderDirty = true;
}

function setPortalWorldVisible(visible) {
  setWorldVisible(visible);
}

function setEmbeddedLook(x, y) {
  if (!baseView) return;
  const spherical = new THREE.Spherical().setFromVector3(baseView.offset);
  spherical.theta -= THREE.MathUtils.clamp(x, -1, 1) * 0.22;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi + y * 0.08, 0.1, Math.PI - 0.1);
  camera.position.copy(baseView.target).add(new THREE.Vector3().setFromSpherical(spherical));
  controls.target.copy(baseView.target);
  camera.lookAt(baseView.target);
  controls.update();
  renderDirty = true;
}

function publishEmbedded() {
  if (!EMBED || !volume || !meta?.timestamps?.length || !environmentReady || window.__stable) return;
  const times = meta.timestamps;
  const start = times[0];
  const duration = times.at(-1) - start;
  window.__stable = {
    meta: { times },
    setLook: setEmbeddedLook,
    setWorldLabsVisible: setPortalWorldVisible,
    setPlaying: (value) => { playing = !!value; renderDirty = true; },
    seek: (seconds) => renderIndex(indexAtTime(start + THREE.MathUtils.clamp(seconds, 0, duration))),
    frame: (force = false) => { if (force) renderDirty = true; return renderFrame(performance.now()); },
  };
}

async function loadEnvironment() {
  const status = $("#worldStatus");
  const toggle = $("#worldToggle");
  status.textContent = "Loading 360° panorama and 3D world…";
  try {
    panoTexture = await new THREE.TextureLoader().loadAsync("assets/worldlabs/wolves/pano.webp");
    panoTexture.colorSpace = THREE.SRGBColorSpace;
    panoTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = panoTexture;
    world = await loadWorldLabs(renderer, scene, () => { renderDirty = true; }, "wolves", params.get("splats"));
    // Keep the generated sky/foliage translucent over the panorama for legibility.
    world.mesh.opacity = 0.18;
    world.mesh.updateVersion();
    await world.spark.update({ scene, camera });
    setWorldVisible(worldVisible);
    if (volume) resetCamera(volume.userData.width, volume.userData.height, volume.userData.depth);
    toggle.disabled = false;
    status.textContent = "Marble 1.1 · 360° + 3D ready";
  } catch (error) {
    status.textContent = panoTexture ? "360° panorama ready · 3D splats unavailable" : "World Labs environment unavailable";
    toggle.disabled = true;
    toggle.title = error.message;
    console.error("World Labs environment could not load:", error);
  }
  environmentReady = true;
  publishEmbedded();
}

async function loadTarget(index) {
  selected = index;
  playing = false;
  showFullStack = false;
  $("#stackBtn").textContent = "Full stack";
  $("#stackBtn").setAttribute("aria-pressed", "false");
  $("#playBtn").textContent = "Play";
  $("#loading").classList.remove("is-hidden");
  $("#loading").textContent = `Loading ${TARGETS[index].label.toLowerCase()} volume…`;
  $("#targetTitle").textContent = TARGETS[index].label;
  $("#targetNote").textContent = TARGETS[index].description;
  $("#matchScore").textContent = TARGETS[index].match.toFixed(3);
  $("#seedCrop").textContent = TARGETS[index].crop;
  $("#fileSize").textContent = TARGETS[index].size;
  $("#qualityNote").textContent = TARGETS[index].note;
  $("#qualityNote").classList.toggle("is-visible", index !== 1);
  $("#depthViewLink").href = `stable.html?clip=wolf${index + 1}`;
  document.querySelectorAll("[data-target]").forEach((button) => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.target) === index));
  });

  const token = ++loadToken;
  try {
    const loaded = await loadVolume("assets/volumes", TARGETS[index].name);
    if (token !== loadToken) { loaded.texture.dispose(); return; }
    if (volume) disposeVolume(volume);
    meta = loaded.meta;
    const height = Math.min(1.4, 1.8 / meta.aspect);
    volume = buildAtlasVolume(loaded.texture, meta, { depth: 1.2, height });
    volume.position.set(0, 0.25, -1.5);
    volume.children.forEach((slice, i) => {
      slice.material.depthTest = false;
      slice.renderOrder = 90000 + i;
    });
    scene.add(volume);
    $("#sliceCount").textContent = String(meta.count);
    const times = meta.timestamps || [];
    $("#timeSpan").textContent = times.length > 1 ? `${times[0].toFixed(2)}–${times.at(-1).toFixed(2)}s` : "single frame";
    $("#timeSlider").max = String(Math.max(0, meta.count - 1));
    resetCamera(volume.userData.width, volume.userData.height, volume.userData.depth);
    renderIndex(0);
    $("#loading").classList.add("is-hidden");
    publishEmbedded();
  } catch (error) {
    if (token !== loadToken) return;
    $("#loading").textContent = `Could not load target volume: ${error.message}`;
    $("#sliceCount").textContent = "—";
    $("#timeSpan").textContent = "—";
  }
}

function renderFrame(now) {
  const delta = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  if (playing && meta?.timestamps?.length) {
    const start = meta.timestamps[0];
    const end = meta.timestamps.at(-1);
    playhead += delta;
    if (playhead > end) playhead = start;
    const next = indexAtTime(playhead);
    if (next !== Number($("#timeSlider").value)) renderIndex(next);
  }
  controls.update();
  if (!renderDirty) return false;
  renderer.render(scene, camera);
  renderDirty = false;
  return true;
}

function frame(now) {
  if (!EMBED) requestAnimationFrame(frame);
  return renderFrame(now);
}

$("#playBtn").addEventListener("click", () => {
  playing = !playing;
  if (playing && meta?.timestamps?.length && Number($("#timeSlider").value) >= meta.count - 1) playhead = meta.timestamps[0];
  $("#playBtn").textContent = playing ? "Pause" : "Play";
  $("#playBtn").setAttribute("aria-label", playing ? "Pause target" : "Play target");
});
$("#timeSlider").addEventListener("input", (event) => {
  playing = false;
  $("#playBtn").textContent = "Play";
  renderIndex(Number(event.target.value));
});
$("#stackBtn").addEventListener("click", () => {
  playing = false;
  showFullStack = !showFullStack;
  $("#playBtn").textContent = "Play";
  $("#stackBtn").textContent = showFullStack ? "Pose only" : "Full stack";
  $("#stackBtn").setAttribute("aria-pressed", String(showFullStack));
  renderIndex(Number($("#timeSlider").value));
});
$("#resetBtn").addEventListener("click", () => resetCamera(volume?.userData.width, volume?.userData.height, volume?.userData.depth));
document.querySelectorAll("[data-target]").forEach((button) => button.addEventListener("click", () => loadTarget(Number(button.dataset.target))));
$("#worldToggle").addEventListener("click", () => setWorldVisible(!worldVisible));

resize();
loadTarget(selected);
loadEnvironment();
if (!EMBED) requestAnimationFrame(frame);
