import path from "node:path";
import { fileURLToPath } from "node:url";

// All tunables come from the environment with safe defaults. Nothing here
// reads secret values; only their presence is ever logged (see index.js).
// Full documentation lives in backend/app/README.md.

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const str = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
};

export function loadConfig() {
  const nodeEnv = str("NODE_ENV", "development");
  return {
    port: num("PORT", 8000),
    dataDir: path.resolve(str("DATA_DIR", "./data")),
    nodeEnv,

    // Meta Model API. Local dev defaults to the credential-injecting proxy
    // (no key is ever handled here). PRODUCTION BUG FIX: in production the
    // default is empty, i.e. the real Meta API via META_API_KEY (Railway
    // secret) — defaulting to 127.0.0.1 would point at a proxy that does
    // not exist there and fail every Meta call. Set META_BASE_URL explicitly
    // if production should use a proxy instead.
    metaBaseUrl: str("META_BASE_URL", nodeEnv === "production" ? "" : "http://127.0.0.1:8787/v1"),

    // Spend-ledger estimates (cents per unit). Rough planning figures used
    // only for the ledger in /api/me and the report; actual billing is via
    // Meta. Override from env as pricing firms up.
    priceSamImageCents: num("PRICE_SAM_IMAGE_CENTS", 1),
    priceSamVideoFrameCents: num("PRICE_SAM_VIDEO_FRAME_CENTS", 0.05),
    priceSparkCallCents: num("PRICE_SPARK_CALL_CENTS", 0.2),
    priceMuseImageCents: num("PRICE_MUSE_IMAGE_CENTS", 1),

    // Hard dollar caps on the ledger above, checked BEFORE every Meta call (per user, and across all users, per UTC day).
    maxUserCentsDay: Math.round(num("MAX_USER_USD_DAY", 2) * 100),
    maxGlobalCentsDay: Math.round(num("MAX_GLOBAL_USD_DAY", 20) * 100),

    // Ask Spark for likely subjects before sweeping SAM image concepts on the
    // prompt-less /api/detect path (cuts ~69 image calls to ~a dozen).
    // Falls back to the full sweep whenever Spark fails or is empty.
    sparkConcepts: str("SPARK_CONCEPTS", "1") === "1",

    // Spend / abuse controls (documented in README.md).
    maxUploadMB: num("MAX_UPLOAD_MB", 100),
    maxClipSec: num("MAX_CLIP_SEC", 60),
    maxLongSide: num("MAX_LONG_SIDE", 1280),
    maxJobsPerUserDay: num("MAX_JOBS_PER_USER_DAY", 10),
    maxSamFramesPerUserDay: num("MAX_SAM_FRAMES_PER_USER_DAY", 3000),
    maxJobsGlobalDay: num("MAX_JOBS_GLOBAL_DAY", 200),
    rateUploadPerMin: num("RATE_UPLOAD_PER_MIN", 10),
    rateJobsPerMin: num("RATE_JOBS_PER_MIN", 30),

    // Worker protocol.
    workerToken: str("WORKER_TOKEN", ""),
    // Meta's serving fails in bursts of minutes; a job that hits one is retried before it is reported as failed.
  jobAttempts: num("JOB_ATTEMPTS", 6),
  jobRetryPauseMs: num("JOB_RETRY_PAUSE_MS", 60_000),
  workerLeaseSec: num("WORKER_LEASE_SEC", 600),
    // Advanced box selection (v2 snapshot -> worker build-specimen). Off by
    // default; enable only with WORKER_ADVANCED_SPECIMEN=1 on the GPU worker.
    // Advanced built in front of the user (live.html) where this server has the GPU and the world builder; LIVE_ADVANCED=0 turns it off.
    liveAdvanced: str("LIVE_ADVANCED", "1") === "1",
    // Result types offered to visitors (ENABLED_TIERS=lite pauses Basic and Advanced; existing builds stay viewable).
    enabledTiers: str("ENABLED_TIERS", "lite,basic,advanced").split(",").map((t) => t.trim()).filter((t) => ["lite", "basic", "advanced"].includes(t)),
    // Only the loopback demo opts in; the normal server retains one live build per user.
    concurrentLiveBuilds: false,
    advancedBoxSelection: str("ADVANCED_BOX_SELECTION", "") === "1",
    workerOnlineSec: num("WORKER_ONLINE_SEC", 900),
    workerResultMaxMB: num("WORKER_RESULT_MAX_MB", 500),
    workerResultMaxFiles: num("WORKER_RESULT_MAX_FILES", 2000),

    // Basic runner.
    basicRunner: str(
      "BASIC_RUNNER",
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../pipeline/basic/run-basic.mjs")
    ),

    // Mail.
    mailMode: str("MAIL_MODE", "console"),
    mailFrom: str("MAIL_FROM", "The Construct <noreply@localhost>"),

    // Kill switch (env side; the admin endpoint is the other side).
    killSwitchEnv: str("KILL_SWITCH", "") === "1",
  };
}
