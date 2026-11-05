// A fixed-camera world's environment is a regular grid seen from the lens. Per part (the crisp surface
// env[0], and the backdrop `fill`) it is a row of u, a column of v, one depth per vertex, and the quads kept.
// `meta.grid` describes that compact form (grid.bin, about a tenth of pos.f32 + uv.f32 + idx.u32). This
// rebuilds the buffers stable.js draws, in their layout: vertices in grid order at the part's vertOffset,
// indices local to the part from its idxOffset, two triangles a-c-b, b-c-d per kept quad, row by row.
//
// grid.bin sections (byte offsets in meta.grid.parts[]):
//   u      float32[w]      the texture u of each column
//   v      float32[h]      the stored uv.y (1 - source v) of each row
//   z.at   float32[w*h]    depth along the lens axis in world units (z.type "f32"), or
//          uint16[w*h]     log depth quantised between z.min and z.max (z.type "u16log")
//   keep   bits[(w-1)*(h-1)]  quads kept, row by row, most significant bit first (null: all kept)
const PARTS = ["env", "fill"];

export function decodeGrid(meta, bin) {
  const grid = meta.grid;
  if (!grid || !Array.isArray(grid.parts) || !grid.parts.length) throw new Error("This clip has an invalid environment grid.");
  const recs = { env: meta.env?.[0], fill: meta.fill };
  const view = (Type, at, n) => {
    if (!Number.isInteger(at) || at < 0 || at % Type.BYTES_PER_ELEMENT || at + n * Type.BYTES_PER_ELEMENT > bin.byteLength) {
      throw new Error("This clip's environment grid is truncated.");
    }
    return new Type(bin, at, n);
  };
  for (const g of grid.parts) {
    const rec = recs[g?.part];
    if (!PARTS.includes(g?.part) || !rec || !(Number.isInteger(g.w) && Number.isInteger(g.h) && g.w > 1 && g.h > 1) ||
        g.w * g.h !== rec.vertCount || ![rec.vertOffset, rec.idxOffset, rec.idxCount].every((n) => Number.isInteger(n) && n >= 0)) {
      throw new Error("This clip has an invalid environment grid.");
    }
  }
  const verts = Math.max(...grid.parts.map((g) => recs[g.part].vertOffset + recs[g.part].vertCount));
  const tris = Math.max(...grid.parts.map((g) => recs[g.part].idxOffset + recs[g.part].idxCount));
  const pos = new Float32Array(verts * 3), uv = new Float32Array(verts * 2), idx = new Uint32Array(tris);
  const tx = meta.tanX, ty = meta.tanY;
  for (const g of grid.parts) {
    const rec = recs[g.part], { w, h } = g;
    const us = view(Float32Array, g.u, w), vs = view(Float32Array, g.v, h);
    let z;
    if (g.z?.type === "f32") z = view(Float32Array, g.z.at, w * h);
    else if (g.z?.type === "u16log" && Number.isFinite(g.z.min) && Number.isFinite(g.z.max)) {
      const q = view(Uint16Array, g.z.at, w * h), span = g.z.max - g.z.min;
      z = new Float64Array(w * h);
      for (let k = 0; k < z.length; k++) z[k] = Math.exp(g.z.min + (q[k] / 65535) * span);
    } else throw new Error("This clip has an unknown environment depth type.");
    for (let r = 0, k = 0; r < h; r++) {
      const vRow = 1 - vs[r];
      for (let c = 0; c < w; c++, k++) {
        const o = rec.vertOffset + k, d = z[k];
        pos[o * 3] = (us[c] - 0.5) * 2 * tx * d;
        pos[o * 3 + 1] = -(vRow - 0.5) * 2 * ty * d;
        pos[o * 3 + 2] = -d;
        uv[o * 2] = us[c];
        uv[o * 2 + 1] = vs[r];
      }
    }
    const keep = g.keep == null ? null : view(Uint8Array, g.keep, Math.ceil((w - 1) * (h - 1) / 8));
    const end = rec.idxOffset + rec.idxCount;
    let n = rec.idxOffset;
    for (let qy = 0, q = 0; qy < h - 1; qy++) {
      for (let qx = 0; qx < w - 1; qx++, q++) {
        if (keep && !(keep[q >> 3] & (128 >> (q & 7)))) continue;
        if (n + 6 > end) throw new Error("This clip's environment grid does not match its surface.");
        const a = qy * w + qx, b = a + 1, c = a + w, d = c + 1;
        idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
      }
    }
    if (n !== end) throw new Error("This clip's environment grid does not match its surface.");
  }
  return { pos, uv, idx };
}
