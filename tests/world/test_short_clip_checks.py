"""A short clip's live checks (world_checks.live_metrics): every moment measured lies inside the clip, so a 2 s world
builds instead of stopping on a moment past its last frame; a clip of 4 s or more keeps its moments as before."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_checks  # noqa: E402


class ShortClip(unittest.TestCase):
    def run_checks(self, seconds):
        fps, size = 15, 64
        plate = np.full((size, size, 3), 100, np.uint8)
        asked = []

        def decode(path, frames, width, height, start=0.0, fps=None):
            asked.append(start)
            left = max(0, int(round((seconds - start) * 30)))    # a stream ends at its last frame
            return np.repeat(plate[None], min(frames, left), axis=0)

        label = np.zeros((size, size), np.uint8)
        label[10:50, 10:50] = 1
        work = SimpleNamespace(w=size, h=size, n=int(seconds * fps), fps=fps, start=0, clip="synthetic",
                               label=lambda i: label)
        real = world_checks.decode
        world_checks.decode = decode
        try:
            out = world_checks.live_metrics(work, plate, "synthetic-live", 1.0)
        finally:
            world_checks.decode = real
        return out, asked

    def test_a_two_second_clip_is_measured_inside_itself(self):
        (residue, liveness), asked = self.run_checks(2.0)
        self.assertTrue(all(0 < t < 2.0 for t in asked))
        self.assertEqual(residue, 0.0)
        self.assertIsNotNone(liveness)

    def test_four_seconds_and_more_keep_their_moments(self):
        for seconds in (4.0, 6.0, 8.0):
            with self.subTest(seconds=seconds):
                _, asked = self.run_checks(seconds)
                np.testing.assert_allclose(sorted(set(asked)), np.unique(np.linspace(2, seconds - 2, 10)))


if __name__ == "__main__":
    unittest.main()
