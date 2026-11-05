"""The mask repair's contacts, worked out once per mask and in a window (world_masks.Contacts), equal contact() on
the full frame, and merge_fragments gives the same pieces."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "tools"))
import world_masks  # noqa: E402


def blobs(rng, n_tracks, n_samples, h=90, w=160):
    out = []
    for i in range(n_samples):
        frame = {}
        for t in range(1, n_tracks + 1):
            if rng.random() < 0.15:
                continue                    # absent this moment
            m = np.zeros((h, w), bool)
            cy, cx = rng.integers(0, h), rng.integers(0, w)   # anywhere, the frame's edges included
            ry, rx = rng.integers(1, 12), rng.integers(1, 20)
            m[max(cy - ry, 0):cy + ry, max(cx - rx, 0):cx + rx] = True
            if rng.random() < 0.3:
                m[max(cy - 1, 0):cy + 1, :] |= rng.random(w) < 0.5    # ragged parts
            frame[t] = m
        out.append(frame)
    return out


def original_merge_fragments(masks):
    """merge_fragments as it was before Contacts (loop 7), verbatim but for the names"""
    W = world_masks
    life = {}
    for i, frame in enumerate(masks):
        for t in frame:
            life.setdefault(t, []).append(i)
    parent = {}
    rank = {t: (len(life[t]), -t) for t in life}
    for b in sorted(life, key=lambda t: rank[t]):
        if len(life[b]) < W.MIN_LIFE:
            parent[b] = 0
            continue
        best = None
        for a in life:
            if rank[a] <= rank[b]:
                continue
            together = [W.contact(masks[i][b], masks[i][a]) >= W.TOUCH for i in life[b] if a in masks[i]]
            share = sum(together) / len(life[b])
            if share >= W.TOGETHER and (best is None or share > best[0]) and W.absorbed(masks, life, b, a):
                best = (share, a)
        if best:
            parent[b] = best[1]

    def root(t):
        while t in parent:
            if parent[t] == 0:
                return 0
            t = parent[t]
        return t

    return {b: root(b) for b in parent}, life


class Contacts(unittest.TestCase):
    def test_equal_to_contact_on_the_full_frame(self):
        rng = np.random.default_rng(7)
        masks = blobs(rng, 6, 40)
        touch = world_masks.Contacts(masks)
        n = 0
        for i, frame in enumerate(masks):
            for b in frame:
                for a in frame:
                    if a != b:
                        self.assertEqual(touch(i, b, a), world_masks.contact(frame[b], frame[a]))
                        n += 1
        self.assertGreater(n, 500)

    def test_merge_fragments_unchanged(self):
        h, w = 90, 160
        masks = []
        for i in range(30):
            host = np.zeros((h, w), bool)
            host[30:50, 40:80] = True
            frame = {1: host}
            if i % 5:
                piece = np.zeros((h, w), bool)
                piece[26:30, 45:75] = True                # a head on top of the body: one animal
                frame[2] = piece
            else:
                host[26:30, 45:75] = True                 # and the body takes it in when it is gone
            far = np.zeros((h, w), bool)
            far[60:80, 100 + i % 3:130] = True           # a second animal, never touching
            frame[3] = far
            masks.append(frame)
        masks += [{t + 10: m for t, m in f.items()} for f in blobs(np.random.default_rng(3), 5, 30)]   # and random others
        before = original_merge_fragments(masks)
        self.assertEqual(before[0].get(2), 1, "the case has a merge to find")
        self.assertEqual(world_masks.merge_fragments(masks), before)


if __name__ == "__main__":
    unittest.main()
