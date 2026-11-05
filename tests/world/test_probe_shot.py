"""probe-clip.py's shot test: a compilation's dissolve or scene cut is cut away, an animal never is."""
import importlib.util
import unittest
from pathlib import Path

import numpy as np

SOURCE = Path(__file__).resolve().parents[2] / "backend" / "tools" / "probe-clip.py"
spec = importlib.util.spec_from_file_location("probe_clip", SOURCE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

W, H = probe.SHOT_CELLS
FPS = probe.SHOT_FPS


def scene(seed):
    """a still picture of cells with texture, plus a little per-sample noise"""
    return np.random.default_rng(seed).uniform(30, 220, W * H).astype(np.float32)


def clip(seconds, seed=0, noise=1.5):
    base = scene(seed)
    n = int(seconds * FPS)
    rng = np.random.default_rng(seed + 100)
    return np.stack([base + rng.normal(0, noise, base.shape) for _ in range(n)]).astype(np.float32), n


def times(n):
    return np.arange(n) / FPS


class ShotSpanTest(unittest.TestCase):
    def test_one_still_shot_is_kept_whole(self):
        v, n = clip(7)
        self.assertIsNone(probe.shot_span(v, times(n), n / FPS))

    def test_dissolve_at_the_start_is_cut_away(self):
        v, n = clip(7)
        other = scene(9)
        for k in range(6):                       # 0.6 s dissolve from another camera
            a = 1 - k / 6
            v[k] = a * other + (1 - a) * v[k]
        span = probe.shot_span(v, times(n), n / FPS)
        self.assertIsNotNone(span)
        self.assertGreaterEqual(span[0], 0.3)
        self.assertLessEqual(span[0], 1.0)
        self.assertEqual(span[1], n / FPS)

    def test_a_dissolve_faint_tail_goes_too(self):
        v, n = clip(7)
        other = scene(9)
        mix = [1.0, 0.8, 0.6, 0.4, 0.25, 0.15]   # the last sample holds a seventh of the other shot (17 % of the cells)
        for k, a in enumerate(mix):
            v[k] = a * other + (1 - a) * v[k]
        span = probe.shot_span(v, times(n), n / FPS)
        self.assertGreaterEqual(span[0], len(mix) / FPS)

    def test_large_animal_at_the_end_is_not_a_dissolve(self):
        v, n = clip(8)
        ys, xs = np.divmod(np.arange(W * H), W)
        body = (np.abs(xs - W / 2) < W * 0.32) & (ys > H * 0.15)   # fills much of the frame, not all of it
        for k in range(n - 8, n):
            v[k, body] = 25.0
        self.assertIsNone(probe.shot_span(v, times(n), n / FPS))

    def test_scene_cut_keeps_the_longest_shot(self):
        a, na = clip(2, seed=1)
        b, nb = clip(5, seed=2)
        v = np.concatenate([a, b])
        span = probe.shot_span(v, times(len(v)), len(v) / FPS)
        self.assertEqual(span, [2.0, 7.0])

    def test_animal_passing_the_lens_is_not_a_cut(self):
        v, n = clip(6)
        ys, xs = np.divmod(np.arange(W * H), W)
        body = xs < W * 0.45                     # a bear walks past, covering the left of the picture
        for k in range(45, n):
            v[k, body] = 20.0 + (k % 3)
        self.assertIsNone(probe.shot_span(v, times(n), n / FPS))

    def test_too_short_a_shot_is_no_world(self):
        a, _ = clip(1.5, seed=1)
        b, _ = clip(1.5, seed=2)
        c, _ = clip(1.5, seed=3)
        v = np.concatenate([a, b, c])
        self.assertIsNone(probe.shot_span(v, times(len(v)), len(v) / FPS))


if __name__ == "__main__":
    unittest.main()
