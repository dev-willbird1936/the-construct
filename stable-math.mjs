// Pure helpers shared by the experimental viewer and its regression tests.
// Keep the resting angle on the short axis in portrait, without narrowing an
// existing wide lens. Invalid/zero-size viewports retain the resting projection.
export function portraitFov(restingFov, aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= 1) return restingFov;
  const wider = 2 * Math.atan(Math.tan(restingFov * Math.PI / 360) / aspect) * 180 / Math.PI;
  return Math.max(restingFov, Math.min(110, wider));
}

export function frameAt(times, elapsed) {
  const t = times[0] + elapsed;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  return lo + Math.max(0, Math.min(1, (t - times[lo]) / (times[hi] - times[lo])));
}

export function poseKeys(points, body, limit = 12, separation = 0.75) {
  const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  const lengths = points.map((p, i) => i ? distance(p, points[i - 1]) : 0);
  const spacing = Math.max(body * separation, lengths.reduce((a, b) => a + b, 0) / (limit - 1), 1e-5);
  const keys = [0];
  let travelled = 0;
  lengths.forEach((d, i) => {
    travelled += d;
    if (travelled >= spacing) { keys.push(i); travelled = 0; }
  });
  return keys;
}

// Constrain excessive monocular relief along the original camera rays. This
// keeps every source projection unchanged; it does NOT infer unseen geometry.
export function regularisePositions(pos, indices, matrix, centroid) {
  const [ox, oy, oz] = matrix.slice(12, 15);
  const centerZ = (centroid[0] - ox) * matrix[8] + (centroid[1] - oy) * matrix[9] + (centroid[2] - oz) * matrix[10];
  if (centerZ >= -1e-6) return 1;
  const used = new Uint8Array(pos.length / 3);
  let unique = 0;
  for (const v of indices) if (!used[v]) { used[v] = 1; unique++; }
  // A bounded, deterministic sample estimates robust thickness; transforming
  // every vertex still preserves every ray. Avoid millions of temporary arrays.
  const capacity = Math.min(unique, 2048), stride = Math.max(1, Math.ceil(unique / 2048));
  const depth = new Float64Array(capacity), width = new Float64Array(capacity), height = new Float64Array(capacity);
  let visited = 0, count = 0;
  for (let v = 0; v < pos.length; v += 3) {
    if (!used[v / 3] || visited++ % stride) continue;
    const dx = pos[v] - ox, dy = pos[v + 1] - oy, dz = pos[v + 2] - oz;
    const z = dx * matrix[8] + dy * matrix[9] + dz * matrix[10];
    if (z >= -1e-6) continue;
    depth[count] = z;
    width[count] = (dx * matrix[0] + dy * matrix[1] + dz * matrix[2]) * centerZ / z;
    height[count++] = (dx * matrix[4] + dy * matrix[5] + dz * matrix[6]) * centerZ / z;
  }
  if (count < 4) return 1;
  const span = a => { const sorted = a.subarray(0, count).sort(); return sorted[Math.floor(count * 0.9)] - sorted[Math.floor(count * 0.1)]; };
  const thickness = span(depth), cross = Math.min(span(width), span(height));
  const relief = Math.min(1, Math.max(0.05, 0.45 * cross / Math.max(thickness, 1e-6)));
  if (relief === 1) return relief;
  for (let v = 0; v < pos.length; v += 3) {
    const dx = pos[v] - ox, dy = pos[v + 1] - oy, dz = pos[v + 2] - oz;
    const z = dx * matrix[8] + dy * matrix[9] + dz * matrix[10];
    if (z >= -1e-6) continue;
    const ratio = (centerZ + (z - centerZ) * relief) / z;
    pos[v] = ox + dx * ratio; pos[v + 1] = oy + dy * ratio; pos[v + 2] = oz + dz * ratio;
  }
  return relief;
}

export function validateMeta(meta) {
  if (meta.version === 2) return validateWorld(meta);
  const n = meta.times?.length;
  if (!n || n < 2 || meta.sub?.length !== n || meta.cameras?.length !== n || !meta.env?.length ||
      !(meta.width > 0 && meta.height > 0 && meta.fovY > 0 && meta.fovY < 180) ||
      meta.times.some((t, i) => !Number.isFinite(t) || (i && t <= meta.times[i - 1])) ||
      meta.cameras.some(c => c.length !== 16 || c.some(v => !Number.isFinite(v))) ||
      meta.sub.filter(Boolean).length < 2 ||
      meta.sub.some(s => s && (s.centroid?.length !== 3 || s.centroid.some(v => !Number.isFinite(v))))) {
    throw new Error('This clip has invalid or incomplete reconstruction data.');
  }
}

export function timeLabel(t) {
  const cents = Math.max(0, Math.round(t * 100));
  const minutes = Math.floor(cents / 6000);
  return `${String(minutes).padStart(2, '0')}:${((cents % 6000) / 100).toFixed(2).padStart(5, '0')}`;
}

// Version 2 (make-world.py): any number of animals, each shell a depth grid and a crop texture.
function validateWorld(meta) {
  const n = meta.times?.length;
  const finite = (a, len) => a?.length === len && a.every(Number.isFinite);
  if (!n || n < 2 || meta.cameras?.length !== n || !meta.env?.length ||
      !(meta.width > 0 && meta.height > 0 && meta.fovY > 0 && meta.fovY < 180 && meta.tanX > 0 && meta.tanY > 0) ||
      meta.times.some((t, i) => !Number.isFinite(t) || (i && t <= meta.times[i - 1])) ||
      meta.cameras.some(c => c.length !== 16 || c.some(v => !Number.isFinite(v))) ||
      !Array.isArray(meta.shells) || meta.shells.length < 2 ||
      meta.shells.some(s => !Number.isInteger(s.i) || s.i < 0 || s.i >= n || !Number.isInteger(s.track) ||
        !finite(s.centroid, 3) || !finite(s.foot, 3) || !finite(s.box, 4) || !finite(s.d, 2) ||
        !(s.gw > 1 && s.gh > 1) || !Number.isInteger(s.off) || typeof s.tex !== 'string')) {
    throw new Error('This clip has invalid or incomplete reconstruction data.');
  }
}

/** A world's surround (make-world.py `fill.surround`: the picture continued past the frame), or null when it has none
 * or it is malformed: { tex: an env/ image path, pad: [x, y] shares of the frame it reaches past each edge } */
export function surroundOf(meta) {
  const s = meta?.fill?.surround;
  if (!s || typeof s.tex !== 'string' || !/^env\/[\w.-]+\.(jpg|png|webp)$/.test(s.tex) || !Array.isArray(s.pad) || s.pad.length !== 2 ||
      !s.pad.every((p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p <= 1)) return null;
  return { tex: s.tex, pad: [s.pad[0], s.pad[1]] };
}
