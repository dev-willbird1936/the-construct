"""Scene-transition scores (tier-improve loop 11): a cross-dissolve at the
clip start changes the whole background and scores high; a moving subject
or local motion (a splashing patch) does not.
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
import transition  # noqa: E402

W, H, N = 320, 180, 30


def scene(seed):
    rng = np.random.default_rng(seed)
    base = rng.integers(0, 255, (H // 10, W // 10, 3), dtype=np.uint8)
    return cv2.GaussianBlur(cv2.resize(base, (W, H), interpolation=cv2.INTER_CUBIC), (0, 0), 2)


def build(tmp, dissolve=6, splash=False):
    a, b = scene(1), scene(2)
    video = tmp / "clip.avi"
    labels = tmp / "labels"
    labels.mkdir()
    vw = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 15, (W, H))
    for i in range(N):
        t = min(1.0, (i + 1) / (dissolve + 1)) if dissolve else 1.0
        frame = cv2.addWeighted(b, t, a, 1 - t, 0)
        x = 40 + i * 6  # the subject walks right
        frame[70:130, x:x + 40] = (30, 60, 200)
        if splash and 10 <= i < 20:
            frame[20:60, 250:300] = np.random.default_rng(i).integers(0, 255, (40, 50, 3), dtype=np.uint8)
        vw.write(frame)
        lab = np.zeros((H, W), np.uint8)
        lab[70:130, x:x + 40] = 1
        cv2.imwrite(str(labels / f"l{i:05d}.png"), lab)
    vw.release()
    mp = tmp / "map.json"
    mp.write_text(json.dumps({str(i): i for i in range(N)}))
    return video, labels, mp


def run(video, labels, mp):
    out = subprocess.run([sys.executable, str(BASIC / "transition.py"), "--video", str(video), "--labels", str(labels),
                          "--ids", "1", "--map", str(mp)], capture_output=True, text=True, check=True).stdout
    return {int(k): v for k, v in json.loads(out)["scores"].items()}


class TransitionTest(unittest.TestCase):
    def test_dissolve_frames_score_high_and_settled_frames_low(self):
        with tempfile.TemporaryDirectory() as d:
            sc = run(*build(Path(d)))
        self.assertEqual(len(sc), N)
        self.assertGreater(min(sc[i] for i in range(3)), 0.05)
        self.assertLess(max(abs(sc[i]) for i in range(8, N)), 0.006)

    def test_local_motion_is_not_a_transition(self):
        with tempfile.TemporaryDirectory() as d:
            sc = run(*build(Path(d), dissolve=0, splash=True))
        self.assertLess(max(abs(v) for v in sc.values()), 0.006)

    def test_long_clips_read_the_ends_and_a_middle_subset(self):
        s = list(range(180))
        picked = transition.pick_samples(s)
        self.assertEqual(picked[:45], s[:45])
        self.assertEqual(picked[-45:], s[-45:])
        self.assertEqual(len(picked), 45 + 24 + 45)
        self.assertEqual(picked, sorted(set(picked)))
        self.assertEqual(transition.pick_samples(list(range(50))), list(range(50)))  # short: all of it

    def test_too_little_background_is_not_judged(self):
        G = [np.zeros((48, 64), np.float32) + i for i in range(4)]
        M = [np.ones((48, 64), bool)] * 4
        self.assertEqual(transition.scores_from(transition.tile_dissimilarity(G, M)), [None] * 4)


if __name__ == "__main__":
    unittest.main()
