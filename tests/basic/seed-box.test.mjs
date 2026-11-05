import test from "node:test";
import assert from "node:assert/strict";
import {
  boxIoU,
  parseSeedBox,
  matchSeedBox,
  SEED_BOX_WINDOW,
  SEED_BOX_MIN_IOU,
} from "../../backend/pipeline/basic/lib/keyframes.mjs";

// Selected-object identity: two same-label tracks must resolve by geometry,
// never by longest-frames fallback. All synthetic, offline.

const leftBox = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.5 };
const rightBox = { left: 0.65, top: 0.2, right: 0.85, bottom: 0.5 };

function boxMap(pairs) {
  // pairs: Map `${trackId}:${sample}` -> box
  const map = new Map(pairs);
  return (trackId, sample) => map.get(`${trackId}:${sample}`) ?? null;
}

test("boxIoU: identical=1, disjoint=0, half-overlap≈1/3, edge-touching=0", () => {
  assert.equal(boxIoU(leftBox, { ...leftBox }), 1);
  assert.equal(boxIoU(leftBox, rightBox), 0);
  const half = { left: 0.2, top: 0.2, right: 0.4, bottom: 0.5 };
  assert.ok(Math.abs(boxIoU(leftBox, half) - 1 / 3) < 1e-9);
  const touch = { left: 0.3, top: 0.2, right: 0.5, bottom: 0.5 };
  assert.equal(boxIoU(leftBox, touch), 0);
  assert.equal(boxIoU(leftBox, null), 0);
});

test("parseSeedBox rejects degenerate/out-of-range input", () => {
  assert.deepEqual(parseSeedBox("0.1,0.2,0.3,0.5"), leftBox);
  assert.throws(() => parseSeedBox("0.3,0.2,0.3,0.5"), /need 0<=l<r/);
  assert.throws(() => parseSeedBox("0.5,0.2,0.3,0.5"), /need 0<=l<r/);
  assert.throws(() => parseSeedBox("-0.1,0,0.5,0.5"), /need 0<=l<r/);
  assert.throws(() => parseSeedBox("0,0,1"), /want/);
  assert.throws(() => parseSeedBox("a,b,c,d"), /want/);
});

test("two same-label tracks: smaller high-IoU twin wins over longest", () => {
  const tracks = [
    { id: 1, first: 0, last: 100, frames: 90 },
    { id: 2, first: 40, last: 60, frames: 21 },
  ];
  const pairs = [];
  for (let s = 47; s <= 53; s += 1) {
    pairs.push([`1:${s}`, rightBox]);
    pairs.push([`2:${s}`, { ...leftBox }]);
  }
  const track = matchSeedBox(tracks, { seedBox: leftBox, seedSample: 50, getBox: boxMap(pairs) });
  assert.equal(track.id, 2);
});

test("id reorder does not matter (geometry is the stable key)", () => {
  const tracks = [
    { id: 7, first: 0, last: 100, frames: 12 },
    { id: 3, first: 0, last: 100, frames: 95 },
  ];
  const pairs = [];
  for (let s = 47; s <= 53; s += 1) {
    pairs.push([`7:${s}`, { ...leftBox }]);
    pairs.push([`3:${s}`, { ...rightBox }]);
  }
  assert.equal(matchSeedBox(tracks, { seedBox: leftBox, seedSample: 50, getBox: boxMap(pairs) }).id, 7);
  assert.equal(matchSeedBox(tracks, { seedBox: rightBox, seedSample: 50, getBox: boxMap(pairs) }).id, 3);
});

test("downscaled frames agree (normalized space on both sides)", () => {
  const tracks = [{ id: 1, first: 0, last: 50, frames: 40 }, { id: 2, first: 0, last: 50, frames: 40 }];
  // Same normalized boxes as if derived from a half-size raster.
  const pairs = [[`1:10`, { ...leftBox }], [`2:10`, { ...rightBox }]];
  assert.equal(matchSeedBox(tracks, { seedBox: leftBox, seedSample: 10, getBox: boxMap(pairs) }).id, 1);
});

test("off-by-one clock still matches inside the ±window", () => {
  const tracks = [{ id: 1, first: 0, last: 50, frames: 10 }, { id: 2, first: 0, last: 50, frames: 40 }];
  // Wanted twin only present one sample after the seed time mapping.
  const pairs = [[`1:11`, { ...leftBox }], [`2:10`, { ...rightBox }], [`2:11`, { ...rightBox }]];
  assert.equal(matchSeedBox(tracks, { seedBox: leftBox, seedSample: 10, getBox: boxMap(pairs) }).id, 1);
  assert.equal(SEED_BOX_WINDOW, 3);
});

test("seed boundary clips the window instead of failing", () => {
  const tracks = [{ id: 1, first: 0, last: 5, frames: 6 }];
  const pairs = [[`1:0`, { ...leftBox }], [`1:1`, { ...leftBox }]];
  assert.equal(matchSeedBox(tracks, { seedBox: leftBox, seedSample: 0, getBox: boxMap(pairs) }).id, 1);
});

test("no track covers the seed window: throws, never longest fallback", () => {
  const tracks = [
    { id: 1, first: 0, last: 10, frames: 100 },
    { id: 2, first: 90, last: 100, frames: 5 },
  ];
  assert.throws(() => matchSeedBox(tracks, { seedBox: leftBox, seedSample: 50, getBox: () => null }), /no match/);
});

test("seed box overlaps nothing in the window: low-confidence refusal", () => {
  const tracks = [{ id: 1, first: 45, last: 55, frames: 11 }];
  const pairs = [[`1:50`, { ...rightBox }]];
  assert.throws(
    () => matchSeedBox(tracks, { seedBox: leftBox, seedSample: 50, getBox: boxMap(pairs) }),
    /no match/
  );
  assert.ok(SEED_BOX_MIN_IOU > 0);
});

test("twin boxes within epsilon: ambiguity refusal", () => {
  const tracks = [
    { id: 1, first: 45, last: 55, frames: 11 },
    { id: 2, first: 45, last: 55, frames: 11 },
  ];
  const near = { left: 0.105, top: 0.2, right: 0.305, bottom: 0.5 };
  const pairs = [[`1:50`, { ...leftBox }], [`2:50`, near]];
  assert.throws(() => matchSeedBox(tracks, { seedBox: leftBox, seedSample: 50, getBox: boxMap(pairs) }), /ambiguous/);
});

test("late SAM start: nearest ring wins, the wide window rescues a former refusal", async () => {
  const { SEED_BOX_WINDOW_MAX } = await import("../../backend/pipeline/basic/lib/keyframes.mjs");
  // clip-b: masks begin 5 samples after the detect frame.
  const tracks = [{ id: 1, first: 20, last: 119, frames: 100 }];
  const pairs = [];
  for (let s = 20; s <= 30; s += 1) pairs.push([`1:${s}`, { ...leftBox }]);
  assert.throws(() => matchSeedBox(tracks, { seedSample: 15, seedBox: leftBox, getBox: boxMap(pairs) }), /no match/);
  assert.equal(matchSeedBox(tracks, { seedSample: 15, seedBox: leftBox, getBox: boxMap(pairs), window: SEED_BOX_WINDOW_MAX }).id, 1);
  assert.equal(SEED_BOX_WINDOW_MAX, 15);
  // A nearer exact match still beats a farther one.
  const two = [{ id: 1, first: 0, last: 60, frames: 60 }, { id: 2, first: 0, last: 60, frames: 60 }];
  const p2 = [[`2:16`, { ...leftBox }], [`1:25`, { ...leftBox }]];
  assert.equal(matchSeedBox(two, { seedSample: 15, seedBox: leftBox, getBox: boxMap(p2), window: SEED_BOX_WINDOW_MAX }).id, 2);
  // Beyond the wide window still refuses.
  const far = [[`1:31`, { ...leftBox }]];
  assert.throws(() => matchSeedBox(tracks, { seedSample: 15, seedBox: leftBox, getBox: boxMap(far), window: SEED_BOX_WINDOW_MAX }), /no match/);
});

// tier-improve 2026-11-04 (basic): clip-a (10 fps) failed "decoded 37 of 38
// keyframes" because two picks mapped to one source frame.
import { uniqueBySource, sampleToSourceFrame, selectKeyframes as pickEven } from "../../backend/pipeline/basic/lib/keyframes.mjs";
test("low-fps sources pick each source frame at most once", () => {
  const src = (s) => sampleToSourceFrame(s, 10);
  const present = Array.from({ length: 120 }, (_, i) => i);
  const unique = uniqueBySource(present, src);
  assert.equal(new Set(unique.map(src)).size, unique.length);
  const picks = pickEven(unique, 40);
  assert.equal(new Set(picks.map(src)).size, picks.length);
  // a snap onto a twin is deduped afterwards, earliest kept, order kept
  assert.deepEqual(uniqueBySource([5, 2, 1], src), [1, 5]); // samples 1 and 2 are both source frame 1
  // 1:1 mapping is a no-op
  assert.deepEqual(uniqueBySource([5, 1, 3], (s) => s), [1, 3, 5]);
});
