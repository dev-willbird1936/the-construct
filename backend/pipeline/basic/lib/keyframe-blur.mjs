/**
 * Local-motion keyframe rejection (Lane D, BLUR-KF-V1). Pure; Node stdlib only.
 *
 * Whole-body sharpness cannot see a smeared ear on an otherwise still deer,
 * so `sharpness.py --local` scores each sample's PEAK local motion instead:
 * Farneback p95 speed inside the subject mask. blurDetails drops (or snaps
 * away) keyframes whose p95 is an outlier vs the clip median:
 *   - outlier: p95 > OUTLIER_FACTOR x clip median (eye-set at 1.75 on
 *     slovakdeer; see BLUR-KF.md for the gap it sits in);
 *   - prefer snapping to the calmest non-outlier present sample within
 *     +-radius, provided it is at most BLUR_SNAP_GAIN x the current p95;
 *   - otherwise drop, worst first, but never the seed, never two adjacent
 *     keyframes, never more than BLUR_MAX_DROP_FRAC of the keyframes.
 * Unscored keyframes are never moved or dropped.
 */

export const BLUR_OUTLIER_FACTOR = 1.75;
export const BLUR_SNAP_GAIN = 0.8;
export const BLUR_MAX_DROP_FRAC = 0.15;

function asScoreFn(local) {
  if (local == null) return () => undefined;
  if (typeof local.get === "function") {
    return (s) => {
      const v = local.get(s) ?? local.get(String(s));
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    };
  }
  return (s) => {
    const v = local[s] ?? local[String(s)];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
}

function medianOf(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clipMedian(local) {
  const vals = [];
  if (local instanceof Map) {
    for (const v of local.values()) if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
  } else if (local != null) {
    for (const v of Object.values(local)) if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
  }
  return medianOf(vals);
}

/**
 * Core rule: returns { kept, dropped, moves }.
 *  - keyframes: shipped picks (any order; sorted internally).
 *  - present: samples where the subject is visible (array or Set).
 *  - local: clip-wide {sample: p95} object or Map (median is taken over it).
 *  - opts: {seed, radius=2, factor=1.75, snapGain=0.8, minGap=1,
 *             maxDropFrac=0.15, maxGap=Infinity, maxDropGap=Infinity}.
 *    Loop 11: a move may not leave a gap wider than max(maxGap, the gap
 *    before it), and a drop may not merge two gaps into one wider than
 *    maxDropGap; with the morphing viewer a wide gap is a doubled body.
 * kept: final time-ordered keyframes (snapped positions substituted).
 * dropped: removed keyframes in time order. moves: [{from,to,before,after}].
 */
export function blurDetails(keyframes, present, local, opts = {}) {
  const {
    seed = null,
    radius = 2,
    factor = BLUR_OUTLIER_FACTOR,
    snapGain = BLUR_SNAP_GAIN,
    minGap = 1,
    maxDropFrac = BLUR_MAX_DROP_FRAC,
    maxGap = Infinity,
    maxDropGap = Infinity,
  } = opts ?? {};
  if (!Array.isArray(keyframes) || keyframes.length === 0) return { kept: [], dropped: [], moves: [] };
  const ordered = [...new Set(keyframes)].sort((a, b) => a - b);
  const kfSet = new Set(ordered);
  const presentSet = present instanceof Set ? new Set(present) : new Set(present);
  const get = asScoreFn(local);
  const med = clipMedian(local);
  if (!(med > 0)) return { kept: ordered, dropped: [], moves: [] };
  const thr = factor * med;
  const isOutlier = (s) => {
    const v = get(s);
    return v !== undefined && v > thr;
  };

  // Phase 1: snap each outlier (worst improvement first) to a calm neighbour.
  const finalPos = new Map(ordered.map((s) => [s, s]));
  const proposals = [];
  for (const s of ordered) {
    if (s === seed) continue; // seed stays fixed, never snapped away
    const base = get(s);
    if (base === undefined || !(base > thr)) continue;
    let best = -1;
    let bestScore = Infinity;
    for (let c = s - radius; c <= s + radius; c += 1) {
      if (c === s) continue;
      if (!presentSet.has(c)) continue;
      if (c === seed) continue; // never land on the seed
      if (kfSet.has(c)) continue; // never land on another pick's slot
      const v = get(c);
      if (v === undefined) continue;
      if (v <= thr && v <= snapGain * base && v < bestScore) {
        best = c;
        bestScore = v;
      }
    }
    if (best !== -1) proposals.push({ from: s, to: best, before: base, after: bestScore, gain: base - bestScore });
  }
  proposals.sort((a, b) => b.gain - a.gain);
  const moves = [];
  for (const m of proposals) {
    finalPos.set(m.from, m.to);
    const vals = ordered.map((s) => finalPos.get(s));
    let ok = new Set(vals).size === vals.length;
    for (let i = 1; ok && i < vals.length; i += 1) {
      const gap = vals[i] - vals[i - 1];
      ok = gap >= minGap && gap <= Math.max(maxGap, ordered[i] - ordered[i - 1]);
    }
    if (ok) moves.push({ from: m.from, to: m.to, before: m.before, after: m.after });
    else finalPos.set(m.from, m.from);
  }
  moves.sort((a, b) => a.from - b.from);
  const movedFrom = new Set(moves.map((m) => m.from));

  // Phase 2: drop leftover outliers, worst first, under the guard rails.
  const maxDrops = Math.floor(maxDropFrac * ordered.length);
  const leftovers = ordered
    .filter((s) => !movedFrom.has(s) && s !== seed && isOutlier(s))
    .sort((a, b) => get(b) - get(a));
  const droppedSet = new Set();
  const indexOf = new Map(ordered.map((s, i) => [s, i]));
  for (const s of leftovers) {
    if (droppedSet.size >= maxDrops) break;
    const i = indexOf.get(s);
    const prev = ordered[i - 1];
    const next = ordered[i + 1];
    if ((prev !== undefined && droppedSet.has(prev)) || (next !== undefined && droppedSet.has(next))) continue;
    if (prev !== undefined && next !== undefined && finalPos.get(next) - finalPos.get(prev) > maxDropGap) continue;
    droppedSet.add(s);
  }
  const dropped = ordered.filter((s) => droppedSet.has(s));
  const kept = ordered.filter((s) => !droppedSet.has(s)).map((s) => finalPos.get(s));
  return { kept, dropped, moves };
}
