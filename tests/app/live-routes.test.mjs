import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test, assert, startApp, api, uploadClip, headers } from "./support.js";
import { Run, getRun } from "../../backend/lib/live.js";
import { reconstructAvailable, reconstructWorld } from "../../backend/lib/reconstruct.js";

const live = reconstructAvailable();

test("/api/me says whether this server can build Advanced live", async (t) => {
  const on = await startApp(t);
  assert.equal((await api(on.base, "GET", "/api/me")).json.live, live);
  const off = await startApp(t, { configOverrides: { liveAdvanced: false } });
  assert.equal((await api(off.base, "GET", "/api/me")).json.live, false);
});

test("live routes refuse when switched off, and never book anything", async (t) => {
  const { base, db } = await startApp(t, { configOverrides: { liveAdvanced: false } });
  const { json: up } = await uploadClip(base, {});
  for (const route of ["prepare", "detect", "build"]) {
    const res = await api(base, "POST", `/api/live/${route}`, { body: { uploadId: up.uploadId, time: 0, objects: [{ label: "bear", box: {} }] } });
    assert.equal(res.status, route === "prepare" ? 503 : 503, route);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
});

test("detect-more validates owner, source and prompts before spending", async (t) => {
  const { base, db } = await startApp(t);
  const { json: up } = await uploadClip(base, { user: "alice" });
  const alice = (await api(base, "GET", "/api/me", { user: "alice" })).json.id;
  const run = new Run("detect", up.uploadId, os.tmpdir(), { owner: alice });
  const request = (body, user = "alice") => api(base, "POST", "/api/live/detect-more", { user, body: { uploadId: up.uploadId, runId: run.id, ...body } });
  assert.equal((await request({ concept: "kayak" }, "mallory")).status, 404);
  assert.equal((await request({})).status, 400);
  assert.equal((await request({ concept: "kayak", box: {} })).status, 400);
  assert.equal((await request({ box: { left: 0, top: 0, right: 2, bottom: 1 } })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
});

test("a live build needs one to three subjects of one kind, and is refused before any spend", { skip: !live }, async (t) => {
  const { base, db } = await startApp(t);
  const { json: up } = await uploadClip(base, {});
  const box = { left: 0.1, top: 0.1, right: 0.4, bottom: 0.4 };
  const none = await api(base, "POST", "/api/live/build", { body: { uploadId: up.uploadId, time: 0, objects: [] } });
  assert.equal(none.status, 400);
  const four = await api(base, "POST", "/api/live/build", { body: { uploadId: up.uploadId, time: 0, objects: Array(4).fill({ label: "bear", box }) } });
  assert.equal(four.status, 400);
  const mixed = await api(base, "POST", "/api/live/build", { body: { uploadId: up.uploadId, time: 0, objects: [{ label: "bear", box }, { label: "person", box }] } });
  assert.equal(mixed.status, 400);
  assert.match(mixed.json.error, /one selected subject|single object/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("live build accepts Basic as a tier before validating subjects", async (t) => {
  const { base, db } = await startApp(t);
  const { json: up } = await uploadClip(base, {});
  const res = await api(base, "POST", "/api/live/build", { body: { uploadId: up.uploadId, tier: "basic", objects: [] } });
  assert.equal(res.status, live ? 400 : 503);
  if (live) assert.match(res.json.error, /one to three subjects/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
});

test("world reconstruction passes the cloud stop only when requested", async (t) => {
  const calls = [];
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const previous = process.env.WORLD_STOP_AFTER;
  delete process.env.WORLD_STOP_AFTER;
  t.after(() => { if (previous !== undefined) process.env.WORLD_STOP_AFTER = previous; });
  const options = { workDir: "work", videoPath: "video", name: "name", webClip: "clip", onStage() {} };
  await reconstructWorld({ ...options, stopAfter: "cloud" });
  await reconstructWorld(options);
  assert.equal(calls[0].env.WORLD_STOP_AFTER, "cloud");
  assert.equal(calls[1].env.WORLD_STOP_AFTER, undefined);
  assert.deepEqual(calls[0].args, calls[1].args);
});

test("stored Basic cloud files remain private without an in-memory run", async (t) => {
  const { base, db, dataDir } = await startApp(t);
  const { json: up } = await uploadClip(base, { user: "alice" });
  const user = (await api(base, "GET", "/api/me", { user: "alice" })).json.id;
  const id = "a0000000-0000-4000-8000-000000000000", pack = "live-aabbccdd";
  const dir = path.join(dataDir, "uploads", up.uploadId, pack, "world", "live");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "cloud.json"), "{\"bg\":{}}");
  const now = Date.now();
  db.prepare("INSERT INTO jobs(id,user_id,upload_id,tier,object_ids,prompt,seed_time,title,subject,email,selection_snapshot,status,stage,detail,progress,sam_frames,result,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, user, up.uploadId, "basic", "[]", "", 0, "cloud", "moose", "", "", "done", "done", "Ready.", 1, 0, JSON.stringify({ pack, tier: "basic", viewer: `basic-cloud.html?job=${id}` }), null, now, now);
  const url = `${base}/api/live/basic/${id}/files/cloud.json`;
  const own = await fetch(url, { headers: headers("alice") });
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { bg: {} });
  assert.equal((await fetch(url, { headers: headers("mallory") })).status, 404);
  assert.equal((await fetch(`${base}/api/live/basic/${id}/files/secret.txt`, { headers: headers("alice") })).status, 404);
});

test("live build rejects an unknown tier before spending", async (t) => {
  const { base, db } = await startApp(t);
  const { json: up } = await uploadClip(base, {});
  const res = await api(base, "POST", "/api/live/build", { body: { uploadId: up.uploadId, tier: "other", objects: [{ label: "bear", box: {} }] } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /tier/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
});

test("live frame stride rejects invalid or non-Lite sampling before spending", async (t) => {
  const { base, db } = await startApp(t);
  const { json: upload } = await uploadClip(base, {});
  for (const frameStride of [0, -1, 1.5, 11, "2", false]) {
    const r = await api(base, "POST", "/api/live/build", { body: { uploadId: upload.uploadId, tier: "lite", frameStride, objects: [] } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /frameStride/);
  }
  const r = await api(base, "POST", "/api/live/build", { body: { uploadId: upload.uploadId, tier: "advanced", frameStride: 2, objects: [] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Lite/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend").get().n, 0);
});

test("live SSE resumes after Last-Event-ID and follows new events", async (t) => {
  const { base } = await startApp(t);
  const run = new Run("build", "clip", os.tmpdir());
  run.emit({ type: "note", text: "already seen" });
  run.emit({ type: "note", text: "replayed" });
  const response = await fetch(`${base}/api/live/${run.id}/events`, { headers: { ...headers(), "Last-Event-ID": "0" } });
  assert.equal(response.status, 200);
  run.finish("failed", { type: "error", message: "builder crashed" });
  const text = await response.text();
  assert.doesNotMatch(text, /already seen/);
  assert.match(text, /id: 1\ndata: .*replayed/);
  assert.match(text, /"type":"error","message":"builder crashed"/);
  assert.match(text, /event: end/);
});

for (const concurrentLiveBuilds of [false, true]) {
  test(`live builds ${concurrentLiveBuilds ? "run concurrently in the demo" : "retain the normal per-user lock"}`, { skip: !live }, async (t) => {
    const { base, dataDir } = await startApp(t, { configOverrides: { concurrentLiveBuilds } });
    const user = concurrentLiveBuilds ? "parallel" : "serial";
    const { json: upload } = await uploadClip(base, { user });
    const pending = [], runs = [];
    const mkdir = fsp.mkdir;
    // Hold each real run before processing: test admission/lifecycle without model calls or GPU work.
    t.mock.method(fsp, "mkdir", (dir, ...args) => {
      if (path.dirname(dir) === path.join(dataDir, "uploads", upload.uploadId) && path.basename(dir).startsWith("live-")) {
        return new Promise((resolve, reject) => pending.push(reject));
      }
      return mkdir(dir, ...args);
    });
    const build = async (frameStride = 1) => {
      const response = await api(base, "POST", "/api/live/build", { user, body: {
        uploadId: upload.uploadId, tier: "lite", time: 0, frameStride,
        objects: [{ label: "bear", box: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.4 } }],
      } });
      if (response.status === 200) runs.push(getRun(response.json.runId));
      return response;
    };
    try {
      const responses = await Promise.all([build(1), build(2)]);
      assert.deepEqual(responses.map(r => r.status).sort(), concurrentLiveBuilds ? [200, 200] : [200, 409]);
      assert.equal(new Set(runs.map(r => r.dir)).size, runs.length, "runs must have isolated output folders");
      assert.equal((await api(base, "POST", `/api/live/${runs[0].id}/cancel`, { user: "mallory" })).status, 404);
      assert.equal((await api(base, "POST", `/api/live/${runs[0].id}/cancel`, { user })).json.stopped, true);
      if (concurrentLiveBuilds) assert.equal(runs[1].status, "running", "cancelling one must leave the other running");
      assert.equal((await build(10)).status, 200, "the highest supported stride can start after one stops");
      // Opting into concurrency must not bypass the emergency stop.
      await api(base, "POST", "/api/admin/kill", { body: { enabled: true }, user: "owner", role: "owner" });
      assert.equal((await build()).status, 503);
      assert.equal((await api(base, "POST", "/api/live/cancel-all", { user, body: {} })).json.stopped, concurrentLiveBuilds ? 2 : 1);
      assert.ok(runs.every(r => r.status === "cancelled"));
    } finally {
      for (const run of runs) run.cancel();
      for (const reject of pending) reject(new Error("Test run cancelled before processing."));
      await new Promise(resolve => setImmediate(resolve));
    }
  });
}

test("the kill switch stops live detect and build", { skip: !live }, async (t) => {
  const { base } = await startApp(t);
  const { json: up } = await uploadClip(base, {});
  const owner = (await api(base, "GET", "/api/me")).json.id;
  const run = new Run("detect", up.uploadId, os.tmpdir(), { owner });
  assert.equal((await api(base, "POST", "/api/admin/kill", { body: { enabled: true }, user: "owner", role: "owner" })).status, 200);
  assert.equal((await api(base, "POST", "/api/live/detect", { body: { uploadId: up.uploadId, time: 0 } })).status, 503);
  assert.equal((await api(base, "POST", "/api/live/detect-more", { body: { uploadId: up.uploadId, runId: run.id, concept: "kayak" } })).status, 503);
  assert.equal((await api(base, "POST", "/api/live/build", { body: { uploadId: up.uploadId, time: 0, objects: [{ label: "bear", box: {} }] } })).status, 503);
});

test("another user's clip and run stay private; files cannot leave the run's folder", { skip: !live }, async (t) => {
  const { base } = await startApp(t);
  const { json: up } = await uploadClip(base, { user: "alice" });
  assert.equal((await api(base, "POST", "/api/live/prepare", { body: { uploadId: up.uploadId }, user: "mallory" })).status, 404);

  const alice = (await api(base, "GET", "/api/me", { user: "alice" })).json.id;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "construct-live-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, "frame.jpg"), "jpg");
  await fsp.writeFile(path.join(path.dirname(dir), "secret.txt"), "secret");
  const run = new Run("detect", up.uploadId, dir, { owner: alice });
  run.stage("frame", "Pulling the frame");
  run.finish("done", { type: "done" });

  const own = await fetch(`${base}/api/live/${run.id}/events`, { headers: headers("alice") });
  assert.equal(own.status, 200);
  const text = await own.text();
  assert.match(text, /"type":"stage"/);
  assert.match(text, /event: end/);
  assert.equal((await fetch(`${base}/api/live/${run.id}/events`, { headers: headers("mallory") })).status, 404);

  assert.equal((await fetch(`${base}/api/live/${run.id}/files/frame.jpg`, { headers: headers("alice") })).status, 200);
  assert.equal((await fetch(`${base}/api/live/${run.id}/files/frame.jpg`, { headers: headers("mallory") })).status, 404);
  assert.equal((await fetch(`${base}/api/live/${run.id}/files/..%2Fsecret.txt`, { headers: headers("alice") })).status, 404);
  assert.equal((await fetch(`${base}/api/live/rdeadbeef00/events`, { headers: headers("alice") })).status, 404);
});

test("Stop ends a user's running runs and only touches its owner's runs", { skip: !live }, async (t) => {
  const { base } = await startApp(t);
  const alice = (await api(base, "GET", "/api/me", { user: "alice" })).json.id;
  const bob = (await api(base, "GET", "/api/me", { user: "bob" })).json.id;
  const mine = new Run("build", "clip", os.tmpdir(), { owner: alice });
  const theirs = new Run("build", "clip", os.tmpdir(), { owner: bob });
  assert.equal((await api(base, "POST", `/api/live/${mine.id}/cancel`, { user: "bob" })).status, 404);       // not bob's run
  assert.ok((await api(base, "POST", "/api/live/cancel-all", { body: {}, user: "alice" })).json.stopped >= 1);   // earlier tests leave runs of the same user behind
  assert.equal(mine.status, "cancelled");
  assert.equal(mine.events.at(-1).type, "cancelled");
  assert.equal(mine.abort.signal.aborted, true);
  assert.equal(theirs.status, "running");
  assert.equal(mine.cancel(), false, "a stopped run cannot be stopped twice");
});
