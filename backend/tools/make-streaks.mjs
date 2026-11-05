// Builds the streak texture that lines a specimen's cell in the construct:
//   node backend/tools/make-streaks.mjs <video> <outName>
// Every streak takes its colour from a real pixel of the clip and drifts toward
// another as it runs, so each cell is lined with its own footage's palette. The
// lines themselves are drawn crisp: a raw slit-scan of a following camera
// reassembles the picture and smoothing it only gives mud, whereas the
// tesseract's walls are thousands of fine, hard-edged streaks.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const VARIANTS = 4; // side by side, so faces can differ
const LEN = 512;    // along the streak
const ROWS = 1024;  // across the streaks

const [videoPath, outName] = process.argv.slice(2);
if (!videoPath || !outName) {
  console.error("usage: make-streaks.mjs <video> <outName>");
  process.exit(1);
}

// seeded, so a rebake of the same clip gives the same walls
let seed = [...outName].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// a small, evenly spread sample of the clip's pixels is the whole palette
const SW = 64;
const SH = 36;
const frameBytes = SW * SH * 3;
const palette = [];
let pending = Buffer.alloc(0);
const ffmpeg = spawn(FFMPEG, ["-v", "error", "-i", videoPath, "-vf", `fps=6,scale=${SW}:${SH}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
ffmpeg.stderr.pipe(process.stderr);
ffmpeg.stdout.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= frameBytes) {
    for (let p = 0; p < frameBytes; p += 3) palette.push([pending[p], pending[p + 1], pending[p + 2]]);
    pending = pending.subarray(frameBytes);
  }
});
await new Promise((resolve, reject) => ffmpeg.on("close", (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve())));
if (!palette.length) throw new Error("no frames decoded");

const pick = () => palette[Math.floor(random() * palette.length)];
const width = VARIANTS * LEN;
const out = Buffer.alloc(width * ROWS * 3);

for (let v = 0; v < VARIANTS; v += 1) {
  let y = 0;
  while (y < ROWS) {
    const thick = 1 + Math.floor(random() * random() * 6);
    const gap = random() < 0.38 ? 1 + Math.floor(random() * 2) : 0;
    const a = pick();
    const b = pick();
    // most lines sit in the footage's own range; a few catch the light
    const gain = random() < 0.03 ? 1.9 : 0.45 + random() * 0.95;
    // occasional breaks so streaks end and restart like stacked spines
    const breakAt = random() < 0.3 ? Math.floor(random() * LEN) : -1;
    const breakLen = 6 + Math.floor(random() * 40);
    for (let r = 0; r < thick && y < ROWS; r += 1, y += 1) {
      // the edge rows of a thick streak are darker, which gives it a round
      const edge = thick > 2 && (r === 0 || r === thick - 1) ? 0.6 : 1;
      for (let x = 0; x < LEN; x += 1) {
        const t = x / (LEN - 1);
        const s = t * t * (3 - 2 * t);
        const dark = breakAt >= 0 && x >= breakAt && x < breakAt + breakLen ? 0.12 : 1;
        const k = gain * edge * dark;
        const o = (y * width + v * LEN + x) * 3;
        out[o] = Math.min(255, (a[0] + (b[0] - a[0]) * s) * k);
        out[o + 1] = Math.min(255, (a[1] + (b[1] - a[1]) * s) * k);
        out[o + 2] = Math.min(255, (a[2] + (b[2] - a[2]) * s) * k);
      }
    }
    y += gap; // gap rows stay black
  }
}

const dir = path.join(ROOT, "assets", "streaks");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${outName}.webp`);
await sharp(out, { raw: { width, height: ROWS, channels: 3 } }).webp({ quality: 78, effort: 6 }).toFile(file);
console.log(`[${outName}] ${palette.length} palette px -> ${path.relative(ROOT, file)} (${Math.round(fs.statSync(file).size / 1024)}KB)`);
