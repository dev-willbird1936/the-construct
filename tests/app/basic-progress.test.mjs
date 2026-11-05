// The Basic wait shows plain steps and a bar that only moves forward, never
// run-basic's diagnostic `stage:` lines (journey walk 1: the live wait showed
// "plate: muse-image scene pass=false (mean 11.41, p95 33.0)…" at 0%).
import test from "node:test";
import assert from "node:assert/strict";
import { basicStep, basicFailureText, BASIC_SEED_BOX_NO_MATCH_TEXT, BASIC_MOVING_CAMERA_TEXT, BASIC_UPSTREAM_BUSY_TEXT, BASIC_UNCLEAN_TEXT } from "../../backend/app/runner-basic.js";

// the stage lines of a real slovakdeer run, in order
const RUN = [
  "work dir: D:\\scratch\\work",
  "probe: 1280x720 25.0fps 8.0s -> working 960x540",
  "proxy usage before: {\"day\":\"2026-11-04\"}",
  "plate: first Muse edit requested at job start (seed frame 27, mask share 0.059, overlaps tracking)",
  "track: cache key e036a6e82b954608 (empty)",
  "track: Following your subject… (1/1)",
  "track: id=1 frames=93 (27-119)",
  "keyframes: sharpness snap moved 7 (32->31 x1.25)",
  "keyframes: 39 samples, seed=27 (t=1.80s)",
  "cleanup: removed track/ (consumed by extract)",
  "sweep: union share 0.0813",
  "subject: max frame share 0.059",
  "camera: fixed",
  "plate: temporal median",
  "plate: muse-image scene pass=false (mean 13.17, p95 40.0) holes pass=true (share 0.0724)",
  "plate: ghost 0/0 (limit 0.3) residue 0/0 (limit 0.05)",
  "infer done: 39 frames, mean 0.3s/frame (keyframes, overlapped with the plate)",
  "cleanup: removed infer/ (consumed by depth-infer)",
  "fit done",
  "atlas: 39 cells 448x312 in 7 cols (crop 319x222)",
  "behind: canvas 1248,702 ghost 1/0.0576 (0.7s)",
  "cleanup: removed tmp/ (child-process scratch)",
  "done: 39 keyframes, 1438KB total",
  "proxy usage after: {\"day\":\"2026-11-04\"}",
];

test("Basic stage lines become plain steps with a forward-only bar", () => {
  let step = -1;
  const shown = [];
  for (const line of RUN) {
    const next = basicStep(line, step);
    if (next) { step = next.index; shown.push(next); }
  }
  assert.deepEqual(shown.map((s) => s.stage), ["reading the clip", "tracking", "choosing moments", "measuring", "painting the scene", "estimating depth", "packing", "finishing"]);
  for (let i = 1; i < shown.length; i += 1) assert.ok(shown[i].progress > shown[i - 1].progress);
  for (const s of shown) assert.doesNotMatch(s.detail, /[=_/\\]|\d/, `diagnostic text leaked: ${s.detail}`);
});

test("lines for no step, or an earlier step, keep the current step", () => {
  assert.equal(basicStep("cleanup: removed tmp/ (child-process scratch)"), null);
  assert.equal(basicStep("proxy usage before: {}"), null);
  assert.equal(basicStep("plate: first Muse edit requested at job start (overlaps tracking)"), null);
  const packing = basicStep("atlas: 39 cells");
  assert.equal(basicStep("behind: canvas 1248,702", packing.index), null);
});

// journey walk L3: a refusal was shown as "Meta's model service is busy; trying
// again (1/5)" and re-run (and paid for) after 60 s, because run-basic's own
// proxy counter line held "files":503.
test("proxy counters and refusals are never read as Meta being busy", () => {
  const usage = 'stage: proxy usage before: {"day":"2026-11-04","images":105,"responses":2595,"files":503,"other":0}';
  assert.equal(basicFailureText({ code: 3 }, `${usage} stage: track: id=1 frames=93 error: seed-box no match (best IoU 0.000 < 0.15)`), BASIC_SEED_BOX_NO_MATCH_TEXT);
  assert.equal(basicFailureText({ code: 3 }, `${usage} error: pan camera (pan 0.2, scale 1); use Lite`), BASIC_MOVING_CAMERA_TEXT);
  assert.equal(basicFailureText({ code: 3 }, `${usage} stage: fit done`), BASIC_UNCLEAN_TEXT);
  // real upstream trouble still reads as busy, so the job retry loop still sees it
  assert.equal(basicFailureText({ code: 1 }, `${usage} Error: 503 Service Unavailable`), BASIC_UPSTREAM_BUSY_TEXT);
  assert.equal(basicFailureText({ code: 1 }, "error: Connection error."), BASIC_UPSTREAM_BUSY_TEXT);
});
