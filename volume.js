import * as THREE from "three";
import { regularisePositions, validateMeta } from "./stable-math.mjs";
// NOTE: poseMeshY/subjectFitDims/fitSolidDistance/fitChronoRow/ribbonStrip are canonically
// defined in backend/app/lite-frame.js (lite agent, shared with tests/lite/**).
// They are copied here — not imported — because the production static server
// never serves /backend/*, so a browser import of that path 404s and kills
// the whole module graph. Keep the copies byte-identical to canonical.
function poseMeshY(anchorBottomFrac, poseH, groundY) {
  const n = Number(anchorBottomFrac);
  const f = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  return Number(groundY) + (f - 0.5) * Number(poseH);
}

const degToRad = (d) => (d * Math.PI) / 180;
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function subjectFitDims({ width, height }, subjectFill) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 1;
  };
  const fw = clampNum(num(subjectFill?.w), 0.15, 1);
  const fh = clampNum(num(subjectFill?.h), 0.15, 1);
  return { fitW: width * fw, fitH: height * fh };
}

export function fitSolidDistance(
  { width, height, depth },
  { fovDeg, aspect, fill = 0.55, widthFill = 0.8, yaw = 0.42, pitch = 0, subjectFill = null } = {}
) {  const w = Number(width);
  const h = Number(height);
  const d = Number(depth);
  if (!(w > 0 && h > 0 && d >= 0)) throw new Error("fitSolidDistance needs positive width/height and non-negative depth.");
  const fov = Number(fovDeg);
  const asp = Number(aspect);
  if (!(fov > 0 && fov < 90 && asp > 0)) throw new Error("fitSolidDistance needs fovDeg in (0,90) and positive aspect.");
  const target = clampNum(Number(fill) || 0.55, 0.2, 0.95);
  const targetW = clampNum(Number(widthFill) || 0.8, 0.2, 0.95);
  const { fitW, fitH } = subjectFitDims({ width: w, height: h }, subjectFill);
  const tanHalf = Math.tan(degToRad(fov) / 2);
  const restYaw = Math.abs(Number(yaw) || 0);
  const restPitch = Math.abs(Number(pitch) || 0);
  const effH = (fitH / 2) * Math.cos(Math.min(restPitch, Math.PI / 2)) + (d / 2) * Math.sin(Math.min(restPitch, Math.PI / 2));
  const effW = (fitW / 2) * Math.cos(Math.min(restYaw, Math.PI / 2)) + (d / 2) * Math.sin(Math.min(restYaw, Math.PI / 2));
  const dist = Math.max(effH / (tanHalf * target), effW / (tanHalf * asp * targetW)) * 1.06;
  return Math.max(dist, d / 2 + 1);
}

// Browser mirrors of canonical lite-frame.js helpers (see NOTE above):
// selectPortraitIndices, portraitChronoPoints, fitChronoPoints, and
// fitChronoRow as the straight-row special case. Keep byte-identical.
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

export function fitChronoPoints(
  points,
  { fovDeg, aspect, yawRest = -0.3, yawBound = 0.52, pitchBound = 0.28, fill = 0.9, widthFill = 0.97, aimY = 0 } = {}
) {
  const pts = Array.isArray(points) ? points : [];
  if (!pts.length) throw new Error("fitChronoPoints needs at least one point.");
  const fov = Number(fovDeg);
  const asp = Number(aspect);
  if (!(fov > 0 && fov < 90 && asp > 0)) throw new Error("fitChronoPoints needs fovDeg in (0,90) and positive aspect.");
  const target = clampNum(Number(fill) || 0.9, 0.2, 0.95);
  const targetW = clampNum(Number(widthFill) || 0.97, 0.2, 0.98);
  const tanHalf = Math.tan(degToRad(fov) / 2);
  const yaws = [yawRest - yawBound, yawRest, yawRest + yawBound];
  const pitches = [-pitchBound, 0, pitchBound];
  let need = 0;
  for (const { x, z, hw, hh, s } of pts) {
    const sNow = Number(s) || 1;
    const aim = Number(aimY) || 0;
    for (const yaw of yaws) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      for (const p of pitches) {
        const cp = Math.cos(p), sp = Math.sin(p);
        for (const [lx, ly] of [[-hw * sNow, -hh * sNow], [hw * sNow, -hh * sNow], [-hw * sNow, hh * sNow], [hw * sNow, hh * sNow]]) {
          const x1 = x + lx * cy, z1 = z - lx * sy;
          const y1 = ly * cp - z1 * sp - aim, z2 = ly * sp + z1 * cp;
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

// Straight-row special case of fitChronoPoints (mirror of the canonical
// delegation): even index spacing along x with matched z recession.
export function fitChronoRow(
  { count, poseW, poseH, rowLen, depth, scaleNow = 1.06 },
  { fovDeg, aspect, yawRest = -0.3, yawBound = 0.52, pitchBound = 0.28, fill = 0.9, widthFill = 0.97, aimY = 0 } = {}
) {
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

// View-only framing (not mirrored in lite-frame.js: the atlas sizes poses
// with the canonical fit above and never calls these, so outputs are
// untouched). The canonical fit models an on-axis camera; the viewer's
// camera sits up and to the right and looks back at the row, so the nearer
// poses loomed off centre (wide rows sat ~20% right, the phone hero clipped
// the left edge). This projects the displayed subjects the way three.js
// does, pans camera and target together to centre them, and picks the
// closest distance where the rest view fills `fill` and every drag extreme
// stays inside `edge`. The pan is sampled across the drag range so the row
// stays centred while it turns (chronoPanAt).
const unit3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
function projectRects(rects, yaw, pitch, C, T, tanHalf, aspect, cardYaw = 0) {
  const f = unit3([T[0] - C[0], T[1] - C[1], T[2] - C[2]]);
  const r = unit3([-f[2], 0, f[0]]);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // Each card may turn about its own upright axis (cardYaw) inside the group.
  const cc = Math.cos(cardYaw), sc = Math.sin(cardYaw);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zMin = Infinity;
  for (const p of rects) {
    for (const [lx, ly] of [[p.l, p.t], [p.r, p.t], [p.l, p.b], [p.r, p.b]]) {
      // Group rotation is Euler XYZ (pitch, yaw, 0): yaw about y, then pitch about x.
      const vx = p.x + lx * p.s * cc, vy = p.y + ly * p.s, vz = p.z - lx * p.s * sc;
      const ax = vx * cy + vz * sy, az = -vx * sy + vz * cy;
      const wy = vy * cp - az * sp, wz = vy * sp + az * cp;
      const dx = ax - C[0], dy = wy - C[1], dz = wz - C[2];
      const z = dx * f[0] + dy * f[1] + dz * f[2];
      if (z < zMin) zMin = z;
      const nx = (dx * r[0] + dy * r[1] + dz * r[2]) / (z * tanHalf * aspect);
      const ny = (dx * u[0] + dy * u[1] + dz * u[2]) / (z * tanHalf);
      if (nx < x0) x0 = nx; if (nx > x1) x1 = nx; if (ny < y0) y0 = ny; if (ny > y1) y1 = ny;
    }
  }
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zMin };
}

export function frameChronoView(rects, {
  fovDeg = 38, aspect, offset = [1.4, 0.9], elev = 0, aimY = 0, yawRest = -0.3, yawBound = 0.52, pitchBound = 0.28,
  fill = [0.94, 0.86], edge = [0.99, 0.98], yawSteps = 5, pitchSteps = 3, cardTurn = 0, minDist = 0,
} = {}) {
  const list = Array.isArray(rects) ? rects.filter((p) => p && ["x", "y", "z", "s", "l", "r", "t", "b"].every((k) => Number.isFinite(p[k]))) : [];
  if (!list.length) throw new Error("frameChronoView needs at least one pose rect.");
  const fov = Number(fovDeg), asp = Number(aspect);
  if (!(fov > 0 && fov < 90 && asp > 0)) throw new Error("frameChronoView needs fovDeg in (0,90) and positive aspect.");
  const tanHalf = Math.tan(degToRad(fov) / 2), tanElev = Math.tan(clampNum(Number(elev) || 0, 0, 1.2));
  const steps = (lo, hi, n) => (n <= 1 || hi === lo ? [(lo + hi) / 2] : Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1)));
  const yaws = steps(yawRest - yawBound, yawRest + yawBound, Math.max(1, Math.floor(yawSteps / 2) * 2 + 1));
  const pitches = steps(-pitchBound, pitchBound, Math.max(1, Math.floor(pitchSteps / 2) * 2 + 1));
  const camAt = (D, px, py) => [[offset[0] + px, offset[1] + D * tanElev + py, D], [px, aimY + py, 0]];
  // cardTurn: the viewer turns each card back toward the camera by this
  // share of the drag (chronoCardYaw), so the extremes are solved with it.
  const turn = Number(cardTurn) || 0;
  const look = (yaw, pitch, D, px, py) => { const [C, T] = camAt(D, px, py); return projectRects(list, yaw, pitch, C, T, tanHalf, asp, chronoCardYaw(yaw, yawRest, turn)); };
  // Newton steps with measured slopes (near poses shift faster than far
  // ones, so a fixed gain can overshoot); the returned box is always the one
  // at the returned pan, so the containment check is honest either way.
  const centre = (yaw, pitch, D) => {
    let px = 0, py = 0, b = look(yaw, pitch, D, 0, 0);
    const d = 0.01 * D;
    for (let k = 0; k < 8 && (Math.abs(b.cx) > 1e-4 || Math.abs(b.cy) > 1e-4); k += 1) {
      const sx = (look(yaw, pitch, D, px + d, py).cx - b.cx) / d;
      const sy = (look(yaw, pitch, D, px, py + d).cy - b.cy) / d;
      if (!(sx < 0 && sy < 0)) break;
      px -= b.cx / sx;
      py -= b.cy / sy;
      b = look(yaw, pitch, D, px, py);
    }
    return { x: px, y: py, b };
  };
  const restI = (yaws.length - 1) / 2, restJ = (pitches.length - 1) / 2;
  const solve = (D) => {
    const pans = [];
    for (let i = 0; i < yaws.length; i += 1) {
      pans.push([]);
      for (let j = 0; j < pitches.length; j += 1) {
        const c = centre(yaws[i], pitches[j], D);
        const [w, h] = i === restI && j === restJ ? fill : edge;
        if (!(c.b.zMin > 0.5 && c.b.x0 >= -w && c.b.x1 <= w && c.b.y0 >= -h && c.b.y1 <= h)) return null;
        pans[i].push({ x: c.x, y: c.y });
      }
    }
    return pans;
  };
  let hi = 4;
  while (!solve(hi)) { hi *= 2; if (hi > 4096) throw new Error("frameChronoView found no containing distance."); }
  let lo = 0.5;
  for (let k = 0; k < 20; k += 1) { const m = (lo + hi) / 2; if (solve(m)) hi = m; else lo = m; }
  // minDist: no closer than this (a view of a few poses must not magnify
  // the backdrop too far); kept only when it still contains them.
  if (Number(minDist) > hi && solve(Number(minDist))) hi = Number(minDist);
  const pans = solve(hi);
  return { dist: hi, camX: offset[0], camY: offset[1] + hi * tanElev, aimY, yaws, pitches, pans, rest: pans[restI][restJ] };
}

// A card's own turn inside the group: back toward the camera by `turn` of
// the drag away from rest (0 at rest, so the rest view is unchanged).
export function chronoCardYaw(yaw, yawRest, turn) {
  return -(Number(turn) || 0) * ((Number(yaw) || 0) - (Number(yawRest) || 0));
}

// Camera pan for the current (eased) yaw/pitch: bilinear over the sampled
// grid, clamped to the drag range.
export function chronoPanAt(frame, yaw, pitch) {
  if (!frame || !frame.pans) return { x: 0, y: 0 };
  const seg = (arr, v) => {
    if (arr.length <= 1) return [0, 0, 0];
    const t = clampNum(Number(v) || 0, arr[0], arr[arr.length - 1]);
    let i = 0;
    while (i < arr.length - 2 && t > arr[i + 1]) i += 1;
    const span = arr[i + 1] - arr[i];
    return [i, i + 1, span > 0 ? (t - arr[i]) / span : 0];
  };
  const [i0, i1, a] = seg(frame.yaws, yaw), [j0, j1, b] = seg(frame.pitches, pitch);
  const P = frame.pans, at = (i, j) => P[i][j] || P[i0][j0];
  const mix = (k) => (1 - a) * (1 - b) * at(i0, j0)[k] + a * (1 - b) * at(i1, j0)[k] + (1 - a) * b * at(i0, j1)[k] + a * b * at(i1, j1)[k];
  return { x: mix("x"), y: mix("y") };
}

// Spaced moments for a wide stage: up to k poses chosen by time (first and
// last kept), placed so their subject boxes (anchors) stand `gap` pose
// widths apart instead of overlapping, receding in depth with time like the
// row. Points carry the pose rect so the framing can be solved before any
// mesh moves.
export function spacedChronoPoints({ count, poseW, poseH, anchors = null, timestamps = null, k = 5, gap = 0.2, depthK = 0.15, scaleNow = 1.06 }) {
  const pw = Number(poseW), ph = Number(poseH);
  if (!(pw > 0 && ph > 0)) throw new Error("spacedChronoPoints needs positive pose dims.");
  const indices = selectPortraitIndices(count, timestamps, Math.max(2, Math.floor(k)));
  const n = indices.length;
  const box = (order) => {
    const a = Array.isArray(anchors) && anchors.length === Number(count) ? anchors[order] : null;
    const f = (v, d) => (Number.isFinite(Number(v)) ? clampNum(Number(v), 0, 1) : d);
    return a ? { l: f(a.left, 0), r: f(a.right, 1), t: f(a.top, 0), b: f(a.bottom, 1) } : { l: 0, r: 1, t: 0, b: 1 };
  };
  const scale = (j) => (j === n - 1 ? Number(scaleNow) || 1 : 1);
  const xs = [0];
  for (let j = 1; j < n; j += 1) {
    const prev = box(indices[j - 1]), cur = box(indices[j]);
    xs.push(xs[j - 1] + (prev.r - 0.5) * pw * scale(j - 1) - (cur.l - 0.5) * pw * scale(j) + gap * pw);
  }
  const span = xs[n - 1] - xs[0], mid = (xs[0] + xs[n - 1]) / 2;
  const depth = n <= 1 ? 0 : Math.min(4.6, Math.max(0.8, span * depthK));
  return {
    indices,
    points: indices.map((order, j) => {
      const b = box(order), u = n <= 1 ? 0.5 : j / (n - 1);
      return { order, x: xs[j] - mid, z: (u - 0.5) * depth, hw: pw / 2, hh: ph / 2, s: scale(j), box: b };
    }),
  };
}

// Rects for laid-out points (as chronoViewRects would see them once the
// meshes stand there): feet on the ground, the head keeps its whole cell.
export function chronoPointRects(points, { poseW, poseH }) {
  const W = Number(poseW), H = Number(poseH), groundY = -H / 2;
  return (points || []).map((p, j, all) => {
    const b = p.box || { l: 0, r: 1, t: 0, b: 1 };
    const head = j === all.length - 1;
    return {
      order: p.order, x: p.x, y: poseMeshY(b.b, H, groundY), z: p.z, s: p.s || 1,
      l: head ? -W / 2 : (b.l - 0.5) * W, r: head ? W / 2 : (b.r - 0.5) * W,
      t: head ? H / 2 : (0.5 - b.t) * H, b: head ? -H / 2 : (0.5 - b.b) * H,
    };
  });
}

// Each rect's on-screen height (share of the frame height) in the rest view
// of a solved frame.
export function chronoRestHeights(rects, frame, { fovDeg = 38, aspect, yawRest = -0.3 } = {}) {
  if (!frame || !frame.pans) return [];
  const tanHalf = Math.tan(degToRad(Number(fovDeg)) / 2);
  const p = frame.rest;
  const C = [frame.camX + p.x, frame.camY + p.y, frame.dist], T = [p.x, frame.aimY + p.y, 0];
  return rects.map((r) => { const b = projectRects([r], yawRest, 0, C, T, tanHalf, Number(aspect)); return (b.y1 - b.y0) / 2; });
}

// The displayed poses as subject rects in group space. The head (the
// now-pose: plays the live tail, stands 6% larger) keeps its whole cell,
// since live cells move inside it; the rest use their anchors.
export function chronoViewRects(group) {
  const u = group && group.userData;
  if (!u || !u.chrono) return [];
  const poses = group.children.filter((m) => m.userData.order !== undefined);
  const byOrder = new Map(poses.map((m) => [m.userData.order, m]));
  const orders = u.activeOrders && u.activeOrders.length
    ? u.activeOrders : poses.map((m) => m.userData.order).sort((a, b) => a - b);
  const anchors = Array.isArray(u.meta?.anchors) && u.meta.anchors.length === u.count ? u.meta.anchors : null;
  const W = u.poseW, H = u.poseH;
  const frac = (v, d) => (Number.isFinite(Number(v)) ? clampNum(Number(v), 0, 1) : d);
  return orders.map((order, j) => {
    const m = byOrder.get(order);
    if (!m) return null;
    const head = j === orders.length - 1;
    const a = !head && anchors ? anchors[order] : null;
    // A mirrored row (dir -1) shows each cell flipped: its anchors swap sides.
    const mir = u.dir === -1;
    const al = a ? (mir ? 1 - frac(a.right, 1) : frac(a.left, 0)) : 0, ar = a ? (mir ? 1 - frac(a.left, 0) : frac(a.right, 1)) : 1;
    return {
      order, x: m.position.x, y: m.position.y, z: m.position.z, s: head ? 1.06 : 1,
      l: (al - 0.5) * W, r: (ar - 0.5) * W,
      t: a ? (0.5 - frac(a.top, 0)) * H : H / 2, b: a ? (0.5 - frac(a.bottom, 1)) * H : -H / 2,
    };
  }).filter(Boolean);
}

function ribbonStrip(points, width, { colorA = [0.25, 0.4, 0.7], colorB = [1.0, 0.72, 0.35], taperEnds = true } = {}) {
  const n = points.length;
  if (n < 2) return { positions: [], colors: [], index: [] };
  const w = Math.max(0.001, Number(width) || 0.001);
  const profile = (i) => {
    if (!taperEnds || n <= 2) return 1;
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

// A volume is N quads stacked along z, each showing one cell of a sprite atlas.
// The slices share one texture (a single GPU upload) but each has its own
// material, so setCut can fade them by age: the moment at the cut is solid and
// the past thins into a ghost trail behind it.

// a touch over unity so the specimen is the brightest thing in its block
const GAIN = 1.1;
// Highlights are capped just under the bloom threshold, keeping hue: a white
// shirt otherwise flares into a glare blob and the figure is lost.
const CEILING = 0.86;

// Slices were a flat unlit decal: MeshBasicMaterial with no lighting response
// at all, dropped into a room that is otherwise fully lit, glossed and
// fogged. That flatness, more than anything else, is why a specimen reads as
// pasted onto the lattice rather than standing inside it. A real depth pass
// per slice (as Stable now does for its subject) would fix this properly,
// but re-baking eight already-baked animals is its own project; this instead
// gets a real-looking response from data every slice already carries. A
// cut-out's alpha channel falls to zero at its silhouette, so its
// screen-space gradient points from body to edge — treated as a fake normal,
// it gives a believable key light and a soft rim without any new bake.
function shadeSlice(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      {
        vec2 g = vec2(dFdx(diffuseColor.a), dFdy(diffuseColor.a));
        float gLen = length(g);
        // near the body's centre the alpha is flat (gLen ~ 0): face the camera.
        // near the silhouette it leans away, toward the edge.
        vec3 edgeN = gLen > 2e-4 ? normalize(vec3(-g * 40.0, 0.5)) : vec3(0.0, 0.0, 1.0);
        vec3 L = normalize(vec3(-0.35, 0.8, 0.5)); // the lattice's own key light direction
        float key = 0.62 + 0.38 * max(dot(edgeN, L), 0.0);
        float rim = pow(clamp(1.0 - edgeN.z, 0.0, 1.0), 1.6);
        diffuseColor.rgb *= key;
        diffuseColor.rgb += vec3(1.0, 0.92, 0.8) * rim * 0.55;
      }`
    )
    .replace(
      "#include <opaque_fragment>",
      `float peak = max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b));
      outgoingLight *= min(1.0, ${CEILING.toFixed(2)} / max(peak, 1e-4));
      #include <opaque_fragment>`
    );
}

function sliceMaterial(map) {
  const material = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
    // the specimen is the light in the room, so the construct's haze must not eat it
    fog: false,
  });
  material.onBeforeCompile = shadeSlice;
  material.customProgramCacheKey = () => "slice-shaded";
  return material;
}

export function buildAtlasVolume(texture, meta, options = {}) {
  const { depth = 4.6, height = 3.4 } = options;
  const group = new THREE.Group();
  const width = height * meta.aspect;

  for (let i = 0; i < meta.count; i += 1) {
    const col = i % meta.cols;
    const row = Math.floor(i / meta.cols);
    const u0 = col / meta.cols;
    const u1 = (col + 1) / meta.cols;
    // atlas rows run top-down, WebGL UVs run bottom-up
    const v0 = 1 - (row + 1) / meta.rows;
    const v1 = 1 - row / meta.rows;

    const geometry = new THREE.PlaneGeometry(width, height);
    geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([u0, v1, u1, v1, u0, v0, u1, v0], 2)
    );

    const t = meta.count <= 1 ? 1 : i / (meta.count - 1);
    const mesh = new THREE.Mesh(geometry, sliceMaterial(texture));
    mesh.position.z = (t - 0.5) * depth;
    mesh.renderOrder = i;
    group.add(mesh);
  }

  group.userData = { map: texture, meta, depth, width, height, count: meta.count };
  setCut(group, 1);
  return group;
}

// ── Chronophotograph (Lite product viewer) ────────────────────────────────
// A discrete row of motion-selected poses along the TIME axis, placed by pose
// INDEX (even spacing, step >= 0.7 x pose width) so time-clustered poses never
// stack head-on; the axis stays time-ordered and the readout shows true
// seconds per pose. Poses are OPAQUE cut-outs: alphaTest + depthWrite, no
// translucency anywhere — the 0.14-opacity smear slices that read as
// slabs/ghosts are gone by construction. Older poses darken (never below
// ~65% brightness) and desaturate toward 55% but stay solid; only the
// now-pose is full colour, rim-lit and slightly larger. setChronoCut reveals
// poses progressively, like the time read head. Geometry stays flat cards
// (no depth relief, no ground reflection): rim light only. Unlike
// buildAtlasVolume (kept for the tesseract cells).
// A premultiplied atlas (texture.premultiplyAlpha, stored as plain data,
// the Lite viewer's) samples without the halo straight alpha leaves: the
// filter would otherwise blend the RGB of the near-clear texels outside the
// matte (light or dark, whatever the resample left there) into the edge.
// The shader divides the alpha back out, decodes sRGB itself, and the edge
// is anti-aliased by alpha to coverage instead of a stair-stepped cut. It
// has no edge rim: on that one-pixel coverage edge the now-pose's rim drew
// a light dotted outline (a cut-out halo); the now-pose keeps its full
// colour and size.
const PREMUL_MAP = `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        vec3 chronoS = sampledDiffuseColor.a > 0.0 ? clamp( sampledDiffuseColor.rgb / sampledDiffuseColor.a, 0.0, 1.0 ) : vec3( 0.0 );
        sampledDiffuseColor.rgb = mix( pow( chronoS * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), chronoS * 0.0773993808, vec3( lessThanEqual( chronoS, vec3( 0.04045 ) ) ) );
        diffuseColor *= sampledDiffuseColor;
      #endif`;
function chronoMaterial(map) {
  const premul = !!map?.premultiplyAlpha;
  const material = new THREE.MeshBasicMaterial({
    map,
    transparent: false,
    alphaTest: 0.5,
    alphaToCoverage: premul,
    side: THREE.DoubleSide,
    depthWrite: true,
    toneMapped: false,
    fog: false,
  });
  const uSat = { value: 1 };
  const uRim = { value: 0 };
  const uRimColor = { value: new THREE.Color(1.0, 0.95, 0.84) };
  // Frame-cut dissolve (see applyCellCut): uCut = how deep the cut-out
  // dissolves toward each side the source frame cuts (left, right, top,
  // bottom, as a share of the cut-out; 0 = not cut), uCutRect = that
  // cut-out's rect in the cell (left, top, right, bottom fractions from the
  // top-left), uFade = 1 once the mesh blends (setCutFade).
  const uCut = { value: new THREE.Vector4(0, 0, 0, 0) };
  const uCutRect = { value: new THREE.Vector4(0, 0, 1, 1) };
  const uFade = { value: 0 };
  // uAppear: a pose just reached by the read head fades in (eased views).
  const uAppear = { value: 1 };
  // uAlpha: a ghost-trail pose's opacity (blending poses only; see setTrailLook).
  const uAlpha = { value: 1 };
  // uGain, uLift: a ghost of a dark subject on a bare (dark) stage has its
  // shadows exposed up to uGain times (rolling off to no lift at uKnee, so
  // a face or a white patch keeps its brightness) and taken up to uLift of
  // the way to a cool grey (uLiftColor sets the tint): it separates from the
  // dark room with its fur detail and without its fur cast (setTrailCut).
  const uGain = { value: 1 };
  const uKnee = { value: 0.1 };
  const uLift = { value: 0 };
  const uLiftColor = { value: new THREE.Color(0.2, 0.22, 0.27) };
  material.userData.uGain = uGain;
  material.userData.uKnee = uKnee;
  material.userData.uLift = uLift;
  material.userData.uLiftColor = uLiftColor;
  material.userData.uAppear = uAppear;
  material.userData.uAlpha = uAlpha;
  material.userData.premul = premul;
  material.userData.uSat = uSat;
  material.userData.uRim = uRim;
  material.userData.uRimColor = uRimColor;
  material.userData.uCut = uCut;
  material.userData.uCutRect = uCutRect;
  material.userData.uFade = uFade;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSat = uSat;
    shader.uniforms.uRim = uRim;
    shader.uniforms.uRimColor = uRimColor;
    shader.uniforms.uCut = uCut;
    shader.uniforms.uCutRect = uCutRect;
    shader.uniforms.uFade = uFade;
    shader.uniforms.uAppear = uAppear;
    shader.uniforms.uAlpha = uAlpha;
    shader.uniforms.uGain = uGain;
    shader.uniforms.uKnee = uKnee;
    shader.uniforms.uLift = uLift;
    shader.uniforms.uLiftColor = uLiftColor;
    // cellUv: the plane's own 0..1 UVs (the uv attribute holds the atlas
    // cell, which the live strip rewrites).
    shader.vertexShader = ("attribute vec2 cellUv;\nvarying vec2 vCellUv;\n" + shader.vertexShader).replace(
      "#include <uv_vertex>",
      `#include <uv_vertex>
      vCellUv = cellUv;`
    );
    // three builds the uniform prefix from its own list: custom uniforms
    // added in onBeforeCompile must be declared explicitly.
    shader.fragmentShader = ("uniform float uAppear;\nuniform float uAlpha;\nuniform float uGain;\nuniform float uKnee;\nuniform float uLift;\nuniform vec3 uLiftColor;\nuniform float uSat;\nuniform float uRim;\nuniform vec3 uRimColor;\nuniform vec4 uCut;\nuniform vec4 uCutRect;\nuniform float uFade;\nvarying vec2 vCellUv;\n" + shader.fragmentShader).replace(
      "#include <map_fragment>",
      `${premul ? PREMUL_MAP : "#include <map_fragment>"}
      {
        // A body the frame cuts dissolves toward each cut side instead of
        // ending in a straight line (as the tesseract world cards do).
        vec2 cutSize = max(uCutRect.zw - uCutRect.xy, vec2(1e-3));
        float cutY = 1.0 - vCellUv.y;
        float cutA = (uCut.x > 0.0 ? smoothstep(0.0, uCut.x * cutSize.x, vCellUv.x - uCutRect.x) : 1.0)
          * (uCut.y > 0.0 ? smoothstep(0.0, uCut.y * cutSize.x, uCutRect.z - vCellUv.x) : 1.0)
          * (uCut.z > 0.0 ? smoothstep(0.0, uCut.z * cutSize.y, cutY - uCutRect.y) : 1.0)
          * (uCut.w > 0.0 ? smoothstep(0.0, uCut.w * cutSize.y, uCutRect.w - cutY) : 1.0);
        float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = mix(vec3(luma), diffuseColor.rgb, uSat);
        if (uGain > 1.0) {
          // Shadow lift on luminance: uGain times at black, a soft (tanh)
          // roll-off to uKnee, nothing above it; the cool grey only as far
          // as the pixel was lifted.
          vec3 liftLw = vec3(0.299, 0.587, 0.114);
          float ll = max(dot(diffuseColor.rgb, liftLw), 1e-5);
          float ly = min(2.0 * ll * uGain / uKnee, 30.0);
          float lt = max(ll, uKnee * (1.0 - 2.0 / (exp(ly) + 1.0)));
          vec3 coolGrey = ll * uLiftColor / max(dot(uLiftColor, liftLw), 1e-4);
          float lk = clamp(uLift * (1.0 - ll / lt) * uGain / (uGain - 1.0), 0.0, uLift);
          diffuseColor.rgb = mix(diffuseColor.rgb, coolGrey, lk) * (lt / ll);
        }
        vec2 ag = vec2(dFdx(diffuseColor.a), dFdy(diffuseColor.a));
        float erim = ${premul ? "0.0" : "clamp(length(ag) * 60.0, 0.0, 1.0) * uRim * cutA"};
        diffuseColor.rgb += uRimColor * erim * 0.3;
        // Blending poses keep the same 0.5 matte, times the dissolve (a
        // premultiplied atlas anti-aliases it over one pixel).
        ${premul
          ? "if (uFade > 0.5) diffuseColor.a = clamp((diffuseColor.a - 0.5) / max(fwidth(diffuseColor.a), 1e-4) + 0.5, 0.0, 1.0) * cutA;"
          : "if (uFade > 0.5) diffuseColor.a = step(0.5, diffuseColor.a) * cutA;"}
        diffuseColor.a *= uAlpha;
        // Soft-shoulder highlight clamp: IR-flash white (rump, shirt) can hit
        // 1.0 and bloom into a blown patch. Above a 0.88 knee the luminance
        // compresses toward a ~0.93 ceiling, hue preserved (RGB scaled by one
        // factor); at and below the knee the scale is exactly 1 (min picks
        // luma), so mid-tones and the warm now-pose are untouched.
        float l2 = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        float over = max(l2 - 0.88, 0.0);
        float soft = 0.88 + over / (1.0 + over / 0.05);
        diffuseColor.rgb *= min(l2, soft) / max(l2, 1e-4);
      }`
    );
    if (premul) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <alphatest_fragment>",
        `#include <alphatest_fragment>
      diffuseColor.a *= uAppear;
      if (diffuseColor.a <= 0.0) discard;`
      );
    }
  };
  material.customProgramCacheKey = () => (premul ? "chrono-cut-premul" : "chrono-cut");
  return material;
}

// Frame cuts per atlas cell (atlas.json `cuts`: per side, the share of the
// cut-out's side that the source frame cuts, and its rect in the cell). Old
// atlases have none and every pose stays opaque and unchanged. The dissolve
// runs over the last 22% of the cut-out once half a side or more is cut (a
// body leaving the shot, a bust) and shortens below that, so paws or a hair
// line grazing the edge keep their legs and forehead.
const CUT_FADE = 0.22;
function cutDepth(share) {
  const s = Number(share);
  return Number.isFinite(s) ? CUT_FADE * Math.min(1, Math.max(0, (s - 0.1) / 0.4)) : 0;
}
function cellCut(meta, index) {
  const c = Array.isArray(meta?.cuts) ? meta.cuts[index] : null;
  return c && Array.isArray(c.sides) && c.sides.length === 4 && Array.isArray(c.rect) && c.rect.length === 4 && c.sides.some((s) => cutDepth(s) > 0) ? c : null;
}
function applyCellCut(mesh, meta, index) {
  const u = mesh.material?.userData;
  if (!u?.uCut) return;
  const c = cellCut(meta, index);
  u.uCut.value.set(...(c ? c.sides.map(cutDepth) : [0, 0, 0, 0]));
  if (c) u.uCutRect.value.set(...c.rect.map(Number));
}
// A pose that shows any frame-cut cell blends (sorted back to front by its
// renderOrder like the rest of the row) so its dissolve is a real fade;
// fully faded texels are discarded and never write depth.
function setCutFade(mesh) {
  mesh.material.transparent = true;
  mesh.material.alphaToCoverage = false;
  mesh.material.alphaTest = 0.01;
  mesh.material.userData.uFade.value = 1;
}

// Faint pool of floor under the row: radial gradient canvas texture, solid
// at the centre fading to the void, so the poses stand in space.
// Floor under the row. The canvas is square with the gradient radius at
// half its side, so on the wide ground plane it is an ellipse that reaches
// zero before EVERY edge (the old 2:1 canvas kept 55-95% alpha along the
// near and far edges: a hard navy slab across the stage). On a photo stage
// (the clip's own place behind the row) it is a soft neutral contact shade
// instead of a blue pool, so the poses stand IN the place.
function groundMaterial(onPhoto = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  if (onPhoto) {
    g.addColorStop(0, "rgba(0,0,0,0.34)");
    g.addColorStop(0.5, "rgba(0,0,0,0.18)");
    g.addColorStop(0.85, "rgba(0,0,0,0.04)");
    g.addColorStop(1, "rgba(0,0,0,0)");
  } else {
    g.addColorStop(0, "rgba(48,59,79,1)");
    g.addColorStop(0.45, "rgba(30,38,53,0.9)");
    g.addColorStop(0.75, "rgba(10,13,19,0.45)");
    g.addColorStop(1, "rgba(2,3,4,0)");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthWrite: false, toneMapped: false, fog: false,
  });
}

function chronoBackdropMaterial(map) {
  // The place behind the row: a big dark plate that melts into the floor
  // pool at the horizon (bottom fade) and into the void everywhere else,
  // so it reads as 'this subject, in that place' without competing.
  const material = new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, toneMapped: false, fog: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = ("varying vec2 vBdUv;\n" + shader.fragmentShader).replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      diffuseColor.a *= smoothstep(0.0, 0.12, vBdUv.y) * (1.0 - 0.6 * smoothstep(0.75, 1.0, vBdUv.y)) * smoothstep(0.0, 0.08, vBdUv.x) * (1.0 - smoothstep(0.92, 1.0, vBdUv.x));`
    );
    shader.vertexShader = ("varying vec2 vBdUv;\n" + shader.vertexShader).replace(
      "#include <uv_vertex>",
      `#include <uv_vertex>
      vBdUv = uv;`
    );
  };
  material.customProgramCacheKey = () => "chrono-backdrop";
  return material;
}

// Soft contact blob for a photo stage: a black ellipse that fades to zero
// (one shared texture). The squashed black silhouette reads as a hard plank
// on a lit floor, cast sideways against the clip's own light.
let _blobTexture = null;
function blobShadowMaterial() {
  if (!_blobTexture) {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(0.55, "rgba(0,0,0,0.28)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    _blobTexture = new THREE.CanvasTexture(c);
    _blobTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const material = new THREE.MeshBasicMaterial({ map: _blobTexture, transparent: true, depthWrite: false, toneMapped: false, fog: false });
  // Seen from near floor level the flat ellipses collapse into thin dark
  // dashes that join into one wire across the stage (muntjac, L5). Fade a
  // blob by how edge-on the floor is to the camera: full from about 25 deg
  // above the floor, gone below about 7 deg.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = ("varying float vBlobFace;\n" + shader.vertexShader).replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      {
        vec3 bw = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vec3 bn = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
        vBlobFace = abs(dot(normalize(cameraPosition - bw), bn));
      }`
    );
    shader.fragmentShader = ("varying float vBlobFace;\n" + shader.fragmentShader).replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      diffuseColor.a *= smoothstep(0.12, 0.42, vBlobFace);`
    );
  };
  material.customProgramCacheKey = () => "chrono-blob";
  return material;
}

function shadowMaterial(map, uv) {
  const material = new THREE.MeshBasicMaterial({
    map, transparent: true, opacity: 0.4, depthWrite: false,
    toneMapped: false, fog: false,
  });
  material.color.setRGB(0, 0, 0);
  material.userData.uv = uv;
  return material;
}

// Ghost trail (atlas.json `trail`, written by new Lite packs): the tracked
// frames between consecutive poses, each with its atlas cell, its place on
// the row (`at`, a fractional pose index: 2.25 is a quarter of the way from
// pose 2 to pose 3 in time) and its own bbox bottom. With it the row reads
// as one continuous exposure, chronophotography rather than a row of
// copies: the now-pose solid, every earlier pose and in-between frame
// overlapping it and fading toward the start. Old atlases have no trail.
export function chronoTrail(meta) {
  const t = meta && meta.trail;
  const n = Number(meta && meta.count) || 0;
  if (!t || !Array.isArray(t.cells) || !Array.isArray(t.at) || t.cells.length !== t.at.length || n < 2) return null;
  const out = [];
  for (let j = 0; j < t.cells.length; j += 1) {
    const cell = Number(t.cells[j]), at = Number(t.at[j]);
    if (!Number.isInteger(cell) || cell < 0 || !(at > 0 && at < n - 1)) continue;
    const b = Array.isArray(t.bottom) && t.bottom[j] !== null ? Number(t.bottom[j]) : NaN;
    const f = Array.isArray(t.fit) && t.fit[j] !== null ? Number(t.fit[j]) : NaN;
    out.push({ cell, at, bottom: Number.isFinite(b) ? Math.min(1, Math.max(0, b)) : 1, fit: f > 0 ? f : null });
  }
  return out.length ? out.sort((a, b) => a.at - b.at) : null;
}
// Stroboscopic trail (a Marey or Muybridge overlay, a multi-flash photo):
// a trail row shows up to STROBE_COUNT crisp cards, every pose plus trail
// frames spread evenly in time, laid out evenly along the row so each
// silhouette starts STROBE_GAP of a body width after the one before (they
// overlap by the rest). Opacity by age, from TRAIL_NEAR just behind the
// solid now-pose down to TRAIL_FAR at the first card shown.
export const STROBE_COUNT = 16, STROBE_GAP = 0.5;
// A room-fitted row (the construct) is shorter for its pose size, so its
// cards sit STROBE_ROOM_GAP of a body width apart (60% overlap).
export const STROBE_ROOM_GAP = 0.4;
// Below STROBE_STILL_MOTION (atlas.json `motion`, the poses' mean pairwise
// change) a row shows STROBE_STILL_COUNT cards STROBE_STILL_GAP apart.
export const STROBE_STILL_MOTION = 0.06, STROBE_STILL_COUNT = 6, STROBE_STILL_GAP = 0.85;
// Ghost lift for a dark subject on a bare stage (the construct): every card
// but the now-pose has its shadows exposed up to TRAIL_GAIN times (its fur
// detail with them), rolling off to none at TRAIL_KNEE (linear luminance),
// and taken up to TRAIL_LIFT of the way to a cool grey of the same brightness.
export const TRAIL_GAIN = 3, TRAIL_LIFT = 0.7, TRAIL_KNEE = 0.1;
// A room-fitted trail row (the construct's fitChronoCell passes it as
// `trailStep`) is TRAIL_STEP pose widths per pose long; the strobe cards
// fill that length. Below a plain row's 0.85, so the room fits each pose
// about 1.25x larger.
export const TRAIL_STEP = 0.65;
// Stride trail (every 5th tracked frame): neighbouring cards start
// STRIDE_GAP of a pose width apart, so they overlap as the frames do.
export const STRIDE_GAP = 0.09;
export const TRAIL_NEAR = 0.8, TRAIL_FAR = 0.15, TRAIL_GAMMA = 1;
// Which trail frames join the poses on a strobe row of `n` cards: the
// frames left over are shared among the gaps between poses (any remainder
// to the gaps nearest the now-pose), each gap taking its frames nearest to
// even times. Returns indices into `ats` (fractional pose indices), sorted.
export function strobeSelect(ats, count, n) {
  const gaps = Number(count) - 1;
  const need = Math.max(0, Math.floor(Number(n) || 0) - Number(count));
  if (!(gaps > 0) || !need || !Array.isArray(ats)) return [];
  const base = Math.floor(need / gaps), extra = need - base * gaps;
  const out = [];
  for (let g = 0; g < gaps; g += 1) {
    const m = base + (g >= gaps - extra ? 1 : 0);
    const cands = [];
    ats.forEach((a, j) => { if (Number(a) > g && Number(a) < g + 1) cands.push(j); });
    const used = new Set();
    for (let k = 1; k <= m && used.size < cands.length; k += 1) {
      const want = g + k / (m + 1);
      let best = -1, bd = Infinity;
      for (const j of cands) {
        const d = Math.abs(Number(ats[j]) - want);
        if (!used.has(j) && d < bd) { bd = d; best = j; }
      }
      used.add(best);
    }
    out.push(...used);
  }
  return out.sort((a, b) => Number(ats[a]) - Number(ats[b]));
}
// A dark subject (atlas.json `dark`, a black cat) keeps its ghosts more
// opaque: dark on a dark room, a fainter ghost disappears.
export const TRAIL_DARK_NEAR = 0.95, TRAIL_DARK_FAR = 0.2;
export function trailAlpha(age, dark = false) {
  const a = Math.min(1, Math.max(0, Number(age) || 0));
  const near = dark ? TRAIL_DARK_NEAR : TRAIL_NEAR, far = dark ? TRAIL_DARK_FAR : TRAIL_FAR;
  return far + (near - far) * Math.pow(1 - a, TRAIL_GAMMA);
}
// True size: every cell fills its cell on its own (a subject seen end-on is
// enlarged more than side-on, and a now-pose whose box takes in spray is
// shrunk), so a trail card is drawn at its source size beside the now-pose:
// the now-pose's cell enlargement over the card's, never above 1 (the row's
// framing assumes cell-filling cards), and at least TRAIL_SIZE_MIN.
export const TRAIL_SIZE_MIN = 0.3;
export function trailSize(headFit, fit) {
  const h = Number(headFit), f = Number(fit);
  if (!(h > 0 && f > 0)) return 1;
  return Math.min(1, Math.max(TRAIL_SIZE_MIN, h / f));
}
// A displayed point for `at` between the displayed poses that bracket it
// (row, diagonal or spaced subset alike); null when none brackets it.
export function trailPoint(display, at) {
  let lo = null, hi = null;
  for (const d of display) {
    if (d.order <= at && (!lo || d.order > lo.order)) lo = d;
    if (d.order >= at && (!hi || d.order < hi.order)) hi = d;
  }
  if (!lo || !hi) return null;
  if (hi.order === lo.order) return { x: lo.x, z: lo.z };
  const k = (at - lo.order) / (hi.order - lo.order);
  return { x: lo.x + (hi.x - lo.x) * k, z: lo.z + (hi.z - lo.z) * k };
}
// A trail frame takes the now-pose's grade at draw time, so a page that
// re-grades the visible poses after the read head (the construct) grades
// the in-between frames the same way without knowing about them.
function ghostGrade(renderer, scene, camera, geometry, material) {
  const g = this.userData.ghost;
  const head = g && g.root && g.root.userData.trailHead;
  let kt = 1, ks = 1;
  const e = head && head.userData.ease;
  if (e) {
    if (e.tone > 1e-3) kt = head.material.color.r / e.tone;
    const hs = head.material.userData.uSat && head.material.userData.uSat.value;
    if (e.sat > 1e-3 && Number.isFinite(hs)) ks = hs / e.sat;
  }
  material.color.setScalar(g.tone * kt);
  if (material.userData.uSat) material.userData.uSat.value = g.sat * ks;
}
// Every pose of a trail row blends (built with setCutFade): only the now-pose
// is solid and writes depth; the rest fade to `alpha` and never hide one another.
function setTrailLook(mesh, alpha, solid) {
  const u = mesh.material.userData;
  if (u.uAlpha) u.uAlpha.value = alpha;
  mesh.material.depthWrite = !!solid;
}

export function buildChronoVolume(texture, meta, options = {}) {
  const { height = 3.4, step = 0.85, depth = 4.6, staging = true } = options;
  const count = meta.count;
  if (!count) throw new Error("Chronophotograph needs at least one pose.");
  const poseW = height * meta.aspect;
  const stepW = Math.max(0.7 * poseW, step * poseW);
  // Sample the atlas premultiplied, as the Lite viewer does: straight-alpha
  // filtering blends the colour left under the clear texels around the matte
  // (often bright ground) into the edge, a thin pale fringe in the construct.
  // The pose shader then divides the alpha back out and decodes sRGB itself.
  if (texture && texture.isTexture && !texture.premultiplyAlpha && options.premultiply !== false) {
    texture.premultiplyAlpha = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
  }
  // Stroboscopic trail (see STROBE_COUNT). A room-fitted row (the construct)
  // keeps its length and takes as many cards as STROBE_GAP allows; the Lite
  // viewer passes trailRow "free" and the row grows to fit STROBE_COUNT.
  const allTrail = options.trail === false || count < 2 ? null : chronoTrail(meta);
  let trail = null, strobe = null;
  if (allTrail) {
    const widths = (Array.isArray(meta.anchors) ? meta.anchors : [])
      .map((a) => Number(a?.right) - Number(a?.left)).filter((w) => w > 0.05 && w <= 1).sort((a, b) => a - b);
    const bodyW = (widths.length ? widths[Math.floor(widths.length / 2)] : 0.8) * poseW;
    // A subject that barely moves (a talking head) repeats nearly the same
    // silhouette: fewer cards, further apart, so it reads as moments, not a crowd.
    const still = Number(meta.motion) < STROBE_STILL_MOTION;
    const gapW = (still ? STROBE_STILL_GAP : STROBE_GAP) * bodyW;
    const roomGapW = (still ? STROBE_STILL_GAP : STROBE_ROOM_GAP) * bodyW;
    const free = options.trailRow === "free";
    // A stride trail (atlas.json trail.stride: every 5th tracked frame) shows
    // every card, STRIDE_GAP of a pose width apart; a room row keeps the
    // length fitChronoCell gave it (trailStep per card).
    const strided = Number(meta.trail && meta.trail.stride) > 0;
    const cardsAll = count + allTrail.length;
    const budget = strided
      ? (Number(options.trailStep) > 0 ? Number(options.trailStep) : STRIDE_GAP) * poseW * (cardsAll - 1)
      : (Number(options.trailStep) > 0 ? Number(options.trailStep) * poseW : stepW) * (count - 1);
    const most = strided ? cardsAll : Math.min(still ? STROBE_STILL_COUNT : STROBE_COUNT, cardsAll);
    const n = strided ? cardsAll : Math.max(count, Math.min(most, free ? most : Math.round(budget / roomGapW) + 1));
    trail = strobeSelect(allTrail.map((g) => g.at), count, n).map((j) => allTrail[j]);
    const cards = [...Array.from({ length: count }, (_, i) => ({ key: i, at: i })), ...trail.map((g) => ({ g, at: g.at }))]
      .sort((a, b) => a.at - b.at);
    const uOf = new Map(cards.map((c, k) => [c.key !== undefined ? `k${c.key}` : c.g, cards.length > 1 ? k / (cards.length - 1) : 0.5]));
    strobe = { rowLen: free && !strided ? (cards.length - 1) * gapW : budget, gapW, keyU: (i) => uOf.get(`k${i}`), ghostU: (g) => uOf.get(g) };
    if (!trail.length) trail = null;
  }
  const stamps = meta.timestamps && meta.timestamps.length === count
    ? meta.timestamps
    : Array.from({ length: count }, (_, i) => i);
  const first = stamps[0];
  const span = Math.max(stamps[stamps.length - 1] - first, 1e-6);
  const rowLen = count <= 1 ? 0 : strobe ? strobe.rowLen : stepW * (count - 1);
  // atlas.json dir -1: the subject went left in the scene. Every card then
  // shows its cell mirrored, so the subject heads right: time still runs
  // left to right with the now-pose nearest the camera (every caller's yaw
  // assumes that) and the ghost trail lies behind the subject.
  const dir = Number(meta.dir) === -1 ? -1 : 1;
  const planeUv = (geometry) => {
    const a = geometry.getAttribute("uv").clone();
    if (dir === -1) for (let k = 0; k < a.count; k += 1) a.setX(k, 1 - a.getX(k));
    return a;
  };
  const group = new THREE.Group();
  const anchors = Array.isArray(meta.anchors) && meta.anchors.length === count ? meta.anchors : null;
  const groundY = -height / 2;
  const shadows = [];

  const cellUV = (index) => {
    const col = index % meta.cols;
    const row = Math.floor(index / meta.cols);
    const u0 = col / meta.cols;
    const u1 = (col + 1) / meta.cols;
    // atlas rows run top-down, WebGL UVs run bottom-up
    const v0 = 1 - (row + 1) / meta.rows;
    const v1 = 1 - row / meta.rows;
    return dir === -1 ? [u1, v1, u0, v1, u1, v0, u0, v0] : [u0, v1, u1, v1, u0, v0, u1, v0];
  };

  for (let i = 0; i < count; i += 1) {
    const geometry = new THREE.PlaneGeometry(poseW, height);
    geometry.setAttribute("cellUv", planeUv(geometry));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(cellUV(i), 2));
    // Even spacing by pose INDEX, never by timestamp: time-clustered poses
    // (an approach, a pause) must not stack head-on. The axis stays
    // time-ordered and the readout shows true seconds per pose.
    const u = count <= 1 ? 0.5 : strobe ? strobe.keyU(i) : i / (count - 1);
    const t = (stamps[i] - first) / span;
    // Sit every pose's own bbox bottom on the ground (centred cells would
    // otherwise float small poses). No anchors -> legacy centred behaviour.
    const fBottom = anchors ? Math.min(1, Math.max(0, Number(anchors[i]?.bottom) || 1)) : 1;
    const mesh = new THREE.Mesh(geometry, chronoMaterial(texture));
    // The now-pose also plays the live cells, so any cut among them counts.
    const liveCells = i === count - 1 && Number(meta.live?.count) > 0
      ? Array.from({ length: Number(meta.live.count) }, (_, k) => (Number(meta.live.start) || 0) + k) : [];
    if ([i, ...liveCells].some((k) => cellCut(meta, k))) setCutFade(mesh);
    applyCellCut(mesh, meta, i);
    mesh.position.set((u - 0.5) * rowLen, poseMeshY(fBottom, height, groundY), (u - 0.5) * depth);
    mesh.userData.order = i;
    mesh.userData.t = t;
    mesh.userData.baseX = mesh.position.x;
    mesh.userData.baseZ = mesh.position.z;
    mesh.userData.baseUV = new Float32Array(cellUV(i));
    group.add(mesh);

    // Contact shadow: the same cut-out tinted black, squashed flat.
    // Skipped in bare mode (index-spacing A/B check).
    if (staging) {
      let shadow;
      if (options.backdrop) {
        const a = anchors ? anchors[i] : null;
        const fw = a && Number(a.right) > Number(a.left) ? Math.min(1, Math.max(0.3, Number(a.right) - Number(a.left))) : 0.8;
        shadow = new THREE.Mesh(new THREE.PlaneGeometry(poseW * fw * 0.6, poseW * 0.3), blobShadowMaterial());
      } else {
        const shadowGeo = new THREE.PlaneGeometry(poseW * 1.02, height * 0.3);
        shadowGeo.setAttribute("uv", new THREE.Float32BufferAttribute(cellUV(i), 2));
        shadow = new THREE.Mesh(shadowGeo, shadowMaterial(texture));
      }
      shadow.rotation.x = -Math.PI / 2;
      shadow.userData.baseOpacity = shadow.material.opacity;
      shadow.position.set(mesh.position.x, groundY + 0.02, mesh.position.z);
      shadow.renderOrder = -1;
      shadows.push(shadow);
      group.add(shadow);
    }
  }

  // Ghost trail: one card per chosen trail frame, in its strobe slot; the
  // poses blend too (setChronoCut sets every opacity).
  const ghosts = [];
  if (trail) {
    for (const mesh of group.children) {
      if (mesh.userData.order === undefined) continue;
      setCutFade(mesh);
    }
    for (const g of trail) {
      const geometry = new THREE.PlaneGeometry(poseW, height);
      geometry.setAttribute("cellUv", planeUv(geometry));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(cellUV(g.cell), 2));
      const mesh = new THREE.Mesh(geometry, chronoMaterial(texture));
      setCutFade(mesh);
      applyCellCut(mesh, meta, g.cell);
      const u = strobe.ghostU(g);
      mesh.position.set((u - 0.5) * rowLen, poseMeshY(g.bottom, height, groundY), (u - 0.5) * depth);
      mesh.userData.ghost = { at: g.at, cell: g.cell, bottom: g.bottom, fit: g.fit, root: group, tone: 1, sat: 1, a: 0, shown: false, placed: true };
      mesh.userData.baseX = mesh.position.x;
      mesh.userData.baseZ = mesh.position.z;
      mesh.onBeforeRender = ghostGrade;
      mesh.visible = false;
      ghosts.push(mesh);
      group.add(mesh);
    }
  }

  // The floor: a faint radial pool of light under the row, plus the faint
  // time-coloured path ribbon joining the poses' foot points. Both skipped
  // in bare mode (index-spacing A/B check).
  let ribbon = null;
  if (staging) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(rowLen + poseW * 4, depth + poseW * 4),
      groundMaterial(Boolean(options.backdrop))
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = groundY;
    ground.renderOrder = -2;
    ground.userData.isGround = true;
    group.add(ground);

    const ordered = group.children
      .filter((m) => m.userData.order !== undefined)
      .sort((a, b) => a.userData.order - b.userData.order);
    const strip = ribbonStrip(
      ordered.map((m) => ({ x: m.position.x, z: m.position.z, t: m.userData.t })),
      Math.max(0.08, poseW * 0.12)
    );
    if (strip.index.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(strip.positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(strip.colors, 3));
      geo.setIndex(strip.index);
      ribbon = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.4,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
      }));
      ribbon.position.y = groundY + 0.015;
      ribbon.renderOrder = -1;
      ribbon.userData.isRibbon = true;
      // On a photo stage the thin path line reads as a stray wire laid
      // across the place under the feet (the tesseract hides it too); the
      // poses and their contact shadows already carry the path there.
      if (options.backdrop) ribbon.visible = false;
      group.add(ribbon);
    }
  }

  // Ambient stage backdrop (optional atlas field): the clip's own place on
  // a world-fixed plate BEHIND the row (depth/y fixed, parallax kept). It
  // is scaled at runtime (fitBackdropToFrame) to fill the frame at ~1.2x
  // instead of looming 4x large, and axis-aligned under the resting camera
  // so no giant out-of-focus subject ghosts in from the sides. Melted into
  // the floor pool at the horizon and into the void on the other three
  // sides. Old atlases have no backdrop and keep the void.
  let backdrop = null;
  if (staging && options.backdrop) {
    const bh = height * 10;
    const image = options.backdrop.image;
    // Preserve the loaded photo's aspect before perspective projection.
    const imageWidth = image && Number.isFinite(image.width) && Number.isFinite(image.height) && image.width > 0 && image.height > 0
      ? bh * (image.width / image.height) : NaN;
    const bw = Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : rowLen * 2.5 + poseW * 12;
    backdrop = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), chronoBackdropMaterial(options.backdrop));
    backdrop.position.set(0, groundY + bh * 0.3, -(depth / 2 + poseW * 2.2));
    backdrop.renderOrder = -3;
    backdrop.frustumCulled = false;
    backdrop.userData.baseW = bw;
    backdrop.userData.baseH = bh;
    group.add(backdrop);
  }

  group.children.sort((a, b) => a.position.z - b.position.z);
  group.children.forEach((mesh, i) => {
    if (mesh.userData.order !== undefined) mesh.renderOrder = mesh.userData.order;
    else if (mesh.userData.ghost) mesh.renderOrder = mesh.userData.ghost.at;
  });
  const live = meta.live && Number(meta.live.count) > 0
    ? { start: Number(meta.live.start) || 0, count: Number(meta.live.count) || 0 }
    : null;
  group.userData = {
    chrono: true, map: texture, meta, depth, poseW, poseH: height, square: options.square === true,
    rowW: rowLen + poseW, rowLen, rowD: depth, count, groundY, shadows, ribbon, backdrop, live,
    liveMesh: null, cellUV, activeOrders: null, layoutMode: "row",
    trail: trail ? {
      ghosts, hiddenPoses: [], gapW: strobe.gapW,
      poseFit: Array.isArray(meta.trail.poseFit) && meta.trail.poseFit.length === count && meta.trail.poseFit.every((v) => Number(v) > 0)
        ? meta.trail.poseFit.map(Number) : null,
    } : null, trailHead: null, dir,
  };
  setChronoCut(group, 1);
  return group;
}

// Narrow-stage layout switch. Row mode shows every pose along x (time);
// portrait mode shows a motion-spaced subset on a receding diagonal
// (oldest far/up-right, now near/bottom-left). Rebuilds the ribbon and the
// ground pool over the displayed feet; the cut head, live tail and readout
// follow userData.activeOrders. Idempotent per mode (call on aspect-class
// change, not per frame).
const _bdV = { v: null, d: null };
// Frame-filling plate: scale the world-fixed backdrop so it fills the frame
// at ~margin (default 1.35x) behind the subject plane, centred on the
// resting view axis at its depth, with the melted bottom edge tucked below
// the frame. Uniform scale keeps the texture undistorted; the vertical
// margin stays generous. Called on resize (the camera never moves on drag
// — only the group turns).
export function fitBackdropToFrame(backdrop, camera, margin = 1.2) {
  if (!backdrop || !camera) return;
  const baseW = backdrop.userData.baseW, baseH = backdrop.userData.baseH;
  if (!(baseW > 0) || !(baseH > 0)) return;
  if (!_bdV.v) { _bdV.v = new THREE.Vector3(); _bdV.d = new THREE.Vector3(); }
  backdrop.getWorldPosition(_bdV.v);
  camera.getWorldDirection(_bdV.d);
  if (_bdV.d.z >= -1e-6) return; // degenerate view, leave the giant plane
  // Axis point at the plate's depth (unit direction, so t IS the distance).
  const t = (_bdV.v.z - camera.position.z) / _bdV.d.z;
  const axisX = camera.position.x + _bdV.d.x * t;
  const axisY = camera.position.y + _bdV.d.y * t;
  const halfH = t * Math.tan(((camera.fov || 38) * Math.PI) / 360);
  const needW = 2 * halfH * (camera.aspect || 1.78) * margin;
  const needH = 2 * halfH * 1.35;
  // Uniform scale driven by the tighter dimension (width on wide, height
  // on portrait) so the texture maps at ~1.2-1.35x with no squeeze.
  const s = Math.max(needW / baseW, needH / baseH);
  backdrop.scale.set(s, s, 1);
  backdrop.position.x = axisX;
  backdrop.position.y = (axisY - halfH * 1.35) + (baseH * s) / 2;
}

export function setChronoLayout(group, layout) {
  const u = group.userData;
  if (!u || !u.chrono) return;
  // "portrait" (phone diagonal) and "subset" (a spaced-out few, e.g. a
  // herd's row) both place a chosen subset at given points.
  const mode = layout && (layout.mode === "portrait" || layout.mode === "subset") && Array.isArray(layout.indices) ? layout.mode : "row";
  // Idempotent per layout: the same mode with the same points is a no-op.
  const key = mode === "row" ? "row" : `${mode}:${JSON.stringify((layout.points || []).map((p) => [p.order, +Number(p.x).toFixed(4), +Number(p.z).toFixed(4)]))}`;
  if (u.layoutKey === key) return;
  u.layoutKey = key;
  const poses = group.children.filter((m) => m.userData.order !== undefined);
  const byOrder = new Map(poses.map((m) => [m.userData.order, m]));
  const anchors = Array.isArray(u.meta.anchors) && u.meta.anchors.length === u.count ? u.meta.anchors : null;
  const fBottom = (order) => (anchors ? Math.min(1, Math.max(0, Number(anchors[order]?.bottom) || 1)) : 1);
  let display;
  if (mode !== "row") {
    const pts = new Map((layout.points || []).map((p) => [p.order, p]));
    display = layout.indices.map((order) => ({ order, x: pts.get(order)?.x ?? 0, z: pts.get(order)?.z ?? 0 }));
    u.activeOrders = [...layout.indices];
  } else {
    display = poses.map((m) => ({ order: m.userData.order, x: m.userData.baseX ?? 0, z: m.userData.baseZ ?? 0 }));
    u.activeOrders = null;
  }
  for (const { order, x, z } of display) {
    const mesh = byOrder.get(order);
    if (!mesh) continue;
    mesh.position.set(x, poseMeshY(fBottom(order), u.poseH, u.groundY), z);
  }
  // Ghost trail: every trail frame (and, in a subset, every pose left out of
  // it) sits on the line between the displayed poses that bracket its time,
  // so the exposure stays continuous along a diagonal or a spaced row too.
  if (u.trail) {
    const shownOrders = new Set(display.map((d) => d.order));
    for (const g of u.trail.ghosts) {
      // The full row keeps each frame in its strobe slot; a subset places
      // it on the line between the displayed poses that bracket its time.
      const p = mode === "row" ? { x: g.userData.baseX, z: g.userData.baseZ } : trailPoint(display, g.userData.ghost.at);
      g.userData.ghost.placed = !!p;
      if (p) g.position.set(p.x, poseMeshY(g.userData.ghost.bottom, u.poseH, u.groundY), p.z);
    }
    u.trail.hiddenPoses = [];
    for (const [order, mesh] of byOrder) {
      if (shownOrders.has(order)) continue;
      const p = trailPoint(display, order);
      if (!p) continue;
      mesh.position.set(p.x, poseMeshY(fBottom(order), u.poseH, u.groundY), p.z);
      u.trail.hiddenPoses.push(mesh);
    }
    // A subset packs the same frames into less room (the phone's diagonal):
    // keep the strobe spacing by leaving out any frame closer than one gap
    // to the card before it or to the next displayed pose.
    if (mode !== "row" && u.trail.gapW > 0) {
      const gap = u.trail.gapW;
      const keys = display.map((d) => ({ at: d.order, x: d.x, z: d.z })).sort((a, b) => a.at - b.at);
      const extra = [
        ...u.trail.ghosts.filter((g) => g.userData.ghost.placed).map((m) => ({ at: m.userData.ghost.at, m, ghost: true })),
        ...u.trail.hiddenPoses.map((m) => ({ at: m.userData.order, m, ghost: false })),
      ].sort((a, b) => a.at - b.at);
      const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < gap;
      let last = null, ki = 0;
      const dropped = new Set();
      for (const c of extra) {
        while (ki < keys.length && keys[ki].at < c.at) last = keys[ki++];
        const pos = { x: c.m.position.x, z: c.m.position.z };
        const next = keys[ki];
        if ((last && near(pos, last)) || (next && near(pos, next))) {
          dropped.add(c.m);
          if (c.ghost) c.m.userData.ghost.placed = false;
        } else last = pos;
      }
      u.trail.hiddenPoses = u.trail.hiddenPoses.filter((m) => !dropped.has(m));
      for (const m of dropped) if (!m.userData.ghost) m.visible = false;
    }
  }
  if (u.shadows) {
    for (const [order, mesh] of byOrder) {
      const sh = u.shadows[order];
      if (sh) sh.position.set(mesh.position.x, u.groundY + 0.02, mesh.position.z);
    }
  }
  const ribbonMesh = group.children.find((m) => m.userData.isRibbon);
  if (ribbonMesh) {
    const strip = ribbonStrip(
      display.map(({ order, x, z }) => ({ x, z, t: byOrder.get(order)?.userData.t ?? 0 })),
      Math.max(0.08, u.poseW * 0.12)
    );
    if (strip.index.length) {
      ribbonMesh.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(strip.positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(strip.colors, 3));
      geo.setIndex(strip.index);
      ribbonMesh.geometry = geo;
      u.ribbon = ribbonMesh;
    }
  }
  const groundMesh = group.children.find((m) => m.userData.isGround);
  if (groundMesh && display.length) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const { x, z } of display) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    groundMesh.geometry.dispose();
    groundMesh.geometry = new THREE.PlaneGeometry(
      Math.max(maxX - minX + u.poseW * 3, u.poseW * 2),
      Math.max(maxZ - minZ + u.poseW * 3, u.poseW * 2)
    );
    groundMesh.position.x = (minX + maxX) / 2;
    groundMesh.position.z = (minZ + maxZ) / 2;
  }
  u.layoutMode = mode;
}

// The read head for the chronophotograph. Poses at or before the cut are
// visible; everything visible is OPAQUE (opacity stays 1). The now-pose is
// full colour, rim-lit and slightly larger; older poses darken (never below
// ~78% brightness) and desaturate toward ~65% but stay solid — translucency
// is what read as ghosts, so there is none.
export function setChronoCut(group, ratio) {
  const { shadows, ribbon, activeOrders } = group.userData;
  const poses = group.children.filter((m) => m.userData.order !== undefined);
  // Narrow stages show a motion-spaced subset (activeOrders); the cut counts
  // displayed poses only, hidden ones stay hidden. Row mode: every pose.
  const shown = activeOrders && activeOrders.length
    ? activeOrders.map((o) => poses.find((m) => m.userData.order === o)).filter(Boolean)
    : [...poses].sort((a, b) => a.userData.order - b.userData.order);
  const cut = Math.max(1, Math.round(shown.length * ratio));
  // The path ribbon draws only up to the read head (no future leaking).
  if (ribbon) ribbon.geometry.setDrawRange(0, Math.max(0, cut - 1) * 6);
  const shownSet = new Set(shown.slice(0, cut).map((m) => m.userData.order));
  for (const mesh of poses) {
    const i = mesh.userData.order;
    mesh.visible = shownSet.has(i);
    if (shadows[i]) shadows[i].visible = mesh.visible;
    if (!mesh.visible) { if (mesh.userData.ease) mesh.userData.ease.shown = false; continue; }
    const di = shown.findIndex((m) => m.userData.order === i);
    const now = di === cut - 1;
    const age = cut <= 1 ? 0 : (cut - 1 - di) / (cut - 1);
    // Readable but clearly past: brightness never below the floor (~78%,
    // ~88% for dark-flagged subjects — a chroma-safe flat lift so black fur
    // reads against the dark stage), saturation never below ~65% (~75% when
    // dark), always opaque. (The floor matters at phone sizes: at 3x
    // minification a 0.65 floor on dark fur falls to background.)
    const dark = !!group.userData.meta?.dark;
    const toneFloor = dark ? 0.88 : 0.78;
    const satFloor = dark ? 0.75 : 0.65;
    const tone = now ? 1 : Math.max(toneFloor, 1 - 0.22 * age);
    const sat = now ? 1 : Math.max(satFloor, 1 - 0.35 * age);
    const rim = now ? 0.28 : 0;
    const scale = now ? 1.06 : 1;
    mesh.material.opacity = 1;
    // Eased views (group.userData.easeK, set per tick by tickChrono when the
    // viewer opts in): when the read head moves, the old head settles and the
    // older poses re-tone over ~0.15 s instead of all jumping on one frame,
    // and a pose just reached fades in. Otherwise every value is set at once.
    const e = group.userData.easeK;
    const st = mesh.userData.ease;
    if (Number.isFinite(e) && st && st.shown) {
      st.tone += (tone - st.tone) * e; st.sat += (sat - st.sat) * e; st.rim += (rim - st.rim) * e; st.scale += (scale - st.scale) * e;
      st.appear += (1 - st.appear) * e;
    } else {
      mesh.userData.ease = { shown: true, tone, sat, rim, scale, appear: Number.isFinite(e) && group.userData.easeWarm ? 0 : 1 };
    }
    const v = mesh.userData.ease;
    mesh.material.color.setScalar(v.tone);
    if (mesh.material.userData.uSat) mesh.material.userData.uSat.value = v.sat;
    if (mesh.material.userData.uRim) mesh.material.userData.uRim.value = v.rim;
    if (mesh.material.userData.uAppear) mesh.material.userData.uAppear.value = v.appear > 0.995 ? 1 : v.appear;
    // Dark subjects get a rim of matching hue (baked exposure tint), not
    // white; bright subjects keep the default warm rim (unchanged look).
    if (mesh.material.userData.uRimColor) {
      const ex = group.userData.meta && group.userData.meta.exposure && group.userData.meta.exposure[i];
      if (ex && ex.gamma > 1.01 && Array.isArray(ex.rim)) mesh.material.userData.uRimColor.value.setRGB(ex.rim[0], ex.rim[1], ex.rim[2]);
      else mesh.material.userData.uRimColor.value.setRGB(1.0, 0.95, 0.84);
    }
    mesh.scale.setScalar(v.scale);
  }
  if (group.userData.trail) setTrailCut(group, shown, cut);
}

// Ghost-trail read head: the now-pose solid, every earlier pose and trail
// frame up to it blended by its age (trailAlpha) and toned like a pose of
// that age; frames after the head stay hidden. Eased with the poses when
// the viewer opts in.
function setTrailCut(group, shown, cut) {
  const u = group.userData;
  const head = shown[cut - 1];
  if (!head) return;
  const headAt = head.userData.order;
  const firstAt = shown[0].userData.order;
  const span = Math.max(1e-6, headAt - firstAt);
  const dark = !!u.meta?.dark;
  const toneFloor = dark ? 0.88 : 0.78;
  const satFloor = dark ? 0.75 : 0.65;
  // A dark subject on a bare stage (no plate backdrop: the construct) lifts
  // every card but the now-pose (TRAIL_GAIN, TRAIL_LIFT), so the trail
  // separates from the dark room; the now-pose keeps its own colour.
  const bare = dark && !u.backdrop;
  const setLift = (mesh, on) => {
    const m = mesh.material.userData;
    if (m.uGain) m.uGain.value = on && bare ? TRAIL_GAIN : 1;
    if (m.uKnee) m.uKnee.value = TRAIL_KNEE;
    if (m.uLift) m.uLift.value = on && bare ? TRAIL_LIFT : 0;
  };
  const e = u.easeK;
  u.trailHead = head;
  for (const mesh of shown.slice(0, cut)) {
    const solid = mesh === head;
    const alpha = solid ? 1 : trailAlpha((headAt - mesh.userData.order) / span, dark);
    setTrailLook(mesh, alpha, solid);
    setLift(mesh, !solid);
    const sh = u.shadows && u.shadows[mesh.userData.order];
    if (sh && Number.isFinite(sh.userData.baseOpacity)) sh.material.opacity = sh.userData.baseOpacity * alpha;
  }
  const samples = [
    ...u.trail.ghosts.map((m) => ({ mesh: m, at: m.userData.ghost.at, ghost: m.userData.ghost })),
    ...(u.trail.hiddenPoses || []).map((m) => ({ mesh: m, at: m.userData.order, ghost: null })),
  ];
  for (const { mesh, at, ghost } of samples) {
    const placed = ghost ? ghost.placed : true;
    const on = placed && at < headAt && at >= firstAt;
    if (!on) {
      mesh.visible = false;
      if (ghost) ghost.shown = false;
      else if (mesh.userData.ease) mesh.userData.ease.shown = false;
      continue;
    }
    const age = (headAt - at) / span;
    const alpha = trailAlpha(age, dark);
    const tone = Math.max(toneFloor, 1 - 0.22 * age);
    const sat = Math.max(satFloor, 1 - 0.35 * age);
    mesh.visible = true;
    setLift(mesh, true);
    if (ghost) {
      if (Number.isFinite(e) && ghost.shown) {
        ghost.a += (alpha - ghost.a) * e; ghost.tone += (tone - ghost.tone) * e; ghost.sat += (sat - ghost.sat) * e;
      } else {
        ghost.a = Number.isFinite(e) && u.easeWarm ? 0 : alpha; ghost.tone = tone; ghost.sat = sat; ghost.shown = true;
      }
      setTrailLook(mesh, ghost.a, false);
      mesh.material.color.setScalar(ghost.tone);
      if (mesh.material.userData.uSat) mesh.material.userData.uSat.value = ghost.sat;
    } else {
      // A pose a subset leaves out still exposes its moment, as a trail frame.
      mesh.userData.ease = { shown: true, tone, sat, rim: 0, scale: 1, appear: 1 };
      setTrailLook(mesh, alpha, false);
      mesh.material.color.setScalar(tone);
      if (mesh.material.userData.uSat) mesh.material.userData.uSat.value = sat;
      mesh.scale.setScalar(1);
    }
  }
  // True size beside the now-pose (trailSize), feet kept on the ground.
  const fits = u.trail.poseFit;
  const anchorsT = Array.isArray(u.meta?.anchors) && u.meta.anchors.length === u.count ? u.meta.anchors : null;
  const keyBottom = (m) => (anchorsT ? Math.min(1, Math.max(0, Number(anchorsT[m.userData.order]?.bottom) || 1)) : 1);
  const headFit = fits ? fits[head.userData.order] : null;
  const sizeCard = (mesh, fit, fb, base) => {
    const k = trailSize(headFit, fit);
    mesh.scale.setScalar(base * k);
    mesh.position.y = poseMeshY(fb, u.poseH * k, u.groundY);
  };
  head.position.y = poseMeshY(keyBottom(head), u.poseH, u.groundY);
  for (const m of shown.slice(0, cut - 1)) sizeCard(m, fits ? fits[m.userData.order] : null, keyBottom(m), m.scale.x);
  for (const s of samples) {
    if (!s.mesh.visible) continue;
    if (s.ghost) sizeCard(s.mesh, s.ghost.fit, s.ghost.bottom, 1);
    else sizeCard(s.mesh, fits ? fits[s.mesh.userData.order] : null, keyBottom(s.mesh), s.mesh.scale.x);
  }
}

// Rewrite one pose mesh's UVs to another atlas cell (the live strip).
export function setMeshCell(group, mesh, index) {
  const uv = group.userData.cellUV(index);
  const attr = mesh.geometry.getAttribute("uv");
  for (let k = 0; k < 8; k += 1) attr.array[k] = uv[k];
  attr.needsUpdate = true;
  applyCellCut(mesh, group.userData.meta, index);
}

// Per-frame tick: reveal plus the now-pose playing the live tail. The live
// frames cycle on the head pose only while the full row stands (the head
// IS the clip end); otherwise the head rests on its own cell.
export function tickChrono(group, ratio, timeSec) {
  const u0 = group.userData;
  if (u0.ease) {
    // Eased transitions (opt-in): rate from the time since the last tick.
    const t = Number(timeSec) || 0;
    const dt = Number.isFinite(u0.easeT) ? Math.min(0.1, Math.max(0, t - u0.easeT)) : 0;
    u0.easeT = t;
    u0.easeK = 1 - Math.exp(-dt / 0.07);
    setChronoCut(group, ratio);
    u0.easeWarm = true;
  } else setChronoCut(group, ratio);
  const { live, count, liveMesh, activeOrders } = group.userData;
  const poses = group.children.filter((m) => m.userData.order !== undefined);
  const shown = activeOrders && activeOrders.length
    ? activeOrders.map((o) => poses.find((m) => m.userData.order === o)).filter(Boolean)
    : [...poses].sort((a, b) => a.userData.order - b.userData.order);
  const cut = Math.max(1, Math.round(shown.length * ratio));
  const head = shown[cut - 1] || null;
  const liveHead = live && live.count > 0 && head && head.userData.order === count - 1 ? head : null;
  if (liveMesh && liveMesh !== liveHead) {
    const attr = liveMesh.geometry.getAttribute("uv");
    attr.array.set(liveMesh.userData.baseUV);
    attr.needsUpdate = true;
    applyCellCut(liveMesh, group.userData.meta, liveMesh.userData.order);
    group.userData.liveMesh = null;
  }
  if (liveHead) {
    // "pingpong" (set by the Lite viewer) plays the tail forward then back,
    // so the loop never jumps from its last frame to its first.
    const step = Math.floor(Number(timeSec) * 8);
    const period = group.userData.liveMode === "pingpong" && live.count > 2 ? 2 * (live.count - 1) : live.count;
    const k = step % period;
    const idx = live.start + (k < live.count ? k : period - k);
    setMeshCell(group, liveHead, idx);
    group.userData.liveMesh = liveHead;
  }
}

// The finished Stable bear as a specimen: one depth shell per observed frame,
// in its natural footage colours, instead of a flat cut-out. Each pose keeps
// the exact source projection (what the old slice showed head-on) and adds its
// own relief toward or away from the lens; time stays the stack's z axis, so
// the lattice's read head works unchanged. Relief is regularised along the
// original camera rays (stable-math.mjs). It is a presentation prior, not
// measured or completed anatomy, so callers must bound the viewing angle.
export async function buildShellVolume(base, { fit, relief = 0.6, river = true } = {}) {
  const get = async (name) => {
    const response = await fetch(base + name, { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load ${base + name} (HTTP ${response.status}).`);
    return response;
  };
  const meta = await (await get("stable.json")).json();
  validateMeta(meta);
  const [pos, uv, idx] = await Promise.all([
    get("pos.f32").then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
    get("uv.f32").then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
    get("idx.u32").then((r) => r.arrayBuffer()).then((b) => new Uint32Array(b)),
  ]);
  const poses = [];
  meta.sub.forEach((rec, frame) => { if (rec) poses.push({ rec, frame }); });
  const aspect = meta.width / meta.height;
  const { depth = 4.6, height = 3.4 } = fit ? fit(aspect) : {};
  const width = height * aspect;
  // pixels-per-tan scale: the source frame's vertical half-extent fills half the height
  const k = height / 2 / Math.tan(THREE.MathUtils.degToRad(meta.fovY / 2));
  const first = meta.times[poses[0].frame];
  const span = Math.max(meta.times[poses.at(-1).frame] - first, 1e-6);
  const loader = new THREE.TextureLoader();
  const group = new THREE.Group();
  const depths = [];

  await Promise.all(poses.map(async ({ rec, frame }, index) => {
    const camera = meta.cameras[frame];
    const local = idx.slice(rec.idxOffset, rec.idxOffset + rec.idxCount);
    const p = pos.slice(rec.vertOffset * 3, (rec.vertOffset + rec.vertCount) * 3);
    regularisePositions(p, local, camera, rec.centroid);
    const e = new THREE.Matrix4().fromArray(camera).invert().elements;
    const [cx, cy, cz] = rec.centroid;
    const centreDepth = -(e[2] * cx + e[6] * cy + e[10] * cz + e[14]);
    if (!(centreDepth > 1e-6)) throw new Error("A bear pose lies behind its own lens.");
    depths.push(centreDepth);
    for (let v = 0; v < p.length; v += 3) {
      const x = p[v], y = p[v + 1], z = p[v + 2];
      const d = Math.max(1e-6, -(e[2] * x + e[6] * y + e[10] * z + e[14]));
      // perspective-normalised: head-on this is the recorded frame, point for point
      p[v] = (e[0] * x + e[4] * y + e[8] * z + e[12]) / d * k;
      p[v + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) / d * k;
      p[v + 2] = (centreDepth - d) / centreDepth * k * relief;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv.slice(rec.vertOffset * 2, (rec.vertOffset + rec.vertCount) * 2), 2));
    geometry.setIndex(new THREE.BufferAttribute(Uint16Array.from(local), 1));
    const texture = await loader.loadAsync(base + rec.tex);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const mesh = new THREE.Mesh(geometry, sliceMaterial(texture));
    mesh.position.z = ((meta.times[frame] - first) / span - 0.5) * depth;
    mesh.userData.order = index;
    mesh.userData.time = meta.times[frame];
    group.add(mesh);
  }));

  group.children.sort((a, b) => a.position.z - b.position.z);
  group.children.forEach((mesh, i) => { mesh.renderOrder = i; });
  group.userData = {
    depth, width, height, count: group.children.length, generated: true, shells: true,
    poseTimes: group.children.map((mesh) => mesh.userData.time), t0: meta.times[0],
  };
  setCut(group, 1);

  // The bear's own river: the original captured surface only, in its recorded
  // frame, as the room's back window. Nothing beyond that frame is shown (the
  // generated surroundings are not part of this view). A fixed-camera bake only.
  const env = meta.env[0], live = env.live;
  if (river && meta.fixed && live) {
    const e = new THREE.Matrix4().fromArray(meta.cameras[env.frame]).invert().elements;
    const p = pos.slice(env.vertOffset * 3, (env.vertOffset + env.vertCount) * 3);
    const reference = depths.sort((a, b) => a - b)[depths.length >> 1];
    const backZ = -depth / 2 - 0.5;
    for (let v = 0; v < p.length; v += 3) {
      const x = p[v], y = p[v + 1], z = p[v + 2];
      const d = Math.max(1e-6, -(e[2] * x + e[6] * y + e[10] * z + e[14]));
      p[v] = (e[0] * x + e[4] * y + e[8] * z + e[12]) / d * k;
      p[v + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) / d * k;
      // banks nearer the lens than the bear may not hide it: relief only a little forward of the back window
      p[v + 2] = backZ + THREE.MathUtils.clamp((reference - d) / reference, -1, 0.15) * k * relief * 0.5;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv.slice(env.vertOffset * 2, (env.vertOffset + env.vertCount) * 2), 2));
    geometry.setIndex(new THREE.BufferAttribute(Uint16Array.from(idx.slice(env.idxOffset, env.idxOffset + env.idxCount)), 1));
    const plate = await loader.loadAsync(base + live.plate);
    plate.colorSpace = THREE.SRGBColorSpace;
    plate.minFilter = THREE.LinearFilter;
    plate.generateMipmaps = false;
    const backdrop = new THREE.Mesh(geometry, backdropMaterial(plate));
    backdrop.frustumCulled = false;
    backdrop.renderOrder = -0.5; // after the room's dark window, before every pose
    group.userData.backdrop = backdrop;
    // the moving river loads after the still plate (about 15 MB); it follows the read head
    fetch(base + live.video).then((r) => r.blob()).then((blob) => {
      const video = document.createElement("video");
      video.muted = video.playsInline = true;
      video.preload = "auto";
      video.src = URL.createObjectURL(blob);
      video.addEventListener("loadeddata", () => {
        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        backdrop.material.map = texture;
        group.userData.river = video;
      }, { once: true });
    }).catch(() => {}); // the still plate stays
  }
  return group;
}

// River frame follows the read head: the video shows the moment of the present pose.
export function syncShellBackdrop(group, cut) {
  const video = group.userData.river;
  if (!video || video.readyState < 2) return;
  const { poseTimes, t0 } = group.userData;
  const want = poseTimes[Math.max(0, Math.min(poseTimes.length - 1, Math.round(poseTimes.length * cut) - 1))] - t0;
  if (!video.paused) video.pause();
  if (!video.seeking && Math.abs(video.currentTime - want) > 0.03) video.currentTime = want;
}

// The bear is the light in the room; its river is dimmed and capped under the
// bloom threshold, and faded out toward the recorded frame's edge so the view
// ends there instead of showing a hard rectangle.
function backdropMaterial(map) {
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, fog: false });
  material.color.setScalar(0.75);
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <map_fragment>", `#include <map_fragment>
        diffuseColor.a *= smoothstep(0.0, 0.06, min(min(vMapUv.x, 1.0 - vMapUv.x), min(vMapUv.y, 1.0 - vMapUv.y)));`)
      .replace("#include <opaque_fragment>", `float peak = max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b));
        outgoingLight *= min(1.0, ${CEILING.toFixed(2)} / max(peak, 1e-4));
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => "river-backdrop";
  return material;
}

// The same stack, built from the per-frame PNGs a live generation returns.
// Spacing follows timestamps, not frame index, so a gap where tracking lost the
// object leaves a real gap instead of silently compressing time.
export async function buildFrameVolume(manifest, baseUrl, options = {}) {
  const { depth = 4.6, height = 3.4 } = options;
  const frames = manifest.frames.filter((frame) => frame.present);
  if (!frames.length) throw new Error("That object was not visible anywhere in the clip.");

  const first = frames[0].timestamp;
  const span = Math.max(frames[frames.length - 1].timestamp - first, 1e-6);
  const aspect = manifest.sliceWidth / manifest.sliceHeight;
  const width = height * aspect;
  const loader = new THREE.TextureLoader();
  const group = new THREE.Group();

  await Promise.all(
    frames.map(
      (frame, index) =>
        new Promise((resolve) => {
          loader.load(
            `${baseUrl}${frame.url}`,
            (texture) => {
              texture.colorSpace = THREE.SRGBColorSpace;
              texture.minFilter = THREE.LinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.generateMipmaps = false;
              const t = (frame.timestamp - first) / span;
              const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), sliceMaterial(texture));
              mesh.position.z = (t - 0.5) * depth;
              mesh.userData.order = index;
              group.add(mesh);
              resolve();
            },
            undefined,
            () => resolve()
          );
        })
    )
  );

  group.children.sort((a, b) => a.position.z - b.position.z);
  group.children.forEach((mesh, i) => { mesh.renderOrder = i; });
  group.userData = { depth, width, height, count: group.children.length, generated: true };
  setCut(group, 1);
  return group;
}

// The read head. Slices past the cut are hidden. Earlier this used one
// continuous opacity computed relative to the cut (`1 - (cut-1-i)/(cut-1)`),
// so as the cut advanced every visible slice's brightness reshuffled on
// every step: the same "counted back from now" artefact that made Stable's
// millipede look like it was sliding (stable.js). Fixed the same way: which
// slices stay solid, readable poses depends only on the slice's own index
// (KEY), never on where the cut currently sits, so a pose holds still once
// revealed. The rest blend into a faint motion-blur smear behind the cut.
const KEY = 6;

export function setCut(group, ratio) {
  const children = group.children;
  const cut = Math.max(1, Math.round(children.length * ratio));
  for (let i = 0; i < children.length; i += 1) {
    const mesh = children[i];
    mesh.visible = i < cut;
    if (!mesh.visible) continue;
    const present = i === cut - 1;
    const age = cut <= 1 ? 0 : (cut - 1 - i) / (cut - 1);
    const key = i % KEY === 0;
    const opacity = present ? 1 : (key ? 0.7 : 0.14) * (1 - 0.45 * age);
    mesh.material.opacity = opacity;
    mesh.material.color.setScalar(GAIN * (present ? 1 : key ? 0.75 : 0.45));
  }
}

// ── Strings ───────────────────────────────────────────────────────────────────
// The film's room is its objects pulled out into strings. A few opaque pixels
// of every slice are drawn out sideways along the lattice's own axes, in their
// own colour, so the specimen visibly feeds the fibres around it. Only the
// slices at the read head carry strings, so they move as you scrub.

const PER_SLICE = 30;
const STRING_WINDOW = 8; // slices behind the cut that still carry strings

export function buildStrings(group) {
  if (group.userData.shells) return buildShellStrings(group);
  const { map, meta, depth } = group.userData;
  // Chrono rows store poseW/poseH/rowLen instead of the stack width/height;
  // without this mapping every string vertex is NaN (and the room loses its
  // fibres plus logs a bounding-sphere error).
  const width = group.userData.width ?? group.userData.poseW;
  const height = group.userData.height ?? group.userData.poseH;
  if (!map?.image || !meta || !(width > 0) || !(height > 0)) return null;
  const image = map.image;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  ctx.canvas.width = image.width;
  ctx.canvas.height = image.height;
  ctx.drawImage(image, 0, 0);
  const cellW = Math.floor(image.width / meta.cols);
  const cellH = Math.floor(image.height / meta.rows);

  const pos = [], col = [], end = [], dir = [], slice = [], seed = [];
  for (let i = 0; i < meta.count; i += 1) {
    const x0 = (i % meta.cols) * cellW;
    const y0 = Math.floor(i / meta.cols) * cellH;
    const px = ctx.getImageData(x0, y0, cellW, cellH).data;
    for (let n = 0, tries = 0; n < PER_SLICE && tries < 400; tries += 1) {
      const u = Math.random(), v = Math.random();
      const o = (Math.floor(v * cellH) * cellW + Math.floor(u * cellW)) * 4;
      if (px[o + 3] < 200) continue;
      n += 1;
      // Stack slices all sit at the origin (local offsets only); chrono
      // poses additionally carry their row position so fibres leave each
      // pose where it stands.
      const uu = meta.count <= 1 ? 1 : i / (meta.count - 1);
      const ox = group.userData.chrono ? (uu - 0.5) * (group.userData.rowLen || 0) : 0;
      const p = [ox + (u - 0.5) * width, (0.5 - v) * height, (uu - 0.5) * depth];
      // run toward the nearer side of the frame: out the sides, or up/down
      const d = Math.abs(u - 0.5) > Math.abs(v - 0.5) * 0.8 ? (u < 0.5 ? 0 : 1) : (v < 0.5 ? 2 : 3);
      const s = Math.random();
      for (const e of [0, 1]) {
        pos.push(...p);
        col.push(px[o] / 255, px[o + 1] / 255, px[o + 2] / 255);
        end.push(e); dir.push(d); slice.push(i); seed.push(s);
      }
    }
  }

  return stringLines(pos, col, end, dir, slice, seed);
}

// Same strings for a shell specimen: drawn from random opaque texels of each pose.
function buildShellStrings(group) {
  const { width, height } = group.userData;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const pos = [], col = [], end = [], dir = [], slice = [], seed = [];
  group.children.forEach((mesh, i) => {
    const image = mesh.material.map?.image;
    if (!image) return;
    ctx.canvas.width = image.width;
    ctx.canvas.height = image.height;
    ctx.clearRect(0, 0, image.width, image.height);
    ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, image.width, image.height).data;
    const vertices = mesh.geometry.attributes.position, uvs = mesh.geometry.attributes.uv;
    for (let n = 0, tries = 0; n < PER_SLICE && tries < 400; tries += 1) {
      const v = Math.floor(Math.random() * vertices.count);
      const o = (Math.min(image.height - 1, Math.floor((1 - uvs.getY(v)) * image.height)) * image.width + Math.min(image.width - 1, Math.floor(uvs.getX(v) * image.width))) * 4;
      if (px[o + 3] < 200) continue;
      n += 1;
      const p = [vertices.getX(v), vertices.getY(v), vertices.getZ(v) + mesh.position.z];
      const u = p[0] / width + 0.5, vv = 0.5 - p[1] / height;
      const d = Math.abs(u - 0.5) > Math.abs(vv - 0.5) * 0.8 ? (u < 0.5 ? 0 : 1) : (vv < 0.5 ? 2 : 3);
      const s = Math.random();
      for (const e of [0, 1]) {
        pos.push(...p);
        col.push(px[o] / 255, px[o + 1] / 255, px[o + 2] / 255);
        end.push(e); dir.push(d); slice.push(i); seed.push(s);
      }
    }
  });
  return stringLines(pos, col, end, dir, slice, seed);
}

function stringLines(pos, col, end, dir, slice, seed) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geometry.setAttribute("aEnd", new THREE.Float32BufferAttribute(end, 1));
  geometry.setAttribute("aDir", new THREE.Float32BufferAttribute(dir, 1));
  geometry.setAttribute("aSlice", new THREE.Float32BufferAttribute(slice, 1));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uGroup: { value: new THREE.Matrix4() },
      uCut: { value: 0 },
      uTime: { value: 0 },
      uAlpha: { value: 1 },
    },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aEnd, aDir, aSlice, aSeed;
      uniform mat4 uGroup;
      uniform float uCut;
      varying vec3 vC;
      varying float vAlong, vLive, vSeed;
      void main() {
        vec4 w = uGroup * vec4(position, 1.0);
        // strings leave in world axes, so they run parallel to the fibres
        float len = 9.0 + aSeed * 16.0;
        vec2 d = aDir < 0.5 ? vec2(-1.0, 0.0) : aDir < 1.5 ? vec2(1.0, 0.0) : aDir < 2.5 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
        w.xy += d * len * aEnd;
        float age = uCut - aSlice;
        vLive = age < 0.0 ? 0.0 : 1.0 - age / ${STRING_WINDOW.toFixed(1)};
        vAlong = aEnd;
        vSeed = aSeed;
        vC = color;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uAlpha;
      varying vec3 vC;
      varying float vAlong, vLive, vSeed;
      void main() {
        if (vLive <= 0.0) discard;
        float fade = pow(1.0 - vAlong, 1.6);
        float pulse = pow(max(0.0, sin(vAlong * 12.0 - uTime * 2.0 + vSeed * 30.0)), 12.0);
        float a = vLive * fade * (0.35 + 0.9 * pulse) * uAlpha;
        // footage colour, pushed a little toward the construct's amber
        gl_FragColor = vec4(mix(vC, vC * vec3(1.15, 0.9, 0.6), 0.5) * a * 0.8, 1.0);
      }
    `,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}

// position the strings with their specimen and keep them at its read head
export function syncStrings(lines, group, cut, time, alpha) {
  const u = lines.material.uniforms;
  group.updateMatrixWorld();
  u.uGroup.value.copy(group.matrixWorld);
  u.uCut.value = Math.max(0, Math.round(group.children.length * cut) - 1);
  u.uTime.value = time;
  u.uAlpha.value = alpha;
}

export function disposeVolume(group) {
  group.children.forEach((mesh) => {
    mesh.geometry?.dispose();
    if (group.userData.generated) mesh.material?.map?.dispose();
    mesh.material?.dispose();
  });
  group.userData.map?.dispose();
  group.clear();
}

export async function loadVolume(basePath, name) {
  const meta = await (await fetch(`${basePath}/${name}.json`)).json();
  const texture = await new THREE.TextureLoader().loadAsync(`${basePath}/${name}.webp`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, meta };
}
