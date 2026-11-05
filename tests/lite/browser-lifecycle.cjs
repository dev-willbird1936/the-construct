// No services/inference: serve only public viewer modules and synthetic images in Playwright.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
const sharp = require('../../backend/node_modules/sharp');
const ROOT = path.resolve(__dirname, '../..'), BASE = 'http://lite.test';
const fixture = { width: 640, height: 360, fps: 20, samples: 6, ghosts: Array.from({ length: 6 }, (_, sample) => ({ sample, track: 1, box: [.1 + sample * .08, .2, .3 + sample * .08, .7], url: `/poses/${sample}.png` })) };
const html = script => `<!doctype html><html><head><script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.js"}}</script><style>#lite-view,.fixture{width:640px}.lite-canvas{width:640px}</style></head><body><p id="status">Loading</p><div id="lite-view"></div>${script ? `<script type="module" src="${script}"></script>` : ''}</body></html>`;
(async () => {
  const pngs = await Promise.all(fixture.ghosts.map((_, n) => sharp({ create: { width: 40, height: 60, channels: 4, background: { r: 30 + n * 35, g: 180, b: 100, alpha: 1 } } }).png().toBuffer()));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'), args: ['--ignore-gpu-blocklist'] });
  const context = await browser.newContext();
  const errors = [], checks = [];
  let manifestMode = 'missing';
  await context.addInitScript(() => {
    window.__metrics = []; window.__sources = []; window.__observers = [];
    const RO = ResizeObserver;
    window.ResizeObserver = class extends RO {
      constructor(fn) { super(fn); this.record = { disconnects: 0 }; window.__observers.push(this.record); }
      disconnect() { this.record.disconnects++; super.disconnect(); }
    };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this); await new Promise(ok => setTimeout(ok, 40));
      const failure = window.__failDecode;
      if (failure && this.src.endsWith(failure.url)) {
        if (failure.skip) failure.skip--;
        else { window.__failDecode = null; throw new Error('Synthetic one-time image failure'); }
      }
    };
    window.EventSource = class {
      constructor(url) { this.url = url; this.readyState = 1; this.listeners = {}; window.__sources.push(this); }
      close() { this.readyState = 2; }
      addEventListener(type, handler) { this.listeners[type] = handler; }
    };
  });
  await context.route('**/*', async route => {
    const u = new URL(route.request().url()), p = u.pathname;
    if (u.origin !== BASE) return route.abort();
    if (p === '/' || p === '/legacy') return route.fulfill({ contentType: 'text/html', body: html(p === '/legacy' ? '/lite.js' : '') });
    if (p.startsWith('/poses/')) return route.fulfill({ contentType: 'image/png', body: pngs[Number(path.basename(p, '.png'))] });
    if (p.endsWith('/files/lite.json')) {
      if (manifestMode === 'missing' || manifestMode === 'forbidden') return route.fulfill({ status: manifestMode === 'missing' ? 404 : 403, json: {} });
      if (manifestMode === 'invalid-json') return route.fulfill({ contentType: 'application/json', body: '{broken' });
      if (manifestMode === 'no-ghosts') return route.fulfill({ json: { ...fixture, ghosts: undefined } });
      if (manifestMode === 'invalid-clock') return route.fulfill({ json: { ...fixture, fps: 0, samples: 0 } });
      return route.fulfill({ json: fixture });
    }
    if (p.startsWith('/vendor/three/') || ['/lite-view.js', '/lite-solid.js', '/lite.js'].includes(p)) {
      let body = fs.readFileSync(path.join(ROOT, p), 'utf8');
      if (p === '/lite-view.js' || p === '/lite-solid.js') body = body.replace('  renderer.setPixelRatio', `  const metric = { renders: 0, disposes: 0 }; window.__metrics.push(metric);
  const render = renderer.render.bind(renderer), release = renderer.dispose.bind(renderer);
  renderer.render = (...args) => { metric.renders++; return render(...args); };
  renderer.dispose = () => { metric.disposes++; return release(); };
  renderer.setPixelRatio`);
      return route.fulfill({ contentType: 'text/javascript', body });
    }
    return route.fulfill({ status: 404, body: 'No real network calls in this test' });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(BASE);
    for (const module of ['lite-view.js', 'lite-solid.js']) {
      const result = await page.evaluate(async ({ module, fixture }) => {
        const { createLiteView } = await import('/' + module);
        const root = document.createElement('div'); root.className = 'fixture'; document.body.append(root);
        const view = await createLiteView(root, { ...fixture, ghosts: fixture.ghosts.filter(g => g.sample >= 2) });
        const pending = view.seek(2); await view.seek(0); await pending;
        const hidden = view.frameState();
        window.__failDecode = { url: '/poses/3.png' };
        let failed = false; try { await view.seek(3); } catch { failed = true; }
        await view.seek(3);
        const recovered = view.frameState();
        const metric = window.__metrics.at(-1), observer = window.__observers.at(-1);
        root.replaceChildren(); await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
        const afterDetach = { disposes: metric.disposes, disconnects: observer.disconnects, renders: metric.renders };
        await view.seek(4); view.dispose(); view.dispose();
        const afterDisposedSeek = { disposes: metric.disposes, renders: metric.renders };
        root.remove();
        return { hidden, failed, recovered, afterDetach, afterDisposedSeek };
      }, { module, fixture });
      assert.deepEqual(result.hidden, [], module + ': pending texture resurrected absent subject');
      assert.equal(result.failed, true); assert.equal(result.recovered[0].textureSample, 3);
      assert.equal(result.afterDetach.disposes, 1); assert.equal(result.afterDetach.disconnects, 1);
      assert.equal(result.afterDisposedSeek.disposes, 1); assert.equal(result.afterDisposedSeek.renders, result.afterDetach.renders);
      checks.push(module + ': absent subject, fail-once recovery, detached canvas, idempotent disposal, no drawing after disposal');
    }
    for (const mode of ['replace-loading', 'ghost-failure', 'head-failure', 'dispose-pending']) {
      const result = await page.evaluate(async ({ mode, fixture }) => {
        const { createLiteView } = await import('/lite-view.js');
        const root = document.createElement('div'); root.className = 'fixture'; document.body.append(root);
        if (mode === 'ghost-failure') window.__failDecode = { url: '/poses/0.png' };
        if (mode === 'head-failure') window.__failDecode = { url: '/poses/5.png', skip: 1 };
        let rejected = false, before = null, view;
        const pending = createLiteView(root, fixture);
        if (mode === 'replace-loading') root.replaceChildren();
        try { view = await pending; } catch { rejected = true; }
        const metric = window.__metrics.at(-1), observer = window.__observers.at(-1);
        if (view) {
          const seek = view.seek(2); view.dispose(); before = metric.renders;
          await seek; view.dispose();
        }
        await new Promise(ok => setTimeout(ok, 100));
        root.remove();
        return { rejected, disposes: metric.disposes, renders: metric.renders, before, disconnects: observer?.disconnects };
      }, { mode, fixture });
      assert.equal(result.rejected, mode !== 'dispose-pending', mode);
      assert.equal(result.disposes, 1, mode);
      if (mode === 'head-failure') assert.equal(result.disconnects, 1);
      if (mode === 'dispose-pending') assert.equal(result.renders, result.before);
      checks.push(mode + ': releases renderer and prevents late presentation');
    }
    for (const mode of ['missing', 'no-ghosts', 'invalid-json', 'invalid-clock', 'malformed-event', 'forbidden', 'valid']) {
      manifestMode = mode === 'malformed-event' ? 'missing' : mode;
      const legacy = await context.newPage(); legacy.on('pageerror', e => errors.push(e.message));
      await legacy.goto(BASE + '/legacy?run=r1234567890');
      if (mode === 'valid') {
        await legacy.waitForFunction(() => document.querySelector('#lite-view .lite-play')?.disabled === false && document.querySelector('#status').textContent === '');
        assert.equal(await legacy.evaluate(() => window.__sources.length), 0);
      } else if (mode === 'forbidden') {
        await legacy.waitForFunction(() => document.querySelector('#status').textContent === 'This result is unavailable.');
        assert.equal(await legacy.evaluate(() => window.__sources.length), 0);
      } else {
        await legacy.waitForFunction(() => window.__sources.length === 1);
        if (mode === 'malformed-event') {
          await legacy.evaluate(() => window.__sources[0].onmessage({ data: '{broken' }));
          assert.equal(await legacy.locator('#status').textContent(), "This result's history is invalid.");
          assert.equal(await legacy.evaluate(() => window.__sources[0].readyState), 2);
        } else {
          await legacy.evaluate(f => {
            const emit = e => window.__sources[0].onmessage({ data: JSON.stringify(e) });
            emit({ type: 'track-start', ...f }); for (const g of f.ghosts) emit({ type: 'cut', ...g }); emit({ type: 'ghosts-done' });
          }, fixture);
          await legacy.waitForFunction(() => !document.querySelector('#lite-view .lite-play')?.disabled && document.querySelector('#status').textContent === '');
          assert.equal(await legacy.locator('.lite-scrub').getAttribute('max'), '5');
        }
      }
      await legacy.close(); checks.push('legacy ' + mode);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks, errors, method: 'Synthetic image fixtures; 40 ms decode delay; no network/services/inference' }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
