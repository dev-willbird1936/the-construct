"""QA tests for the broad-residue detector, local colour metric, motion
claim and exact-outside composite (plate.py), plus behind.py residue keys.

All fixtures are synthetic (no production pixels); run offline:
  .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"
from backend/pipeline/basic (sys.executable picks that venv's python).
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

BASIC = Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"
PLATE_PY = BASIC / "plate.py"
BEHIND_PY = BASIC / "behind.py"


def plate(*args):
    r = subprocess.run([sys.executable, str(PLATE_PY), *args],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"plate.py {args} failed:\n{r.stderr[-2000:]}")
    return json.loads(r.stdout.strip().split("\n")[-1])


def room(rng):
    # Two-tone wall (soft transition, no hard step), grain everywhere,
    # dark couch + seams bottom-right, textured photo top-right.
    H, W = 200, 320
    bg = np.zeros((H, W, 3), np.uint8)
    bg[:, :] = (170, 172, 168)
    bg[:, 160:] = (120, 122, 118)
    bg = cv2.GaussianBlur(bg, (0, 0), 8)
    bg = np.clip(bg.astype(np.int16) + rng.integers(-9, 10, (H, W, 3)),
                 0, 255).astype(np.uint8)
    bg[130:200, 190:320] = (42, 40, 44)
    for y in range(132, 200, 10):
        bg[y:y + 2, 190:320] = (28, 26, 30)
    photo = rng.integers(70, 190, (56, 76, 3)).astype(np.uint8)
    bg[16:72, 190:266] = cv2.GaussianBlur(photo, (0, 0), 1.0)
    return bg


class ResidueTest(unittest.TestCase):
    def test_broad_ghost_rejected_where_thin_rule_is_blind(self):
        rng = np.random.default_rng(11)
        bg = room(rng)
        mask = np.zeros(bg.shape[:2], np.uint8)
        cv2.ellipse(mask, (150, 125), (52, 58), 0, 0, 360, 255, -1)
        ghost = bg.copy()
        blob = np.zeros(bg.shape[:2], np.float32)
        cv2.ellipse(blob, (150, 120), (46, 54), 10, 0, 360, 1.0, -1)
        blob = (cv2.GaussianBlur(blob, (0, 0), 3) * 255).astype(np.uint8)
        tone = np.zeros_like(bg)
        tone[:] = (112, 128, 122)  # flat invented tone, foreign to wall+couch
        ghost = (bg.astype(np.float32) * (255 - blob)[..., None] / 255.0
                 + tone.astype(np.float32) * blob[..., None] / 255.0).astype(np.uint8)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "ghost.png"), ghost)
            cv2.imwrite(str(root / "mask.png"), mask)
            d = plate("ghost-map", "--median", str(root / "ghost.png"),
                      "--mask", str(root / "mask.png"), "--grow", "5")
            # old thin-blob keys retained, and blind here by construction
            self.assertEqual(d["medianGhostShare"], 0.0)
            self.assertEqual(d["medianGhostBlobs"], 0)
            # new broad detector fires hard
            self.assertGreater(d["medianResidueShare"], 0.05)
            self.assertGreaterEqual(d["medianResidueBlobs"], 1)
            # deterministic across runs
            d2 = plate("ghost-map", "--median", str(root / "ghost.png"),
                       "--mask", str(root / "mask.png"), "--grow", "5")
            self.assertEqual(d, d2)

    def test_clean_multimodal_fill_accepted(self):
        rng = np.random.default_rng(11)
        bg = room(rng)  # correct fill == true background by construction
        mask = np.zeros(bg.shape[:2], np.uint8)
        cv2.ellipse(mask, (150, 125), (52, 58), 0, 0, 360, 255, -1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "clean.png"), bg)
            cv2.imwrite(str(root / "mask.png"), mask)
            d = plate("ghost-map", "--median", str(root / "clean.png"),
                      "--mask", str(root / "mask.png"), "--grow", "5")
            self.assertEqual(d["medianResidueShare"], 0.0)
            self.assertEqual(d["medianResidueBlobs"], 0)
            self.assertLess(d["medianGhostShare"], 0.10)  # thin noise floor only

    def test_multimodal_hole_old_colour_fails_local_passes(self):
        # Hole sitting mostly in the dark material with a sliver of wall:
        # the ring is dominated by bright wall, so the ring-wide mean
        # matches nothing and the old distance false-fails; the median pixel
        # still sits on a real ring mode (dark couch continues below).
        bg = np.zeros((140, 200, 3), np.uint8)
        bg[:, :] = (200, 200, 195)
        bg[80:140, :] = (40, 38, 42)
        rng = np.random.default_rng(3)
        bg = np.clip(bg.astype(np.int16) + rng.integers(-6, 7, bg.shape),
                     0, 255).astype(np.uint8)
        mask = np.zeros((140, 200), np.uint8)
        mask[70:110, 70:130] = 255  # mostly dark, sliver of wall on top
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "plate.png"), bg)
            cv2.imwrite(str(root / "mask.png"), mask)
            d = plate("validate-holes", "--plate", str(root / "plate.png"),
                      "--mask", str(root / "mask.png"), "--grow", "5")
            self.assertTrue(d["pass"])
            reg = d["regions"][0]
            self.assertIn("colorDist", reg)  # old diagnostic retained
            self.assertGreater(reg["colorDist"], 25.0)  # old statistic false-fails
            self.assertIn("colorDistLocal", reg)
            self.assertLessEqual(reg["colorDistLocal"], 25.0)  # local rescues it

    def test_textured_print_in_hole_not_flagged(self):
        # Correct textured fill (photo print) fully inside the hole: its
        # tones are foreign to the wall ring, but the bias guard lets real
        # texture through.
        rng = np.random.default_rng(5)
        bg = np.full((120, 200, 3), (170, 172, 168), np.uint8)
        bg = np.clip(bg.astype(np.int16) + rng.integers(-5, 6, bg.shape),
                     0, 255).astype(np.uint8)
        photo = rng.integers(40, 220, (40, 60, 3)).astype(np.uint8)
        bg[40:80, 70:130] = photo
        mask = np.zeros((120, 200), np.uint8)
        mask[25:95, 55:145] = 255  # hole swallows the whole photo
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "plate.png"), bg)
            cv2.imwrite(str(root / "mask.png"), mask)
            d = plate("ghost-map", "--median", str(root / "plate.png"),
                      "--mask", str(root / "mask.png"), "--grow", "5")
            self.assertEqual(d["medianResidueShare"], 0.0)
            self.assertEqual(d["medianResidueBlobs"], 0)
            h = plate("validate-holes", "--plate", str(root / "plate.png"),
                      "--mask", str(root / "mask.png"), "--grow", "5")
            self.assertTrue(h["pass"])

    def test_thin_snake_still_detected_old_keys_stable(self):
        # Long-thin smooth bar: old detector must keep firing exactly as
        # before (aspect gate untouched).
        img = np.full((120, 200, 3), (50, 50, 50), np.uint8)
        img[56:64, 10:190] = (130, 130, 130)
        mask = np.zeros((120, 200), np.uint8)
        mask[40:80, 0:200] = 255
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "plate.png"), img)
            cv2.imwrite(str(root / "mask.png"), mask)
            d = plate("ghost-map", "--median", str(root / "plate.png"),
                      "--mask", str(root / "mask.png"), "--grow", "5")
            self.assertGreaterEqual(d["medianGhostBlobs"], 1)
            self.assertGreater(d["medianGhostShare"], 0)


class MotionClaimTest(unittest.TestCase):
    def test_covers_moving_paper_not_static_texture(self):
        # Static disc (person) + moving paper rect + static textured photo.
        # Claim must extend over the paper's swept path only.
        rng = np.random.default_rng(9)
        W, H, N = 160, 120, 6
        bg = np.zeros((H, W, 3), np.uint8)
        bg[:, :] = (170, 172, 168)
        bg = np.clip(bg.astype(np.int16) + rng.integers(-6, 7, (H, W, 3)),
                     0, 255).astype(np.uint8)
        photo = rng.integers(60, 200, (30, 40, 3)).astype(np.uint8)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paper_cells = np.zeros((H, W), bool)
            for i in range(N):
                fr = bg.copy()
                fr[20:50, 110:150] = photo  # static texture, never masked
                px = 30 + i * 6  # paper marches right, next to the disc
                fr[70:95, px:px + 28] = (225, 222, 210)
                paper_cells[70:95, px:px + 28] = True
                cv2.imwrite(str(root / f"f{i:03d}.jpg"), fr)
                lab = np.zeros((H, W), np.uint8)
                cv2.circle(lab, (45, 82), 20, 1, -1)  # static person disc
                cv2.imwrite(str(root / f"f{i:03d}.png"), lab)
            r = subprocess.run(
                [sys.executable, str(PLATE_PY), "motion-claim",
                 "--frames", str(root), "--labels", str(root),
                 "--out", str(root / "claim.png"), "--width", str(W)],
                capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr[-1000:])
            claim = cv2.imread(str(root / "claim.png"), 0) > 0
            yy, xx = np.ogrid[:H, :W]
            union = (xx - 45) ** 2 + (yy - 82) ** 2 <= 20 ** 2
            out = json.loads(r.stdout.strip().split("\n")[-1])
            self.assertGreater(out["extPx"], 0, "paper extension must exist")
            # extension covers most of the swept paper path...
            self.assertGreater((claim & paper_cells).sum() / paper_cells.sum(), 0.7)
            # ...but never the static photo texture...
            photobox = np.zeros((H, W), bool)
            photobox[20:50, 110:150] = True
            self.assertEqual(int((claim & photobox).sum()), 0)
            # ...and the claim still contains the whole subject union.
            ys, xs = np.where(union)
            for y, x in zip(ys[::37], xs[::37]):
                self.assertTrue(claim[y, x])
            # deterministic: identical bytes on rerun
            before = cv2.imread(str(root / "claim.png"), 0).tobytes()
            r2 = subprocess.run(
                [sys.executable, str(PLATE_PY), "motion-claim",
                 "--frames", str(root), "--labels", str(root),
                 "--out", str(root / "claim2.png"), "--width", str(W)],
                capture_output=True, text=True)
            self.assertEqual(r2.returncode, 0)
            self.assertEqual(before, cv2.imread(str(root / "claim2.png"), 0).tobytes())


class CompositeExactTest(unittest.TestCase):
    def test_outside_margin_bit_exact(self):
        rng = np.random.default_rng(4)
        base = rng.integers(0, 255, (80, 120, 3)).astype(np.uint8)
        fill = rng.integers(0, 255, (80, 120, 3)).astype(np.uint8)
        mask = np.zeros((80, 120), np.uint8)
        mask[30:50, 40:80] = 255
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "base.png"), base)
            cv2.imwrite(str(root / "fill.png"), fill)
            cv2.imwrite(str(root / "mask.png"), mask)
            r = subprocess.run(
                [sys.executable, str(PLATE_PY), "composite",
                 "--base", str(root / "base.png"), "--fill", str(root / "fill.png"),
                 "--mask", str(root / "mask.png"), "--grow", "5",
                 "--feather", "2.0", "--exact-outside", "15",
                 "--out", str(root / "out.png")],
                capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr[-1000:])
            out = cv2.imread(str(root / "out.png"))
            hole = cv2.dilate((mask > 0).astype(np.uint8),
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))) > 0
            keep = cv2.dilate(hole.astype(np.uint8),
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))) > 0
            np.testing.assert_array_equal(out[~keep], base[~keep])
            self.assertGreater(np.abs(out[hole].astype(int) - base[hole].astype(int)).mean(), 1.0)


class BehindResidueTest(unittest.TestCase):
    def test_behind_reports_residue_keys(self):
        # behind.py keeps its old keys and adds residueBlobs/residueShare.
        r = subprocess.run([sys.executable, str(BEHIND_PY), "--help"],
                           capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)  # usage: behind.py <runsDir>
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec = {
                "working": {"width": 96, "height": 64},
                "layout": {"cols": 2, "rows": 1, "dRows": 2, "cellW": 48, "cellH": 32},
                "keyframes": [{"sample": 0}, {"sample": 1}],
                "plate": {"validation": {"seedSample": 0}},
                "depth": {"min": 0.0, "max": 1.0},
                "files": {"plate": "plate.webp", "subject": "subject.webp",
                          "depth": "depth.webp"},
            }
            (root / "specimen.json").write_text(json.dumps(spec))
            cv2.imwrite(str(root / "plate.webp"), np.full((64, 96, 3), 60, np.uint8))
            depth = np.zeros((64, 96), np.uint8)
            depth[0:32, :] = 51
            cv2.imwrite(str(root / "depth.webp"), depth)
            subj = np.zeros((32, 96, 4), np.uint8)
            cv2.circle(subj, (8, 8), 6, (180, 180, 180, 255), -1)
            cv2.imwrite(str(root / "subject.webp"), subj)
            r = subprocess.run([sys.executable, str(BEHIND_PY), str(root)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr[-1000:])
            report = json.loads(r.stdout.strip().split("\n")[-1])
            for key in ("edgePx", "bandPx", "silPx", "canvas", "ghostBlobs",
                        "ghostShare", "residueBlobs", "residueShare", "seconds"):
                self.assertIn(key, report)


if __name__ == "__main__":
    unittest.main()
