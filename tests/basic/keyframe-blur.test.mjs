import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blurDetails, BLUR_OUTLIER_FACTOR } from "../../backend/pipeline/basic/lib/keyframe-blur.mjs";

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// Quiet clip-wide floor (2.0) with caller-supplied spikes. Median stays 2.0.
const quiet = (extra = {}) => Object.assign(Object.fromEntries(range(0, 60).map((s) => [s, 2.0])), extra);

describe("blurDetails", () => {
  it("is a no-op on a clip with no outliers", () => {
    const kf = [10, 20, 30, 40];
    const out = blurDetails(kf, range(0, 50), quiet(), { seed: 10 });
    assert.deepEqual(out.kept, kf);
    assert.deepEqual(out.dropped, []);
    assert.deepEqual(out.moves, []);
  });

  it("never drops or moves the seed keyframe", () => {
    const kf = [10, 20, 30];
    const local = quiet({ 20: 9.5, 18: 1.0, 22: 1.0 });
    const out = blurDetails(kf, range(0, 40), local, { seed: 20, radius: 2 });
    assert.ok(out.kept.includes(20));
    assert.ok(!out.dropped.includes(20));
    assert.ok(!out.moves.some((m) => m.from === 20 || m.to === 20));
  });

  it("prefers snapping to a clean sample within +-2 before dropping", () => {
    const kf = [10, 20, 30];
    const local = quiet({ 20: 8.0, 19: 1.2, 21: 1.5 });
    const out = blurDetails(kf, range(0, 40), local, { radius: 2 });
    assert.deepEqual(out.dropped, []);
    assert.equal(out.moves.length, 1);
    assert.equal(out.moves[0].from, 20);
    assert.equal(out.moves[0].to, 19); // calmest clean neighbour
    assert.deepEqual(out.kept, [10, 19, 30]);
  });

  it("does not snap for a marginal gain (snapGain bar)", () => {
    const kf = [10, 20, 30];
    // threshold = 1.75*2 = 3.5; 20 is an outlier but 19 (3.4) improves only to 0.85x.
    const local = quiet({ 20: 4.0, 19: 3.4, 18: 3.4, 21: 3.4, 22: 3.4 });
    const out = blurDetails(kf, range(0, 40), local, { radius: 2, maxDropFrac: 1 });
    assert.deepEqual(out.moves, []);
    assert.deepEqual(out.dropped, [20]);
  });

  it("never drops two adjacent keyframes (worst of the pair wins)", () => {
    // 10 and 12 adjacent, both outliers, neighbours unscored so no snap.
    const kf = [10, 12, 30];
    const local = { 10: 9.0, 12: 7.0, 30: 2.0, 0: 2.0, 1: 2.0, 2: 2.0, 3: 2.0 };
    const out = blurDetails(kf, [10, 12, 30], local, { radius: 2, maxDropFrac: 1 });
    assert.equal(out.dropped.length, 1);
    assert.deepEqual(out.dropped, [10]);
    assert.ok(out.kept.includes(12));
  });

  it("caps drops at 15% of keyframes", () => {
    const kf = range(0, 39); // 40 keyframes, all outliers, no clean neighbours
    const local = Object.fromEntries(kf.map((s) => [s, 9.0]));
    for (const s of range(100, 140)) local[s] = 2.0; // quiet elsewhere sets median 2.0
    const out = blurDetails(kf, kf, local, {});
    assert.ok(out.dropped.length <= 6, `drops ${out.dropped.length} exceed 15%`);
    for (let i = 1; i < out.dropped.length; i += 1) {
      assert.ok(out.dropped[i] - out.dropped[i - 1] > 1, "adjacent drops");
    }
  });

  it("keeps strict time order and minGap when snaps collide", () => {
    // 10 and 13 both want the calm pocket; only one may take each slot.
    const kf = [10, 13, 30];
    const local = quiet({ 10: 8.0, 13: 9.0, 11: 1.0, 12: 1.1 });
    const out = blurDetails(kf, range(0, 40), local, { radius: 2, maxDropFrac: 1 });
    assert.deepEqual([...out.kept].sort((a, b) => a - b), out.kept);
    assert.equal(new Set(out.kept).size, out.kept.length);
    for (let i = 1; i < out.kept.length; i += 1) assert.ok(out.kept[i] - out.kept[i - 1] >= 1);
    // 13 (gain 8.0) beats 10 (gain 7.0) to slot 11; 10 falls through to a drop.
    assert.deepEqual(out.moves.map((m) => m.from), [13]);
    assert.deepEqual(out.dropped, [10]);
  });

  it("leaves unscored keyframes in place", () => {
    const kf = [10, 20, 30];
    const sparse = { 20: 8.0, 19: 1.0, 21: 1.0, 18: 2.0, 22: 2.0, 0: 2.0, 1: 2.0 };
    const out = blurDetails(kf, [10, 18, 19, 20, 21, 22, 30], sparse, {});
    assert.ok(out.kept.includes(10));
    assert.ok(out.kept.includes(30));
    assert.ok(!out.dropped.includes(10));
  });

  it("exports the documented outlier factor", () => {
    assert.equal(BLUR_OUTLIER_FACTOR, 1.75);
  });
});
