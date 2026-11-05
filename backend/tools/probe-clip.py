"""Looks at a clip before anything is paid for or solved.

  <python with cv2> backend/tools/probe-clip.py <video>

Prints one JSON line:
  stabilizable  true when the camera moved a little (a bump): stabilize.py can hold it still
  fixed    true when the camera never moved: the world builder (make-world.py) handles any number of
           animals only for a fixed lens; a moving camera keeps the single-subject builder
  shift    the largest drift of the background between moments, px at 1280 wide
  crop     [x, y, w, h] of the picture inside black bars, or null; every other number is measured inside it
  overlay  the share of the frame height above a burnt-in data strip (a trail camera's date and
           temperature), 1 when there is none
  shot     [start, end] seconds of the clip's one continuous shot when it opens or closes on another
           scene (a compilation's dissolve or hard cut), else null; every other number is measured
           inside it, and the world builder keeps only that span
"""
import json
import sys

import cv2
import numpy as np

SIZE = (320, 180)
MOMENTS = [0.05, 0.25, 0.5, 0.75, 0.95]
STABILISE_PX = 40.0     # a bump or a shaking mount can be registered away; a pan cannot
FIXED_PX = 3.0          # at 1280 wide; the background of a handheld clip drifts by tens
STRIP_DARK = 0.55       # a strip row is this much darker than the picture just above it
MAX_STRIP = 0.15        # a strip is never more than this share of the frame


SHOT_FPS = 10        # samples per second the shot test looks at
SHOT_CELLS = (48, 27)
SHOT_CUT = 0.5       # share of cells jumping more than 30 levels between neighbouring samples: a hard cut
SHOT_REGIONS = 0.6   # a sample is another scene when this share of the picture's 12 regions changed...
SHOT_CELLS_ON = 0.45 # ...and this share of all its still cells: a moose filling the frame with antlers at the
                     # end of a clip reaches 0.92 of the regions but only 0.40 of the cells; a dissolve 0.5-0.7
SHOT_TAIL = 0.05     # once an end is another scene, the fading rest of the dissolve goes too: at 0.2 its last
                     # tenth of a second stayed, and the moose's world opened on a pale ghost of the other shot
MAX_END = 1.0        # s: a dissolve is short, so no more than this is ever cut from either end
MAX_TRIM = 0.25      # dissolves never take more than this share of a shot: beyond, trust the shot
MIN_SHOT = 2.0       # s: a shorter longest shot is no world; the clip is then taken whole
SHOT_SCENE = 0.9     # share of the 12 regions whose median changed across a jump for it to be a scene cut


def foreign(v):
    """per sample, (share of the picture's 12 regions, 4 x 3, whose still cells changed, share of all still
    cells that changed). Still cells are the 60 % that vary least through the clip (not water, not where
    animals walk); changed means far beyond their own variation. An animal changes the cells it covers;
    a dissolve to another scene changes them everywhere."""
    med = np.median(v, 0)
    mad = np.median(np.abs(v - med), 0) + 1.5
    still = mad <= np.percentile(mad, 60)
    changed = (np.abs(v - med) / mad > 6) & still
    region = regions_of()
    share = [changed[:, still & (region == r)].mean(1) for r in range(12) if (still & (region == r)).sum() >= 4]
    regions = (np.array(share) > 0.25).mean(0) if share else np.zeros(len(v))
    return regions, changed[:, still].mean(1) if still.any() else np.zeros(len(v))


def regions_of():
    """the picture's 12 regions (4 x 3) as an index per cell"""
    w, h = SHOT_CELLS
    ys, xs = np.divmod(np.arange(w * h), w)
    return (ys * 3 // h) * 4 + xs * 4 // w


def scene_changed(before, after):
    """True when two stretches show different places: their medians differ in every part of the picture.
    A bear walking past the lens fills a jump test too, but leaves half the picture as it was."""
    region = regions_of()
    changed = np.abs(np.median(before, 0) - np.median(after, 0)) > 20
    return np.mean([changed[region == r].mean() > 0.5 for r in range(12)]) >= SHOT_SCENE


def shot_span(v, times, duration):
    """[start, end] seconds of the longest stretch between scene cuts, less a dissolve at either end; None
    when that is the whole clip, when the dissolves would cut more than MAX_TRIM of it, or when no stretch
    of MIN_SHOT seconds exists"""
    if len(v) < 8:
        return None
    jump = (np.abs(np.diff(v, axis=0)) > 30).mean(1)
    cuts = [0]
    candidates = [i + 1 for i in np.nonzero(jump > SHOT_CUT)[0]]
    for k, c in enumerate(candidates):
        nxt = candidates[k + 1] if k + 1 < len(candidates) else len(v)
        if c - cuts[-1] >= 2 and nxt - c >= 2 and scene_changed(v[cuts[-1]:c], v[c:nxt]):
            cuts.append(c)
    cuts.append(len(v))
    a, b = max(zip(cuts, cuts[1:]), key=lambda s: s[1] - s[0])
    regions, cells = foreign(v[a:b])
    other = lambda k: regions[k] >= SHOT_REGIONS and cells[k] >= SHOT_CELLS_ON
    reach = max(1, int(round(MAX_END * SHOT_FPS)))
    lo, hi = 0, len(cells)
    if other(0):
        while lo < min(reach, hi - 1) and cells[lo] >= SHOT_TAIL:
            lo += 1
    if other(hi - 1):
        while hi - 1 > max(lo, len(cells) - reach) and cells[hi - 1] >= SHOT_TAIL:
            hi -= 1
    if (lo or hi < len(cells)) and hi - lo < (1 - MAX_TRIM) * len(cells):
        lo, hi = 0, len(cells)       # more than a dissolve: trust the stretch as it is
    a, b = a + lo, a + hi
    if a == 0 and b == len(v):
        return None
    start, end = float(times[a]), float(times[b]) if b < len(v) else duration
    if end - start < MIN_SHOT:
        return None
    return [round(start, 3), round(end, 3)]


def find_shot(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(fps / SHOT_FPS)))
    v, times, k = [], [], 0
    while True:
        if k % step == 0:
            ok, frame = cap.read()
            if not ok:
                break
            v.append(cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), SHOT_CELLS, interpolation=cv2.INTER_AREA).astype(np.float32).ravel())
            times.append(k / fps)
        elif not cap.grab():
            break
        k += 1
    cap.release()
    return shot_span(np.array(v), np.array(times), k / fps) if v else None


def grabs(path, span=None):
    cap = cv2.VideoCapture(path)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps0 = cap.get(cv2.CAP_PROP_FPS) or 30.0
    a, b = (0, n) if not span else (int(span[0] * fps0), min(n, int(span[1] * fps0)))
    out = []
    for m in MOMENTS:
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(a, a + int((b - a) * m) - 1))
        ok, frame = cap.read()
        if ok:
            out.append(frame)
    w, h = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    return out, int(w), int(h), n / fps if fps else 0


def edges(frame):
    """what a static scene shows in any light: gradient strength, stretched so a dark infrared frame still has texture"""
    g = cv2.cvtColor(cv2.resize(frame, SIZE, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = cv2.GaussianBlur(g, (0, 0), 1.0)
    m = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
    return m / (np.percentile(m, 99) + 1e-3)


def drift(frames, width):
    """Phase correlation per tile, median over tiles. A big animal or moving water ruins a whole-frame
    estimate but only the tiles it covers; the camera moved only if most of the picture moved."""
    grey = [edges(f) for f in frames]
    cols, rows = 4, 3
    tw, th = SIZE[0] // cols, SIZE[1] // rows
    win = cv2.createHanningWindow((tw, th), cv2.CV_32F)
    worst = 0.0
    for g in grey[1:]:
        shifts = []
        for r in range(rows):
            for c in range(cols):
                a = grey[0][r * th:(r + 1) * th, c * tw:(c + 1) * tw]
                b = g[r * th:(r + 1) * th, c * tw:(c + 1) * tw]
                (dx, dy), response = cv2.phaseCorrelate(a, b, win)
                if response > 0.3:   # a tile on an animal, water or flat sky has no peak worth trusting
                    shifts.append(float(np.hypot(dx, dy)) * width / SIZE[0])
        if len(shifts) >= 3:
            worst = max(worst, float(np.median(shifts)))
        else:
            # snow, fog, a flat sky: nothing for a correlation to lock onto. A fixed camera then still
            # differs from itself only where something moved; a moving one differs nearly everywhere.
            moved = (np.abs(g.astype(np.float32) - grey[0].astype(np.float32)) > 0.5).mean()
            worst = max(worst, 0.0 if moved < 0.3 else 1e9)
    return worst


BAND_FLAT = 10      # the bar is one colour: its rows' median colour stays within this of the bottom row's
EDGE = 22           # and its top edge is a step at least this large from the picture above
MIN_BAR = 0.02      # a bar is at least this share of the frame's height
TEXT_SHARE = 0.035  # a row with more than this share of hard steps is lettering (rippling water in sun: < 0.04 only at its worst)
TEXT_PAD = 0.02     # share of the height kept clear above the text (a translucent bar starts above its lettering)


def flat_bar(frames):
    """first row (share of the height) of a bar of one colour along the bottom with a sharp top
    edge, or 1. Text on the bar is sparse, so each row's median colour across the width is the bar's."""
    found = []
    for f in frames:
        g = cv2.resize(f, (320, 360), interpolation=cv2.INTER_AREA).astype(np.float32)
        rows = np.median(g, axis=1)                          # 360 x 3
        bottom = np.median(rows[-3:], axis=0)
        flat = np.abs(rows - bottom).max(1) <= BAND_FLAT
        top = len(rows)
        while top > 0 and flat[top - 1]:
            top -= 1
        bar = len(rows) - top
        step = np.abs(rows[top - 1] - rows[top]).max() if 0 < top < len(rows) else 0
        found.append(top / len(rows) if MIN_BAR * len(rows) <= bar <= MAX_STRIP * len(rows) and step >= EDGE else 1.0)
    seen = [x for x in found if x < 1]
    return float(np.median(seen)) if len(seen) > len(found) / 2 else 1.0


def text_band(frames):
    """first row (share of the height) of burnt-in lettering along the bottom, or 1. Lettering is the
    one thing in a trail-camera frame made of hard black-white steps (a bar may be translucent, so
    its colour says nothing): measure, per row, the share of pixels with a step above 90 levels,
    median over several moments so a passing animal does not count. A picture, even rippling water in
    sun, stays under about 4 %; text is 9 % and up."""
    share = []
    for f in frames:
        g = cv2.cvtColor(cv2.resize(f, (640, 360), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
        share.append((np.abs(np.diff(g, axis=1)) > 90).mean(1))
    e = np.median(np.stack(share), axis=0)
    zone = int(360 * (1 - MAX_STRIP))
    picture = np.median(e[int(360 * 0.55):zone])
    tall = e[zone:] > max(TEXT_SHARE, 3 * picture)
    # lettering has body: three rows within a few of each other, not one stray row
    for k in range(len(tall) - 5):
        if tall[k] and tall[k:k + 6].sum() >= 3:
            return max(0.0, (zone + k) / 360 - TEXT_PAD)
    return 1.0


def strip(frames):
    """where a trail camera's burnt-in date and temperature bar begins (share of the height), or 1"""
    return min(flat_bar(frames), text_band(frames))


BLACK = 18          # a bar never rises above this in any moment


def letterbox(frames):
    """[x, y, w, h] of the picture inside black bars (a vertical clip pasted on a landscape canvas, a
    16:9 clip in a phone frame), or None when there are none worth cutting (under 2 % of a side)"""
    peak = np.max([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames], axis=0)   # brightest each pixel ever is
    h, w = peak.shape
    rows = np.nonzero(peak.max(axis=1) > BLACK)[0]
    cols = np.nonzero(peak.max(axis=0) > BLACK)[0]
    if len(rows) == 0 or len(cols) == 0:
        return None
    y0, y1, x0, x1 = int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1
    if (y0 + h - y1) < 0.02 * h and (x0 + w - x1) < 0.02 * w:
        return None
    return [x0 & ~1, y0 & ~1, (x1 - x0) & ~1, (y1 - y0) & ~1]


def main(path):
    try:
        span = find_shot(path)
    except Exception:          # the shot test is an aid: a clip it cannot read is probed whole
        span = None
    frames, width, height, duration = grabs(path, span)
    if len(frames) < 2:
        print(json.dumps({"fixed": False, "shift": None, "overlay": 1.0, "width": width, "height": height, "duration": duration, "shot": None}))
        return
    crop = letterbox(frames)
    if crop:
        x, y, cw, ch = crop
        frames = [f[y:y + ch, x:x + cw] for f in frames]
        width, height = cw, ch
    shift = drift(frames, width)
    overlay = strip(frames)
    print(json.dumps({"fixed": bool(shift < FIXED_PX), "stabilizable": bool(FIXED_PX <= shift < STABILISE_PX), "shift": round(shift, 2) if shift < 1e8 else None,
                      "overlay": round(overlay, 3), "width": width, "height": height, "crop": crop, "duration": round(duration, 2), "shot": span}))


if __name__ == "__main__":
    main(sys.argv[1])
