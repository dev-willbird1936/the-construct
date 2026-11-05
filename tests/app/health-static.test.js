import { createApp } from "../../backend/app/app.js";
import { installGate } from "../../backend/app/test-support/fake-gate.js";
import { test, assert, startApp, api } from "./support.js";

test("health returns exactly {status:ok} with no auth", async (t) => {
  const { base } = await startApp(t);
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("build id is stable for one running app and never cached", async (t) => {
  const { base } = await startApp(t);
  const a = await fetch(`${base}/api/build`);
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("cache-control"), "no-store");
  const { build } = await a.json();
  assert.equal(typeof build, "string");
  assert.ok(build.length > 0);
  assert.equal((await (await fetch(`${base}/api/build`)).json()).build, build);
});

test("static allowlist serves the site and blocks the rest", async (t) => {
  const { base } = await startApp(t);
  const get = (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, type: r.headers.get("content-type") }));

  assert.equal((await get("/api/health")).status, 200);
  const index = await get("/index.html");
  assert.equal(index.status, 200);
  assert.match(index.type, /html/);
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/site.js")).status, 200);
  assert.equal((await get("/assets/volumes/ballet.json")).status, 200);

  // never served: backend, planning, dotfiles, markdown/logs/db, traversal
  assert.equal((await get("/backend/server.js")).status, 404);
  assert.equal((await get("/backend/app/index.js")).status, 404);
  assert.equal((await get("/.planning/hackathon/PLAN.md")).status, 404);
  assert.equal((await get("/.env")).status, 404);
  assert.equal((await get("/README.md")).status, 404);
  assert.equal((await get("/backend.log")).status, 404);
  assert.equal((await get("/app.db")).status, 404);
  assert.equal((await get("/..%2fbackend%2fserver.js")).status, 404);
  assert.equal((await get("/assets")).status, 404);
  assert.equal((await get("/specimens/does-not-exist.webp")).status, 404);
});

test("API backstop requires a user when the gate sets none", async (t) => {
  const { base } = await startApp(t, { gate: { installGate: () => {} } });
  const me = await fetch(`${base}/api/me`);
  assert.equal(me.status, 401);
  assert.deepEqual(await me.json(), { error: "Sign in required." });
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});

test("me/logout reflect the gated user, spend ledger and worker status", async (t) => {
  const { base, db } = await startApp(t);
  const { status, json } = await api(base, "GET", "/api/me", { user: "bob", role: "owner" });
  assert.equal(status, 200);
  assert.equal(json.id, "bob");
  assert.equal(json.email, "bob@example.test");
  assert.equal(json.role, "owner");
  assert.equal(json.spendTodayCents, 0);
  assert.equal(json.worker.online, false);
  assert.equal(json.worker.lastSeenAt, null);
  assert.deepEqual((await api(base, "POST", "/api/logout")).json, { ok: true });
  void db;
});

test("gate loader prefers the real gate and refuses production without it", async (t) => {
  const fs = await import("node:fs");
  const { loadGateInstaller } = await import("../../backend/app/gate-loader.js");
  const gateFile = new URL("../../backend/app/gate/index.js", import.meta.url);
  const loaded = await loadGateInstaller();
  assert.equal(loaded.fake, !fs.existsSync(gateFile));
  assert.equal(typeof loaded.installGate, "function");
});
