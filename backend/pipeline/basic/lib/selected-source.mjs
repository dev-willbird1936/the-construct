import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { makeVideoSeed, requireWholeSeedSource } from '../../../lib/sam-video-seed.mjs';
import { requireSelectedMask } from '../../../lib/selected-video-result.mjs';
import { requireImageBox } from '../../../lib/sam-image-seed.mjs';
import { throwIfCancelled, cancelledError } from '../../../lib/cancel.js';
import { probeVideo } from '../../../lib/ffmpeg.js';
import { liteStride, requireLiteSeedSource, decodeFramesRgb, SEGMENT_MAX_MAD } from '../../../lib/lite-decode.js';

export const BASIC_HANDOFF_TEXT = 'Basic could not validate the selected source. Re-pick the object or try Lite.';
export const BASIC_SPAN_TEXT = 'Basic needs six frames from the selected frame. Pick an earlier frame or try Lite.';
export const BASIC_MASK_TEXT = 'Basic lost the selected mask while resizing. Try Lite or a closer subject.';
export const BASIC_CLOCK_TEXT = 'Basic needs a constant-rate short original clip for a selected subject. Try Lite.';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
const locations = outDir => ({ dir: path.resolve(outDir, '.selection'), json: path.resolve(outDir, '.selection', 'seed.json'), mask: path.resolve(outDir, '.selection', 'mask.png') });

export function requireBasicSelectedSource(source, frameIndex) {
  try { requireWholeSeedSource(source, frameIndex); }
  catch { throw new Error(BASIC_CLOCK_TEXT); }
  if (!Number.isFinite(source.fps) || source.fps <= 0 || source.frames / source.fps > 12 + 1e-6) throw new Error(BASIC_CLOCK_TEXT);
  if (source.frames - frameIndex < 6) throw new Error(BASIC_SPAN_TEXT);
}

function validate(meta) {
  const fields = ['version','sourceSha256','width','height','fps','frames','seedFrameIndex','promptBox','chosenBox','maskSha256'];
  if (!meta || Object.keys(meta).length !== fields.length || Object.keys(meta).some(k => !fields.includes(k))) throw new Error(BASIC_HANDOFF_TEXT);
  if (meta?.version !== 1 || !/^[a-f0-9]{64}$/.test(meta.sourceSha256 || '') || !/^[a-f0-9]{64}$/.test(meta.maskSha256 || '') || !Number.isFinite(meta.fps) || meta.fps <= 0) throw new Error(BASIC_HANDOFF_TEXT);
  requireBasicSelectedSource(meta, meta.seedFrameIndex);
  makeVideoSeed({ box: meta.chosenBox, frameIndex: meta.seedFrameIndex, frames: meta.frames, width: meta.width, height: meta.height, samWidth: meta.width, samHeight: meta.height, samOffset: 0 });
  requireImageBox(meta.promptBox, meta.width, meta.height);
}

// Fixed, server-owned private location: no client path or argv-sized mask.
// Exclusive creation also preserves a prior failed attempt's seed/evidence.
export async function writeBasicSelection({ outDir, videoPath, width, height, fps, frames, seedFrameIndex, promptBox, chosenBox, chosenMask }) {
  requireSelectedMask(chosenMask, width, height);
  const bytes = await sharp(Buffer.from(Uint8Array.from(chosenMask, x => x ? 255 : 0)), { raw: { width, height, channels: 1 } }).png().toBuffer();
  const meta = { version: 1, sourceSha256: sha(await fs.readFile(videoPath)), width, height, fps, frames, seedFrameIndex, promptBox, chosenBox, maskSha256: sha(bytes) };
  validate(meta);
  const loc = locations(outDir);
  await fs.mkdir(loc.dir);
  await fs.writeFile(loc.mask, bytes, { flag: 'wx' });
  await fs.writeFile(loc.json, JSON.stringify(meta), { flag: 'wx' });
  return meta;
}

export async function readBasicSelection(outDir, videoPath, info) {
  try {
    const loc = locations(outDir);
    const root = await fs.realpath(outDir);
    if (await fs.realpath(loc.dir) !== path.join(root, '.selection')) throw new Error();
    for (const [file, max] of [[loc.json, 65536], [loc.mask, 8 * 1024 * 1024]]) {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || stat.size < 1) throw new Error();
    }
    const meta = JSON.parse(await fs.readFile(loc.json, 'utf8'));
    validate(meta);
    if (meta.width !== info.width || meta.height !== info.height || meta.fps !== info.fps || meta.frames !== info.frameCount || meta.sourceSha256 !== sha(await fs.readFile(videoPath))) throw new Error();
    const bytes = await fs.readFile(loc.mask);
    if (sha(bytes) !== meta.maskSha256) throw new Error();
    const { data, info: raw } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    if (raw.width !== meta.width || raw.height !== meta.height || ![1,3].includes(raw.channels)) throw new Error();
    const chosenMask = new Uint8Array(meta.width * meta.height);
    for (let i = 0; i < chosenMask.length; i++) {
      const value = data[i * raw.channels];
      if (![0,255].includes(value)) throw new Error();
      for (let c = 1; c < raw.channels; c++) if (data[i * raw.channels + c] !== value) throw new Error();
      chosenMask[i] = value ? 1 : 0;
    }
    requireSelectedMask(chosenMask, meta.width, meta.height);
    return { ...meta, chosenMask };
  } catch { throw new Error(BASIC_HANDOFF_TEXT); }
}

export function validateBasicClock(timestamps, fps, frames) {
  if (!Array.isArray(timestamps) || timestamps.length !== frames || !Number.isFinite(fps) || fps <= 0 || frames < 1 || frames > 350) throw new Error(BASIC_CLOCK_TEXT);
  const times = timestamps.map(t => typeof t === 'string' && t.trim() !== '' ? Number(t) : NaN);
  if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= times[i - 1]) || Math.abs((t - times[0]) - i / fps) > .00001)) throw new Error(BASIC_CLOCK_TEXT);
  return { kind: 'cfr', fps, frames, indexDomain: 'source-frame', timeOrigin: 'decode-frame-zero' };
}

// Count actual decoded frame PTS, not duration*averageFPS. Output/time bounded;
// unsupported/variable clocks refuse before the native SAM spending step.
export async function probeBasicClock(videoPath, fps, frames, { signal } = {}) {
  throwIfCancelled(signal);
  try {
    const { stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',videoPath], { timeout: 20000, maxBuffer: 256 * 1024, ...(signal ? { signal } : {}) });
    return validateBasicClock(JSON.parse(stdout).frames?.map(f => f.best_effort_timestamp_time), fps, frames);
  } catch {
    if (signal?.aborted) throw cancelledError();
    throw new Error(BASIC_CLOCK_TEXT);
  }
}

// ── Loop 8 (tier-improve 2026-11-04): long or variable-rate box selections ──
// Phone video arrives long (uploads allow 60 s) and often variable-rate; the
// whole-source contract above (<=350 frames, <=12 s, exact constant rate)
// refused it before any spend. Such a clip now gets a constant-rate cut that
// starts at the clicked frame (selected tracking propagates forward only):
// the same frame-exact stride Lite tracks (liteStride, about 15 frames a
// second, Basic's legacy sample rate), at most 12 s and 350 frames, at the
// source size, so the image box and mask carry over exactly as cut frame 0.
// The cut is restamped to an exact constant rate and its first and last
// frames are proven against the source decode (Lite's alignment rule).
const BASIC_CUT_SECONDS = 12;
const BASIC_CUT_MAX_FRAMES = 350;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

export function basicCutPlan(upload, seedFrameIndex) {
  try { requireLiteSeedSource(upload, seedFrameIndex); } catch { throw new Error(BASIC_CLOCK_TEXT); }
  if (!Number.isFinite(upload.fps) || upload.fps <= 0) throw new Error(BASIC_CLOCK_TEXT);
  const stride = liteStride(upload.fps);
  const num0 = Math.round((upload.fps / stride) * 1000), g = gcd(num0, 1000);
  const rate = { num: num0 / g, den: 1000 / g };
  const fps = rate.num / rate.den;
  const most = Math.min(BASIC_CUT_MAX_FRAMES, Math.floor(BASIC_CUT_SECONDS * fps + 1e-9));
  const count = Math.min(most, Math.floor((upload.frames - 1 - seedFrameIndex) / stride) + 1);
  if (!(count >= 6)) throw new Error(BASIC_SPAN_TEXT);
  return { start: seedFrameIndex, stride, count, rate };
}

// Submit-time rule for a Basic box selection: the whole clip as before, or a
// cut that can hold six frames from the clicked one.
export function requireBasicSeedSource(upload, seedFrameIndex) {
  try { requireBasicSelectedSource(upload, seedFrameIndex); return; }
  catch (error) { if (error?.message === BASIC_SPAN_TEXT) throw error; }
  basicCutPlan(upload, seedFrameIndex);
}

async function greyThumb(rgb, width, height) {
  return sharp(rgb, { raw: { width, height, channels: 3 } }).resize(160, 90, { fit: 'fill' }).greyscale().raw().toBuffer();
}
const meanAbs = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]); return s / a.length; };
async function framesAt(videoPath, indices, width, height, signal) {
  const out = new Map();
  for await (const { index, rgb } of decodeFramesRgb(videoPath, indices, { width, height, signal })) out.set(index, await greyThumb(rgb, width, height));
  return out;
}

// Builds and proves the cut. Returns the selection source fields for it
// ({ videoPath, fps, frames, seedFrameIndex: 0, cut }) or throws
// BASIC_CLOCK_TEXT / BASIC_SPAN_TEXT; never a silent whole-clip fallback.
export async function buildBasicCut(videoPath, upload, plan, outPath, { signal, crf = 17 } = {}) {
  throwIfCancelled(signal);
  const { start, stride, count, rate } = plan;
  const select = `select='gte(n\,${start})*not(mod(n-${start}\,${stride}))',settb=${rate.den}/${rate.num},setpts=N`;
  try {
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-i', videoPath, '-vf', select, '-fps_mode', 'cfr', '-r', `${rate.num}/${rate.den}`,
      '-frames:v', String(count), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', outPath],
      { timeout: 120000, windowsHide: true, ...(signal ? { signal } : {}) });
  } catch {
    if (signal?.aborted) throw cancelledError();
    throw new Error(BASIC_CLOCK_TEXT);
  }
  throwIfCancelled(signal);
  const info = await probeVideo(outPath).catch(() => null);
  if (!info || info.width !== upload.width || info.height !== upload.height) throw new Error(BASIC_CLOCK_TEXT);
  const frames = info.frameCount;
  if (!(frames >= 6)) throw new Error(BASIC_SPAN_TEXT);
  if (frames > count) throw new Error(BASIC_CLOCK_TEXT);
  const last = frames - 1;
  let src, cut;
  try {
    [src, cut] = await Promise.all([
      framesAt(videoPath, [start, start + last * stride], upload.width, upload.height, signal),
      framesAt(outPath, [0, last], upload.width, upload.height, signal),
    ]);
  } catch {
    if (signal?.aborted) throw cancelledError();
    throw new Error(BASIC_CLOCK_TEXT);
  }
  const d0 = src.has(start) && cut.has(0) ? meanAbs(src.get(start), cut.get(0)) : Infinity;
  const d1 = src.has(start + last * stride) && cut.has(last) ? meanAbs(src.get(start + last * stride), cut.get(last)) : Infinity;
  if (!(d0 <= SEGMENT_MAX_MAD && d1 <= SEGMENT_MAX_MAD)) throw new Error(BASIC_CLOCK_TEXT);
  await probeBasicClock(outPath, info.fps, frames, { signal });
  requireBasicSelectedSource({ frames, width: info.width, height: info.height, fps: info.fps }, 0);
  return { videoPath: outPath, fps: info.fps, frames, seedFrameIndex: 0,
    cut: { start, stride, frames, sourceFps: upload.fps, mad: [Number(d0.toFixed(2)), Number(d1.toFixed(2))] } };
}
