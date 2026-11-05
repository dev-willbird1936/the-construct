"""Occluded-body fill (tier-improve loop 11): a moving occluder that hides
part of the body on one keyframe is filled back into its alpha; a static
occluder, a small nibble or a fringe outside the body is not. Loop 12: the
fill and the occluder's specks near it are painted as body.
Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import sys
import unittest
from pathlib import Path

import numpy as np

BASIC = Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"
sys.path.insert(0, str(BASIC))
import occlusion  # noqa: E402

H, W = 120, 160


def body(dx=0):
    m = np.zeros((H, W), bool)
    m[30:90, 40 + dx:120 + dx] = True
    return m


def scene():
    plate = np.full((H, W, 3), 90, np.uint8)
    src = plate.copy()
    src[30:90, 40:120] = (40, 60, 80)  # the subject
    return plate, src


class OcclusionFill(unittest.TestCase):
    def run_fill(self, mk, src, plate, shift=0):
        c = lambda m: [float(np.where(m)[1].mean()) / W, float(np.where(m)[0].mean()) / H]
        mp, mn = body(-shift), body(shift)
        return occlusion.fill_for(mk, mp, mn, src, plate, c(mk), c(mp), c(mn))

    def test_moving_occluder_hole_is_filled_with_source(self):
        plate, src = scene()
        mk = body()
        mk[55:90, 60:100] = False  # an arch open at the bottom, hidden by a splash
        src[55:90, 60:100] = 250   # the splash: not in the plate
        fill = self.run_fill(mk, src, plate, shift=4)
        self.assertGreater(fill[58:78, 64:96].mean(), 0.95)  # centroid alignment is approximate near the open edge
        self.assertFalse(fill[:30].any() or fill[90:].any())  # never outside the box

    def test_static_occluder_matches_the_plate_and_stays(self):
        plate, src = scene()
        mk = body()
        mk[55:90, 60:100] = False
        src[55:90, 60:100] = plate[55:90, 60:100]  # what is there is in the plate
        self.assertFalse(self.run_fill(mk, src, plate).any())

    def test_small_nibble_stays(self):
        plate, src = scene()
        mk = body()
        mk[60:66, 70:76] = False  # under 5% of the body
        src[60:66, 70:76] = 250
        self.assertFalse(self.run_fill(mk, src, plate).any())

    def test_a_region_the_body_does_not_surround_stays(self):
        plate, src = scene()
        mk = body()
        mk[30:60, 40:80] = False  # a corner notch: half its rim is background
        src[30:60, 40:80] = 250
        self.assertFalse(self.run_fill(mk, src, plate).any())


class EndKeyframes(unittest.TestCase):
    """An end keyframe has one keyframe neighbour; its second is the outer
    track sample (--outer). Without one it is never filled."""

    def test_neighbours(self):
        fr = [{"sample": s, "centroid": [0.5, 0.5]} for s in (10, 12, 15)]
        outer = {15: {"end": 15, "sample": 16, "file": "x"}}
        self.assertEqual(occlusion.neighbours(1, fr, outer), (("kf", fr[0]), ("kf", fr[2])))
        self.assertEqual(occlusion.neighbours(2, fr, outer), (("kf", fr[1]), ("outer", outer[15])))
        self.assertIsNone(occlusion.neighbours(0, fr, outer))  # no outer sample before 10
        self.assertIsNone(occlusion.neighbours(0, fr[:1], {10: {"end": 10}}))

    def test_last_keyframe_is_filled_from_its_outer_sample(self):
        import contextlib, io, json, os, tempfile
        import cv2
        plate, src = scene()
        hole = body()
        hole[55:90, 60:100] = False
        src[55:90, 60:100] = 250
        with tempfile.TemporaryDirectory() as d:
            for s, m in ((10, body()), (12, body()), (15, hole)):
                cv2.imwrite(os.path.join(d, f"kf_{s:05d}.png"), m.astype(np.uint8))
                cv2.imwrite(os.path.join(d, f"kf_{s:05d}.jpg"), src)
            cv2.imwrite(os.path.join(d, "nb_00016.png"), body().astype(np.uint8))
            cv2.imwrite(os.path.join(d, "plate.png"), plate)
            c = lambda m: [float(np.where(m)[1].mean()) / W, float(np.where(m)[0].mean()) / H]
            json.dump([{"sample": s, "centroid": c(m)} for s, m in ((10, body()), (12, body()), (15, hole))], open(os.path.join(d, "frames.json"), "w"))
            out = os.path.join(d, "occ")
            for outer in ([], [{"end": 15, "sample": 16, "file": os.path.join(d, "nb_00016.png")}]):
                json.dump(outer, open(os.path.join(d, "outer.json"), "w"))
                argv, buf = sys.argv, io.StringIO()
                sys.argv = ["occlusion.py", "--kf", d, "--plate", os.path.join(d, "plate.png"), "--frames", os.path.join(d, "frames.json"),
                            "--ids", "1", "--out", out, "--outer", os.path.join(d, "outer.json")]
                try:
                    with contextlib.redirect_stdout(buf):
                        occlusion.main()
                finally:
                    sys.argv = argv
                filled = json.loads(buf.getvalue())["filled"]
                if outer:
                    self.assertGreater(filled.get("15", 0), 0.75 * 35 * 40)  # centroid alignment trims the open edge
                else:
                    self.assertEqual(filled, {})


class PaintedAsBody(unittest.TestCase):
    """Loop 12: the filled region and the occluder's specks near it are
    painted as body (from the nearer keyframe neighbour, colour-matched),
    not with the splash; specks far from the region and keyframes without a
    fill are left alone."""

    def run_main(self, d, frames):
        import contextlib, io, json, os
        out = os.path.join(d, "occ")
        json.dump(frames, open(os.path.join(d, "frames.json"), "w"))
        argv, buf = sys.argv, io.StringIO()
        sys.argv = ["occlusion.py", "--kf", d, "--plate", os.path.join(d, "plate.png"), "--frames", os.path.join(d, "frames.json"),
                    "--ids", "1", "--out", out]
        try:
            with contextlib.redirect_stdout(buf):
                occlusion.main()
        finally:
            sys.argv = argv
        return json.loads(buf.getvalue()), out

    def test_splash_and_specks_become_body(self):
        import os, tempfile
        import cv2
        plate, clean = scene()
        rng = np.random.default_rng(1)
        clean[30:90, 40:120] = np.clip(clean[30:90, 40:120].astype(int) + rng.integers(-6, 7, (60, 80, 3)), 0, 255).astype(np.uint8)  # fur
        hit = clean.copy()
        hole = body()
        hole[60:90, 64:96] = False
        hit[60:90, 64:96] = 250                       # the splash in the arch
        for y, x in ((52, 70), (54, 86), (50, 78)):   # spray specks just above it
            hit[y:y + 2, x:x + 2] = 250
        hit[33:35, 112:114] = 250                     # a highlight far away stays
        c = lambda m: [float(np.where(m)[1].mean()) / W, float(np.where(m)[0].mean()) / H]
        with tempfile.TemporaryDirectory() as d:
            for s, m, img in ((10, body(), clean), (12, hole, hit), (15, body(), clean)):
                cv2.imwrite(os.path.join(d, f"kf_{s:05d}.png"), m.astype(np.uint8))
                cv2.imwrite(os.path.join(d, f"kf_{s:05d}.png".replace(".png", ".jpg")), img, [cv2.IMWRITE_JPEG_QUALITY, 100])
            cv2.imwrite(os.path.join(d, "plate.png"), plate)
            rep, out = self.run_main(d, [{"sample": s, "centroid": c(m)} for s, m in ((10, body()), (12, hole), (15, body()))])
            self.assertIn("12", rep["filled"])
            self.assertGreater(rep["cleaned"]["12"], rep["filled"]["12"])  # specks repainted too
            img = cv2.imread(os.path.join(out, "occ_rgb_kf_00012.png"))
            mask = cv2.imread(os.path.join(out, "occ_clean_kf_00012.png"), cv2.IMREAD_GRAYSCALE) > 0
            fur = np.array([40, 60, 80], float)
            fill = cv2.imread(os.path.join(out, "occ_kf_00012.png"), cv2.IMREAD_GRAYSCALE) > 0
            self.assertTrue(mask[fill].all())
            self.assertLess(np.abs(img[fill].mean(0) - fur).max(), 15)    # the arch reads as fur
            for y, x in ((52, 70), (54, 86), (50, 78)):
                self.assertLess(img[y:y + 2, x:x + 2].mean(), 120, f"speck at {y},{x}")
            self.assertGreater(img[33:35, 112:114].mean(), 200)          # far highlight untouched
            self.assertFalse(mask[33:35, 112:114].any())
            self.assertEqual(sorted(f for f in os.listdir(out) if f.endswith(".png")),
                             ["occ_clean_kf_00012.png", "occ_kf_00012.png", "occ_rgb_kf_00012.png"])  # only the filled keyframe


class SprayOnTheBody(unittest.TestCase):
    """Loop 12: spray in front of a near subject is inside its mask on
    keyframes without any fill (fresh grizzly: white specks across the rear
    half). Bright colourless specks on the body where the plate behind is
    white water are repainted as fur on every keyframe of a clip that has
    one heavily specked keyframe; a pale marking in front of a dark plate,
    and a clip with only a few specks, are untouched."""

    SPECKS = [(y, x) for y in range(34, 88, 6) for x in range(44, 118, 8)]  # 90 specks of 2x2 = 7.5% of the body

    def run_clip(self, plate_value, counts):
        import contextlib, io, json, os, tempfile
        import cv2
        plate = np.full((H, W, 3), plate_value, np.uint8)
        rng = np.random.default_rng(2)
        c = [float(np.where(body())[1].mean()) / W, float(np.where(body())[0].mean()) / H]
        imgs = {}
        with tempfile.TemporaryDirectory() as d:
            for s, n in counts.items():
                img = plate.copy()
                img[30:90, 40:120] = np.clip(np.array([40, 60, 80]) + rng.integers(-6, 7, (60, 80, 3)), 0, 255).astype(np.uint8)
                for y, x in self.SPECKS[:n]:
                    img[y:y + 2, x:x + 2] = 245
                cv2.imwrite(os.path.join(d, f"kf_{s:05d}.png"), body().astype(np.uint8))
                cv2.imwrite(os.path.join(d, f"kf_{s:05d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 100])
                imgs[s] = cv2.imread(os.path.join(d, f"kf_{s:05d}.jpg"))  # as decoded
            cv2.imwrite(os.path.join(d, "plate.png"), plate)
            json.dump([{"sample": s, "centroid": c} for s in counts], open(os.path.join(d, "frames.json"), "w"))
            out = os.path.join(d, "occ")
            argv, buf = sys.argv, io.StringIO()
            sys.argv = ["occlusion.py", "--kf", d, "--plate", os.path.join(d, "plate.png"), "--frames", os.path.join(d, "frames.json"),
                        "--ids", "1", "--out", out]
            try:
                with contextlib.redirect_stdout(buf):
                    occlusion.main()
            finally:
                sys.argv = argv
            rep = json.loads(buf.getvalue())
            got = {s: cv2.imread(os.path.join(out, f"occ_rgb_kf_{s:05d}.png")) for s in counts
                   if os.path.exists(os.path.join(out, f"occ_rgb_kf_{s:05d}.png"))}
            masks = {s: cv2.imread(os.path.join(out, f"occ_clean_kf_{s:05d}.png"), cv2.IMREAD_GRAYSCALE) > 0 for s in got}
        return rep, imgs, got, masks

    def test_spray_over_white_water_is_painted_as_fur(self):
        rep, imgs, got, masks = self.run_clip(215, {10: 0, 12: 90, 15: 8})  # 7.5% and 0.7% specked
        self.assertEqual(rep["filled"], {})
        self.assertEqual(sorted(got), [12, 15])                    # the clean keyframe is not written
        self.assertEqual(sorted(rep["cleaned"]), ["12", "15"])
        for s, n in ((12, 90), (15, 8)):
            for y, x in self.SPECKS[:n]:
                self.assertLess(got[s][y:y + 2, x:x + 2].mean(), 110, f"speck {y},{x} on {s}")
            self.assertLessEqual(int(masks[s].sum()), 16 * n)        # only the specks, grown 1 px
            away = body() & ~masks[s]
            self.assertTrue(np.array_equal(got[s][away], imgs[s][away]))  # the fur elsewhere is the source

    def test_a_pale_marking_in_front_of_a_dark_plate_stays(self):
        rep, _, got, _ = self.run_clip(90, {10: 0, 12: 90, 15: 8})
        self.assertEqual((rep["cleaned"], got), ({}, {}))

    def test_a_few_specks_are_not_a_spray_occluder(self):
        rep, _, got, _ = self.run_clip(215, {10: 8, 12: 12, 15: 0})  # at most 1% of the body
        self.assertEqual((rep["cleaned"], got), ({}, {}))


if __name__ == "__main__":
    unittest.main()
