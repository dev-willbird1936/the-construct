"""No inference or asset mutation: inventory tests use disposable directories."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("stable_index", Path(__file__).parents[1] / "backend/tools/stable_index.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StableIndexTest(unittest.TestCase):
    def test_only_complete_optional_bakes_are_indexed(self):
        with tempfile.TemporaryDirectory(prefix="stable-index-test-") as directory:
            root = Path(directory)
            for clip in ("walker", "horse", "partial"):
                (root / clip).mkdir()
                (root / clip / "stable.json").write_text("{}")
            (root / "walker/stable.dedup.json").write_text("{}")
            (root / "walker/idx.dedup.u32").write_bytes(b"\0" * 4)
            (root / "partial/stable.dedup.json").write_text("{}")
            self.assertEqual(module.update_index(root), ["walker"])
            self.assertEqual(json.loads((root / "merged-clips.json").read_text()), ["walker"])
            self.assertEqual(list(root.glob("*.tmp")), [])

    def test_empty_and_updated_inventory(self):
        with tempfile.TemporaryDirectory(prefix="stable-index-test-") as directory:
            root = Path(directory)
            self.assertEqual(module.update_index(root), [])
            for clip in ("zebra", "cat"):
                (root / clip).mkdir()
                (root / clip / "stable.json").write_text("{}")
                (root / clip / "stable.dedup.json").write_text("{}")
                (root / clip / "idx.dedup.u32").write_bytes(b"\0" * 4)
            self.assertEqual(module.update_index(root), ["cat", "zebra"])


if __name__ == "__main__":
    unittest.main()
