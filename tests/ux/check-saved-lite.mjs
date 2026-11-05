// Actual local API/DB/files. Synthetic observations; no model work, mail or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
process.env.META_API_KEY = 'contributor-test';
process.env.META_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.RESEND_API_KEY = 'disabled-test';
const nativeFetch = globalThis.fetch;
let origin;
globalThis.fetch = (url, options) => {
  if (new URL(String(url)).origin !== origin) throw new Error('No off-host requests allowed.');
  return nativeFetch(url, options);
};
const { createApp } = await import('../../backend/app/app.js');
const { installGate } = await import('../../backend/app/test-support/fake-gate.js');
const { api, headers, uploadClip, stubRunners } = await import('../app/support.js');
const { getRun, Run } = await import('../../backend/lib/live.js');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'saved-lite-'));
let app;
async function boot() {
  const handle = await createApp({ dataDir, gate: { installGate }, runners: stubRunners(), configOverrides: { liveAdvanced: false } });
  const server = await new Promise(resolve => { const s = handle.app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return { ...handle, async stop() { await new Promise(resolve => server.close(resolve)); handle.close(); } };
}
const report = { provenance: 'Owned synthetic data; API handle restarted on same files/DB with no RAM Run; not a GPU/production restart benchmark.', dataDir, checks: [], failures: [] };
const check = async (name, fn) => { try { await fn(); report.checks.push({ name, passed: true }); } catch (e) { report.checks.push({ name, passed: false }); report.failures.push({ name, error: e.message }); } };
try {
  app = await boot();
  const { json: up } = await uploadClip(origin, { user: 'alice' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kS9sAAAAASUVORK5CYII=', 'base64');
  const ids = { lite: 'a0000000-0000-4000-8000-000000000001', basic: 'a0000000-0000-4000-8000-000000000002', thin: 'a0000000-0000-4000-8000-000000000003', modern: 'a0000000-0000-4000-8000-000000000004' };
  const run = 'r1234567890', thinRun = 'r1234567891', pack = 'live-aabbccdd', thinPack = 'live-aabbccee';
  const prefix = `/api/live/${run}/files/`;
  const manifest = { width: 64, height: 40, fps: 6, samples: 12, frame: prefix + 'world/live/frames/f00001.jpg', heading: [], ghosts: [0, 5, 10].map(sample => ({ sample, track: 1, box: [.2, .2, .5, .8], url: prefix + `world/live/cuts/${sample}.png`, x: .35, y: .5, width: .3 })) };
  const dir = path.join(dataDir, 'uploads', up.uploadId, pack);
  await fs.mkdir(path.join(dir, 'world/live/cuts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'world/live/frames'), { recursive: true });
  await fs.writeFile(path.join(dir, 'lite.json'), JSON.stringify(manifest));
  for (const sample of [0, 5, 10]) await fs.writeFile(path.join(dir, `world/live/cuts/${sample}.png`), png);
  await fs.writeFile(path.join(dir, 'world/live/frames/f00001.jpg'), png);
  await fs.writeFile(path.join(dir, 'world/live/cloud.json'), JSON.stringify({ bg: {} }));
  const thinDir = path.join(dataDir, 'uploads', up.uploadId, thinPack);
  await fs.mkdir(thinDir, { recursive: true });
  const thin = { ...manifest, frame: manifest.frame.replace(run, thinRun), fps: undefined, samples: undefined, ghosts: manifest.ghosts.slice(0, 1).map(g => ({ ...g, url: g.url.replace(run, thinRun) })) };
  await fs.writeFile(path.join(thinDir, 'lite.json'), JSON.stringify(thin));
  const insert = (id, tier, result) => app.db.prepare('INSERT INTO jobs(id,user_id,upload_id,tier,object_ids,prompt,seed_time,title,subject,email,selection_snapshot,status,stage,detail,progress,sam_frames,result,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'alice', up.uploadId, tier, '[]', '', 0, 'Synthetic saved build', 'fixture', '', '', 'done', 'done', 'Ready.', 1, 0, JSON.stringify(result), null, Date.now(), Date.now());
  insert(ids.lite, 'lite', { id: ids.lite, tier: 'lite', viewer: `lite.html?run=${run}`, thumb: manifest.frame });
  insert(ids.basic, 'basic', { id: ids.basic, tier: 'basic', pack, viewer: `basic-cloud.html?job=${ids.basic}` });
  insert(ids.thin, 'lite', { id: ids.thin, tier: 'lite', viewer: `lite.html?run=${thinRun}`, thumb: thin.frame });
  insert(ids.modern, 'lite', { id: ids.modern, tier: 'lite', runId: run, pack, viewer: `lite.html?job=${ids.modern}`, thumb: `/api/live/lite/${ids.modern}/files/world/live/frames/f00001.jpg` });
  await app.stop(); app = null; app = await boot();
  await check('API restart has no RAM Run but Basic files remain readable', async () => {
    assert.equal(getRun(run), undefined);
    const r = await fetch(`${origin}/api/live/basic/${ids.basic}/files/cloud.json`, { headers: headers('alice') });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { bg: {} });
  });
  let saved;
  await check('Saved Lite link reopens its existing full manifest', async () => {
    const { json } = await api(origin, 'GET', '/api/me/jobs', { user: 'alice' });
    const job = json.jobs.find(j => j.id === ids.lite), viewer = new URL(job.result.viewer, origin);
    const url = viewer.searchParams.has('job') ? `/api/live/lite/${viewer.searchParams.get('job')}/files/lite.json` : `/api/live/${viewer.searchParams.get('run')}/files/lite.json`;
    const r = await fetch(origin + url, { headers: headers('alice') });
    assert.equal(r.status, 200, 'A finished saved Lite manifest was lost with RAM state.'); saved = await r.json();
    for (const k of ['fps', 'samples', 'width', 'height']) assert.equal(saved[k], manifest[k]);
    assert.deepEqual(saved.ghosts.map(({ url, ...g }) => g), manifest.ghosts.map(({ url, ...g }) => g));
    assert.deepEqual(saved.heading, manifest.heading);
  });
  await check('Saved textures keep their bytes and exact sample indices', async () => {
    assert(saved, 'Saved manifest did not load.'); assert.deepEqual(saved.ghosts.map(g => g.sample), [0, 5, 10]);
    for (const g of saved.ghosts) { const r = await fetch(origin + g.url, { headers: headers('alice') }); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), png); }
    assert.equal((await fetch(origin + saved.frame, { headers: headers('alice') })).status, 200);
  });
  await check('Saved job files remain owner-scoped', async () => {
    assert.equal((await fetch(`${origin}/api/live/lite/${ids.lite}/files/lite.json`, { headers: headers('bob') })).status, 404);
  });
  await check('Old run links resolve the stored result without rebuilding', async () => {
    const r = await fetch(`${origin}/api/live/saved/${run}`, { headers: headers('alice') });
    assert.equal(r.status, 200); const v = await r.json(); assert.equal(v.samples, 12); assert.deepEqual(v.ghosts.map(g => g.sample), [0, 5, 10]);
  });
  await check('Thin legacy manifests do not gain guessed clocks or poses', async () => {
    const r = await fetch(`${origin}/api/live/lite/${ids.thin}/files/lite.json`, { headers: headers('alice') });
    assert.equal(r.status, 200); const v = await r.json(); assert.equal(v.fps, undefined); assert.equal(v.samples, undefined); assert.equal(v.ghosts.length, 1); assert.equal(v.sourceRun, thinRun);
  });
  await check('Recorded pack references reopen directly and preserve the disk manifest', async () => {
    const r = await fetch(`${origin}/api/live/lite/${ids.modern}/files/lite.json`, { headers: headers('alice') });
    assert.equal(r.status, 200); const value = await r.json(); assert.equal(value.samples, 12);
    assert(value.ghosts.every(g => g.url.startsWith(`/api/live/lite/${ids.modern}/files/`)));
    assert.equal(await fs.readFile(path.join(dir, 'lite.json'), 'utf8'), JSON.stringify(manifest));
  });
  await check('Cached packs still check the current job and reject absent/non-image files', async () => {
    const base = `${origin}/api/live/lite/${ids.lite}/files/`;
    assert.equal((await fetch(base + 'world/live/cloud.json', { headers: headers('alice') })).status, 404);
    assert.equal((await fetch(base + 'world/live/cuts/99.png', { headers: headers('alice') })).status, 404);
    assert.equal((await fetch(`${origin}/api/live/saved/${run}`, { headers: headers('bob') })).status, 404);
    app.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(ids.lite);
    try { assert.equal((await fetch(base + 'world/live/cuts/0.png', { headers: headers('alice') })).status, 404); }
    finally { app.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(ids.lite); }
  });
  await check('Reopening does not book inference/spend', async () => assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM spend').get().n, 0));
  if (process.env.BROWSER_CHECK === '1' && saved) {
    // A separate still-available legacy history proves the old recovery path was retained.
    const historyDir = path.join(dataDir, 'uploads', up.uploadId, 'live-aabbccff');
    await fs.mkdir(path.join(historyDir, 'world/live/cuts'), { recursive: true });
    const history = new Run('build', up.uploadId, historyDir, { owner: 'alice' });
    const historyCuts = manifest.ghosts.map(g => ({ ...g, url: history.url(`world/live/cuts/${g.sample}.png`) }));
    await fs.writeFile(path.join(historyDir, 'lite.json'), JSON.stringify({ width: 64, height: 40, ghosts: historyCuts.slice(0, 1) }));
    for (const g of historyCuts) await fs.writeFile(path.join(historyDir, `world/live/cuts/${g.sample}.png`), png);
    history.emit({ type: 'track-start', width: 64, height: 40, fps: 6, samples: 12 });
    for (const g of historyCuts) history.emit({ type: 'cut', ...g, provisional: false });
    history.emit({ type: 'ghosts-done' }); history.finish('done', { type: 'done' });
    const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url);
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe') });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: headers('alice') });
    const page = await context.newPage(), errors = [], outside = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
    await check('Actual saved-job viewer plays the source-clock timeline', async () => {
      await page.goto(`${origin}/lite.html?job=${ids.lite}`); await page.waitForFunction(() => document.querySelector('.lite-play')?.disabled === false, null, { timeout: 8000 });
      assert.equal(await page.locator('.lite-scrub').getAttribute('max'), '11');
      await page.locator('.lite-play').click(); await page.waitForTimeout(350); await page.locator('.lite-play').click();
      assert(Number(await page.locator('.lite-scrub').inputValue()) > 0); assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    });
    await check('Actual old run link falls back to its stored full manifest', async () => {
      await page.goto(`${origin}/lite.html?run=${run}`); await page.waitForFunction(() => document.querySelector('.lite-play')?.disabled === false, null, { timeout: 8000 });
      assert.equal(await page.locator('.lite-scrub').getAttribute('max'), '11');
    });
    await check('Actual thin legacy result reports missing original history', async () => {
      await page.goto(`${origin}/lite.html?job=${ids.thin}`); await page.waitForFunction(() => /unavailable|no longer available/.test(document.querySelector('#status').textContent), null, { timeout: 8000 });
      assert.equal(await page.locator('.lite-play:not(:disabled)').count(), 0);
    });
    for (const shared of ['', '&shared=1']) await check('Original legacy history remains playable' + (shared ? ' in shared mode' : ''), async () => {
      await page.goto(`${origin}/lite.html?run=${history.id}${shared}`); await page.waitForFunction(() => document.querySelector('.lite-play')?.disabled === false, null, { timeout: 8000 });
      assert.equal(await page.locator('.lite-scrub').getAttribute('max'), '11');
    });
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    await context.close(); await browser.close();
  }
} finally {
  if (app) await app.stop(); globalThis.fetch = nativeFetch;
  // Keep this uniquely-created disposable fixture for inspection; do not recursively clean unknown paths.
  if (process.env.RESULT_PATH) await fs.writeFile(process.env.RESULT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (report.failures.length) process.exitCode = 1;
}
