import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapKeyframes, snapDetails, GAIN_MARGIN } from "../../backend/pipeline/basic/lib/keyframe-snap.mjs";

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("snapKeyframes", () => {
  it("keeps the seed sample fixed even when a neighbour scores far higher", () => {
    const samples = [10, 20, 30];
    const score = { 10: 1.0, 20: 0.5, 21: 5.0, 22: 5.0, 30: 1.0 };
    const out = snapKeyframes(samples, range(8, 32), score, { radius: 2, keep: [20], minGap: 1 });
    assert.deepEqual(out, [10, 20, 30]);
  });

  it("never produces duplicates when two picks want the same target", () => {
    const samples = [10, 12];
    const score = { 10: 1.0, 11: 3.0, 12: 1.0 };
    const out = snapKeyframes(samples, range(8, 14), score, { radius: 2, keep: [], minGap: 1 });
    assert.equal(new Set(out).size, out.length);
    assert.ok(out[1] - out[0] >= 1);
  });

  it("preserves strict time order and minGap under crossing proposals", () => {
    const samples = [10, 13];
    // 10 wants 12, 13 wants 11: crossing. Only the higher gain may win.
    const score = { 10: 1.0, 11: 2.0, 12: 1.5, 13: 1.0 };
    const out = snapKeyframes(samples, range(8, 15), score, { radius: 2, keep: [], minGap: 1 });
    assert.deepEqual([...out].sort((a, b) => a - b), out);
    assert.ok(out[1] - out[0] >= 1);
    assert.equal(new Set(out).size, out.length);
  });

  it("does not move without the gain margin (boundary at 1.15x)", () => {
    const samples = [50];
    const below = { 50: 1.0, 51: 1.0 + (GAIN_MARGIN - 1) * 0.9 };
    assert.deepEqual(snapKeyframes(samples, range(48, 52), below, { radius: 2 }), [50]);
    const above = { 50: 1.0, 51: 1.0 + (GAIN_MARGIN - 1) * 1.1 };
    assert.deepEqual(snapKeyframes(samples, range(48, 52), above, { radius: 2 }), [51]);
  });

  it("respects the radius: a better sample outside the window is ignored", () => {
    const samples = [50];
    const score = { 50: 1.0, 51: 1.01, 55: 9.0 };
    const out = snapKeyframes(samples, range(45, 60), score, { radius: 2 });
    assert.deepEqual(out, [50]);
  });

  it("bounds every shift by the radius on a sweep", () => {
    const samples = [0, 11, 22, 32, 43, 54, 65, 76, 87, 97, 108, 119];
    const score = {};
    for (const s of range(0, 119)) score[s] = 1 + 0.1 * Math.sin(s * 1.7);
    score[75] = 0.5; // dip near keyframe 76
    const { snapped, moves } = snapDetails(samples, range(0, 119), score, { radius: 2, keep: [54], minGap: 1 });
    assert.equal(snapped.length, samples.length);
    snapped.forEach((s, i) => assert.ok(Math.abs(s - samples[i]) <= 2, `shift ${samples[i]}->${s} exceeds radius`));
    assert.deepEqual([...snapped].sort((a, b) => a - b), snapped);
    for (const m of moves) assert.ok(m.after >= GAIN_MARGIN * m.before);
  });

  it("leaves samples without scores in place and ignores unscored candidates", () => {
    const samples = [10, 20];
    const score = { 10: 1.0 }; // 20 and its neighbours unscored
    assert.deepEqual(snapKeyframes(samples, range(8, 22), score, { radius: 2 }), [10, 20]);
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(snapKeyframes([], [1, 2], {}, {}), []);
  });
});
