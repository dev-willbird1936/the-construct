import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { osdTopShare, detectOsdBar } from '../../backend/lib/lite-decode.js';
import { scanSlice } from '../../backend/app/atlas.js';

// Burnt-in data bar (port of backend/tools/probe-clip.py strip + letterbox):
// cut only a real bottom bar, never a clip without one.
const W = 640, H = 360;
function frame(seed, { bar = 0, text = false, letterbox = 0 } = {}) {
  const f = Buffer.alloc(W * H * 3);
  let r = seed * 9301 + 49297;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    r = (r * 9301 + 49297) % 233280;
    const v = 60 + Math.round(60 * Math.sin(x / 23 + y / 31)) + (r % 25);
    const o = (y * W + x) * 3;
    f[o] = v; f[o + 1] = v + 10; f[o + 2] = v - 10;
  }
  const y0 = H - letterbox;
  if (bar) for (let y = y0 - bar; y < y0; y += 1) for (let x = 0; x < W; x += 1) {
    const o = (y * W + x) * 3;
    const ink = text && y > y0 - bar + 4 && y < y0 - 4 && (x % 9 < 3) && x > 300;
    f[o] = f[o + 1] = f[o + 2] = ink ? 240 : 12;
  }
  for (let y = y0; y < H; y += 1) f.fill(0, y * W * 3, (y + 1) * W * 3);
  return f;
}
const five = (opts) => [1, 2, 3, 4, 5].map((s) => frame(s, opts));

test('no bar: the picture is never cropped', () => {
  assert.equal(osdTopShare(five()), 1);
  assert.equal(osdTopShare(five({ letterbox: 30 })), 1, 'a black letterbox is not a data bar');
});

test('a dark bar with lettering along the bottom is found at its top edge', () => {
  const share = osdTopShare(five({ bar: 24, text: true }));
  assert.ok(share < 1 && Math.abs(share - (H - 24) / H) < 0.03, `share ${share}`);
});

test('a bar taller than 15% of the frame is picture, not a data strip', () => {
  assert.equal(osdTopShare(five({ bar: 80 })), 1);
});

test('real clips: the trail camera bar is cut, a clip without one is not (same as probe-clip.py)', async () => {
  const probe = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=width,height,nb_read_packets', '-of', 'csv=p=0', f]).toString().trim().split(',').map(Number);
  const grizzly = new URL('../../assets/clips/trailcam/grizzly.mp4', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const muntjac = new URL('../../assets/corpus/muntjac.mp4', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  let [w, h, n] = probe(grizzly);
  const g = await detectOsdBar(grizzly, { frames: n, width: w, height: h });
  assert.equal(g.share, 0.911); assert.equal(g.cutY, 654);
  [w, h, n] = probe(muntjac);
  assert.deepEqual(await detectOsdBar(muntjac, { frames: n, width: w, height: h }), { share: 1, cutY: null });
  assert.deepEqual(await detectOsdBar('missing.mp4', { frames: 100, width: 64, height: 48 }), { share: 1, cutY: null }, 'a failed probe is no bar');
});

test('scanSlice: a subject cut at the bar touches the picture edge', () => {
  const w = 20, h = 20, data = Buffer.alloc(w * h * 4);
  for (let y = 8; y < 16; y += 1) for (let x = 5; x < 12; x += 1) data[(y * w + x) * 4 + 3] = 255;
  assert.equal(scanSlice(data, w, h).touch, 0);
  assert.ok(scanSlice(data, w, h, { bottom: 16 }).touch > 0.2);
});
