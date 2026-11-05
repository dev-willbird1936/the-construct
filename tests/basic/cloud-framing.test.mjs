import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from '../../vendor/three/build/three.module.js';
import { frameCloud } from '../../cloud-framing.mjs';

const cube = (size = 1) => new Float32Array([-size,-size,-size, size,-size,-size, -size,size,-size, size,size,-size, -size,-size,size, size,-size,size, -size,size,size, size,size,size]);

test('distant background no longer shrinks the observed trail; far clip still retains it', () => {
  const trail = cube(), background = new Float32Array([1000, 400, -700, -800, -300, -1000]);
  const small = frameCloud(new Float32Array(), trail, 35, 16 / 9);
  const frame = frameCloud(background, trail, 35, 16 / 9);
  assert.equal(frame.focus, 'trail');
  assert.deepEqual(frame.target.toArray(), small.target.toArray());
  assert.equal(frame.distance, small.distance);
  for (let i = 0; i < background.length; i += 3) assert.ok(frame.position.distanceTo(new Vector3().fromArray(background, i)) < frame.far);
});

for (const aspect of [16 / 9, 390 / 844]) for (const fov of [15, 35.4734, 80]) {
  test(`all trail bounds project inside ${aspect.toFixed(3)} aspect / ${fov} degree view`, () => {
    for (const size of [1e-4, .01, 1, 100]) {
      const trail = cube(size), frame = frameCloud(new Float32Array([1000, 0, -500]), trail, fov, aspect);
      const camera = new PerspectiveCamera(fov, aspect, .01, frame.far);
      camera.position.copy(frame.position); camera.lookAt(frame.target); camera.updateMatrixWorld(true);
      for (let i = 0; i < trail.length; i += 3) {
        const p = new Vector3().fromArray(trail, i).project(camera);
        assert.ok(Math.abs(p.x) <= 1.000001 && Math.abs(p.y) <= 1.000001 && Math.abs(p.z) <= 1.000001, JSON.stringify({size, point:p.toArray()}));
      }
    }
  });
}

test('empty trail uses scene bounds and empty/non-finite data retains the supplied fallback', () => {
  assert.equal(frameCloud(cube(), new Float32Array(), 40, 1).focus, 'scene');
  const fallback = new Vector3(3, 2, -1), frame = frameCloud(new Float32Array([NaN, 0, 0]), new Float32Array(), 40, 1, fallback);
  assert.equal(frame.focus, 'fallback'); assert.deepEqual(frame.target, fallback); assert.notEqual(frame.target, fallback);
  assert.ok(Number.isFinite(frame.distance) && frame.far >= 200);
});

test('source coordinates and supplied fallback are never mutated', () => {
  const background = cube(10), trail = cube(), beforeBg = background.slice(), beforeTrail = trail.slice(), fallback = new Vector3(3, 2, -1);
  frameCloud(background, trail, 40, 1, fallback);
  assert.deepEqual(background, beforeBg); assert.deepEqual(trail, beforeTrail); assert.deepEqual(fallback.toArray(), [3, 2, -1]);
});

test('invalid camera values and partial vectors fail clearly', () => {
  for (const [fov, aspect] of [[0,1],[180,1],[NaN,1],[40,0],[40,Infinity]]) assert.throws(() => frameCloud(cube(), cube(), fov, aspect), /camera parameters/);
  assert.throws(() => frameCloud(new Float32Array([1]), cube(), 40, 1), /buffers are incomplete/);
});
