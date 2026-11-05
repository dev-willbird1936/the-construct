import assert from "node:assert";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createApp } from "../../backend/app/app.js";
import { installGate } from "../../backend/app/test-support/fake-gate.js";
import { __resetBuckets } from "../../backend/app/quotas.js";

const run = promisify(execFile);

export const workerToken = "test-worker-token";

export function fakeDetect() {
  return {
    frameWidth: 128,
    frameHeight: 96,
    objects: [{ id: 1, label: "test-object", box: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 } }],
    indexMapPngBase64: "e30=",
    _internal: { accepted: [{ concept: "test-object", mask: new Uint8Array(128 * 96).fill(1), box: { left: 0, top: 0, right: 10, bottom: 10 } }] },
  };
}

export function stubRunners(specimensPreload) {
  return {
    lite: async ({ dataDir, job }) => finish(dataDir, job, "lite"),
    basic: async ({ dataDir, job, onProgress }) => {
      // Progress lines without fractions, like the real run-basic.mjs.
      onProgress?.({ stage: "basic", detail: "tracking" });
      return finish(dataDir, job, "basic");
    },
  };
  async function finish(dataDir, job, tier) {
    const dir = path.join(dataDir, "specimens", job.id);
    await fsp.mkdir(dir, { recursive: true });
    const result = {
      id: job.id, tier, title: job.title || `test ${tier}`, subject: "test-object",
      viewer: tier === "basic" ? `view-basic.html?id=${job.id}` : `view-lite.html?id=${job.id}`,
      thumb: `specimens/${job.id}/thumb.webp`,
      durationSec: 2, bytes: 10,
      meta: { camera: "fixed", category: "other", provenance: ["sam-3.1", "muse-spark-1.3"] },
    };
    await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(result));
    await fsp.writeFile(path.join(dir, "thumb.webp"), Buffer.from("WEBP"));
    if (specimensPreload) await specimensPreload(dir);
    return result;
  }
}

export async function startApp(t, overrides = {}) {
  __resetBuckets();
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "construct-app-"));
  const handle = await createApp({
    dataDir,
    gate: { installGate },
    runners: stubRunners(),
    detectFn: async () => ({ result: fakeDetect(), frameIndex: 0, concepts: ["test-object"] }),
    sparkFn: async () => ({ category: "other", camera: "fixed", subjects: ["test-object"], warnings: [] }),
    configOverrides: { workerToken, ...(overrides.configOverrides || {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "configOverrides")),
  });
  const server = await new Promise((resolve) => {
    const s = handle.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    handle.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  return { ...handle, base, dataDir };
}

export const headers = (user = "alice", role = "user", ip = null) => ({
  "x-test-user": user,
  "x-test-email": `${user}@example.test`,
  "x-test-role": role,
  ...(ip ? { "x-test-ip": ip } : {}),
});

export async function api(base, method, route, { body, user = "alice", role = "user", token, ip } = {}) {
  const h = { ...headers(user, role, ip) };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${base}${route}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* empty body (204) */ }
  return { status: res.status, json };
}

let clipCache = null;
export async function fixtureClip() {
  if (clipCache) return clipCache;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "construct-clip-"));
  const file = path.join(dir, "clip.mp4");
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=128x96:rate=10:duration=2", "-pix_fmt", "yuv420p", file]);
  clipCache = file;
  return file;
}

// Selection fixtures: seed the server's exact cached detect for upload+seed
// frame BEFORE enqueueing a job with objectIds (production POST /jobs builds
// its immutable snapshot from that cache and rejects a missing/stale entry
// before any spend). Call this after uploadClip, before POST /api/jobs.
export async function seedSelectionCache(handle, uploadId, { seedTime = 0 } = {}) {
  const { frameIndexFor, __seedDetectCache } = await import("../../backend/app/detect-cache.js");
  const upload = handle.db.prepare("SELECT * FROM uploads WHERE id=?").get(uploadId);
  if (!upload) throw new Error(`seedSelectionCache: unknown upload ${uploadId}`);
  const frameIndex = frameIndexFor(upload, seedTime);
  __seedDetectCache(uploadId, frameIndex, fakeDetect());
  return frameIndex;
}

export async function uploadClip(base, { user = "alice", rights = "1", clip, name = "clip.mp4", ip } = {}) {
  const file = clip || (await fixtureClip());
  const form = new FormData();
  form.append("video", new Blob([await fsp.readFile(file)]), name);
  if (rights !== null) form.append("rights", rights);
  const res = await fetch(`${base}/api/upload`, { method: "POST", headers: headers(user, "user", ip), body: form });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export async function waitFor(base, jobId, { user = "alice", timeout = 10_000 } = {}) {
  const start = Date.now();
  for (;;) {
    const { json } = await api(base, "GET", `/api/jobs/${jobId}`, { user });
    if (json.status === "done" || json.status === "failed") return json;
    assert.ok(Date.now() - start < timeout, `job ${jobId} did not finish in time (still ${json.status})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export { test, assert };
