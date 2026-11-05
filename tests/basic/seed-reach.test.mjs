// Loop 12 (tier-improve 2026-11-04): a Basic pick at the picker's default
// 0:00 failed "could not match the selected object in the video pass". On
// slovakdeer the frame-0 detect found the deer, but the concept pass masked
// it only from sample 27 (1.8 s), past the ±15-sample window, so the click
// matched nothing. The search now reaches the pass's nearest masked samples,
// nearest ring first, ties still refused, and a far ring must sit on the
// click (IoU >= SEED_BOX_REACH_MIN_IOU), not merely touch it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const KF = process.env.SEED_REACH_KF || new URL("../../backend/pipeline/basic/lib/keyframes.mjs", import.meta.url).href;
const RB = process.env.SEED_REACH_RB || new URL("../../backend/pipeline/basic/run-basic.mjs", import.meta.url);
const { matchSeedBox, SEED_BOX_WINDOW_MAX, SEED_BOX_REACH_MIN_IOU } = await import(KF);

const boxMap = (pairs) => { const m = new Map(pairs); return (id, s) => m.get(`${id}:${s}`) ?? null; };
// slovakdeer, journey L2d: the clicked detect box and the pass's own box at sample 27
const click = { left: 0.3921875, top: 0.3416666666666667, right: 0.621875, bottom: 0.7291666666666666 };
const deer = { left: 0.391, top: 0.344, right: 0.629, bottom: 0.731 };
const lateDeer = () => {
  const pairs = [];
  for (let s = 27; s <= 119; s += 1) pairs.push([`1:${s}`, deer]);
  return { tracks: [{ id: 1, first: 27, last: 119, frames: 93 }], getBox: boxMap(pairs) };
};

test("a pick at 0:00 matches its object when the video pass masks it only from 1.8 s", () => {
  const { tracks, getBox } = lateDeer();
  assert.throws(() => matchSeedBox(tracks, { seedBox: click, seedSample: 0, getBox, window: SEED_BOX_WINDOW_MAX }), /no match/, "the 1 s window alone still refuses");
  assert.equal(matchSeedBox(tracks, { seedBox: click, seedSample: 0, getBox, window: SEED_BOX_WINDOW_MAX, reach: 119 }).id, 1);
});

test("past the window a match must sit on the click, ties still refuse, nearest still wins", () => {
  assert.ok(SEED_BOX_REACH_MIN_IOU >= 0.3);
  const tracks = [{ id: 1, first: 30, last: 60, frames: 31 }, { id: 2, first: 40, last: 60, frames: 21 }];
  const touch = { left: 0.55, top: 0.3416, right: 0.8, bottom: 0.729 }; // IoU ~0.18 with the click
  assert.throws(() => matchSeedBox(tracks, { seedBox: click, seedSample: 0, getBox: boxMap([["1:30", touch]]), window: SEED_BOX_WINDOW_MAX, reach: 60 }), /no match/);
  assert.throws(() => matchSeedBox(tracks, { seedBox: click, seedSample: 0, getBox: boxMap([["1:30", deer], ["2:30", { ...deer, right: 0.628 }]]), window: SEED_BOX_WINDOW_MAX, reach: 60 }), /ambiguous/);
  assert.equal(matchSeedBox(tracks, { seedBox: click, seedSample: 0, getBox: boxMap([["2:40", click], ["1:30", deer]]), window: SEED_BOX_WINDOW_MAX, reach: 60 }).id, 1);
  // a near-window match keeps its old 0.15 bar and beats any far one
  assert.equal(matchSeedBox(tracks, { seedBox: click, seedSample: 0, getBox: boxMap([["2:15", touch], ["1:30", click]]), window: SEED_BOX_WINDOW_MAX, reach: 60 }).id, 2);
});

test("run-basic reaches the pass's masked span only after the 1 s window matched nothing", async () => {
  const src = await fs.readFile(RB, "utf8");
  assert.match(src, /if \(!\/no match\/\.test\(String\(error\?\.message\)\) \|\| !spans\.length\) throw error;/);
  assert.match(src, /await load\(lo, hi\);\s+const got = matchSeedBox\(tracks\.tracks, \{ seedBox: opts\.seedBox, seedSample, getBox, window: SEED_BOX_WINDOW_MAX, reach \}\);/);
});
