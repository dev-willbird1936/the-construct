// Actual site entrypoint; local assets, synthetic account/builds, no inference or network egress.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
const ROOT = path.resolve(__dirname, '../..'), BASE = 'http://studio.test';
const sourceDir = process.env.UX_SOURCE_DIR && path.resolve(process.env.UX_SOURCE_DIR);
const jobs = Array.from({ length: 12 }, (_, i) => ({ id: 'fixture-' + i, tier: 'lite', status: 'done', publish: 'unpublished', result: { title: 'Fixture build ' + (i + 1), viewer: 'fixture-viewer.html?id=' + i, durationSec: 2 } }));
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe') });
  const results = [], failures = [], errors = [], unexpected = [], buildFileReads = [], videos = [];
  let page, context, name, contextLabel;
  async function closeContext() {
    if (!context) return;
    const video = page?.video(), viewport = page?.viewportSize();
    await context.close();
    if (video) videos.push({ label: contextLabel, source: await video.path(), viewport });
    context = null;
  }
  async function fresh(mobile = false) {
    await closeContext();
    contextLabel = name;
    context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', ...(process.env.RECORD_DIR ? { recordVideo: { dir: process.env.RECORD_DIR, size: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } } } : {}) });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== BASE) { unexpected.push(request.url()); return route.abort(); }
      if (request.method() !== 'GET') { unexpected.push(request.method() + ' ' + url.pathname); return route.abort(); }
      if (url.pathname === '/api/health') return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname === '/api/build') return route.fulfill({ json: { build: 'test' } });
      if (url.pathname === '/api/me') return route.fulfill({ json: { id: 'fixture-user', email: 'fixture@example.test', role: 'user', worker: { online: true }, spendTodayCents: 0 } });
      if (url.pathname === '/api/me/jobs') return route.fulfill({ json: { jobs } });
      if (url.pathname === '/api/gallery') return route.fulfill({ json: { items: [] } });
      if (url.pathname === '/fixture-viewer.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><title>Synthetic viewer fixture</title><body><h1>Saved build fixture</h1><button id="play">Play</button><p>Navigation test only; no generation or model output.</p></body></html>' });
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const source = sourceDir && ['index.html', 'site.js', 'styles.css'].includes(relative) ? path.join(sourceDir, relative) : path.join(ROOT, relative);
      if ((relative === 'index.html' || relative === 'assets/gallery-seed.json' || /^[^/]+\.(js|mjs|css|svg)$/.test(relative) || /^(vendor\/three\/|assets\/fonts\/|assets\/gallery-seed\/)/.test(relative)) && fs.existsSync(source)) return route.fulfill({ path: source });
      // your latest finished build hangs in your cell, so the page reads its saved files;
      // the synthetic builds have none (a same-origin GET of a saved file, not a live API call)
      if (/^\/specimens\/[^/]+\//.test(url.pathname)) { buildFileReads.push(url.pathname); return route.fulfill({ status: 404, body: 'Synthetic build: no saved files.' }); }
      unexpected.push(url.pathname); return route.fulfill({ status: 404, body: 'No external requests or live API calls allowed.' });
    });
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(12000);
    page.on('pageerror', error => errors.push({ scenario: name, message: error.message }));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__studio?.meKnown && document.querySelector('#backendState').classList.contains('is-ok'));
    await page.mouse.move(650, 380);
  }
  const scene = () => page.evaluate(() => ({ coord: document.querySelector('#cellCoord').textContent, cut: document.querySelector('#cutReadout').textContent, studio: document.body.classList.contains('in-instrument'), scroll: document.querySelector('.instrument-inner').scrollTop }));
  async function openStudio() {
    await page.click('#uploadCta');
    await page.waitForFunction(() => document.body.classList.contains('in-instrument') && !document.querySelector('#stepUpload').classList.contains('is-hidden') && document.querySelector('#buildList button'));
    await page.waitForTimeout(250);
  }
  async function check(label, body) {
    if (process.env.SCENARIO && !label.toLowerCase().includes(process.env.SCENARIO.toLowerCase())) return;
    name = label;
    console.log('CHECK ' + label);
    try {
      await body();
      if (process.env.SHOT_DIR) {
        fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SHOT_DIR, label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png') });
      }
      results.push({ label, passed: true }); console.log('PASS ' + label);
    }
    catch (error) { failures.push({ label, error: error.message }); results.push({ label, passed: false }); console.log('FAIL ' + label + ': ' + error.message); }
  }
  try {
    await check('Gallery wheel and arrow keys still act intentionally', async () => {
      await fresh(); const before = await scene();
      await page.mouse.wheel(0, 250); await page.waitForTimeout(450);
      assert.notEqual((await scene()).cut, before.cut, 'Gallery wheel must scrub time.');
      await page.locator('#latticeCanvas').click({ position: { x: 650, y: 380 } });
      await page.keyboard.press('ArrowRight');
      assert.notEqual((await scene()).coord, before.coord, 'Gallery arrow key must travel.');
    });
    await check('Wheel scroll belongs to the overflowing studio panel', async () => {
      await fresh(); await openStudio(); const before = await scene();
      const box = await page.locator('.instrument-inner').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 650); await page.waitForTimeout(550);
      const after = await scene(); assert(after.scroll > 100, 'Wheel did not scroll the panel.');
      assert.equal(after.cut, before.cut, 'Panel wheel scrubbed the background timeline.');
      assert.equal(after.coord, before.coord);
    });
    await check('Panel keyboard input cannot move to another lattice cell', async () => {
      await fresh(); await openStudio(); const before = await scene();
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(450);
      assert.equal((await scene()).coord, before.coord, 'Panel heading arrow moved the scene.');
      await page.locator('input[value="lite"]').focus();
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100);
      assert.equal((await scene()).coord, before.coord, 'Radio-key interaction moved the scene.');
    });
    await check('An open studio suppresses screen-edge auto-travel', async () => {
      await fresh(); await openStudio(); const before = await scene();
      await page.mouse.move(650, 400); await page.waitForTimeout(180);
      await page.mouse.move(1434, 450); await page.waitForTimeout(850);
      assert.equal((await scene()).coord, before.coord, 'A parked panel pointer moved the scene.');
      assert.equal((await scene()).studio, true);
    });
    await check('Emulated touch scroll belongs to the panel, not the timeline', async () => {
      await fresh(true); await openStudio(); const before = await scene();
      const session = await context.newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 205, y: 680 }] });
      for (let i = 1; i <= 12; i++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 205, y: 680 - i * 30 }] });
        await page.waitForTimeout(30);
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(450); const after = await scene();
      assert(after.scroll > 100, 'Native emulated touch did not scroll.');
      assert.equal(after.cut, before.cut, 'Panel touch also scrubbed the background.');
      assert.equal(after.coord, before.coord);
    });
    for (const mobile of [false, true]) for (const close of ['button', 'Escape']) {
      await check(`${mobile ? 'Mobile' : 'Desktop'} viewer ${close} restores launch cell, panel and focus`, async () => {
        await fresh(mobile); await openStudio();
        const launcher = page.locator('#buildList .build').nth(2).getByRole('button', { name: 'Open', exact: true });
        await launcher.focus(); const before = await scene(); await launcher.click();
        await page.frameLocator('#viewerFrame').getByRole('button', { name: 'Play', exact: true }).waitFor();
        if (close === 'button') await page.click('#viewerClose');
        else {
          await page.frameLocator('#viewerFrame').getByRole('button', { name: 'Play', exact: true }).click();
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(800);
        assert(await page.locator('#viewer').evaluate(e => e.classList.contains('is-hidden')), 'Viewer did not close.');
        const after = await scene(); assert.equal(after.coord, before.coord, 'Closing changed the cell.');
        assert.equal(after.studio, true, 'The build list was not restored.');
        assert(Math.abs(after.scroll - before.scroll) < 4, 'Panel scroll position was lost.');
        assert(await launcher.evaluate(e => document.activeElement === e), 'Launch focus was not restored.');
        assert.equal(await page.locator('#viewerFrame').getAttribute('src'), 'about:blank');
      });
    }
    for (const mobile of [false, true]) await check(`${mobile ? 'Mobile' : 'Desktop'} direct My builds opens the list, not just its footer heading`, async () => {
      await fresh(mobile); await page.getByRole('button', { name: 'My builds', exact: true }).click({ timeout: 1500 });
      const heading = page.locator('#myBuilds .side-label');
      await heading.waitFor(); assert.equal((await scene()).studio, true);
      const box = await heading.boundingBox(), panel = await page.locator('.instrument-inner').boundingBox();
      const firstBuild = await page.locator('#buildList .build').first().boundingBox();
      assert(box.y >= panel.y && box.y < panel.y + 40, 'My builds did not align with the top of the panel.');
      assert(firstBuild.y > box.y && firstBuild.y + firstBuild.height <= panel.y + panel.height, 'The first build is not fully visible.');
      assert(await heading.evaluate(e => document.activeElement === e), 'My builds heading was not focused.');
    });
    await check('Explore returns to the prior room; the edge travels on a click, not a parked pointer', async () => {
      await fresh(); const before = await scene(); await openStudio();
      await page.getByRole('button', { name: 'Explore', exact: true }).click({ timeout: 1500 });
      await page.waitForTimeout(750); const after = await scene();
      assert.equal(after.studio, false); assert.equal(after.coord, before.coord);
      // crossing on a parked pointer is an opt-in switch (default off); a click on the edge is the deliberate way
      await page.mouse.move(650, 400); await page.mouse.move(1435, 450); await page.waitForTimeout(1100);
      assert.equal((await scene()).coord, before.coord, 'A parked pointer moved the scene.');
      await page.mouse.click(1435, 450); await page.waitForTimeout(300);
      assert.notEqual((await scene()).coord, before.coord, 'Intentional edge navigation no longer works.');
    });
    await check('Main navigation fits narrow and wide viewports', async () => {
      await fresh();
      for (const width of [320, 390, 720, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.locator('.studio-nav').evaluate(nav => ({ overflow: document.documentElement.scrollWidth > innerWidth, buttons: [...nav.querySelectorAll('button')].map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height }; }) }));
        assert.equal(layout.overflow, false, 'Horizontal overflow at ' + width);
        assert(layout.buttons.every(r => r.left >= 0 && r.right <= width && r.height >= 44), 'Clipped or undersized navigation at ' + width);
      }
    });
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(unexpected.length, 0, JSON.stringify(unexpected));
  } finally {
    await closeContext(); await browser.close();
    const report = { provenance: 'Synthetic account/build APIs; actual site module and assets; no inference.', sourceDir: sourceDir || ROOT, results, failures, pageErrors: errors, unexpectedRequests: unexpected, buildFileReads: [...new Set(buildFileReads)], videos };
    if (process.env.RESULT_PATH) { fs.mkdirSync(path.dirname(process.env.RESULT_PATH), { recursive: true }); fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(report, null, 2)); }
    console.log(JSON.stringify(report, null, 2));
    if (failures.length || errors.length || unexpected.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
