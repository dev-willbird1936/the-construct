import { test, assert, startApp, api, workerToken } from './support.js';

test('authenticated empty queue polls refresh worker liveness without creating jobs or spend', async (t) => {
  const { base } = await startApp(t);
  const me = () => api(base, 'GET', '/api/me');
  assert.equal((await me()).json.worker.online, false);
  const before = (await api(base, 'GET', '/api/admin/status', { role: 'owner' })).json;
  assert.equal((await api(base, 'POST', '/api/worker/claim', { token: 'wrong', body: {} })).status, 401);
  assert.equal((await me()).json.worker.online, false);
  assert.equal((await api(base, 'POST', '/api/worker/claim', { token: workerToken, body: {} })).status, 204);
  const live = (await me()).json.worker;
  assert.equal(live.online, true);
  assert.ok(Number.isFinite(live.lastSeenAt));
  assert.equal((await api(base, 'POST', '/api/worker/claim', { token: 'wrong', body: {} })).status, 401);
  assert.equal((await me()).json.worker.lastSeenAt, live.lastSeenAt);
  const after = (await api(base, 'GET', '/api/admin/status', { role: 'owner' })).json;
  for (const key of ['spendTodayCents', 'jobsToday', 'running', 'queuedGpu']) assert.equal(after[key], before[key], key);
});
