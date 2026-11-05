import fs from "node:fs";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { detectObjects, detectBox } from "../lib/detect.js";
import { requireImageBox } from "../lib/sam-image-seed.mjs";
import { cancelledError, isCancelError, throwIfCancelled } from "../lib/cancel.js";
import { CANDIDATE_CONCEPTS } from "../lib/vocab.js";
import { extractFrame } from "../lib/ffmpeg.js";

// Persistent detect helper. Frame stills live under
// DATA_DIR/uploads/<uploadId>/frame_<n>.png so any process restart can redo
// them; the parsed SAM result is kept in memory like the legacy dev server.
const cache = new Map(); // `${uploadId}:${frameIndex}` -> { result, objectsById, frameIndex, concepts }
const boxCache = new Map(); // Independent: a visual prompt must not evict an existing noun sweep.
const frameReads = new Map();
const boxRequests = new Map(); // Coalesce identical HTTP picks; independently cancellable jobs stay separate.

export function __resetDetectCache() {
  cache.clear();
  boxCache.clear();
}

export function frameIndexFor(upload, time) {
  return Math.max(0, Math.min(Math.round(Number(time) * upload.fps), upload.frames - 1));
}

function frameDir(dataDir, uploadId) {
  return path.join(dataDir, "uploads", uploadId);
}

async function readStill(dataDir, upload, frameIndex) {
  const dir = frameDir(dataDir, upload.id), stillPath = path.join(dir, `frame_${frameIndex}.png`);
  let pending = frameReads.get(stillPath);
  if (!pending) {
    pending = (async () => {
      await fsp.mkdir(dir, { recursive: true });
      if (!fs.existsSync(stillPath)) {
        const temporary = path.join(dir, `frame_${frameIndex}.${randomUUID()}.png`);
        try {
          await extractFrame(upload.path, frameIndex, temporary);
          await fsp.rename(temporary, stillPath);
        } finally { await fsp.unlink(temporary).catch(() => {}); }
      }
      return fsp.readFile(stillPath);
    })();
    frameReads.set(stillPath, pending);
  }
  try { return await pending; }
  finally { if (frameReads.get(stillPath) === pending) frameReads.delete(stillPath); }
}

// Runs SAM image segmentation for one still frame. Returns the legacy server's
// detect shape plus the internal accepted list for tracking.
// The signal checkpoints below sit BEFORE every spending step: shutdown
// during the free still extraction still refuses instead of calling SAM.
// Nothing is cached on abort, so retry caches stay exactly as they were.
export async function runDetect({ dataDir, upload, time, extraConcepts = [], baseConcepts = CANDIDATE_CONCEPTS, _detectObjects, signal }) {
  const frameIndex = frameIndexFor(upload, time);
  const key = `${upload.id}:${frameIndex}`;
  const base = baseConcepts || CANDIDATE_CONCEPTS;
  const requested = [...(extraConcepts || [])];
  // Same still + same base + same-or-wider extras: reuse instead of re-spending.
  const prev = cache.get(key);
  if (prev && prev.baseKey === base.join(",") && requested.every((c) => prev.extraConcepts.includes(c))) {
    return { result: prev.result, frameIndex, concepts: prev.concepts, cached: true };
  }
  throwIfCancelled(signal);
  try {
    const detectObjectsFn = _detectObjects || detectObjects;
    const mergedExtra = Array.from(new Set([...(prev?.extraConcepts || []), ...requested]));
    const concepts = [...base, ...mergedExtra];

    const frameBuffer = await readStill(dataDir, upload, frameIndex);

    // Final gate before the spending SAM call (the still extraction above
    // is free local ffmpeg, so aborting here wastes nothing billable).
    throwIfCancelled(signal);
    const result = await detectObjectsFn(frameBuffer, upload.width, upload.height, mergedExtra, base, { signal });
    const objectsById = new Map(result._internal.accepted.map((c, i) => [i + 1, c]));
    cache.set(key, { result, extraConcepts: mergedExtra, objectsById, frameIndex, concepts, baseKey: base.join(","), base: [...base] });
    return { result, frameIndex, concepts, cached: false };
  } catch (error) {
    // Shutdown wins over local ffmpeg failures that land at the same
    // moment; otherwise the raw error propagates unchanged.
    if (isCancelError(error) || signal?.aborted) throw cancelledError();
    throw error;
  }
}

// The recipe is server-owned canonical pixels. A receipt prevents another
// tab's box/noun detect from silently changing what the enqueue click means.
export async function runBoxDetect({ dataDir, upload, time, box, _detectBox, signal, onRequest, actorId }) {
  const promptBox = requireImageBox(box, upload.width, upload.height);
  const frameIndex = frameIndexFor(upload, time);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new Error("Choose a valid video frame.");
  const key = `${upload.id}:${frameIndex}`;
  const recipe = JSON.stringify(promptBox);
  const prev = boxCache.get(key);
  throwIfCancelled(signal);
  if (prev?.kind === "box" && prev.recipe === recipe && prev.result.frameWidth === upload.width && prev.result.frameHeight === upload.height) {
    return { result: prev.result, frameIndex, cached: true };
  }
  const requestKey = `${actorId || ''}:${key}:${recipe}`;
  const existing = !signal && boxRequests.get(requestKey);
  if (existing) return { ...await existing, cached: true };
  const request = (async () => {
    const frameBuffer = await readStill(dataDir, upload, frameIndex);
    throwIfCancelled(signal);
    const result = await (_detectBox || detectBox)(frameBuffer, upload.width, upload.height, promptBox, { signal, onRequest });
    throwIfCancelled(signal);
    result.selectionToken = randomUUID();
    result.framePngBase64 = frameBuffer.toString("base64");
    if (!signal || !boxCache.has(key)) boxCache.set(key, { kind: "box", result, frameIndex, promptBox, recipe });
    return { result, frameIndex, cached: false };
  })();
  if (signal) return request;
  boxRequests.set(requestKey, request);
  try { return await request; }
  finally { if (boxRequests.get(requestKey) === request) boxRequests.delete(requestKey); }
}

export function cachedDetect(uploadId, frameIndex) {
  return cache.get(`${uploadId}:${frameIndex}`) || null;
}

// Immutable selection snapshot (selected-object identity correctness).
// Built ONCE at enqueue from the server's exact cached detect for
// upload+seed frame. Shape (small, JSON):
//   { version:1, uploadId, frameIndex, seedTime, frameWidth, frameHeight,
//     objects:[{ id, label, box:{left,top,right,bottom} }] }
// Boxes are normalized 0..1 (detect result.objects space). Never trust
// client-supplied geometry; never re-resolve a persisted numeric id against
// a different detect ordering (ids reshuffle after cache expiry). Returns
// null when the cache is missing/stale or an id is unknown — the caller
// must reject with SELECTION_STALE_TEXT before any spend, never substitute.
export function snapshotFromCache(upload, seedTime, objectIds, selectionToken) {
  const ids = (Array.isArray(objectIds) ? objectIds : []).map(Number).filter(Number.isFinite);
  if (!ids.length) return null;
  const time = Number(seedTime) || 0;
  const frameIndex = frameIndexFor(upload, time);
  const entry = selectionToken ? boxCache.get(`${upload.id}:${frameIndex}`) : cachedDetect(upload.id, frameIndex);
  const objects = entry?.result?.objects;
  if (!Array.isArray(objects) || !objects.length) return null;
  const visual = entry.kind === "box";
  if (visual ? selectionToken !== entry.result.selectionToken || ids.length !== 1 || ids[0] !== 1 : Boolean(selectionToken)) return null;
  const byId = new Map(objects.map((o) => [Number(o?.id), o]));
  const picked = [];
  for (const id of ids) {
    const found = byId.get(Number(id));
    const box = found?.box;
    if (!found || typeof found.label !== "string" || !box) return null;
    const { left, top, right, bottom } = box;
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    if (!(left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top)) return null;
    picked.push({ id: Number(id), ...(visual ? {} : { label: found.label }), box: { left, top, right, bottom } });
  }
  return {
    version: visual ? 2 : 1,
    ...(visual ? { promptBox: { ...entry.promptBox } } : {}),
    uploadId: upload.id,
    frameIndex,
    seedTime: Math.max(0, time),
    frameWidth: entry.result.frameWidth,
    frameHeight: entry.result.frameHeight,
    objects: picked,
  };
}

// Parse a persisted snapshot string. Returns the snapshot object or null
// when missing/malformed — the caller must treat null as stale (re-pick).
export function parseSelectionSnapshot(text) {
  if (!text) return null;
  try {
    const snap = typeof text === "string" ? JSON.parse(text) : text;
    if (!snap || ![1, 2].includes(snap.version) || !Array.isArray(snap.objects) || !snap.objects.length) return null;
    if (snap.version === 2) {
      requireImageBox(snap.promptBox, snap.frameWidth, snap.frameHeight);
      if (snap.objects.length !== 1 || snap.objects[0]?.id !== 1) return null;
    }
    for (const o of snap.objects) {
      if (!o || (snap.version === 1 && (typeof o.label !== "string" || !o.label)) || !o.box) return null;
      const { left, top, right, bottom } = o.box;
      if (![left, top, right, bottom].every(Number.isFinite)) return null;
      if (!(left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top)) return null;
    }
    if (!Number.isInteger(snap.frameIndex) || snap.frameIndex < 0) return null;
    if (typeof snap.uploadId !== "string" || !snap.uploadId) return null;
    return snap;
  } catch {
    return null;
  }
}

// Test-only seeder: writes a cache entry without SAM so fixtures can seed
// the exact cached detect before enqueueing a selection job.
export function __seedDetectCache(uploadId, frameIndex, result) {
  const objectsById = new Map((result?._internal?.accepted || []).map((c, i) => [i + 1, c]));
  cache.set(`${uploadId}:${frameIndex}`, {
    result, objectsById, frameIndex,
    concepts: [], extraConcepts: [], baseKey: "test", base: [],
  });
}

export const publicDetect = (result, frameIndex) => ({
  frameIndex,
  frameWidth: result.frameWidth,
  frameHeight: result.frameHeight,
  objects: result.objects,
  indexMapPngBase64: result.indexMapPngBase64,
  ...(result.selectionToken ? { selectionToken: result.selectionToken, framePngBase64: result.framePngBase64 } : {}),
});
