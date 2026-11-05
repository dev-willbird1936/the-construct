// Real browser + synthetic clips; all API requests are intercepted. No inference or uploads leave this process.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('../../backend/node_modules/sharp');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
const ROOT = path.resolve(__dirname, '../..'), BASE = 'http://clip.test';
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-clip-selection-'));
  for (const [name, color, size] of [['A', 'red', '160x90'], ['B', 'blue', '320x180']]) {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=0.3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, name + '.mp4')]);
  }
  const redFrame = await sharp({ create: { width: 160, height: 90, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const indexMask = await sharp({ create: { width: 160, height: 90, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'), args: ['--ignore-gpu-blocklist'] });
  const videoDir = process.env.RECORD_DIR;
  if (videoDir) fs.mkdirSync(videoDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } } : {}) });
  await context.addInitScript(() => { window.__sources = {}; window.EventSource = class { constructor(url) { window.__sources[url] = this; } addEventListener() {} close() {} }; });
  const page = await context.newPage(), errors = [], failures = [], results = [];
  page.on('pageerror', e => errors.push(e.message));
  let scenario, held, captureHold, uploaded, prepared, detected;
  const info = id => ({ width: id === 'A.mp4' ? 160 : 320, height: id === 'A.mp4' ? 90 : 180, fps: 25, duration: .3, previewUrl: `/preview/${id === 'A.mp4' ? 'A' : 'B'}.mp4` });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()), p = url.pathname;
    if (url.origin !== BASE) return route.abort();
    if (p === '/api/upload') {
      const name = route.request().postDataBuffer().toString().match(/filename="([^"]+)"/)?.[1]; uploaded.push(name);
      if (name === 'A.mp4' && ['upload-late', 'upload-error', 'disable-pending', 'latest-error'].includes(scenario)) { held = route; captureHold(); return; }
      return route.fulfill({ json: { uploadId: name } });
    }
    if (p === '/api/live/prepare') {
      const { uploadId } = route.request().postDataJSON(); prepared.push(uploadId);
      if (uploadId === 'A.mp4' && ['prepare-late', 'prepare-error'].includes(scenario)) { held = route; captureHold(); return; }
      return route.fulfill({ json: info(uploadId) });
    }
    if (p === '/api/live/detect') { detected.push(route.request().postDataJSON().uploadId); return route.fulfill({ json: { runId: 'r0000000001' } }); }
    if (p === '/api/live/build') return route.fulfill({ status: 500, json: { error: 'Intentional build refusal; no model called' } });
    if (p === '/frame.png') return route.fulfill({ contentType: 'image/png', body: redFrame });
    if (p === '/mask.png') { held = route; captureHold(); return; }
    if (p === '/assets/clips/trailcam/moose-pond.mp4') { held = route; captureHold(); return; }
    if (p.startsWith('/preview/')) {
      const bytes = fs.readFileSync(path.join(dir, path.basename(p)));
      const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/), start = range ? Number(range[1]) : 0, end = range && range[2] ? Number(range[2]) : bytes.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }, body: bytes.subarray(start, end + 1) });
    }
    if (p === '/lite3.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'lite3.js'), 'utf8') + '\nwindow.__selectionState = state;\n' });
    if (p.startsWith('/vendor/three/') || ['.js', '.css', '.html', '.woff2'].some(ext => p.endsWith(ext)) && !p.includes('..')) {
      const file = path.join(ROOT, p);
      if (fs.existsSync(file)) return route.fulfill({ path: file });
    }
    return route.fulfill({ status: 404, body: 'Fixture route only' });
  });
  const select = name => page.locator('#file').setInputFiles({ name, mimeType: 'video/mp4', buffer: Buffer.from('intercepted upload fixture') });
  const bluePreview = () => page.evaluate(() => [...document.querySelectorAll('.l3col .live')].every(c => {
    const p = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return p[2] > 180 && p[0] < 80;
  }));
  const banner = async name => {
    await page.addStyleTag({ content: 'body{padding-top:44px}.top{top:44px}.qa-banner{position:fixed;top:0;left:0;right:0;z-index:10000;padding:12px 24px;background:#19364b;color:white;font:17px Arial}' });
    await page.evaluate(name => { const p = document.createElement('div'); p.className = 'qa-banner'; p.textContent = 'CLIP SELECTION CHECK · Synthetic red/blue clips · No inference · ' + name; document.body.prepend(p); }, name);
  };
  try {
    for (scenario of ['upload-late', 'prepare-late', 'upload-error', 'prepare-error', 'disable-pending', 'latest-error', 'moose-late']) {
      held = null; uploaded = []; prepared = []; detected = [];
      const waitHeld = new Promise(ok => { captureHold = ok; });
      const initial = ['disable-pending', 'latest-error'].includes(scenario);
      await page.goto(BASE + '/lite3.html' + (initial ? '?upload=initial.mp4' : ''));
      await banner(scenario);
      if (initial) await page.waitForFunction(() => !document.querySelector('#run').disabled);
      if (scenario === 'moose-late') await page.click('#moose'); else await select('A.mp4');
      await waitHeld;
      let disabledWhilePending = null;
      if (initial) disabledWhilePending = await page.locator('#run').isDisabled();
      else {
        await select('B.mp4');
        await page.waitForFunction(() => document.querySelector('#uploadNote').textContent.startsWith('320×180') && !document.querySelector('#run').disabled);
        await page.waitForFunction(() => [...document.querySelectorAll('.l3col')].every(c => c.dataset.preview === 'frame'));
      }
      if (scenario === 'moose-late') await held.fulfill({ contentType: 'video/mp4', body: fs.readFileSync(path.join(dir, 'A.mp4')) });
      else if (scenario.endsWith('error')) await held.fulfill({ status: 500, json: { error: 'Old clip failed' } });
      else await held.fulfill({ json: scenario === 'prepare-late' ? info('A.mp4') : { uploadId: 'A.mp4' } });
      await page.waitForLoadState('networkidle');
      const metadata = await page.locator('#uploadNote').textContent(), errorVisible = await page.locator('#fail').isVisible(), runDisabled = await page.locator('#run').isDisabled();
      const expectedId = scenario === 'disable-pending' ? 'A.mp4' : 'B.mp4';
      if (initial && !disabledWhilePending) failures.push(scenario + ': Run remained enabled during new upload');
      if (scenario === 'latest-error') {
        if (!runDisabled) failures.push(scenario + ': failed new selection can still build previous clip');
        if (!errorVisible) failures.push(scenario + ': latest failure is hidden');
      } else {
        if (!initial && metadata !== '320×180 · 25.0 fps · 0.3 s') failures.push(scenario + ': stale metadata won: ' + metadata);
        if (!initial && errorVisible) failures.push(scenario + ': stale error replaced current success');
        if (!initial && !(await bluePreview())) failures.push(scenario + ': stale preview replaced the blue clip');
        await Promise.all([page.waitForRequest(r => r.url().endsWith('/api/live/detect')), page.click('#run')]);
        await page.waitForLoadState('networkidle');
        if (detected.at(-1) !== expectedId) failures.push(scenario + ': detect used ' + detected.at(-1) + ', expected ' + expectedId);
      }
      results.push({ scenario, metadata, disabledWhilePending, runDisabled, errorVisible, uploaded: [...uploaded], prepared: [...prepared], detected: [...detected] });
    }
    scenario = 'late-subject'; held = null; uploaded = []; prepared = []; detected = [];
    const waitMask = new Promise(ok => { captureHold = ok; });
    await page.goto(BASE + '/lite3.html?upload=A.mp4'); await banner(scenario);
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
    await page.click('#run');
    await page.waitForFunction(() => !!window.__sources['/api/live/r0000000001/events']);
    await page.evaluate(() => {
      const emit = e => window.__sources['/api/live/r0000000001/events'].onmessage({ data: JSON.stringify(e) });
      emit({ type: 'frame', url: '/frame.png', width: 160, height: 90 });
      emit({ type: 'objects', objects: [{ id: 1, label: 'fixture', box: { left: 0, top: 0, right: 1, bottom: 1 } }], indexUrl: '/mask.png', width: 160, height: 90 });
    });
    await waitMask;
    await page.waitForFunction(() => !document.querySelector('#file').disabled);
    await select('B.mp4');
    await page.waitForFunction(() => window.__selectionState.preview?.width === 320 && !document.querySelector('#run').disabled);
    await held.fulfill({ contentType: 'image/png', body: indexMask });
    await page.waitForLoadState('networkidle');
    const previewWidth = await page.evaluate(() => window.__selectionState.preview?.width);
    if (previewWidth !== 320) failures.push('late-subject: old detector changed the next clip preview');
    await page.click('#run');
    if (!(await bluePreview())) failures.push('late-subject: next run started with old red subject');
    results.push({ scenario, previewWidth, uploaded: [...uploaded], prepared: [...prepared] });
    if (videoDir) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(videoDir, 'latest-clip.png') }); }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: failures.length === 0, results, failures, errors }, null, 2));
    assert.deepEqual(failures, []);
  } finally {
    const video = page.video(); await context.close();
    if (video) fs.renameSync(await video.path(), path.join(videoDir, 'clip-selection-check.webm'));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
