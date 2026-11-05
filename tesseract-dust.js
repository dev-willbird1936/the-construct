import * as THREE from "three";

// ── Time dust ────────────────────────────────────────────────────────────
// In the film the tesseract is the room pulled out along time into strands.
// Here the moment at the read head is pulled out the same way: fine, straight
// threads leave the subject's silhouette along the lattice's own axes
// (sideways and up/down, never toward the eye), each in the colour of the
// pixels it left, and fade as they run out into the beams. Rows and columns
// are spread evenly over the silhouette, so the threads read as the frame
// stretched, not as a spray. Only the now-pose sheds; the pose just behind it
// fades as the head moves on, so the threads follow a scrub. Presentation
// only: nothing here is measured, and the subject's own pixels are untouched.

const ROWS = 20;           // sideways threads per pose, one per row band
const COLS = 7;            // up/down threads per pose, one per column band
const TRAIL = 1.0;         // poses behind the head that still shed (fading)
const ALPHA_IN = 128;      // atlas alpha that counts as "inside the subject"

// Threads only need a silhouette to start from, so poses are read from a small
// copy (about DUST_SIDE pixels a pose). Drawing the full image into a canvas
// decodes it again on the main thread and held up the way in for a few
// hundred milliseconds a room, so the page hands over a reader that shrinks
// the texture already on the GPU and reads back only the small copy (rows top
// first, RGBA bytes as in the image). The canvas path is the fallback.
export const DUST_SIDE = 112;
// share of threads drawn (lower on hardware that cannot keep up)
let dustKeep = 1;
export function setDustDensity(keep) { dustKeep = keep; }
let gpuReader = null;
export function setPixelReader(reader) { gpuReader = reader; }
export async function readPixels(texture, scale = 1) {
  const image = texture.image;
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  if (gpuReader) {
    try {
      const px = gpuReader(texture, width, height);
      if (px) return { px, width, height };
    } catch { /* fall through to the canvas */ }
  }
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  ctx.canvas.width = width;
  ctx.canvas.height = height;
  ctx.drawImage(image, 0, 0, width, height);
  return { px: ctx.getImageData(0, 0, width, height).data, width, height };
}

// The colour a thread carries: a few opaque pixels just inside the edge it
// leaves from (the edge pixel itself is matte fringe).
function edgeColour(P, x, y, ix, iy) {
  const { px, stride, x0, y0, cw, ch } = P;
  let r = 0, g = 0, b = 0, n = 0;
  for (let k = 1; k <= 4; k += 1) {
    const cx = x + ix * k, cy = y + iy * k;
    if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) break;
    const o = ((y0 + cy) * stride + (x0 + cx)) * 4;
    if (px[o + 3] < ALPHA_IN) continue;
    r += px[o]; g += px[o + 1]; b += px[o + 2]; n += 1;
  }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
}
const opaque = (P, x, y) => P.px[((P.y0 + y) * P.stride + (P.x0 + x)) * 4 + 3] >= ALPHA_IN;

// Where one pose's threads start: evenly spread rows shed sideways from the
// silhouette's side edges, evenly spread columns shed up and down from its top
// and bottom. `back` is the share of rows that also shed backward (against
// the row's direction of travel, across the older poses).
function edgeThreads(P, bands, back, out) {
  const { cw, ch } = P;
  let top = ch, bottom = -1, left = cw, right = -1;
  for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) {
    if (!opaque(P, x, y)) continue;
    if (y < top) top = y; if (y > bottom) bottom = y;
    if (x < left) left = x; if (x > right) right = x;
  }
  if (bottom < top) return;
  // threads start just behind the card, so the subject hides whatever part of
  // a thread falls inside it as drawn: a head pose that plays a short loop, or
  // one shown a little larger, never has threads crossing its body
  const at = (ex, ey) => [P.centre.x + (ex / cw - 0.5) * P.w, P.centre.y + (0.5 - ey / ch) * P.h, P.centre.z - 0.03];
  const rows = Math.max(2, Math.round(ROWS * bands)), cols = Math.max(1, Math.round(COLS * bands));
  for (let k = 0; k < rows; k += 1) {
    const y = top + Math.floor((k + 0.05 + Math.random() * 0.9) / rows * (bottom - top + 1));
    let xl = left, xr = right;
    while (xl <= right && !opaque(P, xl, y)) xl += 1;
    while (xr >= left && !opaque(P, xr, y)) xr -= 1;
    if (xl > xr) continue;
    const cr = edgeColour(P, xr, y, -1, 0), cl = edgeColour(P, xl, y, 1, 0);
    if (cr && P.forward >= 0) out.push({ p: at(xr + 1, y + 0.5), c: cr, d: [1, 0] });
    if (cl && (P.forward <= 0 || Math.random() < back)) out.push({ p: at(xl, y + 0.5), c: cl, d: [-1, 0] });
    if (cr && P.forward < 0 && Math.random() < back) out.push({ p: at(xr + 1, y + 0.5), c: cr, d: [1, 0] });
  }
  for (let k = 0; k < cols; k += 1) {
    const x = left + Math.floor((k + 0.05 + Math.random() * 0.9) / cols * (right - left + 1));
    let yt = top, yb = bottom;
    while (yt <= bottom && !opaque(P, x, yt)) yt += 1;
    while (yb >= top && !opaque(P, x, yb)) yb -= 1;
    if (yt > yb) continue;
    const ct = edgeColour(P, x, yt, 0, 1), cb = edgeColour(P, x, yb, 0, -1);
    if (ct) out.push({ p: at(x + 0.5, yt), c: ct, d: [0, 1] });
    if (cb) out.push({ p: at(x + 0.5, yb + 1), c: cb, d: [0, -1] });
  }
}

// Each kind of room describes its poses the same way: where the pose's card
// sits in the group (centre and size), and the RGBA pixels it shows (a
// rectangle inside a larger pixel buffer). `forward` is the side the
// sideways threads lean to (+1 / -1), or 0 for no lean.
async function chronoPoses(group) {
  const u = group.userData;
  const image = u.map?.image, meta = u.meta;
  if (!image?.width || !meta?.cols || !meta?.rows || !(u.poseW > 0) || !(u.poseH > 0)) return null;
  const cellW = image.width / meta.cols, cellH = image.height / meta.rows;
  const scale = Math.min(1, DUST_SIDE / Math.max(cellW, cellH));
  const { px, width } = await readPixels(u.map, scale);
  const cw = Math.floor(cellW * scale), ch = Math.floor(cellH * scale);
  return group.children.filter((m) => m.userData.order !== undefined).map((mesh) => {
    const i = mesh.userData.order;
    return {
      order: i, px, stride: width, x0: Math.floor((i % meta.cols) * cellW * scale), y0: Math.floor(Math.floor(i / meta.cols) * cellH * scale), cw, ch,
      centre: mesh.position, w: u.poseW, h: u.poseH,
    };
  });
}

async function posesFor(group) {
  const u = group.userData;
  if (u.chrono) return { poses: await chronoPoses(group), forward: 1 };
  if (typeof u.dustPoses === "function") return { poses: await u.dustPoses(), forward: u.dustForward ?? 0 };
  return { poses: null };
}

// resolves to the dust for a group (or null); the poses' pixels are read first
export async function buildDust(group) {
  const { poses, forward = 0 } = await posesFor(group);
  if (!poses?.length) return null;

  // a moment with several animals shares one moment's worth of threads, so a
  // pack sheds as much as a single animal instead of a blinding sheaf
  const perOrder = new Map();
  for (const P of poses) perOrder.set(P.order, (perOrder.get(P.order) || 0) + 1);

  // each thread is a thin quad (start and end, either side), so it can be
  // drawn a pixel wide with a soft edge instead of as an aliased GL line
  const origin = [], colour = [], dir = [], seed = [], pose = [], corner = [], index = [];
  // a subject over its own picture: the threads leave from the picture's edge
  // (the frame stretched on past itself), never as lines drawn across it
  const frame = Array.isArray(group.userData.dustFrame) && group.userData.dustFrame.length === 4 ? group.userData.dustFrame : null;
  for (const P of poses) {
    const threads = [];
    // in a chrono row the older poses stand behind the head and are its past:
    // one row in five also sheds backward across them, the rest only forward.
    // A subject over its own picture sheds both ways, so it gets fewer bands,
    // or the threads net the whole picture
    edgeThreads({ ...P, forward }, (forward ? 1 : 0.45) / perOrder.get(P.order), 0.2, threads);
    for (const t of threads) {
      if (frame) {
        if (t.d[0] > 0) t.p[0] = Math.max(t.p[0], frame[2]);
        if (t.d[0] < 0) t.p[0] = Math.min(t.p[0], frame[0]);
        if (t.d[1] > 0) t.p[1] = Math.max(t.p[1], frame[3]);
        if (t.d[1] < 0) t.p[1] = Math.min(t.p[1], frame[1]);
      }
      const s = [Math.random(), Math.random()];
      const base = origin.length / 3;
      for (const [e, side] of [[0, -1], [0, 1], [1, -1], [1, 1]]) {
        origin.push(...t.p);
        colour.push(...t.c);
        dir.push(...t.d);
        seed.push(...s);
        pose.push(P.order);
        corner.push(e, side);
      }
      index.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
  }
  if (!origin.length) return null;

  const uniforms = {
    uGroup: { value: new THREE.Matrix4() },
    uCentre: { value: new THREE.Vector2() },
    uHalf: { value: 4.75 },
    uHead: { value: 0 },
    uTime: { value: 0 },
    uAlpha: { value: 1 },
    uKeep: { value: 1 },
    // 0..1: how far the threads have drawn out from the silhouette (each time
    // you arrive in the room they draw out again)
    uReach: { value: 1 },
    // the drawing buffer in pixels, and the line width in pixels
    uView: { value: new THREE.Vector2(1, 1) },
    uPixel: { value: 1 },
  };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(origin, 3));
  geometry.setAttribute("aColour", new THREE.Float32BufferAttribute(colour, 3));
  geometry.setAttribute("aDir", new THREE.Float32BufferAttribute(dir, 2));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 2));
  geometry.setAttribute("aPose", new THREE.Float32BufferAttribute(pose, 1));
  geometry.setAttribute("aCorner", new THREE.Float32BufferAttribute(corner, 2));
  geometry.setIndex(index);
  const threads = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aColour;
      attribute vec2 aDir, aSeed, aCorner;
      attribute float aPose;
      uniform mat4 uGroup;
      uniform vec2 uCentre, uView;
      uniform float uHalf, uHead, uKeep, uReach, uPixel;
      varying vec3 vC;
      varying float vLive, vAlong, vLen, vAcross, vSeed;
      void main() {
        vec4 w0 = uGroup * vec4(position, 1.0);
        // most run out before the room's wall, some on to it, so their ends
        // are spread and soft rather than one ruled edge
        float toWall = uHalf - dot(w0.xy - uCentre, aDir);
        float len = max(0.6, toWall * (0.35 + 0.75 * fract(aSeed.y * 13.7)));
        // threads draw out a little apart from each other, not as one ring
        float reach = clamp(uReach * 1.35 - aSeed.y * 0.35, 0.0, 1.0);
        vec4 w1 = w0;
        w1.xy += aDir * max(len * reach, 0.001);
        vec4 c0 = projectionMatrix * viewMatrix * w0;
        vec4 c1 = projectionMatrix * viewMatrix * w1;
        // widen across the thread on screen, so it is the same few pixels at any depth
        vec2 d = (c1.xy / c1.w - c0.xy / c0.w) * uView;
        vec2 n = length(d) > 1e-4 ? normalize(vec2(-d.y, d.x)) : vec2(0.0, 1.0);
        vec4 c = mix(c0, c1, aCorner.x);
        c.xy += n * aCorner.y * (0.5 * uPixel + 1.0) * 2.0 / uView * c.w;
        gl_Position = c;
        vAlong = aCorner.x;
        vLen = len * reach;
        vAcross = aCorner.y;
        vSeed = aSeed.x;
        float age = uHead - aPose;
        vLive = smoothstep(-0.7, 0.0, age) * (1.0 - smoothstep(0.0, ${TRAIL.toFixed(1)}, age)) * step(aSeed.x, uKeep);
        // footage colour lifted to a common brightness and warmed a little
        // toward the construct's amber, so a black cat sheds as visibly as a white one
        float m = max(max(aColour.r, aColour.g), aColour.b);
        vC = mix(aColour / max(m, 0.12) * 0.95, vec3(1.0, 0.82, 0.58), 0.3);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uAlpha, uPixel;
      varying vec3 vC;
      varying float vLive, vAlong, vLen, vAcross, vSeed;
      void main() {
        if (vLive <= 0.002) discard;
        // a pixel-wide core with a soft edge
        float halfWidth = 0.5 * uPixel;
        float cover = clamp(halfWidth + 0.5 - abs(vAcross) * (halfWidth + 1.0), 0.0, 1.0);
        // bright where it leaves the subject, fading as it runs out
        float s = vAlong * vLen;
        float fade = smoothstep(0.0, 0.08, s) * (0.15 + 0.85 * exp(-s / 3.0)) * (1.0 - smoothstep(0.45, 1.0, vAlong));
        // most threads faint, a few bright: a sheen, not a ruled sheet
        float strength = 0.25 + 0.75 * pow(fract(vSeed * 7.31), 1.5);
        float breathe = 0.86 + 0.14 * sin(uTime * 0.35 + vSeed * 40.0);
        float a = cover * vLive * fade * breathe * strength * uAlpha;
        gl_FragColor = vec4(vC * a, 1.0);
      }
    `,
  }));
  threads.frustumCulled = false;
  threads.renderOrder = 50;

  const dust = new THREE.Group();
  dust.add(threads);
  dust.userData = { uniforms, head: null };
  return dust;
}

// Keep the dust on its specimen and at its read head. `cut` is the same read
// head ratio tickChrono takes; the head pose's index is derived the same way.
export function syncDust(dust, group, { cut, time, alpha, centre, half, pixel, view, delta, reach = 1 }) {
  const u = dust.userData.uniforms;
  u.uReach.value = reach;
  if (view) u.uView.value.copy(view);
  u.uKeep.value = dustKeep;
  group.updateMatrixWorld();
  u.uGroup.value.copy(group.matrixWorld);
  const count = group.userData.count || 1;
  const head = typeof group.userData.dustHead === "function"
    ? group.userData.dustHead(cut)
    : Math.max(1, Math.round(count * cut)) - 1;
  // ease the head so a newly reached pose's threads grow in rather than pop;
  // a long jump (a looping cell wrapping round, a big scrub) snaps instead of
  // sweeping every pose in between
  const prev = dust.userData.head;
  dust.userData.head = prev == null || Math.abs(head - prev) > 3 ? head : prev + (head - prev) * Math.min(1, delta * 6);
  u.uHead.value = dust.userData.head;
  u.uTime.value = time;
  u.uAlpha.value = alpha;
  u.uCentre.value.set(centre.x, centre.y);
  u.uHalf.value = half;
  u.uPixel.value = pixel;
}

export function disposeDust(dust) {
  if (!dust) return;
  dust.children.forEach((child) => { child.geometry.dispose(); child.material.dispose(); });
  dust.clear();
}

// The chrono row's floor is a plane at the poses' feet. In the construct the
// animal hangs mid-room, far above the room's own floor, so any pool on that
// plane reads as a floating amber smear seen edge-on (centred on the row, it
// sat beside the subject at early read heads). The poses keep their contact
// shadows; the floor plane and the path ribbon are hidden.
export function warmChronoFloor(group) {
  const ribbon = group.children.find((m) => m.userData.isRibbon);
  if (ribbon) ribbon.visible = false;
  const ground = group.children.find((m) => m.userData.isGround);
  if (ground) ground.visible = false;
}
