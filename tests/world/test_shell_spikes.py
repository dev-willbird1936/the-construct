"""A shell's depth grid with no spikes (world_shells.despeckle, nearest_known): a thin part whose crop depth is the
background's takes the depth of the body around it, and a cell past the grown rim takes the nearest known depth,
so seen from aside a tine is a tine, not a fan reaching back to the trees."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_shells  # noqa: E402


class Despeckle(unittest.TestCase):
    def test_a_far_cell_in_the_body_takes_the_body_around_it(self):
        dg = np.full((12, 12), 0.20)
        dg[5, 5] = 0.30                                    # a tine read as the trees behind it
        dg[2, 8:10] = 0.29
        body = np.ones_like(dg, bool)
        out = world_shells.despeckle(dg, body, 0.20)
        self.assertAlmostEqual(out[5, 5], 0.20)
        np.testing.assert_allclose(out[2, 8:10], 0.20)

    def test_relief_is_kept(self):
        ys = np.arange(16)[:, None] * np.ones((1, 16))
        dg = 0.18 + 0.002 * ys                             # a body sloping away, 1 % of its depth per cell
        body = np.ones_like(dg, bool)
        np.testing.assert_allclose(world_shells.despeckle(dg, body, 0.2), dg)

    def test_only_body_cells_and_only_body_neighbours(self):
        dg = np.full((10, 10), 0.20)
        dg[:, 6:] = 0.50                                  # background beside the body: never a body cell's neighbour
        body = np.zeros_like(dg, bool)
        body[:, :6] = True
        out = world_shells.despeckle(dg, body, 0.20)
        np.testing.assert_allclose(out, dg)


class NearestKnown(unittest.TestCase):
    def test_unknown_cells_take_the_nearest_known_depth(self):
        dg = np.full((6, 8), 0.9)                          # the crop's own depth: the background
        known = np.zeros_like(dg, bool)
        known[:, :3] = True
        dg[:, :3] = np.array([0.2, 0.21, 0.22])
        out = world_shells.nearest_known(dg, known)
        np.testing.assert_allclose(out[:, 3:], 0.22)
        np.testing.assert_allclose(out[:, :3], dg[:, :3])

    def test_all_or_nothing_known_is_unchanged(self):
        dg = np.random.default_rng(0).random((5, 5))
        np.testing.assert_array_equal(world_shells.nearest_known(dg, np.ones((5, 5), bool)), dg)
        np.testing.assert_array_equal(world_shells.nearest_known(dg, np.zeros((5, 5), bool)), dg)


if __name__ == "__main__":
    unittest.main()
