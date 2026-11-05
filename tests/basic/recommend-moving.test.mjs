// Loop 7 (tier-improve 2026-11-04): a clip whose camera is measured moving
// with confidence is refused by runner-basic at job start, so the route
// must not preselect Basic for it (handheld pet clip "blackcat").
import test from "node:test";
import assert from "node:assert/strict";
import { recommendTier } from "../../backend/app/camera.js";

test("a confidently moving camera is routed to Lite, not Basic", () => {
  const rec = recommendTier({ camera: "moving", subjects: ["black cat"] }, { moving: true, confident: true, shiftPx: 10.2 });
  assert.equal(rec.tier, "lite");
  assert.match(rec.why, /steady camera/);
});

test("unconfident, fixed or missing measurements keep the Basic recommendation", () => {
  assert.equal(recommendTier({ camera: "moving", subjects: ["fox"] }, { moving: true }).tier, "basic");
  assert.equal(recommendTier({ camera: "fixed", subjects: ["fox"] }, { moving: false, confident: true }).tier, "basic");
  assert.equal(recommendTier({ camera: "handheld", subjects: ["fox"] }, null).tier, "basic");
});

test("category rules still come first", () => {
  assert.equal(recommendTier({ category: "product", subjects: ["mug"] }, { moving: true, confident: true }).tier, "advanced");
  assert.equal(recommendTier({ category: "drone", subjects: [] }, { moving: true, confident: true }).tier, "lite");
});
