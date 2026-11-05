import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { recordsOfKind } from "@meta-sam/parser";
import { parseTrackedVideo } from "./sam-image-result.mjs";
import { client } from "./meta.js";
import { upscaleMask } from "./compose.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// Every instance of one concept, tracked through a clip of any length.
//
// SAM 3.1 drifts on long passes (generate.js caps a pass at 320 frames), so the clip is cut into
// short chunks at the sampling rate every later stage uses, each chunk overlapping the next.
// SAM's object ids are only meaningful inside one chunk; ids are linked across chunks by how well
// the masks agree over the overlap, so one animal keeps one track for the whole clip.
//
// Writes <outDir>/labels/l<sample>.png (8-bit: 0 = background, n = track n, at width x height) and
// <outDir>/tracks.json. Where animals overlap, a pixel goes to the one standing lower in the frame
// (nearer the lens), so a shell never claims pixels of the animal in front of it.
export const SAMPLE_FPS = 15; // every later stage reads the rate back from tracks.json
const SAM_ATTEMPTS = 3;
const PASS_TIMEOUT_MS = 6 * 60 * 1000; // a 15 s chunk takes 1-2 min
const LINK_IOU = 0.3;

async function withRetries(job, signal) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await job();
    } catch (error) {
      if (signal?.aborted || attempt >= SAM_ATTEMPTS) throw error;
      console.warn(`SAM pass failed (${error.code || error.message}); retrying ${attempt}/${SAM_ATTEMPTS - 1}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

const pad = (n) => String(n).padStart(5, "0");

// Detectors are weakest on an animal cut by the picture's edge, so SAM is shown the clip with a margin
// of mirrored picture on every side, and the masks are cropped back to the real frame. An animal half
// out of frame then looks like a whole one lying across the edge.
const BORDER = Number(process.env.SAM_BORDER ?? 0.1);
const even = (n) => Math.round(n / 2) * 2;

function cropRaster(raster, fullWidth, left, top, width, height) {
  const out = new Uint8Array(width * height);
  let any = false;
  for (let y = 0; y < height; y += 1) {
    const row = (top + y) * fullWidth + left;
    for (let x = 0; x < width; x += 1) if (raster[row + x]) { out[y * width + x] = 1; any = true; }
  }
  return any ? out : null;
}

async function samChunk(file, concept, onSnapshot, signal) {
  const upload = await client.files.create({ purpose: "user_data", file: fs.createReadStream(file) });
  try {
    const result = await withRetries(async () => {
      const events = await client.responses.create({
        model: "sam-3.1",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: concept }, { type: "input_video", file_id: upload.id }] }],
        stream: true,
      }, signal ? { signal } : undefined);
      // a stream can stall without ever erroring: give up on it and let the retry run
      let timer;
      const stalled = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("SAM stream stalled"), { code: "STALLED" })), PASS_TIMEOUT_MS); });
      return Promise.race([parseTrackedVideo(events, onSnapshot), stalled]).finally(() => clearTimeout(timer));
    }, signal);
    return recordsOfKind(result.records, "mask");
  } finally {
    await client.files.del?.(upload.id).catch(() => {});
  }
}

/** local masks of one chunk -> per frame, [{id: sam object id, raster, bottom}] */
function groupByFrame(records, width, height, margin = { x: 0, y: 0 }) {
  const frames = new Map();
  const fullWidth = width + 2 * margin.x;
  const fullHeight = height + 2 * margin.y;
  for (const record of records) {
    const index = record.frame?.frameIndex;
    if (index === undefined) continue;
    // a mask lying wholly in the margin (the mirror of an animal at the edge) is not an animal of this frame
    const raster = cropRaster(upscaleMask(record, fullWidth, fullHeight), fullWidth, margin.x, margin.y, width, height);
    if (!raster) continue;
    if (!frames.has(index)) frames.set(index, []);
    frames.get(index).push({ id: String(record.objectId), raster, bottom: record.bounds.bottom - margin.y });
  }
  return frames;
}

export async function trackInstances({ videoPath, concept, outDir, width, height, duration, start = 0, seconds, chunkSeconds = 15, overlapSeconds = 2, sampleFps = SAMPLE_FPS, onStage = () => {}, onFrame, signal }) {
  const fps = sampleFps; // live.html tracks every frame of the clip (up to 30 per second); the default is the pipeline's 15
  const margin = { x: even(width * BORDER), y: even(height * BORDER) };
  const labels = path.join(outDir, "labels");
  const chunkDir = path.join(outDir, "chunks");
  await fsp.mkdir(labels, { recursive: true });
  await fsp.mkdir(chunkDir, { recursive: true });
  const span = seconds ?? duration - start;
  const stride = chunkSeconds - overlapSeconds;
  const chunks = [];
  for (let offset = 0; offset < span - 1e-6; offset += stride) {
    chunks.push({ offset, length: Math.min(chunkSeconds, span - offset) });
    if (offset + chunkSeconds >= span - 1e-6) break;
  }

  const overlapFrames = Math.round(overlapSeconds * fps);
  const tracks = new Map(); // global id -> { id, first, last, frames, area }
  let nextId = 1;
  const ledger = [];

  for (const [index, chunk] of chunks.entries()) {
    if (signal?.aborted) throw Object.assign(new Error("Stopped."), { code: "STOPPED" });
    onStage(`Following your subject… (${index + 1}/${chunks.length})`);
    const first = Math.round(chunk.offset * fps); // global sample index of the chunk's first frame
    const frames = Math.round(chunk.length * fps);
    const file = path.join(chunkDir, `c${String(index).padStart(2, "0")}.mp4`);
    const chunkFilter = margin.x
      ? `fps=${fps},scale=${width}:${height},pad=${width + 2 * margin.x}:${height + 2 * margin.y}:${margin.x}:${margin.y}:black,fillborders=left=${margin.x}:right=${margin.x}:top=${margin.y}:bottom=${margin.y}:mode=mirror`
      : `fps=${fps},scale=${width}:${height}`;
    await run(FFMPEG, ["-y", "-v", "error", "-ss", String(start + chunk.offset), "-i", videoPath, "-frames:v", String(frames), "-vf", chunkFilter, "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", file]);
    const t0 = Date.now();
    // the raw records are kept: re-running a clip (or changing how ids are linked) costs nothing
    const cache = file.replace(/\.mp4$/, `.${concept.replace(/\W+/g, "_")}.${fps}fps${margin.x ? `.m${margin.x}x${margin.y}` : ""}.json`);
    let records;
    if (fs.existsSync(cache)) records = JSON.parse(await fsp.readFile(cache, "utf8"));
    else {
      // frames reach the page as SAM finishes them: each snapshot is cumulative, so only masks not yet seen are passed on
      const reported = new Set();
      records = await samChunk(file, concept, onFrame && ((snapshot) => {
        const fresh = recordsOfKind(snapshot.records, "mask").filter((r) => r.frame?.frameIndex !== undefined && !reported.has(`${r.frame.frameIndex}:${r.objectId}`));
        if (!fresh.length) return;
        for (const r of fresh) reported.add(`${r.frame.frameIndex}:${r.objectId}`);
        for (const [k, items] of groupByFrame(fresh, width, height, margin)) {
          if (index > 0 && k < overlapFrames / 2) continue;
          onFrame(first + k, items, { chunk: index, chunks: chunks.length });
        }
      }), signal);
      await fsp.writeFile(cache, JSON.stringify(records));
    }
    const local = groupByFrame(records, width, height, margin);

    // link this chunk's ids to the tracks already written over the overlap
    const link = new Map(); // sam id -> global id
    if (index > 0) {
      const score = new Map(); // `${sam}|${gid}` -> { inter, union }
      for (let k = 0; k < Math.min(overlapFrames, frames); k += 1) {
        const mine = local.get(k);
        if (!mine) continue;
        const previous = await sharp(path.join(labels, `l${pad(first + k)}.png`)).extractChannel(0).raw().toBuffer().catch(() => null);
        if (!previous) continue;
        const gids = [...new Set(previous)].filter(Boolean);
        for (const m of mine) for (const gid of gids) {
          let inter = 0, union = 0;
          for (let p = 0; p < previous.length; p += 1) {
            const a = m.raster[p] > 0, b = previous[p] === gid;
            if (a || b) union += 1;
            if (a && b) inter += 1;
          }
          const key = `${m.id}|${gid}`;
          const s = score.get(key) ?? { inter: 0, union: 0 };
          s.inter += inter; s.union += union;
          score.set(key, s);
        }
      }
      if (process.env.TRACK_DEBUG) console.log("link scores", [...score].map(([k, v]) => `${k}:${(v.inter / Math.max(1, v.union)).toFixed(2)}`).join(" "));
      const ranked = [...score].map(([key, s]) => ({ key, iou: s.union ? s.inter / s.union : 0 })).sort((a, b) => b.iou - a.iou);
      const usedGid = new Set();
      for (const { key, iou } of ranked) {
        const [sam, gid] = key.split("|");
        if (iou < LINK_IOU || link.has(sam) || usedGid.has(gid)) continue;
        link.set(sam, Number(gid));
        usedGid.add(gid);
      }
    }
    const ids = new Set([...local.values()].flat().map((m) => m.id));
    for (const id of ids) if (!link.has(id)) link.set(id, nextId++);

    let withMasks = 0;
    for (let k = 0; k < frames; k += 1) {
      const global = first + k;
      const mine = local.get(k) ?? [];
      // the previous chunk wrote the first half of the overlap; this one writes the rest
      if (index > 0 && k < overlapFrames / 2) continue;
      const label = new Uint8Array(width * height);
      // nearer (lower in the frame) animals are painted last, so they win where bodies overlap
      for (const m of [...mine].sort((a, b) => a.bottom - b.bottom)) {
        const gid = link.get(m.id);
        for (let p = 0; p < label.length; p += 1) if (m.raster[p]) label[p] = gid;
      }
      if (mine.length) withMasks += 1;
      for (const gid of new Set(label)) {
        if (!gid) continue;
        const t = tracks.get(gid) ?? { id: gid, first: global, last: global, frames: 0 };
        t.first = Math.min(t.first, global); t.last = Math.max(t.last, global); t.frames += 1;
        tracks.set(gid, t);
      }
      await sharp(Buffer.from(label), { raw: { width, height, channels: 1 } }).png({ compressionLevel: 6 }).toFile(path.join(labels, `l${pad(global)}.png`));
    }
    ledger.push({ chunk: index, start: start + chunk.offset, frames, objects: ids.size, framesWithMasks: withMasks, seconds: (Date.now() - t0) / 1000 });
    console.log(JSON.stringify(ledger.at(-1)));
  }

  const samples = Math.round(span * fps);
  const result = { fps, start, samples, width, height, concept, tracks: [...tracks.values()], chunks: ledger };
  await fsp.writeFile(path.join(outDir, "tracks.json"), JSON.stringify(result));
  return result;
}
