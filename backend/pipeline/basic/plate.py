"""Clean background plate for the Basic pipeline.

Subcommands:
  classify  fixed (static camera -> median plate) or moving (Muse Image plate)
  median    temporal-median plate over background witnesses + inpainted holes
  inpaint   OpenCV Telea fallback: seed frame with the dilated subject removed
  validate  is a candidate plate the same scene? background-only mean/p95 diff

All thresholds are recorded in plate-meta.json / stdout JSON; see
backend/pipeline/basic/lib/normalize.mjs PLATE_LIMITS for the Node mirror.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

MEAN_DIFF_LIMIT = 6.0
P95_DIFF_LIMIT = 25.0
MEDIAN_BLOCK_PX = 65536  # pixels per median row block (memory bound, not output)


def load_gray(path, width=None):
    img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    if width and img.shape[1] != width:
        h = round(img.shape[0] * width / img.shape[1])
        img = cv2.resize(img, (width, h), interpolation=cv2.INTER_AREA)
    return img


PHOTO_SUFFIXES = (".jpg", ".jpeg", ".webp")  # labels are .png and live beside the frames


def frames_and_masks(frames_dir, labels_dir, width=320):
    frames = sorted(Path(frames_dir).glob("*.*"))
    frames = [f for f in frames if f.suffix.lower() in PHOTO_SUFFIXES]
    grays, masks = [], []
    for f in frames:
        g = load_gray(f, width)
        lab = Path(labels_dir) / f"{f.stem}.png"
        if lab.exists():
            m = cv2.imread(str(lab), cv2.IMREAD_GRAYSCALE)
            m = cv2.resize(m, (g.shape[1], g.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
        else:
            m = np.zeros_like(g, bool)
        grays.append(g)
        masks.append(m)
    return frames, grays, masks


def cmd_classify(args):
    # Camera motion from low spatial frequencies only: heavy blur removes grass
    # flutter, water ripple and compression noise, leaving the camera's motion.
    # Subject pixels are mean-filled, not zeroed, so masks add no edges. Pairs
    # whose correlation peak is weak are unreliable and skipped.
    frames, grays, masks = frames_and_masks(args.frames, args.labels, width=160)
    shifts = []
    for a, b, ma, mb in zip(grays[:-1], grays[1:], masks[:-1], masks[1:]):
        a = cv2.GaussianBlur(a, (21, 21), 0).astype(np.float32)
        b = cv2.GaussianBlur(b, (21, 21), 0).astype(np.float32)
        free = ~(ma | mb)
        free = cv2.erode(free.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
        if free.sum() < 500:
            continue
        a[~free] = a[free].mean()
        b[~free] = b[free].mean()
        (dx, dy), peak = cv2.phaseCorrelate(a, b)
        if peak < 0.05:
            continue
        shifts.append(float(np.hypot(dx, dy)))
    med = float(np.median(shifts)) if shifts else 0.0
    limit = 0.01 * 160  # ~1.6 px at 160 wide: tripod jitter stays fixed
    trip_shift = med > limit
    # Consecutive-step translation is also blind to an accumulated pan: the
    # walker clip steps < limit per pair while the framing rotates ~30 deg
    # over 12 s. Compare first vs last frame over their shared background.
    pan = 0.0
    try:
        if len(grays) >= 2:
            a0 = cv2.GaussianBlur(grays[0], (21, 21), 0).astype(np.float32)
            b0 = cv2.GaussianBlur(grays[-1], (21, 21), 0).astype(np.float32)
            free0 = ~(masks[0] | masks[-1])
            free0 = cv2.erode(free0.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
            if int(free0.sum()) > 500:
                a0[~free0] = a0[free0].mean()
                b0[~free0] = b0[free0].mean()
                (dx0, dy0), peak0 = cv2.phaseCorrelate(a0, b0)
                if peak0 >= 0.05:
                    pan = float(np.hypot(dx0, dy0))
    except cv2.error:
        pass
    trip_pan = pan > limit
    # Translation-only correlation is blind to a slow dolly/zoom: the walker
    # clip reads "fixed" while the median smears radially. Estimate the
    # global scale between the first and last frame (ECC affine on the
    # shared background). Measured: fixed cougar 0.992/cc 0.99, dolly
    # walker 0.926/cc 0.88 — so a >2.5% scale drift with a converged fit
    # (cc > 0.8) means the camera moved. Unconverged ECC keeps the
    # translation verdict.
    scale, ecc_cc = 1.0, 0.0
    try:
        if len(grays) >= 2:
            a, b = grays[0], grays[-1]
            shared = ~(masks[0] | masks[-1])
            shared = cv2.erode(shared.astype(np.uint8), np.ones((7, 7), np.uint8))
            if int(shared.sum()) > 2000:
                warp = np.eye(2, 3, dtype=np.float32)
                crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 1e-4)
                ecc_cc, warp = cv2.findTransformECC(a, b, warp, cv2.MOTION_AFFINE,
                                                     crit, shared, 5)
                det = float(warp[0, 0] * warp[1, 1] - warp[0, 1] * warp[1, 0])
                if det > 0:
                    scale = det ** 0.5
    except cv2.error:
        pass  # keep the translation verdict when ECC cannot converge
    trip_dolly = abs(scale - 1.0) > 0.025 and ecc_cc > 0.8
    # Granular kind for the HUD/error: pan (translation), dolly (scale),
    # shift (median drift, ambiguous). Thresholds unchanged.
    kind = "pan" if trip_pan else ("dolly" if trip_dolly else ("shift" if trip_shift else None))
    camera = "moving" if kind else "fixed"
    print(json.dumps({"camera": camera, "kind": kind, "medianShift": med, "limit": limit,
                      "pairs": len(shifts), "pan": round(pan, 3),
                      "scale": round(scale, 4),
                      "eccCc": round(float(ecc_cc), 4)}))
    (Path(args.out)).write_text(json.dumps({"camera": camera, "kind": kind,
                                            "medianShift": med, "pan": round(pan, 3),
                                            "scale": round(scale, 4),
                                            "eccCc": round(float(ecc_cc), 4)}))


def guided_filter(guide, src, r, eps):
    # Edge-preserving smooth: src follows guide's edges. guide/src float 0..1.
    # cv2.blur-only formulation (no ximgproc dependency), deterministic.
    g = guide.astype(np.float64)
    p = src.astype(np.float64)
    k = (r, r)
    mean_g = cv2.blur(g, k)
    mean_p = cv2.blur(p, k)
    var_g = cv2.blur(g * g, k) - mean_g * mean_g
    cov_gp = cv2.blur(g * p, k) - mean_g * mean_p
    a = cov_gp / (var_g + eps)
    b = mean_p - a * mean_g
    return (cv2.blur(a, k) * g + cv2.blur(b, k)).astype(np.float32)


def refine_one(mask_path, guide_path, track_id, w, h, out):
    # Refine one track's SAM mask against the full-resolution frame: guided
    # filter (guide = full-res luma) snaps the raster to real edges, then a
    # proper area downscale replaces the nearest-neighbour stair-steps.
    # Output is a binary working-res mask (maskStats/labels path unchanged).
    raw = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    if raw is None:
        raise SystemExit(f"cannot read {mask_path}")
    guide_img = cv2.imread(guide_path, cv2.IMREAD_GRAYSCALE)
    if guide_img is None:
        raise SystemExit(f"cannot read {guide_path}")
    if raw.shape != guide_img.shape:
        guide_img = cv2.resize(guide_img, (raw.shape[1], raw.shape[0]),
                               interpolation=cv2.INTER_AREA)
    fg = (raw == int(track_id)).astype(np.float32)
    if fg.sum() == 0:
        refined = np.zeros((h, w), np.uint8)
        max_q = 0.0
    else:
        guide = (guide_img.astype(np.float32) / 255.0)
        r = int(np.clip(round(min(raw.shape) / 18), 4, 12))
        q = guided_filter(guide, fg, r, 0.01)
        small = cv2.resize(q, (w, h), interpolation=cv2.INTER_AREA)
        # Adaptive threshold: smoothing dilutes a distant subject's peak
        # below any fixed cut (a trail-cam deer can be 0.1% of frame).
        # Threshold at half the mask's own peak, so the blob survives;
        # genuinely absent masks (peak 0) stay empty.
        max_q = float(small.max())
        # Output keeps the track-id convention (not 0/255): downstream
        # maskStats and the plate/label path count pixels == track id.
        refined = (small > min(0.5, 0.5 * max_q)).astype(np.uint8) * int(track_id)
    cv2.imwrite(out, refined)
    kept = float((refined > 0).mean())
    extra = {}
    if not kept > 0:
        # Diagnostic: what did the input raster actually contain?
        extra = {"rawUniq": sorted(map(int, np.unique(raw)))[:12],
                 "rawShape": [int(x) for x in raw.shape]}
    return {"kept": kept, "w": w, "h": h, "maxQ": round(max_q, 4), **extra}


def cmd_refine_mask(args):
    print(json.dumps(refine_one(args.mask, args.guide, args.id, args.w, args.h, args.out)))


def cmd_refine_masks(args):
    # Batch form of refine-mask: one process for every (keyframe, id) job,
    # instead of one Python + OpenCV start-up per job (~0.35 s each, 40+
    # per build). Same per-job maths and outputs; a failing job reports
    # {"error"} and the rest continue (per-job isolation as before).
    with open(args.jobs, encoding="utf8") as f:
        jobs = json.load(f)

    def one(j):
        try:
            return refine_one(j["mask"], j["guide"], j["id"], args.w, args.h, j["out"])
        except (SystemExit, Exception) as error:  # noqa: BLE001 - reported per job
            return {"error": str(error)[:200]}

    # Tier-improve loop 11: the jobs are independent and the full-resolution
    # guided filter (cv2.blur/numpy) releases the GIL, so a few threads run
    # them at once: 60 night-bear keyframes 4.5 s -> 1.8 s on 3 threads, the
    # same mask bytes, results in job order. At most 3 (each job holds about
    # 60 MB of float64 planes at 1280x720).
    workers = refine_workers()
    if workers > 1 and len(jobs) > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(one, jobs))
    else:
        results = [one(j) for j in jobs]
    print(json.dumps({"results": results}))


def refine_workers():
    """BASIC_THREADS wins; else half the usable CPUs (depth.py's count, which
    reads the container quota first), kept in 2..3."""
    env = os.environ.get("BASIC_THREADS")
    if env:
        return max(1, int(env))
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from depth import available_cpus
        n = available_cpus()
    except Exception:  # noqa: BLE001 - a count is best-effort
        n = os.cpu_count() or 2
    return max(2, min(3, n // 2))


REFINE_ALPHA_BAND = 2  # edge-band half-width in px (Lane A; Main inspection)
# Colour-gated boundary trim (Lane A greenrim v1): SAM masks overshoot 1-3 px
# into the background, leaving OPAQUE grass-coloured pixels that band
# decontamination cannot fix. A mask pixel within TRIM_DEPTH px of the edge
# is culled iff it is much closer (TRIM_MARGIN, uint8 BGR distance) to the
# local background ring than to the local interior, unlike the interior
# (> TRIM_MIN_FG) and like the background (< TRIM_MAX_BG; this absolute gate
# keeps thin structures such as the CG antenna). Per-pixel, never an erosion.
# Margins (lane GREENRIM.md): slovakdeer opaque-ring green excess 35.1 -> 14.3,
# clip-b/clip-a trim < 0.25% of the mask, antenna mass 0.917 (limit 0.90).
TRIM_DEPTH, TRIM_MARGIN, TRIM_MIN_FG, TRIM_MAX_BG = 2, 20, 25, 60


def _nearest_index(region):
    # (rows, cols) of the nearest `region` pixel for every pixel; cv2 labels,
    # no scipy (label values are looked up at the region pixels themselves).
    _, lab = cv2.distanceTransformWithLabels(
        (~region).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(region)
    lut = np.zeros((int(lab.max()) + 1, 2), np.int64)
    lut[lab[region]] = np.stack([ys, xs], 1)
    return lut[lab, 0], lut[lab, 1]


def _grey_footage(bgr):
    # Night-IR / grayscale test for the colour trim (whole frame).
    return bool((np.abs(bgr[:, :, 0].astype(np.int16) - bgr[:, :, 1]) > 8).mean() < 0.01)


def _colour_trim(bgr, mask, grey=None):
    # Returns (mask without background-coloured boundary pixels, count).
    # Grayscale footage (night IR) skips it: a colour test is vacuous there.
    # `grey` lets a windowed caller pass the full frame's verdict.
    if not mask.any() or (_grey_footage(bgr) if grey is None else grey):
        return mask, 0
    mu = mask.astype(np.uint8)
    ring = (cv2.dilate(mu, np.ones((11, 11), np.uint8))
            & ~cv2.dilate(mu, np.ones((5, 5), np.uint8))).astype(bool)
    kc = 2 * (REFINE_ALPHA_BAND + 1) + 1
    conf = cv2.erode(mu, np.ones((kc, kc), np.uint8)).astype(bool)
    cand = mask & (cv2.distanceTransform(mu, cv2.DIST_L2, 5) <= TRIM_DEPTH + 0.5)
    if not (ring.any() and conf.any() and cand.any()):
        return mask, 0
    px = bgr.astype(np.float32)
    fy, fx = _nearest_index(conf)
    by, bx = _nearest_index(ring)
    d_fg = np.linalg.norm(px - px[fy, fx], axis=-1)
    d_bg = np.linalg.norm(px - px[by, bx], axis=-1)
    trim = cand & (d_bg + TRIM_MARGIN < d_fg) & (d_fg > TRIM_MIN_FG) & (d_bg < TRIM_MAX_BG)
    return mask & ~trim, int(trim.sum())


def _refine_alpha_guide_filter(guide_rgb, base, radius, eps):
    # RGB ximgproc guided filter (Lane A: colour separates brown deer from
    # green grass where luma does not). Falls back to the blur-only
    # guided_filter() above on a luma guide when opencv-contrib is absent --
    # requirements.txt is not in this snapshot, so the fallback keeps the
    # subcommand working; the guide used is reported in stdout ("guide").
    xf = getattr(cv2, "ximgproc", None)
    if xf is not None and hasattr(xf, "guidedFilter"):
        return xf.guidedFilter(guide_rgb, base, radius, float(eps)), "rgb-ximgproc"
    luma = guide_rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    return guided_filter(luma, base, 2 * radius + 1, float(eps)), "luma-blur"


def _refine_alpha_frame(bgr, mask, radius, eps, grey=None):
    # bgr: HxWx3 uint8; mask: HxW bool (union of track ids). Returns
    # (bgra HxWx4 uint8 for cv2.imwrite, which stores it as RGBA on disk,
    # kept_frac, removed_px, guide_name). Mirrors alpha/refine_alpha.py with
    # two integration substitutions: no scipy (cv2 distance-transform labels
    # give the exact nearest-interior lookup) and temporal OFF (no prev frame in
    # batch mode; keyframes ~5 frames apart would ghost).
    mu = mask.astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mu, 8)
    removed = 0
    if n > 2:
        # Drop only specks (< 1% of the mask): a second selected object or
        # a limb split off by occlusion is a real component and must stay.
        tiny = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] < 0.01 * mask.sum()]
        drop = mask & np.isin(labels, tiny)
        removed = int(drop.sum())
        mask = mask & ~drop
        mu = mask.astype(np.uint8)
    mask, trimmed = _colour_trim(bgr, mask, grey)
    mu = mask.astype(np.uint8)
    b = REFINE_ALPHA_BAND
    k = np.ones((2 * b + 1, 2 * b + 1), np.uint8)
    band = (cv2.dilate(mu, k) & ~cv2.erode(mu, k)).astype(bool)
    base = mask.astype(np.float32)
    alpha = base.copy()
    guide_name = "none"
    if band.any():
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        q, guide_name = _refine_alpha_guide_filter(rgb, base, radius, eps)
        t = np.clip(q[band], 0.0, 1.0)
        alpha[band] = (t * t * (3.0 - 2.0 * t)).astype(np.float32)  # edge snap
    fg = bgr.copy()
    # Whole band, not just alpha < 0.98: the opaque outer ring of a SAM mask
    # still carries background spill (measured green excess ~20 on deer).
    fix = band
    if fix.any():
        kc = np.ones((2 * (b + 1) + 1, 2 * (b + 1) + 1), np.uint8)
        conf = cv2.erode(mu, kc).astype(bool)
        if not conf.any():
            conf = mask
        # Exact nearest confident-interior colour (no scipy): a wide blur
        # averaged blue, orange and seams into a grey rim on thin limbs.
        # The 3x3 median only quietens JPEG noise; conf sits b+1 px inside.
        _, lab = cv2.distanceTransformWithLabels(
            (~conf).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
        ys, xs = np.nonzero(conf)
        lut = np.zeros((int(lab.max()) + 1, 2), np.int64)
        lut[lab[conf]] = np.stack([ys, xs], 1)
        src = cv2.medianBlur(bgr, 3)
        fg[fix] = src[lut[lab[fix], 0], lut[lab[fix], 1]]
    a8 = np.round(np.clip(alpha, 0.0, 1.0) * 255).astype(np.uint8)
    bgra = np.dstack([fg, a8])
    bgra[a8 == 0] = 0  # run-basic convention: transparent pixels are 0
    return bgra, float(mask.mean()), removed, guide_name, trimmed


def _punch_occluders(bgr, bgra):
    # Advanced's occluder + speck pass on the Basic matte: grass/leaves in
    # front of the subject are punched (the plate shows through), floating
    # fragments under 1% of the mask dropped. Main-tested on slovakdeer (ear
    # and muzzle leaves gone, leg retention >= 0.93); clip-b/clip-a/roedeer
    # unchanged. Same merge as advanced_matte: only rim pixels the occluder
    # recoloured replace the decontaminated fg. Fail-soft: any error keeps
    # the refine output.
    try:
        adv = str(Path(__file__).resolve().parent / "advanced")
        if adv not in sys.path:
            sys.path.insert(0, adv)
        from occluder import remove_occluders
        from advanced_matte import drop_specks
        a2, fg2, rep = remove_occluders(bgr, bgra[:, :, 3].astype(np.float32) / 255.0, return_fg=True)
        a2, _ = drop_specks(a2)
        fg = np.where((fg2 != bgr).any(axis=2)[..., None], fg2, bgra[:, :, :3])
        a8 = np.round(np.clip(a2, 0.0, 1.0) * 255).astype(np.uint8)
        out = np.dstack([fg, a8])
        out[a8 == 0] = 0  # run-basic convention: transparent pixels are 0
        return out, int(rep.get("removed_px", 0))
    except Exception:  # noqa: BLE001 - fail-soft, refine output stands
        return bgra, 0


# Windowed refine (tier-improve 2026-11-04, loop 9): the refine and occluder
# steps only read pixels near the mask (furthest reach ~23 px: occluder ring
# 20 px past a band-grown matte; decontam window 15, colour-trim ring 5,
# guided-filter reach <= 4), and outside it the output is transparent zero.
# So each keyframe runs on its mask box plus this margin and is pasted back:
# bit-identical on 199 b8 keyframes, refine-alpha 21-43 s -> 8-25 s there
# (the frame-global grey test is still taken on the full frame). The edge
# pass stays full-frame: its contour sampling is not float-exact under a
# shift. BASIC_REFINE_WINDOW=0 restores the full-frame path.
REFINE_WINDOW_MARGIN = 40


def _refine_window(mask, margin=REFINE_WINDOW_MARGIN):
    # (y0, y1, x0, x1) of the mask box plus margin, clipped; None when empty.
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    h, w = mask.shape
    return (max(0, int(ys.min()) - margin), min(h, int(ys.max()) + 1 + margin),
            max(0, int(xs.min()) - margin), min(w, int(xs.max()) + 1 + margin))


def cmd_refine_alpha(args):
    # Batch Lane-A refinement over a keyframe dir (ONE call for all frames):
    # straight-alpha RGBA PNGs (decontaminated RGB + soft alpha) for the
    # selected path in run-basic.mjs. Temporal is OFF. Fail-closed: any
    # missing/mismatched input or write error aborts with SystemExit
    # (nonzero) -- never a silent binary fallback. An empty union mask
    # writes a transparent RGBA and is reported (downstream drop/keep logic
    # for that sample is unchanged).
    frames = sorted(Path(args.frames).glob("*.*"))
    frames = [f for f in frames if f.suffix.lower() in PHOTO_SUFFIXES]
    if not frames:
        raise SystemExit(f"refine-alpha: no keyframes in {args.frames}")
    ids = [int(x) for x in str(args.ids).split(",") if x.strip() != ""]
    if not ids:
        raise SystemExit("refine-alpha: --ids is empty")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    guides, files, empty, done = set(), [], [], []
    trimmed_total = occ_total = 0
    for f in frames:
        lab = Path(args.labels) / f"{f.stem}.png"
        if not lab.exists():
            raise SystemExit(f"refine-alpha: missing label {lab}")
        bgr = cv2.imread(str(f), cv2.IMREAD_COLOR)
        if bgr is None:
            raise SystemExit(f"refine-alpha: cannot read {f}")
        raw = cv2.imread(str(lab), cv2.IMREAD_UNCHANGED)
        if raw is None:
            raise SystemExit(f"refine-alpha: cannot read {lab}")
        if raw.ndim == 3:
            raw = raw[:, :, 0]  # palette-proof channel-0 read (see maskStats)
        if raw.shape[:2] != bgr.shape[:2]:
            raise SystemExit(
                f"refine-alpha: shape mismatch {lab} {raw.shape} vs {f} {bgr.shape[:2]}")
        mask = np.isin(raw, ids)
        win = _refine_window(mask) if os.environ.get("BASIC_REFINE_WINDOW", "1") != "0" else None
        if win is None:
            rgba, kept, removed, guide, trimmed = _refine_alpha_frame(
                bgr, mask, int(args.radius), float(args.eps))
            rgba, occ = _punch_occluders(bgr, rgba)
        else:
            # Same maths on the mask's box plus REFINE_WINDOW_MARGIN, pasted
            # back into a transparent frame (bit-identical, see the constant).
            y0, y1, x0, x1 = win
            crop = np.ascontiguousarray(bgr[y0:y1, x0:x1])
            part, kept, removed, guide, trimmed = _refine_alpha_frame(
                crop, mask[y0:y1, x0:x1], int(args.radius), float(args.eps),
                grey=_grey_footage(bgr))
            part, occ = _punch_occluders(crop, part)
            rgba = np.zeros(bgr.shape[:2] + (4,), np.uint8)
            rgba[y0:y1, x0:x1] = part
        trimmed_total += trimmed
        occ_total += occ
        guides.add(guide)
        done.append((f, bgr, rgba))
        if not kept > 0:
            empty.append(f.stem)
    # Edge-matched matte (Lane A tighten integration, frozen patch): one
    # clip-level source width measured at working resolution, then
    # match_edge per keyframe -- exactly one of tighten / defocus-v2 /
    # noop fires, so the two corrections stay mutually exclusive.
    # BASIC_EDGE_TIGHTEN=0 restores today's exact behaviour (defocus-v2
    # only, bit-identical). Fail-soft: any exception keeps the untightened
    # alpha and logs one line.
    width, edge = None, lambda bgr, rgba: rgba
    try:
        adv = str(Path(__file__).resolve().parent / "advanced")
        if adv not in sys.path:
            sys.path.insert(0, adv)
        from edge_defocus import clip_source_width, defocus_bgra
        width = clip_source_width([(b, r[:, :, 3] > 127) for _, b, r in done])
        defocus = lambda bgr, rgba: defocus_bgra(bgr, rgba, width)  # noqa: E731
        try:
            from edge_tighten import match_edge
        except Exception:  # noqa: BLE001
            match_edge = None
        if match_edge is None:
            edge = defocus
        else:
            def edge(bgr, rgba, _width=width):  # noqa: E731
                if os.environ.get("BASIC_EDGE_TIGHTEN", "1") == "0":
                    return defocus(bgr, rgba)
                if _width is None:
                    return rgba
                try:
                    a, fg = match_edge(
                        bgr,
                        rgba[:, :, 3].astype(np.float32) / 255.0,
                        np.ascontiguousarray(rgba[:, :, :3]),
                        source_width=_width)[:2]
                    a8 = np.round(np.clip(a, 0.0, 1.0) * 255).astype(np.uint8)
                    out = np.dstack([fg, a8])
                    out[a8 == 0] = 0  # product convention
                    return out
                except Exception as error:  # noqa: BLE001
                    print(f"refine-alpha: match_edge failed: {error}",
                          file=sys.stderr)
                    return rgba
    except Exception:  # noqa: BLE001
        pass
    for f, bgr, rgba in done:
        dest = out / f"rgba_{f.stem}.png"
        if not cv2.imwrite(str(dest), edge(bgr, rgba)):
            raise SystemExit(f"refine-alpha: cannot write {dest}")
        files.append(dest.name)
    print(json.dumps({"frames": len(files), "edgeSourceWidth": width,
                      "guide": sorted(guides)[0] if len(guides) == 1 else sorted(guides),
                      "out": str(args.out), "files": files, "empty": empty,
                      "colorTrimmedPx": trimmed_total, "occluderRemovedPx": occ_total}))


def cmd_median(args):
    frames, grays, masks = frames_and_masks(args.frames, args.labels, width=args.width)
    dil = int(args.dilate)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dil + 1, 2 * dil + 1))
    h, w = grays[0].shape
    # uint8 stack + row blocks (tier-improve 2026-11-04, loop 6): the float32
    # stack and full-frame argsort peaked at 1.5 GB on a 960x960 clip. The
    # per-pixel sort is independent of the blocking, so output is identical.
    color = np.stack([
        cv2.resize(cv2.imread(str(f), cv2.IMREAD_COLOR), (w, h),
                   interpolation=cv2.INTER_AREA)
        for f in frames
    ])  # N,H,W,3 uint8
    forbid = np.stack([cv2.dilate(m.astype(np.uint8), k).astype(bool) for m in masks])
    ok = ~forbid
    counts = ok.sum(0)
    mid = np.minimum(counts // 2, np.maximum(counts - 1, 0))
    plate = np.zeros((h, w, 3), np.float32)
    rows = max(1, MEDIAN_BLOCK_PX // max(w, 1))

    def block(y0):
        y1 = min(h, y0 + rows)
        okb = ok[:, y0:y1]
        for c in range(3):
            ch = color[:, y0:y1, :, c].astype(np.float32)
            order = np.argsort(np.where(okb, ch, np.inf), axis=0)
            ranked = np.take_along_axis(ch, order, axis=0)
            plate[y0:y1, :, c] = np.take_along_axis(ranked, mid[None, y0:y1], axis=0)[0]

    # Loop 11: blocks are disjoint and numpy's sort releases the GIL, so a
    # few run at once (night-bear 60 frames: 2.4 s -> 0.9 s, identical plate;
    # at most 3 blocks in memory, about 80 MB each).
    workers = refine_workers()
    if workers > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(block, range(0, h, rows)))
    else:
        for y0 in range(0, h, rows):
            block(y0)
    holes = counts < 3
    hole_share = float(holes.mean())
    if hole_share > 0:
        fill = cv2.inpaint(plate.astype(np.uint8), holes.astype(np.uint8) * 255,
                           4, cv2.INPAINT_TELEA)
        plate[holes] = fill[holes].astype(np.float32)
    cv2.imwrite(args.out, plate.astype(np.uint8))
    if args.holes:
        cv2.imwrite(args.holes, holes.astype(np.uint8) * 255)
    meta = {"method": "median", "witnessMin": 3, "holeShare": hole_share,
            "frames": len(frames), "dilate": dil}
    Path(args.meta).write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta))


def cmd_inpaint(args):
    img = cv2.imread(args.frame, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {args.frame}")
    m = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise SystemExit(f"cannot read {args.mask}")
    if (m.shape[1], m.shape[0]) != (img.shape[1], img.shape[0]):
        m = cv2.resize(m, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    dm = cv2.dilate((m > 0).astype(np.uint8), k) * 255
    cv2.imwrite(args.out, cv2.inpaint(img, dm, 5, cv2.INPAINT_TELEA))
    print(json.dumps({"method": "inpaint", "frame": args.frame}))


def cmd_validate(args):
    plate = load_gray(args.plate)
    seed = load_gray(args.seed, width=plate.shape[1])
    if seed.shape[0] != plate.shape[0]:
        seed = cv2.resize(seed, (plate.shape[1], plate.shape[0]))
    m = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
    m = cv2.resize(m, (plate.shape[1], plate.shape[0]),
                   interpolation=cv2.INTER_NEAREST) > 0
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (23, 23))
    bg = ~cv2.dilate(m.astype(np.uint8), k).astype(bool)
    if bg.sum() < 100:
        print(json.dumps({"pass": False, "reason": "no background pixels"}))
        return
    d = np.abs(plate.astype(np.float32) - seed.astype(np.float32))[bg]
    mean, p95 = float(d.mean()), float(np.percentile(d, 95))
    ok = mean <= MEAN_DIFF_LIMIT and p95 <= P95_DIFF_LIMIT
    print(json.dumps({"pass": ok, "mean": mean, "p95": p95,
                      "pixels": int(bg.sum())}))


TEX_RATIO_LIMIT = 0.35  # suspect texture must be >= 35% of its surrounding ring
COLOR_DIST_LIMIT = 25.0  # mean BGR distance suspect-vs-ring (0-441 scale)
# Share of the frame the fill may cover. Raised 0.30 -> 0.40 Oct 24: the cat
# clip's close-up subject needs 34% invented, and the region gates (texture
# + colour, verified visually: clean bokeh fill, no ghost, no structure)
# are the binding quality check — the share is only a prior against large
# inventions. Revisit with more clips if a large-but-clean fill ever ships
# something structurally wrong.
MAX_HOLE_SHARE = 0.40  # more invented area than this is never shippable
MIN_REGION_FRAC = 0.001  # smaller specks are not judged (pass, reported)
# Gradient-aware tone explanation (planar_tone_dist): a ring colour plane
# only explains a tone it predicts within half the colour limit. Measured:
# night-IR clean fills 0.9-9.7, synthetic foreign-tone room ghost 17.2,
# 50% dark-subject ghost 25.2.
PLANAR_DIST_LIMIT = 0.5 * COLOR_DIST_LIMIT


def ring_modes(plate, ring):
    # Two deterministic colour modes of a (possibly multi-modal) ring:
    # 2-means on strided ring pixels, seeded at the darkest/brightest luma
    # samples, 10 fixed iterations — no RNG, bit-stable across runs. A
    # correct fill abutting a material edge matches ONE adjacent mode even
    # when the ring-wide mean matches nothing (dark couch fill against a
    # ring that also holds bright wall). Returns two BGR float triples.
    px = plate[ring].reshape(-1, 3).astype(np.float64)[::7]
    if len(px) < 2:
        m = plate[ring].reshape(-1, 3).mean(0) if int(ring.sum()) else np.zeros(3)
        return np.array(m, float), np.array(m, float)
    luma = px @ np.array([0.114, 0.587, 0.299])
    c0, c1 = px[int(luma.argmin())].copy(), px[int(luma.argmax())].copy()
    for _ in range(10):
        d0 = ((px - c0) ** 2).sum(1)
        d1 = ((px - c1) ** 2).sum(1)
        side = d1 < d0
        if side.all() or not side.any():
            break
        c0, c1 = px[~side].mean(0), px[side].mean(0)
    return c0, c1


def _tone_terms(ys, xs, shape):
    # Smooth illumination basis: 1, x, y, x^2, y^2, xy (normalized coords).
    # Quadratic, not linear: IR flash fall-off and vignetting are radial
    # (night-bear clean fill: linear plane 17.5 vs quadratic 9.7).
    h, w = shape
    x, y = xs / w, ys / h
    return np.stack([np.ones(len(xs)), x, y, x * x, y * y, x * y], 1)


def planar_fit(img, ring):
    # Least-squares smooth colour surface per channel over the ring that
    # encloses the zone (strided). Deterministic; None if too few px.
    ys, xs = np.nonzero(ring)
    ys, xs = ys[::3], xs[::3]
    if len(xs) < 12:
        return None
    coef, *_ = np.linalg.lstsq(_tone_terms(ys, xs, ring.shape),
                               img[ys, xs].reshape(-1, 3).astype(np.float64), rcond=None)
    return coef


def planar_pred(coef, ys, xs, shape):
    return _tone_terms(ys, xs, shape) @ coef


def planar_tone_dist(img, ring, core):
    # Distance between the core's mean colour and the ring plane's predicted
    # mean over the same core pixels (BGR units, COLOR_DIST_LIMIT scale).
    coef = planar_fit(img, ring)
    if coef is None:
        return float("inf")
    ys, xs = np.nonzero(core)
    pred = planar_pred(coef, ys, xs, ring.shape).mean(0)
    return float(np.linalg.norm(img[ys, xs].reshape(-1, 3).astype(np.float64).mean(0) - pred))


def cmd_validate_holes(args):
    # Is the filled region real background, or a blurry ghost? A Telea/Muse
    # smear has far less high-frequency texture than the ground around it and
    # usually the wrong colour. Compares each suspect component against a
    # local ring of the plate itself, so no reference frame is needed.
    plate = cv2.imread(args.plate, cv2.IMREAD_COLOR)
    if plate is None:
        raise SystemExit(f"cannot read {args.plate}")
    h, w = plate.shape[:2]
    if args.holes:
        suspect = cv2.imread(args.holes, cv2.IMREAD_GRAYSCALE) > 0
    else:
        if not args.mask:
            raise SystemExit("validate-holes needs --holes or --mask")
        m = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
        if m is None:
            raise SystemExit(f"cannot read {args.mask}")
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                     (2 * args.grow + 1, 2 * args.grow + 1))
        suspect = cv2.dilate((m > 0).astype(np.uint8), k) > 0
    if suspect.shape != (h, w):
        suspect = cv2.resize(suspect.astype(np.uint8), (w, h),
                             interpolation=cv2.INTER_NEAREST) > 0
    gray = cv2.cvtColor(plate, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.abs(gx) + np.abs(gy)
    n, comp = cv2.connectedComponents(suspect.astype(np.uint8))
    regions = []
    for label in range(1, n):
        area = int((comp == label).sum())
        if area < MIN_REGION_FRAC * h * w:
            regions.append({"area": area, "pass": True, "note": "too small to judge"})
            continue
        blob = (comp == label)
        core = cv2.erode(blob.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        outer = cv2.dilate(blob.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
        inner = cv2.dilate(blob.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        ring = outer & ~inner
        if int(core.sum()) < 20 or int(ring.sum()) < 50:
            regions.append({"area": area, "pass": True, "note": "unmeasurable ring"})
            continue
        tex_ratio = float(grad[core].mean() / max(grad[ring].mean(), 1e-6))
        in_col = plate[core].reshape(-1, 3).mean(0)
        out_col = plate[ring].reshape(-1, 3).mean(0)
        color_dist = float(np.linalg.norm(in_col - out_col))
        # Statistic change (thresholds unchanged): colour is also judged
        # against the CLOSEST ring mode, not only the ring-wide mean. The
        # core mean of a hole spanning two materials matches nothing, so the
        # old distance false-fails correct fills; the median core pixel's
        # distance to its nearest ring mode is robust to that (same BGR
        # units, same COLOR_DIST_LIMIT scale). Either distance within the
        # limit passes; texture still has to pass.
        m0, m1 = ring_modes(plate, ring)
        core_px = plate[core].reshape(-1, 3).astype(np.float64)
        d_core = np.minimum(((core_px - m0) ** 2).sum(1),
                            ((core_px - m1) ** 2).sum(1)) ** 0.5
        color_local = float(np.median(d_core))
        # Gradient-aware tone (tier-improve 2026-11-04): on a lit gradient
        # (night IR fall-off, dark bush above bright grass) the ring-wide
        # mean and the ring modes are both the wrong reference, so a clean
        # fill false-fails (night-bear: flat 26.3, local 37, planar 9.7)
        # while a 30% dark subject ghost passes the flat mean (4.2).
        # The planar prediction of the ring colour field ranks them right
        # (clean 9.7 < ghost30 23.7 < ghost50 45). Third rescue statistic at
        # the tighter PLANAR_DIST_LIMIT, so every fill passing today still
        # passes and a plane only rescues fills it predicts closely.
        color_planar = planar_tone_dist(plate, ring, core)
        ok = tex_ratio >= TEX_RATIO_LIMIT and (color_dist <= COLOR_DIST_LIMIT
                                               or color_local <= COLOR_DIST_LIMIT
                                               or color_planar <= PLANAR_DIST_LIMIT)
        regions.append({"area": area, "texRatio": round(tex_ratio, 3),
                        "colorDist": round(color_dist, 2),
                        "colorDistLocal": round(color_local, 2),
                        "colorDistPlanar": round(color_planar, 2), "pass": ok})
    share = float(suspect.mean())
    ok = share <= MAX_HOLE_SHARE and all(r["pass"] for r in regions)
    print(json.dumps({"pass": ok, "holeShare": round(share, 4),
                      "regions": regions}))


def ring_stats(img, ring):
    # per-channel mean/std over a boolean ring mask (float64, stride 3)
    px = img[ring][::3].astype(np.float64)
    return px.mean(0), px.std(0) + 1e-6


def affine_match(fill, base, ring):
    # gain/offset per channel mapping fill's ring statistics onto base's:
    # fixes a generative fill's global grading shift without touching texture.
    fm, fs = ring_stats(fill, ring)
    bm, bs = ring_stats(base, ring)
    gain = np.clip(bs / fs, 0.5, 2.0)
    off = bm - fm * gain
    return np.clip(fill.astype(np.float64) * gain + off, 0, 255).astype(np.uint8)


def cmd_motion_claim(args):
    # Generic repair-claim expansion from cached masks + motion support:
    # union(holes, sweep) plus held-occluder pixels (a moving paper in the
    # hands is background in >=2 frames yet varies wildly frame to frame).
    # Candidate = outside the grown union, within --reach of it, seen as
    # background in >=2 frames (witness>=2, so static-person cores and pure
    # background are excluded), with luma variance far above the
    # always-background floor. Components below --min-frac are dropped, so
    # static texture (photos, grain) never joins. No geometry constants,
    # no filenames: everything derives from the frames + label rasters.
    frames = sorted(Path(args.frames).glob("*.*"))
    frames = [f for f in frames if f.suffix.lower() in PHOTO_SUFFIXES]
    if not frames:
        raise SystemExit("motion-claim: no frames")
    w0 = args.width
    grays, masks = [], []
    for f in frames:
        g = load_gray(f, w0)
        lab = Path(args.labels) / f"{f.stem}.png"
        if lab.exists():
            m = cv2.imread(str(lab), cv2.IMREAD_GRAYSCALE)
            m = cv2.resize(m, (g.shape[1], g.shape[0]),
                           interpolation=cv2.INTER_NEAREST) > 0
        else:
            m = np.zeros_like(g, bool)
        grays.append(g.astype(np.float32))
        masks.append(m)
    n = len(grays)
    dil = int(args.dilate)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dil + 1, 2 * dil + 1))
    forbid = np.stack([cv2.dilate(m.astype(np.uint8), k).astype(bool) for m in masks])
    witness = (~forbid).sum(0)
    stack = np.stack(grays)
    varmap = stack.var(0)
    bgvar = float(np.median(varmap[witness == n])) if int((witness == n).sum()) else 0.0
    base = np.zeros_like(masks[0])
    if args.union:
        u = cv2.imread(args.union, cv2.IMREAD_GRAYSCALE)
        if u is None:
            raise SystemExit(f"cannot read {args.union}")
        base = cv2.resize(u, (base.shape[1], base.shape[0]),
                          interpolation=cv2.INTER_NEAREST) > 0
    else:
        for m in masks:
            base |= m
    kg = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * args.grow + 1, 2 * args.grow + 1))
    grown = cv2.dilate(base.astype(np.uint8), kg) > 0
    kr = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * args.reach + 1, 2 * args.reach + 1))
    near = cv2.dilate(base.astype(np.uint8), kr) > 0
    cand = (~grown) & near & (witness >= 2) & (varmap > bgvar * args.var_k + args.var_floor)
    h, w = base.shape
    ncomp, comp = cv2.connectedComponents(cand.astype(np.uint8))
    keep = np.zeros_like(cand)
    for label in range(1, ncomp):
        if int((comp == label).sum()) >= args.min_frac * h * w:
            keep |= (comp == label)
    claim = base | keep
    cv2.imwrite(args.out, claim.astype(np.uint8) * 255)
    print(json.dumps({"basePx": int(base.sum()), "extPx": int(keep.sum()),
                      "claimPx": int(claim.sum()),
                      "share": round(float(claim.mean()), 4),
                      "bgVar": round(bgvar, 2), "frames": n}))


def cmd_composite(args):
    # Hybrid plate: trustworthy base (median) everywhere except the hole, where
    # the generative fill goes, with a feathered seam. Either input alone failed
    # a gate; together they can pass both. With --match the fill is first
    # colour-matched to the base over the hole's surrounding ring, so a Muse
    # re-render's global grading shift does not read as a seam.
    # Hybrid plate: trustworthy base (median) everywhere except the hole, where
    # the generative fill goes, with a feathered seam. Either input alone failed
    # a gate; together they can pass both.
    base = cv2.imread(args.base, cv2.IMREAD_COLOR)
    fill = cv2.imread(args.fill, cv2.IMREAD_COLOR)
    if base is None or fill is None:
        raise SystemExit("composite: unreadable input")
    if fill.shape[:2] != base.shape[:2]:
        fill = cv2.resize(fill, (base.shape[1], base.shape[0]),
                         interpolation=cv2.INTER_LINEAR)
    m = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise SystemExit(f"cannot read {args.mask}")
    if m.shape[:2] != base.shape[:2]:
        m = cv2.resize(m, (base.shape[1], base.shape[0]),
                       interpolation=cv2.INTER_NEAREST)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                 (2 * args.grow + 1, 2 * args.grow + 1))
    hole = cv2.dilate((m > 0).astype(np.uint8), k)
    if args.match:
        outer = cv2.dilate(hole, np.ones((31, 31), np.uint8))
        inner = cv2.dilate(hole, np.ones((9, 9), np.uint8))
        ring = (outer & ~inner).astype(bool)
        if int(ring.sum()) > 50:
            fill = affine_match(fill, base, ring)
    alpha = cv2.GaussianBlur(hole.astype(np.float32),
                             (0, 0), args.feather)[..., None]
    out = (base.astype(np.float32) * (1 - alpha)
           + fill.astype(np.float32) * alpha).astype(np.uint8)
    if args.exact_outside > 0:
        # Bit-exact provenance outside the claim: pixels beyond the grown
        # hole + margin are copied from the base untouched, so the shipped
        # plate provably changes nothing outside the validated mask (the
        # feather fringe lives inside the margin). Opt-in; default off so
        # existing accepted hybrids rebuild byte-identically.
        km = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                      (2 * args.exact_outside + 1,
                                       2 * args.exact_outside + 1))
        keep = cv2.dilate(hole, km) > 0
        out[~keep] = base[~keep]
    cv2.imwrite(args.out, out)
    print(json.dumps({"method": "composite", "holeShare": float(hole.mean())}))


def cmd_match(args):
    # Global affine colour match of a generative whole-frame render onto the
    # seed frame over background pixels (subject dilated away). Structure
    # already matches; this only removes the re-render's grading shift so the
    # scene gate can pass a plate the hole gate already accepts.
    src = cv2.imread(args.src, cv2.IMREAD_COLOR)
    ref = cv2.imread(args.ref, cv2.IMREAD_COLOR)
    if src is None or ref is None:
        raise SystemExit("match: unreadable input")
    if src.shape[:2] != ref.shape[:2]:
        src = cv2.resize(src, (ref.shape[1], ref.shape[0]),
                         interpolation=cv2.INTER_LINEAR)
    m = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise SystemExit(f"cannot read {args.mask}")
    if m.shape[:2] != ref.shape[:2]:
        m = cv2.resize(m, (ref.shape[1], ref.shape[0]),
                       interpolation=cv2.INTER_NEAREST)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (23, 23))
    bg = ~cv2.dilate((m > 0).astype(np.uint8), k).astype(bool)
    if int(bg.sum()) < 100:
        raise SystemExit("match: no background pixels")
    out = affine_match(src, ref, bg)
    cv2.imwrite(args.out, out)
    print(json.dumps({"method": "match"}))


# A ghost glows: it is SMOOTH. Dense real texture (river water, IR grass)
# also exceeds the bias cut and, over a wide zone, joins into one huge
# component whose box is long, so it scored as one giant "thin blob"
# (grizzly seed frame 0.85, night-bear clean Muse fill 0.65; median fine
# texture 6.8-8.9 vs real glows 0.0-2.2: Telea smear 0.41, median strips
# 1.6-2.2, synthetic snake 0.01). Pixels whose local fine texture
# (|gray - blur 1px|, 5x5 mean) reaches GLOW_TEXTURE_FLOOR, and at least
# GLOW_TEXTURE_RATIO of the zone ring's median, are texture and never seed
# a glow; a smooth strip lying on texture still forms its own component.
GLOW_TEXTURE_FLOOR = 3.0
GLOW_TEXTURE_RATIO = 0.75


def ghost_stats(img, zone):
    # Long-thin smooth-bias blobs: median residue (snakes, ghost strips)
    # glows against texture. Same params as the behind.py reporter, plus the
    # smoothness test above.
    fimg = img.astype(np.float32)
    smooth = cv2.GaussianBlur(fimg, (0, 0), 8.0)
    bias = np.abs(fimg - smooth).mean(axis=2)
    gray = fimg.mean(axis=2)
    fine = cv2.blur(np.abs(gray - cv2.GaussianBlur(gray, (0, 0), 1.0)), (5, 5))
    zu = zone.astype(np.uint8)
    ring = (cv2.dilate(zu, np.ones((31, 31), np.uint8)) & ~cv2.dilate(zu, np.ones((9, 9), np.uint8))) > 0
    texture_floor = max(GLOW_TEXTURE_FLOOR,
                        GLOW_TEXTURE_RATIO * (float(np.median(fine[ring])) if ring.any() else 0.0))
    candles = ((bias > 6) & zone & (fine < texture_floor)).astype(np.uint8)
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


RESIDUE_MIN_FRAC = 0.01  # a foreign tone below 1% of the zone is not judged
# The thin-blob rule above (aspect > 2.5) misses seated/standing residue:
# a static person's median/generative ghost is a broad foreign tone, not a
# snake. Rule: cluster the zone interior into two deterministic colour
# modes; a mode covering >=1% of the zone whose centre is farther than
# COLOR_DIST_LIMIT from EVERY surrounding-ring mode is paint that exists
# nowhere nearby. Guard against textured print (photos wholly inside the
# zone are foreign-toned yet real): the mode must ALSO be calmer than the
# ring — lower mean smooth-bias, i.e. less mid-frequency energy. Ghosts
# (blends or flat fills) attenuate texture; print does not. Purely
# relative, no new threshold. Same BGR units and 25.0 scale as the holes
# colour gate; the thin-blob numbers below are unchanged.


def residue_stats(img, zone, grad=None):
    # Foreign-tone residue: modes of the zone interior unexplained by the
    # surrounding ring (same ring geometry as the holes gate). Returns
    # (share, count, blobs); share is foreign weight over the zone.
    fimg = img.astype(np.float32)
    if grad is None:
        g = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8),
                         cv2.COLOR_BGR2GRAY).astype(np.float32)
        gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
        grad = np.abs(gx) + np.abs(gy)
    smooth = cv2.GaussianBlur(fimg, (0, 0), 8.0)
    bias = np.abs(fimg - smooth).mean(axis=2)
    core = cv2.erode(zone.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    ring = (cv2.dilate(zone.astype(np.uint8), np.ones((31, 31), np.uint8))
            & ~cv2.dilate(zone.astype(np.uint8), np.ones((9, 9), np.uint8))) > 0
    zsum = max(1, int(zone.sum()))
    blobs = []
    if int(core.sum()) < 20 or int(ring.sum()) < 50:
        return 0.0, 0, blobs
    m0, m1 = ring_modes(img, ring)
    ring_bias = float(bias[ring].mean())
    cpx = img[core].reshape(-1, 3).astype(np.float64)[::3]
    bpx = bias[core].reshape(-1)[::3]
    # Gradient-aware explanation (tier-improve 2026-11-04): a tone that the
    # ring's colour plane predicts at those pixels is lit background, not
    # foreign paint (night-IR fall-off: clean fill mode 47 from the ring
    # modes but 0.9 from the plane; a 50% subject ghost stays 25+ off it).
    coef = planar_fit(img, ring)
    cys, cxs = np.nonzero(core)
    cpred = (planar_pred(coef, cys[::3], cxs[::3], zone.shape) if coef is not None
             else None)
    luma = cpx @ np.array([0.114, 0.587, 0.299])
    a, b = cpx[int(luma.argmin())].copy(), cpx[int(luma.argmax())].copy()
    for _ in range(10):
        side = ((cpx - b) ** 2).sum(1) < ((cpx - a) ** 2).sum(1)
        if side.all() or not side.any():
            break
        a, b = cpx[~side].mean(0), cpx[side].mean(0)
    side = ((cpx - b) ** 2).sum(1) < ((cpx - a) ** 2).sum(1)
    for centre, sel in ((a, ~side), (b, side)):
        w = int(sel.sum()) * 3  # stride-3 sampling: scale back to pixels
        if w < RESIDUE_MIN_FRAC * zsum:
            continue
        dist = float(min(np.linalg.norm(centre - m0), np.linalg.norm(centre - m1)))
        calm = float(bpx[sel].mean() / max(ring_bias, 1e-6)) if int(sel.sum()) else 1.0
        pdist = (float(np.linalg.norm(centre - cpred[sel].mean(0)))
                 if cpred is not None and int(sel.sum()) else float("inf"))
        if dist > COLOR_DIST_LIMIT and pdist > PLANAR_DIST_LIMIT and calm < 1.0:
            blobs.append({"area": w, "colorDist": round(dist, 2),
                          "planarDist": round(pdist, 2),
                          "biasRatio": round(calm, 3)})
    share = sum(b["area"] for b in blobs) / zsum
    return round(share, 4), len(blobs), blobs


def edge_energy(img, zone):
    g = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    m = np.hypot(gx, gy)
    return round(float(m[zone].mean()) if int(zone.sum()) else 0.0, 3)


def cmd_ghost_map(args):
    # Scoped hybrid acceptance inputs: ghost + edge energy for the median
    # plate and a hybrid candidate inside the repaint zone (the claim mask
    # grown), plus the mean change OUTSIDE it. The caller applies the
    # ruling: outside at noise floor, ghost non-inferior, edges bounded.
    med = cv2.imread(args.median, cv2.IMREAD_COLOR)
    if med is None:
        raise SystemExit(f"cannot read {args.median}")
    med = med.astype(np.float32)
    m = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise SystemExit(f"cannot read {args.mask}")
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * args.grow + 1, 2 * args.grow + 1))
    zone = cv2.dilate((m > 0).astype(np.uint8), k) > 0
    h, w = med.shape[:2]
    if zone.shape != (h, w):
        zone = cv2.resize(zone.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
    zone[:2, :] = False
    zone[-2:, :] = False
    zone[:, :2] = False
    zone[:, -2:] = False
    zone[int(h * 0.92):, :] = False  # timestamp rows: legitimate overlay
    out = {}
    out["medianGhostShare"], out["medianGhostBlobs"] = ghost_stats(med, zone)
    out["medianResidueShare"], out["medianResidueBlobs"], out["medianResidue"] = residue_stats(med, zone)
    out["medianEdge"] = edge_energy(med, zone)
    if args.hybrid:
        hyb = cv2.imread(args.hybrid, cv2.IMREAD_COLOR)
        if hyb is None:
            raise SystemExit(f"cannot read {args.hybrid}")
        if hyb.shape[:2] != (h, w):
            hyb = cv2.resize(hyb, (w, h), interpolation=cv2.INTER_LINEAR)
        hyb = hyb.astype(np.float32)
        out["hybridGhostShare"], out["hybridGhostBlobs"] = ghost_stats(hyb, zone)
        out["hybridResidueShare"], out["hybridResidueBlobs"], out["hybridResidue"] = residue_stats(hyb, zone)
        outside = ~zone
        out["outsideDiff"] = round(float(np.abs(hyb - med).mean(axis=2)[outside].mean())
                                    if int(outside.sum()) else 0.0, 4)
        out["hybridEdge"] = edge_energy(hyb, zone)
    print(json.dumps(out))


# Soft fallback (tier-improve 2026-11-04, loop 6): when no clean plate passes
# QA (close-ups, still subjects, measured leftovers), ship a background that
# cannot show a ghost instead of refusing. Observed median pixels stay where
# enough clean frames witnessed them and agree; the UNSURE zone (holes, too
# few witnesses, or witnesses that disagree: an untracked mover or a mask
# miss) gets a field inpainted only from surrounding sure pixels (no subject
# content can enter), then a heavy blur so it reads as "not rebuilt" rather
# than as a fake clean scene. (Presence > 40% as the unsure rule blurred the
# clean early-clip background of a bobcat that arrives mid-clip.)
SOFT_WIT_SHARE = 0.15   # witnesses (clean frames) under this share of keyframes: unsure
SOFT_WIT_MIN = 6        # ...and never fewer than this many
SOFT_GROW = 0.02        # zone growth around unsure pixels (x width)
SOFT_SIGMA = 0.025      # blur inside the zone (x width)
SOFT_FEATHER = 0.015    # zone edge feather (x width)


SOFT_MOVER_DIFF = 25.0  # grey levels: a witness frame disagreeing with the median
SOFT_MOVER_SHARE = 0.2  # of witness frames: an untracked passer-by, not noise
SOFT_MOVER_MIN = 0.002  # smallest mover blob kept (frame share)


def mover_blobs(base, grays, masks, k5):
    """Untracked movers (a second animal) leave a half-present smear in the
    median outside the subject's footprint. Flag pixels where >= 20% of the
    witness frames disagree with the median, kept as sizeable blobs."""
    h, w = base.shape[:2]
    ref = cv2.GaussianBlur(cv2.cvtColor(np.clip(base, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY), (0, 0), 2).astype(np.float32)
    dis = np.zeros((h, w), np.float32)
    cnt = np.zeros((h, w), np.float32)
    for g, m in zip(grays, masks):
        ok = ~(cv2.dilate(m.astype(np.uint8), k5) > 0)
        gb = cv2.GaussianBlur(cv2.resize(g, (w, h), interpolation=cv2.INTER_AREA), (0, 0), 2).astype(np.float32)
        dis += (np.abs(gb - ref) > SOFT_MOVER_DIFF) & ok
        cnt += ok
    flag = ((dis / np.maximum(cnt, 1)) > SOFT_MOVER_SHARE).astype(np.uint8)
    flag = cv2.morphologyEx(flag, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(flag)
    keep = np.zeros((h, w), bool)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= SOFT_MOVER_MIN * h * w:
            keep |= lab == i
    return keep


def soften_plate(base, masks, holes, grays=None):
    """base HxWx3 float32 (median plate), masks list of HxW bool (subject
    footprints per keyframe), holes HxW bool, grays optional list of the
    keyframes' grey images (untracked-mover check). Returns (plate, zone,
    report)."""
    h, w = base.shape[:2]
    k5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))  # median dilate parity
    occ = np.zeros((h, w), np.float32)
    for m in masks:
        occ += cv2.dilate(m.astype(np.uint8), k5)
    occ /= max(len(masks), 1)
    movers = mover_blobs(base, grays, masks, k5) if grays else np.zeros((h, w), bool)
    wit = (1.0 - occ) * len(masks)
    few = wit < max(SOFT_WIT_MIN, SOFT_WIT_SHARE * len(masks))
    unsure = cv2.dilate((holes | few | movers).astype(np.uint8), k5) > 0
    grow = max(5, round(SOFT_GROW * w))
    kz = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1))
    zone = cv2.dilate(unsure.astype(np.uint8), kz) > 0
    report = {"method": "soft", "witnessMin": max(SOFT_WIT_MIN, round(SOFT_WIT_SHARE * len(masks), 1)), "unsureShare": round(float(unsure.mean()), 4),
              "moverShare": round(float(movers.mean()), 4),
              "softShare": round(float(zone.mean()), 4), "holeShare": round(float(holes.mean()), 4)}
    if not zone.any():
        return base.copy(), zone, report
    s = 4  # quarter-res field: Telea cost grows with the hole area
    sw, sh = max(1, w // s), max(1, h // s)
    small = cv2.resize(np.clip(base, 0, 255).astype(np.uint8), (sw, sh), interpolation=cv2.INTER_AREA)
    um = cv2.resize(unsure.astype(np.uint8) * 255, (sw, sh), interpolation=cv2.INTER_NEAREST)
    um = cv2.dilate(um, np.ones((3, 3), np.uint8))
    if um.all():
        fill = np.full_like(small, np.median(small.reshape(-1, 3), axis=0).astype(np.uint8))
    else:
        fill = cv2.inpaint(small, um, 6, cv2.INPAINT_TELEA)
    fill = cv2.resize(fill, (w, h), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    field = base.copy()
    field[unsure] = fill[unsure]
    soft = cv2.GaussianBlur(field, (0, 0), SOFT_SIGMA * w)
    alpha = np.clip(cv2.GaussianBlur(zone.astype(np.float32), (0, 0), SOFT_FEATHER * w) * 2.0, 0, 1)
    alpha = np.maximum(alpha, unsure.astype(np.float32))[..., None]  # unsure pixels: fully soft
    return base * (1 - alpha) + soft * alpha, zone, report


def cmd_soften(args):
    base = cv2.imread(args.base, cv2.IMREAD_COLOR)
    if base is None:
        raise SystemExit(f"cannot read {args.base}")
    h, w = base.shape[:2]
    frames, grays, masks = frames_and_masks(args.frames, args.labels, width=w)
    masks = [cv2.resize(m.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0 for m in masks]
    holes = np.zeros((h, w), bool)
    if args.holes and Path(args.holes).exists():
        hm = cv2.imread(args.holes, cv2.IMREAD_GRAYSCALE)
        holes = cv2.resize(hm, (w, h), interpolation=cv2.INTER_NEAREST) > 0
    plate, zone, report = soften_plate(base.astype(np.float32), masks, holes, grays)
    cv2.imwrite(args.out, np.clip(plate, 0, 255).astype(np.uint8))
    if args.zone_out:
        cv2.imwrite(args.zone_out, zone.astype(np.uint8) * 255)
    report["frames"] = len(frames)
    print(json.dumps(report))


def cmd_soften_depth(args):
    # The blurred zone reads as a near blob to the depth model (a bump where
    # the subject stood). Replace plate depth there with a smooth quadratic
    # surface fitted to the ring of background depth around the zone (Telea
    # streaked a near cone up from the floor; a surface cannot bulge).
    d = np.load(args.depth).astype(np.float32)
    h, w = d.shape[:2]
    zm = cv2.imread(args.zone, cv2.IMREAD_GRAYSCALE)
    if zm is None:
        raise SystemExit(f"cannot read {args.zone}")
    zone = cv2.resize(zm, (w, h), interpolation=cv2.INTER_NEAREST) > 0
    share = float(zone.mean())
    fitted = False
    if zone.any() and not zone.all():
        r = max(5, round(SOFT_GROW * w))
        ring = (cv2.dilate(zone.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0) & ~zone
        ys, xs = np.nonzero(ring)
        ys, xs = ys[::3], xs[::3]
        if len(xs) >= 12:
            terms = _tone_terms(ys, xs, (h, w))
            vals = d[ys, xs].astype(np.float64)
            coef, *_ = np.linalg.lstsq(terms, vals, rcond=None)
            res = np.abs(terms @ coef - vals)  # one robust pass: drop far outliers
            keep = res <= 2.5 * max(np.median(res), 1e-6)
            if keep.sum() >= 12:
                coef, *_ = np.linalg.lstsq(terms[keep], vals[keep], rcond=None)
            zy, zx = np.mgrid[0:h, 0:w]
            surf = (_tone_terms(zy.ravel(), zx.ravel(), (h, w)) @ coef).reshape(h, w).astype(np.float32)
            alpha = np.maximum(np.clip(cv2.GaussianBlur(zone.astype(np.float32), (0, 0), SOFT_FEATHER * w) * 2.0, 0, 1), zone)
            d = d * (1 - alpha) + surf * alpha
            fitted = True
    np.save(args.depth, d.astype(np.float32))
    print(json.dumps({"softDepthShare": round(share, 4), "fitted": fitted}))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(required=True)
    a = sub.add_parser("classify")
    a.add_argument("--frames", required=True)
    a.add_argument("--labels", required=True)
    a.add_argument("--out", required=True)
    a.set_defaults(fn=cmd_classify)
    ar = sub.add_parser("refine-mask")
    ar.add_argument("--mask", required=True)  # full-res label raster (all tracks)
    ar.add_argument("--guide", required=True)  # full-res frame (luma guide)
    ar.add_argument("--id", required=True)  # track id to refine
    ar.add_argument("--w", type=int, required=True)  # working width
    ar.add_argument("--h", type=int, required=True)  # working height
    ar.add_argument("--out", required=True)  # working-res binary mask
    ar.set_defaults(fn=cmd_refine_mask)
    arb = sub.add_parser("refine-masks")
    arb.add_argument("--jobs", required=True)  # JSON [{mask, guide, id, out}]
    arb.add_argument("--w", type=int, required=True)
    arb.add_argument("--h", type=int, required=True)
    arb.set_defaults(fn=cmd_refine_masks)
    ra = sub.add_parser("refine-alpha")
    ra.add_argument("--frames", required=True)  # keyframe jpgs (photo suffixes only)
    ra.add_argument("--labels", required=True)  # id-valued label rasters beside them
    ra.add_argument("--ids", required=True)  # comma-separated union track ids
    ra.add_argument("--out", required=True)  # straight-alpha RGBA PNGs (rgba_<stem>.png)
    ra.add_argument("--radius", type=int, default=1)  # guided-filter window radius
    ra.add_argument("--eps", type=float, default=1e-3)
    ra.set_defaults(fn=cmd_refine_alpha)
    b = sub.add_parser("median")
    b.add_argument("--frames", required=True)
    b.add_argument("--labels", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--meta", required=True)
    b.add_argument("--width", type=int, default=640)
    b.add_argument("--dilate", type=int, default=5)
    b.add_argument("--holes", default=None)  # optional PNG: pixels with <witnessMin witnesses
    b.set_defaults(fn=cmd_median)
    c = sub.add_parser("inpaint")
    c.add_argument("--frame", required=True)
    c.add_argument("--mask", required=True)
    c.add_argument("--out", required=True)
    c.set_defaults(fn=cmd_inpaint)
    d = sub.add_parser("validate")
    d.add_argument("--plate", required=True)
    d.add_argument("--seed", required=True)
    d.add_argument("--mask", required=True)
    d.set_defaults(fn=cmd_validate)
    e = sub.add_parser("validate-holes")
    e.add_argument("--plate", required=True)
    e.add_argument("--holes", default=None)  # suspect-region mask (median holes map)
    e.add_argument("--mask", default=None)  # or: subject mask, grown by --grow
    e.add_argument("--grow", type=int, default=11)
    e.set_defaults(fn=cmd_validate_holes)
    f = sub.add_parser("composite")
    f.add_argument("--base", required=True)
    f.add_argument("--fill", required=True)
    f.add_argument("--mask", required=True)  # subject mask (label raster ok)
    f.add_argument("--grow", type=int, default=11)
    f.add_argument("--feather", type=float, default=2.0)
    f.add_argument("--match", action="store_true")
    f.add_argument("--exact-outside", type=int, default=0)  # px margin: base bit-exact beyond hole+margin
    f.add_argument("--out", required=True)
    f.set_defaults(fn=cmd_composite)
    g = sub.add_parser("match")
    g.add_argument("--src", required=True)  # generative render to correct
    g.add_argument("--ref", required=True)  # seed frame: colour reference
    g.add_argument("--mask", required=True)  # subject mask (bg = reference)
    g.add_argument("--out", required=True)
    g.set_defaults(fn=cmd_match)
    gm = sub.add_parser("ghost-map")
    gm.add_argument("--median", required=True)  # median plate (base)
    gm.add_argument("--hybrid", default=None)  # hybrid candidate (optional)
    gm.add_argument("--mask", required=True)  # claim mask (sweep union / holes)
    gm.add_argument("--grow", type=int, default=11)
    gm.set_defaults(fn=cmd_ghost_map)
    mc = sub.add_parser("motion-claim")
    mc.add_argument("--frames", required=True)  # keyframe jpgs (photo suffixes only)
    mc.add_argument("--labels", required=True)  # working-res label rasters beside them
    mc.add_argument("--union", default=None)  # optional holes|sweep union PNG (else OR of labels)
    mc.add_argument("--out", required=True)  # claim PNG (union + held-occluder extension)
    mc.add_argument("--width", type=int, default=640)
    mc.add_argument("--dilate", type=int, default=5)  # witness mask growth (median parity)
    mc.add_argument("--grow", type=int, default=11)  # base-union growth (claim parity)
    mc.add_argument("--reach", type=int, default=25)  # extension search radius around union
    mc.add_argument("--var-k", type=float, default=4.0)  # variance multiple over bg floor
    mc.add_argument("--var-floor", type=float, default=100.0)  # absolute luma-variance floor
    mc.add_argument("--min-frac", type=float, default=0.001)  # smallest kept component (frame share)
    mc.set_defaults(fn=cmd_motion_claim)
    so = sub.add_parser("soften")  # loop-6 soft fallback plate (see soften_plate)
    so.add_argument("--base", required=True)  # median plate
    so.add_argument("--frames", required=True)  # keyframe jpgs
    so.add_argument("--labels", required=True)  # label rasters beside them
    so.add_argument("--holes", default=None)  # median holes map
    so.add_argument("--out", required=True)
    so.add_argument("--zone-out", default=None)  # softened zone PNG
    so.set_defaults(fn=cmd_soften)
    sd = sub.add_parser("soften-depth")  # plate depth under the soft zone
    sd.add_argument("--depth", required=True)  # depth_plate.npy (rewritten in place)
    sd.add_argument("--zone", required=True)  # soft-zone.png from soften
    sd.set_defaults(fn=cmd_soften_depth)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
