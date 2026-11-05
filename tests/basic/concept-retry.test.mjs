// Loop 7 (tier-improve 2026-11-04) helpers: the head-noun retry concept for
// a "Find objects" label the video pass cannot find (magiccup: "white mug with
// blue handle" -> 0 tracks), and the clicked frame kept as a keyframe.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { headNoun, pinSeedSample, sampleToSourceFrame } from "../../backend/pipeline/basic/lib/keyframes.mjs";

test("headNoun keeps the thing SAM should look for", () => {
  const cases = {
    "white mug with blue handle": "mug", "reddish-brown deer": "deer", "elk with antlers": "elk",
    "man in glasses…": "man", "brown bear": "bear", "wolf pack": "wolf", "black-white dog behind": "dog",
    "cup of coffee": "cup", "person on the left": "person", "printed church building": "building",
  };
  for (const [label, noun] of Object.entries(cases)) assert.equal(headNoun(label), noun, label);
});

test("headNoun returns null when there is nothing shorter to try", () => {
  for (const label of ["cat", "Dog", "", null, "  bear  "]) assert.equal(headNoun(label), null, String(label));
});

test("pinSeedSample moves the nearest even pick onto a visible seed", () => {
  const present = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(pinSeedSample([0, 3, 6, 9], present, 4), [0, 4, 6, 9]);
  assert.deepEqual(pinSeedSample([0, 3, 6, 9], present, 3), [0, 3, 6, 9], "already a pick");
  assert.deepEqual(pinSeedSample([0, 3, 6, 9], [0, 3, 6, 9], 4), [0, 3, 6, 9], "subject not visible at the seed");
  assert.deepEqual(pinSeedSample([], present, 4), []);
});

test("pinSeedSample treats a pick on the same source frame as the seed (low-fps sources)", () => {
  const src = (s) => sampleToSourceFrame(s, 10); // 10 fps source, 15 fps samples
  assert.equal(src(4), src(5) === src(4) ? src(5) : src(4));
  const picks = [0, 5, 10];
  assert.equal(src(5), 3); assert.equal(src(4), 3);
  assert.deepEqual(pinSeedSample(picks, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, src), picks);
});

test("run-basic retries the click match once with the head noun, never on ambiguity", async () => {
  const source = await fs.readFile(new URL("../../backend/pipeline/basic/run-basic.mjs", import.meta.url), "utf8");
  assert.match(source, /\/no match\/\.test\(String\(matchError\?\.message\)\) \? headNoun\(opts\.concept\) : null/);
  assert.equal(source.match(/conceptTrack\(retry, "track-retry"\)/g)?.length, 1);
  assert.match(source, /pinSeedSample\(selectKeyframes\(/);
});

test("early Muse is on for Basic jobs, off for Advanced's matte lane unless it opts in", async () => {
  const source = (await fs.readFile(new URL("../../backend/pipeline/basic/run-basic.mjs", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const line = source.match(/const earlyMuseOn = (.+);\n/)[1];
  const on = (env, opts) => new Function("process", "opts", `return ${line};`)({ env }, opts);
  assert.equal(on({}, {}), true, "Basic default");
  assert.equal(on({ BASIC_EARLY_MUSE: "0" }, {}), false, "kill switch");
  assert.equal(on({}, { matte: "birefnet" }), false, "Advanced live matte lane");
  assert.equal(on({}, { matteDir: "D:/m" }), false, "Advanced precomputed mattes");
  assert.equal(on({ BASIC_EARLY_MUSE: "1" }, { matte: "birefnet" }), true, "explicit opt-in");
  assert.match(source, /if \(earlyMuseOn\) \{/);
});
