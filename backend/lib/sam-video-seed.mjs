// Explicit Lite selection only: original bytes, original decode-order frame indices.
export const VIDEO_SEED_UNSUPPORTED =
  'Selected tracking needs a short original clip (up to 350 frames, at most 1280 pixels wide). Re-pick on a supported clip.';
export const VIDEO_SEED_NO_MATCH =
  'Could not match the selected object at the exact video seed frame. Re-pick the object and try again.';
export const VIDEO_SEED_AMBIGUOUS =
  'The selected object matched unexpected video subjects. Re-pick a clearer frame and try again.';

export function requireWholeSeedSource({ frames, width, height }, seedFrameIndex) {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 350 ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 ||
      width > 1280 || width % 2 || height % 2 ||
      !Number.isSafeInteger(seedFrameIndex) || seedFrameIndex < 0 || seedFrameIndex >= frames) {
    throw new Error(VIDEO_SEED_UNSUPPORTED);
  }
}

export function makeVideoSeed({ box, frameIndex, frames, width, height, samWidth, samHeight, samOffset }) {
  requireWholeSeedSource({ frames, width, height }, frameIndex);
  if (samOffset !== 0 || samWidth !== width || samHeight !== height) throw new Error(VIDEO_SEED_UNSUPPORTED);
  if (!box || ![box.left, box.top, box.right, box.bottom].every(Number.isSafeInteger) ||
      box.left < 0 || box.top < 0 || box.right > width || box.bottom > height ||
      box.right <= box.left || box.bottom <= box.top) throw new Error(VIDEO_SEED_NO_MATCH);
  // Parser boxes are half-open; the SAM wire uses inclusive x2/y2. Never trim the mask.
  const text = `<${frameIndex}f>1<|box;x1=${box.left};y1=${box.top};x2=${box.right - 1};y2=${box.bottom - 1};w=${width};h=${height}|>`;
  return { text, objectId: '1', frameIndex, frames, width, height, samOffset: 0, box: { ...box }, propagation: 'forward' };
}
