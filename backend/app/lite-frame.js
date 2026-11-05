// Lite auto-framing maths: fit the camera to the real alpha bounds of the
// subject plus the depth of the slice stack.
//
// Dependency-free on purpose: `volume.js` imports bare `three` (resolved by
// the browser importmap), so node unit tests cannot import it. This module has
// no imports, so both `view-lite.js` (browser) and `tests/lite/**` (node)
// share the exact function the viewer uses.

const degToRad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Footpath ribbon: a flat strip through the poses' foot points, coloured by
// time (cool old -> warm now). Pure geometry math; the viewer lifts it to
// ground level. points: [{x, z, t}] with t in [0,1]; width in world units.
export function ribbonStrip(points, width, { colorA = [0.25, 0.4, 0.7], colorB = [1.0, 0.72, 0.35], taperEnds = true } = {}) {
  const n = points.length;
  if (n < 2) return { positions: [], colors: [], index: [] };
  const w = Math.max(0.001, Number(width) || 0.001);
  const profile = (i) => {
    if (!taperEnds || n <= 2) return 1;
    // Taper to a point at both ends so the path never shows a plate edge.
    const s = Math.sin((Math.PI * i) / (n - 1));
    return Math.pow(Math.max(0, s), 0.7);
  };
  const positions = [];
  const colors = [];
  const index = [];
  for (let i = 0; i < n; i += 1) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz, nz = dx;
    const t = Math.min(1, Math.max(0, Number(p.t) || 0));
    const ww = w * profile(i);
    const col = colorA.map((c, k) => c + (colorB[k] - c) * t);
    positions.push(p.x + nx * ww / 2, 0, p.z + nz * ww / 2, p.x - nx * ww / 2, 0, p.z - nz * ww / 2);
    colors.push(...col, ...col);
    if (i > 0) {
      const v = (i - 1) * 2;
      index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
  return { positions, colors, index };
}

// Projected-bounds fit for a chrono row. A toward-camera subject's near
// pose looms: fitting the row's rest-yaw width clips it at the yaw
// extremes. Instead every pose corner is projected at the rest yaw, both
// yaw bounds and both pitch bounds (same yaw-then-pitch order as the
// viewer's group rotation), and the camera sits where the worst corner
// clears the frame. Pure: same inputs the viewer has from atlas.json.
export function fitChronoRow(
  { count, poseW, poseH, rowLen, depth, scaleNow = 1.06 },
  { fovDeg, aspect, yawRest = -0.3, yawBound = 0.52, pitchBound = 0.28, fill = 0.9, widthFill = 0.97, aimY = 0 } = {}
) {
  // Straight-row special case of fitChronoPoints: even spacing by pose
  // index along x with matched z recession. Delegates so the proof logic
  // lives in exactly one place.
  const n = Number(count);
  const pw = Number(poseW), ph = Number(poseH);
  const rl = Number(rowLen) || 0, d = Number(depth) || 0;
  if (!(n >= 1 && pw > 0 && ph > 0)) throw new Error("fitChronoRow needs count >= 1 and positive pose dims.");
  const points = [];
  for (let i = 0; i < n; i += 1) {
    const u = n <= 1 ? 0.5 : i / (n - 1);
    points.push({
      x: (u - 0.5) * rl,
      z: (u - 0.5) * d,
      hw: pw / 2,
      hh: ph / 2,
      s: i === n - 1 ? Number(scaleNow) || 1 : 1,
    });
  }
  return fitChronoPoints(points, { fovDeg, aspect, yawRest, yawBound, pitchBound, fill, widthFill, aimY });
}

// Vertical placement for one chrono pose: its own bbox bottom (fraction
// from the cell top, 0..1) sits on groundY. A pose that fills its cell stays
// centred; a smaller/high one is lifted down to the floor.
export function poseMeshY(anchorBottomFrac, poseH, groundY) {
  const n = Number(anchorBottomFrac);
  const f = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  return Number(groundY) + (f - 0.5) * Number(poseH);
}
// slices, but a subject that travels fills only part of it. `subjectFill`
// (additive field from packAtlas: median per-slice alpha bbox as a fraction
// of the union crop, each in (0,1]) shrinks the fit box to the subject
// instead of its travel. Missing/invalid fill defaults to the full planes.
export function subjectFitDims({ width, height }, subjectFill) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 1;
  };
  const fw = clamp(num(subjectFill?.w), 0.15, 1);
  const fh = clamp(num(subjectFill?.h), 0.15, 1);
  return { fitW: width * fw, fitH: height * fh };
}

// Distance along +z that frames the solid at `fill` (fraction of the view
// height taken by the subject, target ~0.55). The fit is computed at the
// viewer's resting orientation (a three-quarter turn: yaw ~0.42, pitch 0),
// where the stack's depth swings partly onto screen-x; the 55% target leaves
// enough headroom that the solid stays framed at the drag bounds too.
// Width must also clear the view (portrait stages, wide subjects). A
// near-plane guard keeps the front slice off the lens for very deep stacks.
// The returned value is the z-distance; callers keep their own x/y offsets
export const PORTRAIT_MAX = 5;
export function selectPortraitIndices(count, timestamps, max = PORTRAIT_MAX) {
  const n = Math.floor(Number(count));
  if (!(n >= 1)) throw new Error("selectPortraitIndices needs count >= 1.");
  const k = Math.min(n, Math.max(2, Math.floor(Number(max) || PORTRAIT_MAX)));
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const ts = Array.isArray(timestamps) && timestamps.length === n && timestamps.every((v) => Number.isFinite(Number(v)))
    ? timestamps.map(Number) : Array.from({ length: n }, (_, i) => i);
  const idx = [0];
  for (let j = 1; j < k - 1; j += 1) {
    const f = ts[0] + ((ts[n - 1] - ts[0]) * j) / (k - 1);
    let best = -1, bd = Infinity;
    for (let i = 1; i < n - 1; i += 1) {
      if (idx.includes(i)) continue;
      const d = Math.abs(ts[i] - f);
      if (d < bd) { bd = d; best = i; }
    }
    idx.push(best < 0 ? Math.min(n - 2, Math.max(1, Math.round((j * (n - 1)) / (k - 1)))) : best);
  }
  idx.push(n - 1);
  return [...new Set(idx)].sort((a, b) => a - b);
}

// Portrait diagonal points for narrow stages: oldest far/up-right, the now
// pose near/bottom-left, every foot on the floor. Sizing is honest
// perspective (no per-pose scale except the now marker) — the near pose
// reads large, far poses peek up-right, shadows stay under each foot.
// spreadK/depthK are multiples of poseW: width vs recession trade-off.
export function portraitChronoPoints(
  { count, poseW, poseH, spreadK = 1.0, depthK = 2.0, timestamps = null, max = PORTRAIT_MAX, scaleNow = 1.06 }
) {
  const pw = Number(poseW), ph = Number(poseH);
  if (!(pw > 0 && ph > 0)) throw new Error("portraitChronoPoints needs positive pose dims.");
  const indices = selectPortraitIndices(count, timestamps, max);
  const k = indices.length;
  const S = Number(spreadK) * pw, DP = Number(depthK) * pw;
  if (!(S >= 0 && DP >= 0)) throw new Error("portraitChronoPoints needs non-negative spread/depth.");
  return {
    indices,
    points: indices.map((order, j) => ({
      order,
      x: k <= 1 ? 0 : (0.5 - j / (k - 1)) * S,
      z: k <= 1 ? 0 : (j / (k - 1) - 0.5) * DP,
      hw: pw / 2,
      hh: ph / 2,
      s: j === k - 1 ? Number(scaleNow) || 1 : 1,
    })),
  };
}

// Projected-bounds fit over arbitrary pose points (each {x, z, hw, hh, s}):
// every corner clears the frame at the rest yaw, both yaw bounds and both
// pitch bounds (same yaw-then-pitch order as the viewer group rotation).
// aimY shifts the frame centre vertically (camera lookAt height): corners
// are measured relative to it, so a lowered stage stays inside at every
// bound. Pure: same inputs the viewer has from atlas.json.
export function fitChronoPoints(
  points,
  { fovDeg, aspect, yawRest = -0.3, yawBound = 0.52, pitchBound = 0.28, fill = 0.9, widthFill = 0.97, aimY = 0 } = {}
) {
  const pts = Array.isArray(points) ? points : [];
  if (!pts.length) throw new Error("fitChronoPoints needs at least one point.");
  const fov = Number(fovDeg);
  const asp = Number(aspect);
  if (!(fov > 0 && fov < 90 && asp > 0)) throw new Error("fitChronoPoints needs fovDeg in (0,90) and positive aspect.");
  const target = clamp(Number(fill) || 0.9, 0.2, 0.95);
  const targetW = clamp(Number(widthFill) || 0.97, 0.2, 0.98);
  const tanHalf = Math.tan(degToRad(fov) / 2);
  const yaws = [yawRest - yawBound, yawRest, yawRest + yawBound];
  const pitches = [-pitchBound, 0, pitchBound];
  let need = 0;
  for (const { x, z, hw, hh, s } of pts) {
    const sNow = Number(s) || 1;
    for (const yaw of yaws) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      for (const p of pitches) {
        const cp = Math.cos(p), sp = Math.sin(p);
        for (const [lx, ly] of [[-hw * sNow, -hh * sNow], [hw * sNow, -hh * sNow], [-hw * sNow, hh * sNow], [hw * sNow, hh * sNow]]) {
          const x1 = x + lx * cy, z1 = z - lx * sy;
          const y1 = ly * cp - z1 * sp - Number(aimY || 0), z2 = ly * sp + z1 * cp;
          need = Math.max(
            need,
            Math.abs(x1) / (tanHalf * asp * targetW) + z2,
            Math.abs(y1) / (tanHalf * target) + z2
          );
        }
      }
    }
  }
  return Math.max(need * 1.06, 2);
}
// height taken by the subject, target ~0.55). The fit is computed at the
// viewer's resting orientation (a three-quarter turn: yaw ~0.42, pitch 0),
// where the stack's depth swings partly onto screen-x; the 55% target leaves
// enough headroom that the solid stays framed at the drag bounds too.
// Width must also clear the view (portrait stages, wide subjects). A
// near-plane guard keeps the front slice off the lens for very deep stacks.
// The returned value is the z-distance; callers keep their own x/y offsets
// and drag/scroll bounds.
export function fitSolidDistance(
  { width, height, depth },
  { fovDeg, aspect, fill = 0.55, widthFill = 0.8, yaw = 0.42, pitch = 0, subjectFill = null } = {}
) {
  const w = Number(width);
  const h = Number(height);
  const d = Number(depth);
  if (!(w > 0 && h > 0 && d >= 0)) throw new Error("fitSolidDistance needs positive width/height and non-negative depth.");
  const fov = Number(fovDeg);
  const asp = Number(aspect);
  if (!(fov > 0 && fov < 90 && asp > 0)) throw new Error("fitSolidDistance needs fovDeg in (0,90) and positive aspect.");
  const target = clamp(Number(fill) || 0.55, 0.2, 0.95);
  const targetW = clamp(Number(widthFill) || 0.8, 0.2, 0.95);

  const { fitW, fitH } = subjectFitDims({ width: w, height: h }, subjectFill);
  const tanHalf = Math.tan(degToRad(fov) / 2);
  const restYaw = Math.abs(Number(yaw) || 0);
  const restPitch = Math.abs(Number(pitch) || 0);
  const effH = (fitH / 2) * Math.cos(Math.min(restPitch, Math.PI / 2)) + (d / 2) * Math.sin(Math.min(restPitch, Math.PI / 2));
  const effW = (fitW / 2) * Math.cos(Math.min(restYaw, Math.PI / 2)) + (d / 2) * Math.sin(Math.min(restYaw, Math.PI / 2));
  const dist = Math.max(effH / (tanHalf * target), effW / (tanHalf * asp * targetW)) * 1.06;
  // Never park the camera inside the stack: keep 1 unit clear of the front slice.
  return Math.max(dist, d / 2 + 1);
}
