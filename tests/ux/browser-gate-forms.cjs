// Actual gate page renderers; synthetic local endpoints only. No real mail, codes, sessions or OAuth.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
const ROOT = path.resolve(__dirname, '../..'), BASE = 'http://gate-forms.test';
(async () => {
  const pages = await import(pathToFileURL(process.env.GATE_PAGES_SOURCE || path.join(ROOT, 'backend/app/gate/pages.js')));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe') });
  const results = [], failures = [], errors = [], unexpected = [];
  let page, context, label, scenario, held, requests;
  async function fresh({ width = 390, providers = { email: true }, blocked = false, invite = true } = {}) {
    if (context) await context.close();
    context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    // Bound the production 15s post timeout for a deterministic local timeout test only.
    await context.addInitScript(() => { const timer = window.setTimeout; window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 15000 ? 80 : ms, ...args); });
    held = null; requests = []; scenario = 'ok';
    await context.route('**/*', async route => {
      const r = route.request(), url = new URL(r.url()), p = url.pathname;
      if (url.origin !== BASE) { unexpected.push(r.method() + ' ' + url.href); return route.abort(); }
      if (r.method() === 'GET' && p === '/signin') return route.fulfill({ contentType: 'text/html', body: pages.signinPage({ next: '/compare.html', providers }) });
      if (r.method() === 'GET' && p === '/blocked') return route.fulfill({ contentType: 'text/html', body: pages.blockedPage({ canInvite: invite }) });
      if (r.method() === 'GET' && ['/', '/compare.html'].includes(p)) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local destination fixture</title><h1>No real session was created.</h1>' });
      if (r.method() === 'POST' && ['/auth/start', '/auth/verify', '/geo/code'].includes(p)) {
        // Do not store/print entered codes. Bodies are read in memory for assertions only.
        requests.push(p);
        if (scenario === 'network') return route.abort('failed');
        if (scenario === 'hold' || scenario === 'timeout') { held = route; return; }
        if (scenario === 'malformed') return route.fulfill({ status: 200, contentType: 'application/json', body: 'unreadable response fixture' });
        if (scenario === 'rate') return route.fulfill({ status: 429, json: { error: 'too_many_attempts' } });
        if (scenario === 'reject') return route.fulfill({ status: 401, json: { error: 'rejected fixture' } });
        if (p === '/auth/verify') {
          const body = r.postDataJSON();
          if (String(body.code).replace(/[^0-9]/g, '').length !== 8) return route.fulfill({ status: 400, json: { error: 'Expected an eight-digit synthetic input' } });
          return route.fulfill({ json: { ok: true, next: body.next || '/' } });
        }
        return route.fulfill({ json: { ok: true } });
      }
      // The gate's pre-auth public files (fonts, landing media, terms) come from disk; anything else stays unexpected.
      if (['GET', 'HEAD'].includes(r.method()) && (pages.PUBLIC_FILES || []).includes(p)) return route.fulfill({ path: path.join(ROOT, p) });
      unexpected.push(r.method() + ' ' + p); return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(2500);
    const current = label; page.on('pageerror', e => errors.push({ label: current, error: e.message }));
    await page.goto(BASE + (blocked ? '/blocked' : '/signin'));
  }
  const start = async () => { await page.fill('#email', 'fixture@example.test'); await page.locator('#f1 button').click(); await page.locator('#f2').waitFor({ state: 'visible' }); };
  const submitCode = async () => { await page.fill('#code', '12 34 56 78'); await page.locator('#f2 button[type=submit]').click(); };
  const enabled = async selector => page.waitForFunction(selector => { const el = document.querySelector(selector); return Boolean(el && !el.disabled); }, selector);
  async function check(name, fn) {
    label = name;
    try { await fn(); results.push({ label: name, passed: true }); console.log('PASS ' + name); }
    catch (e) { failures.push({ label: name, error: e.message }); results.push({ label: name, passed: false }); console.log('FAIL ' + name + ': ' + e.message); }
  }
  try {
    for (const width of [320, 390, 1280]) await check('Blank sign-in explains purpose and privacy at ' + width + 'px', async () => {
      await fresh({ width });
      assert.match(await page.locator('main').innerText(), /cut-outs|movement/i);
      const info = page.locator('details'); await info.locator('summary').click();
      const text = await info.innerText(); assert.match(text, /Meta/); assert.match(text, /not used for training/); assert.match(text, /approval/); assert.match(text, /stored|store/i);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(requests.length, 0);
      if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'blank-privacy-' + width + '.png'), fullPage: true }); }
    });
    await check('Empty and malformed email are actionable without a request', async () => {
      await fresh(); await page.locator('#f1 button').click(); assert.match(await page.locator('#status').innerText(), /email/i);
      await page.fill('#email', 'not-an-email'); await page.locator('#f1 button').click();
      assert.equal(requests.length, 0); assert.match(await page.locator('#status').innerText(), /email|address/i);
      assert(await page.locator('#f1 button').isEnabled());
    });
    for (const kind of ['network', 'timeout', 'malformed']) await check('Email ' + kind + ' failure recovers and can retry', async () => {
      await fresh(); scenario = kind; await page.fill('#email', 'fixture@example.test'); await page.locator('#f1 button').click();
      await page.waitForTimeout(180); await enabled('#f1 button');
      assert(await page.locator('#f1').isVisible()); assert.match(await page.locator('#status').innerText(), /connection|request|response|timed out/i);
      scenario = 'ok'; await page.locator('#f1 button').click(); await page.locator('#f2').waitFor({ state: 'visible' });
    });
    await check('Pending email request freezes controls and cannot double-submit', async () => {
      await fresh(); scenario = 'hold'; await page.fill('#email', 'fixture@example.test');
      await page.locator('#f1').evaluate(f => { f.requestSubmit(); f.requestSubmit(); });
      await page.waitForTimeout(20);
      assert.equal(requests.length, 1); assert(await page.locator('#email').isDisabled()); assert(await page.locator('#back').isDisabled());
      await held.fulfill({ json: { ok: true } }); await page.locator('#f2').waitFor({ state: 'visible' });
      assert(await page.locator('#code').isEnabled());
    });
    for (const stage of ['email', 'verify']) await check(stage + ' rate rejection restores controls with honest feedback', async () => {
      await fresh(); if (stage === 'verify') await start(); scenario = 'rate';
      if (stage === 'email') { await page.fill('#email', 'fixture@example.test'); await page.locator('#f1 button').click(); } else await submitCode();
      await enabled(stage === 'email' ? '#f1 button' : '#f2 button[type=submit]');
      assert.match(await page.locator('#status').innerText(), /too many attempts/i);
    });
    for (const kind of ['network', 'timeout', 'malformed']) await check('Verification ' + kind + ' failure is recoverable', async () => {
      await fresh(); await start(); scenario = kind; await submitCode();
      await page.waitForTimeout(180); await enabled('#f2 button[type=submit]');
      assert.match(await page.locator('#status').innerText(), /connection|request|response|timed out/i);
      assert(await page.locator('#back').isEnabled()); assert(await page.locator('#code').isEnabled());
    });
    await check('Code length is checked locally and changing email clears old state', async () => {
      await fresh(); await start(); const count = requests.length; await page.fill('#code', '12'); await page.locator('#f2 button[type=submit]').click();
      assert.equal(requests.length, count); assert.match(await page.locator('#status').innerText(), /8|eight/i);
      await page.click('#back'); assert(await page.locator('#f1').isVisible());
      assert.equal(await page.locator('#code').inputValue(), ''); assert.equal(await page.locator('#status').innerText(), '');
    });
    await check('Valid formatted synthetic code retains the requested destination', async () => {
      await fresh(); await start(); await submitCode(); await page.waitForURL(BASE + '/compare.html');
      assert.equal(await page.title(), 'Local destination fixture');
    });
    await check('Server code rejection remains retryable', async () => {
      await fresh(); await start(); scenario = 'reject'; await submitCode();
      await enabled('#f2 button[type=submit]'); assert.match(await page.locator('#status').innerText(), /code did not work/i);
    });
    await check('Configured provider links work without inventing email availability', async () => {
      await fresh({ providers: { google: true, facebook: true, email: false } });
      assert.equal(await page.locator('#f1').count(), 0); assert.match(await page.locator('main').innerText(), /not available/i);
      assert.equal(await page.getByRole('link', { name: 'Continue with Google' }).getAttribute('href'), '/auth/google?next=%2Fcompare.html');
      assert.equal(await page.getByRole('link', { name: 'Continue with Facebook' }).getAttribute('href'), '/auth/facebook?next=%2Fcompare.html');
      assert.equal(requests.length, 0);
    });
    for (const kind of ['network', 'timeout']) await check('Invite ' + kind + ' failure is recoverable without changing access policy', async () => {
      await fresh({ blocked: true }); scenario = kind; await page.fill('#c', 'synthetic-invalid-invite'); await page.locator('#g button').click();
      await page.waitForTimeout(180); await enabled('#g button'); assert.match(await page.locator('#status').innerText(), /connection|request|timed out/i);
      scenario = 'reject'; await page.locator('#g button').click(); await enabled('#g button'); assert.match(await page.locator('#status').innerText(), /did not work/i);
    });
    await check('No invite option is added where unavailable', async () => {
      await fresh({ blocked: true, invite: false }); assert.equal(await page.locator('form').count(), 0);
      assert.match(await page.locator('h1').innerText(), /United Kingdom only/); assert.equal(requests.length, 0);
    });
  } finally {
    if (context) await context.close(); await browser.close();
    const report = { provenance: 'Actual page rendering; synthetic same-origin endpoints; no real mail, code, account, session or gate bypass. No filled fields recorded.', results, failures, pageErrors: errors, unexpectedRequests: unexpected };
    if (process.env.RESULT_PATH) { fs.mkdirSync(path.dirname(process.env.RESULT_PATH), { recursive: true }); fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(report, null, 2)); }
    console.log(JSON.stringify(report, null, 2)); if (failures.length || errors.length || unexpected.length) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
