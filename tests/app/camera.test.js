import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { measureCamera, recommendTier } from "../../backend/app/camera.js";

const run = promisify(execFile);

async function clip(name, filter, seconds = 3) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "construct-cam-"));
  const file = path.join(dir, name);
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `${filter}`, "-t", String(seconds), "-pix_fmt", "yuv420p", file]);
  return file;
}

const FIXED = "testsrc2=size=320x180:rate=10:duration=3"; // static pattern with small animated elements
test("a fixed camera with a moving subject is not 'moving'", async () => {
  const file = await clip("fixed.mp4", FIXED);
  const out = await measureCamera(file, 3);
  assert.equal(out.moving, false, JSON.stringify(out));
});

test("a slow pan is detected as camera movement", async () => {
  const file = await clip("pan.mp4", "testsrc2=size=480x180:rate=10:duration=3,crop=320:180:x='t*20':y=0");
  const out = await measureCamera(file, 3);
  assert.equal(out.moving, true, JSON.stringify(out));
});

test("tier recommendation follows subjects without content rejections", () => {
  assert.equal(recommendTier({ camera: "fixed", subjects: ["fox"] }, { moving: false, confident: true }).tier, "basic");
  assert.equal(recommendTier({ camera: "fixed", subjects: ["fox"] }, { moving: true }).tier, "basic");
  assert.equal(recommendTier({ camera: "handheld", subjects: ["fox"] }, null).tier, "basic");
  assert.equal(recommendTier({ camera: "fixed", subjects: ["a", "b"] }, { moving: false }).tier, "basic");
  assert.equal(recommendTier({ camera: "fixed", subjects: ["a", "b", "c", "d", "e"] }, { moving: false }).tier, "lite");
  assert.equal(recommendTier({ category: "drone", camera: "drone", subjects: [] }, null).tier, "lite");
  assert.equal(recommendTier({ category: "street-sport", camera: "fixed", subjects: ["a"] }, { moving: false }).tier, "lite");
  assert.equal(recommendTier({ category: "product", camera: "fixed", subjects: ["mug"] }, { moving: false, confident: true }).tier, "advanced");
  assert.equal(recommendTier({ category: "product", camera: "handheld", subjects: ["mug"] }, { moving: true }).tier, "advanced");
  assert.equal(recommendTier({ camera: "moving", subjects: ["a", "b", "c", "d", "e"] }, { moving: true }).tier, "lite");
  assert.equal(recommendTier({ decline: "screen recording" }, null).tier, "basic");
  assert.equal(recommendTier({ camera: "unknown", subjects: [] }, null).tier, "basic");
  assert.match(recommendTier({ camera: "moving", subjects: ["fox"] }, { moving: true }).why, /steady camera/i);
});
