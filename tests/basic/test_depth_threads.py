"""Keyframe depth threads follow the usable CPUs (tier-improve loop 10):
BASIC_THREADS wins, else half the usable CPUs kept in 2..4, so a small
container keeps the old 2 threads.
Run: .venv/Scripts/python -m unittest discover -s tests/basic -p "test_*.py"."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "pipeline" / "basic"))
import depth  # noqa: E402


class DepthThreadsTest(unittest.TestCase):
    def threads(self, cpus, env=None):
        with mock.patch.object(depth, "available_cpus", return_value=cpus), \
                mock.patch.dict(os.environ, {} if env is None else {"BASIC_THREADS": env}, clear=False):
            if env is None:
                os.environ.pop("BASIC_THREADS", None)
            return depth.default_threads()

    def test_small_containers_keep_two(self):
        for cpus in (1, 2, 3, 4, 5):
            self.assertEqual(self.threads(cpus), 2, cpus)

    def test_larger_hosts_cap_at_four(self):
        self.assertEqual(self.threads(6), 3)
        self.assertEqual(self.threads(8), 4)
        self.assertEqual(self.threads(32), 4)

    def test_env_wins(self):
        self.assertEqual(self.threads(32, "2"), 2)
        self.assertEqual(self.threads(2, "6"), 6)

    def test_available_cpus_is_positive(self):
        self.assertGreaterEqual(depth.available_cpus(), 1)


class ConcurrentInferTest(unittest.TestCase):
    """Loop 11: the thread budget runs frames concurrently on one session
    with one intra-op thread each; the maps are the same as one at a time."""

    def test_concurrent_frames_match_serial(self):
        import contextlib
        import io
        import tempfile
        from types import SimpleNamespace

        import cv2
        import numpy as np

        made = []

        class FakeSession:
            def run(self, _outputs, feeds):
                x = next(iter(feeds.values()))
                return [x[:, 0] * 2 + x[:, 1]]  # deterministic per frame

        def fake_session(_model, threads):
            made.append(threads)
            return FakeSession(), "x"

        with tempfile.TemporaryDirectory() as d, mock.patch.object(depth, "session", fake_session):
            frames = Path(d) / "frames"
            frames.mkdir()
            rng = np.random.default_rng(2)
            for i in range(6):
                cv2.imwrite(str(frames / f"kf_{i:05d}.jpg"), rng.integers(0, 255, (60, 90, 3), dtype=np.uint8))
            outs = {}
            for threads in (1, 3):
                out = Path(d) / f"out{threads}"
                with contextlib.redirect_stdout(io.StringIO()) as log:
                    depth.cmd_infer(SimpleNamespace(model="m", frames=str(frames), out=str(out), size=42, threads=threads))
                outs[threads] = {p.name: p.read_bytes() for p in sorted(out.iterdir())}
                lines = [line for line in log.getvalue().splitlines() if line.startswith("infer kf_")]
                self.assertEqual(lines, sorted(lines))  # reported in frame order
            self.assertEqual(made, [1, 1])  # one thread: itself; three: one intra-op thread per run
            self.assertEqual(len(outs[1]), 6)
            self.assertEqual(outs[1], outs[3])


if __name__ == "__main__":
    unittest.main()
