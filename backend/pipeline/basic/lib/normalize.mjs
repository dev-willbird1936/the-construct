// Depth normalisation + plate validation metrics. Pure, unit-tested.

/**
 * Robust affine fit of `img` onto `ref` over paired samples (background pixels
 * only): median-ratio/median-shift start, then 3 rounds of least squares on
 * MAD-gated inliers. Recovers exact scale+shift on clean data and ignores
 * subject pixels that leaked into the background set.
 */
export function robustAffineFit(ref, img) {
  if (ref.length !== img.length || ref.length === 0) {
    throw new Error("robustAffineFit needs non-empty paired samples");
  }
  const ratios = [];
  for (let i = 0; i < ref.length; i += 1) {
    if (Math.abs(img[i]) > 1e-9) ratios.push(ref[i] / img[i]);
  }
  if (!ratios.length) throw new Error("robustAffineFit: degenerate input");
  let a = median(ratios);
  let b = median(Array.from(ref, (v, i) => v - a * img[i]));
  for (let round = 0; round < 3; round += 1) {
    const resid = Array.from(ref, (v, i) => Math.abs(v - (a * img[i] + b)));
    const gate = Math.max(3 * median(resid), 1e-6);
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (let i = 0; i < ref.length; i += 1) {
      if (resid[i] > gate) continue;
      sx += img[i]; sy += ref[i]; sxx += img[i] * img[i]; sxy += img[i] * ref[i]; n += 1;
    }
    if (n < 2) break;
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-12) break;
    a = (n * sxy - sx * sy) / denom;
    b = (sy - a * sx) / n;
  }
  return { scale: a, shift: b };
}

export function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Percentile of a numeric array (linear interpolation). */
export function percentile(values, p) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (!sorted.length) throw new Error("percentile of empty array");
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Map float depths to 8-bit with robust windowing. Returns {bytes, min, max}.
 * Values outside [min,max] clip — honest saturation, recorded in the mapping.
 */
export function normalizeDepth01(depth, { lo = 1, hi = 99 } = {}) {
  const min = percentile(depth, lo);
  const max = percentile(depth, hi);
  const span = max - min || 1;
  const bytes = new Uint8Array(depth.length);
  for (let i = 0; i < depth.length; i += 1) {
    const v = (depth[i] - min) / span;
    bytes[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return { bytes, min, max };
}

/**
 * Mean + p95 absolute difference of two equal-size grayscale buffers over
 * background pixels (mask = 1 where the subject was). For plate validation:
 * a Muse plate that changed the scene fails here.
 */
export function backgroundDiff(a, b, subjectMask) {
  if (a.length !== b.length || a.length !== subjectMask.length) {
    throw new Error("backgroundDiff: buffer size mismatch");
  }
  const diffs = [];
  for (let i = 0; i < a.length; i += 1) {
    if (!subjectMask[i]) diffs.push(Math.abs(a[i] - b[i]));
  }
  if (!diffs.length) throw new Error("backgroundDiff: no background pixels");
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  return { mean, p95: percentile(diffs, 95), pixels: diffs.length };
}

/** Plate acceptance thresholds (0-255 grayscale, background only). */
export const PLATE_LIMITS = { mean: 6.0, p95: 25.0 };

export function platePassesValidation({ mean, p95 }) {
  return mean <= PLATE_LIMITS.mean && p95 <= PLATE_LIMITS.p95;
}
