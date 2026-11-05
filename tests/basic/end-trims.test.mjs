// Loop 11 (tier-improve 2026-11-04): end trims that only fire on real ends.
// - edge trim: a run touching a new border is dropped only when the border
//   cuts a real part of the subject AND the subject moves toward it or
//   changes size (clip-a, a seated talker grazing the left border, keeps all);
// - transition trim: cross-dissolve samples at the clip ends are dropped;
// - keyframe passes may not open a wide gap (clip-b's doubled face mid-morph).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trimEdgeRuns, edgeStats, touchedEdges, trimTransitionRuns, trimEndRuns, TRANSITION_THRESHOLD,
} from '../../backend/pipeline/basic/lib/keyframes.mjs';
import { snapDetails } from '../../backend/pipeline/basic/lib/keyframe-snap.mjs';
import { blurDetails } from '../../backend/pipeline/basic/lib/keyframe-blur.mjs';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const stat = (edges, rel, cx, cy, area) => ({ edges, rel, cx, cy, area });

test('a grazing border with no motion is not an exit (clip-a)', () => {
  const present = range(0, 119);
  const edges = new Map(present.map((s) => [s, s >= 112
    ? stat('LTB', { L: 0.12, T: 0.3, B: 0.99 }, 0.205, 0.58, 0.32)
    : stat('TB', { T: 0.08, B: 0.99 }, 0.205, 0.58, 0.32)]));
  const r = trimEdgeRuns(present, edges, 15);
  assert.equal(r.trail, 0);
  assert.deepEqual(r.vetoed, [{ side: 'trail', run: 8 }]);
});

test('a real exit (big contact, moving toward the border) is dropped (grizzly)', () => {
  const present = range(6, 104);
  const edges = new Map(present.map((s) => [s, s >= 96
    ? stat('L', { L: Math.min(1, 0.3 + (s - 96) * 0.08) }, 0.2 - (s - 96) * 0.02, 0.7, 0.08 - (s - 96) * 0.007)
    : stat('', {}, 0.4 - s * 0.002, 0.7, 0.08)]));
  const r = trimEdgeRuns(present, edges, 15);
  assert.equal(r.trail, 9);
  assert.deepEqual(r.vetoed, []);
});

test('a subject walking into the lens (area doubles) is dropped even without centroid motion', () => {
  const present = range(6, 89);
  const edges = new Map(present.map((s) => [s, s >= 69
    ? stat('LT', { L: 0.9, T: 0.5 }, 0.3, 0.5, 0.28 + (s - 69) * 0.013)
    : stat('', {}, 0.3, 0.5, 0.2)]));
  assert.equal(trimEdgeRuns(present, edges, 15).trail, 21);
});

test('a speck-sized contact is never a cut (elk)', () => {
  const present = range(0, 119);
  const edges = new Map(present.map((s) => [s, s === 0 ? stat('L', { L: 0.02 }, 0.3, 0.5, 0.25) : stat('', {}, 0.3, 0.5, 0.25)]));
  assert.equal(trimEdgeRuns(present, edges, 15).lead, 0);
});

test('edgeStats agrees with touchedEdges and measures the cut share', () => {
  const w = 100, h = 50, raw = new Uint8Array(w * h);
  for (let y = 10; y < 40; y += 1) for (let x = 0; x < 30; x += 1) raw[y * w + x] = 3; // 30 rows on the left border
  const st = edgeStats(raw, w, h, [3]);
  assert.equal(st.edges, touchedEdges(raw, w, h, [3]));
  assert.equal(st.edges, 'L');
  assert.equal(st.rel.L, 1);
  assert.ok(Math.abs(st.cx - 14.5 / w) < 1e-9 && Math.abs(st.area - 900 / 5000) < 1e-9);
  assert.deepEqual(edgeStats(raw, w, h, [9]), { edges: '', rel: {}, cx: 0.5, cy: 0.5, area: 0 });
});

test('dissolve samples at both ends are dropped; the middle and the seed stay', () => {
  const present = range(6, 104);
  const scores = Object.fromEntries(present.map((s) => [s, s <= 8 ? 0.08 - (s - 6) * 0.02 : s >= 98 ? 0.02 + (s - 98) * 0.03 : 0.001]));
  scores[50] = 0.05; // a big subject mid-clip never trims
  const r = trimTransitionRuns(present, scores, 15);
  assert.equal(r.lead, 3);
  assert.equal(r.trail, 7);
  assert.ok(r.kept.includes(50));
  // unjudged samples (null) never count, and the seed stops a run
  assert.equal(trimTransitionRuns(present, { 6: null, 7: 0.1 }, 15).lead, 0);
  assert.equal(trimTransitionRuns(range(0, 20), Object.fromEntries(range(0, 20).map((s) => [s, s < 4 ? 0.1 : 0])), 2).lead, 2);
  assert.ok(TRANSITION_THRESHOLD > 0.006 && TRANSITION_THRESHOLD < 0.023);
});

test('trimEndRuns keeps runs longer than the cap and honours minKeep', () => {
  const present = range(0, 39);
  assert.equal(trimEndRuns(present, (s) => s < 11, 30).lead, 0); // 11 > floor(40 * 0.25)
  assert.equal(trimEndRuns(present, (s) => s < 10, 30).lead, 10);
  assert.equal(trimEndRuns(range(0, 7), (s) => s < 2, 7, { maxFrac: 0.5, minKeep: 7 }).lead, 0);
});

test('an earlier trim does not shrink the cap of the next one (blackbear)', () => {
  // 84 samples: a 3-sample dissolve trim leaves 81, and a 21-sample exit
  // run is over 25% of 81 but not of the clip's 84
  const left = range(3, 83);
  const exit = (s) => s >= 63;
  assert.equal(trimEndRuns(left, exit, 15).trail, 0);
  assert.equal(trimEndRuns(left, exit, 15, { total: 84 }).trail, 21);
  const edges = new Map(left.map((s, i) => [s, s >= 63
    ? stat('RB', { R: 0.6, B: 0.9 }, 0.8 + i * 0.002, 0.7, 0.05)
    : stat('B', { B: 0.9 }, 0.5 + i * 0.002, 0.7, 0.08)]));
  assert.equal(trimEdgeRuns(left, edges, 15).trail, 0);
  assert.equal(trimEdgeRuns(left, edges, 15, { total: 84 }).trail, 21);
});

test('maxGap: the snap may not open a gap wider than allowed', () => {
  // picks every 3 samples; 9 and 12 are soft, the sharp ones lie outward
  // (7 and 14), so snapping both opens a 7-sample gap across 9..12
  const picks = [0, 3, 6, 9, 12, 15, 18];
  const present = range(0, 20);
  const score = Object.fromEntries(present.map((s) => [s, 0.6]));
  score[9] = 0.5; score[7] = 1; score[12] = 0.5; score[14] = 1;
  assert.deepEqual(snapDetails(picks, present, score, { radius: 2 }).snapped, [0, 3, 6, 7, 14, 15, 18]);
  assert.deepEqual(snapDetails(picks, present, score, { radius: 2, maxGap: 5 }).snapped, [0, 3, 6, 7, 12, 14, 18]); // 15 -> 14 is fine: gaps stay <= 5
});

test('maxGap: blur moves and drops respect the gap limits', () => {
  const kf = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  const present = range(0, 26);
  const local = Object.fromEntries(present.map((s) => [s, 1]));
  local[12] = 10; local[10] = 1; // 12 is a blur outlier, 10 is calm (move 12 -> 10 opens 10..15)
  const free = blurDetails(kf, present, local, { radius: 2, maxDropFrac: 1 });
  assert.ok(free.kept.includes(10));
  const capped = blurDetails(kf, present, local, { radius: 2, maxDropFrac: 1, maxGap: 4, maxDropGap: 4 });
  assert.ok(capped.kept.includes(12), String(capped.kept)); // neither moved nor dropped
  const dropOk = blurDetails(kf, present, { ...local, 10: 10, 11: 10, 13: 10, 14: 10 }, { radius: 2, maxDropFrac: 1, maxGap: 4, maxDropGap: 6 });
  assert.deepEqual(dropOk.dropped, [12]);
});
