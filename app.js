// The instrument: upload a clip, pick a frame, right-click an object, and hand
// the resulting volume back to the lattice. It owns no renderer of its own —
// what it makes is installed into the cell you are standing in.

const $ = (selector) => document.querySelector(selector);

const state = {
  backendUrl: new URLSearchParams(window.location.search).get("api") || "http://127.0.0.1:8000",
  video: null,
  videoUrl: null,
  jobId: null,
  width: 0,
  height: 0,
  fps: 30,
  duration: 0,
  detectTime: 0,
  objects: [],
  indexMap: null,
  hoverId: 0,
  selected: null,
  canReconstruct: false, // set from /api/health: the 3D tiers need the GPU server
  build: null,           // the last build: { id, mode, viewer, stage }
};

let previewCanvas;
let previewCtx;
let hoverCanvas;
let hoverCtx;
let hooks = {};

function setStatus(message, timeout = 0) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  if (timeout) window.setTimeout(() => toast.classList.remove("is-visible"), timeout);
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

function showStep(id) {
  ["stepUpload", "stepFrame", "stepWorking"].forEach((step) => {
    $(`#${step}`).classList.toggle("is-hidden", step !== id);
  });
  hooks.onPanel?.(id === "stepFrame" || id === "stepWorking");
}

async function checkBackend() {
  const el = $("#backendState");
  try {
    const res = await fetch(`${state.backendUrl}/api/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error();
    state.canReconstruct = Boolean((await res.json()).reconstruct);
    el.textContent = "linked";
    el.className = "backend-state is-ok";
    updateModes();
  } catch {
    el.textContent = "no link";
    el.className = "backend-state is-down";
  }
}

// ── upload ───────────────────────────────────────────────────────────────

async function loadFile(file) {
  if (!file || !file.type.startsWith("video/")) {
    setStatus("Choose a video file to continue.", 2800);
    return;
  }
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = state.videoUrl;
  state.video = video;
  await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));

  setStatus("Uploading…");
  const form = new FormData();
  form.append("video", file);
  let info;
  try {
    const res = await fetch(`${state.backendUrl}/api/upload`, { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.json()).error || "Upload failed.");
    info = await res.json();
  } catch (error) {
    setStatus(`Upload failed: ${error.message}`, 4500);
    return;
  }

  Object.assign(state, {
    jobId: info.jobId,
    width: info.width,
    height: info.height,
    fps: info.fps,
    duration: info.duration,
  });

  // the page-load health check can lose a race with a server that is still starting
  if (!state.canReconstruct) await checkBackend();
  if (state.canReconstruct && !$("#manualPick").checked) return autoBuild();

  previewCanvas.width = state.width;
  previewCanvas.height = state.height;
  hoverCanvas.width = state.width;
  hoverCanvas.height = state.height;

  const scrubber = $("#scrubber");
  scrubber.min = 0;
  scrubber.max = state.duration;
  scrubber.step = 1 / state.fps;
  scrubber.value = 0;

  resetSelection();
  await seekAndDraw(0);
  showStep("stepFrame");
  setStatus("Clip loaded. Scrub to a frame, then find objects.", 2600);
}

function seekAndDraw(time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      state.video.removeEventListener("seeked", onSeeked);
      previewCtx.drawImage(state.video, 0, 0, previewCanvas.width, previewCanvas.height);
      resolve();
    };
    state.video.addEventListener("seeked", onSeeked);
    state.video.currentTime = Math.max(0, Math.min(time, state.duration));
  });
}

// ── find objects ─────────────────────────────────────────────────────────

function resetSelection() {
  state.objects = [];
  state.indexMap = null;
  state.hoverId = 0;
  state.selected = null;
  hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
  $("#hoverLabel").classList.add("is-hidden");
  $("#contextMenu").classList.add("is-hidden");
  $("#selectedBlock").style.display = "none";
  $("#generateButton").disabled = true;
  $("#detectStatus").textContent = "Scrub to a frame, then find objects.";
}

async function decodeIndexMap(base64Png, width, height) {
  const image = new Image();
  image.src = `data:image/png;base64,${base64Png}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  const ids = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < ids.length; i += 1, p += 4) ids[i] = data[p];
  return { width, height, ids };
}

async function applyDetect(data) {
  state.objects = data.objects;
  state.selected = null;
  $("#selectedBlock").style.display = "none";
  $("#generateButton").disabled = true;
  hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
  const count = data.objects.length;
  $("#detectStatus").textContent = count
    ? `${count} object${count === 1 ? "" : "s"} found. Hover, then right-click one.`
    : "Nothing matched here. Name it in the box instead.";
  state.indexMap = await decodeIndexMap(data.indexMapPngBase64, data.frameWidth, data.frameHeight);
}

async function request(route, body, statusText, button) {
  if (!state.jobId) return;
  if (button) button.disabled = true;
  $("#detectStatus").textContent = statusText;
  try {
    const res = await fetch(`${state.backendUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Request failed.");
    await applyDetect(await res.json());
  } catch (error) {
    setStatus(error.message, 4000);
    $("#detectStatus").textContent = "Scrub to a frame, then find objects.";
  } finally {
    if (button) button.disabled = false;
  }
}

function findObjects() {
  state.detectTime = state.video.currentTime;
  return request(
    "/api/detect",
    { jobId: state.jobId, time: state.detectTime },
    "Reading the frame…",
    $("#findObjects")
  );
}

async function customSearch() {
  const input = $("#customPrompt");
  const prompt = input.value.trim();
  if (!prompt) return;
  await request(
    "/api/detect-custom",
    { jobId: state.jobId, time: state.detectTime, prompt },
    `Looking for "${prompt}"…`,
    $("#customPromptGo")
  );
  input.value = "";
}

// ── hit-testing ──────────────────────────────────────────────────────────

function idAt(clientX, clientY) {
  if (!state.indexMap) return 0;
  const rect = hoverCanvas.getBoundingClientRect();
  const x = Math.floor(((clientX - rect.left) / rect.width) * state.indexMap.width);
  const y = Math.floor(((clientY - rect.top) / rect.height) * state.indexMap.height);
  if (x < 0 || y < 0 || x >= state.indexMap.width || y >= state.indexMap.height) return 0;
  return state.indexMap.ids[y * state.indexMap.width + x];
}

function drawHighlight(id) {
  hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
  if (!id || !state.indexMap) return;
  const { width, height, ids } = state.indexMap;
  const overlay = hoverCtx.createImageData(width, height);
  for (let i = 0, p = 0; i < ids.length; i += 1, p += 4) {
    if (ids[i] !== id) continue;
    // a brighter rim where the mask meets everything else, so the silhouette reads
    const edge =
      ids[i - 1] !== id || ids[i + 1] !== id || ids[i - width] !== id || ids[i + width] !== id;
    overlay.data[p] = edge ? 255 : 196;
    overlay.data[p + 1] = edge ? 226 : 150;
    overlay.data[p + 2] = edge ? 168 : 96;
    overlay.data[p + 3] = edge ? 240 : 86;
  }
  hoverCtx.putImageData(overlay, 0, 0);
}

function objectById(id) {
  return state.objects.find((object) => object.id === id) || null;
}

function selectObject(id) {
  const object = objectById(id);
  if (!object) return;
  state.selected = object;
  $("#selectedBlock").style.display = "grid";
  $("#selectedName").textContent = object.label;
  $("#generateButton").disabled = false;
  $("#generateButton").textContent = state.canReconstruct ? `Build the ${MODE_LABEL[chosenMode()]}` : "Lift it out";
}

// ── generate ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const chosenMode = () => document.querySelector('input[name="mode"]:checked').value;
const MODE_LABEL = { basic: "point cloud", advanced: "rebuilt scene" };

// Without the GPU server only the stacked block can be made; say so instead of failing later.
function updateModes() {
  document.querySelectorAll('input[name="mode"], #manualPick').forEach((input) => { input.disabled = !state.canReconstruct; });
  const note = $("#modeNote");
  note.textContent = "3D tiers need the GPU server. Without it you get the stacked block only, for an object you pick.";
  note.classList.toggle("is-hidden", state.canReconstruct);
}

function setWorking(title, note) {
  if (title) $("#workingTitle").textContent = title;
  if (note !== undefined) $("#workingNote").textContent = note;
}

async function api(route, options) {
  const res = await fetch(`${state.backendUrl}${route}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Request failed.");
  return body;
}
const post = (route, body) => api(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Upload -> find the subject -> build -> show, with nothing to click in between.
async function autoBuild() {
  showStep("stepWorking");
  setWorking("Finding the main subject…", "Reading the first frame for people, animals and things that move.");
  try {
    const mode = chosenMode();
    const { buildId, subject } = await post("/api/auto", { jobId: state.jobId, mode });
    await followBuild(buildId, mode, subject);
  } catch (error) {
    setStatus(error.message, 7000);
    showStep("stepUpload");
  }
}

async function generate() {
  if (!state.selected) return;
  showStep("stepWorking");
  setWorking("Following it to the end of the clip…", "One pass of SAM 3.1 over the whole clip. Usually under two minutes.");
  try {
    const body = { jobId: state.jobId, time: state.detectTime, objectId: state.selected.id };
    if (!state.canReconstruct) {
      const manifest = await post("/api/generate", body);
      await hooks.onGenerated?.(manifest, state.backendUrl);
      showStep("stepUpload");
      setStatus(`"${manifest.concept}" installed in this cell.`, 4000);
      return;
    }
    const mode = chosenMode();
    const { buildId } = await post("/api/build", { ...body, mode });
    await followBuild(buildId, mode, state.selected.label);
  } catch (error) {
    setStatus(error.message, 5000);
    showStep("stepFrame");
  }
}

// Shows a build's progress, installs the stacked block as soon as tracking has made it,
// then opens the finished 3D view. Throws if the build fails.
async function followBuild(buildId, mode, subject) {
  const label = MODE_LABEL[mode];
  state.build = { id: buildId, mode, viewer: null };
  let installed = false;
  for (let build; ; await sleep(1500)) {
    build = await api(`/api/build/${buildId}`);
    if (build.stage === "failed") throw new Error(build.error);
    if (build.manifest && !installed) {
      installed = true;
      await hooks.onGenerated?.(build.manifest, state.backendUrl);
    }
    if (build.stage === "done") {
      state.build.viewer = build.viewer;
      break;
    }
    setWorking(`Building the ${label} of the ${subject || "subject"}…`, build.detail);
  }
  showStep("stepUpload");
  showChip(`open ${label} ↗`, { action: () => openViewer(state.build.viewer) });
  setStatus(`Your ${label} is ready.`, 3500);
  openViewer(state.build.viewer);
}

// ── re-opening a finished 3D view ────────────────────────────────────────

function showChip(text, { action = null } = {}) {
  const chip = $("#buildChip");
  chip.textContent = text;
  chip.classList.remove("is-hidden");
  chip.disabled = !action;
  chip.onclick = action;
}

function openViewer(url) {
  $("#viewerFrame").src = url;
  $("#viewer").classList.remove("is-hidden");
  $("#viewerClose").focus();
}

function closeViewer() {
  $("#viewer").classList.add("is-hidden");
  $("#viewerFrame").src = "about:blank"; // stops its render loop and frees the GPU
}

// ── wiring ───────────────────────────────────────────────────────────────

export function initInstrument(options = {}) {
  hooks = options;
  previewCanvas = $("#previewCanvas");
  previewCtx = previewCanvas.getContext("2d");
  hoverCanvas = $("#hoverCanvas");
  hoverCtx = hoverCanvas.getContext("2d");

  $("#videoInput").addEventListener("change", (event) => loadFile(event.target.files[0]));
  document.querySelectorAll("[data-sample]").forEach((button) =>
    button.addEventListener("click", async () => {
      const src = button.dataset.sample;
      setStatus("Fetching sample clip…");
      try {
        const blob = await (await fetch(src)).blob();
        await loadFile(new File([blob], src.split("/").pop(), { type: "video/mp4" }));
      } catch {
        setStatus("Could not load the sample clip.", 3500);
      }
    })
  );

  const dropZone = $("#dropZone");
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    loadFile(event.dataTransfer.files[0]);
  });

  $("#scrubber").addEventListener("input", (event) => {
    $("#timeReadout").textContent = formatTime(Number(event.target.value));
  });
  $("#scrubber").addEventListener("change", async (event) => {
    await seekAndDraw(Number(event.target.value));
    resetSelection();
  });

  $("#findObjects").addEventListener("click", findObjects);
  $("#customPromptGo").addEventListener("click", customSearch);
  $("#customPrompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter") customSearch();
  });

  hoverCanvas.addEventListener("mousemove", (event) => {
    const id = idAt(event.clientX, event.clientY);
    if (id === state.hoverId) return;
    state.hoverId = id;
    drawHighlight(id);
    const label = $("#hoverLabel");
    const object = objectById(id);
    if (!object) {
      label.classList.add("is-hidden");
      return;
    }
    label.textContent = object.label;
    label.classList.remove("is-hidden");
    const rect = hoverCanvas.getBoundingClientRect();
    label.style.left = `${event.clientX - rect.left}px`;
    label.style.top = `${event.clientY - rect.top}px`;
  });
  hoverCanvas.addEventListener("mouseleave", () => {
    state.hoverId = 0;
    $("#hoverLabel").classList.add("is-hidden");
    drawHighlight(state.selected ? state.selected.id : 0);
  });
  hoverCanvas.addEventListener("click", (event) => {
    const id = idAt(event.clientX, event.clientY);
    if (id) selectObject(id);
    $("#contextMenu").classList.add("is-hidden");
  });
  hoverCanvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const id = idAt(event.clientX, event.clientY);
    if (!id) return;
    selectObject(id);
    const menu = $("#contextMenu");
    const wrap = $("#frameCanvasWrap").getBoundingClientRect();
    menu.style.left = `${event.clientX - wrap.left}px`;
    menu.style.top = `${event.clientY - wrap.top}px`;
    menu.classList.remove("is-hidden");
  });

  document.addEventListener("click", (event) => {
    const menu = $("#contextMenu");
    if (!menu.contains(event.target)) menu.classList.add("is-hidden");
  });

  $("#ctxGenerate").addEventListener("click", () => {
    $("#contextMenu").classList.add("is-hidden");
    generate();
  });
  $("#generateButton").addEventListener("click", generate);
  $("#cancelFrame").addEventListener("click", () => {
    resetSelection();
    showStep("stepUpload");
  });

  $("#viewerClose").addEventListener("click", closeViewer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#viewer").classList.contains("is-hidden")) closeViewer();
  });

  updateModes();
  checkBackend();
  showStep("stepUpload");
}
