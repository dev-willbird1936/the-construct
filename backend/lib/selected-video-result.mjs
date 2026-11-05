import { recordsOfKind } from '@meta-sam/parser';
import { upscaleMask, maskIoU } from './compose.js';
import { VIDEO_SEED_NO_MATCH, VIDEO_SEED_AMBIGUOUS } from './sam-video-seed.mjs';

export function requireSelectedMask(mask, width, height) {
  if (!(mask instanceof Uint8Array) || mask.length !== width * height || !mask.some(Boolean)) throw new Error(VIDEO_SEED_NO_MATCH);
}

// Shared by selected Lite generation and Basic's native tracker. Parser 0.0.12
// drops wire w/h from records, so size declarations must be checked in rawOutput.
export function selectedVideoCandidates(result, seed, chosenMask) {
  const { width, height, frameIndex, frames, objectId } = seed;
  requireSelectedMask(chosenMask, width, height);
  const masks = recordsOfKind(result.records, 'mask');
  const boxes = recordsOfKind(result.records, 'box');
  if ([...boxes, ...masks].some(r => r.objectId !== objectId || !Number.isSafeInteger(r.frame?.frameIndex) || r.frame.frameIndex < frameIndex || r.frame.frameIndex >= frames)) throw new Error(VIDEO_SEED_AMBIGUOUS);
  if (typeof result.rawOutput !== 'string') throw new Error(VIDEO_SEED_NO_MATCH);
  const declarations = [...result.rawOutput.matchAll(/<\|box;([^|]*)\|>/g)];
  if (declarations.length !== boxes.length || declarations.some(([, fields]) => {
    const size = Object.fromEntries(fields.split(';').map(f => f.split('=')));
    return Number(size.w) !== width || Number(size.h) !== height;
  }) || boxes.some(b => b.left < 0 || b.top < 0 || b.right > width || b.bottom > height)) throw new Error(VIDEO_SEED_NO_MATCH);
  const byFrame = new Map();
  for (const mask of masks) {
    const index = mask.frame.frameIndex;
    const box = boxes.findLast(b => b.frame?.frameIndex === index && b.objectId === mask.objectId && ['left','top','right','bottom'].every(k => mask.bounds?.[k] === b[k]));
    if (!box) throw new Error(VIDEO_SEED_NO_MATCH);
    byFrame.set(index, [{ objectId, mask, box }]); // latest valid revision
  }
  const candidate = byFrame.get(frameIndex)?.[0];
  const a = seed.box, b = candidate?.box;
  const intersection = b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0;
  const boxScore = b ? intersection / ((a.right-a.left)*(a.bottom-a.top) + (b.right-b.left)*(b.bottom-b.top) - intersection) : 0;
  const shapeScore = candidate ? maskIoU(chosenMask, upscaleMask(candidate.mask, width, height)) : 0;
  if (!candidate || boxScore < .25 || shapeScore < .25) throw new Error(VIDEO_SEED_NO_MATCH);
  return { byFrame, best: { objectId, score: Math.min(boxScore, shapeScore), frameIndex } };
}
