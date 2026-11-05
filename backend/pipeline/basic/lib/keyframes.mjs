// Keyframe + track selection for the Basic pipeline. Pure, unit-tested.

/** Evenly spread `limit` indices over `count` items (first and last kept). */
export function evenIndices(count, limit) {
  if (count <= 0) return [];
  if (limit <= 1) return [0];
  if (count <= limit) return Array.from({ length: count }, (_, i) => i);
  return Array.from(
    { length: limit },
    (_, i) => Math.round((i * (count - 1)) / (limit - 1))
  );
}

/**
 * Pick the subject track from a tracks.json track list.
 * @param tracks [{id, first, last, frames}] in track.js sample units
 * @param seedSample global sample index nearest the requested seed time
 * @param objectId optional explicit track id
 */
export function pickTrack(tracks, { objectId, seedSample } = {}) {
  if (!tracks?.length) throw new Error("no tracks to pick from");
  if (objectId != null) {
    const found = tracks.find((t) => t.id === Number(objectId));
    if (!found) throw new Error(`track ${objectId} not found`);
    return found;
  }
  const covering = tracks.filter((t) => t.first <= seedSample && seedSample <= t.last);
  const pool = covering.length ? covering : tracks;
  return pool.slice().sort((a, b) => b.frames - a.frames)[0];
}

/**
 * Choose keyframe sample indices where the track is present.
 * @param present sorted global sample indices with mask pixels for the track
 * @param maxKeyframes cap
 * @returns {samples} — throws when too few to build a specimen
 */
export function selectKeyframes(present, maxKeyframes) {
  const MIN_KEYFRAMES = 6;
  if (present.length < MIN_KEYFRAMES) {
    throw new Error(
      `track present in only ${present.length} samples (need >= ${MIN_KEYFRAMES})`
    );
  }
  return evenIndices(present.length, maxKeyframes).map((i) => present[i]);
}

/** IoU of two boxes in the SAME space ({left,top,right,bottom}). */
export function boxIoU(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const areaA = (a.right - a.left) * (a.bottom - a.top);
  const areaB = (b.right - b.left) * (b.bottom - b.top);
  if (!(areaA > 0) || !(areaB > 0)) return 0;
  return intersection / (areaA + areaB - intersection);
}

// Seed-box matching contract (selected-object identity correctness):
// the snapshot seed box is normalized 0..1 (detect result.objects space);
// track boxes derived from full-source label rasters are normalized to the
// same 0..1 space before compare, so source/downscaled sizes agree.
// Window ±3 samples ≈ ±0.2 s at 15 fps covers fps-rounding drift and an
// off-by-one seed sample. Thresholds are documented, not tuned per clip.
export const SEED_BOX_WINDOW = 3;
// Widest ring searched when nothing matches within SEED_BOX_WINDOW. The
// search stays nearest-ring-first, so every seed that matched before still
// resolves to the same track; only former refusals look further out. SAM
// video can start segmenting a few samples after the detect frame (clip-b,
// "man in glasses…": masks from sample 20, seed 15 -> best IoU 0 and a
// paid refusal). 15 samples = 1 s at the 15 fps track rate.
export const SEED_BOX_WINDOW_MAX = 15;
export const SEED_BOX_MIN_IOU = 0.15;
export const SEED_BOX_AMBIGUITY_EPS = 0.05;
// Reach past the window (tier-improve loop 12): a pick at the picker's
// default 0:00 on slovakdeer had its deer found by the frame-0 detect, but
// the concept pass segmented it only from sample 27 (1.8 s), so every ring
// within 1 s was empty and the build failed. With `reach` the search keeps
// going ring by ring past `window`, still nearest first and still refusing
// ties, but a ring past the window needs SEED_BOX_REACH_MIN_IOU: a late (or
// early-ending) SAM pass leaves the subject where it was clicked, so a far
// match must sit on the click, not merely touch it. Default reach = window.
export const SEED_BOX_REACH_MIN_IOU = 0.3;

/**
 * Parse a validated --seed-box value (normalized "l,t,r,b").
 * @param value string "l,t,r,b" or array [l,t,r,b]
 * @returns {left,top,right,bottom} — throws on degenerate/out-of-range input
 */
export function parseSeedBox(value) {
  const parts = Array.isArray(value)
    ? value
    : String(value ?? "").split(",").map((s) => Number(String(s).trim()));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new Error(`invalid --seed-box ${JSON.stringify(value)} (want "l,t,r,b" normalized 0..1)`);
  }
  const [left, top, right, bottom] = parts;
  if (!(left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top)) {
    throw new Error(`invalid --seed-box ${JSON.stringify(value)} (need 0<=l<r<=1, 0<=t<b<=1)`);
  }
  return { left, top, right, bottom };
}

/**
 * Resolve the video track matching an explicit seed box (never longest fallback).
 * @param tracks [{id, first, last, frames}] in track.js sample units
 * @param seedBox {left,top,right,bottom} normalized 0..1
 * @param seedSample global sample index nearest the requested seed time
 * @param getBox (trackId, sample) -> normalized box or null (injected raster reader)
 * @param window samples either side of the seed to search (default SEED_BOX_WINDOW)
 * @param minIoU minimum winning IoU (default SEED_BOX_MIN_IOU)
 * @param ambiguityEps top-two gap below which the match is ambiguous (default SEED_BOX_AMBIGUITY_EPS)
 * @param reach farthest ring searched (default window); rings past window need reachMinIoU
 * @param reachMinIoU minimum winning IoU past the window (default SEED_BOX_REACH_MIN_IOU)
 * @returns the winning track — throws on no-match/ambiguity (never falls back)
 */
export function matchSeedBox(tracks, { seedBox, seedSample, getBox, window = SEED_BOX_WINDOW, minIoU = SEED_BOX_MIN_IOU, ambiguityEps = SEED_BOX_AMBIGUITY_EPS, reach = window, reachMinIoU = SEED_BOX_REACH_MIN_IOU } = {}) {
  if (!tracks?.length) throw new Error("seed-box no match: no tracks to pick from");
  if (!seedBox || typeof getBox !== "function" || !Number.isInteger(seedSample)) {
    throw new Error("seed-box no match: missing seed box, seed sample or raster reader");
  }
  let bestSeen = 0;
  // Prefer the nearest time ring, not the maximum overlap anywhere in the
  // window: a different subject crossing later must not steal an exact match.
  const last = Math.max(window, Number.isInteger(reach) ? reach : window);
  for (let distance = 0; distance <= last; distance += 1) {
    const need = distance <= window ? minIoU : Math.max(minIoU, reachMinIoU);
    const samples = distance === 0 ? [seedSample] : [seedSample - distance, seedSample + distance];
    const scored = tracks.map((track) => {
      let best = 0;
      for (const s of samples) {
        let box = null;
        try {
          box = getBox(track.id, s);
        } catch {
          box = null;
        }
        if (!box) continue;
        const iou = boxIoU(seedBox, box);
        if (iou > best) best = iou;
      }
      return { track, best };
    });
    const ranked = scored.slice().sort((a, b) => b.best - a.best);
    const top = ranked[0];
    bestSeen = Math.max(bestSeen, top?.best || 0);
    if (!top || !(top.best > 0) || top.best < need) continue;
    const second = ranked[1];
    if (second && top.best - second.best < ambiguityEps) {
      throw new Error(`seed-box ambiguous (top IoUs ${top.best.toFixed(3)} vs ${second.best.toFixed(3)} within ${ambiguityEps}); re-pick a clearer frame`);
    }
    return top.track;
  }
  throw new Error(`seed-box no match (best IoU ${bestSeen.toFixed(3)} < ${minIoU}); re-pick the object`);
}

/** Source frame index for a track sample. */
export function sampleToSourceFrame(sample, sourceFps, sampleFps = 15) {
  return Math.round((sample / sampleFps) * sourceFps);
}

/** Time in seconds for a track sample. */
export function sampleToTime(sample, sampleFps = 15) {
  return sample / sampleFps;
}

// First sample per source frame, time order kept. Sources under the 15 fps
// sample rate map several samples to one frame (FFmpeg select emits each
// frame once); selected-source runs map 1:1, so this is a no-op there.
export function uniqueBySource(samples, sourceIndex) {
  const seen = new Set();
  return [...samples].sort((a, b) => a - b).filter((s) => {
    const i = sourceIndex(s);
    if (seen.has(i)) return false;
    seen.add(i);
    return true;
  });
}

// Loop 7 (tier-improve 2026-11-04): detect labels can be long descriptions
// ("white mug with blue handle") that SAM's video concept pass finds in no
// frame. Its head noun ("mug") is the retry concept: drop trailing
// qualifiers (with/in/on/of/holding/...), keep the last word. Returns null
// when the label is already that short.
export function headNoun(label) {
  const text = String(label ?? "").toLowerCase().replace(/[…"'“”]/g, " ").replace(/\.+/g, " ").trim();
  const core = text.split(/\s+(?:with|in|on|at|of|holding|wearing|near|by|under|behind|and|from)\s+|[,;:(]/)[0].trim();
  const words = core.split(/\s+/).filter(Boolean);
  // Trailing position words ("dog behind") and group nouns ("wolf pack")
  // are not what SAM should look for.
  while (words.length > 1 && /^(behind|front|left|right|background|foreground|nearby|far|close|centre|center|middle|top|bottom)$/.test(words.at(-1))) words.pop();
  if (words.length > 1 && /^(pack|herd|flock|group|pair|family|couple|team|crowd|school|swarm|litter|pod|troop)$/.test(words.at(-1))) words.pop();
  const noun = words.length ? words[words.length - 1] : "";
  return noun && noun !== text ? noun : null;
}

// The visitor's chosen frame stays a keyframe: when the subject is visible at
// the seed sample and no pick shares its source frame, the nearest even pick
// moves onto it (count, order and source uniqueness hold). The seed pose is
// then the one the visitor picked, and a plate edit of that frame applies.
export function pinSeedSample(samples, present, seedSample, sourceIndex = (s) => s) {
  if (!samples.length || !present.includes(seedSample)) return samples;
  const seedSrc = sourceIndex(seedSample);
  if (samples.some((s) => sourceIndex(s) === seedSrc)) return samples;
  let k = 0;
  for (let i = 1; i < samples.length; i += 1) if (Math.abs(samples[i] - seedSample) < Math.abs(samples[k] - seedSample)) k = i;
  const out = samples.slice();
  out[k] = seedSample;
  return out.sort((a, b) => a - b);
}

// Edge-cut ends (tier-improve loop 10): a subject walking out of (or into)
// the frame is cut by the frame border for its last (first) samples. In the
// orbit those poses show a straight cut edge sliding off the plate edge and a
// half-body blur at the border, and they hide nothing the rest of the clip
// lacks. A leading or trailing run of samples whose mask touches a border the
// seed sample's mask does not touch is dropped, at most `maxFrac` of the
// present samples per end; a longer run is the clip itself and is kept. The
// seed sample is never dropped, and at least `minKeep` samples remain.
// `edges` maps sample -> borders touched ("L", "R", "T", "B" letters), or ->
// an edgeStats() record. With records, a run is dropped only when it really
// is an exit/entry (loop 11): its new border cuts a real part of the subject
// (contact >= `minRel` of the subject's extent along that border) AND the
// subject moves toward that border (centroid >= `minMove` of the frame) or
// changes size (area ratio beyond `areaRatio`) across the run. A seated
// talker whose shoulder grazes a border keeps every sample (clip-a).
export const EDGE_TRIM_MAX_FRAC = 0.25;
export const EDGE_RUN_MIN_REL = 0.25;
export const EDGE_RUN_MIN_MOVE = 0.02;
export const EDGE_RUN_AREA_RATIO = 1.25;

// Shared end-run trim: drop the leading and trailing runs of `present` for
// which isCut(sample) holds. Each run stops at the seed sample, a run longer
// than `maxFrac` of the samples is kept whole (it is the clip, not an end),
// `accept(run, inner, side)` may veto a run, and at least `minKeep` remain.
// `total` is the clip's sample count the fraction refers to when an earlier
// trim already shortened `present` (blackbear: a 3-sample dissolve trim
// pushed its 21-sample exit run just past 25% of what was left).
export function trimEndRuns(present, isCut, seedSample, { maxFrac = EDGE_TRIM_MAX_FRAC, minKeep = 6, accept = null, total = 0 } = {}) {
  const n = present.length;
  if (!n) return { kept: present, lead: 0, trail: 0, vetoed: [] };
  let seed = present[0];
  for (const s of present) if (Math.abs(s - seedSample) < Math.abs(seed - seedSample)) seed = s;
  const limit = Math.floor(Math.max(n, total) * maxFrac);
  let lead = 0;
  while (lead < n && present[lead] !== seed && isCut(present[lead])) lead += 1;
  let trail = 0;
  while (trail < n - lead && present[n - 1 - trail] !== seed && isCut(present[n - 1 - trail])) trail += 1;
  if (lead > limit) lead = 0;
  if (trail > limit) trail = 0;
  const vetoed = [];
  if (accept && lead && !accept(present.slice(0, lead), present[lead], "lead")) { vetoed.push({ side: "lead", run: lead }); lead = 0; }
  if (accept && trail && !accept(present.slice(n - trail).reverse(), present[n - 1 - trail], "trail")) { vetoed.push({ side: "trail", run: trail }); trail = 0; }
  if (n - lead - trail < minKeep) return { kept: present, lead: 0, trail: 0, vetoed };
  return { kept: present.slice(lead, n - trail), lead, trail, vetoed };
}

const edgeLetters = (v) => String(typeof v === "object" && v !== null ? v.edges : v ?? "");
export function trimEdgeRuns(present, edges, seedSample, {
  maxFrac = EDGE_TRIM_MAX_FRAC, minKeep = 6, total = 0,
  minRel = EDGE_RUN_MIN_REL, minMove = EDGE_RUN_MIN_MOVE, areaRatio = EDGE_RUN_AREA_RATIO,
} = {}) {
  if (!present.length) return { kept: present, lead: 0, trail: 0, vetoed: [] };
  let seed = present[0];
  for (const s of present) if (Math.abs(s - seedSample) < Math.abs(seed - seedSample)) seed = s;
  const seedEdges = edgeLetters(edges.get(seed));
  const newEdges = (s) => [...edgeLetters(edges.get(s))].filter((e) => !seedEdges.includes(e));
  const withStats = typeof edges.get(seed) === "object" && edges.get(seed) !== null;
  // run: outermost sample first; inner: the first sample kept next to it
  const accept = withStats ? (run, inner) => {
    const borders = [...new Set(run.flatMap(newEdges))];
    const rel = Math.max(0, ...run.flatMap((s) => borders.map((e) => edges.get(s)?.rel?.[e] ?? 0)));
    if (rel < minRel) return false;
    const a = edges.get(inner), b = edges.get(run[0]);
    if (!a || !b) return true;
    const dir = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };
    const toward = Math.max(...borders.map((e) => (b.cx - a.cx) * dir[e][0] + (b.cy - a.cy) * dir[e][1]));
    const ratio = a.area > 0 ? b.area / a.area : 1;
    return toward >= minMove || ratio >= areaRatio || ratio <= 1 / areaRatio;
  } : null;
  return trimEndRuns(present, (s) => newEdges(s).length > 0, seedSample, { maxFrac, minKeep, accept, total });
}

// Borders a label raster's subject touches: any of `ids` within `band` px of
// a border, on at least `minShare` of that border's length (a stray speck on
// the border is not a cut body).
export function touchedEdges(raw, width, height, ids, { band = 2, minShare = 0.01 } = {}) {
  return edgeStats(raw, width, height, ids, { band, minShare }).edges;
}

// touchedEdges plus what the loop-11 run check needs: per border, the share
// of the subject's extent along it that the border cuts (rows for L/R,
// columns for T/B, over the subject's bounding box), and the subject's
// centroid and area as frame fractions.
export function edgeStats(raw, width, height, ids, { band = 2, minShare = 0.01 } = {}) {
  const lut = new Uint8Array(256); // label rasters are 8-bit
  for (const id of ids) if (id >= 0 && id < 256) lut[id] = 1;
  const want = { has: (v) => lut[v] === 1 };
  let x0 = width, x1 = -1, y0 = height, y1 = -1, sx = 0, sy = 0, area = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!want.has(raw[y * width + x])) continue;
      area += 1; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const count = (bx0, bx1, by0, by1) => {
    let c = 0;
    for (let y = by0; y < by1; y += 1) for (let x = bx0; x < bx1; x += 1) if (want.has(raw[y * width + x])) c += 1;
    return c;
  };
  const lines = (bx0, bx1, by0, by1, alongX) => { // rows (or columns) of the band holding the subject
    let c = 0;
    if (alongX) { for (let x = bx0; x < bx1; x += 1) { for (let y = by0; y < by1; y += 1) if (want.has(raw[y * width + x])) { c += 1; break; } } }
    else { for (let y = by0; y < by1; y += 1) { for (let x = bx0; x < bx1; x += 1) if (want.has(raw[y * width + x])) { c += 1; break; } } }
    return c;
  };
  const bw = Math.max(1, x1 - x0 + 1), bh = Math.max(1, y1 - y0 + 1);
  let edges = "";
  const rel = {};
  if (area) {
    if (count(0, band, 0, height) >= Math.max(1, minShare * height)) { edges += "L"; rel.L = lines(0, band, 0, height, false) / bh; }
    if (count(width - band, width, 0, height) >= Math.max(1, minShare * height)) { edges += "R"; rel.R = lines(width - band, width, 0, height, false) / bh; }
    if (count(0, width, 0, band) >= Math.max(1, minShare * width)) { edges += "T"; rel.T = lines(0, width, 0, band, true) / bw; }
    if (count(0, width, height - band, height) >= Math.max(1, minShare * width)) { edges += "B"; rel.B = lines(0, width, height - band, height, true) / bw; }
  }
  return { edges, rel, cx: area ? sx / area / width : 0.5, cy: area ? sy / area / height : 0.5, area: area / (width * height) };
}

// Scene-transition ends (loop 11): a clip cut from a compilation can open
// or close on a cross-dissolve, where the tracked subject reads see-through
// (two shots laid over each other). `scores` maps sample -> transition.py
// score (null = not judged); leading/trailing runs at or above `threshold`
// are dropped under the same bounds as the edge trim.
export const TRANSITION_THRESHOLD = 0.015;
export function trimTransitionRuns(present, scores, seedSample, { threshold = TRANSITION_THRESHOLD, maxFrac = EDGE_TRIM_MAX_FRAC, minKeep = 6 } = {}) {
  const get = (s) => {
    const v = scores instanceof Map ? scores.get(s) : scores?.[s] ?? scores?.[String(s)];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return trimEndRuns(present, (s) => (get(s) ?? -Infinity) >= threshold, seedSample, { maxFrac, minKeep });
}
