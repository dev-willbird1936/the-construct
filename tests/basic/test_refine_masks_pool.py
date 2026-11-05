"""refine-masks runs its jobs on a few threads (tier-improve loop 11): the
masks and the per-job report must match one thread, in job order, and a bad
job still fails alone. Synthetic only."""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("plate_refine_pool", ROOT / "backend/pipeline/basic/plate.py")
plate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plate)


class RefineMasksPool(unittest.TestCase):
    def run_batch(self, folder, jobs, threads):
        path = folder / f"jobs-{threads}.json"
        path.write_text(json.dumps([dict(j, out=str(folder / f"{threads}-{i}.png")) for i, j in enumerate(jobs)]))
        old = os.environ.get("BASIC_THREADS")
        os.environ["BASIC_THREADS"] = str(threads)
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                plate.cmd_refine_masks(SimpleNamespace(jobs=str(path), w=96, h=54))
        finally:
            if old is None:
                os.environ.pop("BASIC_THREADS", None)
            else:
                os.environ["BASIC_THREADS"] = old
        return json.loads(buf.getvalue())["results"]

    def test_pool_matches_one_thread(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            rng = np.random.default_rng(5)
            jobs = []
            for i in range(7):
                mask = np.zeros((180, 320), np.uint8)
                cv2.circle(mask, (60 + 25 * i, 90), 30 + i, 1, -1)
                guide = cv2.GaussianBlur(rng.integers(0, 255, (180, 320), dtype=np.uint8), (0, 0), 3)
                cv2.imwrite(str(folder / f"m{i}.png"), mask)
                cv2.imwrite(str(folder / f"g{i}.png"), guide)
                jobs.append({"mask": str(folder / f"m{i}.png"), "guide": str(folder / f"g{i}.png"), "id": "1"})
            jobs.insert(3, {"mask": str(folder / "missing.png"), "guide": str(folder / "g0.png"), "id": "1"})
            one = self.run_batch(folder, jobs, 1)
            three = self.run_batch(folder, jobs, 3)
            self.assertEqual(one, three)
            self.assertIn("error", three[3])
            for i in range(len(jobs)):
                if i == 3:
                    continue
                self.assertEqual((folder / f"1-{i}.png").read_bytes(), (folder / f"3-{i}.png").read_bytes())


class MedianPool(unittest.TestCase):
    def test_threaded_median_blocks_match_one_thread(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            kf = folder / "kf"
            kf.mkdir()
            rng = np.random.default_rng(9)
            bg = cv2.GaussianBlur(rng.integers(0, 255, (120, 200, 3), dtype=np.uint8), (0, 0), 2)
            for i in range(9):
                frame = bg.copy()
                frame[40:80, 10 + 18 * i:40 + 18 * i] = (20, 200, 30)
                lab = np.zeros((120, 200), np.uint8)
                lab[40:80, 10 + 18 * i:40 + 18 * i] = 1
                cv2.imwrite(str(kf / f"kf_{i:05d}.jpg"), frame)
                cv2.imwrite(str(kf / f"kf_{i:05d}.png"), lab)
            old_block, old_env = plate.MEDIAN_BLOCK_PX, os.environ.get("BASIC_THREADS")
            plate.MEDIAN_BLOCK_PX = 2000  # 10-row blocks: many blocks in flight
            outs = {}
            try:
                for threads in (1, 3):
                    os.environ["BASIC_THREADS"] = str(threads)
                    out = folder / f"plate-{threads}.png"
                    args = SimpleNamespace(frames=str(kf), labels=str(kf), out=str(out), meta=str(folder / f"m{threads}.json"),
                                           width=200, dilate=2, holes=str(folder / f"h{threads}.png"))
                    with contextlib.redirect_stdout(io.StringIO()):
                        plate.cmd_median(args)
                    outs[threads] = (out.read_bytes(), (folder / f"h{threads}.png").read_bytes())
            finally:
                plate.MEDIAN_BLOCK_PX = old_block
                if old_env is None:
                    os.environ.pop("BASIC_THREADS", None)
                else:
                    os.environ["BASIC_THREADS"] = old_env
            self.assertEqual(outs[1], outs[3])


if __name__ == "__main__":
    unittest.main()
