"""Advanced matte occluder punch-out (backend/pipeline/basic/advanced/occluder.py).

Synthetic frames only: a tan subject disc on green grass with one green
blade crossing its edge must lose the blade and keep the disc; a blue
subject on grey (no grass) must come back unchanged."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic" / "advanced"))
from occluder import remove_occluders  # noqa: E402
from advanced_matte import drop_specks  # noqa: E402


def scene(subject_bgr, bg_bgr, blade_bgr=None):
    rng = np.random.default_rng(7)
    h = w = 160
    img = np.empty((h, w, 3), np.uint8)
    img[:] = bg_bgr
    img = np.clip(img.astype(int) + rng.integers(-6, 7, img.shape), 0, 255).astype(np.uint8)
    yy, xx = np.mgrid[:h, :w]
    disc = (yy - 80) ** 2 + (xx - 80) ** 2 <= 45 ** 2
    img[disc] = np.clip(np.array(subject_bgr) + rng.integers(-6, 7, (int(disc.sum()), 3)), 0, 255)
    alpha = disc.astype(np.float32)
    blade = np.zeros_like(disc)
    if blade_bgr is not None:
        blade = disc & (np.abs(xx - 52) <= 2) & (yy > 70)  # thin vertical blade touching the rim
        img[blade] = blade_bgr
    return img, alpha, disc, blade


class OccluderTest(unittest.TestCase):
    def test_green_blade_punched_disc_kept(self):
        img, alpha, disc, blade = scene((60, 120, 190), (40, 170, 60), blade_bgr=(45, 175, 65))
        out, rep = remove_occluders(img, alpha)
        self.assertLess(float(out[blade].mean()), 0.5)  # blade mostly removed
        core = disc & ~blade
        self.assertGreater(float(out[core].mean()), 0.97)  # subject kept
        self.assertGreater(rep["removed_px"], 0)

    def test_no_grass_is_noop(self):
        img, alpha, _, _ = scene((180, 90, 30), (128, 128, 128))
        out, rep = remove_occluders(img, alpha)
        self.assertEqual(rep["removed_px"], 0)
        self.assertTrue(np.allclose(out, alpha))


class SpeckTest(unittest.TestCase):
    def test_floating_speck_dropped_border_and_large_kept(self):
        a = np.zeros((200, 200), np.float32)
        a[40:160, 40:160] = 1.0   # body (14400 px)
        a[175:180, 90:95] = 1.0   # floating speck (25 px < 1%): dropped
        a[190:200, 0:6] = 1.0     # border piece (60 px): anatomy cut by the frame, kept
        a[10:30, 170:190] = 1.0   # 400 px (> 1%): a second object, kept
        out, dropped = drop_specks(a)
        self.assertEqual(dropped, 25)
        self.assertEqual(float(out[175:180, 90:95].max()), 0.0)
        self.assertTrue(np.all(out[190:200, 0:6] == 1.0))
        self.assertTrue(np.all(out[10:30, 170:190] == 1.0))
        self.assertTrue(np.all(out[40:160, 40:160] == 1.0))


if __name__ == "__main__":
    unittest.main()
