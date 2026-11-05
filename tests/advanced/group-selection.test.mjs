// A pick drawn round a group ("wolf pack") overlaps each animal too little to match one: the world takes the
// tracked animals lying mostly inside it instead of refusing. Run: node --test tests/advanced/
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSelection } from "../../backend/lib/world.js";

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const tracks = [
  { id: 1, frames: 40 }, { id: 2, frames: 40 }, { id: 3, frames: 40 },
  { id: 4, frames: 40 },          // half outside the pick
  { id: 5, frames: 3 },           // inside, but too short to carry shells
  { id: 6, frames: 40 },          // inside only away from the pick moment
];
const boxes = {
  1: box(0.05, 0.50, 0.15, 0.60), 2: box(0.20, 0.52, 0.30, 0.62), 3: box(0.40, 0.55, 0.50, 0.68),
  4: box(0.50, 0.55, 0.70, 0.65), 5: box(0.10, 0.60, 0.15, 0.65),
};
const getBox = (id, s) => (id === 6 ? (s === 90 ? box(0.3, 0.5, 0.35, 0.55) : null) : boxes[id] ?? null);
const pack = { version: 1, seedTime: 3, objects: [{ label: "wolf pack", box: box(0, 0.48, 0.58, 0.71) }] };

test("a group pick takes the animals inside it", () => {
  assert.deepEqual(groupSelection({ snapshot: pack, tracks, getBox, seedSample: 45 }), { mode: "selected", trackIds: [1, 2, 3] });
});

test("two group picks take the animals in either, once each", () => {
  const two = { ...pack, objects: [pack.objects[0], { label: "wolf pack", box: box(0.35, 0.5, 0.75, 0.7) }] };
  assert.deepEqual(groupSelection({ snapshot: two, tracks, getBox, seedSample: 45 }).trackIds, [1, 2, 3, 4]);
});

test("a pick with no tracked animal inside still refuses", () => {
  const empty = { ...pack, objects: [{ label: "wolf pack", box: box(0.8, 0.1, 0.95, 0.3) }] };
  assert.equal(groupSelection({ snapshot: empty, tracks, getBox, seedSample: 45 }), null);
});

test("a pick in full-source space is moved into the trimmed picture first", () => {
  // the source had 100 px black bars left and right: the kept picture is x 100..1180 of 1280
  const crop = { x: 100, y: 0, w: 1080, h: 720 };
  const src = { ...pack, objects: [{ label: "wolf pack", box: box((0.0 * 1080 + 100) / 1280, 0.48, (0.58 * 1080 + 100) / 1280, 0.71) }] };
  assert.deepEqual(groupSelection({ snapshot: src, tracks, getBox, seedSample: 45, crop, srcW: 1280, srcH: 720 }).trackIds, [1, 2, 3]);
});

test("a group's name is tracked as its animal", async () => {
  const { individualConcept } = await import("../../backend/lib/world.js");
  const cases = {
    "wolf pack": "wolf", "white wolf pack": "white wolf", "pack of wolves": "wolves", "a herd of deer": "deer",
    "elk herd": "elk", "flock of birds": "birds", "bear family": "bear", "pair of bears": "bears", "herd": "animal",
    "wolf pack, wolf pack": "wolf", "white wolves": "white wolves", "moose": "moose", "backpack": "backpack",
    "grey squirrel": "grey squirrel", "": "",
  };
  for (const [asked, tracked] of Object.entries(cases)) assert.equal(individualConcept(asked), tracked, asked);
});

test("a pick named as a group takes the group, even where one animal would match it alone", async () => {
  const { chooseSelection, isGroupName } = await import("../../backend/lib/world.js");
  const one = () => ({ mode: "selected", trackIds: [1] });          // the box matcher: the best-overlapping wolf
  const args = { tracks, getBox, seedSample: 45, resolve: one };
  assert.deepEqual(chooseSelection({ ...args, snapshot: pack }).selection, { mode: "selected", trackIds: [1, 2, 3] });
  assert.equal(chooseSelection({ ...args, snapshot: pack }).group, true);       // make-world then lifts the members in view
  // one animal's name: matched animal by animal as before
  const single = { ...pack, objects: [{ label: "white wolf", box: pack.objects[0].box }] };
  assert.deepEqual(chooseSelection({ ...args, snapshot: single }), { selection: { mode: "selected", trackIds: [1] }, note: null });
  // a group's name with no animal inside: the matcher decides
  const empty = { ...pack, objects: [{ label: "wolf pack", box: box(0.8, 0.1, 0.95, 0.3) }] };
  assert.deepEqual(chooseSelection({ ...args, snapshot: empty }).selection, { mode: "selected", trackIds: [1] });
  for (const [label, group] of Object.entries({ "white wolf pack": true, "herd of elk": true, "pack": true, "white wolves": false, "backpack": false, "moose": false, "": false })) {
    assert.equal(isGroupName(label), group, label);
  }
});

test("a pick the matcher refuses as no-match is read as a group; any other refusal stands", async () => {
  const { chooseSelection } = await import("../../backend/lib/world.js");
  const { ADV_NO_MATCH_TEXT } = await import("../../backend/lib/seed-match.mjs");
  const single = { ...pack, objects: [{ label: "wolf", box: pack.objects[0].box }] };
  const refuse = (text) => () => { throw new Error(text); };
  const got = chooseSelection({ snapshot: single, tracks, getBox, seedSample: 45, resolve: refuse(`${ADV_NO_MATCH_TEXT} (test)`) });
  assert.deepEqual(got.selection.trackIds, [1, 2, 3]);
  assert.match(got.note, /singles out no one animal/);
  assert.equal(got.group, true);
  assert.throws(() => chooseSelection({ snapshot: single, tracks, getBox, seedSample: 45, resolve: refuse("the upload is gone") }), /upload is gone/);
});
