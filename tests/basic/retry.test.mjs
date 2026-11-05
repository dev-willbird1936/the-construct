import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { postImageEdit, museWaitLine, museEditPlate } from "../../backend/pipeline/basic/run-basic.mjs";

const require = createRequire(import.meta.url);
const sharp = require("../../backend/node_modules/sharp");

// Fake fetch script: each entry is either {status, body, retryAfter} or
// {throw: message}. Responses expose clone()/text() like real ones.
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step.throw) throw new Error(step.throw);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (k) => (k === "retry-after" ? step.retryAfter ?? null : null) },
      clone() { return this; },
      async text() { return step.body ?? ""; },
    };
  };
  return { impl, calls };
}

const MODEL_404_BODY = "404 The requested model was not found";
const opts = (fetchImpl, sleeps, extra = {}) => {
  const counter = { buildForms: 0 };
  return {
    headers: { authorization: "Bearer x" },
    counter,
    buildForm() { counter.buildForms += 1; return { fake: "form" }; },
    fetchImpl,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    ...extra,
  };
};

test("retries the transient model 404 then succeeds (form rebuilt)", async () => {
  const { impl, calls } = fakeFetch([
    { status: 404, body: MODEL_404_BODY },
    { status: 404, body: '{"error":{"code":"model_not_found"}}' },
    { status: 200, body: "{}" },
  ]);
  const sleeps = [];
  const o = opts(impl, sleeps);
  const res = await postImageEdit("http://x/v1/images/edits", o);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(o.counter.buildForms, 3, "multipart form rebuilt per attempt");
  assert.equal(sleeps.length, 2);
  for (const ms of sleeps) assert.ok(ms >= 200 && ms <= 12000, `backoff ${ms}ms in range`);
});

test("a 404 for anything else is not retried", async () => {
  const { impl, calls } = fakeFetch([{ status: 404, body: "no such endpoint" }]);
  const sleeps = [];
  const res = await postImageEdit("http://x/v1/images/edits", opts(impl, sleeps));
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("429 honours Retry-After then succeeds", async () => {
  const { impl, calls } = fakeFetch([
    { status: 429, body: "slow down", retryAfter: "0" },
    { status: 200, body: "{}" },
  ]);
  const sleeps = [];
  const res = await postImageEdit("http://x/v1/images/edits", opts(impl, sleeps));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [0]);
});

test("503 backs off then succeeds", async () => {
  const { impl, calls } = fakeFetch([
    { status: 503, body: "overloaded" },
    { status: 200, body: "{}" },
  ]);
  const sleeps = [];
  const res = await postImageEdit("http://x/v1/images/edits", opts(impl, sleeps));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test("gives up after maxRetries and returns the last response", async () => {
  const { impl, calls } = fakeFetch([{ status: 503, body: "overloaded" }]);
  const sleeps = [];
  const res = await postImageEdit("http://x/v1/images/edits", opts(impl, sleeps, { maxRetries: 2 }));
  assert.equal(res.status, 503, "caller maps this to the non-generative fallback");
  assert.equal(calls.length, 3, "initial + 2 retries");
  assert.equal(sleeps.length, 2);
});

test("network errors retry, then throw when exhausted", async () => {
  const { impl, calls } = fakeFetch([{ throw: "boom" }]);
  const sleeps = [];
  await assert.rejects(
    postImageEdit("http://x/v1/images/edits", opts(impl, sleeps, { maxRetries: 1 })),
    /boom/
  );
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test("museWaitLine pins the app-visible progress string", () => {
  assert.equal(museWaitLine(3), "plate: waiting for Meta image model (3)");
});

// Fake clock: virtual time only advances through the injected sleep.
function fakeClock() {
  let now = 0;
  const sleeps = [];
  return {
    nowImpl: () => now,
    sleepImpl: async (ms) => { sleeps.push(ms); now += ms; },
    sleeps,
    now: () => now,
  };
}

test("patience outlasts bursts: endless model-404s run the full budget", async () => {
  const { impl, calls } = fakeFetch([{ status: 404, body: MODEL_404_BODY }]);
  const clock = fakeClock();
  const retries = [];
  const st = {};
  const res = await postImageEdit("http://x/v1/images/edits", {
    headers: {},
    buildForm() { return { fake: "form" }; },
    fetchImpl: impl,
    sleepImpl: clock.sleepImpl,
    nowImpl: clock.nowImpl,
    patienceSec: 240,
    stats: st,
    onRetry: (n) => retries.push(n),
  });
  assert.equal(res.status, 404);
  assert.ok(calls.length > 9, `patience beats the old ~8-try cap (${calls.length} attempts)`);
  assert.ok(clock.now() <= 240_000, `total wait within budget (${clock.now()}ms)`);
  for (const ms of clock.sleeps) assert.ok(ms <= 30_000, `backoff capped at ~30s (${ms}ms)`);
  assert.deepEqual(retries, Array.from({ length: calls.length - 1 }, (_, i) => i + 1));
  assert.equal(st.exhausted, true);
  assert.equal(st.unreachable, true, "budget exited on all-transient failures");
  assert.equal(st.lastStatus, 404);
});

test("unreachable is false on success and on non-transient failure", async () => {
  const okFetch = fakeFetch([{ status: 200, body: "{}" }]);
  const stOk = {};
  const ok = await postImageEdit("http://x/v1/images/edits", {
    ...opts(okFetch.impl, []), stats: stOk,
  });
  assert.equal(ok.status, 200);
  assert.equal(stOk.unreachable, false);
  const badFetch = fakeFetch([{ status: 404, body: "no such endpoint" }]);
  const stBad = {};
  const bad = await postImageEdit("http://x/v1/images/edits", {
    ...opts(badFetch.impl, []), stats: stBad,
  });
  assert.equal(bad.status, 404);
  assert.equal(stBad.unreachable, false, "a lone non-model 404 is a verdict, not an outage");
});

async function tinyPng() {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .png().toBuffer();
}

test("muse cache: miss spends once, hit is free, new mask misses", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "basic-musecache-"));
  try {
    const seed = path.join(dir, "seed.jpg");
    const maskA = path.join(dir, "a.png");
    const maskB = path.join(dir, "b.png");
    await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 100, g: 110, b: 120 } } })
      .jpeg().toFile(seed);
    const blank = Buffer.alloc(64 * 36, 0);
    blank.fill(255, 500, 1000);
    await sharp(Buffer.from(blank), { raw: { width: 64, height: 36, channels: 1 } }).png().toFile(maskA);
    blank.fill(255, 1200, 1700);
    await sharp(Buffer.from(blank), { raw: { width: 64, height: 36, channels: 1 } }).png().toFile(maskB);
    const payload = (await tinyPng()).toString("base64");
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        clone() { return this; },
        async text() { return ""; },
        async json() { return { data: [{ b64_json: payload }] }; },
      };
    };
    const run = (mask) => museEditPlate(seed, mask, 64, 36, "cat", "in the centre", dir,
      { fetchImpl, sleepImpl: async () => {} });
    const first = await run(maskA);
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(fetches, 1);
    assert.ok((await fs.promises.readdir(path.join(dir, "muse-cache"))).length >= 1);
    const second = await run(maskA);
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(fetches, 1, "cache hit spends nothing");
    assert.deepEqual(second.buffer, first.buffer);
    const third = await run(maskB);
    assert.equal(third.ok, true);
    assert.equal(third.cached, false);
    assert.equal(fetches, 2, "different hole mask is a different key");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
