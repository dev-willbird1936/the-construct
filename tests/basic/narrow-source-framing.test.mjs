// Loop 7 (tier-improve 2026-11-04): sources narrower than 16:9 (phone
// portrait, square, 4:3) used to fill a 16:9 window with a cropped zoom (a
// 9:16 clip showed about a quarter of its height) and to fill a phone with a
// 2:1 strip. They now keep the 16:9 plate height and pillarbox to the source
// aspect; 16:9 and wider sources keep the legacy viewport exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../../view-basic.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const world = source.slice(source.indexOf('const WS = '), source.indexOf('// Zero-rim footprint'));
const fit = source.slice(source.indexOf('let fitView = '), source.indexOf('// ── Desktop subject framing'));

function frame({ W, H, w, h, need = 1.2 }) {
  const ctx = { Math, W, H, aspectH: H / W, innerWidth: w, innerHeight: h, FIT_VIEW_ASPECT: need, refreshFitNeed: () => {} };
  return vm.runInNewContext(`${world}\n${fit}\n({ WS, worldW, worldH, view: fitUpdate() })`, ctx);
}

test('16:9 and wider sources keep the legacy world and full viewport', () => {
  for (const [W, H] of [[960, 540], [960, 538], [960, 400]]) {
    const r = frame({ W, H, w: 1280, h: 720 });
    assert.equal(r.WS, 1); assert.equal(r.worldW, 2); assert.equal(r.worldH, 2 * H / W);
    assert.deepEqual({ ...r.view }, { active: false, aspect: 1280 / 720, viewW: 1280, viewH: 720, barH: 0, barW: 0 });
  }
});

test('a portrait source keeps the 16:9 plate height and pillarboxes on desktop', () => {
  const r = frame({ W: 540, H: 960, w: 1280, h: 720 });
  assert.ok(Math.abs(r.worldH - 1.125) < 1e-9); assert.ok(Math.abs(r.worldW - 1.125 * 540 / 960) < 1e-9);
  assert.equal(r.view.active, false); assert.equal(r.view.viewW, 405); assert.equal(r.view.viewH, 720);
  assert.equal(r.view.barW, Math.floor((1280 - 405) / 2)); assert.ok(Math.abs(r.view.aspect - 0.5625) < 1e-9);
});

test('a square source is square on desktop; a phone never letterboxes wider than the source', () => {
  const desk = frame({ W: 960, H: 960, w: 1280, h: 720 });
  assert.equal(desk.view.viewW, 720); assert.equal(desk.view.aspect, 1);
  const phone = frame({ W: 540, H: 960, w: 390, h: 844, need: 2.04 });
  assert.equal(phone.view.active, true); assert.ok(phone.view.aspect <= 540 / 960 + 0.01, `phone aspect ${phone.view.aspect}`);
});
