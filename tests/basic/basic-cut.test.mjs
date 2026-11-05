// Loop 8 (tier-improve 2026-11-04): a Basic box selection on a long or
// variable-rate clip runs on a proven constant-rate cut from the clicked
// frame. Real ffmpeg/ffprobe, a synthetic phone-style clip (variable-rate,
// 14 s, 420 frames) and a real variable-rate corpus clip; no models, no spend.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { probeVideo } from "../../backend/lib/ffmpeg.js";
import { decodeFramesRgb } from "../../backend/lib/lite-decode.js";
import {
  basicCutPlan, buildBasicCut, requireBasicSeedSource, requireBasicSelectedSource, probeBasicClock,
  BASIC_CLOCK_TEXT, BASIC_SPAN_TEXT,
} from "../../backend/pipeline/basic/lib/selected-source.mjs";

const run = promisify(execFile);
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "basic-cut-"));
test.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));

// Phone-style variable rate: 30 fps nominal with jittered frame times.
async function phoneClip() {
  const out = path.join(dir, "phone-vfr.mp4");
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=14",
    "-vf", "setpts='(N/30+0.006*mod(N\\,3))/TB'", "-fps_mode", "passthrough", "-video_track_timescale", "90000",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", out]);
  return out;
}
const asUpload = (info) => ({ frames: info.frameCount, width: info.width, height: info.height, fps: info.fps });
async function rgbAt(file, index, w, h) {
  for await (const f of decodeFramesRgb(file, [index], { width: w, height: h })) return f.rgb;
  return null;
}
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]); return s / a.length; };

test("a long variable-rate phone clip is refused whole but accepted as a cut", async () => {
  const clip = await phoneClip();
  const upload = asUpload(await probeVideo(clip));
  assert.equal(upload.frames, 420);
  assert.throws(() => requireBasicSelectedSource(upload, 150), (e) => e.message === BASIC_CLOCK_TEXT);
  await assert.rejects(probeBasicClock(clip, upload.fps, upload.frames), (e) => e.message === BASIC_CLOCK_TEXT);
  assert.doesNotThrow(() => requireBasicSeedSource(upload, 150));
  const plan = basicCutPlan(upload, 150);
  assert.deepEqual({ start: plan.start, stride: plan.stride, count: plan.count }, { start: 150, stride: 2, count: 135 });

  const out = path.join(dir, "cut.mp4");
  const got = await buildBasicCut(clip, upload, plan, out);
  assert.equal(got.videoPath, out); assert.equal(got.seedFrameIndex, 0); assert.equal(got.frames, 135);
  const cut = await probeVideo(out);
  assert.deepEqual([cut.width, cut.height, cut.frameCount], [320, 180, 135]);
  // exact constant rate and inside the whole-source contract: the selected path takes it unchanged
  assert.deepEqual(await probeBasicClock(out, cut.fps, cut.frameCount), { kind: "cfr", fps: cut.fps, frames: 135, indexDomain: "source-frame", timeOrigin: "decode-frame-zero" });
  assert.doesNotThrow(() => requireBasicSelectedSource({ frames: cut.frameCount, width: cut.width, height: cut.height, fps: cut.fps }, 0));
  // frame-exact: cut frame k is source frame 150 + 2k (the clicked frame is cut frame 0)
  for (const k of [0, 1, 67, 134]) {
    const d = mad(await rgbAt(out, k, 320, 180), await rgbAt(clip, 150 + 2 * k, 320, 180));
    const off = mad(await rgbAt(out, k, 320, 180), await rgbAt(clip, 150 + 2 * k + 1, 320, 180));
    assert.ok(d < off, `cut frame ${k}: ${d.toFixed(2)} must beat the neighbour ${off.toFixed(2)}`);
    assert.ok(d < 3, `cut frame ${k} matches source ${150 + 2 * k} (${d.toFixed(2)})`);
  }
  assert.deepEqual(got.cut.start, 150); assert.ok(got.cut.mad.every((m) => m <= 3));
});

test("a real variable-rate corpus clip (roe deer, 15.08 fps average) cuts at its own rate", async () => {
  const clip = fileURLToPath(new URL("../../assets/corpus/roedeer.mp4", import.meta.url));
  assert.ok(fs.existsSync(clip), clip);
  const upload = asUpload(await probeVideo(clip));
  await assert.rejects(probeBasicClock(clip, upload.fps, upload.frames), (e) => e.message === BASIC_CLOCK_TEXT);
  const plan = basicCutPlan(upload, 15);
  assert.equal(plan.stride, 1);
  const got = await buildBasicCut(clip, upload, plan, path.join(dir, "roedeer-cut.mp4"));
  assert.equal(got.frames, upload.frames - 15);
  assert.ok(Math.abs(got.fps - upload.fps) < 0.001, `${got.fps} vs ${upload.fps}`);
});

test("plans keep the span and size rules", () => {
  const up = { frames: 1800, width: 1280, height: 720, fps: 30 };
  assert.deepEqual(basicCutPlan(up, 900), { start: 900, stride: 2, count: 180, rate: { num: 15, den: 1 } }, "12 s at 15 fps");
  assert.equal(basicCutPlan({ ...up, fps: 60 }, 0).stride, 4);
  assert.equal(basicCutPlan({ ...up, fps: 29.97002997 }, 0).rate.num / basicCutPlan({ ...up, fps: 29.97002997 }, 0).rate.den, 14.985);
  assert.throws(() => basicCutPlan(up, 1795), (e) => e.message === BASIC_SPAN_TEXT, "fewer than six cut frames");
  assert.throws(() => requireBasicSeedSource(up, 1795), (e) => e.message === BASIC_SPAN_TEXT);
  assert.throws(() => basicCutPlan({ ...up, width: 1282 }, 0), (e) => e.message === BASIC_CLOCK_TEXT);
  assert.throws(() => basicCutPlan({ ...up, height: 721 }, 0), (e) => e.message === BASIC_CLOCK_TEXT);
  assert.throws(() => basicCutPlan(up, 1800), (e) => e.message === BASIC_CLOCK_TEXT, "seed outside the clip");
});
