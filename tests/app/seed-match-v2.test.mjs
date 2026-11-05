// seed-match v2 (box) selection tests: v2 accepted for the selected
// pipeline, v1 behaviour byte-identical. Run: node --test tests/app/
// (from the repo root, or against the Lane D patchwork tree).
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAdvancedSnapshot,
  resolveAdvancedSelection,
  ADV_STALE_TEXT,
  ADV_MULTI_CONCEPT_TEXT,
  ADV_NO_MATCH_TEXT,
} from "../../backend/lib/seed-match.mjs";

const DOG = { left: 0.2, top: 0.3, right: 0.5, bottom: 0.8 };
const v2 = (objects, seedTime = 2.0) => ({
  version: 2, uploadId: "up1", frameIndex: 50, seedTime,
  frameWidth: 640, frameHeight: 480,
  promptBox: { left: 128, top: 144, right: 320, bottom: 384 },
  objects,
});
const tracks = [
  { id: 7, first: 40, last: 80, frames: 20 },
  { id: 9, first: 0, last: 119, frames: 60 },
];

test("v2 box: single object accepted with fixed concept", () => {
  const out = validateAdvancedSnapshot(v2([{ id: 1, box: DOG }]), { seedTime: 2.0, required: true });
  assert.equal(out.mode, "selected");
  assert.equal(out.concept, "selected object");
  assert.deepEqual(out.seedBox, DOG);
  assert.equal(out.seedSample, 30);
});

test("v2 box: refusals stay fail-closed", () => {
  assert.throws(() => validateAdvancedSnapshot(null, { required: true }), (e) => e.message === ADV_STALE_TEXT);
  assert.throws(() => validateAdvancedSnapshot(v2([]), { seedTime: 1 }), (e) => e.message === ADV_STALE_TEXT);
  assert.throws(() => validateAdvancedSnapshot(v2([{ id: 1, box: DOG }, { id: 2, box: DOG }]), { seedTime: 1 }),
    (e) => e.message === ADV_STALE_TEXT);
  assert.throws(() => validateAdvancedSnapshot(v2([{ id: 1, box: { ...DOG, right: 0.1 } }]), { seedTime: 1 }),
    (e) => e.message === ADV_STALE_TEXT);
  assert.throws(() => validateAdvancedSnapshot({ version: 3, objects: [{ box: DOG }] }, { seedTime: 1, required: true }),
    (e) => e.message === ADV_STALE_TEXT);
  assert.throws(() => validateAdvancedSnapshot(v2([{ id: 1, box: DOG }], -5), { seedTime: 1, required: true }),
    (e) => e.message === ADV_STALE_TEXT);
});

test("v2 resolves against label rasters by geometry, not ids", () => {
  const getBox = (id) => (id === 7 ? { ...DOG } : { left: 0.6, top: 0.1, right: 0.9, bottom: 0.4 });
  const out = resolveAdvancedSelection({
    snapshot: v2([{ id: 999, box: DOG }]), tracks, getBox, seedTime: 2.0, required: true,
  });
  assert.equal(out.mode, "selected");
  assert.deepEqual(out.trackIds, [7]); // numeric id 999 never trusted
});

test("v1 behaviour unchanged (label concept, multi-concept refusal)", () => {
  const v1 = (objects) => ({ version: 1, uploadId: "up1", frameIndex: 50, seedTime: 2.0, objects });
  const out = validateAdvancedSnapshot(v1([{ id: 3, label: "wolf", box: DOG }]), { seedTime: 2.0, required: true });
  assert.equal(out.mode, "selected");
  assert.equal(out.concept, "wolf");
  assert.throws(
    () => validateAdvancedSnapshot(v1([{ id: 1, label: "a", box: DOG }, { id: 2, label: "b", box: DOG }]), { seedTime: 1, required: true }),
    (e) => e.message === ADV_MULTI_CONCEPT_TEXT,
  );
  assert.deepEqual(validateAdvancedSnapshot(null, {}), { mode: "automatic", trackIds: null });
  assert.throws(() => validateAdvancedSnapshot(null, { required: true }), (e) => e.message === ADV_STALE_TEXT);
  assert.throws(
    () => resolveAdvancedSelection({ snapshot: null, tracks: [], getBox: () => null, required: true }),
    (e) => e.message === ADV_STALE_TEXT,
  );
  assert.throws(
    () => resolveAdvancedSelection({
      snapshot: v1([{ id: 1, label: "x", box: { left: 0, top: 0, right: 0.01, bottom: 0.01 } }]),
      tracks, getBox: () => null, seedTime: 2.0, required: true,
    }),
    (e) => e.message === ADV_NO_MATCH_TEXT,
  );
});
