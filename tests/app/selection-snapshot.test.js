import fsp from "node:fs/promises";
import path from "node:path";
import { test, assert, startApp, api, uploadClip, waitFor, seedSelectionCache } from "./support.js";
import { SELECTION_STALE_TEXT } from "../../backend/app/errors.js";
import {
  BASIC_SEED_BOX_NO_MATCH_TEXT,
  BASIC_SEED_BOX_AMBIGUOUS_TEXT,
  BASIC_SEED_RANGE_TEXT,
  BASIC_SELECTION_STALE_TEXT,
  runBasicJob,
} from "../../backend/app/runner-basic.js";
import { openDb } from "../../backend/app/db.js";
import { __resetDetectCache } from "../../backend/app/detect-cache.js";

// Immutable selection snapshot: enqueue persists server-cache geometry;
// missing/stale rejects before spend; claim carries the snapshot for Advanced.

test("POST /jobs with a selection but no cached detect rejects before spend", async (t) => {
  __resetDetectCache();
  const h = await startApp(t);
  const { json: up } = await uploadClip(h.base, {});
  const res = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [1] } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, SELECTION_STALE_TEXT);
  assert.equal((await api(h.base, "GET", "/api/me")).json.spendTodayCents, 0);
  assert.deepEqual((await api(h.base, "GET", "/api/me/jobs")).json.jobs, []);
});

test("POST /jobs with an unknown id rejects instead of substituting", async (t) => {
  const h = await startApp(t);
  const { json: up } = await uploadClip(h.base, {});
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const res = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [9] } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, SELECTION_STALE_TEXT);
});

test("POST /jobs persists the snapshot; worker claim carries it (Advanced follow-up documented)", async (t) => {
  const h = await startApp(t);
  const { json: up } = await uploadClip(h.base, {});
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const created = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "advanced", objectIds: [1], subject: "mug" } });
  assert.equal(created.status, 200);
  const row = h.db.prepare("SELECT selection_snapshot FROM jobs WHERE id=?").get(created.json.jobId);
  assert.ok(row.selection_snapshot);
  const snap = JSON.parse(row.selection_snapshot);
  assert.equal(snap.version, 1);
  assert.equal(snap.uploadId, up.uploadId);
  assert.equal(snap.objects.length, 1);
  assert.equal(snap.objects[0].label, "test-object");
  const { workerToken } = await import("./support.js");
  const claimed = await api(h.base, "POST", "/api/worker/claim", { body: { workerId: "gpu-0" }, token: workerToken });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.job.id, created.json.jobId);
  assert.ok(claimed.json.job.selectionSnapshot);
  assert.equal(claimed.json.job.selectionSnapshot.objects[0].label, "test-object");
});

test("prompt-only jobs stay automatic with no snapshot", async (t) => {
  const h = await startApp(t);
  const { json: up } = await uploadClip(h.base, {});
  const created = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "basic", prompt: "test-object" } });
  assert.equal(created.status, 200);
  const row = h.db.prepare("SELECT selection_snapshot FROM jobs WHERE id=?").get(created.json.jobId);
  assert.equal(row.selection_snapshot, "");
  assert.equal((await waitFor(h.base, created.json.jobId)).status, "done");
});

test("runBasicJob forwards --seed-box from the snapshot and spends no detect", async (t) => {
  const dataDir = await fsp.mkdtemp("/tmp/the-construct/basic-phone-fix/basic-seedbox-");
  t.after(async () => fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  const db = openDb(dataDir);
  const { fixtureClip } = await import("./support.js");
  const still = await fixtureClip();
  const snapshot = JSON.stringify({
    version: 1, uploadId: "u", frameIndex: 0, seedTime: 0,
    frameWidth: 128, frameHeight: 96,
    objects: [{ id: 1, label: "mug", box: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 } }],
  });
  // Prompt present but must not bypass snapshot geometry.
  const job = { id: "job-seedbox", user_id: "alice", prompt: "wrong-label", seed_time: 0, object_ids: "[1]", selection_snapshot: snapshot, title: "" };
  const upload = { id: "u", path: still, duration: 2, fps: 10, frames: 20, width: 128, height: 96 };
  let captured = null;
  const spawnFn = (cmd, args, opts, cb) => {
    captured = { cmd, args, cb };
    return { killed: false, exitCode: null, kill() {}, stdout: { on() {} }, stderr: { on() {} } };
  };
  const pending = runBasicJob({ db, config: { basicRunner: "run-basic.mjs" }, dataDir, job, upload, spawnFn });
  for (let i = 0; i < 200 && !captured; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(captured, "child spawned");
  const conceptAt = captured.args.indexOf("--concept");
  assert.equal(captured.args[conceptAt + 1], "mug", "snapshot label wins over prompt");
  const boxAt = captured.args.indexOf("--seed-box");
  assert.ok(boxAt !== -1, "--seed-box forwarded");
  assert.equal(captured.args[boxAt + 1], "0.1,0.1,0.5,0.5");
  assert.ok(!captured.args.includes("--object"), "no numeric id forwarded");
  captured.cb({ code: 1, signal: null });
  await assert.rejects(pending);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0, "snapshot path spends no detect");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 0);
  db.close();
});

test("runBasicJob with a missing snapshot refuses before spawn or spend", async (t) => {
  const dataDir = await fsp.mkdtemp("/tmp/the-construct/basic-phone-fix/basic-stale-");
  t.after(async () => fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {}));
  const db = openDb(dataDir);
  const { fixtureClip } = await import("./support.js");
  const still = await fixtureClip();
  const job = { id: "job-stale", user_id: "alice", prompt: "", seed_time: 0, object_ids: "[1]", selection_snapshot: "", title: "" };
  const upload = { id: "u", path: still, duration: 2, fps: 10, frames: 20, width: 128, height: 96 };
  let spawned = false;
  const spawnFn = () => { spawned = true; throw new Error("must not spawn"); };
  await assert.rejects(runBasicJob({ db, config: {}, dataDir, job, upload, spawnFn }), (e) => e.message === BASIC_SELECTION_STALE_TEXT);
  assert.equal(spawned, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
  db.close();
});

test("new Basic identity lines are exact allowlist members", async () => {
  const { BASIC_SAFE_ERRORS } = await import("../../backend/app/runner-basic.js");
  for (const line of [BASIC_SEED_BOX_NO_MATCH_TEXT, BASIC_SEED_BOX_AMBIGUOUS_TEXT, BASIC_SEED_RANGE_TEXT, BASIC_SELECTION_STALE_TEXT]) {
    assert.ok(BASIC_SAFE_ERRORS.includes(line), `allowlisted: ${line.slice(0, 40)}`);
  }
});
