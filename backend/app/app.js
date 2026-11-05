import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { loadConfig } from "./config.js";
import { openDb, recoverJobs, estimateCents, recordSpend } from "./db.js";
import { loadGateInstaller } from "./gate-loader.js";
import { userError, SAFE_JOB_ERROR, exactAllowlist, eitherAllow } from "./errors.js";
import { quotaCheck } from "./quotas.js";
import { installStatic, siteRootFor } from "./static.js";
import { buildApi } from "./routes.js";
import { notifyJobDone, notifyJobFailed } from "./mailer.js";
import { runLiteJob } from "./runner-lite.js";
import { runBasicJob, basicAvailable, BASIC_SAFE_ERRORS, killBasicChild } from "./runner-basic.js";
import { isCancelError } from "../lib/cancel.js";
import { BOX_SELECTION_NO_MATCH } from "../lib/sam-image-result.mjs";
import { IMAGE_FRAME_CHANGED } from "../lib/sam-image-seed.mjs";

// Stored job errors are returned by GET /api/jobs, so they must be
// user-safe. Runner-authored Basic lines pass through by EXACT match
// (cannot widen when reworded); the legacy substring regex still covers
// Lite/detect/upload lines. Tests pin every BASIC_SAFE_ERRORS member.
const JOB_ERROR_ALLOW = eitherAllow(exactAllowlist([...BASIC_SAFE_ERRORS, BOX_SELECTION_NO_MATCH, IMAGE_FRAME_CHANGED]), SAFE_JOB_ERROR);

// Production app factory. options:
//   configOverrides  shallow env-equivalent overrides (tests)
//   runners          { lite, basic } job runners (tests stub these)
//   detectFn, boxDetectFn, sparkFn, cameraFn  injected detect/classify/camera-measure (tests stub these)
//   gate             gate installer override (tests use the fake gate)
//   skipRecovery     keep `running` rows as-is (tests)
export async function createApp(options = {}) {
  const config = { ...loadConfig(), ...(options.configOverrides || {}) };
  // Never invent credentials: only forward an explicit proxy URL, and only
  // use the dummy key outside production (lib/meta.js needs *something*).
  if (!process.env.META_BASE_URL && config.metaBaseUrl) process.env.META_BASE_URL = config.metaBaseUrl;
  if (!process.env.META_API_KEY && config.nodeEnv !== "production") process.env.META_API_KEY = "dummy";

  const dataDir = options.dataDir || config.dataDir;
  for (const dir of ["uploads", "specimens", "models", "tmp"]) {
    fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  }
  const db = openDb(dataDir);
  const recovery = options.skipRecovery ? { failed: 0, requeued: 0 } : recoverJobs(db);

  // Per-app shutdown scope. stop() aborts it so in-flight runners refuse
  // every further spending step and spawn; the signal is scoped to THIS
  // app instance, never a module-global flag, so a later createApp in the
  // same process starts uncancelled. Custom (test/stub) runners receive it
  // too and may ignore it.
  const shutdown = new AbortController();
  const withSignal = (args) => ({ ...args, signal: args.signal ?? shutdown.signal });
  const runners = {
    lite: options.runners?.lite || ((args) =>
      runLiteJob({ db, dataDir, fileIdCache, config, ...withSignal(args) })),
    basic: options.runners?.basic || ((args) =>
      runBasicJob({ db, config, dataDir, ...withSignal(args) })),
  };
  const detectFn = options.detectFn || null;
  const sparkFn = options.sparkFn || null;
  const cameraFn = options.cameraFn || null;
  const fileIdCache = new Map(); // uploadId -> Meta file id (whole-clip uploads)

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  // No global body parser: nothing is buffered or parsed before a request is allowed in. The worker router and
  // /api get their own small parsers (the latter only after the gate).

  // Health + token-authenticated worker API sit before the gate: the worker
  // has a bearer token, not a session. REQUEST to main session: the real
  // gate must likewise let /api/health and /api/worker/* through (it answers
  // only session-less browser traffic).
  const { api, worker } = buildApi({ db, config, dataDir, runners, detectFn, boxDetectFn: options.boxDetectFn, sparkFn, cameraFn, pump });
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  // One id per running build, so a tab left open across a deploy can tell it is stale and reload.
  const BUILD_ID = process.env.RAILWAY_DEPLOYMENT_ID || `boot-${Date.now()}`;
  app.get("/api/build", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json({ build: BUILD_ID }); });
  app.use("/api/worker", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }, express.json({ limit: "64kb" }), worker);

  const gate = options.gate || (await loadGateInstaller());
  gate.installGate(app, { dataDir });

  app.use("/api", express.json({ limit: "256kb" }), api);
  installStatic(app, { siteRoot: siteRootFor(import.meta.url), specimensDir: path.join(dataDir, "specimens") });

  // JSON 404/500 for anything API that fell through.
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
  // eslint-disable-next-line no-unused-vars
  app.use("/api", (err, req, res, next) => {
    res.status(err?.status || 500).json({ error: err?.message || "Server error." });
  });

  // ---- local queue: one Lite and one Basic job at a time, side by side ----
  // A Basic job can wait minutes on Meta's image model; a Lite job should not queue behind that wait.
  const lanes = new Set();
  let closed = false;
  async function pump() {
    if (closed) return;
    const busy = [...lanes];
    const next = db
      .prepare(`SELECT * FROM jobs WHERE status='queued' AND tier IN ('lite','basic') AND not_before<=?${busy.length ? ` AND tier NOT IN (${busy.map(() => "?").join(",")})` : ""} ORDER BY created_at ASC LIMIT 1`)
      .get(Date.now(), ...busy);
    if (!next) return;
    lanes.add(next.tier);
    setImmediate(pump); // the other lane may have work too
    try {
      const upload = db.prepare("SELECT * FROM uploads WHERE id=?").get(next.upload_id);
      if (!upload) throw new Error("Upload is gone.");
      const uploadFull = { ...upload, path: path.join(dataDir, "uploads", upload.id, "source.mp4") };
      if (!fs.existsSync(uploadFull.path)) throw new Error("Upload is gone.");
      db.prepare("UPDATE jobs SET status='running', stage='starting', updated_at=? WHERE id=?").run(Date.now(), next.id);
      const onProgress = ({ stage, detail, progress }) => {
        // Basic progress lines carry no fraction; keep the stored value then.
        let keep = progress;
        if (!Number.isFinite(keep)) {
          try {
            keep = db.prepare("SELECT progress FROM jobs WHERE id=?").get(next.id)?.progress ?? 0;
          } catch {
            keep = 0;
          }
        }
        db.prepare("UPDATE jobs SET stage=?, detail=?, progress=?, updated_at=? WHERE id=?")
          .run(stage, detail, keep, Date.now(), next.id);
      };
      const runner = next.tier === "basic" ? runners.basic : runners.lite;
      if (next.tier === "basic" && !basicAvailable(config) && !options.runners?.basic) {
        throw new Error("Basic runner disappeared.");
      }
      const result = await runner({ db, config, dataDir, fileIdCache, job: next, upload: uploadFull, onProgress });
      db.prepare("UPDATE jobs SET status='done', stage='done', detail='Ready.', progress=1, result=?, error=NULL, updated_at=? WHERE id=?")
        .run(JSON.stringify({ ...result, id: next.id, tier: next.tier }), Date.now(), next.id);
    } catch (error) {
      // Shutdown cancellation is neither a failure nor a retry: no error
      // shaping, no retry reservation, no requeue, no spend. The row stays
      // `running` for boot recovery (like a killed process) while the lanes
      // release in `finally` below. Checked first so a cancelled job is
      // dropped even when the app has not closed yet.
      if (isCancelError(error)) return;
      try {
        if (error?.message === "Basic runner busy; job was re-queued.") {
          db.prepare("UPDATE jobs SET status='queued', updated_at=? WHERE id=? AND status='running'").run(Date.now(), next.id);
        } else if (!closed && UPSTREAM_BUSY.test(`${error?.message ?? error}`) && next.attempts + 1 < config.jobAttempts) {
          // Conservative retry reservation: a retry re-spends (tracking +
          // detect, plus the image edit for Basic), so it must fit under
          // the per-user and global day budgets BEFORE it is queued —
          // otherwise a retry storm during an outage spends past the caps.
          // No refund on failure: failed calls can still be billed, so the
          // initial booking and every reservation stay on the ledger.
          const retryFrames = Number(next.sam_frames) || 0;
          const retryEst = estimateCents(config, "job", retryFrames)
            + estimateCents(config, "detect", 14)
            + (next.tier === "basic" ? estimateCents(config, "image", 2) : 0);
          const quota = quotaCheck(db, config, next.user_id, retryFrames, retryEst);
          if (quota) {
            // Fail safely: quota texts are crafted-safe static strings, so
            // they are stored directly (never through the generic fallback).
            db.prepare("UPDATE jobs SET status='failed', stage='failed', detail=?, error=?, updated_at=? WHERE id=?")
              .run(quota.error, quota.error, Date.now(), next.id);
          } else {
            // Mirror the enqueue booking (routes.js): reserve the frames
            // and the Basic image edit the retry is about to spend.
            if (retryFrames > 0) recordSpend(db, config, next.user_id, "job", "sam-3.1", retryFrames, next.id);
            if (next.tier === "basic") recordSpend(db, config, next.user_id, "image", "muse-image-1.0", 2, next.id);
            // Meta is in a bad patch: put the job back with a delay so other users' jobs are not blocked behind its wait.
            const attempts = next.attempts + 1;
            const delay = config.jobRetryPauseMs * Math.min(attempts, 5);
            db.prepare("UPDATE jobs SET status='queued', stage='waiting', detail=?, attempts=?, not_before=?, updated_at=? WHERE id=?")
              .run(`Meta's model service is busy; trying again (${attempts}/${config.jobAttempts - 1}).`, attempts, Date.now() + delay, Date.now(), next.id);
            const timer = setTimeout(() => { if (!closed) pump(); }, delay + 50);
            timer.unref?.();
          }
        } else if (UPSTREAM_BUSY.test(`${error?.message ?? error}`)) {
          const text = "Meta's model service was temporarily unavailable. Please try again in a few minutes.";
          db.prepare("UPDATE jobs SET status='failed', stage='failed', detail=?, error=?, updated_at=? WHERE id=?")
            .run(text, text, Date.now(), next.id);
        } else {
          // Stored errors are returned by GET /api/jobs, so they must be
          // user-safe; the full detail already went to the server log.
          const safe = userError(error, `The ${next.tier} build failed. Try another frame or clip.`, JOB_ERROR_ALLOW);
          db.prepare("UPDATE jobs SET status='failed', stage='failed', detail=?, error=?, updated_at=? WHERE id=?")
            .run(safe, safe, Date.now(), next.id);
        }
      } catch {
        // DB closed mid-run (teardown); nothing left to record.
      }
    } finally {
      lanes.delete(next.tier);
      if (!closed) setImmediate(pump);
      // Ready / stopped email for a build that ended this run (requeues and shutdown-cancel stay silent).
      try {
        const row = db.prepare("SELECT status, result, error FROM jobs WHERE id=?").get(next.id);
        if (row?.status === "done") notifyJobDone({ job: next, result: JSON.parse(row.result || "{}"), dataDir });
        else if (row?.status === "failed") notifyJobFailed({ job: next, reason: row.error });
      } catch {
        // DB closed mid-run (teardown); no email.
      }
    }
  }
  pump();

  // Graceful stop: refuse new work, kill this app's owned Basic child tree
  // first, then abort its in-flight runners (they reject cancelled before
  // any further spend or spawn) — but leave the DB open so genuinely
  // finished work can still record its outcome. index.js calls this on
  // SIGTERM/SIGINT before closing the server; close() (tests/teardown)
  // stops and then closes the DB (ordering preserved).
  function stop() {
    closed = true;
    // Tree-kill BEFORE the abort, scoped to this app: the abort marks the
    // execFile child killed at once, which would hide its whole tree from a
    // later kill and orphan the Python/ffmpeg grandchildren. Scoping keeps
    // other apps' runs and children in the same process untouched.
    killBasicChild(shutdown.signal);
    try { shutdown.abort(); } catch { /* already aborted */ }
  }
  function close() {
    stop();
    try {
      db.close();
    } catch { /* already closed */ }
  }

  return {
    app, db, config, dataDir, pump,
    recovery,
    gateFake: Boolean(gate.fake),
    stop,
    close,
  };
}

// Transient upstream trouble worth another attempt: Meta's intermittent 404 model_not_found, connection drops, 429/5xx.
// `fetch failed`/`ECONNRESET` are raw network drops (the Basic mapper
// already rewrites them; this lets other tiers' raw errors retry too).
// Exported for unit tests.
export const UPSTREAM_BUSY = /model was not found|model_not_found|temporarily unavailable|connection error|fetch failed|ECONNRESET|\b(429|502|503|504)\b/i;

export function newId() {
  return crypto.randomUUID();
}
