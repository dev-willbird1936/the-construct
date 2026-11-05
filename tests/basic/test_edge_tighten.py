"""FREEZE v2: edge_tighten.match_edge routes tighten / defocus / noop (synthetic disc)."""
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic" / "advanced"))
from edge_defocus import matte_edge_width  # noqa: E402
from edge_tighten import match_edge  # noqa: E402


def disc(blur):
    a = np.zeros((160, 160), np.float32)
    cv2.circle(a, (80, 80), 45, 1.0, -1)
    return cv2.GaussianBlur(a, (0, 0), blur) if blur else a


class EdgeTightenTest(unittest.TestCase):
    def setUp(self):
        self.rgb = np.full((160, 160, 3), 90, np.uint8)
        self.fg = np.full((160, 160, 3), 200, np.uint8)

    def test_soft_matte_on_sharp_source_tightens(self):
        a = disc(1.6)
        out, fg, mode = match_edge(self.rgb, a, self.fg, source_width=1.0)
        self.assertEqual(mode, "tighten")
        self.assertLess(matte_edge_width(out)[0], matte_edge_width(a)[0])
        self.assertTrue(np.array_equal(fg, self.fg))

    def test_matched_matte_is_a_noop(self):
        a = disc(1.6)
        w = matte_edge_width(a)[0]
        out, _, mode = match_edge(self.rgb, a, self.fg, source_width=w)
        self.assertEqual(mode, "noop")
        self.assertTrue(np.array_equal(out, a))

    def test_empty_matte_is_a_noop(self):
        out, _, mode = match_edge(self.rgb, np.zeros((160, 160), np.float32), self.fg, source_width=1.0)
        self.assertEqual(mode, "noop")
        self.assertFalse(out.any())


if __name__ == "__main__":
    unittest.main()
