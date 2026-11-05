// Lite-only video helpers: one streaming decode for the slice frames, full-
// resolution cut-out PNGs, and the strided SAM segment (with a frame-
// alignment proof). No models, no network; ffmpeg + sharp only.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import sharp from "sharp";
import { cancelledError } from "./cancel.js";
import { requireWholeSeedSource, VIDEO_SEED_UNSUPPORTED } from "./sam-video-seed.mjs";

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";

function runFfmpeg(args, { signal, stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const child = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let stderr = "";
    const out = [];
    child.stderr.on("data", (c) => { stderr += c; if (stderr.length > 4000) stderr = stderr.slice(-2000); });
    if (stdout) child.stdout.on("data", (c) => out.push(c));
    const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { signal?.removeEventListener("abort", onAbort); reject(e); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(cancelledError());
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-600)}`));
    });
  });
}

// Decode-order frames `indices` (ascending, unique) as packed RGB24 at the
// source size, streamed: yields {index, rgb} in order. ffmpeg's select=n is
// the same decode-order index SAM and extractFrame use. Memory stays bounded:
// stdout pauses while two frames are waiting for the consumer.
export async function* decodeFramesRgb(videoPath, indices, { width, height, signal } = {}) {
  const want = [...new Set(indices.map(Number))].filter(Number.isSafeInteger).sort((a, b) => a - b);
  if (!want.length) return;
  const frameBytes = width * height * 3;
  const select = want.map((i) => `eq(n\\,${i})`).join("+");
  const child = spawn(FFMPEG_BIN, ["-v", "error", "-i", videoPath, "-vf", `select='${select}'`,
    "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true });
  const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
  signal?.addEventListener("abort", onAbort, { once: true });
  const ready = [];
  let pendingBuf = [], pendingLen = 0, ended = false, failed = null, wake = null, stderr = "";
  const notify = () => { const w = wake; wake = null; w?.(); };
  child.stderr.on("data", (c) => { stderr += c; if (stderr.length > 4000) stderr = stderr.slice(-2000); });
  child.stdout.on("data", (chunk) => {
    pendingBuf.push(chunk);
    pendingLen += chunk.length;
    while (pendingLen >= frameBytes) {
      const all = Buffer.concat(pendingBuf);
      ready.push(all.subarray(0, frameBytes));
      const rest = all.subarray(frameBytes);
      pendingBuf = rest.length ? [rest] : [];
      pendingLen = rest.length;
    }
    if (ready.length >= 2) child.stdout.pause();
    notify();
  });
  child.on("error", (e) => { failed = e; notify(); });
  child.on("close", (code) => {
    ended = true;
    if (code !== 0 && !signal?.aborted && !failed) failed = new Error(`ffmpeg decode exited with code ${code}: ${stderr.slice(-400)}`);
    notify();
  });
  try {
    let k = 0;
    for (;;) {
      if (signal?.aborted) throw cancelledError();
      if (ready.length) {
        const rgb = ready.shift();
        if (ready.length < 2) child.stdout.resume();
        if (k < want.length) yield { index: want[k], rgb: Buffer.from(rgb) };
        k += 1;
        continue;
      }
      if (failed) throw failed;
      if (ended) break;
      await new Promise((r) => { wake = r; });
    }
    if (signal?.aborted) throw cancelledError();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
}

// Full-resolution RGBA cut-out: observed source pixels inside the SAM mask,
// transparent black elsewhere. PNG at a fast compression level (these are
// working files: the atlas re-encodes the few cells it keeps).
export async function cutoutPng(rgb, mask, width, height) {
  const n = width * height;
  const rgba = Buffer.alloc(n * 4);
  for (let p = 0, s = 0, o = 0; p < n; p += 1, s += 3, o += 4) {
    if (!mask[p]) continue;
    rgba[o] = rgb[s];
    rgba[o + 1] = rgb[s + 1];
    rgba[o + 2] = rgb[s + 2];
    rgba[o + 3] = 255;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
}

export async function emptyPng(width, height) {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png({ compressionLevel: 1 }).toBuffer();
}

// Tracking rate for SAM: ~15 fps is plenty for a chronophotograph (the
// atlas keeps <=7 poses + a short live tail) and SAM time scales with the
// frames sent (measured ~10 frames/s + ~2 s start). 30 fps -> every 2nd
// frame, 60 fps -> every 4th, <=22 fps -> every frame.
export function liteStride(fps) {
  const f = Number(fps);
  if (!(f > 0)) return 1;
  return Math.max(1, Math.round(f / 15));
}

async function grayThumbs(videoPath, indices, signal) {
  const W = 160, H = 90;
  const select = indices.map((i) => `eq(n\\,${i})`).join("+");
  const buf = await runFfmpeg(["-v", "error", "-i", videoPath, "-vf", `select='${select}',scale=${W}:${H},format=gray`,
    "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { signal, stdout: true });
  const out = [];
  for (let i = 0; i + W * H <= buf.length; i += W * H) out.push(buf.subarray(i, i + W * H));
  return out;
}
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]); return s / a.length; };

// SAM segment for an explicit seed: source frames start, start+stride, ...
// (count frames) re-encoded at the SOURCE size, so segment frame k is source
// frame start + k*stride. Proven before use: the segment's first and last
// frames must match the source decode of those exact indices (mean abs grey
// diff <= maxMad at 160x90), and the frame count must be exact. Any doubt ->
// null (the caller keeps the whole-clip path).
export const SEGMENT_MAX_MAD = 3;
// crf 25: about the source's own bitrate (crf 20 re-spent bits on the
// source's compression noise: grizzly 5.7 MB -> 3.6 MB for 90 frames), so
// the upload to Meta is ~35% smaller.
export async function buildSamSegment(videoPath, { start, stride, count, outPath, signal, crf = 25, maxMad = SEGMENT_MAX_MAD }) {
  if (!(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(stride) && stride >= 1 && Number.isSafeInteger(count) && count >= 2)) return null;
  const sel = `select='gte(n\\,${start})*not(mod(n-${start}\\,${stride}))'`;
  const last = start + (count - 1) * stride;
  // The source half of the proof does not need the segment: decode it while
  // the segment encodes.
  const srcThumbs = grayThumbs(videoPath, [start, last], signal);
  srcThumbs.catch(() => {});
  await runFfmpeg(["-y", "-v", "error", "-i", videoPath, "-vf", sel, "-fps_mode", "passthrough",
    "-frames:v", String(count), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-pix_fmt", "yuv420p", outPath], { signal });
  // -frames:v caps any surplus; a short segment (the clip ran out early)
  // fails the two-frame decode below and the caller keeps the whole clip.
  const [seg, src] = await Promise.all([grayThumbs(outPath, [0, count - 1], signal), srcThumbs]);
  if (seg.length !== 2 || src.length !== 2) return { ok: false, reason: "decode" };
  const d0 = mad(seg[0], src[0]), d1 = mad(seg[1], src[1]);
  if (!(d0 <= maxMad && d1 <= maxMad)) return { ok: false, reason: `alignment ${d0.toFixed(2)}/${d1.toFixed(2)}` };
  const size = (await fs.stat(outPath)).size;
  return { ok: true, path: outPath, start, stride, count, mad: [Number(d0.toFixed(2)), Number(d1.toFixed(2))], bytes: size };
}

// Lite selected-source contract. Clips up to 350 frames keep the whole-
// source rule unchanged. Longer clips (uploads allow 60 s) used to be
// refused at job submit; Lite tracks a frame-exact strided cut from the seed
// frame (at most MAX_TRACK_FRAMES source frames, buildSamSegment proves the
// alignment), so a long clip only needs the same size rules and a seed
// inside the clip.
export const LITE_WHOLE_SOURCE_FRAMES = 350;
export function requireLiteSeedSource(upload, seedFrameIndex) {
  const { frames, width, height } = upload || {};
  if (!Number.isSafeInteger(frames) || frames <= LITE_WHOLE_SOURCE_FRAMES) {
    return requireWholeSeedSource({ frames, width, height }, seedFrameIndex);
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 ||
      width > 1280 || width % 2 || height % 2 ||
      !Number.isSafeInteger(seedFrameIndex) || seedFrameIndex < 0 || seedFrameIndex >= frames) {
    throw new Error(VIDEO_SEED_UNSUPPORTED);
  }
}

// Burnt-in data bar (a trail camera's date / temperature strip along the
// bottom). A port of backend/tools/probe-clip.py strip() + letterbox(), same
// constants, measured on the same 5 moments of the clip: a flat bar of one
// colour with a sharp top edge, or rows of hard black-white lettering (a bar
// may be translucent). Returns the share of the height ABOVE the bar, 1 when
// there is none. Only ever a bottom strip of 2-15% of the picture; a clip
// without a bar is never cropped (checked on every corpus clip).
const OSD_W = 640, OSD_H = 360;
const OSD = { MOMENTS: [0.05, 0.25, 0.5, 0.75, 0.95], MAX_STRIP: 0.15, BAND_FLAT: 10, EDGE: 22, MIN_BAR: 0.02,
  TEXT_SHARE: 0.035, TEXT_PAD: 0.02, BLACK: 18 };
const median = (arr) => {
  const s = Float64Array.from(arr).sort();
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
};

// frames: RGB24 buffers, w x h each (the probe works at 320x360 for the flat
// bar and 640x360 for the lettering; 640x360 frames are halved for the bar).
function flatBar(frames, w, h) {
  const found = [];
  for (const f of frames) {
    const half = w / 2;
    const rows = [];
    const col = new Float64Array(half);
    for (let y = 0; y < h; y += 1) {
      const px = [0, 0, 0];
      for (let c = 0; c < 3; c += 1) {
        for (let x = 0; x < half; x += 1) {
          const o = (y * w + 2 * x) * 3 + c;
          col[x] = (f[o] + f[o + 3]) / 2;
        }
        px[c] = median(col);
      }
      rows.push(px);
    }
    const bottom = [0, 1, 2].map((c) => median(rows.slice(-3).map((r) => r[c])));
    const flat = rows.map((r) => Math.max(...r.map((v, c) => Math.abs(v - bottom[c]))) <= OSD.BAND_FLAT);
    let top = h;
    while (top > 0 && flat[top - 1]) top -= 1;
    const bar = h - top;
    const step = top > 0 && top < h ? Math.max(...rows[top - 1].map((v, c) => Math.abs(v - rows[top][c]))) : 0;
    found.push(OSD.MIN_BAR * h <= bar && bar <= OSD.MAX_STRIP * h && step >= OSD.EDGE ? top / h : 1);
  }
  const seen = found.filter((x) => x < 1);
  return seen.length > found.length / 2 ? median(seen) : 1;
}

function textBand(frames, w, h) {
  const shares = frames.map((f) => {
    const out = new Float64Array(h);
    for (let y = 0; y < h; y += 1) {
      let hits = 0;
      let prev = -1;
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 3;
        const g = (f[o] * 4899 + f[o + 1] * 9617 + f[o + 2] * 1868 + 8192) >> 14; // cv2 RGB->GRAY
        if (prev >= 0 && Math.abs(g - prev) > 90) hits += 1;
        prev = g;
      }
      out[y] = hits / (w - 1);
    }
    return out;
  });
  const e = Array.from({ length: h }, (_, y) => median(shares.map((s) => s[y])));
  const zone = Math.floor(h * (1 - OSD.MAX_STRIP));
  const picture = median(e.slice(Math.floor(h * 0.55), zone));
  const limit = Math.max(OSD.TEXT_SHARE, 3 * picture);
  const tall = e.slice(zone).map((v) => v > limit);
  for (let k = 0; k < tall.length - 5; k += 1) {
    if (tall[k] && tall.slice(k, k + 6).filter(Boolean).length >= 3) return Math.max(0, (zone + k) / h - OSD.TEXT_PAD);
  }
  return 1;
}

// The picture inside black letterbox bars (rows only matter here): [y0, y1)
// in rows of the analysed frames, or null under 2% of the height.
function letterboxRows(frames, w, h) {
  let y0 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    let bright = false;
    for (const f of frames) {
      for (let x = 0; x < w && !bright; x += 1) {
        const o = (y * w + x) * 3;
        if (((f[o] * 4899 + f[o + 1] * 9617 + f[o + 2] * 1868 + 8192) >> 14) > OSD.BLACK) bright = true;
      }
      if (bright) break;
    }
    if (bright) { if (y0 < 0) y0 = y; y1 = y + 1; }
  }
  if (y0 < 0 || (y0 + h - y1) < 0.02 * h) return null;
  return [y0, y1];
}

// Share of the frame height above the data bar (1 = no bar) from RGB24
// frames at w x h. Exported for tests.
export function osdTopShare(frames, w = OSD_W, h = OSD_H) {
  if (!frames.length) return 1;
  const lb = letterboxRows(frames, w, h);
  if (!lb) return Math.min(flatBar(frames, w, h), textBand(frames, w, h));
  const [y0, y1] = lb;
  const inner = frames.map((f) => f.subarray(y0 * w * 3, y1 * w * 3));
  const share = Math.min(flatBar(inner, w, y1 - y0), textBand(inner, w, y1 - y0));
  return share < 1 ? (y0 + share * (y1 - y0)) / h : 1;
}

// Decode the probe's 5 moments of the clip at 640x360 (area scaling, like
// cv2 INTER_AREA) and measure. Returns {share, cutY}: cutY is the first
// source row of the bar (even), or null when there is no bar. Never throws
// except on cancellation: a failed probe is "no bar".
export async function detectOsdBar(videoPath, { frames, width, height, signal } = {}) {
  try {
    if (!(frames > 2) || !(width > 0) || !(height > 0)) return { share: 1, cutY: null };
    const idx = [...new Set(OSD.MOMENTS.map((m) => Math.max(0, Math.floor(frames * m) - 1)))].sort((a, b) => a - b);
    const select = idx.map((i) => `eq(n\,${i})`).join("+");
    const buf = await runFfmpeg(["-v", "error", "-i", videoPath, "-vf", `select='${select}',scale=${OSD_W}:${OSD_H}:flags=area,format=rgb24`,
      "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { signal, stdout: true });
    const size = OSD_W * OSD_H * 3;
    const shots = [];
    for (let o = 0; o + size <= buf.length; o += size) shots.push(buf.subarray(o, o + size));
    if (shots.length < 2) return { share: 1, cutY: null };
    const share = osdTopShare(shots);
    if (!(share < 1)) return { share: 1, cutY: null };
    const cutY = Math.max(2, Math.floor((share * height) / 2) * 2);
    return { share: Number(share.toFixed(3)), cutY: cutY < height ? cutY : null };
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    return { share: 1, cutY: null };
  }
}

// The picture above a data bar: the top `rows` rows of an encoded image.
export function cropRows(buffer, width, rows) {
  return sharp(buffer).extract({ left: 0, top: 0, width, height: rows }).png().toBuffer();
}
