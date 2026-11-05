import test from "node:test";
import assert from "node:assert/strict";
import {
  gridLayout,
  cellRect,
  uvRect,
  atlasSize,
  readNpyFloat32,
  resizePlane,
} from "../../backend/pipeline/basic/lib/atlas.mjs";

test("gridLayout is near-square with rows <= cols", () => {
  for (let n = 1; n <= 60; n += 1) {
    const { cols, rows } = gridLayout(n);
    assert.ok(cols * rows >= n);
    assert.ok(rows <= cols);
    assert.ok(cols - rows <= 1 || cols * (rows - 1) < n);
  }
  assert.deepEqual(gridLayout(32), { cols: 6, rows: 6 });
  assert.deepEqual(gridLayout(1), { cols: 1, rows: 1 });
});

test("cellRect tiles without overlap", () => {
  const { cols, rows } = gridLayout(7);
  const seen = new Set();
  for (let i = 0; i < 7; i += 1) {
    const r = cellRect(i, cols, 100, 50);
    assert.equal(r.w, 100);
    assert.equal(r.h, 50);
    assert.ok(r.x + r.w <= cols * 100 && r.y + r.h <= rows * 50);
    seen.add(`${r.x},${r.y}`);
  }
  assert.equal(seen.size, 7);
});

test("uvRect flips v for three.js and insets", () => {
  const r = uvRect({ x: 0, y: 0, w: 100, h: 50 }, 200, 100, 0);
  assert.deepEqual(r, { x0: 0, y0: 0.5, x1: 0.5, y1: 1 });
  const inset = uvRect({ x: 0, y: 0, w: 100, h: 50 }, 200, 100, 2);
  assert.ok(inset.x0 > 0 && inset.y1 < 1);
});

test("resizePlane is exact on 1:1 and linear on gradients", () => {
  const src = Float32Array.from([0, 10, 20, 30]); // 2x2
  assert.deepEqual(Array.from(resizePlane(src, 2, 2, 2, 2)), [0, 10, 20, 30]);
  const flat = new Float32Array(16).fill(7);
  assert.ok(resizePlane(flat, 4, 4, 2, 2).every((v) => v === 7));
  const grad = Float32Array.from([0, 100]); // 2x1 horizontal ramp
  const up = resizePlane(grad, 2, 1, 4, 1);
  assert.ok(up[0] < up[1] && up[1] < up[2] && up[2] < up[3]);
});
test("readNpyFloat32 parses C-order float32", () => {
  const dict = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 3), }";
  let header = dict + " ".repeat(64 - ((10 + dict.length + 1) % 64)) + "\n";
  const head = Buffer.alloc(10);
  Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00]).copy(head, 0);
  head.writeUInt16LE(header.length, 8);
  const payload = Buffer.alloc(6 * 4);
  [1.5, -2, 3.25, 0, 1e3, -0.5].forEach((v, i) => payload.writeFloatLE(v, i * 4));
  const { data, shape } = readNpyFloat32(Buffer.concat([head, Buffer.from(header, "latin1"), payload]));
  assert.deepEqual(shape, [2, 3]);
  assert.deepEqual(Array.from(data), [1.5, -2, 3.25, 0, 1e3, -0.5]);
  assert.throws(() => readNpyFloat32(Buffer.from("nope")), /not an npy/);
});
test("atlasSize respects maxWidth", () => {
  const a = atlasSize(33, 16 / 9, { targetCell: 224 });
  assert.ok(a.width <= 2048);
  assert.equal(a.cols * a.rows >= 33, true);
  assert.equal(a.cellH, Math.round(a.cellW / (16 / 9)));
});
