"""Contact residue: subject part left in the plate just outside the claim.

Lane E (Main-reviewed). run-basic uses --ids (label PNG -> binary subject)
and --ext-out (UN-grown subject | blobs, for `plate.py composite --grow 11`).

Positive case: fixtures/plate-residue-v1/adv-v4-plate.png keeps a brown hoof
tip at about (590, 388), ~5 px outside the seed-alpha claim grown 11.
Existing ghost/residue gates read 0 because they measure against the same
claim. This module flags subject-coloured compact blobs that touch the claim
in the contact (feet/hooves) zone, and repairs them by extending the claim.

Scipy-free (cv2 + numpy only) so the logic can be ported to production.
Deterministic: k-means init at Lab percentiles, fixed iteration cap.
"""

import argparse
import json

import cv2
import numpy as np

GROW_DEFAULT = 11
REACH_FRAC = 0.04
REACH_MIN, REACH_MAX = 5, 25
CONTACT_FRAC = 0.30  # search rows at/below yBottom - 0.30*H
SUBJ_MAX = 50.0  # Lab distance to subject palette
BG_MIN = 60.0  # Lab distance from local background median
SCORE_MIN = 20.0  # mean(dBg) - mean(dSubj) over blob
MIN_AREA = 25  # px after 3x3 open
TOUCH_PX = 3  # blob must touch claim dilated this far
BLOB_DILATE = 5  # claimExt growth per kept blob
FEATHER_DEFAULT = 2.0
EXACT_OUTSIDE = 15


def _bin(alpha):
    a = np.asarray(alpha)
    if a.ndim == 3:
        a = a[..., 0]
    return (a > 127)


def _subject_centers(seed_bgr, interior):
    lab = cv2.cvtColor(seed_bgr, cv2.COLOR_BGR2Lab).astype(np.float32)
    vals = lab[interior]
    if int(interior.sum()) < 100 or len(vals) < 3:
        med = np.median(vals.reshape(-1, 3), axis=0) if len(vals) else np.zeros(3, np.float32)
        return np.array([med, med, med], dtype=np.float32)
    centers = np.array([np.percentile(vals, q, axis=0) for q in (25, 50, 75)],
                       dtype=np.float32)
    for _ in range(15):
        d = np.sqrt(((vals[:, None, :] - centers[None, :, :]) ** 2).sum(-1))
        lab_ids = d.argmin(1)
        new = np.array([vals[lab_ids == i].mean(axis=0) if bool((lab_ids == i).any())
                        else centers[i] for i in range(3)], dtype=np.float32)
        if np.allclose(new, centers):
            break
        centers = new
    return centers


def _ring_median(plate_lab, claim):
    outer = cv2.dilate(claim.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
    inner = cv2.dilate(claim.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    ring = outer & ~inner
    if int(ring.sum()) < 50:
        ring = outer & ~claim
    vals = plate_lab[ring]
    return np.median(vals.reshape(-1, 3), axis=0), ring


def detect(plate, seed, alpha, grow=GROW_DEFAULT):
    """Flag contact-residue blobs. Returns dict with blobs + claimExt mask.

    blobs: [{x, y, area, dist, dSubj, dBg, score}] (floats, x/y centroid).
    claimExt: uint8 mask (0/255) = claim plus kept blobs dilated BLOB_DILATE.
    Also returns debug dict under 'debug' (claimPx, reach, thresholds).
    """
    plate = np.asarray(plate)
    seed = np.asarray(seed)
    subj = _bin(alpha)
    h, w = subj.shape[:2]
    if int(subj.sum()) == 0:
        return {"blobs": [], "claimExt": np.zeros((h, w), np.uint8),
                "debug": {"claimPx": 0, "reach": 0, "empty": True}}
    ys, xs = np.where(subj)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    H = int(y1 - y0 + 1)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * int(grow) + 1, 2 * int(grow) + 1))
    claim = cv2.dilate(subj.astype(np.uint8), k) > 0
    reach = int(round(REACH_FRAC * H))
    reach = max(REACH_MIN, min(REACH_MAX, reach))
    kr = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1, 2 * reach + 1))
    band = (cv2.dilate(claim.astype(np.uint8), kr) > 0) & ~claim
    contact = np.zeros_like(band)
    contact[max(0, int(y1 - CONTACT_FRAC * H)):, :] = True
    search = band & contact

    a = np.asarray(alpha)
    if a.ndim == 3:
        a = a[..., 0]
    interior = (a > 230).astype(np.uint8)
    interior = cv2.erode(interior, np.ones((5, 5), np.uint8)) > 0
    if int(interior.sum()) < 100:
        interior = subj
    centers = _subject_centers(np.asarray(seed), interior)

    plate_lab = cv2.cvtColor(np.asarray(plate), cv2.COLOR_BGR2Lab).astype(np.float32)
    rmed, _ring = _ring_median(plate_lab, claim)
    dSubj = np.sqrt(((plate_lab[:, :, None, :] - centers[None, None, :, :]) ** 2).sum(-1)).min(-1)
    dBg = np.sqrt(((plate_lab - rmed) ** 2).sum(-1))

    cand = (search & (dSubj <= SUBJ_MAX) & (dBg >= BG_MIN)).astype(np.uint8)
    cand = cv2.morphologyEx(cand, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    n, comp, stats, cents = cv2.connectedComponentsWithStats(cand.astype(np.uint8), 8)
    kt = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * TOUCH_PX + 1, 2 * TOUCH_PX + 1))
    touch = cv2.dilate(claim.astype(np.uint8), kt) > 0

    blobs = []
    kb = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * BLOB_DILATE + 1, 2 * BLOB_DILATE + 1))
    ext = claim.copy()
    blob_mask = np.zeros_like(claim)
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < MIN_AREA:
            continue
        m = (comp == i)
        if not bool(touch[m].any()):
            continue
        ds = float(dSubj[m].mean())
        db = float(dBg[m].mean())
        score = float(db - ds)
        if score < SCORE_MIN:
            continue
        # distance from blob to claim (min over blob pixels to claim bbox
        # Sana: exact via dilated rings; report gap search radius)
        cx, cy = float(cents[i][0]), float(cents[i][1])
        # gap: smallest r in 1..reach+2 with dilate(claim,r) touching blob
        dist = float(reach + 1)
        for r in range(0, reach + 3):
            kk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
            if bool((cv2.dilate(claim.astype(np.uint8), kk) > 0)[m].any()):
                dist = float(r)
                break
        blobs.append({"x": round(cx, 1), "y": round(cy, 1), "area": area,
                      "dist": round(dist, 1), "dSubj": round(ds, 1),
                      "dBg": round(db, 1), "score": round(score, 1)})
        grown = cv2.dilate(m.astype(np.uint8), kb) > 0
        ext = ext | grown
        blob_mask = blob_mask | grown
    blobs.sort(key=lambda b: -b["score"])
    return {"blobs": blobs, "claimExt": (ext.astype(np.uint8) * 255),
            "subjectExt": ((subj | blob_mask).astype(np.uint8) * 255),
            "debug": {"claimPx": int(claim.sum()), "reach": int(reach),
                      "bbox": [x0, y0, x1, y1], "subjMax": SUBJ_MAX,
                      "bgMin": BG_MIN, "scoreMin": SCORE_MIN,
                      "minArea": MIN_AREA, "touchPx": TOUCH_PX}}


def affine_match(fill, base, ring):
    matched = fill.copy()
    for c in range(3):
        f = fill[:, :, c].astype(np.float64)[ring]
        b = base[:, :, c].astype(np.float64)[ring]
        fm_, fs_ = float(f.mean()), float(f.std() + 1e-6)
        bm_, bs_ = float(b.mean()), float(b.std() + 1e-6)
        gain = min(2.0, max(0.5, bs_ / fs_))
        off = bm_ - fm_ * gain
        matched[:, :, c] = np.clip(fill[:, :, c].astype(np.float64) * gain + off, 0, 255)
    return matched.astype(np.uint8)


def repair_plate(base, fill, claim_ext, feather=FEATHER_DEFAULT, match=True,
                 exact_outside=EXACT_OUTSIDE):
    """Composite fill inside claim_ext over base (mirrors plate.py composite).

    claim_ext: uint8 0/255 hole (already grown). Feather σ=2.0 Gaussian,
    ring affine-match, bit-exact base beyond hole+exact_outside.
    """
    base = np.asarray(base)
    fill = np.asarray(fill)
    if fill.shape[:2] != base.shape[:2]:
        fill = cv2.resize(fill, (base.shape[1], base.shape[0]),
                          interpolation=cv2.INTER_LINEAR)
    hole = (np.asarray(claim_ext)[..., 0] > 0 if np.asarray(claim_ext).ndim == 3
            else np.asarray(claim_ext) > 0)
    if match and int(hole.sum()) > 0:
        outer = cv2.dilate(hole.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
        inner = cv2.dilate(hole.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        ring = outer & ~inner
        if int(ring.sum()) > 50:
            fill = affine_match(fill, base, ring)
    alpha = cv2.GaussianBlur(hole.astype(np.float32), (0, 0), float(feather))[..., None]
    out = (base.astype(np.float32) * (1 - alpha)
           + fill.astype(np.float32) * alpha).astype(np.uint8)
    if int(exact_outside) > 0:
        km = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                       (2 * int(exact_outside) + 1, 2 * int(exact_outside) + 1))
        keep = cv2.dilate(hole.astype(np.uint8), km) > 0
        out[~keep] = base[~keep]
    return out


def _load_color(path):
    im = cv2.imread(path, cv2.IMREAD_COLOR)
    if im is None:
        raise SystemExit(f"cannot read {path}")
    return im


def main(argv=None):
    p = argparse.ArgumentParser(description="contact-residue detect+repair")
    p.add_argument("--plate", required=True)
    p.add_argument("--seed", required=True)
    p.add_argument("--alpha", required=True)
    p.add_argument("--fill", default=None)
    p.add_argument("--grow", type=int, default=GROW_DEFAULT)
    p.add_argument("--out", default=None, help="repaired output path")
    p.add_argument("--claim-out", default=None, help="claimExt mask output path")
    p.add_argument("--ids", default=None, help="alpha is an id-label PNG: these ids are the subject")
    p.add_argument("--ext-out", default=None, help="un-grown subject|blobs mask (written only when blobs exist)")
    args = p.parse_args(argv)
    plate = _load_color(args.plate)
    seed = _load_color(args.seed)
    alpha = cv2.imread(args.alpha, cv2.IMREAD_UNCHANGED)
    if alpha is None:
        raise SystemExit(f"cannot read {args.alpha}")
    if args.ids:
        lab = alpha[..., 0] if alpha.ndim == 3 else alpha  # channel-0 label read
        alpha = np.isin(lab, [int(x) for x in args.ids.split(",") if x.strip()]).astype(np.uint8) * 255
    if alpha.shape[:2] != plate.shape[:2]:
        alpha = cv2.resize(alpha, (plate.shape[1], plate.shape[0]),
                           interpolation=cv2.INTER_NEAREST)
    if seed.shape[:2] != plate.shape[:2]:
        seed = cv2.resize(seed, (plate.shape[1], plate.shape[0]),
                          interpolation=cv2.INTER_LINEAR)
    res = detect(plate, seed, alpha, grow=args.grow)
    out = {"blobs": res["blobs"], "n": len(res["blobs"]), "debug": res["debug"]}
    if args.fill and args.out:
        fill = _load_color(args.fill)
        rep = repair_plate(plate, fill, res["claimExt"])
        cv2.imwrite(args.out, rep)
        out["repaired"] = args.out
    if args.claim_out:
        cv2.imwrite(args.claim_out, res["claimExt"])
    if args.ext_out and res["blobs"]:
        if not cv2.imwrite(args.ext_out, res["subjectExt"]):
            raise SystemExit(f"cannot write {args.ext_out}")
        out["extOut"] = args.ext_out
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
