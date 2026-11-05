import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Earlier moments (view-basic.js, tier-improve loops 11-12): which earlier
// poses the default view shows beside the present one. Sliced from the
// viewer and run with a synthetic specimen.
const source = (await fs.readFile(new URL('../../view-basic.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const slice = source.slice(source.indexOf('const MOMENT_DT = '), source.indexOf('// Moments draw as points'))
  .replace(/^const kfBox = [\s\S]*?\n(?=function boxIoU)/m, '');

function momentsFor(boxes, dt = 0.2) {
  const specimen = { keyframes: boxes.map((_, i) => ({ t: i * dt })) };
  const ctx = { Math, Number, Map, params: new URLSearchParams(''), specimen, kfBox: boxes };
  vm.runInNewContext(`${slice};globalThis.momentGhosts = momentGhosts;`, ctx);
  return ctx.momentGhosts;
}
const box = (x, y, w, h) => [x, y, x + w, y + h];

test('a subject walking across leaves its earlier poses; one standing still leaves none', () => {
  const walk = Array.from({ length: 30 }, (_, i) => box(0.05 + i * 0.025, 0.4, 0.15, 0.2));
  const shown = momentsFor(walk)(29);
  assert.ok(shown.size >= 3, `walk: ${[...shown.keys()]}`);
  for (const [i, o] of shown) assert.ok(i < 29 && o > 0 && o <= 0.42);
  const still = Array.from({ length: 30 }, () => box(0.4, 0.4, 0.15, 0.2));
  assert.equal(momentsFor(still)(29).size, 0);
});

test('a pose that passed close to the lens is not drawn over the scene', () => {
  // puma on a trail camera: near and huge at the lens, then small and far
  const far = (i) => box(0.05 + i * 0.03, 0.4, 0.12, 0.15);
  const control = Array.from({ length: 20 }, (_, i) => far(i));
  assert.ok(momentsFor(control)(19).size >= 3, 'the same path at a distance shows its moments');
  const lens = control.map((b, i) => (i < 17 ? box(0.0, 0.0, 0.7, 0.9) : b));
  assert.equal(momentsFor(lens)(19).size, 0, 'poses at the lens are left out');
  const bigger = control.map((b, i) => (i < 17 ? box(b[0], 0.3, 0.2, 0.25) : b)); // 2.8x the present, under a quarter of the frame
  assert.equal(momentsFor(bigger)(19).size, 0, 'poses much larger than the present are left out');
  // and nothing at all when the present pose has no box
  const gap = control.slice(); gap[19] = null;
  assert.equal(momentsFor(gap)(19).size, 0);
});
