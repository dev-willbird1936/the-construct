import fs from "node:fs/promises";
import path from "node:path";
import { parseVideoStream, recordsOfKind } from "@meta-sam/parser";
import { client } from "./meta.js";
import { cancelledError, sleepAbortable, throwIfCancelled } from "./cancel.js";
import { upscaleMask, maskIoU } from "./compose.js";
import { parseTrackedVideo } from "./sam-image-result.mjs";
import { makeVideoSeed } from "./sam-video-seed.mjs";
import { requireSelectedMask, selectedVideoCandidates } from "./selected-video-result.mjs";
import { decodeFramesRgb, cutoutPng, emptyPng } from "./lite-decode.js";

const SEED_SEARCH_WINDOW = 3;
export const MAX_TRACK_FRAMES = 320; // ~10s at 30fps; keeps clip length + cost bounded, per SAM drift warning
const MAX_SLICES = 90;
// Slices stay at SOURCE resolution (uploads are <=1280 on the long side).
// They used to be downscaled to 640 wide, which threw away half the subject's
// pixels before the atlas upscaled each pose 2-7x into its cell.
const SLICE_CONCURRENCY = 4;

// A pass over a whole clip streams for a minute or more; a dropped connection part-way is routine.
// Retry the whole pass (it is idempotent) a couple of times before giving up.
// Shutdown cancels instead of retrying: the signal is checked before every
// attempt and the pause between attempts aborts promptly.
const SAM_ATTEMPTS = 3;
async function withRetries(run, { signal } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    throwIfCancelled(signal);
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      if (attempt >= SAM_ATTEMPTS) throw error;
      console.warn(`SAM pass failed (${error.code || error.message}); retrying ${attempt}/${SAM_ATTEMPTS - 1}`);
      await sleepAbortable(2000 * attempt, signal);
    }
  }
}

// SAM may have been shown a downscaled copy of the clip: its masks and boxes are in that copy's
// pixels. Bring them back to the source frame's.
function resizeMask(mask, fromW, fromH, toW, toH) {
  if (fromW === toW && fromH === toH) return mask;
  const out = new Uint8Array(toW * toH);
  for (let y = 0; y < toH; y += 1) {
    const row = Math.min(fromH - 1, Math.floor((y * fromH) / toH)) * fromW;
    for (let x = 0; x < toW; x += 1) out[y * toW + x] = mask[row + Math.min(fromW - 1, Math.floor((x * fromW) / toW))];
  }
  return out;
}
const scaleBox = (b, sx, sy) => ({ left: b.left * sx, top: b.top * sy, right: b.right * sx, bottom: b.bottom * sy });

function boxIoU(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const areaA = (a.right - a.left) * (a.bottom - a.top);
  const areaB = (b.right - b.left) * (b.bottom - b.top);
  return intersection / (areaA + areaB - intersection);
}

function evenIndices(count, limit) {
  if (count <= limit) return Array.from({ length: count }, (_, i) => i);
  return Array.from({ length: limit }, (_, i) => Math.round((i * (count - 1)) / (limit - 1)));
}

export async function generateVolume({
  videoPath,
  fileId,
  concept,
  frameWidth,
  frameHeight,
  fps,
  seedFrameIndex,
  samWidth = frameWidth, // the size SAM saw the clip at
  samHeight = frameHeight,
  samOffset = 0, // fileId holds a cut that starts at this source frame; SAM's frame k is source frame k + samOffset
  chosenMask,
  chosenBox,
  jobDir,
  signal,
  selectedSeed = false,
  sourceFrames,
  // Proven strided cut for an explicit seed (runner's buildSamSegment):
  // segment frame k IS source frame start + k*stride, start = the seed frame.
  // The seed is then prompted at segment frame 0 at the source size.
  samSegment = null,
  // First source row of a burnt-in data bar (lite-decode.js detectOsdBar):
  // cut-outs end above it, the bar's lettering is never subject pixels.
  cropBottom = null,
}) {
  throwIfCancelled(signal);
  const segment = selectedSeed && samSegment ? samSegment : null;
  if (segment && !(segment.start === seedFrameIndex && Number.isSafeInteger(segment.stride) && segment.stride >= 1 &&
      Number.isSafeInteger(segment.count) && segment.count >= 2 && samOffset === 0)) {
    throw new Error("Selected tracking segment does not start at the seed frame.");
  }
  const samStride = segment ? segment.stride : 1;
  const seed = selectedSeed ? makeVideoSeed(segment ? {
    box: chosenBox, frameIndex: 0, frames: segment.count, width: frameWidth, height: frameHeight,
    samWidth, samHeight, samOffset: 0,
  } : {
    box: chosenBox, frameIndex: seedFrameIndex, frames: sourceFrames, width: frameWidth, height: frameHeight,
    samWidth, samHeight, samOffset,
  }) : null;
  if (seed) requireSelectedMask(chosenMask, frameWidth, frameHeight);
  const request = async () => {
    const events = await client.responses.create({
      model: "sam-3.1",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: seed ? seed.text : concept },
            { type: "input_video", file_id: fileId },
          ],
        },
      ],
      stream: true,
      ...(seed ? { metadata: { propagation_direction: seed.propagation } } : {}),
    }, seed ? { ...(signal ? { signal } : {}), maxRetries: 0 } : signal ? { signal } : undefined);
    return seed ? parseTrackedVideo(events) : parseVideoStream(events).finalResult;
  };
  // One attempt for an explicit seed; a failed/unusable response must not silently buy another pass.
  const tSam = Date.now();
  const result = seed ? await request() : await withRetries(request, { signal });
  const tSamDone = Date.now();
  // The streaming pass is the spending step; stop before the long local
  // frame extraction when shutdown arrived mid-pass.
  throwIfCancelled(signal);
  const masks = recordsOfKind(result.records, "mask");
  const boxes = recordsOfKind(result.records, "box");
  const selected = seed ? selectedVideoCandidates(result, seed, chosenMask) : null;
  // Seeded results are keyed in SAM's frame space; bring them to source frames.
  const byFrame = selected
    ? (segment ? new Map([...selected.byFrame].map(([k, v]) => [segment.start + k * segment.stride, v])) : selected.byFrame)
    : new Map();
  if (!seed) for (const mask of masks) {
    const samIndex = mask.frame?.frameIndex;
    if (samIndex === undefined) continue;
    const box = boxes.find(b => b.frame?.frameIndex === samIndex && b.objectId === mask.objectId);
    if (!box) continue;
    const frameIndex = samIndex + samOffset;
    if (!byFrame.has(frameIndex)) byFrame.set(frameIndex, []);
    byFrame.get(frameIndex).push({ objectId: mask.objectId, mask, box });
  }

  let best = selected?.best || null;
  if (!seed) for (let offset = -SEED_SEARCH_WINDOW; offset <= SEED_SEARCH_WINDOW; offset += 1) {
    const candidates = byFrame.get(seedFrameIndex + offset);
    if (!candidates) continue;
    for (const candidate of candidates) {
      const candidateMask = resizeMask(upscaleMask(candidate.mask, samWidth, samHeight), samWidth, samHeight, frameWidth, frameHeight);
      const score = Math.max(maskIoU(chosenMask, candidateMask), boxIoU(chosenBox, scaleBox(candidate.box, frameWidth / samWidth, frameHeight / samHeight)));
      if (!best || score > best.score) {
        best = { objectId: candidate.objectId, score, frameIndex: seedFrameIndex + offset };
      }
    }
  }
  if (!best || best.score <= 0) {
    throw new Error("Could not match the selected object in the video pass. Try a different frame or object.");
  }

  const lastAvailableFrame = Math.max(...byFrame.keys());
  const trackEnd = Math.min(lastAvailableFrame, seedFrameIndex + MAX_TRACK_FRAMES - 1);
  const trackedRange = [];
  for (let frameIndex = seedFrameIndex; frameIndex <= trackEnd; frameIndex += samStride) {
    const candidates = byFrame.get(frameIndex);
    const match = candidates?.find((c) => c.objectId === best.objectId);
    trackedRange.push({ frameIndex, mask: match ? match.mask : null });
  }

  const sliceIndices = evenIndices(trackedRange.length, MAX_SLICES);
  const sliceEntries = sliceIndices.map((i) => trackedRange[i]);

  const tSel = Date.now();
  const outDir = path.join(jobDir, "slices");
  await fs.mkdir(outDir, { recursive: true });

  // One streaming decode of exactly the slice frames (no per-frame PNG
  // round trip through disk), cut-outs built while the decoder runs.
  const wanted = sliceEntries.filter((e) => e.mask).map((e) => e.frameIndex);
  const built = new Map();
  const inflight = new Set();
  const build = async (index, rgb) => {
    const entry = sliceEntries.find((e) => e.frameIndex === index);
    const mask = resizeMask(upscaleMask(entry.mask, samWidth, samHeight), samWidth, samHeight, frameWidth, frameHeight);
    if (cropBottom > 0 && cropBottom < frameHeight) mask.fill(0, cropBottom * frameWidth);
    built.set(index, await cutoutPng(rgb, mask, frameWidth, frameHeight));
  };
  for await (const { index, rgb } of decodeFramesRgb(videoPath, wanted, { width: frameWidth, height: frameHeight, signal })) {
    const job = build(index, rgb).finally(() => inflight.delete(job));
    inflight.add(job);
    if (inflight.size >= SLICE_CONCURRENCY) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  throwIfCancelled(signal);
  const tExtract = Date.now();

  let blank = null;
  const frames = [];
  for (const entry of sliceEntries) {
    const present = Boolean(entry.mask) && built.has(entry.frameIndex);
    const buffer = present ? built.get(entry.frameIndex) : (blank ||= await emptyPng(frameWidth, frameHeight));
    const filename = `frame_${String(entry.frameIndex).padStart(6, "0")}.png`;
    await fs.writeFile(path.join(outDir, filename), buffer);
    frames.push({
      sourceFrameIndex: entry.frameIndex,
      timestamp: fps ? entry.frameIndex / fps : 0,
      url: `slices/${filename}`,
      present,
      buffer,
    });
  }

  console.log(`[lite-timing] generate sam=${tSamDone - tSam} select=${tSel - tSamDone} decode+cutouts=${tExtract - tSel} write=${Date.now() - tExtract} tracked=${trackedRange.length} stride=${samStride} slices=${frames.length}`);
  return {
    schemaVersion: "spacetime.generate.v1",
    concept,
    matchScore: best.score,
    seedFrameIndex,
    ...(seed ? { seedPrompt: { objectId: seed.objectId, frameIndex: seedFrameIndex, sourceFrames,
      samOffset, samWidth, samHeight, box: seed.box, propagation: seed.propagation,
      ...(segment ? { segment: { start: segment.start, stride: segment.stride, count: segment.count } } : {}) } } : {}),
    sliceWidth: frameWidth,
    sliceHeight: frameHeight,
    frames,
  };
}
