"""tier-improve 2026-11-04 (basic): gradient-aware plate tone gates,
batched mask refine and the greyscale early exit of the blur pass.

Synthetic fixtures only; run from backend/pipeline/basic:
  .venv/Scripts/python -m unittest discover -s ../../../tests/basic -p "test_*.py"
"""
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


def plate(*args):
    r = subprocess.run([sys.executable, str(BASIC / "plate.py"), *args],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"plate.py {args} failed:\n{r.stderr[-2000:]}")
    return json.loads(r.stdout.strip().split("\n")[-1])


def ir_scene(seed=7):
    # Night-IR style: flash fall-off (bright bottom centre) + dark bush band
    # above the hole, grain scaled with brightness. The clean fill IS the
    # true background, so a correct gate must pass it.
    rng = np.random.default_rng(seed)
    h, w = 180, 260
    y = np.arange(h)[:, None] / h
    x = np.arange(w)[None, :] / w
    lum = 20 + 170 * np.exp(-(((x - 0.5) / 0.55) ** 2 + ((y - 1.05) / 0.55) ** 2))
    tex = cv2.GaussianBlur(rng.normal(0, 1, (h, w)).astype(np.float32), (0, 0), 1.2) * 40
    img = lum + tex * (lum / 120)
    img = img * (1 - 0.8 / (1 + np.exp((y - 0.5) * 60)))
    bg = np.repeat(np.clip(img, 0, 255)[..., None], 3, 2).astype(np.uint8)
    mask = np.zeros((h, w), np.uint8)
    cv2.ellipse(mask, (130, 110), (70, 30), 0, 0, 360, 255, -1)
    return bg, mask


def dark_ghost(bg, strength):
    blob = np.zeros(bg.shape[:2], np.float32)
    cv2.ellipse(blob, (130, 110), (62, 26), 0, 0, 360, 1.0, -1)
    blob = cv2.GaussianBlur(blob, (0, 0), 3)[..., None] * strength
    return (bg.astype(np.float32) * (1 - blob) + 20 * blob).astype(np.uint8)


class GradientToneTest(unittest.TestCase):
    def run_gates(self, img, mask):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "plate.png"), img)
            cv2.imwrite(str(root / "mask.png"), mask)
            holes = plate("validate-holes", "--plate", str(root / "plate.png"),
                          "--mask", str(root / "mask.png"), "--grow", "5")
            ghost = plate("ghost-map", "--median", str(root / "plate.png"),
                          "--mask", str(root / "mask.png"), "--grow", "5")
        return holes, ghost

    def test_clean_fill_on_lit_gradient_passes(self):
        bg, mask = ir_scene()
        holes, ghost = self.run_gates(bg, mask)
        reg = holes["regions"][0]
        self.assertGreater(reg["colorDist"], 25.0)       # flat ring mean false-fails
        self.assertGreater(reg["colorDistLocal"], 25.0)  # ring modes false-fail
        self.assertLessEqual(reg["colorDistPlanar"], 12.5)  # the lit surface explains it
        self.assertTrue(holes["pass"])
        self.assertEqual(ghost["medianResidueShare"], 0.0)

    def test_dark_subject_ghosts_still_refused(self):
        bg, mask = ir_scene()
        # 50%: the flat mean passes it (pre-existing), the residue rule must not
        holes, ghost = self.run_gates(dark_ghost(bg, 0.5), mask)
        self.assertGreater(ghost["medianResidueShare"], 0.05)
        self.assertGreater(ghost["medianResidue"][0]["planarDist"], 12.5)
        # 70%: the holes gate refuses it
        holes, _ = self.run_gates(dark_ghost(bg, 0.7), mask)
        self.assertFalse(holes["pass"])
        self.assertGreater(holes["regions"][0]["colorDistPlanar"], 25.0)


class RefineBatchTest(unittest.TestCase):
    def test_batch_matches_single_job_outputs(self):
        rng = np.random.default_rng(4)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            guide = cv2.GaussianBlur(rng.integers(0, 255, (120, 200, 3)).astype(np.uint8), (0, 0), 2)
            cv2.circle(guide, (100, 60), 30, (240, 240, 240), -1)
            cv2.imwrite(str(root / "g.jpg"), guide)
            lab = np.zeros((120, 200), np.uint8)
            cv2.circle(lab, (100, 60), 31, 1, -1)
            cv2.rectangle(lab, (10, 10), (30, 40), 2, -1)
            cv2.imwrite(str(root / "m.png"), lab)
            jobs = []
            for gid in (1, 2, 3):  # 3 is absent: empty mask, still a result
                single = plate("refine-mask", "--mask", str(root / "m.png"), "--guide", str(root / "g.jpg"),
                               "--id", str(gid), "--w", "100", "--h", "60", "--out", str(root / f"s{gid}.png"))
                jobs.append({"mask": str(root / "m.png"), "guide": str(root / "g.jpg"),
                             "id": str(gid), "out": str(root / f"b{gid}.png"), "single": single})
            jobs.append({"mask": str(root / "missing.png"), "guide": str(root / "g.jpg"),
                         "id": "1", "out": str(root / "bx.png")})
            (root / "jobs.json").write_text(json.dumps(jobs))
            batch = plate("refine-masks", "--jobs", str(root / "jobs.json"), "--w", "100", "--h", "60")["results"]
            self.assertEqual(len(batch), 4)
            for gid, res in zip((1, 2, 3), batch):
                self.assertEqual(res, jobs[gid - 1]["single"])
                a = cv2.imread(str(root / f"s{gid}.png"), cv2.IMREAD_UNCHANGED)
                b = cv2.imread(str(root / f"b{gid}.png"), cv2.IMREAD_UNCHANGED)
                np.testing.assert_array_equal(a, b)
            self.assertIn("error", batch[3])  # isolated per-job failure


class GreyscaleBlurPassTest(unittest.TestCase):
    def test_local_pass_skips_flow_on_greyscale(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "g.avi"
            vw = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10, (64, 48))
            for i in range(8):
                f = np.full((48, 64, 3), 60 + 10 * i, np.uint8)
                vw.write(f)
            vw.release()
            (root / "labels").mkdir()
            for s in range(8):
                lab = np.zeros((48, 64), np.uint8)
                lab[10:30, 10:40] = 1
                cv2.imwrite(str(root / "labels" / f"l{s:05d}.png"), lab)
            (root / "map.json").write_text(json.dumps({str(s): s for s in range(1, 7)}))
            r = subprocess.run([sys.executable, str(BASIC / "sharpness.py"), "--local", "--video", str(video),
                                "--labels", str(root / "labels"), "--ids", "1", "--map", str(root / "map.json")],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr[-1000:])
            out = json.loads(r.stdout.strip().split("\n")[-1])
            self.assertTrue(out["grayscale"])
            self.assertEqual(out["scores"], {})


class GlowNotTextureTest(unittest.TestCase):
    def ghost(self, img, mask):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cv2.imwrite(str(root / "p.png"), img)
            cv2.imwrite(str(root / "m.png"), mask)
            return plate("ghost-map", "--median", str(root / "p.png"), "--mask", str(root / "m.png"), "--grow", "5")

    def scene(self):
        # Dense high-frequency texture (river water / IR grass) over a wide,
        # short zone: one connected component with a long box.
        rng = np.random.default_rng(9)
        tex = cv2.GaussianBlur(rng.normal(0, 1, (120, 300)).astype(np.float32), (0, 0), 0.8) * 60
        img = np.repeat(np.clip(110 + tex, 0, 255)[..., None], 3, 2).astype(np.uint8)
        mask = np.zeros((120, 300), np.uint8)
        mask[40:80, 0:300] = 255
        return img, mask

    def test_real_texture_is_not_a_ghost(self):
        img, mask = self.scene()
        d = self.ghost(img, mask)
        self.assertEqual(d["medianGhostShare"], 0.0)

    def test_smooth_strip_on_texture_still_detected(self):
        img, mask = self.scene()
        img[56:64, 20:280] = (200, 200, 200)  # smooth glowing strip
        d = self.ghost(img, mask)
        self.assertGreaterEqual(d["medianGhostBlobs"], 1)
        self.assertGreater(d["medianGhostShare"], 0.0)


class FlowDownscaleTest(unittest.TestCase):
    """Local-motion speeds survive the downscaled flow crop (full-res units)."""

    def speeds(self, side):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "m.avi"
            rng = np.random.default_rng(3)
            tex = cv2.GaussianBlur(rng.integers(0, 255, (360, 640, 3)).astype(np.uint8), (0, 0), 1.5)
            vw = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 25, (640, 360))
            (root / "labels").mkdir()
            for i in range(12):
                f = np.full((360, 640, 3), 90, np.uint8)
                x = 100 + 6 * i  # 6 px/frame
                f[80:300, x:x + 360] = tex[80:300, 0:360]
                f[:, :, 0] = np.clip(f[:, :, 0].astype(int) + 30, 0, 255)  # colour: not greyscale
                vw.write(f)
                lab = np.zeros((360, 640), np.uint8)
                lab[80:300, x:x + 360] = 1
                cv2.imwrite(str(root / "labels" / f"l{i:05d}.png"), lab)
            vw.release()
            (root / "map.json").write_text(json.dumps({str(s): s for s in range(2, 10)}))
            env = {**os.environ, "BASIC_FLOW_MAX_SIDE": str(side)}
            r = subprocess.run([sys.executable, str(BASIC / "sharpness.py"), "--local", "--video", str(video),
                                "--labels", str(root / "labels"), "--ids", "1", "--map", str(root / "map.json")],
                               capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 0, r.stderr[-1000:])
            return json.loads(r.stdout.strip().split("\n")[-1])["scores"]

    def test_downscaled_speed_matches_full_res(self):
        full, small = self.speeds(0), self.speeds(256)
        self.assertEqual(set(full), set(small))
        for k in full:
            self.assertAlmostEqual(small[k], full[k], delta=0.25 * full[k] + 0.5, msg=k)
        self.assertGreater(min(small.values()), 3.0)  # ~6 px/frame motion reads in full-res units


if __name__ == "__main__":
    unittest.main()


class SoftFallbackTest(unittest.TestCase):
    """Loop 6: the soft fallback plate cannot carry the subject's pixels."""

    def scene(self, still):
        rng = np.random.default_rng(3)
        h, w = 120, 200
        bg = np.full((h, w, 3), 128, np.float32) + rng.normal(0, 4, (h, w, 3)).astype(np.float32)
        frames, masks = [], []
        for i in range(20):
            x = 80 if still else 10 + i * 8
            m = np.zeros((h, w), bool)
            m[40:80, x:x + 30] = True
            f = bg.copy()
            f[m] = (200, 30, 30)  # saturated subject (BGR blue-ish red)
            frames.append(f)
            masks.append(m)
        return bg, frames, masks

    def run_soften(self, still):
        sys.path.insert(0, str(BASIC))
        import plate as plate_mod
        bg, frames, masks = self.scene(still)
        # base: what the median leaves (the still subject contaminates it)
        base = np.median(np.stack(frames), axis=0).astype(np.float32)
        holes = np.stack(masks).all(0)
        return bg, plate_mod.soften_plate(base, masks, holes)

    def test_still_subject_leaves_no_subject_colour(self):
        bg, (out, zone, rep) = self.run_soften(still=True)
        core = out[45:75, 85:105]
        self.assertGreater(rep["softShare"], rep["unsureShare"])
        self.assertLess(float(np.abs(core - 128).max()), 12.0, "soft zone is filled from the surroundings only")
        self.assertLess(float(np.abs(out[5:20, 5:40] - bg[5:20, 5:40]).max()), 1e-3, "far background untouched")

    def test_moving_subject_keeps_the_observed_median(self):
        bg, (out, zone, rep) = self.run_soften(still=False)
        self.assertEqual(rep["unsureShare"], 0.0)
        self.assertEqual(rep["softShare"], 0.0)
        self.assertFalse(zone.any())

    def test_cli_writes_plate_and_zone(self):
        bg, frames, masks = self.scene(still=True)
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            for i, (f, m) in enumerate(zip(frames, masks)):
                cv2.imwrite(str(d / f"kf_{i:05d}.jpg"), np.clip(f, 0, 255).astype(np.uint8))
                cv2.imwrite(str(d / f"kf_{i:05d}.png"), m.astype(np.uint8))
            base = np.median(np.stack(frames), axis=0)
            o = d / "out"
            o.mkdir()
            cv2.imwrite(str(o / "base.jpg"), base.astype(np.uint8))
            rep = plate("soften", "--base", str(o / "base.jpg"), "--frames", str(d), "--labels", str(d),
                        "--out", str(o / "soft.jpg"), "--zone-out", str(o / "zone.png"))
            self.assertEqual(rep["method"], "soft")
            self.assertEqual(rep["frames"], 20)
            self.assertTrue((o / "soft.jpg").exists() and (o / "zone.png").exists())


class BlockedMedianTest(unittest.TestCase):
    """Loop 6: the row-blocked uint8 median is byte-identical to the old
    full-frame float32 median (which peaked at 1.5 GB on 960x960)."""

    def test_blocked_matches_full_frame(self):
        import argparse
        sys.path.insert(0, str(BASIC))
        import plate as plate_mod
        rng = np.random.default_rng(5)
        h, w, n = 50, 70, 9
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            for i in range(n):
                f = rng.integers(0, 256, (h, w, 3), dtype=np.uint8)
                m = np.zeros((h, w), np.uint8)
                m[10:30, 5 + i * 5:25 + i * 5] = 1
                m[0:12, 0:15] = 1  # always covered: a hole
                cv2.imwrite(str(d / f"kf_{i:05d}.png"), m)
                cv2.imwrite(str(d / f"kf_{i:05d}.png").replace(".png", ".jpg"), f)
            # reference: the pre-loop-6 implementation
            frames, grays, masks = plate_mod.frames_and_masks(d, d, width=w)
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
            color = np.stack([cv2.resize(cv2.imread(str(f), cv2.IMREAD_COLOR), (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) for f in frames])
            ok = ~np.stack([cv2.dilate(m.astype(np.uint8), k).astype(bool) for m in masks])
            counts = ok.sum(0)
            ref = np.zeros((h, w, 3), np.float32)
            for c in range(3):
                ch = color[..., c]
                order = np.argsort(np.where(ok, ch, np.inf), axis=0)
                ranked = np.take_along_axis(ch, order, axis=0)
                mid = np.minimum(counts // 2, np.maximum(counts - 1, 0))
                ref[..., c] = np.take_along_axis(ranked, mid[None], axis=0)[0]
            holes = counts < 3
            fill = cv2.inpaint(ref.astype(np.uint8), holes.astype(np.uint8) * 255, 4, cv2.INPAINT_TELEA)
            ref[holes] = fill[holes].astype(np.float32)
            saved = plate_mod.MEDIAN_BLOCK_PX
            try:
                plate_mod.MEDIAN_BLOCK_PX = w * 7  # 7-row blocks, uneven last block
                out = d / "o"
                out.mkdir()
                with open(os.devnull, "w") as null:
                    old = sys.stdout
                    sys.stdout = null
                    try:
                        plate_mod.cmd_median(argparse.Namespace(frames=str(d), labels=str(d), width=w, dilate=5,
                                                                out=str(out / "p.png"), holes=str(out / "h.png"), meta=str(out / "m.json")))
                    finally:
                        sys.stdout = old
            finally:
                plate_mod.MEDIAN_BLOCK_PX = saved
            got = cv2.imread(str(out / "p.png"), cv2.IMREAD_COLOR)
            self.assertTrue(np.array_equal(got, ref.astype(np.uint8)))


class SoftDepthTest(unittest.TestCase):
    def test_zone_bump_is_replaced_by_the_surrounding_surface(self):
        h, w = 90, 160
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        ground = 1.0 + 3.0 * yy / h  # depth ramp: near at the bottom
        d = ground.copy()
        zone = np.zeros((h, w), np.uint8)
        zone[30:70, 60:110] = 255
        d[zone > 0] += 2.5  # the blurred zone read as a near blob
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            np.save(t / "depth_plate.npy", d)
            cv2.imwrite(str(t / "zone.png"), zone)
            rep = plate("soften-depth", "--depth", str(t / "depth_plate.npy"), "--zone", str(t / "zone.png"))
            out = np.load(t / "depth_plate.npy")
        self.assertTrue(rep["fitted"])
        self.assertLess(float(np.abs(out[35:65, 65:105] - ground[35:65, 65:105]).max()), 0.05)
        self.assertLess(float(np.abs(out[:10] - ground[:10]).max()), 1e-5, "outside the zone untouched")


class SoftMoverTest(unittest.TestCase):
    def test_untracked_passer_by_is_softened(self):
        sys.path.insert(0, str(BASIC))
        import plate as plate_mod
        rng = np.random.default_rng(9)
        h, w = 120, 200
        bg = np.full((h, w, 3), 140, np.float32) + rng.normal(0, 3, (h, w, 3)).astype(np.float32)
        frames, masks, grays = [], [], []
        for i in range(20):
            f = bg.copy()
            m = np.zeros((h, w), bool)
            m[40:80, 10:40] = True  # tracked subject, still
            f[m] = 20
            if i % 5 < 2:  # untracked second animal: 40% of frames, never masked
                f[30:70, 130:160] = 10
            frames.append(f)
            masks.append(m)
            grays.append(cv2.cvtColor(np.clip(f, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY))
        base = np.median(np.stack(frames), axis=0).astype(np.float32)
        base[30:70, 130:160] = 75  # a half-present smear in the median
        holes = np.stack(masks).all(0)
        out, zone, rep = plate_mod.soften_plate(base, masks, holes, grays)
        self.assertGreater(rep["moverShare"], 0.03)
        self.assertTrue(zone[50, 145])
        self.assertLess(float(np.abs(out[45:55, 140:150] - 140).max()), 15.0, "smear replaced by the surroundings")
        _, zone0, rep0 = plate_mod.soften_plate(base, masks, holes)
        self.assertFalse(zone0[50, 145], "without keyframes the mover check is off")
