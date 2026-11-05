import { test, assert, startApp, api } from "./support.js";

test("a paused tier is refused, hidden from /me and drops its gallery examples", async (t) => {
  const { base } = await startApp(t, { configOverrides: { enabledTiers: ["lite"] } });
  const me = await api(base, "GET", "/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.tiers, ["lite"]);
  const job = await api(base, "POST", "/api/jobs", { body: { tier: "basic" } });
  assert.equal(job.status, 409);
  assert.match(job.json.error, /paused/);
  const seed = await api(base, "GET", "/assets/gallery-seed.json");
  assert.equal(seed.status, 200);
  assert.ok(seed.json.examples.length > 0);
  assert.ok(seed.json.examples.every((e) => e.tier === "lite"));
});

test("all tiers stay on by default", async (t) => {
  const { base } = await startApp(t);
  const me = await api(base, "GET", "/api/me");
  assert.deepEqual(me.json.tiers, ["lite", "basic", "advanced"]);
});
