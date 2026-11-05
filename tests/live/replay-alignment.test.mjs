import assert from "node:assert/strict";
import { test } from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { upscaleMask } from "../../backend/lib/compose.js";
import { parseTrackedVideo, parseConceptImage } from "../../backend/lib/sam-image-result.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "backend/package.json"));
const sharp = require("sharp");
const { recordsOfKind } = await import(pathToFileURL(require.resolve("@meta-sam/parser")));
const run = promisify(execFile);
async function* events(response) {
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const line of text.split(/\r?\n/)) if (line.startsWith("data: ")) yield JSON.parse(line.slice(6));
}

test("replay masks preserve source coordinates and exclusive bounds with unequal padding", { timeout: 30000 }, async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "replay-alignment-"));
  const width = 80, height = 40, expected = Buffer.alloc(width * height);
  for (let y = 5; y < 30; y++) for (let x = 20; x < 40; x++) expected[y * width + x] = 1;
  await fsp.mkdir(path.join(dir, "labels"));
  await fsp.mkdir(path.join(dir, "frames"));
  await sharp(expected, { raw: { width, height, channels: 1 } }).png().toFile(path.join(dir, "labels/l00000.png"));
  const frame = await sharp(expected, { raw: { width, height, channels: 1 } }).linear(200, 30).png().toBuffer();
  await fsp.writeFile(path.join(dir, "frames/f00001.png"), frame);
  await sharp(frame).jpeg().toFile(path.join(dir, "frames/f00001.jpg"));
  const child = spawn(process.execPath, ["tests/live/fake-meta.mjs", path.join(dir, "labels"), "1", "0"], { cwd: root, windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await fsp.rm(dir, { recursive: true, force: true });
  });
  let log = "", errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const base = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => reject(new Error(`Replay exited ${code}: ${errors}`)));
    child.stdout.on("data", chunk => { log += chunk; const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/v1/); if (match) resolve(match[0]); });
  });
  const post = body => fetch(`${base}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "sam-3.1", input: [{ role: "user", content: body }], stream: true }) });
  const [hit] = await parseConceptImage(events(await post([
    { type: "input_text", text: "moose" }, { type: "input_image", image_url: `data:image/png;base64,${frame.toString("base64")}` },
  ])), "moose");
  assert.deepEqual(Buffer.from(upscaleMask(hit.mask, width, height)), expected, "image replay must retain every edge pixel");

  // The real tracker adds 10% borders independently on each axis, then removes them.
  // Using the horizontal border for y shifts a 1280x720 clip downward by 56 pixels.
  for (const [xPad, yPad] of [[0, 0], [8, 4]]) {
    const pw = width + 2 * xPad, ph = height + 2 * yPad;
    const file = path.join(dir, `pad-${xPad}-${yPad}.mp4`);
    await run("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-i", path.join(dir, "frames/f00001.png"), "-vf", `pad=${pw}:${ph}:${xPad}:${yPad}`, "-t", "1", "-r", "1", "-pix_fmt", "yuv420p", file]);
    const form = new FormData();
    form.append("file", new Blob([await fsp.readFile(file)]), "clip.mp4");
    const uploaded = await fetch(`${base}/files`, { method: "POST", body: form });
    assert.equal(uploaded.status, 200);
    const { id } = await uploaded.json();
    const result = await parseTrackedVideo(events(await post([{ type: "input_text", text: "moose" }, { type: "input_video", file_id: id }])));
    const [mask] = recordsOfKind(result.records, "mask");
    assert.ok(mask, "video replay must return a mask");
    assert.deepEqual(mask.bounds, { left: 20 + xPad, top: 5 + yPad, right: 40 + xPad, bottom: 30 + yPad });
    const padded = upscaleMask(mask, pw, ph), cropped = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cropped[y * width + x] = padded[(y + yPad) * pw + x + xPad];
    assert.deepEqual(cropped, expected, `video replay must align after removing borders ${xPad},${yPad}`);
  }
});
