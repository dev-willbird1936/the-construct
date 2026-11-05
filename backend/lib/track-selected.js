import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { client } from './meta.js';
import { parseTrackedVideo } from './sam-image-result.mjs';
import { makeVideoSeed, VIDEO_SEED_NO_MATCH } from './sam-video-seed.mjs';
import { requireSelectedMask, selectedVideoCandidates } from './selected-video-result.mjs';
import { upscaleMask } from './compose.js';
import { throwIfCancelled, cancelledError } from './cancel.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const combined = (signal, ms) => AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);
export const SELECTED_TRACK_TIMEOUT = 'Selected tracking timed out. Re-pick or try a shorter clip.';
const timedOut = () => Object.assign(new Error(SELECTED_TRACK_TIMEOUT), { code: 'SELECTED_TRACK_TIMEOUT', retryable: false });

// Native selected component, deliberately separate from legacy chunking/cache.
// Caller supplies a fresh owned output directory and an already verified image
// handoff. Nothing here accepts a semantic concept or a numeric image ID.
export async function trackSelectedInstance({ videoPath, sourceSha256, outDir, width, height, fps, frames, seedFrameIndex, chosenBox, chosenMask, signal }) {
  throwIfCancelled(signal);
  const seed = makeVideoSeed({ box: chosenBox, frameIndex: seedFrameIndex, frames, width, height, samWidth: width, samHeight: height, samOffset: 0 });
  requireSelectedMask(chosenMask, width, height);
  if (!Number.isFinite(fps) || fps <= 0 || typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error(VIDEO_SEED_NO_MATCH);
  const sourceBytes = await fsp.readFile(videoPath);
  if (sha(sourceBytes) !== sourceSha256) throw new Error(VIDEO_SEED_NO_MATCH);
  throwIfCancelled(signal);
  // Refuse an occupied directory BEFORE spending; never overwrite paid evidence.
  await fsp.mkdir(outDir);
  await fsp.mkdir(path.join(outDir, 'labels'));
  const evidence = await fsp.open(path.join(outDir, 'segmentation-events.jsonl'), 'wx');
  let owned, result, deleted = false;
  const stats = { events: 0, serializedBytes: 0, cleanup: 'not-dispatched', clientCalls: { upload: 0, video: 0, cleanup: 0 }, sourceSha256, seedFrameIndex, fps, width, height, frames, clientRetries: 0, providerInternalAttempts: null, billing: 'unknown', evidence: 'native output lane text/types only; not raw HTTP' };
  try {
    throwIfCancelled(signal);
    stats.cleanup = 'ownership-unknown';
    stats.clientCalls.upload++;
    const uploadSignal = combined(signal, 25000);
    let upload;
    try {
      upload = await client.files.create({ purpose: 'user_data', file: new File([sourceBytes], `${sourceSha256.slice(0, 16)}-${path.basename(videoPath)}`) }, { maxRetries: 0, signal: uploadSignal });
    } catch (error) {
      if (!signal?.aborted && uploadSignal.aborted) { stats.timedOut = 'upload'; throw timedOut(); }
      throw error;
    }
    if (typeof upload?.id !== 'string' || !upload.id) throw new Error('Selected upload returned no owned file.');
    owned = upload.id;
    stats.cleanup = 'pending';
    let streamSignal;
    try {
      // A forced child-process kill cannot run finally. Retain the exact owned
      // id privately so recovery can distinguish unknown cleanup from success.
      await fsp.writeFile(path.join(outDir, 'owned-upload.json'), JSON.stringify({ id: owned, sourceSha256, filename: `${sourceSha256.slice(0, 16)}-${path.basename(videoPath)}`, cleanupEvidence: 'attempt.json; absent means unknown' }), { flag: 'wx' });
      throwIfCancelled(signal);
      streamSignal = combined(signal, 120000);
      stats.clientCalls.video++;
      const events = await client.responses.create({ model: 'sam-3.1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: seed.text }, { type: 'input_video', file_id: owned }] }], stream: true, metadata: { propagation_direction: seed.propagation } }, { maxRetries: 0, signal: streamSignal });
      async function* captured() {
        for await (const event of events) {
          throwIfCancelled(signal);
          if (streamSignal.aborted) throw timedOut();
          stats.events++;
          stats.serializedBytes += Buffer.byteLength(JSON.stringify(event));
          if (stats.events > 2000000 || stats.serializedBytes > 64 * 1024 * 1024) throw new Error('Selected segmentation evidence exceeded its bound.');
          const lane = { type: event.type };
          if (typeof event.text === 'string') lane.text = event.text;
          if (typeof event.delta === 'string') lane.delta = event.delta;
          await evidence.write(JSON.stringify(lane) + '\n');
          yield event;
        }
      }
      result = await parseTrackedVideo(captured());
      await fsp.writeFile(path.join(outDir, 'segmentation-result.json'), JSON.stringify(result), { flag: 'wx' });
    } catch (error) {
      if (!signal?.aborted && streamSignal?.aborted) { stats.timedOut = 'stream'; throw timedOut(); }
      throw error;
    } finally {
      // Independent owned cleanup BEFORE validation/PNG CPU, even on cancellation.
      try {
        stats.clientCalls.cleanup++;
        const receipt = await client.files.del(owned, { maxRetries: 0, signal: AbortSignal.timeout(10000) });
        deleted = receipt?.deleted === true;
        stats.cleanup = deleted ? 'confirmed' : 'unconfirmed';
      } catch { stats.cleanup = 'failed'; }
    }
    throwIfCancelled(signal);
    if (!deleted) throw new Error('Selected upload cleanup was not confirmed.');
    const { byFrame } = selectedVideoCandidates(result, seed, chosenMask);
    const observed = [];
    for (const [index, [candidate]] of [...byFrame].sort((a, b) => a[0] - b[0])) {
      throwIfCancelled(signal);
      const raster = upscaleMask(candidate.mask, width, height);
      // One plain pass builds the 0/1 label and the empty check together:
      // Uint8Array.from with a map callback cost ~130 ms per 1280x720 frame
      // (11-19 s per box-path job). Same bytes; an empty raster is still skipped.
      const label = new Uint8Array(raster.length);
      let any = false;
      for (let i = 0; i < raster.length; i += 1) if (raster[i]) { label[i] = 1; any = true; }
      if (!any) continue;
      await sharp(Buffer.from(label), { raw: { width, height, channels: 1 } }).png().toFile(path.join(outDir, 'labels', `l${String(index).padStart(5, '0')}.png`));
      observed.push(index);
    }
    const seen = new Set(observed);
    const unverifiedFrames = Array.from({ length: frames - seedFrameIndex }, (_, i) => i + seedFrameIndex).filter(i => !seen.has(i));
    const tracks = { fps, start: 0, samples: frames, width, height, sourceSha256, indexDomain: 'source-frame', seedFrameIndex, processedRange: { first: seedFrameIndex, last: frames - 1 }, unprocessedFrames: Array.from({ length: seedFrameIndex }, (_, i) => i), observedFrames: observed, unverifiedFrames, tracks: [{ id: 1, first: observed[0], last: observed.at(-1), frames: observed.length }], chunks: [] };
    await fsp.writeFile(path.join(outDir, 'tracks.json'), JSON.stringify(tracks), { flag: 'wx' });
    return tracks;
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw error;
  } finally {
    try { await evidence.close(); }
    finally { await fsp.writeFile(path.join(outDir, 'attempt.json'), JSON.stringify(stats), { flag: 'wx' }); }
  }
}
