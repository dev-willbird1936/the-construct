"""The cache-friendly plate median must match the original sample-axis calculation."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "tools"))
import world_env


class PlateMedianTest(unittest.TestCase):
    def test_weighted_median_matches_original_with_ties_and_masks(self):
        rng = np.random.default_rng(41)
        n, h, w = 10, 12, 16
        frames = rng.integers(0, 16, (n, h, w, 3), dtype=np.uint8)
        masks = rng.random((n, h, w)) < 0.15
        masks[:, 0, 0] = False
        class Work:
            def __init__(self, folder):
                self.dir = Path(folder)
                self.n, self.h, self.w = n, h, w
            def frame(self, i): return frames[i]

        trust_px = world_env.TRUST_SHARE * h
        trust = np.stack([np.clip(cv2.distanceTransform((~m).astype(np.uint8), cv2.DIST_L2, 3), 0, trust_px) / trust_px * 255 for m in masks]).astype(np.uint8)
        trust[masks] = 0
        v = frames.astype(np.float32)
        wt = trust.astype(np.float32) + 1e-3 * (~masks)
        order = np.argsort(v, axis=0)
        vs = np.take_along_axis(v, order, axis=0)
        ws = np.take_along_axis(np.broadcast_to(wt[..., None], v.shape), order, axis=0)
        cs = np.cumsum(ws, axis=0)
        expected = np.take_along_axis(vs, (cs >= cs[-1:] / 2).argmax(axis=0)[None], axis=0)[0].astype(np.uint8)
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(world_env, "free_maps", return_value=(np.zeros((n, h // 4, w // 4), bool), None)), \
             patch.object(world_env, "choose_frames", return_value=np.arange(n)), \
             patch.object(world_env, "union_mask", side_effect=lambda work, i: masks[i]), \
             patch.object(world_env, "MIN_EVIDENCE", 0):
            plate, _, _ = world_env.build_plate(Work(folder), 1)
        np.testing.assert_array_equal(plate, expected)


class WeightedMedianDevices(unittest.TestCase):
    """the GPU and the CPU give the same plate to the last pixel (integer weights, exact sums)"""
    def sample(self):
        rng = np.random.default_rng(7)
        n, h, w = 24, 37, 53
        frames = rng.integers(0, 256, (n, h, w, 3), dtype=np.uint8)
        frames[:, :5] = frames[:, :5] // 32 * 32                  # many ties
        full = rng.random((n, h, w)) < 0.3
        full[:, 0, :4] = True                                       # pixels no moment saw
        trust = rng.integers(0, 256, (n, h, w), dtype=np.uint8)
        trust[full] = 0
        return frames, trust, full

    def test_cpu_rows_agree(self):
        frames, trust, full = self.sample()
        with patch.dict("os.environ", {"PLATE_GPU": "0"}):
            a = world_env.weighted_median(frames, trust, full)
            b = world_env.weighted_median(frames, trust, full, rows=11)
        np.testing.assert_array_equal(a, b)
        # where nothing was free, the smallest value
        np.testing.assert_array_equal(a[0, :4], frames[:, 0, :4].min(axis=0))

    def test_gpu_matches_cpu(self):
        try:
            import torch
            if not torch.cuda.is_available():
                self.skipTest("no CUDA")
        except ImportError:
            self.skipTest("no torch")
        frames, trust, full = self.sample()
        with patch.dict("os.environ", {"PLATE_GPU": "0"}):
            cpu = world_env.weighted_median(frames, trust, full)
        with patch.dict("os.environ", {"PLATE_GPU": "1"}):
            gpu = world_env.weighted_median(frames, trust, full, rows=9)
        np.testing.assert_array_equal(cpu, gpu)


if __name__ == "__main__":
    unittest.main()
