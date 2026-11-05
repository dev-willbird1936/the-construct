import test from 'node:test';
import assert from 'node:assert/strict';
import { trimDrift } from '../backend/lib/bake.js';

const frame = (cx, area) => ({ cx, area });

test('a steadily moving subject keeps every frame', () => {
  const frames = Array.from({ length: 20 }, (_, i) => frame(0.7 - i * 0.02, 0.04 + i * 0.001));
  assert.equal(trimDrift(frames).length, 20);
});
test('the tail after a centroid jump is dropped', () => {
  const frames = [...Array.from({ length: 10 }, (_, i) => frame(0.7 - i * 0.02, 0.04)), frame(0.1, 0.04), frame(0.12, 0.04)];
  assert.equal(trimDrift(frames).length, 10);
});
test('a sudden change in area means tracking moved to something else', () => {
  const frames = [frame(0.5, 0.04), frame(0.5, 0.045), frame(0.5, 0.2), frame(0.5, 0.2)];
  assert.equal(trimDrift(frames).length, 2);
  assert.equal(trimDrift([frame(0.5, 0.04), frame(0.5, 0.01)]).length, 1);
});
test('empty and single-frame runs pass through', () => {
  assert.deepEqual(trimDrift([]), []);
  assert.equal(trimDrift([frame(0.5, 0.04)]).length, 1);
});
