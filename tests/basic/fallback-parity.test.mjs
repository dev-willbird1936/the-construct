import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { acceptFallbackPlate } from "../../backend/pipeline/basic/run-basic.mjs";

// FREEZE v2 path parity: a passing mi-gan or inpaint fallback plate faces the
// in-place gate; only an in-place regime with a non-accept verdict refuses.
test("acceptFallbackPlate refuses only an in-place non-accept", () => {
  assert.equal(acceptFallbackPlate({ inplace: false, verdict: "defer" }), true);
  assert.equal(acceptFallbackPlate({ inplace: false, verdict: "reject" }), true);
  assert.equal(acceptFallbackPlate({ inplace: true, verdict: "accept" }), true);
  assert.equal(acceptFallbackPlate({ inplace: true, verdict: "reject" }), false);
  assert.equal(acceptFallbackPlate(null), true);
  assert.equal(acceptFallbackPlate(undefined), true);
});

test("both fallback rungs call the shared in-place gate", async () => {
  const src = await fs.readFile(new URL("../../backend/pipeline/basic/run-basic.mjs", import.meta.url), "utf8");
  assert.match(src, /await assessFallbackGate\("migan"\)/);
  assert.match(src, /await assessFallbackGate\("inpaint"\)/);
});
