// Actual frontend; synthetic accounts/builds, GET-only API fixtures, no inference/egress.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
const ROOT = path.resolve(__dirname, '../..'), BASE = 'http://creation.test';
const sourceDir = process.env.UX_SOURCE_DIR && path.resolve(process.env.UX_SOURCE_DIR);
const jobs = [
  { id: 'missing', tier: 'lite', status: 'done', publish: 'unpublished', result: { title: 'A saved subject trail with a deliberately long descriptive title', viewer: '/fixture.html' } },
  { id: 'broken', tier: 'basic', status: 'done', publish: 'unpublished', result: { title: 'A build whose preview is unavailable', viewer: 'fixture.html', thumb: '/broken.webp' } },
];
(async () => {
  if (process.env.SHOT_DIR) fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe') });
  const results = [], failures = [], errors = [], unexpected = [], buildFileReads = [], videos = [];
  let page, context, label;
  async function close() {
    if (!context) return;
    const video = page.video(), viewport = page.viewportSize(); await context.close();
    if (video) videos.push({ label, source: await video.path(), viewport }); context = null;
  }
  async function fresh(width = 390, entry = '/', empty = false, live = true) {
    await close();
    context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block', isMobile: width < 720, hasTouch: width < 720, reducedMotion: 'reduce', ...(process.env.RECORD_DIR ? { recordVideo: { dir: process.env.RECORD_DIR } } : {}) });
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      if (url.origin !== BASE || req.method() !== 'GET') { unexpected.push(req.method() + ' ' + url.href); return route.abort(); }
      if (p === '/api/health') return route.fulfill({ json: { status: 'ok' } });
      if (p === '/api/build') return route.fulfill({ json: { build: 'test' } });
      if (p === '/api/me') return route.fulfill({ json: { id: 'fixture-user', email: 'fixture@example.test', role: 'user', live, worker: { online: true } } });
      if (p === '/api/me/jobs') return route.fulfill({ json: { jobs: empty ? [] : jobs } });
      if (p === '/api/gallery') return route.fulfill({ json: { specimens: [] } });
      if (p === '/fixture.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Saved viewer fixture</title><button>Play</button>' });
      if (p === '/broken.webp') return route.fulfill({ status: 404, body: 'Deliberately unavailable preview fixture.' });
      const relative = p === '/' ? 'index.html' : p.slice(1);
      const original = path.join(ROOT, relative), overlay = sourceDir && path.join(sourceDir, relative);
      const file = overlay && fs.existsSync(overlay) ? overlay : original;
      if ((/^[^/]+\.(html|js|mjs|css|svg)$/.test(relative) || relative === 'assets/gallery-seed.json' || /^(vendor\/three\/|assets\/fonts\/|assets\/gallery-seed\/)/.test(relative)) && fs.existsSync(file)) return route.fulfill({ path: file });
      // your latest finished build hangs in your cell, so the page reads its saved files;
      // the synthetic builds have none (a same-origin GET of a saved file, not a live API call)
      if (/^\/specimens\/[^/]+\//.test(url.pathname)) { buildFileReads.push(url.pathname); return route.fulfill({ status: 404, body: 'Synthetic build: no saved files.' }); }
      unexpected.push(p); return route.fulfill({ status: 404, body: 'No unlisted requests allowed.' });
    });
    page = await context.newPage(); page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(10000);
    page.on('pageerror', e => errors.push({ label, error: e.message }));
    await page.goto(BASE + entry, { waitUntil: 'networkidle' });
    if (entry === '/') { await page.waitForFunction(() => window.__studio?.meKnown); await page.click('#uploadCta'); await page.waitForFunction(() => document.body.classList.contains('in-instrument')); }
  }
  async function check(name, fn) {
    label = name;
    try {
      await fn();
      if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOT_DIR, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png') }); }
      results.push({ label: name, passed: true }); console.log('PASS ' + name);
    } catch (e) { failures.push({ label: name, error: e.message }); results.push({ label: name, passed: false }); console.log('FAIL ' + name + ': ' + e.message); }
  }
  try {
    for (const width of [320, 390, 720, 1280]) await check('Creation stays compact and usable at ' + width + 'px', async () => {
      await fresh(width);
      const layout = await page.evaluate(() => {
        const r = el => { const b = el.getBoundingClientRect(); return { y: b.y, bottom: b.bottom, height: b.height, width: b.width }; };
        return { overflow: document.documentElement.scrollWidth > innerWidth, panel: r(document.querySelector('.instrument-inner')), tiers: r(document.querySelector('#tierPick')), drop: r(document.querySelector('#dropZone')), consent: document.querySelector('.consent').textContent };
      });
      if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'initial-create-' + width + '.png') });
      assert.equal(layout.overflow, false, 'Creation overflows horizontally.');
      assert(layout.tiers.height < (width < 720 ? 300 : 270), 'Technical tier copy crowds out uploading.');
      assert(layout.drop.y < layout.panel.bottom - 24, 'Uploading is entirely below the initial viewport.');
      assert.match(layout.consent, /Meta/); assert.match(layout.consent, /not used for training/); assert.match(layout.consent, /owner approval/);
      assert.equal(await page.locator('#rightsBox').isChecked(), false, 'Consent must remain explicit.');
      assert.equal(await page.locator('input[name=tier]').count(), 3);
      await page.locator('input[value=basic]').check(); assert.equal(await page.locator('input[value=basic]').isChecked(), true);
      const selected = page.locator('.mode-card:has(input:checked) small'); assert(await selected.isVisible(), 'Selected tier explanation is hidden.');
      if (width < 720) assert.equal(await page.locator('.mode-card:has(input:not(:checked)) small:visible').count(), 0, 'Inactive mobile explanations are not collapsed.');
      await page.locator('#rightsBox').check(); assert.equal(await page.locator('#rightsBox').isChecked(), true);
      assert.equal(await page.locator('input[value=basic]').isChecked(), true, 'Consent changed the selected tier.');
    });
    for (const live of [false, true]) for (const width of [390, 1280]) for (const tier of ['lite', 'basic', 'advanced']) await check((live ? 'Live' : 'Native') + ' ' + tier + ' camera advice matches capability at ' + width + 'px', async () => {
      await fresh(width, '/', false, live);
      // Component-state fixture, not an upload, model route or generation test.
      await page.evaluate(() => {
        window.__studio.route = { category: 'wildlife', camera: 'moving', subjects: ['fixture subject'], warnings: [] };
        window.__studio.routeError = 'Local fixture: clip check unavailable.';
      });
      // Force a genuine tier change even when the default already is Lite.
      await page.locator('input[value=' + (tier === 'lite' ? 'basic' : 'lite') + ']').check();
      await page.locator('input[value=' + tier + ']').check();
      // Existing back handler shows the route card without inventing a public test API.
      await page.evaluate(() => document.querySelector('#cancelFrame').click());
      assert(await page.locator('#stepRoute').isVisible());
      const copy = await page.locator('#routeCard').innerText();
      assert.match(copy, /you can continue with defaults/i);
      assert.doesNotMatch(copy, /any camera works|fastest|fastest and best/i, 'Advice overstates supported inputs or unmeasured speed.');
      if (tier === 'lite') assert.match(copy, /Lite accepts fixed or moving cameras/);
      else if (tier === 'basic' && !live) {
        assert.match(copy, /Basic needs a steady, fixed camera/);
        assert.match(copy, /moving-camera clips, choose Lite/);
        assert.doesNotMatch(copy, /several viewpoints|finish as a 3D cloud/);
      } else if (tier === 'basic') {
        assert.match(copy, /Basic accepts fixed or moving cameras/);
        assert.match(copy, /finish as a 3D cloud/);
      } else if (live) {
        assert.match(copy, /Moving-camera builds finish as a 3D cloud/);
        assert.match(copy, /shells and live footage need a fixed camera/);
      } else {
        assert.match(copy, /fixed-camera clip is recommended/);
        assert.match(copy, /GPU worker.*may decline unsupported clips/);
        assert.doesNotMatch(copy, /moving cameras build|live footage need/);
      }
      assert.equal(await page.locator('input[name=tier]:checked').inputValue(), tier);
      assert.equal(await page.locator('#routeGo').isEnabled(), true, 'Advice silently changed permission to continue.');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    });
    for (const width of [390, 1280]) await check('Legacy CGI rejection remains advisory at ' + width + 'px', async () => {
      await fresh(width);
      // Simulates a cached/older backend; the frontend must not restore the gate.
      await page.evaluate(() => {
        window.__studio.route = { category: 'other', camera: 'fixed', subjects: ['humanoid 3D model'], warnings: ['synthetic CGI render', 'screen recording'], decline: 'Screen recording' };
      });
      await page.locator('input[value=basic]').check(); // Re-render the injected route through the real tier handler.
      await page.evaluate(() => document.querySelector('#cancelFrame').click());
      assert.equal(await page.locator('#routeTitle').innerText(), 'Your clip, as Spark sees it');
      const copy = await page.locator('#routeCard').innerText();
      assert.match(copy, /humanoid 3D model/);
      assert.match(copy, /synthetic CGI render/);
      assert.match(copy, /screen recording/);
      assert.match(copy, /Clip checks are advisory/);
      assert.equal(await page.locator('#routeGo').innerText(), 'Continue to picking');
      assert.equal(await page.locator('#routeGo').isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.locator('#routeGo').click();
      assert(await page.locator('#stepFrame').isVisible());
    });
    await check('Library missing and broken previews have intentional readable states', async () => {
      await fresh(390); await page.click('#myBuildsCta');
      assert(await page.locator('#tierPick').isHidden(), 'Direct library entry still shows the creation form.');
      const heading = await page.locator('#myBuilds .side-label').boundingBox(), panel = await page.locator('.instrument-inner').boundingBox();
      assert(heading.y >= panel.y && heading.y < panel.y + 40, 'A short library cannot align its heading.');
      const broken = page.locator('.build[data-job-id=broken]'); await broken.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      assert.match(await page.locator('.build[data-job-id=missing]').innerText(), /no preview|preview unavailable/i);
      assert.match(await broken.innerText(), /preview unavailable/i);
      const visibleBroken = await page.locator('.build img').evaluateAll(els => els.filter(e => e.getClientRects().length && (!e.complete || !e.naturalWidth)).length);
      assert.equal(visibleBroken, 0, 'Broken image icon is shown.');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    });
    await check('Root-relative saved asset URLs stay on the selected API origin', async () => {
      await fresh(390); await page.click('#myBuildsCta');
      await page.locator('.build[data-job-id=missing]').getByRole('button', { name: 'Open', exact: true }).click();
      const src = await page.locator('#viewerFrame').getAttribute('src');
      assert.equal(new URL(src, BASE).origin, BASE, 'Saved viewer became a protocol-relative off-site URL.');
      await page.frameLocator('#viewerFrame').getByRole('button', { name: 'Play', exact: true }).waitFor();
    });
    await check('An empty library gives a clear route back to creating', async () => {
      await fresh(390, '/', true); await page.click('#myBuildsCta');
      assert(await page.locator('#tierPick').isHidden());
      assert(await page.locator('#buildsEmpty').isVisible());
      assert.match(await page.locator('#buildsEmpty').innerText(), /create/i);
      await page.click('#uploadCta'); assert(await page.locator('#tierPick').isVisible());
      assert.equal(await page.locator('#rightsBox').isChecked(), false);
    });
    await check('Library actions keep mobile-sized hit targets', async () => {
      await fresh(320); await page.click('#myBuildsCta');
      // measure a settled layout, not whatever frame the click lands on under load: fonts in,
      // the panel open with no transition running, and the same button rects two frames running
      await page.waitForFunction(() => new Promise(resolve => {
        const cell = document.querySelector('#instrumentCell');
        const rects = () => [...document.querySelectorAll('#buildList button')].map(e => { const r = e.getBoundingClientRect(); return r.width + 'x' + r.height; }).join('|');
        if (document.fonts.status !== 'loaded' || !cell || !cell.classList.contains('is-live') || getComputedStyle(cell).transform !== 'none' || cell.getAnimations({ subtree: true }).some(a => a.playState === 'running')) return resolve(false);
        const before = rects();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(before !== '' && before === rects())));
      }));
      const buttons = await page.locator('#buildList button').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
      assert(buttons.length >= 4); assert(buttons.every(b => b.width >= 44 && b.height >= 44), 'Library actions are undersized.');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    });
    for (const tier of ['lite', 'basic', 'advanced']) await check('Live ' + tier + ' title and result labels agree', async () => {
      await fresh(1280, '/live.html?tier=' + tier);
      assert.match(await page.title(), new RegExp('^' + tier, 'i'));
      assert.match(await page.locator('.top b').innerText(), new RegExp('^' + tier, 'i'));
      const result = page.locator('#rail a').last();
      assert.match(await result.innerText(), tier === 'lite' ? /ghost trail/i : tier === 'basic' ? /cloud trail/i : /world/i);
      const headline = await page.locator('#headline').innerText();
      assert.match(headline, tier === 'lite' ? /ghost trail|cut-out/i : tier === 'basic' ? /cloud trail|depth/i : /world|scene/i);
      if (tier !== 'advanced') assert.doesNotMatch(headline, /become a world/i);
    });
  } finally {
    await close(); await browser.close();
    const report = { provenance: 'Synthetic account/build APIs; actual frontend; no inference or network egress.', sourceDir: sourceDir || ROOT, results, failures, pageErrors: errors, unexpectedRequests: unexpected, buildFileReads: [...new Set(buildFileReads)], videos };
    if (process.env.RESULT_PATH) { fs.mkdirSync(path.dirname(process.env.RESULT_PATH), { recursive: true }); fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(report, null, 2)); }
    console.log(JSON.stringify(report, null, 2));
    if (failures.length || errors.length || unexpected.length) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
