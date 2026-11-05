"""The surround past the frame: world_inpaint.outpaint continues the picture a share of its size past every edge (a
data strip's rows continued too, not kept), and world_env.extend_disparity continues the backdrop's geometry there as
the planes it holds, not as a wall at the frame's edge."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_env  # noqa: E402
import world_inpaint  # noqa: E402


class Outpaint(unittest.TestCase):
    def test_the_picture_is_kept_and_continued(self):
        rng = np.random.default_rng(1)
        img = rng.integers(0, 255, (90, 160, 3), dtype=np.uint8)
        out = world_inpaint.outpaint(img, 0.25)
        mx, my = 40, 22                                          # round(160 * 0.25), round(90 * 0.25)
        self.assertEqual(out.shape, (90 + 2 * my, 160 + 2 * mx, 3))
        np.testing.assert_array_equal(out[my:my + 90, mx:mx + 160], img)

    def test_a_data_strip_is_continued_not_kept(self):
        img = np.full((90, 160, 3), 120, np.uint8)
        img[80:] = (255, 0, 255)                                 # a burnt-in strip in a colour the picture never has
        out = world_inpaint.outpaint(img, 0.25, top=80)
        np.testing.assert_array_equal(out[22:22 + 80, 40:200], img[:80])
        strip = out[22 + 80:22 + 90, 40:200].astype(int)
        self.assertGreater(np.abs(strip - np.array([255, 0, 255])).sum(axis=-1).mean(), 150)   # no magenta left


class ExtendDisparity(unittest.TestCase):
    def test_a_plane_goes_on_as_a_plane(self):
        h, w = 40, 60
        ys = np.arange(h)[:, None] * np.ones((1, w))
        disp = 0.2 + 0.02 * ys                                    # ground: disparity rising linearly toward the lens
        out = world_env.extend_disparity(disp, 10, 15)
        self.assertEqual(out.shape, (h + 20, w + 30))
        np.testing.assert_array_equal(out[10:10 + h, 15:15 + w], disp)
        below = out[10 + h:, 30]
        self.assertTrue(np.all(np.diff(below) > 0))               # keeps coming nearer, not a wall (edge repeat)
        self.assertGreater(below[-1], disp[-1, 30] + 0.1)

    def test_kept_within_the_frame_range(self):
        disp = np.linspace(0.1, 1.0, 30)[:, None] * np.ones((1, 20))
        out = world_env.extend_disparity(disp, 25, 5)              # wider than the picture is tall
        self.assertEqual(out.shape, (80, 30))
        self.assertGreaterEqual(out.min(), 0.05 - 1e-12)
        self.assertLessEqual(out.max(), 2.0 + 1e-12)


if __name__ == "__main__":
    unittest.main()
