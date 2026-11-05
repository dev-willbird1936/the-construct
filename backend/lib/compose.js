import sharp from "sharp";
import { decodeMaskToRaster } from "@meta-sam/parser";

// A mask record's raster is cropped to its own bounding box (record.bounds), at
// roughly native pixel density for that box -- NOT a downsampled full frame.
// Place it at (bounds.left, bounds.top) on a zeroed full-frame canvas, nearest-
// neighbor scaling only if the raster's own H/W differs from the box's pixel size.
export function upscaleMask(record, frameWidth, frameHeight) {
  const raster = decodeMaskToRaster(record.mask); // Uint8Array, row-major, H*W
  const { width: maskWidth, height: maskHeight } = record.mask;
  const { left, top, right, bottom } = record.bounds;
  const boxWidth = right - left;
  const boxHeight = bottom - top;
  const out = new Uint8Array(frameWidth * frameHeight);
  for (let y = 0; y < boxHeight; y += 1) {
    const frameY = top + y;
    if (frameY < 0 || frameY >= frameHeight) continue;
    const sourceY = Math.min(maskHeight - 1, Math.floor((y * maskHeight) / boxHeight));
    const rowOffset = sourceY * maskWidth;
    const outRowOffset = frameY * frameWidth;
    for (let x = 0; x < boxWidth; x += 1) {
      const frameX = left + x;
      if (frameX < 0 || frameX >= frameWidth) continue;
      const sourceX = Math.min(maskWidth - 1, Math.floor((x * maskWidth) / boxWidth));
      out[outRowOffset + frameX] = raster[rowOffset + sourceX];
    }
  }
  return out;
}

export function maskIoU(a, b) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av || bv) {
      union += 1;
      if (av && bv) intersection += 1;
    }
  }
  return union === 0 ? 0 : intersection / union;
}

export function maskArea(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i];
  return count;
}

// Compose an RGBA cutout: pixels inside `mask` keep the source color with full
// alpha, everything else becomes black with zero alpha, so stacked translucent
// slices in the three.js volume let empty regions through instead of dimming them.
export async function compositeCutout(framePngBuffer, mask, frameWidth, frameHeight, maxWidth) {
  const { data } = await sharp(framePngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0, pixel = 0; i < mask.length; i += 1, pixel += 4) {
    if (!mask[i]) {
      rgba[pixel] = 0;
      rgba[pixel + 1] = 0;
      rgba[pixel + 2] = 0;
      rgba[pixel + 3] = 0;
    }
  }
  let pipeline = sharp(Buffer.from(rgba), {
    raw: { width: frameWidth, height: frameHeight, channels: 4 },
  });
  if (maxWidth && frameWidth > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth });
  }
  return pipeline.png().toBuffer();
}
