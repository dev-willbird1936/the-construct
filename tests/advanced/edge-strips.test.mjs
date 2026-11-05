// The edge strips are tracked two at a time (EDGE_PARALLEL), then merged in the old order, so the
// labels and tracks.json come out the same as tracking them one after another. Real ffmpeg and sharp
// on a generated 2 s clip; the SAM tracker is stubbed (it draws fixed shapes and counts overlap).
// Run: node --test tests/advanced/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const sharpUrl = pathToFileURL(require.resolve("sharp")).href;
const sharp = (await import(sharpUrl)).default;
const W = 160, H = 90, FPS = 15, SECONDS = 2, SAMPLES = FPS * SECONDS;

// the stub tracker: per strip, one animal the full pass missed (it moves with the frame, and the
// backward strips find it a little wider, so merge order decides who gets the pixels and the ids)
// and one animal the full pass already has (dropped by the merge)
const trackStub = `import fs from "node:fs/promises"; import path from "node:path"; import sharp from "${sharpUrl}";
  export async function trackInstances(a) {
    const s = globalThis.__strips; s.now += 1; s.peak = Math.max(s.peak, s.now);
    await new Promise((r) => setTimeout(r, 120));
    const back = a.outDir.endsWith("_back"), n = Math.round(a.seconds * a.sampleFps);
    await fs.mkdir(path.join(a.outDir, "labels"), { recursive: true });
    for (let i = 0; i < n; i += 1) {
      const lab = Buffer.alloc(a.width * a.height);
      const t = back ? n - 1 - i : i;                 // a reversed strip sees the opening backwards
      const x0 = 40 + t * 2, x1 = x0 + (back ? 40 : 30);
      for (let y = 10; y < 40; y += 1) for (let x = x0; x < Math.min(a.width, x1); x += 1) lab[y * a.width + x] = 3;
      for (let y = 30; y < 50; y += 1) for (let x = 0; x < 30; x += 1) lab[y * a.width + x] = 5;
      await sharp(lab, { raw: { width: a.width, height: a.height, channels: 1 } }).png().toFile(path.join(a.outDir, "labels", "l" + String(i).padStart(5, "0") + ".png"));
    }
    s.now -= 1;
    return { width: a.width, height: a.height };
  }`;

async function world() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edge-strips-"));
  const video = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=30:duration=${SECONDS}`, "-pix_fmt", "yuv420p", video]);
  const out = path.join(dir, "work");
  await fs.mkdir(path.join(out, "labels"), { recursive: true });
  for (let i = 0; i < SAMPLES; i += 1) {
    const lab = Buffer.alloc(W * H);
    for (let y = 40; y < 51; y += 1) for (let x = 2; x < 9; x += 1) lab[y * W + x] = 1;       // small, at the left edge
    for (let y = 30; y < 42; y += 1) for (let x = 150; x < 157; x += 1) lab[y * W + x] = 2;   // small, at the right edge
    await sharp(lab, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(out, "labels", `l${String(i).padStart(5, "0")}.png`));
  }
  await fs.writeFile(path.join(out, "tracks.json"), JSON.stringify({ fps: FPS, tracks: [{ id: 1 }, { id: 2 }] }));
  return { dir, video, out };
}

async function edgesWith(parallel, dir, env = {}) {
  await fs.writeFile(path.join(dir, "track.js"), trackStub);
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  const source = (await fs.readFile(new URL("../../backend/lib/edges.js", import.meta.url), "utf8")).replace('from "sharp"', `from "${sharpUrl}"`);
  const file = path.join(dir, `edges-${parallel}.mjs`);
  await fs.writeFile(file, source);
  const vars = { EDGE_PARALLEL: String(parallel), ...env };
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return (await import(pathToFileURL(file))).trackEdges; } finally {
    for (const [k, v] of Object.entries(before)) if (v == null) delete process.env[k]; else process.env[k] = v;
  }
}

async function run(parallel, env = {}) {
  const { dir, video, out } = await world();
  const trackEdges = await edgesWith(parallel, dir, env);
  globalThis.__strips = { now: 0, peak: 0 };
  const stages = [];
  const tracked = { width: W, height: H, samples: SAMPLES, fps: FPS };
  const added = await trackEdges({ videoPath: video, concept: "wolf", outDir: out, tracked, seconds: SECONDS, onStage: (s) => stages.push(s) });
  const labels = [];
  for (let i = 0; i < SAMPLES; i += 1) labels.push(await sharp(path.join(out, "labels", `l${String(i).padStart(5, "0")}.png`)).extractChannel(0).raw().toBuffer());
  const tracks = JSON.parse(await fs.readFile(path.join(out, "tracks.json"), "utf8"));
  return { added, labels, tracks, stages, peak: globalThis.__strips.peak };
}

test("strips tracked two at a time merge exactly as strips tracked in turn", async () => {
  const one = await run(1);
  const two = await run(2);
  assert.equal(one.peak, 1, "EDGE_PARALLEL=1 tracks one strip at a time");
  assert.equal(two.peak, 2, "EDGE_PARALLEL=2 tracks two strips at once");
  assert.ok(one.added > 0, "the strips found animals the full pass missed");
  assert.equal(two.added, one.added);
  assert.deepEqual(two.tracks, one.tracks);
  for (let i = 0; i < SAMPLES; i += 1) assert.ok(two.labels[i].equals(one.labels[i]), `labels differ at frame ${i}`);
  assert.equal(one.stages.length, 4);
  assert.equal(two.stages.length, 2);
  assert.match(two.stages[0], /left and right edges/);
  assert.match(two.stages[1], /left \(backwards\) and right \(backwards\) edges/);
});

test("tracked at a stride, every sample takes the nearest strip frame, the last one included", async () => {
  // 30 samples, a strip tracked at every other one has 15 frames: sample 29 rounds to frame 15, one past the end
  const strided = await run(2, { EDGE_STRIDE: "2" });
  assert.ok(strided.added > 0);
  for (const i of [0, 1, SAMPLES - 2, SAMPLES - 1]) assert.ok(strided.labels[i].some((v) => v >= 100), `sample ${i} has the strips' animal`);
});
