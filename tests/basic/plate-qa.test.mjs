import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  IMAGE_BUDGET,
  createMuseBudget,
  qaOverLimit,
  repairRefusal,
  repairPromptFor,
  attemptPlateRepair,
  museEditPlate,
} from "../../backend/pipeline/basic/run-basic.mjs";

const require = createRequire(import.meta.url);
const sharp = require("../../backend/node_modules/sharp");

test("booked budget: reserve gates paid fetches, charge counts each once", async () => {
  const b = createMuseBudget();
  assert.equal(IMAGE_BUDGET, 2);
  assert.equal(b.reserve(), true);
  b.charge();
  assert.equal(b.spent, 1);
  assert.equal(b.left, 1);
  b.charge();
  assert.equal(b.spent, 2);
  assert.equal(b.left, 0);
  assert.equal(b.reserve(), false, "spent budget refuses further paid fetches");
});

test("refusals: quality/budget route Lite only, outage stays retryable", () => {
  const q = repairRefusal("quality", "ghost 0.01/0.3 residue 0.28/0.05");
  assert.match(q, /Lite/);
  assert.doesNotMatch(q, /Advanced/, "no manual-plate input exists");
  assert.doesNotMatch(q, /model_not_found/);
  const b = repairRefusal("budget", "ghost 0/0.3 residue 0.1/0.05");
  assert.match(b, /Lite/);
  assert.doesNotMatch(b, /Advanced/, "no manual-plate input exists");
  assert.match(b, /booked image budget/);
  const o = repairRefusal("outage", "x");
  assert.match(o, /model_not_found/);
  assert.doesNotMatch(o, /Lite/, "outage is not a quality verdict");
});

test("verdict: residue has its own limit, either share trips it", () => {
  assert.equal(qaOverLimit({ medianGhostShare: 0.01, medianResidueShare: 0.0 }, 0.3, 0.05).over, false);
  assert.equal(qaOverLimit({ medianGhostShare: 0.31, medianResidueShare: 0.0 }, 0.3, 0.05).over, true);
  assert.equal(qaOverLimit({ medianGhostShare: 0.02, medianResidueShare: 0.28 }, 0.3, 0.05).over, true);
  const v = qaOverLimit({ medianGhostShare: 0.02, medianResidueShare: 0.28 }, 0.3, 0.05);
  assert.equal(v.ghost, 0.02);
  assert.equal(v.residue, 0.28);
  assert.equal(v.residueLimit, 0.05);
});

test("repair prompt names residue traces, never new objects", () => {
  const p = repairPromptFor("man", "in the centre");
  assert.match(p, /translucent/);
  assert.match(p, /NO new objects/);
  assert.match(p, /pixel-identical/);
});

// Adapter-level budget boundary: real museEditPlate + fake fetch, no network.
async function editHarness() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "basic-adapter-"));
  const seed = path.join(dir, "seed.jpg");
  await sharp({ create: { width: 32, height: 18, channels: 3, background: { r: 4, g: 5, b: 6 } } })
    .jpeg().toFile(seed);
  const maskFor = async (fill) => {
    const p = path.join(dir, `m-${fill}.png`);
    const buf = Buffer.alloc(32 * 18, 0);
    const start = fill % 300;
    buf.fill(255, start, Math.min(start + 200, buf.length));
    await sharp(Buffer.from(buf), { raw: { width: 32, height: 18, channels: 1 } }).png().toFile(p);
    return p;
  };
  const payload = (await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 7, g: 7, b: 7 } } })
    .png().toBuffer()).toString("base64");
  const fetchOk = (counter) => async () => {
    counter.n += 1;
    return {
      ok: true, status: 200, headers: { get: () => null }, clone() { return this; },
      async text() { return ""; },
      async json() { return { data: [{ b64_json: payload }] }; },
    };
  };
  return { dir, seed, maskFor, fetchOk };
}

test("adapter: paid 200 charges exactly once, cache hit free after spent", async () => {
  const h = await editHarness();
  try {
    const b = createMuseBudget(2);
    const fetches = { n: 0 };
    const run = (mask) => museEditPlate(h.seed, mask, 32, 18, "man", "in the centre",
      h.dir, { fetchImpl: h.fetchOk(fetches), sleepImpl: async () => {} }, null, b);
    const first = await run(await h.maskFor(10));
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(b.spent, 1, "one paid response = one charge, no double-count");
    const second = await run(await h.maskFor(300));
    assert.equal(second.ok, true);
    assert.equal(b.spent, 2);
    assert.equal(fetches.n, 2);
    const hit = await run(await h.maskFor(10));
    assert.equal(hit.ok, true);
    assert.equal(hit.cached, true, "spent budget still serves cache");
    assert.equal(b.spent, 2, "cache hit never consumes");
    assert.equal(fetches.n, 2, "cache hit performs no fetch");
    const refused = await run(await h.maskFor(500));
    assert.equal(refused.ok, false);
    assert.equal(refused.exhausted, true);
    assert.equal(fetches.n, 2, "refused reserve performs no fetch");
    assert.equal(b.spent, 2);
  } finally {
    await fs.promises.rm(h.dir, { recursive: true, force: true });
  }
});

test("adapter: billed 200 without payload charges but stays unusable", async () => {
  const h = await editHarness();
  try {
    const b = createMuseBudget(2);
    const badFetch = async () => ({
      ok: true, status: 200, headers: { get: () => null }, clone() { return this; },
      async text() { return ""; },
      async json() { return { data: [{ nope: true }] }; },
    });
    for (let i = 0; i < 3; i += 1) {
      const got = await museEditPlate(h.seed, await h.maskFor(i), 32, 18, "man",
        "in the centre", h.dir, { fetchImpl: badFetch, sleepImpl: async () => {} }, null, b);
      assert.equal(got.ok, false, "garbage payload is not a usable image");
      assert.equal(got.unreachable, false, "answered 200 is not an outage");
    }
    assert.equal(b.spent, 2, "billed responses consume the booked budget");
  } finally {
    await fs.promises.rm(h.dir, { recursive: true, force: true });
  }
});

test("adapter: transient outage uncharged and retryable", async () => {
  const h = await editHarness();
  try {
    const b = createMuseBudget(2);
    const impl = async () => ({
      ok: false, status: 404, headers: { get: () => null }, clone() { return this; },
      async text() { return "404 The requested model was not found"; },
    });
    const got = await museEditPlate(h.seed, await h.maskFor(0), 32, 18, "man",
      "in the centre", h.dir,
      { fetchImpl: impl, sleepImpl: async () => {}, patienceSec: 0, maxRetries: 0 }, null, b);
    assert.equal(got.ok, false);
    assert.equal(got.unreachable, true);
    assert.equal(b.spent, 0, "outage responses are not booked spend");
  } finally {
    await fs.promises.rm(h.dir, { recursive: true, force: true });
  }
});
// Fake pipeline deps for attemptPlateRepair: real tmp files, canned py.
async function repairHarness(script) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "basic-repair-"));
  const W = 64, H = 36;
  const plateRaw = path.join(dir, "plate-raw.jpg");
  const plateMuse = path.join(dir, "plate-muse.jpg");
  const sweepPath = path.join(dir, "sweep.png");
  const holesPath = path.join(dir, "holes.png");
  const kfDir = path.join(dir, "kf");
  await fs.promises.mkdir(kfDir, { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 95, b: 100 } } })
    .jpeg().toFile(plateRaw);
  const mask = Buffer.alloc(W * H, 0);
  mask.fill(255, 300, 900);
  await sharp(Buffer.from(mask), { raw: { width: W, height: H, channels: 1 } }).png().toFile(sweepPath);
  await sharp(Buffer.from(mask), { raw: { width: W, height: H, channels: 1 } }).png().toFile(holesPath);
  const state = { compositeCopies: 0 };
  const py = async (args) => {
    const sub = args[1];
    if (sub === "motion-claim") {
      const out = args[args.indexOf("--out") + 1];
      await sharp(Buffer.from(mask), { raw: { width: W, height: H, channels: 1 } }).png().toFile(out);
      return JSON.stringify({ basePx: 1, extPx: 0, claimPx: 1, share: 0.01, bgVar: 5, frames: 2 });
    }
    if (sub === "composite") {
      const base = args[args.indexOf("--base") + 1];
      const out = args[args.indexOf("--out") + 1];
      await fs.promises.copyFile(base, out);
      state.compositeCopies += 1;
      return JSON.stringify({ method: "composite", holeShare: 0.01 });
    }
    if (sub === "ghost-map") {
      const step = script.ghostShift();
      return JSON.stringify(step);
    }
    throw new Error(`unexpected py subcommand ${sub}`);
  };
  const deps = {
    py, here: "here", work: dir, W, H, sweepPath, holesPath, kfDir, frames: [],
    concept: "man", location: "in the centre", plateRaw, plateMuse,
    museBudget: createMuseBudget(2), seedMask: sweepPath,
    validatePlate: async () => script.validateOk,
    ghostLimit: 0.3, residueLimit: 0.05,
  };
  return { dir, deps, state };
}

test("repair: provider outage maps to retryable, never a quality verdict", async () => {
  const h = await repairHarness({ validateOk: true, ghostShift: () => ({}) });
  try {
    const out = await attemptPlateRepair({
      ...h.deps,
      editPlate: async () => ({ ok: false, unreachable: true }),
      museBudget: createMuseBudget(2),
    });
    assert.equal(out.ok, false);
    assert.equal(out.unreachable, true);
    assert.match(repairRefusal("outage"), /model_not_found/);
  } finally {
    await fs.promises.rm(h.dir, { recursive: true, force: true });
  }
});

test("repair: strict gates reject a still-ghosted fill and restore the plate", async () => {
  const before = [];
  const h = await repairHarness({
    validateOk: true,
    ghostShift: (() => {
      let n = 0;
      return () => (++n === 1
        ? { outsideDiff: 0.2, medianGhostShare: 0.2, hybridGhostShare: 0.2, medianResidueShare: 0.2, hybridResidueShare: 0.2, medianEdge: 10, hybridEdge: 10 }
        : { medianGhostShare: 0.2, medianGhostBlobs: 1, medianResidueShare: 0.2, medianResidueBlobs: 1 });
    })(),
  });
  try {
    before.push(await fs.promises.readFile(h.deps.plateRaw));
    // The fake edit below echoes the (ghosted) plate bytes, so the strict
    // re-validation must reject and the pre-repair plate must be restored.
    const out = await attemptPlateRepair({
      ...h.deps,
      editPlate: async () => {
        // fake successful edit returning the (ghosted) plate bytes
        const buf = await fs.promises.readFile(h.deps.plateRaw);
        return { ok: true, buffer: buf, resized: false, cached: false };
      },
      museBudget: createMuseBudget(2),
    });
    assert.equal(out.ok, false);
    assert.match(out.detail, /residue/);
    const afterBytes = await fs.promises.readFile(h.deps.plateRaw);
    assert.deepEqual(afterBytes, before[0], "pre-repair plate restored");
  } finally {
    await fs.promises.rm(h.dir, { recursive: true, force: true });
  }
});

test("single final enforcement lives after the inpaint fallback", async () => {
  const src = await fs.promises.readFile(
    new URL("../../backend/pipeline/basic/run-basic.mjs", import.meta.url), "utf8");
  const writers = [...src.matchAll(/plateValidation\.ghost = \{/g)].map((m) => m.index);
  assert.equal(writers.length, 1, "exactly one ghost-measurement write (no vacuous zeros elsewhere)");
  const inpaintAssign = src.lastIndexOf('plateMethod = "inpaint"');
  assert.ok(writers[0] > inpaintAssign, "the single enforcement runs after every candidate path");
  assert.ok(!/--skip-qa|--no-qa|--force-plate|--skip-ghost/.test(src), "no gate-skip flags");
});
