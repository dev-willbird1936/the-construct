// Loop 10 (tier-improve 2026-11-04): the viewer warps the two poses of a
// keyframe pair with flow.py's coarse field instead of cross-fading two
// bodies. flowVertexDisp must sample the grid exactly as flow.py lays it out
// (node 0 on the cell's left/top edge), read fwd for the outgoing pose and
// bwd for the incoming one, and flip y into world units.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../../view-basic.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const fnSrc = source.slice(source.indexOf('function flowVertexDisp('), source.indexOf('const warpCache = new Map();'));
const flowVertexDisp = vm.runInNewContext(`${fnSrc}\nflowVertexDisp`, { Math, Float32Array });

function field({ gx = 4, gy = 3, pairs = 2, scale = 0.5, fill }) {
  const q = new Int8Array(pairs * gy * gx * 4);
  for (let p = 0; p < pairs; p += 1) for (let y = 0; y < gy; y += 1) for (let x = 0; x < gx; x += 1) for (let c = 0; c < 4; c += 1) {
    q[((p * gy + y) * gx + x) * 4 + c] = fill(p, x, y, c);
  }
  return { q, gx, gy, scale };
}

test('a uniform field moves every vertex by value*scale in world units, y flipped', () => {
  const f = field({ fill: (p, x, y, c) => [10, -6, -4, 8][c] });
  const sx = 0.01, sy = 0.02;
  const out = flowVertexDisp(f, 0, 0, 8, 4, sx, sy);
  assert.equal(out.length, 9 * 5 * 2);
  for (let k = 0; k < 45; k += 1) {
    assert.ok(Math.abs(out[k * 2] - 10 * 0.5 * sx) < 1e-6);
    assert.ok(Math.abs(out[k * 2 + 1] - 6 * 0.5 * sy) < 1e-6);
  }
  const inc = flowVertexDisp(f, 0, 1, 8, 4, sx, sy); // incoming pose reads bwd
  assert.ok(Math.abs(inc[0] - -4 * 0.5 * sx) < 1e-6);
  assert.ok(Math.abs(inc[1] - -8 * 0.5 * sy) < 1e-6);
});

test('grid corners land on mesh corners and the middle is bilinear', () => {
  // fwd dx = 10*x + y (node coords), pair 1 only
  const f = field({ gx: 3, gy: 3, scale: 1, fill: (p, x, y, c) => (p === 1 && c === 0 ? 10 * x + y : 0) });
  const nx = 4, ny = 2;
  const out = flowVertexDisp(f, 1, 0, nx, ny, 1, 1);
  const at = (ix, iy) => out[(iy * (nx + 1) + ix) * 2];
  assert.equal(at(0, 0), 0);
  assert.equal(at(nx, 0), 20);
  assert.equal(at(0, ny), 2);
  assert.equal(at(nx, ny), 22);
  assert.ok(Math.abs(at(1, 1) - (10 * 0.5 + 1)) < 1e-6); // u = 0.5 node, v = 1 node
  assert.equal(flowVertexDisp(f, 0, 0, nx, ny, 1, 1).every((v) => v === 0), true, 'pair 0 is untouched');
});

test('the viewer loads the field only when declared and keeps an opt-out', () => {
  assert.match(source, /specimen\.flow/);
  assert.match(source, /\[\?&\]flow=0\\b/);
  assert.match(source, /flowOn: !!flowField/);
});
