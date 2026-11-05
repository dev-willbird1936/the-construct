// Actual main frontend -> real loopback upload/prepare, with model boundaries refused.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startReviewApp, restoreFetch, chromium, executablePath, identity, clip, ROOT } from './local-review-app.mjs';
const dir = process.env.RESULT_DIR || path.join(ROOT, '.planning/ux-hackathon/phase-04/runs', Date.now() + '-' + crypto.randomBytes(3).toString('hex'));
await fs.mkdir(dir, { recursive: true });
const report = { provenance: 'Actual local createApp/DB/upload/probe/FFmpeg + current UI; test identity, routing intentionally 503, no inference. Not production auth or GPU accuracy/speed certification.', checks: [], failures: [], pageErrors: [], outside: [], fixtures: [] };
const check = async (name, fn) => { try { await fn(); report.checks.push({ name, passed: true }); } catch (e) { report.failures.push({ name, error: e.message }); report.checks.push({ name, passed: false }); } };
let app, browser, context, page;
async function fresh(width = 1440) {
  if (context) await context.close();
  context = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: identity, serviceWorkers: 'block' });
  await app.browserGuard(context, report.outside);
  page = await context.newPage(); page.on('pageerror', e => report.pageErrors.push(e.message));
}
async function uploadMain(tier) {
  await page.goto(app.origin + '/');
  await page.click('#uploadCta'); await page.waitForSelector('#meRow:not([hidden])');
  await page.check(`input[name=tier][value=${tier}]`); await page.check('#rightsBox');
  const response = page.waitForResponse(r => r.url() === app.origin + '/api/upload' && r.request().method() === 'POST');
  await page.setInputFiles('#videoInput', clip);
  const uploaded = await response, body = await uploaded.json(); assert.equal(uploaded.status(), 200);
  await page.waitForFunction(() => !document.querySelector('#routeGo').disabled);
  assert.match(await page.locator('#routeCard').innerText(), /no inference was run/i);
  assert.match(await page.locator('#routeTitle').innerText(), /clip check unavailable/i);
  assert.equal(await page.locator('input[name=tier]:checked').inputValue(), tier);
  // The source is anamorphic: compare browser display dimensions with the original
  // decoded preview, not ffprobe's coded raster dimensions (SAR is not 1:1).
  body.displayWidth = await page.locator('#previewCanvas').getAttribute('width');
  body.displayHeight = await page.locator('#previewCanvas').getAttribute('height');
  return body;
}
try {
  browser = await chromium.launch({ headless: true, executablePath });
  app = await startReviewApp(); report.fixtures.push(app.dataDir);
  const { body: me } = await app.request('/api/me');
  assert.equal(me.live, true, 'Actual local live capability is absent; do not fake it for this test.');
  for (const tier of ['lite', 'basic', 'advanced']) await check('Main ' + tier + ' hands the existing upload to real preparation', async () => {
    await fresh(); const up = await uploadMain(tier);
    const before = app.requests.filter(r => r.path === '/api/upload' && r.method === 'POST').length;
    await page.click('#routeGo'); await page.waitForURL('**/live.html?**');
    const url = new URL(page.url()); assert.equal(url.searchParams.get('tier'), tier); assert.equal(url.searchParams.get('upload'), up.uploadId);
    await page.waitForFunction(() => !document.querySelector('#useFrame').disabled, null, { timeout: 90000 });
    assert.match(await page.locator('#headline').innerText(), /choose a start frame/i);
    assert.equal(await page.locator('#fail').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#preview').readyState >= 2);
    assert.equal(await page.locator('#preview').evaluate(v => v.videoWidth), Number(up.displayWidth));
    assert.equal(await page.locator('#preview').evaluate(v => v.videoHeight), Number(up.displayHeight));
    assert.equal(app.requests.filter(r => r.path === '/api/upload' && r.method === 'POST').length, before, 'Handoff uploaded twice.');
    await page.locator('#time').focus(); await page.keyboard.press('ArrowRight');
    assert.match(await page.locator('#timeOut').innerText(), /frame 1/);
    await page.screenshot({ path: path.join(dir, `handoff-${tier}.png`) });
  });
  await check('Invalid live upload has a truthful recoverable clip error', async () => {
    await fresh(); await page.goto(app.origin + '/live.html?tier=lite&upload=missing-owned-test-upload');
    await page.waitForSelector('#fail:not([hidden])');
    assert.equal(await page.locator('#useFrame').isDisabled(), true);
    assert.match(await page.locator('#uploadNote').innerText(), /clip not ready/i);
    assert.equal(await page.locator('#file').count() || await page.locator('input[type=file]').count(), 1);
    await page.screenshot({ path: path.join(dir, 'invalid-upload.png') });
  });
  await check('Cached licensed My builds result plays, scrubs, turns and returns', async () => {
    const saved = await app.seedCachedExample(); report.cachedSourceIds = saved.atlas.poses; report.cachedTimestamps = saved.atlas.timestamps;
    await fresh(); await page.goto(app.origin + '/'); await page.click('#myBuildsCta');
    const open = page.locator(`[data-job-id="${saved.id}"]`).getByRole('button', { name: 'Open', exact: true });
    await open.click(); const frame = page.frameLocator('#viewerFrame');
    await frame.locator('#playBtn').waitFor({ state: 'visible' });
    await page.frames().find(f => f.url().includes('/view-lite.html')).waitForFunction(() => /7\/7/.test(document.querySelector('#poseTick')?.textContent));
    assert.match(await frame.locator('#poseTick').innerText(), /7\/7/);
    await frame.locator('#playBtn').click(); await page.waitForTimeout(900);
    const first = await frame.locator('#timeSlider').inputValue(); await page.waitForTimeout(600);
    assert.notEqual(await frame.locator('#timeSlider').inputValue(), first);
    await frame.locator('#playBtn').click(); await frame.locator('#timeSlider').focus(); await page.keyboard.press('Home');
    assert.match(await frame.locator('#poseTick').innerText(), /pose 1\/7.*2.5s/i);
    const canvas = frame.locator('#stage canvas'); const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .55, { steps: 15 }); await page.mouse.up();
    await page.screenshot({ path: path.join(dir, 'saved-playback.png') });
    await page.click('#viewerClose'); await page.locator('#viewer').waitFor({ state: 'hidden' });
    assert.equal(await open.evaluate(b => b === document.activeElement), true);
    assert.equal(await page.locator('#stepUpload.library-view').isVisible(), true);
  });
  await check('Live comparison and sampling surfaces load without model work', async () => {
    await fresh(390); await page.goto(app.origin + '/live.html?tier=lite');
    await page.getByRole('link', { name: 'Compare tiers' }).click(); await page.waitForURL('**/compare.html');
    assert.match(await page.title(), /tier|compare/i);
    await page.goto(app.origin + '/lite3.html'); await page.waitForSelector('#stopAll');
    assert.match(await page.title(), /lite/i); await page.screenshot({ path: path.join(dir, 'mobile-sampling.png') });
  });
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM spend').get().n, 0);
  report.liveBoundaries = app.boundaries; assert(app.boundaries.every(r => r.path === '/api/route'));
  await context.close(); context = null; await app.stop(); app = null;
  app = await startReviewApp({ live: false }); report.fixtures.push(app.dataDir);
  await check('Main legacy path keeps the selected tier and opens the frame picker', async () => {
    await fresh(); await uploadMain('basic'); await page.click('#routeGo');
    await page.waitForSelector('#stepFrame:not(.is-hidden)'); assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.locator('input[name=tier]:checked').inputValue(), 'basic');
    assert.equal(await page.locator('#findObjects').isEnabled(), true); assert.equal(await page.locator('#generateButton').isEnabled(), false);
    await page.screenshot({ path: path.join(dir, 'legacy-picker.png') });
  });
  report.legacyBoundaries = app.boundaries;
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM spend').get().n, 0); app.net.assertClean();
} catch (e) { report.failures.push({ name: 'Harness', error: e.message }); }
finally {
  if (context) await context.close(); if (browser) await browser.close(); if (app) await app.stop(); restoreFetch();
  if (report.pageErrors.length || report.outside.length) report.failures.push({ name: 'Page/network guards', error: JSON.stringify({ pageErrors: report.pageErrors, outside: report.outside }) });
  await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dir, checks: report.checks.length, failures: report.failures, pageErrors: report.pageErrors, outside: report.outside }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
