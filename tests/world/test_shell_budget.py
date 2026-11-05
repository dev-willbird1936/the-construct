"""A world bakes at most SHELL_BUDGET shells: past it each animal is baked every k-th sample (make-world.py)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
from world_shells import shell_stride  # noqa: E402


class ShellBudget(unittest.TestCase):
    def test_a_world_within_the_budget_bakes_every_sample(self):
        self.assertEqual(shell_stride({1: 120, 2: 118}, 1500), 1)
        self.assertEqual(shell_stride({1: 1500}, 1500), 1)
        self.assertEqual(shell_stride({}, 1500), 1)

    def test_past_the_budget_each_animal_is_baked_every_kth_sample(self):
        self.assertEqual(shell_stride({t: 450 for t in range(10)}, 1500), 3)    # a pack of ten for 30 s
        self.assertEqual(shell_stride({1: 1501}, 1500), 2)
        self.assertLessEqual(4500 / shell_stride({t: 450 for t in range(10)}, 1500), 1500)

    def test_no_budget_means_no_cap(self):
        self.assertEqual(shell_stride({1: 9000}, 0), 1)


if __name__ == "__main__":
    unittest.main()
