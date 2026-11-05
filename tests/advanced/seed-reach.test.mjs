// Advanced pick at a frame the concept pass has not masked yet (loop 12, journey): slovakdeer picked at the
// picker's default 0:00 failed live with "Could not match the selected object in the video", because the pass
// masks the deer only from ~1.8 s (sample 27) and the matcher looked 3 samples either side. Past the window the
// matcher now searches on, nearest first, needing IoU 0.3; ties still refuse; inside the window nothing changes.
// Pure and synthetic: no network, no SAM, no GPU. Run: node --test tests/advanced/
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADV_NO_MATCH_TEXT,
  ADV_AMBIGUOUS_TEXT,
  SEED_BOX_REACH_MIN_IOU,
  matchSeedBox,
  resolveWorldSelection,
} from "../../backend/lib/seed-match.mjs";

const deerBox = { left: 0.40, top: 0.30, right: 0.60, bottom: 0.70 };
const pick = { left: 0.41, top: 0.31, right: 0.61, bottom: 0.71 }; // the frame-0 detect box: the deer grazes in place
const deer = { id: 2, first: 27, last: 119, frames: 93 };
const boxes = (byTrack) => (id, s) => byTrack[id]?.(s) ?? null;
const from27 = boxes({ 2: (s) => (s >= 27 && s <= 119 ? deerBox : null) });

test("frame-0 pick: nothing in the window refuses as before, a reach finds the deer at its first masked sample", () => {
  assert.throws(() => matchSeedBox([deer], { seedBox: pick, seedSample: 0, getBox: from27 }), (e) => e.message.startsWith(ADV_NO_MATCH_TEXT));
  assert.equal(matchSeedBox([deer], { seedBox: pick, seedSample: 0, getBox: from27, reach: 130 }).id, 2);
});

test("past the window a match must overlap the pick by IoU 0.3; inside it 0.15 still does", () => {
  const weak = { left: 0.41, top: 0.31, right: 0.61, bottom: 0.39 }; // IoU 0.2 with the pick
  const far = boxes({ 2: (s) => (s >= 27 ? weak : null) });
  assert.ok(SEED_BOX_REACH_MIN_IOU === 0.3);
  assert.throws(() => matchSeedBox([deer], { seedBox: pick, seedSample: 0, getBox: far, reach: 130 }), (e) => e.message.startsWith(ADV_NO_MATCH_TEXT));
  const near = boxes({ 2: (s) => (s === 2 ? weak : null) });
  assert.equal(matchSeedBox([deer], { seedBox: pick, seedSample: 0, getBox: near }).id, 2);
});

test("the nearest ring wins, and a tie past the window still refuses", () => {
  const doe = { id: 5, first: 40, last: 119, frames: 80 };
  const both = boxes({ 2: (s) => (s >= 27 ? deerBox : null), 5: (s) => (s >= 40 ? deerBox : null) });
  assert.equal(matchSeedBox([deer, doe], { seedBox: pick, seedSample: 0, getBox: both, reach: 130 }).id, 2);
  const twins = boxes({ 2: (s) => (s >= 27 ? deerBox : null), 5: (s) => (s >= 27 ? deerBox : null) });
  assert.throws(() => matchSeedBox([deer, { ...doe, first: 27 }], { seedBox: pick, seedSample: 0, getBox: twins, reach: 130 }),
    (e) => e.message.startsWith(ADV_AMBIGUOUS_TEXT));
});

test("resolveWorldSelection passes the reach through; without it the window contract is unchanged", () => {
  const snapshot = { version: 1, seedTime: 0, objects: [{ id: 1, label: "deer", box: pick }] };
  assert.throws(() => resolveWorldSelection({ snapshot, tracks: [deer], getBox: from27 }), (e) => e.message.startsWith(ADV_NO_MATCH_TEXT));
  assert.deepEqual(resolveWorldSelection({ snapshot, tracks: [deer], getBox: from27, reach: 130 }).trackIds, [2]);
});

test("chooseSelection forwards a reach only when one is given", async () => {
  const { chooseSelection } = await import("../../backend/lib/world.js");
  const seen = [];
  const resolve = (args) => { seen.push(args); return { mode: "selected", trackIds: [2] }; };
  const snapshot = { version: 1, seedTime: 0, objects: [{ id: 1, label: "deer", box: pick }] };
  chooseSelection({ snapshot, tracks: [deer], getBox: from27, seedSample: 0, resolve });
  chooseSelection({ snapshot, tracks: [deer], getBox: from27, seedSample: 0, resolve, reach: 130 });
  assert.equal("reach" in seen[0], false);
  assert.equal(seen[1].reach, 130);
});
