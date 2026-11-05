// Presentation-only experiment on existing licensed atlases. Local intercepted GETs; no inference.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
const ROOT = path.resolve(__dirname, '../..'), BASE = 'http://visual-methods.test', OUT = path.join(ROOT, '.planning/ux-hackathon/phase-03/runs', Date.now() + '-' + crypto.randomUUID().slice(0, 8));
(async () => {
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
  const sources = ['blackcat', 'muntjac'], modes = ['row', 'diagonal', 'sheet'], records = [], failures = [], errors = [], unexpected = [];
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const inputs = sources.map(source => { const file = path.join(ROOT, 'assets/gallery-seed/' + source + '-atlas'); return { source, jsonSha256: hash(file + '.json'), webpSha256: hash(file + '.webp'), bytes: fs.statSync(file + '.json').size + fs.statSync(file + '.webp').size, meta: JSON.parse(fs.readFileSync(file + '.json')) }; });
  const sourceFiles = ['tests/ux/visual-methods.html', 'tests/ux/visual-methods.js', 'tests/ux/benchmark-visual-methods.cjs', 'volume.js', 'stable-math.mjs', 'vendor/three/build/three.module.js'].map(file => ({ path: file, sha256: hash(path.join(ROOT, file)) }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe') });
  try {
    for (let trial = 0; trial < 3; trial++) for (const source of sources) for (const width of [390, 1440]) for (let k = 0; k < modes.length; k++) {
      const mode = modes[(k + trial) % modes.length], label = `${source}-${width}-${mode}-${trial}`;
      const context = await browser.newContext({ viewport: { width, height: width < 720 ? 844 : 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => {
        const request = route.request(), u = new URL(request.url()), p = u.pathname;
        if (u.origin !== BASE || request.method() !== 'GET') { unexpected.push(request.method() + ' ' + u.href); return route.abort(); }
        const relative = p.slice(1), file = ['visual-methods.html', 'visual-methods.js'].includes(relative) ? path.join(__dirname, relative) : path.join(ROOT, relative);
        if ((['visual-methods.html', 'visual-methods.js', 'volume.js', 'stable-math.mjs'].includes(relative) || relative.startsWith('vendor/three/') || /^assets\/gallery-seed\/(blackcat|muntjac)-atlas\.(json|webp)$/.test(relative)) && fs.existsSync(file)) return route.fulfill({ path: file, headers: { 'Cache-Control': 'no-store' } });
        unexpected.push(p); return route.abort();
      });
      const page = await context.newPage(); page.on('pageerror', e => errors.push({ label, error: e.message }));
      try {
        await page.goto(`${BASE}/visual-methods.html?source=${source}&mode=${mode}`);
        await page.waitForFunction(() => window.__metrics?.ready || window.__error, null, { timeout: 20000 });
        const result = await page.evaluate(() => ({ metrics: window.__metrics, error: window.__error }));
        if (result.error) throw Error(result.error);
        const input = inputs.find(i => i.source === source); assert.deepEqual(result.metrics.poseIds, input.meta.poses); assert.deepEqual(result.metrics.timestamps, input.meta.timestamps);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page has horizontal overflow.');
        records.push({ trial, label, assetBytes: input.bytes, ...result.metrics });
        if (trial === 0) await page.screenshot({ path: path.join(OUT, 'screenshots', label + '.png'), fullPage: true });
      } catch (e) { failures.push({ label, error: e.message }); }
      finally { await context.close(); }
    }
    for (const entry of sourceFiles) assert.equal(hash(path.join(ROOT, entry.path)), entry.sha256, 'Source changed during the run: ' + entry.path);
    for (const input of inputs) { const file = path.join(ROOT, 'assets/gallery-seed/' + input.source + '-atlas'); assert.equal(hash(file + '.json'), input.jsonSha256); assert.equal(hash(file + '.webp'), input.webpSha256); }
  } finally {
    const report = { provenance: 'Existing seven identified atlas poses per source; no new model output. Local intercepted asset requests disable HTTP cache; GPU shader/process caches may persist. Balanced trial order. Timings are viewer/decode/draw readiness, NOT network, inference or complete clip creation latency.', browser: browser.version(), sourceFiles, inputs, records, failures, pageErrors: errors, unexpectedRequests: unexpected };
    await browser.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(ROOT, '.planning/ux-hackathon/phase-03/latest.json'), JSON.stringify({ directory: OUT, results: path.join(OUT, 'results.json') }, null, 2));
    console.log(JSON.stringify({ directory: OUT, records: records.length, failures, pageErrors: errors, unexpectedRequests: unexpected }, null, 2));
    if (failures.length || errors.length || unexpected.length || records.length !== 36) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
