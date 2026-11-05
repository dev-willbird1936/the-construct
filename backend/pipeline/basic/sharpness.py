"""Per-sample subject sharpness for keyframe snapping (Lane D sharp-kf v1).

Score = variance of the Laplacian of luma INSIDE the eroded subject mask, so
edge-band and background texture never count. Raw scores: the snap compares
neighbours by ratio, so no normalisation is needed.

CLI: --video <source> --labels <dir of lNNNNN.png> --ids 1[,2] --map <json
{sample: sourceFrameIndex}>. Prints {"scores": {sample: score}, "frames": n}.
Sequential decode (no seeking) up to the largest requested source index.

--local (Lane D blur-kf v1): score PEAK local motion instead - Farneback p95
speed (px/frame) inside the subject over the source neighbours i-1/i+1, max
of both directions. A smeared ear on a still body barely moves the Laplacian
score but is a clear flow outlier. Prints {"scores", "frac", "median"}.
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ERODE_ITERS = (2, 1)  # lighter erosion fallback, then the raw mask
MIN_INTERIOR_PX = 500
MIN_INTERIOR_FRAC = 0.20


def interior_of(mask):
    area = int(mask.sum())
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    floor = max(MIN_INTERIOR_PX, MIN_INTERIOR_FRAC * area)
    for it in ERODE_ITERS:
        e = cv2.erode(mask.astype(np.uint8), k, iterations=it) > 0
        if int(e.sum()) >= floor:
            return e
    return mask  # thin/small subject: whole mask


def score(gray, mask):
    vals = cv2.Laplacian(gray, cv2.CV_64F, ksize=3)[interior_of(mask)]
    return float(vals.var()) if vals.size else 0.0


FARNEBACK_KW = dict(pyr_scale=0.5, levels=3, winsize=15, iterations=3, poly_n=5, poly_sigma=1.2, flags=0)
FLOW_SHARE_PX = 2.0  # interior pixels faster than this count as "fast"
FLOW_CROP_PAD = 10  # subject-bbox margin for the flow crop


# Flow runs on the crop downscaled to this long side (0 = full res). The
# blur rule is a ratio to the clip median, so the scale cancels; speeds are
# reported back in full-res px/frame. 256 kept the blur decisions of the
# tuning clip (slovakdeer) and clip-b identical to full res (r 0.997); full-res
# crops cost 59 ms per pair on clip-b and ~30 s per job on a large elk
# (tier-improve 2026-11-04).
FLOW_MAX_SIDE = int(os.environ.get("BASIC_FLOW_MAX_SIDE", "256"))


def flow_pair_speed(prev_gray, gray, mask):
    """(p95 speed, fast share) on the subject-bbox crop, mask eroded once."""
    ys, xs = np.where(mask)
    h, w = gray.shape
    x0, x1 = max(0, int(xs.min()) - FLOW_CROP_PAD), min(w, int(xs.max()) + 1 + FLOW_CROP_PAD)
    y0, y1 = max(0, int(ys.min()) - FLOW_CROP_PAD), min(h, int(ys.max()) + 1 + FLOW_CROP_PAD)
    m = mask[y0:y1, x0:x1]
    a, b = prev_gray[y0:y1, x0:x1], gray[y0:y1, x0:x1]
    f = 1.0
    if FLOW_MAX_SIDE > 0 and max(m.shape) > FLOW_MAX_SIDE:
        f = FLOW_MAX_SIDE / max(m.shape)
        size = (max(8, round(m.shape[1] * f)), max(8, round(m.shape[0] * f)))
        a = cv2.resize(a, size, interpolation=cv2.INTER_AREA)
        b = cv2.resize(b, size, interpolation=cv2.INTER_AREA)
        m = cv2.resize(m.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST) > 0
    e = cv2.erode(m.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1) > 0
    if int(e.sum()) < 200 * f * f:
        e = m
    flow = cv2.calcOpticalFlowFarneback(a, b, None, **FARNEBACK_KW)
    mag = np.hypot(flow[..., 0], flow[..., 1])[e] / f
    if not mag.size:
        return 0.0, 0.0
    return float(np.percentile(mag, 95)), float((mag > FLOW_SHARE_PX).mean())


def local_motion(prev_gray, gray, next_gray, mask):
    outs = [flow_pair_speed(a, b, mask) for a, b in ((prev_gray, gray), (gray, next_gray)) if a is not None and b is not None]
    return (max(o[0] for o in outs), max(o[1] for o in outs)) if outs else (0.0, 0.0)


def workers():
    """BASIC_THREADS wins; else half the usable CPUs (depth.py's count, which
    reads the container quota first), kept in 2..4. Each sample's score
    depends only on its own frames and label, so the pool changes no output
    (tier-improve loop 11: clip-b's local pass 6.8 s serial)."""
    env = os.environ.get("BASIC_THREADS")
    if env:
        return max(1, int(env))
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from depth import available_cpus
        return max(2, min(4, available_cpus() // 2))
    except Exception:  # noqa: BLE001 - a missing helper only costs speed
        return 2


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--ids", required=True)
    ap.add_argument("--map", required=True)
    ap.add_argument("--local", action="store_true")
    args = ap.parse_args(argv)
    ids = [int(x) for x in args.ids.split(",") if x.strip()]
    with open(args.map, encoding="utf8") as f:
        want = {int(s): int(i) for s, i in json.load(f).items()}
    by_src = {}
    for s, i in want.items():
        by_src.setdefault(i, []).append(s)
    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise SystemExit(f"cannot open {args.video}")
    # --local needs each scored frame's neighbours; keep only those in memory.
    keep = {j for i in by_src for j in ((i - 1, i, i + 1) if args.local else (i,))}
    grays, last = {}, max(keep) if keep else -1
    tinted = []  # per-frame share of chroma pixels; IR/night footage is ~0
    for i in range(last + 1):
        ok, frame = cap.read()
        if not ok:
            break
        if i in keep:
            grays[i] = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if args.local and i in by_src:
                tinted.append(float((np.abs(frame[:, :, 0].astype(np.int16) - frame[:, :, 1]) > 8).mean()))
    cap.release()
    grayscale = bool(tinted) and float(np.median(tinted)) < 0.01
    if args.local and grayscale:
        # The caller discards local-motion scores on IR/greyscale footage
        # (sensor grain reads as flow), so skip the Farneback work entirely
        # (night-bear: ~18 s of flow computed and thrown away).
        print(json.dumps({"scores": {}, "frames": 0, "frac": {}, "median": 0.0, "grayscale": True}))
        return 0
    def one(job):
        i, s = job
        gray = grays[i]
        lab = cv2.imread(os.path.join(args.labels, f"l{s:05d}.png"), cv2.IMREAD_UNCHANGED)
        if lab is None:
            return None
        if lab.ndim == 3:
            lab = lab[:, :, 0]  # channel-0 ids
        m = np.isin(lab, ids)
        if m.shape != gray.shape:
            m = cv2.resize(m.astype(np.uint8), (gray.shape[1], gray.shape[0]),
                           interpolation=cv2.INTER_NEAREST) > 0
        if not m.any():
            return None
        if args.local:
            return s, local_motion(grays.get(i - 1), gray, grays.get(i + 1), m)
        return s, (score(gray, m), None)

    jobs = [(i, s) for i, samples in by_src.items() if grays.get(i) is not None for s in samples]
    scores, frac = {}, {}
    with ThreadPoolExecutor(max_workers=workers()) as ex:
        for r in ex.map(one, jobs):
            if r is None:
                continue
            s, (v, fr) = r
            scores[s] = v
            if args.local:
                frac[s] = fr
    out = {"scores": {str(s): v for s, v in sorted(scores.items())}, "frames": len(scores)}
    if args.local:
        out["frac"] = {str(s): v for s, v in sorted(frac.items())}
        out["median"] = float(np.median(list(scores.values()))) if scores else 0.0
        out["grayscale"] = grayscale
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
