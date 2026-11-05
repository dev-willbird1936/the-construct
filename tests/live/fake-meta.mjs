// A stand-in for the Meta Model API (SAM 3.1 + Muse Spark), so the real backend path behind live.html can be run
// with no key, no billing and no spend. It answers from label rasters of a clip that was tracked before:
//
//   node tests/live/fake-meta.mjs <labels dir> <clip tracked fps> [port=8200] [subject=moose]
//   META_BASE_URL=http://127.0.0.1:8200/v1 node backend/server.js
//
// Image requests get the object at the matching moment for the selected subject (and animal for moose);
// video requests get the labels frame by frame, one line per frame, as the real stream does. Not a model: a replay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(path.resolve("backend/package.json"));
const sharp = require("sharp");
const { encodeSegmentationMask } = await import(pathToFileURL(path.resolve("backend/node_modules/@meta-sam/parser/dist/mask-codec.js")).href);
const [labelsArg, fpsArg, portArg, subjectArg] = process.argv.slice(2);
const labels = path.resolve(labelsArg), SAMPLE_FPS = Number(fpsArg || 15), port = Number(portArg || 8200);
const subject = subjectArg || "moose";
const pad = (n) => String(n).padStart(5, "0");
const files = new Map();
let videoCalls = 0;

// a 24x14 grey thumbnail of every labelled moment's frame, so an image request is answered for the moment it shows
const framesDir = path.join(path.dirname(labels), "frames");
const thumb = (input) => sharp(input).resize(24, 14, { fit: "fill" }).greyscale().raw().toBuffer();
const moments = fs.existsSync(framesDir) ? await Promise.all(fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort().map((f) => thumb(path.join(framesDir, f)))) : [];
async function momentOf(png) {
  if (!moments.length) return 0;
  const t = await thumb(png);
  let best = 0, bestScore = Infinity;
  moments.forEach((m, i) => { let d = 0; for (let k = 0; k < m.length; k += 1) d += (m[k] - t[k]) ** 2; if (d < bestScore) { bestScore = d; best = i; } });
  return best;
}

async function label(i) {
  const { data, info } = await sharp(path.join(labels, `l${pad(i)}.png`)).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
/** One object's box and mask, translated into the padded frame's coordinates. */
function record(id, raster, w, h, offset, pw, ph) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (raster[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, crop = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) crop[y * bw + x] = raster[(y0 + y) * w + x0 + x] ? 1 : 0;
  const m = encodeSegmentationMask(crop, bw, bh);
  return `${id}<|box;x1=${x0 + offset.x};y1=${y0 + offset.y};x2=${x1 + offset.x};y2=${y1 + offset.y};w=${pw};h=${ph}|><|mask;x=0;y=0;data=${bh},${bw},${m.payload}|>`;
}

const readBody = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
const json = (res, body, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
function sse(res, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  return { delta: (d) => ev("response.output_text.delta", { item_id: "m", output_index: 0, content_index: 0, delta: d }),
    finish: () => { ev("response.output_text.done", { item_id: "m", output_index: 0, content_index: 0, text }); ev("response.completed", {}); res.end(); } };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const body = await readBody(req);
  if (req.method === "POST" && url.pathname.endsWith("/files")) {
    const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] || "")?.[1];
    const header = body.indexOf('name="file"', 0, "latin1");
    const start = body.indexOf(Buffer.from([13, 10, 13, 10]), header) + 4;
    const end = body.lastIndexOf(Buffer.concat([Buffer.from([13, 10]), Buffer.from(`--${boundary}`)]));
    const id = `file-${files.size}`;
    files.set(id, body.subarray(start, end));
    return json(res, { id, object: "file", bytes: end - start, created_at: 0, filename: "x.mp4", purpose: "user_data" });
  }
  if (req.method === "DELETE" && /\/files\//.test(url.pathname)) return json(res, { id: url.pathname.split("/").pop(), object: "file", deleted: true });
  if (req.method === "POST" && url.pathname.endsWith("/responses")) {
    const call = JSON.parse(body.toString());
    const content = call.input[0].content;
    const prompt = content.find((c) => c.type === "input_text")?.text ?? "";
    if (call.model === "muse-spark-1.3") {
      const text = JSON.stringify({ scene: subject === "moose" ? "pond with a moose (fake Meta)" : `${subject} (fake Meta)`, subjects: [{ label: subject, main: true }] });
      return json(res, { id: "r", object: "response", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] });
    }
    const video = content.find((c) => c.type === "input_video");
    if (!video) {                                   // an image: one line, frame zero
      const dataUrl = content.find((c) => c.type === "input_image")?.image_url ?? "";
      const first = await label(await momentOf(Buffer.from(dataUrl.split(",")[1] ?? "", "base64")));
      const box = /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=\d+;h=\d+\|>/.exec(prompt);
      let intersects = false;
      if (box) for (let y = +box[2]; y <= +box[4] && !intersects; y++) for (let x = +box[1]; x <= +box[3]; x++) if (first.data[y * first.w + x] === 1) { intersects = true; break; }
      const matches = prompt.trim() === `the ${subject}` || (!process.env.FAKE_META_HIDE_INITIAL && (prompt.trim() === subject || (subject === "moose" && prompt.trim() === "animal")));
      const hit = (box ? intersects : matches) ? record(box ? 1 : 0, first.data.map((v) => (v === 1 ? 1 : 0)), first.w, first.h, { x: 0, y: 0 }, first.w, first.h) : null;
      const text = hit ? `<0f>${hit}\n` : "";
      const out = sse(res, text);
      if (text) out.delta(text);
      return out.finish();
    }
    // a video chunk: probe it for its size and length; chunks are cut 13 s apart (15 s with a 2 s overlap)
    const tmp = path.join(os.tmpdir(), `fake-meta-${process.pid}-${videoCalls++}.mp4`);
    fs.writeFileSync(tmp, files.get(video.file_id));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", tmp]).toString()).streams[0];
    const [pw, ph, n] = [Number(probe.width), Number(probe.height), Number(probe.nb_read_frames)];
    const rate = probe.r_frame_rate.split("/").reduce((a, b) => a / (Number(b) || 1));
    const first = await label(0);
    const margin = Math.round((pw - first.w) / 2), marginY = Math.round((ph - first.h) / 2);
    // which labelled moment this chunk opens on: its first frame, without the mirrored margin, against the frames we hold
    const still = `${tmp}.png`;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", tmp, "-frames:v", "1", still]);
    const opening = await momentOf(await sharp(still).extract({ left: margin, top: marginY, width: first.w, height: first.h }).png().toBuffer());
    fs.unlinkSync(tmp);
    fs.unlinkSync(still);
    const out = sse(res, "");
    let all = "";
    for (let k = 0; k < n; k += 1) {
      let line = `<${k}f>`;
      try {
        const l = await label(opening + Math.round((k / rate) * SAMPLE_FPS));   // the labels were made at SAMPLE_FPS: nearest one
        const r = record(0, l.data.map((v) => (v === 1 ? 1 : 0)), l.w, l.h, { x: margin, y: marginY }, pw, ph);
        if (r) line += r;
      } catch (error) { if (!/ENOENT/.test(String(error))) console.error("fake-meta frame", k, String(error).slice(0, 200)); }
      if (line === `<${k}f>`) continue;
      all += line + "\n";
      out.delta(line + "\n");
      await new Promise((ok) => setTimeout(ok, 15));      // frames arrive over time, like the real stream
    }
    res.write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: "m", output_index: 0, content_index: 0, text: all })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`);
    return res.end();
  }
  json(res, { error: { message: `fake meta: no route ${req.method} ${url.pathname}` } }, 404);
}).listen(port, "127.0.0.1", function () { console.log(`fake Meta API on http://127.0.0.1:${this.address().port}/v1`); });
