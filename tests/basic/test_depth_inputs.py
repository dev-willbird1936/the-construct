"""Native depth input guards; synthetic-only, no model or original mask writes."""
import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "backend/pipeline/basic/depth.py"
spec = importlib.util.spec_from_file_location("native_depth_inputs", SOURCE)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def forbidden_session(*args, **kwargs):
    raise AssertionError("No inference in input guard tests")


native.session = forbidden_session


class DepthInputContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="depth-input-contract-")
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.depth, self.labels, self.fitted = (self.folder / p for p in ("depth", "labels", "fitted"))
        self.depth.mkdir(parents=True)
        self.labels.mkdir()
        yy, xx = np.mgrid[:32, :32]
        self.reference = (2 + xx / 8 + yy / 12).astype(np.float32)
        self.label = np.zeros((32, 32), np.uint8)
        self.label[10:20, 10:20] = 1

    def inputs(self, *, missing=False, nan_reference=False, nan_frame=False, wrong_shape=False, corrupt_label=False, large_labels=False):
        ref = self.reference.copy()
        frame = (ref - 3) / 2
        if nan_reference:
            ref[0, 0] = np.nan
        if nan_frame:
            frame[0, 0] = np.nan
        if wrong_shape:
            frame = frame[:16]
        for name, arr in [("kf_00000", ref), ("kf_00001", frame), ("plate", self.reference / 3 + 5)]:
            np.save(self.depth / f"depth_{name}.npy", arr)
        label = np.repeat(np.repeat(self.label, 2, axis=0), 2, axis=1) if large_labels else self.label
        self.assertTrue(cv2.imwrite(str(self.labels / "kf_00000.png"), label))
        if not missing:
            if corrupt_label:
                (self.labels / "kf_00001.png").write_bytes(b"invalid synthetic png")
            else:
                self.assertTrue(cv2.imwrite(str(self.labels / "kf_00001.png"), label))

    def fit(self):
        args = SimpleNamespace(depth=self.depth, labels=self.labels, out=self.fitted, ref="kf_00000", track="1")
        with contextlib.redirect_stdout(io.StringIO()):
            native.cmd_fit(args)

    def test_clean_affine(self):
        x = np.linspace(1, 100, 4096, dtype=np.float64)
        a, b = native.robust_fit(2.3 * x + 7.1, x)
        np.testing.assert_allclose(a * x + b, 2.3 * x + 7.1, atol=1e-10)

    def test_nonfinite_ref_rejected(self):
        x = np.linspace(1, 100, 100)
        y = x.copy()
        y[0] = np.nan
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            native.robust_fit(y, x)

    def test_nonfinite_input_rejected(self):
        x = np.linspace(1, 100, 100)
        y = x.copy()
        x[0] = np.nan
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            native.robust_fit(y, x)

    def test_shape_rejected(self):
        with self.assertRaisesRegex(ValueError, "shape"):
            native.robust_fit(np.ones(100), np.ones(101))

    def test_missing_frame_label_rejected_before_outputs(self):
        self.inputs(missing=True)
        with self.assertRaisesRegex(FileNotFoundError, "kf_00001"):
            self.fit()
        self.assertFalse(self.fitted.exists())

    def test_nan_reference_rejected_before_outputs(self):
        self.inputs(nan_reference=True)
        with self.assertRaisesRegex(ValueError, "reference"):
            self.fit()
        self.assertFalse(self.fitted.exists())

    def test_nan_later_frame_rejected_before_outputs(self):
        self.inputs(nan_frame=True)
        with self.assertRaisesRegex(ValueError, "kf_00001"):
            self.fit()
        self.assertFalse(self.fitted.exists())

    def test_wrong_depth_shape_rejected_before_outputs(self):
        self.inputs(wrong_shape=True)
        with self.assertRaisesRegex(ValueError, "kf_00001"):
            self.fit()
        self.assertFalse(self.fitted.exists())

    def test_corrupt_label_rejected_before_outputs(self):
        self.inputs(corrupt_label=True)
        with self.assertRaisesRegex(ValueError, "kf_00001"):
            self.fit()
        self.assertFalse(self.fitted.exists())

    def test_valid_job_and_unlabelled_plate_preserved(self):
        self.inputs()
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.labels.glob("*.png")}
        self.fit()
        arrays = {name: np.load(self.fitted / f"fitted_{name}.npy") for name in ["kf_00000", "kf_00001", "plate"]}
        for array in arrays.values():
            self.assertEqual(array.shape, (32, 32))
            self.assertEqual(array.dtype, np.float32)
            self.assertTrue(np.isfinite(array).all())
        np.testing.assert_array_equal(arrays["kf_00001"], arrays["kf_00000"])
        np.testing.assert_allclose(arrays["plate"], arrays["kf_00000"], atol=1e-5)
        report = {r["name"]: r for r in json.loads((self.fitted / "fit.json").read_text())["frames"]}
        self.assertAlmostEqual(report["kf_00001"]["scale"], 2)
        self.assertAlmostEqual(report["kf_00001"]["shift"], 3)
        self.assertEqual(report["plate"]["bgPixels"], 32 * 32)
        self.assertIsNone(report["plate"]["subjectMedian"])
        self.assertTrue(all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in before.items()))

    def test_existing_nearest_label_normalisation_is_unchanged(self):
        self.inputs(large_labels=True)
        before = {p: p.read_bytes() for p in self.labels.glob("*.png")}
        self.fit()
        reference = np.load(self.fitted / "fitted_kf_00000.npy")
        expected_median = float(np.median(reference[self.label == 1]))
        report = json.loads((self.fitted / "fit.json").read_text())
        for frame in report["frames"]:
            if frame["name"] != "plate":
                self.assertAlmostEqual(frame["subjectMedian"], expected_median, places=5)
                self.assertLess(frame["bgPixels"], 32 * 32)
        self.assertTrue(all(p.read_bytes() == data for p, data in before.items()))

    def test_threaded_fit_matches_serial(self):
        # loop 11: frames are fitted in a thread pool; maps and report must
        # be byte-identical to one thread, in the same order
        self.inputs()
        rng = np.random.default_rng(3)
        for k in range(2, 9):  # more frames than threads, with noise
            np.save(self.depth / f"depth_kf_{k:05d}.npy", ((self.reference - 1.5) / 1.7 + rng.normal(0, 0.01, (32, 32))).astype(np.float32))
            self.assertTrue(cv2.imwrite(str(self.labels / f"kf_{k:05d}.png"), self.label))
        outs = {}
        for threads in (1, 3):
            out = self.folder / f"fitted-{threads}"
            args = SimpleNamespace(depth=self.depth, labels=self.labels, out=out, ref="kf_00000", track="1", threads=threads)
            with contextlib.redirect_stdout(io.StringIO()):
                native.cmd_fit(args)
            outs[threads] = {p.name: p.read_bytes() for p in sorted(out.iterdir())}
        self.assertEqual(len(outs[1]), 11)  # 10 maps + fit.json
        self.assertEqual(outs[1], outs[3])

    @classmethod
    def tearDownClass(cls):
        if "onnxruntime" in sys.modules:
            raise AssertionError("Neural runtime must not be imported")


if __name__ == "__main__":
    unittest.main(verbosity=2)
