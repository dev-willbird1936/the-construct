// Local review support: real app/DB/files + explicit test identity. Never production auth.
// Real upload/probe/FFmpeg prepare allowed; all model/job/publication boundaries refused.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.META_API_KEY = 'contributor-test';
process.env.META_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.RESEND_API_KEY = 'disabled-test';
const require = createRequire(import.meta.url);
const { createNodeGuard, classifyRequest } = require('../web/net-guard.cjs');
const nativeFetch = globalThis.fetch;
const net = createNodeGuard();
globalThis.fetch = net.guardedFetch;
const { createApp } = await import('../../backend/app/app.js');
const { installGate } = await import('../../backend/app/test-support/fake-gate.js');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const clip = path.join(ROOT, 'assets/corpus/blackcat.mp4');
export const identity = { 'x-test-user': 'ux-local-review', 'x-test-email': 'local-review@example.test', 'x-test-role': 'user' };
export const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
export const executablePath = process.env.CHROMIUM_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe');

export async function startReviewApp({ live = true, shellHtml = null } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'construct-ux-journey-'));
  const boundaries = [], requests = [];
  const blocked = req => req.method !== 'GET' && req.method !== 'HEAD' && req.path.startsWith('/api/') && !['/api/upload', '/api/live/prepare'].includes(req.path);
  const gate = { installGate(app, opts) {
    installGate(app, opts);
    if (shellHtml) app.get('/__local_review__', (_req, res) => res.type('html').send(shellHtml));
    app.use((req, res, next) => {
      requests.push({ method: req.method, path: req.path });
      if (!blocked(req)) return next();
      boundaries.push({ method: req.method, path: req.path });
      res.status(503).json({ error: 'Local review: model calls and publishing are disabled. No inference was run.' });
    });
  } };
  const refuse = async () => { throw new Error('Review guard: model/runner boundary must not execute.'); };
  const handle = await createApp({ dataDir, gate, detectFn: refuse, boxDetectFn: refuse, sparkFn: refuse, cameraFn: refuse, runners: { lite: refuse, basic: refuse }, configOverrides: { liveAdvanced: live, nodeEnv: 'test', rateUploadPerMin: 30 } });
  const server = await new Promise(resolve => { const s = handle.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = net.allowOrigin('http://127.0.0.1:' + server.address().port);
  const request = async (url, options = {}) => {
    const response = await fetch(origin + url, { ...options, headers: { ...identity, ...options.headers } });
    return { response, body: await response.json() };
  };
  const browserGuard = async (context, outside) => context.route('**/*', route => {
    const href = route.request().url();
    if (classifyRequest(href, origin) !== 'allow') { outside.push(new URL(href).origin); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  return { ...handle, origin, dataDir, boundaries, requests, request, browserGuard, net,
    async seedCachedExample() {
      const form = new FormData();
      form.append('video', new Blob([await fs.readFile(clip)]), 'blackcat-licensed-cache-source.mp4');
      form.append('rights', '1');
      const { response, body: up } = await request('/api/upload', { method: 'POST', body: form });
      if (!response.ok) throw new Error('Could not ingest licensed cache source: ' + response.status);
      const id = crypto.randomUUID(), dir = path.join(dataDir, 'specimens', id);
      await fs.mkdir(dir, { recursive: true });
      const atlas = JSON.parse(await fs.readFile(path.join(ROOT, 'assets/gallery-seed/blackcat-atlas.json'), 'utf8'));
      // Exclude nine cells without source indices. Preserve every identified pose and timestamp verbatim.
      atlas.live = null;
      const result = { id, tier: 'lite', title: 'Cached example · Black cat · 7 observed poses', subject: 'black cat', viewer: `view-lite.html?id=${id}`, thumb: `/specimens/${id}/thumb.webp`, durationSec: up.duration, bytes: 0, meta: { provenance: ['cached observed cut-outs; no new inference'], source: 'https://commons.wikimedia.org/wiki/File:Black_Cat_walking.webm', licence: 'CC0', author: 'Dzkouslavia' } };
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(result));
      await fs.writeFile(path.join(dir, 'atlas.json'), JSON.stringify(atlas));
      await fs.copyFile(path.join(ROOT, 'assets/gallery-seed/blackcat-atlas.webp'), path.join(dir, 'atlas.webp'));
      await fs.copyFile(path.join(ROOT, 'assets/gallery-seed/blackcat-thumb.webp'), path.join(dir, 'thumb.webp'));
      const now = Date.now();
      handle.db.prepare("INSERT INTO jobs(id,user_id,upload_id,tier,title,subject,status,stage,detail,progress,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, identity['x-test-user'], up.uploadId, 'lite', result.title, result.subject, 'done', 'done', 'Existing licensed observations; no fresh inference.', 1, JSON.stringify(result), now, now);
      return { id, result, atlas, upload: up };
    },
    async stop() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      handle.close();
      // Keep this uniquely-created owned fixture for inspection. No recursive deletion.
    }
  };
}
export function restoreFetch() { globalThis.fetch = nativeFetch; }
