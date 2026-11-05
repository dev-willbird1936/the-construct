// Drives the running backend end-to-end for one clip and packs the resulting
// slice PNGs into a single web-friendly atlas:
//   node backend/tools/make-volume.mjs <video> <concept> <outName> [seedTime] [pick]
// pick: "largest" (default) | "tallest" | index number
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const API = process.env.API || "http://127.0.0.1:8000";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const [videoPath, concept, outName, seedTimeArg = "1.0", pick = "largest"] = process.argv.slice(2);
if (!videoPath || !concept || !outName) {
  console.error("usage: make-volume.mjs <video> <concept> <outName> [seedTime] [pick]");
  process.exit(1);
}
const seedTime = Number(seedTimeArg);

// Plain http rather than fetch: a full-clip tracking pass can outlast fetch's
// fixed five-minute wait for response headers.
const post = (route, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(text);
          if (res.statusCode >= 400) reject(new Error(json.error || `${route} failed`));
          else resolve(json);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });

console.log(`[${outName}] uploading ${path.basename(videoPath)}…`);
const form = new FormData();
form.append("video", new Blob([fs.readFileSync(videoPath)]), path.basename(videoPath));
const upRes = await fetch(`${API}/api/upload`, { method: "POST", body: form });
const up = await upRes.json();
if (!upRes.ok) throw new Error(up.error);
console.log(`[${outName}] ${up.width}x${up.height} ${up.fps}fps ${up.frameCount}f`);

// concept may be "bear,animal": the first word is searched for, and any of them
// is accepted, since deduplication can keep a broader label for the same mask
const labels = concept.split(",").map((s) => s.trim());
console.log(`[${outName}] segmenting "${labels[0]}" at t=${seedTime}…`);
const detect = await post("/api/detect-custom", { jobId: up.jobId, time: seedTime, prompt: labels[0] });
const matches = detect.objects.filter((o) => labels.includes(o.label));
if (!matches.length) throw new Error(`no "${concept}" found (got: ${detect.objects.map((o) => o.label).join(", ")})`);

const area = (o) => (o.box.right - o.box.left) * (o.box.bottom - o.box.top);
const height = (o) => o.box.bottom - o.box.top;
let chosen;
if (pick === "tallest") chosen = matches.slice().sort((a, b) => height(b) - height(a))[0];
else if (!Number.isNaN(Number(pick))) chosen = matches[Number(pick)];
else chosen = matches.slice().sort((a, b) => area(b) - area(a))[0];
console.log(`[${outName}] ${matches.length} match(es); using id=${chosen.id} area=${area(chosen).toFixed(3)}`);

console.log(`[${outName}] tracking through clip (this takes a while)…`);
const gen = await post("/api/generate", { jobId: up.jobId, time: seedTime, objectId: chosen.id });
console.log(`[${outName}] match=${gen.matchScore.toFixed(3)} frames=${gen.frames.length} present=${gen.frames.filter((f) => f.present).length}`);

// ---- pack slices into one atlas ----
let present = gen.frames.filter((f) => f.present);
let buffers = await Promise.all(
  present.map(async (f) => Buffer.from(await (await fetch(`${API}${f.url}`)).arrayBuffer()))
);

// Drop frames where the subject has all but left: they add atlas weight and make
// the volume fade into nothing instead of ending on the object.
const coverage = await Promise.all(
  buffers.map(async (buf) => {
    const { data } = await sharp(buf).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    let on = 0;
    for (let i = 0; i < data.length; i += 1) if (data[i] > 8) on += 1;
    return on;
  })
);
const median = [...coverage].sort((a, b) => a - b)[Math.floor(coverage.length / 2)];
const keep = coverage.map((c) => c >= median * 0.2);
const dropped = keep.filter((k) => !k).length;
if (dropped) console.log(`[${outName}] dropping ${dropped} near-empty frame(s)`);
present = present.filter((_, i) => keep[i]);
buffers = buffers.filter((_, i) => keep[i]);

// union alpha bounding box across every frame, so the atlas holds no dead space
let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
let srcW = 0, srcH = 0;
for (const buf of buffers) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  srcW = info.width;
  srcH = info.height;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
}
if (maxX < 0) throw new Error("every frame was empty");
const pad = 2;
minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
maxX = Math.min(srcW - 1, maxX + pad); maxY = Math.min(srcH - 1, maxY + pad);
const cropW = maxX - minX + 1;
const cropH = maxY - minY + 1;

const CELL = Number(process.env.CELL || 224);
const cellW = CELL;
const cellH = Math.max(1, Math.round((cropH / cropW) * CELL));
const cols = Math.ceil(Math.sqrt(buffers.length));
const rows = Math.ceil(buffers.length / cols);
console.log(`[${outName}] crop ${cropW}x${cropH} -> cell ${cellW}x${cellH}, atlas ${cols}x${rows}`);

const cells = await Promise.all(
  buffers.map((buf) =>
    sharp(buf)
      .extract({ left: minX, top: minY, width: cropW, height: cropH })
      .resize(cellW, cellH, { fit: "fill" })
      .toBuffer()
  )
);

const atlas = await sharp({
  create: { width: cols * cellW, height: rows * cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite(cells.map((input, i) => ({ input, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH })))
  .webp({ quality: 82, alphaQuality: 90, effort: 6 })
  .toBuffer();

const outDir = path.join(ROOT, "assets", "volumes");
await fsp.mkdir(outDir, { recursive: true });
await fsp.writeFile(path.join(outDir, `${outName}.webp`), atlas);

const meta = {
  name: outName,
  concept,
  count: cells.length,
  cols,
  rows,
  cellW,
  cellH,
  aspect: cropW / cropH,
  fps: up.fps,
  timestamps: present.map((f) => Number(f.timestamp.toFixed(3))),
  source: path.basename(videoPath),
};
await fsp.writeFile(path.join(outDir, `${outName}.json`), JSON.stringify(meta));
console.log(`[${outName}] wrote assets/volumes/${outName}.webp (${Math.round(atlas.length / 1024)}KB) + .json\n`);
