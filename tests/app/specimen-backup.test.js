import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specimenFiles } from '../../.planning/hackathon/tools/specimen-files.mjs';

test('Lite backup includes the declared backdrop, not just the atlas', () => {
  assert.deepEqual(specimenFiles('lite', { backdrop: { file: 'backdrop.webp' } }),
    ['atlas.json', 'atlas.webp', 'backdrop.webp', 'meta.json', 'thumb.webp']);
  assert.ok(!specimenFiles('lite', {}).includes('backdrop.webp'));
});

test('Basic backup includes the optional layered-fill dependencies', () => {
  const files = { plate: 'plate.webp', subject: 'subject.webp', depth: 'depth.webp', thumb: 'thumb.webp', behind: 'behind.webp', plateAlpha: 'plateAlpha.png' };
  const got = specimenFiles('basic', { files });
  for (const file of Object.values(files)) assert.ok(got.includes(file), file);
  assert.ok(got.includes('specimen.json'));
  const { behind, plateAlpha, ...old } = files;
  assert.ok(!specimenFiles('basic', { files: old }).includes(behind));
});

test('Advanced backup follows every declared render texture and video', () => {
  const got = specimenFiles('advanced', {
    clip: 'clip.mp4', env: [{ tex: 'env/plate_hi.jpg', live: { plate: 'env/plate_hi.jpg', video: 'env/live.mp4' } }],
    shells: [{ tex: 'sub/t1_00000.webp' }, { tex: 'sub/t1_00001.webp' }], sub: [],
  });
  for (const file of ['stable.json', 'pos.f32', 'uv.f32', 'idx.u32', 'clip.mp4', 'env/plate_hi.jpg', 'env/live.mp4', 'sub/t1_00000.webp', 'sub/t1_00001.webp']) assert.ok(got.includes(file), file);
  assert.equal(got.filter((f) => f === 'env/plate_hi.jpg').length, 1);
});

test('backup rejects unsafe references and incomplete required manifests', () => {
  for (const file of ['../secret', '/absolute', 'http://example.test/x', 'C:/secret', 'env/../../secret', 'env\\secret']) {
    assert.throws(() => specimenFiles('lite', { backdrop: { file } }), /Unsafe/);
  }
  assert.throws(() => specimenFiles('basic', { files: {} }), /Unsafe/);
  assert.throws(() => specimenFiles('other', {}), /Unknown/);
});
