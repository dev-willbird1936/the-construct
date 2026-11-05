// Loop 7 (tier-improve 2026-11-04): the site's default seed time is 0 (the
// scrubber starts at the first frame). A click there carries a frame-0 seed
// box. Without an explicit --seed 0, run-basic fell back to its 1.0 s default
// and matched the frame-0 box against the track one second later.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { runBasicJob } from "../../backend/app/runner-basic.js";
import { openDb } from "../../backend/app/db.js";

async function argsFor(t, { seedTime, snapshot, prompt = "" }) {
  const dataDir = await fsp.mkdtemp("/tmp/the-construct/tier-improve/basic/test-seed-zero-");
  const db = openDb(dataDir);
  t.after(async () => { db.close(); await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {}); });
  const job = { id: "job-seed", user_id: "alice", prompt, seed_time: seedTime, object_ids: snapshot ? "[1]" : "[]", selection_snapshot: snapshot ? JSON.stringify(snapshot) : "", title: "" };
  const upload = { id: "u", path: "unused.mp4", duration: 2, fps: 10, frames: 20, width: 128, height: 96 };
  let captured = null;
  const spawnFn = (cmd, args, opts, cb) => {
    captured = { args, cb };
    return { killed: false, exitCode: null, kill() {}, stdout: { on() {} }, stderr: { on() {} } };
  };
  const pending = runBasicJob({ db, config: { basicRunner: "run-basic.mjs" }, dataDir, job, upload, spawnFn, _measureCamera: async () => ({ confident: true, moving: false }) });
  for (let i = 0; i < 200 && !captured; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(captured, "child spawned");
  captured.cb({ code: 1, signal: null });
  await assert.rejects(pending);
  return captured.args;
}

const clickAt = (seedTime, frameIndex) => ({
  version: 1, uploadId: "u", frameIndex, seedTime, frameWidth: 128, frameHeight: 96,
  objects: [{ id: 1, label: "mug", box: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 } }],
});

test("a click on the first frame forwards --seed 0 with its seed box", async (t) => {
  const args = await argsFor(t, { seedTime: 0, snapshot: clickAt(0, 0) });
  const at = args.indexOf("--seed");
  assert.ok(at !== -1, "--seed forwarded");
  assert.equal(args[at + 1], "0");
  assert.ok(args.includes("--seed-box"));
});

test("a later click still forwards its own seed time", async (t) => {
  const args = await argsFor(t, { seedTime: 1, snapshot: clickAt(1, 10) });
  assert.equal(args[args.indexOf("--seed") + 1], "1");
});

test("an automatic job at time 0 keeps run-basic's default seed (no --seed)", async (t) => {
  const args = await argsFor(t, { seedTime: 0, prompt: "mug" });
  assert.equal(args.includes("--seed"), false);
  assert.equal(args.includes("--seed-box"), false);
});
