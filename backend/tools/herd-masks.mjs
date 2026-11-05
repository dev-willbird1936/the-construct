// Masks every instance of one concept (a herd) in a long clip with SAM 3.1, in short chunks.
//   node backend/tools/herd-masks.mjs <video> <concept> <outDir> [--start s] [--seconds s] [--chunk s]
// Each chunk is cut with ffmpeg, uploaded, and segmented in one video pass (generate.js caps a
// pass at 320 frames because masks drift on long passes). The masks of all instances are merged
// per frame, so no instance has to be matched across chunks. Writes <outDir>/masks/m%05d.png
// (255 = herd) and appends one line per paid call to <outDir>/ledger.jsonl.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { parseVideoStream, recordsOfKind } from "@meta-sam/parser";
import { client } from "../lib/meta.js";
import { upscaleMask } from "../lib/compose.js";

const args = process.argv.slice(2);
const [video, concept, outArg] = args;
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(args[i + 1]);
};
if (!video || !concept || !outArg) {
  console.error("usage: herd-masks.mjs <video> <concept> <outDir> [--start s] [--seconds s] [--chunk s]");
  process.exit(1);
}
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const out = path.resolve(outArg);
const start = flag("start", 0);
const chunk = flag("chunk", 8);
const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-show_entries", "format=duration", "-of", "json", video]).toString());
const { width: W, height: H, r_frame_rate: rate } = probe.streams[0];
const [num, den] = rate.split("/").map(Number);
const fps = num / den;
const seconds = flag("seconds", Number(probe.format.duration) - start);
await fsp.mkdir(path.join(out, "masks"), { recursive: true });
await fsp.mkdir(path.join(out, "chunks"), { recursive: true });
const ledger = path.join(out, "ledger.jsonl");

// the first frame of a chunk is global frame round((start + offset) * fps)
const chunks = [];
for (let offset = 0; offset < seconds - 1e-6; offset += chunk) chunks.push({ offset, length: Math.min(chunk, seconds - offset) });
console.log(`${W}x${H} @ ${fps} fps, ${seconds}s from ${start}s in ${chunks.length} chunk(s)`);

for (const [index, c] of chunks.entries()) {
  const firstFrame = Math.round((start + c.offset) * fps);
  const frames = Math.round(c.length * fps);
  const done = Array.from({ length: frames }, (_, i) => fs.existsSync(path.join(out, "masks", `m${String(firstFrame + i).padStart(5, "0")}.png`)));
  if (done.every(Boolean)) { console.log(`chunk ${index}: already done`); continue; }
  const file = path.join(out, "chunks", `c${String(index).padStart(2, "0")}.mp4`);
  // cut by frame count, re-encoded so the pass sees exactly these frames
  execFileSync(FFMPEG, ["-y", "-v", "error", "-ss", String(start + c.offset), "-i", video, "-frames:v", String(frames), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", file]);
  const t0 = Date.now();
  const upload = await client.files.create({ purpose: "user_data", file: fs.createReadStream(file) });
  let usage = null;
  let eventCount = 0;
  const events = await client.responses.create({
    model: "sam-3.1",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: concept }, { type: "input_video", file_id: upload.id }] }],
    stream: true,
  });
  // look at the raw stream for a usage block without consuming it
  async function* tap(source) {
    for await (const event of source) {
      eventCount += 1;
      const found = event?.response?.usage ?? event?.usage;
      if (found) usage = found;
      yield event;
    }
  }
  const result = await parseVideoStream(tap(events)).finalResult;
  const masks = recordsOfKind(result.records, "mask");
  const byFrame = new Map();
  for (const mask of masks) {
    const i = mask.frame?.frameIndex;
    if (i === undefined) continue;
    if (!byFrame.has(i)) byFrame.set(i, []);
    byFrame.get(i).push(mask);
  }
  let written = 0;
  let empty = 0;
  const objectIds = new Set(masks.map((m) => m.objectId));
  for (let i = 0; i < frames; i += 1) {
    const merged = new Uint8Array(W * H);
    for (const record of byFrame.get(i) || []) {
      const raster = upscaleMask(record, W, H);
      for (let p = 0; p < merged.length; p += 1) if (raster[p]) merged[p] = 255;
    }
    if (!byFrame.has(i)) empty += 1;
    await sharp(Buffer.from(merged), { raw: { width: W, height: H, channels: 1 } }).png({ compressionLevel: 6 }).toFile(path.join(out, "masks", `m${String(firstFrame + i).padStart(5, "0")}.png`));
    written += 1;
  }
  const line = { chunk: index, startSeconds: start + c.offset, seconds: c.length, frames, objects: objectIds.size, framesWithMasks: frames - empty, uploadBytes: fs.statSync(file).size, secondsElapsed: (Date.now() - t0) / 1000, events: eventCount, usage, at: new Date().toISOString() };
  await fsp.appendFile(ledger, `${JSON.stringify(line)}\n`);
  console.log(JSON.stringify(line));
  await client.files.del?.(upload.id).catch(() => {});
}
