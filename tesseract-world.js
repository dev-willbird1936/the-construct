import * as THREE from "three";
import { readPixels, DUST_SIDE } from "./tesseract-dust.js";

// ── Advanced world in a tesseract room ───────────────────────────────────
// A published Advanced build used to hang as a flat still: the room loader
// only knew the Basic specimen format. The world bake (stable.json version 2)
// already holds what a room needs: the recorded place with the animals painted
// out (the plate), and one matted crop per animal per sampled moment, with its
// box in the frame and its estimated distance. The room shows the plate as its
// back window and the crops standing in front of it at their own relative
// depth, so the subject crosses its own recorded world as you scrub; the poses
// behind the read head stay as a few fading ghosts. Depth here is the build's
// estimate turned into a layer offset, a presentation of it, not a measurement.

const SAMPLES = 28;      // moments shown along the read head
const GHOST_EVERY = 4;   // every fourth moment behind the head stays as a ghost
const GHOSTS = 5;        // at most this many ghosts per animal

// dust only needs each crop's silhouette: a small copy (see DUST_SIDE)
function pixelsOf(texture) {
  const image = texture.image;
  return readPixels(texture, Math.min(1, DUST_SIDE / Math.max(image.width, image.height)));
}

// A recorded place sits in the construct's amber light: footage colour comes
// down a fifth in saturation, and a camera's neon greens (high chroma) down
// almost half, so a vivid meadow reads as a place in the room rather than a
// lit screen. GLSL after the map is sampled, on linear colour.
const PLATE_GRADE = `
      {
        vec3 c = diffuseColor.rgb;
        float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
        diffuseColor.rgb = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, mix(0.8, 0.55, smoothstep(0.25, 0.6, chroma)));
      }`;

// The plate ends softly at the recorded frame's edge and sits under the
// subject's brightness, so the animal is the light in the room. The fade uses
// the plane's own UVs, so it still lands on the edge when the map is cropped.
export function plateMaterial(map) {
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false, fog: false });
  material.color.setScalar(0.62);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = ("varying vec2 vPlateUv;\n" + shader.vertexShader).replace("#include <uv_vertex>", `#include <uv_vertex>
      vPlateUv = uv;`);
    shader.fragmentShader = ("varying vec2 vPlateUv;\n" + shader.fragmentShader).replace("#include <map_fragment>", `#include <map_fragment>${PLATE_GRADE}
      diffuseColor.a *= smoothstep(0.0, 0.07, min(min(vPlateUv.x, 1.0 - vPlateUv.x), min(vPlateUv.y, 1.0 - vPlateUv.y)));`);
  };
  material.customProgramCacheKey = () => "world-cell-plate";
  return material;
}

// The construct's frame is tone-mapped (ACES) and bloomed as a whole, which
// turns light fur cream-grey. Subject cards get a vibrance lift (up to x1.35 for
// pale, low-chroma fur, none for an already vivid coat, which ACES pushes toward
// orange on its own) and a trim that keeps them under the bloom threshold.
// GLSL to run after the map is sampled, on linear colour.
export const SUBJECT_GRADE = `
  {
    vec3 c = diffuseColor.rgb;
    float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    float lift = mix(1.35, 1.0, smoothstep(0.15, 0.5, chroma));
    diffuseColor.rgb = max(mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, lift), 0.0) * 0.9;
  }`;

// edge: which sides of the card the source frame cuts (left, right, top,
// bottom as 0/1). An animal leaving the shot is a half body with a straight
// cut; the card dissolves toward that side instead of ending in a hard line.
function subjectMaterial(map, edge = [0, 0, 0, 0]) {
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.02, depthWrite: false, toneMapped: false, fog: false });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEdge = { value: new THREE.Vector4(...edge) };
    shader.vertexShader = ("varying vec2 vCardUv;\n" + shader.vertexShader).replace("#include <uv_vertex>", `#include <uv_vertex>
      vCardUv = uv;`);
    shader.fragmentShader = ("uniform vec4 uEdge;\nvarying vec2 vCardUv;\n" + shader.fragmentShader).replace("#include <map_fragment>", `#include <map_fragment>${SUBJECT_GRADE}
      diffuseColor.a *= mix(1.0, smoothstep(0.0, 0.22, vCardUv.x), uEdge.x) * mix(1.0, smoothstep(0.0, 0.22, 1.0 - vCardUv.x), uEdge.y)
        * mix(1.0, smoothstep(0.0, 0.22, 1.0 - vCardUv.y), uEdge.z) * mix(1.0, smoothstep(0.0, 0.22, vCardUv.y), uEdge.w);`);
  };
  material.customProgramCacheKey = () => "world-cell-subject";
  return material;
}

// Trail cameras burn a date/time band into the bottom rows; inside a room it
// reads as a caption under the animal. Same test as view-basic.js: in the
// bottom 15%, the share of pixels far from their row's mean, with an absolute
// floor and a jump over the row two above (overlay text is a sharp band;
// grass and ripples ramp). Returns the fraction from the top where the band
// starts, or 1 when there is none.
export function overlayTop(image) {
  if (!image?.width || !image?.height) return 1;
  const w = Math.min(640, image.width), h = Math.round(image.height * (w / image.width));
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.drawImage(image, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const start = Math.floor(h * 0.85), scores = [];
  for (let r = start; r < h; r += 1) {
    let mean = 0;
    for (let x = 0; x < w; x += 1) { const o = (r * w + x) * 4; mean += 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]; }
    mean /= w;
    let hi = 0;
    for (let x = 0; x < w; x += 1) { const o = (r * w + x) * 4; if (Math.abs(0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2] - mean) > 50) hi += 1; }
    scores.push(hi / w);
  }
  const med = [...scores].sort((a, b) => a - b)[scores.length >> 1];
  const th = Math.max(0.10, 2.5 * med);
  for (let k = 0; k < scores.length; k += 1) {
    if (scores[k] > th && scores[k] >= 3 * scores[Math.max(0, k - 2)] + 0.02) return Math.max(0.8, (start + k) / h - 0.012);
  }
  return 1;
}

// Show only the frame above the band: the map is cropped by its transform and
// the plane is shortened from the bottom, so everything placed by frame
// coordinates (the subject cards) stays where it was.
export function cropPlate(mesh, keep, width, height) {
  if (!(keep < 1)) return;
  mesh.geometry.dispose();
  mesh.geometry = new THREE.PlaneGeometry(width, height * keep).translate(0, (height - height * keep) / 2, 0);
  mesh.userData.keep = keep;
  applyCrop(mesh.material.map, keep);
}
function applyCrop(texture, keep) {
  if (!texture || !(keep < 1)) return;
  texture.repeat.set(1, keep);
  texture.offset.set(0, 1 - keep);
  texture.needsUpdate = true;
}

// A faint mirror of the plate's lower part under its bottom edge, as on a dark
// glossy floor, so the window stands on something instead of floating. It
// shares the plate's map (and its crop transform): the plane's v runs from the
// plate's bottom edge back up into the picture, so the map mirrors itself.
const REFLECT = 0.4; // share of the visible picture height that is mirrored
export function addReflection(group, plate, width, height) {
  const keep = plate.userData.keep || 1;
  const h = height * keep * REFLECT;
  const geometry = new THREE.PlaneGeometry(width, h);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setY(i, (1 - uv.getY(i)) * REFLECT);
  // half the plate's own tone at its own opacity: call once the plate is final
  const material = new THREE.MeshBasicMaterial({ map: plate.material.map, transparent: true, depthWrite: false, toneMapped: false, fog: false, opacity: plate.material.opacity });
  material.color.copy(plate.material.color).multiplyScalar(0.5);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = ("varying vec2 vMirrorUv;\n" + shader.vertexShader).replace("#include <uv_vertex>", `#include <uv_vertex>
      vMirrorUv = uv;`);
    shader.fragmentShader = ("varying vec2 vMirrorUv;\n" + shader.fragmentShader).replace("#include <map_fragment>", `#include <map_fragment>${PLATE_GRADE}
      diffuseColor.a *= 0.3 * (1.0 - smoothstep(0.0, ${REFLECT.toFixed(2)}, vMirrorUv.y)) * smoothstep(0.0, 0.07, min(vMirrorUv.x, 1.0 - vMirrorUv.x));`);
  };
  material.customProgramCacheKey = () => "world-cell-mirror";
  const mirror = new THREE.Mesh(geometry, material);
  mirror.position.set(0, height / 2 - height * keep - h / 2 - height * 0.01, 0);
  mirror.renderOrder = 0;
  group.add(mirror);
  plate.userData.mirror = mirror;
  return mirror;
}

// The place past the frame. A world whose worker continued its picture beyond
// the frame (stable.json fill.surround: env/surround.jpg, `pad` of the frame
// on each side) or a Basic build's expanded behind canvas hangs behind the
// plate, so the room shows a place that runs on into the dark instead of a
// picture with an edge. Under the frame it matches the plate, so the plate's
// soft edge melts into it; past the frame it dims and fades out by its own
// edge, lit from the picture outward.
export function surroundOf(meta) {
  const s = meta?.fill?.surround;
  if (!s || typeof s.tex !== "string" || !/^env\/[\w.-]+\.(jpg|png|webp)$/.test(s.tex) || !Array.isArray(s.pad) || s.pad.length !== 2 ||
      !s.pad.every((p) => typeof p === "number" && Number.isFinite(p) && p > 0 && p <= 1)) return null;
  return { tex: s.tex, pad: [s.pad[0], s.pad[1]] };
}
// reach: the share of the pad shown. A continued picture shows all of it; an
// edge-stretched canvas (Basic's behind) only its inner part, before the
// stretch reads as a smear.
export function addSurround(group, plate, map, pad, width, height, reach = 1) {
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false, fog: false });
  material.color.copy(plate.material.color);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPad = { value: new THREE.Vector2(pad[0], pad[1]) };
    shader.uniforms.uReach = { value: reach };
    shader.uniforms.uKeep = { value: plate.userData.keep || 1 };
    shader.vertexShader = ("varying vec2 vSurUv;\n" + shader.vertexShader).replace("#include <uv_vertex>", `#include <uv_vertex>
      vSurUv = uv;`);
    shader.fragmentShader = ("uniform vec2 uPad;\nuniform float uReach;\nuniform float uKeep;\nvarying vec2 vSurUv;\n" + shader.fragmentShader).replace("#include <map_fragment>", `#include <map_fragment>${PLATE_GRADE}
      vec2 f = vSurUv * (1.0 + 2.0 * uPad) - uPad;
      vec2 o = max(abs(f - 0.5) - 0.5, 0.0);
      float r = max(o.x / uPad.x, o.y / uPad.y) / uReach;
      // a plate cropped above a burned-in caption band: the surround stops
      // with the plate's own soft bottom edge, so the band never shows
      if (uKeep < 1.0) diffuseColor.a *= smoothstep(1.0 - uKeep, 1.0 - 0.93 * uKeep, f.y);
      diffuseColor.rgb *= 1.0 - 0.8 * smoothstep(0.0, 0.6, r);
      diffuseColor.a *= 1.0 - smoothstep(0.0, 0.9, r);`);
  };
  material.customProgramCacheKey = () => "world-cell-surround";
  // the plane covers frame + reach*pad; its uv picks that window of the map
  const geometry = new THREE.PlaneGeometry(width * (1 + 2 * pad[0] * reach), height * (1 + 2 * pad[1] * reach));
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, (pad[0] * (1 - reach) + uv.getX(i) * (1 + 2 * pad[0] * reach)) / (1 + 2 * pad[0]),
      (pad[1] * (1 - reach) + uv.getY(i) * (1 + 2 * pad[1] * reach)) / (1 + 2 * pad[1]));
  }
  const surround = new THREE.Mesh(geometry, material);
  surround.position.z = -0.02;
  surround.renderOrder = -1;
  group.add(surround);
  plate.userData.surround = surround;
  return surround;
}

// Where a plate room's threads start: the picture's rectangle, grown halfway
// out across its surround (where the place is fading into the dark), so the
// threads take over from the picture instead of being drawn across it.
export function dustFrameOf(plate, pad, width, height) {
  const keep = plate.userData.keep || 1;
  const gx = width * pad[0] * 0.55, gy = height * pad[1] * 0.55;
  return [-width / 2 - gx, height / 2 - height * keep - (keep < 1 ? 0 : gy), width / 2 + gx, height / 2 + gy];
}

// The picture is not flat: its estimated depth (a Basic build's plate depth,
// an Advanced world's grid) brings the ground nearer than the subject's feet
// toward the eye and sets the far ground back, up to RELIEF of the picture's
// height, so a turn shows the place recede behind its subject. `near(u, v)`
// is 0 far .. 1 near at frame uv (v from the top); `ref` is the level that
// stays in the plate's plane. The rim is pinned flat, where the picture
// fades into its surround. Depth here is a presentation of the estimate.
const RELIEF = 0.35;
export function reliefPlate(mesh, width, height, near, ref) {
  const keep = mesh.userData.keep || 1;
  const sx = 64, sy = 36;
  const geometry = new THREE.PlaneGeometry(width, height * keep, sx, sy).translate(0, (height - height * keep) / 2, 0);
  const pos = geometry.attributes.position;
  const z = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i += 1) z[i] = near(pos.getX(i) / width + 0.5, 0.5 - pos.getY(i) / height) - ref;
  // one 3x3 pass: the estimate's speckle would ripple the picture as it turns
  for (let iy = 0; iy <= sy; iy += 1) {
    for (let ix = 0; ix <= sx; ix += 1) {
      let s = 0, n = 0;
      for (let jy = Math.max(0, iy - 1); jy <= Math.min(sy, iy + 1); jy += 1) for (let jx = Math.max(0, ix - 1); jx <= Math.min(sx, ix + 1); jx += 1) { s += z[jy * (sx + 1) + jx]; n += 1; }
      const u = ix / sx, v = iy / sy, edge = Math.min(u, 1 - u, v, 1 - v);
      const rim = edge >= 0.14 ? 1 : (edge / 0.14) ** 2 * (3 - 2 * edge / 0.14);
      pos.setZ(iy * (sx + 1) + ix, (s / n) * RELIEF * height * rim);
    }
  }
  geometry.computeBoundingSphere();
  mesh.geometry.dispose();
  mesh.geometry = geometry;
}
// Bilinear lookup in a w x h grid of 0..1 values, frame uv (v from the top).
export function gridSampler(values, w, h) {
  return (u, v) => {
    const gx = Math.min(w - 1, Math.max(0, u * (w - 1))), gy = Math.min(h - 1, Math.max(0, v * (h - 1)));
    const x0 = Math.min(w - 2, Math.floor(gx)), y0 = Math.min(h - 2, Math.floor(gy)), fx = gx - x0, fy = gy - y0;
    const at = (x, y) => values[y * w + x];
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
}
// A world's plate depth is its grid's env part (log depth along the lens):
// only that part is fetched (a range request; a server without ranges sends
// the file, and it is read at the part's offset).
async function worldRelief(base, meta, plate, width, height, feet) {
  const g = Array.isArray(meta.grid?.parts) ? meta.grid.parts.find((p) => p?.part === "env") : null;
  if (!g || typeof meta.grid.file !== "string" || !/^[\w.-]+$/.test(meta.grid.file) || !(g.w > 1 && g.h > 1) || g.z?.type !== "u16log" || !Number.isInteger(g.z.at) || g.z.at % 2) return;
  const count = g.w * g.h;
  const response = await fetch(`${base}/${meta.grid.file}`, { headers: { Range: `bytes=${g.z.at}-${g.z.at + count * 2 - 1}` } });
  if (!response.ok) return;
  const buffer = await response.arrayBuffer();
  const at = response.status === 206 ? 0 : g.z.at;
  if (buffer.byteLength < at + count * 2) return;
  const q = new Uint16Array(buffer, at, count);
  // nearer is a smaller depth; the 2nd..98th percentile spans 0..1
  const sorted = Float32Array.from(q).sort();
  const lo = sorted[Math.floor(count * 0.02)], hi = sorted[Math.floor(count * 0.98)];
  if (!(hi > lo)) return;
  const near = gridSampler(Float32Array.from(q, (d) => Math.min(1, Math.max(0, (hi - d) / (hi - lo)))), g.w, g.h);
  const levels = feet.map(([u, v]) => near(u, v)).sort((a, b) => a - b);
  reliefPlate(plate, width, height, near, levels.length ? levels[levels.length >> 1] : 0.5);
}

function cameraDepth(meta, centroid) {
  const camera = Array.isArray(meta.cameras) && meta.cameras[0];
  if (!camera || !Array.isArray(centroid)) return Array.isArray(centroid) ? -centroid[2] : 1;
  const e = new THREE.Matrix4().fromArray(camera).invert().elements;
  const [x, y, z] = centroid;
  return -(e[2] * x + e[6] * y + e[10] * z + e[14]);
}

export async function buildWorldCell(base, { fit, loadTexture }) {
  const response = await fetch(`${base}/stable.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`world cell: stable.json HTTP ${response.status}`);
  const meta = await response.json();
  const shells = Array.isArray(meta.shells) ? meta.shells.filter((s) => s && Array.isArray(s.box) && s.tex && Number.isFinite(s.t)) : [];
  const env = Array.isArray(meta.env) ? meta.env[0] : null;
  const plateUrl = env?.live?.plate || env?.tex;
  if (meta.version !== 2 || !shells.length || !plateUrl || !(meta.width > 0) || !(meta.height > 0)) throw new Error("world cell: not a version 2 world with shells");

  // Even moments across the clip; at each, the nearest shell of every animal
  // that is present within half a second of it.
  const tracks = new Map();
  for (const s of shells) {
    if (!tracks.has(s.track)) tracks.set(s.track, []);
    tracks.get(s.track).push(s);
  }
  for (const list of tracks.values()) list.sort((a, b) => a.t - b.t);
  const t0 = Math.min(...shells.map((s) => s.t)), t1 = Math.max(...shells.map((s) => s.t));
  const n = Math.max(1, Math.min(SAMPLES, Math.max(...[...tracks.values()].map((l) => l.length))));
  const picks = [];
  for (let k = 0; k < n; k += 1) {
    const t = n === 1 ? t0 : t0 + (t1 - t0) * (k / (n - 1));
    for (const list of tracks.values()) {
      let best = null;
      for (const s of list) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
      if (best && Math.abs(best.t - t) <= 0.5) picks.push({ order: k, shell: best });
    }
  }
  if (!picks.length) throw new Error("world cell: no shells near the sampled moments");

  const aspect = meta.width / meta.height;
  const { height } = fit(aspect);
  const width = height * aspect;
  const group = new THREE.Group();

  const plateTex = await loadTexture(`${base}/${plateUrl}`);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(width, height), plateMaterial(plateTex));
  plate.renderOrder = 0;
  cropPlate(plate, overlayTop(plateTex.image), width, height);
  group.add(plate);
  // the place runs on past the frame where the worker continued it; only a
  // world without that stands on a mirror of itself
  const sur = surroundOf(meta);
  const surTex = sur ? await loadTexture(`${base}/${sur.tex}`).catch(() => null) : null;
  if (surTex) addSurround(group, plate, surTex, sur.pad, width, height);
  else addReflection(group, plate, width, height);
  const reach = surTex ? sur.pad : [0, 0];

  // nearer animals stand further forward of the plate; the whole spread is a
  // fraction of the frame height so the room's parallax stays gentle
  const depths = picks.map((p) => cameraDepth(meta, p.shell.centroid));
  const dMin = Math.min(...depths), dMax = Math.max(...depths);
  const zFar = height * 0.07, zNear = height * 0.3;
  const bottomPx = (plate.userData.keep || 1) * meta.height;

  const textures = await Promise.all(picks.map((p) => loadTexture(`${base}/${p.shell.tex}`).catch(() => null)));
  const cards = [];
  picks.forEach((p, index) => {
    const texture = textures[index];
    if (!texture) return;
    const [x0, y0, x1, y1] = p.shell.box;
    const w = ((x1 - x0) / meta.width) * width, h = ((y1 - y0) / meta.height) * height;
    if (!(w > 0) || !(h > 0)) return;
    // the bottom of the picture is the plate's crop line when a date band was cut
    const edge = [x0 <= 1, x1 >= meta.width - 1, y0 <= 1, y1 >= bottomPx - 2].map(Number);
    const card = new THREE.Mesh(new THREE.PlaneGeometry(w, h), subjectMaterial(texture, edge));
    // a body the frame cuts belongs in the frame's own plane, so parallax
    // cannot swing it out past the plate over the wall
    const near = dMax > dMin ? (dMax - depths[index]) / (dMax - dMin) : 0.5;
    const z = edge.some(Boolean) ? zFar * 0.5 : zFar + near * (zNear - zFar);
    card.position.set(((x0 + x1) / 2 / meta.width - 0.5) * width, (0.5 - (y0 + y1) / 2 / meta.height) * height, z);
    card.userData = { order: p.order, track: p.shell.track, w, h };
    card.renderOrder = 1 + p.order;
    cards.push(card);
    group.add(card);
  });
  if (!cards.length) throw new Error("world cell: no shell textures loaded");
  // the ground at the animal's feet stays in the plate's plane (it lands later; flat until then)
  worldRelief(base, meta, plate, width, height, cards.map((c) => [c.position.x / width + 0.5, 0.5 - (c.position.y - c.userData.h / 2) / height])).catch(() => {});

  const sampleTimes = Array.from({ length: n }, (_, k) => (n === 1 ? t0 : t0 + (t1 - t0) * (k / (n - 1))));
  group.userData = {
    worldCell: true, generated: true, depth: 0, width, height, count: n, cards, sampleTimes, plate,
    liveUrl: env?.live?.video ? `${base}/${env.live.video}` : null,
    dustForward: 0,
    // threads leave from where the picture fades out, not across it
    dustFrame: dustFrameOf(plate, reach, width, height),
    dustHead: (cut) => Math.max(1, Math.round(n * cut)) - 1,
    // the dust sheds from each card's own matte
    dustPoses: async () => (await Promise.all(cards.map(async (card) => {
      const image = card.material.map?.image;
      if (!image?.width) return null;
      const { px, width: cw, height: ch } = await pixelsOf(card.material.map);
      return { order: card.userData.order, px, stride: cw, x0: 0, y0: 0, cw, ch, centre: card.position, w: card.userData.w, h: card.userData.h };
    }))).filter(Boolean),
  };
  tickWorldCell(group, 1);
  return group;
}

// The world's own footage as the back layer, loaded the first time its room is
// in focus (about 10-15 MB, so never for rooms nobody visits). It has only the
// picked animals painted out, so a pack the customer did not pick stays as
// filmed, and water keeps the state it had at that moment. Until it arrives,
// and if it never does, the still plate stays.
export function wakeWorldCell(group) {
  const u = group.userData;
  if (!u?.worldCell || u.liveRequested || !u.liveUrl) return;
  u.liveRequested = true;
  fetch(u.liveUrl).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((blob) => {
    if (u.released) return;
    const video = document.createElement("video");
    video.muted = video.playsInline = true;
    video.preload = "auto";
    video.src = URL.createObjectURL(blob);
    video.addEventListener("loadeddata", () => {
      if (u.released) return;
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const still = u.plate.material.map;
      applyCrop(texture, u.plate.userData.keep);
      u.plate.material.map = texture;
      u.plate.material.needsUpdate = true;
      const mirror = u.plate.userData.mirror;
      if (mirror) {
        mirror.material.map = texture;
        mirror.material.needsUpdate = true;
      }
      still?.dispose();
      u.video = video;
      u.videoHead = null;
    }, { once: true });
  }).catch(() => {}); // the still plate stays
}

export function releaseWorldCell(group) {
  const u = group.userData;
  if (!u?.worldCell) return;
  u.released = true;
  if (u.video) {
    u.video.pause();
    URL.revokeObjectURL(u.video.src);
    u.video.removeAttribute("src");
    u.video = null;
  }
}

// The read head: the moment at the cut in full, a few earlier ones as fading
// ghosts (cooler and dimmer, every GHOST_EVERY moments), the future hidden.
export function tickWorldCell(group, cut) {
  const u = group.userData;
  if (!u?.worldCell) return;
  const head = u.dustHead(cut);
  // the live footage behind the shells shows the same moment as the head
  const video = u.video;
  if (video && video.readyState >= 2 && u.videoHead !== head && !video.seeking) {
    video.currentTime = Math.max(0, u.sampleTimes[head] || 0);
    u.videoHead = head;
  }
  if (u.shownHead === head) return;
  u.shownHead = head;
  for (const card of u.cards) {
    const age = head - card.userData.order;
    const ghost = age > 0 && age % GHOST_EVERY === 0 && age / GHOST_EVERY <= GHOSTS;
    card.visible = age === 0 || ghost;
    if (!card.visible) continue;
    const fade = age === 0 ? 1 : 0.55 * (1 - age / (GHOST_EVERY * (GHOSTS + 1)));
    card.material.opacity = fade;
    if (age === 0) card.material.color.setRGB(1, 1, 1);
    else card.material.color.setRGB(0.62, 0.68, 0.78);
  }
}
