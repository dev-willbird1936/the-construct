"""The speed-ups of loop 2 change no result: windowed differences, the label cache, the smooth backdrop."""
import sys
import tempfile
import time
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_masks  # noqa: E402
import world_env  # noqa: E402
from world_common import Work, Camera  # noqa: E402


class WindowedDifference(unittest.TestCase):
    def test_window_matches_the_full_frame_inside_it(self):
        rng = np.random.default_rng(3)
        plate = rng.integers(0, 256, (90, 160, 3), dtype=np.uint8)
        frame = np.clip(plate.astype(int) * 1.1 + 5 + rng.normal(0, 4, plate.shape), 0, 255).astype(np.uint8)
        frame[30:60, 40:90] = 20
        free = np.ones((90, 160), bool)
        free[25:65, 35:95] = False
        full = world_masks.difference(frame, plate, free, top=80)
        for box in [(40, 30, 90, 60), (0, 0, 30, 20), (120, 50, 160, 90)]:
            part = world_masks.difference(frame, plate, free, top=80, window=box)
            x0, y0, x1, y1 = box
            np.testing.assert_array_equal(part[y0:y1, x0:x1], full[y0:y1, x0:x1])
            outside = np.ones(part.shape, bool)
            outside[y0:y1, x0:x1] = False
            self.assertFalse(part[outside].any())


class LabelCache(unittest.TestCase):
    def test_a_rewritten_label_is_read_again_and_callers_get_copies(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "labels").mkdir()
            (d / "tracks.json").write_text('{"fps": 15, "start": 0, "samples": 2, "width": 8, "height": 6, "tracks": []}')
            lab = np.zeros((6, 8), np.uint8)
            lab[1:3, 1:3] = 4
            cv2.imwrite(str(d / "labels" / "l00000.png"), lab)
            work = Work(d, "x.mp4")
            a = work.label(0)
            a[:] = 9                                   # a caller changing its copy
            self.assertEqual(int(work.label(0).max()), 4)
            time.sleep(0.02)
            lab[4, 4] = 7
            cv2.imwrite(str(d / "labels" / "l00000.png"), lab)
            self.assertEqual(int(work.label(0)[4, 4]), 7)
            self.assertIsNone(work.label(1))


class SmoothBackdrop(unittest.TestCase):
    def test_backdrop_never_comes_in_front_and_has_no_steps(self):
        cam = Camera(tan_y=0.4, src_w=160, src_h=90, scale=1.0)
        gd = np.full((60, 100), 4.0)
        gd[:, 50:] = 1.0                               # a near wall beside a far field
        gd[20:30, 20:24] = 0.5                         # a pole
        far = world_env.backdrop_disparity(cam, gd, np.ones_like(gd, bool))
        eroded = world_env.scale_disp_erode(cam.scale / gd, world_env.FAR_WINDOW)
        self.assertTrue((far <= eroded + 1e-9).all())
        self.assertTrue((far <= cam.scale / gd + 1e-9).all())
        self.assertLess(np.abs(np.diff(far, axis=1)).max(), np.abs(np.diff(eroded, axis=1)).max())


if __name__ == "__main__":
    unittest.main()
