/**
 * Sharpness-aware keyframe snapping (Lane D, SHARP-KF-V1). Pure; Node stdlib only.
 *
 * Basic/Advanced pick evenly spaced keyframes over the samples where the
 * subject track is present. A keyframe can land mid ear-flick/head-jerk while
 * a neighbour 1-2 samples away is sharp. snapKeyframes moves each pick to the
 * best-scoring present sample within +-radius, subject to:
 *   - keep: seed sample(s) stay fixed and are never landed on;
 *   - strict time order with at least minGap between neighbours, no duplicates;
 *   - a move happens only on real gain: best >= GAIN_MARGIN x own score.
 *
 * The gain test is a RATIO on median-normalised scores, so it is
 * scale-invariant across clips: no per-clip threshold. The 15% margin sits
 * above frame-to-frame Laplacian jitter (a few percent on textured subjects)
 * and far below a genuine motion-blur dip (typically 30-60% loss), so it is a
 * noise-floor argument, not a value fitted to one clip.
 */

export const GAIN_MARGIN = 1.15;

function asScoreFn(score) {
  if (score == null) return () => undefined;
  if (typeof score.get === "function") {
    return (s) => {
      const v = score.get(s) ?? score.get(String(s));
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    };
  }
  return (s) => {
    const v = score[s] ?? score[String(s)];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
}

/**
 * Core snap: returns { snapped, moves }.
 *  - samples: evenly spaced picks (sample numbers, any order; sorted internally).
 *  - present: samples where the subject is visible (array or Set).
 *  - score: {sample: normalisedSharpness} object or Map.
 *  - opts: {radius=2, keep=[seedSample], minGap=1, maxGap=Infinity}. maxGap
 *    (loop 11): no move may leave a gap between neighbours wider than
 *    max(maxGap, that gap before the move). With the morphing viewer a wide
 *    gap is a doubled body; snapping away from a fast motion opened them.
 * snapped: new sample per pick, in time order. moves: applied [{from,to,before,after,gain}].
 */
export function snapDetails(samples, present, score, opts = {}) {
  const { radius = 2, keep = [], minGap = 1, maxGap = Infinity } = opts ?? {};
  if (!Array.isArray(samples) || samples.length === 0) return { snapped: [], moves: [] };
  const ordered = [...samples].sort((a, b) => a - b);
  const orderedSet = new Set(ordered);
  const presentSet = present instanceof Set ? present : new Set(present);
  const keepSet = new Set(keep);
  const get = asScoreFn(score);

  const finalPos = new Map(ordered.map((s) => [s, s]));
  const proposals = [];
  for (const s of ordered) {
    if (keepSet.has(s)) continue; // seed stays fixed
    const base = get(s);
    if (!(base > 0)) continue; // no score: never move blind
    let best = s;
    let bestScore = base;
    for (let c = s - radius; c <= s + radius; c += 1) {
      if (c === s) continue;
      if (!presentSet.has(c)) continue;
      if (keepSet.has(c)) continue; // never land on the seed
      if (orderedSet.has(c)) continue; // never land on another pick's slot
      const cs = get(c);
      if (!(cs > 0)) continue;
      if (cs > bestScore) {
        best = c;
        bestScore = cs;
      }
    }
    if (best !== s && bestScore >= GAIN_MARGIN * base) {
      proposals.push({ from: s, to: best, before: base, after: bestScore, gain: bestScore / base });
    }
  }

  // Commit largest gain first; revert any move that breaks order/gap/uniqueness.
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
    if (ok) moves.push(m);
    else finalPos.set(m.from, m.from);
  }
  moves.sort((a, b) => a.from - b.from);
  return { snapped: ordered.map((s) => finalPos.get(s)), moves };
}

/**
 * Move each evenly spaced sample to the best-scoring present sample within
 * +-radius. Returns the new samples in time order (same length as input).
 */
export function snapKeyframes(samples, present, score, opts = {}) {
  return snapDetails(samples, present, score, opts).snapped;
}
