// Bakes the data behind lab.html: every tracked frame of one clip as a
// full-frame cut-out (so the subject keeps its true place in the shot), the
// matching source frames, a clean background plate, and per-frame stats.
//   node backend/tools/make-lab.mjs <video> <concept[,fallbacks]> <seedTime> [pick]
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const API = process.env.API || "http://127.0.0.1:8000";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// OUT=<dir> bakes somewhere else (make-stable.py reads its masks from there)
const OUT = process.env.OUT ? path.resolve(process.env.OUT) : path.join(ROOT, "assets", "lab");
const [videoPath, concept, seedArg = "1.0", pick = "largest"] = process.argv.slice(2);
if (!videoPath || !concept) {
  console.error("usage: make-lab.mjs <video> <concept[,fallbacks]> <seedTime> [pick]");
  process.exit(1);
}
const seedTime = Number(seedArg);

// plain http: a full-clip tracking pass can outlast fetch's header timeout
const request = (method, route, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(`${API}${route}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
const post = async (route, body) => {
  const res = await request("POST", route, JSON.stringify(body), { "Content-Type": "application/json" });
  const json = JSON.parse(res.body);
  if (res.status >= 400) throw new Error(json.error || `${route} failed`);
  return json;
};

// remove only what this script owns: a Stable bake keeps its depth caches
// (da3.npz, da3_crops.npz) in this same OUT folder, and a rerun here must
// not erase a slow GPU solve just to retrack with a new seed/concept
await fsp.rm(path.join(OUT, "cut"), { recursive: true, force: true });
await fsp.rm(path.join(OUT, "src"), { recursive: true, force: true });
await fsp.rm(path.join(OUT, "lab.json"), { force: true });
await fsp.rm(path.join(OUT, "plate.jpg"), { force: true });
await fsp.mkdir(path.join(OUT, "cut"), { recursive: true });
await fsp.mkdir(path.join(OUT, "src"), { recursive: true });

const form = new FormData();
form.append("video", new Blob([fs.readFileSync(videoPath)]), path.basename(videoPath));
const up = await (await fetch(`${API}/api/upload`, { method: "POST", body: form })).json();
console.log(`uploaded ${up.width}x${up.height} ${up.fps}fps ${up.frameCount}f`);

const labels = concept.split(",").map((s) => s.trim());
const detect = await post("/api/detect-custom", { jobId: up.jobId, time: seedTime, prompt: labels[0] });
const matches = detect.objects.filter((o) => labels.includes(o.label));
if (!matches.length) throw new Error(`no "${concept}" (got: ${detect.objects.map((o) => o.label).join(", ")})`);
const area = (o) => (o.box.right - o.box.left) * (o.box.bottom - o.box.top);
const chosen = Number.isNaN(Number(pick)) ? matches.sort((a, b) => area(b) - area(a))[0] : matches[Number(pick)];
console.log(`tracking id=${chosen.id}…`);
const gen = await post("/api/generate", { jobId: up.jobId, time: seedTime, objectId: chosen.id });
console.log(`match=${gen.matchScore.toFixed(3)} frames=${gen.frames.length}`);

// source frames at slice resolution, for the plate and the slit-scan views
const W = gen.sliceWidth;
const H = gen.sliceHeight;
execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
  "-y", "-v", "error", "-i", videoPath, "-vf", `scale=${W}:${H}`, path.join(OUT, "src", "f%04d.jpg"),
]);

const frames = [];
for (const [i, f] of gen.frames.entries()) {
  const png = (await request("GET", f.url)).body;
  const name = `c${String(i).padStart(3, "0")}.png`;
  // stats from alpha: area, centroid, box, all as fractions of the frame
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] > 100) { n++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (!f.present || n < 30) continue;
  await sharp(png).webp({ quality: 85, alphaQuality: 90 }).toFile(path.join(OUT, "cut", name.replace(".png", ".webp")));
  frames.push({
    file: `cut/${name.replace(".png", ".webp")}`,
    src: `src/f${String(f.sourceFrameIndex + 1).padStart(4, "0")}.jpg`,
    t: f.timestamp,
    area: n / (W * H),
    cx: sx / n / W,
    cy: sy / n / H,
    box: [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H],
  });
}

// the plate: per-pixel median of the source frames, which drops the animal
const srcFiles = fs.readdirSync(path.join(OUT, "src")).filter((f) => f.endsWith(".jpg")).sort();
const step = Math.max(1, Math.floor(srcFiles.length / 31));
const stack = await Promise.all(srcFiles.filter((_, i) => i % step === 0).map((f) => sharp(path.join(OUT, "src", f)).raw().toBuffer()));
const plate = Buffer.alloc(W * H * 3);
const column = new Uint8Array(stack.length);
for (let p = 0; p < plate.length; p++) {
  for (let k = 0; k < stack.length; k++) column[k] = stack[k][p];
  column.sort();
  plate[p] = column[column.length >> 1];
}
await sharp(plate, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 88 }).toFile(path.join(OUT, "plate.jpg"));

fs.writeFileSync(path.join(OUT, "lab.json"), JSON.stringify({ width: W, height: H, fps: up.fps, concept: gen.concept, frames }));
console.log(`wrote ${frames.length} cut-outs + ${srcFiles.length} source frames to ${OUT}`);
