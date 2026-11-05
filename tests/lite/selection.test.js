import { test } from "node:test";
import assert from "node:assert/strict";
import {
  associateSnapshotBox,
  LITE_MIN_IOU,
  LITE_SELECTION_STALE_TEXT,
} from "../../backend/app/runner-lite.js";
import { parseSelectionSnapshot, snapshotFromCache } from "../../backend/app/detect-cache.js";
import { SELECTION_STALE_TEXT } from "../../backend/app/errors.js";

// Lite selection identity: refreshed detects reshuffle numeric ids, so the
// persisted snapshot bbox associates by unique overlap (never largest
// fallback). All synthetic, offline.

const left = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.5 };
const right = { left: 0.65, top: 0.2, right: 0.85, bottom: 0.5 };

test("unique overlap associates the right twin despite id reorder", () => {
  const fresh = [
    { id: 2, label: "mug", box: { ...right } },
    { id: 1, label: "mug", box: { ...left } },
  ];
  assert.equal(associateSnapshotBox(left, fresh).id, 1);
  assert.equal(associateSnapshotBox(right, fresh).id, 2);
});

test("no overlap refuses instead of falling back to largest", () => {
  const fresh = [{ id: 1, label: "mug", box: { ...right } }];
  assert.throws(() => associateSnapshotBox(left, fresh), /Could not match the selected/);
});

test("twins within epsilon refuse as ambiguous", () => {
  const near = { left: 0.105, top: 0.2, right: 0.305, bottom: 0.5 };
  const fresh = [
    { id: 1, label: "mug", box: { ...left } },
    { id: 2, label: "mug", box: near },
  ];
  assert.throws(() => associateSnapshotBox(left, fresh), /ambiguously/);
  assert.ok(LITE_MIN_IOU > 0);
});

test("an overlapping different concept cannot replace an explicit selected label", () => {
  assert.throws(() => associateSnapshotBox(left, [{ id: 1, label: "person", box: left }], { expectedLabel: "mug" }), /Could not match the selected/);
});

test("the matching concept survives an overlapping different-concept twin", () => {
  const fresh = [{ id: 9, label: "person", box: left }, { id: 2, label: "mug", box: left }];
  assert.equal(associateSnapshotBox(left, fresh, { expectedLabel: "mug" }).id, 2);
});

test("snapshot round-trips from the exact cached detect; stale parses to null", async () => {
  const { __seedDetectCache, __resetDetectCache } = await import("../../backend/app/detect-cache.js");
  __resetDetectCache();
  const upload = { id: "lite-snap-u", fps: 10, frames: 20 };
  const result = {
    frameWidth: 128,
    frameHeight: 96,
    objects: [
      { id: 1, label: "mug", box: { ...left } },
      { id: 2, label: "mug", box: { ...right } },
    ],
    _internal: { accepted: [] },
  };
  __seedDetectCache(upload.id, 5, result);
  const snap = snapshotFromCache(upload, 0.5, [2]);
  assert.ok(snap);
  assert.equal(snap.frameIndex, 5);
  assert.equal(snap.objects[0].label, "mug");
  assert.deepEqual(snap.objects[0].box, right);
  assert.ok(parseSelectionSnapshot(JSON.stringify(snap)));
  assert.equal(parseSelectionSnapshot(""), null);
  assert.equal(parseSelectionSnapshot("nope"), null);
  assert.equal(snapshotFromCache(upload, 0.5, [9]), null, "unknown id is stale, not substituted");
  assert.equal(snapshotFromCache({ ...upload, id: "other" }, 0.5, [1]), null, "other upload is stale");
  assert.equal(LITE_SELECTION_STALE_TEXT, SELECTION_STALE_TEXT);
  __resetDetectCache();
});
