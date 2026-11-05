// Offline unit tests for net-guard.cjs. Stdlib only (node:test + assert).
// No backend imports, no browser, no network: fetch and route objects are
// fakes defined below.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const NET = require("./net-guard.cjs");

const APP = "http://127.0.0.1:51234";

const fakeOk = (status = 200) => async () => ({ status, headers: { get: () => null } });
const fakeRedirect = () => async () => ({ status: 302, headers: { get: () => "http://127.0.0.1:9/elsewhere" } });

test("node guard allows the exact registered origin incl. path+query", async () => {
  const g = NET.createNodeGuard({ fetchImpl: fakeOk() });
  g.allowOrigin(APP);
  const res = await g.guardedFetch(`${APP}/api/jobs?user=bob&x=1`);
  assert.equal(res.status, 200);
  assert.deepEqual(g.unexpected(), []);
});

test("node guard blocks non-local, unregistered, paid-proxy and mail hosts", () => {
  const g = NET.createNodeGuard({ fetchImpl: fakeOk() });
  g.allowOrigin(APP);
  for (const bad of [
    "http://127.0.0.1:8787/v1/models",
    "http://127.0.0.1:4175/api/health",
    "https://api.resend.com/emails",
    "https://api.meta.com/x",
    "http://127.0.0.1:9999/api/me",
    "not a url",
  ]) {
    assert.throws(() => g.guardedFetch(bad), /NETGUARD/, `must block ${bad}`);
  }
  const trips = g.unexpected();
  assert.equal(trips.length, 6);
  for (const t of trips) {
    assert.ok(t.origin === "invalid-url" || /^https?:\/\/[^/?#]+(:\d+)?$/.test(t.origin), `trip must be a bare origin: ${t.origin}`);
  }
  assert.ok(trips.some((t) => t.origin === "http://127.0.0.1:8787"));
});

test("node guard refuses non-loopback registration", () => {
  const g = NET.createNodeGuard({ fetchImpl: fakeOk() });
  assert.throws(() => g.allowOrigin("https://api.resend.com"), /non-loopback/);
  assert.throws(() => g.allowOrigin("http://127.0.0.1:8787/v1"), /non-loopback/);
});

test("caller cannot re-enable redirects or lose its body/signal through the guard", async () => {
  let seen;
  const g = NET.createNodeGuard({ fetchImpl: async (url, init) => { seen = init; return { status: 200 }; } });
  g.allowOrigin(APP);
  const signal = new AbortController().signal;
  const headers = { "x-test-user": "fixture" };
  await g.guardedFetch(`${APP}/api/jobs`, { method: "POST", body: "{}", signal, headers, redirect: "follow" });
  assert.equal(seen.redirect, "manual");
  assert.equal(seen.body, "{}");
  assert.equal(seen.signal, signal);
  assert.equal(seen.headers, headers);
});

test("node guard errors on redirects instead of auto-following", async () => {
  const g = NET.createNodeGuard({ fetchImpl: fakeRedirect() });
  g.allowOrigin(APP);
  await assert.rejects(g.guardedFetch(`${APP}/login`), /redirect refused/);
  const trips = g.unexpected();
  assert.equal(trips.length, 1);
  assert.equal(trips[0].origin, APP);
});

test("self-test trips are explicit; assertClean fails on unexpected only", async () => {
  const g = NET.createNodeGuard({ fetchImpl: fakeOk() });
  g.allowOrigin(APP);
  const m = g.mark();
  assert.throws(() => g.guardedFetch("http://127.0.0.1:1/v1"), /NETGUARD/);
  g.markSelfTestSince(m);
  g.assertClean();
  assert.throws(() => g.guardedFetch("https://api.resend.com/emails"), /NETGUARD/);
  assert.throws(() => g.assertClean(), /1 unexpected/);
});

const fakeRoute = (href, headers = {}) => {
  const calls = [];
  return {
    calls,
    request: () => ({ url: () => href, method: () => "GET", headers: () => ({ ...headers }) }),
    continue: async (arg) => { calls.push(["continue", arg]); },
    abort: async (arg) => { calls.push(["abort", arg]); },
    fulfill: async (arg) => { calls.push(["fulfill", arg]); },
  };
};

test("classifyRequest allows app origin, blocks everything else", () => {
  assert.equal(NET.classifyRequest(`${APP}/index.html?a=b`, APP), "allow");
  assert.equal(NET.classifyRequest(`${APP}/api/me`, APP), "allow");
  assert.equal(NET.classifyRequest("http://127.0.0.1:8787/v1", APP), "block");
  assert.equal(NET.classifyRequest("https://fonts.example/x.css", APP), "block");
  assert.equal(NET.classifyRequest("not a url", APP), "block");
});

test("handleRoute continues app origin with headers, aborts others with trip", async () => {
  const trips = [];
  const ok = fakeRoute(`${APP}/api/me`);
  const wentOn = await NET.handleRoute(ok, {
    appOrigin: APP,
    onTrip: (href) => trips.push(NET.sanitizeOrigin(href)),
    headersFor: () => ({ "x-test-user": "u" }),
  });
  assert.equal(wentOn, true);
  assert.equal(ok.calls[0][0], "continue");
  assert.equal(ok.calls[0][1].headers["x-test-user"], "u");
  const bad = fakeRoute("https://api.resend.com/emails?k=v");
  const wentOn2 = await NET.handleRoute(bad, {
    appOrigin: APP,
    onTrip: (href) => trips.push(NET.sanitizeOrigin(href)),
    headersFor: () => ({}),
  });
  assert.equal(wentOn2, false);
  assert.deepEqual(bad.calls[0], ["abort", "blockedbyclient"]);
  assert.deepEqual(trips, ["https://api.resend.com"]);
});

test("browser driver: portable resolution, guards, caps, no hardcoded dev paths", () => {
  const p = fs.readFileSync(path.join(__dirname, "check-studio.cjs"), "utf8");
  assert.ok(p.includes("PLAYWRIGHT_MODULE"), "explicit module override first");
  assert.ok(!p.includes("_npx"), "no developer-cache fallbacks");
  assert.ok(!p.includes("C:/Users"), "no hardcoded user browser path");
  assert.ok(p.includes('const { playwright }') || p.includes('require("playwright")'), "installed playwright fallback");
  assert.ok(p.includes('serviceWorkers: "block"'), "service workers blocked");
  assert.ok(p.includes("pathToFileURL"), "fileURL via pathToFileURL");
  assert.ok(p.includes('META_BASE_URL = "http://127.0.0.1:1/v1"'), "dummy unreachable proxy");
  assert.equal(p.split("8787").length - 1, 1, "8787 appears only in the self-test block list");
  assert.ok(p.includes("http://127.0.0.1:1/v1"), "dummy unreachable proxy");
  assert.ok(p.includes("markSelfTestSince") && p.includes("assertClean"), "selftest vs unexpected trips");
});


test("inline resources stay local; foreign blobs and file URLs are blocked", () => {
  assert.equal(NET.classifyRequest(`blob:${APP}/opaque-id`, APP), "allow");
  assert.equal(NET.classifyRequest("data:image/png;base64,AA==", APP), "allow");
  assert.equal(NET.classifyRequest("about:blank", APP), "allow");
  assert.equal(NET.classifyRequest("blob:https://api.meta.com/opaque-id", APP), "block");
  assert.equal(NET.classifyRequest("file:///private/example", APP), "block");
});

test("selected source manifest names actual public files", () => {
  const p = fs.readFileSync(path.join(__dirname, "check-studio.cjs"), "utf8");
  const match = p.match(/const sourceFiles = (\[[^\n]+\]);/);
  assert.ok(match, "selected source list must exist");
  for (const file of JSON.parse(match[1])) {
    assert.ok(fs.statSync(path.resolve(__dirname, "../..", file)).isFile(), file);
  }
});

test("all browser pages get the context guard and native bounded launch cleanup", () => {
  const p = fs.readFileSync(path.join(__dirname, "check-studio.cjs"), "utf8");
  const guardAt = p.indexOf('await context.route("**/*"');
  assert.ok(guardAt >= 0, "a context guard must actually be installed");
  assert.ok(guardAt < p.indexOf("const page = await context.newPage()"));
  assert.ok(p.includes("headless: true, timeout: ACTION, env"));
  assert.ok(!p.includes("Promise.race([chromium.launch"));
  assert.ok(p.includes("if (e?.SUITE_ABORT) throw e"));
  assert.ok(!p.includes("let aborted"));
  assert.ok(p.includes('path.join(REPO_ROOT, "tests/web/fixtures.js")'));
  assert.ok(p.includes('require("node:crypto").randomUUID()'));
});
