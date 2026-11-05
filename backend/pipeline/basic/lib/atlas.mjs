// Atlas grid layout for the Basic specimen. Pure, unit-tested.
//
// depth.webp holds (K+1) cells in the same column flow: cell 0 is the plate
// depth (full frame squeezed to a cell), cells 1..K are the per-keyframe
// subject depth crops aligned with subject.webp cells 0..K-1.

/** Column-major-safe grid: as square as possible, rows <= cols. */
export function gridLayout(count) {
  if (count < 1) throw new Error("gridLayout needs >= 1 cell");
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

/** Pixel rect of cell `i` in a cols-wide grid of cellW×cellH cells. */
export function cellRect(i, cols, cellW, cellH) {
  return {
    x: (i % cols) * cellW,
    y: Math.floor(i / cols) * cellH,
    w: cellW,
    h: cellH,
  };
}

/**
 * UV rect for a cell with three.js flipY=true textures (v origin bottom-left).
 * `atlasH` is the full atlas height; rect is top-left origin pixels.
 * `inset` shrinks by pixels on every side to avoid atlas bleeding.
 */
export function uvRect(rect, atlasW, atlasH, inset = 0.5) {
  const x0 = (rect.x + inset) / atlasW;
  const x1 = (rect.x + rect.w - inset) / atlasW;
  const y1 = 1 - (rect.y + inset) / atlasH;
  const y0 = 1 - (rect.y + rect.h - inset) / atlasH;
  return { x0, y0, x1, y1 };
}

/** Bilinear resize of a single-channel Float32Array plane. */
export function resizePlane(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const gy = Math.min(sh - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(gy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, gy - y0));
    for (let x = 0; x < dw; x += 1) {
      const gx = Math.min(sw - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(gx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, gx - x0));
      const a = src[y0 * sw + x0];
      const b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0];
      const d = src[y1 * sw + x1];
      out[y * dw + x] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return out;
}

/**
 * Minimal .npy reader (C-order float32 only, what depth.py writes).
 * Returns {data: Float32Array, shape}.
 */
export function readNpyFloat32(buffer) {
  const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
  if (!buffer.subarray(0, 6).equals(magic)) throw new Error("not an npy file");
  const headerLen = buffer.readUInt16LE(8);
  const header = buffer.subarray(10, 10 + headerLen).toString("latin1");
  if (!header.includes("'<f4'") && !header.includes("'=f4'") && !header.includes("|f4")) {
    throw new Error(`unsupported npy dtype in ${header.trim()}`);
  }
  if (header.includes("True") && header.includes("fortran")) {
    throw new Error("fortran-order npy not supported");
  }
  const shape = header
    .match(/\(([^)]*)\)/)[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const offset = 10 + headerLen;
  if (buffer.length < offset + count * 4) throw new Error("truncated npy data");
  const data = new Float32Array(count);
  for (let i = 0; i < count; i += 1) data[i] = buffer.readFloatLE(offset + i * 4);
  return { data, shape };
}

/** Reject malformed model rasters before resize/quantization can turn NaN into zero. */
export function requireDepthPlane(plane, width, height, label) {
  if (!plane || !Array.isArray(plane.shape) || plane.shape.length !== 2 ||
      plane.shape[0] !== height || plane.shape[1] !== width || plane.data?.length !== width * height) {
    throw new Error(`depth/frame size mismatch at ${label}`);
  }
  if (!plane.data.every(Number.isFinite)) throw new Error(`nonfinite depth at ${label}`);
  return plane;
}

/**
 * Fit `count` cells of aspect `cellAspect` (w/h) into an atlas whose width
 * does not exceed `maxWidth`, with cell width near `targetCell`.
 */
export function atlasSize(count, cellAspect, { targetCell = 224, maxWidth = 2048 } = {}) {
  const { cols, rows } = gridLayout(count);
  let cellW = targetCell;
  if (cols * cellW > maxWidth) cellW = Math.floor(maxWidth / cols);
  const cellH = Math.max(1, Math.round(cellW / cellAspect));
  return { cols, rows, cellW, cellH, width: cols * cellW, height: rows * cellH };
}
