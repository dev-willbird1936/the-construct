// Studio checks: REAL API surface via createApp (fake gate + injected stub
// fns), zero Meta spend. sparkFn/detectFn/cameraFn/runners are injected so
// route shapes (cameraMeasured/recommend/decline), detect 502/503 and the
// job waiting-retry path are exercised for real. page.route is only used
// for fake-gate identity headers (and one 401-auth case) — never for API
// fixtures.
//
// Portability contract (no hardcoded machine paths):
//   REPO_ROOT resolves via __dirname (tests/web -> repo root), overridable
//     with CONSTRUCT_REPO_ROOT for D-staging checkouts.
//   Playwright resolves via explicit PLAYWRIGHT_MODULE, else installed
//     playwright (NODE_PATH), else a clear setup failure (no fallbacks).
//   Scratch/tmp resolve via TEST_TMP_ROOT (parent sets the D: staging dir),
//     else the OS tmpdir. Set TEST_TMP_ROOT to larger storage on this host.
// Spend/mail guards (dummies, set before any import): contributor-test key,
// unreachable 127.0.0.1:1 proxy URL (SDK shims cannot reach it either),
// Resend disabled, console mail only. Node fetch is guarded to the EXACT
// registered loopback app origin; redirects and service workers are refused.
// One owned browser, one FRESH context per section (storage/cookies/routes
// isolated, closed each time); the fake backend DB lives for the whole run
// by design. Per-action cap 20s, per-section cap 150s, whole-run 900s.
// Selection snapshot contract: the injected detect seeds the server's exact
// detect-cache (mirrors production runDetect); API-seeded jobs call
// seedSelectionCache before enqueue — validation runs for real, never stubbed.
// Licensed default: sections 8/8b assert blackcat/muntjac EXAMPLE rooms
// (assertion count preserved); section 6 additionally pins the Basic>1,
// Advanced multi-concept and stale-snapshot 400 contracts.
process.env.META_API_KEY = "contributor-test";
process.env.META_BASE_URL = "http://127.0.0.1:1/v1";
process.env.RESEND_API_KEY = "disabled-test";
process.env.MAIL_MODE = "console";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const REPO_ROOT = path.resolve(process.env.CONSTRUCT_REPO_ROOT || path.join(__dirname, "../.."));
const DROOT = process.env.TEST_TMP_ROOT || path.join(os.tmpdir(), "web-harness-refresh");
const RUN = "run-" + Date.now() + "-" + require("node:crypto").randomUUID();
const RUN_DIR = path.join(DROOT, "runs", RUN); // fresh nonce per run: shots + reports never overwrite prior evidence
const SCRATCH = path.join(RUN_DIR, "shots");
const TMP = path.join(RUN_DIR, "tmp");
process.env.TEMP = process.env.TMP = process.env.TMPDIR = TMP;
os.tmpdir = () => TMP; // all test-owned data stays inside this fresh run

// ---- network guard: Node fetch may ONLY reach the EXACT registered ----
// ---- loopback app origin; redirects refuse instead of auto-following. ----
// Shared module: ./net-guard.cjs (stdlib only; unit-tested offline).
const NET = require("./net-guard.cjs");
const nodeGuard = NET.createNodeGuard();
globalThis.fetch = nodeGuard.guardedFetch;
let APP_ORIGIN = ""; // exact registered origin, e.g. http://127.0.0.1:51234

// Resolve Playwright: explicit PLAYWRIGHT_MODULE first, else installed
// playwright (NODE_PATH). Anything else is a clear setup failure: no cache
// fallbacks, no installs, no hardcoded browser path (CHROMIUM_PATH optional,
// else the Playwright default).
let chromium;
{
  let mod = null;
  if (process.env.PLAYWRIGHT_MODULE) mod = require(process.env.PLAYWRIGHT_MODULE);
  else {
    try { mod = require("playwright"); }
    catch {
      console.error("FAILED: no Playwright module. Set PLAYWRIGHT_MODULE to its path or install playwright (NODE_PATH).");
      process.exit(2);
    }
  }
  chromium = mod.chromium;
  console.log("[harness] playwright loaded");
}
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const FX = require(path.join(REPO_ROOT, "tests/web/fixtures.js"));

const { pathToFileURL } = require("node:url");
const REPO = REPO_ROOT;
const fileUrl = (p) => pathToFileURL(p).href;

const results = [];
const failures = [];
const teardowns = [];
const openBrowsers = new Set();
async function closeAll() {
  for (const b of openBrowsers) await b.close().catch(() => {});
  openBrowsers.clear();
  for (const fn of teardowns.reverse()) await fn().catch(() => {});
  teardowns.length = 0;
}
const t = { after: (fn) => teardowns.push(fn) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECTION_TIMEOUT_MS = 150000;
const ACTION = 20000;
const sectionFilter = process.env.CONSTRUCT_WEB_SECTIONS ? new Set(process.env.CONSTRUCT_WEB_SECTIONS.split(",").map(s => s.trim()).filter(Boolean)) : null;
const seenSections = new Set();
const deadline = (ms, msg) => {
  let id = null;
  const promise = new Promise((_, rej) => { id = setTimeout(() => { const e = new Error(msg); e.SUITE_ABORT = true; rej(e); }, ms); });
  return { promise, cancel: () => clearTimeout(id) };
};
// A 150s deadline aborts the WHOLE suite: the timed-out fn is still racing
// the shared backend, so no later section may run against it. Regular 20s
// failures resolve inside fn (after its finally) and the run continues.
function flushReport() {
  fs.writeFileSync(path.join(RUN_DIR, "harness-report.json"), JSON.stringify({ results, failures, unexpectedTrips: nodeGuard.unexpected() }, null, 2));
}
async function section(n, label, fn, getDiag) {
  if (sectionFilter && !sectionFilter.has(String(n))) return;
  seenSections.add(String(n));
  const t0 = Date.now();
  console.log(`[harness] START s${n} ${label}`);
  const prog = setInterval(() => console.log(`[harness] ... s${n} still running ${((Date.now() - t0) / 1000).toFixed(0)}s`), 30000);
  const cap = deadline(SECTION_TIMEOUT_MS, `s${n} TIMEOUT after ${SECTION_TIMEOUT_MS}ms waiting (see last DIAG)`);
  try {
    const msg = await Promise.race([fn(), cap.promise]);
    console.log(`[harness] PASS s${n} (${((Date.now() - t0) / 1000).toFixed(1)}s) :: ${msg}`);
    results.push(msg);
    flushReport();
  } catch (e) {
    console.log(`[harness] FAIL s${n} (${((Date.now() - t0) / 1000).toFixed(1)}s) :: ${String(e?.message || e).slice(0, 300)}`);
    failures.push({ n: String(n), label, error: String(e?.message || e).slice(0, 500) });
    flushReport();
    // A fatal deadline/launch error must unwind immediately: even code between
    // section calls must not mutate BE while an old fn remains in flight.
    if (e?.SUITE_ABORT) throw e;
    try { if (getDiag) await getDiag(`section-${n}-fail`); } catch {}
  } finally {
    clearInterval(prog);
    cap.cancel();
  }
}

(async () => {
  await fsp.mkdir(SCRATCH, { recursive: true });
  await fsp.mkdir(TMP, { recursive: true });
  // Selected source fingerprints only, not a full dependency/runtime digest.
  const crypto = require("node:crypto");
  const sourceFiles = ["site.js", "index.html", "stable.js", "stable-math.mjs", "backend/app/routes.js", "tests/app/support.js", "tests/web/check-studio.cjs", "tests/web/net-guard.cjs", "tests/web/fixtures.js", "backend/app/app.js", "backend/app/detect-cache.js", "backend/app/runner-lite.js", "backend/lib/detect.js", "backend/lib/sam-image-seed.mjs", "backend/lib/sam-image-result.mjs"];
  fs.writeFileSync(path.join(RUN_DIR, "source-manifest.json"), JSON.stringify({ phase: "stubbed-browser-contracts", files: Object.fromEntries(sourceFiles.map(p => [p, crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO_ROOT, p))).digest("hex")])) }, null, 2));
  const clipPath = path.join(SCRATCH, "tiny.mp4");
  if (!fs.existsSync(clipPath)) {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-pix_fmt", "yuv420p", clipPath]);
  }
  const clip = clipPath;
  const support = await import(fileUrl(path.join(REPO, "tests/app/support.js")));
  const { frameIndexFor, __seedDetectCache, runBoxDetect } = await import(fileUrl(path.join(REPO, "backend/app/detect-cache.js")));
  const { SELECTION_STALE_TEXT } = await import(fileUrl(path.join(REPO, "backend/app/errors.js")));
  const { BASIC_MULTI_OBJECT_TEXT } = await import(fileUrl(path.join(REPO, "backend/app/runner-basic.js")));
  const { ADV_MULTI_CONCEPT_TEXT } = await import(fileUrl(path.join(REPO, "backend/lib/seed-match.mjs")));

  // ---- section 0: static/source-privacy gate + netguard self-test (prelude, not counted) ----
  {
    const t0 = Date.now();
    console.log("[harness] START s0 static/source-privacy + netguard gate");
    const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
    const site = read("site.js"), html = read("index.html"), terms = read("terms.html");
    for (const needle of ["blackcat-atlas", "muntjac-atlas", "EXAMPLE · BLACK CAT", "EXAMPLE · MUNTJAC", "Dzkouslavia", "Mvolz"]) {
      assert.ok(site.includes(needle), `site.js must mount licensed seed ${needle}`);
    }
    for (const needle of ["assets/volumes", "assets/streaks", "assets/stable", "stable.html", "trailcam", "grizzly", "wolves2106504576", "WOLF_PORTAL_MODE", "openPortal", "clip=wolves", "clip=walker"]) {
      assert.ok(!site.includes(needle), `site.js must not reference uncleared ${needle}`);
    }
    assert.ok(site.toLowerCase().includes("cougar") === false, "site.js must not mention cougar");
    assert.ok(html.includes('data-sample="assets/corpus/blackcat.mp4"'), "sample is the licensed blackcat clip");
    assert.ok(!html.includes("trailcam") && !html.includes("cougar.mp4"), "sample is not trail-cam");
    assert.ok(terms.includes("Black Cat walking") && terms.includes("Muntjac Deer Barking"), "terms carries both attributions");
    assert.equal(process.env.META_API_KEY, "contributor-test", "dummy Meta key");
    assert.equal(process.env.META_BASE_URL, "http://127.0.0.1:1/v1", "dummy unreachable proxy");
    assert.ok(!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === "disabled-test", "resend disabled");
    assert.equal(process.env.MAIL_MODE, "console", "console mail only");
    // Self-test blocks: the REAL paid proxy, other loopbacks, resend and
    // meta must all throw; these trips are marked expected, anything else
    // later fails the suite.
    for (const bad of ["http://127.0.0.1:8787/v1/models", "http://127.0.0.1:4175/api/health", "http://127.0.0.1:4180/api/health", "https://api.resend.com/emails", "https://api.meta.com/x"]) {
      const mark = nodeGuard.mark();
      assert.throws(() => globalThis.fetch(bad), /NETGUARD/, `netguard must block ${bad}`);
      nodeGuard.markSelfTestSince(mark);
    }
    console.log(`[harness] PASS s0 (${((Date.now() - t0) / 1000).toFixed(1)}s) :: static licensed-default + netguard self-test green`);
    results.push("s0 static licensed-default + netguard self-test green (prelude)");
  }

  // Mutable stub behaviours, flipped per section. Real backend path throughout.
  const BE = { spark: "ok", cuts: 0, detectMode: "ok", detectCalls: 0 };
  const sparkFor = () => {
    if (BE.spark === "decline") return { category: "other", camera: "fixed", subjects: ["humanoid 3D model"], warnings: ["synthetic CGI render", "screen recording"], decline: "Screen recording" };
    if (BE.spark === "moving") return { category: "wildlife", camera: "handheld", subjects: ["cougar"], warnings: [] };
    return { category: "wildlife", camera: "fixed", subjects: ["cougar", "grass"], warnings: ["subject under 10% of frame at the start"] };
  };
  // Injected detect that ALSO seeds the real server detect-cache for the exact
  // upload+frame (mirrors production runDetect): the immutable selection
  // snapshot contract at POST /jobs then validates for real instead of 400ing.
  const detectFor = async (args) => {
    BE.detectCalls++;
    if (BE.detectMode === "once503" && BE.detectCalls === 1) {
      const e = new Error("The segmentation service is temporarily unavailable. Try again in a minute.");
      e.retryable = true;
      throw e;
    }
    if (BE.detectMode === "always502") throw new Error("SAM video pass blew up (traceback hidden, request-id stub-1)");
    const up = args?.upload;
    if (!up?.id) throw new Error("stub detect requires its server-owned upload");
    const frameIndex = frameIndexFor(up, Number(args?.time) || 0);
    const result = BE.detectMode === "empty" ? { ...FX.DETECT, objects: [] } : FX.DETECT;
    __seedDetectCache(up.id, frameIndex, result);
    return { result, frameIndex, concepts: ["cougar"] };
  };
  const sharp = require(path.join(REPO, "backend/node_modules/sharp"));
  const webp = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 120, g: 90, b: 60, alpha: 255 } } }).webp().toBuffer();
  const baseRunners = support.stubRunners(async (dir) => {
    const atlas = { name: "stub", concept: "test-object", count: 4, cols: 2, rows: 2, cellW: 8, cellH: 8, aspect: 1, fps: 10, timestamps: [0, 0.1, 0.2, 0.3] };
    await fsp.writeFile(path.join(dir, "atlas.json"), JSON.stringify(atlas));
    await fsp.writeFile(path.join(dir, "atlas.webp"), webp);
  });
  const RUN = { failOnce: false };
  const transient = (model) => { RUN.failOnce = false; throw new Error(`${model} model_not_found (transient upstream wobble)`); };
  const app = await support.startApp(t, {
    sparkFn: async () => sparkFor(),
    detectFn: detectFor,
    boxDetectFn: args => runBoxDetect({ ...args, _detectBox: async (png, width, height, box, options) => {
      options.onRequest?.();
      BE.boxCalls = (BE.boxCalls || 0) + 1;
      if (BE.boxMode === "once503" && BE.boxCalls === 1) throw Object.assign(new Error("The segmentation service is temporarily unavailable. Try again in a minute."), { retryable: true });
      const mask = new Uint8Array(width * height);
      for (let y = Math.floor(height * .2); y < Math.ceil(height * .7); y++) for (let x = Math.floor(width * .2); x < Math.ceil(width * .7); x++) mask[y * width + x] = 1;
      const pixels = { left: Math.floor(width * .2), top: Math.floor(height * .2), right: Math.ceil(width * .7), bottom: Math.ceil(height * .7) };
      return { frameWidth: width, frameHeight: height, objects: [{ id: 1, label: "synthetic boxed subject", box: { left: pixels.left / width, top: pixels.top / height, right: pixels.right / width, bottom: pixels.bottom / height } }],
        indexMapPngBase64: (await sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }).png().toBuffer()).toString("base64"),
        _internal: { accepted: [{ concept: "selected object", mask, box: pixels }] } };
    } }),
    cameraFn: async () => (BE.spark === "moving"
      ? { cuts: BE.cuts, measured: { moving: true, shiftPx: 8.2, confident: true } }
      : { cuts: BE.cuts, measured: { moving: false, shiftPx: 0.4, confident: true } }),
    runners: {
      lite: async (args) => {
        if (RUN.failOnce) transient("sam-3.1");
        return baseRunners.lite(args);
      },
      basic: async (args) => {
        if (RUN.failOnce) transient("muse-image");
        return baseRunners.basic(args);
      },
    },
    // This suite injects legacy job runners, not the separate live-run engine.
    configOverrides: { jobRetryPauseMs: 2000, mailMode: "console", liveAdvanced: false },
  });
  const { base } = app;
  APP_ORIGIN = new URL(base).origin;
  nodeGuard.allowOrigin(APP_ORIGIN);
  console.log("[harness] stub backend:", base, "data:", app.dataDir);
  const runCap = setTimeout(async () => {
    console.log("[harness] WHOLE-RUN 900s watchdog hit");
    try { await closeAll(); } catch {}
    process.exit(3);
  }, 900000);
  let galleryJobId = null;

  const json = (obj) => ({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });
  let sharedBrowser = null;
  async function shared() {
    if (!sharedBrowser) {
      // Browser launch honors the same 20s cap as every other action.
      const env = {};
      for (const key of ["SYSTEMROOT", "WINDIR", "PATH", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      Object.assign(env, { TEMP: TMP, TMP, TMPDIR: TMP, HOME: TMP, USERPROFILE: TMP, APPDATA: TMP, LOCALAPPDATA: TMP });
      try {
        sharedBrowser = await chromium.launch({
          headless: true, timeout: ACTION, env,
          executablePath: process.env.CHROMIUM_PATH,
          args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
        });
      } catch (e) { e.SUITE_ABORT = true; throw e; }
      openBrowsers.add(sharedBrowser);
    }
    return sharedBrowser;
  }
  async function launch(role = "user", options = {}) {
    const browser = await shared();
    const context = await browser.newContext({ viewport: options.viewport || { width: 1280, height: 800 }, hasTouch: options.hasTouch === true, reducedMotion: "reduce", serviceWorkers: "block", ...(options.recordVideo ? { recordVideo: { dir: RUN_DIR, size: options.viewport || { width: 1280, height: 800 } } } : {}) });
    // Includes terms/empty/viewer pages which never call wire(). Page mocks
    // have higher precedence, so wire() repeats this policy before dispatch.
    await context.route("**/*", route => NET.handleRoute(route, {
      appOrigin: APP_ORIGIN, headersFor: () => ({}),
      onTrip: href => nodeGuard.trips.push({ kind: "unexpected", origin: NET.sanitizeOrigin(href), at: Date.now(), note: "browser-context" }),
    }));
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION);
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { try { if (m.type() === "error") errors.push("console: " + String(typeof m.text === "function" ? m.text() : m.text).slice(0, 200)); } catch {} });
    await page.addInitScript(() => {
      const css = "*{transition:none!important;animation:none!important}";
      const apply = () => {
        const root = document.head || document.documentElement;
        if (!root) return false;
        const style = document.createElement("style");
        style.textContent = css;
        root.append(style);
        return true;
      };
      if (!apply()) {
        new MutationObserver((_, obs) => { if (apply()) obs.disconnect(); }).observe(document, { childList: true, subtree: true });
      }
    });
    const handle = { close: async () => { await context.close().catch(() => {}); } };
    return { browser: handle, context, page, errors };
  }
  async function wire(page, baseUrl, user, mocks = {}, role = "user") {
    await page.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      // Context guard FIRST: mock precedence must never bypass it. Non-app
      // origins abort (fail-closed) with a sanitized trip, not continue.
      if (NET.classifyRequest(url.href, APP_ORIGIN) !== "allow") {
        nodeGuard.trips.push({ kind: "unexpected", origin: NET.sanitizeOrigin(url.href), at: Date.now(), note: "browser-route" });
        return route.abort("blockedbyclient");
      }
      if (!["http:", "https:"].includes(url.protocol)) return route.fallback();
      const key = `${req.method()} ${url.pathname}`;
      if (key in mocks) {
        const value = typeof mocks[key] === "function" ? await mocks[key](req) : mocks[key];
        if (value === "passthrough") {
          const headers = { ...req.headers(), "x-test-user": user, "x-test-role": role };
          return route.continue({ headers });
        }
        if (value && value.status) return route.fulfill(value);
        return route.fulfill(json(value));
      }
      const headers = { ...req.headers(), "x-test-user": user, "x-test-role": role };
      return route.continue({ headers });
    });
  }
  async function waitStudio(page) {
    await page.waitForFunction(() => !!window.__studio, null, { polling: 500, timeout: ACTION });
    await page.waitForTimeout(1500);
  }
  let lastDiag = { page: null, errors: null };
  function diagnose(page, errors) {
    page.on("response", (r) => {
      if (r.url().includes("/api/")) page.evaluate(({ s, u }) => { window.__apiLog = [...(window.__apiLog || []).slice(-9), `${s} ${u}`]; }, { s: r.status(), u: r.url().split("/api/")[1] }).catch(() => {});
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { try { if (m.type() === "error") errors.push(`console: ${String(typeof m.text === "function" ? m.text() : m.text).slice(0, 200)}`); } catch {} });
  }
  async function dump(page, errors, label) {
    const log = await page.evaluate(() => ({
      url: location.href,
      api: window.__apiLog || [],
      steps: ["stepAuth", "stepUpload", "stepRoute", "stepFrame", "stepWorking", "stepDone"].filter((s) => !document.querySelector(`#${s}`).classList.contains("is-hidden")),
      detect: document.querySelector("#detectStatus")?.textContent || null,
      toast: document.querySelector("#toast")?.textContent || null,
      working: document.querySelector("#workingNote")?.textContent || null,
      objects: window.__studio?.objects.length ?? null,
      selected: window.__studio?.selected ?? null,
      builds: document.querySelectorAll("#buildList .build").length,
      plaque: document.querySelector("#cellTitle")?.textContent || null,
    })).catch((e) => ({ evalFailed: String(e).slice(0, 120) }));
    console.log(`DIAG ${label}:`, JSON.stringify({ errors, ...log }).slice(0, 1500));
    lastDiag = { page, errors };
  }
  async function openStudio(page, user, mocks = {}) {
    await wire(page, base, user, mocks);
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: ACTION });
    await page.waitForFunction(() => !!window.__studio, null, { polling: 500, timeout: ACTION });
    await page.waitForTimeout(1500);
    await page.click("#uploadCta");
    await page.waitForTimeout(1200);
  }

  // 1. API 401 (expired session) shows the sign-in step, not the form
  await section(1, "expired session -> sign-in step", async () => {
    const { browser, page } = await launch();
    try {
      await wire(page, base, "alice", { "GET /api/me": { status: 401, contentType: "application/json", body: '{"error":"signin_required"}' } });
      await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: ACTION });
      await waitStudio(page);
      await page.click("#uploadCta");
      await page.waitForTimeout(1000);
      assert.equal(await page.evaluate(() => !document.querySelector("#stepAuth").classList.contains("is-hidden")), true);
      assert.match(await page.evaluate(() => document.querySelector("#signInLink").href), /\/signin\?next=/);
      return "expired session shows the sign-in step with a /signin link";
    } finally { await browser.close(); }
  });

  // 2. upload requires the rights tick
  await section(2, "rights tick refused with toast", async () => {
    const { browser, page, errors } = await launch();
    lastDiag = { page, errors };
    try {
      await openStudio(page, "alice");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForTimeout(800);
      assert.match(await page.evaluate(() => document.querySelector("#toast").textContent), /rights box/);
      assert.equal(await page.evaluate(() => !document.querySelector("#stepUpload").classList.contains("is-hidden")), true);
      assert.deepEqual(errors.filter((e) => e.startsWith("pageerror:")), []);
      return "upload without the rights tick is refused with a toast";
    } finally { await browser.close(); }
  }, (l) => dump(lastDiag.page, lastDiag.errors, l));

  // 3. upload -> route renders the advisory Spark card
  await section(3, "spark route card fixed camera", async () => {
    const { browser, page } = await launch();
    lastDiag = { page, errors: [] };
    try {
      await openStudio(page, "alice");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.waitForFunction(() => !document.querySelector("#routeGo").disabled, null, { polling: 500, timeout: ACTION });
      const card = await page.evaluate(() => document.querySelector("#routeCard").textContent);
      assert.match(card, /wildlife/);
      assert.match(card, /fixed/);
      assert.match(card, /measured/);
      assert.match(card, /cougar/);
      assert.match(card, /under 10%/);
      assert.match(card, /spark recommends/);
      assert.equal(await page.evaluate(() => document.querySelector("#routeGo").disabled), false);
      assert.equal(await page.evaluate(() => document.querySelector('input[name="tier"][value="basic"]').checked), true);
      assert.match(await page.evaluate(() => document.querySelector(".rec-why").textContent), /Basic/);
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "studio-route.png") });
      await page.click("#routeGo");
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => !document.querySelector("#stepFrame").classList.contains("is-hidden")), true);
      return "upload -> Spark route card renders category/camera/subjects/warnings and continues";
    } finally { await browser.close(); }
  }, (l) => dump(lastDiag.page, lastDiag.errors, l));

  // 3b. A confidently measured moving camera recommends Lite (runner-basic refuses
  // exactly that measurement), without disabling a manual Basic choice.
  await section("3b", "moving camera recommends Lite; Basic remains selectable", async () => {
    BE.spark = "moving";
    const { browser, page } = await launch();
    try {
      await openStudio(page, "alice");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.waitForFunction(() => !document.querySelector("#routeGo").disabled, null, { polling: 500, timeout: ACTION });
      const card = await page.evaluate(() => document.querySelector("#routeCard").textContent);
      assert.match(card, /moving/);
      assert.match(card, /measured/);
      assert.match(card, /spark recommends/);
      assert.match(await page.evaluate(() => document.querySelector(".rec-why").textContent), /Lite/);
      const basic = await page.evaluate(() => ({ disabled: document.querySelector('input[name="tier"][value="basic"]').disabled, checked: document.querySelector('input[name="tier"][value="basic"]').checked }));
      assert.equal(basic.disabled, false);
      assert.equal(basic.checked, false);
      assert.equal(await page.evaluate(() => document.querySelector('input[name="tier"][value="lite"]').checked), true);
      await page.click("#routeBack");
      await page.check('input[name="tier"][value="basic"]');
      await page.click("#uploadContinue");
      assert.equal(await page.evaluate(() => document.querySelector('input[name="tier"][value="basic"]').checked), true);
      return "measured moving camera recommends Lite; the user can still explicitly choose Basic";
    } finally { BE.spark = "ok"; await browser.close(); }
  });

  // 3c. measured cuts warn but continue through the picker
  await section("3c", "measured cuts stay advisory", async () => {
    BE.cuts = 1;
    const { browser, page } = await launch();
    try {
      await openStudio(page, "alice");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.waitForFunction(() => /hard cuts/i.test(document.querySelector("#routeCard").textContent), null, { polling: 500, timeout: ACTION });
      assert.match(await page.evaluate(() => document.querySelector("#routeCard").textContent), /hard cuts/i);
      assert.equal(await page.evaluate(() => document.querySelector("#routeGo").disabled), false);
      await page.click("#routeGo");
      assert.equal(await page.locator("#stepFrame").isVisible(), true);
      return "hard cuts remain visible advice without stopping the picker";
    } finally { BE.cuts = 0; await browser.close(); }
  });

  await section("3d", "CGI screen recording continues despite a legacy rejection", async () => {
    BE.spark = "decline";
    const { browser, page, errors } = await launch("user", { recordVideo: true });
    const video = page.video();
    try {
      await openStudio(page, "alice");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => document.querySelector("#routeCard").textContent.includes("humanoid 3D model"), null, { polling: 500, timeout: ACTION });
      const card = await page.locator("#routeCard").innerText();
      assert.match(card, /synthetic CGI render/);
      assert.match(card, /screen recording/);
      assert.match(card, /advisory/);
      assert.equal(await page.locator("#routeTitle").innerText(), "Your clip, as Spark sees it");
      assert.equal(await page.locator("#routeGo").isEnabled(), true);
      assert.equal(await page.locator("#routeGo").innerText(), "Continue to picking");
      await page.screenshot({ path: path.join(SCRATCH, "advisory-cgi-route.png") });
      await page.click("#routeGo");
      assert.equal(await page.locator("#stepFrame").isVisible(), true);
      assert.deepEqual(errors.filter(e => e.startsWith("pageerror:")), []);
      return "CGI/screen-recording labels and legacy rejection remain advice; real upload reaches picker (stubbed inference)";
    } finally {
      BE.spark = "ok";
      await browser.close();
      console.log("[harness] advisory route recording: " + await video.path());
    }
  });

  // 4. detect -> canvas multi-select (max 3)
  await section(4, "SAM picking max 3 in sync", async () => {
    const { browser, page, errors } = await launch();
    diagnose(page, errors);
    lastDiag = { page, errors };
    try {
      await openStudio(page, "alice");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.click("#routeGo");
      await page.click("#findObjects");
      try {
        await page.waitForFunction(() => document.querySelectorAll("#objectList [data-obj]").length === 4, null, { polling: 500, timeout: ACTION });
      } catch (e) { await dump(page, errors, "section-4-detect"); throw e; }
      const clickObj = async (fx, fy) => {
        const box = await page.locator("#hoverCanvas").boundingBox();
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
        await page.waitForTimeout(300);
      };
      await clickObj(0.33, 0.33);
      await clickObj(0.7, 0.7);
      await clickObj(0.8, 0.15);
      assert.equal(await page.evaluate(() => document.querySelector("#selectCount").textContent), "3 of 3");
      await clickObj(0.2, 0.8);
      assert.equal(await page.evaluate(() => document.querySelector("#selectCount").textContent), "3 of 3");
      assert.match(await page.evaluate(() => document.querySelector("#toast").textContent), /Three objects at most/);
      assert.equal(await page.evaluate(() => document.querySelector("#generateButton").disabled), false);
      assert.match(await page.evaluate(() => document.querySelector("#generateButton").textContent), /basic cloud trail/);
      assert.equal(await page.evaluate(() => document.querySelectorAll('#objectList [aria-pressed="true"]').length), 3);
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "studio-pick.png") });
      return "SAM picking selects up to 3 objects via canvas clicks; chips and list stay in sync";
    } finally { await browser.close(); }
  }, (l) => dump(lastDiag.page, lastDiag.errors, l));

  // 4b. real job-quota 429 surfaces politely at build time
  await section("4b", "exhausted quota stays visible", async () => {
    const uq = await support.uploadClip(base, { user: "quota" });
    assert.equal(uq.status, 200);
    await support.seedSelectionCache(app, uq.json.uploadId, { seedTime: 0 });
    let code = 200, attempts = 0;
    for (let i = 0; i < 15 && code !== 429; i++) {
      const r = await support.api(base, "POST", "/api/jobs", { user: "quota", body: { uploadId: uq.json.uploadId, tier: "lite", objectIds: [1], seedTime: 0 } });
      code = r.status; attempts++;
      if (r.status === 400) throw new Error(`quota-burn job rejected before quota: ${JSON.stringify(r.json).slice(0, 160)}`);
    }
    console.log(`[harness] s4b quota burn: ${attempts} enqueues -> ${code}`);
    assert.equal(code, 429);
    const { browser, page } = await launch();
    try {
      await openStudio(page, "quota");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.waitForFunction(() => document.querySelector("#routeCard").textContent.includes("Daily job limit reached"), null, { polling: 500, timeout: ACTION });
      // a limit is final for today: the flag says when it resets, not "continue with defaults"
      const flag = await page.evaluate(() => document.querySelector("#routeCard .route-flag").textContent);
      assert.match(flag, /Limits reset at 00:00 UTC/);
      assert.doesNotMatch(flag, /continue with defaults/i);
      assert.match(await page.locator("#routeTitle").innerText(), /Clip check unavailable/i);
      assert.equal(await page.evaluate(() => document.querySelector("#routeGo").disabled), false);
      await page.click("#routeGo");
      await page.click("#findObjects");
      await page.waitForFunction(() => document.querySelector("#detectStatus").textContent.includes("Daily job limit reached"), null, { polling: 500, timeout: ACTION });
      return "exhausted quota stays visible on route + detect; flow continues honestly";
    } finally { await browser.close(); }
  });

  // 4c. transient detect failure names the failure and invites a retry
  await section("4c", "transient detect failure retryable", async () => {
    BE.detectMode = "always502";
    const { browser, page, errors } = await launch();
    diagnose(page, errors);
    lastDiag = { page, errors };
    try {
      await openStudio(page, "alice");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.click("#routeGo");
      await page.click("#findObjects");
      try {
        await page.waitForFunction(() => document.querySelector("#detectStatus").textContent.includes("Nothing is stuck"), null, { polling: 500, timeout: ACTION });
      } catch (e) { await dump(page, errors, "section-4c"); throw e; }
      assert.equal(await page.evaluate(() => document.querySelector("#findObjects").disabled), false);
      return "transient detect failure names the failure and invites a retry, nothing stuck";
    } finally { BE.detectMode = "ok"; await browser.close(); }
  }, (l) => dump(lastDiag.page, lastDiag.errors, l));

  // 4d. detect 503 shows honest message with Retry; retry recovers
  await section("4d", "detect 503 retry recovers", async () => {
    BE.detectMode = "once503";
    BE.detectCalls = 0;
    const { browser, page } = await launch();
    try {
      await openStudio(page, "alice");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.click("#routeGo");
      await page.click("#findObjects");
      await page.waitForFunction(() => document.querySelector("#detectStatus").textContent.includes("temporarily unavailable"), null, { polling: 500, timeout: ACTION });
      assert.equal(await page.evaluate(() => document.querySelector("#detectRetry").classList.contains("is-hidden")), false);
      assert.equal(await page.evaluate(() => document.querySelectorAll("#objectList [data-obj]").length), 0);
      assert.equal(await page.evaluate(() => document.querySelector("#findObjects").disabled), false);
      await page.click("#detectRetry");
      await page.waitForFunction(() => document.querySelectorAll("#objectList [data-obj]").length === 4, null, { polling: 500, timeout: ACTION });
      assert.equal(await page.evaluate(() => document.querySelector("#detectRetry").classList.contains("is-hidden")), true);
      return "detect 503 shows the honest outage message with Retry; retry recovers the picks";
    } finally { BE.detectMode = "ok"; await browser.close(); }
  });

  // 5. real stubbed Lite job: queued -> done, viewer opens, publish -> pending
  await section(5, "lite job queued->done viewer publish", async () => {
    const { browser, page } = await launch();
    lastDiag = { page, errors: [] };
    try {
      await openStudio(page, "bob");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.click("#routeBack");
      await page.waitForTimeout(500);
      await page.check('input[name="tier"][value="lite"]');
      await page.click("#uploadContinue");
      assert.equal(await page.evaluate(() => document.querySelector('input[name="tier"][value="lite"]').checked), true);
      await page.click("#findObjects");
      await page.waitForFunction(() => document.querySelectorAll("#objectList [data-obj]").length === 4, null, { polling: 500, timeout: ACTION });
      const box = await page.locator("#hoverCanvas").boundingBox();
      await page.mouse.click(box.x + box.width * 0.33, box.y + box.height * 0.33);
      await page.waitForTimeout(500);
      await page.click("#generateButton");
      await page.waitForFunction(() => !document.querySelector("#stepWorking").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.waitForFunction(() => !document.querySelector("#stepDone").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      assert.match(await page.evaluate(() => document.querySelector("#doneTitle").textContent), /Cougar · ghost trail/);
      const chips = await page.evaluate(() => document.querySelector("#doneProv").textContent);
      assert.match(chips, /SAM 3\.1 tracking/);
      assert.match(chips, /Muse Spark/);
      await page.click("#doneOpen");
      await page.waitForTimeout(600);
      assert.match(await page.evaluate(() => document.querySelector("#viewerFrame").src), /view-lite\.html\?id=/);
      await page.click("#viewerClose");
      await page.click("#donePublish");
      await page.waitForTimeout(1000);
      assert.match(await page.evaluate(() => document.querySelector("#donePublish").textContent), /pending/i);
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "studio-done.png") });
      return "stubbed Lite job runs queued->done; viewer opens in-dialog; publish goes pending";
    } finally { await browser.close(); }
  }, (l) => dump(lastDiag.page, lastDiag.errors, l));

  // 5b. transient Meta wobble -> job waits calmly then finishes
  await section("5b", "upstream wobble waits then finishes", async () => {
    RUN.failOnce = true;
    const { browser, page } = await launch();
    try {
      await openStudio(page, "walt");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.click("#routeGo");
      await page.click("#findObjects");
      await page.waitForFunction(() => document.querySelectorAll("#objectList [data-obj]").length === 4, null, { polling: 500, timeout: ACTION });
      const box = await page.locator("#hoverCanvas").boundingBox();
      await page.mouse.click(box.x + box.width * 0.33, box.y + box.height * 0.33);
      await page.waitForTimeout(500);
      await page.click("#generateButton");
      await page.waitForFunction(() => document.querySelector("#workingNote").textContent.includes("trying again (1/"), null, { polling: 500, timeout: ACTION });
      assert.equal(await page.evaluate(() => !document.querySelector("#stepWorking").classList.contains("is-hidden")), true);
      assert.equal(await page.evaluate(() => !!document.querySelector("#stepWorking .build-err")), false);
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "studio-waiting.png") });
      await page.waitForFunction(() => !document.querySelector("#stepDone").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      return "upstream wobble shows calm 'trying again (1/5)' then finishes";
    } finally { await browser.close(); }
  });

  // 6. my builds: status list, unpublish, report, delete-fallback (+ new-rule API contracts)
  BE.detectMode = "ok"; BE.detectCalls = 0;
  await section(6, "my builds list unpublish report delete", async () => {
    const { browser, page, errors } = await launch();
    diagnose(page, errors);
    lastDiag = { page, errors };
    page.on("dialog", async (d) => {
      if (d.type() === "prompt") await d.accept("test reason");
      else await d.accept();
    });
    try {
      const up = await support.uploadClip(base, { user: "carol" });
      assert.equal(up.status, 200);
      await support.seedSelectionCache(app, up.json.uploadId, { seedTime: 0 });
      const created = await support.api(base, "POST", "/api/jobs", { user: "carol", body: { uploadId: up.json.uploadId, tier: "lite", objectIds: [1], seedTime: 0 } });
      assert.equal(created.status, 200, `carol enqueue: ${JSON.stringify(created.json).slice(0, 160)}`);
      const jobId = created.json.jobId;
      await support.waitFor(base, jobId, { user: "carol" });
      await support.api(base, "POST", `/api/jobs/${jobId}/publish`, { user: "carol" });
      // NEW-RULE contracts (real validation, no browser): Basic refuses >1
      // selection; Advanced refuses different-concept multi; stale cache 400s.
      const up2 = await support.uploadClip(base, { user: "carol" });
      await support.seedSelectionCache(app, up2.json.uploadId, { seedTime: 0 });
      const multi = await support.api(base, "POST", "/api/jobs", { user: "carol", body: { uploadId: up2.json.uploadId, tier: "basic", objectIds: [1, 2], seedTime: 0 } });
      assert.equal(multi.status, 400);
      assert.equal(multi.json.error, BASIC_MULTI_OBJECT_TEXT);
      const up3 = await support.uploadClip(base, { user: "carol" });
      await support.seedSelectionCache(app, up3.json.uploadId, { seedTime: 0 });
      const cacheMod = await import(fileUrl(path.join(REPO, "backend/app/detect-cache.js")));
      const upRow = app.db.prepare("SELECT * FROM uploads WHERE id=?").get(up3.json.uploadId);
      cacheMod.__seedDetectCache(up3.json.uploadId, cacheMod.frameIndexFor(upRow, 0), {
        frameWidth: 12, frameHeight: 12,
        objects: [
          { id: 1, label: "cougar", box: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 } },
          { id: 2, label: "bush", box: { left: 0.5, top: 0.5, right: 0.9, bottom: 0.9 } },
        ],
        indexMapPngBase64: FX.DETECT.indexMapPngBase64,
      });
      const advMulti = await support.api(base, "POST", "/api/jobs", { user: "carol", body: { uploadId: up3.json.uploadId, tier: "advanced", objectIds: [1, 2], seedTime: 0 } });
      assert.equal(advMulti.status, 400);
      assert.equal(advMulti.json.error, ADV_MULTI_CONCEPT_TEXT);
      const up4 = await support.uploadClip(base, { user: "carol" });
      const stale = await support.api(base, "POST", "/api/jobs", { user: "carol", body: { uploadId: up4.json.uploadId, tier: "lite", objectIds: [1], seedTime: 0 } });
      assert.equal(stale.status, 400);
      assert.equal(stale.json.error, SELECTION_STALE_TEXT);
      await openStudio(page, "carol");
      try {
        await page.waitForFunction(() => document.querySelectorAll("#buildList .build").length >= 1, null, { polling: 500, timeout: ACTION });
      } catch (e) { await dump(page, errors, "section-6-builds"); throw e; }
      assert.match(await page.evaluate(() => document.querySelector("#buildList").textContent), /awaiting approval/);
      await page.getByRole("button", { name: "Unpublish" }).click();
      try {
        await page.waitForFunction(() => document.querySelector("#buildList").textContent.includes("finished"), null, { polling: 500, timeout: ACTION });
      } catch (e) { await dump(page, errors, "section-6-unpublish"); throw e; }
      await page.getByRole("button", { name: "Report" }).click();
      let rows = [];
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        rows = app.db.prepare("SELECT reason FROM reports WHERE job_id=? ORDER BY created_at").all(jobId).map((r) => r.reason);
        if (rows.includes("test reason")) break;
      }
      assert.ok(rows.includes("test reason"), "report reason reaches the backend");
      await page.getByRole("button", { name: "Delete" }).click();
      await page.waitForFunction(() => document.querySelectorAll("#buildList .build").length === 0, null, { polling: 500, timeout: ACTION });
      assert.match(await page.evaluate(() => document.querySelector("#toast").textContent), /Deleted/);
      assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE id=?").get(jobId).n, 0);
      return "my builds lists status; unpublish flips state; report posts; delete removes the build (+Basic>1/Advanced-multi/stale snapshot 400 contracts)";
    } finally { await browser.close(); }
  }, (l) => dump(lastDiag.page, lastDiag.errors, l));

  // 7. publish -> owner approves -> gallery shows it; admin kill switch
  await section(7, "publish approve gallery admin kill", async () => {
    const owner = await launch();
    try {
      await wire(owner.page, base, "olga", {}, "owner");
      await owner.page.goto(`${base}/admin.html`, { waitUntil: "domcontentloaded", timeout: ACTION });
      await owner.page.waitForFunction(() => document.querySelector("#queueState").textContent.length > 8, null, { polling: 500, timeout: ACTION });
      assert.match(await owner.page.evaluate(() => document.querySelector("#spendLine").textContent), /GPU worker/);
      const statusText = await owner.page.evaluate(() => document.querySelector("#statusPanel").textContent);
      assert.match(statusText, /jobs today/);
      assert.match(statusText, /pending/);
      assert.match(statusText, /gpu worker/);
      await owner.page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "admin.png") });
      const up2 = await support.uploadClip(base, { user: "dave" });
      assert.equal(up2.status, 200);
      await support.seedSelectionCache(app, up2.json.uploadId, { seedTime: 0 });
      const created2 = await support.api(base, "POST", "/api/jobs", { user: "dave", body: { uploadId: up2.json.uploadId, tier: "lite", objectIds: [1], seedTime: 0, title: "dave solid", subject: "test-object" } });
      assert.equal(created2.status, 200, `dave enqueue: ${JSON.stringify(created2.json).slice(0, 160)}`);
      const target = created2.json.jobId;
      galleryJobId = target;
      await support.waitFor(base, target, { user: "dave" });
      await support.api(base, "POST", `/api/jobs/${target}/publish`, { user: "dave" });
      await owner.page.reload({ waitUntil: "domcontentloaded" });
      await owner.page.waitForFunction(() => document.querySelectorAll(".admin-card").length >= 1, null, { polling: 500, timeout: ACTION });
      for (let i = 0; i < 6; i++) {
        if ((await owner.page.locator(".admin-card").count()) === 0) break;
        await owner.page.locator(".admin-card").first().getByRole("button", { name: "Approve" }).click();
        await owner.page.waitForTimeout(1500);
      }
      await owner.page.waitForFunction(() => document.querySelector("#queueState").textContent.includes("empty"), null, { polling: 500, timeout: ACTION });
      const approved = await support.api(base, "GET", `/api/jobs/${target}`, { user: "dave" });
      assert.equal(approved.json.publish, "approved");
      const gallery = await support.api(base, "GET", "/api/gallery", { user: "dave" });
      assert.ok(gallery.json.specimens.some((s) => s.id === target), "approved build appears in the gallery");
      const kill = await support.api(base, "POST", "/api/admin/kill", { user: "olga", role: "owner", body: { enabled: true } });
      assert.equal(kill.json.killed, true);
      const unkilled = await support.api(base, "POST", "/api/admin/kill", { user: "olga", role: "owner", body: { enabled: false } });
      assert.equal(unkilled.json.killed, false);
      await support.api(base, "POST", "/api/admin/kill", { user: "olga", role: "owner", body: { enabled: true } });
      {
        const { browser, page } = await launch();
        try {
          await openStudio(page, "maint");
          await page.waitForFunction(() => !document.querySelector("#maintBanner").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
          assert.match(await page.evaluate(() => document.querySelector("#maintBanner").textContent), /builds are paused/);
        } finally { await browser.close(); }
      }
      await support.api(base, "POST", "/api/admin/kill", { user: "olga", role: "owner", body: { enabled: false } });
      const denied = await support.api(base, "GET", "/api/admin/pending", { user: "mallory" });
      assert.equal(denied.status, 403);
      return "publish -> owner approves -> gallery shows it; status panel live; kill toggles + studio banner; non-owners refused";
    } finally { await owner.browser.close(); }
  });

  // 8. LICENSED gallery: published lite build hangs beside the example rooms (adapted, no grizzly)
  await section(8, "licensed gallery hangs published build", async () => {
    const { browser, page } = await launch();
    lastDiag = { page, errors: [] };
    try {
      await wire(page, base, "erin");
      await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: ACTION });
      await waitStudio(page);
      await page.waitForFunction(() => window.__gallery && window.__gallery.items.length >= 1, null, { polling: 500, timeout: ACTION });
      await page.waitForFunction(() => window.__gallery.bySlot.size >= 1, null, { polling: 500, timeout: ACTION });
      const seeds = await page.evaluate(() => window.__gallery.seeds);
      assert.ok(seeds.length === 4, "four licensed seed examples load");
      assert.deepEqual(seeds.map((s) => s.seedName).sort(), ["blackcat-atlas", "muntjac-atlas", "roedeer-basic", "squirrel-advanced"]);
      // Licensed default opens in the black-cat example room.
      const startPlaque = await page.evaluate(() => document.querySelector("#cellTitle").textContent);
      assert.equal(startPlaque, "EXAMPLE · BLACK CAT");
      const startNote = await page.evaluate(() => document.querySelector("#cellNote").textContent);
      assert.match(startNote, /Dzkouslavia/);
      const firstTitle = await page.evaluate(() => window.__gallery.items[0].title.toUpperCase());
      assert.ok(firstTitle.length >= 1, "published item has a title");
      // First empty room (left of the black-cat room) hangs the published build.
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(1200);
      const plaque = await page.evaluate(() => document.querySelector("#cellTitle").textContent);
      assert.equal(plaque, firstTitle);
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "gallery.png") });
      return "licensed gallery: EXAMPLE seed rooms badged with attribution; published lite build hangs beside them with its title";
    } finally { await browser.close(); }
  }, (l) => dump(lastDiag.page, lastDiag.errors, l));

  // 8b. seed examples badge the featured rooms (adapted: no grizzly walk)
  await section("8b", "seed manifest badges featured rooms", async () => {
    const { browser, page } = await launch();
    try {
      await wire(page, base, "erin");
      await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: ACTION });
      await waitStudio(page);
      await page.waitForFunction(() => window.__gallery && window.__gallery.items.length >= 1, null, { polling: 500, timeout: ACTION });
      await page.waitForFunction(() => window.__gallery.bySlot.size >= 1, null, { polling: 500, timeout: ACTION });
      const seeds = await page.evaluate(() => window.__gallery.seeds);
      assert.ok(seeds.length === 4, "seed manifest loads all four licensed examples");
      // Featured seeds keep their rooms (not duplicated into empty rooms); the
      // other examples fill open rooms, each once.
      const bySlotVals = await page.evaluate(() => [...window.__gallery.bySlot.values()]);
      assert.ok(!bySlotVals.some((id) => ["seed-blackcat", "seed-muntjac"].includes(String(id))), "featured seeds are not duplicated into empty rooms");
      assert.equal(new Set(bySlotVals).size, bySlotVals.length, "no item hangs in two rooms");
      // Leave the EXAMPLE room (left, to the published build), then walk back
      // and assert the badge is restored — navigation proven, not assumed from
      // the start cell.
      const startPlaque = await page.evaluate(() => document.querySelector("#cellTitle").textContent);
      assert.match(startPlaque, /EXAMPLE · (BLACK CAT|MUNTJAC)/, "starts on a featured EXAMPLE room");
      const firstTitle = await page.evaluate(() => ((window.__gallery.items[0].title || "PUBLISHED")).toUpperCase().slice(0, 40));
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(1200);
      assert.equal(await page.evaluate(() => document.querySelector("#cellTitle").textContent), firstTitle, "walked out to the published build");
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1200);
      const plaque = await page.evaluate(() => document.querySelector("#cellTitle").textContent);
      assert.match(plaque, /EXAMPLE · (BLACK CAT|MUNTJAC)/, "EXAMPLE badge restored after walking back");
      return "seed manifest carries blackcat+muntjac; walking out and back restores the EXAMPLE badge";
    } finally { await browser.close(); }
  });

  // 9a. terms states
  await section("9a", "terms retention training deletion + attribution", async () => {
    const { browser, page } = await launch();
    try {
      await page.goto(`${base}/terms.html`, { waitUntil: "domcontentloaded", timeout: ACTION });
      const body = await page.evaluate(() => document.body.textContent);
      assert.match(body, /30 days/);
      assert.match(body, /not used for training/);
      assert.match(body, /Delete button in My builds/);
      assert.match(body, /Black Cat walking/);
      assert.match(body, /Muntjac Deer Barking/);
      return "terms covers retention, training note, deletion and both licensed attributions";
    } finally { await browser.close(); }
  });

  // 9b. view-lite empty state
  await section("9b", "view-lite empty state", async () => {
    const { browser, page } = await launch();
    try {
      await page.goto(`${base}/view-lite.html`, { waitUntil: "domcontentloaded", timeout: ACTION });
      await page.waitForTimeout(1200);
      assert.match(await page.evaluate(() => document.querySelector("#stageText").textContent), /No build id/);
      return "view-lite without an id shows an intentional empty state";
    } finally { await browser.close(); }
  });

  // 9c. view-lite renders the approved solid
  await section("9c", "view-lite renders solid + slider", async () => {
    const { browser, page } = await launch();
    try {
      await page.goto(`${base}/view-lite.html?id=${galleryJobId}`, { waitUntil: "domcontentloaded", timeout: ACTION });
      await page.waitForFunction(() => !!window.__lite, null, { polling: 500, timeout: ACTION });
      await page.waitForTimeout(2000);
      assert.match(await page.evaluate(() => document.title), /dave solid/);
      const vchips = await page.evaluate(() => document.querySelector("#vChips").textContent);
      assert.match(vchips, /SAM 3\.1 tracking/);
      assert.match(vchips, /Muse Spark/);
      await page.locator("#timeSlider").fill("500");
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => document.querySelector("#timeOut").textContent), "50%");
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "view-lite.png") });

      return "view-lite renders a solid; slider scrubs time; keyboard/slider accessible";
    } finally { await browser.close(); }
  });

  // 10. mobile 390x844 + native VIEW disclosure
  await section(10, "mobile layout + native disclosure", async () => {
    const { browser, page } = await launch();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await openStudio(page, "fred");
      const layout = await page.evaluate(() => {
        const dz = document.querySelector("#dropZone").getBoundingClientRect();
        const tiers = [...document.querySelectorAll(".tier-pick .mode-card")].map((el) => el.getBoundingClientRect());
        return { dropIn: dz.left >= 0 && dz.right <= innerWidth, stacked: tiers.every((r, i, a) => i === 0 || r.top >= a[i - 1].bottom - 1) };
      });
      assert.equal(layout.dropIn, true);
      assert.equal(layout.stacked, true);
      // Native mobile VIEW disclosure: closed details on the phone width.
      const disc = await page.evaluate(() => {
        const d = document.querySelector("details.toggles");
        return d ? { open: d.open, summary: d.querySelector("summary")?.textContent } : null;
      });
      assert.ok(disc, "native VIEW disclosure exists");
      assert.equal(disc.summary, "View");
      assert.equal(disc.open, false, "disclosure starts closed on phone width");
      await page.check("#rightsBox");
      await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { polling: 500, timeout: ACTION });
      await page.click("#routeGo");
      const stacks = await page.evaluate(() => {
        const wrap = document.querySelector("#frameCanvasWrap").getBoundingClientRect();
        return document.querySelector(".frame-side").getBoundingClientRect().top >= wrap.bottom - 1;
      });
      assert.equal(stacks, true);
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "studio-mobile.png") });
      // Wide again: the disclosure stays closed (the room comes first on every screen).
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.reload({ waitUntil: "domcontentloaded", timeout: ACTION });
      await waitStudio(page);
      assert.equal(await page.evaluate(() => document.querySelector("details.toggles").open), false);
      return "390x844: tiers stack, drop zone fits, frame step stacks; VIEW disclosure closed on phone and on wide";
    } finally { await browser.close(); }
  });

  await section("11", "explicit drawn box -> inspected mask -> Lite and Basic jobs", async () => {
    const outcomes = [];
    for (const tier of ["lite", "basic"]) {
    const { browser, page, errors } = await launch("user", { recordVideo: tier === "basic" });
    try {
      BE.spark = "fixed"; BE.cuts = 0; BE.detectMode = "empty"; BE.boxMode = "ok"; BE.boxCalls = 0;
      await openStudio(page, "box-pointer-" + tier);
      await page.check("#rightsBox"); await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { timeout: ACTION });
      // Choose the tier for THIS upload through real controls; no forced enable.
      await page.click("#routeBack"); await page.click(`input[name="tier"][value="${tier}"]`); await page.click("#uploadContinue");
      assert.equal(await page.evaluate(() => document.querySelector('input[name="tier"]:checked').value), tier);
      await page.click("#findObjects");
      await page.waitForFunction(() => document.querySelector("#detectStatus").textContent.includes("Nothing matched"), null, { timeout: ACTION });
      assert.equal(await page.locator("#toast").evaluate(el => el.classList.contains("is-visible") && el.textContent === "Uploading…"), false, "completed upload must not leave its progress toast");
      const nounCalls = BE.detectCalls;
      const reply = page.waitForResponse(r => r.url().endsWith("/api/detect-box") && r.status() === 200, { timeout: ACTION });
      let postedJob;
      page.on("request", req => { if (req.method() === "POST" && req.url().endsWith("/api/jobs")) postedJob = req.postDataJSON(); });
      await page.click("#drawBox");
      const rect = await page.locator("#hoverCanvas").boundingBox();
      await page.mouse.move(rect.x + rect.width * .1, rect.y + rect.height * .1); await page.mouse.down();
      await page.mouse.move(rect.x + rect.width * .8, rect.y + rect.height * .8, { steps: 6 }); await page.mouse.up();
      await page.locator("#objectList [data-obj]").waitFor({ state: "visible", timeout: ACTION });
      assert.equal(BE.boxCalls, 1); assert.equal(BE.detectCalls, nounCalls);
      const returned = await (await reply).json();
      const receipt = await page.evaluate(() => window.__studio.selectionToken);
      assert.equal(receipt, returned.selectionToken);
      const expectedPixels = await sharp(Buffer.from(returned.framePngBase64, "base64")).ensureAlpha().raw().toBuffer();
      const actualHash = await page.evaluate(async () => {
        const c = document.querySelector("#previewCanvas");
        const bytes = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
      });
      assert.equal(actualHash, crypto.createHash("sha256").update(expectedPixels).digest("hex"), "preview must show the exact server PNG");
      assert.deepEqual(await page.evaluate(() => window.__studio.selected), [], "mask must be inspected/selected, not an automatic build");
      await page.click("#objectList [data-obj]");
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "box-selected-" + tier + ".png") });
      await page.click("#generateButton");
      await page.waitForFunction(() => !document.querySelector("#stepDone").classList.contains("is-hidden"), null, { timeout: ACTION });
      assert.equal(BE.boxCalls, 1); assert.equal(BE.detectCalls, nounCalls);
      assert.equal(postedJob.selectionToken, receipt); assert.equal(postedJob.selectionKind, "box");
      const storedJob = app.db.prepare("SELECT tier,selection_snapshot FROM jobs WHERE id=?").get(await page.evaluate(() => window.__studio.jobId));
      assert.equal(storedJob.tier, tier);
      assert.equal(JSON.parse(storedJob.selection_snapshot).version, 2);
      assert.deepEqual(errors.filter(e => e.startsWith("pageerror:")), []);
      outcomes.push(`${tier}: one stubbed SAM attempt, exact server PNG/receipt, inspected mask then correct v2 job`);
    } finally {
      const video = page.video();
      await browser.close(); BE.detectMode = "ok";
      if (video) fs.writeFileSync(path.join(RUN_DIR, "basic-box-ui-video.json"), JSON.stringify({ file: await video.path(), kind: "synthetic testsrc + fake SAM mask, actual UI capture; NOT real generation" }));
    }
    }
    return outcomes.join("; ");
  });

  await section("12", "keyboard box + explicit same-box retry + Escape cancellation", async () => {
    const { browser, page, errors } = await launch();
    try {
      BE.spark = "fixed"; BE.cuts = 0; BE.boxMode = "once503"; BE.boxCalls = 0;
      await openStudio(page, "box-keyboard");
      await page.check("#rightsBox"); await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { timeout: ACTION });
      await page.click("#routeBack"); await page.click('input[name="tier"][value="lite"]'); await page.click("#uploadContinue");
      assert.equal(await page.evaluate(() => document.querySelector('input[name="tier"]:checked').value), "lite");
      const nounCalls = BE.detectCalls, requests = [];
      page.on("request", req => { if (req.method() === "POST" && req.url().endsWith("/api/detect-box")) requests.push(req.postDataJSON()); });
      const cellBefore = await page.textContent("#cellCoord");
      await page.click("#drawBox"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
      for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.locator("#detectRetry").waitFor({ state: "visible", timeout: ACTION });
      assert.equal(BE.boxCalls, 1); assert.equal(BE.detectCalls, nounCalls);
      await page.click("#detectRetry");
      await page.locator("#objectList [data-obj]").waitFor({ state: "visible", timeout: ACTION });
      assert.equal(BE.boxCalls, 2); assert.equal(BE.detectCalls, nounCalls, "Retry must not switch into Spark/noun sweep");
      assert.deepEqual(requests[1], requests[0], "Retry must repeat the exact box and frame");
      assert.equal(await page.textContent("#cellCoord"), cellBefore, "box arrows must not move the gallery");
      await page.click("#drawBox"); await page.keyboard.press("Escape");
      assert.equal(await page.getAttribute("#drawBox", "aria-pressed"), "false"); assert.equal(BE.boxCalls, 2);
      assert.deepEqual(errors.filter(e => e.startsWith("pageerror:")), []);
      return "keyboard corner picker works; Retry repeats only its explicit box request; Escape sends no request";
    } finally { await browser.close(); BE.boxMode = "ok"; }
  });

  await section("13", "phone Basic touch box does not scrub the background gallery", async () => {
    const { browser, context, page, errors } = await launch("user", { viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      BE.spark = "fixed"; BE.cuts = 0; BE.boxMode = "ok"; BE.boxCalls = 0;
      await openStudio(page, "box-touch");
      await page.check("#rightsBox"); await page.setInputFiles("#videoInput", clip);
      await page.waitForFunction(() => !document.querySelector("#stepRoute").classList.contains("is-hidden"), null, { timeout: ACTION });
      await page.click("#routeBack"); await page.click('input[name="tier"][value="basic"]'); await page.click("#uploadContinue");
      await page.click("#drawBox"); await page.locator("#hoverCanvas").scrollIntoViewIfNeeded({ timeout: ACTION });
      const cut = await page.textContent("#cutReadout"), rect = await page.locator("#hoverCanvas").boundingBox();
      const session = await context.newCDPSession(page);
      const point = (x, y) => [{ x: rect.x + rect.width * x, y: rect.y + rect.height * y }];
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(.8, .8) });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(.5, .5) });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(.2, .2) });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.locator("#objectList [data-obj]").waitFor({ state: "visible", timeout: ACTION });
      assert.equal(BE.boxCalls, 1); assert.equal(await page.textContent("#cutReadout"), cut, "upward box gesture must not scrub the gallery");
      await page.click("#objectList [data-obj]");
      await page.screenshot({ timeout: ACTION, path: path.join(SCRATCH, "box-mobile-selected.png") });
      assert.deepEqual(errors.filter(e => e.startsWith("pageerror:")), []);
      await page.locator("#generateButton").scrollIntoViewIfNeeded({ timeout: ACTION });
      await page.click("#generateButton");
      await page.waitForFunction(() => !document.querySelector("#stepDone").classList.contains("is-hidden"), null, { timeout: ACTION });
      const phoneJob = app.db.prepare("SELECT tier,selection_snapshot FROM jobs WHERE id=?").get(await page.evaluate(() => window.__studio.jobId));
      assert.equal(phoneJob.tier, "basic"); assert.equal(JSON.parse(phoneJob.selection_snapshot).version, 2);
      return "phone touch draws one explicit box without gallery scrub; Basic Build is reachable and stores the v2 job";
    } finally { await browser.close(); }
  });

  // Final gate: any UNEXPECTED network block fails the suite (self-test
  // trips are explicit and excluded).
  if (sectionFilter) for (const n of sectionFilter) if (!seenSections.has(n)) failures.push({ n, label: "section filter", error: "Requested section was not run" });
  let guardVerdict = "clean";
  try { nodeGuard.assertClean(); }
  catch (e) {
    guardVerdict = String(e.message).slice(0, 200);
    failures.push({ n: "net", label: "network guard", error: guardVerdict });
  }
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(RUN_DIR, "web-checks.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(RUN_DIR, "harness-report.json"), JSON.stringify({ results, failures, selectedSections: sectionFilter ? [...sectionFilter] : null, trips: nodeGuard.trips, guardVerdict, shots: SCRATCH }, null, 2));
  console.log(`[harness] done: ${results.length} passed, ${failures.length} failed, guard: ${guardVerdict}`);
  if (failures.length) console.log("[harness] failures:", JSON.stringify(failures, null, 2));
  clearTimeout(runCap);
  await closeAll();
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  console.error("Passed so far:", results);
  try { fs.writeFileSync(path.join(RUN_DIR, "harness-report.json"), JSON.stringify({ results, failures: [...failures, { n: "top", label: "top-level", error: String(e?.message || e).slice(0, 500) }], trips: (typeof nodeGuard !== "undefined" ? nodeGuard.trips : []), runAborted: true }, null, 2)); } catch {}
  await closeAll();
  process.exit(1);
});
