import test from 'node:test';
import assert from 'node:assert/strict';

process.env.META_API_KEY = 'DUMMY';
process.env.META_BASE_URL = 'http://127.0.0.1:1/v1';
process.env.META_MODEL_RETRIES = '0';
process.env.DETECT_BUDGET_MS = '30';
process.env.DETECT_PASS_PAUSE_MS = '0';
const { detectObjects } = await import('../../backend/lib/detect.js');
const { isCancelError } = await import('../../backend/lib/cancel.js');
const png = Buffer.from('synthetic no-hit fixture');

test('fast completed detection clears its deadline and external abort listener', async t => {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const outstanding = new Set();
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    const handle = set(() => { outstanding.delete(handle); fn(...args); }, delay);
    outstanding.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => { outstanding.delete(handle); return clear(handle); });
  const controller = new AbortController();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  let listeners = 0;
  t.mock.method(controller.signal, 'addEventListener', (...args) => { listeners++; return add(...args); });
  t.mock.method(controller.signal, 'removeEventListener', (...args) => { listeners--; return remove(...args); });
  const out = await detectObjects(png, 16, 12, [], ['cat'], { signal: controller.signal, _segment: async () => [] });
  assert.deepEqual(out.objects, []);
  assert.equal(outstanding.size, 0);
  assert.equal(listeners, 0);
});

test('deadline aborts the owned request and does not retry after exhaustion', async () => {
  let calls = 0, aborted = false;
  const segment = (concept, url, { signal }) => new Promise((resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => { aborted = true; reject(Error('synthetic aborted request')); }, { once: true });
  });
  await assert.rejects(detectObjects(png, 16, 12, [], ['cat'], { _segment: segment }), error => error.retryable === true);
  assert.equal(calls, 1);
  assert.equal(aborted, true);
});

test('external cancellation reaches the owned request and stays cancellation', async () => {
  const controller = new AbortController();
  let aborted = false;
  const segment = (concept, url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Error('synthetic aborted request')); }, { once: true });
    setImmediate(() => controller.abort());
  });
  await assert.rejects(detectObjects(png, 16, 12, [], ['cat'], { signal: controller.signal, _segment: segment }), isCancelError);
  assert.equal(aborted, true);
});
