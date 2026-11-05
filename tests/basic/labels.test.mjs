import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { maskStats, maskStatsUnion, erodeAlpha, bleedFill } from "../../backend/pipeline/basic/run-basic.mjs";

// sharp resolves from the backend install (same copy the pipeline uses).
const require = createRequire(import.meta.url);
const sharp = require("../../backend/node_modules/sharp");

test("maskStats reads track.js label rasters as single-channel ids", async () => {
  // track.js writes 1-channel raw ids to PNG; libvips expands palette PNGs
  // to RGB on load, so the reader must take channel 0 (a bare .raw() read
  // has stride 3 and misplaces every mask). This is the regression test.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "basic-label-"));
  try {
    const W = 64, H = 48;
    const raster = Buffer.alloc(W * H, 0);
    for (let y = 10; y < 20; y += 1) for (let x = 5; x < 15; x += 1) raster[y * W + x] = 3;
    const png = path.join(dir, "l00000.png");
    await sharp(Buffer.from(raster), { raw: { width: W, height: H, channels: 1 } }).png().toFile(png);
    const st = await maskStats(png, 3, W, H);
    assert.equal(st.mask.length, W * H, "mask must be one byte per pixel");
    assert.equal(st.n, 100);
    assert.deepEqual(st.box, [5, 10, 14, 19]);
    assert.ok(Math.abs(st.centroid[0] - 9.5 / W) < 1e-9);
    assert.ok(Math.abs(st.centroid[1] - 14.5 / H) < 1e-9);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("bleedFill replaces transparent black with neighbour colour", () => {
  // Cell resampling smears transparent-black into a dark halo; bleeding
  // nearby opaque RGB outward keeps the fringe subject-coloured. Alpha
  // must be untouched, opaque pixels unchanged.
  const W = 8, H = 8;
  const rgba = Buffer.alloc(W * H * 4, 0);
  const set = (x, y, r, g, b, a) => rgba.set([r, g, b, a], (y * W + x) * 4);
  for (let y = 2; y < 6; y += 1) for (let x = 2; x < 6; x += 1) set(x, y, 200, 100, 50, 255);
  bleedFill(rgba, W, H, [0, 0, W - 1, H - 1]);
  const at = (x, y) => [...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
  assert.deepEqual(at(3, 3), [200, 100, 50, 255], "opaque unchanged");
  assert.equal(at(0, 0)[3], 0, "alpha untouched");
  assert.ok(at(1, 3)[0] > 150 && at(1, 3)[3] === 0, `fringe bled, got ${at(1, 3)}`);
  assert.ok(at(0, 3)[0] > 100, `4px diffusion reaches far fringe, got ${at(0, 3)}`);
});

test("maskStatsUnion ORs several ids with one binary mask", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "basic-label-"));
  try {
    const W = 64, H = 48;
    const raster = Buffer.alloc(W * H, 0);
    for (let y = 10; y < 20; y += 1) for (let x = 5; x < 15; x += 1) raster[y * W + x] = 1;
    for (let y = 30; y < 40; y += 1) for (let x = 40; x < 50; x += 1) raster[y * W + x] = 2;
    const png = path.join(dir, "l00000.png");
    await sharp(Buffer.from(raster), { raw: { width: W, height: H, channels: 1 } }).png().toFile(png);
    const st = await maskStatsUnion(png, [1, 2], W, H);
    assert.equal(st.n, 200);
    assert.deepEqual(st.box, [5, 10, 49, 39]);
    assert.ok(Math.abs(st.centroid[0] - 27 / W) < 1e-9);
    const single = await maskStatsUnion(png, [2], W, H);
    assert.equal(single.n, 100, "single id behaves like maskStats");
    assert.deepEqual(single.box, [40, 30, 49, 39]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("erodeAlpha pulls the opaque core back 1px", () => {
  const W = 8, H = 8;
  const a = Buffer.alloc(W * H, 0);
  for (let y = 2; y < 6; y += 1) for (let x = 2; x < 6; x += 1) a[y * W + x] = 255;
  const e = erodeAlpha(a, W, H);
  assert.equal(e[3 * W + 3], 255, "core survives");
  assert.equal(e[2 * W + 2], 0, "rim pixel eroded");
  assert.equal(e[2 * W + 3], 0, "edge pixel eroded");
  assert.equal(e[0], 0, "background stays");
});
