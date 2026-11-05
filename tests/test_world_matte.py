"""Checks of the mask tidy and the colour carry (backend/tools/world_matte.py); no model needed.

  <da3 python> -I tests/test_world_matte.py
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "tools"))
import world_matte as WM  # noqa: E402


class Tidy(unittest.TestCase):
    def test_fills_holes_and_drops_specks(self):
        m = np.zeros((80, 80), bool)
        m[10:60, 10:60] = True
        m[30:34, 30:34] = False          # a hole in the pelt
        m[70:72, 70:72] = True           # a speck far away
        out = WM.tidy(m, np.zeros_like(m))
        self.assertTrue(out[31, 31])
        self.assertFalse(out[70, 70])

    def test_never_takes_a_neighbours_pixels(self):
        m = np.zeros((60, 60), bool)
        m[10:50, 10:25] = True
        m[10:50, 27:50] = True           # a hairline gap, closed by tidy
        other = np.zeros_like(m)
        other[10:50, 24:29] = True
        out = WM.tidy(m & ~other, other)
        self.assertFalse((out & other).any())


class TidyHoles(unittest.TestCase):
    """with the crop and the clean plate behind it, a hole that shows the scene stays open"""
    def ring(self):
        m = np.zeros((80, 80), bool)
        m[10:70, 10:70] = True
        m[30:50, 30:50] = False          # 400 px enclosed, like sky between antler tines
        return m

    def test_hole_showing_the_scene_stays_open(self):
        m = self.ring()
        bg = np.full((80, 80, 3), 200, np.uint8)          # bright sky
        rgb = bg.copy()
        rgb[m] = (60, 40, 30)                             # dark antler around it
        out = WM.tidy(m, np.zeros_like(m), rgb, bg)
        self.assertFalse(out[40, 40])
        self.assertTrue(out[15, 15])

    def test_hole_unlike_the_scene_is_filled(self):
        m = self.ring()
        bg = np.full((80, 80, 3), 200, np.uint8)
        rgb = np.zeros((80, 80, 3), np.uint8)
        rgb[:] = (60, 40, 30)                             # the hole is fur SAM missed
        out = WM.tidy(m, np.zeros_like(m), rgb, bg)
        self.assertTrue(out[40, 40])

    def test_animal_like_the_scene_cannot_tell_so_fills(self):
        m = self.ring()
        bg = np.full((80, 80, 3), 235, np.uint8)          # snow
        rgb = np.full((80, 80, 3), 238, np.uint8)         # a white wolf on it
        out = WM.tidy(m, np.zeros_like(m), rgb, bg)
        self.assertTrue(out[40, 40])

    def test_without_a_plate_holes_fill_as_before(self):
        m = self.ring()
        self.assertTrue(WM.tidy(m, np.zeros_like(m))[40, 40])


class CarryColour(unittest.TestCase):
    def test_edge_takes_the_body_colour(self):
        rgb = np.zeros((40, 40, 3), np.uint8)
        rgb[:] = (250, 250, 250)         # bright ground
        rgb[10:30, 10:30] = (40, 20, 10)  # dark animal
        alpha = np.zeros((40, 40), np.float32)
        alpha[10:30, 10:30] = 1.0
        alpha[8:10, 10:30] = 0.5         # a soft rim of ground-coloured pixels
        out = WM.carry_colour(rgb, alpha)
        # exactly the body's colour: none of the bright ground just past the rim (a light halo off the sky)
        self.assertLessEqual(np.abs(out[8:10, 12:28].astype(int) - (40, 20, 10)).max(), 2)
        self.assertEqual(tuple(out[0, 0]), (250, 250, 250))   # far from the animal the crop is untouched

    def test_each_edge_takes_the_body_colour_nearest_it(self):
        rgb = np.full((40, 60, 3), 250, np.uint8)
        rgb[10:30, 10:30] = (200, 0, 0)  # a red half
        rgb[10:30, 30:50] = (0, 0, 200)  # and a blue half
        alpha = np.zeros((40, 60), np.float32)
        alpha[10:30, 10:50] = 1.0
        alpha[8:10, 10:50] = 0.4
        out = WM.carry_colour(rgb, alpha)
        self.assertEqual(tuple(out[9, 12]), (200, 0, 0))
        self.assertEqual(tuple(out[9, 47]), (0, 0, 200))


if __name__ == "__main__":
    unittest.main()
