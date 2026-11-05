"""Windowed refine-alpha (tier-improve 2026-11-04, loop 9) is bit-identical to
the full-frame path: plate.py refine-alpha with BASIC_REFINE_WINDOW unset vs 0.
Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

BASIC = Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"
sys.path.insert(0, str(BASIC))
from plate import _refine_window, REFINE_WINDOW_MARGIN  # noqa: E402


def frames(root):
    # Textured colour scene: a brown subject with grass blades crossing it
    # (occluder pass), a speck, a subject cut by the left edge, a night-IR
    # (grey) frame and an empty mask.
    rng = np.random.default_rng(7)
    out = []
    for i in range(5):
        bgr = np.clip(rng.normal((60, 170, 70), 18, (180, 320, 3)), 0, 255).astype(np.uint8)
        mask = np.zeros((180, 320), np.uint8)
        x = 60 + 30 * i
        cv2.ellipse(bgr, (x + 40, 90), (38, 26), 0, 0, 360, (40, 90, 150), -1)
        cv2.ellipse(mask, (x + 40, 90), (40, 28), 0, 0, 360, 1, -1)
        cv2.line(bgr, (x + 20, 60), (x + 30, 120), (60, 190, 70), 2)  # blade in front
        mask[40:42, x + 90:x + 92] = 1  # speck
        if i == 1:  # cut by the left frame edge
            mask[:] = 0
            cv2.ellipse(bgr, (10, 100), (40, 30), 0, 0, 360, (40, 90, 150), -1)
            cv2.ellipse(mask, (10, 100), (42, 32), 0, 0, 360, 1, -1)
        if i == 3:  # night IR
            bgr = np.repeat(bgr.mean(axis=2, keepdims=True).astype(np.uint8), 3, axis=2)
        if i == 4:
            mask[:] = 0
        cv2.imwrite(str(root / f"kf_{i:05d}.jpg"), bgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
        cv2.imwrite(str(root / f"kf_{i:05d}.png"), mask)
        out.append(mask)
    return out


def refine(kf, out, window):
    env = dict(os.environ, BASIC_REFINE_WINDOW="1" if window else "0")
    got = subprocess.run([sys.executable, str(BASIC / "plate.py"), "refine-alpha", "--frames", str(kf),
                          "--labels", str(kf), "--ids", "1", "--out", str(out)],
                         env=env, capture_output=True, text=True, check=True)
    return json.loads(got.stdout.strip().splitlines()[-1])


class RefineWindowTest(unittest.TestCase):
    def test_window_matches_full_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            kf = root / "kf"
            kf.mkdir()
            frames(kf)
            full = refine(kf, root / "full", False)
            win = refine(kf, root / "win", True)
            self.assertEqual(full["files"], win["files"])
            self.assertEqual(full["empty"], win["empty"])
            self.assertEqual(full["colorTrimmedPx"], win["colorTrimmedPx"])
            self.assertEqual(full["occluderRemovedPx"], win["occluderRemovedPx"])
            for name in full["files"]:
                a = cv2.imread(str(root / "full" / name), cv2.IMREAD_UNCHANGED)
                b = cv2.imread(str(root / "win" / name), cv2.IMREAD_UNCHANGED)
                self.assertTrue(np.array_equal(a, b), name)

    def test_window_box(self):
        m = np.zeros((100, 200), bool)
        self.assertIsNone(_refine_window(m))
        m[50:60, 5:20] = True
        y0, y1, x0, x1 = _refine_window(m)
        self.assertEqual((y0, y1, x0, x1), (50 - REFINE_WINDOW_MARGIN, 100, 0, 20 + REFINE_WINDOW_MARGIN))


if __name__ == "__main__":
    unittest.main()
