import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { client } from "../lib/meta.js";
import { cancelledError, isCancelError, throwIfCancelled } from "../lib/cancel.js";
import { cutSegment, extractFrame, extractFrames } from "../lib/ffmpeg.js";
import { measureCamera } from "./camera.js";
import { generateVolume, MAX_TRACK_FRAMES } from "../lib/generate.js";
import { buildSamSegment, liteStride, requireLiteSeedSource, LITE_WHOLE_SOURCE_FRAMES, detectOsdBar, cropRows } from "../lib/lite-decode.js";
import { VIDEO_SEED_UNSUPPORTED } from "../lib/sam-video-seed.mjs";
import { packChronoAtlas, makeThumb, buildChronoBackdrop, finishPlate } from "./atlas.js";
import { runDetect, runBoxDetect, cachedDetect, frameIndexFor, parseSelectionSnapshot } from "./detect-cache.js";
import { SELECTION_STALE_TEXT } from "./errors.js";
import { classifyUpload } from "./spark.js";
import { recordUsage, recordSpend } from "./db.js";
import { CANDIDATE_CONCEPTS } from "../lib/vocab.js";

const execFileAsync = promisify(execFile); // one batch call per job (Lane B 2D composite)

// Lite ("Solid") runner: SAM 3.1 video tracking for 1-3 objects, then the
// compact atlas the tesseract cells read. One job runs at a time per
// process (shared with the Basic stub); jobs queue in the DB.

const SAM_MAX_WIDTH = 1280;

// Every Meta upload starts with a shutdown gate: no new billable-track
// bytes after stop. In-flight uploads are aborted via the SDK signal and
// surface as the cancellation error (never an outage to retry).
async function uploadToMeta(file, signal) {
  throwIfCancelled(signal);
  try {
    return await client.files.create(
      { purpose: "user_data", file: fs.createReadStream(file) },
      signal ? { signal } : undefined
    );
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw error;
  }
}

// Explicit seed: SAM time scales with the frames it is sent (~10 frames/s
// plus a ~2 s start, measured on sam-3.1), and the chronophotograph keeps a
// handful of poses, so a 30 fps clip is tracked at ~15 fps. The strided cut
// starts AT the seed frame, at the source size, and is proven frame-exact
// (buildSamSegment) before it is used; any doubt keeps the whole clip.
// A clip over 350 frames has no whole-clip fallback (the seed contract
// caps whole sources): it always tracks a proven cut, or is refused.
// Long windows (a 10 s walk) are thinned further so SAM never gets more
// than LITE_SAM_MAX_FRAMES: the row keeps <= 12 poses and a 10-frame tail.
// SAM time is ~2 s + ~0.08 s/frame, so the cut aims at LITE_SAM_TARGET_FRAMES
// (60: ~6.3 s instead of ~9.5 s for 90) as long as it keeps at least
// LITE_SAM_MIN_FPS; masks measured against the 15 fps cut: IoU 0.98,
// boundary F 0.96-0.97, same pose count (phase-2 experiment 2).
export const LITE_SAM_MAX_FRAMES = 120;
export const LITE_SAM_TARGET_FRAMES = 60;
export const LITE_SAM_MIN_FPS = 8;
export function samCutPlan(upload, frameIndex) {
  const window = Math.min(upload.frames - frameIndex, MAX_TRACK_FRAMES);
  const fpsCap = Number(upload.fps) > 0 ? Math.max(1, Math.floor(Number(upload.fps) / LITE_SAM_MIN_FPS)) : 1;
  const stride = Math.max(liteStride(upload.fps), Math.ceil(window / LITE_SAM_MAX_FRAMES),
    Math.min(Math.ceil(window / LITE_SAM_TARGET_FRAMES), fpsCap));
  const count = Math.ceil(window / stride);
  const long = upload.frames > LITE_WHOLE_SOURCE_FRAMES;
  return { stride, count, long, cut: (stride > 1 || long) && count >= 2 && count <= LITE_WHOLE_SOURCE_FRAMES };
}
async function selectedSamSource(upload, frameIndex, specDir, fileIdCache, signal) {
  // Started while the visitor was still choosing (POST /api/lite/prewarm):
  // the same proven cut, already on Meta. Any failure builds it here.
  const warm = takePrewarm(upload, frameIndex);
  if (warm) {
    const ready = await warm.catch(() => null);
    throwIfCancelled(signal);
    if (ready) {
      console.log(`[lite-prewarm] hit ${upload.id}:${frameIndex}`);
      return ready;
    }
  }
  const { stride, count, long, cut } = samCutPlan(upload, frameIndex);
  if (cut) {
    throwIfCancelled(signal);
    const outPath = path.join(specDir, "work", `sam_${frameIndex}_s${stride}.mp4`);
    const seg = await buildSamSegment(upload.path, { start: frameIndex, stride, count, outPath, signal }).catch((error) => {
      if (isCancelError(error) || signal?.aborted) throw cancelledError();
      console.error(`[lite] strided SAM segment failed: ${error?.message || error}`);
      return null;
    });
    if (seg?.ok) {
      const file = await uploadToMeta(seg.path, signal);
      return { fileId: file.id, samOffset: 0, samWidth: upload.width, samHeight: upload.height,
        samSegment: { start: frameIndex, stride, count } };
    }
    if (seg) console.error(`[lite] strided SAM segment refused (${seg.reason}); ${long ? "long clip refused" : "tracking the whole clip"}`);
  }
  if (long) throw new Error(VIDEO_SEED_UNSUPPORTED);
  return samSource(upload, frameIndex, fileIdCache, signal);
}

// <lite-prewarm>
// Early upload (Lite only): the site asks for this once the visitor has a
// detected frame on a Lite build, so the SAM source is cut and on Meta
// before they press Build. Meta Files uploads are free (capped by the
// files cap); an unused one is simply never referenced. Same plan and the
// same proof as the job's own cut; the local cut is deleted once uploaded.
export const PREWARM_TTL_MS = 15 * 60 * 1000;
const PREWARM_MAX = 64;
const prewarmed = new Map(); // "<uploadId>:<frameIndex>" -> { at, promise }
export function prewarmLiteSource({ upload: u, frameIndex, files = uploadToMeta, now = Date.now }) {
  const key = `${u.id}:${frameIndex}`;
  const t = now();
  for (const [k, v] of prewarmed) if (t - v.at >= PREWARM_TTL_MS) prewarmed.delete(k);
  const hit = prewarmed.get(key);
  if (hit) return hit.promise;
  while (prewarmed.size >= PREWARM_MAX) prewarmed.delete(prewarmed.keys().next().value);
  const promise = (async () => {
    const { stride, count, cut } = samCutPlan(u, frameIndex);
    if (!cut) {
      const file = await files(u.path);
      return { fileId: file.id, samOffset: 0, samWidth: u.width, samHeight: u.height };
    }
    const dir = path.join(path.dirname(u.path), "prewarm");
    const outPath = path.join(dir, `sam_${frameIndex}_s${stride}.mp4`);
    await fsp.mkdir(dir, { recursive: true });
    try {
      const seg = await buildSamSegment(u.path, { start: frameIndex, stride, count, outPath });
      if (!seg?.ok) throw new Error(`segment refused (${seg?.reason || "no segment"})`);
      const file = await files(outPath);
      return { fileId: file.id, samOffset: 0, samWidth: u.width, samHeight: u.height,
        samSegment: { start: frameIndex, stride, count } };
    } finally {
      await fsp.rm(outPath, { force: true }).catch(() => {});
    }
  })();
  promise.then(() => console.log(`[lite-prewarm] ready ${key} ms=${now() - t}`), (error) => {
    console.error(`[lite-prewarm] ${key}: ${error?.message || error}`);
    if (prewarmed.get(key)?.promise === promise) prewarmed.delete(key);
  });
  prewarmed.set(key, { at: t, promise });
  return promise;
}
function takePrewarm(upload, frameIndex) {
  const hit = prewarmed.get(`${upload.id}:${frameIndex}`);
  return hit && Date.now() - hit.at < PREWARM_TTL_MS ? hit.promise : null;
}
// </lite-prewarm>

// Same windowing as the legacy dev server: short clips go whole; longer
// clips send just a window after the seed, downscaled to <=1280 wide.
async function samSource(upload, frameIndex, fileIdCache, signal) {
  const scale = Math.min(1, SAM_MAX_WIDTH / upload.width);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const size = { samWidth: even(upload.width * scale), samHeight: even(upload.height * scale) };
  // Same shutdown-gated upload as uploadToMeta (kept inline: this function
  // is also exercised standalone by tests/lite/seeded-runner.test.mjs).
  const uploadFile = async (file) => {
    throwIfCancelled(signal);
    try {
      return await client.files.create(
        { purpose: "user_data", file: fs.createReadStream(file) },
        signal ? { signal } : undefined
      );
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      throw error;
    }
  };
  if (upload.frames <= MAX_TRACK_FRAMES + 30 && scale === 1) {
    if (!fileIdCache.has(upload.id)) {
      const created = await uploadFile(upload.path);
      fileIdCache.set(upload.id, created.id);
    }
    return { fileId: fileIdCache.get(upload.id), samOffset: 0, ...size };
  }
  const start = upload.frames > MAX_TRACK_FRAMES + 30 ? frameIndex : 0;
  const frames = upload.frames > MAX_TRACK_FRAMES + 30 ? MAX_TRACK_FRAMES + 10 : upload.frames;
  throwIfCancelled(signal);
  const segment = await cutSegment(
    upload.path, start / upload.fps, frames / upload.fps,
    path.join(path.dirname(upload.path), `seg_${start}.mp4`),
    { width: size.samWidth, height: size.samHeight }
  );
  const file = await uploadFile(segment);
  return { fileId: file.id, samOffset: start, ...size };
}

export function estimateSamFrames(upload, objectCount) {
  const window = upload.frames <= MAX_TRACK_FRAMES + 30 ? upload.frames : MAX_TRACK_FRAMES + 10;
  return window * Math.max(1, objectCount);
}

// <lite-composite>
// Lane B 2D composite (the Still). Single batch call per job, never in a
// per-frame loop: composite_lite.py decodes the frames it needs from the
// upload itself. It runs BESIDE the atlas pack and writes into work/still;
// the runner publishes the three files only once the pack has succeeded.
// Any failure skips the still and the job still succeeds (fail closed).
// Returns the atlas `composite` field, or null.
export async function runLiteComposite({ specDir, upload, allSlices, config, job, signal, compositeSignal, osdCut = null, exec = execFileAsync }) {
  const stillDir = path.join(specDir, "work", "still");
  try {
    throwIfCancelled(signal);
    await fsp.mkdir(stillDir, { recursive: true });
    await fsp.writeFile(path.join(specDir, "work", "composite-input.json"), JSON.stringify({
      fps: upload.fps, width: upload.width, height: upload.height,
      frames: allSlices.map((s) => ({ mask: s.file, image: null,
        sourceFrameIndex: s.sourceFrameIndex, timestamp: s.timestamp, concept: s.concept })),
    }));
    const pythonBin = process.env.BASIC_PYTHON || config?.pythonBin || "python3";
    await exec(pythonBin, ["-I", fileURLToPath(new URL("./composite_lite.py", import.meta.url)),
      "--specimen", stillDir, "--video", upload.path,
      "--frames-json", path.join(specDir, "work", "composite-input.json"),
      ...(osdCut > 0 ? ["--crop-bottom", String(osdCut)] : [])],
      { timeout: 600000, ...(compositeSignal ? { signal: compositeSignal } : {}) });
    const compositeMeta = JSON.parse(await fsp.readFile(path.join(stillDir, "composite.json"), "utf8"));
    if (compositeMeta && (compositeMeta.route === "chronophotograph" || compositeMeta.route === "filmstrip")
        && Number.isFinite(compositeMeta.subjectHeightFraction)) {
      return { file: "composite.png", route: compositeMeta.route,
        subjectHeightFraction: compositeMeta.subjectHeightFraction, kept: compositeMeta.keptFrames };
    }
    throw new Error("composite_lite wrote an invalid composite.json");
  } catch (error) {
    if (isCancelError(error) || signal?.aborted) throw cancelledError();
    if (compositeSignal?.aborted) return null; // the pack failed; nothing to publish
    console.error(`[lite-composite] skipped for job ${job.id}: ${error?.message || error}`);
    return null;
  }
}
// </lite-composite>

// <lite-plate>
// Registered stage plate (lite_plate.py): background samples aligned to the
// middle frame and medianed with the subject masked out, for EVERY camera
// (a pan or a handheld clip used to get a blurred grey card). One batch
// call beside the pack, never per frame. Returns {png, qa} or null; null
// (QA refusal, failure, or a failed pack) keeps the JS fallback plates.
// Only cancellation throws.
export async function runLitePlate({ specDir, upload, allSlices, config, job, signal, plateSignal, osdCut = null, exec = execFileAsync }) {
  const out = path.join(specDir, "work", "plate-registered.png");
  try {
    throwIfCancelled(signal);
    const input = path.join(specDir, "work", "plate-input.json");
    await fsp.writeFile(input, JSON.stringify({
      frames: allSlices.map((s) => ({ mask: s.file, sourceFrameIndex: s.sourceFrameIndex })),
    }));
    const pythonBin = process.env.BASIC_PYTHON || config?.pythonBin || "python3";
    const { stdout } = await exec(pythonBin, ["-I", fileURLToPath(new URL("./lite_plate.py", import.meta.url)),
      "--video", upload.path, "--frames-json", input, "--out", out,
      ...(osdCut > 0 ? ["--crop-bottom", String(osdCut)] : [])],
      { timeout: 120000, ...(plateSignal ? { signal: plateSignal } : {}) });
    const res = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
    if (!res || res.ok !== true) throw new Error(res?.reason || "no plate");
    return {
      png: await fsp.readFile(out),
      qa: { decision: "registered", unknownShare: res.unknownShare, mad: res.mad, samples: res.samples },
      // sideways travel in the scene (frame widths, camera motion removed)
      travel: Number.isFinite(Number(res.travel)) ? Number(res.travel) : null,
    };
  } catch (error) {
    if (isCancelError(error) || signal?.aborted) throw cancelledError();
    if (plateSignal?.aborted) return null; // the pack failed; nothing to stage
    const said = error?.stdout ? String(error.stdout).trim() : "";
    console.error(`[lite-plate] fallback for job ${job.id}: ${said || error?.message || error}`);
    return null;
  }
}
// </lite-plate>

// Row direction for the ghost trail: -1 when the subject clearly went left
// (more than TRAVEL_FLIP frame widths), else the usual left-to-right.
export const TRAVEL_FLIP = 0.05;
export function rowDir(travel, frameTravel = null) {
  const t = Number.isFinite(Number(travel)) && travel !== null ? Number(travel) : Number(frameTravel);
  return Number.isFinite(t) && t < -TRAVEL_FLIP ? -1 : 1;
}

// Move the finished still from work/still into the specimen (after the pack).
async function publishComposite(specDir) {
  for (const f of ["composite.png", "composite-portrait.png", "composite.json"]) {
    await fsp.rename(path.join(specDir, "work", "still", f), path.join(specDir, f));
  }
}

// Selected-object identity (Lite): an explicit click persists an immutable
// snapshot at enqueue (label + normalized bbox + seed frame). A refreshed
// detect reshuffles numeric ids after cache expiry, so the snapshot bbox is
// associated to the fresh detect by unique box overlap (threshold +
// ambiguity/no-match refusal), then the FRESH mask is used for
// generateVolume. No largest fallback for an explicit selection. Prompt-only
// jobs without clicked ids stay explicitly automatic.
export const LITE_SELECTION_STALE_TEXT = SELECTION_STALE_TEXT;
export const LITE_NO_MATCH_TEXT =
  "Could not match the selected object in a fresh detect. Re-pick the object and try again.";
export const LITE_AMBIGUOUS_TEXT =
  "The selected object matched two subjects ambiguously. Re-pick a clearer frame and try again.";
// Unique-overlap contract: normalized 0..1 boxes on the same seed frame.
export const LITE_MIN_IOU = 0.25;
export const LITE_AMBIGUITY_EPS = 0.05;

function liteBoxIoU(a, b) {
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

/**
 * Associate one snapshot box to a fresh detect object list (pure, unit-tested).
 * @param snapshotBox normalized {left,top,right,bottom} from the persisted snapshot
 * @param freshObjects result.objects list (normalized boxes, with id+label)
 * @returns the winning fresh object — throws on no-match/ambiguity
 */
export function associateSnapshotBox(snapshotBox, freshObjects, { minIoU = LITE_MIN_IOU, ambiguityEps = LITE_AMBIGUITY_EPS, expectedLabel } = {}) {
  if (expectedLabel !== undefined && (typeof expectedLabel !== "string" || !expectedLabel.trim())) throw new Error(LITE_NO_MATCH_TEXT);
  const candidates = (freshObjects || []).filter((o) => expectedLabel === undefined ||
    (typeof o?.label === "string" && o.label.trim().toLowerCase() === expectedLabel.trim().toLowerCase()));
  const scored = candidates.map((o) => ({ object: o, iou: liteBoxIoU(snapshotBox, o?.box) }));
  scored.sort((a, b) => b.iou - a.iou);
  const top = scored[0];
  if (!top || !(top.iou > 0) || top.iou < minIoU) {
    throw new Error(LITE_NO_MATCH_TEXT);
  }
  const second = scored[1];
  if (second && top.iou - second.iou < ambiguityEps) throw new Error(LITE_AMBIGUOUS_TEXT);
  return top.object;
}

// A generic detect label ("animal") makes a weak title ("animal lite")
// when Muse Spark has already named the creature in the clip ("deer",
// "small deer"). Only an animal name replaces a generic animal label; a
// specific label ("bear", "person") and a typed title are kept.
const GENERIC_ANIMAL = new Set(["animal", "creature", "mammal", "wildlife"]);
const ANIMAL_WORDS = new Set(["dog", "puppy", "cat", "kitten", "bird", "fish", "horse", "pony", "cow", "calf", "deer", "fawn",
  "elk", "moose", "elephant", "lion", "tiger", "bear", "cub", "rabbit", "hare", "fox", "wolf", "coyote", "squirrel", "duck",
  "goose", "swan", "owl", "eagle", "hawk", "heron", "muntjac", "boar", "pig", "sheep", "goat", "bison", "buffalo", "zebra",
  "giraffe", "monkey", "gorilla", "kangaroo", "raccoon", "badger", "otter", "seal", "bobcat", "lynx", "cougar", "leopard",
  "cheetah", "camel", "donkey", "llama", "alpaca", "hedgehog", "mouse", "rat", "chicken", "turkey", "penguin", "dolphin", "whale"]);
export function sparkSubjectName(concept, subjects) {
  if (!GENERIC_ANIMAL.has(String(concept || "").trim().toLowerCase()) || !Array.isArray(subjects)) return null;
  for (const raw of subjects) {
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    const words = name.split(/[\s-]+/);
    if (!/^[a-z][a-z -]{1,30}$/.test(name) || words.length > 3) continue;
    const last = words[words.length - 1];
    if (ANIMAL_WORDS.has(last) || ANIMAL_WORDS.has(last.replace(/s$/, ""))) return name;
  }
  return null;
}

export async function runLiteJob({ db, config, dataDir, fileIdCache, job, upload, onProgress, signal }) {
  const tJob = Date.now();
  let tMark = tJob;
  const timings = {};
  const mark = (name) => { const t = Date.now(); timings[name] = t - tMark; tMark = t; };
  const update = (stage, detail, progress) => {
    db.prepare("UPDATE jobs SET stage=?, detail=?, progress=?, updated_at=? WHERE id=?")
      .run(stage, detail, progress, Date.now(), job.id);
    onProgress?.({ stage, detail, progress });
  };

  // Shutdown gate before any work: an already-stopped app never starts
  // even the free snapshot validation below.
  throwIfCancelled(signal);
  const objectIds = JSON.parse(job.object_ids || "[]");
  const seedTime = Number(job.seed_time ?? job.seedTime ?? 0);
  const extra = job.prompt ? [job.prompt] : [];
  // Immutable snapshot check BEFORE any SAM spend when an explicit selection
  // exists. Old queued rows without a snapshot fail actionable (re-pick),
  // never misbuild via a numeric-id fallback against a reshuffled detect.
  let snapshot = null;
  if (objectIds.length) {
    snapshot = parseSelectionSnapshot(job.selection_snapshot);
    const expectedFrame = frameIndexFor(upload, seedTime);
    if (!snapshot?.objects?.length || snapshot.uploadId !== upload.id || snapshot.frameIndex !== expectedFrame ||
        snapshot.frameWidth !== upload.width || snapshot.frameHeight !== upload.height) {
      throw new Error(LITE_SELECTION_STALE_TEXT);
    }
    // Explicit selections require the very same bytes and decode-order frame seen by detect.
    // Refuse transformed/windowed paths BEFORE fresh detection or uploads can spend anything.
    requireLiteSeedSource(upload, expectedFrame);
  }

  update("detecting", "Finding your objects again…", 0.02);
  // Reuse the detect call's concept set while it is cached (this also picks
  // up Spark-narrowed vocabularies); a cold cache falls back to the full
  // sweep so restarts stay correct.
  const cachedEntry = cachedDetect(upload.id, frameIndexFor(upload, seedTime));
  const visual = snapshot?.version === 2;
  const { result, frameIndex, cached: reused } = visual ? await runBoxDetect({
    dataDir, upload, time: seedTime, box: snapshot.promptBox, signal,
    onRequest: () => {
      recordUsage(db, job.user_id, "sam", 1);
      if (config) recordSpend(db, config, job.user_id, "detect", "sam-3.1", 1, job.id);
    },
  }) : await runDetect({
    dataDir, upload, time: seedTime, extraConcepts: extra, signal,
    ...(cachedEntry?.base ? { baseConcepts: cachedEntry.base } : {}),
  });
  // Shutdown gate BEFORE the spend booking: a detect that finished just as
  // stop arrived must not book usage on the ledger. Caches are untouched.
  throwIfCancelled(signal);
  if (!reused && !visual) {
    recordUsage(db, job.user_id, "sam", 1); // resolve-detect on top of the window estimate
    if (config) recordSpend(db, config, job.user_id, "detect", "sam-3.1", (cachedEntry?.base || CANDIDATE_CONCEPTS).length + extra.length, job.id);
  }
  if (snapshot && (frameIndex !== snapshot.frameIndex || result.frameWidth !== upload.width || result.frameHeight !== upload.height)) {
    throw new Error(LITE_SELECTION_STALE_TEXT);
  }
  const byId = new Map(result._internal.accepted.map((c, i) => [i + 1, c]));
  let targets;
  if (snapshot) {
    // Explicit selection: associate each persisted snapshot box to the fresh
    // detect by unique overlap, then use the FRESH mask/box for tracking.
    // A prompt (if also stored) only widened the detect vocabulary above;
    // it never bypasses snapshot geometry here.
    targets = snapshot.objects.slice(0, 3).map((sel) => {
      const matched = associateSnapshotBox(sel.box, result.objects, visual ? {} : { expectedLabel: sel.label });
      const chosen = byId.get(Number(matched.id));
      if (!chosen) throw new Error(LITE_NO_MATCH_TEXT);
      return { id: matched.id, chosen };
    });
  } else {
    // No clicked id: explicitly automatic subject choice (prompt-only or
    // first object). Legacy fallback stays here only.
    targets = result.objects.slice(0, 1).map((o) => ({ id: o.id, chosen: byId.get(Number(o.id)) })).filter((t) => t.chosen);
  }
  if (snapshot && new Set(targets.map(target => target.id)).size !== targets.length) throw new Error(LITE_AMBIGUOUS_TEXT);
  if (!targets.length) throw new Error("No objects to track. Run detect on this clip first.");

  const specDir = path.join(dataDir, "specimens", job.id);
  await fsp.mkdir(specDir, { recursive: true });

  mark("detect");
  // Work that needs no masks runs WHILE SAM tracks (it used to run after):
  // the free local camera measure, and the provenance route label (one
  // Spark call, same as before, just no longer on the critical path).
  // Route classification is a model call: never start it after shutdown.
  throwIfCancelled(signal);
  const routePromise = Promise.resolve().then(() => classifyUpload({ upload, dataDir })).catch(() => null);
  const cameraPromise = Promise.resolve()
    .then(() => measureCamera(upload.path, upload.duration || 6, { signal }))
    .catch(() => null);
  // Burnt-in data bar (trail cameras): measured once, then cut from the
  // cut-outs, the plate and the still. A failed probe is "no bar".
  const osdPromise = detectOsdBar(upload.path, { frames: upload.frames, width: upload.width, height: upload.height, signal })
    .catch(() => ({ share: 1, cutY: null }));
  const allSlices = [];
  const concepts = [];
  let sharedSource = null; // explicit seeds share one frame: one cut, one upload
  let osd = null;
  for (const [n, target] of targets.entries()) {
    update("tracking", `Following object ${n + 1} of ${targets.length}…`, 0.05 + (0.7 * n) / targets.length);
    const workDir = path.join(specDir, "work", `obj${n}`);
    await fsp.mkdir(workDir, { recursive: true });
    throwIfCancelled(signal);
    const tSrc = Date.now();
    const source = snapshot
      ? (sharedSource ||= await selectedSamSource(upload, frameIndex, specDir, fileIdCache, signal))
      : await samSource(upload, frameIndex, fileIdCache, signal);
    console.log(`[lite-timing] samSource ms=${Date.now() - tSrc} stride=${source.samSegment?.stride || 1}`);
    osd ||= await osdPromise;
    throwIfCancelled(signal);
    const manifest = await generateVolume({
      videoPath: upload.path,
      ...source,
      concept: target.chosen.concept,
      frameWidth: upload.width,
      frameHeight: upload.height,
      fps: upload.fps,
      seedFrameIndex: frameIndex,
      selectedSeed: Boolean(snapshot),
      sourceFrames: upload.frames,
      chosenMask: target.chosen.mask,
      chosenBox: target.chosen.box,
      jobDir: workDir,
      signal,
      cropBottom: osd.cutY,
    });
    throwIfCancelled(signal);
    concepts.push(target.chosen.concept);
    const sliceFiles = [];
    for (const f of manifest.frames) {
      if (!f.present) continue;
      // manifest urls are `slices/<file>` relative to the work dir.
      const file = path.join(workDir, f.url);
      // generateVolume already composited each slice (full-resolution RGBA
      // cut-out) and hands the same bytes back; no disk re-read.
      const buffer = f.buffer || await fsp.readFile(file);
      sliceFiles.push({ buffer, file, timestamp: f.timestamp, sourceFrameIndex: f.sourceFrameIndex, concept: target.chosen.concept });
    }
    allSlices.push(...sliceFiles);
  }
  if (!allSlices.length) throw new Error("Tracking found the object in too few frames.");
  mark("track");

  update("packing", "Packing the chronophotograph…", 0.85);
  // The 2D still and the 3D atlas are independent: start the still now and
  // pack beside it (it used to wait for the pack).
  const compositeAbort = new AbortController();
  const onJobAbort = () => compositeAbort.abort();
  signal?.addEventListener("abort", onJobAbort, { once: true });
  const compositePromise = runLiteComposite({ specDir, upload, allSlices, config, job, signal, compositeSignal: compositeAbort.signal, osdCut: osd?.cutY });
  compositePromise.catch(() => {}); // awaited below; never an unhandled rejection
  const platePromise = runLitePlate({ specDir, upload, allSlices, config, job, signal, plateSignal: compositeAbort.signal, osdCut: osd?.cutY });
  platePromise.catch(() => {});
  let packed;
  let plateTravel = null;
  try {
  // Fallback stage plates straight off the source clip (local ffmpeg, no
  // models, no spend), used only when the registered plate is refused.
  // Fixed camera => N frames for a sharp temporal-median plate; moving
  // camera => one median frame for the blurred card. Any plate failure
  // never fails the job — the atlas ships without a backdrop and the
  // viewer keeps the void.
  // Fallback plates are cut above a burnt-in data bar too.
  const aboveBar = (buf) => (osd?.cutY > 0 ? cropRows(buf, upload.width, osd.cutY) : buf);
  const fallbackPlates = async () => {
    let plate = null, plates = null, plateMasks = null, cameraFixed = false;
    try {
      throwIfCancelled(signal);
      const measured = await cameraPromise;
      throwIfCancelled(signal);
      cameraFixed = !!(measured && !measured.moving);
      if (cameraFixed) {
        // Plate frames ride on slice times so every plate frame carries its
        // genuine SAM cut-out mask (grouped by source frame for multi-object
        // jobs); the pack QA-fallback needs those masks, not a union rect.
        const n = Math.min(12, allSlices.length);
        const ordered = [...allSlices].sort((a, b) => a.timestamp - b.timestamp);
        const picks = [];
        for (let k = 0; k < n; k += 1) picks.push(ordered[Math.round((k * (ordered.length - 1)) / (n - 1))]);
        const byFrame = new Map();
        for (const s of allSlices) {
          if (!byFrame.has(s.sourceFrameIndex)) byFrame.set(s.sourceFrameIndex, []);
          byFrame.get(s.sourceFrameIndex).push(s.buffer);
        }
        const useIdx = [...new Set(picks.map((s) => s.sourceFrameIndex))].filter(Number.isFinite).sort((a, b) => a - b);
        throwIfCancelled(signal);
        const paths = await extractFrames(upload.path, useIdx, path.join(specDir, "work", "plates"));
        throwIfCancelled(signal);
        plates = await Promise.all(paths.map((p) => fsp.readFile(p).then(aboveBar)));
        plateMasks = await Promise.all(useIdx.map((i) => (byFrame.get(i) ? Promise.all(byFrame.get(i).map(aboveBar)) : null)));
        await fsp.rm(path.join(specDir, "work", "plates"), { recursive: true, force: true }).catch(() => {});
      } else {
        const ordered = [...allSlices].sort((a, b) => a.timestamp - b.timestamp);
        const mid = ordered[Math.floor(ordered.length / 2)];
        if (mid && Number.isFinite(mid.sourceFrameIndex)) {
          throwIfCancelled(signal);
          const platePath = path.join(specDir, "work", "plate.png");
          await extractFrame(upload.path, mid.sourceFrameIndex, platePath);
          throwIfCancelled(signal);
          plate = await aboveBar(await fsp.readFile(platePath));
        }
      }
    } catch (error) {
      // A shutdown that lands mid-plate must abort the job, never degrade to
      // a plateless pack that keeps spending downstream.
      if (isCancelError(error) || signal?.aborted) throw cancelledError();
      plate = null; plates = null; plateMasks = null;
    }
    return { plate, plates, plateMasks, cameraFixed };
  };
  // A subject that barely moves (a mug, a person talking) packs as a living
  // still: one pose whose live loop plays the clip. It used to fail here,
  // after tracking was paid for (2 of 5 unseen clips in the generalisation
  // loop). The static line stays as a guard if the pack could not do that.
  packed = await packChronoAtlas(allSlices, { cell: 336, preserveAlpha: Boolean(snapshot), edgeBottom: osd?.cutY || null, staticStill: true });
  if (packed.motion && packed.motion.static && !packed.still) {
    throw new Error("This subject barely moves, so there is no sequence to show. Try Basic or Advanced.");
  }
  mark("pack");
  const registered = await platePromise;
  plateTravel = registered ? registered.travel : null;
  throwIfCancelled(signal);
  if (registered) {
    try {
      packed.backdrop = await finishPlate(registered.png, packed.dark ? { luma: 0.76 } : {});
      packed.backdropKind = "sharp";
      packed.backdropQa = registered.qa;
    } catch (error) {
      console.error(`[lite-plate] could not stage the plate for job ${job.id}: ${error?.message || error}`);
    }
  }
  if (!packed.backdrop) {
    Object.assign(packed, await buildChronoBackdrop({ ...(await fallbackPlates()), rect: packed.stageRect, dark: packed.dark }));
  }
  mark("plates");
  await fsp.writeFile(path.join(specDir, "atlas.webp"), packed.atlas);
  if (packed.backdrop) {
    await fsp.writeFile(path.join(specDir, "backdrop.webp"), packed.backdrop.buffer);
  }
  } catch (error) {
    // Failed or cancelled pack: the still being built beside it is dropped.
    compositeAbort.abort();
    signal?.removeEventListener("abort", onJobAbort);
    throw error;
  }
  let compositeInfo = await compositePromise;
  signal?.removeEventListener("abort", onJobAbort);
  if (compositeInfo) {
    try {
      await publishComposite(specDir);
    } catch (error) {
      console.error(`[lite-composite] could not publish for job ${job.id}: ${error?.message || error}`);
      compositeInfo = null;
    }
  }
  mark("composite-wait");
  const subject = job.subject || concepts[0] || "object";
  const atlasMeta = {
    name: job.id,
    concept: concepts.join(","),
    count: packed.kept.length,
    cols: packed.cols,
    rows: packed.rows,
    cellW: packed.cellW,
    cellH: packed.cellH,
    aspect: packed.cellW / packed.cellH,
    subjectFill: packed.subjectFill,
    poses: packed.poses,
    live: packed.live,
    anchors: packed.anchors,
    // per cell: the sides the source frame cuts (volume.js dissolves them)
    ...(packed.cuts ? { cuts: packed.cuts } : {}),
    // ghost trail: the frames between poses (cells, place on the row, bbox bottom)
    ...(packed.trail ? { trail: packed.trail } : {}),
    // the subject went left in the scene: time runs right to left, so the
    // trail lies behind it (registered travel; else its travel in the frame)
    ...(rowDir(plateTravel, packed.frameTravel) === -1 ? { dir: -1 } : {}),
    // a herd/pack picked as one object: stray members were left out
    ...(packed.group ? { group: true } : {}),
    exposure: packed.exposure,
    dark: packed.dark,
    backdropQa: packed.backdropQa || null,
    ...(osd?.cutY ? { osdBar: { share: osd.share, cutY: osd.cutY } } : {}),
    motion: packed.motion ? Number(packed.motion.mean.toFixed(4)) : 0,
    ...(packed.still ? { still: true } : {}),
    ...(packed.backdrop ? { backdrop: { file: "backdrop.webp", w: packed.backdrop.width, h: packed.backdrop.height, kind: packed.backdropKind || "blur" } } : {}),
    ...(compositeInfo ? { composite: compositeInfo } : {}),
    fps: upload.fps,
    timestamps: packed.kept.map((k) => Number(k.timestamp.toFixed(3))),
    source: path.basename(upload.path),
    objects: concepts,
  };
  await fsp.writeFile(path.join(specDir, "atlas.json"), JSON.stringify(atlasMeta));
  const thumb = await makeThumb(packed.firstPose, 480, { backdrop: packed.backdrop?.buffer || null });
  await fsp.writeFile(path.join(specDir, "thumb.webp"), thumb);

  // Started beside tracking (see routePromise); a failure is a null label.
  throwIfCancelled(signal);
  const route = await routePromise;
  mark("route-wait");
  const atlasBytes = (await fsp.stat(path.join(specDir, "atlas.webp"))).size;
  const thumbBytes = (await fsp.stat(path.join(specDir, "thumb.webp"))).size;
  // The site sends title "<label> lite" + subject "<label>" for every job;
  // only that auto title is renamed, never a title the user typed.
  const named = sparkSubjectName(subject, route?.subjects);
  const shownSubject = named || subject;
  const autoTitle = !job.title || job.title === `${subject} lite`;
  const jobResult = {
    id: job.id,
    tier: "lite",
    title: named && autoTitle ? `${named} lite` : (job.title || `${shownSubject} solid`),
    subject: shownSubject,
    viewer: `view-lite.html?id=${job.id}`,
    thumb: `specimens/${job.id}/thumb.webp`,
    durationSec: Math.round(upload.duration * 10) / 10,
    bytes: atlasBytes + thumbBytes,
    meta: {
      camera: route?.camera || "unknown",
      category: route?.category || "unknown",
      provenance: ["sam-3.1", "muse-spark-1.3"],
    },
  };
  await fsp.writeFile(path.join(specDir, "meta.json"), JSON.stringify(jobResult, null, 2));
  // LITE_KEEP_WORK=1 is eval-only (fixture export: slices + composite-input);
  // production never sets it, so work/ is always removed there.
  if (process.env.LITE_KEEP_WORK !== "1") {
    await fsp.rm(path.join(specDir, "work"), { recursive: true, force: true }).catch(() => {});
  }
  // Remove per-seed segment files if windowing created them.
  for (const f of await fsp.readdir(path.dirname(upload.path)).catch(() => [])) {
    if (f.startsWith("seg_") && f.endsWith(".mp4")) await fsp.rm(path.join(path.dirname(upload.path), f), { force: true }).catch(() => {});
  }
  mark("finish");
  console.log(`[lite-timing] job=${job.id} total=${Date.now() - tJob} ${Object.entries(timings).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return jobResult;
}
