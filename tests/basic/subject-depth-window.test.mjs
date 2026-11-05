// tier-improve 2026-11-04 (basic): subject depth cells get their own
// quantization window when the subject is nearer than the plate's 99th
// percentile (v1 grizzly: 20.6% of bear pixels clipped at 255).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { subjectDepthWindow } from "../../backend/pipeline/basic/run-basic.mjs";

const ramp = (lo, hi, n = 1000) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

test("a subject inside the plate range keeps the plate mapping exactly", () => {
  assert.deepEqual(subjectDepthWindow(ramp(1.5, 3.5), 1, 4), { min: 1, max: 4 });
});

test("a nearer subject widens only the far end it exceeds", () => {
  const w = subjectDepthWindow(ramp(2, 6), 0.3, 4.1);
  assert.equal(w.min, 0.3);
  assert.ok(w.max > 5.9 && w.max <= 6, `max ${w.max}`);
});

test("outliers past the 0.5-99.5% tails do not stretch the window", () => {
  const vals = [...ramp(1, 3), 50, -50];
  assert.deepEqual(subjectDepthWindow(vals, 0, 4), { min: 0, max: 4 });
});

test("too few or non-finite samples fall back to the plate mapping", () => {
  assert.deepEqual(subjectDepthWindow([9, 9, 9], 0, 4), { min: 0, max: 4 });
  assert.deepEqual(subjectDepthWindow([...Array(30).fill(NaN)], 0, 4), { min: 0, max: 4 });
});

test("specimen records the window and the viewer maps it back to plate units", () => {
  const run = fs.readFileSync(new URL("../../backend/pipeline/basic/run-basic.mjs", import.meta.url), "utf8");
  assert.match(run, /subject: \{ min: subjectDepth\.min, max: subjectDepth\.max \}/);
  const view = fs.readFileSync(new URL("../../view-basic.js", import.meta.url), "utf8");
  assert.match(view, /, s = d\.subject;/);
  assert.match(view, /subjWin\.b \+ subjWin\.a \* sampleCell\(depthData, depthImg\.w, frame \+ 1, u, v\)\[0\] \/ 255/);
});

// Pose rate: ~6 keyframes a second, 40-60 (night-bear 12 s stepped at 3.3 Hz).
import { defaultMaxKeyframes } from "../../backend/pipeline/basic/run-basic.mjs";
test("keyframe budget scales with the clip span inside 40-60", () => {
  assert.equal(defaultMaxKeyframes(6.5), 40);
  assert.equal(defaultMaxKeyframes(8), 48);
  assert.equal(defaultMaxKeyframes(12), 60);
  assert.equal(defaultMaxKeyframes(30), 60);
  assert.equal(defaultMaxKeyframes(NaN), 40);
  assert.equal(defaultMaxKeyframes(12, 50), 50);
});


// Loop 6: close-ups ship, so a subject at the lens must not sit at the camera.
import { depthKnee } from "../../backend/pipeline/basic/run-basic.mjs";
test("depth knee keeps ordinary subjects and bounds lens-close ones to one plate span", () => {
  const k = depthKnee(0, 4); // span 4: unchanged up to 6, bounded below 8
  assert.equal(k(3), 3);
  assert.equal(k(5.4), 5.4); // grizzly-like overshoot (0.35 span) untouched
  assert.ok(k(29) < 8 && k(29) > 7.9, `far ${k(29)}`);
  assert.ok(k(7) < k(9) && k(9) < k(29), "order preserved");
  assert.ok(k(-6) > -4 && k(-1) === -1, "symmetric on the far side");
});
