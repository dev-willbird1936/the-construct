import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Loop 10 speedups in composite_lite.py must not change a pixel: the windowed
// tile shadow/hairline equals the canvas-wide one, and nanmedian0 equals
// np.nanmedian(axis=0) (odd and even counts, ties, all-NaN pixels).
const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const PY = process.env.BASIC_PYTHON || [path.join(ROOT, 'backend/pipeline/basic/.venv/Scripts/python.exe'), path.join(ROOT, 'backend/pipeline/basic/.venv/bin/python')].find((p) => nodeFs.existsSync(p));
const CHECK = `
import sys, importlib.util, warnings, numpy as np, cv2
spec = importlib.util.spec_from_file_location("c", sys.argv[1]); c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
rng = np.random.default_rng(7)
bad = 0
for t in range(200):
    k = int(rng.integers(1, 8)); a = (rng.random((k, 9, 11, 3)) * 255).astype(np.float32)
    if t % 2: a = np.round(a)
    a[rng.random(a.shape) < rng.random()] = np.nan
    with warnings.catch_warnings(), np.errstate(all="ignore"):
        warnings.simplefilter("ignore"); ref = np.nanmedian(a, axis=0)
    bad += not np.array_equal(ref, c.nanmedian0(a), equal_nan=True)
def old_place(canvas, disp01, dx, dy):
    th_, tw_ = disp01.shape[:2]
    tm = c.rounded_mask(th_, tw_, min(10, th_ // 2, tw_ // 2))
    sh = np.zeros(canvas.shape[:2], np.float32)
    sh[dy + 10:dy + 10 + th_, dx:dx + tw_] = tm.astype(np.float32)
    sh = cv2.GaussianBlur(sh, (0, 0), sigmaX=14)
    canvas -= canvas * (0.5 * sh)[..., None]
    canvas[dy:dy + th_, dx:dx + tw_] = disp01 * tm[..., None] + canvas[dy:dy + th_, dx:dx + tw_] * ~tm[..., None]
    full = np.zeros(canvas.shape[:2], np.uint8)
    full[dy:dy + th_, dx:dx + tw_] = tm.astype(np.uint8)
    ring = (cv2.dilate(full, np.ones((3, 3), np.uint8)) & ~full).astype(bool)
    canvas[ring] = canvas[ring] * 0.88 + 0.12
for (W, H, tw, th, dx, dy) in [(1920, 1080, 400, 300, 80, 60), (1080, 1350, 980, 600, 50, 700), (640, 360, 200, 120, 0, 0), (640, 360, 630, 340, 5, 5)]:
    tile = rng.random((th, tw, 3)).astype(np.float32)
    a = c.dark_canvas(W, H); b = a.copy()
    old_place(a, tile, dx, dy); c.place_tile(b, tile, dx, dy)
    bad += not np.array_equal(a, b)
print(bad)
`;

test('composite_lite.py speedups are pixel-identical (nanmedian0, windowed tile shadow)', { skip: !PY && 'no basic python' }, async () => {
  const { stdout } = await run(PY, ['-I', '-c', CHECK, path.join(ROOT, 'backend/app/composite_lite.py')], { timeout: 120000 });
  assert.equal(stdout.trim().split(/\r?\n/).pop(), '0');
});
