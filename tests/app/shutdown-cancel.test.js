import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, assert, startApp, api, uploadClip, seedSelectionCache, waitFor, stubRunners } from "./support.js";
import { openDb } from "../../backend/app/db.js";
import { cancelledError, isCancelError, killProcessTree } from "../../backend/lib/cancel.js";
import { withModelRetry } from "../../backend/lib/meta.js";
import { runBasicJob, killBasicChild } from "../../backend/app/runner-basic.js";
import { runLiteJob } from "../../backend/app/runner-lite.js";

// Shutdown cancellation-race regressions (offline; test-owned children only).
// A stop during the free pre-spawn awaits must prevent later spends/spawns,
// and killing the owned Basic child must take its whole process tree —
// without any module-global stopped flag that could block a later createApp
// in the same process.

// Scratch lives on D: (never C: temp), mirroring reliability-fixes.test.js.
const SCRATCH = "/tmp/the-construct/shutdown-cancel";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MISSING = path.join(SCRATCH, "does-not-exist.mp4");

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

async function assertGone(pid, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`${message} (pid ${pid} still alive)`);
    await sleep(50);
  }
}

// Offline nested-tree fixture: a node script that spawns a grandchild
// sleeper and records both pids under its outDir (argv[3] in the runner CLI
// contract), then sleeps. The grandchild is orphan-capable yet stays in the
// parent's tree, so ONLY a whole-tree kill taken while the parent lives
// removes it: win32 detaches it (escapes libuv job-object cleanup, keeps the
// parent-pid link taskkill follows); posix keeps it in the parent's group
// (no job objects there, group SIGKILL reaches it).
async function ensureTreeFixture() {
  await fsp.mkdir(SCRATCH, { recursive: true });
  const file = path.join(SCRATCH, "basic-tree-child.mjs");
  await fsp.writeFile(file, [
    "import { spawn } from \"node:child_process\";",
    "import fs from \"node:fs\";",
    "import path from \"node:path\";",
    "const outDir = process.argv[3];",
    "const gcScript = path.join(outDir, \"tree-grandchild.cjs\");",
    "fs.writeFileSync(gcScript, \"require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(()=>{},1000);\");",
    "fs.writeFileSync(path.join(outDir, \"parent.pid\"), String(process.pid));",
    "const opts = { stdio: \"ignore\" };",
    "if (process.platform === \"win32\") opts.detached = true;",
    "spawn(process.execPath, [gcScript, path.join(outDir, \"grandchild.pid\")], opts);",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  return file;
}

async function pollPid(file, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number(await fsp.readFile(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await sleep(50);
  }
}

function stubSpawn(spawned, { writeMeta = false, outDir = null } = {}) {
  return (cmd, args, opts, cb) => {
    spawned.fired = true;
    const child = {
      killed: false, exitCode: null,
      stdout: { on() {} }, stderr: { on() {} },
      kill() { this.killed = true; return true; },
    };
    setImmediate(async () => {
      if (writeMeta && outDir) {
        await fsp.mkdir(outDir, { recursive: true });
        await fsp.writeFile(path.join(outDir, "meta.json"), JSON.stringify({ thumb: "thumb.webp" }));
        cb(null);
      } else {
        cb(Object.assign(new Error("mock completion"), { code: 1 }));
      }
    });
    return child;
  };
}

// ---- (1) stop while the free camera measurement is pending ----

test("stop during pre-spawn camera measurement prevents the owned spawn", async () => {
  const spawned = {};
  const pending = runBasicJob({
    db: null,
    config: { basicRunner: "fixture.mjs" },
    dataDir: SCRATCH,
    job: { id: "race-cam", prompt: "fixture", object_ids: "[]" },
    upload: { path: MISSING, duration: 8 },
    spawnFn: stubSpawn(spawned),
  });
  // The exact app.stop() behavior while the camera measurement is pending.
  killBasicChild();
  await assert.rejects(pending, (error) => isCancelError(error));
  assert.equal(spawned.fired, undefined, "no new work starts after shutdown");
});

// ---- (2) stop while the resolve (detect) step is pending ----

test("stop while resolve is pending prevents spend and spawn", async () => {
  const dataDir = await scratchTmp("cancel-detect");
  try {
    const db = openDb(dataDir);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let detectCalls = 0;
    const spawned = {};
    const pending = runBasicJob({
      db,
      config: {},
      dataDir,
      job: { id: "job-detect", user_id: "alice", prompt: "", seed_time: 0, object_ids: "[]", title: "" },
      upload: { id: "u", path: MISSING, duration: 2, width: 128, height: 96, fps: 10, frames: 20 },
      spawnFn: stubSpawn(spawned),
      _runDetect: async () => {
        detectCalls += 1;
        await gate;
        return { result: { objects: [{ label: "x" }] }, cached: false };
      },
    });
    for (let i = 0; i < 200 && !detectCalls; i += 1) await sleep(10);
    assert.equal(detectCalls, 1, "resolve step was reached");
    killBasicChild();
    release();
    await assert.rejects(pending, (error) => isCancelError(error));
    assert.equal(spawned.fired, undefined, "no spawn after shutdown");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0, "no detect spend booked");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 0, "no detect usage booked");
    db.close();
  } finally {
    await rmQuiet(dataDir);
  }
});

// ---- (3) owned nested process tree shutdown (offline, test-owned) ----

test("killProcessTree stops an owned parent and its nested grandchild", async (t) => {
  // Parent spawns a same-group grandchild sleeper, prints its pid, sleeps.
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(g.pid);
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { try { parent.kill("SIGKILL"); } catch { /* gone */ } });
  let grandPid = null;
  {
    let out = "";
    const deadline = Date.now() + 10_000;
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (Date.now() > deadline) { clearInterval(timer); reject(new Error("grandchild pid never printed")); }
      }, 50);
      parent.stdout.on("data", (chunk) => {
        out += String(chunk);
        const line = out.trim().split("\n")[0];
        const pid = Number(line);
        if (Number.isInteger(pid) && pid > 0) { clearInterval(timer); grandPid = pid; resolve(); }
      });
      parent.on("error", (error) => { clearInterval(timer); reject(error); });
    });
  }
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code !== "ESRCH"; }
  };
  assert.ok(alive(parent.pid), "parent runs before the kill");
  assert.ok(alive(grandPid), "grandchild runs before the kill");
  const exited = new Promise((resolve) => parent.on("exit", resolve));
  assert.equal(await killProcessTree(parent), true, "owned tree was signalled");
  await Promise.race([exited, sleep(10_000).then(() => { throw new Error("parent survived tree kill"); })]);
  const deadline = Date.now() + 10_000;
  while (alive(grandPid)) {
    if (Date.now() > deadline) throw new Error("grandchild survived tree kill");
    await sleep(50);
  }
  t.after(() => { try { process.kill(grandPid, "SIGKILL"); } catch { /* gone */ } });
});

// ---- (4) no module-global stopped flag: later runs still work ----

test("an idle kill does not block the next run", async () => {
  assert.equal(killBasicChild(), false, "idle kill is a safe no-op");
  const dataDir = await scratchTmp("cancel-reuse");
  try {
    const db = openDb(dataDir);
    const job = { id: "job-reuse", user_id: "alice", prompt: "x", seed_time: 0, object_ids: "[]", title: "" };
    const outDir = path.join(dataDir, "specimens", job.id);
    const spawned = {};
    const meta = await runBasicJob({
      db, config: {}, dataDir, job,
      upload: { id: "u", path: MISSING, duration: 2 },
      spawnFn: stubSpawn(spawned, { writeMeta: true, outDir }),
    });
    assert.equal(spawned.fired, true, "the next run still spawns");
    assert.equal(meta.tier, "basic");
    assert.equal(meta.id, job.id);
    db.close();
  } finally {
    await rmQuiet(dataDir);
  }
});

test("a later createApp in the same process still pumps jobs", async (t) => {
  const first = await startApp(t, {});
  first.stop();
  const h = await startApp(t, {});
  const { json: up } = await uploadClip(h.base, {});
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const created = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "lite", objectIds: [1] } });
  assert.equal(created.status, 200);
  assert.equal((await waitFor(h.base, created.json.jobId)).status, "done");
});

// ---- (5) aborted Lite stops before any spend ----

test("an aborted lite job stops before any spend", async () => {
  const dataDir = await scratchTmp("cancel-lite");
  try {
    const db = openDb(dataDir);
    const controller = new AbortController();
    controller.abort();
    const job = { id: "job-lite-abort", user_id: "alice", prompt: "x", seed_time: 0, object_ids: "[]", title: "" };
    const upload = { id: "u", width: 128, height: 96, fps: 10, frames: 20, duration: 2, path: MISSING };
    await assert.rejects(
      runLiteJob({ db, config: {}, dataDir, fileIdCache: new Map(), job, upload, signal: controller.signal }),
      (error) => isCancelError(error)
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 0);
    db.close();
  } finally {
    await rmQuiet(dataDir);
  }
});

// ---- (6) the pump drops a cancelled job: no retry, requeue, or spend ----

test("the pump drops a cancelled job without retry, requeue, or spend", async (t) => {
  const lite = stubRunners().lite;
  const h = await startApp(t, { runners: { lite, basic: async () => { throw cancelledError(); } } });
  const { json: up } = await uploadClip(h.base, {});
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const created = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "basic", objectIds: [1] } });
  assert.equal(created.status, 200);
  const id = created.json.jobId;
  const row = () => h.db.prepare("SELECT status, attempts FROM jobs WHERE id=?").get(id);
  const spend = () => h.db.prepare("SELECT COUNT(*) AS n FROM spend WHERE ref=?").get(id).n;
  for (let i = 0; i < 200 && row().status !== "running"; i += 1) await sleep(25);
  assert.equal(row().status, "running", "the pump picked the job up");
  const booked = spend();
  await sleep(1000);
  assert.equal(row().status, "running", "cancelled jobs are neither done nor failed");
  assert.equal(row().attempts, 0, "no retry reservation");
  assert.equal(spend(), booked, "no retry spend booked");
});

// ---- (7b) app.stop with a real nested child kills the whole tree ----

test("app.stop kills the whole owned tree, not just the parent", async (t) => {
  const fixture = await ensureTreeFixture();
  const h = await startApp(t, {
    runners: { lite: stubRunners().lite, basic: undefined },
    configOverrides: { basicRunner: fixture },
  });
  const { json: up } = await uploadClip(h.base, {});
  await seedSelectionCache(h, up.uploadId, { seedTime: 0 });
  const created = await api(h.base, "POST", "/api/jobs", { body: { uploadId: up.uploadId, tier: "basic", objectIds: [1] } });
  assert.equal(created.status, 200);
  const specDir = path.join(h.dataDir, "specimens", created.json.jobId);
  const parentPid = await pollPid(path.join(specDir, "parent.pid"));
  const grandchildPid = await pollPid(path.join(specDir, "grandchild.pid"));
  assert.ok(alive(parentPid) && alive(grandchildPid), "real nested child is running");
  t.after(() => { for (const pid of [grandchildPid, parentPid]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });
  h.stop(); // the actual app.stop path: tree-kill must precede the abort
  await assertGone(parentPid, "parent survived app.stop tree kill");
  await assertGone(grandchildPid, "grandchild survived app.stop tree kill (orphaned)");
  const row = h.db.prepare("SELECT status, attempts FROM jobs WHERE id=?").get(created.json.jobId);
  assert.equal(row.status, "running", "cancelled job is dropped, not failed");
  assert.equal(row.attempts, 0, "no retry reservation");
});

// ---- (7c) aborting the source signal tree-kills its own child first ----

test("aborting the source signal tree-kills its own active child first", async () => {
  const fixture = await ensureTreeFixture();
  const dataDir = await scratchTmp("src-abort");
  try {
    const controller = new AbortController();
    const job = { id: "job-src-abort", prompt: "x", seed_time: 0, object_ids: "[]", title: "" };
    const pending = runBasicJob({
      db: null,
      config: { basicRunner: fixture },
      dataDir,
      job,
      upload: { id: "u", path: MISSING, duration: 2 },
      signal: controller.signal,
    });
    const parentPid = await pollPid(path.join(dataDir, "specimens", job.id, "parent.pid"));
    const grandchildPid = await pollPid(path.join(dataDir, "specimens", job.id, "grandchild.pid"));
    assert.ok(alive(parentPid) && alive(grandchildPid), "real nested child is running");
    try {
      controller.abort(); // direct source abort, no killBasicChild call
      await assert.rejects(pending, (error) => isCancelError(error));
      await assertGone(parentPid, "parent survived source-abort tree kill");
      await assertGone(grandchildPid, "grandchild survived source-abort tree kill (orphaned)");
    } finally {
      for (const pid of [grandchildPid, parentPid]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  } finally {
    await rmQuiet(dataDir);
  }
});

// ---- (7d) scoped stops cancel only their own runs ----

test("a scoped stop cancels only runs owned by that scope", async () => {
  const dataDir = await scratchTmp("scoped");
  try {
    const db = openDb(dataDir);
    const unrelated = new AbortController().signal; // never aborted, owns nothing
    // runB pending under sigB: an unrelated scoped stop must not touch it.
    let releaseB;
    const gateB = new Promise((resolve) => { releaseB = resolve; });
    let detectB = 0;
    const gatedDetectB = async () => { detectB += 1; await gateB; return { result: { objects: [{ label: "x" }] }, cached: true }; };
    const sigB = new AbortController();
    const outB = path.join(dataDir, "specimens", "job-B");
    const spawnedB = {};
    const runB = runBasicJob({
      db, config: {}, dataDir,
      job: { id: "job-B", user_id: "alice", prompt: "", seed_time: 0, object_ids: "[]", title: "" },
      upload: { id: "u", path: MISSING, duration: 2, width: 128, height: 96, fps: 10, frames: 20 },
      signal: sigB.signal,
      spawnFn: stubSpawn(spawnedB, { writeMeta: true, outDir: outB }),
      _runDetect: gatedDetectB,
    });
    for (let i = 0; i < 200 && !detectB; i += 1) await sleep(10);
    assert.equal(detectB, 1, "runB reached the pending resolve step");
    assert.equal(killBasicChild(unrelated), false, "unrelated scope signals nothing");
    releaseB();
    const metaB = await runB;
    assert.equal(metaB.tier, "basic", "unrelated scoped stop left the run alone");
    assert.equal(spawnedB.fired, true);
    // runC pending under sigC: its own scoped stop cancels it, no spawn.
    let releaseC;
    const gateC = new Promise((resolve) => { releaseC = resolve; });
    let detectC = 0;
    const gatedDetectC = async () => { detectC += 1; await gateC; return { result: { objects: [{ label: "x" }] }, cached: true }; };
    const sigC = new AbortController();
    const spawnedC = {};
    const runC = runBasicJob({
      db, config: {}, dataDir,
      job: { id: "job-C", user_id: "alice", prompt: "", seed_time: 0, object_ids: "[]", title: "" },
      upload: { id: "u", path: MISSING, duration: 2, width: 128, height: 96, fps: 10, frames: 20 },
      signal: sigC.signal,
      spawnFn: stubSpawn(spawnedC),
      _runDetect: gatedDetectC,
    });
    for (let i = 0; i < 200 && !detectC; i += 1) await sleep(10);
    assert.equal(detectC, 1, "runC reached the pending resolve step");
    assert.equal(killBasicChild(sigC.signal), false, "no live child, only a pending run");
    releaseC();
    await assert.rejects(runC, (error) => isCancelError(error));
    assert.equal(spawnedC.fired, undefined, "own scoped stop prevents the spawn");
    // A later run under a fresh scope still works: scoped stops never bump
    // the global generation for other scopes.
    const sigD = new AbortController();
    const outD = path.join(dataDir, "specimens", "job-D");
    const spawnedD = {};
    const metaD = await runBasicJob({
      db, config: {}, dataDir,
      job: { id: "job-D", user_id: "alice", prompt: "x", seed_time: 0, object_ids: "[]", title: "" },
      upload: { id: "u", path: MISSING, duration: 2 },
      signal: sigD.signal,
      spawnFn: stubSpawn(spawnedD, { writeMeta: true, outDir: outD }),
    });
    assert.equal(spawnedD.fired, true, "fresh scope proceeds after a scoped stop");
    assert.equal(metaD.tier, "basic");
    db.close();
  } finally {
    await rmQuiet(dataDir);
  }
});

// ---- (7) no extra model retry after abort ----

test("model retry stops without extra attempts after abort", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    withModelRetry(async () => {
      calls += 1;
      controller.abort();
      throw Object.assign(new Error("404 The requested model was not found."), { status: 404 });
    }, { signal: controller.signal, wait: async () => {} }),
    (error) => isCancelError(error)
  );
  assert.equal(calls, 1, "no retry after abort");

  const preAborted = new AbortController();
  preAborted.abort();
  let preCalls = 0;
  await assert.rejects(
    withModelRetry(async () => { preCalls += 1; return "ok"; }, { signal: preAborted.signal, wait: async () => {} }),
    (error) => isCancelError(error)
  );
  assert.equal(preCalls, 0, "no first attempt after abort");
});
