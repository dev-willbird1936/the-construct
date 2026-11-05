import { test, assert } from "./support.js";
import { withModelRetry, isTransientModel404 } from "../../backend/lib/meta.js";

const err404 = (message = "404 The requested model was not found.") => Object.assign(new Error(message), { status: 404 });

test("model-not-found 404 is retried with backoff until it succeeds", async () => {
  let calls = 0;
  const waits = [];
  const out = await withModelRetry(async () => { calls += 1; if (calls < 4) throw err404(); return "ok"; }, { retries: 3, wait: async (ms) => waits.push(ms) });
  assert.equal(out, "ok");
  assert.equal(calls, 4);
  assert.equal(waits.length, 3);
  assert.ok(waits[2] > waits[0] * 0.9); // grows (jittered)
});

test("other errors are not retried, and the retry budget is bounded", async () => {
  let calls = 0;
  await assert.rejects(withModelRetry(async () => { calls += 1; throw Object.assign(new Error("bad request"), { status: 400 }); }, { wait: async () => {} }), /bad request/);
  assert.equal(calls, 1);
  assert.equal(isTransientModel404(Object.assign(new Error("404 not found: file"), { status: 404 })), false);
  calls = 0;
  await assert.rejects(withModelRetry(async () => { calls += 1; throw err404(); }, { retries: 3, wait: async () => {} }), /model was not found/);
  assert.equal(calls, 4);
});
