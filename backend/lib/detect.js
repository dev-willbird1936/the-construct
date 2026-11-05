import sharp from "sharp";
import { parseConceptImage, parseBoxImage } from "./sam-image-result.mjs";
import { makeImageBoxSeed, IMAGE_FRAME_CHANGED } from "./sam-image-seed.mjs";
import { client } from "./meta.js";
import { cancelledError, isCancelError, sleepAbortable, throwIfCancelled } from "./cancel.js";
import { CANDIDATE_CONCEPTS, DETECT_CONCURRENCY } from "./vocab.js";
import { upscaleMask, maskIoU, maskArea } from "./compose.js";

const DEDUPE_IOU = 0.85;
const DETECT_RETRY_PASSES = Number(process.env.DETECT_RETRY_PASSES ?? 2);
const DETECT_PASS_PAUSE_MS = Number(process.env.DETECT_PASS_PAUSE_MS ?? 8000);
// Wall-clock budget for the whole sweep: an HTTP request must not hang through a Meta burst. When it runs out, the
// unfinished concepts count as failed and the caller reports "temporarily unavailable" so the user can retry.
const DETECT_BUDGET_MS = Number(process.env.DETECT_BUDGET_MS ?? 110_000);

export async function segmentImageConcept(concept, dataUrl, { signal } = {}) {
  const events = await client.responses.create({
    model: "sam-3.1",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: concept },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
    stream: true,
  }, signal ? { signal } : undefined);
  return parseConceptImage(events, concept);
}

/** union (0/255) of every instance of one concept in a still image, at the image's own size */
export async function conceptMask(pngBuffer, width, height, concept) {
  const hits = await segmentImageConcept(concept, `data:image/png;base64,${pngBuffer.toString("base64")}`);
  const out = new Uint8Array(width * height);
  for (const hit of hits) {
    const mask = upscaleMask(hit.mask, width, height);
    for (let p = 0; p < out.length; p += 1) if (mask[p]) out[p] = 255;
  }
  return out;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

// Runs the fixed vocabulary (plus any extra free-text concepts) against one still
// frame, merges + deduplicates hits across concepts, and builds a single
// largest-first-painted index-map raster so the frontend can hit-test hover/click
// against one small image instead of per-object polygon math.
export async function detectObjects(framePngBuffer, frameWidth, frameHeight, extraConcepts = [], baseConcepts = CANDIDATE_CONCEPTS, { _segment = segmentImageConcept, signal } = {}) {
  const dataUrl = `data:image/png;base64,${framePngBuffer.toString("base64")}`;
  const concepts = [...baseConcepts, ...extraConcepts];

  // Meta's serving fails in bursts of minutes: concepts whose call still failed after the client's own retries get
  // two more passes after a pause, so one bad burst does not silently turn into "no objects".
  // Shutdown cancels instead of retrying: the sweep checks the signal
  // before each pass, forwards it to every segment call (the SDK aborts
  // in-flight requests), and converts an abort into the cancellation error
  // (never a null that would read as an outage and trigger a retry).
  const deadline = Date.now() + DETECT_BUDGET_MS;
  let exhausted = false;
  const timeLeft = () => exhausted ? 0 : Math.max(0, deadline - Date.now());
  const sweep = (list) => mapWithConcurrency(list, DETECT_CONCURRENCY, (concept) => {
    throwIfCancelled(signal);
    if (!timeLeft()) return [concept, null];
    const controller = new AbortController();
    let timer, onAbort, expired = false;
    const deadlineResult = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        exhausted = true;
        expired = true;
        controller.abort();
        resolve([concept, null]);
      }, timeLeft());
      onAbort = () => { controller.abort(); reject(cancelledError()); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const request = Promise.resolve().then(() => {
      throwIfCancelled(controller.signal);
      return _segment(concept, dataUrl, { signal: controller.signal });
    }).then(
      hits => [concept, hits],
      error => {
        if (expired) return [concept, null];
        if (isCancelError(error) || signal?.aborted) throw cancelledError();
        return [concept, null];
      },
    );
    return Promise.race([request, deadlineResult]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
  const byConcept = new Map(await sweep(concepts));
  for (let pass = 1; pass <= DETECT_RETRY_PASSES && [...byConcept.values()].includes(null) && timeLeft() > DETECT_PASS_PAUSE_MS * pass; pass += 1) {
    await sleepAbortable(DETECT_PASS_PAUSE_MS * pass, signal);
    for (const [concept, hits] of await sweep([...byConcept].filter(([, v]) => v === null).map(([c]) => c))) byConcept.set(concept, hits);
  }
  throwIfCancelled(signal);
  const failed = [...byConcept.values()].filter((v) => v === null).length;
  const perConcept = concepts.map((c) => byConcept.get(c) ?? []);
  // Failed calls with nothing found is an outage, not an empty picture: say so instead of caching "0 objects".
  if (failed > 0 && !perConcept.some((hits) => hits.length)) {
    throw Object.assign(new Error("The segmentation service is temporarily unavailable. Try again in a minute."), { retryable: true });
  }

  // rank = position in the concept list: Spark's subject names come before the broad fallbacks, so when two concepts
  // find the same mask the label is the more specific one ("cougar", not "animal").
  const candidates = perConcept.flatMap((hits, rank) => hits.map((hit) => {
    const mask = upscaleMask(hit.mask, frameWidth, frameHeight);
    return {
      concept: hit.concept,
      rank,
      box: hit.box,
      mask,
      area: maskArea(mask),
    };
  }));
  candidates.sort((a, b) => b.area - a.area);

  const accepted = [];
  for (const candidate of candidates) {
    const twin = accepted.find((kept) => maskIoU(kept.mask, candidate.mask) >= DEDUPE_IOU);
    if (!twin) accepted.push(candidate);
    else if (candidate.rank < twin.rank) {
      twin.concept = candidate.concept;
      twin.rank = candidate.rank;
    }
  }

  return detectionResult(accepted, frameWidth, frameHeight);
}

async function detectionResult(accepted, frameWidth, frameHeight) {
  const indexMap = new Uint8Array(frameWidth * frameHeight);
  accepted.forEach((candidate, order) => {
    const id = order + 1; // 0 stays "no object"
    for (let i = 0; i < candidate.mask.length; i += 1) {
      if (candidate.mask[i]) indexMap[i] = id;
    }
  });

  const indexMapPng = await sharp(Buffer.from(indexMap), {
    raw: { width: frameWidth, height: frameHeight, channels: 1 },
  })
    .png()
    .toBuffer();

  const objects = accepted.map((candidate, order) => ({
    id: order + 1,
    label: candidate.concept,
    box: {
      left: candidate.box.left / frameWidth,
      top: candidate.box.top / frameHeight,
      right: candidate.box.right / frameWidth,
      bottom: candidate.box.bottom / frameHeight,
    },
  }));

  return {
    frameWidth,
    frameHeight,
    objects,
    indexMapPngBase64: indexMapPng.toString("base64"),
    // Kept out of the JSON response; cached server-side for /api/generate matching.
    _internal: { accepted },
  };
}

// An explicit user box is one image attempt, never a semantic sweep or a
// silent retry. Empty completed output remains empty, not a fabricated mask.
export async function detectBox(framePngBuffer, frameWidth, frameHeight, box, { signal, onRequest } = {}) {
  throwIfCancelled(signal);
  const seed = makeImageBoxSeed({ box, width: frameWidth, height: frameHeight });
  const raster = await sharp(framePngBuffer).metadata();
  if (raster.width !== frameWidth || raster.height !== frameHeight) {
    throw new Error(IMAGE_FRAME_CHANGED);
  }
  throwIfCancelled(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  // Keep the original 65s request cap through stream consumption, not just headers.
  const timer = setTimeout(abort, 65_000);
  try {
    throwIfCancelled(controller.signal);
    onRequest?.();
    const events = await client.responses.create({
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: seed.text },
        { type: "input_image", image_url: `data:image/png;base64,${framePngBuffer.toString("base64")}` },
      ] }],
      stream: true,
    }, { signal: controller.signal, maxRetries: 0, timeout: 65_000 });
    const hits = await parseBoxImage(events, frameWidth, frameHeight);
    throwIfCancelled(signal);
    return await detectionResult(hits.map(hit => {
      const mask = upscaleMask(hit.mask, frameWidth, frameHeight);
      return { concept: hit.concept, box: hit.box, mask, area: maskArea(mask) };
    }).filter(hit => hit.area > 0), frameWidth, frameHeight);
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    if (controller.signal.aborted) throw Object.assign(new Error("The segmentation service is temporarily unavailable. Try again in a minute."), { retryable: true });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
