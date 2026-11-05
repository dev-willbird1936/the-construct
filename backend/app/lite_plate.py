"""Lite moving-camera plate: the clip's own place, registered and medianed.

A moving camera used to get a heavily blurred, darkened single frame (the
"blur card"): a grey smear for panning or handheld clips. This builds a
clean plate instead. Background frames are aligned to the middle frame
(ORB features on non-subject pixels, RANSAC homography chained between
neighbours, sanity-bounded), warped onto one canvas and medianed per
pixel over the samples where the subject mask is OFF. Every output pixel
is an observed background pixel (median of >= MIN_VOTES aligned samples)
except the patch the subject never uncovered (it stood there in every
sample): that patch, at most UNKNOWN_MAX of the plate, is texture-continued
from its surroundings (shift-map inpainting, opencv-contrib xphoto) and
reported as unknownShare. The plate is refused (exit 3, nothing written)
when registration or coverage is doubtful, so the caller keeps its
fallback (sharp JS plate or blurred card).

Usage (one batch call per job, never per frame):
  python -I lite_plate.py --video SRC.mp4 --frames-json IN.json --out OUT.png
IN.json: {"frames": [{"sourceFrameIndex": int, "mask": rgba_png_path}], ...}
Prints one JSON line: {"ok": true, "width":..,"height":..,"unknownShare":..,
"mad":..,"samples":..} or {"ok": false, "reason": ...} (exit 3).
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

PLATE_W = 640          # working width (the viewer maps ~1.35x of the frame)
HAS_XPHOTO = hasattr(cv2, "xphoto")  # opencv-contrib (Basic venv); plain builds fill smaller holes only
MAX_SAMPLES = 16       # frames medianed
MIN_VOTES = 3          # clean samples a pixel needs to be "observed"
UNKNOWN_MAX = 0.15     # share of the cropped plate filled, not observed
MAD_MAX = 16.0         # mean |frame - median| over clean overlap (0-255)
MIN_INLIERS = 24
MAX_CANVAS_W = 2.0     # canvas at most 2x / 1.5x the reference frame
MAX_CANVAS_H = 1.5
MAX_ASPECT = 2.4       # cropped plate aspect cap (the viewer shows ~16:9)
EDGE_BAD = 0.02        # crop rows/cols until <= 2% of an edge is unknown
FEATHER_PX = 12.0      # sample weight ramps up over this many px from its footprint edge
INLIER_T = 22.0        # a sample joins the blend when within this of the median (0-255)


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj) + "\n")
    return code


def refuse(reason):
    return emit({"ok": False, "reason": reason}, 3)


def load_frames(video, indices, size, rows=None):
    """Decode the wanted source frames in one forward pass (no seeks)."""
    want = sorted(set(indices))
    out = {}
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return out
    n = 0
    k = 0
    while k < len(want):
        if not cap.grab():
            break
        if n == want[k]:
            ok, fr = cap.retrieve()
            if ok and fr is not None:
                out[n] = cv2.resize(fr[:rows] if rows else fr, size, interpolation=cv2.INTER_AREA)
            k += 1
        n += 1
    cap.release()
    return out


def load_mask(paths, size, dil, rows=None):
    m = np.zeros((size[1], size[0]), np.uint8)
    for p in paths:
        img = cv2.imread(p, cv2.IMREAD_UNCHANGED)
        if img is None:
            continue
        a = img[:, :, 3] if img.ndim == 3 and img.shape[2] == 4 else (img if img.ndim == 2 else img[:, :, 0])
        a = cv2.resize(a[:rows] if rows else a, size, interpolation=cv2.INTER_AREA)
        m |= (a > 8).astype(np.uint8)
    if dil > 0 and m.any():
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dil + 1, 2 * dil + 1)))
    return m


def sane(H, w, h):
    """A plausible camera move between neighbouring samples."""
    if H is None or not np.all(np.isfinite(H)):
        return False
    H = H / H[2, 2]
    a = H[:2, :2]
    det = float(np.linalg.det(a))
    if not (0.75 < det < 1.33):
        return False
    if abs(H[2, 0]) * w > 0.25 or abs(H[2, 1]) * h > 0.25:
        return False
    if abs(H[0, 2]) > 0.6 * w or abs(H[1, 2]) > 0.6 * h:
        return False
    return True


def features(orb, gray, mask):
    return orb.detectAndCompute(gray, (1 - mask) * 255)


def pair_h(matcher, fa, fb, w, h):
    """Homography mapping frame b into frame a (background features only)."""
    ka, da = fa
    kb, db = fb
    if da is None or db is None or len(ka) < MIN_INLIERS or len(kb) < MIN_INLIERS:
        return None, 0
    pairs = matcher.knnMatch(db, da, k=2)
    good = [m for m, *rest in pairs if rest and m.distance < 0.75 * rest[0].distance]
    if len(good) < MIN_INLIERS:
        return None, 0
    src = np.float32([kb[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([ka[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    n = int(inl.sum()) if inl is not None else 0
    if n < MIN_INLIERS or not sane(H, w, h):
        A, inl2 = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
        n2 = int(inl2.sum()) if inl2 is not None else 0
        if A is None or n2 < MIN_INLIERS:
            return None, 0
        H = np.vstack([A, [0, 0, 1]])
        if not sane(H, w, h):
            return None, 0
        return H, n2
    return H / H[2, 2], n


FILL_DEV = 26.0        # mean low-pass luma gap (0-255) from the smooth fill that rejects every shift-map fill
FILL_PADS = (0.0, 0.5)  # context margin round the hole: 32 px, or half the hole's larger side


def fill_crop(plate, hole, pad, budget, band):
    """One shift-map fill of the hole on a crop padded by `pad` px. Returns
    the crop box, crop, hole core, fill, the smooth (Telea) fill and the
    mean low-pass luma gap between the two over the filled pixels."""
    ys, xs = np.nonzero(hole)
    H, W = hole.shape
    y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + 1 + pad)
    x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + 1 + pad)
    crop = plate[y0:y1, x0:x1]
    core = hole[y0:y1, x0:x1]
    cmask = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band + 1, 2 * band + 1)))
    ch, cw = cmask.shape
    s = min(1.0, (budget / float(ch * cw)) ** 0.5)
    if s < 1.0:
        sw, sh = max(8, int(cw * s)), max(8, int(ch * s))
        small = cv2.resize(crop, (sw, sh), interpolation=cv2.INTER_AREA)
        smask = cv2.resize(cmask, (sw, sh), interpolation=cv2.INTER_NEAREST)
        smask = cv2.dilate(smask, np.ones((3, 3), np.uint8))
    else:
        small, smask = crop.copy(), cmask
    out = small.copy()
    if HAS_XPHOTO:
        cv2.xphoto.inpaint(small, (1 - smask) * 255, out, cv2.xphoto.INPAINT_SHIFTMAP)
    else:  # plain opencv build: smooth fill, only allowed for tiny holes (main)
        out = cv2.inpaint(small, smask, 5, cv2.INPAINT_TELEA)
    if s < 1.0:
        out = cv2.resize(out, (cw, ch), interpolation=cv2.INTER_CUBIC)
    if not HAS_XPHOTO:
        return (y0, y1, x0, x1), crop, core, out, out, 0.0
    smooth = cv2.inpaint(crop, cmask, 5, cv2.INPAINT_TELEA)
    low = lambda im: cv2.GaussianBlur(im.astype(np.float32).mean(axis=2), (0, 0), 6)
    hp = cmask > 0
    dev = float(np.abs(low(out) - low(smooth))[hp].mean()) if hp.any() else 0.0
    return (y0, y1, x0, x1), crop, core, out, smooth, dev


def fill_holes(plate, hole, budget=40000):
    """Texture-continue the never-uncovered region (shift-map inpainting on
    a padded crop, downscaled to `budget` px when large). The fill is made
    BAND px wider than the hole and cross-faded into the observed plate
    over that band, so its border is not a hard line; beyond the band the
    plate stays the observed median.

    Shift-map is a global search: a small change in the masks can make it
    pull a patch from another band of the scene (bright floor stacked into
    dark forest: a blocky ghost where the subject stood). So it runs with
    two context margins and keeps the fill whose low-pass brightness stays
    closest to the smooth fill the hole's own border implies; when both
    stray far from it, the smooth fill is kept (a soft patch, never a
    ghost)."""
    ys, xs = np.nonzero(hole)
    span = max(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1)
    band = 6
    best = None
    for k in (FILL_PADS if HAS_XPHOTO else FILL_PADS[:1]):
        pad = int(max(32, k * span))
        if best is not None and pad == best[0]:
            continue
        cand = (pad,) + fill_crop(plate, hole, pad, budget, band)
        if best is None or cand[-1] < best[-1]:
            best = cand
    _, (y0, y1, x0, x1), crop, core, out, smooth, dev = best
    if dev > FILL_DEV:
        out = smooth
    dist = cv2.distanceTransform(((1 - core) * 255).astype(np.uint8), cv2.DIST_L2, 3)
    a = np.clip(1.0 - dist / band, 0.0, 1.0)[:, :, None]
    plate[y0:y1, x0:x1] = np.clip(out * a + crop * (1.0 - a), 0, 255).astype(np.uint8)
    return plate


def subject_travel(used, masks, Hs, w):
    """How far the subject went sideways in the scene, in frame widths: its
    mask centroid in the reference frame's coordinates (the camera's own
    motion removed), mean of the last three aligned samples minus the first
    three. A camera that follows a walking animal keeps it mid-frame; this
    still says which way it walked (the viewer lays the ghost trail behind it)."""
    xs = []
    for i in used:
        yy, xx = np.nonzero(masks[i])
        if len(xx) < 20:
            continue
        p = cv2.perspectiveTransform(np.float32([[[xx.mean(), yy.mean()]]]), Hs[i])
        xs.append(float(p[0, 0, 0]))
    if len(xs) < 2:
        return 0.0
    k = max(1, min(3, len(xs) // 3))
    return round((float(np.mean(xs[-k:])) - float(np.mean(xs[:k]))) / w, 3)


def crop_known(valid):
    """Shrink the canvas rect until every edge is <= EDGE_BAD unknown."""
    h, w = valid.shape
    y0, y1, x0, x1 = 0, h, 0, w
    for _ in range(h + w):
        if y1 - y0 < 8 or x1 - x0 < 8:
            return None
        sub = valid[y0:y1, x0:x1]
        bad = {
            "t": 1 - sub[0].mean(), "b": 1 - sub[-1].mean(),
            "l": 1 - sub[:, 0].mean(), "r": 1 - sub[:, -1].mean(),
        }
        side, worst = max(bad.items(), key=lambda kv: kv[1])
        if worst <= EDGE_BAD:
            break
        if side == "t":
            y0 += 1
        elif side == "b":
            y1 -= 1
        elif side == "l":
            x0 += 1
        else:
            x1 -= 1
    return y0, y1, x0, x1


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--frames-json", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=PLATE_W)
    ap.add_argument("--crop-bottom", type=int, default=0,
                    help="first source row of a burnt-in data bar; the plate is built above it (0 = none)")
    ap.add_argument("--unknown-max", type=float, default=UNKNOWN_MAX)
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args(argv)
    import time
    t0 = time.perf_counter()
    def lap(tag):
        if args.debug:
            sys.stderr.write(f"[plate] {tag} {time.perf_counter() - t0:.2f}s\n")
    cv2.setNumThreads(4)

    spec = json.load(open(args.frames_json, encoding="utf-8"))
    by_frame = defaultdict(list)
    for f in spec.get("frames", []):
        if f.get("mask"):
            by_frame[int(f["sourceFrameIndex"])].append(f["mask"])
    idx = sorted(by_frame)
    if len(idx) < MIN_VOTES + 1:
        return refuse("too few tracked frames")
    if len(idx) > MAX_SAMPLES:
        pick = np.linspace(0, len(idx) - 1, MAX_SAMPLES).round().astype(int)
        idx = [idx[i] for i in sorted(set(pick.tolist()))]

    cap = cv2.VideoCapture(args.video)
    fw, fh = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    if fw < 16 or fh < 16:
        return refuse("unreadable video")
    w = args.width
    # A burnt-in data bar is static: it would pin the registration to
    # identity and print into the plate. Work on the picture above it.
    rows = int(args.crop_bottom) if 0 < args.crop_bottom < fh else None
    if rows:
        fh = rows
    h = max(8, int(round(w * fh / fw)))
    frames = load_frames(args.video, idx, (w, h), rows)
    idx = [i for i in idx if i in frames]
    if len(idx) < MIN_VOTES + 1:
        return refuse("could not decode samples")
    lap("decode")
    dil = max(2, round(w * 0.012))
    with ThreadPoolExecutor(max_workers=6) as ex:  # PNG decode releases the GIL
        masks = dict(zip(idx, ex.map(lambda i: load_mask(by_frame[i], (w, h), dil, rows), idx)))
    grays = {i: cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY) for i in idx}

    # Chain neighbour homographies to the middle sample. Features and the
    # neighbour pairs are independent, so they run on a thread pool (OpenCV
    # releases the GIL; one ORB per thread); the chain is walked in order
    # afterwards, so the result is the same as computing them one by one.
    ref = len(idx) // 2
    Hs = {idx[ref]: np.eye(3)}
    inliers = []
    local = threading.local()

    def feat(i):
        if not hasattr(local, "orb"):
            local.orb = cv2.ORB_create(nfeatures=1500, fastThreshold=12)
        return features(local.orb, grays[i], masks[i])

    jobs = [(idx[k], idx[k + 1]) for k in range(ref, len(idx) - 1)] + [(idx[k], idx[k - 1]) for k in range(ref, 0, -1)]
    with ThreadPoolExecutor(max_workers=6) as ex:
        feats = dict(zip(idx, ex.map(feat, idx)))
        pairs = dict(zip(jobs, ex.map(lambda ab: pair_h(cv2.BFMatcher(cv2.NORM_HAMMING), feats[ab[0]], feats[ab[1]], w, h), jobs)))
    for step in (1, -1):
        k = ref
        while 0 <= k + step < len(idx):
            a, b = idx[k], idx[k + step]
            H, n = pairs[(a, b)]
            if H is None:
                break  # chain broken: farther samples are dropped
            Hs[b] = Hs[a] @ H
            inliers.append(n)
            k += step
    lap("register")
    used = [i for i in idx if i in Hs]
    if len(used) < MIN_VOTES + 1:
        return refuse(f"registration failed ({len(used)} of {len(idx)} samples aligned)")
    travel = subject_travel(used, masks, Hs, w)

    # Canvas: union of the aligned frames, bounded around the reference.
    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
    pts = np.vstack([cv2.perspectiveTransform(corners, Hs[i]) for i in used]).reshape(-1, 2)
    cx0 = max(float(pts[:, 0].min()), -(MAX_CANVAS_W - 1) / 2 * w)
    cx1 = min(float(pts[:, 0].max()), w + (MAX_CANVAS_W - 1) / 2 * w)
    cy0 = max(float(pts[:, 1].min()), -(MAX_CANVAS_H - 1) / 2 * h)
    cy1 = min(float(pts[:, 1].max()), h + (MAX_CANVAS_H - 1) / 2 * h)
    CW, CH = int(np.ceil(cx1 - cx0)), int(np.ceil(cy1 - cy0))
    T = np.array([[1, 0, -cx0], [0, 1, -cy0], [0, 0, 1]], np.float64)

    stack = np.empty((len(used), CH, CW, 3), np.int16)
    warps, cleans = [], []
    for j, i in enumerate(used):
        M = T @ Hs[i]
        warped = cv2.warpPerspective(frames[i], M, (CW, CH), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        clean = cv2.warpPerspective((1 - masks[i]) * 255, M, (CW, CH), flags=cv2.INTER_NEAREST, borderValue=0)
        # Erode the footprint by a pixel: warped borders interpolate black.
        clean = cv2.erode(clean, np.ones((3, 3), np.uint8))
        warps.append(warped)
        cleans.append(clean)
        layer = warped.astype(np.int16)
        layer[clean == 0] = 1000
        stack[j] = layer
    votes = (stack[:, :, :, 0] < 1000).sum(axis=0)
    stack.sort(axis=0)
    k = np.clip((votes - 1) // 2, 0, len(used) - 1)
    med = np.take_along_axis(stack, k[None, :, :, None].repeat(3, axis=3), axis=0)[0]
    valid = votes >= MIN_VOTES

    crop = crop_known(valid.astype(np.float32))
    if crop is None:
        return refuse("no well-covered region")
    y0, y1, x0, x1 = crop
    # Keep the reference frame's centre inside a sane aspect.
    if (x1 - x0) / (y1 - y0) > MAX_ASPECT:
        rcx = int(round(w / 2 - cx0))
        half = int((y1 - y0) * MAX_ASPECT / 2)
        nx0 = min(max(x0, rcx - half), x1 - 2 * half)
        x0, x1 = nx0, nx0 + 2 * half
    ref_cover = ((min(x1, w - cx0) - max(x0, -cx0)) * (min(y1, h - cy0) - max(y0, -cy0))) / (w * h)
    if ref_cover < 0.6:
        return refuse(f"plate covers only {ref_cover:.2f} of the reference frame")
    med = med[y0:y1, x0:x1]
    valid = valid[y0:y1, x0:x1]
    unknown = 1.0 - float(valid.mean())
    lap("median+crop")
    if unknown > (args.unknown_max if HAS_XPHOTO else min(args.unknown_max, 0.04)):
        return refuse(f"unknown share {unknown:.3f}")

    # Registration check (each aligned sample vs the median, clean overlap),
    # then the blend. A plain median switches sample sets at every frame
    # border, so vignetting/exposure/blur steps show as straight seams
    # across a pan; the plate is instead a feathered, gain-matched mean of
    # the samples that agree with the median (|diff| < INLIER_T): same
    # outlier (subject) rejection, no seams.
    mads = []
    medf = med.astype(np.float32)
    acc = np.zeros(medf.shape, np.float32)
    wsum = np.zeros(medf.shape[:2], np.float32)

    def contribution(j):
        warped = warps[j][y0:y1, x0:x1].astype(np.float32)
        feather = np.clip(cv2.distanceTransform(cleans[j], cv2.DIST_L2, 3)[y0:y1, x0:x1] / FEATHER_PX, 0, 1)
        sel = (cv2.erode(cleans[j], np.ones((5, 5), np.uint8))[y0:y1, x0:x1] > 0) & valid
        if sel.sum() <= 500:
            return None
        mad_j = float(np.abs(warped[sel] - medf[sel]).mean())
        gain = np.clip(medf[sel].mean(axis=0) / np.maximum(warped[sel].mean(axis=0), 1.0), 0.85, 1.18)
        warped *= gain
        agree = np.abs(warped - medf).mean(axis=2) < INLIER_T
        wj = feather * agree
        return mad_j, warped * wj[:, :, None], wj

    # Per-sample work in parallel; summed in sample order (same result).
    with ThreadPoolExecutor(max_workers=6) as ex:
        parts = list(ex.map(contribution, range(len(used))))
    for part in parts:
        if part is None:
            continue
        mads.append(part[0])
        acc += part[1]
        wsum += part[2]
    mad = float(np.median(mads)) if mads else 999.0
    if mad > MAD_MAX:
        return refuse(f"misregistered (mad {mad:.1f})")
    blended = np.where(wsum[:, :, None] > 0.05, acc / np.maximum(wsum, 1e-6)[:, :, None], medf)
    plate = np.clip(np.where(valid[:, :, None], blended, medf), 0, 255).astype(np.uint8)
    lap("blend")
    if unknown > 0:
        t1 = time.perf_counter()
        hole = (~valid).astype(np.uint8)
        plate = fill_holes(plate, hole)
        lap(f"fill {time.perf_counter() - t1:.2f}s")
    if not cv2.imwrite(args.out, plate):
        return refuse("could not write plate")
    return emit({
        "ok": True, "width": int(plate.shape[1]), "height": int(plate.shape[0]),
        "unknownShare": round(unknown, 4), "mad": round(mad, 2),
        "samples": len(used), "of": len(idx), "inliers": int(np.median(inliers)) if inliers else 0,
        "travel": travel,
    })


if __name__ == "__main__":
    sys.exit(main())
