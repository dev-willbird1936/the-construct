import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Joint follow ladder (view-basic.js): widest valid pivot range first, then the
// framing nearest rWant; validity is checked at the r actually used.
const source = (await fs.readFile(new URL('../../view-basic.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const slice = source.slice(source.indexOf('function shrinkRanges('), source.indexOf('// Per-frame subject boxes'));
const { shrinkRanges, selectLadder } = vm.runInNewContext(slice + ';({shrinkRanges,selectLadder})', { Math, Set });
const grid = Array.from({ length: 11 }, (_, i) => (10 + i) / 20);

test('shrinkRanges narrows symmetrically toward the middle, widest first', () => {
  assert.equal(JSON.stringify(shrinkRanges(-1, 1, [1, 0.5])), '[[-1,1],[-0.5,0.5]]');
});

test('picks r nearest rWant that is itself valid, never an unvalidated wider view', () => {
  // valid only for r <= 0.9 (closer view = more margin), full range
  const pick = selectLadder(1, grid, shrinkRanges(-0.4, 0.4), (r) => 0.9 - r);
  assert.equal(pick.r, 0.9); assert.equal(JSON.stringify([pick.lo, pick.hi]), '[-0.4,0.4]');
});

test('narrows the pivot range only when the full range fails at every distance', () => {
  const pick = selectLadder(1, grid, shrinkRanges(-0.4, 0.4), (r, lo, hi) => 0.25 - (hi - lo) / 2);
  assert.ok(Math.abs(pick.hi - 0.2) < 1e-9); assert.equal(pick.r, 1);
});

test('stands down (null) when nothing passes', () => {
  assert.equal(selectLadder(1, grid, shrinkRanges(-0.4, 0.4), () => -1), null);
});

// HEADROOM-V1: containment is met by re-aiming (ty) before zooming out.
test('re-aim keeps the close framing when the shifted view contains the subject', () => {
  const contain = (r, lo, hi, ty = 0) => (ty === 0 ? 1.1 : 0.9); // crops unless re-aimed
  const pick = selectLadder(0.6, grid, shrinkRanges(-0.4, 0.4), () => 1, contain, 0.95, () => -0.01);
  assert.equal(pick.r, 0.6); assert.equal(pick.ty, -0.01);
});

test('a subject taller than the frame still zooms out after re-aim', () => {
  const contain = (r) => 1.2 - r * 0.4; // <= 0.95 only for r >= 0.625
  const pick = selectLadder(0.5, grid, shrinkRanges(-0.4, 0.4), () => 1, contain, 0.95, () => -0.01);
  assert.ok(pick.r >= 0.625);
});

test('the margin is checked at the shifted target', () => {
  const seen = [];
  selectLadder(0.6, grid, shrinkRanges(-0.4, 0.4), (r, lo, hi, ty) => { seen.push(ty); return 1; }, () => 0, 0.95, () => 0.02);
  assert.ok(seen.length && seen.every((ty) => ty === 0.02));
});
