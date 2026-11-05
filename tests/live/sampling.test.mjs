import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sampleRate, makeHooks, Run } from "../../backend/lib/live.js";
import { trackInstances } from "../../backend/lib/track.js";
import { client } from "../../backend/lib/meta.js";

const exec = promisify(execFile);

test("Lite sampling reduces the processing rate, not just the displayed ghosts", () => {
  const duration = 20.14;
  const rates = [1, 2, 3].map(stride => sampleRate(30, duration, stride));
  assert.deepEqual(rates, [29, 14.5, 29 / 3]);
  assert.deepEqual(rates.map(fps => Math.round(fps * duration)), [584, 292, 195]);
  assert.equal(sampleRate(30, duration), rates[0], "existing callers keep their old sampling rate");
  assert.equal(sampleRate(30, duration, 10), 2.9);
  for (const bad of [0, -1, 11, 1.5, "2", NaN]) assert.throws(() => sampleRate(30, duration, bad), /frameStride/);
});

test("preview extraction and the actual SAM upload both contain fewer video frames", { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lite-sampling-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, "source.mp4");
  await exec("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x40:rate=12:duration=2", "-pix_fmt", "yuv420p", videoPath]);
  const uploads = [], deleted = [];
  t.mock.method(client.files, "create", async ({ file }) => {
    const name = file.path; file.destroy();
    const { stdout } = await exec("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "json", name]);
    const id = `sample-${uploads.length}`;
    uploads.push({ id, frames: Number(JSON.parse(stdout).streams[0].nb_read_frames) });
    return { id };
  });
  t.mock.method(client.files, "del", async id => { deleted.push(id); });
  t.mock.method(client.responses, "create", async () => (async function* () {
    yield { type: "response.output_text.done", item_id: "m", output_index: 0, content_index: 0, text: "" };
    yield { type: "response.completed" };
  })());
  const previewCounts = [], trackCounts = [];
  for (const stride of [1, 2, 3]) {
    const run = new Run("build", "sample-test", path.join(dir, `stride-${stride}`));
    const cuts = {}, hooks = makeHooks(run, cuts, []), fps = sampleRate(12, 2, stride);
    await hooks.beforeTrack({ videoPath, width: 64, height: 40, fps, seconds: 2 });
    previewCounts.push((await fs.readdir(path.join(hooks.dir, "frames"))).length);
    const tracked = await trackInstances({ videoPath, concept: "moose", outDir: path.join(run.dir, "world"), width: 64, height: 40, duration: 2, seconds: 2, sampleFps: fps });
    trackCounts.push(tracked.samples);
    assert.equal(run.events.find(e => e.type === "track-start").samples, tracked.samples);
    run.finish("done", { type: "done" });
  }
  assert.deepEqual(previewCounts, [24, 12, 8]);
  assert.deepEqual(trackCounts, [24, 12, 8]);
  assert.deepEqual(uploads.map(x => x.frames), [24, 12, 8], "these are decoded frames in the MP4s uploaded to SAM");
  assert.deepEqual(deleted, uploads.map(x => x.id));
});
