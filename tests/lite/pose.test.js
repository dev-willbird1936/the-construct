import { test } from "node:test";
import assert from "node:assert/strict";
import { frameStats, selectPoses, appearanceDist, meanPairwiseMotion, STATIC_MOTION, STAT_GRID } from "../../backend/app/lite-pose.js";

// Solid white disc on transparency; rasterised without dependencies.
function discFrame(w, h, cx, cy, r) {
  const rgba = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (Math.hypot(x - cx, y - cy) <= r) {
        const o = (y * w + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 255;
      }
    }
  }
  return frameStats(rgba, w, h);
}

const W = 120, H = 90, R = 18;

test("still subject collapses to ~3 poses, first+last kept", () => {
  const stats = Array.from({ length: 30 }, () => discFrame(W, H, 60, 45, R));
  const out = selectPoses(stats);
  assert.ok(out.length >= 3 && out.length <= 5, `poses ${out.length}`);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 29);
});

test("steady travel keeps a bounded run of distinct poses", () => {
  const stats = Array.from({ length: 60 }, (_, i) => discFrame(W, H, 25 + (70 * i) / 59, 45, R));
  const out = selectPoses(stats, { max: 14 });
  assert.ok(out.length >= 8 && out.length <= 14, `poses ${out.length}`);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 59);
  for (let k = 1; k < out.length; k += 1) assert.ok(out[k] > out[k - 1], "strictly increasing");
});

test("border-touching poses are dropped", () => {
  const stats = Array.from({ length: 12 }, (_, i) => discFrame(W, H, 8 + (104 * i) / 11, 45, R));
  assert.ok(stats[0].border && stats[11].border, "ends touch the border");
  const out = selectPoses(stats, { max: 14, min: 3 });
  assert.ok(!out.includes(0) || out.length <= 3, `first dropped unless starved: ${out}`);
  assert.ok(out.length >= 3, "minimum kept");
});

test("over-max thins by appearance keeping first+last", () => {
  const stats = Array.from({ length: 90 }, (_, i) => discFrame(W, H, 25 + (70 * i) / 89, 30 + (30 * i) / 89, R));
  const out = selectPoses(stats, { max: 10 });
  assert.ok(out.length <= 10, `poses ${out.length}`);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 89);
});

test("over-max thinning keeps distinct looks, not just spacing", () => {
  // Fast-travelling disc, alternating white / dark red: every frame moves
  // enough to pass the motion gate, so thinning (not gating) decides.
  // Diversity thinning must keep both colours.
  const stats = [];
  for (let i = 0; i < 24; i += 1) {
    const rgba = Buffer.alloc(W * H * 4, 0);
    const cx = 22 + (76 * i) / 23;
    const red = i % 2 === 1;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (Math.hypot(x - cx, y - 45) <= R) {
          const o = (y * W + x) * 4;
          rgba[o] = 255; rgba[o + 1] = red ? 20 : 255; rgba[o + 2] = red ? 15 : 255; rgba[o + 3] = 255;
        }
      }
    }
    stats.push(frameStats(rgba, W, H));
  }
  assert.ok(appearanceDist(stats[0], stats[1]) > appearanceDist(stats[0], stats[2]), "colour counts");
  const out = selectPoses(stats, { max: 6, minGapSec: 0 });
  assert.ok(out.length <= 6, `poses ${out.length}`);
  assert.equal(out[0], 0); assert.equal(out[out.length - 1], 23);
  const cols = out.map((i) => (stats[i].col[1] > 0.5 ? "w" : "r")).join("");
  assert.ok(cols.includes("w") && cols.includes("r"), `both looks kept: ${cols}`);
});

test("subject leaving the frame ends on the last whole pose", () => {
  const stats = Array.from({ length: 30 }, (_, i) => discFrame(W, H, 20 + (120 * i) / 29, 45, R));
  assert.equal(stats[29].coverage, 0, "last frame has exited entirely");
  const out = selectPoses(stats, { max: 14 });
  assert.ok(!out.includes(29), `exited frame dropped: ${out}`);
  assert.ok(out.length >= 3, "row still stands");
});

test("minimum time gap spreads an approaching subject", () => {
  // Growing disc, fixed centre: heavy mask overlap, timestamps 0.2 s apart.
  const stats = Array.from({ length: 30 }, (_, i) => discFrame(W, H, 60, 45, 10 + (10 * i) / 29));
  const times = stats.map((_, i) => i * 0.2);
  const out = selectPoses(stats, { max: 14, timestamps: times, minGapSec: 1.0 });
  for (let k = 1; k < out.length; k += 1) {
    assert.ok(times[out[k]] - times[out[k - 1]] >= 1.0 - 1e-9, `gap ${out}`);
  }
  assert.equal(out[out.length - 1], 29, "now-pose stands");
});

test("now-pose displaces instead of stacking inside the gap", () => {
  const stats = Array.from({ length: 6 }, () => discFrame(W, H, 60, 45, R));
  const times = [0, 4.8, 4.9, 5.0, 5.1, 6.0];
  const out = selectPoses(stats, { max: 14, timestamps: times });
  assert.ok(out.includes(5), `now kept: ${out}`);
  assert.ok(out.length <= 4, `no head-on stack: ${out}`);
});

test("deterministic on identical input", () => {
  const stats = Array.from({ length: 40 }, (_, i) => discFrame(W, H, 10 + (100 * i) / 39, 45, R));
  assert.deepEqual(selectPoses(stats), selectPoses(stats));
});

test("empty input stays empty", () => {
  assert.deepEqual(selectPoses([]), []);
});

test("walking gait keeps at least 6 poses", () => {
  // Steady travel + articulating shape (alternating stride): a walking
  // subject must not thin below 6 poses on a 6 s clip.
  const stats = Array.from({ length: 90 }, (_, i) => discFrame(W, H, 25 + (70 * i) / 89, 45, i % 8 < 4 ? 14 : 20));
  const times = stats.map((_, i) => (i * 6) / 89);
  const out = selectPoses(stats, { max: 12, timestamps: times });
  assert.ok(out.length >= 6, `walking keeps ${out.length}: ${out}`);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 89);
});

test("motion gate: identical frames score zero (static)", () => {
  // A perfectly still subject (the magiccup mug): every pair is identical.
  const stats = Array.from({ length: 10 }, () => discFrame(W, H, 60, 45, R));
  const picked = selectPoses(stats, { max: 14 });
  const sub = picked.map((i) => stats[i]);
  assert.equal(meanPairwiseMotion(sub), 0, "no travel, no change");
  assert.ok(meanPairwiseMotion(sub) < STATIC_MOTION, "trips the static gate");
});

test("motion gate: travelling subject clears the static threshold", () => {
  const stats = Array.from({ length: 60 }, (_, i) => discFrame(W, H, 25 + (70 * i) / 59, 45, R));
  const picked = selectPoses(stats, { max: 14 });
  const sub = picked.map((i) => stats[i]);
  const mean = meanPairwiseMotion(sub);
  assert.ok(mean > STATIC_MOTION, `moving clears ${STATIC_MOTION}: ${mean}`);
});

test("motion gate: single pose scores zero", () => {
  assert.equal(meanPairwiseMotion([discFrame(W, H, 60, 45, R)]), 0);
  assert.equal(meanPairwiseMotion([]), 0);
});
