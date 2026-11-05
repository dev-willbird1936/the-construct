import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { trackInstances } from "./track.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// An animal cut by the picture's edge is the one SAM misses most, and small animals are missed whole.
// When the animals are small, each side edge gets its own pass: the strip of picture along it, enlarged
// until the animals in it are as big as SAM likes them, with the usual mirrored margin. What the strip
// finds that the full-frame pass did not is added as new tracks.
//
// A pass costs as much as the main one, so it is only for a clip where animals are small (their median
// height under SMALL_ANIMAL of the picture) and touch the edge strip at all.
const SMALL_ANIMAL = 0.2;
const STRIP = 0.25;          // share of the width the strip takes
const PAD_Y = 0.04;
const MIN_HEIGHT = 0.08;     // a window shorter than this share of the picture is not worth a pass
// px on the long side the strip is enlarged to. SAM 3 reads its input at 1008 px, so a larger strip (it was 1920)
// only cost upload and encode time: a wolf pack's four strips took 78 s instead of 175 s, and found a wolf the 1920 px pass missed
const TARGET_LONG = Number(process.env.EDGE_TARGET) || 1008;
// experiment knob: track the strip at 1/EDGE_STRIDE of the samples and give each sample the nearest tracked one
const EDGE_STRIDE = Math.max(1, Math.round(Number(process.env.EDGE_STRIDE) || 1));
const MAX_ENLARGE = 4;
const FIRST_ID = 100;
const BACK_SECONDS = 12;      // the backward pass covers this many opening seconds (the reversed strip is held in memory)
const KEEP_UNCOVERED = 0.5;  // a strip mask more than this covered by the full pass is the same animal
const EDGE_PARALLEL = Math.max(1, Number(process.env.EDGE_PARALLEL) || 2);  // strips tracked at once (1 = one after another)

const pad = (n) => String(n).padStart(5, "0");
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

async function labelsOf(dir, i) {
  return sharp(path.join(dir, "labels", `l${pad(i)}.png`)).extractChannel(0).raw().toBuffer();
}

/** where the animals are: median height share, and per edge the rows its strip's animals occupy */
async function survey(outDir, tracked) {
  const { width, height, samples } = tracked;
  const heights = [];
  const rows = { left: [height, -1, 0], right: [height, -1, 0] };
  const xs = { left: Math.round(width * STRIP), right: Math.round(width * (1 - STRIP)) };
  for (let i = 0; i < samples; i += 3) {
    const lab = await labelsOf(outDir, i).catch(() => null);
    if (!lab) continue;
    const top = new Map(), bottom = new Map();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const id = lab[y * width + x];
        if (!id) continue;
        if (!top.has(id)) top.set(id, y);
        bottom.set(id, y);
        const side = x < xs.left ? "left" : x >= xs.right ? "right" : null;
        if (side) { const r = rows[side]; r[0] = Math.min(r[0], y); r[1] = Math.max(r[1], y); r[2] += 1; }
      }
    }
    for (const [id, t] of top) heights.push((bottom.get(id) - t + 1) / height);
  }
  heights.sort((a, b) => a - b);
  return { median: heights.length ? heights[Math.floor(heights.length / 2)] : 1, rows };
}

async function stripPass({ side, videoPath, concept, outDir, tracked, rows, start, seconds, reverse = false }) {
  const { width, height } = tracked;
  const cw = even(width * STRIP);
  const y0 = Math.max(0, Math.floor(rows[0] - PAD_Y * height));
  const y1 = Math.min(height, Math.ceil(rows[1] + 1 + PAD_Y * height));
  const ch = even(y1 - y0);
  if (ch < MIN_HEIGHT * height) return null;
  const x0 = side === "left" ? 0 : width - cw;
  const scale = Math.min(MAX_ENLARGE, TARGET_LONG / Math.max(cw, ch));
  const sw = even(cw * scale), sh = even(ch * scale);
  const dir = path.join(outDir, `edge_${side}${reverse ? "_back" : ""}`);
  await fsp.mkdir(dir, { recursive: true });
  const cropped = path.join(dir, "strip.mp4");
  // the crop is cut from the clip as the main pass saw it (scaled to width x height first)
  const fps = tracked.fps / EDGE_STRIDE;
  await run(FFMPEG, ["-y", "-v", "error", "-ss", String(start), "-i", videoPath, "-t", String(seconds), "-vf", `fps=${fps},scale=${width}:${height},crop=${cw}:${ch}:${x0}:${y0},scale=${sw}:${sh}:flags=lanczos${reverse ? ",reverse" : ""}`, "-an", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", cropped]);
  const result = await trackInstances({ videoPath: cropped, concept, outDir: dir, width: sw, height: sh, duration: seconds, seconds, sampleFps: fps });
  return { dir, x0, y0, cw, ch, result, reverse, frames: (await fsp.readdir(path.join(dir, "labels"))).length };
}

/** adds what the edge strips find to <outDir>/labels and tracks.json; returns the number of tracks added */
export async function trackEdges({ videoPath, concept, outDir, tracked, start = 0, seconds, onStage = () => {} }) {
  const { width, height, samples } = tracked;
  const { median, rows } = await survey(outDir, tracked);
  if (median >= SMALL_ANIMAL) return 0;
  let nextId = FIRST_ID, added = 0;
  const extra = [];
  const span = seconds ?? tracked.samples / tracked.fps;
  // forward over the whole clip; then backward over its first seconds, because SAM finds an animal
  // cut by the edge only once more of it shows, and loses the frames before that
  // The strips are tracked two at a time (left and right together: each is its own SAM session on its own
  // crop, so neither waits for the other; a wolf pack spent three minutes here one strip after another).
  // What they found is then merged one strip at a time, in the same order as before, so the result is
  // the same as tracking them in turn.
  const order = [["left", false], ["right", false], ["left", true], ["right", true]].filter(([side]) => rows[side][1] >= 0);
  const passes = [];
  for (let k = 0; k < order.length; k += EDGE_PARALLEL) {
    const group = order.slice(k, k + EDGE_PARALLEL);
    const names = group.map(([side, reverse]) => `${side}${reverse ? " (backwards)" : ""}`);
    onStage(`Looking along the ${names.join(" and ")} edge${group.length > 1 ? "s" : ""}…`);
    passes.push(...await Promise.all(group.map(([side, reverse]) => stripPass({ side, videoPath, concept, outDir, tracked, rows: rows[side], start, seconds: reverse ? Math.min(span, BACK_SECONDS) : span, reverse }))));
  }
  for (const pass of passes) {
    if (!pass) continue;
    const { dir, x0, y0, cw, ch, result, frames, reverse } = pass;
    const ids = new Map(); // strip id -> global id
    const seen = new Map(); // global id -> { first, last, frames }
    for (let i = 0; i < samples; i += 1) {
      // the strip frame for this sample (every sample at EDGE_STRIDE 1; the nearest tracked one above it)
      let j = Math.round(i / EDGE_STRIDE);
      // a forward strip tracked at a stride can end one frame short of the last sample: that sample takes the last frame
      if (!reverse && j === frames && EDGE_STRIDE > 1) j = frames - 1;
      // a reversed pass covers only the clip's opening seconds, played backwards
      if (reverse && j >= frames) break;
      const small = await labelsOf(dir, reverse ? frames - 1 - j : j).catch(() => null);
      if (!small) continue;
      const main = await labelsOf(outDir, i);
      // strip labels -> the crop's size, nearest neighbour
      const up = await sharp(small, { raw: { width: result.width, height: result.height, channels: 1 } }).resize(cw, ch, { kernel: "nearest" }).extractChannel(0).raw().toBuffer();
      const area = new Map(), covered = new Map();
      for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) {
        const id = up[y * cw + x];
        if (!id) continue;
        area.set(id, (area.get(id) ?? 0) + 1);
        if (main[(y0 + y) * width + x0 + x]) covered.set(id, (covered.get(id) ?? 0) + 1);
      }
      let wrote = false;
      for (const [id, n] of area) {
        if ((covered.get(id) ?? 0) / n > KEEP_UNCOVERED) continue;
        if (!ids.has(id)) ids.set(id, nextId++);
        const gid = ids.get(id);
        for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) {
          const at = (y0 + y) * width + x0 + x;
          if (up[y * cw + x] === id && !main[at]) { main[at] = gid; wrote = true; }
        }
        const t = seen.get(gid) ?? { id: gid, first: i, last: i, frames: 0 };
        t.last = i; t.frames += 1;
        seen.set(gid, t);
      }
      if (wrote) await sharp(Buffer.from(main), { raw: { width, height, channels: 1 } }).png({ compressionLevel: 6 }).toFile(path.join(outDir, "labels", `l${pad(i)}.png`));
    }
    extra.push(...seen.values());
    added += seen.size;
  }
  if (extra.length) {
    const file = path.join(outDir, "tracks.json");
    const json = JSON.parse(await fsp.readFile(file, "utf8"));
    json.tracks.push(...extra);
    json.edges = extra.length;
    await fsp.writeFile(file, JSON.stringify(json));
  }
  return added;
}
