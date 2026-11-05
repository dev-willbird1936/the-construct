import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { trackEdges } from "./edges.js";
import { SAMPLE_FPS, trackInstances } from "./track.js";
import { resolveWorldSelection, seedSampleFor, SEED_BOX_WINDOW, boxForTrackId } from "./seed-match.mjs";
import * as seedMatch from "./seed-match.mjs";
import { enhanceAvailable, enhanceClip, reconstructWorld } from "./reconstruct.js";
import { transcodeForWeb } from "./ffmpeg.js";

const run = promisify(execFile);
const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");
const PYTHON = process.env.DA3_PYTHON || "python";

// Longer than this is sampled from the start only: SAM is billed by the frame.
export const MAX_WORLD_SECONDS = 120;
// A world covers at most this many seconds of its clip, taken round the pick. Tracking, mask repair and the
// live paint-out all grow with length: a 60 s clip of a wolf pack measured past the 25 min job limit, and 30 s
// of a small, sharpened clip with its edge strips comes to about 18 min.
export const WORLD_WINDOW_SECONDS = 30;

/**
 * The [start, end] seconds a world is built from: the steady shot (`span`, or the whole clip), narrowed to
 * `max` seconds round the pick moment (`seed`, when it lies in the shot), or the shot's opening when nothing
 * was picked. Returns `span` itself when no narrowing is needed (null: the whole clip).
 */
export function worldSpan(span, duration, seed, picked, max = WORLD_WINDOW_SECONDS) {
  const [t0, t1] = span ?? [0, duration];
  if (!(Number.isFinite(t0) && Number.isFinite(t1)) || !(t1 - t0 > max + 0.5)) return span;
  const centre = picked && Number.isFinite(seed) && seed >= t0 && seed <= t1 ? seed : t0 + max / 2;
  const start = Math.min(Math.max(centre - max / 2, t0), t1 - max);
  return [start, start + max];
}
const SAM_LONG = 1280;     // px on the long side the animals are tracked at
const MAX_ENLARGE = 3;
const SMALL_LONG = 800;    // a clip smaller than this on its long side is sharpened 2x first

const GROUP_INSIDE = 0.6;  // share of an animal's box inside a picked box that makes it part of that pick

// The detector sometimes names a group ("wolf pack", "white wolf pack", "herd of deer"). Asked for that,
// SAM returns the group as one animal: one shell spanning the whole pack at one depth, and no edge pass.
// Tracking asks for the animal instead; a pick drawn round the group then takes the animals inside it.
const GROUPS = "pack|herd|flock|group|family|pair|couple|pod|colony|troop|pride|litter|brood|gaggle|band|bunch|crowd|swarm|school";
const OF_GROUP = new RegExp(`^(?:an?\\s+|the\\s+)?(?:${GROUPS})\\s+of\\s+(.+)$`, "i");
const GROUP_OF = new RegExp(`^(.+?)\\s+(?:${GROUPS})$`, "i");
const ONLY_GROUP = new RegExp(`^(?:${GROUPS})$`, "i");

/** the concept SAM is asked to track: a group's name becomes its animal ("white wolf pack" -> "white wolf") */
export function individualConcept(concept) {
  const parts = String(concept ?? "").split(",").map((part) => {
    const text = part.trim();
    const m = text.match(OF_GROUP) || text.match(GROUP_OF);
    if (m && m[1].trim()) return m[1].trim();
    return ONLY_GROUP.test(text) ? "animal" : text;
  }).filter(Boolean);
  return [...new Set(parts)].join(", ") || String(concept ?? "");
}

/**
 * A picked box that singles out no one tracked animal: drawn round a group (the detector's "wolf pack",
 * "herd"), so it overlaps each animal too little to match one, or round two animals equally. It picks every
 * tracked animal (long enough to carry shells) whose box lies mostly inside it near the pick moment.
 * Returns { mode: "selected", trackIds } or null when no animal qualifies (the refusal then stands).
 */
export function groupSelection({ snapshot, tracks, getBox, seedSample, crop = null, srcW = 0, srcH = 0, window = SEED_BOX_WINDOW }) {
  const ids = new Set();
  const minFrames = seedMatch.MIN_SELECTED_FRAMES ?? 6;
  for (const sel of snapshot?.objects ?? []) {
    let pick;
    try {
      pick = crop || srcW > 0 ? seedMatch.remapBoxForCrop(sel.box, srcW || 1, srcH || 1, crop) : { ...sel.box };
    } catch {
      continue;
    }
    for (const t of tracks ?? []) {
      if (!(Number(t?.frames) >= minFrames)) continue;
      for (let s = seedSample - window; s <= seedSample + window; s += 1) {
        const b = s >= 0 ? getBox(t.id, s) : null;
        if (!b) continue;
        const area = (b.right - b.left) * (b.bottom - b.top);
        const iw = Math.max(0, Math.min(b.right, pick.right) - Math.max(b.left, pick.left));
        const ih = Math.max(0, Math.min(b.bottom, pick.bottom) - Math.max(b.top, pick.top));
        if (area > 0 && (iw * ih) / area >= GROUP_INSIDE) { ids.add(Number(t.id)); break; }
      }
    }
  }
  return ids.size ? { mode: "selected", trackIds: [...ids].sort((a, b) => a - b) } : null;
}

/** true when a detector's label names a group ("wolf pack", "herd of deer"), not one animal */
export function isGroupName(label) {
  const text = String(label ?? "").trim();
  return Boolean(text) && (OF_GROUP.test(text) || GROUP_OF.test(text) || ONLY_GROUP.test(text));
}

/**
 * The tracked animals a pick stands for. A pick the detector named as a group ("white wolf pack") is read as
 * the group first: the animals inside its box, not the one wolf that happens to overlap it best. Any other
 * pick is matched animal by animal, and a pick that singles out no one animal, or two equally, is read as a
 * group before refusing: the customer gets the animals inside the box they drew, not "re-pick and try again".
 * Returns { selection, note } (note: what was read differently, for the log, or null), and group: true when the
 * pick was read as a group: make-world then lifts only the members mostly in view (world_masks.in_view).
 */
export function chooseSelection({ snapshot, tracks, getBox, seedTime = 0, seedSample, crop = null, srcW = 0, srcH = 0, required = false, resolve = resolveWorldSelection, reach = undefined }) {
  const picks = snapshot?.objects ?? [];
  const args = { snapshot, tracks, getBox, seedSample, crop, srcW, srcH };
  if (picks.length && picks.every((o) => isGroupName(o?.label))) {
    const group = groupSelection(args);
    if (group) return { selection: group, group: true, note: `the pick names a group ("${picks[0].label}"); taking the ${group.trackIds.length} animals inside it` };
  }
  try {
    return { selection: resolve({ snapshot, tracks, getBox, seedTime, crop, srcW, srcH, required, ...(reach === undefined ? {} : { reach }) }), note: null };
  } catch (error) {
    const message = String(error?.message ?? "");
    const unmatched = [seedMatch.ADV_NO_MATCH_TEXT, seedMatch.ADV_AMBIGUOUS_TEXT].some((text) => text && message.startsWith(text));
    const group = unmatched ? groupSelection(args) : null;
    if (!group) throw error;
    return { selection: group, group: true, note: `the pick singles out no one animal; taking the ${group.trackIds.length} inside it (${message.slice(0, 80)})` };
  }
}

/** { fixed, shift, overlay, ... } from probe-clip.py; null when it could not look */
export async function probeClip(videoPath) {
  try {
    const { stdout } = await run(PYTHON, ["-I", path.join(TOOLS, "probe-clip.py"), videoPath], { maxBuffer: 1 << 20 });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } catch (error) {
    console.warn("probe-clip failed:", error.message.slice(0, 200));
    return null;
  }
}

/**
 * [start, end] seconds worth rebuilding when the probe found the clip opening or closing on another scene
 * (probe.shot); null when the whole clip is one shot or the span is not believable
 */
export function shotSpan(probe, duration) {
  const s = probe?.shot;
  if (!Array.isArray(s) || s.length !== 2 || !s.every(Number.isFinite)) return null;
  const [t0, t1] = s;
  if (!(t0 >= 0 && t1 > t0 && t1 - t0 >= 2)) return null;
  if (Number.isFinite(duration) && (t0 >= duration || (t0 < 0.05 && t1 > duration - 0.05))) return null;
  return [t0, Number.isFinite(duration) ? Math.min(t1, duration) : t1];
}

/** Registers a bumped clip to its first frame; resolves with the path to build from (the input if nothing moved) */
export async function stabilizeClip(videoPath, outPath, overlay) {
  const { stdout } = await run(PYTHON, ["-I", path.join(TOOLS, "stabilize.py"), videoPath, outPath, String(overlay ?? 1)], { maxBuffer: 1 << 20 });
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  return result.moved ? outPath : videoPath;
}

/**
 * A fixed-camera clip, any number of animals, any length (up to MAX_WORLD_SECONDS): SAM tracks every
 * instance in overlapping chunks, then make-world.py rebuilds the scene around them. One pass, no
 * per-clip corrections. Returns the viewer URL.
 */
const pad5 = (n) => String(n).padStart(5, "0");

export async function buildWorld({ build, job, concept: asked, probe, name, clipPath, site, sampleFps, live, lite = false, stopAfter, moving = false }) {
  const concept = individualConcept(asked);
  if (concept !== asked) console.warn(`concept: tracking "${concept}" for "${asked}" (a group's name tracks as one animal)`);
  // Original source dimensions BEFORE crop/enhance mutate job: the snapshot
  // seed box is normalized in this space, so the crop remap must use it.
  const srcW = job.width, srcH = job.height;
  let crop = null;
  const workDir = path.join(job.jobDir, "world");
  // the moment the visitor picked their animal at must be in the kept shot (a dissolve's second aside is
  // fine: the animal is the same one); otherwise the whole clip is the span, narrowed below like any other
  const picked = job.selectionSnapshot != null || job.requireSelection;
  const seed = Number(job.selectionSnapshot?.seedTime ?? job.seedTime ?? 0);
  const steady = shotSpan(probe, job.duration);
  const keep = steady && (!picked || (seed >= steady[0] - 1 && seed <= steady[1] + 1)) ? steady : null;
  // a long clip is narrowed to the seconds round the pick, on the same path as the shot trim
  const span = worldSpan(keep, job.duration, seed, picked);
  if (span && !lite && stopAfter == null && !moving) {
    // a compilation clip that cuts to, or dissolves from, another camera: that footage is not this scene.
    // Rebuilt on this scene's ground it plays as a wrong world, and the plate's median takes its colours
    // wherever an animal stood still (the moose's green ghost, Nov 2026)
    Object.assign(build, { stage: "stabilizing", detail: span !== keep ? `Keeping ${Math.round(span[1] - span[0])} seconds ${picked ? "round your pick" : "from the start"}…` : "Keeping the clip's one steady shot…" });
    await mkdir(workDir, { recursive: true });
    const shot = path.join(workDir, "shot.mp4");
    const [t0, t1] = span;
    await run("ffmpeg", ["-y", "-v", "error", "-ss", t0.toFixed(3), "-i", job.videoPath, "-t", (t1 - t0).toFixed(3), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-an", shot]);
    const info = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", shot])
      .then(({ stdout }) => ({ duration: Number(JSON.parse(stdout).format?.duration) || 0 })).catch(() => null);
    if (info?.duration > 0) {
      const into = (t) => (typeof t === "number" && Number.isFinite(t) ? Math.min(Math.max(t - t0, 0), info.duration) : t);
      const snapshot = job.selectionSnapshot;
      job = {
        ...job, videoPath: shot, duration: info.duration, seedTime: into(job.seedTime ?? 0),
        selectionSnapshot: snapshot && typeof snapshot === "object" && "seedTime" in snapshot ? { ...snapshot, seedTime: into(snapshot.seedTime) } : snapshot,
      };
    }
  }
  if (probe?.crop) {
    // black bars (a phone-shaped clip on a landscape canvas) are not scene: cut them before anything looks
    Object.assign(build, { stage: "stabilizing", detail: "Trimming the black bars…" });
    await mkdir(workDir, { recursive: true });
    const [x, y, w, h] = probe.crop;
    crop = { x, y, w, h };
    const trimmed = path.join(workDir, "cropped.mp4");
    await run("ffmpeg", ["-y", "-v", "error", "-i", job.videoPath, "-vf", `crop=${w}:${h}:${x}:${y}`, "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-an", trimmed]);
    job = { ...job, videoPath: trimmed, width: w, height: h };
  }
  if (!lite && Math.max(job.width, job.height) < SMALL_LONG && enhanceAvailable()) {
    // a phone-sized clip: SAM, depth and every texture get twice the pixels (a failure just leaves the clip as it is)
    Object.assign(build, { stage: "stabilizing", detail: "Sharpening the clip…" });
    await mkdir(workDir, { recursive: true });
    const enhanced = path.join(workDir, "enhanced.mp4");
    try {
      await enhanceClip(job.videoPath, enhanced);
      job = { ...job, videoPath: enhanced, width: job.width * 2, height: job.height * 2 };
    } catch (error) { console.warn(error.message); }
  }
  if (!probe?.fixed && probe?.stabilizable) {
    Object.assign(build, { stage: "stabilizing", detail: "Holding the camera still…" });
    await mkdir(workDir, { recursive: true });
    job = { ...job, videoPath: await stabilizeClip(job.videoPath, path.join(workDir, "stabilized.mp4"), probe.overlay) };
  }
  // SAM sees small animals far better in a larger picture (a pack of wolves in a 360 x 640 phone clip
  // came back as blobs; enlarged to 720 x 1280 the same masks followed legs and fur). So a clip is
  // brought to SAM_LONG on its long side: shrunk when bigger, enlarged (up to 3x) when smaller.
  const scale = Math.min(MAX_ENLARGE, SAM_LONG / Math.max(job.width, job.height));
  const width = Math.round((job.width * scale) / 2) * 2;
  const height = Math.round((job.height * scale) / 2) * 2;
  Object.assign(build, { stage: "tracking", detail: "Following your subject…" });
  await live?.beforeTrack({ videoPath: job.videoPath, width, height, fps: sampleFps ?? SAMPLE_FPS, seconds: Math.min(job.duration, MAX_WORLD_SECONDS), workDir });
  const tracked = await trackInstances({
    videoPath: job.videoPath, concept, outDir: workDir, width, height,
    duration: job.duration, seconds: Math.min(job.duration, MAX_WORLD_SECONDS),
    sampleFps, onFrame: live?.onFrame, signal: live?.signal,
    onStage: (detail) => { build.detail = detail; live?.detail(detail); },
  });
  // a clip of small animals gets a second look along its side edges, where SAM misses most
  const seconds = Math.min(job.duration, MAX_WORLD_SECONDS);
  await trackEdges({ videoPath: job.videoPath, concept, outDir: workDir, tracked, seconds, onStage: (detail) => { build.detail = detail; } });
  await live?.afterTrack(tracked);
  if (!tracked.tracks.some((t) => t.frames >= 6)) {
    throw new Error(`Couldn't follow any "${concept}" through this clip. Try "choose the object myself".`);
  }
  // Selected identity (post-track): match the trusted snapshot to video
  // track ids by box overlap near the seed sample. Automatic jobs skip this
  // without reading rasters. Refusals throw before the expensive bake.
  // Edge strips may add tracks after the in-memory result, so re-read the
  // file the Python builder reads — never filter or delete label rasters.
  let selectedTrackIds = null;
  let groupPick = false;
  if (job.selectionSnapshot != null || job.requireSelection) {
    const seedSample = seedSampleFor(job.seedTime ?? 0, tracked.fps);
    const boxCache = new Map(); // sample -> Map(trackId -> normalized box)
    const readBoxes = async (s) => {
      const perId = new Map();
      try {
        const { data, info } = await sharp(path.join(workDir, "labels", `l${pad5(s)}.png`)).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
        const seen = new Set();
        for (let p = 0; p < data.length; p += 1) if (data[p]) seen.add(data[p]);
        for (const id of seen) {
          const box = boxForTrackId(data, info.width, info.height, id);
          if (box) perId.set(Number(id), box);
        }
      } catch {
        // missing/unreadable raster in the window: treated as absent
      }
      return perId;
    };
    for (let s = seedSample - SEED_BOX_WINDOW; s <= seedSample + SEED_BOX_WINDOW; s += 1) {
      if (s < 0) continue;
      boxCache.set(s, await readBoxes(s));
    }
    const getBox = (trackId, sample) => boxCache.get(sample)?.get(Number(trackId)) ?? null;
    const allTracks = JSON.parse(await fsp.readFile(path.join(workDir, "tracks.json"), "utf8")).tracks;
    const choose = (reach) => chooseSelection({
      snapshot: job.selectionSnapshot, tracks: allTracks, getBox, seedTime: job.seedTime ?? 0, seedSample,
      crop, srcW, srcH, required: Boolean(job.requireSelection), reach,
    });
    let chosen;
    try {
      chosen = choose(undefined);
    } catch (error) {
      // A pick at a frame the concept pass has not masked yet (the picker's default 0:00: slovakdeer's deer is
      // masked only from ~1.8 s) matches nothing in the window. Read the pass's other samples and match nearest
      // first (IoU 0.3 past the window, ties still refuse) instead of failing. Never on an ambiguity.
      if (!String(error?.message ?? "").startsWith(seedMatch.ADV_NO_MATCH_TEXT)) throw error;
      const ends = allTracks.flatMap((t) => [Number(t?.first), Number(t?.last)]).filter(Number.isInteger);
      if (!ends.length) throw error;
      const lo = Math.max(0, Math.min(...ends));
      const hi = Math.max(...ends);
      for (let s = lo; s <= hi; s += 1) if (!boxCache.has(s)) boxCache.set(s, await readBoxes(s));
      chosen = choose(hi + Math.abs(seedSample) + SEED_BOX_WINDOW); // covers every read sample from the matcher's seed
      console.warn(`selection: nothing tracked within ${SEED_BOX_WINDOW} samples of the pick; matched at the pass's nearest masked samples`);
    }
    const { selection, note, group } = chosen;
    if (note) console.warn(`selection: ${note}`);
    if (selection.mode === "selected") {
      selectedTrackIds = selection.trackIds;
      groupPick = Boolean(group);
      Object.assign(build, { detail: "Following your selected subject…" });
      await live?.selection(selectedTrackIds, allTracks);
    }
  }
  if (lite) return null;
  Object.assign(build, { stage: "solving", detail: "Waiting for the GPU…" });
  const webClip = stopAfter === "cloud" || moving ? job.videoPath : await transcodeForWeb(job.videoPath, path.join(clipPath, `${name}.mp4`));
  await reconstructWorld({
    workDir, videoPath: job.videoPath, name,
    webClip: path.relative(site, webClip).split(path.sep).join("/"),
    selectedTrackIds, groupPick,
    // a little above the strip's measured edge: its anti-aliased rows, and a logo taller than the bar, are still the strip
    overlay: probe?.overlay < 1 ? probe.overlay - 0.01 : 1,
    onStage: (detail) => { build.detail = detail; },
    liveDir: live?.dir, onEvent: live?.onPython, stopAfter, moving, onChild: live?.onChild,
  });
  return `stable.html?clip=${name}`;
}
