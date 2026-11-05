"""Tests for sharpness.py local-motion mode (BLUR-KF-V1)."""
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend", "pipeline", "basic"))

from sharpness import FLOW_SHARE_PX, flow_pair_speed, local_motion  # noqa: E402


def checker(size=240, squares=12):
    cell = size // squares
    board = (np.indices((squares, squares)).sum(axis=0) % 2 * 255).astype(np.uint8)
    return np.repeat(np.repeat(board, cell, axis=0), cell, axis=1)


def shift(img, dx):
    m = np.float32([[1, 0, dx], [0, 1, 0]])
    return cv2.warpAffine(img, m, (img.shape[1], img.shape[0]),
                          flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_REPLICATE)


def interior():
    m = np.zeros((240, 240), bool)
    m[40:200, 40:200] = True
    return m


class TestLocalMotion(unittest.TestCase):
    def test_still_pair_scores_near_zero(self):
        a = checker()
        p95, frac = flow_pair_speed(a, a, interior())
        self.assertLess(p95, 0.5)
        self.assertEqual(frac, 0.0)

    def test_global_shift_reads_shift_with_full_share(self):
        a = checker()
        p95, frac = flow_pair_speed(a, shift(a, 6), interior())
        self.assertGreater(p95, 0.8 * 6)
        self.assertLess(p95, 1.2 * 6)
        self.assertGreater(frac, 0.8)

    def test_sub_threshold_shift_stays_out_of_share(self):
        a = checker()
        p95, frac = flow_pair_speed(a, shift(a, 1), interior())
        self.assertLess(p95, FLOW_SHARE_PX)
        self.assertEqual(frac, 0.0)

    def test_motion_outside_mask_does_not_leak_in(self):
        a = checker()
        b = a.copy()
        rng = np.random.default_rng(3)
        # Change only pixels outside the interior mask.
        outside = np.zeros_like(b, bool)
        outside[200:, :] = True
        noisy = rng.integers(0, 256, b.shape).astype(np.uint8)
        b[outside] = noisy[outside]
        p95, frac = flow_pair_speed(a, b, interior())
        self.assertLess(p95, 1.0)
        self.assertLess(frac, 0.05)

    def test_local_motion_takes_max_over_directions(self):
        a = checker()
        m = interior()
        p95, frac = local_motion(a, a, shift(a, 6), m)  # still behind, jump ahead
        self.assertGreater(p95, 4.0)
        p95b, _ = local_motion(shift(a, 6), a, a, m)  # jump behind, still ahead
        self.assertGreater(p95b, 4.0)
        p95c, fracc = local_motion(a, a, a, m)
        self.assertLess(p95c, 0.5)
        self.assertEqual(fracc, 0.0)

    def test_local_motion_tolerates_clip_edges(self):
        a = checker()
        p95, frac = local_motion(None, a, None, interior())
        self.assertEqual((p95, frac), (0.0, 0.0))


if __name__ == "__main__":
    unittest.main()
