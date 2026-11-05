import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// SQLite (built-in node:sqlite, WAL mode). Tables:
//   uploads  one row per ingested clip
//   jobs     one row per tier job (lite/basic run locally, advanced is GPU-claimed)
//   usage    per-day Meta-call counters that are not jobs (detect, route)
//   kv       misc flags (kill switch set via the admin endpoint)
//   tokens   single-use worker download tokens (by id)
//   reports  user reports against published specimens
//   heartbeat single-row worker liveness marker

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "app.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, filename TEXT NOT NULL,
      bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      fps REAL NOT NULL, frames INTEGER NOT NULL, duration REAL NOT NULL,
      rights INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, created_at);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, upload_id TEXT NOT NULL,
      tier TEXT NOT NULL, object_ids TEXT NOT NULL DEFAULT '[]', prompt TEXT NOT NULL DEFAULT '',
      seed_time REAL NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      selection_snapshot TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
      progress REAL NOT NULL DEFAULT 0, result TEXT, error TEXT,
      sam_frames INTEGER NOT NULL DEFAULT 0, publish TEXT NOT NULL DEFAULT 'unpublished',
      lease_expires INTEGER NOT NULL DEFAULT 0, worker_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, lease_expires);
    CREATE INDEX IF NOT EXISTS idx_jobs_publish ON jobs(publish, status);
    CREATE TABLE IF NOT EXISTS usage (
      day TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY, upload_id TEXT NOT NULL,
      expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, reporter TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS heartbeat (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS spend (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      model TEXT NOT NULL, units REAL NOT NULL, est_cents REAL NOT NULL,
      ref TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spend_user ON spend(user_id, created_at);
  `);
  // retry bookkeeping + immutable selection snapshot (added later: tolerate databases created before these columns existed)
  for (const col of ["attempts INTEGER NOT NULL DEFAULT 0", "not_before INTEGER NOT NULL DEFAULT 0", "selection_snapshot TEXT NOT NULL DEFAULT ''"]) {
    try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  return db;
}

export const todayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const dayStart = (now = Date.now()) => Date.parse(new Date(now).toISOString().slice(0, 10));

// Jobs left mid-flight by a restart: local runs become failed (their
// in-memory progress is gone); GPU claims return to the queue so a worker
// can pick them up again. Returns counts for the boot log.
export function recoverJobs(db) {
  const now = Date.now();
  // Interrupted local runs fail: their in-memory progress is gone. Stage
  // and detail are reset too, so the job card does not show a stale
  // pipeline stage next to the restart error. (Retry caches under the
  // data dir are intentionally left alone: a resubmitted job resumes past
  // completed tracking chunks instead of re-spending.)
  const failed = db
    .prepare("UPDATE jobs SET status='failed', stage='failed', detail='The server restarted during the run. Please submit the job again.', error='server restarted during run', updated_at=? WHERE status IN ('running','building')")
    .run(now);
  const requeued = db
    .prepare("UPDATE jobs SET status='queued_gpu', worker_id='', lease_expires=0, updated_at=? WHERE status='claimed'")
    .run(now);
  return { failed: Number(failed.changes), requeued: Number(requeued.changes) };
}

export function getKv(db, key) {
  const row = db.prepare("SELECT v FROM kv WHERE k=?").get(key);
  return row ? row.v : null;
}

export function setKv(db, key, value) {
  db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key, value);
}

export function recordUsage(db, userId, kind, n) {
  const day = todayKey();
  db.prepare(
    "INSERT INTO usage(day,user_id,kind,n) VALUES(?,?,?,?) ON CONFLICT(day,user_id,kind) DO UPDATE SET n=n+excluded.n"
  ).run(day, userId, kind, n);
}

// Dollar-cost ledger (finding: every Meta call is booked). kinds: 'detect'
// (units = concepts swept), 'route' (units = 1 Spark call), 'job'
// (units = SAM video frames reserved). Prices are rough planning estimates
// from env, not bills; actual billing is via Meta.
export function estimateCents(config, kind, units) {
  if (kind === "detect") return units * config.priceSamImageCents;
  if (kind === "job") return units * config.priceSamVideoFrameCents;
  if (kind === "route") return units * config.priceSparkCallCents;
  if (kind === "image") return units * config.priceMuseImageCents;
  return 0;
}

export function recordSpend(db, config, userId, kind, model, units, ref = "") {
  const est = estimateCents(config, kind, Number(units) || 0);
  db.prepare("INSERT INTO spend(id,user_id,kind,model,units,est_cents,ref,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, kind, model, Number(units) || 0, est, String(ref || ""), Date.now());
  return est;
}

export function spendTodayCents(db, userId) {
  const row = db.prepare("SELECT COALESCE(SUM(est_cents),0) AS s FROM spend WHERE user_id=? AND created_at>=?")
    .get(userId, dayStart());
  return Math.round(Number(row.s) * 100) / 100;
}

export function spendGlobalTodayCents(db) {
  const row = db.prepare("SELECT COALESCE(SUM(est_cents),0) AS s FROM spend WHERE created_at>=?").get(dayStart());
  return Math.round(Number(row.s) * 100) / 100;
}

export function userSamFramesToday(db, userId) {
  const start = dayStart();
  const jobs = db
    .prepare("SELECT COALESCE(SUM(sam_frames),0) AS s FROM jobs WHERE user_id=? AND created_at>=?")
    .get(userId, start).s;
  const extra = db
    .prepare("SELECT COALESCE(SUM(n),0) AS s FROM usage WHERE day=? AND user_id=? AND kind='sam'")
    .get(todayKey(), userId).s;
  return Number(jobs) + Number(extra);
}

export function userJobsToday(db, userId) {
  return Number(
    db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE user_id=? AND created_at>=?").get(userId, dayStart()).c
  );
}

export function globalJobsToday(db) {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE created_at>=?").get(dayStart()).c);
}
