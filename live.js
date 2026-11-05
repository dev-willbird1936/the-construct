import * as THREE from "three";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";
import { cloudColors } from "./cloud-colors.mjs";
import { frameCloud } from "./cloud-framing.mjs";

// The selected tier, one step at a time (backend/lib/live.js feeds it). Every step draws itself from the
// server's event stream as the work happens: nothing here is a canned animation.

const params = new URLSearchParams(location.search);
let tier = ["lite", "basic"].includes(params.get("tier")) ? params.get("tier") : "advanced";
// Same origin when the app serves this page; the plain dev server (python serve.py, :4175) has no API, so it points at :8000.
const API = (params.get("api") ?? (location.port === "4175" ? "http://127.0.0.1:8000" : "")).replace(/\/$/, "");
const $ = (s, root = document) => root.querySelector(s);
const abs = (url) => (/^https?:/.test(url) ? url : API + url);
const fail = (message) => { const box = $("#fail"); box.hidden = false; box.textContent = message; };
const PALETTE = ["#ffc828", "#3cdcff", "#ff5aa0", "#78ff78", "#c88cff", "#ff8c3c"];     // the same order motion.jpg uses
const SPACING = 0.45;                                                                    // a new ghost when a subject has moved this many of its widths

const resultName = { lite: "Ghost trail", basic: "Cloud trail", advanced: "World" };
document.title = `${tier[0].toUpperCase() + tier.slice(1)} · ${resultName[tier]} — The Construct`;
$(".top b").textContent = `${tier.toUpperCase()} · LIVE`;
$("#headline").textContent = {
  lite: "Upload a clip to make a trail of real cut-outs.",
  basic: "Upload a clip to estimate scene depth and a cloud trail.",
  advanced: "Upload a clip to rebuild a scene where the footage supports it.",
}[tier];

// ── steps ────────────────────────────────────────────────────────────────

const STEPS = [
  ["upload", "Your clip"], ["frame", "Start frame"], ["pick", "Choose subjects"], ["track", "Follow and cut out"],
  ["scene", "Empty scene and depth"], ["heading", "Which way they go"], ["cloud", "First cloud trail"],
  ["shells", "Depth shells"], ["water", "Live footage"], ["done", "The world"],
];
const STAGE_STEP = { trim: "track", probe: "track", prepare: "track", track: "track", ghosts: "track", world: "scene", plate: "scene", depth: "scene", motion: "heading", cloud: "cloud", environment: "cloud", shells: "shells", water: "water", pack: "done" };
const times = new Map();          // step -> { start, end }
let activeStep = null;

const rail = $("#rail");
for (const [id, label] of STEPS) {
  if (tier === "lite" && !["upload", "frame", "pick", "track", "done"].includes(id)) continue;
  if (tier === "basic" && ["shells", "water"].includes(id)) continue;
  const a = document.createElement("a");
  a.href = `#card-${id}`;
  a.dataset.step = id;
  const railLabel = id === "done" ? `The ${resultName[tier].toLowerCase()}` : label;
  a.innerHTML = `<span class="dot">·</span><span>${railLabel}</span><time></time>`;
  rail.append(a);
}

if (tier === "lite") {
  document.querySelector("#card-done h2").firstChild.textContent = "5";
  document.querySelector("#card-done h2").childNodes[1].textContent = " The ghost trail ";
}
if (tier === "basic") {
  document.querySelector("#card-done h2").firstChild.textContent = "8";
  document.querySelector("#card-done h2").childNodes[1].textContent = " The cloud trail ";
}
for (const h of document.querySelectorAll(".card h2")) {
  h.tabIndex = 0;
  h.setAttribute("role", "button");
  h.setAttribute("aria-expanded", "true");
  const toggle = () => h.setAttribute("aria-expanded", String(!h.parentElement.classList.toggle("collapsed")));
  h.addEventListener("click", toggle);
  h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}
function showStep(id) { $(`#card-${id}`).hidden = false; }
function enter(id, { scroll = true } = {}) {
  if (activeStep === id) return;
  if (activeStep) leave(activeStep);
  activeStep = id;
  showStep(id);
  times.set(id, { start: performance.now(), end: null });
  $(`#card-${id}`).classList.remove("done", "failed");
  $(`#card-${id}`).classList.add("active");
  paintRail();
  if (scroll) $(`#card-${id}`).scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
}
function leave(id, state = "done") {
  const t = times.get(id);
  if (t && !t.end) t.end = performance.now();
  const card = $(`#card-${id}`);
  card.classList.remove("active");
  card.classList.add(state);
  if (state === "done" && ["upload", "frame", "pick"].includes(id)) {
    card.classList.add("collapsed");     // the choices made; the work is what to watch
    $("h2", card).setAttribute("aria-expanded", "false");
  }
  rail.querySelector(`[data-step="${id}"]`).dataset.state = state;
  paintRail();
}
function paintRail() {
  for (const a of rail.children) {
    const id = a.dataset.step;
    const state = $(`#card-${id}`).classList.contains("active") ? "active" : a.dataset.state || (times.has(id) ? "done" : "");
    a.className = state;
    if (state === "active") a.setAttribute("aria-current", "step");
    else a.removeAttribute("aria-current");
    a.firstChild.textContent = state === "done" ? "✓" : state === "failed" ? "✕" : state === "active" ? "●" : "·";
  }
}
setInterval(() => {
  for (const [id, t] of times) {
    const s = (((t.end ?? performance.now()) - t.start) / 1000).toFixed(1) + " s";
    $(`#card-${id} .t`).textContent = s;
    rail.querySelector(`[data-step="${id}"] time`).textContent = s;
  }
  if (run.started && !run.finished) $("#clock").textContent = `${((performance.now() - run.started) / 1000).toFixed(0)} s since you pressed Build`;
}, 200);

// ── state ────────────────────────────────────────────────────────────────

const state = { epoch: 0, ready: false, uploadId: null, info: null, time: 0, frame: null, objects: [], selected: new Set(), idx: null, dino: null, hover: 0, view: "frame" };
const run = { started: 0, finished: false, source: null, sources: new Set() };
let cloud = null;

function closeSources() { for (const source of run.sources) source.close(); run.sources.clear(); run.source = null; }
function listen(runId, handlers, onEnd, epoch = state.epoch) {
  const source = new EventSource(`${API}/api/live/${runId}/events`);
  run.source = source; run.sources.add(source);
  const close = () => { source.close(); run.sources.delete(source); };
  source.onmessage = (m) => {
    if (epoch !== state.epoch) return close();
    try {
      const e = JSON.parse(m.data);
      Promise.resolve(handlers[e.type]?.(e, epoch)).catch(error => { if (epoch === state.epoch) console.error(e.type, error); });
    } catch (error) { if (epoch === state.epoch) console.error(error); }
  };
  source.addEventListener("end", () => { close(); if (epoch === state.epoch) onEnd?.(); });
  source.onerror = () => { if (epoch === state.epoch && source.readyState === EventSource.CLOSED) { close(); fail("Lost the connection to the server."); } };
}

async function post(path, body) {
  const res = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} failed (${res.status})`);
  return data;
}
// Stop button: ends every run of this user (detect, selection, build), kills their processes, and frees the "already building" lock
$("#stopAll").addEventListener("click", async () => {
  const button = $("#stopAll"); button.disabled = true;
  const epoch = state.epoch;
  try {
    const { stopped } = await post("/api/live/cancel-all", {});
    if (epoch !== state.epoch) return;
    state.epoch++; closeSources(); run.finished = true; state.moreBusy = false;
    $("#useFrame").disabled = !state.ready;
    $("#headline").textContent = stopped ? `Stopped ${stopped} running job${stopped === 1 ? "" : "s"}.` : "Nothing was running. The build lock is cleared.";
    if (activeStep && activeStep !== "pick") leave(activeStep, "failed");
    $("#fail").hidden = true;
    if (state.objects.length) $("#build").disabled = false;
    $("#pickNote").textContent ||= "";
  } catch (error) { if (epoch === state.epoch) fail(error.message); }
  finally { button.disabled = false; }
});
const chip = (text, cls = "") => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };

// ── 1 · upload ───────────────────────────────────────────────────────────

const drop = $("#drop"), file = $("#file");
file.addEventListener("change", () => file.files[0] && upload(file.files[0], beginClip()));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files[0] && upload(e.dataTransfer.files[0], beginClip()); });
$("#useGrizzly").addEventListener("click", async () => {
  const epoch = beginClip();
  try {
    $("#uploadNote").textContent = "Fetching the clip…";
    const response = await fetch("assets/clips/trailcam/grizzly.mp4");
    if (epoch !== state.epoch) return;
    if (!response.ok) throw new Error("Could not fetch the clip.");
    const blob = await response.blob();
    if (epoch !== state.epoch) return;
    await upload(new File([blob], "grizzly.mp4", { type: "video/mp4" }), epoch);
  } catch (error) { failClip(error, epoch); }
});
enter("upload", { scroll: false });

function beginClip() {
  const epoch = ++state.epoch;
  closeSources(); cloud?.dispose(); cloud = null;
  Object.assign(state, { ready: false, uploadId: null, info: null, time: 0, frame: null, objects: [], idx: null, dino: null, hover: 0, view: "frame", detectRun: null, moreBusy: false, name: null, checks: null });
  state.selected.clear(); heatCache.clear(); track.chain = Promise.resolve();
  run.started = 0; run.finished = true; times.clear(); timings.clear(); activeStep = null;
  video.pause(); video.removeAttribute("src"); video.load();
  for (const id of ["useFrame", "back", "fwd", "time", "build", "similar"]) $("#" + id).disabled = true;
  addControls.querySelectorAll("input, button").forEach(el => { el.disabled = true; });
  for (const card of document.querySelectorAll(".card")) {
    card.hidden = card.id !== "card-upload"; card.classList.remove("active", "done", "failed", "collapsed");
    card.querySelector("h2").setAttribute("aria-expanded", "true");
  }
  for (const item of rail.children) delete item.dataset.state;
  for (const id of ["objects", "camera", "names", "scene", "concepts", "dinoNote", "pickNote", "trackNote", "trackChips", "sceneChips", "headings", "shellNote", "shellGrid", "waterStrip", "doneNote", "gate", "timings", "cloudHud"]) $("#" + id).replaceChildren();
  for (const id of ["pickImg", "plateImg", "depthImg", "groundImg", "motionImg", "waterImg"]) $("#" + id).removeAttribute("src");
  for (const id of ["pickMasks", "pickHeat", "trackBase", "trackGhosts", "trackLive"]) { const canvas = $("#" + id); canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height); }
  $("#world").removeAttribute("src"); $("#openWorld").removeAttribute("href");
  $("#dinoView").hidden = $("#pickTip").hidden = dragBox.hidden = true; drag = null;
  $("#fail").hidden = true; $("#headline").textContent = "Preparing your clip…";
  enter("upload", { scroll: false });
  return epoch;
}
function failClip(error, epoch) {
  if (epoch !== state.epoch) return;
  state.ready = false; state.uploadId = null; state.info = null;
  $("#useFrame").disabled = true; $("#uploadNote").textContent = "Clip not ready."; $("#headline").textContent = "Choose a clip to continue.";
  fail(error.message);
}
async function upload(f, epoch) {
  if (epoch !== state.epoch) return;
  try {
    $("#uploadNote").textContent = `Uploading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`;
    const form = new FormData(); form.append("video", f); form.append("rights", "1");
    const res = await fetch(`${API}/api/upload`, { method: "POST", body: form });
    if (epoch !== state.epoch) return;
    const up = await res.json().catch(() => ({}));
    if (epoch !== state.epoch) return;
    if (!res.ok) throw new Error(up.error || "Upload failed.");
    await prepare(up.uploadId || up.jobId, epoch);
  } catch (error) { failClip(error, epoch); }
}

// the clip is already on the server: the main page uploaded it, or the visitor came back to it
async function prepare(uploadId, epoch) {
  if (epoch !== state.epoch) return;
  try {
    $("#uploadNote").textContent = "Looking at the camera…";
    const info = await post("/api/live/prepare", { uploadId });
    if (epoch !== state.epoch) return;
    const chips = $("#camera");
    chips.replaceChildren(
      chip(`${info.width}×${info.height}`), chip(`${info.fps.toFixed(1)} fps`), chip(`${info.duration.toFixed(1)} s`),
      ...(info.camera ? [
        chip(info.camera.fixed ? `camera fixed · ${info.camera.shift} px drift` : info.camera.stabilizable ? `camera nudged · ${info.camera.shift} px, will be held still` : `camera moving · ${info.camera.shift} px`, info.supported ? "ok" : "bad"),
        ...(info.camera.overlay < 1 ? [chip(`data strip at the bottom ${Math.round((1 - info.camera.overlay) * 100)}%, left out`, "warn")] : []),
        ...(info.camera.crop ? [chip("black bars, trimmed", "warn")] : []),
      ] : [chip("camera could not be checked", "warn")]));
    if (!info.supported && tier !== "lite") return failClip(new Error(info.reason), epoch);
    state.uploadId = uploadId; state.info = info; state.ready = true;
    $("#uploadNote").textContent = ""; $("#headline").textContent = "Choose a start frame.";
    for (const id of ["useFrame", "back", "fwd", "time"]) $("#" + id).disabled = false;
    leave("upload"); openFrameStep(info);
  } catch (error) { failClip(error, epoch); }
}

// ── 2 · start frame ──────────────────────────────────────────────────────

const video = $("#preview"), slider = $("#time");
function openFrameStep(info) {
  enter("frame");
  video.src = API + info.previewUrl;
  slider.max = Math.max(0, info.duration - 1 / info.fps);
  slider.step = 1 / info.fps;
  slider.value = 0;
  seek(0);
}
function seek(t) {
  const step = 1 / state.info.fps;
  t = Math.max(0, Math.min(Number(slider.max), Math.round(t / step) * step));
  slider.value = t;
  video.currentTime = t + step / 4;      // land inside the frame, not on its edge
  $("#timeOut").textContent = `${t.toFixed(2)} s · frame ${Math.round(t * state.info.fps)}`;
}
slider.addEventListener("input", () => seek(Number(slider.value)));
$("#back").addEventListener("click", () => seek(Number(slider.value) - 1 / state.info.fps));
$("#fwd").addEventListener("click", () => seek(Number(slider.value) + 1 / state.info.fps));
$("#useFrame").addEventListener("click", async () => {
  if (!state.ready) return;
  const epoch = state.epoch;
  try {
    state.time = Number(slider.value);
    $("#useFrame").disabled = true;
    video.pause();
    const { runId } = await post("/api/live/detect", { uploadId: state.uploadId, time: state.time });
    if (epoch !== state.epoch) return;
    state.detectRun = runId;
    leave("frame");
    enter("pick");
    listen(runId, detectHandlers, () => { if (activeStep === "pick") $("#pickNote").textContent ||= "Click the subjects you want. Up to three of one kind."; }, epoch);
  } catch (error) { if (epoch === state.epoch) { $("#useFrame").disabled = !state.ready; fail(error.message); } }
});

// ── 3 · pick ─────────────────────────────────────────────────────────────

const pickImg = $("#pickImg"), masks = $("#pickMasks"), heat = $("#pickHeat");
const objectColour = (id) => PALETTE[(id - 1) % PALETTE.length];
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

const detectHandlers = {
  stage(e) { if (e.id === "sam") $("#concepts").replaceChildren(...e.concepts.map((c) => { const s = chip(c); s.dataset.concept = c; return s; })); },
  frame(e) { pickImg.src = abs(e.url); state.frame = e; masks.width = heat.width = e.width; masks.height = heat.height = e.height; },
  note(e) { $("#scene").textContent = e.text; },
  names(e) {
    $("#names").replaceChildren(...(e.subjects.length ? e.subjects.map((s) => chip(s.label, s.main ? "main" : "")) : [chip("nothing named")]));
    $("#scene").textContent ||= e.scene;
  },
  concept(e) {
    const c = $(`#concepts [data-concept="${CSS.escape(e.concept)}"]`);
    if (c) { c.textContent = `${e.concept} · ${e.boxes.length}`; c.className = e.boxes.length ? "ok" : ""; }
    const g = masks.getContext("2d");
    g.lineWidth = 3;
    g.strokeStyle = "rgba(255,217,168,.85)";
    for (const [l, t, r, b] of e.boxes) g.strokeRect(l * masks.width, t * masks.height, (r - l) * masks.width, (b - t) * masks.height);
  },
  async objects(e, epoch) {
    state.objects = e.objects;
    masks.getContext("2d").clearRect(0, 0, masks.width, masks.height);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = abs(e.indexUrl);
    await img.decode();
    if (epoch !== state.epoch) return;
    const off = document.createElement("canvas");
    off.width = e.width; off.height = e.height;
    const g = off.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, e.width, e.height).data;
    state.idx = new Uint8Array(e.width * e.height);
    for (let i = 0; i < state.idx.length; i += 1) state.idx[i] = px[i * 4];
    addControls.querySelectorAll("input, button").forEach(el => { el.disabled = false; });
    for (const o of e.objects) if (o.suggested) state.selected.add(o.id);
    renderObjects();
    paintMasks();
  },
  dino(e) {
    state.dino = e.error ? null : e;
    const note = $("#dinoNote");
    if (e.error) { note.textContent = `Unavailable: ${e.error}`; return; }
    $("#dinoName").textContent = e.dinov3 ? "DINOv3" : "DINOv2 (stand-in)";
    note.textContent = e.dinov3 ? `${e.model} · ${e.groups.length} kind(s) among ${state.objects.length} objects` : `${e.model} stands in: DINOv3's weights are gated on Hugging Face and not installed. ${e.groups.length} kind(s) among ${state.objects.length} objects.`;
    $("#dinoView").hidden = false;
    $("#similar").disabled = false;
    renderObjects();
  },
  error(e) { $("#pickNote").textContent = e.message; leave("pick", "failed"); fail(e.message); },
  cancelled(e) { $("#pickNote").textContent = e.message; },
};

function renderObjects() {
  const list = $("#objects");
  list.replaceChildren(...state.objects.map((o) => {
    const li = document.createElement("li"), button = document.createElement("button");
    li.className = state.selected.has(o.id) ? "sel" : "";
    button.type = "button";
    button.setAttribute("aria-pressed", String(state.selected.has(o.id)));
    const thumb = document.createElement("canvas");
    thumb.width = 64; thumb.height = 48;
    const b = o.box, g = thumb.getContext("2d");
    if (pickImg.complete && pickImg.naturalWidth) g.drawImage(pickImg, b.left * pickImg.naturalWidth, b.top * pickImg.naturalHeight, (b.right - b.left) * pickImg.naturalWidth, (b.bottom - b.top) * pickImg.naturalHeight, 0, 0, 64, 48);
    const label = document.createElement("span"); label.textContent = o.label;
    button.append(thumb, label);
    button.addEventListener("click", () => toggle(o.id));
    button.addEventListener("focus", () => hover(o.id));
    button.addEventListener("blur", () => hover(0));
    li.append(button);
    if (o.added) {
      const input = document.createElement("input"); input.value = o.label; input.maxLength = 80; input.setAttribute("aria-label", "Edit subject name");
      input.addEventListener("change", () => { o.label = input.value.trim().toLowerCase() || "object"; renderObjects(); paintMasks(); });
      li.append(input);
    }
    li.addEventListener("mouseenter", () => hover(o.id));
    li.addEventListener("mouseleave", () => hover(0));
    return li;
  }));
  const picked = state.objects.filter((o) => state.selected.has(o.id));
  const kinds = new Set(picked.map((o) => o.label));
  const ok = picked.length >= 1 && picked.length <= 3 && kinds.size === 1 && !state.moreBusy;
  $("#build").disabled = !ok;
  $("#build").textContent = picked.length ? `Build with ${picked.length} subject${picked.length > 1 ? "s" : ""}` : "Build";
  $("#pickNote").textContent = !picked.length ? "Click the subjects you want to follow." : picked.length > 3 ? "Three subjects at most." : kinds.size > 1 ? "One kind at a time (for example, only bears)." : "";
}
function toggle(id) { state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); renderObjects(); paintMasks(); paintHeat(); }
function hover(id) { if (state.hover === id) return; state.hover = id; paintMasks(); paintHeat(); }

function paintMasks() {
  if (!state.idx) return;
  const w = masks.width, h = masks.height, g = masks.getContext("2d");
  const out = g.createImageData(w, h);
  const rgb = new Map(state.objects.map((o) => [o.id, hex(objectColour(o.id))]));
  for (let i = 0; i < state.idx.length; i += 1) {
    const id = state.idx[i];
    if (!id) continue;
    const c = rgb.get(id);
    const edge = id === state.hover && (i % w === 0 || i % w === w - 1 || i < w || i >= w * (h - 1) || state.idx[i - 1] !== id || state.idx[i + 1] !== id || state.idx[i - w] !== id || state.idx[i + w] !== id);
    const a = edge ? 255 : state.selected.has(id) ? 170 : id === state.hover ? 95 : 38;
    out.data[i * 4] = c[0]; out.data[i * 4 + 1] = c[1]; out.data[i * 4 + 2] = c[2]; out.data[i * 4 + 3] = a;
  }
  g.putImageData(out, 0, 0);
  const picked = state.objects.filter(o => state.selected.has(o.id));
  picked.forEach((o, i) => {
    const x = o.box.left * w, y = o.box.top * h;
    g.fillStyle = objectColour(o.id); g.beginPath(); g.arc(x + 13, y + 13, 13, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#111"; g.font = "bold 16px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(i + 1), x + 13, y + 13);
  });
}

const heatCache = new Map();
async function heatImage(id, epoch) {
  if (!heatCache.has(id)) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = abs(state.dino.heat[id]);
    try { await img.decode(); } catch { if (epoch === state.epoch) $("#dinoNote").textContent = "Could not load this view."; return null; }
    if (epoch !== state.epoch) return null;
    heatCache.set(id, img);
  }
  return heatCache.get(id);
}
async function paintHeat() {
  const epoch = state.epoch;
  const g = heat.getContext("2d");
  g.clearRect(0, 0, heat.width, heat.height);
  heat.style.mixBlendMode = state.view === "pca" ? "normal" : "screen";
  if (!state.dino || state.view === "frame") return;
  if (state.view === "pca") {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = abs(state.dino.pca);
    try { await img.decode(); } catch { if (epoch === state.epoch) $("#dinoNote").textContent = "Could not load this view."; return; }
    if (epoch !== state.epoch) return;
    g.globalAlpha = 0.94;
    g.imageSmoothingEnabled = true;
    g.drawImage(img, 0, 0, heat.width, heat.height);
    g.globalAlpha = 1;
    return;
  }
  const id = state.hover || [...state.selected].at(-1);
  if (!id || !state.dino.heat[id]) return;
  const img = await heatImage(id, epoch);
  if (epoch !== state.epoch || !img) return;
  const small = document.createElement("canvas");
  small.width = img.width; small.height = img.height;
  const sg = small.getContext("2d", { willReadFrequently: true });
  sg.drawImage(img, 0, 0);
  const data = sg.getImageData(0, 0, small.width, small.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = data.data[i] / 255;      // warm where alike
    data.data[i] = Math.min(255, v * 2 * 255);
    data.data[i + 1] = Math.min(255, Math.max(0, v - 0.35) * 2.2 * 255);
    data.data[i + 2] = Math.max(0, 0.3 - v) * 255;
    data.data[i + 3] = 255;
  }
  sg.putImageData(data, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, heat.width, heat.height);
}
for (const b of $("#dinoView").children) b.addEventListener("click", () => {
  state.view = b.dataset.v;
  for (const o of $("#dinoView").children) o.classList.toggle("on", o === b);
  paintHeat();
});

function objectAt(ev) {
  const r = masks.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - r.left) / r.width) * masks.width), y = Math.floor(((ev.clientY - r.top) / r.height) * masks.height);
  return { id: state.idx?.[y * masks.width + x] ?? 0, x: ev.clientX - r.left, y: ev.clientY - r.top };
}
masks.addEventListener("mousemove", (ev) => {
  const { id, x, y } = objectAt(ev);
  hover(id);
  const tip = $("#pickTip");
  const o = state.objects.find((s) => s.id === id);
  tip.hidden = !o;
  if (o) { tip.style.left = `${x}px`; tip.style.top = `${y}px`; tip.textContent = o.label + (state.selected.has(id) ? " · chosen" : ""); }
});
masks.addEventListener("mouseleave", () => { hover(0); $("#pickTip").hidden = true; });
const addControls = document.createElement("div");
addControls.className = "pick-add";
addControls.innerHTML = '<p>Nothing found? Click it, draw a box, or type what it is.</p><form><label>Find a subject <input name="concept" maxlength="80" placeholder="the red kayak" required></label><button type="submit">Find</button></form>';
$("#objects").before(addControls);
addControls.querySelectorAll("input, button").forEach(el => { el.disabled = true; });
addControls.querySelector("form").addEventListener("submit", e => { e.preventDefault(); const input = addControls.querySelector("input"); addMore({ concept: input.value.trim() }); });
async function addMore(request) {
  if (!state.idx || state.moreBusy) return;
  const epoch = state.epoch;
  state.moreBusy = true; renderObjects(); $("#pickNote").textContent = "Finding subject…";
  try {
    const { runId } = await post("/api/live/detect-more", { uploadId: state.uploadId, runId: state.detectRun, ...request });
    if (epoch !== state.epoch) return;
    let task = Promise.resolve(), failed = false;
    listen(runId, {
      concept: detectHandlers.concept,
      objects(e) { task = mergeMore(e, epoch); task.catch(() => {}); },
      error(e) { failed = true; $("#pickNote").textContent = e.message; },
    }, async () => {
      try { await task; } catch (error) { if (epoch !== state.epoch) return; failed = true; $("#pickNote").textContent = error.message; }
      if (epoch !== state.epoch) return;
      state.moreBusy = false; const message = $("#pickNote").textContent; renderObjects(); if (failed || message === "No subjects found. Try another selection." || message === "That subject is already listed.") $("#pickNote").textContent = message;
    }, epoch);
  } catch (error) { if (epoch === state.epoch) { state.moreBusy = false; renderObjects(); $("#pickNote").textContent = error.message; } }
}
async function mergeMore(e, epoch) {
  if (!e.objects.length) { $("#pickNote").textContent = "No subjects found. Try another selection."; return; }
  const img = new Image(); img.crossOrigin = "anonymous"; img.src = abs(e.indexUrl); await img.decode();
  if (epoch !== state.epoch) return;
  const off = document.createElement("canvas"); off.width = e.width; off.height = e.height;
  const g = off.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const pixels = g.getImageData(0, 0, e.width, e.height).data, ids = new Map();
  let next = Math.max(0, ...state.objects.map(o => o.id));
  if (next + e.objects.length > 255) throw new Error("Too many subjects found. Choose another frame.");
  const existingArea = new Map(), newArea = new Map(), overlap = new Map();
  for (let i = 0; i < state.idx.length; i++) {
    const oldId = state.idx[i], newId = pixels[i * 4];
    if (oldId) existingArea.set(oldId, (existingArea.get(oldId) || 0) + 1);
    if (newId) newArea.set(newId, (newArea.get(newId) || 0) + 1);
    if (oldId && newId) { const key = `${newId}:${oldId}`; overlap.set(key, (overlap.get(key) || 0) + 1); }
  }
  for (const o of e.objects) {
    const duplicate = state.objects.some(old => { const n = overlap.get(`${o.id}:${old.id}`) || 0; return n / ((newArea.get(o.id) || 0) + (existingArea.get(old.id) || 0) - n) >= .85; });
    if (!duplicate) { ids.set(o.id, ++next); state.objects.push({ ...o, id: next, added: true }); }
  }
  for (let i = 0; i < state.idx.length; i++) if (ids.has(pixels[i * 4]) && !state.idx[i]) state.idx[i] = ids.get(pixels[i * 4]);
  renderObjects(); paintMasks();
  if (!ids.size) $("#pickNote").textContent = "That subject is already listed.";
}
function point(ev) { const r = masks.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) }; }
let drag;
const dragBox = document.createElement("div"); dragBox.className = "pick-drag"; dragBox.hidden = true; $("#pickBox").append(dragBox);
masks.addEventListener("pointerdown", ev => { if (!state.idx || state.moreBusy) return; drag = { start: point(ev), x: ev.clientX, y: ev.clientY }; masks.setPointerCapture(ev.pointerId); });
masks.addEventListener("pointermove", ev => {
  if (!drag) return;
  const end = point(ev), start = drag.start;
  dragBox.hidden = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) <= 5;
  Object.assign(dragBox.style, { left: `${Math.min(start.x, end.x) * 100}%`, top: `${Math.min(start.y, end.y) * 100}%`, width: `${Math.abs(start.x - end.x) * 100}%`, height: `${Math.abs(start.y - end.y) * 100}%` });
});
masks.addEventListener("pointerup", ev => {
  if (!drag) return;
  const end = point(ev), start = drag.start, moved = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 5; drag = null; dragBox.hidden = true;
  if (!moved) { const { id } = objectAt(ev); if (id) { toggle(id); return; } }
  const dx = moved ? 0 : Math.max(1 / masks.width, .01), dy = moved ? 0 : Math.max(1 / masks.height, .01);
  addMore({ box: { left: Math.max(0, Math.min(start.x, end.x) - dx), top: Math.max(0, Math.min(start.y, end.y) - dy), right: Math.min(1, Math.max(start.x, end.x) + dx), bottom: Math.min(1, Math.max(start.y, end.y) + dy) } });
});
masks.addEventListener("pointercancel", () => { drag = null; dragBox.hidden = true; });
$("#similar").addEventListener("click", () => {
  for (const id of [...state.selected]) for (const g of state.dino?.groups ?? []) if (g.includes(id)) g.forEach((m) => state.selected.add(m));
  renderObjects(); paintMasks();
});

$("#build").addEventListener("click", async () => {
  if (!state.ready) return;
  const epoch = state.epoch;
  try {
    $("#build").disabled = true;
    const picked = state.objects.filter((o) => state.selected.has(o.id));
    const response = await post("/api/live/build", { uploadId: state.uploadId, time: state.time, tier, objects: picked.map((o) => ({ label: o.label, box: o.box })) });
    if (epoch !== state.epoch) return;
    const { runId } = response;
    tier = response.tier || tier;
    leave("pick");
    run.started = performance.now();
    $("#headline").textContent = `Building ${picked.map((o) => o.label).join(" + ")}…`;
    resetBuild();
    listen(runId, buildHandlers, () => { run.finished = true; }, epoch);
  } catch (error) { if (epoch === state.epoch) { $("#build").disabled = !state.ready; fail(/already have a build/.test(error.message) ? `${error.message} Or press “Stop everything” (top right) to end it and start this one.` : error.message); } }
});

// ── 4 · tracking: the cut-outs arrive as SAM finishes frames ─────────────

const layers = { base: $("#trackBase"), ghosts: $("#trackGhosts"), live: $("#trackLive") };
const track = { w: 0, h: 0, fps: 15, samples: 0, mode: "provisional", keys: new Map(), last: new Map(), chain: Promise.resolve(), liveSample: -1, frameBase: "" };

function resetBuild() {
  track.keys.clear(); track.last.clear(); track.mode = "provisional"; track.liveSample = -1;
}
function keyColour(key) { if (!track.keys.has(key)) track.keys.set(key, PALETTE[track.keys.size % PALETTE.length]); return track.keys.get(key); }

async function drawCut(e, epoch) {
  if (epoch !== state.epoch) return;
  const img = new Image();
  img.src = abs(e.url);
  try { await img.decode(); } catch { return; }
  if (epoch !== state.epoch) return;
  const key = e.track != null ? `t${e.track}` : `${e.chunk}:${e.id}`;
  const [l, t, r, b] = e.box;
  const x = l * track.w, y = t * track.h, w = (r - l) * track.w, h = (b - t) * track.h;
  const colour = keyColour(key);
  const lg = layers.live.getContext("2d");
  if (e.sample !== track.liveSample) { lg.clearRect(0, 0, track.w, track.h); track.liveSample = e.sample; }
  lg.save();
  lg.shadowColor = colour; lg.shadowBlur = 14;
  lg.drawImage(img, x, y, w, h);
  lg.restore();
  const prev = track.last.get(key);
  const centre = [x + w / 2, y + h / 2];
  const moved = prev ? Math.hypot(centre[0] - prev.c[0], centre[1] - prev.c[1]) / Math.max(w, prev.w) : Infinity;
  if (moved > SPACING || (prev && e.sample - prev.sample > track.fps * 1.5)) {
    const gg = layers.ghosts.getContext("2d");
    gg.save();
    gg.globalAlpha = 0.55;
    gg.shadowColor = colour; gg.shadowBlur = 8;
    gg.drawImage(img, x, y, w, h);
    gg.restore();
    track.last.set(key, { c: centre, w, sample: e.sample });
  } else if (!prev) track.last.set(key, { c: centre, w, sample: e.sample });
}

// what the builder is doing right now, under the card it belongs to
function note(stageId, text) {
  if (!text) return;
  $("#headline").textContent = text;
  const step = STAGE_STEP[stageId];
  if (step === "track") $("#trackNote").textContent = text;
  else if (step) { const p = $(`#card-${step} .live`); if (p) p.textContent = text; }
}

const buildHandlers = {
  stage(e) {
    const step = STAGE_STEP[e.id];
    if (step) enter(step);
    $("#headline").textContent = e.label || $("#headline").textContent;
  },
  "stage-detail"(e) { note(e.id, e.label); },
  detail(e) { note(e.id, e.label); },
  "stage-end"(e) { timings.set(e.id, e.seconds); },
  plan(e) {
    $("#trackNote").textContent = `Starting at ${e.from.toFixed(2)} s · ${e.samples} frames at ${e.sampleFps} per second${e.everyFrame ? " (every frame)" : ` (the clip has ${e.nativeFps.toFixed(0)}; long clips are sampled so the whole run stays bounded)`}.`;
    state.name = e.name;
  },
  probe(e) { $("#trackChips").append(chip(e.camera?.fixed ? "camera fixed" : e.camera?.stabilizable ? "camera held still" : "camera?", "ok")); },
  async "track-start"(e, epoch) {
    track.w = e.width; track.h = e.height; track.fps = e.fps; track.samples = e.samples; track.frameBase = abs(e.frameBase);
    for (const c of Object.values(layers)) { c.width = e.width; c.height = e.height; }
    $("#trackBox").style.aspectRatio = `${e.width} / ${e.height}`;
    const img = new Image();
    img.src = abs(e.frameUrl);
    await img.decode();
    if (epoch !== state.epoch) return;
    const g = layers.base.getContext("2d");
    g.drawImage(img, 0, 0);
    g.fillStyle = "rgba(2,3,4,.55)";
    g.fillRect(0, 0, e.width, e.height);
  },
  cut(e, epoch) {
    if (e.provisional && track.mode === "final") return;
    if (!e.provisional && track.mode !== "final") return;
    track.chain = track.chain.then(() => drawCut(e, epoch));
  },
  "track-progress"(e) { $("#trackBar").style.width = `${((e.sample + 1) / e.samples) * 100}%`; $("#trackNote").textContent = `SAM 3.1 · frame ${e.sample + 1} of ${e.samples}`; },
  tracked(e) { $("#trackChips").append(chip(`${e.tracks.length} track${e.tracks.length === 1 ? "" : "s"} found`)); },
  selection(e, epoch) {
    track.mode = "final";
    track.keys.clear(); track.last.clear(); track.liveSample = -1;
    track.chain = track.chain.then(() => { if (epoch !== state.epoch) return; layers.ghosts.getContext("2d").clearRect(0, 0, track.w, track.h); layers.live.getContext("2d").clearRect(0, 0, track.w, track.h); });
    $("#trackBar").style.width = "0%";
    $("#trackChips").append(chip(`${e.trackIds.length} of yours`, "ok"), ...(e.others ? [chip(`${e.others} other${e.others === 1 ? "" : "s"} painted out of the scene`)] : []));
  },
  "ghost-progress"(e) { $("#trackBar").style.width = `${((e.sample + 1) / e.samples) * 100}%`; $("#trackNote").textContent = `Cutting your subjects out, frame ${e.sample + 1} of ${e.samples}`; },
  "ghosts-done"() { $("#trackNote").textContent = "Every frame cut out. The ghosts are spaced by how far each subject actually moved."; $("#trackBar").style.width = "100%"; },

  // ── the world builder, stage by stage ──
  plate(e) {
    $("#plateImg").src = abs(e.file);
    $("#sceneChips").append(chip(e.unseen > 0 ? `${(e.unseen * 100).toFixed(1)}% never seen, continued from around it` : "every pixel seen without an animal in it", e.unseen > 0.06 ? "warn" : "ok"));
  },
  depth(e) {
    $("#depthImg").src = abs(e.file);
    $("#groundImg").src = abs(e.ground);
    $("#sceneChips").append(chip(`lens ${e.fovY.toFixed(0)}° tall`), chip(`ground fits ${(e.groundShare * 100).toFixed(0)}% of the lower frame`, e.groundShare > 0.3 ? "ok" : "warn"), chip(`orbit limit ${e.yawLimit.toFixed(0)}°`));
  },
  motion(e) {
    if (!e.file) { $("#headings").replaceChildren(chip("no subject stood on the ground long enough to follow", "warn")); return; }
    $("#motionImg").src = abs(e.file);
    $("#headings").replaceChildren(...e.tracks.map((t, n) => {
      const li = document.createElement("li");
      li.innerHTML = `<i style="background:${PALETTE[n % PALETTE.length]}"></i><div><b>${t.label}</b><small>${t.length.toFixed(2)} scene units from start to end (${t.pathLength.toFixed(2)} walked) · ${t.speed.toFixed(2)} per second · distance ${t.distStart.toFixed(2)} → ${t.distEnd.toFixed(2)} of the scene's median depth · body ${t.bodyWidth.toFixed(2)} wide</small></div>`;
      return li;
    }));
  },
  async cloud(e, epoch) { await showCloud(abs(e.json), epoch); },
  shell(e) {
    const grid = $("#shellGrid");
    $("#shellBar").style.width = `${((e.i + 1) / e.n) * 100}%`;
    $("#shellNote").textContent = `moment ${e.i + 1} of ${e.n}`;
    if (grid.children.length < 600) { const im = new Image(); im.src = abs(e.file); im.alt = ""; im.loading = "lazy"; grid.append(im); grid.scrollTop = grid.scrollHeight; }
  },
  water(e) {
    $("#waterImg").src = abs(e.file);
    $("#waterBar").style.width = `${((e.j + 1) / e.n) * 100}%`;
    const im = new Image(); im.src = abs(e.file); im.alt = `${e.t.toFixed(1)} s`; im.title = `${e.t.toFixed(1)} s`;
    im.addEventListener("click", () => { $("#waterImg").src = im.src; });
    $("#waterStrip").append(im);
  },
  checks(e) {
    state.checks = e;
    $("#gate").replaceChildren(chip(e.tier === "full" ? "full quality tier" : "narrow tier", e.tier === "full" ? "ok" : "warn"), ...e.notes.map((n) => chip(n, "warn")));
  },
  done(e) {
    leave(activeStep);
    enter("done");
    leave("done");
    run.finished = true;
    $("#headline").textContent = `Done in ${e.seconds.toFixed(0)} s.`;
    const viewer = new URL(e.viewer, location.href);
    if (["lite", "basic"].includes(e.tier) && API) viewer.searchParams.set("api", API);
    const url = viewer.href;
    $("#world").src = url;
    $("#openWorld").href = url;
    $("#doneNote").textContent = e.tier === "lite" ? "Screen-space motion from the selected cut-outs; camera movement also affects the trail." : e.tier === "basic" ? "Orbit the empty-scene depth cloud and each subject's trail. Distances are relative scene units." : "This is the same viewer the finished clips open in. It plays the live footage under the depth surface and keeps each subject's shells as the trail.";
    const names = { trim: "starting the clip", probe: "looking at the camera", prepare: "preparing", track: "SAM 3.1 tracking", ghosts: "cutting out every frame", world: "starting the builder", plate: "empty scene", depth: "Depth Anything 3", motion: "headings", cloud: "cloud trail", environment: "scene surface", shells: "depth shells", water: "live footage", pack: "packing" };
    $("#timings").replaceChildren(...[...timings].map(([id, s]) => { const tr = document.createElement("tr"); tr.innerHTML = `<td>${names[id] ?? id}</td><td>${s.toFixed(1)} s</td>`; return tr; }), Object.assign(document.createElement("tr"), { innerHTML: `<td>total</td><td>${e.seconds.toFixed(1)} s</td>` }));
  },
  error(e) { if (activeStep) leave(activeStep, "failed"); run.finished = true; $("#headline").textContent = "Stopped."; fail(e.message); },
  cancelled(e) { if (activeStep) leave(activeStep, "failed"); run.finished = true; $("#headline").textContent = e.message; $("#build").disabled = false; },
};
const timings = new Map();

// ── 7 · the first cloud trail ────────────────────────────────────────────

async function showCloud(jsonUrl, epoch) {
  if (cloud || epoch !== state.epoch) return;
  const base = jsonUrl.slice(0, jsonUrl.lastIndexOf("/") + 1);
  const meta = await (await fetch(jsonUrl)).json();
  if (epoch !== state.epoch) return;
  const motion = await (await fetch(base + meta.motion)).json();
  if (epoch !== state.epoch) return;
  const buf = async (name, Type) => new Type(await (await fetch(base + name)).arrayBuffer());
  const [bgPos, bgRgb, trPos, trRgb] = await Promise.all([buf(meta.bg.pos, Float32Array), buf(meta.bg.rgb, Uint8Array), buf(meta.trail.pos, Float32Array), buf(meta.trail.rgb, Uint8Array)]);
  if (epoch !== state.epoch || cloud) return;
  if (bgPos.length !== meta.bg.n * 3 || bgRgb.length !== bgPos.length || trPos.length !== meta.trail.n * 3 || trRgb.length !== trPos.length) throw new Error("This cloud is incomplete.");

  const canvas = $("#cloudView"), box = $("#cloudBox");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x020304);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(meta.fovY, meta.aspect, 0.01, 200);
  const points = (pos, rgb, size) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(cloudColors(rgb), 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true }));
  };
  const bg = points(bgPos, bgRgb, 0.0075);
  const trail = points(trPos, trRgb, 0.014);
  trail.geometry.setDrawRange(0, 0);
  scene.add(bg, trail);

  // paths and arrows, in the colours of the heading list
  const centre = new THREE.Vector3();
  let pathCount = 0;
  motion.tracks.forEach((t, n) => {
    const col = new THREE.Color(PALETTE[n % PALETTE.length]);
    const pts = t.path.map((p) => new THREE.Vector3(...p));
    if (!pts.length) return;
    pathCount += 1;
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col })));
    const tail = pts[Math.max(0, pts.length - 1 - Math.round(pts.length * 0.15))], head = pts.at(-1);
    const dir = head.clone().sub(tail);
    if (dir.length() > 1e-4) scene.add(new THREE.ArrowHelper(dir.clone().normalize(), head, Math.max(0.12, t.length * 0.25), col, 0.05, 0.03));
    centre.add(pts[Math.floor(pts.length / 2)]);
  });
  if (pathCount) centre.divideScalar(pathCount); else centre.set(0, 0, -1);

  // the lens: a small frustum at the origin, so the recording's point of view is never lost
  const half = Math.tan((meta.fovY * Math.PI) / 360), f = 0.25;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3(x * half * meta.aspect * f, y * half * f, -f));
  const seg = [];
  for (const c of corners) seg.push(new THREE.Vector3(), c);
  for (let i = 0; i < 4; i += 1) seg.push(corners[i], corners[(i + 1) % 4]);
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg), new THREE.LineBasicMaterial({ color: 0xffd9a8, transparent: true, opacity: 0.8 })));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  const framing = frameCloud(bgPos, trPos, meta.fovY, meta.aspect, centre);
  controls.target.copy(framing.target);
  const lens = new THREE.Vector3(0, 0, 0.02);
  const oblique = framing.position.clone();
  camera.position.copy(lens);
  camera.far = framing.far + camera.position.distanceTo(framing.position);
  camera.updateProjectionMatrix();
  controls.update();
  const t0 = performance.now();
  const total = trPos.length / 3;
  let touched = false;
  const resize = () => {
    const w = box.clientWidth, h = box.clientHeight;
    if (w <= 0 || h <= 0) return;
    const frame = frameCloud(bgPos, trPos, meta.fovY, w / h, centre);
    renderer.setSize(w, h, false); camera.aspect = w / h;
    if (!touched) { controls.target.copy(frame.target); oblique.copy(frame.position); }
    camera.far = frame.far + camera.position.distanceTo(frame.position);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize); observer.observe(box);
  resize();
  controls.addEventListener("start", () => { touched = true; });
  renderer.setAnimationLoop(() => {
    const s = (performance.now() - t0) / 1000;
    // the trail lays itself down moment by moment, then the view glides from the lens to an oblique one
    trail.geometry.setDrawRange(0, Math.min(total, Math.floor((s / 2.5) * total)));
    if (!touched && s > 2.5) camera.position.lerp(oblique, 0.035);
    controls.update();
    renderer.render(scene, camera);
  });
  let disposed = false;
  cloud = { renderer, dispose() {
    if (disposed) return; disposed = true;
    renderer.setAnimationLoop(null); observer.disconnect(); controls.dispose();
    const resources = new Set();
    scene.traverse(object => { if (object.geometry) resources.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) resources.add(material); });
    for (const resource of resources) resource.dispose();
    scene.clear(); renderer.dispose();
  } };
  $("#cloudHud").textContent = `${(bgPos.length / 3).toLocaleString()} points of empty scene\n${total.toLocaleString()} points of trail · ${meta.trail.ghosts.length} moments\nlens at the gold frustum`;
}

// Start only after all reset dependencies (canvases, caches and cloud state) exist.
if (params.get("upload")) prepare(params.get("upload"), beginClip());
