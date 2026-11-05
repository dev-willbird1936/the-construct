import assert from "node:assert/strict";
import test from "node:test";
import { validateMeta } from "../stable-math.mjs";

// The shape make-world.py writes (version 2): any number of animals, one shell per animal per moment.
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const shell = (i, track) => ({
  track, i, t: i / 10, box: [10, 20, 110, 90], gw: 20, gh: 14, d: [0.4, 0.5], off: 0, tex: `sub/t${track}_${i}.webp`,
  centroid: [0.1, -0.02, -0.45], foot: [0.1, -0.1, -0.45],
});
const world = () => ({
  version: 2, width: 1280, height: 720, fovY: 31.7, tanX: 0.505, tanY: 0.284, fixed: true,
  times: [0, 0.1, 0.2, 0.3], cameras: [identity, identity, identity, identity], env: [{}], sub: [],
  shells: [shell(0, 1), shell(1, 1), shell(1, 2), shell(3, 2)], tracks: [{ id: 1 }, { id: 2 }],
});

test("a version 2 world with several animals is valid", () => {
  assert.doesNotThrow(() => validateMeta(world()));
});

test("a version 2 world rejects bad shells and bad lens data", () => {
  const bad = (mutate) => { const w = world(); mutate(w); return () => validateMeta(w); };
  assert.throws(bad((w) => { w.shells[0].i = 9; }), /invalid or incomplete/);            // a moment that does not exist
  assert.throws(bad((w) => { w.shells[0].foot = [0, NaN, 0]; }), /invalid or incomplete/);
  assert.throws(bad((w) => { w.shells[1].gw = 1; }), /invalid or incomplete/);           // a grid needs two samples a side
  assert.throws(bad((w) => { w.shells = [w.shells[0]]; }), /invalid or incomplete/);
  assert.throws(bad((w) => { w.tanX = 0; }), /invalid or incomplete/);
  assert.throws(bad((w) => { w.times = [0, 0, 0.2, 0.3]; }), /invalid or incomplete/);   // time must run forward
  assert.throws(bad((w) => { w.cameras.pop(); }), /invalid or incomplete/);
});
