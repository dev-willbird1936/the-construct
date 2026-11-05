#!/usr/bin/env node
// Basic tier ("Specimen") pipeline: CPU-only, one Node entry point.
//
// Usage:
//   node backend/pipeline/basic/run-basic.mjs <video> <outDir> --concept "<text>"
//     [--seed <sec>] [--seed-box "l,t,r,b"] [--object <id>] [--max-keyframes 40] [--max-seconds 12]
// --selected-source uses outDir/.selection/{seed.json,mask.png} (no path arguments).
// It bypasses legacy tracking/cache and uses validated native decode indices.
// --seed-box carries the immutable snapshot geometry (normalized 0..1) for an
// explicit selection; matching resolves the video track by box IoU near the
// seed sample (nearest ring first, ±1 s) and refuses on no-match/ambiguity (never longest
// fallback). Legacy auto-pick (longest covering track) applies only when no
// --seed-box is given. --object is ignored when --seed-box is present.
//     [--work-dir <path>] [--camera-override fixed] [--envelope-k <0.2-1>]
//     [--ghost-limit <0-1>] (QA ladder last rung; default 0.30, thin-blob share)
//     [--residue-limit <0-1>] (same rung; default 0.05, broad-residue share)
//     [--matte-dir <path>] (selected path only: precomputed rgba_kf_NNNNN.png mattes,
//      e.g. Advanced SAM+BiRefNet, used instead of the plate.py refine-alpha call)
//     [--matte birefnet] (selected path only, Advanced worker: GPU BiRefNet raw alphas via
//      BIREFNET_PYTHON + advanced/birefnet_infer.py, SAM-gated CPU combine via advanced_matte.py;
//      needs BIREFNET_PYTHON, BIREFNET_PACKAGE, BIREFNET_WEIGHTS, BIREFNET_WEIGHTS_SHA256)
//
// Writes specimen.json, plate.webp, subject.webp, depth.webp, thumb.webp,
// meta.json into <outDir> (work files under --work-dir, BASIC_WORK_DIR, or
// <outDir>/.work, in that precedence). Target <= 6 MB.
// Exit codes: 0 ok, 2 usage, 3 pipeline failure. Progress lines on stdout as
// `stage: <text>` (the platform integration contract).
//
// Disk rule: intermediates and temp live under the work dir (point it at
// scratch, e.g. BASIC_WORK_DIR=/tmp/the-construct/basic/<run>) and are
// deleted as soon as they are consumed; TMP/TEMP/TMPDIR are redirected to
// <work>/tmp for the child processes. Only small provenance JSONs survive.
//
// Meta calls go through META_BASE_URL (default http://127.0.0.1:8787/v1, the
// local credential-injecting proxy) with a dummy key in development. In
// production the default is empty, i.e. the real Meta API via META_API_KEY
// (same treatment as backend/app/config.js); without either, the generative
// plate step is skipped with a warning and the run continues on the
// non-generative fallback. This process never reads secrets from files.
// The Muse Image edit is patient: 404-model_not_found/429/503 with backoff
// (capped ~30 s) for up to BASIC_MUSE_PATIENCE_SEC (default 360) total, with
// a `stage:` progress line per retry; successful edits are cached in the
// work dir keyed by (seed frame, hole mask) so a retried job never re-pays.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { probeVideo } from "../../lib/ffmpeg.js";
import { SAMPLE_FPS, trackInstances } from "../../lib/track.js";
import { trackSelectedInstance } from "../../lib/track-selected.js";
import { readBasicSelection, probeBasicClock, BASIC_HANDOFF_TEXT, BASIC_CLOCK_TEXT, BASIC_MASK_TEXT } from "./lib/selected-source.mjs";
import {
  pickTrack,
  matchSeedBox,
  parseSeedBox,
  SEED_BOX_WINDOW_MAX,
  selectKeyframes,
  uniqueBySource,
  sampleToSourceFrame,
  sampleToTime,
  headNoun,
  pinSeedSample,
  trimEdgeRuns,
  edgeStats,
  trimTransitionRuns,
} from "./lib/keyframes.mjs";
import { atlasSize, cellRect, readNpyFloat32, resizePlane, requireDepthPlane } from "./lib/atlas.mjs";
import { snapDetails } from "./lib/keyframe-snap.mjs";
import { blurDetails } from "./lib/keyframe-blur.mjs";
import { saturationStats, neonGrade, applyGrade } from "./lib/grade.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
// Meta endpoint resolution (mirrors backend/app/config.js + backend/lib/meta.js):
// dev defaults to the local proxy; production defaults to empty, i.e. the
// real Meta API via META_API_KEY. Empty env falls back to the real API, and
// the dummy key is dev-only. Exported for unit tests.
export function resolveMetaConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const baseUrl = env.META_BASE_URL ?? (nodeEnv === "production" ? "" : "http://127.0.0.1:8787/v1");
  const apiKey = env.META_API_KEY || (nodeEnv === "production" ? "" : "via-meta-proxy");
  return { nodeEnv, baseUrl, apiKey, endpoint: baseUrl || "https://api.meta.ai/v1" };
}
const META = resolveMetaConfig();
const META_BASE_URL = META.baseUrl;
const META_ENDPOINT = META.endpoint;
// Work dir: --work-dir flag > BASIC_WORK_DIR env > <outDir>/.work. Exported
// for unit tests.
export function resolveWorkDir(outDir, opt) {
  return path.resolve(opt || process.env.BASIC_WORK_DIR || path.join(outDir, ".work"));
}
// Native jobs must not share the legacy BASIC_WORK_DIR scratch folder.
export function resolveSelectedWorkDir(outDir, opt) {
  return path.join(resolveWorkDir(outDir, opt), "selected-" + crypto.createHash("sha256").update(path.resolve(outDir)).digest("hex").slice(0, 24));
}
const MODELS_DIR = process.env.MODELS_DIR || path.join(here, "models");
const MODEL = path.join(MODELS_DIR, "depth-anything-v2-small.onnx");
const VENV_PY = process.env.BASIC_PYTHON || (
  os.platform() === "win32"
    ? path.join(here, ".venv", "Scripts", "python.exe")
    : path.join(here, ".venv", "bin", "python")
);
const TRACK_CONCEPT_MAX = 60;

const usage = () => `usage: run-basic.mjs <video> <outDir> --concept "<text>" [--seed <sec>] [--seed-box "l,t,r,b"] [--object <id>] [--max-keyframes 40] [--max-seconds 12] [--work-dir <path>] [--camera-override fixed] [--envelope-k <0.2-1>] [--ghost-limit <0-1>] [--residue-limit <0-1>]`;
const stage = (text) => console.log(`stage: ${text}`);
const warn = (text) => console.warn(`warn: ${text}`);
const timings = {};
async function timed(name, fn) {
  const t0 = Date.now();
  const out = await fn();
  timings[name] = (Date.now() - t0) / 1000;
  return out;
}
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(3);
}

// Remove a consumed intermediate; never fails the run. Returns true when
// something was actually deleted.
async function cleanPath(target, label) {
  try {
    await fsp.rm(target, { recursive: true, force: true });
    stage(`cleanup: removed ${label}`);
    return true;
  } catch (error) {
    warn(`cleanup: could not remove ${label}: ${error.message}`);
    return false;
  }
}

function parseArgs(argv) {
  const [video, outDir, ...rest] = argv;
  const opts = { seed: 1.0, object: null, objects: [], seedBox: null, seedSelection: false, maxKeyframes: 40, maxSeconds: 12, concept: null, workDir: null, cameraOverride: null, envelopeK: 1, ghostLimit: 0.30, residueLimit: 0.05 };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const take = () => rest[++i] ?? fail(`${usage()} (missing value for ${flag})`);
    if (flag === "--concept") opts.concept = take();
    else if (flag === "--seed") opts.seed = Number(take());
    else if (flag === "--selected-source") opts.seedSelection = true;
    else if (flag === "--seed-box") {
      // Immutable snapshot geometry (normalized l,t,r,b). Validated here;
      // never trust client-supplied pixels, never re-resolve a numeric id.
      try {
        opts.seedBox = parseSeedBox(take());
      } catch (error) {
        fail(`${usage()} (${error.message})`);
      }
    }
    else if (flag === "--object") {
      // Repeatable: each --object id joins the union subject. The app
      // contract (runner-basic.js) forwards concept only today; when it
      // forwards job.object_ids they land here, one flag each. Single
      // --object (or none) behaves exactly as before.
      const v = Number(take());
      if (!Number.isInteger(v) || v < 0 || v > 255) fail(`${usage()} (--object is an 8-bit label id)`);
      opts.objects.push(v);
    }
    else if (flag === "--max-keyframes") { opts.maxKeyframes = Number(take()); opts.maxKeyframesSet = true; }
    else if (flag === "--max-seconds") opts.maxSeconds = Number(take());
    else if (flag === "--work-dir") opts.workDir = take();
    else if (flag === "--matte-dir") opts.matteDir = path.resolve(take());
    else if (flag === "--matte") {
      const v = take();
      if (v !== "birefnet") fail(`${usage()} (only --matte birefnet is supported)`);
      opts.matte = v;
    }
    else if (flag === "--camera-override") {
      const v = take();
      if (v !== "fixed") fail(`${usage()} (only --camera-override fixed is supported)`);
      opts.cameraOverride = v;
    }
    else if (flag === "--envelope-k") {
      // Per-specimen default envelope cap (k-ladder pick): the viewer
      // searches k downward from here instead of from 1. Default 1.
      const v = Number(take());
      if (!Number.isFinite(v) || v < 0.2 || v > 1) fail(`${usage()} (--envelope-k in [0.2, 1])`);
      opts.envelopeK = v;
    }
    else if (flag === "--ghost-limit") {
      // QA ladder last rung: decline past this thin-blob share. Default 0.30.
      const v = Number(take());
      if (!Number.isFinite(v) || v < 0 || v > 1) fail(`${usage()} (--ghost-limit in [0, 1])`);
      opts.ghostLimit = v;
    }
    else if (flag === "--residue-limit") {
      // Same rung for the broad-residue share. Default 0.05: clean plates
      // measure 0.000, ghosted muse plates 0.28+.
      const v = Number(take());
      if (!Number.isFinite(v) || v < 0 || v > 1) fail(`${usage()} (--residue-limit in [0, 1])`);
      opts.residueLimit = v;
    }
    else fail(`${usage()} (unknown flag ${flag})`);
  }
  if (!video || !outDir || !opts.concept) fail(usage());
  if (opts.seedSelection && (opts.concept !== "selected object" || opts.seedBox || opts.objects.length)) fail(BASIC_HANDOFF_TEXT);
  if (opts.matteDir && !opts.seedSelection) fail(`${usage()} (--matte-dir needs --selected-source)`);
  if (opts.matte && (!opts.seedSelection || opts.matteDir)) fail(`${usage()} (--matte birefnet needs --selected-source and no --matte-dir)`);
  if (!Number.isFinite(opts.seed) || !Number.isFinite(opts.maxKeyframes) || !Number.isFinite(opts.maxSeconds)) fail(usage());
  opts.maxKeyframes = Math.max(6, Math.min(TRACK_CONCEPT_MAX, Math.round(opts.maxKeyframes)));
  return { video, outDir, opts };
}

async function proxyUsage() {
  if (!META_BASE_URL) return null; // production real-API path: no proxy caps to read
  try {
    const res = await fetch(META_BASE_URL.replace(/\/v1$/, "") + "/_usage");
    if (res.ok) return await res.json();
  } catch { /* proxy unreachable: downstream calls fail loudly */ }
  return null;
}

// Meta's API intermittently answers `404 The requested model was not found`
// for models that exist (observed Oct 24: ~3 in 4 calls failing in bursts,
// and a Railway production burst outlasting minutes). The shared client
// (backend/lib/meta.js resilientFetch) retries that 404, but this script's
// raw fetch calls bypass it — so the same handling lives here for POST
// /v1/images/edits: retry the transient 404, plus 429/503, with exponential
// backoff + jitter (capped ~30 s, Retry-After honoured but capped), for up
// to BASIC_MUSE_PATIENCE_SEC (default 360) total. The multipart form is
// rebuilt every attempt so the body is always fresh. Patience exhaustion is
// NOT fatal: the caller falls back to the non-generative plate — but the
// stats outbox records whether the Muse step was *unreachable* (exited on
// budget with every failure transient) so the final error can say so.
// A single 404 for anything else is returned immediately (never treated as
// "Muse Image unavailable"). Exported for unit tests.
const MODEL_404 = /model was not found|model_not_found/i;
const MAX_META_RETRIES = Number(process.env.META_MODEL_RETRIES || 1000);
const musePatienceSec = () => Number(process.env.BASIC_MUSE_PATIENCE_SEC || 360);
const metaSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function metaRetryDelay(attempt, retryAfterMs) {
  if (Number.isFinite(retryAfterMs)) return Math.min(Math.max(retryAfterMs, 0), 30_000);
  // Cap applies to the jittered total, not just the exponential base.
  return Math.min(30_000, Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random()));
}
function retryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  if (raw == null) return NaN;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at - Date.now() : NaN;
}
// Exact progress line the app shows while the Muse edit waits out a burst.
export function museWaitLine(n) {
  return `plate: waiting for Meta image model (${n})`;
}
export async function postImageEdit(url, {
  headers, buildForm, fetchImpl = fetch, sleepImpl = metaSleep,
  nowImpl = Date.now, maxRetries = MAX_META_RETRIES,
  patienceSec = musePatienceSec(), stats = null, onRetry = null,
} = {}) {
  const st = stats || {};
  st.attempts = 0; st.retries = 0; st.lastStatus = null;
  st.exhausted = false; st.unreachable = false;
  const t0 = nowImpl();
  const budgetMs = Math.max(0, patienceSec * 1000);
  const noteRetry = (n, label) => {
    st.retries += 1;
    if (onRetry) onRetry(n, label);
    else warn(`muse-image ${label}; retrying (attempt ${n})`);
  };
  for (let attempt = 0; ; attempt += 1) {
    st.attempts = attempt + 1;
    let response;
    try {
      response = await fetchImpl(url, { method: "POST", headers, body: buildForm() });
    } catch (error) {
      st.lastStatus = null;
      if (nowImpl() - t0 >= budgetMs || attempt >= maxRetries) {
        st.exhausted = true; st.unreachable = true;
        throw error;
      }
      noteRetry(attempt + 1, `request failed: ${error.message}`);
      await sleepImpl(Math.min(metaRetryDelay(attempt, NaN), Math.max(0, budgetMs - (nowImpl() - t0))));
      continue;
    }
    if (response.ok) {
      st.lastStatus = response.status;
      return response;
    }
    st.lastStatus = response.status;
    let transient = response.status === 429 || response.status === 503;
    let after = NaN;
    if (response.status === 404) {
      let text = "";
      try {
        text = await response.clone().text();
      } catch {
        try { text = await response.text(); } catch { text = ""; }
      }
      transient = MODEL_404.test(text);
    } else if (transient) {
      after = retryAfterMs(response);
    }
    if (!transient || nowImpl() - t0 >= budgetMs || attempt >= maxRetries) {
      if (transient) { st.exhausted = true; st.unreachable = true; }
      return response;
    }
    noteRetry(attempt + 1, `HTTP ${response.status}`);
    await sleepImpl(Math.min(metaRetryDelay(attempt, after), Math.max(0, budgetMs - (nowImpl() - t0))));
  }
}

function museCacheKey(seedBytes, maskBytes, concept, location, promptOverride = null) {
  const h = crypto.createHash("sha256");
  h.update(seedBytes); h.update(maskBytes);
  h.update(String(concept)); h.update(String(location));
  if (promptOverride) h.update(String(promptOverride));
  return h.digest("hex").slice(0, 32);
}

// Box path (tier-improve loop 9): a drawn box has no name ("selected
// object"), so a worded edit can erase the wrong animal (b8 deer-lake: Muse
// removed the fawn and kept the doe the visitor boxed). A marked edit paints
// the subject (its mask grown MARK_GROW_PX) flat magenta in the image sent
// and asks Muse to replace that shape: no name needed, nothing to confuse.
// Marked edits key their own cache entries (the image bytes differ).
export const MARK_GROW_PX = 6;
export function markedPromptFor(location, again = false) {
  return `This photo has a flat magenta shape ${location}. Replace only that magenta shape with the natural background that belongs behind it, ` +
    `continuing the surrounding ground, water, plants, lighting, focus blur and film grain at full photographic detail. ` +
    (again ? `Repaint every magenta pixel: no person, animal, silhouette, shadow or ghost may appear there. ` : "") +
    `Do not add any person, animal or object, and leave no magenta. ` +
    `Keep every other pixel identical, with the same size and aspect ratio as the input.`;
}
// JPEG of the seed frame with the mask (channel 0 > 0, grown by a square of
// `grow` px) painted magenta. Throws on an empty or unreadable mask.
export async function markSubject(seedPath, maskPath, grow = MARK_GROW_PX) {
  const { data, info } = await sharp(seedPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const m = await sharp(maskPath).extractChannel(0).resize(w, h, { fit: "fill", kernel: "nearest" }).raw().toBuffer();
  const hor = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const o = y * w;
    let n = 0;
    for (let x = 0; x < Math.min(w, grow); x += 1) if (m[o + x]) n += 1;
    for (let x = 0; x < w; x += 1) {
      if (x + grow < w && m[o + x + grow]) n += 1;
      if (x - grow - 1 >= 0 && m[o + x - grow - 1]) n -= 1;
      hor[o + x] = n > 0 ? 1 : 0;
    }
  }
  let px = 0;
  for (let x = 0; x < w; x += 1) {
    let n = 0;
    for (let y = 0; y < Math.min(h, grow); y += 1) if (hor[y * w + x]) n += 1;
    for (let y = 0; y < h; y += 1) {
      if (y + grow < h && hor[(y + grow) * w + x]) n += 1;
      if (y - grow - 1 >= 0 && hor[(y - grow - 1) * w + x]) n -= 1;
      if (n > 0) { const p = (y * w + x) * c; data[p] = 255; data[p + 1] = 0; data[p + 2] = 255; px += 1; }
    }
  }
  if (!px) throw new Error("empty mask");
  return sharp(data, { raw: { width: w, height: h, channels: c } }).jpeg({ quality: 95 }).toBuffer();
}

export async function museEditPlate(seedPath, seedMaskPath, seedW, seedH, concept, location, cacheDir, fetchOpts = {}, promptOverride = null, budget = null, { mark = false } = {}) {
  // NOTE: this endpoint does not accept a `mask` field (HTTP 400
  // `unsupported_parameter`), so the fill region is described in words,
  // or, with `mark`, painted into the image (markSubject above).
  // location is a short phrase like "in the centre-right of the frame".
  // Returns { ok:true, buffer, resized, cached } or { ok:false, unreachable }
  // where unreachable means the Muse step never answered (budget exhausted
  // with every failure a 404-model_not_found/429/503, or repeated network
  // errors) — as opposed to answering with an image the gates rejected.
  if (META.nodeEnv === "production" && !META.apiKey) {
    warn("muse-image skipped: production without META_API_KEY");
    return { ok: false, unreachable: false };
  }
  const t0 = Date.now();
  let seedBytes = await fsp.readFile(seedPath);
  if (mark) {
    try {
      seedBytes = await markSubject(seedPath, seedMaskPath);
    } catch (error) {
      warn(`muse-image: subject mark skipped (${String(error.message).slice(0, 80)}); worded edit`);
      mark = false;
    }
  }
  let maskBytes = Buffer.alloc(0);
  try { maskBytes = await fsp.readFile(seedMaskPath); } catch { /* mask only keys the cache */ }
  const cachePath = path.join(cacheDir, "muse-cache", `muse-${museCacheKey(seedBytes, maskBytes, concept, location, promptOverride)}.jpg`);
  try {
    const hit = await fsp.readFile(cachePath);
    const meta = await sharp(hit).metadata();
    const resized = meta.width !== seedW || meta.height !== seedH;
    const out = resized
      ? await sharp(hit).resize(seedW, seedH, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer()
      : hit;
    stage("plate: muse-image cache hit (no new spend)");
    return { ok: true, buffer: out, resized, cached: true };
  } catch { /* cache miss: spend one edit */ }
  // Cache hits return above untouched. Reserve here: a spent budget still
  // serves cache, and only a paid fetch can consume the last slot.
  if (budget && !budget.reserve()) return { ok: false, unreachable: false, exhausted: true };
  const prompt = promptOverride ?? (mark ? markedPromptFor(location) :
    `Remove the ${concept} from this video frame completely. It is located ${location}: ` +
    `fill that area with the exact surrounding background, continuing the visible ground texture, lighting direction, focus blur and film grain at full photorealistic detail. ` +
    `The filled area must be indistinguishable from a real photograph of that spot: NO blur, NO smear, NO ghost, silhouette or discoloration hinting at the removed animal, NO new objects, people, animals or text. ` +
    `Keep every other pixel pixel-identical, with the same size and aspect ratio as the input.`);
  const st = {};
  let res;
  try {
    res = await postImageEdit(`${META_ENDPOINT}/images/edits`, {
      headers: { authorization: `Bearer ${META.apiKey}` },
      buildForm: () => {
        const form = new FormData();
        form.append("model", "muse-image-1.0");
        form.append("image", new Blob([seedBytes], { type: "image/jpeg" }), "seed.jpg");
        form.append("response_format", "b64_json");
        form.append("prompt", prompt);
        return form;
      },
      stats: st,
      onRetry: (n) => stage(museWaitLine(n)),
      ...fetchOpts,
    });
  } catch (error) {
    warn(`muse-image request failed after retries: ${error.message}`);
    return { ok: false, unreachable: !!st.unreachable };
  }
  if (!res.ok) {
    warn(`muse-image HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { ok: false, unreachable: !!st.unreachable };
  }
  budget?.charge(); // the paid successful response; payload validity is judged below, already billed
  const json = await res.json().catch(() => null);
  const item = json?.data?.[0];
  let buf = null;
  if (item?.b64_json) buf = Buffer.from(item.b64_json, "base64");
  else if (item?.url) {
    try {
      buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
    } catch (error) {
      warn(`muse-image url fetch failed: ${error.message}`);
    }
  }
  if (!buf) {
    warn("muse-image returned no image payload");
    return { ok: false, unreachable: false };
  }
  let resized = false;
  let pipeline = sharp(buf);
  const meta = await pipeline.metadata();
  if (meta.width !== seedW || meta.height !== seedH) {
    pipeline = sharp(buf).resize(seedW, seedH, { fit: "fill" });
    resized = true;
  }
  const out = await pipeline.jpeg({ quality: 92 }).toBuffer();
  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, out);
  } catch (error) {
    warn(`muse-image cache write failed: ${error.message}`);
  }
  console.log(`muse-image plate: ${((Date.now() - t0) / 1000).toFixed(1)}s resized=${resized}`);
  return { ok: true, buffer: out, resized, cached: false };
}

// Booked image budget: at most IMAGE_BUDGET paid Muse Image responses per
// job across ALL candidate paths — one original plus at most one repair.
// Enforcement lives in the adapter AFTER the cache lookup: cache hits are
// always servable and never consume; charge() runs exactly once per paid
// (HTTP-ok) response, before payload validation, so billed-but-unusable
// responses are accounted and transient 404/429/503 stay uncharged. A
// refused reserve returns { ok:false, exhausted:true } without touching
// the network, so the caller routes to Lite instead of half-repairing.
export const IMAGE_BUDGET = 2;
export function createMuseBudget(limit = IMAGE_BUDGET) {
  let spent = 0;
  return {
    get spent() { return spent; },
    get left() { return Math.max(0, limit - spent); },
    // Checked by the adapter AFTER the cache lookup, so free cache hits
    // are always servable. charge() runs exactly once per paid response.
    reserve() { return spent < limit; },
    charge() { spent += 1; },
  };
}

// Single choke-point verdict for the ghost/residue ladder: over when the
// thin-blob share exceeds the ghost limit OR the broad-residue share
// exceeds the residue limit (default 0.05: clean plates measure 0.000 —
// roedeer median/hybrid, clip-b muse/after, synthetic clean — while ghosted
// muse plates measure 0.28-0.95; the limit sits 5x from both sides).
// Pure (unit tested); the pipeline measures real numbers and never writes
// zeros for unmeasured gates.
export function qaOverLimit(g, ghostLimit, residueLimit) {
  const numBad = (v) => typeof v !== "number" || !Number.isFinite(v);
  const shareBad = (v) => numBad(v) || v < 0 || v > 1;
  const malformed = (!g || typeof g !== "object") ? "missing gate output"
    : shareBad(g.medianGhostShare) ? `bad ghost share ${String(g.medianGhostShare)}`
    : shareBad(g.medianResidueShare) ? `bad residue share ${String(g.medianResidueShare)}`
    : numBad(ghostLimit) || ghostLimit < 0 || ghostLimit > 1 ? `bad ghost limit ${String(ghostLimit)}`
    : numBad(residueLimit) || residueLimit < 0 || residueLimit > 1 ? `bad residue limit ${String(residueLimit)}`
    : null;
  if (malformed) return { over: true, malformed, ghost: null, residue: null, limit: ghostLimit, residueLimit };
  const ghost = g.medianGhostShare;
  const residue = g.medianResidueShare;
  const over = ghost > ghostLimit || residue > residueLimit;
  return { over, ghost, residue, limit: ghostLimit, residueLimit };
}

// Refusal wording: outages stay retryable (model_not_found, no verdict),
// quality/budget failures route Lite and never pose as outages.
// Pure (unit tested); no gate-skip flags exist anywhere in this proof.
export function repairRefusal(kind, detail = "") {
  if (kind === "outage") {
    return `no clean plate (model_not_found: Muse Image unreachable, all attempts 404/429/503)${detail ? `: ${detail}` : ""}`;
  }
  if (kind === "budget") {
    return `no clean plate (booked image budget spent: 2 successful Muse edits per job, cache hits free)${detail ? `: ${detail}` : ""}; use Lite \u2014 Basic needs clean plates, Lite carries the cut-out`;
  }
  return `persistent background ghosts${detail ? ` (${detail})` : ""}; use Lite \u2014 Basic needs clean plates, Lite carries the cut-out`;
}

// Subject depth-cell window: the plate's 1-99% window, widened only as far
// as the subject's own 0.5-99.5% reaches past it. A subject inside the plate
// range keeps the plate mapping exactly (old viewers read it unchanged).
export function subjectDepthWindow(samples, plateMin, plateMax) {
  const vals = Float64Array.from(samples.filter(Number.isFinite)).sort();
  if (vals.length < 20) return { min: plateMin, max: plateMax };
  const lo = vals[Math.floor(vals.length * 0.005)];
  const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))];
  return { min: Math.min(plateMin, lo), max: Math.max(plateMax, hi) };
}

// Subject depth knee (loop 6): a close-up at the lens reads 6-12 plate
// spans nearer than the background (bobcat, blackbear), which put the
// billboard at the camera and the plate's edges in view. Depth up to half a
// span past the plate passes unchanged (grizzly 0.36, clip-b 0.06); beyond it
// compresses smoothly toward one span. Order-preserving, so relief survives.
export function depthKnee(plateMin, plateMax, a = 0.5, b = 0.5) {
  const span = plateMax - plateMin || 1;
  const A = a * span, B = b * span;
  return (v) => {
    if (v > plateMax + A) return plateMax + A + B * Math.tanh((v - plateMax - A) / B);
    if (v < plateMin - A) return plateMin - A - B * Math.tanh((plateMin - A - v) / B);
    return v;
  };
}

// Default keyframe budget for a clip span (seconds): ~6 poses a second,
// never under the old fixed 40, never over the atlas cap.
export const KEYFRAME_RATE = 6;
export function defaultMaxKeyframes(span, cap = 60) {
  const want = Math.round((Number.isFinite(span) ? span : 0) * KEYFRAME_RATE);
  return Math.max(40, Math.min(cap, want));
}

// Ghost/residue zone for the final ladder. A median ghost can only live in
// synthesized pixels. Seed-frame plates (seed-base Muse hybrid, mi-gan,
// inpaint) keep the real seed frame outside the fill claim, so the claim is
// measured there; measuring the whole sweep scored real texture as ghost
// (grizzly river: seed frame 0.85 thin-blob share, keyframes 0.75-0.86,
// claim 0.0). Median-based and full-render plates synthesize the sweep.
// Pure (unit tested).
export function ghostZoneKind({ method, blend, colorMatched } = {}) {
  if (method === "migan" || method === "inpaint") return "claim";
  if (colorMatched) return "sweep";
  if (method === "muse-image" && blend === "seed-base+muse-holes") return "claim";
  return "sweep";
}

// Non-generative fallback parity (PATH-PARITY-V1): the in-place gate only
// runs on the median-pass branch, so a median-fail run reaches the inpaint
// rung unassessed. The gate defers (verdict "defer", inplace false) when the
// median is a valid reference, so only an in-place regime with a non-accept
// verdict refuses the fallback. Pure (unit tested); a measured-clean plate
// still ships, and the gate spends no Meta budget (local cv2+numpy).
export function acceptFallbackPlate(gate) {
  if (!gate || typeof gate !== "object") return true;
  return !(gate.inplace && gate.verdict !== "accept");
}

// One booked repair of a residue-tripped plate: erase-ghost Muse edit of
// the bad plate itself, composited inside a generically expanded claim
// (motion-claim over cached masks; sweep union if motion is underivable),
// bit-exact outside the claim margin. Strict re-validation (scene + holes
// + scoped ghost/residue/edge + residue limit); anything red restores the
// pre-repair plate and refuses. Returns { ok:true, validation } or
// { ok:false, unreachable?, exhausted?, detail }. Deps-injected for tests.
export function repairPromptFor(concept, location) {
  return (
    `Remove every trace of the ${concept} from this video frame: any translucent ` +
    `human or animal shaped residue, pale smears, crescents or ghost outlines ${location}, ` +
    `plus any sheets, held objects or shadows that moved with it: ` +
    `fill those areas with the exact surrounding background, continuing the visible texture, ` +
    `lighting direction, focus blur and film grain at full photorealistic detail. ` +
    `The filled areas must be indistinguishable from a real photograph of that spot: NO blur, ` +
    `NO smear, NO ghost, silhouette or discoloration hinting at what was removed, ` +
    `NO new objects, people, animals or text. ` +
    `Keep every other pixel pixel-identical, with the same size and aspect ratio as the input.`);
}

export async function attemptPlateRepair(deps) {
  const { py, here, work, W, H, sweepPath, holesPath, kfDir, concept, location,
    plateRaw, plateMuse, museBudget, validatePlate, ghostLimit, residueLimit } = deps;
  const claimPath = path.join(work, "repair-claim.png");
  const prePath = path.join(work, "plate-pre-repair.jpg");
  const hybridPath = path.join(work, "plate-repair-hybrid.jpg");
  // Generic claim: motion-claim over the cached holes|sweep union. Falls
  // back to the sweep union itself when motion support is underivable.
  let claimInfo = null;
  try {
    let unionArg = [];
    if (fs.existsSync(holesPath) && fs.existsSync(sweepPath)) {
      const h = await sharp(holesPath).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
      const sw = await sharp(sweepPath).extractChannel(0).raw().toBuffer();
      const hw = h.info.width, hh = h.info.height;
      const uni = Buffer.alloc(hw * hh);
      for (let p = 0; p < hw * hh; p += 1) {
        const sx = Math.min(W - 1, Math.floor((p % hw) * W / hw));
        const sy = Math.min(H - 1, Math.floor(Math.floor(p / hw) * H / hh));
        uni[p] = (h.data[p] > 0 || sw[sy * W + sx] > 0) ? 255 : 0;
      }
      const unionPath = path.join(work, "repair-union.png");
      await sharp(uni, { raw: { width: hw, height: hh, channels: 1 } }).png().toFile(unionPath);
      unionArg = ["--union", unionPath];
    }
    const mcOut = await py([path.join(here, "plate.py"), "motion-claim",
      "--frames", kfDir, "--labels", kfDir, ...unionArg,
      "--out", claimPath, "--width", String(W)]);
    claimInfo = JSON.parse(mcOut.match(/\{[\s\S]*\}$/)[0]);
    claimInfo.source = "motion-claim";
  } catch (error) {
    warn(`repair claim: motion-claim failed (${String(error.message).slice(0, 120)}); using sweep union`);
    await fsp.copyFile(sweepPath, claimPath);
    claimInfo = { source: "sweep-union", basePx: 0, extPx: 0 };
  }
  await fsp.copyFile(plateRaw, prePath);
  const prompt = repairPromptFor(concept, location);
  const editPlate = deps.editPlate ?? museEditPlate;
  const got = await editPlate(plateRaw, claimPath, W, H, concept, location, work, {}, prompt, museBudget);
  if (!got?.ok) {
    return { ok: false, unreachable: !!got?.unreachable, exhausted: !!got?.exhausted, detail: got?.exhausted ? "booked image budget spent" : "edit unanswered" };
  }
  await fsp.writeFile(plateMuse, got.buffer);
  await py([path.join(here, "plate.py"), "composite", "--base", prePath,
    "--fill", plateMuse, "--mask", claimPath, "--grow", "11",
    "--feather", "2.0", "--match", "--exact-outside", "15", "--out", hybridPath]);
  await fsp.copyFile(hybridPath, plateRaw);
  const holesOk = await validatePlate(["--mask", claimPath, "--grow", "11"], "muse-repair");
  const ghostOut = await py([path.join(here, "plate.py"), "ghost-map",
    "--median", prePath, "--hybrid", plateRaw, "--mask", claimPath, "--grow", "11"]);
  const gh = JSON.parse(ghostOut.match(/\{[\s\S]*\}$/)[0]);
  const scopedOk = gh.outsideDiff <= 1.0
    && gh.hybridGhostShare <= gh.medianGhostShare
    && (gh.hybridResidueShare ?? 0) <= (gh.medianResidueShare ?? 0)
    && gh.hybridEdge <= gh.medianEdge * 1.1;
  const resOut = await py([path.join(here, "plate.py"), "ghost-map",
    "--median", plateRaw, "--mask", claimPath, "--grow", "11"]);
  const rs = JSON.parse(resOut.match(/\{[\s\S]*\}$/)[0]);
  const resVerdict = qaOverLimit(rs, ghostLimit, residueLimit);
  const validation = {
    museResized: got.resized, museCached: !!got.cached, blend: "plate-base+muse-repair",
    repair: {
      claim: claimInfo, spent: museBudget.spent, outsideDiff: gh.outsideDiff,
      ghostBefore: gh.medianGhostShare, ghostAfter: gh.hybridGhostShare,
      residueBefore: gh.medianResidueShare, residueAfter: gh.hybridResidueShare,
    },
  };
  if (holesOk && scopedOk && !resVerdict.over) {
    stage(`plate: repair accepted (residue ${gh.medianResidueShare}->${gh.hybridResidueShare}, outside ${gh.outsideDiff})`);
    return { ok: true, validation };
  }
  warn("plate repair rejected by strict gates; restoring pre-repair plate");
  await fsp.copyFile(prePath, plateRaw);
  return { ok: false, detail: `holes=${holesOk} scoped=${scopedOk} residue=${resVerdict.residue}/${resVerdict.residueLimit}` };
}

// Colour-bleed + decontamination: transparent texels hold BLACK, which
// bilinear resampling (cell resize) and GPU filtering smear into a dark
// halo on the outline. Diffuse nearby opaque RGB into transparent AND
// low-alpha edge pixels (union box only), so the feather zone samples
// subject colour instead of background: no dark sticker rim. Alpha
// untouched (the edge shape still comes from the mask + blur below).
export function bleedFill(rgba, W, H, box) {
  const [x0, y0, x1, y1] = box;
  const solid = (q) => rgba[q * 4 + 3] >= 128 || rgba[q * 4] + rgba[q * 4 + 1] + rgba[q * 4 + 2];
  for (let pass = 0; pass < 4; pass += 1) {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = y * W + x;
        if (rgba[p * 4 + 3] >= 128) continue;
        let r = 0, g = 0, b = 0, n = 0;
        if (x > 0) { const q = p - 1; if (solid(q)) { r += rgba[q * 4]; g += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; n += 1; } }
        if (x + 1 < W) { const q = p + 1; if (solid(q)) { r += rgba[q * 4]; g += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; n += 1; } }
        if (y > 0) { const q = p - W; if (solid(q)) { r += rgba[q * 4]; g += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; n += 1; } }
        if (y + 1 < H) { const q = p + W; if (solid(q)) { r += rgba[q * 4]; g += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; n += 1; } }
        if (n) { rgba[p * 4] = Math.round(r / n); rgba[p * 4 + 1] = Math.round(g / n); rgba[p * 4 + 2] = Math.round(b / n); }
      }
    }
  }
}
function boxBlurAlpha(alpha, w, h) {
  // one 3x3 box pass on the alpha channel: kills cut-out jaggies without
  // eroding thin legs the way a real feather would.
  const out = new Uint8Array(alpha);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += alpha[(y + dy) * w + x + dx];
      out[y * w + x] = Math.round(sum / 9);
    }
  }
  return out;
}

// Label rasters are single-channel ids, but libvips expands palette PNGs to
// RGB on load (track.js reads them back the same way): always take channel 0.
export async function maskStats(labelPath, trackId, w, h) {
  const raw = await sharp(labelPath).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const lab = raw.data;
  let n = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (lab[y * w + x] !== trackId) continue;
      n += 1; sx += x; sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { n, mask: lab, centroid: n ? [sx / n / w, sy / n / h] : null, box: n ? [x0, y0, x1, y1] : null };
}

// Union stats over several label ids in ONE raster read: same shape as
// maskStats but mask is a binary union (0/1) instead of the id raster.
// Single id behaves exactly like maskStats (minus the raw raster).
export async function maskStatsUnion(labelPath, ids, w, h) {
  const set = new Set(ids);
  const lab = await sharp(labelPath).extractChannel(0).raw().toBuffer();
  const umask = new Uint8Array(w * h);
  let n = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (!set.has(lab[p])) continue;
      umask[p] = 1;
      n += 1; sx += x; sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { n, mask: umask, centroid: n ? [sx / n / w, sy / n / h] : null, box: n ? [x0, y0, x1, y1] : null };
}

export function erodeAlpha(alpha, w, h) {
  // 1px binary erosion (3x3 min): pulls the opaque core back from the
  // mask edge so wall-coloured rim pixels leave the solid region. The
  // feather passes + decontaminating bleed below then repaint the ring
  // interior-side: edge position holds, fringe colour goes.
  const out = new Uint8Array(alpha);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      let m = 255;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) m = Math.min(m, alpha[(y + dy) * w + x + dx]);
      out[y * w + x] = m;
    }
  }
  return out;
}

async function main() {
  const { video, outDir, opts } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(video)) fail(`video not found: ${video}`);
  if (!fs.existsSync(MODEL)) fail(`depth weights missing: ${MODEL} (run fetch-models.mjs)`);
  if (!fs.existsSync(VENV_PY)) fail(`python venv missing: ${VENV_PY} (see requirements.txt)`);
  if (META.nodeEnv === "production" && !META.baseUrl && !META.apiKey) {
    fail("production needs META_API_KEY or META_BASE_URL (refusing to run blind)");
  }
  const work = opts.seedSelection ? resolveSelectedWorkDir(outDir, opts.workDir) : resolveWorkDir(outDir, opts.workDir);
  const kfDir = path.join(work, "kf");
  const depthDir = path.join(work, "depth");
  const fitDir = path.join(work, "fit");
  const tmpDir = path.join(work, "tmp");
  for (const dir of [outDir, work, kfDir, depthDir, fitDir, tmpDir]) await fsp.mkdir(dir, { recursive: true });
  // Keep every child process (ffmpeg, sharp/libvips, python) off C: when the
  // work dir points at scratch. execFile inherits this process's env.
  for (const v of ["TMPDIR", "TMP", "TEMP"]) process.env[v] = tmpDir;
  if (work !== path.join(outDir, ".work")) stage(`work dir: ${work}`);
  const py = (args) => run(VENV_PY, [args[0], ...args.slice(1)], { cwd: path.resolve(here, "..", "..", "..") }).then(
    (r) => (r.stdout + r.stderr).trim(),
    (error) => { throw new Error(`python ${args[0]} ${args[1]} failed: ${(error.stderr || error.message).slice(-600)}`); }
  );

  const info = await timed("probe", () => probeVideo(video));
  if (!info.width || !info.fps) fail("could not read video stream info");
  const span = Math.min(info.duration || opts.maxSeconds, opts.maxSeconds);
  // Pose rate: a fixed 40 keyframes stepped a 12 s clip at 3.3 Hz (night-
  // bear read as stop-motion). Default to ~KEYFRAME_RATE poses a second,
  // 40-60 keyframes; an explicit --max-keyframes still wins.
  if (!opts.maxKeyframesSet) opts.maxKeyframes = defaultMaxKeyframes(span, TRACK_CONCEPT_MAX);
  // Working long side 960 (brief range 960-1280): full-res SAM masks carry
  // the edges; 960 keeps DAV2/plate compute and atlas bytes in budget.
  const longSide = 960;
  const landscape = info.width >= info.height;
  const W = landscape ? longSide : Math.max(2, Math.round((info.width / info.height) * longSide / 2) * 2);
  const H = landscape ? Math.max(2, Math.round((info.height / info.width) * longSide / 2) * 2) : longSide;
  stage(`probe: ${info.width}x${info.height} ${info.fps.toFixed(1)}fps ${span.toFixed(1)}s -> working ${W}x${H}`);
  // Seeds beyond the pipeline's supported clip span fail clearly BEFORE any
  // SAM tracking spend when an explicit selection exists — never silently
  // match another time. Legacy auto-pick (no --seed-box) keeps its hint-only
  // seed behaviour below.
  if (opts.seedBox) {
    const spanSamples = Math.round(span * SAMPLE_FPS);
    const seedSampleEarly = Math.round(opts.seed * SAMPLE_FPS);
    if (!Number.isInteger(seedSampleEarly) || seedSampleEarly < 0 || seedSampleEarly >= spanSamples) {
      fail(`seed time ${opts.seed}s is beyond the Basic ${span.toFixed(1)}s window; pick a seed inside the opening window`);
    }
  }

  const selection = opts.seedSelection ? await readBasicSelection(outDir, video, info) : null;
  if (selection && selection.frames / selection.fps > opts.maxSeconds + 1e-6) fail(BASIC_CLOCK_TEXT);
  const selectedClock = selection ? await probeBasicClock(video, info.fps, selection.frames) : null;
  const sampleFps = selection ? info.fps : SAMPLE_FPS;
  const sourceIndex = s => selection ? s : sampleToSourceFrame(s, info.fps);
  const sampleTime = s => sampleToTime(s, sampleFps);
  const before = selection ? null : await proxyUsage();
  if (before) stage(`proxy usage before: ${JSON.stringify(before.counts)}`);

  // SAM video detection degrades badly below source resolution (44/45 vs 1/105
  // frames with masks on the same clip), so track full-res and downscale after.
  // Stage-level retry: the model-404 bursts can outlast the shared client's
  // retries (a failed pass throws). Chunk records are cached on disk, so a
  // retry resumes past completed chunks instead of re-spending.
  const trackDir = path.join(work, selection ? "selected-track" : "track");
  // Determinism: re-tracking changes the sweep and thus the plate (roedeer
  // ghost 0.02 -> 0.20 across rebuilds). Cache the track outputs keyed by
  // sha256(source clip, concept, span, keyframes, v) in the work dir and
  // reuse them, so retries and rebuilds are bit-identical. Refine/depth
  // downstream are deterministic given these labels. A model upgrade
  // bumps TRACK_CACHE_V.
  // Early Muse (tier-improve loop 7): the first plate edit only needs the
  // seed frame and a location phrase, both known from the selection, so it
  // starts now and overlaps SAM tracking (20-35 s) instead of waiting for
  // the keyframes. The plate ladder then uses the seed keyframe as its
  // generative seed. Skipped when the seed mask is large (a likely close-up:
  // those skip Muse); same budget, same cache. On by default after the fresh
  // A/B (basic/EXPERIMENTS.md #2b: the ladder's 11-18 s Muse wait went to 0);
  // BASIC_EARLY_MUSE=0 turns it off. Advanced's GPU worker also runs this
  // script (--matte / --matte-dir); it keeps its own plate seed unless it
  // opts in with BASIC_EARLY_MUSE=1 (not A/B'd on that lane).
  const earlyMuseOn = process.env.BASIC_EARLY_MUSE === "1" || (process.env.BASIC_EARLY_MUSE !== "0" && !opts.matte && !opts.matteDir);
  const museBudget = createMuseBudget(); // booked 2 successful edits/job, all paths
  const describeLocation = (cx, cy) => {
    const horiz = cx < 1 / 3 ? "left" : cx < 2 / 3 ? "centre" : "right";
    const vert = cy < 1 / 3 ? "upper" : cy < 2 / 3 ? "middle" : "lower";
    return `in the ${vert === "middle" && horiz === "centre" ? "centre" : `${vert}-${horiz}`} of the frame`;
  };
  let earlyMuse = null;
  let early = null; // { idx, share, cx, cy, kind }
  if (earlyMuseOn) {
    if (selection) {
      const sw = selection.width, sh = selection.height, m = selection.chosenMask;
      let n = 0, x0 = sw, y0 = sh, x1 = -1, y1 = -1;
      for (let p = 0; p < m.length; p += 1) {
        if (!m[p]) continue;
        n += 1;
        const x = p % sw, y = (p - x) / sw;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const share = n / Math.max(1, m.length);
      if (n && share <= 0.2) early = { idx: selection.seedFrameIndex, share, cx: (x0 + x1 + 1) / 2 / sw, cy: (y0 + y1 + 1) / 2 / sh, kind: "mask" };
    } else if (opts.seedBox && (!before || before.CAPS.images - before.counts.images > 0)) {
      // A "Find objects" click (the site default): its detect box over-covers
      // the mask 1.5-2.6x (bears 1.5-2, a seated man 2.6: box 0.32, mask
      // 0.12), so up to 0.45 of the frame stays under the 0.30 close-up rule
      // in practice; under 1% the ladder skips Muse.
      const b = opts.seedBox, share = (b.right - b.left) * (b.bottom - b.top);
      if (share > 0.01 && share <= 0.45) early = { idx: sourceIndex(Math.round(opts.seed * SAMPLE_FPS)), share, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2, kind: "box" };
    }
  }
  if (early) {
    const { idx, share } = early;
    const seedPath = path.join(work, "early-seed.jpg");
    const maskPath = path.join(work, "early-seed-mask.png");
    const where = describeLocation(early.cx, early.cy);
    const t0 = Date.now();
    earlyMuse = { srcIdx: idx, seedPath, where, promise: (async () => {
      // Same decode as the keyframe extract below (select + scale + q 2).
      // Never rejects: a local decode/mask error reads as a failed edit.
      try {
        await run(FFMPEG, ["-y", "-v", "error", "-i", video, "-vf", `select='eq(n\\,${idx})',scale=${W}:${H}`, "-vsync", "0", "-q:v", "2", "-frames:v", "1", seedPath]);
        // the mask only keys the Muse cache (the edit endpoint takes none)
        if (selection) await sharp(Buffer.from(Uint8Array.from(selection.chosenMask, (v) => (v ? 255 : 0))), { raw: { width: selection.width, height: selection.height, channels: 1 } }).resize(W, H, { kernel: "nearest" }).png().toFile(maskPath);
      } catch (error) {
        warn(`early Muse seed decode failed (${String(error.message).slice(0, 120)})`);
        return { ok: false, unreachable: false };
      }
      const got = await museEditPlate(seedPath, maskPath, W, H, opts.concept, where, work, {}, null, museBudget, { mark: !!selection });
      timings["muse-first-edit"] = (Date.now() - t0) / 1000;
      return got;
    })() };
    earlyMuse.promise.catch(() => {}); // observed where the plate ladder awaits it
    stage(`plate: first Muse edit requested at job start (seed frame ${idx}, ${early.kind} share ${share.toFixed(3)}, overlaps tracking)`);
  }

  let tracks = null;
  // Concept pass (a "Find objects" click, or an automatic job), cached per
  // concept. Loop 7: called a second time only for the head-noun retry when
  // the label's own pass matched nothing at the clicked box.
  const conceptTrack = async (concept, timing = "track") => {
    const TRACK_CACHE_V = 1;
    const trackKey = crypto.createHash("sha256")
      .update(await fsp.readFile(video)).update("\0").update(concept)
      .update(`\0${span.toFixed(3)}/${opts.maxKeyframes}/v${TRACK_CACHE_V}`)
      .digest("hex").slice(0, 16);
    const trackCacheDir = path.join(work, "track-cache", trackKey);
    stage(`track: cache key ${trackKey} (${fs.existsSync(trackCacheDir) ? "stored" : "empty"})`);
    try {
      const cached = JSON.parse(await fsp.readFile(path.join(trackCacheDir, "tracks.json"), "utf8"));
      if (!cached || !Array.isArray(cached.tracks)) throw new Error("bad cache");
      await fsp.rm(trackDir, { recursive: true, force: true });
      await fsp.cp(path.join(trackCacheDir, "track"), trackDir, { recursive: true });
      stage("track: cache hit (deterministic reuse; SAM skipped)");
      return cached;
    } catch {
      // miss: run SAM below
    }
    const got = await timed(timing, async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await trackInstances({
            videoPath: video, concept, outDir: trackDir,
            width: info.width, height: info.height, duration: info.duration, start: 0, seconds: span,
            onStage: (text) => stage(`track: ${text}`),
          });
        } catch (error) {
          if (attempt >= 3) throw error;
          const waitMs = Math.min(60_000, 5000 * 2 ** (attempt - 1));
          warn(`track: attempt ${attempt} failed (${String(error.message).slice(0, 120)}); retrying in ${waitMs / 1000}s`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    });
    // save the track outputs for deterministic rebuilds/retries
    await fsp.rm(trackCacheDir, { recursive: true, force: true });
    await fsp.mkdir(trackCacheDir, { recursive: true });
    await fsp.cp(trackDir, path.join(trackCacheDir, "track"), { recursive: true });
    await fsp.writeFile(path.join(trackCacheDir, "tracks.json"), JSON.stringify(got));
    return got;
  };
  if (selection) {
    tracks = await timed("track", () => trackSelectedInstance({ ...selection, videoPath: video, outDir: trackDir }));
  } else {
    tracks = await conceptTrack(opts.concept);
  }
  const seedSample = selection ? selection.seedFrameIndex : Math.round(opts.seed * SAMPLE_FPS);
  // Explicit selection: resolve the video track by snapshot geometry (box IoU
  // near the seed sample, nearest ring first out to ±SEED_BOX_WINDOW_MAX,
  // full-source label rasters).
  // Refuses on low-confidence/ambiguous/no-match — never longest fallback.
  // --object ids are ignored here (unrelated image/track namespace).
  // Legacy CLI auto-pick (longest covering track) applies only when no
  // --seed-box was requested. The track cache key above excludes --seed-box
  // (tracks are reused; matching runs after load).
  let track;
  let trackConcept = opts.concept; // the concept whose pass supplied the track
  if (selection) {
    track = tracks.tracks[0]; // strict native adapter validated the one requested identity
  } else if (opts.seedBox) {
    if (opts.objects.length) warn(`--seed-box given; ignoring --object id(s) ${opts.objects.join(",")}`);
    const matchClick = async () => {
      const boxCache = new Map(); // sample -> Map(trackId -> normalized box)
      const load = async (from, to) => { for (let s = Math.max(0, from); s <= to; s += 1) {
        if (boxCache.has(s)) continue;
        const file = path.join(trackDir, "labels", `l${String(s).padStart(5, "0")}.png`);
        const perId = new Map();
        try {
          const { data, info: rawInfo } = await sharp(file).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
          const Wl = rawInfo.width, Hl = rawInfo.height;
          const bounds = new Map(); // id -> [x0,y0,x1,y1]
          for (let y = 0; y < Hl; y += 1) {
            for (let x = 0; x < Wl; x += 1) {
              const id = data[y * Wl + x];
              if (!id) continue;
              const b = bounds.get(id) ?? [x, y, x, y];
              if (x < b[0]) b[0] = x;
              if (y < b[1]) b[1] = y;
              if (x > b[2]) b[2] = x;
              if (y > b[3]) b[3] = y;
              bounds.set(id, b);
            }
          }
          for (const [id, b] of bounds) {
            perId.set(Number(id), {
              left: b[0] / Wl, top: b[1] / Hl,
              right: Math.min(1, (b[2] + 1) / Wl), bottom: Math.min(1, (b[3] + 1) / Hl),
            });
          }
        } catch {
          // missing/unreadable raster in the window: treated as absent
        }
        boxCache.set(s, perId);
      } };
      await load(seedSample - SEED_BOX_WINDOW_MAX, seedSample + SEED_BOX_WINDOW_MAX);
      const getBox = (trackId, sample) => boxCache.get(sample)?.get(Number(trackId)) ?? null;
      try {
        return matchSeedBox(tracks.tracks, { seedBox: opts.seedBox, seedSample, getBox, window: SEED_BOX_WINDOW_MAX });
      } catch (error) {
        // Loop 12: nothing tracked within 1 s of the click (the pass started
        // late, e.g. a pick at the picker's default 0:00). Read the pass's
        // other masked samples and keep searching outward, nearest first,
        // with the stricter far IoU (keyframes.mjs: reach).
        const spans = tracks.tracks.filter((t) => Number.isInteger(t.first) && Number.isInteger(t.last));
        if (!/no match/.test(String(error?.message)) || !spans.length) throw error;
        const lo = Math.min(...spans.map((t) => t.first)), hi = Math.max(...spans.map((t) => t.last));
        const reach = Math.max(seedSample - lo, hi - seedSample);
        if (reach <= SEED_BOX_WINDOW_MAX) throw error;
        await load(lo, hi);
        const got = matchSeedBox(tracks.tracks, { seedBox: opts.seedBox, seedSample, getBox, window: SEED_BOX_WINDOW_MAX, reach });
        stage(`track: nothing tracked within 1 s of the clicked frame; the clicked box matched id=${got.id} at its nearest tracked frames`);
        return got;
      }
    };
    let matchError = null;
    try { track = await matchClick(); } catch (error) { matchError = error; }
    // Loop 7: a long detect label ("white mug with blue handle") can find
    // nothing in the video pass; one retry with its head noun ("mug"). The
    // clicked box still decides identity, and ambiguity never retries.
    const retry = !track && /no match/.test(String(matchError?.message)) ? headNoun(opts.concept) : null;
    if (retry) {
      stage(`track: "${opts.concept}" matched nothing at the clicked box; one retry as "${retry}"`);
      await fsp.rm(trackDir, { recursive: true, force: true });
      tracks = await conceptTrack(retry, "track-retry");
      try { track = await matchClick(); trackConcept = retry; } catch (error) { matchError = error; }
    }
    if (!track) fail(String(matchError?.message || "seed-box no match; re-pick the object"));
    stage(`track: seed-box matched id=${track.id} frames=${track.frames} (${track.first}-${track.last})`);
  } else {
    track = pickTrack(tracks.tracks, { objectId: opts.objects[0] ?? null, seedSample });
  }
  // Multi-instance union subject: all listed ids OR-ed into one subject
  // (one billboard, one sweep, one seed mask). track.id stays the primary
  // (seed/centroid anchor, back-compat record); unionIds drives every mask.
  // With --seed-box the union is the matched track alone (numeric --object
  // ids are ignored, never merged).
  const unionIds = selection || opts.seedBox ? [track.id] : [...new Set([track.id, ...opts.objects])];
  if (track.id > 255) fail(`track id ${track.id} exceeds 8-bit label range`);
  const unionSet = new Set(unionIds);
  if (unionIds.length > 1) stage(`track: union subject ids=${unionIds.join("+")}`);
  stage(`track: id=${track.id} frames=${track.frames} (${track.first}-${track.last})`);
  // which samples actually show the track (labels exist for every sample,
  // but the track may be absent)? read the label rasters.
  // Loop 11: the scene-transition scores (transition.py) need only the
  // labels and the video, so they run while the label loop below reads.
  const transitionJob = process.env.BASIC_TRANSITION_TRIM === "0" || track.last - track.first + 1 < 6 ? null : (async () => {
    const mapFile = path.join(work, "transition-map.json");
    const span = [];
    for (let s = track.first; s <= track.last; s += 1) span.push(s);
    await fsp.writeFile(mapFile, JSON.stringify(Object.fromEntries(span.map((s) => [s, sourceIndex(s)]))));
    return JSON.parse((await timed("transition", () => py([path.join(here, "transition.py"), "--video", video,
      "--labels", path.join(trackDir, "labels"), "--ids", unionIds.join(","), "--map", mapFile]))).match(/\{[\s\S]*\}$/)[0]);
  })().catch((error) => ({ error }));
  let present = [];
  const edgesBySample = new Map();
  {
    // Loop 11: four labels decode at once (sharp works off the main thread);
    // night-bear's 180 rasters took 1.6 s one by one, 0.7 s like this.
    const seen = new Map();
    let next = track.first;
    const reader = async () => {
      while (next <= track.last) {
        const s = next++;
        const label = path.join(trackDir, "labels", `l${String(s).padStart(5, "0")}.png`);
        if (!fs.existsSync(label)) continue;
        const { data: raw, info: labelInfo } = await sharp(label).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
        if (!unionIds.some((id) => raw.includes(id))) continue;
        seen.set(s, edgeStats(raw, labelInfo.width, labelInfo.height, unionIds));
      }
    };
    await Promise.all(Array.from({ length: 4 }, reader));
    for (let s = track.first; s <= track.last; s += 1) {
      if (!seen.has(s)) continue;
      present.push(s);
      edgesBySample.set(s, seen.get(s));
    }
  }
  if (!present.length) fail(`track ${track.id} has no visible samples`);
  const presentTotal = present.length; // both end trims cap against the whole clip
  // Loop 11: a clip cut from a compilation can open or close on a cross-
  // dissolve; there the subject is two shots laid over each other (see-
  // through body). transition.py scores how much of the whole background
  // changed per sample; end runs above the threshold are dropped. Bounded,
  // seed-safe, fail-soft (trimTransitionRuns).
  if (transitionJob) {
    const out = await transitionJob;
    if (out.error || !out.scores) warn(`keyframes: transition check skipped (${String(out.error?.message ?? "no scores").slice(0, 120)})`);
    else if (present.length >= 6) {
      const { kept, lead, trail } = trimTransitionRuns(present, out.scores, seedSample);
      if (lead || trail) {
        stage(`keyframes: dropped ${lead} leading / ${trail} trailing samples inside a scene transition (cross-dissolve)`);
        present = kept;
      }
    }
  }
  // Loop 10: a subject leaving (entering) the frame ends (starts) the clip
  // cut by the border; those poses only show a straight cut edge and a
  // half-body blur in the orbit. Loop 11: only a real exit/entry counts (the
  // border cuts a real part of the subject and it moves toward it or changes
  // size); a seated subject grazing a border keeps its samples. Bounded,
  // seed-safe (trimEdgeRuns).
  if (process.env.BASIC_EDGE_TRIM !== "0") {
    const { kept, lead, trail, vetoed } = trimEdgeRuns(present, edgesBySample, seedSample, { total: presentTotal });
    if (lead || trail) {
      stage(`keyframes: dropped ${lead} leading / ${trail} trailing samples cut by the frame edge (subject entering/leaving)`);
      present = kept;
    }
    for (const v of vetoed) stage(`keyframes: kept ${v.run} ${v.side === "lead" ? "leading" : "trailing"} samples touching a new border (not an exit: small contact or no motion toward it)`);
  }
  // Sources under the 15 fps sample rate (trail cams record 8-12 fps) map
  // several samples to one source frame; FFmpeg's select emits each frame
  // once, so duplicate picks failed the decode count (clip-a 10 fps: "decoded
  // 37 of 38"). Pick from distinct source frames, and dedupe again after
  // the snap passes below (a +-2 move can land on a twin).
  // Loop 7: the clicked frame stays a keyframe (pinSeedSample), so the seed
  // pose is the visitor's own and an early plate edit of it always applies.
  let samples = pinSeedSample(selectKeyframes(uniqueBySource(present, sourceIndex), opts.maxKeyframes), present, seedSample, sourceIndex);
  // Loop 11: the viewer morphs pose to pose, so the cadence matters more than
  // a sharper pick. The snap and blur passes moved picks AWAY from fast
  // motion, opening the widest gap exactly where the pose changes most (clip-b:
  // 0.4 s across a head turn, a doubled face mid-morph). A move may not open
  // a gap wider than the widest even-pick gap (times BASIC_KF_GAP_K), and a
  // drop not either (a blurred pose mid-turn beats a doubled body).
  const evenSpacing = samples.length > 1 ? (samples[samples.length - 1] - samples[0]) / (samples.length - 1) : 1;
  const gapK = Number(process.env.BASIC_KF_GAP_K || 1);
  const maxGap = Math.ceil(gapK * Math.ceil(evenSpacing - 1e-9));
  const gapLimits = process.env.BASIC_KF_MAX_GAP === "0" ? {} : { maxGap, maxDropGap: maxGap };
  // Loop 11: the local-motion scores (blur pass below) start now, beside the
  // sharpness snap, instead of after it: each sample's score depends only on
  // its own frames and label, so scoring every sample within +-4 of the even
  // picks covers any +-2 snap's +-2 neighbourhood, and the blur pass is fed
  // exactly the scores the serial order would have computed.
  const localJob = process.env.BASIC_BLUR_KF === "0" ? null : (async () => {
    const presentSet = new Set(present);
    const map = {};
    for (const s of samples) for (let d = -4; d <= 4; d += 1) if (presentSet.has(s + d)) map[s + d] = sourceIndex(s + d);
    const mapFile = path.join(work, "blur-map.json");
    await fsp.writeFile(mapFile, JSON.stringify(map));
    return JSON.parse((await py([path.join(here, "sharpness.py"), "--local", "--video", video, "--labels", path.join(trackDir, "labels"),
      "--ids", unionIds.join(","), "--map", mapFile])).match(/\{[\s\S]*\}$/)[0]);
  })().catch((error) => ({ error }));
  // Sharpness snap (Lane D): an even pick can land mid ear-flick/head-jerk
  // while a sample 1-2 steps away is sharp. Move a pick within +-2 samples
  // only on a >=1.15x Laplacian-variance gain inside the eroded subject
  // (ratio test, scale-free); the pick nearest the seed stays fixed, order
  // and uniqueness hold. Fail-soft: any error keeps the even picks.
  if (process.env.BASIC_SHARP_SNAP !== "0") {
    const presentSet = new Set(present);
    const seed0 = samples.reduce((best, s) => (Math.abs(s - seedSample) < Math.abs(best - seedSample) ? s : best), samples[0]);
    const map = {};
    for (const s of samples) for (let d = -2; d <= 2; d += 1) if (presentSet.has(s + d)) map[s + d] = sourceIndex(s + d);
    try {
      const mapFile = path.join(work, "sharp-map.json");
      await fsp.writeFile(mapFile, JSON.stringify(map));
      const out = JSON.parse((await py([path.join(here, "sharpness.py"), "--video", video, "--labels", path.join(trackDir, "labels"),
        "--ids", unionIds.join(","), "--map", mapFile])).match(/\{[\s\S]*\}$/)[0]);
      const { snapped, moves } = snapDetails(samples, present, out.scores, { radius: 2, keep: [seed0], maxGap: gapLimits.maxGap });
      if (moves.length) {
        samples = snapped;
        stage(`keyframes: sharpness snap moved ${moves.length} (${moves.map((m) => `${m.from}->${m.to} x${m.gain.toFixed(2)}`).join(", ")})`);
      }
    } catch (error) {
      warn(`keyframes: sharpness snap skipped (${String(error.message).slice(0, 120)})`);
    }
  }
  // Local-motion pass (Lane D blur-kf): whole-body sharpness misses a
  // smeared ear/head on a still body; Farneback p95 inside the subject does
  // not. Picks whose p95 exceeds 1.75x the median of the scored
  // neighbourhoods snap to a calm sample within +-2, else drop (never the
  // seed pick, never adjacent, <=5%: out of sample the flags on tripod
  // speakers were all crisp frames, so a false snap is harmless but a false
  // drop costs a pose; BLUR-VALIDATE). Fail-soft like the snap.
  if (localJob) {
    const presentSet = new Set(present);
    const seed0 = samples.reduce((best, s) => (Math.abs(s - seedSample) < Math.abs(best - seedSample) ? s : best), samples[0]);
    const wanted = new Set();
    for (const s of samples) for (let d = -2; d <= 2; d += 1) if (presentSet.has(s + d)) wanted.add(s + d);
    try {
      const out = await localJob;
      if (out.error) throw out.error;
      // the clip median in blurDetails is taken over exactly these samples
      const local = Object.fromEntries(Object.entries(out.scores).map(([k, v]) => [Number(k), v]).filter(([k]) => wanted.has(k)));
      // Out-of-sample check (BLUR-VALIDATE): on IR/greyscale footage every
      // flag was a false positive (sensor grain reads as flow), so skip it.
      const { kept, dropped, moves } = out.grayscale ? { kept: samples, dropped: [], moves: [] } : blurDetails(samples, present, local, { seed: seed0, radius: 2, maxDropFrac: 0.05, ...gapLimits });
      if (out.grayscale) stage("keyframes: motion-blur pass skipped (greyscale footage)");
      if (moves.length || dropped.length) {
        samples = kept;
        stage(`keyframes: motion-blur pass moved ${moves.length} (${moves.map((m) => `${m.from}->${m.to}`).join(", ")}), dropped ${dropped.length} (${dropped.join(", ")})`);
      }
    } catch (error) {
      warn(`keyframes: motion-blur pass skipped (${String(error.message).slice(0, 120)})`);
    }
  }
  {
    const before = samples.length;
    samples = uniqueBySource(samples, sourceIndex);
    if (samples.length < before) stage(`keyframes: ${before - samples.length} pick(s) shared a source frame (${info.fps.toFixed(1)} fps source); kept one each`);
  }
  const seedKey = samples.reduce((best, s) => (Math.abs(s - seedSample) < Math.abs(best - seedSample) ? s : best), samples[0]);
  stage(`keyframes: ${samples.length} samples, seed=${seedKey} (t=${sampleTime(seedKey).toFixed(2)}s)`);

  // Keyframe depth needs only the keyframe JPGs, so it runs in the
  // background while the masks are refined and the plate ladder below waits
  // on Muse (network, 10-20 s per edit). Loop 11: it starts as soon as FFmpeg
  // has written the JPGs instead of after the mask refine, sweep and camera
  // check (night-bear: its depth finished 2.5 s after the plate); a sample
  // the refine drops has its depth removed before the fit. The plate's own
  // depth follows once a plate ships. A failed job kills the child on exit;
  // an inference error surfaces where the depth stage awaits it.
  let kfDepth = null;
  const startKfDepth = (list) => {
    const t0 = Date.now();
    const inferDir = path.join(work, "infer-kf");
    let child = null;
    const kill = () => { try { child?.kill(); } catch { /* already gone */ } };
    process.once?.("exit", kill);
    const done = (async () => {
      await fsp.rm(inferDir, { recursive: true, force: true });
      await fsp.mkdir(inferDir, { recursive: true });
      for (const s of list) {
        const name = `kf_${String(s).padStart(5, "0")}.jpg`;
        await fsp.copyFile(path.join(kfDir, name), path.join(inferDir, name));
      }
      const pending = run(VENV_PY, [path.join(here, "depth.py"), "infer", "--model", MODEL, "--frames", inferDir, "--out", depthDir, "--size", "350"],
        { cwd: path.resolve(here, "..", "..", "..") });
      child = pending.child ?? null; // promisified execFile exposes the process
      const r = await pending.catch((error) => { throw new Error(`python depth.py infer failed: ${String(error.stderr || error.message).slice(-600)}`); });
      process.removeListener?.("exit", kill);
      return { out: `${r.stdout}${r.stderr}`.trim(), sec: (Date.now() - t0) / 1000 };
    })();
    done.catch(() => {}); // observed by the depth stage
    return { done };
  };

  // keyframes at working res, named by sample index so labels line up;
  // full-res copies ride along as the mask-refinement guides
  await timed("extract", async () => {
    await fsp.rm(kfDir, { recursive: true, force: true });
    await fsp.mkdir(kfDir, { recursive: true });
    const srcIdx = samples.map(sourceIndex);
    const select = srcIdx.map((i) => `eq(n\\,${i})`).join("+");
    const rawDir = path.join(kfDir, "raw");
    const fullDir = path.join(kfDir, "full");
    // Sequential FFmpeg names can overlap source indices (e.g. 37 of 40).
    // Stage separately so renaming cannot overwrite an unconsumed frame.
    const fullRawDir = path.join(kfDir, "full-raw");
    await fsp.mkdir(rawDir, { recursive: true });
    await fsp.mkdir(fullDir, { recursive: true });
    await fsp.mkdir(fullRawDir, { recursive: true });
    // -frames:v per output stops decoding at the last keyframe instead of
    // running the select filter to the end of a long upload.
    await run(FFMPEG, ["-y", "-v", "error", "-i", video,
      "-vf", `select='${select}',scale=${W}:${H}`, "-vsync", "0", "-q:v", "2", "-frames:v", String(samples.length), path.join(rawDir, "kf_%05d.jpg"),
      "-vf", `select='${select}'`, "-vsync", "0", "-q:v", "2", "-frames:v", String(samples.length), path.join(fullRawDir, "kf_%05d.jpg")]);
    const files = (await fsp.readdir(rawDir)).filter((f) => f.startsWith("kf_")).sort();
    const fullFiles = (await fsp.readdir(fullRawDir)).filter((f) => f.startsWith("kf_")).sort();
    if (files.length !== samples.length || fullFiles.length !== samples.length) fail(`decoded ${files.length}/${fullFiles.length} of ${samples.length} keyframes`);
    const pad5 = (s) => String(s).padStart(5, "0");
    // masks are refined against the full-res frame (guided filter snaps
    // the SAM raster to real edges) instead of a nearest downscale whose
    // steps stair-case thin features. Output stays a binary working mask.
    // normalize the label raster through sharp first: track labels may be
    // palette PNGs, which cv2 expands to color (ids unreadable) while
    // sharp's channel-0 read is the proven id reader (see maskStats).
    const jobs = [];
    for (const [i, s] of samples.entries()) {
      await fsp.rename(path.join(rawDir, files[i]), path.join(kfDir, `kf_${pad5(s)}.jpg`));
      await fsp.rename(path.join(fullRawDir, fullFiles[i]), path.join(fullDir, `kf_${pad5(s)}.jpg`));
    }
    kfDepth = startKfDepth(samples);
    for (const s of samples) {
      if (selection) {
        // Native selection never passes through guided refinement/erosion.
        // Working-raster nearest resampling remains explicitly lossy.
        await sharp(path.join(trackDir, "labels", `l${pad5(s)}.png`))
          .extractChannel(0).resize(W, H, { fit: "fill", kernel: "nearest" }).png()
          .toFile(path.join(kfDir, `kf_${pad5(s)}.png`));
        continue;
      }
      const cleanMask = path.join(kfDir, `lm_${pad5(s)}.png`);
      await sharp(path.join(trackDir, "labels", `l${pad5(s)}.png`)).extractChannel(0).toFile(cleanMask);
      // Refine every union id separately, then max-merge per sample: the kf
      // raster stays id-valued ({0} U ids).
      for (const gid of unionIds) {
        jobs.push({ s, gid, mask: cleanMask, guide: path.join(fullDir, `kf_${pad5(s)}.jpg`), id: String(gid), out: path.join(kfDir, `kr_${pad5(s)}_${gid}.png`) });
      }
    }
    if (jobs.length) {
      // One Python process for every (keyframe, id) refine (was one spawn
      // per job). Per-job failures still degrade to an empty mask; a failed
      // batch falls back to the per-job calls.
      let results = null;
      try {
        const jobsFile = path.join(kfDir, "refine-jobs.json");
        await fsp.writeFile(jobsFile, JSON.stringify(jobs.map(({ mask, guide, id, out }) => ({ mask, guide, id, out }))));
        results = JSON.parse((await py([path.join(here, "plate.py"), "refine-masks", "--jobs", jobsFile, "--w", String(W), "--h", String(H)])).match(/\{[\s\S]*\}$/)[0]).results;
        if (!Array.isArray(results) || results.length !== jobs.length) throw new Error(`refine-masks returned ${results?.length} of ${jobs.length}`);
      } catch (error) {
        warn(`refine batch failed (${String(error.message).slice(0, 120)}); refining per job`);
        results = [];
        for (const j of jobs) {
          try {
            results.push(JSON.parse((await py([path.join(here, "plate.py"), "refine-mask", "--mask", j.mask, "--guide", j.guide,
              "--id", j.id, "--w", String(W), "--h", String(H), "--out", j.out])).match(/\{[\s\S]*\}$/)[0]));
          } catch (e) { results.push({ error: String(e.message).slice(0, 200) }); }
        }
      }
      const bySample = new Map();
      for (const [k, j] of jobs.entries()) {
        const info = results[k];
        const st = bySample.get(j.s) ?? { merged: null, keptAny: false };
        bySample.set(j.s, st);
        try {
          if (info.error) throw new Error(info.error);
          st.keptAny = st.keptAny || info.kept > 0;
          if (!(info.kept > 0)) warn(`refine sample ${j.s} id ${j.gid}: kept=${info.kept} rawUniq=${JSON.stringify(info.rawUniq)} (mask present but unreadable)`);
          const buf = await sharp(j.out).extractChannel(0).raw().toBuffer();
          if (!st.merged) st.merged = Buffer.from(buf);
          else for (let p = 0; p < W * H; p += 1) if (buf[p] > st.merged[p]) st.merged[p] = buf[p];
        } catch (error) {
          warn(`refine sample ${j.s} id ${j.gid} failed (${String(error.message).slice(0, 80)}); treating as empty`);
        } finally {
          await fsp.rm(j.out, { force: true });
        }
      }
      for (const s of samples) {
        if (selection) continue;
        const st = bySample.get(s) ?? { merged: null, keptAny: false };
        await fsp.rm(path.join(kfDir, `lm_${pad5(s)}.png`), { force: true });
        await sharp(st.merged ?? Buffer.alloc(W * H), { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(kfDir, `kf_${pad5(s)}.png`));
        if (!st.keptAny) warn(`refine sample ${s}: no union id kept pixels`);
      }
      await fsp.rm(path.join(kfDir, "refine-jobs.json"), { force: true });
    }
  });
  // track/ labels are now downscaled copies in kf/: the full-res originals
  // (chunks mp4 + 100+ label rasters) are consumed.
  // Loop 11: except two. The first and last keyframes have one keyframe
  // neighbour each, so the occlusion fill also gets the nearest kept sample
  // beyond them (a label the keyframe pick passed over, e.g. a blurred one),
  // at most 3 samples out. Fresh grizzly: the splash-hidden belly falls on
  // the last keyframe. Fail-soft (that end is just not filled).
  const occOuter = [];
  for (const [end, dir] of samples.length >= 2 ? [[samples[0], -1], [samples[samples.length - 1], 1]] : []) {
    const beyond = present.filter((p) => (p - end) * dir > 0 && Math.abs(p - end) <= 3);
    if (!beyond.length) continue;
    const o = dir > 0 ? Math.min(...beyond) : Math.max(...beyond);
    const file = path.join(work, "occ-outer", `nb_${String(o).padStart(5, "0")}.png`);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await sharp(path.join(trackDir, "labels", `l${String(o).padStart(5, "0")}.png`))
        .extractChannel(0).resize(W, H, { fit: "fill", kernel: "nearest" }).png().toFile(file);
      occOuter.push({ end, sample: o, file });
    } catch (error) {
      warn(`occlusion: outer neighbour ${o} unreadable (${String(error.message).slice(0, 80)})`);
    }
  }
  if (!selection) await cleanPath(trackDir, "track/ (consumed by extract)");

  // per-keyframe mask stats + union crop box (tail keyframes whose mask is a
  // sliver can vanish in the downscale: drop them, don't fail)
  const frames = [];
  let union = null;
  for (const s of samples) {
    const st = await maskStatsUnion(path.join(kfDir, `kf_${String(s).padStart(5, "0")}.png`), unionIds, W, H);
    if (selection && !st.n) fail(BASIC_MASK_TEXT);
    if (!st.n) {
      warn(`dropping sample ${s}: empty mask after refine`);
      await fsp.rm(path.join(kfDir, `kf_${String(s).padStart(5, "0")}.jpg`), { force: true });
      await fsp.rm(path.join(kfDir, `kf_${String(s).padStart(5, "0")}.png`), { force: true });
      continue;
    }
    const [x0, y0, x1, y1] = st.box;
    union = union
      ? [Math.min(union[0], x0), Math.min(union[1], y0), Math.max(union[2], x1), Math.max(union[3], y1)]
      : [x0, y0, x1, y1];
    frames.push({ sample: s, t: sampleTime(s), src: sourceIndex(s), centroid: st.centroid, box: st.box, pixels: st.n });
  }
  // Precomputed mattes can reach past the SAM label box (BiRefNet keeps a CG
  // antenna 20px above it): grow the crop to each matte's alpha box so the
  // atlas never clips them. Fail closed on a missing or mis-sized matte.
  if (selection && opts.matte === "birefnet") {
    // Advanced: GPU raw alphas (owner worker env), then the SAM-gated CPU
    // combine. Both fail closed; the result feeds the --matte-dir path below.
    const env = Object.fromEntries(["BIREFNET_PYTHON", "BIREFNET_PACKAGE", "BIREFNET_WEIGHTS", "BIREFNET_WEIGHTS_SHA256"].map((k) => [k, process.env[k]]));
    const missing = Object.keys(env).filter((k) => !env[k]);
    if (missing.length) fail(`--matte birefnet needs ${missing.join(", ")}`);
    const rawDir = path.join(work, "birefnet-raw");
    opts.matteDir = path.join(work, "birefnet-rgba");
    await timed("birefnet-matte", async () => {
      await fsp.rm(rawDir, { recursive: true, force: true });
      await fsp.rm(opts.matteDir, { recursive: true, force: true });
      await run(env.BIREFNET_PYTHON, ["-I", "-B", path.join(here, "advanced", "birefnet_infer.py"), "--frames", kfDir, "--out", rawDir,
        "--weights", env.BIREFNET_WEIGHTS, "--weights-sha256", env.BIREFNET_WEIGHTS_SHA256, "--package", env.BIREFNET_PACKAGE],
        { cwd: work, timeout: 900000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
        .catch((error) => fail(`birefnet inference failed: ${String(error.stderr || error.message).slice(-600)}`));
      const out = await py([path.join(here, "advanced", "advanced_matte.py"), "--frames", kfDir, "--labels", kfDir, "--ids", unionIds.join(","), "--raw", rawDir, "--out", opts.matteDir]);
      const info = JSON.parse(String(out).match(/\{[\s\S]*\}\s*$/)[0]);
      if (info.frames !== frames.length) fail(`advanced matte returned ${info.frames} of ${frames.length} frames`);
      stage(`birefnet-matte: ${info.frames} frames (SAM-gated)`);
    });
  }
  if (selection && opts.matteDir) {
    for (const f of frames) {
      const name = `rgba_kf_${String(f.sample).padStart(5, "0")}.png`;
      if (!fs.existsSync(path.join(opts.matteDir, name))) fail(`--matte-dir lacks ${name}`);
      const a = await sharp(path.join(opts.matteDir, name)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
      if (a.info.width !== W || a.info.height !== H) fail(`matte ${name} is ${a.info.width}x${a.info.height}, expected ${W}x${H}`);
      for (let p = 0; p < W * H; p += 1) {
        if (!a.data[p]) continue;
        const x = p % W, y = (p - x) / W;
        union = [Math.min(union[0], x), Math.min(union[1], y), Math.max(union[2], x), Math.max(union[3], y)];
      }
    }
  }
  const pad = 6;
  // Sweep union: OR of every kept frame's subject mask (working res). The
  // median ghosts a moving subject across this whole path even where
  // witnesses stay >=3 (no holes); the sweep-hybrid candidate repaints it.
  // (kf/ still exists here; it is consumed later by atlases+thumb.)
  const sweepAcc = new Uint8Array(W * H);
  for (const f of frames) {
    const lab = await sharp(path.join(kfDir, `kf_${String(f.sample).padStart(5, "0")}.png`)).extractChannel(0).raw().toBuffer();
    for (let p = 0; p < W * H; p += 1) if (unionSet.has(lab[p])) sweepAcc[p] = 255;
  }
  let sweepN = 0;
  for (let p = 0; p < W * H; p += 1) if (sweepAcc[p]) sweepN += 1;
  const sweepShare = sweepN / (W * H);
  const sweepPath = path.join(work, "sweep.png");
  await sharp(Buffer.from(sweepAcc), { raw: { width: W, height: H, channels: 1 } }).png().toFile(sweepPath);
  stage(`sweep: union share ${sweepShare.toFixed(4)}`);
  if (!frames.length) fail(`track ${track.id} has no usable keyframe masks`);
  if (frames.length < 6) fail(`only ${frames.length} usable keyframes (need >= 6)`);
  let seedKeyUsed = seedKey;
  if (!frames.some((f) => f.sample === seedKey)) {
    seedKeyUsed = frames.reduce((best, f) =>
      (Math.abs(f.sample - seedKey) < Math.abs(best.sample - seedKey) ? f : best), frames[0]).sample;
    warn(`seed sample ${seedKey} dropped; using ${seedKeyUsed}`);
  }
  union = [Math.max(0, union[0] - pad), Math.max(0, union[1] - pad), Math.min(W - 1, union[2] + pad), Math.min(H - 1, union[3] + pad)];
  const cropW = union[2] - union[0] + 1;
  const cropH = union[3] - union[1] + 1;
  // Close-up routing (brief: fixed 0.30, no tuning): a subject filling over
  // ~30% of the frame belongs to Lite, not Basic. Measured post-refine.
  // (tier-improve 2026-11-04 tried the 75th percentile instead of the max:
  // the blackbear walk-in then shipped a ghosted plate, because a subject at
  // the lens also swings the trail cam's auto-exposure. Max kept.)
  const maxShare = Math.max(...frames.map((f) => f.pixels)) / (W * H);
  stage(`subject: max frame share ${maxShare.toFixed(3)}`);
  // Subject-touching-frame-border gate: a subject clipped by the LEFT,
  // RIGHT or TOP frame edge cannot orbit wide cleanly (lateral orbit
  // reveals past the cut, where no disocclusion cover exists). Narrow the
  // envelope to +-4 deg (cap 0.5) instead of routing Lite: the close-up
  // rule (>0.30) still owns true close-ups. BOTTOM cuts are exempt:
  // talking-head torsos leave frame downward, and the small vertical
  // slide only reveals plate (correct room) below the billboard edge.
  // Measured on the padded union box, in working px.
  let envelopeK = opts.envelopeK;
  {
    const edgeGap = Math.min(union[0], W - 1 - union[2], union[1]);
    if (edgeGap <= 2) {
      envelopeK = Math.min(envelopeK, 0.5);
      warn(`subject touches the frame edge (gap ${edgeGap}px, bottom exempt); envelope capped to +-4 deg`);
    }
  }
  // Night-IR tripwire (warn-only, best-effort): grey frame (night vision
  // is near-monochrome; daylight keeps colour spread even when dim).
  // Roedeer is the declined-IR example (spread 0.0); clip-b holds 12.8.
  // Mean bound excludes bright daylight; warn-only so fog costs a line.
  try {
    const stats = await sharp(path.join(kfDir, `kf_${String(seedKeyUsed).padStart(5, "0")}.jpg`)).stats();
    const means = stats.channels.map((c) => c.mean);
    const spread = Math.max(...means) - Math.min(...means);
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    if (spread < 10 && mean < 130) warn(`possible night-IR (grey frame: mean ${mean.toFixed(0)} colour-spread ${spread.toFixed(1)}); Basic claims daylight`);
  } catch { /* stats best-effort; never fail the build */ }
  // Loop 6: a close-up no longer refuses. Its plate skips the generated
  // ladder (no Muse spend: half-frame fills are inventions the gates cannot
  // judge, see blackbear above) and ships the soft fallback below.
  const closeUp = maxShare > 0.30;
  if (closeUp) stage(`subject: close-up (frame share ${maxShare.toFixed(2)} > 0.30): soft background, no generated plate`);

  const camJson = await timed("classify", () =>
    py([path.join(here, "plate.py"), "classify", "--frames", kfDir, "--labels", kfDir, "--out", path.join(work, "camera.json")])
  );
  const camInfo = JSON.parse(camJson.match(/\{[\s\S]*\}$/)[0]);
  let camera = camInfo.camera;
  let cameraOverride = false;
  // App-measured camera wins for claims: when the app measured fixed
  // (measureCamera) it passes --camera-override fixed, so the two can
  // never contradict each other in production. Recorded, not silent.
  if (opts.cameraOverride === "fixed" && camera !== "fixed") {
    cameraOverride = true;
    stage(`camera: ${camera} overridden to fixed (measured fixed upstream; classify said ${camInfo.kind || "moving"} pan=${camInfo.pan ?? "?"} scale=${camInfo.scale ?? "?"})`);
    camera = "fixed";
  }
  stage(`camera: ${camera}${camInfo.kind ? ` (${camInfo.kind} pan=${camInfo.pan} scale=${camInfo.scale})` : ""}`);
  // Moving-camera routing: Basic does not claim handheld/panning/dolly
  // sources (corpus scopes those lite-only). Fail before any Muse spend.
  if (camera !== "fixed") fail(`${camInfo.kind || "moving"} camera (pan ${camInfo.pan ?? "?"}, scale ${camInfo.scale ?? "?"}); use Lite — Basic handles fixed cameras only`);

  if (!kfDepth) fail("keyframe depth was not started");

  // plate: fixed -> median; moving -> Muse Image edit, validated, else inpaint
  // Plate candidates, cheapest first. EVERY candidate faces both gates:
  // scene fidelity (background identical to the seed frame) and hole texture
  // (the filled region must read as background, not a blurry ghost).
  // A visibly ghosted plate is never shipped: if nothing passes, exit 3.
  // The generative/inpaint seed is the smallest-mask keyframe (least to invent).
  const plateRaw = path.join(work, "plate-raw.jpg");
  let plateSeed = frames.reduce((a, b) => (b.pixels < a.pixels ? b : a), frames[0]);
  // Early Muse: its edit is of the seed frame, so that keyframe becomes the
  // generative seed (the smallest-mask pick is the fallback when the seed
  // keyframe was dropped, or for close-ups, which never use Muse).
  let earlyUsed = false;
  if (earlyMuse) {
    const f = closeUp ? null : frames.find((fr) => sourceIndex(fr.sample) === earlyMuse.srcIdx);
    if (f) {
      plateSeed = f;
      earlyUsed = true;
      const same = await Promise.all([fsp.readFile(earlyMuse.seedPath), fsp.readFile(path.join(kfDir, `kf_${String(f.sample).padStart(5, "0")}.jpg`))])
        .then(([a, b]) => a.equals(b), () => false);
      stage(`plate: early Muse edit adopted (seed keyframe ${f.sample}, decode ${same ? "identical" : "differs"})`);
    } else warn(`early Muse edit unused (${closeUp ? "close-up" : "seed keyframe dropped"}); its spend is not recovered`);
  }
  const plateSeedS = String(plateSeed.sample).padStart(5, "0");
  const seedKf = path.join(kfDir, `kf_${plateSeedS}.jpg`);
  const seedMask = path.join(kfDir, `kf_${plateSeedS}.png`);
  const holesPath = path.join(work, "holes.png");
  const plateAttempts = [];
  let plateMethod = null;
  const plateValidation = {};
  async function validatePlate(holesArgs, label) {
    const scene = JSON.parse((await py([path.join(here, "plate.py"), "validate", "--plate", plateRaw, "--seed", seedKf, "--mask", seedMask])).match(/\{[\s\S]*\}$/)[0]);
    const holes = JSON.parse((await py([path.join(here, "plate.py"), "validate-holes", "--plate", plateRaw, ...holesArgs])).match(/\{[\s\S]*\}$/)[0]);
    const entry = { label, scene, holes };
    plateAttempts.push(entry);
    Object.assign(plateValidation, { scene, holes });
    stage(`plate: ${label} scene pass=${scene.pass} (mean ${scene.mean?.toFixed?.(2)}, p95 ${scene.p95?.toFixed?.(1)}) holes pass=${holes.pass} (share ${holes.holeShare})`);
    return scene.pass && holes.pass;
  }
  const plateMedian = path.join(work, "plate-median.jpg");
  const plateMuse = path.join(work, "plate-muse.jpg");
  const plateHybrid = path.join(work, "plate-hybrid.jpg");
  // describe the hole's position for the mask-less edit endpoint
  // (museOutcome survives to the final failure block below)
  let museOutcome = null;
  // In-place subject whose median is proven contaminated and no clean
  // candidate shipped: the ghost ladder below measures the plate against
  // itself and reads 0 blobs, so this flag refuses instead.
  let inplaceUnresolved = false;
  // Loop 6: set when no clean plate can ship (close-up, still subject,
  // measured leftovers, nothing passed): the soft fallback ships instead of
  // a refusal, recorded as plate.fallback in specimen.json.
  let fallbackReason = closeUp ? "close-up" : null;
  let fallbackDetail = closeUp ? `frame share ${maxShare.toFixed(2)}` : "";
  const [bx0, by0, bx1, by1] = plateSeed.box;
  const bcx = (bx0 + bx1) / 2 / W, bcy = (by0 + by1) / 2 / H;
  const horiz = bcx < 1 / 3 ? "left" : bcx < 2 / 3 ? "centre" : "right";
  const vert = bcy < 1 / 3 ? "upper" : bcy < 2 / 3 ? "middle" : "lower";
  const location = `in the ${vert === "middle" && horiz === "centre" ? "centre" : `${vert}-${horiz}`} of the frame`;
  let museSeedPromise = null;
  const museSeedEdit = () => {
    if (!museSeedPromise && earlyUsed) museSeedPromise = earlyMuse.promise; // already in flight since job start
    if (!museSeedPromise) {
      const t0 = Date.now();
      museSeedPromise = museEditPlate(seedKf, seedMask, W, H, opts.concept, location, work, {}, null, museBudget, { mark: !!selection });
      // Full request time; "plate-muse" keeps only the ladder's wait on it.
      museSeedPromise.then(() => { timings["muse-first-edit"] = (Date.now() - t0) / 1000; }, () => {});
    }
    return museSeedPromise;
  };
  if (camera === "fixed") {
    // Both ladder branches ask Muse for the same first edit (seed frame +
    // seed mask) whenever the sweep is non-trivial (> 0.5% of the frame):
    // the median-pass branch for its sweep hybrid, the median-fail branch
    // for its inpaint. So it starts now and overlaps the median build and
    // its gates (5-10 s). One memoised promise: one paid edit, charged once.
    if (sweepShare > 0.005 && !closeUp) {
      const usageSpec = selection ? null : await proxyUsage();
      if (!usageSpec || usageSpec.CAPS.images - usageSpec.counts.images > 0) {
        museSeedEdit();
        stage("plate: first Muse edit requested (overlaps the median)");
      }
    }
    stage("plate: temporal median");
    await timed("plate", () =>
      py([path.join(here, "plate.py"), "median", "--frames", kfDir, "--labels", kfDir, "--out", plateRaw, "--meta", path.join(work, "plate-meta.json"), "--width", String(W), "--holes", holesPath])
    );
    await fsp.copyFile(plateRaw, plateMedian); // kept as hybrid base either way
    if (closeUp) stage("plate: close-up: generated plates skipped (soft fallback)");
    else if (await validatePlate(["--holes", holesPath], "median")) {
      plateMethod = "median";
      // Swept-area smear upgrade: a moving subject ghosts the median
      // across its whole path even when the gates pass — holes (witness<3)
      // AND smear (witness>=3 but inconsistent: snakes, ghost strips).
      // A median-base Muse hybrid repaints the sweep UNION (holes plus
      // every sweep pixel) with validated fill; shipped only with both
      // gates green on holes AND sweep plus strictly no-worse scene
      // fidelity, else the median stays. Gates themselves never move.
      const medianSceneMean = plateValidation.scene?.mean ?? Infinity;
      const medianHoleShare = plateValidation.holes?.holeShare ?? 0;
      if (medianHoleShare > 0.15 || sweepShare > 0.005) {
        const usageMH = selection ? null : await proxyUsage();
        const mhImagesLeft = usageMH ? usageMH.CAPS.images - usageMH.counts.images : 1;
        if (mhImagesLeft <= 0) {
          warn("median-hybrid skipped (images cap reached); keeping median");
        } else {
          stage("plate: median-hybrid attempt (sweep union)");
          const gotMH = await timed("plate-muse", () =>
            museSeedEdit());
          if (gotMH?.ok) {
            await fsp.writeFile(plateMuse, gotMH.buffer);
            plateValidation.museResized = gotMH.resized;
            plateValidation.museCached = !!gotMH.cached;
            const savedScene = plateValidation.scene, savedHoles = plateValidation.holes;
            // composite mask: holes OR sweep union (one raster, grown 11 +
            // feathered, ring-matched like before). NOTE: libvips expands
            // palette/gray PNGs to RGB on load (see maskStats), so read
            // channel 0 explicitly — a raw 3-channel read silently scans
            // only the first third of the frame and yields an empty mask.
            const sweepMaskPath = path.join(work, "sweep-mask.png");
            {
              const h = await sharp(holesPath).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
              const sw = await sharp(sweepPath).extractChannel(0).raw().toBuffer();
              const hw = h.info.width, hh = h.info.height;
              const out = Buffer.alloc(hw * hh);
              let maskNz = 0;
              for (let p = 0; p < hw * hh; p += 1) {
                const sx = Math.min(W - 1, Math.floor((p % hw) * W / hw));
                const sy = Math.min(H - 1, Math.floor(Math.floor(p / hw) * H / hh));
                const v = (h.data[p] > 0 || sw[sy * W + sx] > 0) ? 255 : 0;
                out[p] = v;
                if (v) maskNz += 1;
              }
              await sharp(out, { raw: { width: hw, height: hh, channels: 1 } }).png().toFile(sweepMaskPath);
              stage(`plate: sweep-mask ${maskNz} px over ${hw}x${hh}`);
              if (!maskNz) warn("median-hybrid: empty sweep mask; keeping median");
              else {
            await py([path.join(here, "plate.py"), "composite", "--base", plateMedian, "--fill", plateMuse, "--mask", sweepMaskPath, "--grow", "11", "--feather", "2.0", "--match", "--out", plateHybrid]);
            await fsp.copyFile(plateHybrid, plateRaw);
            plateValidation.blend = "median-base+muse-sweep";
            plateValidation.base = "median (sweep union)";
            // Both gates green (holes AND sweep suspect regions) plus the
            // SCOPED acceptance ruling (approved): (a) changes only inside
            // the grown claim mask (outside at noise floor), (b) ghost
            // metric inside non-inferior vs the median (ties pass: the
            // metric is blind to narrow strips, and (c) guards texture),
            // (c) no new HF object (edge energy within the median's range).
            // No global-mean comparison: it dilutes local fixes ~100:1.
            const holesOk = await validatePlate(["--holes", holesPath], "muse-image");
            const sweepOk = await validatePlate(["--mask", sweepPath, "--grow", "11"], "muse-image");
            const ghostOut = await py([path.join(here, "plate.py"), "ghost-map", "--median", plateMedian, "--hybrid", plateHybrid, "--mask", sweepMaskPath, "--grow", "11"]);
            const ghost = JSON.parse(ghostOut.match(/\{[\s\S]*\}$/)[0]);
            plateValidation.scoped = { mask: "sweep-union", outsideDiff: ghost.outsideDiff, medianGhost: ghost.medianGhostShare, hybridGhost: ghost.hybridGhostShare, medianEdge: ghost.medianEdge, hybridEdge: ghost.hybridEdge };
            const scopedOk = ghost.outsideDiff <= 1.0 && ghost.hybridGhostShare <= ghost.medianGhostShare && ghost.hybridEdge <= ghost.medianEdge * 1.1;
            stage(`plate: scoped ${scopedOk ? "PASS" : "FAIL"} (outside ${ghost.outsideDiff}, ghost ${ghost.medianGhostShare}->${ghost.hybridGhostShare}, edge ${ghost.medianEdge}->${ghost.hybridEdge})`);
            if (holesOk && sweepOk && scopedOk) {
              plateMethod = "muse-image";
              stage("plate: median-hybrid accepted (smear replaced)");
            } else {
              warn("median-hybrid rejected; keeping median");
              await fsp.copyFile(plateMedian, plateRaw);
              Object.assign(plateValidation, { scene: savedScene, holes: savedHoles });
              delete plateValidation.blend; delete plateValidation.base;
              delete plateValidation.museResized; delete plateValidation.museCached;
              delete plateValidation.scoped;
              } // end non-empty-mask else: composite + validate ran
            } // end mask block
            // QA ladder stage 3: holes-only Muse composite (narrower claim
            // than the sweep union; same cached render, same scoped
            // ruling). Only when the sweep union lost and holes alone are
            // significant: less Muse area can pass where the union failed.
            if (plateMethod === "median" && medianHoleShare > 0.15) {
              stage("plate: median-hybrid attempt (holes only)");
              await py([path.join(here, "plate.py"), "composite", "--base", plateMedian, "--fill", plateMuse, "--mask", holesPath, "--grow", "21", "--feather", "2.0", "--match", "--out", plateHybrid]);
              await fsp.copyFile(plateHybrid, plateRaw);
              plateValidation.blend = "median-base+muse-holes";
              plateValidation.base = "median (holes)";
              const hHolesOk = await validatePlate(["--holes", holesPath], "muse-image");
              const hGhostOut = await py([path.join(here, "plate.py"), "ghost-map", "--median", plateMedian, "--hybrid", plateHybrid, "--mask", holesPath, "--grow", "21"]);
              const hGhost = JSON.parse(hGhostOut.match(/\{[\s\S]*\}$/)[0]);
              plateValidation.scoped = { mask: "holes", outsideDiff: hGhost.outsideDiff, medianGhost: hGhost.medianGhostShare, hybridGhost: hGhost.hybridGhostShare, medianEdge: hGhost.medianEdge, hybridEdge: hGhost.hybridEdge };
              const hScopedOk = hGhost.outsideDiff <= 1.0 && hGhost.hybridGhostShare <= hGhost.medianGhostShare && hGhost.hybridEdge <= hGhost.medianEdge * 1.1;
              stage(`plate: scoped ${hScopedOk ? "PASS" : "FAIL"} (outside ${hGhost.outsideDiff}, ghost ${hGhost.medianGhostShare}->${hGhost.hybridGhostShare}, edge ${hGhost.medianEdge}->${hGhost.hybridEdge})`);
              if (hHolesOk && hScopedOk) {
                plateMethod = "muse-image";
                stage("plate: median-hybrid accepted (holes filled)");
              } else {
                warn("median-hybrid rejected; keeping median");
                await fsp.copyFile(plateMedian, plateRaw);
                Object.assign(plateValidation, { scene: savedScene, holes: savedHoles });
                delete plateValidation.blend; delete plateValidation.base;
                delete plateValidation.museResized; delete plateValidation.museCached;
                delete plateValidation.scoped;
              }
            }
          }} else warn(`median-hybrid edit failed${gotMH?.exhausted ? " (booked image budget spent)" : ""}; keeping median`);
        }
      }
      // In-place rung: a subject that never leaves its footprint contaminates
      // the median, so the median-referenced scoped gates above can pass a
      // ghosted hybrid. inplace_gate.py detects that regime from the witness
      // record and judges the full Muse render by alignment, tone, erasure
      // and subject likeness instead. Only when it ACCEPTS the full render
      // (in-place and the fill is clean) are candidates tried, widest first:
      // the full render, then median-base hybrids over the sweep union grown
      // 81/61/41 px (the halo and held props sit outside the SAM footprint).
      // The first that the gate accepts AND that passes the unchanged scene +
      // holes validation ships; otherwise the ladder's plate is restored.
      // Reuses the ladder's render; a rejected render gets at most one
      // paid re-render (below) inside the booked budget.
      if (fs.existsSync(plateMuse)) {
        const inplaceGate = async (candidate) => JSON.parse((await py([path.join(here, "inplace_gate.py"), "--median", plateMedian, "--candidate", candidate, "--claim", holesPath, "--labels", kfDir, "--ids", unionIds.join(",")])).match(/\{[\s\S]*\}$/)[0]);
        let gate = await inplaceGate(plateMuse);
        stage(`plate: in-place gate ${gate.verdict} (contam ${gate.contamShare})`);
        // Muse sometimes re-draws a still subject instead of removing it
        // (clip-b p2: person kept, halo + bgCorr fail). One stronger re-render
        // inside the booked edit budget; the gate judges it the same way.
        if (gate.inplace && gate.verdict === "reject") {
          const again = await timed("plate-muse", () => museEditPlate(seedKf, seedMask, W, H, opts.concept, location, work, {}, selection ? markedPromptFor(location, true) :
            `Erase only the ${opts.concept} ${location} from this photo; it is the person, animal or thing in the foreground there. ` +
            `Keep the furniture, ground and objects it sits, stands or leans on exactly as they are, and repaint only the areas it covered ` +
            `as the empty scene behind it, with the same lighting, focus blur and grain. No person, animal, silhouette, shadow or ghost may remain. ` +
            `Keep every other pixel identical, with the same size and aspect ratio as the input.`, museBudget, { mark: !!selection }));
          if (again?.ok) {
            await fsp.writeFile(plateMuse, again.buffer);
            gate = await inplaceGate(plateMuse);
            stage(`plate: in-place re-render gate ${gate.verdict}`);
          }
        }
        inplaceUnresolved = gate.inplace && gate.verdict !== "accept";
        if (gate.verdict === "accept") {
          const keptPlate = path.join(work, "plate-kept.jpg");
          const saved = { ...plateValidation };
          await fsp.copyFile(plateRaw, keptPlate);
          const sweepMaskPath = path.join(work, "sweep-mask.png");
          let shipped = null, ok = false;
          for (const grow of [null, 81, 61, 41]) {
            const cand = grow === null ? plateMuse : path.join(work, `plate-inplace-g${grow}.jpg`);
            if (grow !== null) {
              if (!fs.existsSync(sweepMaskPath)) break;
              await py([path.join(here, "plate.py"), "composite", "--base", plateMedian, "--fill", plateMuse, "--mask", sweepMaskPath, "--grow", String(grow), "--feather", "2.0", "--match", "--out", cand]);
              const g = await inplaceGate(cand);
              stage(`plate: in-place hybrid g${grow} gate ${g.verdict}`);
              if (g.verdict !== "accept") continue;
            }
            await sharp(cand).resize(W, H, { fit: "fill" }).jpeg({ quality: 95 }).toFile(plateRaw);
            if (await validatePlate(["--holes", holesPath], grow === null ? "muse-full-inplace" : `muse-inplace-g${grow}`)) { shipped = grow; ok = true; break; }
          }
          if (ok) {
            plateMethod = "muse-image";
            Object.assign(plateValidation, { blend: shipped === null ? "muse-full (in-place)" : `median-base+muse-sweep-g${shipped} (in-place)`, base: shipped === null ? "muse" : "median (in-place claim)", inplace: { verdict: gate.verdict, contamShare: gate.contamShare, grow: shipped } });
            delete plateValidation.scoped;
            stage(`plate: in-place plate accepted (${plateValidation.blend})`);
          } else {
            warn("in-place candidates failed validation; keeping ladder plate");
            inplaceUnresolved = true;
            await fsp.copyFile(keptPlate, plateRaw);
            for (const k of Object.keys(plateValidation)) delete plateValidation[k];
            Object.assign(plateValidation, saved);
          }
        }
      }
    }
    else warn("median plate rejected (ghosted holes); trying generative fill");
  }
  // QA ladder last rung lives AFTER every candidate path (see below): the
  // surviving plate — median, any muse-image hybrid, mi-gan or inpaint —
  // faces the ghost/residue check exactly once, so no fallback can bypass it.
  if (!plateMethod && !fallbackReason) {
    const usage = selection ? null : await proxyUsage();
    const imagesLeft = usage ? usage.CAPS.images - usage.counts.images : 1;
    // Unreachable Muse (every attempt a transient 404/429/503) is recorded
    // so a final plate failure can say model_not_found (Meta busy, worth a
    // job retry) instead of looking like a quality verdict.
    if (imagesLeft > 0) {
      stage("plate: muse-image inpaint of the seed frame");
      const got = await timed("plate-muse", () =>
        museSeedEdit());
      if (got?.ok) {
        await fsp.writeFile(plateMuse, got.buffer);
        plateValidation.museResized = got.resized;
        plateValidation.museCached = !!got.cached;
        // Hybrid first: median background (proven clean) + muse-filled hole
        // (proven textured). The fill is colour-matched to the base over the
        // hole's ring first: a full-frame re-render's grading shift must not
        // read as a seam. A full-frame muse render is only a fallback for
        // moving cameras.
        if (fs.existsSync(plateMedian)) {
          await py([path.join(here, "plate.py"), "composite", "--base", plateMedian, "--fill", plateMuse, "--mask", seedMask, "--grow", "11", "--feather", "2.0", "--match", "--out", plateHybrid]);
          await fsp.copyFile(plateHybrid, plateRaw);
          plateValidation.blend = "median-base+muse-holes";
          plateValidation.base = "median";
          if (await validatePlate(["--mask", seedMask, "--grow", "11"], "muse-image")) {
            plateMethod = "muse-image";
            stage("plate: muse-image hybrid accepted");
          } else {
            warn("muse-image hybrid rejected; trying seed-base hybrid");
          }
        }
        if (!plateMethod) {
          // Seed-base hybrid: when the median base itself is scene-rejected
          // (slow dolly/handheld drift that `classify` called fixed), the
          // seed frame is the only scene-consistent base. The scene gate
          // dilates the filled hole away, so this passes iff the base is
          // the seed; the hole gate still judges the fill on its own.
          const plateSeedHybrid = path.join(work, "plate-seed-hybrid.jpg");
          await py([path.join(here, "plate.py"), "composite", "--base", seedKf, "--fill", plateMuse, "--mask", seedMask, "--grow", "11", "--feather", "2.0", "--match", "--out", plateSeedHybrid]);
          await fsp.copyFile(plateSeedHybrid, plateRaw);
          plateValidation.blend = "seed-base+muse-holes";
          plateValidation.base = "seed (median scene-rejected)";
          if (await validatePlate(["--mask", seedMask, "--grow", "11"], "muse-image")) {
            plateMethod = "muse-image";
            stage("plate: muse-image seed-hybrid accepted");
          } else {
            warn("muse-image seed-hybrid rejected; trying full-frame muse");
          }
        }
        if (!plateMethod) {
          // Full-frame re-renders shift global grading: match the render onto
          // the seed background before the scene gate sees it.
          const plateMatched = path.join(work, "plate-matched.jpg");
          await py([path.join(here, "plate.py"), "match", "--src", plateMuse, "--ref", seedKf, "--mask", seedMask, "--out", plateMatched]);
          await fsp.copyFile(plateMatched, plateRaw);
          plateValidation.colorMatched = true;
          if (await validatePlate(["--mask", seedMask, "--grow", "11"], "muse-image")) {
            plateMethod = "muse-image";
            stage("plate: muse-image accepted (colour-matched)");
          } else {
            warn("muse-image plate rejected; falling back to inpaint");
          }
        }
      } else {
        museOutcome = { unreachable: !!got?.unreachable };
        warn(`muse-image edit failed${got?.exhausted ? " (booked image budget spent)" : ""}; falling back to inpaint`);
      }
    } else {
      warn("images cap reached; using inpaint fallback for the plate");
    }
  }
  // Shared non-generative fallback gate (PATH-PARITY-V2): the in-place gate
  // lives on the median-pass branch, so both fallback rungs below assess a
  // passing plate through this one code path. Defer / not-in-place ships as
  // before (see acceptFallbackPlate); an in-place non-accept refuses per the
  // house rule instead of shipping unassessed. A mi-gan rejection falls
  // through to the inpaint rung like a validation rejection; an inpaint
  // rejection falls through to the final fail("no clean plate") below.
  const assessFallbackGate = async (method) => {
    if (plateMethod !== method || !fs.existsSync(plateMedian) || !fs.existsSync(holesPath)) return;
    const gate = JSON.parse((await py([path.join(here, "inplace_gate.py"), "--median", plateMedian, "--candidate", plateRaw, "--claim", holesPath, "--labels", kfDir, "--ids", unionIds.join(",")])).match(/\{[\s\S]*\}$/)[0]);
    stage(`plate: in-place gate ${gate.verdict} (contam ${gate.contamShare})`);
    if (!acceptFallbackPlate(gate)) {
      warn(`in-place gate rejected the ${method} plate; ${method === "migan" ? "falling back to inpaint" : "refusing"}`);
      plateMethod = null;
    }
  };
  const miganWeights = path.join(MODELS_DIR, "migan_pipeline_v2.onnx");
  if (!plateMethod && !fallbackReason && fs.existsSync(miganWeights) && process.env.BASIC_MIGAN !== "0") {
    stage("plate: mi-gan fill");
    await timed("plate", () =>
      py([path.join(here, "plate.py"), "migan", "--model", miganWeights, "--frame", seedKf, "--mask", seedMask, "--out", plateRaw])
    );
    if (await validatePlate(["--mask", seedMask, "--grow", "11"], "migan")) plateMethod = "migan";
    else warn("mi-gan plate rejected; falling back to inpaint");
    await assessFallbackGate("migan");
  }
  if (!plateMethod && !fallbackReason) {
    stage("plate: opencv inpaint fallback");
    await timed("plate", () =>
      py([path.join(here, "plate.py"), "inpaint", "--frame", seedKf, "--mask", seedMask, "--out", plateRaw])
    );
    if (await validatePlate(["--mask", seedMask, "--grow", "11"], "inpaint")) plateMethod = "inpaint";
    // Parity rung (PATH-PARITY-V2): same shared gate as mi-gan above (see
    // acceptFallbackPlate). Defer/not-in-place ships as before; an in-place
    // non-accept refuses via the final fail("no clean plate") below.
    await assessFallbackGate("inpaint");
  }
  // Contact rung (Lane E): a subject part hidden by grass or an occluder
  // (hoof tip, shoe) can sit just outside the grown seed claim, so a Muse
  // hybrid keeps it and the ghost gates (same masks) read 0. Flag
  // subject-coloured blobs touching the claim in the lower contact band,
  // then re-composite the SAME Muse fill over the extended claim (no new
  // Meta call). Kept only if scene + holes still pass; else restored.
  // (colorMatched = the full-frame fallback won; blend then still names the
  // rejected hybrid, so it is excluded explicitly.)
  if (plateMethod === "muse-image" && /\+muse-holes$/.test(plateValidation.blend || "") && !plateValidation.colorMatched && fs.existsSync(plateMuse)) {
    const extMask = path.join(work, "contact-claim.png");
    const cr = JSON.parse((await py([path.join(here, "contact_residue.py"), "--plate", plateRaw, "--seed", seedKf,
      "--alpha", seedMask, "--ids", unionIds.join(","), "--grow", "11", "--ext-out", extMask])).match(/\{[\s\S]*\}$/)[0]);
    plateValidation.contact = { blobs: cr.blobs, applied: false };
    if (cr.n > 0) {
      const before = path.join(work, "plate-pre-contact.jpg");
      const repaired = path.join(work, "plate-contact.jpg");
      const base = plateValidation.base === "median" ? plateMedian : seedKf;
      await fsp.copyFile(plateRaw, before);
      await py([path.join(here, "plate.py"), "composite", "--base", base, "--fill", plateMuse, "--mask", extMask, "--grow", "11", "--feather", "2.0", "--match", "--out", repaired]);
      await fsp.copyFile(repaired, plateRaw);
      if (await validatePlate(["--mask", extMask, "--grow", "11"], "contact")) {
        plateValidation.contact.applied = true;
        stage(`plate: contact rung repainted ${cr.n} blob(s) (${cr.blobs.map((b) => b.area).join(",")} px)`);
      } else {
        await fsp.copyFile(before, plateRaw);
        await validatePlate(["--mask", seedMask, "--grow", "11"], "contact-restored");
        warn("contact rung: repaired plate failed the gates; kept the accepted plate");
      }
    }
  }
  // QA ladder last rung — SINGLE choke point AFTER every candidate path
  // (median, every muse-image hybrid, mi-gan, inpaint): the surviving plate
  // faces the thin-blob AND broad-residue checks. Measured numbers only;
  // a measurement failure fails loudly, never as zeros. Over-limit plates
  // get exactly one booked repair attempt (budget permitting); quality
  // failures refuse with Lite routing, outages stay retryable.
  if (camera === "fixed" && plateMethod) {
    const ladder = async () => {
      // Measure where pixels were synthesized: the sweep for median-based
      // and full-render plates, the fill claim for seed-frame plates.
      const zoneKind = ghostZoneKind({ method: plateMethod, blend: plateValidation.blend, colorMatched: plateValidation.colorMatched });
      const zoneMask = zoneKind === "sweep" ? sweepPath
        : plateValidation.contact?.applied ? path.join(work, "contact-claim.png") : seedMask;
      const gOut = await py([path.join(here, "plate.py"), "ghost-map", "--median", plateRaw, "--mask", zoneMask, "--grow", "11"]);
      const g = JSON.parse(gOut.match(/\{[\s\S]*\}$/)[0]);
      stage(`plate: ghost ${g.medianGhostBlobs}/${g.medianGhostShare} (limit ${opts.ghostLimit}) residue ${g.medianResidueBlobs}/${g.medianResidueShare} (limit ${opts.residueLimit})`);
      const verdict = qaOverLimit(g, opts.ghostLimit, opts.residueLimit);
      plateValidation.ghost = {
        measured: !verdict.malformed, zone: zoneKind, blobs: g.medianGhostBlobs, share: g.medianGhostShare,
        residueBlobs: g.medianResidueBlobs, residueShare: g.medianResidueShare,
        residue: g.medianResidue, limit: opts.ghostLimit, residueLimit: opts.residueLimit,
      };
      return { g, verdict };
    };
    let { g, verdict } = await ladder();
    // Median-base hybrids were judged against that same contaminated
    // median (clip-b: shipped holes-hybrid kept a person-shaped ghost), so
    // they never ship: the soft fallback does (loop 6; was a refusal).
    // Before the repair rung: never pay for a repair it would discard.
    if (inplaceUnresolved) {
      fallbackReason = "still-subject";
      fallbackDetail = "median keeps it, generated plates rejected";
    }
    // Repair a measured defect, never spend on an invalid measurement.
    if (!inplaceUnresolved && verdict.over && !verdict.malformed && museBudget.left > 0) {
      stage(`plate: booked repair attempt (${museBudget.left} image left)`);
      const repaired = await attemptPlateRepair({
        py, here, work, W, H, sweepPath, holesPath, kfDir, frames,
        concept: opts.concept, location, plateRaw, plateMuse,
        museBudget, seedMask, validatePlate,
        ghostLimit: opts.ghostLimit, residueLimit: opts.residueLimit,
      });
      if (repaired?.unreachable) museOutcome = { unreachable: true };
      if (repaired?.ok) {
        plateMethod = "muse-image";
        Object.assign(plateValidation, repaired.validation);
        ({ g, verdict } = await ladder());
      } else {
        warn(`plate repair failed (${repaired?.unreachable ? "Muse unreachable" : repaired?.detail ?? "rejected by strict gates"}); soft fallback`);
      }
    }
    if (!inplaceUnresolved && verdict.over) {
      fallbackReason = "ghost-qa";
      fallbackDetail = `ghost ${verdict.ghost}/${verdict.limit} residue ${verdict.residue}/${verdict.residueLimit}${museOutcome?.unreachable ? " (repair: Muse unreachable)" : ""}`;
    }
  }
  if (!plateMethod && !fallbackReason) {
    // Nothing passed. An unreachable Muse (all 404/429/503) is recorded as
    // such: the soft plate then stands in for a generative fill (loop 6;
    // both were refusals).
    fallbackReason = museOutcome?.unreachable ? "muse-unreachable" : "no-clean-plate";
    fallbackDetail = plateAttempts.map((a) => `${a.label}: scene ${a.scene?.pass ? "pass" : "fail"} holes ${a.holes?.pass ? "pass" : "fail"}`).join("; ").slice(0, 600);
  }
  // Soft fallback (loop 6): the median's observed pixels where the subject
  // was rarely present, a heavily blurred field (inpainted from those
  // pixels only) where it stayed. It cannot show a ghost and never passes
  // for a clean scene: specimen.json records plate.fallback, the viewer
  // labels it. Every other plate keeps the clean-plate QA unchanged.
  let plateFallback = null;
  if (fallbackReason) {
    const softOut = await timed("plate-soft", () => py([path.join(here, "plate.py"), "soften", "--base", plateMedian, "--holes", holesPath,
      "--frames", kfDir, "--labels", kfDir, "--out", plateRaw, "--zone-out", path.join(work, "soft-zone.png")]));
    const soft = JSON.parse(softOut.match(/\{[\s\S]*\}$/)[0]);
    plateMethod = "soft";
    plateFallback = { kind: "soft", reason: fallbackReason, detail: fallbackDetail, softShare: soft.softShare, unsureShare: soft.unsureShare, holeShare: soft.holeShare };
    stage(`plate: soft fallback (${fallbackReason}${fallbackDetail ? `: ${fallbackDetail.slice(0, 160)}` : ""}) soft ${soft.softShare}`);
  }
  plateValidation.seedSample = plateSeed.sample;
  const plateWebp = path.join(outDir, "plate.webp");
  // Loop 12: neon footage (lib/grade.mjs gate) gets one shared grade on the
  // plate, the subject atlas and the thumb; behind.webp is built from this
  // plate. Any other clip takes the unchanged path below.
  const grade = process.env.BASIC_NEON_GRADE === "0" ? null
    : neonGrade(saturationStats(await sharp(plateRaw).resize(320).removeAlpha().raw().toBuffer(), 3));
  if (grade) {
    const { data, info } = await sharp(plateRaw).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    applyGrade(data, 3, grade);
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).webp({ quality: 92, effort: 6 }).toFile(plateWebp);
    stage(`plate: neon footage graded (mean saturation ${grade.meanS}, ${Math.round(grade.clipShare * 100)}% clipped)`);
  } else await sharp(plateRaw).webp({ quality: 92, effort: 6 }).toFile(plateWebp);
  // Loop 11: occluded-body fill (occlusion.py). A moving occluder in front of
  // the subject (a splash over the grizzly's belly) leaves a hole in that
  // keyframe's mask, and the viewer showed the water through the body. Where
  // both neighbours (an end keyframe: its one keyframe neighbour and the
  // outer sample, occOuter) cover a large region the body surrounds, and the
  // source shows something the plate does not, the atlas keeps the source
  // pixels there. Runs beside the depth stages; fail-soft (no fill).
  const occDir = path.join(work, "occ");
  const occJob = opts.matteDir || process.env.BASIC_OCCLUSION_FILL === "0" || frames.length < 3 ? null : (async () => {
    const occFrames = path.join(work, "occ-frames.json");
    await fsp.writeFile(occFrames, JSON.stringify(frames.map((f) => ({ sample: f.sample, centroid: f.centroid }))));
    const outerFile = path.join(work, "occ-outer.json");
    await fsp.writeFile(outerFile, JSON.stringify(occOuter));
    const out = await timed("occlusion", () => py([path.join(here, "occlusion.py"), "--kf", kfDir, "--plate", plateRaw, "--frames", occFrames,
      "--ids", unionIds.join(","), "--out", occDir, "--outer", outerFile]));
    return JSON.parse(out.match(/\{[^\n]*\}\s*$/)[0]);
  })().catch((error) => ({ error }));

  // depth: infer on keyframes + plate, align to the seed keyframe
  await timed("depth-infer", async () => {
    const kf = await kfDepth.done;
    timings["depth-infer-kf"] = kf.sec; // background, overlapped with the plate ladder
    stage(`${kf.out.split("\n").filter(Boolean).at(-1)} (keyframes, overlapped with the plate)`);
    // samples the refine dropped (empty mask) have no label: the fit must not see them
    const keptKf = new Set(frames.map((f) => `depth_kf_${String(f.sample).padStart(5, "0")}.npy`));
    for (const name of await fsp.readdir(depthDir)) {
      if (name.startsWith("depth_kf_") && !keptKf.has(name)) await fsp.rm(path.join(depthDir, name), { force: true });
    }
    const inferDir = path.join(work, "infer");
    await fsp.mkdir(inferDir, { recursive: true });
    await fsp.copyFile(plateRaw, path.join(inferDir, "plate.jpg"));
    const inferOut = await py([path.join(here, "depth.py"), "infer", "--model", MODEL, "--frames", inferDir, "--out", depthDir, "--size", "350"]);
    stage(inferOut.split("\n").filter(Boolean).at(-1));
    // Soft fallback: the blurred zone reads as a near blob to the depth
    // model; a smooth surface from the surrounding depth replaces it.
    if (plateFallback) {
      const sd = await py([path.join(here, "plate.py"), "soften-depth", "--depth", path.join(depthDir, "depth_plate.npy"), "--zone", path.join(work, "soft-zone.png")]);
      stage(`depth: soft zone surfaced ${sd.match(/\{[\s\S]*\}$/)?.[0] ?? ""}`);
    }
  });
  await cleanPath(path.join(work, "infer"), "infer/ (consumed by depth-infer)");
  await cleanPath(path.join(work, "infer-kf"), "infer-kf/ (consumed by depth-infer)");
  const fitReport = await timed("depth-fit", async () => {
    const out = await py([path.join(here, "depth.py"), "fit", "--depth", depthDir, "--labels", kfDir, "--track", unionIds.join(","), "--ref", `kf_${String(seedKeyUsed).padStart(5, "0")}`, "--out", fitDir]);
    stage(out.split("\n").at(-1));
    return JSON.parse(await fsp.readFile(path.join(fitDir, "fit.json"), "utf8"));
  });

  // shared depth mapping from the plate's fitted range (robust window)
  const plateDepth = requireDepthPlane(readNpyFloat32(await fsp.readFile(path.join(fitDir, "fitted_plate.npy"))), W, H, "plate");
  const plateVals = Array.from(plateDepth.data.filter((_, i) => i % 7 === 0));
  plateVals.sort((a, b) => a - b);
  const depthMin = plateVals[Math.floor(plateVals.length * 0.01)];
  const depthMax = plateVals[Math.floor(plateVals.length * 0.99)];
  const depthSpan = depthMax - depthMin || 1;
  const quantize = (plane, lo = depthMin, span = depthSpan) => {
    const out = new Uint8Array(plane.length);
    for (let i = 0; i < plane.length; i += 1) {
      out[i] = Math.max(0, Math.min(255, Math.round(((plane[i] - lo) / span) * 255)));
    }
    return out;
  };

  // atlases: subject RGBA crops + depth cells (cell 0 = full-frame plate depth)
  const K = frames.length;
  const cellAspect = cropW / cropH;
  // 448px cells (brief range 448-512): thin features survive the atlas.
  // maxWidth 4096 so the grid is not clamped back down; watch total bytes.
  const { cols, cellW, cellH } = atlasSize(Math.max(K, 1), cellAspect, { targetCell: 448, maxWidth: 4096 });
  stage(`atlas: ${K} cells ${cellW}x${cellH} in ${cols} cols (crop ${cropW}x${cropH})`);
  const subjectCells = [];
  const depthCells = [];
  // Subject depth cells are quantized after the loop on their own window
  // (depth.subject in specimen.json): a subject nearer than the plate's 99th
  // percentile clipped at 255 on the plate mapping (v1 grizzly: 20.6% of
  // bear pixels, the approaching half of the walk), which flattened its
  // relief to the dome alone.
  const subjectPlanes = [];
  const subjectSamples = [];
  const knee = depthKnee(depthMin, depthMax); // subject depth only; the plate cell is unchanged
  // plate depth first
  const plateCell = quantize(resizePlane(plateDepth.data, W, H, cellW, cellH));
  depthCells.push(Buffer.from(plateCell)); // raw 1-channel cell (loop 11: no PNG round trip)
  // Selected path: one batch plate.py refine-alpha call -> straight-alpha RGBA
  // (guided-filter soft edge + decontaminated RGB). Fail-closed: py() throws on
  // a nonzero exit, so a failed refine aborts the run (no binary fallback).
  // The legacy (non-selection) branch is unchanged.
  const refineDir = opts.matteDir || path.join(work, "refine-rgba");
  if (selection && opts.matteDir) {
    // Precomputed mattes (Advanced): every keyframe needs its RGBA; the
    // per-frame size check below still applies. Never a partial fallback.
    const missing = frames.filter((f) => !fs.existsSync(path.join(refineDir, `rgba_kf_${String(f.sample).padStart(5, "0")}.png`)));
    if (missing.length) fail(`--matte-dir lacks ${missing.length} of ${frames.length} keyframe mattes (first kf_${String(missing[0].sample).padStart(5, "0")})`);
    stage(`matte-dir: ${frames.length} precomputed frames`);
  } else if (selection) {
    await timed("refine-alpha", async () => {
      await fsp.rm(refineDir, { recursive: true, force: true });
      const out = await py([path.join(here, "plate.py"), "refine-alpha", "--frames", kfDir, "--labels", kfDir, "--ids", unionIds.join(","), "--out", refineDir]);
      const info = JSON.parse(String(out).match(/\{[\s\S]*\}\s*$/)[0]);
      if (info.frames !== frames.length) fail(`refine-alpha returned ${info.frames} of ${frames.length} frames`);
      stage(`refine-alpha: ${info.frames} frames (guide ${info.guide})`);
    });
  }
  // Loop 11: cells are built three at a time (sharp decode/resize runs off
  // the main thread while the next cell's alpha loops run) and kept as raw
  // pixels; the PNG encode + decode round trip per cell is gone. Output
  // atlases are byte-identical (PNG is lossless).
  const ATLAS_CONCURRENCY = 3;
  const cellResults = new Array(frames.length);
  const occFilled = new Set();
  const occCleaned = new Set(); // keyframes with a repaint (fill and/or spray)
  if (occJob) {
    const occ = await occJob;
    if (occ.error || !occ.filled) warn(`occlusion fill skipped (${String(occ.error?.message ?? "no report").slice(0, 120)})`);
    else {
      for (const s of Object.keys(occ.filled)) occFilled.add(Number(s));
      for (const s of Object.keys(occ.cleaned ?? {})) occCleaned.add(Number(s));
      if (occFilled.size) stage(`atlas: occluded body filled on ${occFilled.size} keyframe(s) (${Object.entries(occ.filled).map(([s, px]) => `${s}: ${px}px`).join(", ")})`);
      const sprayed = Object.keys(occ.spray ?? {}).length;
      if (sprayed) stage(`atlas: spray on the subject painted as body on ${sprayed} keyframe(s)`);
    }
  }
  await timed("atlas", async () => {
  // A bad cell stops new work; the refusal names the FIRST bad keyframe, as
  // the serial loop did (every lower cell was started first and finishes).
  let next = 0;
  const cellErrors = [];
  const worker = async () => {
    while (next < frames.length && !cellErrors.length) {
      const i = next++;
      try {
        cellResults[i] = await buildCell(i, frames[i]);
      } catch (error) {
        cellErrors[i] = error;
      }
    }
  };
  async function buildCell(i, f) {
    const s = String(f.sample).padStart(5, "0");
    const st = await maskStatsUnion(path.join(kfDir, `kf_${s}.png`), unionIds, W, H);
    const rgb = selection
      ? await sharp(path.join(refineDir, `rgba_kf_${s}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      : await sharp(path.join(kfDir, `kf_${s}.jpg`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (rgb.info.width !== W || rgb.info.height !== H) throw Object.assign(new Error(`keyframe ${s} is ${rgb.info.width}x${rgb.info.height}, expected ${W}x${H}`), { exitFail: true });
    const rgba = Buffer.from(rgb.data);
    // Legacy: erode 1px (wall-coloured rim leaves the core) then feather
    // ~1.5px. Selected: the refined soft alpha already in the RGBA.
    // Plain loops: Uint8Array.from with a map callback cost ~37 ms a frame.
    const raw = new Uint8Array(W * H);
    if (selection) for (let p = 0; p < W * H; p += 1) raw[p] = rgba[p * 4 + 3];
    else for (let p = 0; p < W * H; p += 1) raw[p] = st.mask[p] ? 255 : 0;
    if (occFilled.has(f.sample) || occCleaned.has(f.sample)) { // the hidden body joins the alpha, painted as body
      const occ = occFilled.has(f.sample) ? await sharp(path.join(occDir, `occ_kf_${s}.png`)).extractChannel(0).raw().toBuffer() : null;
      // Loop 12: occlusion.py repaints the fill and the occluder's specks
      // near it as body (occ_rgb + occ_clean); the source pixels there were
      // the splash itself. An older report without them keeps the source.
      // Spray specks on the body (any keyframe, no fill) are repainted the
      // same way.
      let rep = null, paint = null;
      try {
        rep = await sharp(path.join(occDir, `occ_clean_kf_${s}.png`)).extractChannel(0).raw().toBuffer();
        paint = await sharp(path.join(occDir, `occ_rgb_kf_${s}.png`)).removeAlpha().raw().toBuffer();
        if (rep.length !== W * H || paint.length !== W * H * 3) rep = paint = null;
      } catch { rep = paint = null; }
      const src = occ && !paint && selection ? (await sharp(path.join(kfDir, `kf_${s}.jpg`)).ensureAlpha().raw().toBuffer()) : null;
      for (let p = 0; p < W * H; p += 1) {
        if (occ && occ[p]) {
          raw[p] = 255;
          if (src) { rgba[p * 4] = src[p * 4]; rgba[p * 4 + 1] = src[p * 4 + 1]; rgba[p * 4 + 2] = src[p * 4 + 2]; }
        }
        if (rep && rep[p] && raw[p]) { rgba[p * 4] = paint[p * 3]; rgba[p * 4 + 1] = paint[p * 3 + 1]; rgba[p * 4 + 2] = paint[p * 3 + 2]; }
      }
    }
    const alpha = selection ? raw : boxBlurAlpha(boxBlurAlpha(erodeAlpha(raw, W, H), W, H), W, H);
    for (let p = 0; p < W * H; p += 1) {
      rgba[p * 4 + 3] = alpha[p];
      if (!alpha[p]) { rgba[p * 4] = 0; rgba[p * 4 + 1] = 0; rgba[p * 4 + 2] = 0; }
    }
    if (!selection) bleedFill(rgba, W, H, [Math.max(0, union[0] - 6), Math.max(0, union[1] - 6), Math.min(W - 1, union[2] + 6), Math.min(H - 1, union[3] + 6)]);
    const cut = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
      .extract({ left: union[0], top: union[1], width: cropW, height: cropH })
      .resize(cellW, cellH, { fit: "fill" })
      .raw()
      .toBuffer();
    if (grade) applyGrade(cut, 4, grade); // the plate's neon grade, so the subject matches its scene
    // depth crop of the same box, fitted depths, shared mapping
    const fit = requireDepthPlane(readNpyFloat32(await fsp.readFile(path.join(fitDir, `fitted_kf_${s}.npy`))), W, H, s);
    const cropped = new Float32Array(cropW * cropH);
    for (let y = 0; y < cropH; y += 1) {
      for (let x = 0; x < cropW; x += 1) cropped[y * cropW + x] = knee(fit.data[(union[1] + y) * W + union[0] + x]);
    }
    const plane = resizePlane(cropped, cropW, cropH, cellW, cellH);
    // per-frame depth median over the subject (for the specimen record)
    let med = 0;
    const samples = [];
    {
      const vals = [];
      for (let p = 0; p < W * H; p += 1) if (st.mask[p] && p % 5 === 0) vals.push(knee(fit.data[p]));
      for (let k = 0; k < vals.length; k += 4) samples.push(vals[k]);
      vals.sort((a, b) => a - b);
      med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    }
    f.depthMedian = med;
    f.cell = i;
    f.box = [union[0] / W, union[1] / H, (union[2] + 1) / W, (union[3] + 1) / H];
    return { cut, plane, samples };
  }
  await Promise.all(Array.from({ length: Math.min(ATLAS_CONCURRENCY, frames.length) }, worker));
  const firstBad = cellErrors.find(Boolean);
  if (firstBad?.exitFail) fail(firstBad.message);
  if (firstBad) throw firstBad;
  for (const r of cellResults) {
    subjectCells.push({ input: r.cut, raw: { width: cellW, height: cellH, channels: 4 } });
    subjectPlanes.push(r.plane);
    for (const v of r.samples) subjectSamples.push(v);
  }
  cellResults.length = 0;
  });
  const subjectDepth = subjectDepthWindow(subjectSamples, depthMin, depthMax);
  for (const plane of subjectPlanes) {
    const cell = quantize(plane, subjectDepth.min, subjectDepth.max - subjectDepth.min || 1);
    depthCells.push(Buffer.from(cell));
  }
  subjectPlanes.length = 0;
  if (subjectDepth.min !== depthMin || subjectDepth.max !== depthMax) {
    stage(`depth: subject window ${subjectDepth.min.toFixed(3)}..${subjectDepth.max.toFixed(3)} (plate ${depthMin.toFixed(3)}..${depthMax.toFixed(3)})`);
  }
  const rows = Math.ceil(K / cols);
  const dRows = Math.ceil((K + 1) / cols);
  // Sub-keyframe motion field (loop 10): per keyframe pair, a coarse warp
  // that lets the viewer morph the outgoing pose into the incoming one
  // instead of cross-fading two bodies (doubled, see-through limbs on a
  // stride). It starts as soon as subject.webp is written, so it overlaps
  // the depth atlas and the thumb. Fail-soft: without it the viewer keeps
  // the plain slide + fade. BASIC_FLOW=0 turns it off.
  let flowJob = null;
  const startFlow = () => process.env.BASIC_FLOW === "0" || K < 2 ? null : timed("flow", async () => {
    const flowIn = path.join(work, "flow-in.json");
    await fsp.writeFile(flowIn, JSON.stringify({
      cols, cellW, cellH, count: K,
      centroids: frames.map((f) => [((f.centroid[0] * W - union[0]) / cropW) * cellW, ((f.centroid[1] * H - union[1]) / cropH) * cellH]),
    }));
    const out = await py([path.join(here, "flow.py"), "--atlas", path.join(outDir, "subject.webp"), "--meta", flowIn, "--out", path.join(outDir, "flow.bin")]);
    const report = JSON.parse(out.match(/\{[^\n]*\}\s*$/)[0]);
    if (report.pairs !== K - 1) throw new Error(`flow wrote ${report.pairs} of ${K - 1} pairs`);
    stage(`flow: ${report.kept}/${report.pairs} pairs warped (median gain ${report.gainMedian}, peak ${report.peakPx}px, ${report.bytes} bytes)`);
    return report;
  }).catch((error) => { warn(`flow skipped (${String(error.message).slice(0, 160)}); viewer keeps the plain blend`); return null; });
  // Subject atlas at webp effort 4: effort 6 took 18.0 s on a 3136x2712
  // atlas for 0.3% fewer bytes (effort 4: 2.1 s), same quality setting.
  // Loop 11: the two atlases encode at the same time (about 0.5 s less).
  const subjectAtlas = await timed("pack", async () => {
    const subjectDone = sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(subjectCells.map((cell, i) => ({ ...cell, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH })))
      .webp({ quality: 92, alphaQuality: 100, effort: 4 })
      .toFile(path.join(outDir, "subject.webp"))
      .then((out) => { flowJob = startFlow(); return out; });
    // Raw 1-channel cells composite exactly as the old PNG + ensureAlpha
    // inputs did (grey replicated, opaque); a raw 2-channel grey+alpha input
    // does not (it came out dark), so keep this form.
    const depthDone = sharp({ create: { width: cols * cellW, height: dRows * cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } } })
      .composite(depthCells.map((input, i) => ({ input, raw: { width: cellW, height: cellH, channels: 1 }, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH })))
      // effort 4 (loop 11): 0.4 s less than 6 on a 60-cell atlas, about 5%
      // more bytes, same quality setting (re-encode error 0.30 vs 0.32 grey levels)
      .webp({ quality: 100, effort: 4 })
      .toFile(path.join(outDir, "depth.webp"));
    const [out] = await Promise.all([subjectDone, depthDone]);
    return out;
  });
  await cleanPath(depthDir, "depth/ (consumed by fit)");
  for (const f of await fsp.readdir(fitDir).catch(() => [])) {
    if (f.startsWith("fitted_") && f.endsWith(".npy")) await fsp.unlink(path.join(fitDir, f)).catch(() => {});
  }
  stage("cleanup: removed fitted_*.npy (fit.json keeps the report)");
  void subjectAtlas;

  // thumb: middle keyframe's subject composited over the plate
  const mid = frames[Math.floor(frames.length / 2)];
  const midS = String(mid.sample).padStart(5, "0");
  const midLabel = await sharp(path.join(kfDir, `kf_${midS}.png`)).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const midRgb = await sharp(path.join(kfDir, `kf_${midS}.jpg`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const plateBase = await sharp(plateRaw).ensureAlpha().raw().toBuffer();
  {
    const { data } = midRgb;
    for (let p = 0; p < W * H; p += 1) {
      if (!unionSet.has(midLabel.data[p])) continue;
      plateBase[p * 4] = data[p * 4];
      plateBase[p * 4 + 1] = data[p * 4 + 1];
      plateBase[p * 4 + 2] = data[p * 4 + 2];
      plateBase[p * 4 + 3] = 255;
    }
    if (grade) applyGrade(plateBase, 4, grade);
    await sharp(plateBase, { raw: { width: W, height: H, channels: 4 } })
      .resize(480)
      .webp({ quality: 82, effort: 6 })
      .toFile(path.join(outDir, "thumb.webp"));
  }
  await cleanPath(kfDir, "kf/ (consumed by atlases+thumb)");

  const files = ["specimen.json", "plate.webp", "subject.webp", "depth.webp", "thumb.webp", "meta.json"];
  const sizes = {};
  for (const f of files.slice(1, 5)) {
    try { sizes[f] = fs.statSync(path.join(outDir, f)).size; } catch { sizes[f] = 0; }
  }
  const id = path.basename(path.resolve(outDir));
  const specimen = {
    version: 1, id, tier: "basic", subject: opts.concept,
    source: { file: path.basename(video), width: info.width, height: info.height, fps: info.fps, duration: info.duration },
    working: { width: W, height: H },
    camera, ...(cameraOverride ? { cameraOverride: true } : {}), plate: { method: plateMethod, validation: plateValidation, ...(plateFallback ? { fallback: plateFallback } : {}) },
    envelopeK,
    track: { id: track.id, ids: unionIds, samples, seedSample: seedKeyUsed, ...(trackConcept !== opts.concept ? { concept: trackConcept } : {}), ...(selection ? { clock: selectedClock, sourceSha256: selection.sourceSha256, requestedSeedFrame: selection.seedFrameIndex, processedRange: tracks.processedRange, unprocessedFrames: tracks.unprocessedFrames, unverifiedFrames: tracks.unverifiedFrames } : {}) },
    keyframes: frames.map(({ sample, t, src, centroid, box, pixels, depthMedian, cell }) => ({ sample, t, src, centroid, box, pixels, depthMedian, cell })),
    crop: { x: union[0] / W, y: union[1] / H, w: cropW / W, h: cropH / H },
    layout: { cols, rows, dRows, cellW, cellH },
    depth: { min: depthMin, max: depthMax, subject: { min: subjectDepth.min, max: subjectDepth.max }, model: "depth-anything-v2-small-onnx-apache-2.0", ref: `kf_${String(seedKeyUsed).padStart(5, "0")}` },
    depthFit: fitReport.frames.map((f) => ({ name: f.name, scale: f.scale, shift: f.shift })),
    files: { plate: "plate.webp", subject: "subject.webp", depth: "depth.webp", thumb: "thumb.webp" },
    provenance: ["sam-3.1", plateMethod === "muse-image" ? "muse-image-1.0" : `plate-${plateMethod}`, "depth-anything-v2-small-onnx", ...(opts.matteDir ? ["birefnet-matte"] : [])],
    timings,
  };
  // Loop 11: the behind layer reads only plate/depth/subject and this
  // record, so it runs beside the flow field instead of after it.
  await fsp.writeFile(path.join(outDir, "specimen.json"), JSON.stringify(specimen));
  const behindJob = timed("behind", async () => py([path.join(here, "behind.py"), outDir])).then((out) => ({ out }), (error) => ({ error }));
  const flowReport = flowJob ? await flowJob : null;
  if (flowReport) {
    specimen.flow = { file: "flow.bin", gx: flowReport.gx, gy: flowReport.gy, scale: flowReport.scale, pairs: flowReport.pairs, kept: flowReport.kept };
    specimen.files.flow = "flow.bin";
    sizes["flow.bin"] = flowReport.bytes;
  }
  const bytes = Object.values(sizes).reduce((a, b) => a + b, 0);
  const meta = {
    id, tier: "basic", title: `${opts.concept} specimen`, subject: opts.concept,
    viewer: `view-basic.html?id=${id}`, thumb: `${id}/thumb.webp`,
    durationSec: frames.length ? frames.at(-1).t - frames[0].t : 0,
    bytes: bytes + JSON.stringify(specimen).length,
    meta: { camera, category: "unclassified", provenance: specimen.provenance },
  };
  await fsp.writeFile(path.join(outDir, "specimen.json"), JSON.stringify(specimen));
  await fsp.writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
  meta.bytes += JSON.stringify(meta).length;
  await fsp.writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
  // Behind layer (production path for the layered disocclusion fill):
  // CPU-only synthesis from the shipped plates. Failure-isolated: a
  // behind failure warns and ships the specimen WITHOUT the layer (the
  // viewer falls back to the legacy backing), so the Railway median path
  // stays green. Timed against the 20s budget.
  try {
    const behindRun = await behindJob;
    if (behindRun.error) throw behindRun.error;
    const behindOut = behindRun.out;
    const behindReport = JSON.parse(behindOut.match(/\{[\s\S]*\}$/)[0]);
    stage(`behind: canvas ${behindReport.canvas} ghost ${behindReport.ghostBlobs}/${behindReport.ghostShare} (${behindReport.seconds}s)`);
    specimen.files.behind = "behind.webp";
    specimen.files.plateAlpha = "plateAlpha.png";
    specimen.behind = { canvas: behindReport.canvas, bandPx: behindReport.bandPx, ghostBlobs: behindReport.ghostBlobs, ghostShare: behindReport.ghostShare };
    await fsp.writeFile(path.join(outDir, "specimen.json"), JSON.stringify(specimen));
    let extra = JSON.stringify(specimen).length;
    for (const f of ["behind.webp", "plateAlpha.png"]) {
      try { extra += fs.statSync(path.join(outDir, f)).size; } catch { /* sizes below */ }
    }
    meta.bytes += extra;
    await fsp.writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
  } catch (error) {
    warn(`behind failed (${error.message}); shipping without layered fill`);
  }
  await cleanPath(path.join(work, "plate-raw.jpg"), "plate-raw.jpg (plate.webp is final)");
  await cleanPath(tmpDir, "tmp/ (child-process scratch)");

  const after = selection ? null : await proxyUsage();
  stage(`done: ${K} keyframes, ${(meta.bytes / 1024).toFixed(0)}KB total, timings ${JSON.stringify(timings)}`);
  if (after) stage(`proxy usage after: ${JSON.stringify(after.counts)}`);
}

// Importable for unit tests (resolveWorkDir/resolveMetaConfig) without
// launching the pipeline: main() runs only under direct execution.
const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedAs === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error.stack || error.message));
}
