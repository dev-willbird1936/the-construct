"""contact_residue.py CLI as run-basic calls it (--ids label PNG, --ext-out).
Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

SCRIPT = Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic" / "contact_residue.py"


def scene(root, hoof):
    # Green field; brown body with legs; label id 2 marks the subject. The
    # plate is the field plus (optionally) a brown hoof tip 13 px below the
    # front leg: outside the 11 px claim, touching its 3 px tolerance.
    seed = np.zeros((240, 320, 3), np.uint8)
    seed[:] = (40, 190, 70)
    seed[60:150, 100:220] = (40, 90, 170)
    seed[150:200, 110:122] = (30, 70, 140)
    seed[150:200, 196:208] = (30, 70, 140)
    lab = np.zeros((240, 320), np.uint8)
    lab[60:150, 100:220] = 2
    lab[150:200, 110:122] = 2
    lab[150:200, 196:208] = 2
    plate = np.zeros_like(seed)
    plate[:] = (40, 190, 70)
    if hoof:
        plate[211:219, 111:121] = (30, 70, 140)
    for name, im in (("seed.png", seed), ("label.png", lab), ("plate.png", plate)):
        cv2.imwrite(str(Path(root) / name), im)


def run(root):
    ext = Path(root) / "ext.png"
    r = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), "--plate", str(Path(root) / "plate.png"),
                        "--seed", str(Path(root) / "seed.png"), "--alpha", str(Path(root) / "label.png"),
                        "--ids", "2", "--grow", "11", "--ext-out", str(ext)], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1]), ext


class ContactResidueCliTest(unittest.TestCase):
    def test_hoof_flagged_and_ext_covers_it(self):
        with tempfile.TemporaryDirectory() as d:
            scene(d, hoof=True)
            out, ext = run(d)
            self.assertEqual(out["n"], 1)
            m = cv2.imread(str(ext), cv2.IMREAD_GRAYSCALE)
            self.assertTrue((m[211:219, 111:121] > 0).all())  # hoof inside the extended mask
            self.assertTrue((m[60:150, 100:220] > 0).all())   # subject kept
            self.assertEqual(int((m[0:40] > 0).sum()), 0)      # un-grown: nothing far away

    def test_clean_plate_flags_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            scene(d, hoof=False)
            out, ext = run(d)
            self.assertEqual(out["n"], 0)
            self.assertFalse(ext.exists())


if __name__ == "__main__":
    unittest.main()
