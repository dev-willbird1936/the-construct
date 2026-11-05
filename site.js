import * as THREE from "three";
import { EffectComposer } from "./vendor/three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "./vendor/three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "./vendor/three/examples/jsm/postprocessing/OutputPass.js";
import { CELL, OPEN, PERIOD, BUILT, buildLattice, buildShafts, latticeUniforms } from "./lattice.js";
import { buildChronoVolume, tickChrono, buildFrameVolume, buildShellVolume, syncShellBackdrop, buildStrings, syncStrings, loadVolume, setCut, disposeVolume } from "./volume.js";
// optional exports, read through the namespace so a volume.js without them still loads
import * as Vol from "./volume.js";
import { buildDust, syncDust, disposeDust, warmChronoFloor, readPixels, setPixelReader, setDustDensity, DUST_SIDE } from "./tesseract-dust.js";
import { buildWorldCell, tickWorldCell, wakeWorldCell, releaseWorldCell, plateMaterial, overlayTop, cropPlate, addReflection, addSurround, dustFrameOf, SUBJECT_GRADE } from "./tesseract-world.js";
// optional exports (the plate relief), read through the namespace like Vol
import * as World from "./tesseract-world.js";


const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const TILE = 3;

// ── The tile ─────────────────────────────────────────────────────────────
// Nine slots laid out 3×3 and repeated forever. Because the index is taken
// modulo 3 on each axis, any 3×3 window holds all nine exactly once, so each
// specimen needs only one instance no matter how far you travel — and walking
// three cells returns you to the same room, which is the whole conceit.
// Licensed default: two featured chrono seeds (CC0 black cat, CC BY 3.0
// muntjac) mounted via seedBase/seedName; your cell preserved; the rest
// stay empty until a published build claims them.
const EMPTY_NOTE = "This room is free. Build something in Create and publish it, and it can hang in a room like this one.";
const SLOTS = [
  { kind: "volume", tier: "lite", seedBase: "assets/gallery-seed", seedName: "blackcat-atlas", thumb: "assets/gallery-seed/blackcat-thumb.webp", title: "EXAMPLE · BLACK CAT", note: "Black Cat walking by Dzkouslavia, CC0." },
  { kind: "volume", tier: "lite", seedBase: "assets/gallery-seed", seedName: "muntjac-atlas", thumb: "assets/gallery-seed/muntjac-thumb.webp", title: "EXAMPLE · MUNTJAC", note: "Muntjac Deer Barking by Mvolz, CC BY 3.0 (Wikimedia Commons)." },
  { kind: "volume", name: "empty-2", title: "OPEN ROOM", note: EMPTY_NOTE, missing: true },
  { kind: "volume", name: "empty-3", title: "OPEN ROOM", note: EMPTY_NOTE, missing: true },
  { kind: "instrument", title: "YOUR CELL", note: "Your builds hang here. Open the studio to make one." },
  { kind: "volume", name: "empty-5", title: "OPEN ROOM", note: EMPTY_NOTE, missing: true },
  { kind: "volume", name: "empty-6", title: "OPEN ROOM", note: EMPTY_NOTE, missing: true },
  { kind: "volume", name: "empty-7", title: "OPEN ROOM", note: EMPTY_NOTE, missing: true },
  { kind: "volume", name: "empty-8", title: "OPEN ROOM", note: EMPTY_NOTE, missing: true },
];

const state = {
  // Licensed default opens in the black-cat example room.
  focus: { x: 0, y: 0 },
  cam: { x: 0, y: 0 },
  // start mid-clip: the last frames are often the subject leaving the shot,
  // and a cut with history behind it shows the idea straight away
  cut: 0.62,
  cutTarget: 0.62,
  pointer: { x: 0.5, y: 0.5 },
  look: { x: 0, y: 0 },
  // pointing into an edge band leans the eye toward that neighbour (a peek); eased
  lean: { x: 0, y: 0 },
  // how much of the pointer's look each view takes (1 = follows, 0 = holds still); eased
  follow: { construct: 1, scene: 1 },
  travelling: 0,
  travelDir: { x: 0, y: 0 },
  camVel: { x: 0, y: 0 },
  // 0..1: how far the eye has pulled back from the window frame for a glide
  arc: 0,
  bank: 0,
  // the read head eases slower for a moment after arriving, so a room plays in
  arrival: 0,
  entry: reduced ? 1 : 0,
  time: 0,
  // left-drag turns the specimen you are standing with; eased toward target
  drag: null,
  spin: { x: 0, y: 0 },
  spinTarget: { x: 0, y: 0 },
};

const canvas = $("#latticeCanvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
function softwareRendererName(name) {
  return /swiftshader|llvmpipe|softpipe|software/i.test(String(name || ""));
}
const gl = renderer.getContext();
const debugRenderer = gl.getExtension("WEBGL_debug_renderer_info");
const softwareGraphics = softwareRendererName(debugRenderer ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
canvas.dataset.graphics = softwareGraphics ? "software" : "full";
if (softwareGraphics) state.entry = 1; // don't stretch the fly-in across slow software frames
// the HUD waits for the way in (index.html starts the body as is-intro), then settles in a beat behind it
if (state.entry >= 1) document.body.classList.remove("is-intro");
renderer.setPixelRatio(Math.min(window.devicePixelRatio, softwareGraphics ? 1 : 1.75));
// the same warm haze the fog fades into, so the far end glows instead of going black
renderer.setClearColor(latticeUniforms.uFog.value, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Asking the GPU for each program's log on first use waits for its compile
// to finish, which stalled the way in and the first glide by a few hundred
// milliseconds. The shaders are fixed and tested; ?shaders=check turns it on.
renderer.debug.checkShaderErrors = new URLSearchParams(location.search).get("shaders") === "check";
// filmic roll-off keeps the gloss and bloom from clipping to flat white
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 400);
scene.add(camera);

// ── Post ─────────────────────────────────────────────────────────────────
// Bloom is what turns bright streaks and rims into the film's glow. The film
// pass adds a slight lens: colour fringing toward the edges and a vignette.

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// threshold sits just above the specimens' highlight ceiling (volume.js)
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.5, 0.9);
bloom.enabled = !softwareGraphics; // software rasterizers cannot afford the multi-pass blur
composer.addPass(bloom);
const lens = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uAberration: { value: 0.0015 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAberration;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * r2 * uAberration * 4.0;
      vec3 c = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      c *= 1.0 - smoothstep(0.1, 0.62, r2) * 0.75;
      gl_FragColor = vec4(c, 1.0);
    }
  `,
});
composer.addPass(lens);
composer.addPass(new OutputPass());

// Time dust reads each pose's pixels to start its threads from. The textures
// are already on the GPU, so draw one into a small target there and read back
// only that (rows top first, the image's own bytes), instead of decoding the
// image a second time on the main thread.
const dustRead = {
  target: new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }),
  material: new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, flip: { value: 1 }, encode: { value: 1 } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float flip, encode;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(map, vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, flip)));
        // an sRGB texture samples as linear light; write the image's bytes back
        vec3 srgb = mix(c.rgb * 12.92, 1.055 * pow(c.rgb, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c.rgb));
        gl_FragColor = vec4(mix(c.rgb, srgb, encode), c.a);
      }
    `,
    depthTest: false,
    depthWrite: false,
  }),
  scene: new THREE.Scene(),
  camera: new THREE.Camera(),
};
dustRead.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dustRead.material));
setPixelReader((texture, width, height) => {
  if (!texture?.isTexture || renderer.getContext().isContextLost()) return null;
  dustRead.target.setSize(width, height);
  dustRead.material.uniforms.map.value = texture;
  dustRead.material.uniforms.flip.value = texture.flipY ? 1 : 0;
  dustRead.material.uniforms.encode.value = texture.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(dustRead.target);
  renderer.render(dustRead.scene, dustRead.camera);
  const px = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(dustRead.target, 0, 0, width, height, px);
  renderer.setRenderTarget(previous);
  dustRead.material.uniforms.map.value = null;
  return px;
});

// ── Content ──────────────────────────────────────────────────────────────

const slotObjects = new Array(SLOTS.length).fill(null);
const slotStrings = new Array(SLOTS.length).fill(null);
const slotBackdrops = new Array(SLOTS.length).fill(null);
const slotDust = new Array(SLOTS.length).fill(null);
// the drawing buffer's size, for the dust threads' pixel width
const dustView = new THREE.Vector2(1, 1);
const dustBuilds = new Set(); // dust still reading its poses
let lattice = null;

function unmountDust(index) {
  if (!slotDust[index]) return;
  scene.remove(slotDust[index]);
  disposeDust(slotDust[index]);
  slotDust[index] = null;
}
const YAW = -0.42;
const PLATE_YAW = -0.16;
const PLATE_TURN = 0.95; // furthest a plate room turns either way, radians

// Size a specimen to sit inside its room at the fixed yaw: tall subjects get
// the height, wide ones are held to a width that clears the beams.
function fitSpecimen(aspect) {
  return { depth: 5.2, height: Math.min(6.2, (OPEN * 0.74) / aspect) };
}
// Size a chrono row to sit inside its room: the pose height is held so the
// whole row (poses + recede) clears the beams. Long legacy rows become a
// frieze; new 5-14 pose specimens stand near full height. A ghost-trail row
// is spaced by Lite's TRAIL_STEP (pose widths per pose; its trail cards fill
// the row), so a smaller step there stands each pose larger here.
function fitChronoCell(meta) {
  const n = Math.max(1, meta.count || 1);
  const trailStep = typeof Vol === "object" && Number(Vol.TRAIL_STEP) > 0 ? Number(Vol.TRAIL_STEP) : 0.85;
  const s = Array.isArray(meta.trail?.cells) && meta.trail.cells.length ? trailStep : 0.85;
  const aspect = meta.aspect || 1;
  let meanW = 1;
  if (Array.isArray(meta.anchors) && meta.anchors.length) {
    let sum = 0, count = 0;
    for (const anchor of meta.anchors) {
      const left = Number(anchor?.left), right = Number(anchor?.right);
      if (Number.isFinite(left) && Number.isFinite(right) && right > left) { sum += right - left; count += 1; }
    }
    if (count) meanW = Math.min(1, Math.max(0.5, sum / count));
  } else if (meta.subjectFill?.w > 0) {
    meanW = Math.min(1, Math.max(0.5, Number(meta.subjectFill.w)));
  }
  let height = Math.min(6.2, (OPEN * 0.92) / (aspect * (s * (n - 1) + meanW)));
  const fullWidth = height * aspect * (s * (n - 1) + 1);
  if (fullWidth > OPEN * 0.95) height *= OPEN * 0.95 / fullWidth;
  return { height, step: 0.85, trailStep: s, depth: 4.6 };
}
const SPECIMEN_Z = 0;
const REST_STANDOFF = 23.5;
const FOCUS_Z_MAX = 13;
// A row reads by the angle it makes with the resting eye's line of sight, not
// by a fixed yaw: at YAW a row with the standard recede ran about 60° off
// side-on and its poses stacked into one silhouette. Each row turns to a
// three-quarter view, ROW_TURN.min off side-on (now-pose nearest the eye), or
// further, up to ROW_TURN.max, when that would not fit its share of the
// screen (a phone, where the row may then span nearly the whole width).
const ROW_TURN = { min: 0.55, max: 0.9 };
const rowShare = (aspect) => (aspect >= 1 ? 0.56 : 0.95);
function chronoRestYaw(group, aspect) {
  const u = group.userData;
  if (!(u?.rowLen > 0) || !(u.poseW > 0) || !(u.depth >= 0) || !(aspect > 0)) return YAW;
  const across = -Math.atan2(REST_EYE.x, REST_STANDOFF); // the floor direction the eye sees straight across
  const along = Math.atan2(u.depth, u.rowLen), len = Math.hypot(u.rowLen, u.depth);
  const room = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * aspect * (REST_STANDOFF - FOCUS_Z_MAX) * rowShare(aspect);
  let off = ROW_TURN.min;
  while (off < ROW_TURN.max && len * Math.cos(off) + u.poseW * Math.abs(Math.cos(along - off)) > room) off += 0.03;
  return along - across - off;
}
function focusZForChrono(group, aspect) {
  const u = group.userData;
  if (!u?.chrono || ![u.rowLen, u.poseW, u.depth, aspect, camera.fov].every(Number.isFinite) || u.rowLen < 0 || u.poseW <= 0 || u.depth < 0 || aspect <= 0 || camera.fov <= 0 || camera.fov >= 180) return 0;
  const yaw = Number.isFinite(u.restYaw) ? u.restYaw : YAW;
  const width = Math.abs(u.rowLen * Math.cos(yaw) + u.depth * Math.sin(yaw)) + u.poseW * Math.abs(Math.cos(yaw));
  if (!(width > 0.1)) return 0;
  const target = rowShare(aspect);
  const distance = width / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * aspect * target);
  return Math.max(0, Math.min(FOCUS_Z_MAX, REST_STANDOFF - distance));
}
// Plate rooms (Basic diorama, Advanced world) come forward the same way so
// the recorded place fills most of the window instead of hanging small.
function focusZForPlate(group, aspect) {
  const u = group.userData;
  if (!(u?.worldCell || u?.basicCell) || !(u.width > 0) || !(aspect > 0) || !(camera.fov > 0 && camera.fov < 180)) return 0;
  const width = u.width * Math.cos(YAW);
  const distance = width / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * aspect * (aspect >= 1 ? 0.58 : 0.86));
  return Math.max(0, Math.min(PLATE_Z_MAX, REST_STANDOFF - distance));
}
// a plate is one flat-backed picture, so it may come nearer than a row: at
// FOCUS_Z_MAX a wide screen showed it at about two fifths of its width
const PLATE_Z_MAX = 15;

// Licensed default loads only the two featured seeds above. No depth shells
// and no embedded viewer are fetched here; experimental viewers remain
// available as standalone pages but are never auto-started from this surface.
const LOADED_SPECIMENS = new Set(["blackcat-atlas", "muntjac-atlas"]);
const SHELL_VIEW = { rest: -0.3, yaw: THREE.MathUtils.degToRad(20), up: THREE.MathUtils.degToRad(6), down: THREE.MathUtils.degToRad(1.5) };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A dark void closing the back window of the room you are in, so the specimen
// reads as a silhouette instead of dissolving into the corridor behind it.
const voidPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(OPEN + 0.4, OPEN + 0.4),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      void main() {
        // flat and nearly opaque: a hint of streak survives, the object reads
        gl_FragColor = vec4(0.02, 0.014, 0.006, 0.9 * uAlpha);
      }
    `,
  })
);
voidPlane.renderOrder = -1; // behind every slice, whose renderOrder is its index
scene.add(voidPlane);

function slotIndexFor(cellX, cellY) {
  const ix = ((cellX % TILE) + TILE) % TILE;
  const iy = ((cellY % TILE) + TILE) % TILE;
  return ix + TILE * iy;
}

// Which cell in the window around the focus does this slot occupy?
function cellForSlot(index) {
  const want = { x: index % TILE, y: Math.floor(index / TILE) };
  const pick = (centre, target) => {
    for (let d = -1; d <= 1; d += 1) {
      const c = centre + d;
      if (((c % TILE) + TILE) % TILE === target) return c;
    }
    return centre;
  };
  return { x: pick(state.focus.x, want.x), y: pick(state.focus.y, want.y) };
}

function placeSlots() {
  SLOTS.forEach((slot, i) => { slot.cell = cellForSlot(i); });
}

function mountVolume(index, group) {
  if (slotObjects[index]) {
    scene.remove(slotObjects[index]);
    releaseWorldCell(slotObjects[index]);
    disposeVolume(slotObjects[index]);
  }
  if (slotStrings[index]) {
    scene.remove(slotStrings[index]);
    slotStrings[index].geometry.dispose();
    slotStrings[index].material.dispose();
  }
  unmountDust(index);
  // Chrono rows shed time dust from their read head instead of the legacy
  // slice strings (which assume a stack and would sit off the poses).
  if (group.userData.chrono || group.userData.dustPoses) {
    slotStrings[index] = null;
    if (group.userData.chrono) warmChronoFloor(group);
    // the threads come a moment after the room (their poses are read first) and fade in
    const pending = buildDust(group).then((dust) => {
      if (!dust) return;
      if (slotObjects[index] !== group) { disposeDust(dust); return; }
      unmountDust(index);
      dust.userData.fade = 0;
      slotDust[index] = dust;
      scene.add(dust);
    }).catch(() => {}).finally(() => dustBuilds.delete(pending));
    dustBuilds.add(pending);
  } else {
    slotStrings[index] = buildStrings(group);
    if (slotStrings[index]) scene.add(slotStrings[index]);
  }
  // held at a fixed three-quarter angle: the stack has to be read from the
  // side, and a turning object would fight the lattice's fixed perspective
  group.rotation.y = YAW;
  group.userData.hangIn = 0;
  slotObjects[index] = group;
  scene.add(group);
  placeSlots();
}

// Optional shell backdrop, positioned with its specimen every frame.
function mountBackdrop(index, mesh) {
  const old = slotBackdrops[index];
  if (old) {
    scene.remove(old);
    old.geometry.dispose();
    old.material.map?.dispose();
    old.material.dispose();
  }
  slotBackdrops[index] = mesh || null;
  if (mesh) scene.add(mesh);
}

function loadTexture(url) {
  return new THREE.TextureLoader().loadAsync(url).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  });
}

// Each room's fibres use a deterministic neutral tint row (64 swatches per
// room). The licensed default fetches no footage-derived textures here.
const SWATCHES = 64;

async function buildConstruct() {
  const pixels = new Uint8Array(SWATCHES * SLOTS.length * 4);
  const tints = [
    [96, 84, 66], [88, 80, 70], [70, 66, 60], [78, 72, 64], [60, 58, 54],
    [82, 76, 68], [74, 70, 62], [86, 78, 66], [68, 64, 58],
  ];
  SLOTS.forEach((slot, row) => {
    const base = tints[row % tints.length];
    for (let i = 0; i < SWATCHES; i += 1) {
      const f = 0.82 + 0.36 * ((i * 0.618034 + row * 0.37) % 1);
      const o = (row * SWATCHES + i) * 4;
      pixels[o] = Math.min(255, Math.round(base[0] * f));
      pixels[o + 1] = Math.min(255, Math.round(base[1] * f));
      pixels[o + 2] = Math.min(255, Math.round(base[2] * f));
      pixels[o + 3] = 255;
    }
  });
  const palette = new THREE.DataTexture(pixels, SWATCHES, SLOTS.length);
  palette.colorSpace = THREE.SRGBColorSpace;
  palette.needsUpdate = true;
  // software rendering draws a smaller construct: it is bound by strand count,
  // and the haze hides where the construct ends
  lattice = buildLattice(palette, softwareGraphics ? { span: 3, zFar: 3 } : {});
  if (!reduced) buildShafts(lattice);
  applyQuality();
  lattice.visible = toggles.structure;
  scene.add(lattice);
}

// Compile every program the rooms nearby will need (and the lattice's glide
// variant) while the title is still up, against the target the composer draws
// into (its programs differ from the screen's), so the first glide into a room
// does not wait on a shader.
function prewarmPrograms() {
  if (!lattice) return Promise.resolve();
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.readBuffer);
  if (!reduced && !softwareGraphics) lattice.material = lattice.userData.clearMaterial;
  let ready;
  try { ready = renderer.compileAsync(scene, camera); } catch { ready = Promise.resolve(); }
  lattice.material = lattice.userData.baseMaterial;
  renderer.setRenderTarget(previous);
  return ready.catch(() => {});
}

async function loadSpecimens() {
  await Promise.all(SLOTS.map(async (slot, index) => {
    if (slot.kind !== "volume") return;
    // Licensed default: only the featured seeds mount here; the rest stay
    // empty until a published build claims them via the gallery.
    if (!slot.seedBase || !LOADED_SPECIMENS.has(slot.seedName)) { slot.missing = true; return; }
    try {
      const { texture, meta } = await loadVolume(slot.seedBase, slot.seedName);
      mountVolume(index, buildChronoVolume(texture, meta, fitChronoCell(meta)));
      // Chrono groups carry row dims; drop the legacy slice strings so the
      // room keeps its fibres without a NaN cloud (same as gallery cells).
      if (slotStrings[index]) {
        scene.remove(slotStrings[index]);
        slotStrings[index].geometry.dispose();
        slotStrings[index].material.dispose();
        slotStrings[index] = null;
      }
    } catch {
      // a missing seed leaves its block empty rather than breaking the walk
      slot.missing = true;
    }
  }));
  refreshPlaque();
}

// ── No embedded viewer on the licensed default ──────────────────────────
// Experimental viewers stay available as standalone pages but are never
// embedded or auto-started here, so the default issues no viewer requests.
let portal = null;
function updatePortal() {}



// ── Where am I ───────────────────────────────────────────────────────────

function focusSlot() {
  return SLOTS[slotIndexFor(state.focus.x, state.focus.y)];
}

// What a room is, in words, for the plaque, the door signs and the map.
// the studio's names for each result, and one phrase for what each one is,
// used wherever the name shows: the plaque, the tier cards, the finished build
const TIER_FORM = { lite: "ghost trail", basic: "cloud trail", advanced: "world" };
const TIER_NAME = { lite: "Lite", basic: "Basic", advanced: "Advanced" };
const FORM_IS = {
  lite: "every pose of one subject, cut out and lined up through time",
  basic: "a subject's moments as points in estimated depth, over its scene",
  advanced: "the filmed place in estimated 3D, with its subject at each moment",
};
const SCRUB = window.matchMedia("(hover: none)").matches ? "Swipe up or down" : "Scroll";
const FORM_HOW = {
  lite: `Every pose of one subject, cut out and lined up through time. ${SCRUB} to move through it.`,
  basic: `A subject's moments over its scene, set in estimated depth. ${SCRUB} to move through them.`,
  advanced: `The filmed place in estimated 3D, with its subject at each moment. ${SCRUB} to move through it.`,
};
function roomInfo(slot) {
  const item = slot.gItem;
  if (slot.kind === "instrument") {
    return { kind: "yours", kicker: item ? `your cell · ${TIER_FORM[item.tier] || item.tier}` : "your cell", title: "YOUR CELL", short: "YOUR CELL", sub: item ? "your latest build" : "build here", how: item ? FORM_HOW[item.tier] || "" : "" };
  }
  if (slot.missing) return { kind: "empty", kicker: "open room", title: "OPEN ROOM", short: "OPEN ROOM", sub: "room for your build", how: "" };
  const tier = item?.tier || slot.tier || "lite";
  const example = !item || item.example;
  const title = slot.title || "PUBLISHED";
  const loading = Boolean(item && !slotObjects[SLOTS.indexOf(slot)] && slot._loading);
  return {
    kind: example ? "example" : "published",
    kicker: `${example ? "" : "a visitor's build · "}${TIER_FORM[tier] || "build"}${loading ? " · hanging…" : ""}`,
    how: FORM_HOW[tier] || "",
    title,
    short: title.replace(/^EXAMPLE · /, ""),
    sub: `${example ? "example" : "a visitor's"} · ${TIER_FORM[tier] || tier}`,
  };
}

function plaqueActions(slot) {
  const actions = [];
  const item = slot.gItem;
  if (slot.kind === "instrument") actions.push({ label: ST.me || !ST.meKnown ? "Open the studio" : "Sign in to build", run: () => openStudio() });
  else if (slot.missing) actions.push({ label: "Make a build", run: () => openStudio() });
  if (item?.viewer && (item.tier !== "lite" || slot.kind === "instrument" || !item.example)) {
    actions.push({ label: "Open in viewer ↗", run: (event) => openViewer(assetUrl(item.viewer), event.currentTarget) });
  }
  return actions;
}

let plaqueCell = null, plaqueTimer = 0, plaqueBox = null, chipFloor = 0;
function paintPlaque() {
  const slot = focusSlot();
  const info = roomInfo(slot);
  $("#cellKicker").textContent = info.kicker;
  $("#cellTitle").textContent = slot.missing ? "OPEN ROOM" : slot.title;
  $("#cellHow").textContent = info.how || "";
  $("#cellNote").textContent = slot.kind === "instrument" && slot.gItem
    ? `${slot.gItem.title || "Your build"}: your latest build hangs here.`
    : slot.missing ? EMPTY_NOTE : slot.note;
  $("#plaqueActions").replaceChildren(...plaqueActions(slot).map((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plaque-btn";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    return button;
  }));
  $("#plaque").dataset.kind = info.kind;
  $("#plaque").classList.toggle("is-loading", info.kicker.endsWith("hanging…"));
  plaqueBox = null; // its size changed: the door signs measure it again
}

function refreshPlaque() {
  const key = `${state.focus.x},${state.focus.y}`;
  const plaque = $("#plaque");
  // a new room's plaque is swapped like a gallery label: out, then in
  if (plaqueCell !== null && plaqueCell !== key && !reduced) {
    plaque.classList.add("is-swapping");
    window.clearTimeout(plaqueTimer);
    plaqueTimer = window.setTimeout(() => { paintPlaque(); plaque.classList.remove("is-swapping"); }, 200);
  } else if (!plaque.classList.contains("is-swapping")) paintPlaque();
  plaqueCell = key;
  $("#cellCoord").textContent = `${state.focus.x >= 0 ? "+" : ""}${state.focus.x} , ${state.focus.y >= 0 ? "+" : ""}${state.focus.y}`;
  syncStudio();
  paintDoors();
  paintMap();
}

// Door signs name each neighbour; their place on screen is set every frame.
function paintDoors() {
  for (const el of doorEls) {
    const dx = Number(el.dataset.dx), dy = Number(el.dataset.dy);
    const info = roomInfo(SLOTS[slotIndexFor(state.focus.x + dx, state.focus.y + dy)]);
    el.querySelector("b").textContent = info.short;
    el.querySelector("small").textContent = info.sub;
    el.dataset.kind = info.kind;
    // the peek: a picture of the room on its sign, shown when you point at it
    const slot = SLOTS[slotIndexFor(state.focus.x + dx, state.focus.y + dy)];
    const thumb = slot.missing ? "" : slot.gItem?.thumb || slot.thumb || "";
    const img = el.querySelector("img");
    if (!thumb) img.removeAttribute("src");
    else if (img.dataset.src !== thumb) img.src = assetUrl(thumb);
    img.dataset.src = thumb;
  }
  // measured once per room change, never inside the frame loop
  for (const el of doorEls) {
    el.dataset.half = String((el.offsetWidth || 120) / 2);
    el.dataset.tall = String(el.offsetHeight || 30);
  }
  for (const el of edgeEls) {
    const dx = Number(el.dataset.dx || 0), dy = Number(el.dataset.dy || 0);
    const info = roomInfo(SLOTS[slotIndexFor(state.focus.x + dx, state.focus.y + dy)]);
    const side = dx < 0 ? "on the left" : dx > 0 ? "on the right" : dy > 0 ? "above" : "below";
    el.setAttribute("aria-label", `Go to the room ${side}: ${info.short.toLowerCase()}, ${info.sub}`);
  }
}

// Signs are projected from the room's resting eye, not the live one, so a
// sign never slides away from a pointer that leans toward it.
const doorAt = new THREE.Vector3();
const restEye = new THREE.PerspectiveCamera();
function placeDoors() {
  restEye.fov = camera.fov;
  restEye.aspect = camera.aspect;
  restEye.near = camera.near;
  restEye.far = camera.far;
  restEye.updateProjectionMatrix();
  restEye.position.set(state.cam.x + REST_EYE.x, state.cam.y + REST_EYE.y, REST_STANDOFF);
  restEye.lookAt(state.cam.x, state.cam.y, 0);
  restEye.rotateZ(-0.07);
  restEye.updateMatrixWorld();
  const w = window.innerWidth, h = window.innerHeight;
  const narrow = w <= 640;
  // up/down signs hug the HUD bands so they sit over the frame, not the room
  const top = narrow ? 150 : 96, bottom = narrow ? 178 : 100;
  // a sign never sits on the plaque: where they would share columns, it rises
  // above the plaque's top (measured once per plaque change, not per frame)
  if (!plaqueBox) {
    const r = $("#plaque").getBoundingClientRect();
    plaqueBox = { top: r.height ? r.top : h, left: r.left, right: r.right };
  }
  const upTall = Number(doorEls.find((el) => el.dataset.dy === "1")?.dataset.tall) || 44;
  for (const el of doorEls) {
    const dx = Number(el.dataset.dx), dy = Number(el.dataset.dy);
    doorAt.set((state.focus.x + dx) * CELL, (state.focus.y + dy) * CELL, 0).project(restEye);
    const half = Number(el.dataset.half) || 60;
    const x = clamp((doorAt.x + 1) / 2 * w, 14 + half, w - (narrow ? 46 : 100) - half);
    const tall = Number(el.dataset.tall) || 30;
    // and below the build chip while one is showing
    const ceiling = Math.max(top, chipFloor ? chipFloor + tall / 2 + 8 : 0);
    let y = clamp((1 - doorAt.y) / 2 * h, ceiling, h - bottom);
    // on a phone the room's subject spans nearly the width at mid-height, so
    // the side signs hang in the upper corners, under the up sign, not on it
    if (narrow && dx) y = ceiling + upTall / 2 + tall / 2 + 10;
    if (x + half > plaqueBox.left && x - half < plaqueBox.right) y = Math.max(ceiling, Math.min(y, plaqueBox.top - tall / 2 - 10));
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
  }
  $("#doors").style.opacity = String(state.entry < 0.7 || !titleGone || galleryIsCovered() ? 0 : clamp(1 - state.travelling * 3, 0, 1));
}

// The map: the 3x3 window around you holds every room exactly once.
const mapEl = $("#roomMap");
for (const dy of [1, 0, -1]) for (const dx of [-1, 0, 1]) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.dx = dx;
  button.dataset.dy = dy;
  button.innerHTML = "<i></i>";
  if (!dx && !dy) button.setAttribute("aria-current", "location");
  mapEl.append(button);
}
mapEl.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  travel(Number(button.dataset.dx), Number(button.dataset.dy));
  if (event.detail > 0) canvas.focus({ preventScroll: true });
});
function paintMap() {
  for (const button of mapEl.children) {
    const dx = Number(button.dataset.dx), dy = Number(button.dataset.dy);
    const info = roomInfo(SLOTS[slotIndexFor(state.focus.x + dx, state.focus.y + dy)]);
    const where = !dx && !dy ? "you are here" : [dy > 0 ? "up" : dy < 0 ? "down" : "", dx < 0 ? "left" : dx > 0 ? "right" : ""].filter(Boolean).join(" ");
    button.dataset.kind = info.kind;
    button.dataset.name = `${info.short.toLowerCase()} · ${where}`;
    button.setAttribute("aria-label", `${info.short.toLowerCase()}, ${info.sub}, ${where}`);
  }
}

// The studio is a panel you open in your cell, not the cell itself: walking
// into your cell shows the room (and your latest build hanging in it).
let studioOpen = false;
let currentStep = "stepUpload";
function syncStudio() {
  const open = studioOpen && focusSlot().kind === "instrument";
  document.body.classList.toggle("in-instrument", open);
  $("#instrumentCell").classList.toggle("is-live", open);
  document.body.classList.toggle("panel-open", open && currentStep !== "stepUpload" && currentStep !== "stepAuth");
  syncBuildChip();
}
// Back and Forward: the studio and a viewer each add one same-URL history entry, so Back
// closes them before it leaves the site and Forward opens them again. Closing one from
// the page takes its entry back off. Only this page's own entries count (not after a reload).
const PAGE_ID = Math.random().toString(36).slice(2);
let historyBack = false;
const ownLayer = () => (history.state?.page === PAGE_ID ? history.state.layer : null);
function pushLayer(layer, url = "") {
  if (ownLayer() !== layer) history.pushState({ page: PAGE_ID, layer, url }, "");
}
function dropLayer(layer) {
  if (ownLayer() !== layer) return;
  historyBack = true;
  history.back();
}
window.addEventListener("popstate", () => {
  if (historyBack) { historyBack = false; return; }
  const layer = ownLayer();
  if (viewerReturn && layer !== "viewer") closeViewer();
  if (studioOpen && !layer) closeStudio();
  if (layer === "studio" && !studioOpen) openStudio();
  if (layer === "viewer" && !viewerReturn && history.state.url) openViewer(history.state.url);
});
function closeStudio() {
  if (!studioOpen) return;
  studioOpen = false;
  dropLayer("studio");
  resetSceneInput();
  refreshPlaque();
  canvas.focus({ preventScroll: true });
}

// The shortest hop (at most one cell each way) to the nearest cell that is yours: the slots tile 3x3.
const ownCell = SLOTS.findIndex((slot) => slot.kind === "instrument");
const hop = (from, want) => ((((want - from) % TILE) + TILE + 1) % TILE) - 1;
let studioReturnCell = { ...state.focus };
function openStudio(library = false) {
  if (focusSlot().kind !== "instrument") studioReturnCell = { ...state.focus };
  resetSceneInput();
  // Reuse the same panel/list for creation and the library; leaving never cancels server work.
  $("#stepUpload").classList.toggle("library-view", library);
  Object.assign(SLOTS[ownCell], { kind: "instrument", title: "YOUR CELL", missing: false });
  studioOpen = true;
  pushLayer("studio");
  travel(hop(state.focus.x, ownCell % TILE), hop(state.focus.y, Math.floor(ownCell / TILE)));
  refreshPlaque();
  // a flow in progress (picking, building, done) is picked up where it was left
  const resume = !library && ST.me && ["stepRoute", "stepFrame", "stepWorking"].includes(currentStep);
  showStep(resume ? currentStep : ST.me ? "stepUpload" : "stepAuth");
  if (ST.me) {
    loadBuilds();
    if (library) {
      const heading = $("#myBuilds .side-label");
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: "start" });
    }
  }
}
$("#uploadCta").addEventListener("click", () => openStudio());
$("#myBuildsCta").addEventListener("click", () => openStudio(true));
$("#studioClose").addEventListener("click", closeStudio);
// Explore leaves the studio for the room you came from; out in the construct
// it is a guide: it glides to a hung room next door you have not seen yet.
const visited = new Set([slotIndexFor(state.focus.x, state.focus.y)]);
function exploreNext() {
  const ways = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
  const slotAt = ([dx, dy]) => slotIndexFor(state.focus.x + dx, state.focus.y + dy);
  const hung = ways.filter((way) => !SLOTS[slotAt(way)].missing && SLOTS[slotAt(way)].kind !== "instrument");
  const [dx, dy] = hung.find((way) => !visited.has(slotAt(way))) || hung[0] || ways[0];
  travel(dx, dy);
}
$("#exploreCta").addEventListener("click", () => {
  resetSceneInput();
  const wasOpen = studioOpen;
  studioOpen = false;
  dropLayer("studio");
  if (focusSlot().kind === "instrument") {
    const back = slotIndexFor(studioReturnCell.x, studioReturnCell.y) === ownCell
      ? { x: state.focus.x - 1, y: state.focus.y } : studioReturnCell;
    travel(back.x - state.focus.x, back.y - state.focus.y);
  } else if (!wasOpen) exploreNext();
  syncStudio();
  canvas.focus({ preventScroll: true });
});
// Escape closes the studio back to the room (the viewer and box drawing handle their own Escape first)
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || !studioOpen || viewerReturn || ST.boxMode) return;
  if (event.target instanceof Element && event.target.closest("input[type=text], textarea")) return;
  event.preventDefault();
  closeStudio();
});

function travel(dx, dy) {
  if (!dx && !dy) return;
  resetSceneInput();
  // each room starts at its resting angle
  state.spinTarget = { x: 0, y: 0 };
  state.focus.x += dx;
  state.focus.y += dy;
  state.travelDir = { x: dx, y: dy };
  startGlide();
  // every room opens on a showcase moment: a read head left near the start
  // in the last room would show a lone subject here, with no trail behind it
  state.cutTarget = Math.max(state.cutTarget, ARRIVE_CUT);
  if (!reduced) { state.cut = 0.04; state.arrival = 1.2; }
  else state.cut = state.cutTarget; // reduced motion: no sweep, the head is simply there
  Object.assign(sway, { on: !reduced, t: 0, scrubbed: false });
  placeSlots();
  refreshPlaque();
  galleryTick();
  pulseEdge(dx, dy);
  lastTravel = performance.now();
  visited.add(slotIndexFor(state.focus.x, state.focus.y));
  document.body.classList.add("has-travelled");
}
let lastTravel = 0;
const ARRIVE_CUT = 0.75; // a little past the home's opening moment (state.cut), so the trail reads

// ── The glide ────────────────────────────────────────────────────────────
// Crossing is a timed curve, not a chase: the eye starts and ends at rest,
// pulls back from the window frame while it slides (so no beam fills the
// frame), turns a little toward where it is going, and a second press
// mid-glide carries on from the current speed instead of restarting.
// Reduced motion cuts straight to the room behind a short fade instead.
const glide = { from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, v0: { x: 0, y: 0 }, arc0: 0, t: 1, dur: 1 };
const DOLLY = 7.2;   // pull-back at mid-glide; the eye stays clear of the frame plane behind it (face at ~32.3)
const EYE_REACH = 4.3; // the window's half-opening is 4.75: the eye stays inside it
const INTRO_TIME = 3.4;
const FOG_DENSITY = latticeUniforms.uFogDensity.value;
const softLimit = (v, limit) => limit * Math.tanh(v / limit);
// where the eye rests in a room, before the pointer or the drift move it
const REST_EYE = { x: softLimit(2.4, EYE_REACH), y: softLimit(1.7, EYE_REACH) };
const smoother = (s) => s * s * s * (s * (s * 6 - 15) + 10);
const bump = (s) => Math.sin(Math.PI * s) ** 2;
function startGlide() {
  const to = { x: state.focus.x * CELL, y: state.focus.y * CELL };
  if (reduced) {
    state.cam.x = to.x; state.cam.y = to.y;
    state.camVel = { x: 0, y: 0 };
    glide.t = glide.dur;
    const veil = $(".veil");
    veil.classList.remove("is-cut");
    void veil.offsetWidth; // restart the fade
    veil.classList.add("is-cut");
    return;
  }
  glide.from = { ...state.cam };
  glide.v0 = { ...state.camVel };
  glide.to = to;
  glide.arc0 = state.arc;
  const cells = Math.hypot(to.x - state.cam.x, to.y - state.cam.y) / CELL;
  glide.dur = clamp(0.9 + 0.38 * cells, 1.05, 1.75);
  glide.t = 0;
}
function stepGlide(delta) {
  if (glide.t >= glide.dur) {
    state.camVel = { x: 0, y: 0 };
    state.arc = 0;
    return 1;
  }
  glide.t = Math.min(glide.dur, glide.t + delta);
  const s = glide.t / glide.dur, e = smoother(s), h = s * (1 - s) * (1 - s) * glide.dur;
  const nx = glide.from.x + (glide.to.x - glide.from.x) * e + glide.v0.x * h;
  const ny = glide.from.y + (glide.to.y - glide.from.y) * e + glide.v0.y * h;
  state.camVel = { x: (nx - state.cam.x) / Math.max(delta, 1e-3), y: (ny - state.cam.y) / Math.max(delta, 1e-3) };
  state.cam.x = nx; state.cam.y = ny;
  state.arc = Math.min(1, bump(s) + glide.arc0 * (1 - smoother(Math.min(1, s * 2))));
  return s;
}

function pulseEdge(dx, dy) {
  const el = $(dx > 0 ? "#edgeR" : dx < 0 ? "#edgeL" : dy > 0 ? "#edgeU" : "#edgeD");
  if (!el) return;
  el.classList.add("is-firing");
  window.setTimeout(() => el.classList.remove("is-firing"), 420);
}

// ── Input ────────────────────────────────────────────────────────────────
// Look freely, go deliberately. The pointer only looks: pointing into an edge
// band (or at a door sign) leans the eye toward that neighbour and lights its
// sign, and nothing moves until you click, press an arrow, swipe or pick a
// room on the map. Crossing on a parked pointer is an opt-in switch; when on,
// a dwell fills the sign first and each visit to an edge moves one room only.

const EDGE = 0.1;
const DWELL = 0.75;
let dwell = 0;
let armed = true;
let peek = [0, 0];
let peekHeld = 0;

// ── Toggles ──────────────────────────────────────────────────────────────
// All switches start on to preserve the default view. Kept in site.js so the page's
// own markup and stylesheet stay as they were.
const TOGGLES = [
  { key: "dust", label: "Time dust", hint: "threads of the current moment run out along the lattice" },
  { key: "structure", label: "Lattice", hint: "show or hide the fibre lattice" },
  { key: "construct", label: "Lattice follows the pointer", hint: "the corridors slide as you look around" },
  { key: "scene", label: "Room follows the pointer", hint: "the eye drifts with the pointer" },
  { key: "edge", label: "Cross at screen edge", hint: "rest the pointer at an edge to enter that room" },
  { key: "worldlabs", label: "Generated surroundings", hint: "when a room provides them" },
];
// Crossing on a parked pointer starts off: v2 drops switch states saved while it defaulted on.
const toggles = { construct: true, scene: true, edge: false, structure: true, worldlabs: true, dust: true };
try { Object.assign(toggles, JSON.parse(localStorage.getItem("tesseract.toggles.v2") || "{}")); } catch { /* private mode */ }
let overPanel = false;

function syncToggleEffects() {
  if (lattice) lattice.visible = toggles.structure;
}
syncToggleEffects();

(function buildTogglePanel() {
  const style = document.createElement("style");
  style.textContent = `
.toggles{position:fixed;z-index:9;left:clamp(20px,5vw,54px);top:78px;display:grid;justify-items:start;gap:6px;width:250px;font-family:var(--mono);font-size:10px;letter-spacing:.08em;pointer-events:auto;transition:opacity .4s var(--ease)}
.toggles summary{list-style:none;display:inline-flex;align-items:center;gap:9px;min-height:32px;padding:7px 12px;border:1px solid var(--line-strong);background:rgba(7,6,10,.55);backdrop-filter:blur(6px);cursor:pointer;font:500 9.5px var(--mono);letter-spacing:.24em;text-transform:uppercase;color:var(--muted);transition:border-color .25s,color .25s,background .25s}
.toggles summary::-webkit-details-marker{display:none}
.toggles summary::before{content:"";width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:translateY(-2px) rotate(45deg);transition:transform .3s var(--ease)}
.toggles[open] summary::before{transform:translateY(1px) rotate(-135deg)}
.toggles summary:hover,.toggles summary:focus-visible,.toggles[open] summary{border-color:var(--glow-soft);color:var(--ink);background:rgba(7,6,10,.8)}
.toggles summary:focus-visible{outline:1px solid var(--glow);outline-offset:3px}
.toggles button{display:grid;grid-template-columns:30px 1fr;gap:2px 11px;align-items:center;width:100%;text-align:left;padding:8px 11px;border:1px solid var(--line);background:rgba(7,6,10,.78);color:var(--muted);font:inherit;cursor:pointer;backdrop-filter:blur(8px);transition:border-color .25s,color .25s,background .25s}
.toggles[open] button{animation:toggleIn .38s var(--ease) both;animation-delay:calc(var(--i) * 28ms)}
@keyframes toggleIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.toggles button:hover,.toggles button:focus-visible{border-color:var(--glow-soft);color:var(--ink);outline:none}
.toggles .sw{grid-row:span 2;position:relative;width:30px;height:16px;border:1px solid var(--line-strong);border-radius:8px;background:rgba(238,242,250,.06);transition:background .25s,border-color .25s}
.toggles .sw::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--dim);transition:transform .25s var(--ease),background .25s}
.toggles button[aria-checked=true] .sw{background:var(--glow-soft);border-color:var(--glow)}
.toggles button[aria-checked=true] .sw::after{transform:translateX(14px);background:var(--glow-hot)}
.toggles button[aria-checked=true]{color:var(--ink)}
.toggles .name{font-size:10.5px;letter-spacing:.05em}
.toggles .name b{display:none}
.toggles .hint{font-size:9px;letter-spacing:.03em;color:var(--dim);line-height:1.35}
@media (max-width:900px){.toggles{left:auto;right:14px;top:auto;bottom:18px;display:flex;flex-direction:column-reverse;align-items:flex-end;width:min(250px,calc(100vw - 28px))}.toggles .hint{display:none}.toggles[open]{max-height:58vh;overflow-y:auto}}
@media (prefers-reduced-motion:reduce){.toggles[open] button{animation:none}}
body.panel-open .toggles,body.in-instrument .toggles{opacity:0;pointer-events:none}`;
  document.head.append(style);
  const panel = document.createElement("details");
  panel.className = "toggles";
  panel.setAttribute("aria-label", "View toggles");
  const summary = document.createElement("summary");
  summary.textContent = "View";
  panel.append(summary);
  // closed on every screen: the room comes first; the switches are one click away
  panel.open = false;
  TOGGLES.forEach((t, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "switch");
    button.dataset.toggle = t.key;
    button.style.setProperty("--i", i);
    button.innerHTML = `<span class="sw" aria-hidden="true"></span><span class="name">${t.label}<b></b></span><span class="hint">${t.hint}</span>`;
    const sync = () => {
      button.setAttribute("aria-checked", String(toggles[t.key]));
      button.querySelector("b").textContent = toggles[t.key] ? "ON" : "OFF";
    };
    button.addEventListener("click", () => {
      toggles[t.key] = !toggles[t.key];
      sync();
      syncToggleEffects();
      try { localStorage.setItem("tesseract.toggles.v2", JSON.stringify(toggles)); } catch { /* private mode */ }
    });
    sync();
    panel.append(button);
  });
  // a switch near the left edge must not also count as the pointer sitting in the edge band
  panel.addEventListener("pointerenter", () => { overPanel = true; });
  panel.addEventListener("pointerleave", () => { overPanel = false; });
  document.body.append(panel);
})();

function sceneOwnsInput(target) {
  return !galleryIsCovered() && !(target instanceof Element && target.closest("button:not(.edge):not(.door), a, input, textarea, select, summary, [contenteditable]:not([contenteditable=false]), .toggles, .hud"));
}

// Where the pointer is decides the peek: an edge band or a door sign leans the
// eye that way. A pointer parked over UI must come back to the scene's
// interior before the opt-in edge crossing re-arms.
let peekFromEdge = false;
window.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") return; // a finger has no hover: it taps, swipes or scrubs
  state.pointer.x = event.clientX / window.innerWidth;
  state.pointer.y = event.clientY / window.innerHeight;
  const way = event.target instanceof Element ? event.target.closest(".edge, .door") : null;
  if (way) {
    peek = [Number(way.dataset.dx || 0), Number(way.dataset.dy || 0)];
    peekFromEdge = way.classList.contains("edge");
    if (!peekFromEdge) { armed = false; dwell = 0; }
    return;
  }
  peek = [0, 0];
  peekFromEdge = false;
  if (!sceneOwnsInput(event.target)) { armed = false; dwell = 0; }
  else { armed = true; dwell = 0; }
}, { passive: true });
document.documentElement.addEventListener("mouseleave", () => { peek = [0, 0]; peekFromEdge = false; });

// The arrival sway of a plate room (see frame): on from each arrival until the
// visitor drags or scrubs, centred a little toward the eye (PLATE_YAW turns the
// picture away from it); `scrubbed` hands a Basic room's moments to the read head.
const SWAY = { centre: 0.1, yaw: 0.36, pitch: 0.06, period: 11, rise: 2.5 };
const sway = { on: false, t: 0, scrubbed: false };
const holdSway = () => { sway.on = false; };

// Left-drag on the construct turns the specimen in the current room. Mouse and
// pen only: a finger drag stays the time scrub.
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.pointerType === "touch") return;
  holdSway();
  state.drag = { x: event.clientX, y: event.clientY, spin: { ...state.spinTarget } };
  canvas.setPointerCapture(event.pointerId);
  document.body.classList.add("is-turning");
});
canvas.addEventListener("pointermove", (event) => {
  if (!state.drag) return;
  state.spinTarget.y = state.drag.spin.y + (event.clientX - state.drag.x) * 0.008;
  state.spinTarget.x = Math.max(-1.2, Math.min(1.2, state.drag.spin.x + (event.clientY - state.drag.y) * 0.006));
  // bounded specimens stop at their safe angles, with no dead zone to drag back out of
  const held = slotObjects[slotIndexFor(state.focus.x, state.focus.y)]?.userData;
  if (held?.shells) {
    state.spinTarget.y = clamp(state.spinTarget.y, -SHELL_VIEW.yaw - SHELL_VIEW.rest, SHELL_VIEW.yaw - SHELL_VIEW.rest);
    state.spinTarget.x = clamp(state.spinTarget.x, -SHELL_VIEW.down, SHELL_VIEW.up);
  } else if (held?.worldCell || held?.basicCell) {
    // a recorded place is one-sided: it turns far enough to part its layers,
    // never edge-on or round to its blank back
    state.spinTarget.y = clamp(state.spinTarget.y, -PLATE_TURN - PLATE_YAW, PLATE_TURN - PLATE_YAW);
    state.spinTarget.x = clamp(state.spinTarget.x, -0.5, 0.5);
  }
});
const endDrag = () => {
  state.drag = null;
  document.body.classList.remove("is-turning");
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("dblclick", () => { holdSway(); state.spinTarget = { x: 0, y: 0 }; });

function updateEdgeAffordance(kx, ky, charge) {
  for (const el of edgeEls) {
    const on = Number(el.dataset.dx || 0) === kx && Number(el.dataset.dy || 0) === ky && (kx || ky);
    el.classList.toggle("is-peek", Boolean(on));
  }
  for (const el of doorEls) {
    const on = Number(el.dataset.dx) === kx && Number(el.dataset.dy) === ky && (kx || ky);
    el.classList.toggle("is-peek", Boolean(on));
    el.style.setProperty("--charge", on ? charge : 0);
  }
}

// Scroll is the fourth axis: it drives the read head through the object's own
// time, not the document. There is no document to scroll — the page is a room.
function scrub(delta) {
  holdSway();
  sway.scrubbed = true;
  state.cutTarget = Math.min(1, Math.max(0.04, state.cutTarget + delta));
}

window.addEventListener("wheel", (event) => {
  if (!sceneOwnsInput(event.target)) return;
  event.preventDefault();
  scrub(-event.deltaY * 0.00085);
}, { passive: false });

// Touch: a vertical drag scrubs time (as before); a horizontal swipe crosses
// to the room on that side, like turning a page. The axis locks on the first
// few pixels so a scrub never drifts sideways into a crossing.
let touch = null;
function resetSceneInput() {
  armed = false;
  dwell = 0;
  touch = null;
  state.drag = null;
  document.body.classList.remove("is-turning");
}
window.addEventListener("touchstart", (event) => {
  const t = event.touches[0];
  touch = !(event.target instanceof Element && event.target.closest(".t-rail")) && sceneOwnsInput(event.target) && event.touches.length === 1 ? { x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, axis: null } : null;
}, { passive: true });
window.addEventListener("touchmove", (event) => {
  if (touch === null || !sceneOwnsInput(event.target) || event.touches.length !== 1) { touch = null; return; }
  const { clientX: x, clientY: y } = event.touches[0];
  if (!touch.axis && Math.hypot(x - touch.x0, y - touch.y0) > 12) touch.axis = Math.abs(x - touch.x0) > Math.abs(y - touch.y0) * 1.2 ? "x" : "y";
  if (touch.axis === "y") scrub((y - touch.y) * 0.0016);
  touch.x = x;
  touch.y = y;
}, { passive: true });
window.addEventListener("touchend", () => {
  if (touch?.axis === "x" && Math.abs(touch.x - touch.x0) > 48) travel(touch.x < touch.x0 ? 1 : -1, 0);
  touch = null;
}, { passive: true });
window.addEventListener("touchcancel", () => { touch = null; }, { passive: true });

const WAYFINDING = ".map, .doors, .plaque-actions";
window.addEventListener("keydown", (event) => {
  const wayfinding = event.target instanceof Element && event.target.closest(WAYFINDING) && !galleryIsCovered() && event.key.startsWith("Arrow");
  if ((!sceneOwnsInput(event.target) && !wayfinding) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === "arrowleft" || key === "a") travel(-1, 0);
  else if (key === "arrowright" || key === "d") travel(1, 0);
  else if (key === "arrowup" || key === "w") travel(0, 1);
  else if (key === "arrowdown" || key === "s") travel(0, -1);
  else if (key === "[" || key === "pagedown") scrub(-0.08);
  else if (key === "]" || key === "pageup") scrub(0.08);
  else return;
  event.preventDefault();
});

// The t rail is a handle too: drag it (or focus it and use the arrow keys) to
// move the read head, for anyone who never thinks to scroll.
const tRail = $("#tBar");
let lastPct = -1;
function railTo(clientY) {
  const r = tRail.querySelector(".t-track").getBoundingClientRect();
  scrub(0);
  state.cutTarget = clamp(1 - (clientY - r.top) / r.height, 0.04, 1);
}
tRail.addEventListener("pointerdown", (event) => {
  if (galleryIsCovered()) return;
  event.preventDefault();
  tRail.setPointerCapture(event.pointerId);
  tRail.classList.add("is-held");
  railTo(event.clientY);
});
tRail.addEventListener("pointermove", (event) => { if (tRail.hasPointerCapture(event.pointerId)) railTo(event.clientY); });
const releaseRail = () => tRail.classList.remove("is-held");
tRail.addEventListener("pointerup", releaseRail);
tRail.addEventListener("pointercancel", releaseRail);
tRail.addEventListener("keydown", (event) => {
  const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05, PageUp: 0.15, PageDown: -0.15 }[event.key];
  if (step) scrub(step);
  else if (event.key === "Home") state.cutTarget = 0.04;
  else if (event.key === "End") state.cutTarget = 1;
  else return;
  event.preventDefault();
});

const edgeEls = $$(".edge");
const doorEls = $$(".door");
[...edgeEls, ...doorEls].forEach((el) => {
  el.addEventListener("click", (event) => {
    travel(Number(el.dataset.dx || 0), Number(el.dataset.dy || 0));
    if (event.detail > 0) canvas.focus({ preventScroll: true }); // a pointer click: the keys go back to the scene
  });
});

// ── Frame ────────────────────────────────────────────────────────────────

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  bloom.resolution.set(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(dustView);
  plaqueBox = null;
}
window.addEventListener("resize", resize);
resize();

const target = new THREE.Vector3();
const centre = new THREE.Vector3();
let last = performance.now();

// ── The title ────────────────────────────────────────────────────────────
// What this is, in one glance: it covers loading and the way in, holds long
// enough to read on a first visit, and goes at the first touch of anything.
let sceneWarm = false, sceneShown = false, titleGone = false;
const firstVisit = (() => { try { return !localStorage.getItem("construct.seen.v1"); } catch { return true; } })();
// The way in on a first visit: under the title, the construct draws itself out
// from the room ahead, fibre by fibre, and the push in waits for the near
// frames. Return visits, reduced motion and software rendering skip it.
const BUILD_TIME = 3, BUILD_PUSH = 32;
const build = { on: firstVisit && !reduced && !softwareGraphics && new URLSearchParams(location.search).get("build") !== "off", start: 0, u: 0, last: 0, rush: false };
latticeUniforms.uBuild.value = build.on ? 0 : BUILT;
function stepBuild(now) {
  if (!build.on || !sceneShown) return;
  // wall time, not frame time, so a slow load never stretches it; any input
  // (the title going) finishes it at three times the pace
  build.last ||= now;
  build.u = Math.min(1, build.u + (now - build.last) / 1000 / BUILD_TIME * (build.rush ? 3 : 1));
  build.last = now;
  const u = build.u;
  // an even pace through the rooms you can see, then a rush out into the haze
  latticeUniforms.uBuild.value = u >= 1 ? BUILT : u < 0.9 ? 38 * u : 34.2 + (u - 0.9) * 608;
  latticeUniforms.uBuildAt.value.set(state.cam.x, state.cam.y, 0);
  if (u >= 1) build.on = false;
}
const titleCard = $("#titleCard");
function dropTitle() {
  if (titleGone) return;
  titleGone = true;
  sceneWarm = true;
  build.rush = true;
  titleCard?.classList.add("is-out");
  setTimeout(() => titleCard?.classList.add("is-gone"), 950);
  try { localStorage.setItem("construct.seen.v1", "1"); } catch { /* private window: show it again next time */ }
  if (firstVisit) {
    document.body.classList.add("first-look");
    setTimeout(() => document.body.classList.remove("first-look"), 4200);
  }
}
for (const type of ["wheel", "keydown", "pointerdown", "touchstart"]) {
  window.addEventListener(type, () => { if (sceneShown) dropTitle(); }, { capture: true, passive: true });
}
function stepTitle() {
  if (!sceneShown && lattice) {
    sceneShown = true;
    document.body.classList.add("scene-ready");
  }
  if (titleGone) return;
  // a first visit reads it for at least ~4 s from page start; a return visit only waits for the rooms
  const ready = state.entry >= 1 ? sceneWarm : state.entry >= (firstVisit ? 0.85 : 0.05);
  if (sceneShown && ready && performance.now() > (firstVisit ? 4200 : 0)) dropTitle();
}

// The construct's frame goes through ACES filmic and bloom as a whole, so a
// light-furred row (a pale brown animal, a white deer) came out cream-grey and
// hazy where view-lite shows its real colour. Re-grade the row each frame after its read
// head has set its own tone: a saturation lift that offsets ACES's highlight
// desaturation, and a brightness trim that keeps the fur under the bloom
// threshold. A black cat barely changes; the setting is per frame, never
// compounding, because tickChrono rewrites both values first.
const CONSTRUCT_SAT = 1.3, CONSTRUCT_TONE = 0.9;
function gradeChronoForConstruct(group, light = 1) {
  for (const mesh of group.children) {
    if (mesh.userData.order === undefined || !mesh.visible) continue;
    const u = mesh.material.userData;
    if (u?.uSat) u.uSat.value *= CONSTRUCT_SAT;
    mesh.material.color.multiplyScalar(CONSTRUCT_TONE * light);
  }
}

// A chrono row hides the poses after its read head, so centring the whole row
// left the visible part hugging one wall. Centre the span from the first pose
// to the head instead, eased so the row glides as you scrub.
const chronoWant = new THREE.Vector3();
function chronoCentre(group, cut, delta, out) {
  const u = group.userData;
  const head = Math.max(1, Math.round((u.count || 1) * cut)) - 1;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const mesh of group.children) {
    const order = mesh.userData.order;
    if (order === undefined || order > head) continue;
    const x = mesh.userData.baseX ?? mesh.position.x, z = mesh.userData.baseZ ?? mesh.position.z;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  if (!Number.isFinite(x0)) return out.set(0, 0, 0);
  chronoWant.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  if (!u.viewCentre) u.viewCentre = chronoWant.clone();
  else u.viewCentre.lerp(chronoWant, Math.min(1, delta * 4));
  return out.copy(u.viewCentre).applyEuler(group.rotation);
}

function galleryIsCovered() {
  const viewer = $("#viewer");
  return document.hidden || document.body.classList.contains("in-instrument") || Boolean(viewer && !viewer.classList.contains("is-hidden"));
}

let softwareFramePending = false, softwareIdleUntil = 0;
function galleryMayDraw(now) {
  // Acknowledge the previous frame on the NEXT rAF: software compositing can
  // finish well after composer.render() returns. Leave the UI a real idle gap.
  if (softwareFramePending) {
    softwareFramePending = false;
    softwareIdleUntil = performance.now() + 250;
  }
  return !galleryIsCovered() && (!softwareGraphics || now >= softwareIdleUntil);
}

// ── Quality ──────────────────────────────────────────────────────────────
// On hardware that cannot keep up, the construct steps down rather than
// stutter: first a coarser buffer, then no bloom, plain fibres (no hairline
// threads or glints), no light shafts, half the dust
// threads and no strand-parting on glides, then a coarser buffer still and
// fewer strands: the beams keep their cores and broad spines and drop
// hairlines (half of them at "low", all of them at "minimal").
// Software rendering starts at the bottom. Only frames at rest are measured.
const QUALITY = [
  { name: "high", ratio: 1.75, bloom: true, detail: 1, extras: true, dust: 1, strands: "all" },
  { name: "medium", ratio: 1, bloom: true, detail: 1, extras: true, dust: 1, strands: "all" },
  { name: "low", ratio: 0.8, bloom: false, detail: 0, extras: false, dust: 0.5, strands: "most" },
  { name: "minimal", ratio: 0.5, bloom: false, detail: 0, extras: false, dust: 0.5, strands: "spines" },
];
const askedQuality = QUALITY.findIndex((q) => q.name === new URLSearchParams(location.search).get("quality"));
let quality = askedQuality >= 0 ? askedQuality : softwareGraphics ? QUALITY.length - 1 : 0;
const qualityRatio = (level) => Math.min(window.devicePixelRatio, QUALITY[level].ratio);
function applyQuality() {
  const q = QUALITY[quality];
  const ratio = qualityRatio(quality);
  if (renderer.getPixelRatio() !== ratio) {
    renderer.setPixelRatio(ratio);
    composer.setPixelRatio(ratio);
    resize();
  }
  bloom.enabled = q.bloom;
  latticeUniforms.uDetail.value = q.detail;
  if (lattice) {
    for (const shaft of lattice.children) shaft.visible = q.extras;
    lattice.count = lattice.userData.strands?.[q.strands] ?? lattice.count;
  }
  setDustDensity(q.dust);
  canvas.dataset.quality = q.name;
}
const pace = { frames: [], slow: 0, settleUntil: 0 };
function watchPace(now, interval) {
  if (quality >= QUALITY.length - 1) return;
  const resting = !document.hidden && !galleryIsCovered() && titleGone && state.entry >= 1 && state.travelling < 0.01 && glide.t >= glide.dur;
  if (!resting || now < pace.settleUntil) { pace.frames.length = 0; return; }
  pace.frames.push(interval);
  if (pace.frames.length < 90) return;
  const median = pace.frames.sort((a, b) => a - b)[45];
  pace.frames.length = 0;
  pace.slow = median > 25 ? pace.slow + 1 : 0;
  if (pace.slow < 2) return;
  pace.slow = 0;
  // skip a step that would change nothing on this screen (a 1x screen has no
  // coarser buffer at "medium")
  const before = qualityRatio(quality);
  quality += 1;
  if (quality < QUALITY.length - 1 && qualityRatio(quality) === before && QUALITY[quality].bloom) quality += 1;
  applyQuality();
  pace.settleUntil = now + 2000;
}

function frame(now) {
  requestAnimationFrame(frame);
  watchPace(now, now - last);
  const delta = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (!reduced) state.time += delta;
  const t = state.time;

  // A covered gallery never arms navigation. Only a deliberate pointer return to the scene re-arms it.
  const sceneLive = !(galleryIsCovered() || overPanel || state.drag);
  if (!sceneLive) { armed = false; dwell = 0; }
  const [kx, ky] = sceneLive && state.entry >= 1 ? peek : [0, 0];
  if (toggles.edge && armed && peekFromEdge && (kx || ky)) {
    dwell += delta;
    if (dwell > DWELL) {
      travel(kx, ky);
      dwell = 0;
      armed = false;
    }
  } else {
    dwell = Math.max(0, dwell - delta * 2.5);
  }
  updateEdgeAffordance(kx, ky, toggles.edge ? Math.min(1, dwell / DWELL).toFixed(3) : 0);
  // the lean is a camera move: it waits for a moment of intent (a pointer
  // passing through a band does nothing), and reduced motion keeps only the lit sign
  peekHeld = kx || ky ? peekHeld + delta : 0;
  const leaning = !reduced && peekHeld > 0.28;
  const leanEase = Math.min(1, delta * 2.2);
  state.lean.x += ((leaning ? kx : 0) - state.lean.x) * leanEase;
  state.lean.y += ((leaning ? ky : 0) - state.lean.y) * leanEase;

  // glide toward the focused cell
  const s = stepGlide(delta);
  const goalX = state.focus.x * CELL;
  const goalY = state.focus.y * CELL;
  state.travelling = Math.min(1, Math.hypot(goalX - state.cam.x, goalY - state.cam.y) / CELL);

  // the way in: a slow push through the window frame out of thick haze,
  // unrolling as it settles; the HUD follows
  stepTitle();
  stepBuild(now);
  if (state.entry < 1 && sceneWarm && (!build.on || latticeUniforms.uBuild.value > BUILD_PUSH)) {
    state.entry = Math.min(1, state.entry + delta / INTRO_TIME);
    if (state.entry > 0.62) document.body.classList.remove("is-intro");
  }
  const entry = 1 - Math.pow(1 - state.entry, 3);
  const fall = (1 - entry) * 2.2;
  const introBack = (1 - entry) * 8.5;
  latticeUniforms.uFogDensity.value = FOG_DENSITY * (1 + 1.8 * (1 - smoother(Math.min(1, state.entry * 1.6))));

  // the pointer moves the eye, not just the gaze: near rims slide across the
  // corridors behind them, which is where the depth comes from
  const px = reduced ? 0 : state.pointer.x - 0.5;
  const py = reduced ? 0 : 0.5 - state.pointer.y;
  // while turning a specimen the eye holds still, so only the object moves
  if (!state.drag) {
    state.look.x += (px - state.look.x) * Math.min(1, delta * 2.2);
    state.look.y += (py - state.look.y) * Math.min(1, delta * 2.2);
  }

  const followEase = Math.min(1, delta * 4);
  state.follow.construct += ((toggles.construct ? 1 : 0) - state.follow.construct) * followEase;
  state.follow.scene += ((toggles.scene ? 1 : 0) - state.follow.scene) * followEase;
  const lookX = state.look.x * state.follow.construct;
  const lookY = state.look.y * state.follow.construct;

  // weightless drift, so there is parallax even with a still hand
  const floatX = Math.sin(t * 0.21) * 0.55 + Math.sin(t * 0.07) * 0.4;
  const floatY = Math.sin(t * 0.17 + 1.3) * 0.4;
  const floatZ = Math.sin(t * 0.13 + 0.4) * 0.7;

  // one room back from the specimen: you look through the window you are
  // standing behind into its room, with the corridors running off around it.
  // That window's frame beams sit just in front of the resting eye (their
  // face is at z = 23.25), so the eye's sideways reach is soft-limited to the
  // window's opening: a pointer in a corner or a lean never parks a beam in
  // your face. A glide pulls back from the frame (state.arc) and banks a touch.
  const standoff = REST_STANDOFF + state.arc * DOLLY + introBack;
  const eyeX = softLimit(2.4 + lookX * 5 + floatX, EYE_REACH);
  const eyeY = softLimit(1.7 + lookY * 4 + floatY, EYE_REACH);
  // the resting eye sits high and to one side with a slight Dutch tilt, so
  // the bundles cross the frame on diagonals as they do in the film
  camera.position.set(state.cam.x + eyeX, state.cam.y + eyeY + fall, Math.min(standoff + floatZ, 31.9));
  // look where you are going: the gaze leads a glide and follows a lean
  const lead = bump(s) * 0.35;
  target.set(
    state.cam.x + lookX * 2.2 + state.lean.x * 1.6 + (glide.to.x - state.cam.x) * lead,
    state.cam.y + lookY * 1.4 + state.lean.y * 1.2 + (glide.to.y - state.cam.y) * lead + fall * 0.55,
    0
  );
  camera.lookAt(target);
  state.bank = -state.travelDir.x * 0.045 * state.arc;
  camera.rotateZ(-0.07 + state.bank + Math.sin(t * 0.11) * 0.012 + (1 - entry) * 0.32);
  camera.updateMatrixWorld();
  placeDoors();

  // the construct slides under the camera one layout period at a time, so it
  // never ends; colour comes from world position, so nothing changes hands
  if (lattice) {
    const step = CELL * PERIOD;
    lattice.position.set(Math.round(state.cam.x / step) * step, Math.round(state.cam.y / step) * step, 0);
    // mid-glide the beams you pass through part into threads
    const clear = reduced || softwareGraphics || !QUALITY[quality].extras ? 0 : 0.95 * smoother(Math.min(1, state.arc * 1.5));
    latticeUniforms.uNearClear.value = clear;
    const material = clear > 0.01 ? lattice.userData.clearMaterial : lattice.userData.baseMaterial;
    if (lattice.material !== material) lattice.material = material;
  }
  // it belongs to the room you are in, so it fades out while you cross
  voidPlane.position.set(state.focus.x * CELL, state.focus.y * CELL, -CELL / 2);
  voidPlane.material.uniforms.uAlpha.value = Math.max(0, 1 - state.travelling * 2.5);
  latticeUniforms.uTime.value = t;
  latticeUniforms.uFocus.value.set(state.cam.x, state.cam.y, 0);

  // the read head. Arriving in a room plays its time in: the head waits at
  // the start until the room is in view, then sweeps up to where you left it
  if (state.arrival > 0 && glide.t < glide.dur * 0.45) state.cut = 0.04;
  else {
    state.cut += (state.cutTarget - state.cut) * Math.min(1, delta * (state.arrival > 0 ? 2.4 : 7));
    state.arrival = Math.max(0, state.arrival - delta);
  }
  // a plate room shows it is more than a picture: until the visitor drags or
  // scrubs, it turns slowly back and forth, so the subject parts from its place
  const plateHeld = slotObjects[slotIndexFor(state.focus.x, state.focus.y)]?.userData;
  if (sway.on && !state.drag && (plateHeld?.worldCell || plateHeld?.basicCell) && state.travelling < 0.02) {
    sway.t += delta;
    const rise = smoother(Math.min(1, sway.t / SWAY.rise)), w = (2 * Math.PI) / SWAY.period;
    state.spinTarget.y = rise * (SWAY.centre + SWAY.yaw * Math.sin(sway.t * w));
    state.spinTarget.x = SWAY.pitch * rise * Math.sin(sway.t * w * 0.62);
  }
  const turn = Math.min(1, delta * 9);
  state.spin.x += (state.spinTarget.x - state.spin.x) * turn;
  state.spin.y += (state.spinTarget.y - state.spin.y) * turn;
  const focused = focusSlot();
  SLOTS.forEach((slot, i) => {
    const group = slotObjects[i];
    if (!group) return;
    const isFocus = slot === focused;
    const u = group.userData;
    // a room you leave keeps the moment it showed, rather than snapping to its whole run
    if (isFocus) u.heldCut = state.cut;
    const cut = isFocus ? state.cut : u.heldCut ?? 1;
    // Chrono rows drive their own read head (opaque poses, live now-pose);
    // basic diorama cells cycle their subject atlas on gallery time;
    // every other cell type keeps the legacy slice fade.
    // a room hangs in the first time you see it: it settles from a little
    // above, grows to size and (for a chrono row) brightens out of the dark
    if (u.hangIn < 1 && (reduced || softwareGraphics)) u.hangIn = 1;
    const hung = u.hangIn === undefined ? 1 : 1 - Math.pow(1 - u.hangIn, 3);
    if (group.userData.chrono) { tickChrono(group, cut, t); gradeChronoForConstruct(group, hung); }
    // (once you scrub in its room, a diorama follows the read head instead)
    else if (group.userData.basicCell) tickBasicCell(group, isFocus && sway.scrubbed ? Math.min(cut, 0.999) * u.basic.duration : t);
    else if (group.userData.worldCell) { if (isFocus) wakeWorldCell(group); tickWorldCell(group, cut); }
    else setCut(group, cut);
    const cell = slot.cell || { x: 0, y: 0 };
    // Keep whatever part of the stack is visible centred in its block, so it
    // never pierces the walls at any cut: the visible slices span local z
    // [-d/2, -d/2 + cut*d], and that span's centre is rotated by the yaw.
    // A chrono row is pre-centred (visible poses are always a subset of a
    // room-fitting row), so it needs no shift.
    const spinX = isFocus ? state.spin.x : 0, spinY = isFocus ? state.spin.y : 0;
    if (group.userData.shells) {
      group.rotation.set(clamp(spinX, -SHELL_VIEW.down, SHELL_VIEW.up), SHELL_VIEW.rest + clamp(spinY, -SHELL_VIEW.yaw - SHELL_VIEW.rest, SHELL_VIEW.yaw - SHELL_VIEW.rest), 0);
    } else if (group.userData.worldCell || group.userData.basicCell) {
      // a recorded place is a picture first: rest nearly face-on, so the
      // animal is legible before the visitor turns it to see the layers part
      group.rotation.set(spinX, PLATE_YAW + spinY, 0);
    } else {
      if (u.chrono) u.restYaw = chronoRestYaw(group, camera.aspect);
      group.rotation.set(spinX, (u.restYaw ?? YAW) + spinY, 0);
    }
    // the visible part of the stack turns about its own centre
    if (group.userData.chrono) chronoCentre(group, cut, delta, centre);
    else centre.set(0, 0, group.userData.depth * (cut - 1) / 2).applyEuler(group.rotation);
    const distanceToCell = Math.hypot(cell.x * CELL - state.cam.x, cell.y * CELL - state.cam.y);
    const plateRoom = group.userData.worldCell || group.userData.basicCell;
    const focusWeight = group.userData.chrono || plateRoom ? Math.max(0, 1 - distanceToCell / (CELL * 0.75)) : 0;
    const focusZ = focusWeight > 0 ? focusWeight * (plateRoom ? focusZForPlate(group, camera.aspect) : focusZForChrono(group, camera.aspect)) : 0;
    // a subject pulled toward the eye slides onto the resting line of sight, so
    // it hangs centred in the frame instead of off by the eye's sideways offset
    const onSight = focusZ / REST_STANDOFF;
    group.position.set(cell.x * CELL - centre.x + REST_EYE.x * onSight, cell.y * CELL - centre.y + REST_EYE.y * onSight + (1 - hung) * 1.8, SPECIMEN_Z + focusZ - centre.z);
    group.scale.setScalar(0.9 + 0.1 * hung);
    // a specimen shows only in the room you are in, or the one you are entering
    group.visible = distanceToCell < CELL * 0.75;
    if (group.visible && u.hangIn < 1 && state.entry > 0.5) u.hangIn = Math.min(1, u.hangIn + delta / 1.1);
    const backdrop = slotBackdrops[i];
    if (backdrop) {
      backdrop.visible = group.visible;
      backdrop.position.copy(group.position);
      backdrop.rotation.copy(group.rotation);
      if (group.visible) syncShellBackdrop(group, cut);
    }
    const strings = slotStrings[i];
    if (strings) {
      strings.visible = group.visible && isFocus;
      if (strings.visible) syncStrings(strings, group, cut, t, Math.max(0, 1 - state.travelling * 2.5));
    }
    const dust = slotDust[i];
    if (dust) {
      dust.visible = group.visible && isFocus && toggles.dust;
      // the threads draw out from the subject each time you arrive in its room
      const settled = dust.visible && state.travelling < 0.02 && hung > 0.3;
      dust.userData.reach = reduced ? 1 : settled ? Math.min(1, (dust.userData.reach ?? 0) + delta / 1.4) : 0;
      if (dust.visible) {
        syncDust(dust, group, {
          cut, time: t, delta, alpha: Math.max(0, 1 - state.travelling * 2.5) * hung * (dust.userData.fade = Math.min(1, (dust.userData.fade ?? 1) + delta / 0.9)),
          centre: { x: cell.x * CELL, y: cell.y * CELL }, half: OPEN / 2, pixel: renderer.getPixelRatio(), view: dustView,
          reach: 1 - Math.pow(1 - dust.userData.reach, 3),
        });
      }
    }
  });

  updatePortal();

  const pct = Math.round(state.cut * 100);
  if (pct !== lastPct) {
    lastPct = pct;
    $("#cutReadout").textContent = `${pct}%`;
    tRail.setAttribute("aria-valuenow", String(pct));
  }
  tRail.style.setProperty("--t", state.cut.toFixed(3));

  // Keep clocks/navigation current, but don't compete with forms or the
  // embedded viewer for GPU time. The last gallery frame remains underneath.
  if (galleryMayDraw(now)) {
    composer.render();
    softwareFramePending = softwareGraphics;
  }
}

// ── The instrument ───────────────────────────────────────────────────────
// A generated volume is not shown in a separate viewer; it is installed into
// the block you were standing in, so the thing you made joins the construct.

// ── The studio ─────────────────────────────────────────────────────────
// Tier studio in your cell: upload -> Muse Spark routing -> SAM 3.1 object
// picking (1-3) -> job -> progress -> viewer. Plus My builds and the public
// gallery hanging in the empty rooms. (Replaces the legacy instrument.)

const ST = {
  apiBase: new URLSearchParams(location.search).get("api") || "",
  me: null,
  meKnown: false,
  upload: null,
  video: null,
  videoUrl: null,
  route: null,
  detectTime: 0,
  objects: [],
  indexMap: null,
  hoverId: 0,
  selected: [],
  selectionToken: null,
  requestTicket: 0,
  detectBusy: false,
  retryRequest: null,
  boxMode: false,
  boxStart: null,
  boxCursor: { x: 0.25, y: 0.25 },
  pickAfter: 0,
  jobId: null,
  pollTimer: 0,
  lastResult: null,
  lastViewer: null,
  builds: [],
};

const apiUrl = (path) => `${ST.apiBase}${path}`;
const assetUrl = (path) => apiUrl(`/${String(path).replace(/^\/+/, "")}`);
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const chosenTier = () => document.querySelector('input[name="tier"]:checked')?.value || "lite";

let toastVersion = 0;
function toast(message, timeout = 0) {
  const version = ++toastVersion;
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("is-visible");
  if (timeout) window.setTimeout(() => { if (version === toastVersion) el.classList.remove("is-visible"); }, timeout);
}

function fmtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

const STUDIO_STEPS = ["stepAuth", "stepUpload", "stepRoute", "stepFrame", "stepWorking", "stepDone"];
// Forward path for a user who went back to change tiers: visible only when
// the current upload already has a route.
function syncUploadContinue() {
  const ok = Boolean(ST.upload && ST.route && ST.routeFor === ST.upload.uploadId);
  $("#uploadContinue").classList.toggle("is-hidden", !ok);
}
function showStep(id) {
  STUDIO_STEPS.forEach((step) => $(`#${step}`).classList.toggle("is-hidden", step !== id));
  currentStep = id;
  syncStudio();
  if (id === "stepUpload") syncUploadContinue();
  const heading = $(`#${id} h2`);
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    // a step that changes while you walk (a build finishing) must not pull
    // focus into the closed panel and away from the construct
    if (studioOpen && focusSlot().kind === "instrument") heading.focus({ preventScroll: true });
  }
}

// Server-written text is already user-safe, but it is never injected as HTML.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Provenance chips for a result meta: 'SAM 3.1 tracking · Muse Spark: wildlife · fixed camera'.
function provChips(meta = {}) {
  const out = [];
  const prov = meta.provenance || [];
  if (prov.some((p) => String(p).startsWith("sam"))) out.push("SAM 3.1 tracking");
  if (prov.some((p) => String(p).startsWith("muse-image"))) out.push("Muse Image plate");
  if (prov.some((p) => String(p).startsWith("muse-spark"))) {
    const known = (v) => v && !["unknown", "other"].includes(v);
    const cam = known(meta.camera) ? meta.camera : "";
    const cat = known(meta.category) ? meta.category : "";
    out.push(cat || cam ? `Muse Spark: ${[cat.replace(/-/g, " "), cam && `${cam} camera`].filter(Boolean).join(" · ")}` : "Muse Spark: clip check");
  }
  return out;
}

// A build's title in product words. The studio names a build "<subject> <tier>" ("animal basic",
// kept or renamed by the runners); it reads "Animal · cloud trail". Other titles are shown as they are.
function buildTitle(title, fallback = "") {
  const text = String(title || "").trim();
  const m = text.match(/^(.+) (lite|basic|advanced)$/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} · ${TIER_FORM[m[2].toLowerCase()]}` : text || fallback;
}

// Budget/capacity/kill-switch messages are polite server-side and final for
// today; everything else is transient and a retry is honest.
function budgetLike(message) {
  return /budget|capacity|kill switch|temporarily disabled|limit reached/i.test(String(message || ""));
}

async function stFetch(path, options = {}) {
  const res = await fetch(apiUrl(path), { ...options, headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) }, body: options.body });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || `Request failed (${res.status}).`);
    error.status = res.status;
    throw error;
  }
  return body;
}
const stGet = (path) => stFetch(path);
const stPost = (path, body) => stFetch(path, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body || {}) });

function syncAuthStep() {
  if (!ST.meKnown) return;
  if (!ST.me && focusSlot().kind === "instrument") showStep("stepAuth");
}

async function checkBackend() {
  const el = $("#backendState");
  try {
    const res = await fetch(apiUrl("/api/health"), { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error();
    el.textContent = "studio online";
    el.title = "The studio is online: you can build";
    el.className = "backend-state is-ok";
  } catch {
    el.textContent = "studio offline";
    el.className = "backend-state is-down";
  }
}

function updateNet() {
  if (!navigator.onLine) {
    $("#backendState").textContent = "offline";
    $("#backendState").className = "backend-state is-down";
    toast("You are offline. The lattice keeps its baked rooms; building needs a connection.", 4000);
  } else checkBackend();
}

async function loadMe() {
  try {
    const res = await fetch(apiUrl("/api/me"));
    ST.meKnown = true;
    if (res.status === 401) {
      ST.me = null;
    } else if (!res.ok) {
      ST.me = null;
    } else {
      ST.me = await res.json();
    }
  } catch {
    ST.meKnown = true;
    ST.me = null;
  }
  const me = ST.me;
  ST.maintenance = Boolean(me && me.maintenance);
  $("#meRow").hidden = !me;
  $("#maintBanner").classList.toggle("is-hidden", !ST.maintenance);
  if (me) {
    $("#meLine").textContent = `signed in as ${me.email}`;
    $("#adminWrap").hidden = me.role !== "owner";
  }
  updateWorkerLine();
  syncAuthStep();
  return me;
}

function updateWorkerLine() {
  const line = $("#workerLine");
  if (chosenTier() !== "advanced") {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  if (ST.me?.live) { line.textContent = "Advanced builds on this server, live: you pick the start frame and your subjects, then watch every stage happen."; return; }
  const w = ST.me?.worker;
  if (!w) line.textContent = "Advanced runs on our GPU worker — we email your sign-in address when it is ready.";
  else if (w.online) line.textContent = "GPU worker online — Advanced jobs queue according to load; we email you when yours is ready.";
  else line.textContent = "GPU worker offline — Advanced will queue until it returns; we email you when yours is ready.";
}

// ── upload ─────────────────────────────────────────────────────────────

// The drop zone says what is happening to the clip you gave it: waiting for
// the rights tick, then uploading. A clip given before the tick is kept and
// sent the moment the box is ticked, so the first try is never a dead end.
let pendingClip = null;
function dropState(mode, name = "") {
  const zone = $("#dropZone");
  zone.classList.toggle("is-busy", mode === "busy");
  zone.classList.toggle("is-waiting", mode === "waiting");
  zone.setAttribute("aria-busy", String(mode === "busy"));
  $("#dropTitle").textContent = mode === "busy" ? `Uploading ${name}…` : mode === "waiting" ? `${name} is ready to send` : "Drop a clip here";
  $("#dropHint").textContent = mode === "busy" ? "Spark reads it next" : mode === "waiting" ? "tick the rights box below to send it" : "mp4 · mov · webm — or browse";
}
// the ask ends with its notice already gone, so the notice never flashes
// into view as the box stops asking
function endAsk() {
  const consent = $(".consent");
  if (!consent.classList.contains("is-asking")) return;
  $("#toast").classList.remove("is-visible");
  void $("#toast").offsetWidth;
  consent.classList.remove("is-asking");
}
async function takeClip(file) {
  if (!file) return;
  endAsk(); // asked again below if the box is still unticked
  dropState("busy", file.name);
  try {
    await loadFile(file);
  } finally {
    if (pendingClip) dropState("waiting", pendingClip.name);
    else dropState("idle");
  }
}

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    toast("Choose a video file to continue.", 2800);
    return;
  }
  if (!$("#rightsBox").checked) {
    // the clip is kept, not dropped: ticking the box sends it
    pendingClip = file;
    toast("Tick the rights box first — your clip is sent as soon as you do.", 3200);
    const consent = $(".consent");
    consent.classList.remove("is-asking");
    void consent.offsetWidth; // restart the flag's pulse on a second try
    consent.classList.add("is-asking");
    consent.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    $("#rightsBox").focus({ preventScroll: true });
    return;
  }
  pendingClip = null;
  if (!ST.me) {
    showStep("stepAuth");
    toast("Sign in first, then drop your clip.", 3500);
    return;
  }
  if (ST.videoUrl) URL.revokeObjectURL(ST.videoUrl);
  ST.videoUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = ST.videoUrl;
  try {
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("unreadable")), { once: true });
    });
  } catch {
    toast("Could not read that video. Try an mp4, mov or webm clip.", 4500);
    return;
  }
  ST.video = video;
  toast("Uploading…");
  const form = new FormData();
  form.append("video", file);
  form.append("rights", "1");
  let info;
  try {
    const res = await fetch(apiUrl("/api/upload"), { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Upload failed.");
    info = body;
  } catch (error) {
    if (ST.video !== video) return;
    toast(`Upload failed: ${error.message}`, 5000);
    return;
  }
  if (ST.video !== video) return; // A newer upload owns the picker and its notice.
  if ($("#toast").textContent === "Uploading…") $("#toast").classList.remove("is-visible");
  ST.upload = info;
  ST.tierManual = false;
  ST.routeFor = null;
  syncUploadContinue();
  const preview = $("#previewCanvas");
  preview.width = video.videoWidth || info.width;
  preview.height = video.videoHeight || info.height;
  const hover = $("#hoverCanvas");
  hover.width = preview.width;
  hover.height = preview.height;
  const scrubber = $("#scrubber");
  scrubber.min = 0;
  scrubber.max = Math.max(0.1, video.duration || info.duration);
  scrubber.step = 1 / (info.fps || 30);
  scrubber.value = 0;
  $("#timeReadout").textContent = fmtTime(0);
  resetSelection();
  await seekAndDraw(0);
  runRoute();
}

function seekAndDraw(time) {
  return new Promise((resolve) => {
    const video = ST.video;
    if (!video) return resolve();
    let timer;
    const finish = (draw) => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      if (draw && ST.video === video) try {
        $("#previewCanvas").getContext("2d").drawImage(video, 0, 0, $("#previewCanvas").width, $("#previewCanvas").height);
      } catch { /* cross-origin sample; the server still sees it */ }
      resolve();
    };
    const onSeeked = () => finish(true);
    video.addEventListener("seeked", onSeeked);
    video.currentTime = Math.max(0, Math.min(time, video.duration || time));
    timer = window.setTimeout(() => finish(false), 2500);
  });
}

// ── route (Muse Spark) ─────────────────────────────────────────────────

async function runRoute() {
  showStep("stepRoute");
  $("#routeTitle").textContent = "Reading your clip…";
  $("#routeCard").innerHTML = `<p class="microcopy dim">Muse Spark checks the category, camera and likely subjects before the main build.</p>`;
  $("#routeGo").disabled = true;
  ST.routeError = null;
  try {
    ST.route = await stPost("/api/route", { uploadId: ST.upload.uploadId });
  } catch (error) {
    // Routing never blocks: fall back to permissive defaults but keep the
    // failure visible in the card (budgets especially must not look normal).
    ST.routeError = error.message;
    toast(error.message, budgetLike(error.message) ? 8000 : 5000);
    ST.route = { category: "unknown", camera: "unknown", subjects: [], warnings: [] };
  }
  if (ST.routeFor !== ST.upload.uploadId) {
    ST.routeFor = ST.upload.uploadId;
    // a recommendation that changes the chosen result says so and can be undone
    const before = chosenTier();
    applyRecommend(ST.route);
    ST.routeSwitched = chosenTier() !== before ? before : null;
  }
  renderRoute();
}

function renderRoute() {
  const r = ST.route || {};
  const tier = chosenTier();
  const subjects = (r.subjects || []).map((s) => `<li>${esc(s)}</li>`).join("");
  // Older servers may still send a decline; display it as advice, not a gate.
  // the recommendation already says when the camera moves: say it once
  const saidCamera = /camera moves/i.test(r.recommend?.why || "");
  const warnings = [...(r.warnings || []).filter((w) => !(saidCamera && /camera moves/i.test(w))), ...(r.decline ? [`Automatic clip check: ${r.decline}`] : [])].map((w) => `<li>${esc(w)}</li>`).join("");
  const m = r.cameraMeasured;
  const camNote = m ? (m.moving === (r.camera === "moving") ? "measured" : `measured ${m.moving ? "moving" : "fixed"}`) : null;
  const rec = r.recommend || {};
  const recName = rec.tier === "lite" ? "Lite" : rec.tier === "basic" ? "Basic" : rec.tier === "advanced" ? "Advanced" : null;
  let hint = "";
  if (tier === "basic") hint = ST.me?.live
    ? "Basic accepts fixed or moving cameras. Moving-camera builds use several viewpoints and finish as a 3D cloud."
    : "Basic needs a steady, fixed camera. For handheld, panning or moving-camera clips, choose Lite.";
  else if (tier === "advanced") hint = ST.me?.live
    ? "Advanced accepts fixed or moving cameras. Moving-camera builds finish as a 3D cloud; shells and live footage need a fixed camera."
    : "For Advanced, a fixed-camera clip is recommended. Builds use the GPU worker, which may decline unsupported clips.";
  else hint = "Lite accepts fixed or moving cameras.";
  // a switch made by the recommendation can be undone, and a recommendation
  // that differs from the choice can be taken, each in one step
  const kept = ST.routeSwitched && ST.routeSwitched !== tier ? ST.routeSwitched : null;
  const switchTo = !kept && rec.tier && rec.tier !== tier && document.querySelector(`input[name="tier"][value="${rec.tier}"]:not(:disabled)`) ? rec.tier : null;
  $("#routeTitle").textContent = ST.routeError ? "Clip check unavailable" : "Your clip, as Spark sees it";
  $("#routeCard").innerHTML = `
    ${ST.routeError ? `<p class="route-flag">${esc(ST.routeError)} ${/tomorrow/i.test(ST.routeError) ? "Limits reset at 00:00 UTC." : budgetLike(ST.routeError) ? "Builds are paused for now." : "You can continue with defaults."}</p>` : ""}
    <dl class="route-facts">
      <div><dt>category</dt><dd>${esc(r.category || "unknown")}</dd></div>
      <div><dt>camera</dt><dd>${esc(r.camera || "unknown")}${camNote ? ` <span class="dim">· ${esc(camNote)}</span>` : ""}</dd></div>
      <div><dt>your result</dt><dd>${TIER_NAME[tier] || tier} · ${TIER_FORM[tier] || ""}</dd></div>
    </dl>
    ${rec.tier ? `<p class="side-label">spark recommends</p><p class="microcopy rec-why"><b>${recName}</b> — ${esc(rec.why || "")}</p>` : ""}
    ${kept ? `<p class="microcopy route-switched">Spark switched your result from ${TIER_NAME[kept]} to ${TIER_NAME[tier] || tier}.</p><button class="btn btn-quiet route-switch" type="button" data-switch-tier="${kept}">Keep ${TIER_NAME[kept]}: ${TIER_FORM[kept]}</button>` : ""}
    ${switchTo ? `<button class="btn btn-quiet route-switch" type="button" data-switch-tier="${switchTo}">Use ${recName} instead: ${TIER_FORM[switchTo]}</button>` : ""}
    ${!rec.tier && rec.why ? `<p class="microcopy">${esc(rec.why)}</p>` : ""}
    ${subjects ? `<p class="side-label">subjects</p><ul class="chip-list static">${subjects}</ul>` : ""}
    ${warnings ? `<p class="side-label">watch for</p><ul class="warn-list">${warnings}</ul>` : ""}
    <p class="microcopy">Clip checks are advisory. You can try any video; results depend on the footage.</p>
    <p class="microcopy">${hint}</p>`;
  $("#routeGo").disabled = false;
  $("#routeGo").textContent = "Continue to picking";
}

// Suggest a tier once per fresh route without disabling manual choices.
function applyRecommend(r) {
  const rec = (r && r.recommend) || {};
  const basic = document.querySelector('input[name="tier"][value="basic"]');
  if (!basic) return;
  const keepAdvanced = ["lite", "advanced"].includes(chosenTier()) && ST.me?.live; // Preserve the selected live tier.
  basic.disabled = false;
  basic.title = "";
  if (rec.tier === "lite" && !ST.tierManual && !keepAdvanced) {
    const lite = document.querySelector('input[name="tier"][value="lite"]');
    if (lite) lite.checked = true;
  } else if (rec.tier === "basic" && !ST.tierManual && !keepAdvanced) {
    basic.checked = true;
  }
  updateWorkerLine();
  renderSelection();
}

// ── find objects (SAM 3.1) ─────────────────────────────────────────────

function resetSelection() {
  ST.requestTicket += 1;
  ST.selectionToken = null;
  ST.retryRequest = null;
  endBoxMode();
  setDetectBusy(false);
  ST.objects = [];
  ST.indexMap = null;
  ST.hoverId = 0;
  ST.selected = [];
  $("#hoverCanvas").getContext("2d")?.clearRect(0, 0, $("#hoverCanvas").width, $("#hoverCanvas").height);
  $("#hoverLabel").classList.add("is-hidden");
  $("#contextMenu").classList.add("is-hidden");
  $("#objectList").innerHTML = "";
  $("#detectRetry").classList.add("is-hidden");
  renderSelection();
  $("#detectStatus").textContent = "Scrub to a frame, then find objects. SAM 3.1 sweeps the frame; Muse Spark narrows the search.";
}

async function decodeIndexMap(base64Png, width, height) {
  const image = new Image();
  image.src = `data:image/png;base64,${base64Png}`;
  await image.decode();
  const canvasEl = document.createElement("canvas");
  canvasEl.width = width;
  canvasEl.height = height;
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  const ids = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < ids.length; i += 1, p += 4) ids[i] = data[p];
  return { width, height, ids };
}

async function applyDetect(data, ticket) {
  const indexMap = await decodeIndexMap(data.indexMapPngBase64, data.frameWidth, data.frameHeight);
  let frame = null;
  if (data.framePngBase64) {
    frame = new Image();
    frame.src = `data:image/png;base64,${data.framePngBase64}`;
    await frame.decode();
  }
  if (ticket !== ST.requestTicket) return;
  ST.objects = data.objects || [];
  ST.selected = [];
  ST.selectionToken = data.selectionToken || null;
  ST.indexMap = indexMap;
  if (frame) {
    const preview = $("#previewCanvas");
    preview.getContext("2d").drawImage(frame, 0, 0, preview.width, preview.height);
    ST.detectTime = data.frameIndex / ST.upload.fps;
    $("#timeReadout").textContent = fmtTime(ST.detectTime);
  }
  renderSelection();
  const count = ST.objects.length;
  $("#detectStatus").textContent = count
    ? `${count} object${count === 1 ? "" : "s"} found. ${SCRUB === "Scroll" ? "Point at the picture to light each one, then click your subject" : "Tap your subject in the picture"} or pick it from the list.`
    : ST.selectionToken ? "Nothing found in that box. Draw another box or try a different frame." : "Nothing matched here. Name it below, or draw a box for Lite.";
  $("#detectRetry").classList.add("is-hidden");
  drawHighlight();
  $("#objectList").innerHTML = ST.objects.map((o) => `<li><button type="button" data-obj="${o.id}" aria-pressed="false">${esc(o.label)}</button></li>`).join("");
  litePrewarm();
}

// Lite only: start the SAM cut upload while the visitor is still choosing
// (the server dedups per frame; the job reuses it). Fire-and-forget.
function litePrewarm() {
  if (chosenTier() !== "lite" || !ST.upload || !ST.objects.length) return;
  const key = `${ST.upload.uploadId}:${ST.detectTime}`;
  if (ST.prewarmKey === key) return;
  ST.prewarmKey = key;
  fetch(apiUrl("/api/lite/prewarm"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadId: ST.upload.uploadId, time: ST.detectTime }) }).catch(() => {});
}

async function detectRequest(path, body, statusText, button) {
  if (!ST.upload || ST.detectBusy) return;
  resetSelection();
  const ticket = ++ST.requestTicket;
  setDetectBusy(true);
  $("#detectStatus").textContent = statusText;
  try {
    const res = await fetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed."), { status: res.status });
    await applyDetect(data, ticket);
    return ticket === ST.requestTicket;
  } catch (error) {
    if (ticket !== ST.requestTicket) return;
    const msg = path === "/api/detect-box" && error.status === undefined ? "Could not confirm the box selection. Check the connection or try again." : error.message || "Detection failed.";
    // A failed pass clears any stale picks (they belong to another frame) so
    // the panel never shows an empty "no objects" result as if it succeeded.
    // Budget messages stay in the panel (a toast fades; the panel does not).
    // Transient failures — including the segmentation service being briefly
    // unavailable — get an explicit Retry button; nothing is stuck.
    resetSelection();
    const canRetry = !budgetLike(msg) && (path !== "/api/detect-box" || error.status === 503 || error.status === undefined);
    ST.retryRequest = canRetry ? { path, body } : null;
    $("#detectStatus").textContent = budgetLike(msg)
      ? `${msg} Your clip is safe — come back tomorrow and pick up where you left off.`
      : canRetry ? `${msg} Nothing is stuck — retry, or scrub to another frame.` : msg;
    $("#detectRetry").classList.toggle("is-hidden", !canRetry);
    if (path !== "/api/detect-box") toast(msg, budgetLike(msg) ? 8000 : 4500);
  } finally {
    if (ticket === ST.requestTicket) setDetectBusy(false);
  }
}

function setDetectBusy(busy) {
  ST.detectBusy = busy;
  ["#findObjects", "#customPromptGo", "#detectRetry", "#scrubber"].forEach(id => { $(id).disabled = busy; });
  $("#drawBox").disabled = busy || chosenTier() !== "lite";
  renderSelection();
}

function endBoxMode() {
  ST.boxMode = false;
  ST.boxStart = null;
  const canvas = $("#hoverCanvas");
  canvas.style.touchAction = "";
  canvas.style.cursor = "";
  canvas.setAttribute("aria-label", "Object picker. Hover or tap an object, or use the object list.");
  $("#drawBox").textContent = "Draw a box";
  $("#drawBox").setAttribute("aria-pressed", "false");
  if (!ST.detectBusy) $("#scrubber").disabled = false;
}

function startBoxMode() {
  if (ST.boxMode) { resetSelection(); return; }
  if (!ST.upload || ST.detectBusy || !["lite", "basic"].includes(chosenTier())) return;
  resetSelection();
  ST.boxMode = true;
  ST.boxCursor = { x: 0.25, y: 0.25 };
  ST.detectTime = Math.max(0, Math.min(ST.upload.duration, ST.video?.currentTime || 0));
  $("#scrubber").disabled = true;
  $("#drawBox").textContent = "Cancel box selection";
  $("#drawBox").setAttribute("aria-pressed", "true");
  $("#hoverCanvas").style.touchAction = "none";
  $("#hoverCanvas").style.cursor = "crosshair";
  $("#hoverCanvas").setAttribute("aria-label", "Draw around the whole subject. Arrow keys move the corner; Enter sets each corner; Escape cancels. Completing the box sends one SAM request.");
  $("#hoverCanvas").focus({ preventScroll: true });
  $("#detectStatus").textContent = "Draw around the whole subject. Release to ask SAM once. Keyboard: arrows move, Enter sets each corner, Escape cancels.";
  drawHighlight();
}

function boxGuide(ctx, canvas) {
  if (!ST.boxMode) return;
  const p = ST.boxCursor, a = ST.boxStart;
  const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
  ctx.save();
  ctx.strokeStyle = "#ffd9a8";
  ctx.lineWidth = 2 * scale;
  if (a) ctx.strokeRect(a.x * canvas.width, a.y * canvas.height, (p.x - a.x) * canvas.width, (p.y - a.y) * canvas.height);
  ctx.beginPath();
  ctx.moveTo(p.x * canvas.width - 6 * scale, p.y * canvas.height); ctx.lineTo(p.x * canvas.width + 6 * scale, p.y * canvas.height);
  ctx.moveTo(p.x * canvas.width, p.y * canvas.height - 6 * scale); ctx.lineTo(p.x * canvas.width, p.y * canvas.height + 6 * scale);
  ctx.stroke(); ctx.restore();
}

function finishBox() {
  const a = ST.boxStart, b = ST.boxCursor;
  if (!a) return;
  const box = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
  if ((box.right - box.left) * ST.upload.width < 2 || (box.bottom - box.top) * ST.upload.height < 2) {
    ST.boxStart = null;
    $("#detectStatus").textContent = "That box is too small. Draw around the whole subject; no request was sent.";
    drawHighlight(); return;
  }
  endBoxMode();
  return detectRequest("/api/detect-box", { uploadId: ST.upload.uploadId, time: ST.detectTime, box }, "SAM is finding the boxed subject…", $("#drawBox"));
}

function findObjects() {
  ST.detectTime = ST.video ? ST.video.currentTime : 0;
  return detectRequest("/api/detect", { uploadId: ST.upload.uploadId, time: ST.detectTime }, "Reading the frame… this takes about 10–20 seconds.", $("#findObjects"));
}

async function customSearch() {
  const input = $("#customPrompt");
  const prompt = input.value.trim();
  if (!prompt) return;
  ST.detectTime = ST.video ? ST.video.currentTime : ST.detectTime;
  if (await detectRequest("/api/detect-custom", { uploadId: ST.upload.uploadId, time: ST.detectTime, prompt }, `Looking for "${prompt}"…`, $("#customPromptGo"))) input.value = "";
}

function idAt(clientX, clientY) {
  if (!ST.indexMap) return 0;
  const rect = $("#hoverCanvas").getBoundingClientRect();
  const x = Math.floor(((clientX - rect.left) / rect.width) * ST.indexMap.width);
  const y = Math.floor(((clientY - rect.top) / rect.height) * ST.indexMap.height);
  if (x < 0 || y < 0 || x >= ST.indexMap.width || y >= ST.indexMap.height) return 0;
  return ST.indexMap.ids[y * ST.indexMap.width + x];
}

function drawHighlight() {
  const canvasEl = $("#hoverCanvas");
  const ctx = canvasEl.getContext("2d");
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (!ST.indexMap) { boxGuide(ctx, canvasEl); return; }
  const { width, height, ids } = ST.indexMap;
  const overlay = ctx.createImageData(width, height);
  const paint = (id, r, g, b, a) => {
    for (let i = 0, p = 0; i < ids.length; i += 1, p += 4) {
      if (ids[i] !== id) continue;
      const edge = ids[i - 1] !== id || ids[i + 1] !== id || ids[i - width] !== id || ids[i + width] !== id;
      overlay.data[p] = edge ? Math.min(255, r + 60) : r;
      overlay.data[p + 1] = edge ? Math.min(255, g + 60) : g;
      overlay.data[p + 2] = b;
      overlay.data[p + 3] = edge ? 240 : a;
    }
  };
  ST.selected.forEach((id) => paint(id, 196, 150, 96, 86));
  if (ST.hoverId && !ST.selected.includes(ST.hoverId)) paint(ST.hoverId, 255, 217, 168, 150);
  ctx.putImageData(overlay, 0, 0);
  boxGuide(ctx, canvasEl);
}

function objectById(id) {
  return ST.objects.find((o) => o.id === id) || null;
}

function toggleSelect(id) {
  if (!objectById(id)) return;
  if (ST.selected.includes(id)) ST.selected = ST.selected.filter((s) => s !== id);
  else {
    if (ST.selected.length >= 3) {
      toast("Three objects at most — remove one first.", 2600);
      return;
    }
    ST.selected = [...ST.selected, id];
    litePrewarm();
  }
  drawHighlight();
  renderSelection();
}

function renderSelection() {
  const has = ST.selected.length > 0;
  $("#selectedBlock").style.display = has ? "grid" : "none";
  $("#selectCount").textContent = `${ST.selected.length} of ${ST.selectionToken ? 1 : 3}`;
  $("#chipList").innerHTML = ST.selected.map((id) => {
    const o = objectById(id);
    const label = o ? o.label : `object ${id}`;
    return `<li><span>${esc(label)}</span><button type="button" data-unpick="${id}" aria-label="Remove ${esc(label)}">✕</button></li>`;
  }).join("");
  const tier = chosenTier();
  const btn = $("#generateButton");
  btn.disabled = !has || ST.detectBusy || (Boolean(ST.selectionToken) && !["lite", "basic"].includes(tier));
  $("#drawBox").disabled = ST.detectBusy || !["lite", "basic"].includes(tier);
  btn.textContent = has ? `Build the ${tier} ${tier === "lite" ? "ghost trail" : tier === "basic" ? "cloud trail" : "world"}` : "Build it";
  document.querySelectorAll("#objectList [data-obj]").forEach((b) => {
    b.setAttribute("aria-pressed", String(ST.selected.includes(Number(b.dataset.obj))));
  });
}

// ── jobs ───────────────────────────────────────────────────────────────

function setProgress(fraction, stage, detail) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  $("#workFill").style.width = `${pct}%`;
  $("#workBar").setAttribute("aria-valuenow", String(pct));
  if (stage) $("#workingTitle").textContent = stage;
  if (detail !== undefined) $("#workingNote").textContent = detail;
}

// What the visitor sees while it cooks: elapsed time against the tier's usual
// time, and each finished stage kept as a ticked line, so a long build reads
// as progress rather than a spinner.
const TYPICAL = { lite: "Lite usually takes about 15 s", basic: "Basic usually takes 1–2 min", advanced: "Advanced runs on the GPU worker; it can take several minutes" };
// past this many seconds a build says it is slow, so a long wait never looks stuck
const TYPICAL_LIMIT = { lite: 30, basic: 180 };
const work = { started: 0, tier: "lite", stage: "", timer: 0 };
function startWork(tier, startedAt = Date.now(), preview = false) {
  work.started = startedAt;
  work.tier = tier;
  work.stage = "";
  $("#workLog").replaceChildren();
  $("#workingKicker").textContent = `building · ${TIER_NAME[tier] || tier} ${TIER_FORM[tier] || ""}`;
  $("#workFail").hidden = true;
  $("#workAway").hidden = false;
  $("#workPreview").hidden = !preview;
  $("#stepWorking .working").classList.toggle("has-preview", preview);
  window.clearInterval(work.timer);
  tickWork();
  work.timer = window.setInterval(tickWork, 1000);
}
function tickWork() {
  const s = Math.max(0, Math.round((Date.now() - work.started) / 1000));
  const slow = s > (TYPICAL_LIMIT[work.tier] || Infinity);
  $("#workClock").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} · ${slow ? `longer than usual for ${TIER_NAME[work.tier]}; still working` : TYPICAL[work.tier] || ""}`;
}
// the frame you picked, with your subject lit, so the wait shows what is being built
function snapWorkPreview() {
  const frame = $("#previewCanvas"), lit = $("#hoverCanvas"), out = $("#workPreview");
  if (!frame.width || !frame.height) return false;
  out.width = 320;
  out.height = Math.round(320 * frame.height / frame.width);
  const ctx = out.getContext("2d");
  try {
    ctx.drawImage(frame, 0, 0, out.width, out.height);
    ctx.drawImage(lit, 0, 0, out.width, out.height);
  } catch { return false; }
  return true;
}
// a stopped build says so plainly and offers the next step
function failWork(message) {
  stopWork();
  setProgress(0, "This build stopped.", message || "The build failed.");
  $("#workingKicker").textContent = `stopped · ${TIER_NAME[work.tier] || work.tier} ${TIER_FORM[work.tier] || ""}`;
  $("#workClock").textContent = "";
  $("#workFail").hidden = false;
  $("#workAway").hidden = true;
  $("#workRetry").textContent = ST.upload && ST.video ? "Pick again" : "Start again";
}
function noteStage(stage) {
  const clean = String(stage || "").trim();
  if (!clean || clean === work.stage || clean === "done") return;
  if (work.stage) {
    const li = document.createElement("li");
    li.textContent = work.stage[0].toUpperCase() + work.stage.slice(1);
    $("#workLog").append(li);
  }
  work.stage = clean;
}
function stopWork() { window.clearInterval(work.timer); }

async function createJob() {
  if (!ST.selected.length || !ST.upload) return;
  if (ST.maintenance) {
    toast("Maintenance is on — new builds are paused. Your clip is safe; try again later.", 6000);
    return;
  }
  const tier = chosenTier();
  if (ST.selectionToken && !["lite", "basic"].includes(tier)) { toast("Box selection is available for Lite or Basic. Use text detection for Advanced.", 5000); return; }
  const labels = ST.selected.map((id) => objectById(id)?.label || `object ${id}`);
  const subject = labels.join(", ").slice(0, 120);
  const preview = snapWorkPreview();
  showStep("stepWorking");
  startWork(tier, Date.now(), preview);
  setProgress(0, "Sending the job…", "Waiting for a runner…");
  try {
    const { jobId } = await stPost("/api/jobs", {
      uploadId: ST.upload.uploadId,
      tier,
      objectIds: ST.selected,
      ...(ST.selectionToken ? { selectionToken: ST.selectionToken, selectionKind: "box" } : {}),
      seedTime: ST.detectTime,
      title: `${subject} ${tier}`,
      subject,
    });
    ST.jobId = jobId;
    pollJob();
  } catch (error) {
    toast(error.message, budgetLike(error.message) ? 9000 : 6000);
    showStep("stepFrame");
  }
}

async function pollJob() {
  window.clearInterval(ST.pollTimer);
  const tick = async () => {
    let job;
    try {
      job = await stGet(`/api/jobs/${ST.jobId}`);
    } catch (error) {
      setProgress(0, "Still building…", "Lost contact for a moment — retrying.");
      return;
    }
    // the GPU worker's claim reads as a start, not as the queue's own word
    const stage = job.stage === "claimed" ? "starting" : job.stage;
    noteStage(stage);
    ST.watch = { status: job.status, tier: job.tier, progress: job.progress || 0, viewer: Boolean(job.result?.viewer) };
    setProgress(job.progress || 0, stage === "done" ? "Ready." : stage ? stage[0].toUpperCase() + stage.slice(1) : "Working…", job.detail || "");
    if (job.status === "done") {
      window.clearInterval(ST.pollTimer);
      stopWork();
      ST.lastResult = job.result;
      renderDone(job);
      loadBuilds();
    } else if (job.status === "failed") {
      window.clearInterval(ST.pollTimer);
      failWork(job.error);
      // the open panel already says it; out in the construct the chip and a notice do
      if (!(studioOpen && focusSlot().kind === "instrument")) toast(job.error || "The build failed. Try another frame or clip.", 7000);
    }
    syncBuildChip();
  };
  await tick();
  ST.pollTimer = window.setInterval(tick, 1500);
}

function renderDone(job) {
  const r = job.result || {};
  const tier = job.tier;
  showStep("stepDone");
  // a world still waiting for the GPU worker has nothing to see yet; a built
  // one hangs in your cell and opens like any other result
  const queued = tier === "advanced" && !r.viewer;
  $("#doneSee").style.display = queued ? "none" : "";
  // what was made, in one phrase, and a picture of it when the build has one
  $("#doneWhat").textContent = FORM_IS[tier] ? `A ${TIER_FORM[tier]}: ${FORM_IS[tier].replace(/\b(one|a|its) subject/, "your subject")}.` : "";
  const thumb = $("#doneThumb");
  thumb.hidden = !r.thumb;
  thumb.onerror = () => { thumb.hidden = true; };
  if (r.thumb) thumb.src = assetUrl(r.thumb);
  else thumb.removeAttribute("src");
  if (queued) {
    $("#doneKicker").textContent = "queued for the worker";
    $("#doneTitle").textContent = "Your world is in the queue.";
    $("#doneMeta").textContent = `We will email ${ST.me?.email || "you"} when it is ready.`;
    $("#doneOpen").style.display = "none";
    $("#donePublish").style.display = "none";
    $("#doneNote").textContent = job.worker?.online === false ? "The GPU worker is offline, so this waits until it returns." : "";
    return;
  }
  $("#doneKicker").textContent = `done · ${tier}`;
  $("#doneTitle").textContent = buildTitle(r.title, "Your build is ready.");
  $("#doneMeta").textContent = `${r.subject || ""} · ${Math.round((Number(r.durationSec) || 0) * 10) / 10}s`;
  $("#doneProv").innerHTML = provChips(r.meta).map((c) => `<li>${esc(c)}</li>`).join("");
  ST.lastViewer = r.viewer ? assetUrl(r.viewer) : null;
  $("#doneOpen").style.display = r.viewer ? "" : "none";
  const pub = $("#donePublish");
  pub.style.display = "";
  pub.textContent = job.publish === "pending" ? "Publish pending approval" : job.publish === "approved" ? "Published ✓" : "Publish to the construct";
  pub.disabled = job.publish === "pending" || job.publish === "approved";
  $("#doneNote").textContent = job.publish === "approved" ? "It hangs in other visitors' rooms now." : job.publish === "pending" ? "It hangs in other visitors' rooms once the owner approves it." : "Publish it, and once the owner approves it, it hangs in other visitors' rooms.";
}

let viewerReturn = null;
function openViewer(url, launcher = document.activeElement) {
  if (!url) return;
  if (!viewerReturn) {
    const surfaces = [...document.querySelectorAll(".hud, .edge, .toggles, #instrumentCell, #buildChip, #latticeCanvas")];
    viewerReturn = {
      launcher, jobId: launcher?.closest?.(".build")?.dataset.jobId,
      cell: { ...state.focus }, scroll: $(".instrument-inner").scrollTop,
      surfaces: surfaces.map(el => ({ el, inert: el.inert })),
    };
    surfaces.forEach(el => { el.inert = true; });
    pushLayer("viewer", url);
  }
  resetSceneInput();
  $("#viewerFrame").src = url;
  // which viewer is up, so the close button can keep clear of its own header
  $("#viewer").dataset.page = /view-basic\.html/.test(url) ? "basic" : "";
  $("#viewer").classList.remove("is-hidden");
  $("#viewerClose").focus({ preventScroll: true });
}

function closeViewer() {
  if (!viewerReturn) return;
  const restore = viewerReturn;
  viewerReturn = null;
  $("#viewer").classList.add("is-hidden");
  // a fresh frame, not a navigation to about:blank: the old frame's history goes with it,
  // so Back never reloads a closed viewer out of sight
  const frame = $("#viewerFrame"), fresh = frame.cloneNode(false);
  fresh.setAttribute("src", "about:blank");
  fresh.addEventListener("load", viewerFrameLoad);
  frame.replaceWith(fresh);
  dropLayer("viewer");
  restore.surfaces.forEach(({ el, inert }) => { el.inert = inert; });
  travel(restore.cell.x - state.focus.x, restore.cell.y - state.focus.y);
  resetSceneInput();
  let launcher = restore.launcher;
  if (!launcher?.isConnected && restore.jobId) {
    const row = [...$("#buildList").children].find(el => el.dataset.jobId === restore.jobId);
    launcher = [...(row?.querySelectorAll("button") || [])].find(el => el.textContent === "Open");
  }
  if (launcher?.isConnected && !launcher.disabled && launcher.getClientRects().length) launcher.focus({ preventScroll: true });
  else if (studioOpen && focusSlot().kind === "instrument") ($("#stepUpload.library-view #myBuilds .side-label") || $("#stepUpload h2")).focus({ preventScroll: true });
  else canvas.focus({ preventScroll: true });
  $(".instrument-inner").scrollTop = restore.scroll;
}

function viewerFrameLoad() {
  if (!viewerReturn) return;
  // Same-origin viewers have their own document; Escape does not bubble to the host.
  try { $("#viewerFrame").contentDocument?.addEventListener("keydown", viewerKeydown); }
  catch { /* Cross-origin overrides still have the host's close button. */ }
}

function viewerKeydown(event) {
  if (event.key !== "Escape" || event.defaultPrevented || !viewerReturn) return;
  event.preventDefault();
  closeViewer();
}

function showChip(text, action = null, busy = false) {
  const chip = $("#buildChip");
  chip.textContent = text;
  chip.classList.remove("is-hidden");
  chip.classList.toggle("is-busy", busy);
  chip.disabled = !action;
  chip.onclick = action;
  chipFloor = chip.getBoundingClientRect().bottom; // the door signs stay below it
}
function hideChip() {
  $("#buildChip").classList.add("is-hidden");
  chipFloor = 0;
}
// A build keeps going while you walk the construct: the chip carries its
// progress and brings the studio back; a finished build points to your cell.
function syncBuildChip() {
  const job = ST.watch;
  if (!job || (studioOpen && focusSlot().kind === "instrument")) return hideChip();
  // a world is ready once it has its viewer (a done world without one is still waiting for the GPU)
  if (job.status === "done" && (job.tier !== "advanced" || job.viewer)) {
    if (focusSlot().kind === "instrument") return hideChip();
    return showChip("your build is ready · go to your cell", () => { ST.watch = null; goHome(); });
  }
  if (job.status === "failed") return showChip("your build stopped · open the studio", () => openStudio(), false);
  showChip(`building · ${Math.round((job.progress || 0) * 100)}% · open the studio`, () => openStudio(), true);
}
function goHome() {
  travel(hop(state.focus.x, ownCell % TILE), hop(state.focus.y, Math.floor(ownCell / TILE)));
}

// ── my builds ──────────────────────────────────────────────────────────

async function loadBuilds() {
  const list = $("#buildList");
  try {
    const { jobs } = await stGet("/api/me/jobs");
    ST.builds = jobs || [];
  } catch {
    list.innerHTML = `<li class="microcopy dim">Could not load builds — check the link and try again.</li>`;
    $("#buildsEmpty").hidden = true;
    return;
  }
  $("#buildsEmpty").hidden = ST.builds.length > 0;
  list.innerHTML = "";
  ST.builds.slice(0, 20).forEach((job) => {
    const li = document.createElement("li");
    li.className = "build";
    li.dataset.tier = job.tier;
    li.dataset.jobId = job.id;
    const r = job.result || {};
    const thumb = r.thumb ? assetUrl(r.thumb) : "";
    const state = job.status === "done" ? ({ approved: "published", pending: "awaiting approval", rejected: "not approved" }[job.publish] || "finished")
      : job.status === "failed" ? "failed" : job.status === "queued_gpu" ? "waiting for the GPU worker" : `${job.status === "claimed" ? "building" : String(job.status).replace(/_/g, " ")}${job.stage ? ` · ${job.stage}` : ""}`;
    li.innerHTML = `
      <div class="build-preview"><span>No preview</span>${thumb && job.status === "done" ? `<img src="${esc(thumb)}" alt="" loading="lazy" width="96" height="54" />` : ""}</div>
      <div class="build-meta"><b></b><span class="dim"></span>${job.status === "failed" && job.error ? `<span class="build-err"></span>` : ""}</div>
      <div class="build-btns"></div>`;
    li.querySelector("img")?.addEventListener("error", (event) => {
      event.currentTarget.remove();
      li.querySelector(".build-preview span").textContent = "Preview unavailable";
    }, { once: true });
    li.querySelector("b").textContent = buildTitle(r.title || job.title, `${TIER_NAME[job.tier] || job.tier} build`);
    li.querySelector(".build-meta .dim").textContent = `${job.tier} · ${state}`;
    if (job.status === "failed" && job.error) li.querySelector(".build-err").textContent = job.error;
    const btns = li.querySelector(".build-btns");
    const add = (label, fn, opts = {}) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link-btn";
      b.textContent = label;
      if (opts.hidden) b.hidden = true;
      b.addEventListener("click", fn);
      btns.append(b);
      return b;
    };
    if (job.status === "done" && r.viewer) add("Open", (event) => openViewer(assetUrl(r.viewer), event.currentTarget));
    if (job.status === "done" && (job.publish === "unpublished" || job.publish === "rejected")) add("Publish", () => publishJob(job.id));
    if (job.status === "done" && (job.publish === "pending" || job.publish === "approved")) add("Unpublish", () => unpublishJob(job.id));
    if (job.status !== "done" && job.status !== "failed") add("Watch", () => { ST.jobId = job.id; showStep("stepWorking"); startWork(job.tier, Number(job.created_at || job.createdAt) || Date.now()); pollJob(); });
    add("Report", () => reportJob(job.id));
    add("Delete", () => deleteJob(job.id));
    list.append(li);
  });
  hangOwnBuild();
  // a build still cooking after a reload is picked up again: the chip shows it and Create returns to it
  const cooking = !ST.jobId && currentStep === "stepUpload" && ST.builds.find((j) => !["done", "failed"].includes(j.status) && Date.now() - Number(j.createdAt) < 864e5);
  if (cooking) { ST.jobId = cooking.id; showStep("stepWorking"); startWork(cooking.tier, Number(cooking.createdAt) || Date.now()); pollJob(); }
}

// Your latest finished build hangs in your cell, so what you made joins the
// construct. Same loaders as the gallery rooms; a build that fails to load
// leaves the cell empty rather than breaking the walk.
// a build whose files will not load (expired, removed) is tried once, not on
// every refresh of the list
const unhangable = new Set();
function hangOwnBuild() {
  const job = ST.builds.find((j) => j.status === "done" && j.result?.viewer && ["lite", "basic", "advanced"].includes(j.tier));
  const slot = SLOTS[ownCell];
  if (!job || slot.gItem?.id === job.id || unhangable.has(job.id)) return;
  if (slotObjects[ownCell]) {
    scene.remove(slotObjects[ownCell]);
    releaseWorldCell(slotObjects[ownCell]);
    disposeVolume(slotObjects[ownCell]);
    slotObjects[ownCell] = null;
    unmountDust(ownCell);
  }
  slot.gItem = { id: job.id, tier: job.tier, title: buildTitle(job.result.title || job.title), viewer: job.result.viewer, own: true };
  ensureGalleryCell(ownCell).catch(() => {}).finally(() => {
    if (!SLOTS[ownCell].gItem) unhangable.add(job.id);
    refreshPlaque();
  });
}

async function publishJob(id) {
  try {
    await stPost(`/api/jobs/${id}/publish`, {});
    toast("Sent for owner approval — it hangs in the construct once approved.", 4000);
  } catch (error) {
    toast(error.message, 5000);
  }
  loadBuilds();
}

async function unpublishJob(id) {
  try {
    await stPost(`/api/jobs/${id}/unpublish`, {});
    toast("Unpublished — it leaves other visitors' tesseracts.", 3500);
  } catch (error) {
    toast(error.message, 5000);
  }
  loadBuilds();
}

async function reportJob(id) {
  const reason = window.prompt("What is wrong with this build?");
  if (!reason) return;
  try {
    await stPost("/api/report", { jobId: id, reason: reason.slice(0, 1000) });
    toast("Reported — the owner will look at it.", 3500);
  } catch (error) {
    toast(error.message, 5000);
  }
}

async function deleteJob(id) {
  if (!window.confirm("Delete this build for good?")) return;
  try {
    await stPost(`/api/jobs/${id}/delete`, {});
    toast("Deleted.", 3000);
  } catch (error) {
    toast(error.message, 5000);
  }
  loadBuilds();
}

async function signOut() {
  try {
    await fetch(apiUrl("/api/logout"), { method: "POST" });
  } catch { /* the session is gone either way */ }
  location.reload();
}

// ── gallery in the tesseract ───────────────────────────────────────────
// Published builds hang in the rooms the featured seeds never filled.
// Featured seed rooms and your own cell are never touched.

const gallery = { items: [], bySlot: new Map() };

function gallerySlots() {
  const out = [];
  SLOTS.forEach((slot, i) => {
    // rooms the gallery filled last time are planned again, so a refresh never hangs the same item twice
    if (slot.kind === "volume" && (slot.missing || gallery.bySlot.has(i)) && !LOADED_SPECIMENS.has(slot.name) && !LOADED_SPECIMENS.has(slot.seedName)) out.push(i);
  });
  return out;
}

async function initGallery() {
  let items = [];
  try {
    const res = await fetch(apiUrl("/api/gallery"));
    if (res.ok) items = (await res.json()).specimens || [];
  } catch { /* signed out or offline: the empty rooms keep their waiting copy */ }
  gallery.items = items;
  // the title card promises visitors' builds only when one is actually published
  $("#titleWho").hidden = !items.some((item) => item && !item.example);
  // Licensed examples fill rooms no published build has claimed yet.
  // Clearly badged as examples.
  let seeds = [];
  try {
    const res = await fetch(apiUrl("/assets/gallery-seed.json"), { cache: "no-store" });
    if (res.ok) seeds = (((await res.json()).examples) || []).map((s) => ({ ...s, example: true }));
  } catch { /* seeds are optional garnish */ }
  gallery.seeds = seeds;
  // Featured seeds already hang in their rooms; do not duplicate them in empty rooms.
  const assignSeeds = seeds.filter((s) => !SLOTS.some((slot) => slot.seedName === s.seedName));
  const slots = gallerySlots();
  const prev = new Map(gallery.bySlot);
  gallery.bySlot.clear();
  slots.forEach((slotIndex, n) => {
    const item = n < items.length ? items[n] : assignSeeds[n - items.length];
    // a room whose item changed (or emptied) drops the cell it showed before
    const had = prev.get(slotIndex);
    if (had && had !== item?.id && slotObjects[slotIndex]) {
      scene.remove(slotObjects[slotIndex]);
      releaseWorldCell(slotObjects[slotIndex]);
      disposeVolume(slotObjects[slotIndex]);
      slotObjects[slotIndex] = null;
      unmountDust(slotIndex);
    }
    if (!item) {
      Object.assign(SLOTS[slotIndex], { title: "OPEN ROOM", note: EMPTY_NOTE, missing: true });
      delete SLOTS[slotIndex].gItem;
      return;
    }
    gallery.bySlot.set(slotIndex, item.id);
    Object.assign(SLOTS[slotIndex], {
      title: (item.example ? `EXAMPLE · ${(item.title || "STUDY")}` : buildTitle(item.title, "PUBLISHED")).toUpperCase().slice(0, 40),
      note: item.example ? item.note || "An example build." : `Published by a visitor${item.subject ? ` · ${item.subject}` : ""}.`,
      missing: false,
      gItem: item,
    });
  });
  // focused cell first, the rest right after: only rooms near you cost work.
  const order = [...slots].sort((a, b) => Number(b === slotIndexFor(state.focus.x, state.focus.y)) - Number(a === slotIndexFor(state.focus.x, state.focus.y)));
  await Promise.allSettled(order.map((i) => ensureGalleryCell(i)));
  refreshPlaque();
  galleryTick();
  // one refresh timer for the page's life; each refresh must not add another
  galleryRefresh ||= window.setInterval(() => initGallery().catch(() => {}), 5 * 60 * 1000);
}
let galleryRefresh = 0;

async function buildPlate(url) {
  const texture = await loadTexture(url);
  const aspect = (texture.image?.width || 16) / (texture.image?.height || 9);
  const height = 3.4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(height * aspect, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, fog: false })
  );
  const group = new THREE.Group();
  group.add(mesh);
  group.userData = { depth: 0.1, width: height * aspect, height, count: 1, plate: true };
  setCut(group, 1);
  return group;
}

// Basic/Advanced diorama cell (TESSERACT-BASIC-CELL-V1): a lightweight
// in-scene 3.5D stand-in for the full view-basic.html viewer. Back layer:
// the plate on a plane. Front layer: the subject atlas on a plane at the
// crop position, cycling keyframe cells over time via texture
// repeat/offset (same cell math as view-basic.js). No depth displacement:
// the layer gap alone carries the parallax. Any load error throws and the
// caller falls back to the flat still.
async function buildBasicDiorama(item) {
  const base = item.seedBase ? apiUrl(`/${item.seedBase}`) : apiUrl(`/specimens/${item.id}`);
  const specimen = await (await fetch(`${base}/specimen.json`, { cache: "no-store" })).json();
  if (!specimen || !Array.isArray(specimen.keyframes) || !specimen.keyframes.length) throw new Error("basic cell: no keyframes");
  const layout = specimen.layout, crop = specimen.crop, files = specimen.files || {};
  if (!layout || !crop || !Number.isFinite(layout.cols) || !Number.isFinite(layout.rows) ||
      !Number.isFinite(layout.cellW) || !Number.isFinite(layout.cellH)) throw new Error("basic cell: bad layout");
  const K = specimen.keyframes.length;
  const times = specimen.keyframes.map((f) => f.t);
  const t0 = times[0], duration = Math.max(times[K - 1] - t0, 0.1);
  const [plateTex, subjectTex, behindTex] = await Promise.all([
    loadTexture(`${base}/${files.plate || "plate.webp"}`),
    new THREE.TextureLoader().loadAsync(`${base}/${files.subject || "subject.webp"}`).then((tex) => {
      // Same premultiplied-alpha upload as view-basic.js: filtering happens
      // in premultiplied space, then the shader un-premultiplies and
      // decodes sRGB itself, so edges show no dark rims.
      tex.premultiplyAlpha = true;
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      return tex;
    }),
    // the build's expanded canvas: the place continued past the frame
    files.behind ? loadTexture(`${base}/${files.behind}`).catch(() => null) : null,
  ]);
  const aspect = (plateTex.image?.width || 16) / (plateTex.image?.height || 9);
  const { height } = fitSpecimen(aspect);
  const width = height * aspect;
  const group = new THREE.Group();
  // soft-edged and dimmed under the subject, like the Advanced world room, and
  // cut above a burnt-in date band so no caption hangs under the animal
  const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), plateMaterial(plateTex));
  cropPlate(plateMesh, overlayTop(plateTex.image), width, height);
  group.add(plateMesh);
  // the plate's own estimated depth (cell 0 of depth.webp) as relief; flat until it lands
  if (files.depth && World.reliefPlate) basicRelief(`${base}/${files.depth}`, layout, crop, plateMesh, width, height).catch(() => {});
  const subjMat = new THREE.MeshBasicMaterial({
    map: subjectTex, transparent: true, toneMapped: false, fog: false,
    alphaTest: 0.004, depthWrite: true, // cut only at the gradient foot
  });
  // Threshold-free soft edge + premultiplied un-premultiply + manual sRGB
  // decode, exactly as view-basic.js: the baked atlas alpha is a real soft
  // matte, used directly; opacity multiplies after the linear alpha.
  subjMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <alphatest_fragment>",
      `vec3 pm = diffuseColor.rgb / max(sampledDiffuseColor.a, 1e-4);
       diffuseColor.rgb = mix(pm / 12.92, pow((pm + 0.055) / 1.055, vec3(2.4)), step(0.04045, pm));
       // the matte's soft rim carries the grass behind it: take the green
       // spill out of the rim and tighten it a little, so no lime outline
       float rim = 1.0 - smoothstep(0.55, 0.95, sampledDiffuseColor.a);
       diffuseColor.g = mix(diffuseColor.g, min(diffuseColor.g, max(diffuseColor.r, diffuseColor.b)), rim);
       ${SUBJECT_GRADE}
       diffuseColor.a = smoothstep(0.08, 0.85, sampledDiffuseColor.a) * opacity;
       if (diffuseColor.a < 0.004) discard;`
    );
  };
  const subj = new THREE.Mesh(new THREE.PlaneGeometry(crop.w * width, crop.h * height), subjMat);
  subj.position.set(
    (crop.x + crop.w / 2 - 0.5) * width,
    (0.5 - (crop.y + crop.h / 2)) * height,
    Math.max(0.05, height * 0.15)
  );
  subj.renderOrder = 1;
  group.add(subj);
  // the build's expanded canvas, centred on the frame, continues the place past it
  const pw = plateTex.image?.width, ph = plateTex.image?.height, bw = behindTex?.image?.width, bh = behindTex?.image?.height;
  const pad = pw > 0 && ph > 0 && bw > pw && bh > ph ? [(bw / pw - 1) / 2, (bh / ph - 1) / 2] : null;
  const surround = pad && pad.every((p) => p > 0 && p <= 1) ? pad : null;
  // its margin is the frame's edge pixels stretched outward: show the inner
  // part, where it still reads as the place, not the smear
  const BEHIND_REACH = 0.22;
  const atlasW = layout.cols * layout.cellW, atlasH = layout.rows * layout.cellH;
  const inset = 0.6; // px texel inset against atlas bleed, as in view-basic.js
  const basic = { tex: subjectTex, times, t0, duration, k: K, cols: layout.cols, cellW: layout.cellW, cellH: layout.cellH, atlasW, atlasH, inset, shown: -1 };
  group.userData = {
    depth: Math.max(0.3, height * 0.15 + 0.1),
    width, height, count: 2, basicCell: true, basic,
    // time dust sheds from the keyframe on show, out of its own atlas cell
    dustHead: () => Math.max(0, basic.shown),
    // threads leave from where the picture fades out, not across it
    dustFrame: dustFrameOf(plateMesh, surround ? surround.map((p) => p * BEHIND_REACH) : [0, 0], width, height),
    dustPoses: async () => {
      const image = subjectTex.image;
      if (!image?.width) return [];
      // a small copy is enough to start threads from (see DUST_SIDE)
      const fit = Math.min(1, DUST_SIDE / Math.max(layout.cellW * image.width / atlasW, layout.cellH * image.height / atlasH));
      const { px, width: pw, height: ph } = await readPixels(subjectTex, fit);
      const sx = pw / atlasW, sy = ph / atlasH;
      return specimen.keyframes.map((_, k) => ({
        order: k, px, stride: pw,
        x0: Math.floor((k % layout.cols) * layout.cellW * sx), y0: Math.floor(Math.floor(k / layout.cols) * layout.cellH * sy),
        cw: Math.floor(layout.cellW * sx), ch: Math.floor(layout.cellH * sy),
        centre: subj.position, w: crop.w * width, h: crop.h * height,
      }));
    },
  };
  group.userData.generated = true; // disposeVolume also frees our two maps
  setCut(group, 1);
  // setCut treats the plate as an older slice (38% opacity, dimmed), which let
  // the room's beams show through the picture; the plate is a solid window at
  // the Advanced world's tone
  plateMesh.material.opacity = 1;
  plateMesh.material.color.setScalar(0.62);
  // the place runs on past the frame where the build continued it; only a
  // build without that stands on a mirror of itself
  if (surround) addSurround(group, plateMesh, behindTex, surround, width, height, BEHIND_REACH);
  else {
    behindTex?.dispose();
    addReflection(group, plateMesh, width, height);
  }
  tickBasicCell(group, state.time);
  return group;
}

// depth.webp holds the plate's depth in its first cell (the full frame
// squeezed to a cell, brighter = nearer); the subject's feet keep the plane.
async function basicRelief(url, layout, crop, plate, width, height) {
  const image = await new THREE.ImageLoader().loadAsync(url);
  const w = 96, h = Math.max(8, Math.round((96 * layout.cellH) / layout.cellW));
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  const sx = image.width / (layout.cols * layout.cellW), sy = image.height / (layout.rows * layout.cellH);
  ctx.drawImage(image, 0, 0, layout.cellW * sx, layout.cellH * sy, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const near = World.gridSampler(Float32Array.from({ length: w * h }, (_, k) => px[k * 4] / 255), w, h);
  World.reliefPlate(plate, width, height, near, near(crop.x + crop.w / 2, Math.min(1, crop.y + crop.h)));
}

// Advance a diorama cell to gallery time t (seconds, frozen under
// prefers-reduced-motion because state.time is): nearest-keyframe lookup on
// the clip's own keyframe times, looping, then point the subject texture at
// that atlas cell. Pure index math mirrors view-basic.js frameAt.
function tickBasicCell(group, t) {
  const b = group.userData?.basic;
  if (!b) return;
  const phase = ((t % b.duration) + b.duration) % b.duration;
  let best = 0;
  for (let i = 1; i < b.k; i += 1) {
    if (Math.abs(b.times[i] - b.t0 - phase) < Math.abs(b.times[best] - b.t0 - phase)) best = i;
  }
  if (best === b.shown) return;
  b.shown = best;
  const col = best % b.cols, row = Math.floor(best / b.cols);
  b.tex.repeat.set((b.cellW - 2 * b.inset) / b.atlasW, (b.cellH - 2 * b.inset) / b.atlasH);
  b.tex.offset.set((col * b.cellW + b.inset) / b.atlasW, 1 - ((row + 1) * b.cellH - b.inset) / b.atlasH);
}

async function ensureGalleryCell(index) {
  const item = SLOTS[index]?.gItem;
  if (!item || slotObjects[index]) return;
  if (SLOTS[index]._loading) return;
  SLOTS[index]._loading = true;
  try {
    if (item.tier === "lite") {
      const base = item.seedBase ? apiUrl(`/${item.seedBase}`) : apiUrl(`/specimens/${item.id}`);
      const { texture, meta } = await loadVolume(base, item.seedName || "atlas");
      if (SLOTS[index]?.gItem?.id !== item.id) {
        texture.dispose?.();
        return;
      }
      mountVolume(index, buildChronoVolume(texture, meta, fitChronoCell(meta)));
      // Chrono groups carry row dims, not the stack width/height the legacy
      // string builder assumes — it emits a NaN cloud (and console spam) for
      // them. Drop it until volume.js guards chrono groups (lite agent).
      if (slotStrings[index]) {
        scene.remove(slotStrings[index]);
        slotStrings[index].geometry.dispose();
        slotStrings[index].material.dispose();
        slotStrings[index] = null;
      }
    } else {
      // basic / advanced: a live 3.5D diorama (plate + cycling subject atlas)
      // sharing the one gallery renderer; any load error falls back to the
      // framed still, and the focused room still offers Open. An Advanced
      // world bake hangs as its plate with the matted moments standing in it.
      try {
        const base = item.seedBase ? apiUrl(`/${item.seedBase}`) : apiUrl(`/specimens/${item.id}`);
        const group = item.tier === "advanced"
          ? await buildWorldCell(base, { fit: fitSpecimen, loadTexture }).catch(() => buildBasicDiorama(item))
          : await buildBasicDiorama(item);
        if (SLOTS[index]?.gItem?.id !== item.id) {
          disposeVolume(group);
          return;
        }
        mountVolume(index, group);
      } catch {
        const group = await buildPlate(assetUrl(item.thumb));
        if (SLOTS[index]?.gItem?.id !== item.id) return;
        mountVolume(index, group);
      }
    }
    refreshPlaque();
  } catch {
    // a room that fails to hang stays an intentional empty; your cell stays yours
    if (index === ownCell) delete SLOTS[index].gItem;
    else if (SLOTS[index]?.gItem?.id === item.id) {
      Object.assign(SLOTS[index], { title: "OPEN ROOM", note: EMPTY_NOTE, missing: true });
      delete SLOTS[index].gItem;
      gallery.bySlot.delete(index);
      refreshPlaque();
    }
  } finally {
    SLOTS[index]._loading = false;
  }
}

function galleryTick() {
  ensureGalleryCell(slotIndexFor(state.focus.x, state.focus.y)).catch(() => {});
  syncBuildChip();
}

// ── studio wiring ──────────────────────────────────────────────────────

function initStudio() {
  $("#signInLink").href = `${ST.apiBase}/signin?next=${encodeURIComponent(location.pathname + location.search)}`;
  document.querySelectorAll('input[name="tier"]').forEach((input) => {
    // Clicking the already-checked choice is still a deliberate choice.
    input.addEventListener("click", () => { ST.tierManual = true; });
    input.addEventListener("change", () => {
      ST.tierManual = true; // a deliberate pick sticks; fresh routes still recommend
      ST.routeSwitched = null;
      if ((ST.boxMode || ST.selectionToken || ST.retryRequest?.path === "/api/detect-box") && !["lite", "basic"].includes(chosenTier())) resetSelection();
      updateWorkerLine();
      if (ST.route) renderRoute();
    });
  });
  // Advanced where this server can build it in front of the user: the live page takes the clip from here
const goLive = () => {
  const q = new URLSearchParams({ upload: ST.upload.uploadId, tier: chosenTier() });
  if (ST.apiBase) q.set("api", ST.apiBase);
  location.href = `live.html?${q}`;
};
const wantsLive = () => ["lite", "basic", "advanced"].includes(chosenTier()) && ST.me?.live && ST.upload;
$("#uploadContinue").addEventListener("click", () => { if (wantsLive()) return goLive(); resetSelection(); showStep("stepFrame"); });

  const dropZone = $("#dropZone");
  // cleared after each pick, so picking the same clip again (say, for another result) still sends it
  $("#videoInput").addEventListener("change", (event) => { const file = event.target.files[0]; event.target.value = ""; takeClip(file); });
  document.querySelectorAll("[data-sample]").forEach((button) =>
    button.addEventListener("click", async () => {
      const src = button.dataset.sample;
      toast("Fetching sample clip…");
      dropState("busy", "the sample clip");
      let file;
      try {
        const blob = await (await fetch(src)).blob();
        file = new File([blob], src.split("/").pop(), { type: blob.type || "video/mp4" });
      } catch {
        dropState(pendingClip ? "waiting" : "idle", pendingClip?.name);
        toast("Could not load the sample clip.", 3500);
        return;
      }
      await takeClip(file);
    })
  );
  // ticking the box sends a clip that was waiting for it
  $("#rightsBox").addEventListener("change", (event) => {
    endAsk();
    if (!event.target.checked || !pendingClip) return;
    const file = pendingClip;
    pendingClip = null;
    takeClip(file);
  });
  dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("is-dragging"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    takeClip(event.dataTransfer.files[0]);
  });

  $("#signOutBtn").addEventListener("click", signOut);
  $("#routeBack").addEventListener("click", () => showStep("stepUpload"));
  // "Use Lite instead" is the same deliberate choice as ticking that tier card
  $("#routeCard").addEventListener("click", (event) => {
    const button = event.target.closest("[data-switch-tier]");
    if (!button) return;
    document.querySelector(`input[name="tier"][value="${button.dataset.switchTier}"]`)?.click();
    $("#routeGo").focus({ preventScroll: true });
  });
  $("#routeGo").addEventListener("click", () => { if (wantsLive()) return goLive(); resetSelection(); showStep("stepFrame"); });

  $("#scrubber").addEventListener("input", (event) => {
    $("#timeReadout").textContent = fmtTime(Number(event.target.value));
  });
  $("#scrubber").addEventListener("change", async (event) => {
    await seekAndDraw(Number(event.target.value));
    resetSelection();
  });

  $("#findObjects").addEventListener("click", findObjects);
  $("#detectRetry").addEventListener("click", () => ST.retryRequest ? detectRequest(ST.retryRequest.path, ST.retryRequest.body, "Retrying your selection…", $("#detectRetry")) : findObjects());
  $("#drawBox").addEventListener("click", startBoxMode);
  $("#customPromptGo").addEventListener("click", customSearch);
  $("#customPrompt").addEventListener("keydown", (event) => { if (event.key === "Enter") customSearch(); });
  $("#objectList").addEventListener("click", (event) => {
    const b = event.target.closest("[data-obj]");
    if (b) toggleSelect(Number(b.dataset.obj));
  });
  $("#chipList").addEventListener("click", (event) => {
    const b = event.target.closest("[data-unpick]");
    if (b) toggleSelect(Number(b.dataset.unpick));
  });

  const hover = $("#hoverCanvas");
  const boxPoint = (event) => {
    const rect = hover.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  ["touchstart", "touchmove"].forEach(type => hover.addEventListener(type, event => {
    if (ST.boxMode) event.stopPropagation(); // A box drag must not scrub the gallery.
  }, { passive: true }));
  hover.addEventListener("pointerdown", (event) => {
    if (!ST.boxMode || event.button !== 0) return;
    event.preventDefault();
    ST.boxStart = boxPoint(event); ST.boxCursor = ST.boxStart;
    try { hover.setPointerCapture(event.pointerId); } catch { /* gesture can continue inside the canvas */ }
    drawHighlight();
  });
  hover.addEventListener("pointermove", (event) => {
    if (!ST.boxMode || !ST.boxStart) return;
    ST.boxCursor = boxPoint(event); drawHighlight();
  });
  hover.addEventListener("pointerup", (event) => {
    if (!ST.boxMode || !ST.boxStart) return;
    event.preventDefault();
    ST.boxCursor = boxPoint(event); ST.pickAfter = performance.now() + 250;
    if (hover.hasPointerCapture(event.pointerId)) hover.releasePointerCapture(event.pointerId);
    finishBox();
  });
  hover.addEventListener("pointercancel", () => { if (ST.boxMode) { ST.boxStart = null; drawHighlight(); } });
  hover.addEventListener("mousemove", (event) => {
    if (ST.boxMode) return;
    const id = idAt(event.clientX, event.clientY);
    if (id === ST.hoverId) return;
    ST.hoverId = id;
    drawHighlight();
    const label = $("#hoverLabel");
    const object = objectById(id);
    if (!object) {
      label.classList.add("is-hidden");
      return;
    }
    label.textContent = `${object.label}${ST.selected.includes(id) ? " ✓" : ""}`;
    label.classList.remove("is-hidden");
    const rect = hover.getBoundingClientRect();
    label.style.left = `${event.clientX - rect.left}px`;
    label.style.top = `${event.clientY - rect.top}px`;
  });
  hover.addEventListener("mouseleave", () => {
    ST.hoverId = 0;
    $("#hoverLabel").classList.add("is-hidden");
    drawHighlight();
  });
  hover.addEventListener("click", (event) => {
    if (performance.now() < ST.pickAfter) return;
    if (ST.boxMode || ST.detectBusy) return;
    const id = idAt(event.clientX, event.clientY);
    if (id) toggleSelect(id);
    $("#contextMenu").classList.add("is-hidden");
  });
  hover.addEventListener("keydown", (event) => {
    if (event.key.startsWith("Arrow")) event.stopPropagation();
    if (ST.boxMode) {
      event.stopPropagation(); // Corner arrows must not travel the gallery behind the studio.
      if (event.key === "Escape") { event.preventDefault(); resetSelection(); return; }
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 1 : 10, rect = hover.getBoundingClientRect();
        ST.boxCursor = { x: Math.max(0, Math.min(1, ST.boxCursor.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0) / rect.width)), y: Math.max(0, Math.min(1, ST.boxCursor.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) / rect.height)) };
        drawHighlight(); return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (ST.boxStart) finishBox();
        else { ST.boxStart = { ...ST.boxCursor }; drawHighlight(); }
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && ST.hoverId) {
      event.preventDefault();
      toggleSelect(ST.hoverId);
    }
  });
  hover.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const id = idAt(event.clientX, event.clientY);
    if (!id) return;
    if (!ST.selected.includes(id)) toggleSelect(id);
    const menu = $("#contextMenu");
    const wrap = $("#frameCanvasWrap").getBoundingClientRect();
    menu.style.left = `${event.clientX - wrap.left}px`;
    menu.style.top = `${event.clientY - wrap.top}px`;
    menu.classList.remove("is-hidden");
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.("#contextMenu")) $("#contextMenu").classList.add("is-hidden");
  });
  $("#ctxGenerate").addEventListener("click", () => {
    $("#contextMenu").classList.add("is-hidden");
    createJob();
  });
  $("#generateButton").addEventListener("click", createJob);
  $("#cancelFrame").addEventListener("click", () => { resetSelection(); showStep("stepRoute"); });
  $("#workingBack").addEventListener("click", () => openStudio(true));
  // walking away never cancels: the chip carries progress and leads back
  $("#workingWalk").addEventListener("click", () => { closeStudio(); syncBuildChip(); });
  $("#workRetry").addEventListener("click", () => {
    if (ST.upload && ST.video) showStep("stepFrame");
    else { $("#stepUpload").classList.remove("library-view"); showStep("stepUpload"); }
  });
  $("#workNewClip").addEventListener("click", () => { $("#stepUpload").classList.remove("library-view"); showStep("stepUpload"); });
  $("#doneOpen").addEventListener("click", (event) => openViewer(ST.lastViewer, event.currentTarget));
  $("#doneSee").addEventListener("click", () => { ST.watch = null; closeStudio(); });
  $("#donePublish").addEventListener("click", async () => {
    if (!ST.jobId) return;
    await publishJob(ST.jobId);
    if (ST.jobId) renderDone(await stGet(`/api/jobs/${ST.jobId}`).catch(() => ({ tier: chosenTier(), result: ST.lastResult })));
  });
  $("#doneBack").addEventListener("click", () => openStudio(true));

  $("#viewerClose").addEventListener("click", closeViewer);
  document.addEventListener("keydown", viewerKeydown);
  $("#viewerFrame").addEventListener("load", viewerFrameLoad);

  window.addEventListener("online", updateNet);
  window.addEventListener("offline", updateNet);
  window.setInterval(loadMe, 60 * 1000);

  window.__studio = ST;
  window.__gallery = gallery;
  checkBackend();
  loadMe().then(() => loadBuilds());
  showStep("stepUpload");
}

initStudio();

placeSlots();
refreshPlaque();
// The way in waits, under the title, until the rooms nearby have hung and read
// their dust, so the push does not stall halfway; never more than a few seconds.
const warmUp = buildConstruct().then(loadSpecimens).then(() => initGallery().catch(() => {}));
Promise.race([
  warmUp.then(() => Promise.allSettled([...dustBuilds])).then(prewarmPrograms),
  new Promise((resolve) => setTimeout(resolve, 3200)),
]).finally(() => { sceneWarm = true; });
requestAnimationFrame(frame);

// A tab left open across a deploy keeps the old code but fetches the new rooms'
// files, and the mix can render wrong. When the tab comes back into view and the
// server is running a newer build, reload (never mid-build in the studio).
{
  let bootBuild = null;
  let stale = false;
  const readBuild = () => fetch("/api/build", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => j?.build || null).catch(() => null);
  readBuild().then((b) => { bootBuild = b; });
  const check = async () => {
    if (!bootBuild) return;
    const now = await readBuild();
    if (now && now !== bootBuild) stale = true;
    if (stale && !studioOpen && document.visibilityState === "visible") location.reload();
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  window.addEventListener("focus", check);
  window.setInterval(() => { if (document.visibilityState === "hidden" || stale) check(); }, 5 * 60 * 1000);
}
