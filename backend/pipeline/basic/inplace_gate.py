"""In-place plate acceptance rung, v2 (Lane E prototype).

The standard ladder (plate.py ghost-map / validate / validate-holds) uses the
temporal median as the reference. For an in-place subject the median NEVER
sees behind the subject, so the median is contaminated inside the footprint
and any clean fill scores as "residue" against it.

v1 tried to keep the median as reference outside a grown claim (exact-outside
+ strong-witness fidelity). Main's visual verdict showed that inverts quality:
the shipped holes-hybrids keep a person-shaped ghost (pale halo, dark smear,
held paper) while the pure Muse regeneration is clean, yet v1 accepted the
hybrids and rejected Muse because Muse regrades the whole frame.

v2 is a regenerated-plate rung. It is used ONLY when the contamination
detector says in-place (contamShare high). A full regeneration replaces the
whole background, so pixel equality with the median outside the zone is NOT
required. Instead the rung checks, in order:
  a. contamination flag -> in-place vs defer-to-standard-ladder (unchanged)
  b. subject erasure: median IS the subject on never-witnessed pixels, so a
     plate must differ there (rejects median-as-plate)
  c. geometric alignment outside the zone: phase-correlation shift, Sobel
     magnitude correlation, and tolerant (2 px) Canny edge F-score
  d. bounded tone drift: per-channel affine median ~= a*cand+b on outside,
     residual MAE plus slope/intercept bounds (allows global shift, not
     structural change)
  e. subject-likeness inside the footprint, from the label record only:
     halo gradient NCC (silhouette persistence), prop gradient NCC when a
     second tracked id exists (held prop), and background-ring histogram
     correlation (zone must look like nearby observed background, not ghost)
  f. no hallucinated objects in the never-seen core: ring-referenced ghost
     share, edge, texture and tone floors (kept from v1, unchanged limits)

Scipy-free (cv2 + numpy only) so the logic can move into production code.

  python -I inplace_gate.py --median plate-median.jpg --candidate plate-x.jpg \
      --claim holes.png --labels path/to/labels --ids 1
"""

import argparse
import glob
import json
import os
import sys

import cv2
import numpy as np

# --- thresholds -----------------------------------------------------------
# Reused unchanged from the existing ladder (NOT relaxed):
GHOST_LIMIT = 0.30         # run-basic --ghost-limit default (thin-blob share)
TEX_RATIO_LIMIT = 0.35     # plate.py validate-holes texture floor
COLOR_DIST_SLACK = 25.0    # plate.py COLOR_DIST_LIMIT scale (BGR units)
EDGE_RING_RATIO = 1.1      # ghost-map scoped ruling: edge within median range
MIN_REGION_FRAC = 0.001    # plate.py: smaller specks are not judged
MIN_PIXELS = 100           # below this a sub-metric is "unmeasured", never 0
# Detector (unchanged from v1, calibrated on Clip-b/CG-robot in PLATE.md):
CONTAM_LIMIT = 0.10        # contaminated-claim share above which median is
                           # declared an invalid reference (moving clips: 0.0,
                           # clip-b: 0.81-0.99, clip-a: 0.63)
CONTAM_FRAME_MIN = 0.005   # materiality: contaminated share of the frame
STRONG_FRAC = 0.5          # witness share at/above which the median pixel is
                           # provably background (majority of frames)
ERASE_MIN = 10.0           # subject-erasure floor (BGR units): inside the
                           # never-witnessed footprint the median IS the
                           # subject, so a plate must differ from it there.
FID_EXCLUDE_DILATE = 15    # SAM-mask dilation for the witness maps: excludes
                           # halo + the subject's own shadow
HOLE_DILATE = 5            # median-parity dilation for the hole/witness map
GROW = 11                  # claim growth: hole + seam margin (ladder parity)
MARGIN = 15                # outside margin beyond the grown hole
WITNESS_MIN = 3            # median-parity witness minimum
NEAR_BOX = 121             # neighbourhood (odd side) for nearby observed tones
# Regen rung (new in v2, calibrated on Clip-b in PLATE.md v2 section):
SHIFT_LIMIT = 1.5          # phase-correlation shift magnitude outside (px).
                           # Regen must not move scene structure (cutouts are
                           # drawn over the plate). Hybrids 0.00, muse 0.88.
SOBEL_LIMIT = 0.50         # Sobel magnitude correlation outside. Hybrids
                           # 1.00, muse 0.61. Strict Canny IoU (0.18-0.30 for
                           # muse) is too brittle at 1-px localisation, so
                           # the binding edge gate is the tolerant F below.
EDGE_F_LIMIT = 0.80        # tolerant (2 px) Canny edge F-score outside.
                           # Hybrids 0.996, muse 0.919. Tol 2 absorbs the
                           # 0.88-px regen shift plus JPEG edge jitter.
TONE_RESID_LIMIT = 15.0    # affine residual MAE outside (BGR units, max over
                           # channels). Hybrids 0.2, muse 11.4. Allows the
                           # regen's spatially varying re-lighting, rejects
                           # wild repaints (synthetic +30 shift still fits
                           # with small resid, so slope/intercept bind it).
TONE_SLOPE_LO = 0.80       # affine slope bounds (median ~= a*cand+b).
TONE_SLOPE_HI = 1.20       # Muse 0.90, hybrids 1.00.
TONE_INTERCEPT_LIMIT = 25.0  # |b| bound (BGR units). Muse +5, hybrids 0.
HALO_NCC_LIMIT = 0.43      # halo gradient-vector NCC median-vs-candidate.
                           # Ghost retains the silhouette gradients:
                           # shipped 0.50, sweep 0.23, muse 0.19. A second,
                           # visually clean Muse render of clip-b (product run
                           # p1) scores 0.365: the band also holds real,
                           # witnessed background edges. Limit sits midway
                           # between clean max 0.365 and ghost 0.498.
SUBJ_NCC_LIMIT = 0.35      # same NCC on the majority footprint itself: the
                           # rim is blind to interior ghosts (Lane E
                           # HALO-CALIB: clean max 0.20, alpha>=0.5 synthetic
                           # ghosts 0.52+; the median scores 1.00).
PAPER_NCC_LIMIT = 0.80     # prop gradient NCC (second tracked id, when one
                           # exists). Hybrids 1.00 (paper kept pixel-exact),
                           # muse 0.33 (paper gone). Skipped when no prop.
BG_CORR_LIMIT = 0.50       # mean 32-bin histogram correlation of the erase
                           # zone against the median ring (observed
                           # background). Ghost is unlike the ring:
                           # hybrids 0.04-0.06, muse 0.91, median 0.74.


def load_bgr(path):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit("cannot read %s" % path)
    return img


def load_mask(path, shape):
    m = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise SystemExit("cannot read %s" % path)
    if m.shape != shape:
        m = cv2.resize(m, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
    return m > 0


def load_labels(labels_dir, ids, shape):
    files = sorted(glob.glob(os.path.join(labels_dir, "*.png")))
    if not files:
        raise SystemExit("no label PNGs in %s" % labels_dir)
    masks = []
    for f in files:
        m = cv2.imread(f, cv2.IMREAD_UNCHANGED)
        if m is None:
            raise SystemExit("cannot read label %s" % f)
        if m.ndim == 3:
            m = m[:, :, 0]  # palette-proof channel-0 read (REFERENCE.md)
        hit = np.isin(m, np.asarray(ids))
        if hit.shape != shape:
            hit = cv2.resize(hit.astype(np.uint8), (shape[1], shape[0]),
                             interpolation=cv2.INTER_NEAREST).astype(bool)
        masks.append(hit)
    return np.stack(masks)


def first_label_uniques(labels_dir):
    files = sorted(glob.glob(os.path.join(labels_dir, "*.png")))
    if not files:
        return []
    m = cv2.imread(files[0], cv2.IMREAD_UNCHANGED)
    if m is None:
        return []
    if m.ndim == 3:
        m = m[:, :, 0]
    return [int(v) for v in np.unique(m)]


def dilate(mask, r):
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    return cv2.dilate(mask.astype(np.uint8), k) > 0


def witness_counts(masks, r):
    # Per-pixel count of frames showing background, with the subject mask
    # grown by r px (halo/shadow exclusion). Pure function of label rasters.
    forbid = np.stack([dilate(m, r) for m in masks])
    return (~forbid).sum(0)


def edge_energy(img, zone):
    g = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8),
                     cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    m = np.hypot(gx, gy)
    return round(float(m[zone].mean()) if int(zone.sum()) else 0.0, 3)


def ghost_stats(img, zone):
    # Copied semantics from plate.py ghost_stats: long-thin smooth-bias blobs.
    smooth = cv2.GaussianBlur(img, (0, 0), 8.0)
    bias = np.abs(img.astype(np.float32) - smooth).mean(axis=2)
    candles = ((bias > 6) & zone).astype(np.uint8)
    nlab, _, stats, _ = cv2.connectedComponentsWithStats(candles, 8)
    big = []
    for i in range(1, nlab):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < 150:
            continue
        w = max(1, stats[i, cv2.CC_STAT_WIDTH])
        h = max(1, stats[i, cv2.CC_STAT_HEIGHT])
        if max(w, h) / min(w, h) > 2.5:
            big.append(i)
    share = sum(int(stats[i, cv2.CC_STAT_AREA]) for i in big) / max(1, int(zone.sum()))
    return round(share, 4), len(big)


def core_texture(img, core):
    # Per-component texture ratio vs local ring (plate.py validate-holes
    # geometry and TEX_RATIO_LIMIT; colour judged against witnesses below).
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.abs(gx) + np.abs(gy)
    h, w = core.shape
    n, comp = cv2.connectedComponents(core.astype(np.uint8))
    regions = []
    for label in range(1, n):
        area = int((comp == label).sum())
        if area < MIN_REGION_FRAC * h * w:
            regions.append({"area": area, "pass": True, "note": "too small to judge"})
            continue
        blob = comp == label
        rin = cv2.erode(blob.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        outer = cv2.dilate(blob.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
        inner = cv2.dilate(blob.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        ring = outer & ~inner
        if int(rin.sum()) < 20 or int(ring.sum()) < 50:
            regions.append({"area": area, "pass": True, "note": "unmeasurable ring"})
            continue
        tex = float(grad[rin].mean() / max(grad[ring].mean(), 1e-6))
        ok = tex >= TEX_RATIO_LIMIT
        regions.append({"area": area, "texRatio": round(tex, 3), "pass": ok})
    return regions


def gray_f32(bgr):
    return cv2.cvtColor(np.clip(bgr, 0, 255).astype(np.uint8),
                        cv2.COLOR_BGR2GRAY).astype(np.float32)


def phase_shift(med_gray, cand_gray, outside):
    # Masked phase correlation: the zone differs by design (ghost removed),
    # so fill it with the outside mean on both sides before correlating.
    h, w = med_gray.shape
    mu_m = float(med_gray[outside].mean())
    mu_c = float(cand_gray[outside].mean())
    a = med_gray.copy()
    b = cand_gray.copy()
    a[~outside] = mu_m
    b[~outside] = mu_c
    hann = cv2.createHanningWindow((w, h), cv2.CV_32F)
    a32 = (a - mu_m).astype(np.float32)
    b32 = (b - mu_c).astype(np.float32)
    (sx, sy), resp = cv2.phaseCorrelate(a32, b32, hann)
    mag = float(np.hypot(sx, sy))
    return round(float(sx), 4), round(float(sy), 4), round(mag, 4), round(float(resp), 4)


def sobel_corr(med_gray, cand_gray, outside):
    gx_m = cv2.Sobel(med_gray, cv2.CV_32F, 1, 0, ksize=3)
    gy_m = cv2.Sobel(med_gray, cv2.CV_32F, 0, 1, ksize=3)
    mag_m = np.hypot(gx_m, gy_m)
    gx_c = cv2.Sobel(cand_gray, cv2.CV_32F, 1, 0, ksize=3)
    gy_c = cv2.Sobel(cand_gray, cv2.CV_32F, 0, 1, ksize=3)
    mag_c = np.hypot(gx_c, gy_c)
    x = mag_m[outside].astype(np.float64)
    y = mag_c[outside].astype(np.float64)
    xm = x - x.mean()
    ym = y - y.mean()
    denom = float(np.sqrt((xm ** 2).mean() * (ym ** 2).mean()))
    if denom < 1e-9:
        return 0.0
    return round(float((xm * ym).mean() / denom), 4)


def edge_fscore(med_bgr, cand_bgr, outside, tol=2):
    cm = cv2.Canny(med_bgr, 100, 200) > 0
    cu = cv2.Canny(cand_bgr, 100, 200) > 0
    cmo = cm & outside
    cuo = cu & outside
    if tol == 0:
        inter_m = np.logical_and(cmo, cuo).sum()
        inter_u = inter_m
    else:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * tol + 1, 2 * tol + 1))
        dmo = cv2.dilate(cmo.astype(np.uint8), k) > 0
        duo = cv2.dilate(cuo.astype(np.uint8), k) > 0
        inter_m = np.logical_and(cmo, duo).sum()
        inter_u = np.logical_and(cuo, dmo).sum()
    prec = float(inter_u / max(int(cuo.sum()), 1))
    rec = float(inter_m / max(int(cmo.sum()), 1))
    f = 0.0 if (prec + rec) < 1e-9 else 2 * prec * rec / (prec + rec)
    return round(prec, 4), round(rec, 4), round(f, 4)


def affine_fit(med_bgr, cand_bgr, outside):
    # Per-channel least squares median ~= a*cand+b on outside pixels.
    med_f = med_bgr.astype(np.float64)
    can_f = cand_bgr.astype(np.float64)
    slopes, intercepts, resids, raws = [], [], [], []
    for ch in range(3):
        x = can_f[:, :, ch][outside]
        y = med_f[:, :, ch][outside]
        xm = x.mean()
        ym = y.mean()
        var = ((x - xm) ** 2).mean()
        a = float(((x - xm) * (y - ym)).mean() / max(var, 1e-9))
        b = float(ym - a * xm)
        resid = float(np.abs(a * x + b - y).mean())
        raw = float(np.abs(x - y).mean())
        slopes.append(round(a, 4))
        intercepts.append(round(b, 2))
        resids.append(round(resid, 3))
        raws.append(round(raw, 3))
    return slopes, intercepts, resids, raws


def grad_ncc(med_gray, cand_gray, mask):
    gx_m = cv2.Sobel(med_gray, cv2.CV_32F, 1, 0, ksize=3)
    gy_m = cv2.Sobel(med_gray, cv2.CV_32F, 0, 1, ksize=3)
    gx_c = cv2.Sobel(cand_gray, cv2.CV_32F, 1, 0, ksize=3)
    gy_c = cv2.Sobel(cand_gray, cv2.CV_32F, 0, 1, ksize=3)
    dot = float((gx_m * gx_c + gy_m * gy_c)[mask].mean())
    rms_m = float(np.sqrt(((gx_m ** 2 + gy_m ** 2)[mask]).mean()))
    rms_c = float(np.sqrt(((gx_c ** 2 + gy_c ** 2)[mask]).mean()))
    if rms_m < 1e-9 or rms_c < 1e-9:
        return 0.0
    return round(dot / (rms_m * rms_c), 4)


def hist_corr_to_ring(cand_bgr, erase, ring_bgr_pixels, bins=32):
    # Mean per-channel histogram correlation of the candidate erase zone
    # against the median ring (observed background). Ghost paint has a
    # different palette shape from the surrounding wall/sofa; a clean
    # continuation correlates strongly.
    corrs = []
    for ch in range(3):
        hc, _ = np.histogram(cand_bgr[:, :, ch][erase].astype(int),
                             bins=bins, range=(0, 255))
        ht, _ = np.histogram(ring_bgr_pixels[:, ch].astype(int),
                             bins=bins, range=(0, 255))
        hc = hc.astype(float)
        ht = ht.astype(float)
        am = hc - hc.mean()
        bm = ht - ht.mean()
        denom = float(np.sqrt((am ** 2).mean() * (bm ** 2).mean()))
        if denom < 1e-9:
            corrs.append(0.0)
        else:
            corrs.append(round(float((am * bm).mean() / denom), 4))
    mean_c = round(float(np.mean(corrs)), 4)
    return corrs, mean_c


def run(args):
    median = load_bgr(args.median).astype(np.float32)
    h, w = median.shape[:2]
    cand = load_bgr(args.candidate)
    if cand.shape[:2] != (h, w):
        cand = cv2.resize(cand, (w, h), interpolation=cv2.INTER_LINEAR)
    cand = cand.astype(np.float32)
    claim = load_mask(args.claim, (h, w))

    ids = [int(x) for x in str(args.ids).split(",") if x.strip() != ""]
    if not ids:
        raise SystemExit("--ids is empty")
    labels = load_labels(args.labels, ids, (h, w))
    nframes = len(labels)

    # Witness maps. wit5 mirrors the median hole definition (HOLE_DILATE);
    # witF excludes halo/shadow (exclude_dilate) for erasure judgements.
    wit5 = witness_counts(labels, HOLE_DILATE)
    witF = witness_counts(labels, args.exclude_dilate)
    strong_need = int(np.ceil(args.strong_frac * nframes))

    out = {"frames": nframes, "strongNeed": strong_need,
           "claimShare": round(float(claim.mean()), 4)}

    if int(claim.sum()) == 0:
        out.update({"verdict": "defer", "reason": "empty claim: nothing to judge",
                    "inplace": False, "contamShare": 0.0})
        return out

    contaminated = wit5 < args.witness_min
    contam_px = int((contaminated & claim).sum())
    contam_share = contam_px / max(1, int(claim.sum()))
    inplace = (contam_share > args.contam_limit
               and contam_px / (h * w) > CONTAM_FRAME_MIN)
    out.update({"inplace": bool(inplace),
                "contamShare": round(contam_share, 4),
                "contamFrameShare": round(contam_px / (h * w), 4)})
    if not inplace:
        out.update({"verdict": "defer",
                    "reason": "median reference valid: use the standard ladder"})
        return out

    # (b) Subject erasure: the witness record proves the median shows the
    # selected subject on `erase`. A plate that still shows it there is not
    # a plate, however plausible the paint.
    erase = (witF == 0) & claim
    erase_n = int(erase.sum())
    out.update({"erasePixels": erase_n})
    if erase_n < MIN_PIXELS:
        out.update({"verdict": "reject",
                    "reason": "unmeasured: no never-witnessed footprint"})
        return out
    erase_diff = float(np.abs(cand - median).mean(axis=2)[erase].mean())
    erase_ok = erase_diff >= ERASE_MIN
    out.update({"eraseDiff": round(erase_diff, 3),
                "eraseOk": bool(erase_ok)})

    hole = dilate(claim, args.grow)
    outside = ~dilate(hole, args.margin)
    if int(outside.sum()) < MIN_PIXELS:
        out.update({"verdict": "reject", "reason": "unmeasured: no outside pixels"})
        return out

    med_u8 = np.clip(median, 0, 255).astype(np.uint8)
    cand_u8 = np.clip(cand, 0, 255).astype(np.uint8)
    med_gray = gray_f32(med_u8)
    cand_gray = gray_f32(cand_u8)

    # (c) Geometric alignment outside the zone. The plate replaces the whole
    # background, so exact pixel equality is NOT required; structure must not
    # move (or cutouts float) and edges must agree within localisation.
    sx, sy, shift_mag, shift_resp = phase_shift(med_gray, cand_gray, outside)
    shift_ok = shift_mag <= args.shift_limit
    out.update({"shiftX": sx, "shiftY": sy, "shiftMag": shift_mag,
                "shiftResp": shift_resp, "shiftOk": bool(shift_ok)})
    s_corr = sobel_corr(med_gray, cand_gray, outside)
    sobel_ok = s_corr >= args.sobel_limit
    out.update({"sobelCorr": s_corr, "sobelOk": bool(sobel_ok)})
    e_prec, e_rec, e_f = edge_fscore(med_u8, cand_u8, outside, tol=2)
    edge_geo_ok = e_f >= args.edge_f_limit
    out.update({"edgePrec2": e_prec, "edgeRec2": e_rec, "edgeF2": e_f,
                "edgeGeoOk": bool(edge_geo_ok)})

    # (d) Bounded tone drift: per-channel affine median ~= a*cand+b outside.
    # A global re-lighting passes (small residual, slope ~1, small |b|);
    # structural repaint does not hide behind the fit (residual stays high).
    slopes, intercepts, resids, raws = affine_fit(med_u8, cand_u8, outside)
    max_resid = max(resids)
    tone_ok = (max_resid <= args.tone_resid_limit
               and all(args.tone_slope_lo <= a <= args.tone_slope_hi for a in slopes)
               and all(abs(b) <= args.tone_intercept_limit for b in intercepts))
    out.update({"toneSlopes": slopes, "toneIntercepts": intercepts,
                "toneResids": resids, "toneRaw": raws,
                "toneMaxResid": round(max_resid, 3), "toneOk": bool(tone_ok)})

    # (e) Subject-likeness inside the footprint (label record only).
    subj_major = labels.sum(0) > (nframes // 2)
    halo = dilate(subj_major, args.exclude_dilate) & ~subj_major
    halo_n = int(halo.sum())
    out.update({"haloPixels": halo_n})
    if halo_n < MIN_PIXELS:
        out.update({"verdict": "reject", "reason": "unmeasured: no halo band"})
        return out
    halo_ncc = grad_ncc(med_gray, cand_gray, halo)
    halo_ok = halo_ncc <= args.halo_ncc_limit
    subj_ncc = grad_ncc(med_gray, cand_gray, subj_major)
    subj_ok = subj_ncc <= SUBJ_NCC_LIMIT
    out.update({"haloNCC": halo_ncc, "haloOk": bool(halo_ok),
                "subjNCC": subj_ncc, "subjOk": bool(subj_ok)})

    # Held prop: a second tracked id (clip-b id 2) is part of the subject. When
    # one exists, its gradients must not survive in the plate.
    prop_ids = [v for v in first_label_uniques(args.labels)
                if v != 0 and v not in ids]
    prop_ok = True
    prop_ncc = None
    prop_n = 0
    if prop_ids:
        prop_masks = load_labels(args.labels, prop_ids, (h, w))
        prop_major = prop_masks.sum(0) > (nframes // 2)
        prop_n = int(prop_major.sum())
        out.update({"propIds": prop_ids, "propPixels": prop_n})
        if prop_n >= MIN_PIXELS:
            prop_ncc = grad_ncc(med_gray, cand_gray, prop_major)
            prop_ok = prop_ncc <= args.paper_ncc_limit
            out.update({"propNCC": prop_ncc, "propOk": bool(prop_ok)})
        else:
            out.update({"propNCC": None, "propOk": True,
                        "note": "prop too small to judge"})
    else:
        out.update({"propIds": [], "propPixels": 0, "propNCC": None,
                    "propOk": True, "note": "no second tracked id"})

    # Background-ring palette: the erase zone must look like the nearby
    # OBSERVED background (median ring), not like ghost paint.
    bg_ring = ((cv2.dilate(hole.astype(np.uint8), np.ones((31, 31), np.uint8))
                & ~cv2.dilate(hole.astype(np.uint8), np.ones((9, 9), np.uint8))) > 0)
    if int(bg_ring.sum()) < 50:
        out.update({"verdict": "reject", "reason": "unmeasured: no bg ring"})
        return out
    ring_px = med_u8[bg_ring].reshape(-1, 3)
    bg_corrs, bg_mean = hist_corr_to_ring(cand_u8, erase, ring_px)
    bg_ok = bg_mean >= args.bg_corr_limit
    out.update({"bgCorrs": bg_corrs, "bgCorrMean": bg_mean,
                "bgCorrOk": bool(bg_ok)})

    # (f) Never-seen core plausibility, ring-referenced (kept from v1).
    core = hole & (witF < strong_need)
    core_n = int(core.sum())
    out.update({"coreShare": round(core_n / (h * w), 4)})
    if core_n < MIN_PIXELS:
        ok = erase_ok and shift_ok and sobel_ok and edge_geo_ok and tone_ok \
            and halo_ok and subj_ok and prop_ok and bg_ok
        out.update({"verdict": "accept" if ok else "reject",
                    "reason": "core too small to judge; verdict on regen rung"})
        return out

    ghost_share, ghost_blobs = ghost_stats(cand, core)
    ghost_ok = ghost_share <= GHOST_LIMIT
    out.update({"coreGhostShare": ghost_share, "coreGhostBlobs": ghost_blobs,
                "coreGhostOk": bool(ghost_ok)})

    core_ring = ((cv2.dilate(core.astype(np.uint8), np.ones((31, 31), np.uint8))
                  & ~cv2.dilate(core.astype(np.uint8), np.ones((9, 9), np.uint8))) > 0)
    if int(core_ring.sum()) < 50:
        out.update({"verdict": "reject", "reason": "unmeasured: no core ring"})
        return out
    core_edge = edge_energy(cand_u8, core)
    ring_edge = edge_energy(cand_u8, core_ring)
    edge_ok = core_edge <= ring_edge * EDGE_RING_RATIO
    out.update({"coreEdge": core_edge, "coreRingEdge": ring_edge,
                "coreEdgeOk": bool(edge_ok)})

    tex_regions = core_texture(cand_u8, core)
    tex_ok = all(r["pass"] for r in tex_regions)
    out.update({"texRegions": tex_regions, "texOk": bool(tex_ok)})

    near = ((cv2.dilate(hole.astype(np.uint8),
                        np.ones((args.near_box, args.near_box), np.uint8)) > 0)
            & (witF >= strong_need))
    near_n = int(near.sum())
    out.update({"witnessTonePixels": near_n})
    if near_n < MIN_PIXELS:
        out.update({"verdict": "reject",
                    "reason": "unmeasured: no nearby witnessed tones"})
        return out
    tones = med_u8[near].reshape(-1, 3).astype(np.float64)
    lo = np.percentile(tones, 1, axis=0) - COLOR_DIST_SLACK
    hi = np.percentile(tones, 99, axis=0) + COLOR_DIST_SLACK
    out.update({"witnessToneP1": [round(float(v), 1) for v in
                                  np.percentile(tones, 1, axis=0)],
                "witnessToneP99": [round(float(v), 1) for v in
                                   np.percentile(tones, 99, axis=0)]})
    nlab, comp = cv2.connectedComponents(core.astype(np.uint8))
    color_regions = []
    for label in range(1, nlab):
        area = int((comp == label).sum())
        if area < MIN_REGION_FRAC * h * w:
            color_regions.append({"area": area, "pass": True,
                                  "note": "too small to judge"})
            continue
        mean_tone = cand[comp == label].reshape(-1, 3).mean(0)
        ok = bool(np.all(mean_tone >= lo) and np.all(mean_tone <= hi))
        color_regions.append({"area": area,
                              "meanTone": [round(float(v), 1) for v in mean_tone],
                              "pass": ok})
    color_ok = all(r["pass"] for r in color_regions)
    out.update({"colorRegions": color_regions, "colorOk": bool(color_ok)})

    verdict = "accept" if (erase_ok and shift_ok and sobel_ok and edge_geo_ok
                           and tone_ok and halo_ok and subj_ok and prop_ok and bg_ok
                           and ghost_ok and edge_ok and tex_ok and color_ok) \
        else "reject"
    out.update({"verdict": verdict})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--median", required=True)
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--claim", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--ids", default="1")
    ap.add_argument("--witness-min", type=int, default=WITNESS_MIN)
    ap.add_argument("--contam-limit", type=float, default=CONTAM_LIMIT)
    ap.add_argument("--strong-frac", type=float, default=STRONG_FRAC)
    ap.add_argument("--exclude-dilate", type=int, default=FID_EXCLUDE_DILATE)
    ap.add_argument("--grow", type=int, default=GROW)
    ap.add_argument("--margin", type=int, default=MARGIN)
    ap.add_argument("--near-box", type=int, default=NEAR_BOX)
    ap.add_argument("--shift-limit", type=float, default=SHIFT_LIMIT)
    ap.add_argument("--sobel-limit", type=float, default=SOBEL_LIMIT)
    ap.add_argument("--edge-f-limit", type=float, default=EDGE_F_LIMIT)
    ap.add_argument("--tone-resid-limit", type=float, default=TONE_RESID_LIMIT)
    ap.add_argument("--tone-slope-lo", type=float, default=TONE_SLOPE_LO)
    ap.add_argument("--tone-slope-hi", type=float, default=TONE_SLOPE_HI)
    ap.add_argument("--tone-intercept-limit", type=float, default=TONE_INTERCEPT_LIMIT)
    ap.add_argument("--halo-ncc-limit", type=float, default=HALO_NCC_LIMIT)
    ap.add_argument("--paper-ncc-limit", type=float, default=PAPER_NCC_LIMIT)
    ap.add_argument("--bg-corr-limit", type=float, default=BG_CORR_LIMIT)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    rep = run(args)
    text = json.dumps(rep)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
    print(text)


if __name__ == "__main__":
    sys.exit(main())
