import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Scale follow (view-basic.js, tier-improve loop 11): a travel clip the
// follow ladder refuses gets a distance per keyframe instead of one for the
// whole clip. The plan is pure; the viewer supplies rWantAt and okAt.
const source = (await fs.readFile(new URL('../../view-basic.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const slice = source.slice(source.indexOf('function scaleFollowPlan('), source.indexOf('// Per-frame subject boxes'));
const { scaleFollowPlan } = vm.runInNewContext(slice + ';({scaleFollowPlan})', { Math });

const R = 1.5, FLOOR = 1.2;

test('a far subject zooms in to its wanted distance, a near one stays at rest', () => {
  // keyframes 0-5 far (want 1.2), 6-9 near: no zoom is ok there
  const want = (i) => (i < 6 ? 1.2 : 1.5);
  const ok = (i, r) => i < 6 || r >= 1.5 - 1e-9;
  const { raw, smooth } = scaleFollowPlan(10, R, FLOOR, want, ok);
  assert.ok(Math.abs(raw[0] - 1.2) < 1e-6);
  assert.equal(raw[9], R);
  // eases out before the near poses (farthest of +-3, then a +-2 mean)
  assert.ok(smooth[2] < R - 0.1);
  for (let i = 3; i < 10; i += 1) assert.ok(smooth[i] >= raw[i] - 1e-9, `keyframe ${i} never closer than its own limit`);
  for (let i = 1; i < 10; i += 1) assert.ok(smooth[i] >= smooth[i - 1] - 1e-9, 'monotone ease out toward the near poses');
});

test('never closer than the user zoom limit or the wanted share', () => {
  const { raw } = scaleFollowPlan(4, R, FLOOR, () => 0.5, () => true);
  for (const r of raw) assert.ok(r >= FLOOR - 1e-9);
  const { raw: raw2 } = scaleFollowPlan(4, R, FLOOR, () => 1.4, () => true);
  for (const r of raw2) assert.ok(r >= 1.4 - 1e-9);
});

test('every smoothed keyframe stays ok when ok holds at every farther distance', () => {
  const lim = [1.3, 1.21, 1.45, 1.2, 1.5, 1.33, 1.26, 1.2, 1.2, 1.38, 1.5, 1.25];
  const ok = (i, r) => r >= lim[i] - 1e-9;
  const { smooth } = scaleFollowPlan(lim.length, R, FLOOR, () => 1.2, ok);
  smooth.forEach((r, i) => assert.ok(ok(i, r), `keyframe ${i}: ${r} < ${lim[i]}`));
});

test('nothing ok closer than rest: the plan is rest everywhere (viewer stays inactive)', () => {
  const { raw, smooth } = scaleFollowPlan(5, R, FLOOR, () => 1.2, () => false);
  assert.equal(JSON.stringify(raw), JSON.stringify([R, R, R, R, R])); // vm-realm arrays
  assert.equal(JSON.stringify(smooth), JSON.stringify([R, R, R, R, R]));
});
