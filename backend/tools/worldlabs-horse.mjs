// Video -> World Labs Marble world. Usage: node worldlabs-horse.mjs [operation_id]
// With an operation id it skips upload/generate (no credits spent) and only polls + downloads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'assets/clips/horse.mp4');
const OUT = path.join(ROOT, 'assets/worldlabs/horse');
const KEY = (process.env.WORLDLABS_API_KEY || '').trim();
const B = 'https://api.worldlabs.ai/marble/v1';
const H = { 'Content-Type': 'application/json', 'WLT-Api-Key': KEY };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const j = async r => { const t = await r.text(); if (!r.ok) throw new Error(r.status + ' ' + t.slice(0, 500)); return JSON.parse(t); };

fs.mkdirSync(OUT, { recursive: true });
let opId = process.argv[2];

if (!opId) {
  const prep = await j(await fetch(B + '/media-assets:prepare_upload', { method: 'POST', headers: H, body: JSON.stringify({ file_name: 'horse.mp4', extension: 'mp4', kind: 'video' }) }));
  const put = await fetch(prep.upload_info.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', ...prep.upload_info.required_headers }, body: fs.readFileSync(SRC) });
  if (!put.ok) throw new Error('upload ' + put.status);
  const gen = await j(await fetch(B + '/worlds:generate', { method: 'POST', headers: H, body: JSON.stringify({
    display_name: 'horse (3.5D-Visualizer)', model: 'marble-1.1',
    world_prompt: { type: 'video', video_prompt: { source: 'media_asset', media_asset_id: prep.media_asset.media_asset_id } } }) }));
  opId = gen.operation_id;
  fs.writeFileSync(path.join(OUT, 'operation-id.txt'), opId);
}
log('operation', opId);

let op;
do {
  op = await j(await fetch(B + '/operations/' + opId, { headers: H }));
  log(op.done ? 'DONE' : 'running', op.metadata?.progress?.description || '');
  if (!op.done) await new Promise(r => setTimeout(r, 10000));
} while (!op.done);

fs.writeFileSync(path.join(OUT, 'operation.json'), JSON.stringify(op, null, 2));
if (op.error) throw new Error('generation failed ' + JSON.stringify(op.error));

const a = op.response.assets;
log('marble url', op.response.world_marble_url);
log('caption', a.caption);
const dl = async (u, name) => {
  if (!u) return;
  const ext = new URL(u).pathname.split('.').pop();
  const f = path.join(OUT, name + '.' + ext);
  fs.writeFileSync(f, Buffer.from(await (await fetch(u)).arrayBuffer()));
  log('saved', path.basename(f), fs.statSync(f).size);
};
await dl(a.thumbnail_url, 'thumbnail');
await dl(a.imagery?.pano_url, 'pano');
await dl(a.splats?.spz_urls?.['500k'], 'world-500k');
await dl(a.splats?.spz_urls?.['100k'], 'world-100k');
await dl(a.mesh?.collider_mesh_url, 'collider');
log('FINISHED');
