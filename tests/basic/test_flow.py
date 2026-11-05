"""Sub-keyframe motion field (tier-improve 2026-11-04, loop 10): flow.py.
Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

BASIC = Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"
sys.path.insert(0, str(BASIC))
import flow  # noqa: E402

CW, CH = 160, 80


def pose(head_dx=0, body_dx=0):
    """RGBA cell: a body ellipse plus a textured head that can move alone."""
    rng = np.random.default_rng(3)
    img = np.zeros((CH, CW, 4), np.uint8)
    tex = rng.integers(60, 200, (CH, CW, 3), dtype=np.uint8)
    m = np.zeros((CH, CW), np.uint8)
    cv2.ellipse(m, (70 + body_dx, 45), (30, 16), 0, 0, 360, 255, -1)
    head = np.zeros((CH, CW), np.uint8)
    cv2.circle(head, (108 + head_dx, 30), 11, 255, -1)
    img[:, :, :3] = tex
    # head texture travels with the head
    img[:, :, :3][head > 0] = np.roll(tex, head_dx, axis=1)[head > 0]
    img[:, :, 3] = np.maximum(m, head)
    return img


def centroid(cell):
    ys, xs = np.nonzero(cell[:, :, 3] > 127)
    return [float(xs.mean()), float(ys.mean())]


def atlas_of(poses):
    return np.hstack(poses)


class FlowTest(unittest.TestCase):
    def meta(self, poses):
        return {"cols": len(poses), "cellW": CW, "cellH": CH, "count": len(poses), "centroids": [centroid(p) for p in poses]}

    def test_identical_poses_write_zero(self):
        poses = [pose(), pose()]
        fields, gx, gy, gains, kept = flow.build(atlas_of(poses), self.meta(poses))
        self.assertEqual(fields.shape, (1, gy, gx, 4))
        self.assertEqual(kept, 0)
        self.assertFalse(np.abs(fields).any())

    def test_moving_head_warps_head_not_body(self):
        poses = [pose(0), pose(14)]
        fields, gx, gy, gains, kept = flow.build(atlas_of(poses), self.meta(poses))
        self.assertEqual(kept, 1)
        self.assertGreater(gains[0], 0.3)
        fwd = fields[0, :, :, :2]
        node = lambda x, y: fwd[round(y / (CH - 1) * (gy - 1)), round(x / (CW - 1) * (gx - 1))]
        head, body = node(108, 30), node(60, 45)
        # residual after the centroid slide: the head moves on (+x) relative to the body
        self.assertGreater(head[0] - body[0], 6)
        bwd = fields[0, :, :, 2:]
        self.assertLess(bwd[round(30 / (CH - 1) * (gy - 1)), round(122 / (CW - 1) * (gx - 1))][0] - body[0], 0)

    def test_cli_writes_int8_field_and_report(self):
        poses = [pose(0), pose(8), pose(16)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "subject.png"), atlas_of(poses))
            (root / "in.json").write_text(json.dumps(self.meta(poses)))
            got = subprocess.run([sys.executable, str(BASIC / "flow.py"), "--atlas", str(root / "subject.png"),
                                  "--meta", str(root / "in.json"), "--out", str(root / "flow.bin")],
                                 capture_output=True, text=True, check=True)
            rep = json.loads(got.stdout.strip().splitlines()[-1])
            self.assertEqual(rep["pairs"], 2)
            q = np.fromfile(root / "flow.bin", np.int8)
            self.assertEqual(q.size, 2 * rep["gy"] * rep["gx"] * 4)
            self.assertEqual(rep["bytes"], q.size)
            self.assertLessEqual(np.abs(q).max(), 127)

    def test_cli_rejects_missing_centroids(self):
        poses = [pose(0), pose(8)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "subject.png"), atlas_of(poses))
            meta = self.meta(poses)
            meta["centroids"] = meta["centroids"][:1]
            (root / "in.json").write_text(json.dumps(meta))
            got = subprocess.run([sys.executable, str(BASIC / "flow.py"), "--atlas", str(root / "subject.png"),
                                  "--meta", str(root / "in.json"), "--out", str(root / "flow.bin")],
                                 capture_output=True, text=True)
            self.assertNotEqual(got.returncode, 0)
            self.assertFalse((root / "flow.bin").exists())


if __name__ == "__main__":
    unittest.main()
