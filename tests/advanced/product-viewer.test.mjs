// A visitor's build (?specimen=) or an example (?seed=) opens as a plain viewer; the lab UI stays behind ?debug=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const js = fs.readFileSync(new URL('../../stable.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../stable.css', import.meta.url), 'utf8');

test('the plain viewer is on for a build or an example, off for ?debug=1 and the embed', () => {
  assert.match(js, /const PRODUCT = Boolean\(SPECIMEN \|\| SEED\) && !params\.has\("debug"\) && !EMBED;/);
  assert.match(js, /if \(PRODUCT\) \{\s*document\.body\.classList\.add\("product"\)/);
});

test('the repo clip menu is never shown on a build or an example', () => {
  assert.match(js, /\$\("#clipPick"\)\.hidden = Boolean\(SPECIMEN \|\| SEED\);/);
});

test('the plain viewer hides the lab modes and the motion readout, keeping two ways to look', () => {
  const rule = css.split('\n').find((l) => l.startsWith('.product .modes > '));
  assert.ok(rule, 'stable.css hides the lab modes for .product');
  assert.match(rule, /:not\(\[data-cam="orbit"\]\):not\(\[data-cam="recorded"\]\)/);
  assert.match(rule, /\.product \.motion/);
  assert.match(rule, /display: none !important/);
});

test('the title is the subject, or "Your world" when there is no real name', () => {
  const start = js.indexOf('\nconst GENERIC =');
  const end = js.indexOf('\nif (PRODUCT) {', start);
  assert.ok(start >= 0 && end > start, 'test must run the actual naming block');
  const ctx = {};
  vm.runInNewContext(`${js.slice(start, end)}; this.worldName = worldName;`, ctx);
  assert.equal(ctx.worldName('moose'), 'Moose');
  assert.equal(ctx.worldName('white wolves, white wolves'), 'White wolves');
  assert.equal(ctx.worldName('wolf, moose'), 'Wolf and moose');
  for (const none of ['', null, undefined, 'animal', 'an animal', 'Subject', 'objects']) assert.equal(ctx.worldName(none), 'Your world');
  assert.ok(ctx.worldName('x'.repeat(200)).length <= 60);
});
