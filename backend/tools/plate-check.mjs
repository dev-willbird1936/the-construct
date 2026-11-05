// SAM on a finished plate: only a successful, valid mask can certify no instance.
// node backend/tools/plate-check.mjs <plate.png> <concept> <out mask.png>
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export async function scanPlate(png, width, height, concept, predict) {
  if (![width, height, width * height].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("plate-check: invalid source dimensions");
  }
  const mask = await predict(png, width, height, concept);
  if (!(mask instanceof Uint8Array) || mask.length !== width * height) {
    throw new Error("plate-check: invalid segmentation mask");
  }
  const count = mask.reduce((n, v) => n + (v ? 1 : 0), 0);
  return { mask, result: { checked: true, found: count > 0, share: count / mask.length } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [plate, concept, out] = process.argv.slice(2);
    const image = sharp(plate);
    const { width, height } = await image.metadata();
    const png = await image.png().toBuffer();
    // Delay the paid adapter import: pure validation tests load no credential helper.
    const { conceptMask } = await import("../lib/detect.js");
    const { mask, result } = await scanPlate(png, width, height, concept, conceptMask);
    await sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }).png().toFile(out);
    console.log(JSON.stringify(result));
  } catch {
    // No synthetic success JSON/mask, and no provider body or credentials in stderr.
    console.error("plate-check: failed; plate cleanliness is unverified");
    process.exitCode = 1;
  }
}
