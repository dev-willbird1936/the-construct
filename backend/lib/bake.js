import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { extractFrames } from "./ffmpeg.js";

// Turns one finished SAM tracking pass into the folder the reconstruction
// scripts read (the same layout make-lab.mjs writes): cut/ full-frame RGBA
// cut-outs, src/ source frames at slice size, lab.json, plus the sampled
// frames at full resolution in fullDir.

export const MIN_FRAMES = 6;  // fewer tracked frames than this is not a trail
const MIN_PIXELS = 30;        // fewer opaque pixels than this: the subject is not in the frame
const JUMP_CENTROID = 0.25;   // a centroid move of this share of the frame width between samples...
const JUMP_AREA = 2.5;        // ...or an area change by this factor means tracking drifted onto something else

// Tracking drifts onto the background after the subject leaves, and that tail would be
// built into the world. Keep the contiguous run from the first frame up to the first jump.
export function trimDrift(frames) {
  let end = frames.length;
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1];
    const b = frames[i];
    const ratio = b.area / a.area;
    if (Math.abs(b.cx - a.cx) > JUMP_CENTROID || ratio > JUMP_AREA || ratio < 1 / JUMP_AREA) {
      end = i;
      break;
    }
  }
  return frames.slice(0, end);
}

async function stats(png, width, height) {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, sx = 0, sy = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= 100) continue;
      n += 1; sx += x; sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { n, area: n / (width * height), cx: n ? sx / n / width : 0, cy: n ? sy / n / height : 0, box: [x0 / width, y0 / height, (x1 + 1) / width, (y1 + 1) / height] };
}

// Trail cameras burn a data strip (date, temperature) into the bottom of every frame; built into the
// scene it would stand there as a wall. Call it a strip when some row in the bottom 7% is far darker
// than the rows above it, in most sampled frames. Returns the share of the frame height to keep.
const KEEP_WITH_STRIP = 0.9;
async function keptHeight(files) {
  const W = 160, H = 180;
  let strips = 0;
  for (const file of files) {
    const { data } = await sharp(file).greyscale().resize(W, H, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    const row = (y) => { let sum = 0; for (let x = 0; x < W; x += 1) sum += data[y * W + x]; return sum / W; };
    let darkest = Infinity;
    for (let y = Math.round(H * 0.93); y < H; y += 1) darkest = Math.min(darkest, row(y));
    let above = 0;
    for (let y = H - 54; y < H - 30; y += 1) above += row(y) / 24;
    if (darkest < 0.55 * above) strips += 1;
  }
  return strips > files.length / 2 ? KEEP_WITH_STRIP : 1;
}

export async function bakeLab({ videoPath, manifest, genDir, bakeDir, fullDir, fps }) {
  const { sliceWidth: W, sliceHeight: H } = manifest;
  await fs.rm(bakeDir, { recursive: true, force: true });
  await Promise.all([fs.mkdir(path.join(bakeDir, "cut"), { recursive: true }), fs.mkdir(path.join(bakeDir, "src"), { recursive: true }), fs.mkdir(fullDir, { recursive: true })]);

  const present = [];
  for (const f of manifest.frames) {
    if (!f.present) continue;
    const png = await fs.readFile(path.join(genDir, f.url));
    const s = await stats(png, W, H);
    if (s.n >= MIN_PIXELS) present.push({ f, png, ...s });
  }
  const kept = trimDrift(present);
  if (kept.length < MIN_FRAMES) throw Object.assign(new Error("The object was tracked in too few frames to rebuild. Pick a frame where it stays in view."), { retryable: true });

  const indices = kept.map((k) => k.f.sourceFrameIndex);
  const fullFiles = await extractFrames(videoPath, indices, fullDir);
  const lab = [];
  for (const [i, k] of kept.entries()) {
    const name = `f${String(k.f.sourceFrameIndex + 1).padStart(4, "0")}.jpg`;
    await fs.rename(fullFiles[i], path.join(fullDir, name));
    await sharp(path.join(fullDir, name)).resize(W, H, { fit: "fill" }).jpeg({ quality: 92 }).toFile(path.join(bakeDir, "src", name));
    const cut = `cut/c${String(i).padStart(3, "0")}.webp`;
    await sharp(k.png).webp({ quality: 85, alphaQuality: 90 }).toFile(path.join(bakeDir, cut));
    lab.push({ file: cut, src: `src/${name}`, t: k.f.timestamp, area: k.area, cx: k.cx, cy: k.cy, box: k.box });
  }
  await fs.writeFile(path.join(bakeDir, "lab.json"), JSON.stringify({ width: W, height: H, fps, concept: manifest.concept, frames: lab }));
  const samples = Array.from({ length: Math.min(5, kept.length) }, (_, i) => path.join(bakeDir, "src", `f${String(kept[Math.floor((i * (kept.length - 1)) / Math.max(1, Math.min(5, kept.length) - 1))].f.sourceFrameIndex + 1).padStart(4, "0")}.jpg`));
  return { frames: lab.length, dropped: present.length - kept.length, overlay: await keptHeight(samples) };
}
