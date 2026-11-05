import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, assert, startApp, api, uploadClip, waitFor, stubRunners, seedSelectionCache } from "./support.js";
import { userError, SAFE_JOB_ERROR, exactAllowlist, eitherAllow } from "../../backend/app/errors.js";
import {
  BASIC_SAFE_ERRORS,
  BASIC_MULTI_OBJECT_TEXT,
  BASIC_MOVING_CAMERA_TEXT,
  BASIC_NO_META_TEXT,
  basicFailureText,
  runBasicJob,
  killBasicChild,
} from "../../backend/app/runner-basic.js";
import { UPSTREAM_BUSY } from "../../backend/app/app.js";
import { openDb, estimateCents } from "../../backend/app/db.js";
import { estimateSamFrames } from "../../backend/app/runner-lite.js";
import { measureCamera } from "../../backend/app/camera.js";

const run = promisify(execFile);

// Scratch lives on D: (never C: temp): mkdtemp under the suite dir.
// Every direct openDb() is closed synchronously in the test body before
// its directory is unlinked, so cleanup never races an open SQLite handle.
const SCRATCH = "/tmp/the-construct/reliability";
async function scratchTmp(prefix) {
  await fsp.mkdir(SCRATCH, { recursive: true });
  return fsp.mkdtemp(path.join(SCRATCH, `${prefix}-`));
}

// Belt-and-braces for Windows lock release after close().
async function rmQuiet(dir) {
  for (let i = 0; i < 5; i += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// The exact trusted allowlist, built the same way app.js builds it.
const JOB_ALLOW = eitherAllow(exactAllowlist(BASIC_SAFE_ERRORS), SAFE_JOB_ERROR);

// ---- (1) exact trusted allowlist for every Basic safe output ----

test("every BASIC_SAFE_ERRORS line passes error shaping byte-identically", () => {
  assert.ok(BASIC_SAFE_ERRORS.length >= 8, `expected all safe lines, got ${BASIC_SAFE_ERRORS.length}`);
  for (const line of BASIC_SAFE_ERRORS) {
    assert.equal(
      userError(new Error(line), "The basic build failed. Try another frame or clip.", JOB_ALLOW),
      line,
      `must pass through untouched: ${line.slice(0, 60)}…`
    );
  }
});

test("basicFailureText can only return members of BASIC_SAFE_ERRORS", () => {
  const safe = new Set(BASIC_SAFE_ERRORS);
  const tails = [
    "muse-image model_not_found; retrying",
    "404 The requested model was not found.",
    "HTTP 429 too many requests",
    "HTTP 502 bad gateway",
    "connection error: socket hang up",
    "read ECONNRESET",
    "request failed: fetch failed",
    "close-up subject (frame share 0.33 > 0.30); use Lite",
    "pan camera (pan 4.1, scale 1.0); use Lite",
    "dolly camera drift; use Lite",
    "shift camera",
    "persistent background ghosts (share 0.4 > 0.30); use Lite",
    "no clean plate: [{...}]",
    "seed-box no match (best IoU 0.000 < 0.15); re-pick the object",
    "seed-box ambiguous (top IoUs 0.800 vs 0.780 within 0.05); re-pick a clearer frame",
    "seed time 20s is beyond the Basic 12.0s window; pick a seed inside the opening window",
    "Your selection expired. Run detect again and re-pick the object to build.",
  ];
  for (const tail of tails) {
    assert.ok(safe.has(basicFailureText({ code: 3 }, tail)), `mapped tail must be trusted: ${tail}`);
  }
  assert.ok(safe.has(basicFailureText({ code: 3 }, "exit 3 with no recognisable reason")));
  assert.ok(safe.has(basicFailureText({ code: 1, signal: null }, "/srv/x.py boom")));
  assert.ok(safe.has(basicFailureText({ code: null, signal: "SIGKILL" }, "killed")));
  assert.equal(BASIC_SAFE_ERRORS.length, safe.size, "no duplicates in the allowlist");
});

test("unknown failures still fall back to generic text", () => {
  assert.equal(
    userError(new Error("/tmp/x/plate.png: ffmpeg boom"), "The basic build failed.", JOB_ALLOW),
    "The basic build failed."
  );
});

// ---- (5) raw fetch failed / ECONNRESET retry tokens ----

test("UPSTREAM_BUSY matches raw network drops and legacy tokens, not clean failures", () => {
  for (const msg of [
    "request failed: fetch failed",
    "fetch failed",
    "read ECONNRESET",
    "ECONNRESET: socket hang up",
    "404 The requested model was not found.",
    "model_not_found",
    "temporarily unavailable",
    "connection error",
    "HTTP 429",
    "HTTP 503",
  ]) {
    assert.ok(UPSTREAM_BUSY.test(msg), `must retry: ${msg}`);
  }
  for (const msg of [
    "Basic pipeline failed unexpectedly. Please try again later.",
    "track 4 has no usable keyframe masks",
    "Upload is gone.",
    "",
  ]) {
    assert.ok(!UPSTREAM_BUSY.test(msg), `must not retry: ${msg || "(empty)"}`);
  }
});

test("a lite job that throws raw 'fetch failed' is retried, then succeeds", async (t) => {
  let calls = 0;
  const flaky = async ({ dataDir, job }) => {
    calls += 1;
    if (calls <= 2) throw new Error("request failed: fetch failed");
    const dir = path.join(dataDir, "specimens", job.id);
    await fsp.mkdir(dir, { recursive: true });
    const result = { id: job.id, tier: "lite", title: "t", subject: "s", viewer: `view-lite.html?id=${job.id}`, thumb: `specimens/${job.id}/thumb.webp`, durationSec: 1, bytes: 1, meta: {} };
    await fsp.writeFile(path.join(dir, "thumb.webp"), Buffer.from("WEBP"));
    return result;
  };
  const h = await startApp(t, { runners: { lite: flaky }, configOverrides: { jobAttempts: 3, jobRetryPauseMs: 5 } });
  const { json: up } = await uploadClip(h.base, {});
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const ok = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [1] } });
  assert.equal((await waitFor(h.base, ok.json.jobId)).status, "done");
  assert.equal(calls, 3);
});

// ---- (3) graceful stop ----

test("stop() prevents any new pump dispatch after shutdown", async (t) => {
  const handle = await startApp(t);
  // Stop queue work, then submit: creation succeeds but the pump must
  // never pick the job up (no new background work after shutdown).
  handle.stop();
  const { json: up } = await uploadClip(handle.base, {});
  const created = await api(handle.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite" } });
  assert.equal(created.status, 200);
  handle.pump(); // explicit pump after stop is also a no-op
  await new Promise((r) => setTimeout(r, 300));
  const job = await api(handle.base, "GET", `/api/jobs/${created.json.jobId}`);
  assert.equal(job.json.status, "queued", "no dispatch after stop()");
});

test("killBasicChild signals the owned child; completion clears it", async (t) => {
  assert.equal(killBasicChild(), false, "no child running: safe no-op");
  const dataDir = await scratchTmp("basic-kill");
  t.after(() => rmQuiet(dataDir));
  const db = openDb(dataDir);
  const config = { basicRunner: "/nonexistent/run-basic.mjs" };
  const job = { id: "job-kill", user_id: "alice", prompt: "stub-concept", seed_time: 0, object_ids: "[]", title: "" };
  const upload = { id: "u", path: path.join(dataDir, "missing.mp4"), duration: 2 };

  let captured = null;
  const kills = [];
  const spawnFn = (cmd, args, opts, cb) => {
    captured = { cmd, args, cb };
    return {
      killed: false,
      exitCode: null,
      kill(sig) { kills.push(sig); this.killed = true; },
      stdout: { on() {} },
      stderr: { on() {} },
    };
  };
  const pending = runBasicJob({ db, config, dataDir, job, upload, spawnFn });
  // The runner is async (camera measure first): wait for it to reach spawn.
  for (let i = 0; i < 200 && !captured; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(captured, "child spawned");
  // The prompt path spends nothing and spawns with the concept; no --object.
  assert.equal(captured.cmd, "node");
  assert.ok(captured.args.includes("--concept") && captured.args.includes("stub-concept"));
  assert.ok(!captured.args.includes("--object"), "single/empty selection forwards no tracker id");
  assert.equal(killBasicChild(), true, "live child is signalled");
  assert.deepEqual(kills, ["SIGTERM"]);
  captured.cb(null); // child exits with no meta.json
  await assert.rejects(pending, (e) => e.message === BASIC_NO_META_TEXT);
  assert.equal(killBasicChild(), false, "completed child is cleared");
  // The `running` backstop was released: a second job is not reported busy.
  captured = null;
  const job2 = { ...job, id: "job-kill-2" };
  const pending2 = runBasicJob({ db, config, dataDir, job: job2, upload, spawnFn });
  for (let i = 0; i < 200 && !captured; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(captured, "second child spawned (backstop released)");
  captured.cb({ code: 1, signal: null });
  await assert.rejects(pending2, (e) => e.message === "Basic pipeline failed unexpectedly. Please try again later.");
  db.close();
});

test("index.js stops queue work before the server and DB close", async () => {
  const src = await fsp.readFile(new URL("../../backend/app/index.js", import.meta.url), "utf8");
  const stopAt = src.indexOf("handle.stop();");
  const closeAt = src.indexOf("server.close(");
  assert.ok(stopAt !== -1, "signal handler calls handle.stop()");
  assert.ok(stopAt < closeAt, "stop() precedes server.close()");
});

// ---- (2) multi-object Basic is rejected, never silently narrowed ----

test("POST /api/jobs rejects Basic with >1 object before any spend", async (t) => {
  const h = await startApp(t);
  const { json: up } = await uploadClip(h.base, {});
  const res = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "basic", objectIds: [1, 2] } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, BASIC_MULTI_OBJECT_TEXT);
  // Nothing booked, nothing queued.
  assert.equal((await api(h.base, "GET", "/api/me")).json.spendTodayCents, 0);
  assert.deepEqual((await api(h.base, "GET", "/api/me/jobs")).json.jobs, []);
  // A single object still enqueues (stub runner stands in for run-basic.mjs).
  // The immutable snapshot is seeded from the exact cached detect first.
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const one = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "basic", objectIds: [1], prompt: "x" } });
  assert.equal(one.status, 200);
  assert.equal((await waitFor(h.base, one.json.jobId)).status, "done");
});

test("runBasicJob refuses >1 object_ids before spawning or spending", async (t) => {
  const dataDir = await scratchTmp("basic-multi");
  t.after(() => rmQuiet(dataDir));
  const db = openDb(dataDir);
  let spawned = false;
  const spawnFn = () => { spawned = true; throw new Error("must not spawn"); };
  // Prompt set: the old code would have skipped straight to spawn.
  const job = { id: "job-multi", user_id: "alice", prompt: "x", seed_time: 0, object_ids: "[1,2]", title: "" };
  const upload = { id: "u", path: path.join(dataDir, "missing.mp4"), duration: 2 };
  await assert.rejects(
    runBasicJob({ db, config: {}, dataDir, job, upload, spawnFn }),
    (e) => e.message === BASIC_MULTI_OBJECT_TEXT
  );
  assert.equal(spawned, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 0);
  db.close();
});

// ---- (4) conservative retry reservation ----

test("a retry that would exceed the day budget fails safely instead of re-queueing", async (t) => {
  let calls = 0;
  const alwaysBusy = async () => {
    calls += 1;
    throw new Error("503 Service Unavailable");
  };
  const h = await startApp(t, { runners: { lite: alwaysBusy }, configOverrides: { jobAttempts: 5, jobRetryPauseMs: 5 } });
  const { json: up } = await uploadClip(h.base, {});
  // Cap the day budget at exactly one full job estimate: creation fits
  // (0 + est is not over), but any retry reservation (ledger + est) cannot.
  const uploadRow = h.db.prepare("SELECT * FROM uploads WHERE id=?").get(up.uploadId);
  const frames = estimateSamFrames(uploadRow, 1);
  assert.ok(frames > 0, "fixture books frames");
  const est = estimateCents(h.config, "job", frames) + estimateCents(h.config, "detect", 14);
  h.config.maxUserCentsDay = est;
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const created = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [1] } });
  assert.equal(created.status, 200);
  const failed = await waitFor(h.base, created.json.jobId);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Daily budget reached/);
  assert.equal(h.db.prepare("SELECT attempts FROM jobs WHERE id=?").get(created.json.jobId).attempts, 0);
  assert.equal(calls, 1, "no retry ran without a reservation");
  // Only the initial booking sits on the ledger — no retry reservation, and
  // nothing was refunded either (failed calls can still be billed).
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM spend WHERE ref=?").get(created.json.jobId).n, 1);
});

test("each retry reserves before it runs (ledger grows per attempt)", async (t) => {
  let calls = 0;
  const flaky = async ({ dataDir, job }) => {
    calls += 1;
    if (calls <= 2) throw new Error("model_not_found");
    const dir = path.join(dataDir, "specimens", job.id);
    await fsp.mkdir(dir, { recursive: true });
    const result = { id: job.id, tier: "lite", title: "t", subject: "s", viewer: `view-lite.html?id=${job.id}`, thumb: `specimens/${job.id}/thumb.webp`, durationSec: 1, bytes: 1, meta: {} };
    await fsp.writeFile(path.join(dir, "thumb.webp"), Buffer.from("WEBP"));
    return result;
  };
  const h = await startApp(t, { runners: { lite: flaky }, configOverrides: { jobAttempts: 3, jobRetryPauseMs: 5 } });
  const { json: up } = await uploadClip(h.base, {});
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const ok = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [1] } });
  assert.equal((await waitFor(h.base, ok.json.jobId)).status, "done");
  assert.equal(calls, 3);
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS n FROM spend WHERE ref=?").get(ok.json.jobId).n,
    3,
    "initial booking + one reservation per retry"
  );
});

// ---- (6) recovery stage/detail + free camera refusal before spend ----

test("boot recovery resets stage/detail alongside the restart error", async (t) => {
  const first = await startApp(t);
  const { json: up } = await uploadClip(first.base, {});
  const created = await api(first.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite" } });
  await waitFor(first.base, created.json.jobId);
  first.db.prepare("UPDATE jobs SET status='running', stage='tracking', detail='Following object 1 of 1…' WHERE id=?").run(created.json.jobId);

  const { recoverJobs } = await import("../../backend/app/db.js");
  const db2 = openDb(first.dataDir);
  const recovery = recoverJobs(db2);
  assert.equal(recovery.failed, 1);
  const row = db2.prepare("SELECT status, stage, detail, error FROM jobs WHERE id=?").get(created.json.jobId);
  assert.equal(row.status, "failed");
  assert.equal(row.stage, "failed", "no stale pipeline stage");
  assert.match(row.detail, /restarted/i, "user-safe detail, not a stale progress line");
  assert.equal(row.error, "server restarted during run", "existing error string unchanged");
  db2.close();
});

let panClipCache = null;
async function panningClip() {
  if (panClipCache) return panClipCache;
  const dir = await scratchTmp("construct-pan");
  const file = path.join(dir, "pan.mp4");
  // A hard horizontal pan: the crop window sweeps the full source width.
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=256x96:rate=10:duration=2",
    "-vf", "crop=128:96:x='(in_w-128)*t/2':y=0", "-pix_fmt", "yuv420p", file]);
  panClipCache = file;
  return file;
}

test("moving-camera Basic refuses before any detect spend or spawn", async (t) => {
  const pan = await panningClip();
  const measured = await measureCamera(pan, 2);
  assert.equal(measured.moving, true, "fixture really pans");
  assert.equal(measured.confident, true, "measurement is confident");

  const dataDir = await scratchTmp("basic-cam");
  t.after(() => rmQuiet(dataDir));
  const db = openDb(dataDir);
  let spawned = false;
  const spawnFn = () => { spawned = true; throw new Error("must not spawn"); };
  // No prompt: the old order ran a spending SAM detect before the camera check.
  const job = { id: "job-pan", user_id: "alice", prompt: "", seed_time: 0, object_ids: "[]", title: "" };
  const upload = { id: "u", path: pan, duration: 2 };
  await assert.rejects(
    runBasicJob({ db, config: {}, dataDir, job, upload, spawnFn }),
    (e) => e.message === BASIC_MOVING_CAMERA_TEXT
  );
  assert.equal(spawned, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0, "no detect spend before refusal");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 0);
  db.close();
});

test("fixed-camera Basic proceeds and carries the camera override", async (t) => {
  const { fixtureClip } = await import("./support.js");
  const still = await fixtureClip();
  const measured = await measureCamera(still, 2);
  assert.equal(measured.moving, false, "fixture is static");
  assert.equal(measured.confident, true, "measurement is confident");

  const dataDir = await scratchTmp("basic-fixed");
  t.after(() => rmQuiet(dataDir));
  const db = openDb(dataDir);
  let captured = null;
  const spawnFn = (cmd, args, opts, cb) => {
    captured = { args, cb };
    return { killed: false, exitCode: null, kill() {}, stdout: { on() {} }, stderr: { on() {} } };
  };
  const job = { id: "job-fixed", user_id: "alice", prompt: "test-object", seed_time: 0, object_ids: "[]", title: "" };
  const upload = { id: "u", path: still, duration: 2 };
  const pending = runBasicJob({ db, config: { basicRunner: "run-basic.mjs" }, dataDir, job, upload, spawnFn });
  for (let i = 0; i < 200 && !captured; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(captured, "child spawned");
  assert.ok(captured.args.includes("--camera-override") && captured.args.includes("fixed"));
  captured.cb({ code: 1, signal: null });
  await assert.rejects(pending, (e) => e.message === "Basic pipeline failed unexpectedly. Please try again later.");
  db.close();
});
