// SAM image object prompts use frame 0 and a request-local STRING identity.
// Input protocol: meta-models/meta-sam@40318970/protocol/sam3.md.
export const IMAGE_BOX_INVALID = "Draw a box inside the displayed video frame.";
export const IMAGE_FRAME_CHANGED = "The displayed frame dimensions changed. Reload the clip before selecting a box.";

function requireSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      !Number.isSafeInteger(width * height)) throw new Error(IMAGE_BOX_INVALID);
}

export function requireImageBox(box, width, height) {
  requireSize(width, height);
  if (!box || !['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(box[key])) ||
      box.left < 0 || box.top < 0 || box.right > width || box.bottom > height ||
      box.right <= box.left || box.bottom <= box.top) throw new Error(IMAGE_BOX_INVALID);
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

// Public preview coordinates are normalized extents. Preserve every touched
// source pixel; the canonical integer box, not client floats, is cache identity.
export function imageBoxPixels(box, width, height) {
  requireSize(width, height);
  if (!box || !['left', 'top', 'right', 'bottom'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key])) ||
      box.left < 0 || box.top < 0 || box.right > 1 || box.bottom > 1 ||
      box.right <= box.left || box.bottom <= box.top) throw new Error(IMAGE_BOX_INVALID);
  return requireImageBox({ left: Math.floor(box.left * width), top: Math.floor(box.top * height),
    right: Math.ceil(box.right * width), bottom: Math.ceil(box.bottom * height) }, width, height);
}

export function makeImageBoxSeed({ box, width, height }) {
  const b = requireImageBox(box, width, height);
  return { objectId: '1', text: `<0f>1<|box;x1=${b.left};y1=${b.top};x2=${b.right - 1};y2=${b.bottom - 1};w=${width};h=${height}|>` };
}
