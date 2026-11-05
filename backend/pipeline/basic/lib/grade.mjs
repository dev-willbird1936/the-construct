// Neon footage grade (tier-improve loop 12). Pure, unit-tested.
//
// Some clips arrive oversaturated (slovakdeer, the roe deer example: mean
// HSV saturation 239/255, 60 % of pixels over 240), and in the room they read
// as neon next to everything else. When the plate is clearly neon, one
// shared grade goes on the plate, the subject atlas and the thumb (behind.webp
// is built from the graded plate), so the subject still matches its scene:
// a blend toward luma in gamma space, a slight brightness trim, a touch of
// warmth. Every other clip is untouched (the gate does not fire, nothing is
// re-encoded).

export const NEON_MEAN_S = 170; // plate mean HSV saturation (0-255) over this ...
export const NEON_CLIP_SHARE = 0.25; // ... with this share of pixels over NEON_CLIP_S
export const NEON_CLIP_S = 240;
export const GRADE = { keep: 0.6, bright: 0.92, warmR: 1.03, warmB: 0.96 };

/** Mean HSV saturation (0-255) and share of pixels over NEON_CLIP_S of raw RGB(A) pixels. */
export function saturationStats(data, channels) {
  let sum = 0;
  let clip = 0;
  let n = 0;
  for (let p = 0; p + 2 < data.length; p += channels) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const max = Math.max(r, g, b);
    const s = max ? (255 * (max - Math.min(r, g, b))) / max : 0;
    sum += s;
    if (s > NEON_CLIP_S) clip += 1;
    n += 1;
  }
  return { meanS: n ? sum / n : 0, clipShare: n ? clip / n : 0 };
}

/** The grade to apply, or null when the plate is not clearly neon. */
export function neonGrade(stats) {
  if (!stats || !(stats.meanS > NEON_MEAN_S) || !(stats.clipShare > NEON_CLIP_SHARE)) return null;
  return { ...GRADE, meanS: Math.round(stats.meanS), clipShare: Math.round(stats.clipShare * 100) / 100 };
}

/** Grade raw RGB(A) pixels in place (alpha untouched). */
export function applyGrade(data, channels, grade) {
  if (!grade) return data;
  const { keep, bright, warmR, warmB } = grade;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let p = 0; p + 2 < data.length; p += channels) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    data[p] = clamp((y + keep * (r - y)) * bright * warmR);
    data[p + 1] = clamp((y + keep * (g - y)) * bright);
    data[p + 2] = clamp((y + keep * (b - y)) * bright * warmB);
  }
  return data;
}
