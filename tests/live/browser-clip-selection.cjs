// Real live.html entrypoint across all tiers; synthetic clips and intercepted APIs only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('../../backend/node_modules/sharp');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
const ROOT = path.resolve(__dirname, '../..'), BASE = 'http://live-clip.test';
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-clip-selection-'));
  for (const [name, color, size] of [['A', 'red', '160x90'], ['B', 'blue', '320x180']]) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=0.3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, name + '.mp4')]);
  const red = await sharp({ create: { width: 160, height: 90, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const mask = await sharp({ create: { width: 160, height: 90, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer();
  const cloudMeta = { fovY: 50, aspect: 16 / 9, motion: 'motion.json', bg: { pos: 'bg-pos.bin', rgb: 'bg-rgb.bin' }, trail: { pos: 'trail-pos.bin', rgb: 'trail-rgb.bin', ghosts: [] } };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'), args: ['--ignore-gpu-blocklist'] });
  const videoDir = process.env.RECORD_DIR;
  if (videoDir) fs.mkdirSync(videoDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } } : {}) });
  await context.addInitScript(() => {
    window.__sources = {}; window.__sourceList = []; window.__metrics = [];
    window.EventSource = class {
      constructor(url) { this.readyState = 1; this.listeners = {}; window.__sources[url] = this; window.__sourceList.push(this); }
      addEventListener(type, handler) { this.listeners[type] = handler; }
      close() { this.readyState = 2; }
    };
  });
  const page = await context.newPage(), errors = [], failures = [], results = [];
  page.on('pageerror', e => errors.push(e.message));
  let scenario, held, captureHold, prepared, detected, uploaded, built, cancelled;
  const info = id => ({ width: id === 'A.mp4' ? 160 : 320, height: id === 'A.mp4' ? 90 : 180, fps: 25, duration: .3, supported: scenario !== 'unsupported', reason: 'Unsupported fixture', camera: { fixed: true, shift: 0 }, previewUrl: `/preview/${id === 'A.mp4' ? 'A' : 'B'}.mp4` });
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
    if (p === '/api/live/detect') {
      const request = route.request().postDataJSON(); detected.push(request);
      if (scenario === 'late-detect') { held = route; captureHold(); return; }
      return route.fulfill({ json: { runId: 'r0000000001' } });
    }
    if (p === '/api/live/detect-more') return route.fulfill({ json: { runId: 'r0000000003' } });
    if (p === '/api/live/build') { const request = route.request().postDataJSON(); built.push(request); return route.fulfill({ json: { runId: 'r0000000002', tier: request.tier } }); }
    if (p === '/api/live/cancel-all') {
      cancelled.push(route.request().postDataJSON());
      if (scenario === 'late-stop' || scenario === 'late-stop-error') { held = route; captureHold(); return; }
      return route.fulfill({ json: { stopped: 2 } });
    }
    if (['/held-mask.png', '/held-cut.png', '/held-heat.png'].includes(p)) { held = route; captureHold(); return; }
    if (p === '/red.png' || p === '/mask.png') return route.fulfill({ contentType: 'image/png', body: p === '/red.png' ? red : mask });
    if (p === '/cloud/meta.json') {
      if (scenario === 'late-cloud') { held = route; captureHold(); return; }
      return route.fulfill({ json: cloudMeta });
    }
    if (p === '/cloud/motion.json') return route.fulfill({ json: { tracks: [] } });
    if (p.startsWith('/cloud/') && p.endsWith('.bin')) return route.fulfill({ body: p.includes('pos') ? Buffer.from(new Float32Array([0, 0, -1, 1, 0, -2]).buffer) : Buffer.from([255, 0, 0, 0, 0, 255]) });
    if (p === '/assets/clips/trailcam/grizzly.mp4') { held = route; captureHold(); return; }
    if (p.startsWith('/preview/')) {
      const data = fs.readFileSync(path.join(dir, path.basename(p))), range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/), start = range ? Number(range[1]) : 0, end = range && range[2] ? Number(range[2]) : data.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}) }, body: data.subarray(start, end + 1) });
    }
    if (p === '/live.js') {
      let source = fs.readFileSync(process.env.LIVE_SOURCE_PATH || path.join(ROOT, 'live.js'), 'utf8');
      source = source.replace('  renderer.setPixelRatio', `  const metric={disposes:0,renders:0};window.__metrics.push(metric);const release=renderer.dispose.bind(renderer),render=renderer.render.bind(renderer);renderer.dispose=()=>{metric.disposes++;return release();};renderer.render=(...args)=>{metric.renders++;return render(...args);};\n  renderer.setPixelRatio`);
      return route.fulfill({ contentType: 'text/javascript', body: source + '\nwindow.__liveState = state; window.__cloudView = () => cloud;\n' });
    }
    if (p.startsWith('/vendor/three/') || ['live.html', 'live.css', 'pick.css', 'favicon.svg', 'cloud-colors.mjs'].includes(p.slice(1)) || p.startsWith('/assets/fonts/')) {
      const file = path.join(ROOT, p); if (fs.existsSync(file)) return route.fulfill({ path: file });
    }
    return route.fulfill({ status: 404, body: 'No real API calls allowed' });
  });
  const select = async name => {
    if (await page.locator('#card-upload').evaluate(el => el.classList.contains('collapsed'))) await page.click('#card-upload h2');
    await page.locator('#file').setInputFiles({ name, mimeType: 'video/mp4', buffer: Buffer.from('intercepted upload fixture') });
  };
  const ready = (width = 320) => page.waitForFunction(width => window.__liveState.info?.width === width && document.querySelector('#preview').readyState >= 2, width);
  const emit = (id, event) => page.evaluate(({ id, event }) => window.__sources[`/api/live/${id}/events`].onmessage({ data: JSON.stringify(event) }), { id, event });
  const openDetection = async () => {
    await Promise.all([page.waitForRequest(r => r.url().endsWith('/api/live/detect')), page.click('#useFrame')]);
    await page.waitForFunction(() => !!window.__sources['/api/live/r0000000001/events']);
  };
  const seed = async () => {
    const width = await page.evaluate(() => window.__liveState.info.width);
    await emit('r0000000001', { type: 'frame', url: '/red.png', width, height: width * 9 / 16 });
    await emit('r0000000001', { type: 'objects', width, height: width * 9 / 16, indexUrl: '/mask.png', objects: [{ id: 1, label: 'fixture', suggested: true, box: { left: 0, top: 0, right: 1, bottom: 1 } }] });
    await page.waitForFunction(() => !document.querySelector('#build').disabled);
  };
  const startBuild = async () => {
    await seed();
    await Promise.all([page.waitForRequest(r => r.url().endsWith('/api/live/build')), page.click('#build')]);
    await page.waitForFunction(() => !!window.__sources['/api/live/r0000000002/events']);
  };
  const banner = async tier => {
    await page.addStyleTag({ content: 'body{padding-top:40px}.top{top:40px}.qa-banner{position:fixed;top:0;left:0;right:0;z-index:10000;padding:10px 24px;background:#19364b;color:white;font:16px Arial}' });
    await page.evaluate(name => { const p = document.createElement('div'); p.className = 'qa-banner'; p.textContent = 'LIVE CLIP CHECK · Synthetic clips · No inference · ' + name; document.body.prepend(p); }, tier + ' / ' + scenario);
  };
  const fresh = async tier => {
    prepared = []; detected = []; uploaded = []; built = []; cancelled = [];
    await page.goto(BASE + '/live.html?tier=' + tier + '&upload=A.mp4'); await banner(tier); await ready(160); await openDetection();
  };
  const blue = () => page.evaluate(() => { const video = document.querySelector('#preview'), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const g = canvas.getContext('2d'); g.drawImage(video, 0, 0, 1, 1); const p = g.getImageData(0, 0, 1, 1).data; return p[2] > 180 && p[0] < 80; });
  try {
    for (const tier of ['lite', 'basic', 'advanced']) {
      for (scenario of ['upload-late', 'prepare-late', 'upload-error', 'prepare-error', 'disable-pending', 'latest-error', 'grizzly-late']) {
        held = null; prepared = []; detected = []; uploaded = []; built = []; cancelled = [];
        const waitHeld = new Promise(ok => { captureHold = ok; }), initial = ['disable-pending', 'latest-error'].includes(scenario);
        await page.goto(BASE + '/live.html?tier=' + tier + (initial ? '&upload=initial.mp4' : ''));
        await banner(tier);
        if (initial) await ready();
        if (scenario === 'grizzly-late') await page.click('#useGrizzly'); else await select('A.mp4');
        await waitHeld;
        let disabledPending = null;
        if (initial) disabledPending = await page.locator('#useFrame').isDisabled();
        else { await select('B.mp4'); await ready(); }
        if (scenario === 'grizzly-late') await held.fulfill({ contentType: 'video/mp4', body: fs.readFileSync(path.join(dir, 'A.mp4')) });
        else if (scenario.endsWith('error')) await held.fulfill({ status: 500, json: { error: 'Old clip failed' } });
        else await held.fulfill({ json: scenario === 'prepare-late' ? info('A.mp4') : { uploadId: 'A.mp4' } });
        await page.waitForLoadState('networkidle');
        // A released upload can settle before its follow-up prepare begins.
        // Wait for actual clip readiness; network idleness is not that contract.
        if (scenario === 'disable-pending') await ready(160);
        const snapshot = await page.evaluate(() => ({ id: window.__liveState.uploadId, width: window.__liveState.info?.width, error: !document.querySelector('#fail').hidden, disabled: document.querySelector('#useFrame').disabled }));
        const label = tier + '/' + scenario;
        if (initial && !disabledPending) failures.push(label + ': Use frame enabled while new clip pending');
        if (scenario === 'latest-error') {
          if (!snapshot.disabled || snapshot.id) failures.push(label + ': latest failure leaves previous clip buildable');
          if (!snapshot.error) failures.push(label + ': latest failure not reported');
        } else {
          const expected = scenario === 'disable-pending' ? 'A.mp4' : 'B.mp4';
          if (snapshot.id !== expected) failures.push(label + ': wrong upload ID ' + snapshot.id);
          if (!initial && (snapshot.width !== 320 || !(await blue()))) failures.push(label + ': wrong clip metadata or preview');
          if (snapshot.error) failures.push(label + ': stale failure replaced current success');
          await Promise.all([page.waitForRequest(r => r.url().endsWith('/api/live/detect')), page.click('#useFrame')]);
          await page.waitForLoadState('networkidle');
          if (detected.at(-1)?.uploadId !== expected) failures.push(label + ': detection request used wrong upload');
        }
        results.push({ tier, scenario, disabledPending, ...snapshot, prepared: [...prepared], detected: [...detected] });
      }
      scenario = 'unsupported'; prepared = []; detected = []; uploaded = [];
      await page.goto(BASE + '/live.html?tier=' + tier + '&upload=unsupported.mp4'); await banner(tier); await page.waitForLoadState('networkidle');
      const visible = await page.locator('#card-frame').isVisible();
      if (visible !== (tier === 'lite')) failures.push(tier + '/unsupported: existing tier-specific camera rule changed');
      results.push({ tier, scenario, frameVisible: visible });
    }
    if (process.env.SELECTION_ONLY !== '1') {
    for (const tier of ['lite', 'basic', 'advanced']) {
      for (scenario of ['late-detect', 'late-mask', 'late-mask-error', 'late-more', 'late-more-error', 'late-cut', 'late-cut-error', 'late-heat', 'late-heat-error']) {
        held = null; const waitHeld = new Promise(ok => { captureHold = ok; });
        if (scenario === 'late-detect') {
          prepared = []; detected = []; uploaded = []; built = []; cancelled = [];
          await page.goto(BASE + '/live.html?tier=' + tier + '&upload=A.mp4'); await banner(tier); await ready(160);
          await page.click('#useFrame');
        } else {
          await fresh(tier);
          if (scenario.startsWith('late-mask')) {
            await emit('r0000000001', { type: 'frame', url: '/red.png', width: 160, height: 90 });
            await emit('r0000000001', { type: 'objects', width: 160, height: 90, indexUrl: '/held-mask.png', objects: [{ id: 1, label: 'old subject', suggested: true, box: { left: 0, top: 0, right: 1, bottom: 1 } }] });
          } else if (scenario.startsWith('late-more')) {
            await seed(); await page.locator('.pick-add input').fill('second subject'); await page.locator('.pick-add button').click();
            await page.waitForFunction(() => !!window.__sources['/api/live/r0000000003/events']);
            await emit('r0000000003', { type: 'objects', width: 160, height: 90, indexUrl: '/held-mask.png', objects: [{ id: 2, label: 'old addition', box: { left: 0, top: 0, right: 1, bottom: 1 } }] });
          } else if (scenario.startsWith('late-cut')) {
            await startBuild();
            await emit('r0000000002', { type: 'track-start', width: 160, height: 90, fps: 25, samples: 8, frameBase: '/frame/', frameUrl: '/red.png' });
            await emit('r0000000002', { type: 'cut', provisional: true, id: 1, sample: 1, box: [0, 0, 1, 1], url: '/held-cut.png' });
          } else {
            await seed(); await emit('r0000000001', { type: 'dino', dinov3: true, model: 'synthetic', groups: [], pca: '/held-heat.png', heat: {} });
            await page.click('#dinoView [data-v="pca"]');
          }
        }
        await waitHeld; await select('B.mp4'); await ready();
        if (scenario === 'late-detect') await held.fulfill({ json: { runId: 'r0000000001' } });
        else if (scenario.endsWith('-error')) await held.fulfill({ status: 500, body: 'Synthetic stale image failure' });
        else await held.fulfill({ contentType: 'image/png', body: scenario.startsWith('late-mask') || scenario.startsWith('late-more') ? mask : red });
        await page.waitForLoadState('networkidle');
        const snapshot = await page.evaluate(() => {
          const s = window.__liveState;
          const blank = id => { const c = document.querySelector(id); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.every((v, i) => i % 4 !== 3 || v === 0); };
          return { objects: s.objects.length, selected: s.selected.size, index: !!s.idx, moreBusy: !!s.moreBusy, buildDisabled: document.querySelector('#build').disabled, pickHidden: document.querySelector('#card-pick').hidden, sourceCount: window.__sourceList.length, trackBlank: blank('#trackLive'), heatBlank: blank('#pickHeat') };
        });
        const label = tier + '/' + scenario;
        if (snapshot.objects || snapshot.selected || snapshot.index || !snapshot.buildDisabled || snapshot.moreBusy) failures.push(label + ': stale subject/selection state survived');
        if (scenario === 'late-detect' && (!snapshot.pickHidden || snapshot.sourceCount)) failures.push(label + ': stale detection reopened the picker');
        if (scenario.startsWith('late-cut') && !snapshot.trackBlank) failures.push(label + ': old cut repainted new clip');
        if (scenario.startsWith('late-heat') && !snapshot.heatBlank) failures.push(label + ': old heatmap repainted new clip');
        results.push({ tier, scenario, ...snapshot });
      }
      scenario = 'stop-sources'; await fresh(tier); await startBuild();
      await page.click('#stopAll'); await page.waitForLoadState('networkidle');
      const stop = await page.evaluate(() => ({ allClosed: window.__sourceList.every(s => s.readyState === 2), id: window.__liveState.uploadId, frameEnabled: !document.querySelector('#useFrame').disabled }));
      if (!stop.allClosed || stop.id !== 'A.mp4' || !stop.frameEnabled || cancelled.length !== 1 || Object.keys(cancelled[0]).length) failures.push(tier + '/stop-sources: owner Stop contract changed');
      results.push({ tier, scenario, ...stop });
      for (scenario of ['late-stop', 'late-stop-error']) {
        held = null; const waitStop = new Promise(ok => { captureHold = ok; });
        await fresh(tier); await startBuild(); await page.click('#stopAll'); await waitStop;
        await select('B.mp4'); await ready(); await openDetection();
        if (scenario.endsWith('error')) await held.fulfill({ status: 500, json: { error: 'Old stop failed' } });
        else await held.fulfill({ json: { stopped: 2 } });
        await page.waitForLoadState('networkidle');
        const lateStop = await page.evaluate(() => ({ id: window.__liveState.uploadId, sourceOpen: window.__sources['/api/live/r0000000001/events'].readyState === 1, error: !document.querySelector('#fail').hidden, headline: document.querySelector('#headline').textContent }));
        if (lateStop.id !== 'B.mp4' || !lateStop.sourceOpen || lateStop.error || lateStop.headline.startsWith('Stopped')) failures.push(tier + '/' + scenario + ': stale Stop response changed the new clip');
        results.push({ tier, scenario, ...lateStop });
      }
    }
    for (const tier of ['basic', 'advanced']) {
      scenario = 'late-cloud'; held = null; const waitHeld = new Promise(ok => { captureHold = ok; });
      await fresh(tier); await startBuild();
      await emit('r0000000002', { type: 'stage', id: 'cloud', label: 'Synthetic cloud' });
      await emit('r0000000002', { type: 'cloud', json: '/cloud/meta.json' });
      await waitHeld; await select('B.mp4'); await ready(); await held.fulfill({ json: cloudMeta }); await page.waitForLoadState('networkidle');
      const staleCloud = await page.evaluate(() => !!window.__cloudView());
      if (staleCloud) failures.push(tier + '/late-cloud: old data created a new cloud');
      results.push({ tier, scenario, staleCloud });
      scenario = 'cloud-disposal'; await fresh(tier); await startBuild();
      await emit('r0000000002', { type: 'stage', id: 'cloud', label: 'Synthetic cloud' }); await emit('r0000000002', { type: 'cloud', json: '/cloud/meta.json' });
      await page.waitForFunction(() => !!window.__cloudView()); await select('B.mp4'); await ready();
      const disposed = await page.evaluate(() => ({ cloud: !!window.__cloudView(), disposes: window.__metrics[0].disposes }));
      if (disposed.cloud || disposed.disposes !== 1) failures.push(tier + '/cloud-disposal: old renderer was not released');
      await openDetection(); await startBuild(); await emit('r0000000002', { type: 'stage', id: 'cloud', label: 'Synthetic cloud' }); await emit('r0000000002', { type: 'cloud', json: '/cloud/meta.json' });
      await page.waitForFunction(() => !!window.__cloudView());
      if (await page.evaluate(() => window.__metrics.length) !== 2) failures.push(tier + '/cloud-disposal: new clip could not create its own cloud');
      results.push({ tier, scenario, ...disposed });
    }
    }
    if (videoDir) await page.screenshot({ path: path.join(videoDir, 'final-cloud.png') });
    console.log(JSON.stringify({ passed: !failures.length && !errors.length, scenarios: results.length, results, failures, errors }, null, 2));
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
  } finally { const video = page.video(); await context.close(); if (video) fs.renameSync(await video.path(), path.join(videoDir, 'live-clip-selection.webm')); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
