// Loop 9 (tier-improve 2026-11-04): a box-path Muse edit marks the subject in
// the image (magenta, mask grown MARK_GROW_PX) instead of naming it, because a
// drawn box is only "selected object" (b8 deer-lake: the worded edit erased
// the fawn, not the boxed doe). Real museEditPlate + fake fetch, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { museEditPlate, markSubject, markedPromptFor, MARK_GROW_PX, createMuseBudget } from "../../backend/pipeline/basic/run-basic.mjs";

const require = createRequire(import.meta.url);
const sharp = require("../../backend/node_modules/sharp");

async function scene() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "basic-mark-"));
  const seed = path.join(dir, "seed.jpg");
  await sharp({ create: { width: 64, height: 40, channels: 3, background: { r: 40, g: 160, b: 60 } } }).jpeg({ quality: 95 }).toFile(seed);
  const mask = path.join(dir, "mask.png");
  const m = Buffer.alloc(64 * 40, 0);
  for (let y = 15; y < 25; y += 1) for (let x = 20; x < 30; x += 1) m[y * 64 + x] = 1; // label value 1, like a kf label
  await sharp(m, { raw: { width: 64, height: 40, channels: 1 } }).png().toFile(mask);
  const empty = path.join(dir, "empty.png");
  await sharp(Buffer.alloc(64 * 40, 0), { raw: { width: 64, height: 40, channels: 1 } }).png().toFile(empty);
  return { dir, seed, mask, empty };
}

const magenta = (d, p) => d[p] > 200 && d[p + 1] < 60 && d[p + 2] > 200;

test("markSubject paints the mask grown by MARK_GROW_PX magenta and nothing else", async () => {
  const s = await scene();
  try {
    const { data, info } = await sharp(await markSubject(s.seed, s.mask)).raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => (y * info.width + x) * info.channels;
    assert.ok(magenta(data, at(25, 20)), "inside the mask");
    assert.ok(magenta(data, at(20 - MARK_GROW_PX + 1, 20)), "inside the grown band");
    assert.ok(!magenta(data, at(20 - MARK_GROW_PX - 3, 20)), "clear of the band");
    assert.ok(!magenta(data, at(2, 2)), "background untouched");
    await assert.rejects(markSubject(s.seed, s.empty), /empty mask/);
  } finally { await fs.promises.rm(s.dir, { recursive: true, force: true }); }
});

test("a marked edit sends the magenta image and the shape prompt; a worded edit is unchanged", async () => {
  const s = await scene();
  try {
    const payload = (await sharp({ create: { width: 64, height: 40, channels: 3, background: { r: 7, g: 7, b: 7 } } }).png().toBuffer()).toString("base64");
    const sent = [];
    const fetchImpl = async (_url, init) => {
      const image = Buffer.from(await init.body.get("image").arrayBuffer());
      sent.push({ prompt: init.body.get("prompt"), image });
      return { ok: true, status: 200, headers: { get: () => null }, clone() { return this; }, async text() { return ""; }, async json() { return { data: [{ b64_json: payload }] }; } };
    };
    const opts = { fetchImpl, sleepImpl: async () => {} };
    const marked = await museEditPlate(s.seed, s.mask, 64, 40, "selected object", "in the centre of the frame", s.dir, opts, null, createMuseBudget(2), { mark: true });
    assert.equal(marked.ok, true);
    assert.equal(sent[0].prompt, markedPromptFor("in the centre of the frame"));
    assert.doesNotMatch(sent[0].prompt, /selected object/);
    const { data, info } = await sharp(sent[0].image).raw().toBuffer({ resolveWithObject: true });
    assert.ok(magenta(data, (20 * info.width + 25) * info.channels), "the subject is painted in the image sent");
    const worded = await museEditPlate(s.seed, s.mask, 64, 40, "deer", "in the centre of the frame", s.dir, opts, null, createMuseBudget(2));
    assert.equal(worded.ok, true);
    assert.match(sent[1].prompt, /^Remove the deer from this video frame completely/);
    assert.deepEqual(sent[1].image, fs.readFileSync(s.seed), "unmarked edits send the seed bytes");
    // an unusable mask falls back to the worded edit instead of failing the plate
    const fallback = await museEditPlate(s.seed, s.empty, 64, 40, "selected object", "in the centre of the frame", s.dir, opts, null, createMuseBudget(2), { mark: true });
    assert.equal(fallback.ok, true);
    assert.match(sent[2].prompt, /^Remove the selected object/);
  } finally { await fs.promises.rm(s.dir, { recursive: true, force: true }); }
});
