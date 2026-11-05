import * as THREE from "three";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";
import { frameAt as timeFrame, poseKeys, regularisePositions, validateMeta, timeLabel, portraitFov, surroundOf } from "./stable-math.mjs";
import { decodeGrid } from "./stable-grid.mjs";

// ── Stable ───────────────────────────────────────────────────────────────
// A handheld clip rebuilt as one world (backend/tools/make-stable.py). The
// camera moved, so every frame saw the park from somewhere else; Depth
// Anything 3 solved where. Keyframe depth maps become surfaces textured with
// the footage itself, so the park is a continuous picture that holds still
// while the recording camera travels through it. As in the reference, only
// what the lens is looking at right now is lit; the rest sinks into dark.
// The walker, masked out of each frame by SAM 3.1, is a surface per frame,
// left standing at every moment she was seen: the millipede.

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
// ?specimen=<job id>: a finished Advanced build served from the app's specimens store (same bake layout as assets/stable/<clip>/)
const SPECIMEN = params.get("specimen") || "";
if (SPECIMEN && !/^[0-9a-f-]{36}$/i.test(SPECIMEN)) throw new Error("Invalid specimen id.");
// ?seed=<name>: a licensed example world shipped with the site (assets/gallery-seed/<name>/), packed small:
// its environment as grid.bin and no source clip (the inset and the lens pane stay hidden)
const SEED = SPECIMEN ? "" : params.get("seed") || "";
if (SEED && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(SEED)) throw new Error("Invalid example name.");
const CLIP = SPECIMEN ? "specimen" : SEED ? "seed" : params.get("clip") || "walker";
// Shown inside the tesseract's room window: no UI, paused, fixed 1:1 pixels, and
// a readable canvas so the host page can use each rendered frame as a texture.
const EMBED = params.has("embed");
if (EMBED) document.body.classList.add("embed");
const hasGeneratedWorld = ["horse", "walker", "grizzly", "wolf1", "wolf2", "wolf3"].includes(CLIP);
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(CLIP)) throw new Error("Invalid clip name. Use a baked recording's folder name.");
if (![...$("#clipPick").options].some(o => o.value === CLIP)) $("#clipPick").add(new Option(CLIP, CLIP));
const BASE = SPECIMEN ? `specimens/${SPECIMEN}/` : SEED ? `assets/gallery-seed/${SEED}/` : `assets/stable/${CLIP}/`;
// The generated background is the slowest asset: start its module and bytes now,
// not after every texture. Failures surface where the world is loaded.
const worldImport = hasGeneratedWorld && params.get("world") !== "original" ? import("./stable-worldlabs.mjs") : null;
let worldBytes = worldImport?.then(({ worldUrl }) => fetch(worldUrl(CLIP, params.get("splats"))).then((r) => {
  if (!r.ok) throw new Error(`Unable to load the background (HTTP ${r.status}).`);
  return r.arrayBuffer();
}));
worldImport?.catch(() => {});
worldBytes?.catch(() => {});
$("#clipPick").value = CLIP;
// a visitor's build or a licensed example is the only clip on its page: the bake menu would only reload it
$("#clipPick").hidden = Boolean(SPECIMEN || SEED);
const reload =(set) => { const q = new URLSearchParams(location.search); set(q); location.search = q.toString(); };
$("#clipPick").addEventListener("change", (e) => reload((q) => q.set("clip", e.target.value)));
// bakes are rewritten in place, so data never comes from the browser cache
const get = async (url) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load ${url} (HTTP ${response.status}).`);
  return response;
};
const buffer = (name, Type) => get(BASE + name).then((r) => r.arrayBuffer()).then((b) => new Type(b));

const meta = await get(BASE + "stable.json").then((r) => r.json());
validateMeta(meta);

// A visitor's build or a licensed example opens as a plain viewer: its name, play and time, and two ways to look. The
// reconstruction lab's modes, readouts and key list stay behind ?debug=1 (and the clip menu is gone: see #clipPick above)
const PRODUCT = Boolean(SPECIMEN || SEED) && !params.has("debug") && !EMBED;
const GENERIC = /^(?:an?\s+)?(?:animal|object|subject|thing|something|creature|wildlife)s?$/i;
// "white wolves, white wolves" -> "White wolves"; a generic or missing name -> "Your world"
const worldName = (subject) => {
  const names = [...new Set(String(subject || "").split(",").map((s) => s.trim()).filter(Boolean))];
  const name = names.join(" and ").slice(0, 60);
  return !name || GENERIC.test(name) ? "Your world" : name[0].toUpperCase() + name.slice(1);
};
if (PRODUCT) {
  document.body.classList.add("product");
  const setTitle = (name) => { $(".top b").textContent = name; document.title = `${name} — The Construct`; };
  setTitle(SEED ? "Example" : "Your world");
  $(".top .eyebrow").textContent = SEED ? "Example · world" : "World";
  $("#blurb").textContent = "The filmed place in 3D, with its subject at each moment";
  $("[data-cam='orbit']").textContent = "look around";
  $("[data-cam='orbit']").title = "Drag to look around the recorded place";
  $("[data-cam='recorded']").textContent = "through the lens";
  $("[data-cam='recorded']").title = "The view from where the camera stood";
  $(".hud .keys").innerHTML = "<kbd>drag</kbd> look around · <kbd>scroll</kbd> move through time · <kbd>space</kbd> play or pause";
  const note = $(".hud .note").firstChild;
  note.textContent = "Depth is estimated, and the place past the frame is filled in ";
  $("#loading b").textContent = "Opening the world";
  $("#loading p").textContent = "Loading the place and its subject…";
  // the name: an example's from the gallery list (with its credit), a build's from its own record
  (SEED
    ? fetch("assets/gallery-seed.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        const item = list?.examples?.find((e) => e.seedName === SEED);
        if (item?.title) setTitle(String(item.title).slice(0, 60));
        if (item?.note) note.textContent = `${String(item.note).slice(0, 200)} · ${note.textContent}`;
      })
    : fetch(BASE + "meta.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((info) => setTitle(worldName(info?.subject || meta.concept)))
  ).catch(() => { if (!SEED) setTitle(worldName(meta.concept)); });
}
// Existing merge bakes are inventoried separately, avoiding optional-file 404s.
const mergeClips = await get("assets/stable/merged-clips.json").then(r => r.json());
const mergedData = mergeClips.includes(CLIP) || params.has("dedup")
  ? await fetch(BASE + "stable.dedup.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null)
  : null;
const dedupParam = params.get("dedup");
const dedup = dedupParam !== null ? mergedData : null;
// soft (default): redundant triangles stay, drawn behind the winning keyframe's;
// hard (?dedup=hard): they are dropped, which is fewer triangles but opens thin seams
const soft = dedup && dedupParam !== "hard";
if (dedup) {
  dedup.env.forEach((r, i) => Object.assign(meta.env[i], r));
  dedup.sub.forEach((r, i) => r && Object.assign(meta.sub[i], r));
}
const mergedBtn = $("#mergedBtn");
mergedBtn.disabled = !mergedData;
mergedBtn.title = mergedData ? "Use the existing voxel-deduplicated environment bake"
  : meta.env.length === 1 ? "nothing to merge: this clip has one environment surface" : "No merged-world bake available for this clip";
mergedBtn.setAttribute("aria-pressed", String(!!dedup));
mergedBtn.addEventListener("click", () => reload((q) => (dedup ? q.delete("dedup") : q.set("dedup", "1"))));
const V2 = meta.version === 2;
// A fixed lens: rest where it looked, so the first view is the footage and orbiting reveals its depth.
const lensView = V2 && meta.fixed;
// A world that carries its environment as a grid (grid.bin) downloads that instead of the three buffers.
const grid = meta.grid && !dedup && /^[\w.-]+\.bin$/.test(meta.grid.file || "")
  ? get(BASE + meta.grid.file).then((r) => r.arrayBuffer()).then((b) => decodeGrid(meta, b))
  : null;
const [pos, uv, idx, clipBlob, shellDepth] = await Promise.all([
  grid ? grid.then((g) => g.pos) : buffer("pos.f32", Float32Array),
  grid ? grid.then((g) => g.uv) : buffer("uv.f32", Float32Array),
  grid ? grid.then((g) => g.idx) : buffer(dedup ? "idx.dedup.u32" : "idx.u32", Uint32Array),
  // held in memory: seeking a streamed file needs range requests, which a
  // plain static server may not answer
  // (not fetched when embedded: its inset is hidden, so the 10 MB would never be seen; a seed ships none)
  (EMBED && !params.has("source")) || SEED ? null : get(SPECIMEN ? BASE + meta.clip : meta.clip).then((r) => r.blob()),
  V2 ? buffer("shells.u16", Uint16Array) : null,
]);
// One record per animal per sampled moment (a "shell"). Legacy bakes: meta.sub, one animal, a mesh per
// frame in pos/uv/idx. Version 2 (make-world.py): any number of animals, each a depth grid + crop.
const recs = V2 ? meta.shells : meta.sub.map((rec, i) => rec && { ...rec, i, track: 1 }).filter(Boolean);
const frames = Array.from({ length: V2 ? meta.times.length : meta.sub.length }, () => ({ centroid: undefined }));
{
  const sums = frames.map(() => ({ n: 0, c: [0, 0, 0] }));
  for (const r of recs) { sums[r.i].n++; r.centroid.forEach((v, k) => { sums[r.i].c[k] += v; }); }
  sums.forEach((a, i) => { if (a.n) frames[i].centroid = a.c.map((v) => v / a.n); });
}
const N = frames.length;
const times = meta.times;
const T0 = times[0];
const DURATION = times[N - 1] - T0;
if (pos.length % 3 || uv.length !== pos.length / 3 * 2) throw new Error("This clip has incomplete geometry buffers.");
$("#total").textContent = timeLabel(DURATION);

// ── Scene ────────────────────────────────────────────────────────────────

// Everything here is raw sRGB bytes end to end (footage textures, hex
// colours, the post pass), so no stage converts colour.
THREE.ColorManagement.enabled = false;
const canvas = $("#view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: CLIP === "grizzly" && params.get("world") !== "original" });
renderer.setPixelRatio(EMBED ? 1 : Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x020304, 1);
let renderDirty = true;
const scene = new THREE.Scene();
const environment = hasGeneratedWorld && params.get("world") !== "original" ? new THREE.Group() : scene;
if (environment !== scene) scene.add(environment);
let world = null;
const camera = new THREE.PerspectiveCamera(meta.fovY, 1, 0.005, 60);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// the wheel runs time, so it must not also zoom
controls.enableZoom = false;
controls.enablePan = false; // shifting the pivot would bypass the safe viewing angles
controls.addEventListener("change", () => { renderDirty = true; });

// Textures stay raw sRGB bytes and the shaders skip colour conversion, so the
// footage reaches the screen exactly as filmed.
const loader = new THREE.TextureLoader();
const pendingTextures = [];
function texture(file) {
  let loaded, failed;
  pendingTextures.push(new Promise((resolve, reject) => { loaded = resolve; failed = reject; }));
  const t = loader.load(`${BASE}${file}?v=${meta.env.length}.${meta.env[0].idxCount}.${meta.env[0].live ? 1 : 0}`, loaded,
    undefined, () => failed(new Error(`Unable to load the reconstruction texture ${file}.`)));
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function surface(rec, from = rec.idxOffset, count = rec.idxCount) {
  if (![rec.vertOffset, rec.vertCount, from, count].every(n => Number.isInteger(n) && n >= 0) ||
      (rec.vertOffset + rec.vertCount) * 3 > pos.length || from + count > idx.length || count % 3) {
    throw new Error("This clip has invalid surface ranges.");
  }
  for (let i = from; i < from + count; i++) if (idx[i] >= rec.vertCount) throw new Error("This clip has out-of-range surface indices.");
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos.subarray(rec.vertOffset * 3, (rec.vertOffset + rec.vertCount) * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv.subarray(rec.vertOffset * 2, (rec.vertOffset + rec.vertCount) * 2), 2));
  g.setIndex(new THREE.BufferAttribute(idx.subarray(from, from + count), 1));
  return g;
}

const surfaceVS = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

// The environment is lit by the recording lens: inside its frustum at full
// strength, outside it a dim memory of what was seen earlier.
const lensVP = new THREE.Matrix4();
// shared with the soft side backdrop of a portrait clip (sideFill): past the frame the world dissolves into it, not into black
const sideU = { uSide: { value: null }, uSideOn: { value: 0 }, uSideRes: { value: new THREE.Vector2(1, 1) }, uSideFit: { value: new THREE.Vector4(1, 1, 0, 0) } };
const envFS = /* glsl */ `
  uniform sampler2D uMap, uSide, uBack, uSur;
  uniform float uBackOn, uSurOn;
  uniform vec2 uSurPad;
  uniform mat4 uLensVP;
  uniform float uLit, uSideOn;
  uniform vec2 uSideRes;
  uniform vec4 uSideFit;
  uniform float uAmbient, uCaptured, uStretch, uStripV;
  varying vec2 vUv;
  varying vec3 vWorld;
  // How many times larger one source texel is drawn here than through the recording lens (at the origin)
  float stretchHere() {
    vec3 nrm = normalize(cross(dFdx(vWorld), dFdy(vWorld)) + vec3(1e-12));
    vec3 toCam = cameraPosition - vWorld;
    float dNow = max(length(toCam), 1e-4), dLens = max(length(vWorld), 1e-4);
    float fNow = abs(dot(nrm, toCam)) / dNow, fLens = abs(dot(nrm, vWorld)) / dLens;
    return (fNow * dLens * dLens) / max(fLens * dNow * dNow, 1e-5);
  }
  // How unevenly it is drawn: the longest over the shortest stretch of a source pixel on screen. Through the lens a
  // pixel is drawn square (1); a surface the eye sees sheared draws it as a streak, which keeps its area, so the
  // stretch above misses it (the moose's near grass, combed sideways at the orbit's edge)
  float smearHere() {
    vec2 a = dFdx(vUv) * vec2(${meta.width.toFixed(1)}, ${meta.height.toFixed(1)}), b = dFdy(vUv) * vec2(${meta.width.toFixed(1)}, ${meta.height.toFixed(1)});
    float e = 0.5 * (dot(a, a) + dot(b, b)), det = abs(a.x * b.y - a.y * b.x);
    return sqrt((e + sqrt(max(e * e - det * det, 0.0))) / max(e - sqrt(max(e * e - det * det, 0.0)), 1e-12));
  }
  void main() {
    float surLit = -1.0;   // a surround's light, falling off across the continuation (below: uSurOn)
    if (uStretch > 0.5) {
      // A near blade of grass seen edge-on by the lens and face-on from the side is drawn tens of times larger: a
      // streak, not a surface. Past a few times (or drawn that unevenly) it dissolves, revealing the backdrop behind
      // it (screen-door, so there is no sorting).
      float stretch = stretchHere();
      // and by the parallax angle between the lens's ray and this camera's ray to the same point:
      // the near scene is what moves most between the two eyes, and what streaks first
      float parallax = degrees(acos(clamp(dot(normalize(vWorld), normalize(vWorld - cameraPosition)), -1.0, 1.0)));
      float keep = (1.0 - smoothstep(1.6, 3.0, stretch)) * (1.0 - smoothstep(2.5, 4.0, smearHere())) * (1.0 - smoothstep(22.0, 34.0, parallax));
      float thr = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (keep < thr) discard;
    }
    float sourceEdge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    if (uCaptured > 0.5 && sourceEdge <= 0.0) discard;
    float sourceAlpha = uCaptured > 0.5 ? smoothstep(0.0, 0.08, sourceEdge) : 1.0;
    vec3 c = texture2D(uMap, vUv).rgb;
    // The backdrop has its own picture (env/back.jpg): the plate with what stands in front of it inpainted
    // away. Through the lens the footage shows as recorded; as the eye leaves the lens, what the backdrop
    // shows behind a near bush becomes that inpainted background, not the bush's own colours smeared.
    if (uBackOn > 0.5) {
      float off = degrees(acos(clamp(dot(normalize(vWorld), normalize(vWorld - cameraPosition)), -1.0, 1.0)));
      // Seen from aside, the backdrop's slope from a near bank down to the water behind it is drawn many times larger
      // than through the lens, and the bank's grass streaked across it. There it shows its picture blurred: a soft band
      float blur = clamp(1.5 * log2(max(max(stretchHere(), smearHere() / 1.5), 1.0) / 1.4), 0.0, 5.0);
      c = mix(c, texture2D(uBack, vUv, blur).rgb, smoothstep(0.5, 3.0, off));
    }
    // the burnt-in data strip was painted over with a mirror of the picture above it: that is a
    // continuation for the eye, never a surface, so it fades to the page's black
    if (uStripV > 0.0) {
      // Through the lens the bar's own rows are dark, as the camera recorded them (a black strip), with a
      // soft edge: the mirror painted there read as a second, upside-down river under the real one. As the
      // eye leaves the lens, a tenth of the picture above them (which a bar often shades) dims too.
      float aside = degrees(acos(clamp(dot(normalize(vWorld), normalize(vWorld - cameraPosition)), -1.0, 1.0)));
      if (uSurOn > 0.5) {
        // a world with a surround has the strip's rows continued from the picture above them (env/surround.jpg):
        // dark through the lens, as recorded, and that continuation as the eye leaves it, not a black band
        vec3 s = texture2D(uSur, (vUv + uSurPad) / (1.0 + 2.0 * uSurPad)).rgb;
        c = mix(s * smoothstep(1.0, 6.0, aside), c, smoothstep(uStripV - 0.006, uStripV + 0.006, vUv.y));
      } else {
        c *= mix(smoothstep(uStripV - 0.006, uStripV + 0.006, vUv.y), smoothstep(uStripV, uStripV + 0.10, vUv.y), smoothstep(1.0, 6.0, aside));
      }
    }
    // past the frame the backdrop is a mirrored continuation: fade it out
    vec2 o = max(abs(vUv - 0.5) - 0.5, 0.0);
    // (a version 2 world ends in black, not in a cut: the page behind it is black)
    float fade = 1.0 - ${V2 ? "0.98" : "0.55"} * smoothstep(0.0, ${V2 ? "0.05" : "0.25"}, max(o.x, o.y));
    // a world whose picture the worker continued past the frame (env/surround.jpg, LaMa) shows that continuation
    // there, dimmed by the lens light below, fading out across it instead of cutting to black at the edge (a band
    // kept bright to its outer half read as a stone border round the grizzly's river)
    if (uSurOn > 0.5) {
      if (max(o.x, o.y) > 0.0) c = texture2D(uSur, (vUv + uSurPad) / (1.0 + 2.0 * uSurPad)).rgb;
      // how far across the continuation: from the frame's edge, or below a data strip from the strip's top line (the
      // strip's rows are continuation too: lit by their own rule, a dark band lay between the picture and the
      // surround under it)
      float r = max(o.x / uSurPad.x, max(max(vUv.y - 1.0, 0.0) / uSurPad.y, max(uStripV - vUv.y, 0.0) / (uSurPad.y + uStripV)));
      fade = 1.0 - 0.98 * smoothstep(0.0, 1.0, r);
      // lit from the frame's edge out, not by the lens frustum: that dropped to its ambient a few degrees past the
      // edge, and the continuation read as a black border, the void it is there to fill
      surLit = 1.0 - smoothstep(0.0, 1.0, r);
    }
    c *= fade;
    vec4 clip = uLensVP * vec4(vWorld, 1.0);
    vec2 ndc = clip.xy / max(clip.w, 1e-4);
    float edge = max(abs(ndc.x), abs(ndc.y));
    float lit = clip.w > 0.0 ? 1.0 - smoothstep(0.82, 1.08, edge) : 0.0;
    lit = mix(uAmbient, 1.0, lit * uLit + (1.0 - uLit));
    if (surLit >= 0.0) lit = mix(uAmbient, 1.0, surLit);
    vec3 col = c * lit;
    if (uSideOn > 0.5) col += texture2D(uSide, gl_FragCoord.xy / uSideRes * uSideFit.xy + uSideFit.zw).rgb * (1.0 - fade);
    gl_FragColor = vec4(col, sourceAlpha);
  }
`;
const envMaterial = (map, offset, ambient = 0.3, stretch = 0) => new THREE.ShaderMaterial({
  vertexShader: surfaceVS,
  fragmentShader: envFS,
  uniforms: { uMap: { value: map }, uBack: { value: null }, uBackOn: { value: 0 }, uSur: { value: null }, uSurOn: { value: 0 }, uSurPad: { value: new THREE.Vector2(0.25, 0.25) }, uLensVP: { value: lensVP }, uLit: { value: 1 }, uAmbient: { value: ambient }, uCaptured: { value: 0 }, uStretch: { value: stretch }, uStripV: { value: V2 && meta.overlay < 1 ? 1 - meta.overlay : 0 }, ...sideU },
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: offset ? 2 : 0,
  polygonOffsetUnits: offset,
});
// Layers, front to back (polygon-offset units): what a keyframe saw; what it
// only painted in over the subject; its frame plus a margin, whole. Any
// keyframe's real view beats every keyframe's guess, so the world is a
// mosaic of observations and the guesses show only where nothing saw.
const HOLE = 2000, PADDED = 4000;
const env = meta.env.flatMap((rec) => {
  const tex = texture(rec.live ? rec.live.plate : rec.tex);
  const holes = dedup ? 0 : rec.holeCount || 0;
  const parts = [[rec, rec.idxOffset, rec.idxCount - holes, 0]];
  if (holes) parts.push([rec, rec.idxOffset + rec.idxCount - holes, holes, HOLE]);
  if (soft) parts.push([rec, rec.idxOffset + rec.idxCount, rec.loseCount, 64]);
  if (rec.pad && !dedup) parts.push([rec.pad, rec.pad.idxOffset, rec.pad.idxCount, PADDED]);
  return parts.map(([src, from, count, base]) => {
    // overlapping keyframes: the nearest the present wins where they meet
    // (merged world: the voxel's best view wins, and redundant triangles sit behind)
    const m = new THREE.Mesh(surface(src, from, count), envMaterial(tex, base, 0.3, V2 && !base ? 1 : 0));
    m.userData.frame = rec.frame;
    m.userData.base = base;
    m.frustumCulled = false;
    environment.add(m);
    return m;
  });
});

// Fixed camera: the backdrop (make-stable.py) fills what the crisp surface
// left out and continues the frame past its edges, behind that surface.
const backdrop = meta.fill && meta.env.length === 1
  ? new THREE.Mesh(surface(meta.fill), envMaterial(env[0].material.uniforms.uMap.value, 4000, 0.3))
  : null;
if (backdrop && typeof meta.fill.tex === "string" && /^env\/[\w.-]+\.(jpg|png|webp)$/.test(meta.fill.tex)) {
  backdrop.material.uniforms.uBack.value = texture(meta.fill.tex);
  backdrop.material.uniforms.uBackOn.value = 1;
}
// Past the frame a version 2 world cut to black a few degrees off the lens. One with a surround (make-world.py: the
// picture continued by LaMa) shows that continuation there instead, dimmed by the lens light and fading out
const sur = surroundOf(meta);
if (backdrop && sur) {
  // the backdrop shows it past the frame; every environment layer takes the strip's rows from it
  const tex = texture(sur.tex);
  for (const m of [backdrop, ...env]) {
    m.material.uniforms.uSur.value = tex;
    m.material.uniforms.uSurPad.value.set(sur.pad[0], sur.pad[1]);
    m.material.uniforms.uSurOn.value = 1;
  }
}
if (backdrop) {
  backdrop.frustumCulled = false;
  environment.add(backdrop);
}

// Natural 4D tracing: original footage colours, with age shown only by opacity.
// No coloured contours, tint, or invented intermediate anatomy.
const subFS = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uPresent, uAge, uOpacity, uGhost, uLens;
  uniform vec3 uTint;
  uniform vec2 uTexel;
  uniform sampler2D uSrc;
  uniform mat4 uLensVP;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    if (uPresent > 0.5 && uLens > 0.5) {
      // The present animal is a sample (15 fps) of a 30 fps clip. Seen from the lens it is drawn from
      // the footage itself, projected through the recording lens (its matte grown by two texels: what
      // that lets in is true background, which the scene behind already is), and handed back to the
      // sample's own crop as the eye leaves the lens, where a projection would stretch.
      float ah = max(max(texture2D(uMap, vUv + vec2(uTexel.x * 2.0, 0.0)).a, texture2D(uMap, vUv - vec2(uTexel.x * 2.0, 0.0)).a),
                     max(texture2D(uMap, vUv + vec2(0.0, uTexel.y * 2.0)).a, texture2D(uMap, vUv - vec2(0.0, uTexel.y * 2.0)).a));
      float aside = degrees(acos(clamp(dot(normalize(vWorld), normalize(vWorld - cameraPosition)), -1.0, 1.0)));
      float k = 1.0 - smoothstep(0.5, 4.0, aside);
      vec4 clip = uLensVP * vec4(vWorld, 1.0);
      vec2 q = clip.xy / clip.w * 0.5 + 0.5;
      t.rgb = mix(t.rgb, texture2D(uSrc, q).rgb, k);
      t.a = mix(t.a, max(t.a, ah), k);
    }
    float edge = uPresent > 0.5 ? smoothstep(0.45, 0.6, t.a) : smoothstep(0.35, 0.7, t.a);
    float alpha = edge * uOpacity;
    if (alpha < 0.006) discard;
    vec3 c = t.rgb;
    // lit by the lens like the scene around it (envFS): near the frame's edge the scene dims toward its ambient,
    // and an animal drawn at full light there stood out, its matte's rim of bright sky with it
    vec4 lc = uLensVP * vec4(vWorld, 1.0);
    vec2 ln = lc.xy / max(lc.w, 1e-4);
    // (a world with a surround is lit to the frame's edge and past it: so is its animal)
    ${sur ? "" : "c *= mix(0.3, 1.0, lc.w > 0.0 ? 1.0 - smoothstep(0.82, 1.08, max(abs(ln.x), abs(ln.y))) : 0.0);"}
    if (uGhost > 0.5) {
      // still natural colour, but a trail must not read as another animal: less saturated, and a
      // faint tint per animal so three trails stay three trails
      c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), 0.6);
      c = mix(c, uTint, 0.12);
    }
    gl_FragColor = vec4(c, alpha);
  }
`;
// A shell's mesh exists only while the playhead is near it (version 2), so a minute of three animals
// costs what a few seconds do. Legacy shells are all built up front, as they always were.
function lazyTexture(file, onLoad) {
  const t = loader.load(`${BASE}${file}`, onLoad, undefined, () => {});
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}
const TINTS = [[0.45, 0.8, 1.0], [1.0, 0.7, 0.4], [0.8, 0.6, 1.0], [0.6, 1.0, 0.6]];
// Version 2 ghosts: a few poses per animal, spaced by how far it moved, over a short window. The most
// travelled animals get the trail; one standing still gets none.
const GHOST = { perTrack: 4, total: 8, seconds: 3, max: 0.6, min: 0.25, spacing: 0.3 };
const gridIndices = new Map();
function gridGeometry(rec) {
  const { gw, gh, box: [x0, y0, x1, y1], d: [lo, hi], off } = rec;
  const key = gw * 1000 + gh;
  if (!gridIndices.has(key)) {
    const index = new Uint32Array((gw - 1) * (gh - 1) * 6);
    let k = 0;
    for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) {
      const a = y * gw + x, b = a + 1, c = a + gw, d = c + 1;
      index.set([a, c, b, b, c, d], k); k += 6;
    }
    gridIndices.set(key, new THREE.BufferAttribute(index, 1));
  }
  const p = new Float32Array(gw * gh * 3), q = new Float32Array(gw * gh * 2);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const v = y * gw + x;
    const z = lo + (shellDepth[off + v] / 65535) * (hi - lo);
    const u = (x0 + ((x + 0.5) / gw) * (x1 - x0)) / meta.width, w = (y0 + ((y + 0.5) / gh) * (y1 - y0)) / meta.height;
    p[v * 3] = (u - 0.5) * 2 * meta.tanX * z;
    p[v * 3 + 1] = -(w - 0.5) * 2 * meta.tanY * z;
    p[v * 3 + 2] = -z;
    q[v * 2] = (x + 0.5) / gw;
    q[v * 2 + 1] = 1 - (y + 0.5) / gh;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(q, 2));
  g.setIndex(gridIndices.get(key));
  g.computeBoundingSphere();
  return g;
}
const shells = recs.map((rec) => ({ rec, i: rec.i, track: rec.track, mesh: null, ready: false, used: 0, centroid: new THREE.Vector3(...rec.centroid), foot: null }));
function build(s) {
  const rec = s.rec;
  const material = new THREE.ShaderMaterial({
    vertexShader: surfaceVS,
    fragmentShader: subFS,
    uniforms: { uMap: { value: null }, uPresent: { value: 0 }, uAge: { value: 0 }, uOpacity: { value: 1 }, uGhost: { value: 0 }, uLens: { value: 0 }, uSrc: { value: null }, uLensVP: { value: lensVP }, uTexel: { value: new THREE.Vector2(0.004, 0.004) }, uTint: { value: new THREE.Vector3(...TINTS[(s.track - 1) % TINTS.length]) } },
    side: THREE.DoubleSide,
    transparent: true,
  });
  const m = new THREE.Mesh(V2 ? gridGeometry(rec) : surface(rec), material);
  m.visible = false;
  m.userData.centroid = s.centroid;
  if (V2) {
    material.uniforms.uMap.value = lazyTexture(rec.tex, () => { s.ready = true; renderDirty = true; });
    m.frustumCulled = true;
  } else {
    material.uniforms.uMap.value = texture(rec.tex);
    s.ready = true;
    m.frustumCulled = false;
    m.userData.relief = regularisePositions(m.geometry.attributes.position.array, m.geometry.index.array, meta.cameras[s.i], rec.centroid);
    m.geometry.computeBoundingSphere();
    m.frustumCulled = true;
  }
  scene.add(m);
  s.mesh = m;
  return m;
}
function release(s) {
  scene.remove(s.mesh);
  s.mesh.geometry.dispose();
  s.mesh.material.uniforms.uMap.value?.dispose();
  s.mesh.material.dispose();
  s.mesh = null;
  s.ready = false;
}
if (!V2) shells.forEach(build);
// All observed frames remain available; the display uses a solid present
// and spatially anchored, time-fading poses instead of an all-frame smear.
// a pack's ghosts pile onto each other and smear it, so a herd starts without the trail (the button brings it back)
const trail = { on: !(V2 && meta.tier === "narrow") && new Set(recs.map((r) => r.track)).size < 8, flow: true };
$("#trailBtn").setAttribute("aria-pressed", String(trail.on));

// Each animal is a track: a faint neutral guide along where its feet were, and poses spaced along it.
const spansOf = new Map((meta.tracks || []).map((t) => [t.id, t.spans]));
const tracks = [...Map.groupBy(shells, (s) => s.track)].map(([id, list]) => ({ id, list: list.sort((a, b) => a.i - b.i), spans: spansOf.get(id) }));
for (const s of shells) {
  if (V2) { s.foot = new THREE.Vector3(...s.rec.foot); continue; }
  const p = s.mesh.geometry.attributes.position;
  let low = Infinity;
  for (let v = 0; v < p.count; v++) low = Math.min(low, p.getY(v));
  s.foot = new THREE.Vector3(s.centroid.x, low, s.centroid.z);
}
const trailSeconds = Math.min(DURATION + 0.1, 5.5);
// Poses per path: enough that every window of trailSeconds can show as many as a short clip does.
const POSE_LIMIT = Math.ceil(32 * Math.max(1, DURATION / trailSeconds));
const worldlines = [];
const flowKeys = new Set(), spacedKeys = new Set();
const bodyOf = (s, heading) => {
  if (!V2) {
    const b = new THREE.Box3().setFromBufferAttribute(s.mesh.geometry.attributes.position).getSize(new THREE.Vector3());
    return Math.abs(heading.x) * b.x + Math.abs(heading.y) * b.y + Math.abs(heading.z) * b.z;
  }
  const { box: [x0, y0, x1, y1], d } = s.rec, z = (d[0] + d[1]) / 2;
  const w = ((x1 - x0) / meta.width) * 2 * meta.tanX * z, h = ((y1 - y0) / meta.height) * 2 * meta.tanY * z;
  return Math.abs(heading.x) * w + Math.abs(heading.y) * h + Math.abs(heading.z) * 0.4 * w;
};
for (const tr of tracks) {
  const feet = tr.list;
  const smooth = feet.map((s, k) => {
    const w = feet.slice(Math.max(0, k - 4), k + 5);
    return w.reduce((a, s2) => a.add(s2.foot), new THREE.Vector3()).multiplyScalar(1 / w.length);
  });
  // How far apart poses and ghosts fall follows how far the animal actually went, so a slow
  // one is not buried under a pile of overlapping copies.
  const heading = smooth.at(-1).clone().sub(smooth[0]);
  heading.length() > 1e-6 ? heading.normalize() : heading.set(1, 0, 0);
  const reachAlong = feet.map((s) => bodyOf(s, heading)).sort((a, b) => a - b);
  const body = reachAlong[reachAlong.length >> 1];
  const points = smooth.map((p) => p.toArray());
  poseKeys(points, body, POSE_LIMIT, V2 ? GHOST.spacing : 0.16).forEach((k) => flowKeys.add(feet[k]));
  poseKeys(points, body).forEach((k) => spacedKeys.add(feet[k]));
  if (feet.length < 2) continue;
  // a thin line, drawn over everything: the ground it runs on is only approximately where the feet were
  const curve = new THREE.CatmullRomCurve3(smooth);
  const lineGeometry = new THREE.TubeGeometry(curve, Math.min(2400, Math.max(240, feet.length * 2)), Math.max(0.00035, body * 0.006), 6, false);
  const lineFrames = new Float32Array(lineGeometry.attributes.position.count);
  for (let v = 0; v < lineFrames.length; v++) {
    // Tube UVs use arc length, not observation time. Map them back to source
    // frame indices so changing speed and missing observations stay truthful.
    const sample = curve.getUtoTmapping(lineGeometry.attributes.uv.getX(v)) * (feet.length - 1);
    const i = Math.min(feet.length - 2, Math.floor(sample));
    lineFrames[v] = THREE.MathUtils.lerp(feet[i].i, feet[i + 1].i, sample - i);
  }
  lineGeometry.setAttribute("aFrame", new THREE.BufferAttribute(lineFrames, 1));
  const worldline = new THREE.Mesh(
    lineGeometry,
    new THREE.ShaderMaterial({
      uniforms: { uNow: { value: 0 }, uTotal: { value: N - 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aFrame;
        varying float vFrame;
        void main() { vFrame = aFrame; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uNow, uTotal;
        varying float vFrame;
        void main() {
          float age = uNow - vFrame;
          if (age < 0.0) discard;
          float fading = clamp(age / max(uTotal, 1.0), 0.0, 1.0);
          gl_FragColor = vec4(vec3(0.32, 0.29, 0.25), mix(0.14, 0.04, fading));
        }
      `,
    })
  );
  worldline.frustumCulled = false;
  worldline.renderOrder = 8e4 + 2; // after splats/contact cue, before history and present
  scene.add(worldline);
  worldlines.push(worldline);
}
let keys = flowKeys;
$("#trailStyle").addEventListener("change", e => {
  trail.flow = e.target.value === "flow";
  keys = trail.flow ? flowKeys : spacedKeys;
  renderDirty = true;
});

// dust: a sprinkle of the environment's own vertices as faint white specks,
// so the dark outside the lens still reads as space
{
  const env0 = meta.env[0].vertOffset, envEnd = meta.env.at(-1).vertOffset + meta.env.at(-1).vertCount;
  const specks = [];
  for (let v = env0; v < envEnd; v += 37) specks.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(specks, 3));
  const dust = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.045, depthWrite: false }));
  dust.frustumCulled = false;
  environment.add(dust);
}

// ── The recording camera ─────────────────────────────────────────────────

const poses = meta.cameras.map((a) => {
  const m = new THREE.Matrix4().fromArray(a);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { p, q };
});
function poseAt(f, outP, outQ) {
  const i = Math.min(N - 2, Math.max(0, Math.floor(f)));
  const k = Math.min(1, Math.max(0, f - i));
  outP.lerpVectors(poses[i].p, poses[i + 1].p, k);
  outQ.slerpQuaternions(poses[i].q, poses[i + 1].q, k);
}

const rig = new THREE.Group();
scene.add(rig);
const path = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(poses.map((p) => p.p)),
  new THREE.LineBasicMaterial({ color: 0x6ff3ff, transparent: true, opacity: 0.45 })
);
rig.add(path);

// a frustum with the live source frame on its image plane
const aspect = meta.width / meta.height;
const FD = 0.09;
const fh = Math.tan(THREE.MathUtils.degToRad(meta.fovY / 2)) * FD;
const fw = fh * aspect;
const corners = [[-fw, fh], [fw, fh], [fw, -fh], [-fw, -fh]].map(([x, y]) => new THREE.Vector3(x, y, -FD));
const lensLines = [];
corners.forEach((c, i) => lensLines.push(new THREE.Vector3(), c, c, corners[(i + 1) % 4]));
const frustum = new THREE.Group();
frustum.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lensLines), new THREE.LineBasicMaterial({ color: 0x6ff3ff })));
const video = $("#clip");
for (const event of ["loadeddata", "seeked"]) video.addEventListener(event, () => { renderDirty = true; });
video.addEventListener("error", () => { $("#status").textContent = "Source preview unavailable · reconstructed poses still available"; });
if (clipBlob) video.src = URL.createObjectURL(clipBlob);
// The time of the frame the video texture actually holds. currentTime runs ahead of it after a seek,
// and a projection painted from some other moment's frame would put the wrong animal on the shell.
let srcFrameTime = -1;
if ("requestVideoFrameCallback" in video) {
  const onFrame = (_now, info) => { srcFrameTime = info.mediaTime; video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
}
const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.NoColorSpace;
const pane = new THREE.Mesh(new THREE.PlaneGeometry(fw * 2, fh * 2), new THREE.MeshBasicMaterial({ map: videoTex, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
pane.position.z = -FD;
frustum.add(pane);
// a shipped example has no source clip: no picture for the lens's pane or the inset
if (SEED) { pane.visible = false; $(".inset").hidden = true; }
rig.add(frustum);

// Past the picture's edge (most of a window, for a portrait clip) the view would be black. Behind the scene sits a dimmed, blurred,
// cover-fitted copy of the playing frame, like the soft sides of a phone video on a wide screen.
// (embedded, only the capture tools load the source clip: they get the page's look)
const sideFill = environment === scene && (!EMBED || clipBlob) ? (() => {
  const c = document.createElement("canvas");
  c.width = 64; c.height = Math.round(64 / aspect);
  const g = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  scene.background = tex;
  sideU.uSide.value = tex;
  sideU.uSideOn.value = 1;
  let last = -1;
  return {
    fit() {
      const k = Math.min(1, aspect / (innerWidth / innerHeight));
      tex.repeat.set(1, k);
      tex.offset.set(0, (1 - k) / 2);
      sideU.uSideRes.value.set(innerWidth, innerHeight).multiplyScalar(renderer.getPixelRatio());
      sideU.uSideFit.value.set(1, k, 0, (1 - k) / 2);
    },
    update() {
      if (video.readyState < 2 || video.currentTime === last) return;
      last = video.currentTime;
      g.filter = "blur(3px)";
      g.drawImage(video, -6, -6, c.width + 12, c.height + 12);
      g.filter = "none";
      g.fillStyle = "rgba(2, 3, 4, 0.5)";
      g.fillRect(0, 0, c.width, c.height);
      tex.needsUpdate = true;
    },
  };
})() : null;

// A fixed camera's world is one surface seen from the lens, so the footage maps
// onto it 1:1: it plays there (subject painted out, backend/tools/make-env-video.py)
// instead of a still median, which turns anything that moves, water above all,
// to mush. The still shows until the video is ready.
let liveVideo = null;
const live = meta.env[0].live;
// While the live video seeks a long way (the loop's wrap, a scrub), its texture still holds the frame it left, and
// the painted-out patch of that other moment showed as a pale ghost for a frame or two. Until the frame the video
// presents (three takes its picture then) is this moment's, to half a second, the still stands in. ("seeked" alone
// came before or after that presentation, either way round.)
const liveMaps = { still: null, video: null, frameTime: -1 };
const liveMap = (t) => { env[0].material.uniforms.uMap.value = t; if (backdrop) backdrop.material.uniforms.uMap.value = t; renderDirty = true; };
if (live && env.length === 1) {
  liveVideo = document.createElement("video");
  liveVideo.muted = liveVideo.playsInline = true;
  liveVideo.addEventListener("seeked", () => { renderDirty = true; });
  liveVideo.addEventListener("error", () => { $("#status").textContent = "Live background unavailable · showing the baked still"; });
  get(BASE + live.video).then((r) => r.blob()).then((b) => {
    liveVideo.src = URL.createObjectURL(b);
    liveVideo.addEventListener("loadeddata", () => {
      const t = new THREE.VideoTexture(liveVideo);
      t.colorSpace = THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      liveMaps.still = env[0].material.uniforms.uMap.value;
      liveMaps.video = t;
      liveMap(t);
      if ("requestVideoFrameCallback" in liveVideo) {
        const shown = (_now, frame) => { liveMaps.frameTime = frame.mediaTime; renderDirty = true; liveVideo.requestVideoFrameCallback(shown); };
        liveVideo.requestVideoFrameCallback(shown);
      }
    }, { once: true });
  }).catch(() => { $("#status").textContent = "Live background unavailable · showing the baked still"; });
}

// ── Framing ──────────────────────────────────────────────────────────────

const centroids = frames.filter((f) => f.centroid).map((f) => new THREE.Vector3(...f.centroid));
const centroid = centroids.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(1 / centroids.length);
const middle = lensView ? new THREE.Vector3(0, 0, centroid.z) : centroid;
const travel = centroids[centroids.length - 1].clone().sub(centroids[0]);
const up = new THREE.Vector3(0, 1, 0);
// Sized by the walk and by how far off the lens it happened, so a short
// amble far from a fixed camera is still framed whole
const reach = Math.max(travel.length(), meta.motion.distStart * 1.1, 0.4);
// Half the frame's width at its nearest ground (10th percentile of the first surface's depth).
// A hand-built clip (grizzly, horse, walker) has no such surfaces; 1 means "no cap" there.
const nearHalf = (() => {
  const r = meta.env[0], z = [];
  for (let i = 0; i < r.vertCount; i += 7) z.push(-pos[(r.vertOffset + i) * 3 + 2]);
  z.sort((a, b) => a - b);
  const half = meta.tanX * Math.max(z[Math.floor(z.length * 0.1)] || 1, 0.05);
  return Number.isFinite(half) && half > 0 ? half : 1;
})();
// 1 for an ordinary frame, falling toward 0 for a narrow phone frame of a deep scene (a wolf pack: pack in front,
// trees far behind). Such a scene smears under depth-of-field blur and shears to a shard when the eye swings wide.
const narrow = nearHalf > 0 ? Math.min(1, nearHalf / 0.16) : 1;
const dofGain = narrow ** 2;
// A fixed camera only ever saw the scene from one place, so its rebuilt
// surfaces (and the subject's per-frame shells) look worst edge-on, away
// from that one viewpoint. Cap how far the resting eye swings off the lens's
// own axis to the subject instead of placing it freely to the side.
const sideEye = (() => {
  const source = poses[Math.floor(N / 2)].p;
  const axis = source.clone().sub(middle);
  // The generated park supports a wider resting view. Keep the whole long
  // approach in frame instead of letting the final walker pose cross the eye.
  const parkView = CLIP === "walker" && params.get("world") !== "original";
  const distance = lensView ? axis.length() : Math.max(axis.length(), reach * (parkView ? 1.05 : 0.65));
  if (axis.lengthSq() < 1e-8) axis.set(0, 0, 1);
  // Bear and horse read best close to the recording direction: larger natural
  // poses, less exposed shell thickness. Keep the approved scene pivot fixed.
  const captureView = (["grizzly", "horse"].includes(CLIP) && environment !== scene) || lensView;
  // The eye may leave the lens axis only by a share of what the frame covers at its nearest ground, or
  // the rebuilt scene of a narrow phone clip shears to a shard in the dark.
  const rest = captureView ? 6 : meta.fixed || parkView ? 12 : 18;
  const sway = Math.asin(Math.min(1, 0.3 * nearHalf / Math.max(axis.length(), 1e-4)));
  axis.normalize().applyAxisAngle(up, Math.min(THREE.MathUtils.degToRad(rest), sway));
  return middle.clone().addScaledVector(axis, distance).addScaledVector(up, reach * (captureView ? 0.025 : 0.06));
})();

// Stay near the recording direction, not the unobserved side/back of the shells.
// This window is fixed for the clip; playback must never move the orbit limits.
const sourceOffset = poses[Math.floor(N / 2)].p.clone().sub(middle);
if (sourceOffset.lengthSq() < 1e-8) sourceOffset.set(0, 0, 1);
const sourceView = new THREE.Spherical().setFromVector3(sourceOffset);
const yawLimit = Math.min(THREE.MathUtils.degToRad(V2 && meta.yawLimit ? meta.yawLimit : 20), Math.asin(Math.min(1, 1.5 * narrow ** 1.5 * nearHalf / Math.max(sourceOffset.length(), 1e-4))));
const restingView = new THREE.Spherical().setFromVector3(sideEye.clone().sub(middle));
controls.minAzimuthAngle = sourceView.theta - yawLimit;
controls.maxAzimuthAngle = sourceView.theta + yawLimit;
// Keep tilt near the approved height; a broad downward range exposes the
// underside of the captured river/ground sheets even without a side-on turn.
controls.minPolarAngle = Math.max(0.001, restingView.phi - THREE.MathUtils.degToRad(6));
controls.maxPolarAngle = Math.min(Math.PI - 0.001, restingView.phi + THREE.MathUtils.degToRad(1.5));
const viewOffset = new THREE.Vector3(), boundedView = new THREE.Spherical();
function limitViewingAngle(position) {
  boundedView.setFromVector3(viewOffset.copy(position).sub(middle));
  const turn = Math.atan2(Math.sin(boundedView.theta - sourceView.theta), Math.cos(boundedView.theta - sourceView.theta));
  boundedView.theta = sourceView.theta + THREE.MathUtils.clamp(turn, -yawLimit, yawLimit);
  boundedView.phi = THREE.MathUtils.clamp(boundedView.phi, controls.minPolarAngle, controls.maxPolarAngle);
  position.copy(middle).add(viewOffset.setFromSpherical(boundedView));
}

// Embedded in the tesseract, the host's pointer moves the eye inside this same
// bounded window (limitViewingAngle): never past the angle caps, never the pivot.
const embedLook = { x: 0, y: 0, applied: "" };
function applyEmbedLook() {
  if (!EMBED || mode !== "orbit") return;
  const key = `${embedLook.x.toFixed(4)},${embedLook.y.toFixed(4)}`;
  if (embedLook.applied === key) return;
  embedLook.applied = key;
  boundedView.set(restingView.radius, restingView.phi - embedLook.y * THREE.MathUtils.degToRad(6), restingView.theta + embedLook.x * yawLimit);
  camera.position.copy(middle).add(viewOffset.setFromSpherical(boundedView));
  limitViewingAngle(camera.position);
  camera.lookAt(middle);
  renderDirty = true;
}

// ── Motion verdict ───────────────────────────────────────────────────────

{
  const m = meta.motion;
  const ratio = m.distEnd / m.distStart;
  const q0 = poses[0].q;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q0);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q0);
  const lateral = new THREE.Vector3(...m.travel).dot(right);
  const camFwd = new THREE.Vector3(...m.cameraTravel).dot(fwd);
  const camSide = new THREE.Vector3(...m.cameraTravel).dot(right);
  const toward = ratio < 0.9 ? "<b>TOWARD THE CAMERA</b>" : ratio > 1.1 ? "<b>AWAY FROM THE CAMERA</b>" : "<b>ACROSS THE FRAME</b>";
  const leftRight = Math.abs(lateral) > 0.15 * m.distStart ? (lateral > 0 ? " · rightward" : " · leftward") : "";
  const camMoved = !meta.fixed;
  if (!PRODUCT) $("#blurb").textContent = `${meta.concept} · ${camMoved ? "moving camera" : "fixed camera"} · recorded moments, held in space`;
  $("#caption").textContent = PRODUCT ? "the original clip" : `source · ${camMoved ? "handheld, camera moving" : "fixed camera"}`;
  const camWords = !camMoved ? "fixed" : Math.abs(camFwd) > Math.abs(camSide) ? (camFwd < 0 ? "dollying back" : "pushing in") : camSide > 0 ? "trucking right" : "trucking left";
  $("#motion").innerHTML =
    `subject  ${toward}${leftRight}\n` +
    `distance to lens  ${m.distStart.toFixed(2)} → ${m.distEnd.toFixed(2)} (×${ratio.toFixed(2)})\n` +
    `camera  ${camWords}, ${new THREE.Vector3(...m.cameraTravel).length().toFixed(2)} u\n` +
    `world  held still: ${meta.env.length} keyframe surfaces` +
    (dedup ? `
merged  ${dedup.tris[1].toLocaleString()} of ${dedup.tris[0].toLocaleString()} triangles ${soft ? "in front" : "kept"}` : "");
}

// ── Time ─────────────────────────────────────────────────────────────────
// One clock for everything. Scroll runs it either way at the speed you scroll;
// let go and it settles back to playing forward (or holds, when paused).

const clock = { t: 0, rate: reducedMotion.matches || EMBED ? 0 : 1, push: 0, playing: !reducedMotion.matches && !EMBED };
const frameAt = t => timeFrame(times, t);
const bar = $("#bar");
bar.max = DURATION;
let scrubbing = false;
function setPlaying(playing) {
  renderDirty = true;
  clock.playing = playing;
  clock.push = 0;
  if (!playing) clock.rate = 0;
  $("#playBtn").textContent = playing ? "Pause" : "Play";
  $("#playBtn").setAttribute("aria-label", playing ? "Pause recording" : "Play recording");
}
function seek(t) {
  clock.t = Math.min(DURATION, Math.max(0, t));
  clock.push = clock.rate = 0;
}
function stepFrame(direction) {
  setPlaying(false);
  const f = frameAt(Math.min(clock.t, DURATION));
  const next = Math.max(0, Math.min(N - 1, direction > 0 ? Math.floor(f + 1e-6) + 1 : Math.ceil(f - 1e-6) - 1));
  seek(times[next] - T0);
}
$("#playBtn").addEventListener("click", () => setPlaying(!clock.playing));
$("#prevBtn").addEventListener("click", () => stepFrame(-1));
$("#nextBtn").addEventListener("click", () => stepFrame(1));
bar.addEventListener("pointerdown", () => { scrubbing = true; });
addEventListener("pointerup", () => { scrubbing = false; });
bar.addEventListener("pointercancel", () => { scrubbing = false; });
bar.addEventListener("input", () => seek(Number(bar.value)));
bar.addEventListener("keydown", e => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) setPlaying(false);
});
bar.addEventListener("change", () => { scrubbing = false; });
setPlaying(clock.playing);
const tickStep = DURATION <= 5 ? 1 : DURATION <= 15 ? 2 : 5;
for (let s = 0; s <= DURATION + 0.001; s += tickStep) {
  const el = document.createElement("span");
  el.style.left = `${(s / DURATION) * 100}%`;
  el.textContent = timeLabel(s).slice(0, 5);
  $("#ticks").append(el);
}
addEventListener("wheel", (e) => {
  if (e.target.closest?.(".modes, .hud, .inset")) return;
  e.preventDefault();
  const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  clock.push = THREE.MathUtils.clamp(clock.push - pixels * 0.004, -4, 4);
}, { passive: false });

// ── Cameras ──────────────────────────────────────────────────────────────

// Start anchored to the scene; playback moves the recording, not the viewing camera.
let mode = "orbit";
let cinematicTime = 0;
function setMode(next, keepView = false) {
  renderDirty = true;
  mode = next;
  cinematicTime = 0;
  document.querySelectorAll("[data-cam]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cam === mode)));
  if (mode === "orbit") {
    // Flush residual drag damping, restore the fixed pivot and clamp immediately.
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.target.copy(middle);
    if (!keepView) camera.position.copy(sideEye);
    camera.lookAt(middle);
    controls.update();
    controls.enableDamping = damping;
  }
}
document.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.cam)));
controls.addEventListener("start", () => {
  if (mode !== "orbit") {
    setMode("orbit", true);
  }
});
$("#resetBtn").addEventListener("click", () => setMode("orbit"));
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) { setPlaying(false); setMode("orbit"); }
});

const toggle = (id, on) => {
  const b = $(id);
  b.addEventListener("click", () => {
    const next = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(next));
    on(next);
    renderDirty = true;
  });
};
toggle("#trailBtn", (v) => { trail.on = v; });
toggle("#rigBtn", (v) => { rig.visible = v; });

addEventListener("keydown", (e) => {
  if (e.target.closest?.("button, input, select, textarea, a, [contenteditable]")) return;
  if (e.code === "Space") { e.preventDefault(); setPlaying(!clock.playing); }
  else if (e.key === "1") setMode("cinematic");
  else if (e.key === "2") setMode("recorded");
  else if (e.key === "3") setMode("orbit");
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); stepFrame(e.key === "ArrowRight" ? 1 : -1); }
});

// ── Frame ────────────────────────────────────────────────────────────────

// ── Lens blur ────────────────────────────────────────────────────────────
// Depth of field focused on the walker now: the ghosts and the world fall
// out of focus with distance from her, so the rebuilt scene's torn edges go
// soft, the way a long lens renders the reference.
const target = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: {
    tColor: { value: target.texture }, tDepth: { value: target.depthTexture },
    uNear: { value: camera.near }, uFar: { value: camera.far },
    uFocus: { value: 1 }, uAperture: { value: 0 }, uTexel: { value: new THREE.Vector2() },
  },
  depthTest: false,
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tColor, tDepth;
    uniform float uNear, uFar, uFocus, uAperture;
    uniform vec2 uTexel;
    varying vec2 vUv;
    float viewZ(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
    // blur radius in pixels for a point at distance z
    float coc(float z) { return min(14.0, abs(z - uFocus) / max(z, 1e-3) * uAperture); }
    void main() {
      float r = coc(viewZ(vUv));
      vec3 sum = texture2D(tColor, vUv).rgb;
      float n = 1.0;
      if (r > 0.5) {
        for (int k = 1; k < 32; k++) {
          float fk = float(k);
          vec2 o = vec2(cos(fk * 2.39996), sin(fk * 2.39996)) * sqrt(fk / 32.0) * r;
          vec2 uv = vUv + o * uTexel;
          // a sharp neighbour in front stays out of a blurry pixel's average
          float w = step(coc(viewZ(uv)), r) * 0.85 + 0.15;
          sum += texture2D(tColor, uv).rgb * w;
          n += w;
        }
      }
      gl_FragColor = vec4(sum / n, 1.0);
    }
  `,
}));
const postScene = new THREE.Scene();
postScene.add(post);
const postCamera = new THREE.Camera();

// what the timeline panel covers of the page's bottom, halved (the orbit's lift); none when embedded, and none for a
// world with no surround: lifted, its frame's bottom cut showed above the panel, where the panel had hidden it
const hud = document.querySelector(".hud");
let viewLift = 0, appliedLift = -1;
function measureLift() {
  const r = !EMBED && hud && sur && backdrop ? hud.getBoundingClientRect() : null;
  viewLift = r && r.height > 0 && r.top < innerHeight ? Math.round((innerHeight - r.top) / 2) : 0;
}
if (hud && !EMBED && sur && backdrop && "ResizeObserver" in window) new ResizeObserver(() => { measureLift(); renderDirty = true; }).observe(hud);
function resize() {
  renderDirty = true;
  measureLift();
  appliedLift = -1;
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  const pr = renderer.getPixelRatio();
  target.setSize(innerWidth * pr, innerHeight * pr);
  post.material.uniforms.uTexel.value.set(1 / (innerWidth * pr), 1 / (innerHeight * pr));
  sideFill?.fit();
}
addEventListener("resize", resize);
resize();

const eye = new THREE.Vector3(), look = new THREE.Vector3();
const lensP = new THREE.Vector3(), lensQ = new THREE.Quaternion();
const fwd = new THREE.Vector3();
let last = performance.now();
let lastSeek = 0;
let previousTime = null;
let focusAt = null;
const lens = new THREE.PerspectiveCamera(meta.fovY, meta.width / meta.height, 0.01, 100);

function loop(now) {
  requestAnimationFrame(loop);
  tick(now);
}

// One frame of the scene. Returns true when it submitted a render. Embedded, the host
// page calls this itself (window.__stable.frame) so it can copy the canvas in the same
// task as the draw, instead of this page running a second animation-frame loop.
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // time: scrolling pushes the rate, which relaxes back to the resting rate
  const rest = clock.playing ? 1 : 0;
  clock.push *= Math.exp(-dt * 3);
  clock.rate += (rest + clock.push - clock.rate) * Math.min(1, dt * 8);
  if (!rest && Math.abs(clock.push) < 0.003 && Math.abs(clock.rate) < 0.003) clock.push = clock.rate = 0;
  if (!scrubbing) clock.t += clock.rate * dt;
  if (clock.playing && clock.t > DURATION + 1.2) clock.t = 0; // brief hold, then loop
  if (clock.t < 0) clock.t = 0;
  const t = Math.min(clock.t, DURATION);
  const f = frameAt(t);
  applyEmbedLook();
  let controlsUpdated = false;
  const idle = !clock.playing && Math.abs(clock.rate) < 0.003 && !scrubbing && t === previousTime;
  if (idle && !renderDirty) {
    if (mode === "orbit") { controls.update(); controlsUpdated = true; }
    if (!renderDirty) return false; // Keep RAF input handling, but stop submitting an unchanged scene.
  }
  previousTime = t;

  poseAt(f, lensP, lensQ);
  lens.position.copy(lensP);
  lens.quaternion.copy(lensQ);
  lens.updateMatrixWorld();
  lensVP.multiplyMatrices(lens.projectionMatrix, lens.matrixWorldInverse);

  // Rank observations by the observer, not the playback clock. In a fixed
  // free-orbit view the world no longer swaps keyframe priority as time runs.
  if (!dedup) [...env].sort((a, b) => {
    const score = m => poses[m.userData.frame].p.distanceToSquared(camera.position) + 0.15 * poses[m.userData.frame].q.angleTo(camera.quaternion);
    return score(a) - score(b);
  }).forEach((m, rank) => {
    m.material.polygonOffsetFactor = (m.userData.base ? 2 : 0) + rank * 0.5;
    m.material.polygonOffsetUnits = m.userData.base + rank * 8;
  });

  // The nearest observed pose of each animal is solid; history stays anchored in space.
  const nowFrame = Math.round(f);
  worldlines.forEach((line) => { line.material.uniforms.uNow.value = f; line.visible = trail.on; });
  const present = new Set();
  for (const tr of tracks) {
    // the shell at this moment, else the nearest within two samples (a mask lost for a frame)
    let best = null;
    const reach = tr.spans ? (tr.spans.some(([a, b]) => nowFrame >= a - 1 && nowFrame <= b + 1) ? Infinity : -1) : 2;
    for (const s of tr.list) if (Math.abs(s.i - nowFrame) <= reach && (!best || Math.abs(s.i - nowFrame) < Math.abs(best.i - nowFrame))) best = s;
    if (best && V2 && !best.ready) {
      // its picture has not arrived yet: hold the nearest one that has
      for (const s of tr.list) if (s.ready && Math.abs(s.i - nowFrame) <= 6 && (!best.ready || Math.abs(s.i - nowFrame) < Math.abs(best.i - nowFrame))) best = s;
    }
    if (best) present.add(best);
  }
  focusAt = null;
  for (const s of present) focusAt = focusAt ? focusAt.clone().add(s.centroid) : s.centroid.clone();
  if (focusAt) focusAt.multiplyScalar(1 / present.size);
  const ghosts = new Set();
  if (V2 && trail.on) {
    const picks = [];
    // A trail reads as a trail only where the animal has moved on: a ghost on top of the present pose, or
    // on top of another ghost, is a smudge. Boxes are the shells' own footprints in the lens image.
    const overlap = (a, b) => {
      const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      return w > 0 && h > 0 ? (w * h) / ((a[2] - a[0]) * (a[3] - a[1])) : 0;
    };
    for (const tr of tracks) {
      const now = [...present].filter((p) => p.track === tr.id);
      const kept = [];
      for (const g of tr.list.filter((s) => keys.has(s) && T0 + t - times[s.i] > 0 && T0 + t - times[s.i] < GHOST.seconds).reverse()) {
        if (now.some((p) => overlap(g.rec.box, p.rec.box) > 0.15)) continue;
        if (kept.some((k) => overlap(g.rec.box, k.rec.box) > 0.3)) continue;
        kept.push(g);
        if (kept.length >= GHOST.perTrack) break;
      }
      const recent = kept.reverse();
      if (recent.length) picks.push({ recent, travelled: recent[0].foot.distanceTo(now[0]?.foot ?? recent.at(-1).foot) });
    }
    let room = GHOST.total;
    for (const pick of picks.sort((a, b) => b.travelled - a.travelled)) {
      if (room <= 0) break;
      if (pick.travelled <= 0) continue;
      pick.recent.slice(-room).forEach((s) => ghosts.add(s));
      room -= pick.recent.length;
    }
  }
  for (const s of shells) {
    const isPresent = present.has(s);
    const secondsAgo = T0 + t - times[s.i];
    // Do not crossfade unrelated shell topology: two half-transparent bodies
    // make the present look hollow. Show the nearest actual observation solid.
    const wanted = isPresent || (V2 ? ghosts.has(s) : trail.on && keys.has(s) && secondsAgo > 0 && secondsAgo < trailSeconds);
    if (V2) {
      if (wanted || (s.i - f > -1 && s.i - f < 8)) { s.used = now; if (!s.mesh) build(s); }
      else if (s.mesh && now - s.used > 2500) release(s);
    }
    const m = s.mesh;
    if (!m) continue;
    m.visible = wanted && s.ready;
    if (!m.visible) continue;
    const age = Math.max(0, Math.min(1, secondsAgo / (V2 ? GHOST.seconds : trailSeconds)));
    // anchored to fixed frames: counted back from now, the solid poses
    // would hop to new frames every step and look like they move
    const key = keys.has(s);
    const u = m.material.uniforms;
    u.uPresent.value = isPresent ? 1 : 0;
    u.uAge.value = age;
    u.uGhost.value = V2 && !isPresent ? 1 : 0;
    if (V2) {
      u.uSrc.value = videoTex;
      // only while the source frame shown is the frame for this moment: a video still seeking (a long
      // 1080p clip, a fast scrub) would paint the animal with some other moment's picture
      const sourceReady = clipBlob && video.readyState >= 2 && !video.seeking && Math.abs((srcFrameTime >= 0 ? srcFrameTime : video.currentTime) - (T0 + t)) < (video.paused ? 0.06 : 0.25);
      u.uLens.value = isPresent && sourceReady ? 1 : 0;
      const img = u.uMap.value?.image;
      if (img?.width) u.uTexel.value.set(1 / img.width, 1 / img.height);
    }
    u.uOpacity.value = isPresent ? 1 : V2
      ? (GHOST.max + (GHOST.min - GHOST.max) * age) * THREE.MathUtils.smoothstep(secondsAgo, 0, 0.13)
      : (trail.flow ? 0.32 : 0.5) * Math.pow(1 - age, 1.35) * THREE.MathUtils.smoothstep(secondsAgo, 0, trail.flow ? 0.13 : 0.3);
    // Only the nearest present frame writes depth: translucent history must
    // not punch holes in other poses or in the focus buffer.
    m.material.depthWrite = isPresent;
    // Dense history is a temporal illustration, not hidden behind uncertain
    // background reconstruction. The real present retains normal depth tests.
    m.material.depthTest = isPresent || V2 || !trail.flow;
    m.material.depthWrite = isPresent || !V2;      // a ghost never hides what is behind it, nor another ghost
    // the smear first, then the solid poses over it, then the present; each
    // group back to front
    const d = camera.position.distanceTo(s.centroid);
    m.renderOrder = isPresent ? 1e6 : key ? 1e5 - d : -d;
  }
  frustum.position.copy(lensP);
  frustum.quaternion.copy(lensQ);
  fwd.set(0, 0, -1).applyQuaternion(lensQ);

  // the source clip follows the clock; it plays itself only at plain 1×
  const want = T0 + t;
  if (!clipBlob) { /* embedded: no source clip */ }
  else if (!scrubbing && clock.playing && Math.abs(clock.rate - 1) < 0.05 && clock.t < DURATION) {
    if (video.paused) video.play().catch(() => {});
    if (Math.abs(video.currentTime - want) > 0.2) video.currentTime = want;
  } else {
    if (!video.paused) video.pause();
    if (now - lastSeek > 80 && Math.abs(video.currentTime - want) > 0.03) { video.currentTime = want; lastSeek = now; }
  }

  if (liveVideo?.readyState >= 2) {
    if (!video.paused && liveVideo.paused) liveVideo.play().catch(() => {});
    if (video.paused && !liveVideo.paused) liveVideo.pause();
    if (Math.abs(liveVideo.currentTime - t) > (video.paused ? 0.03 : 0.2)) liveVideo.currentTime = t;
    if (liveMaps.video && liveMaps.frameTime >= 0) {
      const want = Math.abs(liveMaps.frameTime - t) < 0.5 ? liveMaps.video : liveMaps.still;
      if (env[0].material.uniforms.uMap.value !== want) liveMap(want);
    }
  }

  const here = frames[Math.round(f)].centroid ? new THREE.Vector3(...frames[Math.round(f)].centroid) : middle;
  // the lens's own field of view only when looking through it; otherwise a
  // normal lens, since a trail camera's narrow one crops the scene too tight
  const embedFov = EMBED ? Number(params.get("fov")) : 0;
  // (a fixed camera's world: a little wider than its lens. 1.28 times showed a fifth of the view past the frame,
  // which a world with a surround fills only dimly: there the picture fills the view, and the orbit uncovers the rest)
  const restingFov = embedFov > 0 ? embedFov : lensView ? meta.fovY * (sur ? 1.06 : 1.28) : Math.max(meta.fovY, world?.captured || (world && CLIP === "horse" && camera.aspect >= 1) ? 36 : 50);
  // Portrait must not narrow the horizontal view enough to lose the approach.
  // Keep the same minimum angle on the shorter axis; recorded projection stays exact.
  const observerFov = world ? THREE.MathUtils.radToDeg(2 * Math.atan(
    Math.tan(THREE.MathUtils.degToRad(restingFov / 2)) / Math.min(camera.aspect, 1))) : restingFov;
  const fov = mode === "recorded" ? meta.fovY : world ? Math.min(110, observerFov)
    : lensView && !(embedFov > 0) ? portraitFov(restingFov, camera.aspect) : restingFov;
  if (mode !== "cinematic" && camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  if (mode === "recorded") {
    // exactly where the phone was: the world lines up with the footage, and
    // only the walker's past selves give away that this is not the video
    camera.position.copy(lensP);
    camera.quaternion.copy(lensQ);
    rig.visible = false;
  } else if (mode === "cinematic") {
    // swing from the lens out to the side of the walk and back, slowly
    if (!reducedMotion.matches && clock.playing && !scrubbing) cinematicTime += dt;
    const s = reducedMotion.matches ? 0 : 0.5 - 0.5 * Math.cos(cinematicTime * 0.16);
    const drift = reducedMotion.matches ? 0 : Math.sin(cinematicTime * 0.1) * 0.06;
    // starts exactly on the source view, then widens as it swings away
    const e = s * s * (3 - 2 * s);
    const fovNow = THREE.MathUtils.lerp(meta.fovY, Math.max(meta.fovY, 50), e);
    if (camera.fov !== fovNow) { camera.fov = fovNow; camera.updateProjectionMatrix(); }
    eye.lerpVectors(lensP, sideEye.clone().addScaledVector(travel.clone().normalize(), drift * reach), e);
    look.lerpVectors(lensP.clone().addScaledVector(fwd, here.distanceTo(lensP)), here.clone().lerp(middle, 0.75), s);
    camera.position.copy(eye);
    limitViewingAngle(camera.position);
    camera.lookAt(look);
    rig.visible = $("#rigBtn").getAttribute("aria-pressed") === "true";
  } else {
    if (!controlsUpdated) controls.update();
    rig.visible = $("#rigBtn").getAttribute("aria-pressed") === "true";
  }

  // The timeline panel covers the page's bottom: in the bounded orbit the picture is lifted by half of what it covers,
  // so the subject sits mid-way in what is left rather than under the panel. Through the lens it must line up with the
  // footage, and the cinematic path starts there, so only the orbit
  const lift = mode === "orbit" ? viewLift : 0;
  if (lift !== appliedLift) {
    appliedLift = lift;
    if (lift) camera.setViewOffset(innerWidth, innerHeight, 0, lift, innerWidth, innerHeight);
    else camera.clearViewOffset();
  }

  // the lens's own pane would fill the view from right behind it: fade it
  // until the eye has pulled well clear
  const clear = THREE.MathUtils.smoothstep(camera.position.distanceTo(lensP), 0.18, 0.5);
  pane.material.opacity = 0.85 * clear;
  frustum.visible = clear > 0.02;

  // HUD
  $("#clock").textContent = timeLabel(t);
  const k = t / DURATION;
  if (!scrubbing) bar.value = t;
  bar.style.setProperty("--progress", `${k * 100}%`);
  bar.setAttribute("aria-valuetext", `${timeLabel(t)} of ${timeLabel(DURATION)}`);
  const r = scrubbing ? 0 : clock.rate;
  $("#dir").textContent = Math.abs(r) < 0.03 ? "■ hold" : r > 0 ? "▸▸ forward" : "◂◂ reverse";
  $("#rate").textContent = Math.abs(r) < 0.03 ? "0.00×" : `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}×`;

  // focus on her now; no blur through the lens, where the view is the footage
  camera.updateMatrixWorld();
  if (world?.contact && focusAt) world.contact.position.set(focusAt.x, world.ground, focusAt.z);
  const pu = post.material.uniforms;
  if (focusAt) pu.uFocus.value = -focusAt.clone().applyMatrix4(camera.matrixWorldInverse).z;
  const aperture = world || mode === "recorded" ? 0 : 7 * dofGain;
  pu.uAperture.value += (aperture - pu.uAperture.value) * Math.min(1, dt * 4);
  sideFill?.update();
  if (world) {
    // Spark emits sRGB to the canvas, but linear colour to an offscreen target.
    // Our raw-footage post pass deliberately does no conversion: bypass it for
    // the generated world rather than mixing linear splats with sRGB poses.
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  } else {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
  }
  renderDirty = Math.abs(pu.uAperture.value - aperture) > 0.01;
  return true;
}

await Promise.all(pendingTextures);
const worldBtn = $("#worldBtn");
const worldDetail = $("#worldDetail");
worldDetail.value = ["100k", "500k", "full"].includes(params.get("splats")) ? params.get("splats") : "auto";
worldDetail.addEventListener("change", () => reload(q => worldDetail.value === "auto" ? q.delete("splats") : q.set("splats", worldDetail.value)));
worldBtn.hidden = !hasGeneratedWorld;
const generatedWorld = hasGeneratedWorld && params.get("world") !== "original";
worldBtn.addEventListener("click", () => reload(q => world ? q.set("world", "original") : q.delete("world")));
if (generatedWorld) {
  $("#loading p").textContent = "Loading the generated 360° environment and recorded subject poses…";
  try {
    const { loadWorldLabs } = await worldImport;
    world = await loadWorldLabs(renderer, scene, () => { renderDirty = true; }, CLIP, params.get("splats"), worldBytes)
      .finally(() => { worldBytes = null; }); // the decoded splats are all that is kept
    // Decoding is not display readiness. Complete Spark's first generation/sort
    // behind the loading screen, rather than showing capture over a black void.
    setMode(mode);
    await world.spark.update({ scene, camera });
    environment.visible = false;
    document.body.classList.add("worldlabs");
    worldBtn.setAttribute("aria-pressed", "true");
    worldDetail.hidden = false;
    if (CLIP === "grizzly" || /^wolf[1-3]$/.test(CLIP)) {
      // Keep the measured/recorded source view depth-sorted in front of the
      // generated surroundings. Its subject holes let the present shell show
      // through; depth writes also keep background geometry from covering it.
      const captured = [...env, backdrop].filter(Boolean);
      captured.forEach((m, i) => {
        scene.add(m);
        m.material.uniforms.uCaptured.value = 1;
        m.material.uniforms.uLit.value = 0;
        m.material.transparent = true;
        m.material.depthTest = false;
        m.material.depthWrite = true;
        // Real geometry first, fill only in its holes. Blend each pixel once:
        // two overlapping layers otherwise turn alpha a into 2a-a² and harden
        // the feather. Stencil resets on each render; its mask never follows time.
        m.material.stencilWrite = true;
        m.material.stencilRef = 1;
        m.material.stencilFunc = THREE.NotEqualStencilFunc;
        m.material.stencilZPass = THREE.ReplaceStencilOp;
        m.renderOrder = 85000 + i;
      });
      world.captured = captured;
      if (CLIP === "grizzly") {
        $("#status").textContent = " · Original live river/captured scene · World Labs surroundings";
        $("#motion").textContent = $("#motion").textContent.replace(/world  held still:.*/, "world  original capture + generated surroundings");
      } else {
        $("#status").textContent = " · Original depth-sorted source scene · World Labs surroundings";
        $("#motion").textContent = $("#motion").textContent.replace(/world  held still:.*/, "world  original depth + generated surroundings");
      }
    } else {
      $("#status").textContent = " · World Labs generated environment · approximate alignment";
      $("#motion").textContent = $("#motion").textContent.replace(/world  held still:.*/, "world  World Labs 360° environment (generated)");
    }
  } catch (error) {
    if (world) {
      scene.remove(world.mesh, world.spark);
      if (world.contact) {
        scene.remove(world.contact);
        world.contact.geometry.dispose();
        world.contact.material.dispose();
      }
      world.mesh.dispose();
      world.spark.dispose();
      world = null;
    }
    worldBtn.textContent = "retry World Labs";
    worldBtn.title = error.message;
    $("#status").textContent = " · Generated environment unavailable · showing original world";
  }
}
$("#loading").classList.add("is-done");
setMode(mode);
last = performance.now();
function setWorldLabsVisible(visible) {
  if (!world) return;
  world.mesh.visible = !!visible;
  world.spark.visible = !!visible;
  if (world.contact) world.contact.visible = !!visible;
  renderDirty = true;
}
window.__stable = { meta, trail, setLook: (x, y) => { embedLook.x = THREE.MathUtils.clamp(x, -1, 1); embedLook.y = THREE.MathUtils.clamp(y, -1, 1); renderDirty = true; }, setWorldLabsVisible, world, clock, setMode, camera, controls, reach, middle, sideEye, shells, walker: shells.map((s) => s.mesh), env, seek, setPlaying, stepFrame, skip: ms => { cinematicTime += ms / 1000; }, frame: (force = false) => { if (force) renderDirty = true; return tick(performance.now()); } };
if (!EMBED) requestAnimationFrame(loop);

// The bake's own verdict, for a visitor who cannot know why a clip looks the way it does
if (V2 && meta.notes?.length) {
  const note = ` · Heads-up: ${meta.notes.join("; ")}. Orbit narrowed.`;
  $("#status").textContent += note;
  $("#status").title = note;
}
