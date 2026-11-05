"""A pick read as a group lifts the members mostly in view (world_masks.in_view, keep_in_view): a member cut by the
frame's edge, or half hidden behind another animal, for most of the samples it is seen in stays in the footage."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_masks  # noqa: E402


class FakeWork:
    def __init__(self, labels):
        self.labels = labels
        self.n = len(labels)
        self.h, self.w = labels[0].shape

    def label(self, i):
        return self.labels[i].copy()


def frames(n, h=120, w=200, draw=None):
    out = []
    for i in range(n):
        lab = np.zeros((h, w), np.uint8)
        draw(lab, i)
        out.append(lab)
    return out


class InView(unittest.TestCase):
    def test_whole_animals_are_in_view(self):
        def draw(lab, i):
            lab[40:70, 20 + i:60 + i] = 1          # walks along, well inside the picture
            lab[30:60, 120:150] = 2
        shares = world_masks.in_view(FakeWork(frames(10, draw=draw)), [1, 2])
        self.assertEqual({t: s for t, (s, _) in shares.items()}, {1: 1.0, 2: 1.0})

    def test_cut_by_the_frame_edge(self):
        def draw(lab, i):
            lab[40:70, 0:30] = 3                   # half outside the left edge, every sample
            lab[40:70, 100:140] = 4
            if i < 3:
                lab[10:30, 170:200] = 5           # at the right edge for 3 of 10 samples
            else:
                lab[10:30, 150:180] = 5
        shares = world_masks.in_view(FakeWork(frames(10, draw=draw)), [3, 4, 5])
        self.assertEqual(shares[3][0], 0.0)
        self.assertEqual(shares[4][0], 1.0)
        self.assertAlmostEqual(shares[5][0], 0.7)
        self.assertEqual(world_masks.keep_in_view(shares), {4, 5})

    def test_a_data_strip_is_the_picture_edge(self):
        def draw(lab, i):
            lab[80:100, 50:90] = 1                 # standing on the strip's top row (overlay 0.8 of 120 rows = 96)
        shares = world_masks.in_view(FakeWork(frames(4, draw=draw)), [1], overlay=0.8)
        self.assertEqual(shares[1][0], 0.0)
        self.assertEqual(world_masks.in_view(FakeWork(frames(4, draw=draw)), [1])[1][0], 1.0)

    def test_half_hidden_behind_another(self):
        def draw(lab, i):
            lab[40:70, 60:100] = 2                 # wolf 2: whole for 4 samples, then mostly behind wolf 1
            lab[40:70, 20:50] = 1                 # wolf 1, whole, against wolf 2 only when it covers it
            if i >= 4:
                lab[40:70, 50:85] = 1              # wolf 1 walks over the front half of wolf 2
        shares = world_masks.in_view(FakeWork(frames(10, draw=draw)), [1, 2])
        self.assertEqual(shares[1][0], 1.0)        # in front: at its full size whenever it touches wolf 2
        self.assertAlmostEqual(shares[2][0], 0.4)  # behind for 6 of 10: 15 of 40 columns left

    def test_smaller_because_farther_is_not_hidden(self):
        def draw(lab, i):
            s = 4 + 2 * i                           # walks towards the camera, growing, near no other animal
            lab[50:50 + s, 80:80 + 2 * s] = 1
        shares = world_masks.in_view(FakeWork(frames(10, draw=draw)), [1])
        self.assertEqual(shares[1][0], 1.0)

    def test_none_in_view_keeps_the_group(self):
        shares = {7: (0.2, 30), 8: (0.0, 12)}
        self.assertEqual(world_masks.keep_in_view(shares), {7, 8})

    def test_unknown_or_tiny_ids_are_left_out(self):
        def draw(lab, i):
            lab[40:70, 40:80] = 1
            lab[10, 10] = 2                        # one pixel: under min_area
        shares = world_masks.in_view(FakeWork(frames(3, draw=draw)), [1, 2, 9], min_area=4)
        self.assertEqual(set(shares), {1})


if __name__ == "__main__":
    unittest.main()
