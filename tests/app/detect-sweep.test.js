import test from "node:test";
import assert from "node:assert/strict";

process.env.DETECT_PASS_PAUSE_MS = "0";
process.env.META_API_KEY ||= "test";
const { detectObjects } = await import("../../backend/lib/detect.js");

const W = 16;
const H = 12;
const png = Buffer.from("not-a-real-png"); // detectObjects only base64-encodes it for the request

test("a concept that failed in the first pass is retried; once it answers there is no outage error", async () => {
  const calls = {};
  const segment = async (concept) => {
    calls[concept] = (calls[concept] || 0) + 1;
    if (concept === "cougar" && calls[concept] === 1) throw new Error("404 model not found");
    return [];
  };
  const out = await detectObjects(png, W, H, [], ["animal", "cougar", "tree"], { _segment: segment });
  assert.equal(calls.cougar, 2);
  assert.equal(calls.animal, 1);
  assert.equal(out.objects.length, 0);
});

test("failed calls with no hits throw a retryable outage error instead of caching zero objects", async () => {
  let calls = 0;
  const segment = async (concept) => {
    calls += 1;
    if (concept === "cougar") throw new Error("404 model not found");
    return []; // the other concepts really found nothing
  };
  await assert.rejects(
    detectObjects(png, W, H, [], ["animal", "cougar", "tree"], { _segment: segment }),
    (error) => error.retryable === true && /temporarily unavailable/.test(error.message)
  );
  assert.equal(calls, 3 + 2); // first pass + two retry passes for the one failing concept
});

test("an honest empty picture (no failures, no hits) is still an empty result", async () => {
  const out = await detectObjects(png, W, H, [], ["animal", "tree"], { _segment: async () => [] });
  assert.equal(out.objects.length, 0);
});
