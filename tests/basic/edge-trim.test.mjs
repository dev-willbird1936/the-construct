// Loop 10 (tier-improve 2026-11-04): a subject leaving or entering the frame
// is cut by the border for its last or first samples; those poses are dropped
// from the ends of the span (bounded and seed-safe), never from the middle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trimEdgeRuns, touchedEdges, EDGE_TRIM_MAX_FRAC } from '../../backend/pipeline/basic/lib/keyframes.mjs';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const edgeMap = (present, fn) => new Map(present.map((s) => [s, fn(s)]));

test('a trailing exit run is dropped; the seed and the middle stay', () => {
  const present = range(6, 104); // grizzly-like: walks out on the left from sample 94
  const edges = edgeMap(present, (s) => (s >= 94 ? 'L' : ''));
  const r = trimEdgeRuns(present, edges, 15);
  assert.equal(r.lead, 0);
  assert.equal(r.trail, 11);
  assert.deepEqual(r.kept, range(6, 93));
});

test('a leading entry run is dropped the same way', () => {
  const present = range(0, 99);
  const edges = edgeMap(present, (s) => (s < 7 ? 'R' : ''));
  const r = trimEdgeRuns(present, edges, 50);
  assert.equal(r.lead, 7);
  assert.equal(r.kept[0], 7);
});

test('borders the seed already touches never count (a seated man cut by the frame bottom)', () => {
  const present = range(20, 119);
  const edges = edgeMap(present, () => 'B');
  assert.deepEqual(trimEdgeRuns(present, edges, 30), { kept: present, lead: 0, trail: 0, vetoed: [] });
  // a new border at the end still counts
  const edges2 = edgeMap(present, (s) => (s > 110 ? 'BL' : 'B'));
  assert.equal(trimEdgeRuns(present, edges2, 30).trail, 9);
});

test('a run longer than the cap is the clip itself and is kept', () => {
  const present = range(0, 99);
  const long = Math.floor(100 * EDGE_TRIM_MAX_FRAC) + 1;
  const edges = edgeMap(present, (s) => (s >= 100 - long ? 'L' : ''));
  assert.equal(trimEdgeRuns(present, edges, 10).trail, 0);
});

test('the seed sample is never dropped, and too few left keeps everything', () => {
  const present = range(0, 9);
  const edges = edgeMap(present, (s) => (s >= 7 ? 'L' : ''));
  // seed inside the cut run: the run stops at the seed
  const r = trimEdgeRuns(present, edges, 9, { maxFrac: 0.5 });
  assert.ok(r.kept.includes(9));
  // dropping would leave fewer than minKeep
  assert.equal(trimEdgeRuns(present, edges, 2, { maxFrac: 0.5, minKeep: 8 }).trail, 0);
  assert.deepEqual(trimEdgeRuns([], new Map(), 0), { kept: [], lead: 0, trail: 0, vetoed: [] });
});

test('touchedEdges needs a real share of the border, not a speck', () => {
  const w = 400, h = 50; // top/bottom need >= 4 px (1% of 400)
  const raw = new Uint8Array(w * h);
  for (let y = 10; y < 40; y += 1) raw[y * w] = 1; // 30 px on the left border
  raw[0 * w + 50] = 1; // one speck on the top border
  for (let x = 20; x < 60; x += 1) raw[(h - 1) * w + x] = 2; // other id on the bottom
  assert.equal(touchedEdges(raw, w, h, [1]), 'L');
  assert.equal(touchedEdges(raw, w, h, [1, 2]), 'LB');
  assert.equal(touchedEdges(raw, w, h, [3]), '');
});
