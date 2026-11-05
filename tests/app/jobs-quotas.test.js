import fsp from "node:fs/promises";
import path from "node:path";
import { test, assert, startApp, api, uploadClip, waitFor, stubRunners, seedSelectionCache } from "./support.js";

test("a Lite job does not queue behind a Basic job that is waiting on Meta", async (t) => {
  const stub = stubRunners();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handle = await startApp(t, { runners: { lite: stub.lite, basic: async (args) => { await gate; return stub.basic(args); } } });
  const base = handle.base;
  t.after(() => release());
  const { json: up } = await uploadClip(base, {});
  const slow = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "basic", prompt: "test-object" } });
  assert.equal(slow.status, 200);
  await seedSelectionCache(handle, up.uploadId, { seedTime: 0 });
  const quick = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [1] } });
  assert.equal(quick.status, 200);
  const lite = await waitFor(base, quick.json.jobId);
  assert.equal(lite.status, "done");
  const basic = await api(base, "GET", `/api/jobs/${slow.json.jobId}`);
  assert.equal(basic.json.status, "running");
  release();
  assert.equal((await waitFor(base, slow.json.jobId)).status, "done");
});

test("lite job runs end to end through the stub runner", async (t) => {
  const handle = await startApp(t);
  const { base, dataDir } = handle;
  const { json: up } = await uploadClip(base, {});
  await seedSelectionCache(handle, up.uploadId, { seedTime: 0.5 });
  const created = await api(base, "POST", "/api/jobs", {
    body: { uploadId: up.uploadId, tier: "lite", objectIds: [1], seedTime: 0.5, subject: "test beast" },
  });
  assert.equal(created.status, 200);
  assert.ok(created.json.jobId);

  const done = await waitFor(base, created.json.jobId);
  assert.equal(done.status, "done");
  assert.equal(done.result.viewer, `view-lite.html?id=${created.json.jobId}`);
  assert.equal(done.result.thumb, `specimens/${created.json.jobId}/thumb.webp`);
  assert.deepEqual(done.result.meta.provenance, ["sam-3.1", "muse-spark-1.3"]);

  // specimen files are served
  const thumb = await fetch(`${base}/${done.result.thumb}`);
  assert.equal(thumb.status, 200);
  const meta = await fsp.readFile(path.join(dataDir, "specimens", created.json.jobId, "meta.json"), "utf8");
  assert.equal(JSON.parse(meta).id, created.json.jobId);

  // jobs are private to their owner
  const other = await api(base, "GET", `/api/jobs/${created.json.jobId}`, { user: "mallory" });
  assert.equal(other.status, 404);
  const mine = await api(base, "GET", "/api/me/jobs", { user: "mallory" });
  assert.deepEqual(mine.json.jobs, []);
});

test("jobs validate tier, email, availability and budget", async (t) => {
  const { base } = await startApp(t, { configOverrides: { basicRunner: "/nonexistent/run-basic.mjs" } });
  const { json: up } = await uploadClip(base, {});

  assert.equal((await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "huge" } })).status, 400);
  // A client-provided email is ignored: completion mail always goes to the
  // signed-in user, so even a bogus value cannot break job creation.
  assert.equal((await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", email: "not-an-email" } })).status, 200);
  const basic = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "basic" } });
  assert.equal(basic.status, 503);
  assert.match(basic.json.error, /not available/);
});

test("basic tier enqueues when the runner script exists", async (t) => {
  const { base } = await startApp(t);
  const { json: up } = await uploadClip(base, {});
  const created = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "basic", prompt: "test-object" } });
  assert.equal(created.status, 200);
  const done = await waitFor(base, created.json.jobId);
  assert.equal(done.status, "done");
  assert.equal(done.result.tier, "basic"); // stub runner stands in for run-basic.mjs in tests
});

test("per-user daily job cap holds", async (t) => {
  const { base } = await startApp(t, { configOverrides: { maxJobsPerUserDay: 1 } });
  const { json: up } = await uploadClip(base, {});
  const first = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite" } });
  assert.equal(first.status, 200);
  const second = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite" } });
  assert.equal(second.status, 429);
  // another user is unaffected
  const other = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "advanced" }, user: "bob" });
  assert.equal(other.status, 404); // ...but cannot use alice's upload
});

test("kill switch blocks meta-touching endpoints until lifted", async (t) => {
  const { base } = await startApp(t);
  const { json: up } = await uploadClip(base, {});

  assert.equal((await api(base, "POST", "/api/admin/kill", { body: { enabled: true } })).status, 403);
  const killed = await api(base, "POST", "/api/admin/kill", { body: { enabled: true }, role: "owner" });
  assert.deepEqual(killed.json, { ok: true, killed: true });

  assert.equal((await api(base, "POST", "/api/route", { body: { uploadId: up.uploadId } })).status, 503);
  assert.equal((await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite" } })).status, 503);

  const lifted = await api(base, "POST", "/api/admin/kill", { body: { enabled: false }, role: "owner" });
  assert.deepEqual(lifted.json, { ok: true, killed: false });
  assert.equal((await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite" } })).status, 200);
});

test("upload rate limit holds per IP", async (t) => {
  const { base } = await startApp(t, { configOverrides: { rateUploadPerMin: 1 } });
  assert.equal((await uploadClip(base, {})).status, 200);
  assert.equal((await uploadClip(base, {})).status, 429);
});

test("rate limits key on the gate client ip, not the socket", async (t) => {
  const { clientKey } = await import("../../backend/app/quotas.js");
  assert.equal(clientKey({ ip: "1.1.1.1", clientIp: { value: "2.2.2.2" } }), "2.2.2.2");
  assert.equal(clientKey({ ip: "1.1.1.1" }), "1.1.1.1");
  assert.equal(clientKey({ ip: "1.1.1.1", clientIp: {} }), "1.1.1.1");
  const { base } = await startApp(t, { configOverrides: { rateUploadPerMin: 1 } });
  assert.equal((await uploadClip(base, { ip: "10.0.0.1" })).status, 200);
  assert.equal((await uploadClip(base, { ip: "10.0.0.1" })).status, 429);
  assert.equal((await uploadClip(base, { ip: "10.0.0.2" })).status, 200);
});

test("boot recovery fails running jobs and resumes queued ones", async (t) => {
  const first = await startApp(t);
  const { json: up } = await uploadClip(first.base, {});
  const created = await api(first.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite" } });
  await waitFor(first.base, created.json.jobId);
  // Fake an interrupted run + an interrupted claim directly in the DB.
  first.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(created.json.jobId);
  const adv = await api(first.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "advanced" } });
  first.db.prepare("UPDATE jobs SET status='claimed', lease_expires=? WHERE id=?").run(Date.now() + 60000, adv.json.jobId);

  const { openDb, recoverJobs } = await import("../../backend/app/db.js");
  const db2 = openDb(first.dataDir);
  const recovery = recoverJobs(db2);
  assert.equal(recovery.failed, 1);
  assert.equal(recovery.requeued, 1);
  assert.equal(db2.prepare("SELECT status FROM jobs WHERE id=?").get(created.json.jobId).status, "failed");
  assert.equal(db2.prepare("SELECT status FROM jobs WHERE id=?").get(adv.json.jobId).status, "queued_gpu");
  db2.close();
});

test("dollar caps stop Meta calls before they happen (per user and global)", async (t) => {
  // user cap: 1 cent a day, so even one Spark routing call (0.2c) fits but a ~14-concept SAM sweep does not
  const user = await startApp(t, { configOverrides: { maxUserCentsDay: 1 } });
  const { json: up } = await uploadClip(user.base, {});
  const route = await api(user.base, "POST", "/api/route", { body: { uploadId: up.uploadId } });
  assert.equal(route.status, 200);
  const detect = await api(user.base, "POST", "/api/detect", { body: { uploadId: up.uploadId, time: 0.5 } });
  assert.equal(detect.status, 429);
  assert.match(detect.json.error, /budget/i);
  const job = await api(user.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite" } });
  assert.equal(job.status, 429);
  // the refusals booked nothing
  const me = await api(user.base, "GET", "/api/me");
  assert.ok(me.json.spendTodayCents <= 1, `spend ${me.json.spendTodayCents}`);

  // global cap: a fresh user is refused once the service-wide budget is gone
  const global = await startApp(t, { configOverrides: { maxGlobalCentsDay: 0 } });
  const { json: up2 } = await uploadClip(global.base, {});
  const blocked = await api(global.base, "POST", "/api/route", { body: { uploadId: up2.uploadId }, user: "carol" }).catch(() => null);
  assert.ok(blocked === null || blocked.status === 429 || blocked.status === 404);
  const mine = await api(global.base, "POST", "/api/route", { body: { uploadId: up2.uploadId } });
  assert.equal(mine.status, 429);
  assert.match(mine.json.error, /capacity/i);

  // an Advanced job is booked too (it spends on the owner's GPU box with the same key)
  const adv = await startApp(t, {});
  const { json: up3 } = await uploadClip(adv.base, {});
  const queued = await api(adv.base, "POST", "/api/jobs", { body: { uploadId: up3.uploadId, tier: "advanced" } });
  assert.equal(queued.status, 200);
  assert.ok((await api(adv.base, "GET", "/api/me")).json.spendTodayCents > 0);
});

test("a job that hits Meta's transient 404 is retried, then succeeds; exhausted retries say 'try again later'", async (t) => {
  let calls = 0;
  const flaky = (failTimes) => async ({ dataDir, job }) => {
    calls += 1;
    if (calls <= failTimes) throw Object.assign(new Error("404 The requested model was not found."), { status: 404 });
    const dir = path.join(dataDir, "specimens", job.id);
    await fsp.mkdir(dir, { recursive: true });
    const result = { id: job.id, tier: "lite", title: "t", subject: "s", viewer: `view-lite.html?id=${job.id}`, thumb: `specimens/${job.id}/thumb.webp`, durationSec: 1, bytes: 1, meta: {} };
    await fsp.writeFile(path.join(dir, "thumb.webp"), Buffer.from("WEBP"));
    return result;
  };
  const retried = await startApp(t, { runners: { lite: flaky(2) }, configOverrides: { jobAttempts: 3, jobRetryPauseMs: 5 } });
  const { json: up } = await uploadClip(retried.base, {});
  await seedSelectionCache(retried, up.uploadId, { seedTime: 0.5 });
  const ok = await api(retried.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [1], seedTime: 0.5, subject: "x" } });
  assert.equal((await waitFor(retried.base, ok.json.jobId)).status, "done");
  assert.equal(calls, 3);

  calls = 0;
  const exhausted = await startApp(t, { runners: { lite: flaky(99) }, configOverrides: { jobAttempts: 2, jobRetryPauseMs: 5 } });
  const { json: up2 } = await uploadClip(exhausted.base, {});
  await seedSelectionCache(exhausted, up2.uploadId, { seedTime: 0.5 });
  const bad = await api(exhausted.base, "POST", "/api/jobs", { body: { uploadId: up2.uploadId, tier: "lite", objectIds: [1], seedTime: 0.5, subject: "x" } });
  const failed = await waitFor(exhausted.base, bad.json.jobId);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /temporarily unavailable/);
  assert.equal(calls, 2);
});

test("basic child failures become user-safe text; upstream trouble stays retryable", async () => {
  const { basicFailureText } = await import("../../backend/app/runner-basic.js");
  const busy = basicFailureText({ code: 3 }, "SAM pass failed (model_not_found); retrying 2/2");
  assert.match(busy, /temporarily unavailable/);
  assert.match(basicFailureText({ code: 3 }, "no clean plate"), /could not build a clean scene/);
  assert.match(basicFailureText({ code: 3 }, "close-up subject (frame share 0.33 > 0.30); use Lite"), /Advanced for objects up close/);
  assert.match(basicFailureText({ code: 3 }, "pan camera (pan 4.1, scale 1.0); use Lite"), /steady camera/);
  assert.match(basicFailureText({ code: 3 }, "persistent background ghosts (share 0.4 > 0.30); use Lite"), /clean background/);
  const crash = basicFailureText({ code: null, signal: "SIGKILL" }, "/srv/app/backend/x.py line 4 Killed");
  assert.match(crash, /failed unexpectedly/);
  assert.ok(![busy, crash].some((m) => /\/srv|\.py|Killed/.test(m)));
});

test("owners can delete finished builds (files + rows); running ones refuse; admin status is owner-only", async (t) => {
  const handle = await startApp(t);
  const { base, dataDir } = handle;
  const { json: up } = await uploadClip(base, {});
  await seedSelectionCache(handle, up.uploadId, { seedTime: 0.5 });
  const created = await api(base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [1], seedTime: 0.5, subject: "x" } });
  const id = created.json.jobId;
  assert.equal((await waitFor(base, id)).status, "done");
  // not the owner
  assert.equal((await api(base, "POST", `/api/jobs/${id}/delete`, { user: "mallory" })).status, 404);
  assert.equal((await api(base, "GET", "/api/admin/status")).status, 403);
  const adminStatus = await api(base, "GET", "/api/admin/status", { user: "boss", role: "owner" });
  assert.equal(adminStatus.status, 200);
  assert.equal(adminStatus.json.killed, false);
  assert.ok(Number.isFinite(adminStatus.json.spendTodayCents));
  assert.equal((await api(base, "GET", "/api/me")).json.maintenance, false);

  const specDir = path.join(dataDir, "specimens", id);
  await fsp.access(specDir);
  const del = await api(base, "POST", `/api/jobs/${id}/delete`);
  assert.equal(del.status, 200);
  await assert.rejects(fsp.access(specDir));
  assert.equal((await api(base, "GET", `/api/jobs/${id}`)).status, 404);
  await assert.rejects(fsp.access(path.join(dataDir, "uploads", up.uploadId)));
});
