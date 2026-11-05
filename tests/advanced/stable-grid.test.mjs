// grid.bin (a fixed-camera world's environment as grids) rebuilds exactly the buffers make-world writes as
// pos.f32 / uv.f32 / idx.u32: same vertex order, same local indices, same triangles per kept quad.
// Run: node --test tests/advanced/
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeGrid } from "../../stable-grid.mjs";

const TX = 0.7, TY = 0.4;

// the buffers as make-world lays them out (world_env.env_geometry + world_common.grid_triangles), for a
// part of w x h vertices with depth z(c, r) and a kept-quad test
function reference(parts) {
  const pos = [], uv = [], idx = [];
  const recs = {};
  for (const p of parts) {
    const rec = { vertOffset: pos.length / 3, vertCount: p.w * p.h, idxOffset: idx.length };
    for (let r = 0; r < p.h; r++) for (let c = 0; c < p.w; c++) {
      const u = p.u(c), v = p.v(r), d = p.z(c, r);
      pos.push((u - 0.5) * 2 * TX * d, -(v - 0.5) * 2 * TY * d, -d);
      uv.push(u, 1 - v);
    }
    for (let qy = 0; qy < p.h - 1; qy++) for (let qx = 0; qx < p.w - 1; qx++) {
      if (!p.keep(qx, qy)) continue;
      const a = qy * p.w + qx;
      idx.push(a, a + p.w, a + 1, a + 1, a + p.w, a + p.w + 1);
    }
    rec.idxCount = idx.length - rec.idxOffset;
    recs[p.part] = rec;
  }
  return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint32Array(idx), recs };
}

// grid.bin as the seed packer writes it
function pack(parts, type = "f32") {
  const chunks = [], out = [];
  let at = 0;
  const put = (typed) => { const o = at; chunks.push(new Uint8Array(typed.buffer.slice(0))); at += typed.byteLength; while (at % 4) { chunks.push(new Uint8Array(1)); at += 1; } return o; };
  for (const p of parts) {
    const g = { part: p.part, w: p.w, h: p.h };
    g.u = put(Float32Array.from({ length: p.w }, (_, c) => p.u(c)));
    g.v = put(Float32Array.from({ length: p.h }, (_, r) => 1 - p.v(r)));
    const z = Float64Array.from({ length: p.w * p.h }, (_, k) => p.z(k % p.w, Math.floor(k / p.w)));
    if (type === "f32") g.z = { type, at: put(Float32Array.from(z)) };
    else {
      const lo = Math.min(...z.map(Math.log)), hi = Math.max(...z.map(Math.log));
      g.z = { type, min: lo, max: hi, at: put(Uint16Array.from(z, (d) => Math.round((Math.log(d) - lo) / (hi - lo) * 65535))) };
    }
    const quads = (p.w - 1) * (p.h - 1), bits = new Uint8Array(Math.ceil(quads / 8));
    let all = true;
    for (let q = 0; q < quads; q++) {
      if (p.keep(q % (p.w - 1), Math.floor(q / (p.w - 1)))) bits[q >> 3] |= 128 >> (q & 7); else all = false;
    }
    g.keep = all ? null : put(bits);
    out.push(g);
  }
  const bin = new Uint8Array(at);
  let o = 0;
  for (const c of chunks) { bin.set(c, o); o += c.length; }
  return { parts: out, bin: bin.buffer };
}

const PARTS = [
  { part: "env", w: 9, h: 6, u: (c) => (c * 2 + 0.5) / 18, v: (r) => (r * 2 + 0.5) / 12, z: (c, r) => 1 + 0.1 * c + 0.3 * Math.sin(r), keep: (x, y) => (x + 2 * y) % 5 !== 0 },
  { part: "fill", w: 14, h: 10, u: (c) => (c * 2 - 4 + 0.5) / 18, v: (r) => (r * 2 - 4 + 0.5) / 12, z: (c, r) => 3 + 0.05 * r, keep: () => true },
];

function world(type) {
  const ref = reference(PARTS);
  const { parts, bin } = pack(PARTS, type);
  const meta = { tanX: TX, tanY: TY, env: [ref.recs.env], fill: ref.recs.fill, grid: { file: "grid.bin", parts } };
  return { ref, meta, bin };
}

test("an f32 grid rebuilds make-world's buffers", () => {
  const { ref, meta, bin } = world("f32");
  const { pos, uv, idx } = decodeGrid(meta, bin);
  assert.deepEqual([...idx], [...ref.idx]);
  assert.deepEqual([...uv], [...ref.uv]);
  assert.equal(pos.length, ref.pos.length);
  for (let i = 0; i < pos.length; i++) assert.ok(Math.abs(pos[i] - ref.pos[i]) <= 1e-6 * Math.max(1, Math.abs(ref.pos[i])), `pos ${i}`);
});

test("a u16 log-depth grid is within 1e-4 of the depth", () => {
  const { ref, meta, bin } = world("u16log");
  const { pos, idx } = decodeGrid(meta, bin);
  assert.deepEqual([...idx], [...ref.idx]);
  for (let i = 2; i < pos.length; i += 3) assert.ok(Math.abs(pos[i] / ref.pos[i] - 1) < 1e-4, `z ${i}`);
});

test("a damaged grid is refused, not drawn", () => {
  const { meta, bin } = world("f32");
  assert.throws(() => decodeGrid(meta, bin.slice(0, bin.byteLength - 8)), /truncated/);
  const short = structuredClone(meta); short.env[0].idxCount -= 6;
  assert.throws(() => decodeGrid(short, bin), /does not match/);
  const wrong = structuredClone(meta); wrong.grid.parts[0].w = 8;
  assert.throws(() => decodeGrid(wrong, bin), /invalid environment grid/);
  const odd = structuredClone(meta); odd.grid.parts[0].u += 1;
  assert.throws(() => decodeGrid(odd, bin), /truncated/);
  const unknown = structuredClone(meta); unknown.grid.parts[0].part = "sky";
  assert.throws(() => decodeGrid(unknown, bin), /invalid environment grid/);
});
