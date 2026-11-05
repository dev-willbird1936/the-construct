import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { trailFrames, atlasGrid, packChronoAtlas, ATLAS_MAX_SIDE, TRAIL_TOTAL } from '../../backend/app/atlas.js';
import { rowDir, TRAVEL_FLIP } from '../../backend/app/runner-lite.js';

// Dense ghost trail (user feedback, 2026-11-04: "7 separate cats, no ghost
// trail"): the pack adds the tracked frames between poses (atlas.json
// `trail`), and volume.js draws them as one long exposure behind the solid
// now-pose. Old atlases have no trail and draw exactly as before.
const sharp = createRequire(new URL('../../backend/app/atlas.js', import.meta.url))('sharp');
const source = (await fs.readFile(new URL('../../volume.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const from = source.indexOf('export function chronoTrail(');
const to = source.indexOf('function ghostGrade(', from);
assert.ok(from >= 0 && to > from, 'trail helpers block');
const vol = vm.runInNewContext(`${source.slice(from, to).replace(/^export /gm, '')}\n({ chronoTrail, trailAlpha, strobeSelect, trailPoint, trailSize, TRAIL_NEAR, TRAIL_FAR, TRAIL_DARK_FAR, TRAIL_SIZE_MIN });`, { Number, Math, Array });

const scan = (solid = 100, touch = 0) => ({ solid, touch });

test('trailFrames fills each gap between poses with the usable frames nearest to even times', () => {
  const scans = Array.from({ length: 40 }, () => scan());
  scans[12] = scan(5); // a tiny mask (lost track) never joins the trail
  const ts = scans.map((_, i) => i / 10);
  const picked = [0, 13, 26, 39];
  const out = trailFrames(scans, picked, ts, { total: 22, perGap: 6 });
  assert.equal(out.length, 18, 'six per gap');
  assert.ok(!out.some((f) => f.index === 12));
  assert.ok(!out.some((f) => picked.includes(f.index)), 'poses are not repeated');
  for (let k = 1; k < out.length; k += 1) assert.ok(out[k].at > out[k - 1].at, 'in time order');
  for (const f of out) {
    const g = Math.floor(f.at);
    assert.ok(f.at > 0 && f.at < picked.length - 1);
    assert.ok(f.index > picked[g] && f.index < picked[g + 1], 'inside its own gap');
    assert.ok(Math.abs(f.at - (g + (ts[f.index] - ts[picked[g]]) / (ts[picked[g + 1]] - ts[picked[g]]))) < 1e-9);
  }
  assert.deepEqual(trailFrames(scans, [5], ts), [], 'one pose: no trail');
  assert.deepEqual(trailFrames(scans, [0, 5], ts, { total: 2 }), [], 'total not above the pose count: no trail');
});

test('atlasGrid picks the squarest grid and keeps the texture side under the cap', () => {
  const g = atlasGrid(43, 336, 318);
  assert.ok(g.cols * g.rows >= 43);
  assert.ok(g.cols * g.cellW <= ATLAS_MAX_SIDE && g.rows * g.cellH <= ATLAS_MAX_SIDE);
  assert.ok(Math.abs(g.cellW / g.cellH - 336 / 318) < 0.02, 'cell aspect kept');
  const small = atlasGrid(7, 100, 80);
  assert.deepEqual([small.cellW, small.cellH], [100, 80], 'small atlases are never scaled');
});

async function walkPng(i) {
  // A 24x20 opaque block walking right across a 160x60 frame.
  const w = 160, h = 60, buf = Buffer.alloc(w * h * 4, 0);
  for (let y = 20; y < 40; y += 1) for (let x = 10 + i * 4; x < 34 + i * 4; x += 1) {
    const o = (y * w + x) * 4; buf[o] = 90; buf[o + 1] = 60; buf[o + 2] = 30; buf[o + 3] = 255;
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

test('packChronoAtlas writes a trail of tracked frames between the poses; trail: 0 packs as before', async () => {
  const slices = [];
  for (let i = 0; i < 24; i += 1) slices.push({ buffer: await walkPng(i), timestamp: i / 12, sourceFrameIndex: i, concept: 'block' });
  const packed = await packChronoAtlas(slices, { cell: 48, maxPoses: 5 });
  const n = packed.poses.length;
  assert.ok(packed.trail, 'trail written');
  const { cells, at, bottom } = packed.trail;
  assert.equal(cells.length, at.length);
  assert.equal(cells.length, bottom.length);
  assert.ok(cells.length > n, `denser than the poses (${cells.length} trail frames, ${n} poses)`);
  assert.ok(cells.length + n <= TRAIL_TOTAL);
  for (let k = 0; k < cells.length; k += 1) {
    assert.ok(Number.isInteger(cells[k]) && cells[k] >= 0 && cells[k] < packed.cols * packed.rows);
    assert.ok(at[k] > 0 && at[k] < n - 1);
    assert.ok(bottom[k] > 0 && bottom[k] <= 1);
  }
  assert.ok(packed.cols * packed.cellW <= ATLAS_MAX_SIDE && packed.rows * packed.cellH <= ATLAS_MAX_SIDE);
  assert.ok(packed.frameTravel > 0, 'the block walks right');
  assert.equal(packed.trail.fit.length, cells.length);
  assert.equal(packed.trail.poseFit.length, n);
  for (const f of [...packed.trail.fit, ...packed.trail.poseFit]) assert.ok(f > 0, 'every cell records its enlargement');
  const plain = await packChronoAtlas(slices, { cell: 48, maxPoses: 5, trail: 0 });
  assert.equal(plain.trail, null);
  assert.deepEqual(plain.poses, packed.poses, 'the poses do not change');
});

test('chronoTrail reads only well-formed trails; old atlases have none', () => {
  assert.equal(vol.chronoTrail({ count: 7 }), null);
  assert.equal(vol.chronoTrail({ count: 1, trail: { cells: [3], at: [0.5] } }), null);
  assert.equal(vol.chronoTrail({ count: 7, trail: { cells: [3, 4], at: [0.5] } }), null, 'length mismatch');
  const t = vol.chronoTrail({ count: 4, trail: { cells: [9, 7, 8, -1, 5], at: [2.5, 0.5, 1.5, 1.2, 3], bottom: [0.9, 2, null, 1, 1], fit: [1.5, 0, null, 1, 1] } });
  assert.deepEqual(JSON.parse(JSON.stringify(t)), [
    { cell: 7, at: 0.5, bottom: 1, fit: null },
    { cell: 8, at: 1.5, bottom: 1, fit: null },
    { cell: 9, at: 2.5, bottom: 0.9, fit: 1.5 },
  ], 'sorted by time; bad cells and out-of-row times dropped; bottom clamped; a bad fit is none');
});

test('ghost opacity ramps from just behind the now-pose down to 0.12-0.2 at the first card', () => {
  assert.ok(Math.abs(vol.trailAlpha(0) - vol.TRAIL_NEAR) < 1e-9);
  assert.ok(Math.abs(vol.trailAlpha(1) - vol.TRAIL_FAR) < 1e-9);
  assert.ok(vol.TRAIL_FAR >= 0.12 && vol.TRAIL_FAR <= 0.2 && vol.TRAIL_NEAR < 1);
  for (let k = 0; k < 10; k += 1) assert.ok(vol.trailAlpha((k + 1) / 10) < vol.trailAlpha(k / 10));
  // A dark subject keeps every ghost more opaque, still within the same range at the start.
  for (let k = 0; k <= 10; k += 1) assert.ok(vol.trailAlpha(k / 10, true) > vol.trailAlpha(k / 10));
  assert.ok(vol.TRAIL_DARK_FAR >= 0.12 && vol.TRAIL_DARK_FAR <= 0.2);
});

test('strobeSelect spreads the extra cards over the gaps, each gap at even times', () => {
  // 4 poses (3 gaps), five frames per gap at 0.1 steps.
  const ats = [];
  for (let g = 0; g < 3; g += 1) for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) ats.push(g + f);
  const pick = (n) => Array.from(vol.strobeSelect(ats, 4, n), (j) => ats[j]);
  assert.deepEqual(pick(4), [], 'as many cards as poses: no frames');
  assert.deepEqual(pick(7), [0.5, 1.5, 2.5], 'one per gap: the middle frame');
  assert.deepEqual(pick(8), [0.5, 1.5, 2.3, 2.7], 'the remainder goes to the gap nearest the now-pose');
  assert.deepEqual(pick(10), [0.3, 0.7, 1.3, 1.7, 2.3, 2.7]);
  assert.equal(pick(40).length, 15, 'never more frames than exist');
  assert.equal(vol.strobeSelect(ats, 1, 10).length, 0, 'one pose has no gaps');
});

test('trailSize draws a card at its source size beside the now-pose, never larger than its cell', () => {
  // The now-pose's box took in spray (enlarged 0.61x); a clean frame of the same bear was enlarged 1.5x.
  assert.ok(Math.abs(vol.trailSize(0.61, 1.5) - 0.61 / 1.5) < 1e-9);
  assert.equal(vol.trailSize(2, 1), 1, 'capped at the cell-filling size');
  assert.equal(vol.trailSize(0.1, 2), vol.TRAIL_SIZE_MIN);
  assert.equal(vol.trailSize(null, 1.2), 1, 'old trails without fits keep their size');
  assert.equal(vol.trailSize(1, undefined), 1);
});

test('trailPoint interpolates between the displayed poses that bracket a frame', () => {
  const display = [{ order: 0, x: -2, z: 0 }, { order: 2, x: 0, z: 1 }, { order: 3, x: 1, z: 1 }];
  assert.deepEqual({ ...vol.trailPoint(display, 1) }, { x: -1, z: 0.5 });
  assert.deepEqual({ ...vol.trailPoint(display, 2.5) }, { x: 0.5, z: 1 });
  assert.equal(vol.trailPoint(display, 3.5), null, 'past the last displayed pose');
});

test('rowDir lays the row right-to-left only for a subject that travelled left', () => {
  assert.equal(rowDir(-0.5), -1);
  assert.equal(rowDir(-TRAVEL_FLIP / 2), 1, 'a stationary subject keeps left-to-right');
  assert.equal(rowDir(0.3), 1);
  assert.equal(rowDir(null, -0.4), -1, 'no registered plate: the frame travel decides');
  assert.equal(rowDir(undefined, 0.4), 1);
  assert.equal(rowDir(null, null), 1);
});
