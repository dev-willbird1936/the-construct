import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the production resize closure, not a copied implementation. Geometry
// helpers are stubs here: these tests cover sizing/recovery, not projection fit.
const source = fs.readFileSync(new URL('../../view-lite.js', import.meta.url), 'utf8');
const start = source.indexOf('  const resize = () => {');
const end = source.indexOf('  addEventListener("resize", resize);', start);
assert.ok(start > 0 && end > start);
const closure = source.slice(start, end) + '\nresize;';

function fixture(width = 0, innerHeight = 844, { frame = null, poseW = 2, groupClip = false, spacedFit = null } = {}) {
  const calls = [], pending = [];
  // Spaced moments: declines by default (the full row then keeps the contract below).
  const spaced = (aimY) => { calls.push(['spaced', aimY]); return spacedFit !== null; };
  spaced.fit = spacedFit;
  const stage = { clientWidth: width };
  const camera = { fov: 38, aspect: 1, updateProjectionMatrix() { calls.push('projection'); }, position: { set(...args) { calls.push(['position', ...args]); } }, lookAt() {} };
  // Follow framing (built after the plate is fitted): declines here, so the full frame stays.
  const followFrames = (full, options) => { calls.push(['follow', full, options.cardTurn]); return null; };
  const context = { stage, innerHeight, camera, renderer: { setSize(...args) { calls.push(['size', ...args]); } }, view: {}, YAWREST: -.3, PITCH: .28, CARD_TURN: .6, followFrames, followTarget: () => 0,
    group: { userData: { count: 4, poseW, poseH: 3, rowLen: 7, rowD: 2 } }, atlas: { timestamps: [1.48, 3.8, 5.04, 7.96], ...(groupClip ? { group: true } : {}) },
    selectPortraitIndices: (count, ts, max) => { calls.push(['subset', count, max]); return [0, 2, 3]; },
    portraitChronoPoints: (options) => { calls.push(['portrait', options.max, options.spreadK]); return { indices: [0, 1, 3], points: [{ x: 0 }] }; },
    setChronoLayout: (_, value) => calls.push(['layout', value.mode, value.points ? value.points.map(p => [p.order, +p.x.toFixed(3)]) : null]),
    // Projected framing: absent (throws) by default, so the fallback contract below still holds.
    chronoViewRects: () => [{ x: 0 }],
    frameChronoView: (_, options) => { calls.push(['frame', options.yawBound, options.aimY, options.elev]); if (!frame) throw new Error('no frame'); return frame; },
    placeCamera: (...args) => calls.push(['place', ...args]), spaced,
    fitChronoPoints: (_, options) => { assert.ok(options.aspect > 0 && Number.isFinite(options.aspect)); calls.push('portrait-fit'); return 5; },
    fitChronoRow: (_, options) => { assert.ok(options.aspect > 0 && Number.isFinite(options.aspect)); calls.push('row-fit'); return 5; },
    fitBackdropToFrame: () => calls.push('backdrop'), requestAnimationFrame: fn => pending.push(fn),
  };
  return { calls, pending, stage, context, camera, resize: vm.runInNewContext(closure, context) };
}

for (const [name, width, height] of [['zero width', 0, 844], ['zero height', 390, 0], ['negative width', -1, 844], ['nonfinite width', NaN, 844]]) {
  test(`Lite resize defers ${name} then recovers at a real size`, () => {
    const f = fixture(width, height);
    f.resize();
    assert.deepEqual(f.calls, []);
    assert.equal(f.pending.length, 1);
    f.stage.clientWidth = 352; f.context.innerHeight = 844;
    assert.doesNotThrow(() => f.pending.shift()());
    assert.equal(f.pending.length, 0);
    assert.ok(f.calls.includes('portrait-fit'));
    assert.equal(f.camera.aspect, 352 / (844 * .62));
  });
}

test('Lite resize remains deferred while hidden and recovers without a resize event', () => {
  const f = fixture(); f.resize();
  for (let i = 0; i < 5; i++) { f.pending.shift()(); assert.equal(f.pending.length, 1); assert.deepEqual(f.calls, []); }
  f.stage.clientWidth = 978;
  f.pending.shift()();
  assert.ok(f.calls.includes('row-fit'));
  assert.equal(f.pending.length, 0);
});

test('Lite visible desktop sizing follows the existing fit and camera contract', () => {
  const f = fixture(978, 800); f.resize();
  assert.equal(f.pending.length, 0);
  assert.deepEqual(f.calls[0], ['size', 978, 496, false]);
  assert.equal(f.camera.aspect, 978 / 496);
  assert.ok(f.calls.includes('row-fit'));
  assert.deepEqual(f.calls.find(c => Array.isArray(c) && c[0] === 'position'), ['position', 1.4, .9, 5]);
});

test('Lite resize centres the row with the projected framing when it solves', () => {
  const frame = { dist: 9, camX: 1.4, camY: .9, aimY: -.2, pans: [[{ x: 1, y: 0 }]], yaws: [-.3], pitches: [0] };
  const f = fixture(978, 800, { frame }); f.resize();
  assert.equal(f.context.view.frame, frame);
  assert.deepEqual(f.calls.find(c => Array.isArray(c) && c[0] === 'frame'), ['frame', .52, -.2, 0]);
  // The rest pan places the camera before the backdrop is fitted to it.
  const place = f.calls.findIndex(c => Array.isArray(c) && c[0] === 'place');
  assert.deepEqual(f.calls[place], ['place', -.3, 0, 0]);
  assert.ok(place < f.calls.indexOf('backdrop'));
  // The follow steps are built from the full frame once the plate is fitted,
  // with the same card turn the framing was solved with.
  const follow = f.calls.findIndex(c => Array.isArray(c) && c[0] === 'follow');
  assert.ok(follow > f.calls.indexOf('backdrop'));
  assert.equal(f.calls[follow][1], frame);
  assert.equal(f.calls[follow][2], .6);
  assert.equal(f.context.view.frames, null);
  assert.equal(f.context.view.zoom, 0);
});

test('Lite resize falls back to the canonical fit when the framing cannot solve', () => {
  const f = fixture(978, 800); f.resize();
  assert.equal(f.context.view.frame, null);
  assert.ok(f.calls.includes('backdrop'));
});

test('Lite phone diagonal: three poses, x spread by pose shape, wide poses seen from above', () => {
  const tall = fixture(352, 844, { poseW: 1.5 }); tall.resize();
  assert.deepEqual(tall.calls.find(c => Array.isArray(c) && c[0] === 'portrait'), ['portrait', 3, 1]);
  assert.deepEqual(tall.calls.find(c => Array.isArray(c) && c[0] === 'frame'), ['frame', .28, 0, 0]);
  assert.deepEqual(tall.context.view.headOrders, [0, 1, 3]);
  const wide = fixture(352, 844, { poseW: 6.6 }); wide.resize();
  const p = wide.calls.find(c => Array.isArray(c) && c[0] === 'portrait');
  assert.equal(p[1], 3); assert.ok(Math.abs(p[2] - .3) < 1e-9, `spread ${p[2]}`);
  const elev = wide.calls.find(c => Array.isArray(c) && c[0] === 'frame')[3];
  assert.ok(Math.abs(elev - 25 * Math.PI / 180) < 1e-9, `elevation ${elev}`);
});

test('Lite wide stage, group clip: three moments spaced 1.15 pose widths apart instead of the full row', () => {
  const f = fixture(978, 800, { groupClip: true }); f.resize();
  assert.deepEqual(f.calls.find(c => Array.isArray(c) && c[0] === 'subset'), ['subset', 4, 3]);
  const layout = f.calls.find(c => Array.isArray(c) && c[0] === 'layout');
  assert.equal(layout[1], 'subset');
  assert.deepEqual(layout[2], [[0, -2.3], [2, 0], [3, 2.3]]);
  assert.deepEqual(f.context.view.headOrders, [0, 2, 3]);
  assert.ok(f.calls.includes('portrait-fit'), 'fallback fit over the shown points');
  const single = fixture(978, 800); single.resize();
  assert.equal(single.calls.find(c => Array.isArray(c) && c[0] === 'layout')[1], 'row');
});

test('Lite wide stage, single subject: spaced moments when they solve, the full row otherwise', () => {
  const f = fixture(978, 800, { spacedFit: 7 }); f.resize();
  assert.deepEqual(f.calls.find(c => Array.isArray(c) && c[0] === 'spaced'), ['spaced', -.2]);
  assert.equal(f.calls.find(c => Array.isArray(c) && c[0] === 'layout'), undefined, 'spaced() lays itself out');
  assert.deepEqual(f.calls.find(c => Array.isArray(c) && c[0] === 'position'), ['position', 1.4, .9, 7]);
  const row = fixture(978, 800); row.resize();
  assert.equal(row.calls.find(c => Array.isArray(c) && c[0] === 'layout')[1], 'row');
  // Phones and groups never ask for it.
  const phone = fixture(352, 844); phone.resize();
  assert.equal(phone.calls.find(c => Array.isArray(c) && c[0] === 'spaced'), undefined);
  const herd = fixture(978, 800, { groupClip: true }); herd.resize();
  assert.equal(herd.calls.find(c => Array.isArray(c) && c[0] === 'spaced'), undefined);
});
