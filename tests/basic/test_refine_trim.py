"""Colour-gated boundary trim in plate.py refine-alpha (Lane A greenrim v1).
Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"))
from plate import _colour_trim  # noqa: E402


def scene():
    # Green field, brown body 40..80, a dark-grey 2 px antenna on top.
    bgr = np.zeros((120, 120, 3), np.uint8)
    bgr[:] = (40, 200, 60)
    bgr[40:80, 40:80] = (30, 80, 160)
    bgr[20:40, 59:61] = (60, 60, 60)
    return bgr


class ColourTrimTest(unittest.TestCase):
    def test_trims_overshoot_keeps_body_and_antenna(self):
        bgr = scene()
        mask = np.zeros((120, 120), bool)
        mask[38:82, 38:82] = True   # SAM overshoots 2 px into the grass
        mask[20:40, 59:61] = True   # thin antenna
        out, n = _colour_trim(bgr, mask)
        self.assertGreater(n, 0)
        self.assertFalse(out[38:40, 45:57].any())   # grass overshoot culled
        self.assertFalse(out[80:82, 45:75].any())
        self.assertTrue(out[40:80, 40:80].all())     # body intact (no erosion)
        self.assertTrue(out[20:40, 59:61].all())     # antenna: unlike grass, kept

    def test_grayscale_skips(self):
        bgr = scene()
        grey = np.repeat(bgr.mean(axis=2, keepdims=True).astype(np.uint8), 3, axis=2)
        mask = np.zeros((120, 120), bool)
        mask[38:82, 38:82] = True
        out, n = _colour_trim(grey, mask)
        self.assertEqual(n, 0)
        self.assertTrue((out == mask).all())


if __name__ == "__main__":
    unittest.main()
