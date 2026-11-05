import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../../vendor/three/build/three.module.js';

// Loop 11 view framing: the production frameChronoView / chronoPanAt from
// volume.js, checked against real three.js cameras (not the solver's own
// projector). The rest view is centred and filled; no drag extreme, nor
// any turn in between, pushes a displayed subject out of the frame.
const VOLUME = process.env.LITE_VOLUME_JS || new URL('../../volume.js', import.meta.url);
const source = (await fs.readFile(VOLUME, 'utf8')).replace(/\r\n/g, '\n');
const from = source.indexOf('const degToRad');
const to = source.indexOf('function ribbonStrip(', from);
assert.ok(from >= 0 && to > from, 'fit + view framing block');
const api = vm.runInNewContext(`${source.slice(from, to).replace(/^export /gm, '')}\n({ frameChronoView, chronoPanAt, fitChronoRow, portraitChronoPoints });`, {});

const H = 3.4;
// A row laid out the way buildChronoVolume does (index spacing, depth by
// length, feet on the ground), with subject boxes like the anchors carry.
function rowRects(count, aspect, inset = 0.04) {
  const W = H * aspect, rowLen = 0.85 * W * (count - 1), depth = Math.min(4.6, Math.max(0.8, rowLen * 0.15));
  return { W, rowLen, depth, rects: Array.from({ length: count }, (_, i) => {
    const u = count <= 1 ? 0.5 : i / (count - 1), head = i === count - 1;
    return { x: (u - 0.5) * rowLen, y: 0, z: (u - 0.5) * depth, s: head ? 1.06 : 1,
      l: head ? -W / 2 : (inset - 0.5) * W, r: head ? W / 2 : (0.5 - inset) * W, t: H / 2, b: -H / 2 };
  }) };
}
function portraitRects(count, aspect) {
  const W = H * aspect, shape = aspect;
  const { points } = api.portraitChronoPoints({ count, poseW: W, poseH: H, spreadK: Math.min(1, Math.max(0.3, 0.6 / shape)), depthK: 2, max: 3 });
  return points.map((p, j) => ({ x: p.x, y: 0, z: p.z, s: p.s, l: -W / 2, r: W / 2, t: H / 2, b: -H / 2 }));
}
// Project with three.js: group turned (pitch, yaw), camera panned per frame.
function view(rects, frame, aspect, yaw, pitch) {
  const cam = new THREE.PerspectiveCamera(38, aspect, 0.1, 500);
  const p = api.chronoPanAt(frame, yaw, pitch);
  cam.position.set(frame.camX + p.x, frame.camY + p.y, frame.dist);
  cam.lookAt(p.x, frame.aimY + p.y, 0);
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const g = new THREE.Object3D(); g.rotation.set(pitch, yaw, 0); g.updateMatrixWorld();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rects) for (const [lx, ly] of [[r.l, r.t], [r.r, r.t], [r.l, r.b], [r.r, r.b]]) {
    const v = new THREE.Vector3(r.x + lx * r.s, r.y + ly * r.s, r.z).applyMatrix4(g.matrixWorld).project(cam);
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
  }
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: (x1 - x0) / 2, h: (y1 - y0) / 2 };
}
function sweep(rects, frame, aspect, yawBound) {
  let worst = 0;
  for (let i = 0; i <= 20; i += 1) for (let j = 0; j <= 6; j += 1) {
    const b = view(rects, frame, aspect, -0.3 - yawBound + (2 * yawBound * i) / 20, -0.28 + (0.56 * j) / 6);
    worst = Math.max(worst, -b.x0, b.x1, -b.y0, b.y1);
  }
  return worst;
}

const CASES = [
  ['long wide row (herd)', 6, 1.21, 978 / 496], ['seven near-square poses', 7, 1.03, 978 / 496],
  ['short tall row', 5, 0.5, 978 / 496], ['single pose (living still)', 1, 1.04, 978 / 496], ['very wide poses', 4, 2.24, 2.2],
];

for (const [name, count, aspect, asp] of CASES) {
  test(`wide stage, ${name}: rest view centred and filled, every turn inside the frame`, () => {
    const { rects } = rowRects(count, aspect);
    const f = api.frameChronoView(rects, { aspect: asp, aimY: -0.2, yawBound: 0.52 });
    const rest = view(rects, f, asp, -0.3, 0);
    assert.ok(Math.abs(rest.cx) < 0.01 && Math.abs(rest.cy) < 0.01, `centred ${rest.cx.toFixed(3)},${rest.cy.toFixed(3)}`);
    const tight = Math.max(rest.w / 0.94, rest.h / 0.86);
    assert.ok(tight <= 1.001, `rest fill inside target (${tight.toFixed(3)})`);
    // As close as the bounds allow: either the rest fill or an extreme binds.
    assert.ok(tight > 0.97 || sweep(rects, f, asp, 0.52) > 0.96, `fit is tight (${tight.toFixed(3)})`);
    const worst = sweep(rects, f, asp, 0.52);
    assert.ok(worst <= 1, `every turn inside the frame (worst ${worst.toFixed(3)})`);
  });
}

test('the canonical on-axis fit leaves wide rows right of centre; the view framing centres and enlarges them', () => {
  const asp = 978 / 496, count = 6, aspect = 1.21;
  const { W, rowLen, depth, rects } = rowRects(count, aspect, 0);
  const D = api.fitChronoRow({ count, poseW: W, poseH: H, rowLen, depth }, { fovDeg: 38, aspect: asp, yawRest: -0.3, yawBound: 0.52, pitchBound: 0.28, fill: 0.85, widthFill: 0.97, aimY: -0.2 });
  const old = view(rects, { camX: 1.4, camY: 0.9, dist: D, aimY: -0.2, pans: null }, asp, -0.3, 0);
  const f = api.frameChronoView(rects, { aspect: asp, aimY: -0.2, yawBound: 0.52 });
  const now = view(rects, f, asp, -0.3, 0);
  assert.ok(old.cx > 0.15, `old row sat right (${old.cx.toFixed(3)})`);
  assert.ok(Math.abs(now.cx) < 0.01 && now.h > old.h * 1.1, `centred and larger (${old.h.toFixed(3)} -> ${now.h.toFixed(3)})`);
});

for (const [name, aspect] of [['tall poses', 0.5], ['square poses', 1.03], ['wide poses seen from above', 2.24]]) {
  test(`phone diagonal, ${name}: centred, contained at every turn`, () => {
    const asp = 354 / 523, rects = portraitRects(7, aspect);
    assert.equal(rects.length, 3, 'three poses on phones');
    const elev = (Math.min(25, Math.max(0, (aspect - 0.8) * 25)) * Math.PI) / 180;
    const f = api.frameChronoView(rects, { aspect: asp, elev, aimY: 0, yawBound: 0.28 });
    assert.ok(f.camY > 0.9 + f.dist * Math.tan(elev) - 1e-9 && f.camY < 0.9 + f.dist * Math.tan(elev) + 1e-9);
    const rest = view(rects, f, asp, -0.3, 0);
    assert.ok(Math.abs(rest.cx) < 0.01 && Math.abs(rest.cy) < 0.01, `centred ${rest.cx.toFixed(3)},${rest.cy.toFixed(3)}`);
    assert.ok(sweep(rects, f, asp, 0.28) <= 1, 'every turn inside the frame');
  });
}

test('chronoPanAt: rest pan at rest, clamped outside the drag range, zero without a frame', () => {
  const { rects } = rowRects(5, 1);
  const f = api.frameChronoView(rects, { aspect: 2, aimY: -0.2, yawBound: 0.52 });
  const r = api.chronoPanAt(f, -0.3, 0);
  assert.ok(Math.abs(r.x - f.rest.x) < 1e-9 && Math.abs(r.y - f.rest.y) < 1e-9);
  const far = api.chronoPanAt(f, 5, 5), edge = api.chronoPanAt(f, -0.3 + 0.52, 0.28);
  assert.ok(Math.abs(far.x - edge.x) < 1e-9 && Math.abs(far.y - edge.y) < 1e-9);
  const none = api.chronoPanAt(null, 0, 0);
  assert.ok(none.x === 0 && none.y === 0);
});

test('frameChronoView rejects empty rects and bad camera input', () => {
  assert.throws(() => api.frameChronoView([], { aspect: 2 }));
  assert.throws(() => api.frameChronoView([{ x: 0 }], { aspect: 2 }));
  assert.throws(() => api.frameChronoView(rowRects(3, 1).rects, { aspect: 0 }));
  assert.throws(() => api.frameChronoView(rowRects(3, 1).rects, { aspect: 2, fovDeg: 120 }));
});
