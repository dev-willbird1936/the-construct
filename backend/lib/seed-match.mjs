// Advanced selected-identity matcher (backend/lib/seed-match.mjs).
//
// Pure geometry + clock helper. Zero dependencies, no network, no credentials,
// no SAM calls. Carries the server-trusted selection snapshot (normalized
// boxes + seed time) to the tracker's video track ids WITHOUT ever trusting
// numeric ids across namespaces (detect image ids reshuffle; video track ids
// are a different namespace entirely).
//
// IoU contract values match the Basic pipeline's pure helper
// (backend/pipeline/basic/lib/keyframes.mjs): WINDOW=3, MIN_IOU=0.15,
// AMBIGUITY_EPS=0.05. Deliberately NOT shared by import: the worker must not
// depend on the Basic pipeline, and this file must stay credential-free.
// NOTE (crossing risk): this matcher prefers the nearest temporal evidence
// with a unique qualifying overlap; Basic's max-over-window copy can let a
// crossing instance at a later sample outrank the exact-time match. Left
// unchanged for now — see final report; align only via this module with
// Basic's full contract/tests intact.

export const SAMPLE_FPS = 15; // tracker sampling rate (backend/lib/track.js)
export const SEED_BOX_WINDOW = 3;
export const SEED_BOX_MIN_IOU = 0.15;
export const SEED_BOX_AMBIGUITY_EPS = 0.05;
// Past the window (a pick at a frame the concept pass has not masked yet,
// e.g. the picker's default 0:00), a match must overlap the pick this much.
export const SEED_BOX_REACH_MIN_IOU = 0.3;
// A selected track this short cannot carry shells through the reshell;
// refuse before the expensive Python bake instead of baking a stub.
export const MIN_SELECTED_FRAMES = 6;

// User-safe refusal lines. Shipped to users only by the server
// (backend/app/routes.js FAIL_TEXT); the worker maps errors to reason codes.
export const ADV_STALE_TEXT =
  "The selected object expired. Re-pick the object to build.";
export const ADV_NO_MATCH_TEXT =
  "Could not match the selected object in the video. Re-pick the object and try again.";
export const ADV_AMBIGUOUS_TEXT =
  "The selected object matched two subjects ambiguously. Re-pick a clearer frame and try again.";
export const ADV_MULTI_CONCEPT_TEXT =
  "Advanced builds one selected subject for now. Pick a single object, or build each subject separately.";
export const ADV_CROP_UNSUPPORTED_TEXT =
  "The selected object cannot be placed after the clip was trimmed. Re-pick the object and try again.";

/** Worker fail reason codes for selection refusals (fail fast, no retry). */
export const ADV_CODE_STALE = "seed_stale";
export const ADV_CODE_NO_MATCH = "seed_no_match";
export const ADV_CODE_AMBIGUOUS = "seed_ambiguous";
export const ADV_CODE_MULTI = "multi_object";

/** Map a selection error to its worker fail reason code (else "internal"). */
export function codeForSelectionError(error) {
  const message = String(error?.message ?? error ?? "");
  if (message.startsWith(ADV_AMBIGUOUS_TEXT)) return ADV_CODE_AMBIGUOUS;
  if (message.startsWith(ADV_NO_MATCH_TEXT)) return ADV_CODE_NO_MATCH;
  if (message === ADV_MULTI_CONCEPT_TEXT) return ADV_CODE_MULTI;
  if (message === ADV_STALE_TEXT || message === ADV_CROP_UNSUPPORTED_TEXT) return ADV_CODE_STALE;
  return "internal";
}

/** Upload-frame index for a time (mirrors detect-cache frameIndexFor). */
export function frameIndexFor(time, fps, frames) {
  if (!(fps > 0) || !(frames > 0)) throw new Error(ADV_STALE_TEXT);
  return Math.max(0, Math.min(Math.round(Number(time) * fps), frames - 1));
}

/** Global tracker sample index nearest a seed time (tracker runs at 15 fps). */
export function seedSampleFor(seedTime, sampleFps = SAMPLE_FPS) {
  const s = Math.round(Number(seedTime) * sampleFps);
  if (!Number.isInteger(s) || s < 0) throw new Error(ADV_STALE_TEXT);
  return s;
}

function checkBox(box) {
  if (!box) return false;
  const { left, top, right, bottom } = box;
  if (![left, top, right, bottom].every(Number.isFinite)) return false;
  return left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top;
}

/**
 * Remap a snapshot box (normalized in FULL-source space) into cropped space.
 * crop is {x,y,w,h} in source pixels (black-bar trim), or null when no crop.
 * Returns the box normalized in cropped space. Throws an explicit refusal
 * when the box falls outside the kept region — never silently clamps.
 */
export function remapBoxForCrop(box, srcW, srcH, crop) {
  if (!checkBox(box)) throw new Error(ADV_STALE_TEXT);
  if (!crop) return { ...box };
  const { x, y, w, h } = crop;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    throw new Error(ADV_CROP_UNSUPPORTED_TEXT);
  }
  const L = (box.left * srcW - x) / w;
  const T = (box.top * srcH - y) / h;
  const R = (box.right * srcW - x) / w;
  const B = (box.bottom * srcH - y) / h;
  const out = { left: L, top: T, right: R, bottom: B };
  if (!checkBox(out)) throw new Error(ADV_CROP_UNSUPPORTED_TEXT);
  return out;
}

/** IoU of two boxes in the SAME normalized space. */
export function boxIoU(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return 0;
  const inter = (right - left) * (bottom - top);
  const areaA = (a.right - a.left) * (a.bottom - a.top);
  const areaB = (b.right - b.left) * (b.bottom - b.top);
  if (!(areaA > 0) || !(areaB > 0)) return 0;
  return inter / (areaA + areaB - inter);
}

/**
 * Tight normalized bbox of one track id in an 8-bit label raster.
 * pixels: Uint8Array-like of label ids, length width*height. Same inclusive
 * convention as the Basic pipeline (right edge is (x1+1)/w, clamped to 1).
 * Returns null when the track has no pixels (absent sample).
 */
export function boxForTrackId(pixels, width, height, trackId) {
  if (!pixels || !(width > 0) || !(height > 0)) return null;
  const id = Number(trackId);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (pixels[row + x] !== id) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return {
    left: x0 / width,
    top: y0 / height,
    right: Math.min(1, (x1 + 1) / width),
    bottom: Math.min(1, (y1 + 1) / height),
  };
}

/**
 * Resolve the video track matching one seed box (never longest fallback).
 * tracks: [{id, first, last, frames}] in tracker sample units.
 * getBox(trackId, sample) -> normalized box or null (label-raster reader).
 * Prefers the nearest temporal evidence with a unique qualifying overlap: a
 * different instance crossing the clicked position later must not outrank a
 * unique exact-time match.
 * reach (default: window) searches on past the window, nearest ring first;
 * a match there needs IoU >= reachMinIoU. Ties still refuse.
 */
export function matchSeedBox(
  tracks,
  {
    seedBox, seedSample, getBox, window = SEED_BOX_WINDOW, minIoU = SEED_BOX_MIN_IOU, ambiguityEps = SEED_BOX_AMBIGUITY_EPS,
    reach = window, reachMinIoU = SEED_BOX_REACH_MIN_IOU,
  } = {},
) {
  if (!tracks?.length) throw new Error(ADV_NO_MATCH_TEXT);
  if (!checkBox(seedBox) || typeof getBox !== "function" || !Number.isInteger(seedSample)) {
    throw new Error(ADV_NO_MATCH_TEXT);
  }
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
    if (!top || !(top.best > 0) || top.best < need) continue;
    const second = ranked[1];
    if (second && top.best - second.best < ambiguityEps) {
      throw new Error(
        `${ADV_AMBIGUOUS_TEXT} (top IoUs ${top.best.toFixed(3)} vs ${second.best.toFixed(3)})`,
      );
    }
    return top.track;
  }
  throw new Error(ADV_NO_MATCH_TEXT);
}

// Preflight is separate from matching: no tracks exist before SAM spend.
// required=true when ids were clicked: a null snapshot is then stale, never
// legacy automatic (old automatic rows carry no ids).
export function validateAdvancedSnapshot(snapshot, { seedTime = 0, required = false } = {}) {
  if (snapshot == null) {
    if (required) throw new Error(ADV_STALE_TEXT);
    return { mode: "automatic", trackIds: null };
  }
  // Box selection (Basic-shared v2 snapshot): exactly one normalized box,
  // fixed concept. Accepted for tiers the route allows through (Basic and,
  // behind the worker flag, Advanced); the route still decides the tier.
  if (snapshot.version === 2) {
    if (!Array.isArray(snapshot.objects) || snapshot.objects.length !== 1 ||
        !checkBox(snapshot.objects[0]?.box)) {
      throw new Error(ADV_STALE_TEXT);
    }
    const time = snapshot.seedTime ?? seedTime;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) throw new Error(ADV_STALE_TEXT);
    return { mode: "selected", concept: "selected object", seedBox: snapshot.objects[0].box, seedSample: seedSampleFor(time) };
  }
  if (
    !snapshot || snapshot.version !== 1 ||
    !Array.isArray(snapshot.objects) || !snapshot.objects.length || snapshot.objects.length > 3
  ) {
    throw new Error(ADV_STALE_TEXT);
  }
  for (const o of snapshot.objects) {
    if (!o || typeof o.label !== "string" || !o.label.trim() || !checkBox(o.box)) {
      throw new Error(ADV_STALE_TEXT);
    }
  }
  const labels = [...new Set(snapshot.objects.map((o) => o.label))];
  if (labels.length > 1) throw new Error(ADV_MULTI_CONCEPT_TEXT);
  const time = snapshot.seedTime ?? seedTime;
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) throw new Error(ADV_STALE_TEXT);
  return { mode: "selected", concept: labels[0], seedSample: seedSampleFor(time) };
}

/**
 * Resolve a persisted selection snapshot to video track ids (post-track).
 * Never resolves snapshot numeric ids against track ids (unrelated
 * namespaces). Distinct selections resolving to the same track refuse
 * ambiguous (no silent dedupe). Same-label multi (up to 3) resolves each box
 * against the single concept pass — zero extra SAM.
 * This helper never mutates tracks or label rasters: plate/live-video stages
 * keep ALL labels; only the returned id list scopes shell emission.
 */
export function resolveAdvancedSelection({
  snapshot,
  tracks,
  getBox,
  seedTime = 0,
  crop = null,
  srcW = 0,
  srcH = 0,
  required = false,
  reach = undefined,
}) {
  const preflight = validateAdvancedSnapshot(snapshot, { seedTime, required });
  if (preflight.mode === "automatic") return preflight;
  const { seedSample } = preflight;
  const trackIds = [];
  for (const sel of snapshot.objects) {
    const seedBox =
      crop || srcW > 0 ? remapBoxForCrop(sel.box, srcW || 1, srcH || 1, crop) : { ...sel.box };
    const track = matchSeedBox(tracks, { seedBox, seedSample, getBox, reach });
    if (trackIds.includes(track.id)) throw new Error(ADV_AMBIGUOUS_TEXT);
    trackIds.push(track.id);
  }
  return { ...preflight, trackIds };
}

/**
 * Post-track world step: resolve selection to ids AND gate on track length
 * before the expensive Python reshell (a selected track too short to carry
 * shells refuses here, never bakes a stub). Automatic passthrough returns
 * {mode:'automatic', trackIds:null} without touching getBox (no raster reads
 * for legacy jobs).
 */
export function resolveWorldSelection({
  snapshot,
  tracks,
  getBox,
  seedTime = 0,
  crop = null,
  srcW = 0,
  srcH = 0,
  required = false,
  minFrames = MIN_SELECTED_FRAMES,
  reach = undefined,
}) {
  const selection = resolveAdvancedSelection({
    snapshot, tracks, getBox, seedTime, crop, srcW, srcH, required, reach,
  });
  if (selection.mode === "automatic") return selection;
  const byId = new Map((tracks || []).map((t) => [Number(t?.id), t]));
  const matched = selection.trackIds.map((id) => byId.get(Number(id))).filter(Boolean);
  if (!matched.length || !matched.some((t) => Number(t.frames) >= minFrames)) {
    throw new Error(ADV_NO_MATCH_TEXT);
  }
  return selection;
}

/**
 * Scope shell emission to selected tracks. shells entries carry .track.
 * Pure: returns a new array, never touches the label rasters.
 */
export function filterShellsByTracks(shells, trackIds) {
  if (!Array.isArray(shells)) return [];
  if (!trackIds) return shells.slice(); // automatic legacy: everything
  const keep = new Set(trackIds);
  return shells.filter((s) => keep.has(s?.track));
}

/**
 * argv for make-world.py. Legacy invocation is byte-identical when no
 * selection is active; selected jobs append the explicit --select-tracks
 * flag (preferred over a positional, which would need an empty webclip).
 */
export function worldScriptArgs({ workDir, videoPath, name, webClip, selectedTrackIds = null }) {
  const args = [workDir, videoPath, name, webClip];
  if (selectedTrackIds) args.push("--select-tracks", [...selectedTrackIds].join(","));
  return args;
}
