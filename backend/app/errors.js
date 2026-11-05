// User-safe error shaping. Validation messages are crafted safe and pass
// through untouched; anything bubbling up from ffmpeg/Meta/fs (paths,
// stacks, upstream text) is replaced with a generic fallback and logged
// server-side. Never send internals to clients.

export function userError(error, fallback, allow = null) {
  const raw = String(error?.message ?? error ?? "").split("\n")[0].slice(0, 200).trim();
  if (allow && allow.test(raw)) return raw;
  console.error(`[app] ${fallback} :: ${raw.slice(0, 300)}`);
  return fallback;
}

// Immutable selection snapshot: persisted at enqueue from the server's exact
// cached detect (upload+seed frame). Never trust client-supplied geometry and
// never re-resolve a persisted numeric id against a different detect ordering.
// When the cache is missing/stale the job is rejected before any spend with
// this actionable line (no silent substitution of another instance).
export const SELECTION_STALE_TEXT =
  "Your selection expired. Run detect again and re-pick the object to build.";

// Known-safe runner failure lines (actionable by the user, no internals).
// Includes the selection-identity lines: stale snapshots (re-pick), explicit
// no-match/ambiguous refusals for a clicked object, never a silent fallback.
export const SAFE_JOB_ERROR =
  /could not match|too few frames|no objects|basic (runner|pipeline)|upload is gone|re-queued|not available|temporarily unavailable|too large|too long|barely moves|attestation|selection expired|re-pick|ambiguous|selected object in the video/i;

// Exact-match allowlist: passes through ONLY byte-identical trusted lines.
// Prefer this for runner-authored safe strings: it cannot silently widen
// when a future edit rewords a message, unlike a loose substring regex.
export function exactAllowlist(lines) {
  const set = new Set(lines);
  return { test: (s) => set.has(String(s)) };
}

// OR-combination of allow matchers (each needs only a `test` method).
export function eitherAllow(...allows) {
  return { test: (s) => allows.some((a) => a?.test(s)) };
}
