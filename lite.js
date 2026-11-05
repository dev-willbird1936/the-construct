import { createLiteView, liteEvents } from './lite-view.js';
const params = new URLSearchParams(location.search), run = params.get('run'), job = params.get('job'), api = (params.get('api') || '').replace(/\/$/, ''), status = document.querySelector('#status');
async function show() {
  let historyRun = run, needsHistory = false;
  const validRun = value => /^r[0-9a-f]{10}$/.test(value || '');
  if (job ? !/^[0-9a-f-]{36}$/i.test(job) : !validRun(run)) throw new Error('No Lite result specified.');
  if (!params.has('shared')) {
    const path = job ? `/api/live/lite/${job}/files/lite.json` : `/api/live/${run}/files/lite.json`;
    let response = await fetch(api + path);
    if (!job && [404, 410].includes(response.status)) response = await fetch(`${api}/api/live/saved/${run}`);
    if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error('This result is unavailable.');
    const result = response.ok ? await response.json().catch(() => null) : null;
    if (validRun(result?.sourceRun)) historyRun = result.sourceRun;
    if (result && Number.isFinite(result.fps) && result.fps > 0 && Number.isInteger(result.samples) && result.samples > 0 && Array.isArray(result.ghosts) && result.width > 0 && result.height > 0) {
      await createLiteView(document.querySelector('#lite-view'), result, api);
      status.textContent = ''; return;
    }
    // Older manifests may need their original event history; never guess the missing clock or poses.
    needsHistory = Boolean(result);
    status.textContent = 'Restoring the full pose sequence…';
  }
  if (!validRun(historyRun)) throw new Error('This result is unavailable.');
  const unavailable = () => needsHistory ? "This older result's original playback history is no longer available." : 'This result is unavailable.';
  const events = liteEvents(), source = new EventSource(`${api}/api/live/${historyRun}/events`);
  source.onmessage = async message => {
    let e;
    try { e = JSON.parse(message.data); if (!e || typeof e !== 'object') throw new Error(); }
    catch { source.close(); status.textContent = "This result's history is invalid."; return; }
    events.consume(e);
    if (e.type === 'ghosts-done') { source.close(); try { await createLiteView(document.querySelector('#lite-view'), events.result(), api); status.textContent = ''; } catch (error) { status.textContent = error.message; } }
    else if (e.type === 'error') { source.close(); status.textContent = e.message; }
  };
  source.addEventListener('end', () => { source.close(); if (!document.querySelector('#lite-view canvas')) status.textContent = unavailable(); });
  source.onerror = () => { if (source.readyState === EventSource.CLOSED) status.textContent = unavailable(); };
}
show().catch(error => { status.textContent = error.message; });
