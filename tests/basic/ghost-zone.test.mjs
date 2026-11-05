// tier-improve 2026-11-04 (basic): the final ghost/residue ladder measures
// where pixels were synthesized (grizzly river: the real seed frame read as
// 0.85 "ghost" over the sweep; 0.0 over the fill claim).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ghostZoneKind } from "../../backend/pipeline/basic/run-basic.mjs";

test("seed-frame plates measure the fill claim", () => {
  assert.equal(ghostZoneKind({ method: "muse-image", blend: "seed-base+muse-holes" }), "claim");
  assert.equal(ghostZoneKind({ method: "inpaint" }), "claim");
  assert.equal(ghostZoneKind({ method: "migan", blend: "seed-base+muse-holes", colorMatched: true }), "claim");
});

test("median-based and full-render plates measure the whole sweep", () => {
  assert.equal(ghostZoneKind({ method: "median" }), "sweep");
  assert.equal(ghostZoneKind({ method: "muse-image", blend: "median-base+muse-holes" }), "sweep");
  assert.equal(ghostZoneKind({ method: "muse-image", blend: "median-base+muse-sweep" }), "sweep");
  assert.equal(ghostZoneKind({ method: "muse-image", blend: "plate-base+muse-repair" }), "sweep");
  assert.equal(ghostZoneKind({ method: "muse-image", blend: "seed-base+muse-holes", colorMatched: true }), "sweep",
    "full-frame colour-matched render is synthesized everywhere");
  assert.equal(ghostZoneKind({}), "sweep", "unknown stays conservative");
});

test("the ladder routes its ghost-map through the zone choice", async () => {
  const src = await fs.promises.readFile(new URL("../../backend/pipeline/basic/run-basic.mjs", import.meta.url), "utf8");
  assert.match(src, /"ghost-map", "--median", plateRaw, "--mask", zoneMask/);
});

