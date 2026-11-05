import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Loop 12: which Still the viewer shows. Runs the production stillCropRect +
// startStill from view-lite.js with a stage stub (no DOM, no network).
const source = fs.readFileSync(new URL('../../view-lite.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const from = source.indexOf('function stillCropRect(');
const to = source.indexOf('function openViewer(', from);
assert.ok(from > 0 && to > from, 'still choice block');

function choose(composite, stageWidth, innerHeight) {
  const requested = [];
  class Image { set src(v) { requested.push(v); } }
  const ctx = { $: () => ({ clientWidth: stageWidth }), innerHeight, Image, apiUrl: (p) => p, id: 'b1', Promise, Math, Array, Number, Infinity };
  const startStill = vm.runInNewContext(`${source.slice(from, to)}\nstartStill;`, ctx);
  const out = startStill(composite);
  return { file: out.file, portrait: out.portrait, requested };
}
// 4 moments: landscape 2x2 on a 1920x1080 canvas, portrait twin a 4x1 column on 1080x1350.
const grid = (w, h) => [[288, 48, w, h], [288 + w + 16, 48, w, h], [288, 48 + h + 62, w, h], [288 + w + 16, 48 + h + 62, w, h]];
const column = (w, h) => [0, 1, 2, 3].map((i) => [346, 48 + i * (h + 61), w, h]);
const pack = { tileRects: grid(573, 438), outputSize: [1920, 1080], portrait: { file: 'composite-portrait.png', tileRects: column(334, 256), layout: { canvas: [1080, 1350] } } };
const bear = { tileRects: grid(664, 438), outputSize: [1920, 1080], portrait: { file: 'composite-portrait.png', tileRects: column(388, 256), layout: { canvas: [1080, 1350] } } };

test('phone: the landscape 2x2 wins when its tiles come out clearly larger than the column', () => {
  const c = choose(pack, 354, 844);
  assert.equal(c.file, 'composite.png'); assert.equal(c.portrait, false);
  assert.deepEqual(c.requested, ['/specimens/b1/composite.png']);
});

test('phone: under 20% apart the tall stage keeps the portrait twin (its time labels read larger)', () => {
  const c = choose(bear, 354, 844);
  assert.equal(c.file, 'composite-portrait.png'); assert.equal(c.portrait, true);
});

test('desktop keeps the landscape Still', () => {
  for (const comp of [pack, bear]) assert.equal(choose(comp, 980, 800).file, 'composite.png');
});

test('without tile rects on both the stage shape decides, and an unsafe twin name is never requested', () => {
  const chrono = { outputSize: [1920, 1080], portrait: { file: 'composite-portrait.png', layout: { canvas: [1080, 1350] } } };
  assert.equal(choose(chrono, 354, 844).file, 'composite-portrait.png');
  assert.equal(choose(chrono, 980, 800).file, 'composite.png');
  assert.equal(choose({ ...bear, portrait: { ...bear.portrait, file: '../x.png' } }, 354, 844).file, 'composite.png');
  assert.equal(choose({ tileRects: grid(573, 438) }, 354, 844).file, 'composite.png');
});
