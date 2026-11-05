// A compilation clip's other scenes are cut away before tracking (probe.shot), and the customer's
// pick moment moves with the cut. Real ffmpeg on a generated 4 s clip; tracker and matcher stubbed.
// Run: node --test tests/advanced/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { shotSpan, worldSpan } from "../../backend/lib/world.js";

test("shotSpan trusts only a believable span", () => {
  assert.deepEqual(shotSpan({ shot: [0.6, 6.7] }, 7), [0.6, 6.7]);
  assert.deepEqual(shotSpan({ shot: [2, 7] }, 7), [2, 7]);
  assert.equal(shotSpan({ shot: [0, 7] }, 7), null);          // the whole clip
  assert.equal(shotSpan({ shot: [1, 2.5] }, 7), null);        // under 2 s is no world
  assert.equal(shotSpan({ shot: [8, 10] }, 7), null);         // past the end
  assert.equal(shotSpan({ shot: "x" }, 7), null);
  assert.equal(shotSpan(null, 7), null);
  assert.deepEqual(shotSpan({ shot: [0.6, 7.4] }, 7), [0.6, 7]);
});

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shot-trim-"));
  const video = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=4", "-pix_fmt", "yuv420p", video]);
  const seen = {};
  const stubs = {
    "track.js": `import fs from "node:fs/promises"; import path from "node:path";
      export const SAMPLE_FPS = 15;
      export async function trackInstances(a) { globalThis.__seen.track = a; await fs.mkdir(a.outDir, { recursive: true });
        await fs.writeFile(path.join(a.outDir, "tracks.json"), JSON.stringify({ tracks: [{ id: 1, frames: 30 }] }));
        return { tracks: [{ id: 1, frames: 30 }], fps: 15 }; }`,
    "edges.js": "export async function trackEdges() {}",
    "seed-match.mjs": `export const SEED_BOX_WINDOW = 0, seedSampleFor = (t) => Math.round(t * 15), boxForTrackId = () => null;
      export function resolveWorldSelection(a) { globalThis.__seen.select = a; throw Object.assign(new Error("stop"), { code: "STOP" }); }`,
    "reconstruct.js": "export const enhanceAvailable = () => false, enhanceClip = () => {}, reconstructWorld = () => {};",
    "ffmpeg.js": "export const transcodeForWeb = () => {};",
    "sharp.mjs": "export default function () { throw new Error('no rasters here'); }",
    "package.json": '{"type":"module"}',
  };
  await Promise.all(Object.entries(stubs).map(([n, c]) => fs.writeFile(path.join(dir, n), c)));
  const source = (await fs.readFile(new URL("../../backend/lib/world.js", import.meta.url), "utf8")).replace('from "sharp"', 'from "./sharp.mjs"');
  await fs.writeFile(path.join(dir, "world.mjs"), source);
  globalThis.__seen = seen;
  const { buildWorld } = await import(pathToFileURL(path.join(dir, "world.mjs")));
  return { dir, video, seen, buildWorld };
}

test("buildWorld keeps the one shot and moves the pick moment with it", async () => {
  const { dir, video, seen, buildWorld } = await harness();
  const snapshot = { version: 1, seedTime: 2.5, objects: [{ label: "deer", box: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.5 } }] };
  const build = {};
  await assert.rejects(buildWorld({
    build, concept: "deer", name: "t", clipPath: dir, site: dir, probe: { fixed: true, shot: [1, 4] },
    job: { jobDir: dir, videoPath: video, width: 320, height: 180, duration: 4, seedTime: 2.5, selectionSnapshot: snapshot, requireSelection: true },
  }), { code: "STOP" });
  assert.match(seen.track.videoPath, /shot\.mp4$/);
  assert.ok(Math.abs(seen.track.duration - 3) < 0.1, `duration ${seen.track.duration}`);
  assert.ok(Math.abs(seen.select.seedTime - 1.5) < 1e-9);
  assert.ok(Math.abs(seen.select.snapshot.seedTime - 1.5) < 1e-9);
  assert.equal(snapshot.seedTime, 2.5, "the caller's snapshot is not mutated");
});

test("a pick outside the kept shot keeps the clip whole", async () => {
  const { dir, video, seen, buildWorld } = await harness();
  const snapshot = { version: 1, seedTime: 0.2, objects: [{ label: "deer", box: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.5 } }] };
  await assert.rejects(buildWorld({
    build: {}, concept: "deer", name: "t", clipPath: dir, site: dir, probe: { fixed: true, shot: [2, 4] },
    job: { jobDir: dir, videoPath: video, width: 320, height: 180, duration: 4, seedTime: 0.2, selectionSnapshot: snapshot, requireSelection: true },
  }), { code: "STOP" });
  assert.equal(seen.track.videoPath, video);
  assert.equal(seen.select.seedTime, 0.2);
});

test("Lite and the cloud stop never trim", async () => {
  const { dir, video, seen, buildWorld } = await harness();
  await buildWorld({
    build: {}, concept: "deer", name: "t", clipPath: dir, site: dir, probe: { fixed: true, shot: [1, 4] }, lite: true,
    job: { jobDir: dir, videoPath: video, width: 320, height: 180, duration: 4 },
  });
  assert.equal(seen.track.videoPath, video);
});

test("worldSpan keeps a long clip to the seconds round the pick", () => {
  assert.equal(worldSpan(null, 20, 5, true), null);                       // short enough: the whole clip
  assert.deepEqual(worldSpan(null, 60, 40, true), [25, 55]);              // centred on the pick
  assert.deepEqual(worldSpan(null, 60, 3, true), [0, 30]);                // held inside the clip
  assert.deepEqual(worldSpan(null, 60, 59, true), [30, 60]);
  assert.deepEqual(worldSpan(null, 60, 40, false), [0, 30]);              // nothing picked: the opening
  assert.deepEqual(worldSpan([10, 55], 60, 50, true), [25, 55]);          // inside the steady shot
  assert.deepEqual(worldSpan([2, 7], 60, 5, true), [2, 7]);               // a short shot stays as it is
  assert.deepEqual(worldSpan([10, 55], 60, 2, true), [10, 40]);           // a pick outside the shot: its opening
});

test("buildWorld narrows a long clip to the window round the pick and moves the pick with it", async () => {
  const { dir, seen, buildWorld } = await harness();
  const long = path.join(dir, "long.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=15:duration=40", "-pix_fmt", "yuv420p", long]);
  const snapshot = { version: 1, seedTime: 30, objects: [{ label: "deer", box: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.5 } }] };
  const build = {};
  await assert.rejects(buildWorld({
    build, concept: "deer", name: "t", clipPath: dir, site: dir, probe: { fixed: true },
    job: { jobDir: dir, videoPath: long, width: 160, height: 90, duration: 40, seedTime: 30, selectionSnapshot: snapshot, requireSelection: true },
  }), { code: "STOP" });
  assert.match(seen.track.videoPath, /shot\.mp4$/);
  assert.ok(Math.abs(seen.track.duration - 30) < 0.2, `duration ${seen.track.duration}`);
  assert.ok(Math.abs(seen.select.seedTime - 20) < 0.01, `pick at ${seen.select.seedTime}`);   // 30 s into 10..40
});
