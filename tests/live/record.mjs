// Builds the fixture the mock API replays (tests/live/mock-api.mjs): the real hooks and the real Python
// events from one finished world run, over a tracked clip we already have labels for. No network, no SAM.
//
//   node tests/live/record.mjs <fixture dir> <moose work dir with labels/ tracks.json live/> <python log with @@live lines> <clip>
//
// The moose work dir and the log come from running backend/tools/make-world.py with LIVE_DIR=<work>/live.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Run, makeHooks } from "../../backend/lib/live.js";

const sharp = createRequire(path.resolve("backend/package.json"))("sharp");
const [fixture, work, log, clip] = process.argv.slice(2).map((p) => path.resolve(p));
const PY = process.env.DA3_PYTHON || "python";
const pad = (n) => String(n).padStart(5, "0");
await fsp.mkdir(fixture, { recursive: true });
const tracks = JSON.parse(await fsp.readFile(path.join(work, "tracks.json"), "utf8"));

// ── the build run ────────────────────────────────────────────────────────
{
  const dir = path.join(fixture, "live-build");
  await fsp.cp(path.join(work, "labels"), path.join(dir, "world", "labels"), { recursive: true });
  await fsp.cp(path.join(work, "live"), path.join(dir, "world", "live"), { recursive: true });
  await fsp.copyFile(path.join(work, "tracks.json"), path.join(dir, "world", "tracks.json"));
  const r = new Run("build", "mock", dir);
  const cuts = { queue: Promise.resolve(), samples: 0 };
  const hooks = makeHooks(r, cuts, []);
  r.emit({ type: "plan", from: 0, duration: tracks.samples / tracks.fps, sampleFps: tracks.fps, samples: tracks.samples, everyFrame: false, nativeFps: 30, subjects: [{ label: "moose" }], name: "livetest-moose" });
  r.stage("probe", "Looking at the camera");
  r.emit({ type: "probe", camera: { fixed: true, stabilizable: false, shift: 0.4, overlay: 0.9, crop: null } });
  await hooks.beforeTrack({ videoPath: clip, width: tracks.width, height: tracks.height, fps: tracks.fps, seconds: tracks.samples / tracks.fps });
  for (let s = 0; s < tracks.samples; s += 1) {
    const label = await sharp(path.join(dir, "world", "labels", `l${pad(s)}.png`)).extractChannel(0).raw().toBuffer();
    const raster = new Uint8Array(label.length);
    let any = false;
    for (let p = 0; p < label.length; p += 1) if (label[p] === 1) { raster[p] = 1; any = true; }
    if (any) hooks.onFrame(s, [{ id: "1", raster, bottom: 0 }], { chunk: 0, chunks: 1 });
  }
  await cuts.queue;
  await hooks.afterTrack({ ...tracks });
  await hooks.selection([1], tracks.tracks);
  r.stage("world", "Waiting for the GPU…");
  for (const line of (await fsp.readFile(log, "utf8")).split(/\r?\n/)) if (line.startsWith("@@live ")) hooks.onPython(JSON.parse(line.slice(7)));
  r.finish("done", { type: "done", viewer: "stable.html?clip=livetest-moose", name: "livetest-moose" });
  await fsp.writeFile(path.join(fixture, "build-events.json"), JSON.stringify(r.events));
  console.log("build events:", r.events.length);
}

// ── the detect run: the real DINO on the real frame, with the one object the labels hold ─
{
  const dir = path.join(fixture, "live-detect");
  await fsp.mkdir(dir, { recursive: true });
  const frame = path.join(dir, "frame.png");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", clip, "-frames:v", "1", frame]);
  const label = await sharp(path.join(work, "labels", "l00000.png")).extractChannel(0).raw().toBuffer();
  const index = Buffer.from(label.map((v) => (v === 1 ? 1 : 0)));
  await sharp(index, { raw: { width: tracks.width, height: tracks.height, channels: 1 } }).png().toFile(path.join(dir, "index.png"));
  await sharp(frame).resize({ width: 960 }).jpeg({ quality: 85 }).toFile(path.join(dir, "frame.jpg"));
  execFileSync(PY, ["-I", path.resolve("backend/tools/dino-embed.py"), frame, path.join(dir, "index.png"), path.join(dir, "dino")], { stdio: "inherit" });
  const dino = JSON.parse(await fsp.readFile(path.join(dir, "dino", "dino.json"), "utf8"));
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < index.length; i += 1) if (index[i]) { const x = i % tracks.width, y = (i / tracks.width) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const box = { left: x0 / tracks.width, top: y0 / tracks.height, right: (x1 + 1) / tracks.width, bottom: (y1 + 1) / tracks.height };
  const r = new Run("detect", "mock", dir);
  r.stage("frame", "Pulling the frame");
  r.emit({ type: "frame", url: r.url("frame.jpg"), width: tracks.width, height: tracks.height, frameIndex: 0, time: 0 });
  r.stage("spark", "Muse Spark is naming what it sees");
  r.emit({ type: "names", scene: "(mock fixture)", subjects: [{ label: "moose", main: true }] });
  r.stage("sam", "SAM 3.1 is cutting each of them out", { concepts: ["moose", "person", "animal", "vehicle"] });
  [["moose", [box]], ["person", []], ["animal", [box]], ["vehicle", []]].forEach(([concept, boxes], k) => r.emit({ type: "concept", concept, done: k + 1, of: 4, boxes: boxes.map((b) => [b.left, b.top, b.right, b.bottom]) }));
  r.emit({ type: "objects", objects: [{ id: 1, label: "moose", box, suggested: true }], indexUrl: r.url("index.png"), width: tracks.width, height: tracks.height });
  r.stage("dino", "DINOv3 is reading the frame");
  r.emit({ type: "dino", ...dino, pca: r.url("dino/pca.jpg"), heat: { 1: r.url("dino/heat_1.png") } });
  r.finish("done", { type: "done", frameIndex: 0, time: 0 });
  await fsp.writeFile(path.join(fixture, "detect-events.json"), JSON.stringify(r.events));
  console.log("detect events:", r.events.length);
}
