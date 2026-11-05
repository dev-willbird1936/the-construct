"""Scene-transition score per track sample (tier-improve loop 11).

Clips cut from a compilation can open or close on a cross-dissolve: for a
few frames the scene is two shots laid over each other. The subject tracked
there reads see-through (grass and leaves show through its body), and its
pose is a blend of two moments. A dissolve changes the WHOLE background at
once, while a moving subject, splashing water or a swaying branch changes a
few places, so the score is spatial: the background (subject masks dilated
out) of each sample is compared with the clip's median background in a grid
of tiles, each tile against its own usual level, and the score is the median
excess over the tiles.

score = median over valid tiles of (d - d_tile_median), d = 1 - NCC of the
tile's background pixels against the median background. NCC ignores a
global gain and offset, so exposure drift does not count. Settled frames
score about 0 (|score| <= 0.003 on eight test clips); dissolve frames 0.01-0.2.

CLI: --video <source> --labels <dir of lNNNNN.png> --ids 1[,2] --map <json
{sample: sourceFrameIndex}>. Prints {"scores": {sample: score|null},
"frames": n, "sec": s}. A sample whose background is too small to judge
(a close-up covering most tiles) scores null.
"""
import argparse
import json
import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

WIDTH = 192         # analysis width (px); the dissolve is a global, low-frequency change
TILES = (8, 6)      # tiles across, down
MIN_BG_SHARE = 0.5  # a tile needs this much background to count
MIN_TILES = 6       # fewer valid tiles than this: no score
ENDS = 0.25         # only the first/last quarter can be trimmed, so only those are scored
MIDDLE_MAX = 24     # plus at most this many middle samples for the median background


def pick_samples(samples, ends=ENDS, middle_max=MIDDLE_MAX):
    """The samples worth reading: every sample in the first and last `ends`
    share (the trim never reaches further), plus an even subset of the middle
    so the median background still sees the whole clip. Label decoding is
    the cost (about 11 ms a 720p PNG), so a 180-sample clip reads ~113."""
    n = len(samples)
    k = int(np.ceil(n * ends))
    if n <= 2 * k + middle_max:
        return list(samples)
    middle = samples[k:n - k]
    step = len(middle) / middle_max
    return list(samples[:k]) + [middle[int(i * step)] for i in range(middle_max)] + list(samples[n - k:])


def read_label(path, lut):
    lab = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if lab is None:
        return None
    if lab.ndim == 3:
        lab = lab[:, :, 0]
    return lut[lab]  # 0/255 subject mask


def prepare(frame, mask, size):
    g = cv2.cvtColor(cv2.resize(frame, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = cv2.GaussianBlur(g, (0, 0), 1)
    if mask is None:
        m = np.zeros((size[1], size[0]), bool)
    else:
        m = cv2.resize(mask, size, interpolation=cv2.INTER_AREA) > 0
        m = cv2.dilate(m.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    return g, m


def tile_dissimilarity(frames, masks, tiles=TILES):
    """(K, tiles) of 1 - NCC against the masked median background; NaN where
    a tile has too little background or no texture."""
    G = np.stack(frames)
    M = np.stack(masks)
    k, h, w = G.shape
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN columns: handled below
        med = np.nanmedian(np.where(M, np.nan, G), axis=0)
    med = np.where(np.isnan(med), np.median(G, axis=0), med)
    tx, ty = tiles
    ys = np.linspace(0, h, ty + 1).astype(int)
    xs = np.linspace(0, w, tx + 1).astype(int)
    D = np.full((k, tx * ty), np.nan)
    for i in range(k):
        for r in range(ty):
            for c in range(tx):
                sl = (slice(ys[r], ys[r + 1]), slice(xs[c], xs[c + 1]))
                bg = ~M[i][sl]
                if bg.mean() < MIN_BG_SHARE:
                    continue
                a = G[i][sl][bg]
                b = med[sl][bg]
                a = a - a.mean()
                b = b - b.mean()
                den = float(np.sqrt((a * a).sum() * (b * b).sum()))
                if den < 1e-3:
                    continue
                D[i, r * tx + c] = 1.0 - float((a * b).sum()) / den
    return D


def scores_from(D):
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # stdout must stay one JSON line
        base = np.nanmedian(D, axis=0)
        X = D - base
        valid = np.sum(~np.isnan(X), axis=1)
        sc = np.nanmedian(X, axis=1)
    return [None if valid[i] < MIN_TILES or np.isnan(sc[i]) else round(float(sc[i]), 5) for i in range(len(sc))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--ids", required=True)
    ap.add_argument("--map", required=True)
    ap.add_argument("--ends", type=float, default=ENDS)
    args = ap.parse_args()
    t0 = time.time()
    lut = np.zeros(256, np.uint8)
    for x in args.ids.split(","):
        if x.strip() and 0 <= int(x) < 256:
            lut[int(x)] = 255
    mapping = {int(s): int(i) for s, i in json.load(open(args.map)).items()}
    mapping = {s: mapping[s] for s in pick_samples(sorted(mapping), args.ends)}
    by_index = {}
    for s, i in mapping.items():
        by_index.setdefault(i, []).append(s)
    cap = cv2.VideoCapture(args.video)
    jobs = []  # (sample, frame) in decode order
    size = None
    last = max(by_index) if by_index else -1
    idx = 0
    while idx <= last:
        if not cap.grab():
            break
        if idx in by_index:
            ok, frame = cap.retrieve()
            if ok:
                if size is None:
                    h, w = frame.shape[:2]
                    size = (WIDTH, max(8, round(WIDTH * h / w)))
                small = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)  # same bytes prepare() makes first
                for s in sorted(by_index[idx]):
                    jobs.append((s, small))
        idx += 1
    cap.release()

    # Label PNG decoding is the cost (about 11 ms a 720p raster); OpenCV
    # releases the GIL, so a few threads read them at once. Same results,
    # same order.
    def one(job):
        s, small = job
        return prepare(small, read_label(os.path.join(args.labels, f"l{s:05d}.png"), lut), size)

    with ThreadPoolExecutor(max_workers=4) as pool:
        prepared = list(pool.map(one, jobs))
    frames = [g for g, _ in prepared]
    masks = [m for _, m in prepared]
    order = [s for s, _ in jobs]
    scores = scores_from(tile_dissimilarity(frames, masks)) if len(frames) >= 3 else [None] * len(order)
    print(json.dumps({"scores": {str(s): v for s, v in zip(order, scores)}, "frames": len(order),
                      "sec": round(time.time() - t0, 2)}))


if __name__ == "__main__":
    main()
