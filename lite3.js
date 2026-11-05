import { createLiteView, liteEvents } from "./lite-view.js";
import { parseFrameStrides } from "./lite-retention.js";

// Detect once, then build each selected sampling rate independently.
const p = new URLSearchParams(location.search);
const API = (p.get("api") ?? (location.port === "4175" ? "http://127.0.0.1:8000" : "")).replace(/\/$/, "");
const $ = (s, root = document) => root.querySelector(s), abs = u => /^https?:/.test(u) ? u : API + u;
const state = { uploadId: null, started: 0, finished: false, epoch: 0, sources: new Set(), preview: null, previewKind: null, previewToken: 0, frameUrl: null };
const showError = message => { $("#fail").hidden = false; $("#fail").textContent = message; };
async function post(url, body) { const r = await fetch(API + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; }
function listen(id, handler, end, epoch) {
  const source = new EventSource(`${API}/api/live/${id}/events`);
  state.sources.add(source);
  const close = () => { source.close(); state.sources.delete(source); };
  source.onmessage = m => { if (epoch !== state.epoch) return close(); try { handler(JSON.parse(m.data)); } catch (e) { showError(e.message); } };
  source.addEventListener("end", () => { close(); if (epoch === state.epoch) end?.(); });
  source.onerror = () => { if (source.readyState === EventSource.CLOSED) { close(); if (epoch === state.epoch) handler({ type: "error", message: "Lost connection to the server." }); } };
}
function closeSources() { for (const source of state.sources) source.close(); state.sources.clear(); }
function enableSetup() { $("#run").disabled = !state.uploadId; $("#file").disabled = $("#moose").disabled = false; }
let strides;
try { strides = parseFrameStrides(p.get("strides")); } catch (error) { showError(error.message); throw error; }
const comparison = strides.map(n => `1 in ${n}`).join(" vs ");
document.title = `Lite sampling speed — ${comparison}`;
$(".compare-hero h1").textContent = comparison;
$(".compare-hero .eyebrow").textContent = `ONE CLIP · ${strides.length} INDEPENDENT BUILDS`;
$(".compare-hero .intro").textContent = "One subject selection, then separate Lite builds. Each run reduces frames before sending them to SAM. Long clips remain subject to the sampling cap.";
$("#run").textContent = strides.length === 2 ? "Run both →" : "Run all →";
$("#columns").style.setProperty("--column-count", strides.length);
const columns = strides.map(stride => {
  const title = `1 in ${stride}`, share = stride === 1 ? "Full capped rate" : `1/${stride} input rate`;
  const el = document.createElement("section"); el.className = "l3col"; el.dataset.stride = stride; el.dataset.phase = "waiting";
  el.innerHTML = `<header><h2>${title}</h2><time>0.0 s</time></header><p class="sub">${share} to SAM · <span class="rate">waiting</span> · <span class="count">0</span> masks</p><span class="badge" hidden></span><div class="meter"><i></i></div><canvas class="live"></canvas><p class="note status">Waiting for the tracker.</p><div class="viewer" hidden></div>`;
  $("#columns").append(el);
  return { stride, title, el, started: 0, seen: new Set(), count: 0, finished: false, finishing: false, seconds: null, current: new Map(), initial: null, trail: null, chain: Promise.resolve(), lite: liteEvents() };
});
function settle() {
  if (!columns.every(c => c.finished && !c.finishing)) return;
  state.finished = true; enableSetup();
  $("#overall").textContent = `${((performance.now() - state.started) / 1000).toFixed(1)} s`;
  $("#setupNote").textContent = "All builds ended. Timings measure each build; subject selection was shared. Concurrent runs compete for the same hardware.";
}
function failColumn(c, message) { c.el.dataset.phase = "failed"; c.failed = c.finished = true; c.seconds ??= c.started ? (performance.now() - c.started) / 1000 : 0; $(".status", c.el).textContent = message; showError(`${c.title}: ${message}`); settle(); }
setInterval(() => {
  if (state.started && !state.finished) $("#overall").textContent = `${((performance.now() - state.started) / 1000).toFixed(1)} s`;
  for (const c of columns) if (c.started) $("time", c.el).textContent = `${(c.seconds ?? (performance.now() - c.started) / 1000).toFixed(1)} s`;
}, 100);

function beginSelection() {
  state.epoch++; closeSources();
  const token = ++state.previewToken;
  state.uploadId = null; state.preview = state.previewKind = state.frameUrl = null;
  $("#run").disabled = true; $("#fail").hidden = true; $("#shared").textContent = "Preparing clip";
  $("#setupNote").textContent = "Getting the selected clip ready…";
  return token;
}
function failSelection(error, token) {
  if (token !== state.previewToken) return;
  state.uploadId = null; $("#run").disabled = true; $("#uploadNote").textContent = "Clip not ready."; showError(error.message);
}
async function upload(file, token) {
  if (token !== state.previewToken) return;
  try {
    $("#uploadNote").textContent = `Uploading ${file.name}…`;
    const form = new FormData(); form.append("video", file); form.append("rights", "1");
    const r = await fetch(`${API}/api/upload`, { method: "POST", body: form });
    if (token !== state.previewToken) return;
    const d = await r.json().catch(() => ({}));
    if (token !== state.previewToken) return;
    if (!r.ok) throw new Error(d.error || "Upload failed.");
    await prepare(d.uploadId || d.jobId, token);
  } catch (error) { failSelection(error, token); }
}
async function prepare(id, token) {
  if (token !== state.previewToken) return;
  try {
    $("#uploadNote").textContent = "Checking the clip…";
    const info = await post("/api/live/prepare", { uploadId: id });
    if (token !== state.previewToken) return;
    state.uploadId = id;
    $("#uploadNote").textContent = `${info.width}×${info.height} · ${info.fps.toFixed(1)} fps · ${info.duration.toFixed(1)} s`;
    $("#setupNote").textContent = "Ready. The largest subject is followed from the first frame."; $("#shared").textContent = "Clip ready"; $("#run").disabled = false;
    if (info.previewUrl) previewClip(info.previewUrl, token).catch(() => {});
  } catch (error) { failSelection(error, token); }
}
$("#file").addEventListener("change", e => e.target.files[0] && upload(e.target.files[0], beginSelection()));
$("#moose").addEventListener("click", async () => {
  const token = beginSelection();
  try {
    $("#uploadNote").textContent = "Fetching the moose clip…";
    const r = await fetch("assets/clips/trailcam/moose-pond.mp4");
    if (token !== state.previewToken) return;
    if (!r.ok) throw new Error("Could not fetch the moose clip.");
    const blob = await r.blob();
    if (token !== state.previewToken) return;
    await upload(new File([blob], "moose-pond.mp4", { type: "video/mp4" }), token);
  } catch (error) { failSelection(error, token); }
});
if (p.get("upload")) prepare(p.get("upload"), beginSelection());

$("#stopAll").addEventListener("click", async () => {
  const button = $("#stopAll"); button.disabled = true;
  try {
    const { stopped } = await post("/api/live/cancel-all", {});
    state.epoch++; closeSources(); state.finished = true;
    for (const c of columns) if (!c.finished || c.finishing) {
      c.view?.dispose(); c.view = null; $(".viewer", c.el).replaceChildren();
      c.finished = true; c.finishing = false; c.seconds = c.started ? (performance.now() - c.started) / 1000 : 0; $(".status", c.el).textContent = "Stopped by you."; c.el.dataset.phase = "stopped";
    }
    $("#setupNote").textContent = stopped ? `Stopped ${stopped} running job${stopped === 1 ? "" : "s"}. Press Run to start again.` : "Nothing was running.";
    enableSetup(); $("#fail").hidden = true;
  } catch (e) { showError(e.message); } finally { button.disabled = false; }
});

$("#run").addEventListener("click", async () => {
  const epoch = ++state.epoch; closeSources();
  state.started = performance.now(); state.finished = false; $("#fail").hidden = true;
  images.clear();
  for (const c of columns) {
    c.view?.dispose(); c.view = null;
    Object.assign(c, { started: 0, count: 0, finished: false, finishing: false, failed: false, seconds: null, trail: null, chain: Promise.resolve(), lite: liteEvents() }); c.current.clear(); c.seen.clear();
    c.el.dataset.phase = "waiting";
    for (const key of ["runId", "startedAt", "buildSeconds", "readySeconds"]) delete c.el.dataset[key];
    $(".count", c.el).textContent = "0"; $(".rate", c.el).textContent = "waiting"; $(".badge", c.el).hidden = true; $(".meter i", c.el).style.width = "0"; $(".status", c.el).textContent = "Waiting for shared subject selection."; $("time", c.el).textContent = "0.0 s";
    const canvas = $(".live", c.el); canvas.hidden = false; c.initial = state.preview; setupCanvas(c, c.initial?.width || 16, c.initial?.height || 9); draw(c, c.g, canvas.width, canvas.height);
    const viewer = $(".viewer", c.el); viewer.hidden = true; viewer.replaceChildren();
  }
  $("#run").disabled = $("#file").disabled = $("#moose").disabled = true;
  $("#setupNote").textContent = "Finding a shared subject with Muse Spark and SAM…";
  try {
    const { runId } = await post("/api/live/detect", { uploadId: state.uploadId, time: 0 });
    if (epoch !== state.epoch) { await post(`/api/live/${runId}/cancel`, {}); return; }
    let started = false;
    listen(runId, e => {
      if (e.type === "stage" && !started) $("#setupNote").textContent = e.label;
      if (e.type === "frame") { state.frameUrl = e.url; load(abs(e.url)).then(image => paintInitial(image, "frame", epoch)).catch(() => {}); }
      if (e.type === "objects" && !started) {
        if (!e.objects.length) throw new Error("No subjects found in the first frame. Try another clip.");
        started = true;
        const area = o => (o.box.right - o.box.left) * (o.box.bottom - o.box.top);
        const pick = e.objects.slice().sort((a, b) => area(b) - area(a))[0];
        $("#shared").textContent = `following: ${pick.label}`;
        $("#setupNote").textContent = `Following ${pick.label}. Separate builds: ${comparison}.`;
        seedSubject(pick, e, epoch).catch(() => {});
        for (const c of columns) startColumn(c, pick, epoch);
      }
      if ((e.type === "error" || e.type === "cancelled") && !started) { state.finished = true; showError(e.message); enableSetup(); }
    }, () => { if (!started) { state.finished = true; showError("No subjects found. Try another clip."); enableSetup(); } }, epoch);
  } catch (e) { if (epoch === state.epoch) { state.finished = true; showError(e.message); enableSetup(); } }
});
async function startColumn(c, pick, epoch) {
  c.started = performance.now(); c.el.dataset.startedAt = c.started; c.el.dataset.phase = "running"; $(".status", c.el).textContent = "Starting independent SAM run…";
  try {
    const { runId } = await post("/api/live/build", { uploadId: state.uploadId, time: 0, tier: "lite", frameStride: c.stride, objects: [{ label: pick.label, box: pick.box }] });
    if (epoch !== state.epoch) { await post(`/api/live/${runId}/cancel`, {}); return; }
    c.el.dataset.runId = runId;
    listen(runId, e => { c.lite.consume(e); if (!c.finished) consume(c, e, epoch); }, () => { if (!c.finished) failColumn(c, "Build ended before the trail was finished."); }, epoch);
  } catch (e) { if (epoch === state.epoch) failColumn(c, e.message); }
}

const images = new Map();
const load = url => {
  if (!images.has(url)) {
    const pending = new Promise((ok, no) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => ok(img); img.onerror = () => no(new Error("Could not load a cut-out.")); img.src = url; });
    images.set(url, pending);
    pending.catch(() => { if (images.get(url) === pending) images.delete(url); });
  }
  return images.get(url);
};
function setupCanvas(c, width, height) {
  const canvas = $(".live", c.el); canvas.width = 640; canvas.height = Math.round(640 * height / width);
  c.trail = document.createElement("canvas"); c.trail.width = canvas.width; c.trail.height = canvas.height;
  c.g = canvas.getContext("2d");
}
function paintInitial(image, kind, epoch = state.epoch) {
  if (epoch !== state.epoch || (kind === "frame" && state.previewKind === "subject")) return;
  state.preview = image; state.previewKind = kind;
  for (const c of columns) if (!c.finished && !c.count) {
    c.initial = image;
    if (!c.trail) setupCanvas(c, image.width, image.height);
    draw(c, c.g, c.trail.width, c.trail.height); c.el.dataset.preview = kind;
  }
}
async function previewClip(url, token) {
  const video = document.createElement("video"); video.muted = true; video.preload = "auto";
  try {
    await new Promise((ok, no) => { video.onloadeddata = ok; video.onerror = no; video.src = abs(url); });
    if (token !== state.previewToken) return;
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0); paintInitial(canvas, "frame");
  } finally { video.removeAttribute("src"); video.load(); }
}
async function seedSubject(pick, event, epoch) {
  if (!state.frameUrl || !event.indexUrl) return;
  const [frame, mask] = await Promise.all([load(abs(state.frameUrl)), load(abs(event.indexUrl))]);
  if (epoch !== state.epoch) return;
  const canvas = document.createElement("canvas"); canvas.width = event.width; canvas.height = event.height;
  const g = canvas.getContext("2d", { willReadFrequently: true }); g.drawImage(mask, 0, 0, canvas.width, canvas.height);
  const labels = g.getImageData(0, 0, canvas.width, canvas.height).data;
  g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(frame, 0, 0, canvas.width, canvas.height);
  const pixels = g.getImageData(0, 0, canvas.width, canvas.height); let count = 0;
  for (let i = 0; i < pixels.data.length; i += 4) { const selected = labels[i] === Number(pick.id); pixels.data[i + 3] = selected ? 255 : 0; if (selected) count++; }
  if (count) { g.putImageData(pixels, 0, 0); paintInitial(canvas, "subject", epoch); }
}
function draw(c, g, w, h) {
  g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
  if (!c.current.size && c.initial) g.drawImage(c.initial, 0, 0, w, h);
  g.drawImage(c.trail, 0, 0, w, h);
  for (const cut of c.current.values()) { const [l, t, r, b] = cut.box; g.save(); g.shadowColor = "rgba(255,200,40,.7)"; g.shadowBlur = Math.max(6, w / 100); g.drawImage(cut.image, l * w, t * h, (r - l) * w, (b - t) * h); g.restore(); }
}
function consume(c, e, epoch) {
  const canvas = $(".live", c.el), status = $(".status", c.el);
  if (e.type === "plan") $(".rate", c.el).textContent = `${e.samples} input frames · ${e.sampleFps.toFixed(2)} fps`;
  if (e.type === "track-start") {
    setupCanvas(c, e.width, e.height); draw(c, c.g, canvas.width, canvas.height); status.textContent = "SAM is following the subject…";
  }
  if (e.type === "cut" && e.provisional && c.trail && !c.seen.has(`${e.sample}:${e.id}`)) {
    c.seen.add(`${e.sample}:${e.id}`);
    c.chain = c.chain.then(async () => {
      const image = await load(abs(e.url)); if (epoch !== state.epoch) return;
      const tg = c.trail.getContext("2d"), w = c.trail.width, h = c.trail.height;
      const before = c.current.get(e.id); if (before) { tg.save(); tg.globalAlpha = .2; tg.filter = "grayscale(1) brightness(1.8)"; const [bl, bt, br, bb] = before.box; tg.drawImage(before.image, bl * w, bt * h, (br - bl) * w, (bb - bt) * h); tg.restore(); }
      c.current.set(e.id, { box: e.box, image }); draw(c, c.g, canvas.width, canvas.height); c.el.dataset.preview = "tracked";
      $(".count", c.el).textContent = ++c.count;
    }).catch(error => { if (epoch === state.epoch) showError(error.message); });
  }
  if (e.type === "track-progress") { $(".meter i", c.el).style.width = `${100 * (e.sample + 1) / e.samples}%`; status.textContent = `SAM tracking · frame ${e.sample + 1} of ${e.samples}`; }
  if (e.type === "stage" || e.type === "stage-detail") status.textContent = e.label || "Processing…";
  if (e.type === "ghost-progress") status.textContent = `Cut-outs · frame ${e.sample + 1} of ${e.samples}`;
  if (e.type === "done") finishColumn(c, e, epoch).catch(error => { if (epoch === state.epoch) failColumn(c, error.message); });
  if (e.type === "error" || e.type === "cancelled") failColumn(c, e.message);
}
async function finishColumn(c, event, epoch) {
  c.finished = c.finishing = true; c.seconds = event.seconds ?? (performance.now() - c.started) / 1000;
  c.el.dataset.phase = "preparing-viewer"; c.el.dataset.buildSeconds = c.seconds;
  try {
    await c.chain; if (epoch !== state.epoch) return;
    const result = c.lite.result(); if (!result) throw new Error("No result to show.");
    const badge = $(".badge", c.el); badge.hidden = false; badge.textContent = `FINISHED · ${c.seconds.toFixed(1)} s`; $(".meter i", c.el).style.width = "100%";
    $(".count", c.el).textContent = result.ghosts.length;
    $(".status", c.el).textContent = `Done · ${result.samples} input frames · ${result.ghosts.length} subject masks. Scroll to move through time, drag to turn it.`;
    const viewer = $(".viewer", c.el);
    const view = await createLiteView(viewer, result, API, { maxGhosts: 800 });
    if (epoch !== state.epoch) { view.dispose(); return; }
    c.view = view;
    $(".live", c.el).hidden = true; viewer.hidden = false;
    c.el.dataset.readySeconds = (performance.now() - c.started) / 1000;
    c.el.dataset.phase = "done";
  } finally { if (epoch === state.epoch) { c.finishing = false; settle(); } }
}
