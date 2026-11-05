import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Pose blend (view-basic.js, tier-improve loop 12): mid-blend the body was
// see-through, because both poses were partly faded. The outgoing pose now
// stays opaque under the incoming one until the incoming is opaque.
const source = (await fs.readFile(new URL('../../view-basic.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const slice = source.slice(source.indexOf('const BLEND_UNDER = '), source.indexOf('function showFrame('));
const weights = (query = '') => vm.runInNewContext(`${slice};blendWeights`, { Math, Number, params: new URLSearchParams(query) });

test('the body is never see-through: while the incoming pose fades in, the outgoing stays opaque', () => {
  const bw = weights();
  let last = 0;
  for (let k = 0; k <= 1000; k += 1) {
    const { wIn, outW } = bw(k / 1000);
    assert.ok(wIn >= last - 1e-12, 'incoming opacity only rises');
    last = wIn;
    if (wIn < 1) assert.equal(outW, 1, `f=${k / 1000}: outgoing opaque until the incoming is`);
    else assert.equal(outW, 0);
    // coverage where both poses overlap: incoming over outgoing
    assert.ok(wIn + outW * (1 - wIn) >= 1 - 1e-12);
  }
  assert.equal(bw(0).wIn, 0);
  assert.equal(bw(1).wIn, 1);
  // the hand-over is a short window in the middle of the pair
  assert.equal(bw(0.44).wIn, 0);
  assert.equal(bw(0.56).wIn, 1);
});

test('?blendUnder=0 keeps the old cross-fade', () => {
  const bw = weights('blendUnder=0');
  const { wIn, outW } = bw(0.5);
  assert.ok(Math.abs(wIn - 0.5) < 1e-9);
  assert.ok(Math.abs(outW - (1 - 0.5 ** 4)) < 1e-9);
  assert.ok(bw(0.7).outW < 1 && bw(0.7).wIn < 1, 'both partly faded: the case the default removes');
});
