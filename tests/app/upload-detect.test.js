import { test, assert, startApp, api, uploadClip, fakeDetect } from "./support.js";

test("upload requires a rights attestation and probes the clip", async (t) => {
  const { base } = await startApp(t);
  const noRights = await uploadClip(base, { rights: null });
  assert.equal(noRights.status, 400);
  assert.match(noRights.json.error, /Rights attestation/);

  const { status, json } = await uploadClip(base, {});
  assert.equal(status, 200);
  assert.ok(json.uploadId);
  assert.equal(json.width, 128);
  assert.equal(json.height, 96);
  assert.equal(json.frameCount, 20);
});

test("upload enforces size and duration caps", async (t) => {
  const { base } = await startApp(t, { configOverrides: { maxUploadMB: 0.00001 } });
  const over = await uploadClip(base, {});
  assert.equal(over.status, 413);

  const short = await startApp(t, { configOverrides: { maxClipSec: 1 } });
  const long = await uploadClip(short.base, {});
  assert.equal(long.status, 422);
  assert.match(long.json.error, /seconds or shorter/);
});

test("detect validates input and surfaces Meta failure as 502", async (t) => {
  const { base } = await startApp(t);
  const { json: up } = await uploadClip(base, {});

  const missing = await api(base, "POST", "/api/detect", { body: { time: 0 } });
  assert.equal(missing.status, 400);

  const unknown = await api(base, "POST", "/api/detect", { body: { uploadId: "nope", time: 0 } });
  assert.equal(unknown.status, 404);

  const noPrompt = await api(base, "POST", "/api/detect-custom", { body: { uploadId: up.uploadId, time: 0 } });
  assert.equal(noPrompt.status, 400);

  const ok = await api(base, "POST", "/api/detect", { body: { uploadId: up.uploadId, time: 0.5 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.objects[0].label, "test-object");

  const alias = await api(base, "POST", "/api/detect", { body: { jobId: up.uploadId, time: 0.5 } });
  assert.equal(alias.status, 200);

  const failing = await startApp(t, {
    detectFn: async () => { throw new Error("proxy down (ECONNREFUSED 127.0.0.1:9, request-id abc)"); },
  });
  const up2 = await uploadClip(failing.base, {});
  const bad = await api(failing.base, "POST", "/api/detect", { body: { uploadId: up2.json.uploadId, time: 0 } });
  assert.equal(bad.status, 502);
  // Internals (addresses, request ids) never reach the client.
  assert.equal(bad.json.error, "Detection failed. Try another frame or a shorter clip.");
});

test("spark proposes concepts before the sam sweep, with ledger rows", async (t) => {
  let seen;
  const { base, db } = await startApp(t, {
    detectFn: async (args) => { seen = args; return { result: fakeDetect(), frameIndex: 1, concepts: args.baseConcepts, cached: false }; },
    sparkFn: async () => ({ category: "wildlife", camera: "fixed", subjects: ["Zebra"], warnings: [] }),
  });
  const { json: up } = await uploadClip(base, {});
  const ok = await api(base, "POST", "/api/detect", { body: { uploadId: up.uploadId, time: 0.5 } });
  assert.equal(ok.status, 200);
  assert.ok(seen.baseConcepts.includes("zebra"));
  assert.ok(seen.baseConcepts.length < 68);
  const kinds = db.prepare("SELECT kind, units, model FROM spend ORDER BY created_at").all();
  assert.ok(kinds.some((r) => r.kind === "route" && r.model === "muse-spark-1.3" && r.units === 1));
  assert.ok(kinds.some((r) => r.kind === "detect" && r.model === "sam-3.1" && r.units === seen.baseConcepts.length));
  const me = await api(base, "GET", "/api/me");
  assert.ok(me.json.spendTodayCents > 0);
});

test("detect falls back to a small broad sweep (never the full vocabulary) when spark fails, and says so when SAM is down", async (t) => {
  let seen;
  const { base } = await startApp(t, {
    detectFn: async (args) => { seen = args; return { result: fakeDetect(), frameIndex: 1, concepts: ["x"], cached: true }; },
    sparkFn: async () => { throw new Error("proxy down"); },
  });
  const { json: up } = await uploadClip(base, {});
  const ok = await api(base, "POST", "/api/detect", { body: { uploadId: up.uploadId, time: 0 } });
  assert.equal(ok.status, 200);
  assert.ok(seen.baseConcepts.includes("animal") && seen.baseConcepts.length <= 16);

  // an outage of the segmentation service is reported as unavailable (503), not as an empty picture
  const down = await startApp(t, {
    detectFn: async () => { throw Object.assign(new Error("The segmentation service is temporarily unavailable. Try again in a minute."), { retryable: true }); },
    sparkFn: async () => ({ category: "wildlife", camera: "fixed", subjects: ["fox"], warnings: [] }),
  });
  const { json: up2 } = await uploadClip(down.base, {});
  const out = await api(down.base, "POST", "/api/detect", { body: { uploadId: up2.uploadId, time: 0 } });
  assert.equal(out.status, 503);
  assert.match(out.json.error, /temporarily unavailable/);
});

test("identical detect repeats reuse the cached SAM result", async (t) => {
  const { runDetect, __resetDetectCache } = await import("../../backend/app/detect-cache.js");
  __resetDetectCache();
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return { frameWidth: 4, frameHeight: 4, objects: [], _internal: { accepted: [] } };
  };
  const upload = { id: "cache-u", path: "nowhere.mp4", fps: 10, frames: 20, width: 4, height: 4 };
  // Seed the still so no ffmpeg is needed.
  const { default: fsp } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { default: os } = await import("node:os");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cache-u-"));
  await fsp.mkdir(path.join(dir, "uploads", "cache-u"), { recursive: true });
  await fsp.writeFile(path.join(dir, "uploads", "cache-u", "frame_5.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  await runDetect({ dataDir: dir, upload, time: 0.5, extraConcepts: ["cougar"], baseConcepts: ["animal"], _detectObjects: fake });
  await runDetect({ dataDir: dir, upload, time: 0.5, extraConcepts: ["cougar"], baseConcepts: ["animal"], _detectObjects: fake });
  assert.equal(calls, 1);
  await runDetect({ dataDir: dir, upload, time: 0.5, extraConcepts: ["cougar", "bear"], baseConcepts: ["animal"], _detectObjects: fake });
  assert.equal(calls, 2);
  await fsp.rm(dir, { recursive: true, force: true });
});

test("route is permissive when Spark fails", async (t) => {
  const { base } = await startApp(t);
  const { json: up } = await uploadClip(base, {});
  const ok = await api(base, "POST", "/api/route", { body: { uploadId: up.uploadId } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.category, "other");
  assert.equal(ok.json.camera, "fixed");

  const failing = await startApp(t, { sparkFn: async () => { throw new Error("proxy down"); } });
  const up2 = await uploadClip(failing.base, {});
  const sad = await api(failing.base, "POST", "/api/route", { body: { uploadId: up2.json.uploadId } });
  assert.equal(sad.status, 200);
  assert.equal(sad.json.category, "unknown");
  assert.ok(sad.json.warnings.length > 0);
  assert.ok(!("decline" in sad.json));
});

test("route: content categories and legacy declines stay advisory", async (t) => {
  let route;
  const { base } = await startApp(t, {
    cameraFn: async () => ({ cuts: 0, measured: null }),
    sparkFn: async () => route,
  });
  const { json: up } = await uploadClip(base, {});
  for (const [category, subject, warning] of [
    ["other", "humanoid 3D model", "synthetic CGI render"],
    ["other", "game character", "screen recording"],
    ["drone", "building", "aerial footage"],
    ["person", "crowd", "more than 12 people"],
    ["product", "glass of water", "transparent subject"],
  ]) {
    route = { category, camera: "fixed", subjects: [subject], warnings: [warning], decline: `Legacy rejection: ${warning}` };
    const result = await api(base, "POST", "/api/route", { body: { uploadId: up.uploadId } });
    assert.equal(result.status, 200);
    assert.ok(!("decline" in result.json), warning);
    assert.ok(result.json.recommend.tier, warning);
    assert.deepEqual(result.json.subjects, [subject]);
    assert.ok(result.json.warnings.includes(warning));
    assert.ok(result.json.warnings.some((w) => w.includes("Legacy rejection:") && w.includes("advisory")));
  }
});

test("route: cuts remain advisory when Spark is unavailable", async (t) => {
  const { base } = await startApp(t, {
    cameraFn: async () => ({ cuts: 3, measured: null }),
    sparkFn: async () => { throw new Error("proxy down"); },
  });
  const { json: up } = await uploadClip(base, {});
  const result = await api(base, "POST", "/api/route", { body: { uploadId: up.uploadId } });
  assert.equal(result.status, 200);
  assert.ok(!("decline" in result.json));
  assert.equal(result.json.cuts, 3);
  assert.equal(result.json.recommend.tier, "basic");
  assert.ok(result.json.warnings.some((w) => /unavailable/i.test(w)));
  assert.ok(result.json.warnings.some((w) => /hard cuts/i.test(w)));
});

test("route: hard cuts warn without skipping Spark; measured confident motion routes to Lite, matching the Basic runner", async (t) => {
  let sparkCalls = 0;
  const cuts = await startApp(t, {
    cameraFn: async () => ({ cuts: 2, measured: null }),
    sparkFn: async () => { sparkCalls += 1; return { category: "wildlife", camera: "fixed", subjects: ["fox"], warnings: [] }; },
  });
  const { json: up } = await uploadClip(cuts.base, {});
  const edited = await api(cuts.base, "POST", "/api/route", { body: { uploadId: up.uploadId } });
  assert.equal(edited.status, 200);
  assert.ok(!("decline" in edited.json));
  assert.equal(edited.json.cuts, 2);
  assert.ok(edited.json.warnings.some((w) => /hard cuts/i.test(w)));
  assert.equal(edited.json.recommend.tier, "basic");
  assert.deepEqual(edited.json.subjects, ["fox"]);
  assert.equal(sparkCalls, 1);

  const moving = await startApp(t, {
    cameraFn: async () => ({ cuts: 0, measured: { moving: true, shiftPx: 7, confident: true } }),
    sparkFn: async () => ({ category: "wildlife", camera: "fixed", subjects: ["fox"], warnings: [] }),
  });
  const { json: up2 } = await uploadClip(moving.base, {});
  const r = await api(moving.base, "POST", "/api/route", { body: { uploadId: up2.uploadId } });
  assert.equal(r.json.camera, "moving");
  // runner-basic refuses a confidently moving camera at job start, so the route recommends Lite
  assert.equal(r.json.recommend.tier, "lite");
  assert.ok(r.json.warnings.some((w) => /camera moves.*steady camera/.test(w)));

  const fixed = await startApp(t, {
    cameraFn: async () => ({ cuts: 0, measured: { moving: false, shiftPx: 0, confident: true } }),
    sparkFn: async () => ({ category: "wildlife", camera: "fixed", subjects: ["fox"], warnings: [] }),
  });
  const { json: up3 } = await uploadClip(fixed.base, {});
  const ok = await api(fixed.base, "POST", "/api/route", { body: { uploadId: up3.uploadId } });
  assert.equal(ok.json.recommend.tier, "basic");
});
