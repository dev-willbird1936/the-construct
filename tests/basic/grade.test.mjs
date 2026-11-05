// Neon footage grade (loop 12): a clearly neon plate (slovakdeer, the roe deer example: mean HSV saturation
// 239/255, 60 % of pixels over 240) gets one shared grade on plate, atlas and thumb; ordinary clips (clip-b 91,
// grizzly 53, night-bear 6, black cat 100) are untouched. Run: node --test tests/basic/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { saturationStats, neonGrade, applyGrade, NEON_MEAN_S } from "../../backend/pipeline/basic/lib/grade.mjs";

const fill = (n, rgb, channels = 3) => {
  const out = new Uint8Array(n * channels);
  for (let i = 0; i < n; i += 1) {
    const c = rgb(i);
    out.set(channels === 4 ? [...c, 200] : c, i * channels);
  }
  return out;
};
const neon = (i) => (i % 5 === 0 ? [180, 120, 30] : [40 + (i % 7), 230, 12]); // clipped greens and an orange deer
const ordinary = (i) => (i % 3 ? [120, 110, 90] : [70, 95, 60]);           // muted bank and grass

test("the gate fires on neon footage only", () => {
  const n = saturationStats(fill(1000, neon), 3);
  assert.ok(n.meanS > NEON_MEAN_S && n.clipShare > 0.25);
  assert.ok(neonGrade(n));
  assert.equal(neonGrade(saturationStats(fill(1000, ordinary), 3)), null);
  assert.equal(neonGrade({ meanS: 200, clipShare: 0.05 }), null); // saturated but not clipped: left alone
  assert.equal(neonGrade(null), null);
});

test("the grade takes neon down to natural saturation, keeps luma order, trims brightness, leaves alpha", () => {
  const px = fill(1000, neon, 4);
  const before = saturationStats(px, 4);
  applyGrade(px, 4, neonGrade(before));
  const after = saturationStats(px, 4);
  assert.ok(after.meanS < 175 && after.meanS > 110, `mean saturation ${after.meanS}`);
  assert.equal(after.clipShare, 0);
  for (let p = 3; p < px.length; p += 4) assert.equal(px[p], 200);
  const grey = new Uint8Array([100, 100, 100]);
  applyGrade(grey, 3, neonGrade(before));
  assert.ok(grey[0] > grey[2] && grey[1] < 100, `grey -> ${[...grey]}`); // warmer and a little darker
});

test("no grade, no change; run-basic grades plate, atlas cells and thumb with the same grade", () => {
  const px = fill(10, ordinary);
  const copy = px.slice();
  applyGrade(px, 3, null);
  assert.deepEqual(px, copy);
  const src = fs.readFileSync(new URL("../../backend/pipeline/basic/run-basic.mjs", import.meta.url), "utf8");
  assert.match(src, /neonGrade\(saturationStats\(/);
  assert.match(src, /if \(grade\) applyGrade\(cut, 4, grade\)/);
  assert.match(src, /if \(grade\) applyGrade\(plateBase, 4, grade\)/);
  assert.match(src, /else await sharp\(plateRaw\)\.webp\(\{ quality: 92, effort: 6 \}\)\.toFile\(plateWebp\)/); // ungraded path unchanged
});
