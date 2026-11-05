import { getKv, setKv, globalJobsToday, userJobsToday, userSamFramesToday, spendTodayCents, spendGlobalTodayCents } from "./db.js";

// Spend/abuse controls, checked BEFORE every Meta call and before new
// uploads/jobs. Limits come from env (see config.js / README.md).

export const killed = (db, config) => config.killSwitchEnv || getKv(db, "kill") === "1";

export function setKilled(db, enabled) {
  setKv(db, "kill", enabled ? "1" : "0");
}

// The gate (when present) parses the real client IP into req.clientIp
// (proxy-aware); otherwise fall back to Express's req.ip. Rate limits key
// on this so a shared egress IP is counted as one client either way.
export function clientKey(req) {
  const v = req.clientIp?.value;
  return typeof v === "string" && v ? v : req.ip;
}

// Simple in-memory per-client token buckets for upload/jobs creation.
const buckets = new Map(); // `${ip}:${kind}` -> number[] (epoch ms)
export function __resetBuckets() {
  buckets.clear();
}

export function rateLimited(ip, kind, perMin) {
  const now = Date.now();
  const key = `${ip}:${kind}`;
  const windowStart = now - 60_000;
  const hits = (buckets.get(key) || []).filter((t) => t > windowStart);
  if (hits.length >= perMin) {
    buckets.set(key, hits);
    return true;
  }
  hits.push(now);
  buckets.set(key, hits);
  return false;
}

// Returns null when the user may proceed, or { status, error } to send.
// estCents is the estimated cost of the call about to be made; it must fit under both dollar caps.
export function quotaCheck(db, config, userId, samFrames, estCents = 0) {
  if (killed(db, config)) return { status: 503, error: "Service temporarily disabled (kill switch)." };
  if (userJobsToday(db, userId) >= config.maxJobsPerUserDay) {
    return { status: 429, error: "Daily job limit reached. Try again tomorrow." };
  }
  if (userSamFramesToday(db, userId) + samFrames > config.maxSamFramesPerUserDay) {
    return { status: 429, error: "Daily processing budget reached. Try again tomorrow." };
  }
  if (globalJobsToday(db) >= config.maxJobsGlobalDay) {
    return { status: 429, error: "The service is at capacity today. Try again tomorrow." };
  }
  if (spendTodayCents(db, userId) + estCents > config.maxUserCentsDay) {
    return { status: 429, error: "Daily budget reached. Try again tomorrow." };
  }
  if (spendGlobalTodayCents(db) + estCents > config.maxGlobalCentsDay) {
    return { status: 429, error: "The service is at capacity today. Try again tomorrow." };
  }
  return null;
}
