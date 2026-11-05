// Explicitly bounded to named, user-authorized examples. No implicit paid retries.
// node worldlabs-example.mjs walker|grizzly|wolves --generate|--collect|--status
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [clip, action] = process.argv.slice(2);
if (!['walker', 'grizzly', 'wolves'].includes(clip) || !['--generate', '--collect', '--status'].includes(action)) throw Error('Choose walker|grizzly|wolves and --generate|--collect|--status.');
const out = path.join(root, 'assets/worldlabs', clip);
const key = (process.env.WORLDLABS_API_KEY || '').trim();
const base = 'https://api.worldlabs.ai/marble/v1';
const headers = { 'Content-Type': 'application/json', 'WLT-Api-Key': key };
const json = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) throw Error(`World Labs HTTP ${response.status}; no automatic retries.`);
  return response.json();
};
const post = (url, body) => json(base + url, { method: 'POST', body: JSON.stringify(body) });
const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));

if (action === '--generate') {
  // Published marble-1.1 video total: 1500 generation +100 pano, no variable-size charge.
  const credits = await json(base + '/credits');
  if (!(credits.remaining_credits >= 1600)) throw Error('Need 1600 existing credits; no refill or overage authorized.');
  const meta = clip === 'wolves'
    ? { clip: '.planning/trailcam-wolves-world/wolves-29.9s.mp4' }
    : JSON.parse(fs.readFileSync(path.join(root, 'assets/stable', clip, 'stable.json')));
  const source = path.resolve(root, meta.clip);
  const expected = path.resolve(root, clip === 'walker'
    ? 'assets/clips/walker.mp4'
    : clip === 'grizzly'
      ? 'assets/clips/trailcam/grizzly.mp4'
      : '.planning/trailcam-wolves-world/wolves-29.9s.mp4');
  if (source !== expected) throw Error('Unexpected source video path.');
  if (['operation-id.txt', 'operation.json', 'submission.json'].some((name) => fs.existsSync(path.join(out, name)))) throw Error('An operation already exists; collect/resume it instead.');
  fs.mkdirSync(out, { recursive: true });
  // Exclusive durable reservation prevents a second POST even if the first
  // response is lost. Ambiguous submission requires reconciliation, not retry.
  const sourceUrl = clip === 'wolves' ? 'https://x.com/Trail_Cams/status/2106504576014659770' : undefined;
  const reservation = { clip, source: meta.clip, model: 'marble-1.1', expectedCredits: 1600, balanceBefore: credits.remaining_credits, startedAt: new Date().toISOString(), state: 'reserved', ...(sourceUrl && { sourceUrl }) };
  fs.writeFileSync(path.join(out, 'submission.json'), JSON.stringify(reservation, null, 2), { flag: 'wx' });
  const upload = await post('/media-assets:prepare_upload', { file_name: clip + '.mp4', extension: 'mp4', kind: 'video' });
  if (!upload.upload_info.upload_url.startsWith('https://')) throw Error('Refusing insecure upload.');
  const uploaded = await fetch(upload.upload_info.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', ...upload.upload_info.required_headers }, body: fs.readFileSync(source) });
  if (!uploaded.ok) throw Error(`Upload HTTP ${uploaded.status}; no generation sent.`);
  save('submission.json', { ...reservation, mediaAssetId: upload.media_asset.media_asset_id, state: 'generation-post-about-to-send' });
  const operation = await post('/worlds:generate', { display_name: clip + ' (3.5D-Visualizer)', model: 'marble-1.1', permission: { public: false, allow_id_access: false }, world_prompt: { type: 'video', video_prompt: { source: 'media_asset', media_asset_id: upload.media_asset.media_asset_id } } });
  if (!operation.operation_id) throw Error('Missing operation ID; reconcile submission before any new paid action.');
  fs.writeFileSync(path.join(out, 'operation-id.txt'), operation.operation_id, { flag: 'wx' });
  save('operation.json', operation);
  console.log(JSON.stringify({ clip, operationId: operation.operation_id, expectedCredits: 1600, balanceBefore: credits.remaining_credits }));
} else {
  const id = fs.readFileSync(path.join(out, 'operation-id.txt'), 'utf8').trim();
  if (!/^[a-z0-9-]+$/i.test(id)) throw Error('Invalid persisted operation ID.');
  let operation;
  do {
    operation = await json(base + '/operations/' + id);
    save('operation.json', operation);
    console.log(JSON.stringify({ clip, operationId: id, done: operation.done, status: operation.metadata?.progress?.description, cost: operation.cost?.total_credits }));
    if (action === '--status' || operation.done) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  } while (true);
  if (operation.error) throw Error('Generation failed; no paid retry authorized.');
  if (action === '--collect') {
    const assets = operation.response.assets;
    const files = [[assets.splats.spz_urls.full_res, 'world-full.spz'], [assets.splats.spz_urls['500k'], 'world-500k.spz'], [assets.splats.spz_urls['100k'], 'world-100k.spz'], [assets.imagery.pano_url, 'pano.png'], [assets.thumbnail_url, 'thumbnail.webp'], [assets.mesh?.collider_mesh_url, 'collider.glb']];
    for (const [url, name] of files) {
      if (!url || fs.existsSync(path.join(out, name))) continue;
      const response = await fetch(url);
      if (!response.ok) throw Error(`Asset download ${name} HTTP ${response.status}.`);
      fs.writeFileSync(path.join(out, name), Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
    }
    const credits = await json(base + '/credits');
    const submission = JSON.parse(fs.readFileSync(path.join(out, 'submission.json'), 'utf8'));
    save('submission.json', { ...submission, state: 'succeeded', operationId: id, worldId: operation.response.world_id, costCredits: operation.cost?.total_credits, balanceAfter: credits.remaining_credits, completedAt: operation.updated_at });
    console.log(JSON.stringify({ clip, worldId: operation.response.world_id, url: operation.response.world_marble_url, costCredits: operation.cost?.total_credits, balanceAfter: credits.remaining_credits, collected: true }));
  }
}
