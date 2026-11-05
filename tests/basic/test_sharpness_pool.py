"""sharpness.py scores samples in a thread pool (tier-improve loop 11): the
output must be identical to one worker, for the snap and the --local pass.
Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

BASIC = Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"
sys.path.insert(0, str(BASIC))
import sharpness  # noqa: E402


def clip(d, n=14, w=160, h=96):
    path = os.path.join(d, "v.avi")
    out = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), 15, (w, h))
    rng = np.random.default_rng(3)
    bg = rng.integers(0, 255, (h, w, 3), dtype=np.uint8)
    os.makedirs(os.path.join(d, "labels"))
    for i in range(n):
        f = bg.copy()
        x = 20 + 6 * i
        f[30:70, x:x + 40] = rng.integers(0, 255, (40, 40, 3), dtype=np.uint8)  # a textured, moving subject
        out.write(f)
        lab = np.zeros((h, w), np.uint8)
        lab[30:70, x:x + 40] = 1
        cv2.imwrite(os.path.join(d, "labels", f"l{i:05d}.png"), lab)
    out.release()
    with open(os.path.join(d, "map.json"), "w") as fh:
        json.dump({str(i): i for i in range(1, n - 1)}, fh)
    return path


class PoolMatchesSerial(unittest.TestCase):
    def run_main(self, d, video, threads, local):
        argv = ["--video", video, "--labels", os.path.join(d, "labels"), "--ids", "1", "--map", os.path.join(d, "map.json")]
        if local:
            argv.append("--local")
        old, buf = os.environ.get("BASIC_THREADS"), io.StringIO()
        os.environ["BASIC_THREADS"] = str(threads)
        try:
            with contextlib.redirect_stdout(buf):
                sharpness.main(argv)
        finally:
            if old is None:
                os.environ.pop("BASIC_THREADS", None)
            else:
                os.environ["BASIC_THREADS"] = old
        return buf.getvalue()

    def test_snap_and_local_scores_identical(self):
        with tempfile.TemporaryDirectory() as d:
            video = clip(d)
            for local in (False, True):
                serial = self.run_main(d, video, 1, local)
                pooled = self.run_main(d, video, 4, local)
                self.assertEqual(serial, pooled)
                self.assertEqual(len(json.loads(serial)["scores"]), 12)


if __name__ == "__main__":
    unittest.main()
