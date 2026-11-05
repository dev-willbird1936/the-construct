"""Tests for behind.py (layered disocclusion fill). Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

BASIC = Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"
BEHIND_PY = BASIC / "behind.py"


def run(*args):
    r = subprocess.run([sys.executable, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"{args} failed:\n{r.stderr[-2000:]}")
    return r


def make_fixture(root):
    # working 96x64, layout cols 2, cells 48x32, 2 keyframes, seed = sample 0
    W, H, cw, ch, cols = 96, 64, 48, 32, 2
    spec = {
        "working": {"width": W, "height": H},
        "layout": {"cols": cols, "rows": 1, "dRows": 2, "cellW": cw, "cellH": ch},
        "keyframes": [{"sample": 0}, {"sample": 1}],
        "plate": {"validation": {"seedSample": 0}},
        "depth": {"min": 0.0, "max": 1.0},
        "files": {"plate": "plate.webp", "subject": "subject.webp", "depth": "depth.webp"},
    }
    (root / "specimen.json").write_text(json.dumps(spec))
    # plate: dark left / bright right step at x=48 (a depth edge) + a pale
    # horizontal bar (a median-residue "snake") across the dark side
    # plate: uniform dark + a pale horizontal bar (a median-residue
    # "snake": 72x8, aspect 9 so it survives the halo + aspect gate).
    # Depth is uniform: bands come from the silhouette ring alone, so no
    # step-blur halo can merge with the bar into one blobby component.
    plate = np.zeros((H, W, 3), np.uint8)
    plate[:, :] = (50, 50, 50)
    plate[40:48, 4:76] = (130, 130, 130)
    cv2.imwrite(str(root / "plate.webp"), plate)
    # depth atlas: cell 0 = uniform plate depth (no step needed)
    depth = np.zeros((64, 96), np.uint8)
    depth[0:32, :] = 51
    cv2.imwrite(str(root / "depth.webp"), depth)
    # subject atlas: cell 0 = seed silhouette (small corner disc, alpha
    # 255), gray rgb. Kept small and cornered so the silhouette-dilate
    # exclusion cannot swallow the snake bar in this tiny frame.
    subj = np.zeros((32, 96, 4), np.uint8)
    cv2.circle(subj, (8, 8), 6, (180, 180, 180, 255), -1)
    cv2.imwrite(str(root / "subject.webp"), subj)


class BehindTest(unittest.TestCase):
    def test_builds_canvas_alpha_and_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_fixture(root)
            r = run(str(BEHIND_PY), str(root))
            report = json.loads(r.stdout.strip().split("\n")[-1])
            for key in ("edgePx", "bandPx", "silPx", "canvas", "ghostBlobs", "ghostShare", "seconds"):
                self.assertIn(key, report)
            # expanded canvas is 1.3x the working frame
            self.assertEqual(report["canvas"], [125, 83])
            # the depth step is a strong-tier edge: bands exist
            self.assertGreater(report["bandPx"], 0)
            # the pale bar is a long-thin smooth bias: ghost metric fires
            self.assertGreaterEqual(report["ghostBlobs"], 1)
            self.assertGreater(report["ghostShare"], 0)
            behind = cv2.imread(str(root / "behind.webp"))
            self.assertEqual((behind.shape[1], behind.shape[0]), (125, 83))
            alpha = cv2.imread(str(root / "plateAlpha.png"), cv2.IMREAD_GRAYSCALE)
            self.assertEqual(alpha.shape, (64, 96))
            # border feather: frame edge is 0, interior is opaque
            self.assertEqual(int(alpha[0, 48]), 0)
            self.assertEqual(int(alpha[32, 48]), 255)
            # surround is filled (no black corners): mean of a corner patch
            corner = behind[0:10, 0:10].astype(float).mean()
            self.assertGreater(corner, 20)

    def test_far_field_ring_keeps_plate(self):
        # Smear fix: silhouette-ring inpaint only in the near field. A
        # checkered plate around the subject disc survives when that region
        # is far-field relief (left half deeper than the median) and is
        # blurred by the fill when the same region is near field.
        def texture_std(far):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                make_fixture(root)
                plate = np.full((64, 96, 3), 50, np.uint8)
                plate[(np.indices((64, 96)).sum(0) // 2) % 2 == 0] = 200
                cv2.imwrite(str(root / "plate.webp"), plate)
                depth = np.zeros((64, 96), np.uint8)
                depth[0:32, :] = 120
                if far:
                    depth[0:32, 0:24] = 20  # cell 0 left half: far relief
                cv2.imwrite(str(root / "depth.webp"), depth)
                run(str(BEHIND_PY), str(root))
                behind = cv2.imread(str(root / "behind.webp"), cv2.IMREAD_GRAYSCALE)
                return float(behind[8:40, 8:40].std())
        self.assertGreater(texture_std(True), texture_std(False) + 5)

    def test_missing_inputs_fail_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = subprocess.run([sys.executable, str(BEHIND_PY), str(Path(tmp))],
                               capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
