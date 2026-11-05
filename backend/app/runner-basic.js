import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { recordUsage, recordSpend } from "./db.js";
import { cancelledError, isCancelError, killProcessTree, throwIfCancelled } from "../lib/cancel.js";
import { measureCamera } from "./camera.js";
import { runDetect, runBoxDetect, cachedDetect, frameIndexFor, parseSelectionSnapshot } from "./detect-cache.js";
import { SELECTION_STALE_TEXT } from "./errors.js";
import { CANDIDATE_CONCEPTS } from "../lib/vocab.js";
import { BASIC_HANDOFF_TEXT, BASIC_CLOCK_TEXT, BASIC_MASK_TEXT, BASIC_SPAN_TEXT, requireBasicSelectedSource, probeBasicClock, writeBasicSelection, basicCutPlan, buildBasicCut } from "../pipeline/basic/lib/selected-source.mjs";
import { VIDEO_SEED_NO_MATCH, VIDEO_SEED_AMBIGUOUS } from "../lib/sam-video-seed.mjs";
import { IMAGE_FRAME_CHANGED } from "../lib/sam-image-seed.mjs";
import { BOX_SELECTION_NO_MATCH } from "../lib/sam-image-result.mjs";
import { boxIoU } from "../pipeline/basic/lib/keyframes.mjs";
import { SELECTED_TRACK_TIMEOUT } from "../lib/track-selected.js";

// Basic ("Specimen") runner: shells out to backend/pipeline/basic/run-basic.mjs
// (basic agent owns that file; this module tracks its CLI contract):
//   node run-basic.mjs <video> <outDir> --concept "<text>" [--seed <sec>] [--seed-box "l,t,r,b"] [--object <id>]
// Progress arrives as `stage: <text>` stdout lines. The script writes
// specimen.json, plate.webp, subject.webp, depth.webp, thumb.webp, meta.json
// into <outDir>. Its meta.json already matches the job-result shape except
// `thumb` is relative to the specimen dir, so it is normalised here to
// `specimens/<id>/thumb.webp`. Concurrency: one local job at a time (the
// pump in app.js serialises; `running` is a backstop).

// The `stage:` lines are diagnostics (scores, paths, cache keys), never shown
// as they are: each maps to a plain step and a fraction, and the bar only moves
// forward. A line for no step or an earlier one (cleanup, the early Muse edit
// that overlaps tracking, the behind pass after packing) keeps the current step.
const BASIC_STEPS = [
  [/^(work dir|probe)\b/, "reading the clip", "Reading your clip…", 0.03],
  [/^track\b/, "tracking", "Following your subject through the clip…", 0.08],
  [/^(keyframes|sweep|birefnet-matte|refine-alpha|matte-dir|flow)\b/, "choosing moments", "Choosing the moments for the trail…", 0.4],
  [/^(subject|camera)\b/, "measuring", "Measuring your subject and the camera…", 0.48],
  [/^plate\b(?!: first Muse edit requested at job start)|^behind\b/, "painting the scene", "Painting the scene without your subject…", 0.55],
  [/^(infer|depth|fit)\b/, "estimating depth", "Estimating depth at each moment…", 0.75],
  [/^atlas\b/, "packing", "Packing the cloud trail…", 0.9],
  [/^done\b/, "finishing", "Finishing…", 0.97],
];
export function basicStep(text, current = -1) {
  const index = BASIC_STEPS.findIndex(([re]) => re.test(text));
  if (index <= current) return null;
  const [, stage, detail, progress] = BASIC_STEPS[index];
  return { index, stage, detail, progress };
}

let running = 0;

export function basicAvailable(config) {
  try {
    return fs.existsSync(config.basicRunner);
  } catch {
    return false;
  }
}

// Every user-facing line this module can throw (basicFailureText outputs
// plus the runner's own crafted lines). Exported so the app can pass them
// through error shaping by EXACT match, and so tests pin each one.
export const BASIC_UPSTREAM_BUSY_TEXT =
  "Meta's model service was temporarily unavailable. Please try again in a few minutes.";
export const BASIC_CLOSEUP_TEXT =
  "This subject fills too much of the frame for Basic, which needs it under about a third of the picture. Try Advanced for objects up close, or Lite.";
export const BASIC_MOVING_CAMERA_TEXT =
  "Basic needs a steady camera, and this clip's camera moves. Try Lite.";
export const BASIC_GHOST_TEXT =
  "Basic could not rebuild a clean background behind the subject. Try Lite.";
export const BASIC_UNCLEAN_TEXT =
  "Basic pipeline could not build a clean scene from this clip. Try Lite, or a clip with a clearer subject.";
export const BASIC_UNEXPECTED_TEXT =
  "Basic pipeline failed unexpectedly. Please try again later.";
export const BASIC_SELECTED_FAIL_TEXT = "Basic selected tracking did not finish. Start a new build to retry.";
export const BASIC_NO_META_TEXT =
  "Basic runner finished without readable meta.json.";
// Multi-object Basic is rejected, not approximated (see resolveConcept).
export const BASIC_MULTI_OBJECT_TEXT =
  "Basic builds one subject at a time. Re-submit with a single object, or try Lite for up to three.";
// Selected-object identity: an explicit click persists an immutable snapshot
// at enqueue (label + normalized bbox + seed frame). A missing/stale snapshot
// refuses before spend (never silently substitutes another instance).
export const BASIC_SELECTION_STALE_TEXT = SELECTION_STALE_TEXT;
// Seed-box track matching refusals (run-basic.mjs --seed-box): low-confidence
// /no-match and ambiguous twins refuse instead of longest-track fallback.
export const BASIC_SEED_BOX_NO_MATCH_TEXT =
  "Basic could not match the selected object in the video pass. Re-pick the object or try Lite.";
export const BASIC_SEED_BOX_AMBIGUOUS_TEXT =
  "Basic found an ambiguous match for the selected object. Re-pick a clearer frame or try Lite.";
// Seeds past the pipeline's supported clip span fail before tracking.
export const BASIC_SEED_RANGE_TEXT =
  "Basic builds from the first 12 seconds. Pick a seed time inside that window.";
export const BASIC_SAFE_ERRORS = [
  BASIC_HANDOFF_TEXT,
  BASIC_CLOCK_TEXT,
  BASIC_MASK_TEXT,
  BASIC_SPAN_TEXT,
  SELECTED_TRACK_TIMEOUT,
  BASIC_SELECTED_FAIL_TEXT,
  BASIC_UPSTREAM_BUSY_TEXT,
  BASIC_CLOSEUP_TEXT,
  BASIC_MOVING_CAMERA_TEXT,
  BASIC_GHOST_TEXT,
  BASIC_UNCLEAN_TEXT,
  BASIC_UNEXPECTED_TEXT,
  BASIC_NO_META_TEXT,
  BASIC_MULTI_OBJECT_TEXT,
  BASIC_SELECTION_STALE_TEXT,
  BASIC_SEED_BOX_NO_MATCH_TEXT,
  BASIC_SEED_BOX_AMBIGUOUS_TEXT,
  BASIC_SEED_RANGE_TEXT,
];

// _runDetect is a test seam mirroring runDetect's own _detectObjects: it lets
// shutdown tests hold the resolve step pending without any network call.
async function resolveConcept({ db, config, dataDir, job, upload, signal, _runDetect, _runBoxDetect, _probeBasicClock, _buildBasicCut }) {
  const ids = JSON.parse(job.object_ids || "[]");
  // Selected-object identity: app image ids and video track ids are unrelated
  // namespaces, and fresh detects reshuffle numeric ids after cache expiry.
  // An explicit click therefore persists an IMMUTABLE snapshot at enqueue
  // (label + normalized bbox + seed frame); the numeric id is never
  // re-resolved against a different detect ordering, and client-supplied
  // geometry is never trusted (only the server snapshot is read here).
  // More than one selected object stays an explicit refusal (no multi-object
  // expansion). (POST /jobs rejects this first; this guards pre-existing
  // queued rows.)
  if (ids.length > 1) throw new Error(BASIC_MULTI_OBJECT_TEXT);
  const seedTime = Number(job.seed_time) || 0;
  if (ids.length === 1) {
    // Explicit selection: the snapshot governs even when a prompt is also
    // stored (a prompt must not bypass snapshot geometry when an id was
    // clicked). No fresh detect here — no spend, no reshuffle.
    const snap = parseSelectionSnapshot(job.selection_snapshot);
    const expectedFrame = frameIndexFor(upload, seedTime);
    if (snap?.version === 2) {
      if (ids[0] !== 1 || snap.uploadId !== upload.id || snap.frameIndex !== expectedFrame ||
          snap.frameWidth !== upload.width || snap.frameHeight !== upload.height) throw new Error(BASIC_SELECTION_STALE_TEXT);
      // Loop 8 (tier-improve 2026-11-04): a long (>12 s, >350 frames) or
      // variable-rate clip no longer refuses; it gets a proven constant-rate
      // cut from the clicked frame (basicCutPlan / buildBasicCut), planned
      // here before the paid image detect and built after it.
      let cutPlan = null;
      try {
        requireBasicSelectedSource(upload, expectedFrame);
      } catch (error) {
        if (error?.message === BASIC_SPAN_TEXT) throw error;
        cutPlan = basicCutPlan(upload, expectedFrame);
      }
      if (fs.existsSync(path.join(dataDir, "specimens", job.id, ".selection"))) throw new Error(BASIC_HANDOFF_TEXT);
      if (!cutPlan) {
        try {
          await (_probeBasicClock || probeBasicClock)(upload.path, upload.fps, upload.frames, { signal });
        } catch (error) {
          if (isCancelError(error) || signal?.aborted) throw cancelledError();
          cutPlan = basicCutPlan(upload, expectedFrame);
        }
      }
      throwIfCancelled(signal);
      let fresh;
      try {
        fresh = await (_runBoxDetect || runBoxDetect)({
          dataDir, upload, time: seedTime, box: snap.promptBox, signal,
          onRequest: () => {
            throwIfCancelled(signal);
            recordUsage(db, job.user_id, "sam", 1);
            recordSpend(db, config, job.user_id, "detect", "sam-3.1", 1, job.id);
          },
        });
      } catch (error) {
        if (isCancelError(error) || signal?.aborted) throw cancelledError();
        if (error?.message === IMAGE_FRAME_CHANGED) throw new Error(BASIC_SELECTION_STALE_TEXT);
        if (error?.message === BOX_SELECTION_NO_MATCH) throw new Error(BASIC_SEED_BOX_NO_MATCH_TEXT);
        throw new Error(BASIC_UPSTREAM_BUSY_TEXT);
      }
      throwIfCancelled(signal);
      const result = fresh?.result;
      if (fresh?.frameIndex !== expectedFrame || result?.frameWidth !== upload.width || result?.frameHeight !== upload.height) throw new Error(BASIC_SELECTION_STALE_TEXT);
      const publicObject = result.objects?.[0], chosen = result._internal?.accepted?.[0];
      const raw = chosen?.box;
      const norm = raw && { left: raw.left / upload.width, top: raw.top / upload.height, right: raw.right / upload.width, bottom: raw.bottom / upload.height };
      if (result.objects?.length !== 1 || result._internal?.accepted?.length !== 1 || publicObject?.id !== 1 || !norm ||
          !['left','top','right','bottom'].every(k => Number.isFinite(norm[k]) && Math.abs(norm[k] - publicObject.box?.[k]) < 1e-6) ||
          !(boxIoU(snap.objects[0].box, norm) >= .25)) throw new Error(BASIC_SEED_BOX_NO_MATCH_TEXT);
      // The cut keeps the source size and starts at the clicked frame, so the
      // image box and mask are cut frame 0's exactly.
      let source = { videoPath: upload.path, fps: upload.fps, frames: upload.frames, seedFrameIndex: expectedFrame };
      if (cutPlan) {
        // private: beside the upload, never under the served /specimens tree
        const cutPath = path.join(path.dirname(upload.path), `basic-cut-${job.id}.mp4`);
        source = await (_buildBasicCut || buildBasicCut)(upload.path, upload, cutPlan, cutPath, { signal });
        throwIfCancelled(signal);
        console.log(`[basic] job ${job.id}: constant-rate cut ${JSON.stringify(source.cut)}`);
      }
      return { concept: "selected object", seedBox: null, selectionSeed: {
        videoPath: source.videoPath, width: upload.width, height: upload.height, fps: source.fps, frames: source.frames,
        seedFrameIndex: source.seedFrameIndex, promptBox: snap.promptBox, chosenBox: chosen.box, chosenMask: chosen.mask,
      }, cut: source.cut || null };
    }
    if (!snap || snap.version !== 1 || snap.uploadId !== upload.id || snap.frameIndex !== expectedFrame || snap.objects?.length !== 1) {
      throw new Error(BASIC_SELECTION_STALE_TEXT);
    }
    const sel = snap.objects[0];
    if (!sel?.label || !sel?.box) throw new Error(BASIC_SELECTION_STALE_TEXT);
    return { concept: sel.label, object: null, seedBox: sel.box };
  }
  // No clicked id: explicitly automatic subject choice. A prompt (if any)
  // selects the subject; otherwise the first detect object is used.
  if (job.prompt) return { concept: job.prompt, object: null, seedBox: null };
  const cachedEntry = cachedDetect(upload.id, frameIndexFor(upload, seedTime));
  const runDetectFn = _runDetect || runDetect;
  const { result, cached: reused } = await runDetectFn({
    dataDir, upload, time: seedTime, signal,
    ...(cachedEntry?.base ? { baseConcepts: cachedEntry.base } : {}),
  });
  // Shutdown gate BEFORE the spend booking: a detect that finished just as
  // stop arrived must not book usage on the ledger.
  throwIfCancelled(signal);
  if (!reused) {
    recordUsage(db, job.user_id, "sam", 1);
    recordSpend(db, config, job.user_id, "detect", "sam-3.1", (cachedEntry?.base || CANDIDATE_CONCEPTS).length, job.id);
  }
  const concept = result.objects[0]?.label || null;
  if (!concept) throw new Error("No objects to build. Run detect on this clip first.");
  return { concept, object: null, seedBox: null };
}

// Maps a failed child process to a user-safe line. Upstream trouble keeps the wording the job retry loop recognises.
// Every return value MUST stay a member of BASIC_SAFE_ERRORS (exact trusted
// allowlist in app.js); tests pin this invariant.
export function basicFailureText(error, tail) {
  // Recognize crafted selected-path refusals before legacy HTTP heuristics;
  // line numbers in a stack must not turn a timeout into a paid requeue.
  if (String(tail).includes(VIDEO_SEED_NO_MATCH)) return BASIC_SEED_BOX_NO_MATCH_TEXT;
  if (String(tail).includes(VIDEO_SEED_AMBIGUOUS)) return BASIC_SEED_BOX_AMBIGUOUS_TEXT;
  if (String(tail).includes("Selected upload cleanup was not confirmed.") || String(tail).includes("Selected segmentation evidence exceeded its bound.")) return BASIC_SELECTED_FAIL_TEXT;
  for (const text of [BASIC_HANDOFF_TEXT, BASIC_CLOCK_TEXT, BASIC_MASK_TEXT, BASIC_SPAN_TEXT, SELECTED_TRACK_TIMEOUT, BASIC_SELECTED_FAIL_TEXT]) {
    if (String(tail).includes(text)) return text;
  }
  // Exit 3 is a deliberate refusal. run-basic prints its reason; map each to advice the user can act on.
  // Checked before the HTTP heuristic below: a refusal is never retried (and paid for again) as upstream trouble.
  if (/close-up subject/i.test(tail)) return BASIC_CLOSEUP_TEXT;
  if (/\b(pan|dolly|shift) camera\b/i.test(tail)) return BASIC_MOVING_CAMERA_TEXT;
  if (/persistent background ghosts/i.test(tail)) return BASIC_GHOST_TEXT;
  // Seed-box identity refusals (explicit selection): never collapse to generic unclean.
  if (/seed-box no match|could not match the selected object in the video/i.test(tail)) return BASIC_SEED_BOX_NO_MATCH_TEXT;
  if (/seed-box ambiguous|ambiguous match for the selected/i.test(tail)) return BASIC_SEED_BOX_AMBIGUOUS_TEXT;
  if (/beyond the Basic|first 12 seconds|inside that window|opening window/i.test(tail)) return BASIC_SEED_RANGE_TEXT;
  if (/selection expired|re-pick the object to build/i.test(tail)) return BASIC_SELECTION_STALE_TEXT;
  // run-basic's Meta proxy counters ("proxy usage before: {...,"files":503}") are counts, not HTTP statuses.
  const httpTail = String(tail).replace(/proxy usage (before|after): \{[^}]*\}/g, "");
  if (/model_not_found|model was not found|\b(429|502|503|504)\b|connection error|ECONNRESET|fetch failed/i.test(httpTail)) {
    return BASIC_UPSTREAM_BUSY_TEXT;
  }
  if (error?.code === 3) return BASIC_UNCLEAN_TEXT;
  return BASIC_UNEXPECTED_TEXT;
}

// Currently running child process owned by this module (one at a time).
// Tracked so graceful shutdown can kill the whole tree instead of
// orphaning the Python/ffmpeg grandchildren. killProcessTree (lib/cancel.js)
// owns the platform kill; this module only owns the slot.
let activeChild = null;
// Source signal owning the active child (the app scope passed to the run
// that spawned it, or null for signal-less module-level runs). Scoped stops
// only touch the child owned by their own scope.
let activeChildOwner = null;

// Shutdown generation: bumped whenever a stop cancels not-yet-spawned work.
// Each run captures the generation at entry and refuses to spawn when it has
// moved on. A generation is NOT a stopped flag: runs that start after the
// bump capture the new value and proceed, so a later createApp in the same
// test process is never blocked.
let cancelEpoch = 0;
// Runs between entry and settle (includes the pre-spawn await window where
// there is no child yet to kill). Lets an idle kill still cancel penders.
let pendingStarts = 0;
// Live per-run controllers keyed by owning scope (the source signal passed
// to the run, or null). A scoped stop aborts only its own runs; the legacy
// no-arg kill aborts everything owned by this module.
const liveControllers = new Map();

function childIsLive(child) {
  if (!child || child.killed) return false;
  // exitCode is null while running (undefined on minimal stubs: treat as live).
  return child.exitCode === null || child.exitCode === undefined;
}

// Kill the owned Basic child TREE, and cancel pending pre-spawn work.
// killBasicChild() with no argument keeps the legacy all-owned semantics:
// any live child tree plus every pending run, with a generation bump so
// pre-spawn runs started before the call refuse to spawn.
// killBasicChild(scope) is scoped to one app: it tree-kills the active
// child only when that child was spawned by a run owned by scope, aborts
// only scope's run controllers, and never bumps the global generation — an
// unrelated app's pending runs and children are untouched.
// Safe to call with nothing running. Returns true when a live child was
// signalled. Exported for app shutdown. Tree kills fire without awaiting
// (callers are sync); the generation bump (legacy) and controller aborts
// (both paths) already prevent new spawns.
export function killBasicChild(scopeSignal) {
  if (scopeSignal === undefined) {
    const child = activeChild;
    const live = childIsLive(child);
    if (live) void killProcessTree(child).catch(() => {});
    if (live || pendingStarts > 0) {
      cancelEpoch += 1;
      for (const controller of [...liveControllers.keys()]) {
        try { controller.abort(); } catch { /* already aborted */ }
      }
    }
    return live;
  }
  let live = false;
  if (activeChildOwner === scopeSignal && childIsLive(activeChild)) {
    live = true;
    void killProcessTree(activeChild).catch(() => {});
  }
  for (const [controller, owner] of [...liveControllers]) {
    if (owner === scopeSignal) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
  }
  return live;
}

export function runBasicJob({ db, config, dataDir, job, upload, onProgress, spawnFn = execFile, signal, _runDetect, _runBoxDetect, _probeBasicClock, _measureCamera, _buildBasicCut }) {
  return new Promise((resolve, reject) => {
    if (running > 0) return reject(new Error("Basic runner busy; job was re-queued."));
    running += 1;
    pendingStarts += 1;
    // Settle exactly once; every path releases the pending slot and drops
    // the per-run source listener (never leak it onto the app signal).
    let settled = false;
    const settle = (fn) => (value) => {
      if (!settled) {
        settled = true;
        pendingStarts -= 1;
        liveControllers.delete(runController);
        ownChild = null;
        if (signal && onSourceAbort) {
          try { signal.removeEventListener("abort", onSourceAbort); } catch { /* gone */ }
        }
      }
      fn(value);
    };
    resolve = settle(resolve);
    reject = settle(reject);
    // Per-run controller: follows the app's signal when one is passed and
    // is aborted by killBasicChild for the module-level (signal-less) path.
    // The captured epoch refuses post-stop spawns without blocking runs
    // that start afterwards.
    const runController = new AbortController();
    liveControllers.set(runController, signal ?? null);
    // This run's own spawned child (cleared on settle). The source listener
    // tree-kills it BEFORE aborting the controller: execFile's built-in
    // abort would otherwise kill only the parent first and mark it killed,
    // hiding the whole tree from the later kill and orphaning grandchildren.
    let ownChild = null;
    let onSourceAbort = null;
    if (signal) {
      if (signal.aborted) runController.abort();
      else {
        onSourceAbort = () => {
          const c = ownChild;
          if (c && childIsLive(c)) void killProcessTree(c).catch(() => {});
          runController.abort();
        };
        signal.addEventListener("abort", onSourceAbort, { once: true });
      }
    }
    const runSignal = runController.signal;
    const epoch = cancelEpoch;
    // Shutdown gate for the pre-spawn window: stop() during the free
    // camera measurement or the resolve step must prevent the later spawn.
    const assertLive = () => {
      if (epoch !== cancelEpoch) runController.abort();
      throwIfCancelled(runSignal);
    };
    const assertOwned = (child) => {
      if (activeChild === child) {
        activeChild = null;
        activeChildOwner = null;
      }
    };
    // Loop 8: a constant-rate cut built for this run (private, beside the
    // upload); removed once the child is done with it or the run fails first.
    let cutVideo = null;
    const dropCut = () => { if (cutVideo) void fsp.rm(cutVideo, { force: true }).catch(() => {}); };
    (async () => {
      try {
        // Free local ffmpeg measurement BEFORE the possibly-spending
        // resolveConcept (SAM detect): a moving camera refuses here with
        // no Meta cost. One camera verdict for the whole app: when the
        // measurement says fixed, the runner must not second-guess it.
        // The measurement is abort-aware; a stop mid-measurement rejects
        // cancelled instead of falling through to the spawn below.
        const measured = await (_measureCamera || measureCamera)(upload.path, upload.duration, { signal: runSignal }).catch((error) => {
          if (isCancelError(error) || runSignal.aborted) throw cancelledError();
          return null;
        });
        assertLive();
        if (measured?.confident && measured.moving) throw new Error(basicFailureText({ code: 3 }, "shift camera"));
        const { concept, seedBox, selectionSeed } = await resolveConcept({ db, config, dataDir, job, upload, signal: runSignal, _runDetect, _runBoxDetect, _probeBasicClock, _buildBasicCut });
        if (selectionSeed && selectionSeed.videoPath !== upload.path) cutVideo = selectionSeed.videoPath;
        assertLive();
        const outDir = path.join(dataDir, "specimens", job.id);
        await fsp.mkdir(outDir, { recursive: true });
        assertLive();
        const seed = Number(job.seed_time);
        // CLI contract: --concept + --seed always; --seed-box carries the
        // immutable snapshot geometry (never a numeric image/track id).
        // --object is never forwarded (unrelated video-track namespace).
        if (selectionSeed) {
          try { await writeBasicSelection({ outDir, ...selectionSeed }); }
          catch { throw new Error(BASIC_HANDOFF_TEXT); }
          assertLive();
        }
        const args = [config.basicRunner, selectionSeed ? selectionSeed.videoPath : upload.path, outDir, "--concept", concept];
        if (selectionSeed) args.push("--selected-source");
        if (measured?.confident && !measured.moving) args.push("--camera-override", "fixed");
        // A click carries its frame's seed box, so its seed time is forwarded
        // even at 0 (the site's default frame); otherwise run-basic's 1.0 s
        // default would match a frame-0 box one second later.
        if (Number.isFinite(seed) && (seed > 0 || seedBox)) args.push("--seed", String(seed));
        if (seedBox) args.push("--seed-box", `${seedBox.left},${seedBox.top},${seedBox.right},${seedBox.bottom}`);
        let tail = "";
        const keepTail = (chunk) => { tail = (tail + chunk).slice(-4000); };
        const child = spawnFn("node", args, {
          timeout: 30 * 60 * 1000,
          maxBuffer: 16 * 1024 * 1024,
          // No `signal` here on purpose: execFile's built-in abort kills
          // only the direct parent first and marks it killed synchronously,
          // which would hide the Python/ffmpeg grandchildren from the
          // shutdown tree kill and orphan them (proven by the tree-kill
          // regressions). Killing the child path is owned by
          // killProcessTree — via the scoped stop and the source listener
          // above — while JS-side waits still abort through runSignal.
          // Own process group on POSIX so the shutdown tree-kill reaches
          // the Python/ffmpeg grandchildren, not just the Node parent.
          ...(process.platform === "win32" ? {} : { detached: true }),
        }, async (error) => {
          assertOwned(child);
          running -= 1;
          dropCut();
          if (error) {
            // A stop that landed mid-child reports cancellation, never a
            // pipeline failure (which the pump would retry-reserve). A
            // success callback always drains normally: finished work keeps
            // its outcome and performs no new spend.
            if (runSignal.aborted || epoch !== cancelEpoch) {
              reject(cancelledError());
              return;
            }
            // Full detail goes to the server log only; the thrown text is what a user may read (no paths, no stderr).
            console.error(`[basic] job ${job.id} failed (code ${error.code ?? "?"}, signal ${error.signal ?? "-"}): ${tail.replace(/\s+/g, " ").slice(-1500)}`);
            const text = basicFailureText(error, tail);
            reject(new Error(selectionSeed && text === BASIC_UPSTREAM_BUSY_TEXT ? BASIC_SELECTED_FAIL_TEXT : text));
            return;
          }
          try {
            const metaPath = path.join(outDir, "meta.json");
            const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
            if (typeof meta.thumb === "string" && !meta.thumb.startsWith("specimens/")) {
              meta.thumb = `specimens/${job.id}/${meta.thumb.split("/").pop()}`;
            }
            meta.id = job.id;
            meta.tier = "basic";
            if (job.title) meta.title = job.title;
            await fsp.writeFile(metaPath, JSON.stringify(meta));
            // run-basic's per-job caches (~6-7 MB, never served: dotfiles
            // deny) are not part of the specimen; same as the GPU worker.
            await fsp.rm(path.join(outDir, ".work"), { recursive: true, force: true }).catch(() => {});
            resolve(meta);
          } catch {
            reject(new Error(BASIC_NO_META_TEXT));
          }
        });
        activeChild = child;
        activeChildOwner = signal ?? null;
        ownChild = child;
        let step = -1;
        child.stdout?.on("data", (chunk) => {
          keepTail(chunk);
          for (const line of String(chunk).split("\n")) {
            const next = line.startsWith("stage: ") && basicStep(line.slice(7), step);
            if (next) { step = next.index; onProgress?.({ stage: next.stage, detail: next.detail, progress: next.progress }); }
          }
        });
        child.stderr?.on("data", keepTail);
      } catch (error) {
        running -= 1;
        dropCut();
        // Shutdown wins over any error that lands at the same moment
        // (ffmpeg probe failure, stale snapshot refusal, ...): the pump
        // must drop a cancelled job, never retry or requeue it.
        if (isCancelError(error) || runSignal.aborted || epoch !== cancelEpoch) reject(cancelledError());
        else reject(error);
      }
    })();
  });
}
