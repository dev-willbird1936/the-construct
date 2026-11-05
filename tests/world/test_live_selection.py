"""The live video paints out only the animals the customer picked: the rest of the pack stays as filmed."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_live  # noqa: E402
import world_env  # noqa: E402


class Work:
    def __init__(self):
        self.n, self.h, self.w, self.fps = 6, 120, 200, 15
        self.plate = np.full((self.h, self.w, 3), 100, np.uint8)
        self.lab = np.zeros((self.h, self.w), np.uint8)
        self.lab[30:60, 20:50] = 1        # the picked animal
        self.lab[30:60, 140:170] = 2      # one nobody picked

    def label(self, i):
        return self.lab

    def frame(self, i):
        f = self.plate.copy()
        f[self.lab == 1] = 20
        f[self.lab == 2] = 240
        return f


class LiveSelection(unittest.TestCase):
    def test_unpicked_animal_stays_in_the_footage(self):
        work = Work()
        painter = world_live.Painter(work, work.plate, 1.0, 60.0, tracks={1})
        out = painter.paint(work.frame(0), 0)
        self.assertTrue((out[35:55, 145:165] == 240).all())          # still there, untouched
        self.assertLess(np.abs(out[35:55, 25:45].astype(int) - 100).max(), 3)   # painted to the plate

    def test_without_a_selection_every_animal_goes(self):
        work = Work()
        out = world_live.Painter(work, work.plate, 1.0, 60.0).paint(work.frame(0), 0)
        self.assertLess(np.abs(out[35:55, 145:165].astype(int) - 100).max(), 3)
        self.assertLess(np.abs(out[35:55, 25:45].astype(int) - 100).max(), 3)

    def test_patch_follows_the_footage_light(self):
        """auto-exposure brightened the footage by 30 levels: the patch is not the plate's darker light"""
        work = Work()
        work.lab = work.lab.copy()
        work.lab[30:60, 140:170] = 0
        work.lab[30:60, 95:115] = 2                # a bright animal nobody picked, close by
        brighter = lambda i: np.where(work.lab[..., None] == 0, 130, Work.frame(work, i)).astype(np.uint8)
        work.frame = brighter
        out = world_live.Painter(work, work.plate, 1.0, 60.0, tracks={1}).paint(work.frame(0), 0)
        self.assertLess(np.abs(out[35:55, 25:45].astype(int) - 130).max(), 4)   # matched, and not pulled to 240
        self.assertTrue((out[35:55, 97:113] == 240).all())

    def test_patch_follows_a_light_gradient(self):
        work = Work()
        ramp = np.linspace(0, 40, work.w)[None, :, None]
        base = (work.plate.astype(float) + ramp).astype(np.uint8)
        work.frame = lambda i: np.where(work.lab[..., None] == 1, 20, base).astype(np.uint8)
        work.lab = np.where(work.lab == 1, 1, 0).astype(np.uint8)
        out = world_live.Painter(work, work.plate, 1.0, 60.0).paint(work.frame(0), 0).astype(int)
        self.assertLess(np.abs(out[35:55, 25:45] - base[35:55, 25:45]).max(), 5)

    def test_animals_helper(self):
        work = Work()
        self.assertEqual(int(world_env.animals(work, 0).sum()), 1800)
        self.assertEqual(int(world_env.animals(work, 0, {2}).sum()), 900)
        self.assertFalse(world_env.union_mask(work, 0, grow=5, tracks={1})[45, 155])


if __name__ == "__main__":
    unittest.main()
