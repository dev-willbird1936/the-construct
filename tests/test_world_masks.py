"""Synthetic checks of the mask repair (backend/tools/world_masks.py).

  <da3 python> -I tests/test_world_masks.py

A work folder is built in a temp directory: a grey scene, a plate of it, and labels for blobs that
move across it. Each case breaks the tracker's output in one way and checks that the repair mends it.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "tools"))
from world_common import Work  # noqa: E402
import world_masks as M  # noqa: E402

W, H, N = 320, 180, 40


def scene():
    rng = np.random.default_rng(1)
    base = cv2.GaussianBlur(rng.integers(60, 140, (H, W, 3)).astype(np.uint8), (0, 0), 3)
    return base


def make_work(root, boxes):
    """boxes: {track: {sample: (x0, y0, x1, y1)}}; the frame shows a dark blob wherever any box is"""
    root = Path(root)
    (root / "labels").mkdir(parents=True)
    (root / "frames").mkdir()
    base = scene()
    for i in range(N):
        lab = np.zeros((H, W), np.uint8)
        frame = base.copy()
        for t, per in boxes.items():
            for j, (x0, y0, x1, y1) in per.items():
                if j == i:
                    lab[y0:y1, x0:x1] = t
        for per in boxes.values():
            if i in per:
                pass
        cv2.imwrite(str(root / "labels" / f"l{i:05d}.png"), lab)
        # the footage has the blob wherever the animal really is, even where the tracker lost it
        for t, per in boxes.items():
            truth = per.get(i) or TRUTH.get((t, i))
            if truth:
                x0, y0, x1, y1 = truth
                frame[y0:y1, x0:x1] = 20
        cv2.imwrite(str(root / "frames" / f"f{i:05d}.jpg"), frame)
    (root / "tracks.json").write_text(json.dumps({"fps": 15, "start": 0, "samples": N, "width": W, "height": H, "concept": "animal", "tracks": []}))
    return Work(root, root / "clip.mp4"), base


TRUTH = {}


class Repair(unittest.TestCase):
    def test_fragments_of_one_animal_become_one(self):
        # a head and a body that never come apart, and that SAM draws as one body for a stretch
        body = {i: (40 + i, 60, 120 + i, 90) for i in range(15, 25)}
        boxes = {1: {i: (40 + i, 60, 70 + i, 90) for i in range(N) if not 15 <= i < 25},
                 2: {i: (70 + i, 60, 120 + i, 90) for i in range(N) if not 15 <= i < 25}}
        boxes[2].update(body)
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, boxes)
            masks = M.small_masks(work)
            pieces, _ = M.merge_fragments(masks)
            self.assertEqual(pieces, {1: 2})            # the piece joins the one that swallows it

    def test_two_animals_that_stay_together_stay_two(self):
        # a pack: neighbours touch for the whole clip and neither ever covers the other
        boxes = {1: {i: (40 + i, 60, 70 + i, 90) for i in range(N)}, 2: {i: (70 + i, 60, 120 + i, 90) for i in range(N)}}
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, boxes)
            pieces, _ = M.merge_fragments(M.small_masks(work))
            self.assertEqual(pieces, {})

    def test_two_animals_that_part_stay_two(self):
        # they touch for a while, then walk apart
        a = {i: (40 + 2 * i if i > 20 else 40, 60, 70 + 2 * i if i > 20 else 70, 90) for i in range(N)}
        b = {i: (70, 60, 100, 90) for i in range(N)}
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, {1: a, 2: b})
            pieces, _ = M.merge_fragments(M.small_masks(work))
            self.assertEqual(pieces, {})

    def test_a_flicker_is_dropped(self):
        boxes = {1: {i: (40, 60, 80, 100) for i in range(N)}, 2: {5: (200, 20, 230, 50), 6: (200, 20, 230, 50)}}
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, boxes)
            pieces, _ = M.merge_fragments(M.small_masks(work))
            self.assertEqual(pieces, {2: 0})

    def test_a_dropout_is_bridged_by_the_plate_difference(self):
        TRUTH.clear()
        seen = {i: (100 + 3 * i, 70, 140 + 3 * i, 110) for i in range(N)}
        lost = range(15, 22)
        boxes = {1: {i: b for i, b in seen.items() if i not in lost}}
        for i in lost:
            TRUTH[(1, i)] = seen[i]
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, boxes)
            work.top = H
            masks = M.small_masks(work)
            T = M.noise_floor(work, work.frame, base, masks)
            fills = M.bridge_dropouts(work, work.frame, base, masks, [1], T)
            self.assertEqual(sorted(fills), list(lost))
            x0, y0, x1, y1 = seen[18]
            inside = fills[18][1][y0:y1, x0:x1].mean()
            self.assertGreater(inside, 0.9)
        TRUTH.clear()

    def test_a_speck_far_from_the_rest_of_its_track_is_dropped(self):
        TRUTH.clear()
        boxes = {1: {i: (60, 60, 110, 100) for i in range(0, 20)}, 2: {i: (150, 60, 200, 100) for i in range(0, 12)}}
        boxes[2][33] = (150, 60, 200, 100)       # found again for one sample, long after it left
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, boxes)
            self.assertEqual(M.stray_runs(M.small_masks(work), 15), {2: [33]})

    def test_a_departure_and_an_arrival_are_not_one_animal(self):
        TRUTH.clear()
        boxes = {1: {i: (10, 60, 50, 100) for i in range(0, 15)}, 2: {i: (260, 60, 300, 100) for i in range(22, N)}}
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, boxes)
            work.top = H
            masks = M.small_masks(work)
            T = M.noise_floor(work, work.frame, base, masks)
            joins, fills = M.stitch_tracks(work, work.frame, base, masks, T)
            self.assertEqual(joins, {})

    def test_the_same_animal_under_a_new_id_the_next_sample_is_joined(self):
        # a second pass over the strip (read backwards) hands the animal on under its own id, with no gap
        TRUTH.clear()
        boxes = {1: {i: (100 + i, 60, 140 + i, 100) for i in range(0, 20)}, 2: {i: (100 + i, 60, 140 + i, 100) for i in range(20, N)}}
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, boxes)
            work.top = H
            masks = M.small_masks(work)
            T = M.noise_floor(work, work.frame, base, masks)
            joins, fills = M.stitch_tracks(work, work.frame, base, masks, T)
            self.assertEqual(joins, {2: 1})

    def test_a_neighbour_that_starts_elsewhere_is_not_joined(self):
        TRUTH.clear()
        boxes = {1: {i: (10, 60, 50, 100) for i in range(0, 20)}, 2: {i: (250, 60, 290, 100) for i in range(20, N)}}
        with tempfile.TemporaryDirectory() as d:
            work, base = make_work(d, boxes)
            work.top = H
            masks = M.small_masks(work)
            T = M.noise_floor(work, work.frame, base, masks)
            joins, fills = M.stitch_tracks(work, work.frame, base, masks, T)
            self.assertEqual(joins, {})


if __name__ == "__main__":
    unittest.main()
