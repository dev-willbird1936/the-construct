import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveMetaConfig, resolveWorkDir } from "../../backend/pipeline/basic/run-basic.mjs";

test("resolveWorkDir: flag beats env beats <out>/.work", () => {
  const fallback = path.resolve("out/.work");
  assert.equal(resolveWorkDir("out", null), fallback);
  assert.equal(
    resolveWorkDir("out", null),
    path.resolve(process.env.BASIC_WORK_DIR || "out/.work")
  );
  assert.equal(resolveWorkDir("out", "D:/scratch/x"), path.resolve("D:/scratch/x"));
  assert.equal(resolveWorkDir("out", "rel/dir"), path.resolve("rel/dir"));
});

test("resolveWorkDir honours BASIC_WORK_DIR", () => {
  const before = process.env.BASIC_WORK_DIR;
  process.env.BASIC_WORK_DIR = "/tmp/the-construct/basic/cougar";
  try {
    assert.equal(resolveWorkDir("runs/cougar", null), path.resolve("/tmp/the-construct/basic/cougar"));
    // explicit flag still wins over env
    assert.equal(resolveWorkDir("runs/cougar", "other"), path.resolve("other"));
  } finally {
    if (before === undefined) delete process.env.BASIC_WORK_DIR;
    else process.env.BASIC_WORK_DIR = before;
  }
});

test("resolveMetaConfig: dev defaults to the local proxy + dummy key", () => {
  const c = resolveMetaConfig({ NODE_ENV: "development" });
  assert.equal(c.baseUrl, "http://127.0.0.1:8787/v1");
  assert.equal(c.endpoint, "http://127.0.0.1:8787/v1");
  assert.equal(c.apiKey, "via-meta-proxy");
});

test("resolveMetaConfig: production default is empty (real API via env key)", () => {
  const c = resolveMetaConfig({ NODE_ENV: "production" });
  assert.equal(c.baseUrl, "");
  assert.equal(c.endpoint, "https://api.meta.ai/v1");
  assert.equal(c.apiKey, "");
  const keyed = resolveMetaConfig({ NODE_ENV: "production", META_API_KEY: "k" });
  assert.equal(keyed.endpoint, "https://api.meta.ai/v1");
  assert.equal(keyed.apiKey, "k");
});

test("resolveMetaConfig: explicit base survives in any env", () => {
  const c = resolveMetaConfig({ NODE_ENV: "production", META_BASE_URL: "http://127.0.0.1:8787/v1" });
  assert.equal(c.baseUrl, "http://127.0.0.1:8787/v1");
  assert.equal(c.endpoint, "http://127.0.0.1:8787/v1");
});
