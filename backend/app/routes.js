import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Router } from "express";
import multer from "multer";
import { probeVideo } from "../lib/ffmpeg.js";
import { recordUsage, recordSpend, spendTodayCents, spendGlobalTodayCents, setKv, estimateCents, globalJobsToday } from "./db.js";
import { killed, quotaCheck, rateLimited, clientKey } from "./quotas.js";
import { runDetect, runBoxDetect, frameIndexFor, publicDetect, snapshotFromCache, parseSelectionSnapshot } from "./detect-cache.js";
import { ADV_STALE_TEXT, ADV_NO_MATCH_TEXT, ADV_AMBIGUOUS_TEXT, ADV_MULTI_CONCEPT_TEXT } from "../lib/seed-match.mjs";
import { classifyUpload, normalizeRoute, SPARK_MODEL } from "./spark.js";
import { userError, SELECTION_STALE_TEXT } from "./errors.js";
import { estimateSamFrames, prewarmLiteSource } from "./runner-lite.js";
import { imageBoxPixels, IMAGE_FRAME_CHANGED } from "../lib/sam-image-seed.mjs";
import { BOX_SELECTION_NO_MATCH } from "../lib/sam-image-result.mjs";
import { requireWholeSeedSource } from "../lib/sam-video-seed.mjs";
import { requireLiteSeedSource } from "../lib/lite-decode.js";
import { measureCamera, detectCuts, recommendTier } from "./camera.js";
import { basicAvailable, BASIC_MULTI_OBJECT_TEXT } from "./runner-basic.js";
import { requireBasicSelectedSource, requireBasicSeedSource, probeBasicClock, BASIC_CLOCK_TEXT, BASIC_SPAN_TEXT } from "../pipeline/basic/lib/selected-source.mjs";
import {
  workerAuth, heartbeat, workerStatus, claimJob,
  mintDownloadToken, redeemDownloadToken, extractZip, writePackage, dirSize,
  mergeWorkerProvenance,
} from "./worker.js";
import { notifyJobDone, notifyJobFailed } from "./mailer.js";
import { liveRouter } from "../lib/live.js";
import { reconstructAvailable } from "../lib/reconstruct.js";
import { siteRootFor } from "./static.js";

// All production endpoints (contract in PLAN.md). Everything here except
// /api/health and /api/worker/* sits behind the gate; requireUser is the
// backstop (the gate itself answers unauthenticated requests).

const uploadRow = (db, id) => db.prepare("SELECT * FROM uploads WHERE id=?").get(id);
const jobRow = (db, id) => db.prepare("SELECT * FROM jobs WHERE id=?").get(id);

const liveLiteRun = (result) => {
  const id = result?.runId || /^\/?lite\.html\?run=(r[0-9a-f]{10})(?:&|$)/.exec(result?.viewer || "")?.[1];
  return /^r[0-9a-f]{10}$/.test(id || "") ? id : null;
};

function publicJob(db, config, job) {
  const out = {
    id: job.id, tier: job.tier, status: job.status,
    stage: job.stage, detail: job.detail, progress: job.progress,
    uploadId: job.upload_id, publish: job.publish,
    title: job.title, subject: job.subject,
    createdAt: job.created_at, updatedAt: job.updated_at,
  };
  if (job.result) {
    try {
      out.result = JSON.parse(job.result);
      const run = job.tier === "lite" && liveLiteRun(out.result);
      if (run) out.result = { ...out.result, runId: run, viewer: `lite.html?job=${job.id}`, thumb: `/api/live/lite/${job.id}/files/world/live/frames/f00001.jpg` };
    } catch {
      out.result = null;
    }
  }
  if (job.error) out.error = job.error;
  if (job.tier === "advanced" && (job.status === "queued_gpu" || job.status === "claimed")) {
    out.worker = workerStatus(db, config);
  }
  return out;
}

function ownerOrAdmin(req, ownerId) {
  return req.user && (req.user.id === ownerId || req.user.role === "owner");
}

function scaleFilter(maxSide) {
  return `scale='if(gt(iw,ih),${maxSide},-2)':'if(gt(iw,ih),-2,${maxSide})'`;
}

function scaleDown(src, dst, maxSide) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-i", src, "-vf", scaleFilter(maxSide), "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", dst], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg scale failed: ${stderr.slice(-400)}`))));
  });
}

// Adds the measured camera and a tier recommendation to Spark's route. Measured motion overrides a single-still guess.
function enrichRoute(route, measured, cuts = 0) {
  const out = normalizeRoute(route);
  if (cuts > 0) {
    out.cuts = cuts;
    out.warnings.push("Hard cuts detected; tracking may lose subjects between shots. You can still try this clip.");
  }
  if (measured) {
    out.cameraMeasured = { moving: measured.moving, shiftPx: measured.shiftPx };
    if (measured.confident && measured.moving) {
      out.camera = "moving";
      out.warnings = [...(out.warnings || []), "The camera moves in this clip (measured). Lite follows your subject anyway; Basic and Advanced work best with a steady camera."];
    } else if (measured.confident && !measured.moving) {
      out.camera = "fixed"; // measurement beats Spark's single-still guess in both directions
    }
  }
  out.recommend = recommendTier(out, measured);
  return out;
}

export function buildApi({ db, config, dataDir, runners, detectFn, boxDetectFn, sparkFn, cameraFn, pump }) {
  const api = Router();
  const tmpDir = path.join(dataDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: Math.max(1, Math.ceil(config.maxUploadMB * 1024 * 1024)), files: 1 },
  });

  // ---- requireUser backstop (gate runs first and normally handles this) ----
  api.use((req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/worker/")) return next();
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    next();
  });

  api.get("/health", (req, res) => res.json({ status: "ok" }));
  const liveAvailable = () => Boolean(config.liveAdvanced && reconstructAvailable());

  api.get("/me", (req, res) => {
    res.json({
      id: req.user.id, email: req.user.email, role: req.user.role,
      spendTodayCents: spendTodayCents(db, req.user.id),
      worker: workerStatus(db, config),
      maintenance: killed(db, config),
      live: liveAvailable(),   // this server can run Advanced in front of the user (a GPU and the world builder are here)
    });
  });

  api.post("/logout", (req, res) => res.json({ ok: true }));

  // ---- uploads ----
  api.post("/upload", (req, res, next) => {
    if (killed(db, config)) return res.status(503).json({ error: "Service temporarily disabled (kill switch)." });
    if (rateLimited(clientKey(req), "upload", config.rateUploadPerMin)) {
      return res.status(429).json({ error: "Too many uploads. Slow down and try again." });
    }
    upload.single("video")(req, res, (err) => {
      if (err) {
        const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Clip exceeds the size limit." : "Upload failed." });
      }
      next();
    });
  }, async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No video uploaded." });
      const rights = req.body?.rights;
      if (!["1", "true", "on", "yes"].includes(String(rights).toLowerCase())) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Rights attestation is required (confirm you may use this clip)." });
      }
      let info;
      try {
        info = await probeVideo(req.file.path);
      } catch {
        fs.unlink(req.file.path, () => {});
        return res.status(422).json({ error: "Could not read that video. Try an mp4, mov or webm clip." });
      }
      if (!info.duration || info.duration > config.maxClipSec) {
        fs.unlink(req.file.path, () => {});
        return res.status(422).json({ error: `Clips must be ${config.maxClipSec} seconds or shorter.` });
      }
      const uploadId = crypto.randomUUID();
      const dir = path.join(dataDir, "uploads", uploadId);
      await fsp.mkdir(dir, { recursive: true });
      let stored = path.join(dir, "source.mp4");
      await fsp.rename(req.file.path, stored);
      // A rotation-tagged clip (phone) is also re-encoded, upright at its own
      // size: its coded width/height would disagree with every decoded frame.
      if (Math.max(info.width, info.height) > config.maxLongSide || info.rotation) {
        const scaled = path.join(dir, "scaled.mp4");
        await scaleDown(stored, scaled, 2 * Math.floor(Math.min(config.maxLongSide, Math.max(info.width, info.height)) / 2));
        await fsp.rename(scaled, stored);
        info = await probeVideo(stored);
      }
      const stat = await fsp.stat(stored);
      const now = Date.now();
      db.prepare(
        "INSERT INTO uploads(id,user_id,filename,bytes,width,height,fps,frames,duration,rights,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
      ).run(uploadId, req.user.id, req.file.originalname || "clip", stat.size, info.width, info.height, info.fps, info.frameCount, info.duration, 1, now);
      res.json({
        uploadId, jobId: uploadId, // jobId alias eases the legacy frontend transition
        width: info.width, height: info.height, fps: info.fps, frameCount: info.frameCount, duration: info.duration,
      });
    } catch (error) {
      res.status(500).json({ error: userError(error, "Upload failed. Try again.") });
    }
  });

  const resolveUpload = (req, res) => {
    const id = req.body?.uploadId || req.body?.jobId; // jobId accepted as an alias
    if (!id) {
      res.status(400).json({ error: "uploadId is required." });
      return null;
    }
    const row = uploadRow(db, id);
    if (!row || !ownerOrAdmin(req, row.user_id)) {
      res.status(404).json({ error: "Unknown upload." });
      return null;
    }
    return { ...row, path: path.join(dataDir, "uploads", row.id, "source.mp4") };
  };

  // ---- detect ----
  // Prompt-less detect asks Spark for likely subjects first, then sweeps SAM
  // over those (~a dozen concepts) instead of the full 68-concept vocabulary.
  // Any Spark failure falls back to the full sweep; detect-custom keeps the
  // full sweep plus the prompt so a named object is never narrowed away.
  const SPARK_FALLBACK_CONCEPTS = ["person", "animal", "vehicle", "dog", "cat", "bird"];
  // Used when Spark names nothing (or is down): a broad but small sweep, never the 68-concept vocabulary.
  const BROAD_CONCEPTS = [...SPARK_FALLBACK_CONCEPTS, "horse", "car", "bicycle", "bottle", "cup", "chair", "ball", "bag", "toy", "object"];
  const FULL_SWEEP_CONCEPTS = 68;
  const detectHandler = (extraPrompt) => async (req, res) => {
    try {
      // worst case: Spark call + (full vocabulary sweep for a named prompt, ~14 concepts otherwise)
      const detectEst = estimateCents(config, "route", 1) + estimateCents(config, "detect", extraPrompt || !config.sparkConcepts ? FULL_SWEEP_CONCEPTS : 14);
      const check = quotaCheck(db, config, req.user.id, 1, detectEst);
      if (check) return res.status(check.status).json({ error: check.error });
      const upload = resolveUpload(req, res);
      if (!upload) return;
      let extra = [];
      if (extraPrompt) {
        const prompt = req.body?.prompt;
        if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: "Prompt is required." });
        extra = [String(prompt).trim().toLowerCase().slice(0, 120)];
      }
      let baseConcepts;
      if (config.sparkConcepts && !extraPrompt) {
        baseConcepts = BROAD_CONCEPTS;
        try {
          const spark = sparkFn || classifyUpload;
          const cls = await spark({ upload, dataDir });
          recordSpend(db, config, req.user.id, "route", SPARK_MODEL, 1, upload.id);
          const subjects = (cls?.subjects || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 8);
          if (subjects.length) {
            baseConcepts = Array.from(new Set([...subjects, ...SPARK_FALLBACK_CONCEPTS])).slice(0, 14);
          }
        } catch {
          baseConcepts = BROAD_CONCEPTS;
        }
      }
      recordUsage(db, req.user.id, "sam", 1);
      const fn = detectFn || runDetect;
      const out = await fn({ dataDir, upload, time: Number(req.body?.time) || 0, extraConcepts: extra, ...(baseConcepts ? { baseConcepts } : {}) });
      if (!out.cached) recordSpend(db, config, req.user.id, "detect", "sam-3.1", out.concepts.length, upload.id);
      res.json(publicDetect(out.result, out.frameIndex));
    } catch (error) {
      res.status(error?.retryable ? 503 : 502).json({ error: userError(error, "Detection failed. Try another frame or a shorter clip.", /temporarily unavailable/i) });
    }
  };
  api.post("/detect", detectHandler(false));
  api.post("/detect-custom", detectHandler(true));

  // Lite early upload: the site calls this (Lite tier only) once a frame is
  // detected, so the job's SAM cut is built and on Meta (Files API: no model
  // call, nothing booked) before Build is pressed. Fire-and-forget: the job
  // reuses it, or builds its own if it is missing or failed.
  api.post("/lite/prewarm", (req, res) => {
    if (killed(db, config)) return res.status(503).json({ error: "Service temporarily disabled (kill switch)." });
    if (rateLimited(clientKey(req), "lite-prewarm", config.rateJobsPerMin)) return res.status(429).json({ error: "Too many requests. Slow down and try again." });
    const upload = resolveUpload(req, res);
    if (!upload) return;
    const time = req.body?.time;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > upload.duration) return res.status(400).json({ error: "Choose a valid video frame." });
    const frameIndex = frameIndexFor(upload, time);
    try { requireLiteSeedSource(upload, frameIndex); } catch (error) { return res.status(400).json({ error: error.message }); }
    prewarmLiteSource({ upload, frameIndex }).catch(() => {});
    res.status(202).json({ ok: true });
  });

  api.post("/detect-box", async (req, res) => {
    if (killed(db, config)) return res.status(503).json({ error: "Service temporarily disabled (kill switch)." });
    if (rateLimited(clientKey(req), "detect-box", config.rateJobsPerMin)) return res.status(429).json({ error: "Too many selection requests. Slow down and try again." });
    const upload = resolveUpload(req, res);
    if (!upload) return;
    const time = req.body?.time ?? 0;
    let box;
    try {
      if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > upload.duration) throw new Error("Choose a valid video frame.");
      // Size and seed-in-clip rules only: tiers handle long clips at /jobs.
      requireLiteSeedSource(upload, frameIndexFor(upload, time));
      box = imageBoxPixels(req.body?.box, upload.width, upload.height);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const cost = estimateCents(config, "detect", 1);
    try {
      const out = await (boxDetectFn || runBoxDetect)({ dataDir, upload, time, box, actorId: req.user.id, onRequest: () => {
        const blocked = quotaCheck(db, config, req.user.id, 1, cost);
        if (blocked) throw Object.assign(new Error(blocked.error), { quotaStatus: blocked.status });
        // Reserve this one attempted call, including failed upstream responses.
        // This is estimated spend, not provider-internal/billing telemetry.
        recordUsage(db, req.user.id, "sam", 1);
        recordSpend(db, config, req.user.id, "detect", "sam-3.1", 1, upload.id);
      } });
      res.json(publicDetect(out.result, out.frameIndex));
    } catch (error) {
      if (error.quotaStatus) return res.status(error.quotaStatus).json({ error: error.message });
      if (error.message === IMAGE_FRAME_CHANGED) return res.status(409).json({ error: IMAGE_FRAME_CHANGED });
      if (error.message === BOX_SELECTION_NO_MATCH) return res.status(502).json({ error: BOX_SELECTION_NO_MATCH });
      // SDK/stream failures are not bad user geometry. Classify at this
      // HTTP boundary without adding retryable job errors to the runner.
      res.status(503).json({ error: "The segmentation service is temporarily unavailable. Try again in a minute." });
    }
  });

  // ---- route (Spark; permissive on Meta failure) ----
  api.post("/route", async (req, res) => {
    const check = quotaCheck(db, config, req.user.id, 1, estimateCents(config, "route", 1));
    if (check) return res.status(check.status).json({ error: check.error });
    const upload = resolveUpload(req, res);
    if (!upload) return;
    // Measured signals inform advice, never content eligibility. Avoid comparing
    // camera motion across cuts; a single still cannot establish motion either.
    let cuts = 0;
    let measured = null;
    if (!cameraFn) {
      try { cuts = await detectCuts(upload.path); } catch { /* optional signal */ }
      if (!cuts) {
        try { measured = await measureCamera(upload.path, upload.duration); } catch { /* optional signal */ }
      }
    } else {
      ({ cuts = 0, measured = null } = await cameraFn({ upload }));
    }
    recordUsage(db, req.user.id, "sam", 1);
    try {
      const fn = sparkFn || classifyUpload;
      const out = await fn({ upload, dataDir });
      recordSpend(db, config, req.user.id, "route", SPARK_MODEL, 1, upload.id);
      res.json(enrichRoute(out, measured, cuts));
    } catch {
      recordSpend(db, config, req.user.id, "route", SPARK_MODEL, 1, upload.id);
      const { PERMISSIVE_ROUTE } = await import("./spark.js");
      res.json(enrichRoute({ ...PERMISSIVE_ROUTE }, measured, cuts));
    }
  });

  // ---- jobs ----
  api.post("/jobs", async (req, res) => {
    try {
      if (killed(db, config)) return res.status(503).json({ error: "Service temporarily disabled (kill switch)." });
      if (rateLimited(clientKey(req), "jobs", config.rateJobsPerMin)) {
        return res.status(429).json({ error: "Too many job requests. Slow down and try again." });
      }
      const { tier } = req.body || {};
      if (!["lite", "basic", "advanced"].includes(tier)) {
        return res.status(400).json({ error: "Choose tier lite, basic or advanced." });
      }
      const upload = resolveUpload(req, res);
      if (!upload) return;
      const objectIds = Array.isArray(req.body?.objectIds) ? req.body.objectIds.map(Number).filter(Number.isFinite).slice(0, 3) : [];
      const prompt = String(req.body?.prompt || "").slice(0, 200);
      const seedTime = Number(req.body?.seedTime ?? 0);
      const selectionToken = req.body?.selectionToken;
      if (req.body?.selectionKind === "box" && !selectionToken) return res.status(400).json({ error: SELECTION_STALE_TEXT });
      if (selectionToken && !(objectIds.length === 1 && typeof selectionToken === "string" && selectionToken.length >= 1 && selectionToken.length <= 128 && (tier === "lite" || tier === "basic" || (tier === "advanced" && config.advancedBoxSelection)))) {
        return res.status(400).json({ error: config.advancedBoxSelection
          ? "Box selection is available for one Lite, Basic or Advanced subject. Use text detection for anything else."
          : "Box selection is available for one Lite or Basic subject. Use text detection for Advanced." });
      }
      // Completion mail always goes to the signed-in user's address; a
      // client-provided email field, if sent, is ignored (never trusted).
      const email = req.user.email || "";
      if (tier === "basic" && !basicAvailable(config)) {
        return res.status(503).json({ error: "Basic tier is not available yet. Try Lite." });
      }
      // Basic builds one subject: app detect ids cannot address pipeline
      // track ids (different model pass, different list), so extra
      // selections would be silently dropped. Refuse up front — before any
      // spend is booked — with an actionable line.
      if (tier === "basic" && objectIds.length > 1) {
        return res.status(400).json({ error: BASIC_MULTI_OBJECT_TEXT });
      }
      // Immutable selection snapshot: persisted at enqueue from the server's
      // exact cached detect for upload+seed frame (label + normalized bbox
      // + seed frame). Never trust client-supplied geometry; never re-resolve
      // a persisted numeric id against a different detect ordering. A missing
      // or stale cache (unknown id, no entry, cold restart) rejects here
      // before any spend with an actionable re-pick line — never a silent
      // substitution. Prompt-only jobs (no clicked ids) stay explicitly
      // automatic and persist no snapshot.
      let selectionSnapshot = "";
      let selectionIsV2Box = false;
      if (objectIds.length) {
        const snapshot = snapshotFromCache(upload, seedTime, objectIds, selectionToken);
        if (!snapshot) return res.status(400).json({ error: SELECTION_STALE_TEXT });
        if (snapshot.version === 2 && tier === "advanced" && !config.advancedBoxSelection) return res.status(400).json({ error: "Box selection is available for Lite or Basic only." });
        if (snapshot.version === 2 && tier === "advanced" && objectIds.length !== 1) return res.status(400).json({ error: "Box selection builds one Advanced subject. Re-pick a single object." });
        if (snapshot.version === 2 && (tier === "basic" || tier === "advanced")) {
          try {
            // Basic: long or variable-rate clips run on a constant-rate cut.
            if (tier === "basic") requireBasicSeedSource(upload, snapshot.frameIndex);
            else {
              requireBasicSelectedSource(upload, snapshot.frameIndex);
              await probeBasicClock(upload.path, upload.fps, upload.frames);
            }
          } catch (error) {
            return res.status(400).json({ error: error?.message === BASIC_SPAN_TEXT ? BASIC_SPAN_TEXT : BASIC_CLOCK_TEXT });
          }
        }
        if (tier === "lite") {
          try { requireLiteSeedSource(upload, snapshot.frameIndex); }
          catch (error) { return res.status(400).json({ error: error.message }); }
        }
        // Advanced tracks one concept per pass: different-label selections
        // would need extra tracking passes, so refuse BEFORE any spend is
        // booked. Same-label multi (up to 3) resolves against the one pass.
        if (tier === "advanced" && new Set(snapshot.objects.map((o) => o.label)).size > 1) {
          return res.status(400).json({ error: ADV_MULTI_CONCEPT_TEXT });
        }
        selectionSnapshot = JSON.stringify(snapshot);
        selectionIsV2Box = snapshot.version === 2;
      }
      const objectCount = objectIds.length || 1;
      const samFrames = tier === "advanced" ? 0 : estimateSamFrames(upload, objectCount);
      // Advanced runs on the owner's GPU box with the same Meta key: book its tracking passes too (20 frames/s of clip, <= 120 s).
      const bookedFrames = tier === "advanced" ? Math.ceil(Math.min(upload.duration, 120) * 20) : samFrames;
      const jobEst = estimateCents(config, "job", bookedFrames) + estimateCents(config, "detect", 14) + ((tier === "basic" || (tier === "advanced" && selectionIsV2Box)) ? estimateCents(config, "image", 2) : 0);
      const check = quotaCheck(db, config, req.user.id, samFrames, jobEst);
      if (check) return res.status(check.status).json({ error: check.error });

      const id = crypto.randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO jobs(id,user_id,upload_id,tier,object_ids,prompt,seed_time,title,subject,email,selection_snapshot,status,stage,detail,progress,sam_frames,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(
        id, req.user.id, upload.id, tier, JSON.stringify(objectIds), prompt,
        Number.isFinite(seedTime) ? Math.max(0, seedTime) : 0,
        String(req.body?.title || "").slice(0, 120), String(req.body?.subject || "").slice(0, 120),
        email, selectionSnapshot, tier === "advanced" ? "queued_gpu" : "queued",
        tier === "advanced" ? "queued" : "queued", "Waiting for a runner…", 0, samFrames, now, now
      );
      if (bookedFrames > 0) recordSpend(db, config, req.user.id, "job", "sam-3.1", bookedFrames, id);
      if (tier === "basic" || (tier === "advanced" && selectionIsV2Box)) recordSpend(db, config, req.user.id, "image", "muse-image-1.0", 2, id);
      if (tier !== "advanced") pump();
      res.json({ jobId: id });
    } catch (error) {
      res.status(500).json({ error: userError(error, "Could not create the job. Try again.") });
    }
  });

  api.get("/jobs/:id", (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job || !ownerOrAdmin(req, job.user_id)) return res.status(404).json({ error: "Unknown job." });
    res.json(publicJob(db, config, job));
  });

  api.get("/me/jobs", (req, res) => {
    const rows = db.prepare("SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.user.id);
    res.json({ jobs: rows.map((j) => publicJob(db, config, j)) });
  });

  // ---- live Advanced: the world builder, one step at a time in front of the user (lib/live.js) ----
  // Only where this server has the GPU and the builder; elsewhere Advanced stays the queued worker job.
  const liveSite = siteRootFor(import.meta.url);
  const liveBusy = new Set(); // one live build per user unless the local demo opts into concurrency
  // Saved Lite reads existing observations; a completed job never needs a RAM Run.
  const litePacks = new Map();
  async function savedLitePack(job) {
    const key = `${job.id}:${job.result}`;
    if (litePacks.has(key)) return litePacks.get(key);
    const pending = (async () => {
      const result = JSON.parse(job.result), run = liveLiteRun(result);
      if (!run) throw new Error("Missing saved run reference.");
      const root = await fsp.realpath(path.join(dataDir, "uploads", job.upload_id));
      const packs = /^live-[0-9a-f]{8}$/.test(result.pack || "") ? [result.pack] : (await fsp.readdir(root, { withFileTypes: true })).filter(p => p.isDirectory() && /^live-[0-9a-f]{8}$/.test(p.name)).map(p => p.name);
      for (const pack of packs) {
        try {
          const dir = await fsp.realpath(path.join(root, pack));
          if (!dir.startsWith(root + path.sep)) continue;
          const manifest = JSON.parse(await fsp.readFile(path.join(dir, "lite.json"), "utf8"));
          if (typeof manifest.frame === "string" && manifest.frame.startsWith(`/api/live/${run}/files/`)) return { dir, manifest, run };
        } catch { /* another build's missing/incomplete pack is not this result */ }
      }
      throw new Error("Saved Lite pack is unavailable.");
    })();
    litePacks.set(key, pending);
    try { return await pending; } catch (error) { if (litePacks.get(key) === pending) litePacks.delete(key); throw error; }
  }
  const liteManifest = (job, saved) => {
    const prefix = `/api/live/${saved.run}/files/`, base = `/api/live/lite/${job.id}/files/`;
    const rebase = value => typeof value === "string" && value.startsWith(prefix) ? base + value.slice(prefix.length) : value;
    return { ...saved.manifest, sourceRun: saved.run, frame: rebase(saved.manifest.frame), ...(Array.isArray(saved.manifest.ghosts) ? { ghosts: saved.manifest.ghosts.map(g => ({ ...g, url: rebase(g.url) })) } : {}) };
  };
  api.get("/live/lite/:id/files/*", async (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job || job.tier !== "lite" || job.status !== "done" || !ownerOrAdmin(req, job.user_id)) return res.status(404).end();
    try {
      const saved = await savedLitePack(job), name = req.params[0];
      if (name === "lite.json") return res.set("Cache-Control", "private, no-store").json(liteManifest(job, saved));
      if (!/\.(png|jpe?g|webp)$/i.test(name || "")) return res.status(404).end();
      const file = await fsp.realpath(path.resolve(saved.dir, name));
      if (!file.startsWith(saved.dir + path.sep) || !(await fsp.stat(file)).isFile()) return res.status(404).end();
      return res.sendFile(file, { headers: { "Cache-Control": "private, max-age=3600" } });
    } catch { return res.status(404).json({ error: "Saved result is unavailable." }); }
  });
  api.get("/live/saved/:run", async (req, res) => {
    if (!/^r[0-9a-f]{10}$/.test(req.params.run)) return res.status(404).end();
    const jobs = db.prepare("SELECT * FROM jobs WHERE tier='lite' AND status='done' AND (user_id=? OR ?=1) AND instr(result,?)>0").all(req.user.id, req.user.role === "owner" ? 1 : 0, req.params.run);
    const job = jobs.find(job => { try { return liveLiteRun(JSON.parse(job.result)) === req.params.run; } catch { return false; } });
    if (!job) return res.status(404).end();
    try { return res.set("Cache-Control", "private, no-store").json(liteManifest(job, await savedLitePack(job))); }
    catch { return res.status(404).json({ error: "Saved result is unavailable." }); }
  });
  // Basic packs live with the upload, and remain accessible to their owner after a restart.
  api.get("/live/basic/:id/files/:file", (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job || job.tier !== "basic" || !ownerOrAdmin(req, job.user_id)) return res.status(404).end();
    let result;
    try { result = JSON.parse(job.result); } catch { return res.status(404).end(); }
    if (!/^live-[0-9a-f]{8}$/.test(result?.pack || "") || !["cloud.json", "motion.json", "bg.f32", "bg.u8", "trail.f32", "trail.u8", "plate_hi.jpg"].includes(req.params.file)) return res.status(404).end();
    res.sendFile(path.resolve(dataDir, "uploads", job.upload_id, result.pack, "world", "live", req.params.file));
  });
  api.use("/live", liveRouter({
    resolveJob(req, res, key) {
      const upload = resolveUpload({ body: { uploadId: key }, user: req.user }, res);
      if (!upload) return null;
      return { videoPath: upload.path, jobDir: path.join(dataDir, "uploads", upload.id), uploadId: upload.id, width: upload.width, height: upload.height, fps: upload.fps, frameCount: upload.frames, duration: upload.duration };
    },
    owner: (req) => req.user?.id ?? null,
    guard(req, res, kind, job, info) {
      const refuse = (status, error) => { res.status(status).json({ error }); return false; };
      if (!liveAvailable()) return refuse(503, "Live building is not available on this server.");
      if (killed(db, config)) return refuse(503, "Service temporarily disabled (kill switch).");
      if (kind === "detect") {
        const check = quotaCheck(db, config, req.user.id, 1, estimateCents(config, "route", 1) + estimateCents(config, "detect", 14));
        if (check) return refuse(check.status, check.error);
      }
      if (kind === "detect-more") {
        if (rateLimited(clientKey(req), "detect-box", config.rateJobsPerMin)) return refuse(429, "Too many selection requests. Slow down and try again.");
        const check = quotaCheck(db, config, req.user.id, 1, estimateCents(config, "route", 1) + estimateCents(config, "detect", 1));
        if (check) return refuse(check.status, check.error);
      }
      if (kind === "build") {
        if (rateLimited(clientKey(req), "jobs", config.rateJobsPerMin)) return refuse(429, "Too many job requests. Slow down and try again.");
        const labels = new Set((info?.objects || []).map((o) => o.label));
        if (!info?.objects?.length || info.objects.length > 3) return refuse(400, "Pick one to three subjects.");
        if (labels.size > 1) return refuse(400, ADV_MULTI_CONCEPT_TEXT);
        if (!config.concurrentLiveBuilds && liveBusy.has(req.user.id)) return refuse(409, "You already have a build running. Wait for it to finish.");
        const frames = Math.ceil(Math.min(job.duration, 120) * 30 / (info.frameStride ?? 1));
        const check = quotaCheck(db, config, req.user.id, 0, estimateCents(config, "job", frames) + estimateCents(config, "detect", 14));
        if (check) return refuse(check.status, check.error);
        if (!config.concurrentLiveBuilds) liveBusy.add(req.user.id);
      }
      return true;
    },
    spend: (req, job) => (kind, model, units) => {
      if (kind === "detect") recordUsage(db, req.user.id, "sam", 1);
      recordSpend(db, config, req.user.id, kind, model, units, job.uploadId);
    },
    clipDir: path.join(liveSite, "assets", "clips", "uploads"),
    site: liveSite,
    onBuildAbort: (req) => liveBusy.delete(req.user.id),
    onBuildFinish(req, job, status, event, { objects, time, tier = "advanced" }) {
      liveBusy.delete(req.user.id);
      if (status === "cancelled") return; // stopped by the user: nothing to record
      const id = crypto.randomUUID();
      const now = Date.now();
      const subject = [...new Set(objects.map((o) => o.label))].join(", ").slice(0, 120);
      const done = status === "done";
      const result = done ? {
        id, tier, title: `${subject} ${tier}`, subject, viewer: tier === "lite" ? `lite.html?job=${id}` : tier === "basic" ? `basic-cloud.html?job=${id}` : event.viewer,
        ...(tier === "basic" || tier === "lite" ? { pack: event.pack } : {}),
        ...(tier === "lite" ? { runId: liveLiteRun(event) } : {}),
        thumb: tier === "basic" ? `/api/live/basic/${id}/files/plate_hi.jpg` : tier === "lite" ? `/api/live/lite/${id}/files/world/live/frames/f00001.jpg` : `assets/stable/${event.name}/env/plate_hi.jpg`, durationSec: Math.round(job.duration - time), bytes: 0,
        meta: { camera: tier === "lite" ? "unknown" : "fixed", category: "unknown", provenance: tier === "lite" ? ["sam-3.1", "muse-spark-1.3"] : ["sam-3.1", "muse-spark-1.3", "depth-anything-3"] },
      } : null;
      db.prepare(
        "INSERT INTO jobs(id,user_id,upload_id,tier,object_ids,prompt,seed_time,title,subject,email,selection_snapshot,status,stage,detail,progress,sam_frames,result,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(id, req.user.id, job.uploadId, tier, "[]", "", time, `${subject} ${tier}`, subject, req.user.email || "", "",
        done ? "done" : "failed", done ? "done" : "failed", done ? "Ready." : "", done ? 1 : 0, 0, result ? JSON.stringify(result) : null,
        done ? null : "The live build stopped. Try another frame or subject.", now, now);
    },
  }));

  // ---- publishing ----
  api.post("/jobs/:id/publish", (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job || !ownerOrAdmin(req, job.user_id)) return res.status(404).json({ error: "Unknown job." });
    if (job.status !== "done") return res.status(409).json({ error: "Only finished jobs can be published." });
    db.prepare("UPDATE jobs SET publish='pending', updated_at=? WHERE id=?").run(Date.now(), job.id);
    res.json({ ok: true, publish: "pending" });
  });

  api.post("/jobs/:id/unpublish", (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job || !ownerOrAdmin(req, job.user_id)) return res.status(404).json({ error: "Unknown job." });
    db.prepare("UPDATE jobs SET publish='unpublished', updated_at=? WHERE id=?").run(Date.now(), job.id);
    res.json({ ok: true, publish: "unpublished" });
  });

  // Deletes a finished/failed build and its files (the terms promise this). Running or queued jobs cannot be deleted.
  // The source upload goes too when no other build uses it.
  api.post("/jobs/:id/delete", async (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job || !ownerOrAdmin(req, job.user_id)) return res.status(404).json({ error: "Unknown job." });
    if (!["done", "failed"].includes(job.status)) return res.status(409).json({ error: "This build is still running. Try again when it has finished." });
    await fsp.rm(path.join(dataDir, "specimens", job.id), { recursive: true, force: true });
    db.prepare("DELETE FROM reports WHERE job_id=?").run(job.id);
    db.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
    const others = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE upload_id=?").get(job.upload_id).n;
    if (!others) {
      await fsp.rm(path.join(dataDir, "uploads", job.upload_id), { recursive: true, force: true });
      db.prepare("DELETE FROM uploads WHERE id=?").run(job.upload_id);
    }
    res.json({ ok: true });
  });

  // Gallery items are explicit picks from the stored result: no user ids,
  // emails, or other owner metadata ever leaves the server here.
  api.get("/gallery", (req, res) => {
    const rows = db.prepare("SELECT * FROM jobs WHERE publish='approved' AND status='done' ORDER BY updated_at DESC LIMIT 100").all();
    res.json({
      specimens: rows.map((j) => {
        let r = null;
        try {
          r = JSON.parse(j.result);
        } catch { /* ignore */ }
        if (!r) return null;
        return {
          id: j.id, tier: r.tier, title: r.title, subject: r.subject,
          viewer: r.viewer, thumb: r.thumb, durationSec: r.durationSec,
          bytes: r.bytes, meta: r.meta, publishedAt: j.updated_at,
        };
      }).filter(Boolean),
    });
  });

  api.post("/report", (req, res) => {
    const { jobId, reason } = req.body || {};
    if (!jobId || !jobRow(db, jobId)) return res.status(404).json({ error: "Unknown job." });
    db.prepare("INSERT INTO reports(id,job_id,reporter,reason,created_at) VALUES(?,?,?,?,?)")
      .run(crypto.randomUUID(), jobId, req.user.id, String(reason || "").slice(0, 1000), Date.now());
    res.json({ ok: true });
  });

  // ---- admin (owner role) ----
  const requireOwner = (req, res, next) => {
    if (!req.user || req.user.role !== "owner") return res.status(403).json({ error: "Owner role required." });
    next();
  };
  api.get("/admin/pending", requireOwner, (req, res) => {
    const rows = db.prepare("SELECT * FROM jobs WHERE publish='pending' ORDER BY updated_at ASC LIMIT 100").all();
    res.json({ pending: rows.map((j) => publicJob(db, config, j)) });
  });
  api.post("/admin/:id/approve", requireOwner, (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown job." });
    if (job.status !== "done") return res.status(409).json({ error: "Only finished jobs can be approved." });
    db.prepare("UPDATE jobs SET publish='approved', updated_at=? WHERE id=?").run(Date.now(), job.id);
    res.json({ ok: true, publish: "approved" });
  });
  api.post("/admin/:id/reject", requireOwner, (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown job." });
    db.prepare("UPDATE jobs SET publish='rejected', updated_at=? WHERE id=?").run(Date.now(), job.id);
    res.json({ ok: true, publish: "rejected" });
  });
  api.get("/admin/status", requireOwner, (req, res) => {
    const count = (sql) => db.prepare(sql).get().n;
    res.json({
      killed: killed(db, config),
      spendTodayCents: Math.round(spendGlobalTodayCents(db) * 10) / 10,
      capGlobalCents: config.maxGlobalCentsDay,
      jobsToday: globalJobsToday(db),
      capJobsToday: config.maxJobsGlobalDay,
      pending: count("SELECT COUNT(*) AS n FROM jobs WHERE publish='pending'"),
      running: count("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')"),
      queuedGpu: count("SELECT COUNT(*) AS n FROM jobs WHERE status='queued_gpu'"),
      reports: count("SELECT COUNT(*) AS n FROM reports"),
      worker: workerStatus(db, config),
    });
  });
  api.post("/admin/kill", requireOwner, (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    setKv(db, "kill", enabled ? "1" : "0");
    res.json({ ok: true, killed: enabled });
  });

  // ---- worker (token auth, mounted pre-gate in app.js) ----
  const worker = Router();
  const resultUpload = multer({
    dest: tmpDir,
    limits: { fileSize: config.workerResultMaxMB * 1024 * 1024, files: 2 },
  });

  // Worker liveness is not public: browsers get it from the authenticated GET /api/me and /api/jobs/:id.

  // Presigned-style download: the single-use HMAC token in the URL is the
  // auth (like S3 presigned URLs), so this sits before the bearer middleware.
  worker.get("/download/:uploadId", (req, res) => {
    const row = uploadRow(db, req.params.uploadId);
    if (!row) return res.status(404).end();
    if (!redeemDownloadToken(db, config, row.id, req.query.token)) return res.status(403).end();
    const file = path.join(dataDir, "uploads", row.id, "source.mp4");
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader("Content-Type", "video/mp4");
    fs.createReadStream(file).pipe(res);
  });

  worker.use((req, res, next) => {
    if (!workerAuth(req, config)) return res.status(401).json({ error: "Invalid worker token." });
    next();
  });

  worker.post("/claim", (req, res) => {
    heartbeat(db); // an authenticated idle worker is alive even when no job is claimed
    const workerId = String(req.body?.workerId || "gpu-0").slice(0, 80);
    const job = claimJob(db, config, workerId);
    if (!job) return res.status(204).end();
    const token = mintDownloadToken(db, config, job.upload_id);
    // The current worker matches this immutable server snapshot to video
    // geometry; detection IDs are never assumed equal across model requests.
    res.json({
      job: { id: job.id, tier: job.tier, uploadId: job.upload_id, seedTime: job.seed_time, prompt: job.prompt, subject: job.subject, title: job.title, objectIds: JSON.parse(job.object_ids || "[]"), selectionSnapshot: parseSelectionSnapshot(job.selection_snapshot) },
      downloadUrl: `/api/worker/download/${job.upload_id}?token=${token}`,
      leaseSec: config.workerLeaseSec,
      expiresAt: job.lease_expires,
    });
  });

  worker.post("/:id/progress", (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job || job.status !== "claimed") return res.status(404).json({ error: "Unknown claimed job." });
    const now = Date.now();
    db.prepare("UPDATE jobs SET stage=?, detail=?, progress=?, lease_expires=?, updated_at=? WHERE id=?")
      .run(String(req.body?.stage || "working").slice(0, 40), String(req.body?.detail || "").slice(0, 500), Number(req.body?.progress) || 0, now + config.workerLeaseSec * 1000, now, job.id);
    heartbeat(db);
    res.json({ ok: true });
  });

  // The worker reports a failure by reason code only; the user-facing text is fixed here, so no path, stack or
  // upstream message can reach a user. A failed claim is final (no endless re-queue after each lease expiry).
  const FAIL_TEXT = {
    no_subject: "We could not follow a clear subject through this clip. Try another clip or subject.",
    unsupported_camera: "We could not build a scene from this clip's camera movement. Try another clip.",
    too_long: "This clip is too long for the Advanced tier.",
    quality: "The Advanced build did not meet the quality bar for this clip.",
    internal: "The Advanced build failed. Try again later.",
    seed_stale: ADV_STALE_TEXT,
    seed_no_match: ADV_NO_MATCH_TEXT,
    seed_ambiguous: ADV_AMBIGUOUS_TEXT,
    multi_object: ADV_MULTI_CONCEPT_TEXT,
  };
  worker.post("/:id/fail", async (req, res) => {
    const job = jobRow(db, req.params.id);
    if (!job || job.status !== "claimed") return res.status(404).json({ error: "Unknown claimed job." });
    const text = FAIL_TEXT[req.body?.reason] || FAIL_TEXT.internal;
    db.prepare("UPDATE jobs SET status='failed', stage='failed', detail=?, error=?, lease_expires=0, updated_at=? WHERE id=?")
      .run(text, text, Date.now(), job.id);
    heartbeat(db);
    await notifyJobFailed({ job, reason: text }); // never throws: mail failure must not change the job outcome
    res.json({ ok: true });
  });

  // Only our crafted validation messages go back to the worker; anything
  // else (fs errors, unzip internals) becomes a generic rejection.
  const SAFE_RESULT_ERROR =
    /^(Not a zip|Corrupt zip|Unsupported zip|Symlink rejected|Bad file|Absolute path|Unsafe path|Zip holds|Unpacked size|Result JSON|Result package|Unknown claimed|Basic runner)/;
  worker.post("/:id/result", (req, res, next) => {
    resultUpload.single("package")(req, res, (err) => {
      if (err) {
        return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
          error: err.code === "LIMIT_FILE_SIZE" ? "Result package exceeds the size limit." : "Result upload failed.",
        });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const job = jobRow(db, req.params.id);
      if (!job || job.status !== "claimed") {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: "Unknown claimed job." });
      }
      if (!req.file) return res.status(400).json({ error: "Zip package is required." });
      let meta = {};
      try {
        meta = JSON.parse(req.body?.result || "{}");
      } catch {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Result JSON is unreadable." });
      }
      const buffer = await fsp.readFile(req.file.path);
      fs.unlink(req.file.path, () => {});
      const files = extractZip(buffer, path.join(dataDir, "specimens", job.id), {
        maxFiles: config.workerResultMaxFiles,
        maxBytes: config.workerResultMaxMB * 1024 * 1024,
      });
      const dest = path.join(dataDir, "specimens", job.id);
      const bytes = await writePackage(dest, files);
      const webps = files.filter((f) => f.name.toLowerCase().endsWith(".webp")).map((f) => f.name).sort();
      const result = {
        id: job.id, tier: job.tier,
        title: String(meta.title || job.title || "world").slice(0, 120),
        subject: String(meta.subject || job.subject || "subject").slice(0, 120),
        // worker-supplied strings end up in an iframe/img: accept only safe shapes, else fall back to defaults
        viewer: /^(stable|view-basic|view-lite)\.html\?[A-Za-z0-9_=&.-]{1,120}$/.test(String(meta.viewer || "")) ? String(meta.viewer) : `stable.html?specimen=${job.id}`,
        thumb: new RegExp(`^specimens/${job.id}/[A-Za-z0-9_./-]{1,100}\\.webp$`).test(String(meta.thumb || "")) && !String(meta.thumb).includes("..")
          ? String(meta.thumb)
          : (webps[0] ? `specimens/${job.id}/${webps[0]}` : ""),
        durationSec: Number(meta.durationSec) || 0,
        bytes,
        meta: { camera: "unknown", category: "unknown", provenance: mergeWorkerProvenance(meta.provenance), ...(["full", "narrow"].includes(meta.quality) ? { quality: meta.quality } : {}) },
      };
      const now = Date.now();
      db.prepare("UPDATE jobs SET status='done', stage='done', detail='Ready.', progress=1, result=?, error=NULL, lease_expires=0, updated_at=? WHERE id=?")
        .run(JSON.stringify(result), now, job.id);
      await fsp.writeFile(path.join(dest, "meta.json"), JSON.stringify(result, null, 2)).catch(() => {});
      heartbeat(db);
      await notifyJobDone({ job, result, dataDir }); // never throws: mail failure must not fail the job
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: userError(error, "Result rejected. Try again.", SAFE_RESULT_ERROR) });
    }
  });

  return { api, worker };
}
