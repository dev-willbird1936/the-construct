"""A crisp piece of the environment cut off from the rest by occlusion edges and smaller than world_env.ISLAND of the
grid is a fragment (foggy sky read as near, a twig): env_geometry drops it, and the backdrop shows there. A large
near surface, cut off the same way, stays."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_env  # noqa: E402
from world_common import Camera, Mesh  # noqa: E402


class Islands(unittest.TestCase):
    def test_small_pieces_go_large_ones_stay(self):
        cam = Camera(tan_y=0.4, src_w=640, src_h=360, scale=2.0)
        h, w = 72, 128
        depth = np.full((h, w), 3.0)
        depth[4:10, 40:46] = 1.0         # a speck of sky read as near: 4 quads of 2,205
        depth[40:72, 0:64] = 1.0         # a near bank: a quarter of the frame
        mesh = Mesh()
        world_env.env_geometry(mesh, cam, depth, np.zeros((h, w)), np.ones((h, w), bool), pad=0.5)
        (name, gw, gh, keep), _ = mesh.grids[0]
        self.assertEqual(name, "env")
        self.assertFalse(keep[2:5, 20:23].any())            # the speck is gone
        self.assertTrue(keep[22:34, 2:30].all())             # the bank stays
        self.assertTrue(keep[2:15, 40:60].all())             # and so does the far surface round the speck


if __name__ == "__main__":
    unittest.main()
