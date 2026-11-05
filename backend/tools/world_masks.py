"""Repairs what a SAM tracker gets wrong, using what a fixed camera gives for free: a clean plate.

Two failures were seen on real trail-cam clips (an infrared bear at night, a doe with fawns):
  fragments  one animal reported as two or three instances (a head and a body, a flank and a back);
             each gets its own shell, at its own depth, and the animal comes apart when orbited.
  dropouts   SAM loses an animal for a second or two (a black bear in infrared, a fawn behind
             a log); with no mask there is no shell, and the animal flattens into the live video.

  merge_fragments   an instance that never lives apart from another (touching it for 90 % of its
                    life) is a piece of it, and is relabelled to it
  bridge_dropouts   inside a gap in an animal's track, whatever differs from the plate near where
                    the animal was and will be is the animal

Everything works from the labels and the footage: no SAM call, so re-running costs nothing. The raw
labels are kept in labels_raw/ and every run starts from them, so a repair is never applied twice.
"""
import json
import shutil

import cv2
import numpy as np
from scipy import ndimage

SMALL = 4                 # analysis at 1/4 size
TOUCH = 0.1               # share of the smaller outline that must lie against the other to count as touching
TOGETHER = 0.9            # an instance that touches another for this share of its life is a piece of it
MIN_LIFE = 3              # samples: a shorter instance is a flicker
JOIN_IOU = 0.3             # consecutive samples under two ids whose masks overlap this much are one animal
MAX_GAP = 60              # samples a dropout may last and still be bridged (4 s at 15 fps)
MIN_NOISE = 25.0          # grey levels of difference from the plate that are never just noise
MAX_NOISE = 60.0          # glints on water and moving leaves set the floor high; an animal still differs more than this


def small_masks(work):
    """per sample: {track id: bool mask at 1/4 size}"""
    h4, w4 = work.h // SMALL, work.w // SMALL
    out = []
    for i in range(work.n):
        lab = cv2.resize(work.label(i), (w4, h4), interpolation=cv2.INTER_NEAREST)
        out.append({int(t): lab == t for t in np.unique(lab) if t})
    return out


def outline(m):
    return int((m & ~(cv2.erode(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)).sum())


def contact(a, b):
    """share of the smaller outline that lies against the other mask"""
    near = cv2.dilate(a.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    return int((near & b).sum()) / max(min(outline(a), outline(b)), 1)


class Contacts:
    """contact() for masks[i][piece] against masks[i][host], with each mask's outline and box worked out once per
    sample and the dilation done in a window round the piece: the same values. A wolf pack's mask repair asked
    for 166,000 contacts over a minute of footage, two full-frame erosions each, and most pairs were far apart."""

    def __init__(self, masks):
        self.masks, self.outlines, self.boxes = masks, {}, {}

    def outline(self, i, t):
        if (i, t) not in self.outlines:
            self.outlines[i, t] = outline(self.masks[i][t])
        return self.outlines[i, t]

    def box(self, i, t):
        if (i, t) not in self.boxes:
            m = self.masks[i][t]
            ys, xs = np.nonzero(m.any(axis=1))[0], np.nonzero(m.any(axis=0))[0]
            self.boxes[i, t] = (int(ys[0]), int(ys[-1]), int(xs[0]), int(xs[-1])) if len(ys) else None
        return self.boxes[i, t]

    def __call__(self, i, piece, host):
        bp, bh = self.box(i, piece), self.box(i, host)
        if bp is None or bh is None:
            return 0.0
        m = self.masks[i][piece]
        y0, y1 = max(bp[0] - 2, 0), min(bp[1] + 3, m.shape[0])
        x0, x1 = max(bp[2] - 2, 0), min(bp[3] + 3, m.shape[1])
        # the 5 x 5 dilation reaches 2 px past the piece: a host wholly outside that window touches nothing
        if bh[0] >= y1 or bh[1] < y0 or bh[2] >= x1 or bh[3] < x0:
            touching = 0
        else:
            near = cv2.dilate(m[y0:y1, x0:x1].astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            touching = int((near & self.masks[i][host][y0:y1, x0:x1]).sum())
        return touching / max(min(self.outline(i, piece), self.outline(i, host)), 1)


ABSORB = 0.6              # share of a piece's mask the host must cover, in a moment when the piece is gone
ABSORBED_FOR = 3          # moments of that, near the piece's life, that prove it was part of the host
NEAR = 8                  # samples around a piece's life where such a moment still counts


def absorbed(masks, life, b, a):
    """True when, in moments the piece is missing, the host's mask takes over the piece's place: one
    animal that SAM drew as two pieces for a while and as one at other times. Two animals that touch
    (a pack of wolves, a doe and her fawn) never do that: neither one ever swallows the other."""
    mine = sorted(life[b])
    lo, hi = mine[0] - NEAR, mine[-1] + NEAR
    have = set(mine)
    count = 0
    for i in range(max(lo, 0), min(hi, len(masks) - 1) + 1):
        if i in have or a not in masks[i]:
            continue
        j = min(mine, key=lambda k: abs(k - i))
        if abs(j - i) > NEAR:
            continue
        piece = masks[j][b]
        if piece.sum() and (piece & masks[i][a]).sum() / piece.sum() >= ABSORB:
            count += 1
    return count >= ABSORBED_FOR


def merge_fragments(masks):
    """({piece id: whole id, 0 for a flicker}, {id: samples}). A piece is an instance that, for
    TOGETHER of its life, touches one that lives longer, and that the other swallows whenever the
    piece is missing. (A fawn at its mother's side leaves her, and the wolf behind another wolf is
    never covered by it; the head of one bear is.)"""
    life = {}
    for i, frame in enumerate(masks):
        for t in frame:
            life.setdefault(t, []).append(i)
    parent = {}
    touch = Contacts(masks)
    rank = {t: (len(life[t]), -t) for t in life}      # a strict order, so no two pieces can claim each other
    for b in sorted(life, key=lambda t: rank[t]):
        if len(life[b]) < MIN_LIFE:
            parent[b] = 0
            continue
        best = None
        for a in life:
            if rank[a] <= rank[b]:
                continue
            both = [i for i in life[b] if a in masks[i]]
            if len(both) / len(life[b]) < TOGETHER:
                continue        # together for less of the piece's life than TOGETHER asks, whatever they touch
            together = [touch(i, b, a) >= TOUCH for i in both]
            share = sum(together) / len(life[b])
            if share >= TOGETHER and (best is None or share > best[0]) and absorbed(masks, life, b, a):
                best = (share, a)
        if best:
            parent[b] = best[1]

    def root(t):
        while t in parent:
            if parent[t] == 0:
                return 0            # a flicker, or a piece of one
            t = parent[t]
        return t

    return {b: root(b) for b in parent}, life


BLUR_REACH = 8   # px: the 1.5 px blur's kernel radius (6) with room to spare, so a window gives the same values


def difference(frame, plate, free, top=None, window=None):
    """per-pixel distance from the plate, after undoing a global change of exposure (infrared
    auto-gain, a cloud): frame = gain * plate + offset, fitted on pixels known to be free of animals.
    With `window` (x0, y0, x1, y1) only that part is measured (the same values, a fraction of the work):
    the exposure is still fitted over the whole frame."""
    if top is not None:
        free = free.copy()
        free[top:] = False          # the burnt-in strip is text the plate does not have
    gain, offset = 1.0, 0.0
    if free is not None and free.sum() > 2000:
        ys, xs = np.nonzero(free)
        pick = np.random.default_rng(0).choice(len(ys), min(20000, len(ys)), replace=False)
        fs = frame[ys[pick], xs[pick]].astype(np.float32).mean(1)
        ps = plate[ys[pick], xs[pick]].astype(np.float32).mean(1)
        keep = np.abs(fs - ps) < np.percentile(np.abs(fs - ps), 90)      # not the few pixels that really changed
        gain, offset = np.polyfit(ps[keep], fs[keep], 1) if keep.sum() > 500 else (1.0, 0.0)
        gain = float(np.clip(gain, 0.5, 2.0))
    h, w = frame.shape[:2]
    x0, y0, x1, y1 = window if window is not None else (0, 0, w, h)
    X0, Y0, X1, Y1 = max(0, x0 - BLUR_REACH), max(0, y0 - BLUR_REACH), min(w, x1 + BLUR_REACH), min(h, y1 + BLUR_REACH)
    f = frame[Y0:Y1, X0:X1].astype(np.float32)
    if (gain, offset) != (1.0, 0.0):
        f = (f - offset) / gain
    p = plate[Y0:Y1, X0:X1].astype(np.float32)
    d = np.abs(cv2.GaussianBlur(f, (0, 0), 1.5) - cv2.GaussianBlur(p, (0, 0), 1.5)).max(2)[y0 - Y0:y1 - Y0, x0 - X0:x1 - X0]
    if top is not None:
        d[max(0, top - y0):] = 0
    if window is None:
        return d
    out = np.zeros((h, w), np.float32)
    out[y0:y1, x0:x1] = d
    return out


def full(mask, work):
    return cv2.resize(mask.astype(np.uint8), (work.w, work.h), interpolation=cv2.INTER_NEAREST) > 0


def noise_floor(work, frames, plate, masks):
    """how far a pixel of a moving scene (rippling water, a gust in the trees) strays from the plate
    when no animal is there: 1.25 x the 99.5th percentile, never below MIN_NOISE"""
    errs = []
    for i in np.linspace(0, work.n - 1, 10).astype(int):
        free = np.ones((work.h, work.w), bool)
        for m in masks[i].values():
            free &= ~(cv2.dilate(full(m, work).astype(np.uint8), np.ones((41, 41), np.uint8)) > 0)
        d = difference(frames(i), plate, free, work.top)
        errs.append(np.percentile(d[:work.top][free[:work.top]], 99))
    return float(np.clip(1.25 * float(np.median(errs)), MIN_NOISE, MAX_NOISE))   # median: a frame an animal fills has no free pixels worth the name


MARGIN = 24   # px around a bridged region: past the 5 px opening and the 15 px closing


def bridge(work, frames, plate, masks, T, t, a, la, b, lb):
    """the animal t is seen at sample a (mask la) and at sample b (mask lb) and not in between:
    for every sample between, whatever differs from the plate near the straight path between the two
    is the animal. Returns ({sample: mask}, samples tried)."""
    boxes = []
    for m in (la, lb):
        ys, xs = np.nonzero(m)
        boxes.append(np.array([xs.min(), ys.min(), xs.max(), ys.max()], float))
    found = {}
    for j in range(a + 1, b):
        f = (j - a) / (b - a)
        box = boxes[0] * (1 - f) + boxes[1] * f
        pad = 0.25 * np.array([box[2] - box[0], box[3] - box[1]]) + 30
        x0, y0 = np.maximum(0, box[:2] - pad).astype(int)
        x1, y1 = np.minimum([work.w, work.h], box[2:] + pad).astype(int)
        other = np.zeros((work.h, work.w), bool)
        for u, m in masks[j].items():
            if u != t:
                other |= full(m, work)
        other = cv2.dilate(other.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        region = np.zeros((work.h, work.w), bool)
        region[y0:y1, x0:x1] = True
        free = ~region & ~(cv2.dilate(other.astype(np.uint8), np.ones((81, 81), np.uint8)) > 0)
        # everything below happens near the region: a window MARGIN px larger than it holds every pixel the
        # opening and closing can reach, so the result is the full frame's, at a fraction of the cost
        wx0, wy0 = max(0, x0 - MARGIN), max(0, y0 - MARGIN)
        wx1, wy1 = min(work.w, x1 + MARGIN), min(work.h, y1 + MARGIN)
        win = (slice(wy0, wy1), slice(wx0, wx1))
        d = difference(frames(j), plate, free, work.top, window=(wx0, wy0, wx1, wy1))[win]
        cand = ((d > T) & ~other[win] & region[win]).astype(np.uint8)
        cand = cv2.morphologyEx(cand, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        cand = cv2.morphologyEx(cand, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
        n, comp, stats, _ = cv2.connectedComponentsWithStats(cand)
        want = la.sum() * (1 - f) + lb.sum() * f
        part = np.zeros(cand.shape, bool)
        for c in range(1, n):
            if stats[c, cv2.CC_STAT_AREA] >= 0.15 * want:
                part |= comp == c
        part = ndimage.binary_fill_holes(part)      # an animal's black pelt can match a contaminated plate
        if want * 0.45 <= part.sum() <= want * 2.2:
            keep = np.zeros((work.h, work.w), bool)
            keep[win] = part
            found[j] = keep
    return found, b - a - 1


def bridge_dropouts(work, frames, plate, masks, ids, T):
    """fills the gaps inside the listed tracks. Returns {sample: {track: bool full-size mask}}"""
    fills = {}
    for t in ids:
        present = [i for i, m in enumerate(masks) if t in m]
        for a, b in zip(present, present[1:]):
            if 1 <= b - a - 1 <= MAX_GAP:
                found, _ = bridge(work, frames, plate, masks, T, t, a, work.label(a) == t, b, work.label(b) == t)
                for j, m in found.items():
                    fills.setdefault(j, {})[t] = m
    return fills


def stitch_tracks(work, frames, plate, masks, T):
    """({later id: earlier id}, fills). An animal lost for a moment comes back under a new id.
    The two are one animal when something that differs from the plate is there for most of the gap:
    an animal that left and another that arrived leave the gap empty."""
    life = {}
    for i, frame in enumerate(masks):
        for t in frame:
            life.setdefault(t, []).append(i)
    joins, fills = {}, {}
    for b in sorted(life, key=lambda t: life[t][0]):
        s = life[b][0]
        ends = [(life[a][-1], a) for a in life if a != b and life[a][-1] < s and s - life[a][-1] - 1 <= MAX_GAP and a not in joins.values()]
        for e, a in sorted(ends, key=lambda x: s - x[0]):
            if s - e == 1:
                # no gap to look through: the animal simply changed id (a second pass over the same strip,
                # read backwards, picked it up), so the two are one if they lie on top of each other
                ma, mb = masks[e][a], masks[s][b]
                if (ma & mb).sum() / max((ma | mb).sum(), 1) >= JOIN_IOU:
                    joins[b] = a
                    break
                continue
            found, tried = bridge(work, frames, plate, masks, T, a, e, work.label(e) == a, s, work.label(s) == b)
            if tried and len(found) >= 0.8 * tried:
                joins[b] = a
                for j, m in found.items():
                    fills.setdefault(j, {})[a] = m
                break
    return joins, fills


def stray_runs(masks, fps):
    """{track: [samples]} of runs under four samples that sit more than a second from the rest of their
    track: an instance SAM reports for a moment where its animal is not (a cub that left, found again
    as a speck for one frame)"""
    life = {}
    for i, frame in enumerate(masks):
        for t in frame:
            life.setdefault(t, []).append(i)
    out = {}
    for t, seen in life.items():
        runs = [[seen[0], seen[0]]]
        for i in seen[1:]:
            if i - runs[-1][1] <= 1:
                runs[-1][1] = i
            else:
                runs.append([i, i])
        if len(runs) < 2:
            continue
        for k, (a, b) in enumerate(runs):
            before = a - runs[k - 1][1] if k else 10 ** 9
            after = runs[k + 1][0] - b if k + 1 < len(runs) else 10 ** 9
            if b - a + 1 < 4 and before > fps and after > fps:
                out.setdefault(t, []).extend(range(a, b + 1))
    return out


def write_labels(work, relabel, fills):
    for i in range(work.n):
        lab = work.label(i)
        out = lab.copy()
        for b, a in relabel.items():
            out[lab == b] = a
        for t, m in fills.get(i, {}).items():
            out[(out == 0) & m] = t
        if (out != lab).any():
            cv2.imwrite(str(work.dir / "labels" / f"l{i:05d}.png"), out)


def repair(work, plate, frames, overlay=1.0):
    """repairs the work folder's labels in place (the raw ones are kept); returns what was done"""
    work.top = int(work.h * overlay)
    raw, live = work.dir / "labels_raw", work.dir / "labels"
    if raw.exists():
        for f in raw.glob("l*.png"):        # start from the tracker's own output, never from a repair of it
            shutil.copyfile(f, live / f.name)
    else:
        shutil.copytree(live, raw)
    masks = small_masks(work)
    pieces, _ = merge_fragments(masks)
    if pieces:
        write_labels(work, pieces, {})
        masks = small_masks(work)
    for t, samples in stray_runs(masks, work.fps).items():
        for i in samples:
            lab = work.label(i)
            lab[lab == t] = 0
            cv2.imwrite(str(work.dir / "labels" / f"l{i:05d}.png"), lab)
    masks = small_masks(work)
    T = noise_floor(work, frames, plate, masks)
    joins, stitched = stitch_tracks(work, frames, plate, masks, T)
    if joins or stitched:
        write_labels(work, joins, stitched)
        masks = small_masks(work)
    fills = bridge_dropouts(work, frames, plate, masks, sorted({t for m in masks for t in m}), T)
    write_labels(work, {}, fills)
    present = {}
    for i in range(work.n):
        for t in np.unique(work.label(i)):
            if t:
                present.setdefault(int(t), []).append(i)
    work.tracks["tracks"] = [{"id": t, "first": v[0], "last": v[-1], "frames": len(v)} for t, v in sorted(present.items())]
    (work.dir / "tracks.json").write_text(json.dumps(work.tracks))
    return {"merged": {int(k): int(v) for k, v in pieces.items()}, "stitched": {int(k): int(v) for k, v in joins.items()},
            "bridged": sum(len(v) for v in fills.values()) + sum(len(v) for v in stitched.values()), "noise": round(T, 1)}


IN_VIEW = 0.5      # share of the samples it is seen in that a group member must be wholly in view to be lifted
HIDDEN = 0.6       # under this share of its own usual size (90th percentile), an animal against another is part hidden
FRAME_EDGE = 2     # px: a mask this close to the picture's edge is cut by it


def in_view(work, ids, overlay=1.0, min_area=1):
    """{track id: (share, samples)}: for each of ids, the share of the samples it is seen in where it is wholly in
    view: clear of the picture's edges (and a burnt-in data strip) and not part hidden behind another animal.
    A pack lifted whole puts a shell on every wolf, and a wolf cut by the frame or half behind another is a
    fragment off-lens (a head, a back): it reads as broken where it would read as footage."""
    ids = {int(t) for t in ids}
    bottom = min(work.h, int(work.h * overlay))
    grow = np.ones((5, 5), np.uint8)
    seen = {}
    for i in range(work.n):
        lab = work.label(i)
        if lab is None:
            continue
        area = np.bincount(lab.ravel(), minlength=256)
        boxes = ndimage.find_objects(lab)
        for t in ids:
            if t > len(boxes) or boxes[t - 1] is None or area[t] < min_area:
                continue
            ys, xs = boxes[t - 1]
            cut = xs.start < FRAME_EDGE or ys.start < FRAME_EDGE or xs.stop > work.w - FRAME_EDGE or ys.stop > bottom - FRAME_EDGE
            y0, x0 = max(ys.start - 2, 0), max(xs.start - 2, 0)
            win = lab[y0:ys.stop + 2, x0:xs.stop + 2]
            near = cv2.dilate((win == t).astype(np.uint8), grow) > 0
            against = bool((near & (win != 0) & (win != t)).any())
            seen.setdefault(t, []).append((int(area[t]), cut, against))
    out = {}
    for t, rows in seen.items():
        usual = np.percentile([a for a, _, _ in rows], 90)
        whole = [not cut and not (against and a < HIDDEN * usual) for a, cut, against in rows]
        out[t] = (float(np.mean(whole)), len(rows))
    return out


def keep_in_view(shares, share=IN_VIEW):
    """the group members in view for at least share of their samples; all of them when none is"""
    keep = {t for t, (s, _) in shares.items() if s >= share}
    return keep or set(shares)


def identity_report(work):
    """Measured on the final labels, for the gate:
      switches     a track ends and another begins within a second and a body length of it: the same
                   animal under two ids, which the repair should already have joined
      unexplained  share of track life where an animal is missing and nothing explains it: not
                   covered by another animal, not at the frame's edge
      longest      the longest such gap, seconds"""
    masks = small_masks(work)
    life = {}
    box = {}
    for i, frame in enumerate(masks):
        for t, m in frame.items():
            life.setdefault(t, []).append(i)
            ys, xs = np.nonzero(m)
            box[(i, t)] = (xs.min(), ys.min(), xs.max(), ys.max())
    h4, w4 = work.h // SMALL, work.w // SMALL
    switches = 0
    for b in life:
        s0 = life[b][0]
        for a in life:
            if a == b or life[a][-1] >= s0 or s0 - life[a][-1] > work.fps:
                continue
            ea, sb = box[(life[a][-1], a)], box[(s0, b)]
            size = max(ea[2] - ea[0], ea[3] - ea[1], 1)
            if np.hypot((ea[0] + ea[2]) / 2 - (sb[0] + sb[2]) / 2, (ea[1] + ea[3]) / 2 - (sb[1] + sb[3]) / 2) < size:
                switches += 1
                break
    missing = unexplained = longest = 0
    total = sum(v[-1] - v[0] + 1 for v in life.values())
    for t, seen in life.items():
        for a, b in zip(seen, seen[1:]):
            if b - a <= 1:
                continue
            run = 0
            for j in range(a + 1, b):
                f = (j - a) / (b - a)
                bx = np.array(box[(a, t)]) * (1 - f) + np.array(box[(b, t)]) * f
                x0, y0, x1, y1 = [int(v) for v in bx]
                at_edge = x0 <= 2 or y0 <= 2 or x1 >= w4 - 3 or y1 >= h4 - 3
                other = np.zeros((h4, w4), bool)
                for u, m in masks[j].items():
                    if u != t:
                        other |= m
                area = max((x1 - x0 + 1) * (y1 - y0 + 1), 1)
                covered = other[max(0, y0):y1 + 1, max(0, x0):x1 + 1].sum() / area
                if other.mean() > 0.3:
                    covered = 1.0      # an animal filling a third of the picture hides whatever is behind it
                missing += 1
                if covered < 0.3 and not at_edge:
                    unexplained += 1
                    run += 1
                    longest = max(longest, run)
                else:
                    run = 0
    return {"switches": switches, "unexplained": unexplained / max(total, 1), "longest": longest / work.fps}
