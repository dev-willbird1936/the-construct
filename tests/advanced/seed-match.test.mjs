// Advanced selected-identity tests: pure matcher + world wiring, all synthetic.
// No network, no credentials, no SAM, no GPU. Run: node --test tests/advanced/
import test from "node:test";
import assert from "node:assert/strict";
import {
  SAMPLE_FPS,
  SEED_BOX_WINDOW,
  SEED_BOX_MIN_IOU,
  SEED_BOX_AMBIGUITY_EPS,
  frameIndexFor,
  seedSampleFor,
  remapBoxForCrop,
  boxIoU,
  boxForTrackId,
  matchSeedBox,
  validateAdvancedSnapshot,
  resolveAdvancedSelection,
  resolveWorldSelection,
  filterShellsByTracks,
  worldScriptArgs,
  codeForSelectionError,
  ADV_STALE_TEXT,
  ADV_NO_MATCH_TEXT,
  ADV_AMBIGUOUS_TEXT,
  ADV_MULTI_CONCEPT_TEXT,
  ADV_CROP_UNSUPPORTED_TEXT,
} from "../../backend/lib/seed-match.mjs";

const DOG = { left: 0.2, top: 0.3, right: 0.5, bottom: 0.8 };
const CAT = { left: 0.6, top: 0.2, right: 0.9, bottom: 0.7 };

const tracksABC = [
  { id: 1, first: 0, last: 100, frames: 90 },
  { id: 2, first: 0, last: 100, frames: 95 },
  { id: 3, first: 0, last: 100, frames: 88 },
];
const boxesByTrack = (map) => (trackId, sample) =>
  sample < 0 ? null : (map[trackId]?.[sample] ?? map[trackId]?.["*"] ?? null);

const snapOf = (objects, seedTime = 2.0) => ({
  version: 1,
  uploadId: "up1",
  frameIndex: 50,
  seedTime,
  objects,
});

test("clocks: upload frame index uses source fps; seed sample uses 15 fps sampling", () => {
  assert.equal(frameIndexFor(2.0, 25, 200), 50);
  assert.equal(seedSampleFor(2.0), 30);
  assert.equal(SAMPLE_FPS, 15);
});

test("seed window covers fps-rounding drift", () => {
  const s = seedSampleFor(61 / 30);
  assert.ok(Math.abs(s - 30) <= 1 && s - 3 <= 30 && 30 <= s + 3);
});

test("thresholds unchanged (Basic contract)", () => {
  assert.equal(SEED_BOX_WINDOW, 3);
  assert.equal(SEED_BOX_MIN_IOU, 0.15);
  assert.equal(SEED_BOX_AMBIGUITY_EPS, 0.05);
});

test("normalized boxes are scale-invariant (2x enhance changes nothing)", () => {
  assert.equal(boxIoU(DOG, DOG), 1);
  const tracks = [{ id: 1, first: 28, last: 32, frames: 5 }];
  assert.equal(matchSeedBox(tracks, { seedBox: DOG, seedSample: 30, getBox: () => ({ ...DOG }) }).id, 1);
});

test("black-bar crop remaps the seed box into kept space", () => {
  const remapped = remapBoxForCrop(DOG, 1280, 720, { x: 0, y: 60, w: 1280, h: 600 });
  assert.ok(Math.abs(remapped.top - (0.3 * 720 - 60) / 600) < 1e-9);
  assert.ok(Math.abs(remapped.bottom - (0.8 * 720 - 60) / 600) < 1e-9);
  assert.equal(remapped.left, DOG.left);
});

test("box inside the cropped-away bars refuses explicitly", () => {
  const barBox = { left: 0.2, top: 0.01, right: 0.5, bottom: 0.06 };
  assert.throws(
    () => remapBoxForCrop(barBox, 1280, 720, { x: 0, y: 60, w: 1280, h: 600 }),
    (e) => e.message === ADV_CROP_UNSUPPORTED_TEXT,
  );
});

test("matches by overlap with twin ordering (ids reshuffled)", () => {
  const seedSample = 30;
  const dogAt = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [27 + k, { ...DOG }]));
  const boxesA = { 1: dogAt, 2: { "*": CAT }, 3: { "*": { left: 0.0, top: 0.0, right: 0.1, bottom: 0.1 } } };
  const boxesB = { 7: dogAt, 9: { "*": CAT }, 4: { "*": { left: 0.0, top: 0.0, right: 0.1, bottom: 0.1 } } };
  const tracksB = [
    { id: 7, first: 0, last: 100, frames: 95 },
    { id: 9, first: 0, last: 100, frames: 95 },
    { id: 4, first: 0, last: 100, frames: 88 },
  ];
  assert.equal(matchSeedBox(tracksABC, { seedBox: DOG, seedSample, getBox: boxesByTrack(boxesA) }).id, 1);
  assert.equal(matchSeedBox(tracksB, { seedBox: DOG, seedSample, getBox: boxesByTrack(boxesB) }).id, 7);
});

test("snapshot numeric ids are ignored (reordered detect ids still match)", () => {
  const far = { left: 0.0, top: 0.0, right: 0.05, bottom: 0.05 };
  const dogAt = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [27 + k, { ...DOG }]));
  const out = resolveAdvancedSelection({
    snapshot: snapOf([{ id: 99, label: "dog", box: DOG }]),
    tracks: tracksABC,
    getBox: boxesByTrack({ 2: dogAt, 1: { "*": CAT }, 3: { "*": far } }),
    seedTime: 2.0,
  });
  assert.equal(out.mode, "selected");
  assert.deepEqual(out.trackIds, [2]);
});

test("no-match refuses (never longest fallback)", () => {
  const far = { left: 0.0, top: 0.0, right: 0.05, bottom: 0.05 };
  const dogAt = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [27 + k, { ...DOG }]));
  assert.throws(
    () =>
      matchSeedBox(tracksABC, {
        seedBox: far,
        seedSample: 30,
        getBox: boxesByTrack({ 1: dogAt, 2: { "*": CAT }, 3: { "*": DOG } }),
      }),
    (e) => e.message.startsWith(ADV_NO_MATCH_TEXT),
  );
});

test("ambiguous twins refuse", () => {
  const twin = { ...DOG, right: DOG.right + 0.005 };
  const dogAt = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [27 + k, { ...DOG }]));
  const twinAt = Object.fromEntries(Object.entries(dogAt).map(([k]) => [k, twin]));
  assert.throws(
    () => matchSeedBox(tracksABC, { seedBox: DOG, seedSample: 30, getBox: boxesByTrack({ 1: dogAt, 2: twinAt, 3: { "*": CAT } }) }),
    (e) => e.message.startsWith(ADV_AMBIGUOUS_TEXT),
  );
});

test("single selection resolves to one track id", () => {
  const scene = boxesByTrack({
    1: Object.fromEntries(Array.from({ length: 7 }, (_, k) => [27 + k, { ...DOG }])),
    2: { "*": CAT },
  });
  const out = resolveAdvancedSelection({
    snapshot: snapOf([{ id: 1, label: "dog", box: DOG }]),
    tracks: tracksABC.slice(0, 2),
    getBox: scene,
    seedTime: 2.0,
  });
  assert.deepEqual(out, { mode: "selected", concept: "dog", seedSample: 30, trackIds: [1] });
});

test("same-label multi resolves each box independently (no extra SAM)", () => {
  const scene = boxesByTrack({
    1: Object.fromEntries(Array.from({ length: 7 }, (_, k) => [27 + k, { ...DOG }])),
    2: { "*": CAT },
  });
  const out = resolveAdvancedSelection({
    snapshot: snapOf([
      { id: 1, label: "dog", box: DOG },
      { id: 2, label: "dog", box: CAT },
    ]),
    tracks: tracksABC.slice(0, 2),
    getBox: scene,
    seedTime: 2.0,
  });
  assert.deepEqual(out.trackIds, [1, 2]);
});

test("different-concept multi refuses pre-spend (no new SAM calls)", () => {
  const scene = boxesByTrack({ 1: { "*": DOG }, 2: { "*": CAT } });
  assert.throws(
    () =>
      resolveAdvancedSelection({
        snapshot: snapOf([
          { id: 1, label: "dog", box: DOG },
          { id: 2, label: "cat", box: CAT },
        ]),
        tracks: tracksABC.slice(0, 2),
        getBox: scene,
        seedTime: 2.0,
      }),
    (e) => e.message === ADV_MULTI_CONCEPT_TEXT,
  );
});

test("malformed snapshot refuses stale (never misbuilds)", () => {
  const scene = boxesByTrack({ 1: { "*": DOG } });
  for (const bad of [
    // v2 single-box is valid now (geometry match, seed-match-v2.test); a
    // v2 with two boxes is still malformed.
    { version: 2, objects: [{ label: "dog", box: DOG }, { label: "dog", box: DOG }] },
    { version: 1, objects: [] },
    { version: 1, objects: [{ label: "dog", box: { left: 0, top: 0, right: 2, bottom: 1 } }] },
    { version: 1, objects: [{ label: "", box: DOG }] },
    { version: 1, objects: [1, 2, 3, 4].map(() => ({ label: "dog", box: DOG })) },
  ]) {
    assert.throws(
      () => resolveAdvancedSelection({ snapshot: bad, tracks: tracksABC, getBox: scene }),
      (e) => e.message === ADV_STALE_TEXT,
      JSON.stringify(bad),
    );
  }
});

test("legacy no-snapshot jobs stay automatic (unchanged path)", () => {
  const out = resolveAdvancedSelection({
    snapshot: null,
    tracks: tracksABC,
    getBox: () => { throw new Error("must not read rasters for automatic jobs"); },
  });
  assert.deepEqual(out, { mode: "automatic", trackIds: null });
});

test("null snapshot with clicked ids is stale, not legacy automatic", () => {
  assert.throws(
    () => validateAdvancedSnapshot(null, { required: true }),
    (e) => e.message === ADV_STALE_TEXT,
  );
  assert.throws(
    () => resolveAdvancedSelection({ snapshot: null, tracks: tracksABC, getBox: () => null, required: true }),
    (e) => e.message === ADV_STALE_TEXT,
  );
});

test("crop context remaps before matching", () => {
  const srcBox = { left: 0.2, top: 0.3, right: 0.5, bottom: 0.8 };
  const kept = remapBoxForCrop(srcBox, 1280, 720, { x: 0, y: 60, w: 1280, h: 600 });
  const getBox = (id, s) => (s >= 27 && s <= 33 && id === 5 ? { ...kept } : null);
  const out = resolveAdvancedSelection({
    snapshot: snapOf([{ id: 1, label: "dog", box: srcBox }]),
    tracks: [{ id: 5, first: 27, last: 33, frames: 7 }],
    getBox,
    seedTime: 2.0,
    crop: { x: 0, y: 60, w: 1280, h: 600 },
    srcW: 1280,
    srcH: 720,
  });
  assert.deepEqual(out.trackIds, [5]);
});

test("preflight validates snapshot without attempting a track match", () => {
  assert.equal(typeof validateAdvancedSnapshot, "function");
  assert.equal(
    validateAdvancedSnapshot({ version: 1, seedTime: 1, objects: [{ label: "person", box: { left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 } }] }).concept,
    "person",
  );
});

test("two selected instances cannot silently collapse to one video track", () => {
  const a = { left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 };
  assert.throws(
    () =>
      resolveAdvancedSelection({
        snapshot: { version: 1, seedTime: 1, objects: [{ label: "person", box: a }, { label: "person", box: { ...a, left: 0.11 } }] },
        tracks: [{ id: 8 }],
        getBox: () => a,
      }),
    /ambigu|separate|distinct/i,
  );
});

test("nearby-time crossing cannot outrank the unique exact-time selected instance", () => {
  const a = { left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 };
  const b = { left: 0.65, top: 0.1, right: 0.85, bottom: 0.3 };
  const got = resolveAdvancedSelection({
    snapshot: { version: 1, seedTime: 1, objects: [{ label: "person", box: a }] },
    tracks: [{ id: 8 }, { id: 9 }],
    getBox: (id, s) => (id === 8 ? { ...a, right: 0.29 } : s === 18 ? a : b),
  });
  assert.deepEqual(got.trackIds, [8]);
});

test("codeForSelectionError maps refusals to fail codes, else internal", () => {
  assert.equal(codeForSelectionError(new Error(ADV_STALE_TEXT)), "seed_stale");
  assert.equal(codeForSelectionError(new Error(ADV_CROP_UNSUPPORTED_TEXT)), "seed_stale");
  assert.equal(codeForSelectionError(new Error(`${ADV_NO_MATCH_TEXT} (best IoU 0.000 < 0.15)`)), "seed_no_match");
  assert.equal(codeForSelectionError(new Error(`${ADV_AMBIGUOUS_TEXT} (top IoUs 0.900 vs 0.880)`)), "seed_ambiguous");
  assert.equal(codeForSelectionError(new Error(ADV_MULTI_CONCEPT_TEXT)), "multi_object");
  assert.equal(codeForSelectionError(new Error("boom")), "internal");
  assert.equal(codeForSelectionError(null), "internal");
});

test("boxForTrackId: tight inclusive box, null when absent", () => {
  const w = 10, h = 8;
  const lab = new Uint8Array(w * h);
  for (let y = 2; y <= 5; y += 1) for (let x = 3; x <= 6; x += 1) lab[y * w + x] = 4;
  assert.deepEqual(boxForTrackId(lab, w, h, 4), { left: 0.3, top: 0.25, right: 0.7, bottom: 0.75 });
  assert.equal(boxForTrackId(lab, w, h, 9), null);
  // edge-clamped like the Basic pipeline
  const edge = new Uint8Array(w * h);
  edge.fill(2);
  assert.deepEqual(boxForTrackId(edge, w, h, 2), { left: 0, top: 0, right: 1, bottom: 1 });
});

test("worldScriptArgs: legacy argv identical; selection appends explicit flag", () => {
  const base = { workDir: "w", videoPath: "v.mp4", name: "n", webClip: "n.mp4" };
  assert.deepEqual(worldScriptArgs(base), ["w", "v.mp4", "n", "n.mp4"]);
  assert.deepEqual(worldScriptArgs({ ...base, selectedTrackIds: [2, 5] }), [
    "w", "v.mp4", "n", "n.mp4", "--select-tracks", "2,5",
  ]);
});

test("resolveWorldSelection gates short selected tracks before the reshell", () => {
  const scene = boxesByTrack({ 1: { "*": DOG } });
  assert.throws(
    () =>
      resolveWorldSelection({
        snapshot: snapOf([{ id: 1, label: "dog", box: DOG }]),
        tracks: [{ id: 1, first: 28, last: 32, frames: 3 }],
        getBox: scene,
        seedTime: 2.0,
      }),
    (e) => e.message.startsWith(ADV_NO_MATCH_TEXT),
  );
  const ok = resolveWorldSelection({
    snapshot: snapOf([{ id: 1, label: "dog", box: DOG }]),
    tracks: [{ id: 1, first: 28, last: 32, frames: 7 }],
    getBox: scene,
    seedTime: 2.0,
  });
  assert.deepEqual(ok.trackIds, [1]);
});

test("shell emission scopes to selected tracks only; automatic keeps everything", () => {
  const shells = [{ track: 1, i: 30 }, { track: 2, i: 30 }, { track: 2, i: 31 }, { track: 3, i: 40 }];
  assert.deepEqual(filterShellsByTracks(shells, [2]), [{ track: 2, i: 30 }, { track: 2, i: 31 }]);
  assert.equal(filterShellsByTracks(shells, null).length, 4);
});

test("resolver never mutates tracks or label inputs", () => {
  const tracks = JSON.parse(JSON.stringify(tracksABC.slice(0, 2)));
  const frozen = JSON.parse(JSON.stringify(tracks));
  resolveAdvancedSelection({
    snapshot: snapOf([{ id: 1, label: "dog", box: DOG }]),
    tracks,
    getBox: boxesByTrack({ 1: { "*": DOG }, 2: { "*": CAT } }),
    seedTime: 2.0,
  });
  assert.deepEqual(tracks, frozen);
});

test("two-actor actual behavior: background union erases both, shells scope to selected", () => {
  // Honest behavior contract (see report): plate/live-video union masks erase
  // ALL tracked actors from the scene — unselected actors get no 3D shells
  // AND are painted out of the scene context. Only shell emission is scoped.
  const w = 12, h = 6;
  const labels = [new Uint8Array(w * h), new Uint8Array(w * h)];
  for (const lab of labels) {
    for (let y = 1; y <= 3; y += 1) for (let x = 1; x <= 3; x += 1) lab[y * w + x] = 1; // actor 1 (selected)
    for (let y = 1; y <= 3; y += 1) for (let x = 8; x <= 10; x += 1) lab[y * w + x] = 2; // actor 2 (unselected)
  }
  const unionErases = labels.every((lab) => {
    let erased = 0;
    for (let p = 0; p < lab.length; p += 1) if (lab[p] > 0) erased += 1;
    return erased === 2 * 3 * 3; // both actors masked out of the background
  });
  assert.ok(unionErases);
  const shells = [{ track: 1, i: 30 }, { track: 2, i: 30 }];
  assert.deepEqual(filterShellsByTracks(shells, [1]), [{ track: 1, i: 30 }]);
});
