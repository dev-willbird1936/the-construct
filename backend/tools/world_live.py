"""Paints the animals out of the footage, for the live video the page plays on the rebuilt scene.

The plate (the median of every moment a pixel was free) supplies the colour. Two things make a
patch of it look wrong on moving water, and both are handled here:

  shadow and reflection   an animal in water brings a dark reflection and a splash that its mask does
                          not cover; cut at the mask's edge they remain as floating dark blocks.
                          Whatever differs from the plate beside the animal, connected to it, is part
                          of it.
  flat patch              the plate is a median: smooth. The ripples of the surface are put back from
                          the nearest moments each hidden pixel was free (frozen, but real texture of
                          the right scale), clipped so a stray shadow cannot come back with them.
  wrong brightness        the plate is the clip's typical light, but a camera's auto-exposure follows a
                          big dark animal (the sky brightens as a moose walks up). The patch is shifted by
                          how the footage around it differs from the plate, smoothly (a low-frequency
                          field, filled in from the ring outside the patch), so its edge meets the footage.

Cost: one difference image and a few mask operations per output frame.
"""
import cv2
import numpy as np

from world_common import hide_strip
from world_env import animals, union_mask
from world_masks import difference

STEP = 8             # samples between the moments ripples are borrowed from (about half a second)
SIGMA = 7            # px: what is texture and what is colour
CLIP = 9             # levels: ripples are borrowed softly (tanh) up to this; grass blades and bark are not ripples
REACH = 150          # samples: how far in time to look for a moment a pixel was free
SEAM = True          # match the patch's brightness to the footage around it
SEAM_PAD = 48        # px around the painted box where the footage is compared with the plate
SEAM_SIGMA = 12      # px: the ring is smoothed this much before it is filled inwards
SEAM_CLIP = 60       # levels: a larger difference is something passing (a bird, a splash), not light
SEAM_SCALE = 4       # the field is smooth: it is worked out at a quarter of the size
SEAM_TRUST = 0.25    # ring weight at which a cell keeps its own value and takes nothing from coarser levels


def push_pull(num, den, fallback):
    """fills a weighted field (num = sum of weight x value, den = sum of weight) everywhere: each cell
    keeps its own value as far as its weight allows and takes the rest from the next coarser level, so a
    hole is filled from its nearest edge first and from further away only as it widens"""
    levels = [(num, den)]
    while min(levels[-1][1].shape) > 1:
        n, d = levels[-1]
        size = (max(1, d.shape[1] // 2), max(1, d.shape[0] // 2))
        levels.append((cv2.resize(n, size, interpolation=cv2.INTER_AREA).reshape(size[1], size[0], 3),
                       cv2.resize(d, size, interpolation=cv2.INTER_AREA)))
    n, d = levels[-1]
    value = np.where(d[..., None] > 1e-6, n / np.maximum(d, 1e-6)[..., None], fallback).astype(np.float32)
    for n, d in reversed(levels[:-1]):
        up = cv2.resize(value, (d.shape[1], d.shape[0]), interpolation=cv2.INTER_LINEAR).reshape(d.shape[0], d.shape[1], 3)
        a = np.clip(d / SEAM_TRUST, 0.0, 1.0)[..., None]
        value = a * (n / np.maximum(d, 1e-6)[..., None]) + (1 - a) * up
    return value.astype(np.float32)


class Painter:
    """`tracks`: the ids painted out (the customer's selection); None paints every animal out. An animal
    nobody picked stays in the footage as filmed, so the lens shows the whole pack the camera saw."""

    def __init__(self, work, plate, overlay, noise, tracks=None):
        self.work, self.overlay, self.tracks = work, overlay, tracks
        self.plate = plate.astype(np.float32)
        self.plate8 = plate
        self.low = cv2.GaussianBlur(self.plate, (0, 0), SIGMA)
        self.smooth_ground = cv2.GaussianBlur(np.abs(self.plate - self.low).mean(2), (0, 0), 6) < 6.0
        self.plate_mean = self.plate.mean(2)
        self.top = int(work.h * overlay)
        self.floor = float(np.clip(0.75 * noise, 28.0, 45.0))
        self.masks = {}
        self.texture = {}
        self.free = {}
        self.last = None
        self.box = None

    def mask(self, i):
        i = min(i, self.work.n - 1)
        if i not in self.masks:
            self.masks[i] = union_mask(self.work, i, grow=17, tracks=self.tracks)
            self.masks.pop(i - 6, None)
        return self.masks[i]

    def ripples(self, k):
        """high-frequency texture of the footage at key sample k (int8), and where it may be borrowed"""
        if k not in self.texture:
            frame = self.work.frame(k).astype(np.float32)
            hf = frame - cv2.GaussianBlur(frame, (0, 0), SIGMA)
            self.texture[k] = (CLIP * np.tanh(hf / CLIP)).astype(np.float16)
            self.free[k] = ~(cv2.dilate((self.work.label(k) > 0).astype(np.uint8), np.ones((41, 41), np.uint8)) > 0)
        return self.texture[k], self.free[k]

    def cover(self, a):
        """(soft mask of what to paint out, ripple texture to put back) for the pair of samples a, a+1.
        Computed from the footage at sample a and kept: two output frames share it."""
        if self.last and self.last[0] == a:
            return self.last[1], self.last[2]
        w = self.work
        frame = w.frame(min(a, w.n - 1))
        base = self.mask(a) | self.mask(a + 1)
        lab = animals(w, min(a, w.n - 1), self.tracks) | animals(w, min(a + 1, w.n - 1), self.tracks)
        every = (w.label(min(a, w.n - 1)) > 0) | (w.label(min(a + 1, w.n - 1)) > 0)
        near = cv2.dilate(base.astype(np.uint8), np.ones((75, 75), np.uint8)) > 0
        # free of every animal, kept or painted: the plate is compared with the footage only there
        free = ~(cv2.dilate((base | every).astype(np.uint8), np.ones((81, 81), np.uint8)) > 0)
        # an animal that stays is never taken for a painted one's shadow
        stays = cv2.dilate((every & ~lab).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0 if self.tracks is not None else np.zeros_like(lab)
        # the footage is compared with the plate only near the animals (the box around `near`): every test
        # below is limited to there, so the values are the full frame's at a fraction of the cost
        darker = np.zeros(base.shape, bool)
        if near.any():
            ys_, xs_ = np.nonzero(near.any(axis=1))[0], np.nonzero(near.any(axis=0))[0]
            box = (int(xs_[0]), int(ys_[0]), int(xs_[-1]) + 1, int(ys_[-1]) + 1)
            d = difference(frame, self.plate8, free, self.top, window=box)
            # a shadow or reflection is darker than the plate and lies in the animal's own rows or below
            win = (slice(box[1], box[3]), slice(box[0], box[2]))
            darker[win] = (self.plate_mean[win] - frame[win].astype(np.float32).mean(2)) > 0.6 * self.floor
        else:
            d = np.zeros(base.shape, np.float32)
        ys = np.nonzero(base.any(axis=1))[0]
        below = np.zeros_like(base)
        if len(ys):
            below[int(ys[0] + 0.5 * (ys[-1] - ys[0])):] = True
        # hysteresis: a region that is clearly darker than the plate (the floor) and touches the animal
        # takes with it the fainter region around it (half the floor), but never more than 2.5x the animal
        weak = ((d > 0.45 * self.floor) & darker & below & near & ~stays).astype(np.uint8)
        weak = cv2.morphologyEx(weak, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        n, comp, stats, _ = cv2.connectedComponentsWithStats(weak)
        grown = cv2.dilate(base.astype(np.uint8), np.ones((17, 17), np.uint8)) > 0
        strong = (d > self.floor) & darker
        cap = 2.5 * max(int(base.sum()), 1)
        keep = lab.copy()
        for c in range(1, n):
            area = stats[c, cv2.CC_STAT_AREA]
            if area > 150:
                part = comp == c
                if (part & grown).any() and (part & strong).sum() > 60 and area <= cap:
                    keep |= part
        m = cv2.GaussianBlur(cv2.dilate((keep | base).astype(np.uint8), np.ones((17, 17), np.uint8)).astype(np.float32), (0, 0), 5)
        if self.tracks is not None:
            m[every & ~lab] = 0.0          # the grown rim of a painted animal never eats into one that stays
        hole = m > 0.02
        # ripples from the nearest moments each hidden pixel was free, on smooth ground only (ripples, not blades)
        texture = np.zeros_like(self.plate)
        todo = hole & self.smooth_ground
        for k in sorted(range(0, w.n, STEP), key=lambda k: abs(k - a)):
            if not todo.any() or abs(k - a) > REACH:
                break
            hf, ok = self.ripples(k)
            sel = todo & ok
            if sel.any():
                texture[sel] = hf[sel].astype(np.float32)
                todo &= ~sel
        # the clip is walked forward: what is further behind than we reach is never looked at again
        for k in [k for k in self.texture if k < a - REACH]:
            self.texture.pop(k, None)
            self.free.pop(k, None)
        some = m > 0      # the blur's faint tail reaches past the hole: it is composited too
        rows, cols = np.nonzero(some.any(axis=1))[0], np.nonzero(some.any(axis=0))[0]
        self.box = (slice(rows[0], rows[-1] + 1), slice(cols[0], cols[-1] + 1)) if len(rows) else None
        if SEAM and self.box is not None:
            shift = self.seam(frame, m, every)
            if shift is not None:
                texture[self.box] += shift
        self.last = (a, m, texture)
        return m, texture

    def seam(self, frame, m, every):
        """the brightness shift for the patch (box-sized, float32 RGB): the footage minus the plate on the
        ring around the patch that no animal covers, lightly smoothed (the ring's own ripples are not light),
        then filled inwards from the ring (push-pull), so the patch meets its edge and changes smoothly
        across. None without a usable ring."""
        rows, cols = self.box
        h, w = frame.shape[:2]
        y0, y1 = max(0, rows.start - SEAM_PAD), min(h, rows.stop + SEAM_PAD)
        x0, x1 = max(0, cols.start - SEAM_PAD), min(w, cols.stop + SEAM_PAD)
        near = (slice(y0, y1), slice(x0, x1))
        ring = (m[near] <= 0) & ~(cv2.dilate(every[near].astype(np.uint8), np.ones((25, 25), np.uint8)) > 0)
        ring[max(0, self.top - y0):] = False          # the burnt-in strip is text the plate does not have
        if ring.sum() < 200:
            return None
        d = np.clip(frame[near].astype(np.float32) - self.plate[near], -SEAM_CLIP, SEAM_CLIP)
        wt = ring.astype(np.float32)
        size = (max(1, (x1 - x0) // SEAM_SCALE), max(1, (y1 - y0) // SEAM_SCALE))
        sigma = SEAM_SIGMA / SEAM_SCALE
        num = cv2.GaussianBlur(cv2.resize(d * wt[..., None], size, interpolation=cv2.INTER_AREA), (0, 0), sigma).reshape(size[1], size[0], 3)
        den = cv2.GaussianBlur(cv2.resize(wt, size, interpolation=cv2.INTER_AREA), (0, 0), sigma)
        field = push_pull(num, den, d[ring].mean(0))
        field = cv2.resize(field, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)
        return field[rows.start - y0:rows.stop - y0, cols.start - x0:cols.stop - x0]

    def paint(self, frame, a):
        """frame: the footage at an output time (uint8 RGB, work size) lying between samples a and a+1.
        Only the box around what is painted out is composited; elsewhere the footage passes as it was."""
        m, texture = self.cover(a)
        painted = frame.copy()
        if self.box is not None:
            b = self.box
            mm = m[b][..., None]
            painted[b] = np.clip((self.plate[b] + texture[b]) * mm + frame[b].astype(np.float32) * (1 - mm), 0, 255).astype(np.uint8)
        return hide_strip(painted, self.overlay)
