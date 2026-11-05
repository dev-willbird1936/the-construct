"""Synthetic-data tests for depth fit + plate. Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

BASIC = Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"
DEPTH_PY = BASIC / "depth.py"
PLATE_PY = BASIC / "plate.py"
# Keep in sync with TEX_RATIO_LIMIT in plate.py (validator threshold).
TEX_LIMIT = 0.35


def run(*args):
    r = subprocess.run([sys.executable, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"{args} failed:\n{r.stderr[-2000:]}")
    return r


class FitTest(unittest.TestCase):
    def test_affine_fit_recovers_scale_shift(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            dd, ld, od = tmp / "d", tmp / "l", tmp / "o"
            dd.mkdir()
            ld.mkdir()
            od.mkdir()
            rng = np.random.default_rng(0)
            ref = rng.uniform(1, 10, (40, 50))
            np.save(dd / "depth_a.npy", ref.astype(np.float32))
            # frame b: same scene, unknown scale+shift, plus a moved "subject"
            b = 2.5 * ref + 7.0
            lab_b = np.zeros((40, 50), np.uint8)
            lab_b[10:20, 10:20] = 1  # track 1 moved here
            b[10:20, 10:20] += 30  # subject is nearer (different depth)
            np.save(dd / "depth_b.npy", b.astype(np.float32))
            cv2.imwrite(str(ld / "a.png"), np.zeros((40, 50), np.uint8))
            cv2.imwrite(str(ld / "b.png"), lab_b)
            run(DEPTH_PY, "fit", "--depth", str(dd), "--labels", str(ld),
                "--track", "1", "--ref", "a", "--out", str(od))
            rep = json.loads((od / "fit.json").read_text())
            by_name = {f["name"]: f for f in rep["frames"]}
            # ref untouched
            self.assertAlmostEqual(by_name["a"]["scale"], 1.0)
            # background of b aligned to ref: fitted bg ~= ref bg
            fitted = np.load(od / "fitted_b.npy").astype(float)
            bg = np.ones((40, 50), bool)
            bg[8:22, 8:22] = False  # keep clear of dilation + subject
            err = np.abs(fitted[bg] - ref[bg]).mean()
            self.assertLess(err, 0.5, f"bg alignment error {err}")


class PlateTest(unittest.TestCase):
    def _scene(self, tmp, moving=False):
        """A textured wall with a dark square subject; returns (frames, labels)."""
        fd, ld = tmp / "f", tmp / "l"
        fd.mkdir()
        ld.mkdir()
        rng = np.random.default_rng(0)
        wall = np.tile(np.linspace(60, 140, 64, dtype=np.uint8)[None, :], (48, 1))
        wall = (wall.astype(float) + rng.uniform(-10, 10, (48, 64))).clip(0, 255).astype(np.uint8)
        wall = cv2.cvtColor(wall, cv2.COLOR_GRAY2BGR)
        n = 8
        for i in range(n):
            img = wall.copy()
            x = 5 + i * (6 if not moving else 1)
            img[18:32, x:x + 12] = (10, 10, 200)  # subject
            cv2.imwrite(str(fd / f"k{i:02d}.jpg"), img)
            lab = np.zeros((48, 64), np.uint8)
            lab[18:32, x:x + 12] = 1
            cv2.imwrite(str(ld / f"k{i:02d}.png"), lab)
        return fd, ld

    def test_median_plate_removes_subject(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            fd, ld = self._scene(tmp)
            out = tmp / "plate.png"
            meta = tmp / "meta.json"
            holes = tmp / "holes.png"
            r = run(PLATE_PY, "median", "--frames", str(fd), "--labels", str(ld),
                    "--out", str(out), "--meta", str(meta), "--holes", str(holes))
            info = json.loads(r.stdout)
            self.assertEqual(info["method"], "median")
            self.assertTrue(holes.exists())
            plate = cv2.imread(str(out))
            # subject pixels should be wall-like (no strong red)
            red = plate[20:30, 10:50, 2].astype(float).mean()
            self.assertLess(red, 120, f"subject leaked into plate (red {red})")

    def test_validate_holes_rejects_blur_accepts_texture(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rng = np.random.default_rng(7)
            # textured background (grass-like noise)
            bg = (rng.uniform(60, 160, (96, 128, 3))).astype(np.uint8)
            plate = tmp / "plate.png"
            cv2.imwrite(str(plate), bg)
            # suspect region over untouched texture -> must pass
            m = np.zeros((96, 128), np.uint8)
            m[20:50, 20:60] = 255
            mask = tmp / "m.png"
            cv2.imwrite(str(mask), m)
            r = run(PLATE_PY, "validate-holes", "--plate", str(plate),
                    "--holes", str(mask))
            self.assertTrue(json.loads(r.stdout)["pass"], r.stdout)
            # same region replaced by a blurred smear -> must fail
            smeared = bg.copy()
            blob = smeared[20:50, 20:60].copy()
            blob = cv2.GaussianBlur(blob, (21, 21), 0)
            blob = np.full_like(blob, blob.mean(axis=(0, 1)))  # flat ghost tint
            smeared[20:50, 20:60] = blob
            bad = tmp / "bad.png"
            cv2.imwrite(str(bad), smeared)
            r = run(PLATE_PY, "validate-holes", "--plate", str(bad),
                    "--holes", str(mask))
            out = json.loads(r.stdout)
            self.assertFalse(out["pass"], r.stdout)
            self.assertLess(out["regions"][0]["texRatio"], TEX_LIMIT)

    def test_validate_holes_accepts_large_clean_fill(self):
        # Close-up subjects (cat: 34% of frame) need a large hole. A big
        # region of consistent texture must pass: the region gates, not the
        # share prior, are the binding check.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rng = np.random.default_rng(9)
            bg = (rng.uniform(60, 160, (120, 160, 3))).astype(np.uint8)
            plate = tmp / "plate.png"
            cv2.imwrite(str(plate), bg)
            m = np.zeros((120, 160), np.uint8)
            m[20:100, 40:124] = 255  # 35% of the frame: over the old cap
            mask = tmp / "m.png"
            cv2.imwrite(str(mask), m)
            r = run(PLATE_PY, "validate-holes", "--plate", str(plate),
                    "--holes", str(mask))
            out = json.loads(r.stdout)
            self.assertGreater(out["holeShare"], 0.30)
            self.assertTrue(out["pass"], r.stdout)

    def test_validate_accepts_same_scene_rejects_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            fd, ld = self._scene(tmp)
            seed = sorted(fd.glob("*.jpg"))[0]
            mask = ld / "k00.png"
            same = tmp / "same.png"
            cv2.imwrite(str(same), cv2.imread(str(seed)))
            r = run(PLATE_PY, "validate", "--plate", str(same),
                    "--seed", str(seed), "--mask", str(mask))
            self.assertTrue(json.loads(r.stdout)["pass"])
            other = np.full((48, 64, 3), 200, np.uint8)  # a different scene
            cv2.imwrite(str(tmp / "other.png"), other)
            r = run(PLATE_PY, "validate", "--plate", str(tmp / "other.png"),
                    "--seed", str(seed), "--mask", str(mask))
            self.assertFalse(json.loads(r.stdout)["pass"])

    def test_classify_still_camera(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            fd, ld = self._scene(tmp)
            out = tmp / "cam.json"
            r = run(PLATE_PY, "classify", "--frames", str(fd),
                    "--labels", str(ld), "--out", str(out))
            info = json.loads(r.stdout)
            self.assertEqual(info["camera"], "fixed")
            self.assertIsNone(info["kind"], r.stdout)

    def test_classify_pan_is_moving(self):
        # A pan steps < limit per pair while the framing drifts far: the
        # walker failure mode. Background rolls 1 px/frame (8 px total).
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rng = np.random.default_rng(13)
            wall = (rng.uniform(60, 160, (96, 128, 3))).astype(np.uint8)
            fd, ld = tmp / "f", tmp / "l"
            fd.mkdir()
            ld.mkdir()
            for i in range(8):
                cv2.imwrite(str(fd / f"k{i:02d}.jpg"), np.roll(wall, 1 * i, axis=1))
                lab = np.zeros((96, 128), np.uint8)
                lab[40:60, 55:70] = 1
                cv2.imwrite(str(ld / f"k{i:02d}.png"), lab)
            out = tmp / "cam.json"
            r = run(PLATE_PY, "classify", "--frames", str(fd),
                    "--labels", str(ld), "--out", str(out))
            info = json.loads(r.stdout)
            self.assertEqual(info["camera"], "moving", r.stdout)
            self.assertGreater(info["pan"], 1.6)
            self.assertEqual(info["kind"], "pan", r.stdout)

    def test_classify_slow_dolly_is_moving(self):
        # A slow push-in has ~zero translation (phase correlation reads it as
        # fixed) but the background scales: the walker failure mode.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rng = np.random.default_rng(11)
            wall = (rng.uniform(60, 160, (96, 128, 3))).astype(np.uint8)
            fd, ld = tmp / "f", tmp / "l"
            fd.mkdir()
            ld.mkdir()
            for i in range(8):
                s = 1.0 + 0.012 * i  # ~10% growth over the span
                big = cv2.resize(wall, None, fx=s, fy=s)
                h, w = big.shape[:2]
                y0, x0 = (h - 96) // 2, (w - 128) // 2
                cv2.imwrite(str(fd / f"k{i:02d}.jpg"), big[y0:y0 + 96, x0:x0 + 128])
                lab = np.zeros((96, 128), np.uint8)
                lab[40:60, 55:70] = 1
                cv2.imwrite(str(ld / f"k{i:02d}.png"), lab)
            out = tmp / "cam.json"
            r = run(PLATE_PY, "classify", "--frames", str(fd),
                    "--labels", str(ld), "--out", str(out))
            info = json.loads(r.stdout)
            self.assertEqual(info["camera"], "moving", r.stdout)
            self.assertGreater(abs(info["scale"] - 1.0), 0.025)
            self.assertEqual(info["kind"], "dolly", r.stdout)

    def test_refine_mask_snaps_to_fullres_edge(self):
        # A SAM-grade mask (edge accurate to ~1 px, unbiased) refines against
        # the full-res guide: the refined working-res edge must beat a
        # nearest downscale (the cat-tail stair-step) and sit within 1 px of
        # the true edge. Guided filtering transfers detail; it does not move
        # grossly misplaced edges, so the synthetic bias stays SAM-grade.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rng = np.random.default_rng(7)
            FW, FH, W, H = 256, 144, 128, 72
            edge = FW // 2
            guide = np.zeros((FH, FW, 3), np.uint8)
            guide[:, :edge] = (60, 60, 60)
            guide[:, edge:] = (180, 180, 180)
            guide = (guide.astype(np.int16) +
                     rng.integers(-6, 7, guide.shape)).clip(0, 255).astype(np.uint8)
            bad = np.zeros((FH, FW), np.uint8)
            for y in range(FH):
                shift = int(rng.integers(-1, 2))
                bad[y, edge + shift:] = 5
            cv2.imwrite(str(tmp / "guide.jpg"), guide)
            cv2.imwrite(str(tmp / "mask.png"), bad)
            out = tmp / "ref.png"
            r = run(PLATE_PY, "refine-mask", "--mask", str(tmp / "mask.png"),
                    "--guide", str(tmp / "guide.jpg"), "--id", "5",
                    "--w", str(W), "--h", str(H), "--out", str(out))
            info = json.loads(r.stdout)
            self.assertGreater(info["kept"], 0.3)
            ref = cv2.imread(str(out), cv2.IMREAD_GRAYSCALE) > 0
            def edge_err(m, w):
                cols = np.argmax(m, axis=1)
                return np.abs(cols.astype(float) / m.shape[1] * w -
                              edge / FW * w)
            ref_err = edge_err(ref, W).mean()
            bad_small = cv2.resize((bad > 0).astype(np.uint8), (W, H),
                                     interpolation=cv2.INTER_NEAREST)
            bad_err = edge_err(bad_small > 0, W).mean()
            self.assertLess(ref_err, 1.0, f"refined edge error {ref_err}")
            self.assertLess(ref_err, bad_err, "refine must beat nearest")

    def test_refine_mask_keeps_distant_subject(self):
        # A trail-cam subject can be ~0.1% of frame: smoothing dilutes its
        # peak below any fixed cut, so the threshold follows the mask's own
        # peak. The blob must survive, near its true centroid.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rng = np.random.default_rng(3)
            FW, FH, W, H = 640, 360, 320, 180
            guide = (rng.uniform(40, 200, (FH, FW, 3))).astype(np.uint8)
            mask = np.zeros((FH, FW), np.uint8)
            cx, cy, rad = 400, 120, 7  # ~154 px = 0.07% of frame
            yy, xx = np.ogrid[:FH, :FW]
            mask[(yy - cy) ** 2 + (xx - cx) ** 2 <= rad * rad] = 9
            cv2.imwrite(str(tmp / "guide.jpg"), guide)
            cv2.imwrite(str(tmp / "mask.png"), mask)
            out = tmp / "ref.png"
            r = run(PLATE_PY, "refine-mask", "--mask", str(tmp / "mask.png"),
                    "--guide", str(tmp / "guide.jpg"), "--id", "9",
                    "--w", str(W), "--h", str(H), "--out", str(out))
            info = json.loads(r.stdout)
            self.assertGreater(info["kept"], 0.0, "distant blob deleted")
            ref = cv2.imread(str(out), cv2.IMREAD_GRAYSCALE)
            # id-valued output (maskStats counts == track id downstream)
            self.assertTrue(set(np.unique(ref).tolist()) <= {0, 9})
            ref = ref > 0
            ys, xs = np.nonzero(ref)
            self.assertLess(abs(xs.mean() / W * FW - cx), 8.0)
            self.assertLess(abs(ys.mean() / H * FH - cy), 8.0)

    def test_match_corrects_global_grading_shift(self):
        # A generative re-render keeps structure but shifts global grading
        # (what the scene gate rejects). match() must undo the shift over
        # background without touching the subject hole's own texture.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rng = np.random.default_rng(3)
            wall = np.tile(np.linspace(60, 140, 64)[None, :], (48, 1))
            seed = (wall + rng.uniform(-8, 8, (48, 64))).clip(0, 255).astype(np.uint8)
            seed = cv2.cvtColor(seed, cv2.COLOR_GRAY2BGR)
            m = np.zeros((48, 64), np.uint8)
            m[18:32, 20:32] = 255
            render = np.clip(seed.astype(float) * 1.25 + 15, 0, 255).astype(np.uint8)
            for name, arr in (("seed.png", seed), ("render.png", render), ("m.png", m)):
                cv2.imwrite(str(tmp / name), arr)
            out = tmp / "matched.png"
            run(PLATE_PY, "match", "--src", str(tmp / "render.png"),
                "--ref", str(tmp / "seed.png"), "--mask", str(tmp / "m.png"),
                "--out", str(out))
            r = run(PLATE_PY, "validate", "--plate", str(out),
                    "--seed", str(tmp / "seed.png"), "--mask", str(tmp / "m.png"))
            info = json.loads(r.stdout)
            self.assertTrue(info["pass"], r.stdout)
            self.assertLess(info["mean"], 3.0, r.stdout)

    def test_composite_match_removes_seam(self):
        # Hybrid seam case: fill has the right texture but a grading shift.
        # Without --match the hole core keeps the fill's tint; with it, the
        # core reads as base.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rng = np.random.default_rng(5)
            base = rng.uniform(90, 110, (40, 40, 3)).astype(np.uint8)
            fill = np.clip(base.astype(float) * 0.5 + 70, 0, 255).astype(np.uint8)
            m = np.zeros((40, 40), np.uint8)
            m[15:25, 15:25] = 255
            for name, arr in (("base.png", base), ("fill.png", fill), ("m.png", m)):
                cv2.imwrite(str(tmp / name), arr)
            plain = tmp / "plain.png"
            run(PLATE_PY, "composite", "--base", str(tmp / "base.png"),
                "--fill", str(tmp / "fill.png"), "--mask", str(tmp / "m.png"),
                "--grow", "2", "--feather", "0.5", "--out", str(plain))
            matched = tmp / "matched.png"
            run(PLATE_PY, "composite", "--base", str(tmp / "base.png"),
                "--fill", str(tmp / "fill.png"), "--mask", str(tmp / "m.png"),
                "--grow", "2", "--feather", "0.5", "--match", "--out", str(matched))
            base_mean = base[15:25, 15:25].astype(float).mean()
            plain_core = cv2.imread(str(plain))[18:22, 18:22].astype(float).mean()
            match_core = cv2.imread(str(matched))[18:22, 18:22].astype(float).mean()
            self.assertGreater(abs(plain_core - base_mean), 15)  # seam visible
            self.assertLess(abs(match_core - base_mean), 8)  # seam matched

    def test_composite_pastes_fill_into_hole(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            base = np.full((40, 40, 3), 100, np.uint8)
            fill = np.full((40, 40, 3), 200, np.uint8)
            m = np.zeros((40, 40), np.uint8)
            m[15:25, 15:25] = 255
            for name, arr in (("base.png", base), ("fill.png", fill), ("m.png", m)):
                cv2.imwrite(str(tmp / name), arr)
            out = tmp / "out.png"
            run(PLATE_PY, "composite", "--base", str(tmp / "base.png"),
                "--fill", str(tmp / "fill.png"), "--mask", str(tmp / "m.png"),
                "--grow", "2", "--feather", "0.5", "--out", str(out))
            img = cv2.imread(str(out))
            self.assertEqual(img[2, 2, 0], 100)  # far outside: base
            self.assertEqual(img[20, 20, 0], 200)  # hole core: fill


class GhostMapTest(unittest.TestCase):
    def test_scoped_ruling_inputs(self):
        # median: smooth field + a pale bar (ghost) inside the claim mask;
        # hybrid: bar removed, identical outside. Expect ghost drop,
        # outside at noise floor, edges bounded.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            med = np.full((64, 96, 3), 100, np.uint8)
            med[30:38, 10:82] = (160, 160, 160)
            hyb = np.full((64, 96, 3), 100, np.uint8)
            m = np.zeros((64, 96), np.uint8)
            m[26:42, 6:86] = 255
            for name, arr in (("med.png", med), ("hyb.png", hyb), ("m.png", m)):
                cv2.imwrite(str(tmp / name), arr)
            r = run(PLATE_PY, "ghost-map", "--median", str(tmp / "med.png"),
                    "--hybrid", str(tmp / "hyb.png"), "--mask", str(tmp / "m.png"),
                    "--grow", "4")
            g = json.loads(r.stdout.strip().split("\n")[-1])
            self.assertGreater(g["medianGhostShare"], 0)  # snake seen
            self.assertLess(g["hybridGhostShare"], g["medianGhostShare"])
            self.assertLessEqual(g["outsideDiff"], 1.0)
            self.assertLessEqual(g["hybridEdge"], g["medianEdge"] * 1.1)

    def test_median_only_mode(self):
        # decline-rung usage: no hybrid, median stats only.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            med = np.full((48, 48, 3), 120, np.uint8)
            m = np.zeros((48, 48), np.uint8)
            m[10:30, 10:30] = 255
            cv2.imwrite(str(tmp / "med.png"), med)
            cv2.imwrite(str(tmp / "m.png"), m)
            r = run(PLATE_PY, "ghost-map", "--median", str(tmp / "med.png"),
                    "--mask", str(tmp / "m.png"), "--grow", "4")
            g = json.loads(r.stdout.strip().split("\n")[-1])
            self.assertIn("medianGhostShare", g)
            self.assertNotIn("hybridGhostShare", g)
            self.assertEqual(g["medianGhostBlobs"], 0)  # clean field


if __name__ == "__main__":
    unittest.main()
