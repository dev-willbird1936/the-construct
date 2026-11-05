import { parseImageStream, parseVideoStream, recordsOfKind } from '@meta-sam/parser';

const unavailable = () => Object.assign(
  new Error('The segmentation service is temporarily unavailable. Try again in a minute.'),
  { retryable: true },
);

// Shared completion evidence: an early EOF or malformed result is not an empty scene.
export function requireCompleteSamResult(result) {
  if (result.outcome?.status !== 'completed' || !Array.isArray(result.diagnostics) || result.diagnostics.length) {
    throw unavailable();
  }
  return result;
}

export async function parseTrackedVideo(events, onSnapshot) {
  const parsed = parseVideoStream(events);
  if (onSnapshot) for await (const snapshot of parsed) onSnapshot(snapshot); // cumulative; lets a page watch frames arrive
  const result = requireCompleteSamResult(await parsed.finalResult);
  const boxes = recordsOfKind(result.records, 'box');
  const masks = recordsOfKind(result.records, 'mask');
  if (boxes.length + masks.length !== result.records.length || boxes.length !== masks.length) throw unavailable();
  return result;
}

function imageHits(result, concept) {
  const boxes = recordsOfKind(result.records, 'box');
  const masks = recordsOfKind(result.records, 'mask');
  if (boxes.length + masks.length !== result.records.length || boxes.length !== masks.length ||
      new Set(boxes.map(b => b.objectId)).size !== boxes.length ||
      new Set(masks.map(m => m.objectId)).size !== masks.length ||
      masks.some(mask => !boxes.some(box => box.objectId === mask.objectId))) {
    throw unavailable();
  }
  return masks.map(mask => ({ concept, box: boxes.find(box => box.objectId === mask.objectId), mask }));
}

// A completed, diagnostic-free empty image remains a legitimate empty result.
export async function parseConceptImage(events, concept) {
  return imageHits(requireCompleteSamResult(await parseImageStream(events).finalResult), concept);
}

export const BOX_SELECTION_NO_MATCH = "SAM did not return the boxed object. Draw a clearer box and try again.";

export async function parseBoxImage(events, width, height) {
  const result = requireCompleteSamResult(await parseImageStream(events).finalResult);
  const hits = imageHits(result, 'selected object');
  if (!hits.length) return hits;
  const boxes = typeof result.rawOutput === 'string' ? [...result.rawOutput.matchAll(/<\|box;([^|]*)\|>/g)] : [];
  const dimensions = boxes.length === 1 ? Object.fromEntries(boxes[0][1].split(';').map(field => field.split('='))) : {};
  if (hits.length !== 1 || hits[0].box.objectId !== '1' || hits[0].mask.objectId !== '1' ||
      Number(dimensions.w) !== width || Number(dimensions.h) !== height ||
      hits[0].box.left < 0 || hits[0].box.top < 0 || hits[0].box.right > width || hits[0].box.bottom > height) {
    throw new Error(BOX_SELECTION_NO_MATCH);
  }
  return hits;
}
