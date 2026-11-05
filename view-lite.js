// Lite viewer: renders specimens/<id>/{atlas.webp,atlas.json} as an orbitable
// spacetime solid. Scroll = time, drag = bounded turn. `?id=` required;
// `?embed=1` hides the chrome for embedding; `?api=` overrides the API base.
import * as THREE from "three";
import { buildChronoVolume, tickChrono, fitChronoRow, fitChronoPoints, portraitChronoPoints, selectPortraitIndices, spacedChronoPoints, chronoPointRects, chronoRestHeights, chronoCardYaw, setChronoLayout, fitBackdropToFrame, frameChronoView, chronoPanAt, chronoViewRects } from "./volume.js";

const params = new URLSearchParams(location.search);
const apiBase = params.get("api") || "";
const id = params.get("id") || "";
const embed = params.get("embed") === "1";
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s) => document.querySelector(s);

const apiUrl = (p) => `${apiBase}${p}`;
if (embed) {
  $("#pageWrap").querySelectorAll("p, h1, .back-row").forEach((el) => {
    if (!el.closest(".stage")) el.style.display = "none";
  });
}

function state(text, retry = null) {
  const box = $("#stageState");
  box.innerHTML = "";
  const span = document.createElement("span");
  span.id = "stageText";
  span.textContent = text;
  box.append(span);
  if (retry) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-quiet";
    btn.textContent = "Try again";
    btn.addEventListener("click", retry);
    box.append(btn);
  }
}

async function load() {
  if (!id) {
    state("No build id. Open a finished Lite build from My builds.");
    return;
  }
  if (!navigator.onLine) state("You are offline — the solid needs a connection.");
  state("Loading the solid…");
  let meta, atlas, composite;
  try {
    const [m, a] = await Promise.all([
      fetch(apiUrl(`/specimens/${id}/meta.json`)).then((r) => (r.ok ? r.json() : null)),
      fetch(apiUrl(`/specimens/${id}/atlas.json`)).then((r) => {
        if (!r.ok) throw new Error(`solid not found (HTTP ${r.status})`);
        return r.json();
      }),
    ]);
    meta = m;
    atlas = a;
    // The runner lists the 2D still in atlas.json; older specimens have
    // none, so they never request it and the 3D viewer is unchanged.
    // Soft-fail: a missing composite.json just hides the toggle.
    composite = atlas?.composite
      ? await fetch(apiUrl(`/specimens/${id}/composite.json`)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      : null;
  } catch (error) {
    state(`Could not load this solid: ${error.message}`, load);
    return;
  }
  // Fetch the still beside the solid's pictures, not after them: it is the
  // first view, so it should be ready when the stage opens.
  const still = composite && typeof composite === "object" ? startStill(composite) : null;
  let texture;
  try {
    texture = await new THREE.TextureLoader().loadAsync(apiUrl(`/specimens/${id}/atlas.webp`));
    // Premultiplied, as plain data: the pose shader divides the alpha back
    // out and decodes sRGB itself, so cut-out edges carry no halo.
    texture.premultiplyAlpha = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
  } catch {
    state("The solid's pictures are missing.", load);
    return;
  }
  // Optional ambient stage: a dark plate of the clip's own place. Old
  // atlases have no backdrop field — the load fails soft and the viewer
  // keeps today's void, byte-identical to before.
  let backdropTex = null;
  if (atlas && atlas.backdrop) {
    try {
      backdropTex = await new THREE.TextureLoader().loadAsync(apiUrl(`/specimens/${id}/${atlas.backdrop.file || "backdrop.webp"}`));
      backdropTex.colorSpace = THREE.SRGBColorSpace;
      backdropTex.minFilter = THREE.LinearFilter;
      backdropTex.generateMipmaps = false;
    } catch {
      backdropTex = null;
    }
  }
  openViewer(meta, atlas, texture, backdropTex, composite, still);
}

// The Still crop: the tile grid plus caption rows (tileRects are [x, y,
// w, h]), clamped to the image. Null when the rects are unusable.
function stillCropRect(rects, width, height) {
  const ok = Array.isArray(rects) && rects.length &&
    rects.every((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite));
  if (!ok) return null;
  const pad = 20, cap = 46;
  const x0 = Math.max(0, Math.min(...rects.map((r) => r[0])) - pad);
  const y0 = Math.max(0, Math.min(...rects.map((r) => r[1])) - pad);
  const x1 = Math.min(width, Math.max(...rects.map((r) => r[0] + r[2])) + pad);
  const y1 = Math.min(height, Math.max(...rects.map((r) => r[1] + r[3])) + cap + 8);
  return x1 - x0 > 32 && y1 - y0 > 32 ? [x0, y0, x1, y1] : null;
}

// Two Stills ship: the landscape composite and a 1080x1350 portrait twin.
// Show the one whose tiles come out larger in this stage (the canvas is
// min(62vh, 560px) tall, the panel pads 12px and keeps 34px for its
// caption), so the choice is known before the canvas exists. Without tile
// rects on both, or under 20% apart (the swap shrinks the burnt-in time
// labels, so it must buy clearly bigger tiles), the stage shape decides as
// before: the twin on a tall stage. (Phones: a 2x2 grid can beat a column.)
function startStill(composite) {
  const stage = $("#stage");
  const portraitFile = /^[\w.-]+\.png$/.test(composite?.portrait?.file || "") ? composite.portrait.file : null;
  const stageH = Math.min(innerHeight * 0.62, 560);
  let usePortrait = !!portraitFile && stageH > stage.clientWidth;
  const tileShown = (rects, size) => {
    const [w, h] = Array.isArray(size) && size.length === 2 ? size : [Infinity, Infinity];
    const r = stillCropRect(rects, w, h);
    if (!r) return 0;
    return rects[0][2] * Math.min(1, (stage.clientWidth - 24) / (r[2] - r[0]), (stageH - 58) / (r[3] - r[1]));
  };
  const land = tileShown(composite?.tileRects, composite?.outputSize || composite?.layout?.canvas);
  const port = portraitFile ? tileShown(composite.portrait.tileRects, composite.portrait.layout?.canvas || [1080, 1350]) : 0;
  if (land > 0 && port > 0) {
    if (port > land * 1.2) usePortrait = true;
    else if (land > port * 1.2) usePortrait = false;
  }
  const file = usePortrait ? portraitFile : "composite.png";
  const img = new Image();
  // Preload off-DOM: the panel image src is assigned only after a good
  // load, so a missing file shows text, never a broken-image icon.
  const ready = new Promise((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = apiUrl(`/specimens/${id}/${file}`);
  return { file, portrait: usePortrait, img, ready };
}

function openViewer(meta, atlas, texture, backdropTex, composite, still) {
  const stage = $("#stage");
  $("#stageState").remove();
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", `Spacetime solid of ${meta?.subject || "an object"}. Scroll to move through time; drag to turn.`);
  stage.prepend(canvas);
  $("#stageBar").hidden = false;

  // Still panel (Lane B composite artefact): a fitted 2D still next to the
  // 3D solid. The "3D | Still" toggle appears only when the specimen ships
  // composite.json; "3D" is the default and is otherwise untouched.
  let stillMode = "3d";
  let userChose = false;
  let onEnter3d = null; // the one-time reveal, wired once the solid exists
  const seg = $("#viewSeg");
  const btn3d = $("#view3dBtn");
  const btnStill = $("#viewStillBtn");
  const stillWrap = $("#stillWrap");
  const stillImg = $("#stillImg");
  const stillMsg = $("#stillMsg");
  const stillCap = $("#stillCap");
  const stillCaption = (c) => {
    const frames = Array.isArray(c?.frames) ? c.frames : [];
    const n = frames.length;
    if (c?.route === "filmstrip") return `Pose filmstrip · ${n} moment${n === 1 ? "" : "s"}`;
    const ts = frames.map((f) => Number(f?.time)).filter((t) => Number.isFinite(t));
    const range = ts.length ? ` · ${Math.min(...ts).toFixed(1)}–${Math.max(...ts).toFixed(1)} s` : "";
    return `${n} pose${n === 1 ? "" : "s"}${range}`;
  };
  const stillState = { json: still ? composite : null, imgOk: false, imgBad: false };
  const stillPngUrl = still ? apiUrl(`/specimens/${id}/${still.file}`) : "";
  // The composite canvas is fixed-size with wide dark margins around the
  // tiles; shown whole, the tiles fill ~a quarter of the stage. Crop to the
  // tile grid + caption rows (tileRects are [x, y, w, h]) when recorded.
  const stillRects = still?.portrait ? composite?.portrait?.tileRects : composite?.tileRects;
  const cropStill = (img) => new Promise((resolve) => {
    const r = stillCropRect(stillRects, img.naturalWidth, img.naturalHeight);
    if (!r) return resolve(null);
    const [x0, y0, x1, y1] = r;
    const c = document.createElement("canvas");
    c.width = x1 - x0; c.height = y1 - y0;
    c.getContext("2d").drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), "image/png");
  });
  const paintStill = () => {
    if (stillState.imgOk) {
      const src = stillState.cropUrl || stillPngUrl;
      if (stillImg.getAttribute("src") !== src) stillImg.src = src;
      stillImg.alt = stillState.json?.route === "filmstrip"
        ? `Pose filmstrip of ${meta?.subject || "an object"}`
        : `Chronophotograph still of ${meta?.subject || "an object"}`;
      stillImg.hidden = false;
      stillMsg.textContent = "";
      stillCap.textContent = stillCaption(stillState.json);
    } else if (stillState.imgBad) {
      stillImg.hidden = true;
      stillImg.removeAttribute("src");
      stillMsg.textContent = "Still unavailable";
      stillCap.textContent = "";
    } else {
      stillImg.hidden = true;
      stillMsg.textContent = "Loading still…";
      stillCap.textContent = "";
    }
  };
  const setStillMode = (m) => {
    stillMode = m;
    const still = m === "still";
    btn3d.setAttribute("aria-pressed", String(!still));
    btnStill.setAttribute("aria-pressed", String(still));
    stillWrap.hidden = !still;
    // Time/turn controls do nothing on a static still: hide them with it.
    $("#stageBar").classList.toggle("still-mode", still);
    if (still) paintStill();
    else if (onEnter3d) onEnter3d();
  };
  if (stillState.json && typeof stillState.json === "object") {
    seg.hidden = false;
    // Still is the default (judged stills beat the 3D solid) and the stage
    // opens on it at once, so the solid never flashes up first and is then
    // swapped out. A still that fails to load falls back to the solid. A
    // living still (the subject barely moves) opens on the solid instead:
    // there the clip plays on its one pose, while the still would show the
    // same frame several times over. So does a ghost-trail build: its 3D
    // trail is the result, and the Still stays one tap away. A user's own
    // toggle choice always wins.
    const living = !!atlas?.still || !!(atlas?.trail && Array.isArray(atlas.trail.cells) && atlas.trail.cells.length);
    if (!living) setStillMode("still");
    still.ready.then(async (ok) => {
      if (ok) {
        stillState.cropUrl = await cropStill(still.img).catch(() => null);
        stillState.imgOk = true;
      } else stillState.imgBad = true;
      if (!userChose && !living) setStillMode(ok ? "still" : "3d");
      else if (stillMode === "still") paintStill();
    });
    btn3d.addEventListener("click", () => { userChose = true; setStillMode("3d"); });
    btnStill.addEventListener("click", () => { userChose = true; setStillMode("still"); });
    seg.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (document.activeElement !== btn3d && document.activeElement !== btnStill) return;
      e.preventDefault();
      const next = e.key === "ArrowRight" ? btnStill : btn3d;
      next.focus();
      next.click();
    });
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020304);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);

  const group = buildChronoVolume(texture, atlas, (() => {
    // Short rows sit deep for their length (depth 4.6 vs a 7-long row),
    // which forces the fit back and shrinks every pose. Depth scales with
    // the row so the time axis keeps its parallax without the airfare.
    const aspect = Number(atlas.aspect) || 1;
    const rowLenEst = 0.85 * 3.4 * aspect * Math.max(0, (Number(atlas.count) || 1) - 1);
    return { height: 3.4, step: 0.85, trailRow: "free", depth: Math.min(4.6, Math.max(0.8, rowLenEst * 0.15)), staging: params.get("staging") !== "0", backdrop: backdropTex };
  })());
  group.rotation.y = -0.3;
  group.userData.liveMode = "pingpong";
  group.userData.ease = true;
  scene.add(group);
  // The backdrop hangs in the WORLD, not the turning group: the row orbits
  // beneath the camera while the place stays put, so no plane edge can ever
  // swing into frame at the yaw extremes.
  if (group.userData.backdrop) scene.add(group.userData.backdrop);
  // No void plane: the chrono row owns its backdrop (floor gradient + CSS
  // vignette). The legacy stack-era dark quad occluded wide rows.

  const auto = params.get("path") === "auto" && !reduced;
  const view = { cut: 1, cutTarget: 1, yaw: -0.3, pitch: 0, yawT: -0.3, pitchT: 0, aimX: 0, aimY: -0.2, playing: false, auto, autoT0: 0, reveal: null, leadMax: Infinity, frames: null, zoom: 0, yawAmp: 0.52, headOrders: null };
  // Cards turn back toward the camera by this share of a drag, so at the
  // turn's extremes a pose is never seen as a thin flat card (the row still
  // turns fully; the framing solve includes it).
  const CARD_TURN = 0.6;
  const turnCards = () => {
    const a = chronoCardYaw(view.yaw, YAWREST, CARD_TURN);
    for (const m of group.children) if (m.userData.order !== undefined || m.userData.ghost) m.rotation.y = a;
  };
  const YAWREST = -0.3; // rest yaw; swing amplitude yawAmp (~+-30 deg wide, narrower on portrait so flat cards never turn edge-on)
  const PITCH = 0.28;
  if (auto) { view.cut = 0.15; view.cutTarget = 0.15; }

  const slider = $("#timeSlider");
  const out = $("#timeOut");
  const playBtn = $("#playBtn");
  const secOut = $("#timeSec");
  const poseOut = $("#poseTick");
  const durSec = Number(meta?.durationSec) || 0;
  const poseCount = atlas?.count || 0;
  const poseTimes = Array.isArray(atlas?.timestamps) ? atlas.timestamps : [];
  const setCutUi = (c, user = true) => {
    if (user) { view.auto = false; view.reveal = null; } // any input takes over from the autoplay path and the reveal
    view.cutTarget = Math.min(1, Math.max(0.02, c));
    slider.value = String(Math.round(view.cutTarget * 1000));
    out.textContent = `${Math.round(view.cutTarget * 100)}%`;
    // The head marker follows the DISPLAYED poses (portrait shows a motion-
    // spaced subset), so the pose number and seconds stay honest per mode.
    const orders = view.headOrders && view.headOrders.length ? view.headOrders : Array.from({ length: poseCount }, (_, i) => i);
    const di = Math.max(1, Math.round(orders.length * view.cutTarget));
    const order = orders[Math.min(di, orders.length) - 1] ?? 0;
    const hasStamps = poseTimes.length === poseCount && poseCount;
    const stamp = hasStamps ? poseTimes[order] : undefined;
    const t = typeof stamp === "number" || (typeof stamp === "string" && stamp.trim() !== "") ? Number(stamp) : NaN;
    const tHead = Number.isFinite(t) ? ` · ${t.toFixed(1)}s` : (hasStamps ? " · time unknown" : "");
    if (secOut) secOut.textContent = durSec > 0 ? `${(view.cutTarget * durSec).toFixed(1)}s of ${durSec.toFixed(1)}s` : "";
    // The 'now' marker on the time axis: which pose the head stands on.
    // A living still (a subject that barely moved): one pose that plays the clip.
    if (poseOut && atlas?.still) poseOut.textContent = "barely moves · one pose, the clip plays on it";
    else if (poseOut && poseCount) poseOut.textContent = `now: pose ${order + 1}/${poseCount}${tHead}`;
  };
  slider.addEventListener("input", () => {
    view.playing = false;
    playBtn.setAttribute("aria-pressed", "false");
    playBtn.textContent = "Play";
    setCutUi(Number(slider.value) / 1000);
  });
  // One-time reveal: the first time a visitor enters the 3D view in a
  // session, the row builds once through time (a gentle 5 s sweep from the
  // first poses; no turn, so the backdrop plate never shows its edge), then
  // rests on the full row. Any input stops it at once: a time control (slider, wheel, arrow
  // keys, Play) takes over from where it is, anything else lets the row
  // finish. Reduced motion, a single pose (a living still already plays its
  // clip) and the ?path=auto recording sweep skip it. It never repeats.
  const REVEAL_MS = 5000, REVEAL_FROM = 0.15, REVEAL_KEY = "lite-reveal-seen";
  let revealDone = false;
  const startReveal = () => {
    if (revealDone || reduced || auto || poseCount < 2) return;
    revealDone = true;
    try {
      if (sessionStorage.getItem(REVEAL_KEY)) return;
      sessionStorage.setItem(REVEAL_KEY, "1");
    } catch { /* storage blocked: once per page load */ }
    view.reveal = { t0: 0 };
    setCutUi(REVEAL_FROM, false);
    view.cut = view.cutTarget;
    view.zoom = followTarget();
  };
  const stopReveal = (e) => {
    if (!view.reveal) return;
    view.reveal = null;
    const timeInput = e && (e.target === slider || e.target === playBtn
      || (e.type === "wheel" && stage.contains(e.target))
      || (e.type === "keydown" && e.target === canvas && (e.key === "ArrowLeft" || e.key === "ArrowRight")));
    if (timeInput) return;
    if (e?.target !== canvas) view.yawT = YAWREST; // a drag keeps its own turn
    setCutUi(1, false);
  };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(type, stopReveal, { capture: true, passive: true });
  }
  playBtn.addEventListener("click", () => {
    view.playing = !view.playing;
    if (view.playing && view.cutTarget >= 0.999) setCutUi(0.02);
    playBtn.setAttribute("aria-pressed", String(view.playing));
    playBtn.textContent = view.playing ? "Pause" : "Play";
  });
  $("#resetBtn").addEventListener("click", () => {
    view.yawT = -0.3;
    view.pitchT = 0;
    view.aimX = 0;
  });
  stage.addEventListener("wheel", (e) => { e.preventDefault(); setCutUi(view.cutTarget - e.deltaY * 0.0009); }, { passive: false });
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    view.auto = false;
    drag = { x: e.clientX, y: e.clientY, yaw: view.yawT, pitch: view.pitchT };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    view.yawT = Math.max(YAWREST - view.yawAmp, Math.min(YAWREST + view.yawAmp, drag.yaw + (e.clientX - drag.x) * 0.006));
    view.pitchT = Math.max(-PITCH, Math.min(PITCH, drag.pitch + (e.clientY - drag.y) * 0.004));
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.tabIndex = 0;
  canvas.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") setCutUi(view.cutTarget + 0.05);
    else if (e.key === "ArrowLeft") setCutUi(view.cutTarget - 0.05);
    else return;
    e.preventDefault();
  });

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const chipsFor = (m = {}) => {
    const out = [];
    const prov = m.provenance || [];
    if (prov.includes("synthetic-gt-body-rgba")) return ["Synthetic ground truth", "Consumer QA · no model inference"];
    if (prov.some((p) => String(p).startsWith("sam"))) out.push("SAM 3.1 tracking");
    if (prov.some((p) => String(p).startsWith("muse-image"))) out.push("Muse Image plate");
    if (prov.some((p) => String(p).startsWith("muse-spark"))) {
      const known = (v) => v && !["unknown", "other"].includes(v);
      const cam = known(m.camera) ? m.camera : "";
      const cat = known(m.category) ? m.category : "";
      out.push(`Muse Spark: ${[cam, cat].filter(Boolean).join("-") || "routing"}`);
    }
    return out.length ? out : ["SAM 3.1 tracking", "Muse Spark routing"];
  };
  if (meta) {
    $("#vTitle").textContent = meta.title || "A spacetime solid";
    const bits = [meta.subject, meta.durationSec ? `${meta.durationSec}s` : ""].filter(Boolean);
    if (bits.length) $("#vLede").textContent = bits.join(" · ");
    $("#vChips").innerHTML = chipsFor(meta.meta).map((c) => `<li>${esc(c)}</li>`).join("");
  }
  document.title = `${meta?.title || "Lite solid"} — The Construct`;
  setCutUi(view.cutTarget, false);

  let last = performance.now();
  const _aimV = new THREE.Vector3();
  // Camera for the current turn: the projected framing pans camera and
  // target together so the row stays centred at every yaw/pitch; without
  // one (older code path, failed solve) the camera keeps its fitted spot.
  view.frame = null;
  const placeCamera = (yaw, pitch, aimX) => {
    if (view.frames) {
      const c = followAt(view.zoom, yaw, pitch);
      camera.position.set(c.camX + c.x, c.camY + c.y, c.dist);
      camera.lookAt(c.x, c.aimY + c.y, 0);
      return;
    }
    const f = view.frame;
    if (!f) { camera.lookAt(aimX, view.aimY, 0); return; }
    // The early-sweep lead (aimX) pans too, rather than turning the view,
    // and only as far as the backdrop plate's solid part reaches (its outer
    // 8% fades to the void), net of the turn's own pan.
    const p = chronoPanAt(f, yaw, pitch);
    const room = Math.max(0, view.leadMax - Math.abs(p.x - f.rest.x));
    const lead = Math.max(-room, Math.min(room, aimX));
    camera.position.set(f.camX + p.x + lead, f.camY + p.y, f.dist);
    camera.lookAt(p.x + lead, f.aimY + p.y, 0);
  };
  // Spaced moments on a wide stage: poses that overlap read as one smear,
  // and seven of them shrink each to a quarter of the frame. Show the most
  // moments (up to 5, first and last kept) whose subjects stand apart and
  // still come out large: every pose at least 27% of the frame height and
  // the now-pose at least 45%, else 3. Solved with the real framing.
  const SPACED = { max: 5, min: 3, gap: 0.2, minH: 0.27, headH: 0.45 };
  const spaced = (aimY) => {
    const u = group.userData;
    const ts = Array.isArray(atlas.timestamps) ? atlas.timestamps : null;
    const opts = { fovDeg: camera.fov, aspect: camera.aspect, aimY, yawRest: YAWREST, yawBound: view.yawAmp, pitchBound: PITCH, cardTurn: CARD_TURN };
    let pick = null;
    for (let k = Math.min(u.count, SPACED.max); k >= Math.min(u.count, SPACED.min); k -= 1) {
      try {
        const built = spacedChronoPoints({ count: u.count, poseW: u.poseW, poseH: u.poseH, anchors: atlas.anchors, timestamps: ts, k, gap: SPACED.gap });
        const rects = chronoPointRects(built.points, u);
        const frame = frameChronoView(rects, opts);
        const hs = chronoRestHeights(rects, frame, opts);
        pick = { built };
        if (Math.min(...hs) >= SPACED.minH && hs[hs.length - 1] >= SPACED.headH) break;
      } catch { /* try fewer */ }
    }
    if (!pick) return false;
    setChronoLayout(group, { mode: "subset", indices: pick.built.indices, points: pick.built.points });
    view.headOrders = pick.built.indices;
    spaced.fit = fitChronoPoints(pick.built.points, { fovDeg: camera.fov, aspect: camera.aspect, yawRest: YAWREST, yawBound: view.yawAmp, fill: 0.85, widthFill: 0.97, aimY });
    return true;
  };
  // Follow framing: while the read head shows only the first poses (the
  // reveal, Play, a scrub), the camera frames those poses at up to FOLLOW_H
  // of the frame height, then pulls back step by step to the full row. Each
  // step is solved like the full frame (every drag extreme inside) and eased
  // toward the full frame until its view stays on the backdrop plate's solid
  // part. Reduced motion keeps the full frame.
  const FOLLOW_H = 0.6;
  const followAt = (z, yaw, pitch) => {
    const fs = view.frames;
    const i0 = Math.max(0, Math.min(fs.length - 1, Math.floor(z))), i1 = Math.min(fs.length - 1, i0 + 1);
    const a = Math.min(1, Math.max(0, z - i0)), A = fs[i0], B = fs[i1];
    const pa = chronoPanAt(A, yaw, pitch), pb = chronoPanAt(B, yaw, pitch), L = (x, y) => x + (y - x) * a;
    return { camX: L(A.camX, B.camX), camY: L(A.camY, B.camY), dist: L(A.dist, B.dist), aimY: L(A.aimY, B.aimY), x: L(pa.x, pb.x), y: L(pa.y, pb.y) };
  };
  const blendFrame = (A, B, s) => {
    const L = (x, y) => x + (y - x) * s;
    return {
      ...A, dist: L(A.dist, B.dist), camX: L(A.camX, B.camX), camY: L(A.camY, B.camY), aimY: L(A.aimY, B.aimY),
      pans: A.pans.map((row, i) => row.map((p, j) => ({ x: L(p.x, B.pans[i][j].x), y: L(p.y, B.pans[i][j].y) }))),
    };
  };
  const _probe = new THREE.PerspectiveCamera();
  // Where a frame's view meets the plate, per sampled turn: [left, right]
  // in plate x (null when a corner ray misses the plate).
  const plateFoot = (f, bd) => {
    _probe.fov = camera.fov; _probe.aspect = camera.aspect; _probe.near = camera.near; _probe.far = camera.far;
    _probe.updateProjectionMatrix();
    return f.pans.map((row) => row.map((p) => {
      _probe.position.set(f.camX + p.x, f.camY + p.y, f.dist);
      _probe.lookAt(p.x, f.aimY + p.y, 0);
      _probe.updateMatrixWorld();
      let l = Infinity, r = -Infinity;
      for (const [nx, ny] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const ray = _aimV.set(nx, ny, 0.5).unproject(_probe).sub(_probe.position);
        const t = ray.z < -1e-6 ? (bd.position.z - _probe.position.z) / ray.z : -1;
        if (!(t > 0)) return null;
        const x = _probe.position.x + ray.x * t - bd.position.x;
        l = Math.min(l, x); r = Math.max(r, x);
      }
      return [l, r];
    }));
  };
  // A follow step may show no more of the plate's fading edge than the full
  // frame does at the same turn: inside the solid part, or inside the full
  // frame's own view of the plate.
  const plateClear = (f, bd, solid, fullFoot) => {
    const foot = plateFoot(f, bd);
    return foot.every((row, i) => row.every((v, j) => {
      const F = fullFoot[i][j];
      return v && F && v[0] >= Math.min(-solid, F[0]) - 1e-6 && v[1] <= Math.max(solid, F[1]) + 1e-6;
    }));
  };
  const FOLLOW_PLATE = 1.3; // the plate may grow up to this much so the close steps keep it behind them
  const FOLLOW_NEAR = 0.55; // never closer than this share of the full frame's distance (the plate would blur)
  const followFrames = (full, opts) => {
    const rects = chronoViewRects(group);
    if (!full || reduced || rects.length < 2) return null;
    const nears = [];
    for (let k = 1; k < rects.length; k += 1) {
      let near = null;
      try {
        // The k-th pose is the now-pose at that cut: it stands 6% larger.
        const sub = rects.slice(0, k).map((r, j) => (j === k - 1 ? { ...r, s: 1.06 } : r));
        near = frameChronoView(sub, { ...opts, fill: [0.94, FOLLOW_H], minDist: FOLLOW_NEAR * full.dist });
        if (!(near.pans.length === full.pans.length && near.pans[0].length === full.pans[0].length)) near = null;
      } catch { near = null; }
      nears.push(near);
    }
    const bd = group.userData.backdrop;
    if (bd && bd.userData.baseW > 0) {
      // Grow and recentre the plate (up to FOLLOW_PLATE) so its solid part
      // spans every step's view of it, keeping its bottom edge where it was.
      const feet = [full, ...nears.filter(Boolean)].flatMap((f) => plateFoot(f, bd).flat());
      if (feet.every(Boolean)) {
        const L = Math.min(...feet.map((v) => v[0])) + bd.position.x, R = Math.max(...feet.map((v) => v[1])) + bd.position.x;
        const fullFeet = plateFoot(full, bd).flat();
        const FL = Math.min(...fullFeet.map((v) => v[0])) + bd.position.x, FR = Math.max(...fullFeet.map((v) => v[1])) + bd.position.x;
        const s0 = bd.scale.x, baseW = bd.userData.baseW, baseH = bd.userData.baseH;
        const s1 = Math.min(s0 * FOLLOW_PLATE, Math.max(s0, (R - L) / (0.84 * baseW)));
        const half = (s1 * baseW * 0.84) / 2;
        const cx = Math.min(FL + half, Math.max(FR - half, (L + R) / 2));
        const bottom = bd.position.y - (baseH * s0) / 2;
        bd.scale.set(s1, s1, 1);
        bd.position.x = cx;
        bd.position.y = bottom + (baseH * s1) / 2;
      }
    }
    const solid = bd && bd.userData.baseW > 0 ? (bd.scale.x * bd.userData.baseW * 0.84) / 2 : Infinity;
    const fullFoot = Number.isFinite(solid) ? plateFoot(full, bd) : null;
    const frames = nears.map((near) => {
      if (!near) return full;
      if (!fullFoot || plateClear(near, bd, solid, fullFoot)) return near;
      let lo = 0, hi = 1;
      for (let it = 0; it < 14; it += 1) { const m = (lo + hi) / 2; if (plateClear(blendFrame(near, full, m), bd, solid, fullFoot)) hi = m; else lo = m; }
      return blendFrame(near, full, hi);
    });
    frames.push(full);
    return frames;
  };
  // Continuous with the read head: pose k+1 appears when the cut passes
  // k + 0.5 poses, by when the camera (eased, so a little behind) frames
  // nearly k + 1 poses.
  const followTarget = () => (view.frames ? Math.min(view.frames.length - 1, Math.max(0, view.frames.length * view.cut - 0.35)) : 0);
  const resize = () => {
    const w = stage.clientWidth;
    const h = Math.min(innerHeight * 0.62, 560);
    // A hidden or not-yet-laid-out stage has no valid projection. Recover
    // without needing a second window resize event when layout settles.
    if (!(w > 0 && h > 0)) { requestAnimationFrame(resize); return; }
    renderer.setSize(w, h, false);
    view.frames = null;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Projected-bounds fit: every pose corner clears the frame at the rest
    // yaw, both drag bounds and both pitch bounds, so a looming near pose
    // never clips (cornersClear proof in tests/lite/frame.test.js).
    // Wide: tight targets (row fills the frame) + the stage lowered a touch
    // so the floor pool sits in the bottom third with the poses on it.
    // Portrait (aspect < 1): a straight row of 8-12 renders as an illegible
    // sliver, so the viewer switches to a motion-spaced subset (first/last
    // kept) on a receding diagonal — near pose bottom-left large, far poses
    // up-right smaller, shadows under each foot. Same proof over the points.
    view.yawAmp = camera.aspect < 1 ? 0.28 : 0.52;
    const u = group.userData;
    let fit, aimY, elev = 0;
    if (camera.aspect < 1) {
      aimY = 0;
      // Phone diagonal by pose shape: three poses (five overlapped into one
      // another at phone size), x spread shrinking as poses get wider, and
      // wide poses seen from a little above so the diagonal climbs the frame
      // instead of running off its sides (a herd, a jellyfish trail).
      const shape = u.poseW / u.poseH;
      elev = (Math.min(25, Math.max(0, (shape - 0.8) * 25)) * Math.PI) / 180;
      const built = portraitChronoPoints({
        count: u.count, poseW: u.poseW, poseH: u.poseH,
        spreadK: Math.min(1, Math.max(0.3, 0.6 / shape)), depthK: 2.0, max: 3,
        timestamps: Array.isArray(atlas.timestamps) ? atlas.timestamps : null,
      });
      setChronoLayout(group, { mode: "portrait", indices: built.indices, points: built.points });
      view.headOrders = built.indices;
      fit = fitChronoPoints(built.points, {
        fovDeg: camera.fov, aspect: camera.aspect,
        yawRest: YAWREST, yawBound: view.yawAmp, fill: 0.8, widthFill: 0.95, aimY,
      });
    } else if (atlas.group && u.count > 1) {
      // A herd or pack picked as one object: every pose is a crowd, and six
      // crowds at the usual spacing merge into one band of animals. Show
      // three moments (first, middle, last by time) spaced so the crowds
      // stand apart; each comes out about half again as large.
      aimY = -0.2;
      const ts = Array.isArray(atlas.timestamps) ? atlas.timestamps : null;
      const indices = selectPortraitIndices(u.count, ts, 3);
      const span = 1.15 * u.poseW * (indices.length - 1);
      const depth = Math.min(4.6, Math.max(0.8, span * 0.15));
      const points = indices.map((order, j) => {
        const t = indices.length <= 1 ? 0.5 : j / (indices.length - 1);
        return { order, x: (t - 0.5) * span, z: (t - 0.5) * depth };
      });
      setChronoLayout(group, { mode: "subset", indices, points });
      view.headOrders = indices;
      fit = fitChronoPoints(points.map((p, j) => ({ ...p, hw: u.poseW / 2, hh: u.poseH / 2, s: j === points.length - 1 ? 1.06 : 1 })), {
        fovDeg: camera.fov, aspect: camera.aspect, yawRest: YAWREST, yawBound: view.yawAmp, fill: 0.85, widthFill: 0.97, aimY,
      });
    } else {
      aimY = -0.2;
      // A ghost-trail build keeps every pose on the row: the frames between
      // them overlap into one exposure, which spaced-out moments would break
      // back into separate copies.
      if (!u.trail && spaced(aimY)) fit = spaced.fit;
      else {
        setChronoLayout(group, { mode: "row" });
        view.headOrders = null;
        fit = fitChronoRow(
          { count: u.count, poseW: u.poseW, poseH: u.poseH, rowLen: u.rowLen, depth: u.rowD },
          { fovDeg: camera.fov, aspect: camera.aspect, yawRest: YAWREST, yawBound: view.yawAmp, fill: 0.85, widthFill: 0.97, aimY }
        );
      }
    }
    camera.position.set(1.4, 0.9, fit);
    camera.lookAt(0, aimY, 0);
    view.aimY = aimY;
    // Projected framing over the displayed subjects (see frameChronoView):
    // centred at rest, as close as the rest fill allows, every drag extreme
    // inside the frame. The canonical fit above stays as the fallback.
    const frameOpts = {
      fovDeg: camera.fov, aspect: camera.aspect, aimY, elev,
      yawRest: YAWREST, yawBound: view.yawAmp, pitchBound: PITCH, cardTurn: CARD_TURN,
    };
    try {
      view.frame = frameChronoView(chronoViewRects(group), frameOpts);
    } catch {
      view.frame = null;
    }
    placeCamera(YAWREST, 0, 0);
    // Frame-filling plate: map the backdrop at ~1.35x behind the subject
    // plane (not 4x), centred on the resting view axis.
    const bd = group.userData.backdrop;
    fitBackdropToFrame(bd, camera, 1.35);
    // How far the camera may slide sideways before the plate's fading edge
    // (its outer 8%) shows: where the frame's corner rays meet the plate,
    // against the plate's solid part.
    view.leadMax = Infinity;
    if (bd && bd.userData.baseW > 0) {
      camera.updateMatrixWorld();
      const solid = (bd.scale.x * bd.userData.baseW * 0.84) / 2;
      let room = Infinity;
      for (const [nx, ny] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const ray = _aimV.set(nx, ny, 0.5).unproject(camera).sub(camera.position);
        const t = ray.z < -1e-6 ? (bd.position.z - camera.position.z) / ray.z : -1;
        if (!(t > 0)) { room = 0; break; }
        const x = camera.position.x + ray.x * t - bd.position.x;
        room = Math.min(room, nx < 0 ? x + solid : solid - x);
      }
      view.leadMax = Math.max(0, room);
    }
    view.frames = followFrames(view.frame, frameOpts);
    view.zoom = followTarget();
  };
  addEventListener("resize", resize);
  resize();

  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    // Still panel is a static image: skip all 3D work (and pause autoplay)
    // while it is shown. No animation runs here, so reduced motion needs
    // no further handling for this mode.
    if (stillMode === "still") return;
    if (view.auto) {
      // Autoplay path: wall-clock sweep (immune to headless frame-rate),
      // slow arc ending at a 3/4 view with the time sweep.
      if (!view.autoT0) view.autoT0 = now;
      // The sweep opens on 2-3 poses, never an empty floor: first
      // impressions (and sampled judge frames) should read as a row.
      const c = 0.15 + ((now - view.autoT0) / 12000) * 0.85;
      view.yawT = YAWREST + view.yawAmp * Math.min(1, c);
      if (c >= 1) { view.auto = false; setCutUi(1, false); }
      else setCutUi(c, false);
    } else if (view.reveal) {
      if (!view.reveal.t0) view.reveal.t0 = now;
      const k = Math.min(1, (now - view.reveal.t0) / REVEAL_MS);
      const ease = k * k * (3 - 2 * k);
      if (k >= 1) { view.reveal = null; setCutUi(1, false); }
      else setCutUi(REVEAL_FROM + (1 - REVEAL_FROM) * ease, false);
    } else if (view.playing && !reduced) {
      let c = view.cutTarget + (dt / Math.max(4, meta?.durationSec || 6)) ;
      if (c >= 1) {
        if (reduced) { c = 1; view.playing = false; }
        else c = 0.02;
      }
      setCutUi(c);
    } else if (view.playing && reduced) {
      // reduced motion: step gently to the end and stop (no looping).
      setCutUi(Math.min(1, view.cutTarget + dt * 0.2));
      if (view.cutTarget >= 1) {
        view.playing = false;
        playBtn.setAttribute("aria-pressed", "false");
        playBtn.textContent = "Play";
      }
    }
    view.cut += (view.cutTarget - view.cut) * Math.min(1, dt * 8);
    if (view.frames) view.zoom += (followTarget() - view.zoom) * Math.min(1, dt * 3);
    view.yaw += (view.yawT - view.yaw) * Math.min(1, dt * 8);
    view.pitch += (view.pitchT - view.pitch) * Math.min(1, dt * 8);
    tickChrono(group, view.cut, now / 1000);
    group.rotation.set(view.pitch, view.yaw, 0);
    turnCards();
    // Aim-x easing: the early sweep opens on the leftmost 2-3 poses with
    // the rest of the stage empty, so pan toward the revealed centroid
    // (smoothed ~1s vs the 12s sweep) and settle on the full-row fit as the
    // head reaches the end (centroid of the full row sits at x≈0).
    group.updateMatrixWorld();
    let ax = 0, an = 0;
    for (const m of group.children) {
      if (m.userData.order === undefined || !m.visible) continue;
      ax += m.position.x; an += 1;
    }
    if (an > 0) {
      _aimV.set(ax / an, 0, 0);
      group.localToWorld(_aimV);
      // Lead, don't centre: a third of the centroid keeps the revealed poses
      // left-of-centre with open stage ahead of them (and keeps the pan
      // inside what the 1.35x plate covers). Full row centroids sit at x≈0,
      // so the sweep still settles exactly on the full-row fit.
      view.aimX += (_aimV.x * 0.35 - view.aimX) * Math.min(1, dt * 3);
    }
    placeCamera(view.yaw, view.pitch, view.aimX);
    renderer.render(scene, camera);
  };
  // Same bounded control contract as Basic/Advanced, used by reproducible
  // playback checks. Normal UI bounds and selected-pose semantics stay intact.
  window.__lite = {
    meta, camera, group,
    setPlaying(playing) {
      view.auto = false;
      view.reveal = null;
      view.playing = !!playing;
      playBtn.setAttribute("aria-pressed", String(view.playing));
      playBtn.textContent = view.playing ? "Pause" : "Play";
    },
    seek(seconds) {
      setCutUi(durSec > 0 ? seconds / durSec : 1);
      view.cut = view.cutTarget;
    },
    setLook(x, y) {
      view.auto = false;
      view.reveal = null;
      view.yaw = view.yawT = YAWREST + Math.max(-1, Math.min(1, x)) * view.yawAmp;
      view.pitch = view.pitchT = Math.max(-1, Math.min(1, y)) * PITCH;
    },
    frame() {
      tickChrono(group, view.cut, performance.now() / 1000);
      group.rotation.set(view.pitch, view.yaw, 0);
      turnCards();
      group.updateMatrixWorld();
      placeCamera(view.yaw, view.pitch, view.aimX);
      renderer.render(scene, camera);
    },
    showStill(on) {
      // Scripted views (playback checks) never start the reveal.
      revealDone = true;
      stopReveal(null);
      setStillMode(on ? "still" : "3d");
    },
  };
  onEnter3d = startReveal;
  if (stillMode === "3d") startReveal();
  requestAnimationFrame(frame);
}

load();
