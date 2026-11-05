import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { client } from "./lib/meta.js";
import { probeVideo, extractFrame, transcodeForWeb, cutSegment } from "./lib/ffmpeg.js";
import { detectObjects } from "./lib/detect.js";
import { AUTO_CONCEPTS } from "./lib/vocab.js";
import { generateVolume, MAX_TRACK_FRAMES } from "./lib/generate.js";
import { probeClip, buildWorld } from "./lib/world.js";
import { bakeLab } from "./lib/bake.js";
import { reconstruct, reconstructAvailable } from "./lib/reconstruct.js";
import { liveRouter } from "./lib/live.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, "jobs");
const SITE = path.resolve(__dirname, "..");
const CLIPS_DIR = path.join(SITE, "assets", "clips", "uploads");
fs.mkdirSync(JOBS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use("/api/jobs", express.static(JOBS_DIR));

const upload = multer({ dest: path.join(JOBS_DIR, "_uploads"), limits: { fileSize: 300 * 1024 * 1024 } });

/** jobId -> { videoPath, fileId (set when the whole clip is first sent to Meta), width, height, fps, frameCount, duration } */
const JOBS = new Map();
/** `${jobId}:${frameIndex}` -> { result, extraConcepts, objectsById } */
const DETECT_CACHE = new Map();

app.get("/api/health", async (req, res) => {
  res.json({ status: "ok", model: "sam-3.1 via Meta Model API", reconstruct: reconstructAvailable() });
});

app.post("/api/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video uploaded." });
    const jobId = path.basename(req.file.path);
    const jobDir = path.join(JOBS_DIR, jobId);
    await fsp.mkdir(jobDir, { recursive: true });
    const videoPath = path.join(jobDir, "source.mp4");
    await fsp.rename(req.file.path, videoPath);

    const info = await probeVideo(videoPath);

    JOBS.set(jobId, { videoPath, jobDir, ...info });
    res.json({ jobId, ...info });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function runDetect(jobId, time, extraConcepts, baseConcepts) {
  const job = JOBS.get(jobId);
  if (!job) throw Object.assign(new Error("Unknown job."), { status: 404 });
  const frameIndex = Math.max(0, Math.min(Math.round(time * job.fps), job.frameCount - 1));
  const cacheKey = `${jobId}:${frameIndex}`;
  const cached = DETECT_CACHE.get(cacheKey);
  const mergedExtra = Array.from(new Set([...(cached?.extraConcepts || []), ...(extraConcepts || [])]));

  const stillPath = path.join(job.jobDir, `frame_${frameIndex}.png`);
  if (!fs.existsSync(stillPath)) await extractFrame(job.videoPath, frameIndex, stillPath);
  const frameBuffer = await fsp.readFile(stillPath);

  const result = await detectObjects(frameBuffer, job.width, job.height, mergedExtra, baseConcepts);
  const objectsById = new Map(result._internal.accepted.map((c, i) => [i + 1, c]));
  DETECT_CACHE.set(cacheKey, { result, extraConcepts: mergedExtra, objectsById, frameIndex });
  return { result, frameIndex };
}

app.post("/api/detect", async (req, res) => {
  try {
    const { jobId, time } = req.body;
    const { result, frameIndex } = await runDetect(jobId, Number(time), []);
    res.json({ frameIndex, frameWidth: result.frameWidth, frameHeight: result.frameHeight, objects: result.objects, indexMapPngBase64: result.indexMapPngBase64 });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/detect-custom", async (req, res) => {
  try {
    const { jobId, time, prompt } = req.body;
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "Prompt is required." });
    const { result, frameIndex } = await runDetect(jobId, Number(time), [prompt.trim().toLowerCase()]);
    res.json({ frameIndex, frameWidth: result.frameWidth, frameHeight: result.frameHeight, objects: result.objects, indexMapPngBase64: result.indexMapPngBase64 });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Track the chosen object through the clip with SAM. Throws errors carrying an HTTP status.
async function track(jobId, time, objectId) {
  const job = JOBS.get(jobId);
  if (!job) throw Object.assign(new Error("Unknown job."), { status: 404 });
  const frameIndex = Math.max(0, Math.min(Math.round(Number(time) * job.fps), job.frameCount - 1));
  const chosen = DETECT_CACHE.get(`${jobId}:${frameIndex}`)?.objectsById.get(Number(objectId));
  if (!chosen) throw Object.assign(new Error("Run detect on this frame before generating."), { status: 400 });
  return { job, chosen, frameIndex };
}

// SAM is billed and timed per frame of the whole clip, but tracking reads only MAX_TRACK_FRAMES
// after the seed. For a longer clip, send just that window. A big frame is sent at most SAM_MAX_WIDTH
// wide: tracking time grows with pixels and the masks are scaled back afterwards.
const SAM_MAX_WIDTH = 1280;
async function samSource(job, frameIndex) {
  const scale = Math.min(1, SAM_MAX_WIDTH / job.width);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const size = { samWidth: even(job.width * scale), samHeight: even(job.height * scale) };
  if (job.frameCount <= MAX_TRACK_FRAMES + 30 && scale === 1) {
    job.fileId ||= (await client.files.create({ purpose: "user_data", file: fs.createReadStream(job.videoPath) })).id;
    return { fileId: job.fileId, samOffset: 0, ...size };
  }
  const start = job.frameCount > MAX_TRACK_FRAMES + 30 ? frameIndex : 0;
  const frames = job.frameCount > MAX_TRACK_FRAMES + 30 ? MAX_TRACK_FRAMES + 10 : job.frameCount;
  const segment = await cutSegment(job.videoPath, start / job.fps, frames / job.fps, path.join(job.jobDir, `seg_${start}.mp4`), { width: size.samWidth, height: size.samHeight });
  const file = await client.files.create({ purpose: "user_data", file: fs.createReadStream(segment) });
  return { fileId: file.id, samOffset: start, ...size };
}

function runTrack({ job, chosen, frameIndex }, genId) {
  const genDir = path.join(job.jobDir, genId);
  return fsp.mkdir(genDir, { recursive: true }).then(async () => ({
    genDir,
    manifest: await generateVolume({
      videoPath: job.videoPath,
      ...(await samSource(job, frameIndex)),
      concept: chosen.concept,
      frameWidth: job.width,
      frameHeight: job.height,
      fps: job.fps,
      seedFrameIndex: frameIndex,
      chosenMask: chosen.mask,
      chosenBox: chosen.box,
      jobDir: genDir,
    }),
  }));
}

const withUrls = (manifest, jobId, genId) => ({
  ...manifest,
  frames: manifest.frames.map((f) => ({ ...f, url: `/api/jobs/${jobId}/${genId}/${f.url}` })),
});

app.post("/api/generate", async (req, res) => {
  try {
    const { jobId, time, objectId } = req.body;
    const target = await track(jobId, time, objectId);
    const genId = `gen_${Date.now().toString(36)}`;
    const { manifest } = await runTrack(target, genId);
    res.json(withUrls(manifest, jobId, genId));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ── Builds: the object block plus a 3D reconstruction of the clip ────────
// basic    -> a 4D point cloud (make-cloud.py, assets/cloud/<name>, cloud.html)
// advanced -> the rebuilt scene with the subject in relief (make-stable.py, assets/stable/<name>, stable.html)
// Both start from one SAM pass, whose block is available as soon as tracking ends.

/** buildId -> { mode, stage, detail, manifest, viewer, error } */
const BUILDS = new Map();

// `targets` are tried in order: a subject that is tracked in too few frames hands over to the next.
function startBuild(jobId, targets, mode) {
  const buildId = `b${crypto.randomBytes(5).toString("hex")}`;
  const build = { mode, stage: "tracking", detail: "Following it to the end of the clip…", subject: targets[0].chosen.concept, manifest: null, viewer: null, error: null };
  BUILDS.set(buildId, build);
  console.log(`build ${buildId}: ${mode}, ${targets.length} candidate subject(s)`);
  runBuild(build, buildId, jobId, targets).catch((error) => {
    console.error(`build ${buildId}:`, error);
    Object.assign(build, { stage: "failed", error: error.message });
  });
  return buildId;
}

// A fixed camera with any number of animals goes through the world builder (lib/world.js): every
// animal tracked, the scene rebuilt around them, the water left live. Moving cameras keep startBuild.
function startWorld(job, concept, probe) {
  const buildId = `b${crypto.randomBytes(5).toString("hex")}`;
  const build = { mode: "advanced", stage: "tracking", detail: "Following your subject…", subject: concept, manifest: null, viewer: null, error: null };
  BUILDS.set(buildId, build);
  console.log(`build ${buildId}: advanced world, "${concept}", fixed camera (drift ${probe.shift}px)`);
  buildWorld({ build, job, concept, probe, name: `up-${buildId}`, clipPath: CLIPS_DIR, site: SITE })
    .then((viewer) => Object.assign(build, { stage: "done", detail: "Ready.", viewer }))
    .catch((error) => {
      console.error(`build ${buildId}:`, error);
      Object.assign(build, { stage: "failed", error: error.message });
    });
  return buildId;
}

const checkMode = (mode) => {
  if (!["basic", "advanced"].includes(mode)) throw Object.assign(new Error("Choose basic or advanced."), { status: 400 });
  if (!reconstructAvailable()) throw Object.assign(new Error("3D reconstruction is not set up on this server (set DA3_PYTHON)."), { status: 503 });
};

app.post("/api/build", async (req, res) => {
  try {
    const { jobId, time, objectId, mode } = req.body;
    checkMode(mode);
    res.json({ buildId: startBuild(jobId, [await track(jobId, time, objectId)], mode) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Upload -> build with no clicking: find the main subject ourselves, then build.
// A few broad concepts are swept over several moments (a clip can open on another shot, or the
// subject can walk in later). Candidates are ranked by size, earlier first (tracking runs forward
// from the seed); one that fills the frame is the scene, not a subject.
const MAX_SUBJECT_AREA = 0.6;
const PREFERRED_AREA = 0.1; // anything bigger ties: a subject up at the lens is a close-up, not the better pick
const SEED_SHARES = [0, 0.15, 0.3, 0.45, 0.6];
const MAX_ATTEMPTS = 3;
app.post("/api/auto", async (req, res) => {
  try {
    const { jobId, mode } = req.body;
    checkMode(mode);
    const job = JOBS.get(jobId);
    if (!job) return res.status(404).json({ error: "Unknown job." });
    const sweeps = await Promise.all(SEED_SHARES.map(async (share) => {
      const { result, frameIndex } = await runDetect(jobId, share * job.duration, [], AUTO_CONCEPTS);
      const best = result.objects
        .map((o) => ({ ...o, area: (o.box.right - o.box.left) * (o.box.bottom - o.box.top) }))
        .filter((o) => o.area < MAX_SUBJECT_AREA)
        .sort((a, b) => b.area - a.area)[0];
      return best && { id: best.id, label: best.label, time: frameIndex / job.fps, score: Math.min(best.area, PREFERRED_AREA) * (1 - 0.5 * share) };
    }));
    const picks = sweeps.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, MAX_ATTEMPTS);
    if (!picks.length) return res.status(422).json({ error: "Couldn't find a clear subject in this clip. Use \"choose the object myself\" to pick one." });
    if (mode === "advanced") {
      const probe = await probeClip(job.videoPath);
      if (probe?.fixed || probe?.stabilizable) return res.json({ buildId: startWorld(job, picks[0].label, probe), subject: picks[0].label });
    }
    const targets = await Promise.all(picks.map((p) => track(jobId, p.time, p.id)));
    res.json({ buildId: startBuild(jobId, targets, mode), subject: picks[0].label });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/build/:id", (req, res) => {
  const build = BUILDS.get(req.params.id);
  if (!build) return res.status(404).json({ error: "Unknown build." });
  res.json(build);
});

async function runBuild(build, buildId, jobId, targets) {
  const { job } = targets[0];
  const name = `up-${buildId}`;
  let attempt = null;
  let lastError;
  for (const [k, target] of targets.entries()) {
    const genId = k ? `${buildId}_${k}` : buildId;
    const dir = path.join(job.jobDir, genId);
    Object.assign(build, { stage: "tracking", subject: target.chosen.concept, detail: k ? "That one left the shot. Trying another subject…" : "Following it to the end of the clip…" });
    try {
      const { genDir, manifest } = await runTrack(target, genId);
      Object.assign(build, { stage: "baking", detail: "Cutting out and sampling frames…" });
      const { overlay } = await bakeLab({ videoPath: job.videoPath, manifest, genDir, bakeDir: path.join(dir, "bake"), fullDir: path.join(dir, "full"), fps: job.fps });
      attempt = { dir, overlay, manifest: withUrls(manifest, jobId, genId) };
      break;
    } catch (error) {
      lastError = error;
      if (!error.retryable && !/Could not match/.test(error.message)) throw error;
      console.warn(`build ${buildId}: subject ${k + 1} of ${targets.length} unusable: ${error.message}`);
    }
  }
  if (!attempt) throw lastError;

  build.manifest = attempt.manifest;
  const clipPath = await transcodeForWeb(job.videoPath, path.join(CLIPS_DIR, `${name}.mp4`));
  Object.assign(build, { stage: "solving", detail: "Waiting for the GPU…" });
  await reconstruct({
    mode: build.mode,
    bakeDir: path.join(attempt.dir, "bake"),
    fullDir: path.join(attempt.dir, "full"),
    name,
    overlay: attempt.overlay,
    clip: path.relative(SITE, clipPath).split(path.sep).join("/"),
    onStage: (detail) => { build.detail = detail; },
  });
  Object.assign(build, {
    stage: "done",
    detail: "Ready.",
    viewer: build.mode === "basic" ? `cloud.html?job=${name}` : `stable.html?clip=${name}`,
  });
  fsp.rm(path.join(attempt.dir, "full"), { recursive: true, force: true }).catch(() => {});
}

// ── live.html: the Advanced tier, a step at a time (lib/live.js; the production app mounts the same router) ──

app.use("/api/live", liveRouter({
  resolveJob(req, res, key) {
    const job = JOBS.get(key);
    if (!job) res.status(404).json({ error: "Unknown job. Upload the clip again." });
    return job;
  },
  clipDir: CLIPS_DIR,
  site: SITE,
}));

const port = Number(process.env.PORT || 8000);
app.listen(port, "127.0.0.1", () => {
  console.log(`Spacetime Object Volume backend on http://127.0.0.1:${port}`);
});
