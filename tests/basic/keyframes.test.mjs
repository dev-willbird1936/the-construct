import test from "node:test";
import assert from "node:assert/strict";
import {
  evenIndices,
  pickTrack,
  selectKeyframes,
  sampleToSourceFrame,
  sampleToTime,
} from "../../backend/pipeline/basic/lib/keyframes.mjs";

test("evenIndices keeps endpoints and spreads evenly", () => {
  assert.deepEqual(evenIndices(5, 10), [0, 1, 2, 3, 4]);
  assert.deepEqual(evenIndices(10, 1), [0]);
  assert.deepEqual(evenIndices(10, 4), [0, 3, 6, 9]);
  assert.deepEqual(evenIndices(0, 4), []);
});

test("pickTrack honours an explicit object id", () => {
  const tracks = [
    { id: 1, first: 0, last: 100, frames: 90 },
    { id: 2, first: 10, last: 40, frames: 20 },
  ];
  assert.equal(pickTrack(tracks, { objectId: 2 }).id, 2);
  assert.throws(() => pickTrack(tracks, { objectId: 9 }), /not found/);
});

test("pickTrack prefers the longest track covering the seed", () => {
  const tracks = [
    { id: 1, first: 0, last: 100, frames: 50 },
    { id: 2, first: 40, last: 60, frames: 21 },
  ];
  assert.equal(pickTrack(tracks, { seedSample: 50 }).id, 1);
  assert.equal(pickTrack(tracks, { seedSample: 55 }).id, 1);
  // seed outside every track: longest overall wins
  assert.equal(pickTrack(tracks, { seedSample: 500 }).id, 1);
  assert.throws(() => pickTrack([], {}), /no tracks/);
});

test("selectKeyframes spreads and rejects tiny tracks", () => {
  const present = Array.from({ length: 90 }, (_, i) => i * 2);
  const keys = selectKeyframes(present, 32);
  assert.equal(keys.length, 32);
  assert.equal(keys[0], present[0]);
  assert.equal(keys.at(-1), present.at(-1));
  assert.throws(() => selectKeyframes([1, 2, 3], 32), /need >= 6/);
});

test("sample mapping helpers", () => {
  assert.equal(sampleToTime(30), 2);
  assert.equal(sampleToSourceFrame(30, 30), 60);
});
