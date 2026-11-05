// Lite motion pose selection: pick 8-14 poses by motion (3-5 for still
// subjects) from per-frame alpha stats.
//
// Dependency-free on purpose (same reason as lite-frame.js): the browser
// resolves `three` via importmap but node unit tests cannot import
// `volume.js`, so the selection maths lives here with no imports and is
// shared by tests, the repack driver, and (later) the runner.

export const MAX_POSES = 14;
export const MIN_POSES = 3;

// Downsampled alpha grid edge; 48x48 bits = 288 bytes/frame, enough for IoU.
export const STAT_GRID = 48;

// Codec between RGBA pixels and stats. `borderPx`: alpha within this many px
// of the frame edge counts as border-touching (a pose cut by the picture's
// edge; the selector drops those unless dropping would starve the minimum).
// `timestamps`/`minGapSec`: minimum seconds between kept poses (default half
// the even spacing) so an approaching subject cannot stack near-identical
// poses head-on; the now-pose always stands (displacing, not joining).
export function frameStats(rgba, w, h, { grid = STAT_GRID, borderPx = 2, alphaT = 128 } = {}) {
  const bits = new Uint8Array(grid * grid);
  const sx = w / grid, sy = h / grid;
  let on = 0, cx = 0, cy = 0, rS = 0, gS = 0, bS = 0;
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x = Math.min(w - 1, Math.floor((gx + 0.5) * sx));
      const y = Math.min(h - 1, Math.floor((gy + 0.5) * sy));
      const o = (y * w + x) * 4;
      const a = rgba[o + 3];
      if (a > alphaT) {
        bits[gy * grid + gx] = 1;
        on += 1;
        cx += gx;
        cy += gy;
        rS += rgba[o]; gS += rgba[o + 1]; bS += rgba[o + 2];
      }
    }
  }
  let border = false;
  const edge = Math.max(1, Math.floor(Number(borderPx) || 0));
  outer: for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x >= edge && x < w - edge && y >= edge && y < h - edge) continue;
      if (rgba[(y * w + x) * 4 + 3] > alphaT) { border = true; break outer; }
    }
  }
  return {
    coverage: on / (grid * grid),
    cx: on ? cx / on / grid : 0.5,
    cy: on ? cy / on / grid : 0.5,
    // Mean opaque colour (0..1): drives appearance-distance selection so
    // the row holds distinct looks, not near-identical stamps.
    col: on ? [rS / on / 255, gS / on / 255, bS / on / 255] : [0, 0, 0],
    border,
    bits,
    grid,
  };
}

function iou(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.bits.length; i += 1) {
    const av = a.bits[i], bv = b.bits[i];
    if (av || bv) {
      union += 1;
      if (av && bv) inter += 1;
    }
  }
  return union === 0 ? 1 : inter / union;
}

const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);

// Mean pairwise motion over a selected set: centroid travel (normalized by
// the unit-square diagonal) plus appearance change. ~0 for identical
// frames; anything actually moving scores an order of magnitude higher.
// The runner fails effectively-static jobs on STATIC_MOTION.
export const STATIC_MOTION = 0.02;
export function meanPairwiseMotion(sub) {
  if (!Array.isArray(sub) || sub.length < 2) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i < sub.length; i += 1) {
    for (let j = i + 1; j < sub.length; j += 1) {
      const a = sub[i], b = sub[j];
      const cent = Math.hypot(a.cx - b.cx, a.cy - b.cy) / Math.SQRT2;
      sum += 0.5 * cent + 0.5 * appearanceDist(a, b);
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

// Appearance distance between two frames: silhouette (1 - mask IoU) plus
// mean-colour distance, so the row holds distinct looks. Both terms 0..1.
export function appearanceDist(a, b) {
  const sil = 1 - iou(a, b);
  const ca = a.col || [0, 0, 0], cb = b.col || [0, 0, 0];
  const col = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) / Math.sqrt(3);
  return 0.5 * sil + 0.5 * col;
}

// Pure selection over stats (timestamps carried for even fill-ins).
// Rule: always keep first; keep a frame when mask overlap with the last kept
// pose drops (1-IoU > iouDrop) or the centroid moves (dist > moveFrac of the
// unit-square diagonal); always keep last. Poses whose mask touches the frame
// border are dropped (they are cut by the picture's edge) unless that would
// leave fewer than MIN_POSES. Over MAX_POSES: even-thin keeping first+last.
// Under MIN_POSES: even fill to MIN_POSES. A still subject keeps ~first+last
// +1 fill = 3 distinct poses, never a smear.
export function selectPoses(stats, {
  max = MAX_POSES, min = MIN_POSES, iouDrop = 0.25, moveFrac = 0.12, dropBorder = true,
  timestamps = null, minGapSec = null,
} = {}) {
  if (!stats.length) return [];
  // Candidate pool: poses cut by the picture's edge carry no clean shape, so
  // they are out (a leaving subject ends on its last whole pose); empty
  // frames carry no pose at all. Starvation falls back toward everything.
  const hasContent = stats.map((_, i) => i).filter((i) => stats[i].coverage > 0);
  const clean = hasContent.filter((i) => !dropBorder || !stats[i].border);
  const pool = clean.length >= min ? clean : hasContent.length >= min ? hasContent : stats.map((_, i) => i);
  // Minimum time gap between kept poses: without it an approaching subject
  // (masks overlap heavily) clusters many near-identical poses <0.5 s apart
  // that stack head-on and hide each other. Default: half the even spacing.
  const times = Array.isArray(timestamps) && timestamps.length === stats.length
    ? timestamps
    : pool.map((i) => i);
  const spanT = Math.max(times[pool[pool.length - 1]] - times[pool[0]], 1e-6);
  const gap = Math.max(0, Number(minGapSec) || spanT / (2 * Math.max(1, max)));
  const keep = [pool[0]];
  for (let k = 1; k < pool.length - 1; k += 1) {
    const i = pool[k];
    const last = stats[keep[keep.length - 1]];
    const moved = 1 - iou(stats[i], last) > iouDrop || dist(stats[i], last) > moveFrac;
    const spaced = times[i] - times[keep[keep.length - 1]] >= gap - 1e-9;
    if (moved && spaced) keep.push(i);
  }
  const lastIdx = pool[pool.length - 1];
  if (keep[keep.length - 1] !== lastIdx) {
    // The now-pose always stands: if it falls inside the gap, it displaces
    // the previous keep instead of stacking head-on with it.
    if (times[lastIdx] - times[keep[keep.length - 1]] < gap && keep.length > 1) keep[keep.length - 1] = lastIdx;
    else keep.push(lastIdx);
  }
  let out = [...new Set(keep)].sort((a, b) => a - b);
  if (out.length > max) {
    // Thin by APPEARANCE + motion, not blindly even: greedy max-min on the
    // combined silhouette/colour distance, seeded with first+last. Twelve
    // near-identical stamps read as a pattern; distinct looks read as time.
    // (Screen overlap stays bounded by the min time gap above.)
    const kept = [out[0], out[out.length - 1]];
    const rest = out.slice(1, -1);
    while (kept.length < max && rest.length) {
      let bi = -1, bd = -1;
      for (let k = 0; k < rest.length; k += 1) {
        let m = Infinity;
        for (const q of kept) m = Math.min(m, appearanceDist(stats[rest[k]], stats[q]));
        if (m > bd) { bd = m; bi = k; }
      }
      kept.push(rest.splice(bi, 1)[0]);
    }
    out = [...new Set(kept)].sort((a, b) => a - b);
  }
  if (out.length < min && pool.length >= min) {
    const filled = [...out];
    for (let k = 0; k < pool.length && filled.length < min; k += 1) {
      const idx = pool[Math.min(pool.length - 1, Math.round((k * (pool.length - 1)) / (min - 1)))];
      if (!filled.includes(idx)) filled.push(idx);
    }
    out = filled.sort((a, b) => a - b);
  }
  return out;
}
