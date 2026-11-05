import test from "node:test";
import assert from "node:assert/strict";
import {
  robustAffineFit,
  median,
  percentile,
  normalizeDepth01,
  backgroundDiff,
  platePassesValidation,
} from "../../backend/pipeline/basic/lib/normalize.mjs";

const f64 = (a) => Float64Array.from(a);

test("robustAffineFit recovers scale and shift, ignores outliers", () => {
  const ref = f64([10, 20, 30, 40, 50, 60, 1000]);
  const img = f64([5, 10, 15, 20, 25, 30, 1]); // true: a=2, b=0, last is junk
  const { scale, shift } = robustAffineFit(ref, img);
  assert.ok(Math.abs(scale - 2) < 1e-9);
  assert.ok(Math.abs(shift) < 1e-9);
});

test("robustAffineFit with shift recovers exact parameters", () => {
  const ref = f64([12, 22, 32, 42, 52, 500]); // last is junk (leaked subject)
  const img = f64([5, 10, 15, 20, 25, 26]); // true: a=2, b=2
  const { scale, shift } = robustAffineFit(ref, img);
  assert.ok(Math.abs(scale - 2) < 1e-9, `scale ${scale}`);
  assert.ok(Math.abs(shift - 2) < 1e-9, `shift ${shift}`);
});

test("robustAffineFit rejects empty input", () => {
  assert.throws(() => robustAffineFit(f64([]), f64([])), /non-empty/);
});

test("median and percentile", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([0, 10, 20, 30, 40], 50), 20);
  assert.equal(percentile([0, 100], 1), 1);
  assert.equal(percentile([0, 100], 99), 99);
});

test("normalizeDepth01 windows robustly and clips", () => {
  const depth = new Array(100).fill(0).map((_, i) => i); // 0..99
  const { bytes, min, max } = normalizeDepth01(depth);
  assert.ok(min >= 0.5 && min <= 1.5);
  assert.ok(max >= 97.5 && max <= 98.5);
  assert.equal(bytes[0], 0);
  assert.equal(bytes[99], 255);
  assert.ok(bytes[50] > 100 && bytes[50] < 160);
});

test("backgroundDiff measures only unmasked pixels", () => {
  const a = [10, 10, 10, 10];
  const b = [12, 12, 200, 200]; // last two differ wildly but are masked
  const mask = [0, 0, 1, 1];
  const { mean, p95, pixels } = backgroundDiff(a, b, mask);
  assert.equal(pixels, 2);
  assert.equal(mean, 2);
  assert.equal(p95, 2);
  assert.ok(platePassesValidation({ mean: 2, p95: 2 }));
  assert.ok(!platePassesValidation({ mean: 2, p95: 200 }));
  assert.ok(!platePassesValidation({ mean: 20, p95: 2 }));
});
