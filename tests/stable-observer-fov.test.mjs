import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as math from '../stable-math.mjs';

const base = 45.19494668628921;
const phone = 390 / 844;
const source = fs.readFileSync(new URL('../stable.js', import.meta.url), 'utf8');
const start = source.indexOf('  const embedFov =');
const end = source.indexOf('  if (mode === "recorded") {', start);
assert.ok(start >= 0 && end > start, 'test must execute the actual observer-FOV selection block');
function observer({ aspect = phone, lensView = true, mode = 'orbit', world = null, embedded = true, override = '', sourceFov = base / 1.28, initial = 61.3, sur = null } = {}) {
  const camera = { aspect, fov: initial, updates: 0, updateProjectionMatrix() { this.updates++; } };
  vm.runInNewContext(source.slice(start, end), {
    EMBED: embedded, params: new URLSearchParams(override ? { fov: override } : {}),
    lensView, mode, world, camera, meta: { fovY: sourceFov }, CLIP: 'mug-v4B', sur,
    portraitFov: math.portraitFov,
    THREE: { MathUtils: { radToDeg: v => v * 180 / Math.PI, degToRad: v => v * Math.PI / 180 } },
  });
  return camera;
}
const oldWorld = (fov, aspect) => Math.min(110, 2 * Math.atan(Math.tan(fov * Math.PI / 360) / Math.min(aspect, 1)) * 180 / Math.PI);

test('portrait lens observer retains the short-axis angle for the verified mug case', () => {
  const fov = math.portraitFov(base, phone);
  assert.ok(fov > 83 && fov < 85);
  assert.ok(Math.abs(Math.tan(fov * Math.PI / 360) * phone - Math.tan(base * Math.PI / 360)) < 1e-12);
});
test('square and landscape retain their exact original field of view', () => {
  for (const aspect of [1, 1.6, 2.5]) assert.equal(math.portraitFov(base, aspect), base);
});
test('widening is capped without ever narrowing an existing wide lens', () => {
  assert.equal(math.portraitFov(45, 0.1), 110);
  assert.equal(math.portraitFov(120, phone), 120);
  assert.equal(math.portraitFov(115, 2), 115);
  assert.equal(math.portraitFov(109, phone), 110);
});
test('zero-size and malformed aspect ratios keep the original finite projection', () => {
  for (const aspect of [0, -1, NaN, Infinity, -Infinity, undefined, null, '0.5', true, {}]) {
    assert.equal(math.portraitFov(base, aspect), base);
  }
});
test('portrait widening is monotonic and bounded across supported lens widths', () => {
  for (const fov of [10, 35, base, 80, 109, 120, 170]) {
    let previous = fov;
    for (let i = 99; i >= 5; i--) {
      const next = math.portraitFov(fov, i / 100);
      assert.ok(next >= previous && next <= Math.max(fov, 110));
      previous = next;
    }
  }
});
test('actual fixed-V2 default observer widens portrait, not landscape', () => {
  assert.ok(observer().fov > 83 && observer().fov < 85, 'phone currently crops the body and handle at 45 degrees');
  assert.equal(observer({ aspect: 1.6 }).fov, base);
  assert.equal(observer({ aspect: 1 }).fov, base);
});
test('a world with a surround rests at 1.06 times its lens, so the picture fills the view', () => {
  const sur = { tex: 'env/surround.jpg', pad: [0.25, 0.25] };
  assert.ok(Math.abs(observer({ aspect: 1.6, sur }).fov - (base / 1.28) * 1.06) < 1e-9);
  assert.equal(observer({ aspect: phone, sur }).fov, math.portraitFov((base / 1.28) * 1.06, phone));
  assert.equal(observer({ aspect: 1.6, sur, mode: 'recorded' }).fov, base / 1.28);
  assert.equal(observer({ aspect: 1.6, sur, override: '36' }).fov, 36);
});
test('explicit embedded lens overrides remain authoritative', () => {
  assert.equal(observer({ override: '36' }).fov, 36);
  assert.equal(observer({ override: '120' }).fov, 120);
});
test('recorded projection and cinematic observer assignment remain unchanged', () => {
  assert.equal(observer({ mode: 'recorded' }).fov, base / 1.28);
  const cinematic = observer({ mode: 'cinematic' });
  assert.equal(cinematic.fov, 61.3);
  assert.equal(cinematic.updates, 0);
});
test('non-lens legacy observers keep their current framing', () => {
  for (const aspect of [phone, 1, 1.6]) assert.equal(observer({ aspect, lensView: false }).fov, 50);
});
test('generated-world framing is unchanged, including its existing cap', () => {
  for (const aspect of [phone, 1, 1.6]) {
    assert.equal(observer({ aspect, lensView: false, world: {} }).fov, oldWorld(50, aspect));
    assert.equal(observer({ aspect, lensView: false, world: { captured: true } }).fov, oldWorld(36, aspect));
    assert.equal(observer({ aspect, lensView: false, world: {}, sourceFov: 120 }).fov, oldWorld(120, aspect));
  }
});
