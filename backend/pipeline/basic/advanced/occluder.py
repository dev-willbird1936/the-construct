"""Lane A -- foreground-occluder (grass) removal inside the subject matte.

Pure function module plus a small CLI. No network, no models, no GPU.

Problem (Main inspected ``main/advanced-natural-qa-v1/slovakdeer-sheet.png``):
on natural deer clips, grass blades/leaves crossing IN FRONT of the deer
stay inside both the SAM mask and the BiRefNet-combined matte, reading as
green scribbles on legs/muzzle/chest that move with the deer at orbit.
Punching those pixels to alpha 0 is visually safe: the background plate is
grass at that location, so at rest the composite still shows grass in front
of the deer, and at orbit it reads as background grass.

Method (see OCCLUDER.md for thresholds and why):
  1. Subject colour model: k-means palette (K_SUB centres) in Lab over
     confident interior pixels (alpha >= 0.98, eroded 4 px).
     Occluder/background model: k-means palette (K_BG centres) over a ring
     RING_IN-RING_OUT px outside the mask.
  2. Candidate = inside mask, alpha >= OPAQUE_MIN (the soft rim is never
     touched), and much closer to background than subject:
     (d_sub - d_bg) > MARGIN with d_sub > DSUB_MIN and d_bg < DBG_MAX.
  3. Shape gate per 8-connected candidate component: punch only components
     with area >= MIN_AREA that touch the mask boundary (within TOUCH_PX)
     or are thin (inscribed radius <= THIN_RADIUS) AND elongated
     (min-area-rect aspect >= ELONG_MIN). The elongation half is what
     separates grass blades from compact subject patches that happen to
     share the background's neutral grey (cg-robot light metal): round
     interior blobs (eyes, nose) are never punched.
  4. Punch kept pixels to 0, then guided-filter (RGB guide) the punched
     alpha and take the filtered values ONLY in a narrow rim around the
     holes; hole interiors stay 0, the rest of the matte is untouched.
  5. Never erodes the matte globally. Reports removed alpha mass per frame.

Colour note: BGR order is kept throughout (as loaded by cv2).
"""

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # `python -I` strips cwd from sys.path

import cv2
import numpy as np

K_SUB = 6  # subject shades (robot multi-material grey needs the coverage)
K_BG = 3
MARGIN = 14.0      # required (d_sub - d_bg) gap, Lab units
DSUB_MIN = 10.0    # candidate must be at least this far from subject model
DBG_MAX = 30.0     # ... and at most this far from the background model
MIN_AREA = 12      # punched components must have at least this many px
THIN_RADIUS = 3.5  # ... and be this thin (inscribed radius, px) ...
ELONG_MIN = 2.5    # ... and this elongated (min-area-rect aspect) ...
# Calibrated: compact cg grey patch measures 2.0 (dropped) vs the only
# measured interior blade fragment at 2.57 (kept); boundary-touching
# tufts are exempt from this test regardless.
TOUCH_PX = 3       # ... or touch the mask boundary within this distance
OPAQUE_MIN = 0.9   # candidacy needs alpha >= this (soft rim never touched)
RING_IN = 6        # background ring starts this far outside the mask
RING_OUT = 20      # ... and ends here
GUIDE_RADIUS = 2   # guided-filter window radius for hole-rim softening
GUIDE_EPS = 1e-3
RIM_PX = 2         # rim width (px) around holes where filtering applies
KMEANS_SAMPLE = 6000
SUB_EXCLUDE_MAX = 0.15  # max interior share dropped from the subject palette as background-like


def _require_ximgproc():
    """Return cv2.ximgproc, or fail closed (no silent blur fallback)."""
    xf = getattr(cv2, "ximgproc", None)
    if xf is None or not hasattr(xf, "guidedFilter"):
        raise RuntimeError(
            "occluder needs cv2.ximgproc.guidedFilter "
            "(opencv-contrib); refusing to run without it")
    return xf


def _to_lab(bgr_uint8):
    """BGR uint8 frame -> Lab float32 (L 0-100, a/b approx -127..127)."""
    return cv2.cvtColor(bgr_uint8.astype(np.float32) / 255.0,
                        cv2.COLOR_BGR2Lab)


def _palette(lab_pixels, k):
    """k-means palette (k x 3 float32) of Lab samples.

    Small deterministic numpy k-means++ (fixed seed): avoids cv2 RNG
    seeding differences across builds and keeps results bit-stable.
    """
    data = np.asarray(lab_pixels, dtype=np.float64).reshape(-1, 3)
    n = len(data)
    if n == 0:
        raise ValueError("occluder: empty sample for palette")
    if n <= k:
        reps = np.tile(data.mean(axis=0, keepdims=True), (k, 1))
        return reps.astype(np.float32)
    step = max(1, n // KMEANS_SAMPLE)
    sample = data[::step]
    rng = np.random.default_rng(0)
    first = rng.integers(len(sample))
    centers = [sample[first]]
    d2 = np.full(len(sample), np.inf)
    for _ in range(1, k):
        d = ((sample - centers[-1]) ** 2).sum(axis=1)
        np.minimum(d2, d, out=d2)
        total = d2.sum()
        if total <= 0:
            centers.append(sample[rng.integers(len(sample))])
        else:
            centers.append(sample[rng.choice(len(sample),
                                             p=d2 / total)])
    centers = np.array(centers)
    for _ in range(25):
        d = ((sample[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
        lab_idx = d.argmin(axis=1)
        new = centers.copy()
        for c in range(k):
            pts = sample[lab_idx == c]
            if len(pts):
                new[c] = pts.mean(axis=0)
        if np.allclose(new, centers, atol=1e-6):
            centers = new
            break
        centers = new
    return centers.astype(np.float32)


def _nearest_dist(lab_image, centers):
    """Per-pixel distance to the nearest palette centre."""
    pix = np.asarray(lab_image, dtype=np.float32).reshape(-1, 3)
    d = np.sqrt(((pix[:, None, :] - centers[None, :, :]) ** 2).sum(-1))
    return d.min(axis=1).reshape(lab_image.shape[:2])


def _mask_regions(alpha):
    """Mask (alpha > 0.5), confident interior, background ring."""
    mask = alpha > 0.5
    conf = cv2.erode((alpha >= 0.98).astype(np.uint8),
                     np.ones((9, 9), np.uint8)).astype(bool)
    if not conf.any():
        conf = mask  # tiny/thin mask: fall back to the mask itself
    mu = mask.astype(np.uint8)
    outer = cv2.dilate(mu, np.ones((2 * RING_OUT + 1, 2 * RING_OUT + 1),
                                   np.uint8)).astype(bool)
    inner = cv2.dilate(mu, np.ones((2 * RING_IN + 1, 2 * RING_IN + 1),
                                   np.uint8)).astype(bool)
    ring = outer & ~inner
    return mask, conf, ring


def _shape_gate(candidates, mask, *, min_area=MIN_AREA,
                thin_radius=THIN_RADIUS, elong_min=ELONG_MIN,
                touch_px=TOUCH_PX):
    """Keep candidate components that are sizable AND thin/boundary-touching.

    Returns the punched-pixel mask. Drops specks (area < min_area) and
    round interior blobs (thick, not touching the boundary): eyes/noses.
    Interior components must be BOTH thin and elongated (grass blades);
    thin-but-compact interior patches (cg light-grey metal sharing the
    floor's neutral grey) are dropped. Boundary-touching components are
    exempt (grass tufts at the muzzle/silhouette edge).
    """
    n, labels, stats, _ = cv2.connectedComponentsWithStats(
        candidates.astype(np.uint8), 8)
    if n <= 1:
        return np.zeros_like(candidates)
    exterior = ~mask
    touch_kernel = np.ones((2 * touch_px + 1, 2 * touch_px + 1), np.uint8)
    dt = cv2.distanceTransform(candidates.astype(np.uint8),
                               cv2.DIST_L2, 5)
    keep_ids = []
    for cid in range(1, n):
        area = int(stats[cid, cv2.CC_STAT_AREA])
        if area < min_area:
            continue  # speck: neither a blade nor a tuft
        comp = (labels == cid)
        touches = bool((cv2.dilate(comp.astype(np.uint8),
                                    touch_kernel).astype(bool)
                         & exterior).any())
        if touches:
            keep_ids.append(cid)  # silhouette-edge tuft / crossing blade
            continue
        if float(dt[comp].max()) > thin_radius:
            continue  # thick interior blob: eye, nose, anatomy
        (_cx, _cy), (w, h), _ang = cv2.minAreaRect(
            np.column_stack(np.where(comp)[::-1]).astype(np.float32))
        if max(w, h) / max(1.0, min(w, h)) < elong_min:
            continue  # thin but compact: subject patch in bg colours
        keep_ids.append(cid)
    if not keep_ids:
        return np.zeros_like(candidates)
    return np.isin(labels, keep_ids) & candidates


def _rim_around(holes, px=RIM_PX):
    """2-D bool rim: dilated holes minus holes (v2 fg fix uses the same)."""
    return ((cv2.dilate(holes.astype(np.uint8),
                         np.ones((2 * px + 1, 2 * px + 1),
                                 np.uint8)).astype(bool)) & ~holes)


def _decontaminate_rim(rgb, holes, rim, donor):
    """Recolour each hole's rim with local clean-subject colour (BGR copy).

    Per 8-connected hole component: take clean donor pixels within a
    31x31 neighbourhood of the component and fill the component's rim
    (dilated-by-2 overlap) with their median BGR. The median averages out
    green spill that tints the nearest fur pixels; the window keeps the
    shade local (sunlit ear vs shadowed leg use different fills). Falls
    back to the global donor/conf median when a neighbourhood is empty.
    Pixels outside ``rim`` are never touched.
    """
    fg = np.asarray(rgb).copy()
    if not rim.any() or not donor.any():
        return fg
    rgb_arr = np.asarray(rgb)
    n, labels = cv2.connectedComponents(holes.astype(np.uint8))
    k31 = np.ones((31, 31), np.uint8)
    k5 = np.ones((2 * RIM_PX + 1, 2 * RIM_PX + 1), np.uint8)
    if donor.any():
        global_med = np.median(rgb_arr[donor].reshape(-1, 3).astype(
            np.float64), axis=0)
    else:
        global_med = None
    for cid in range(1, n):
        comp = (labels == cid)
        neigh = cv2.dilate(comp.astype(np.uint8), k31).astype(bool) & donor
        if neigh.any():
            med = np.median(rgb_arr[neigh].reshape(-1, 3).astype(
                np.float64), axis=0)
        elif global_med is not None:
            med = global_med
        else:
            continue
        rc = cv2.dilate(comp.astype(np.uint8), k5).astype(bool) & rim
        fg[rc] = np.round(med).astype(np.uint8)
    return fg


def _soften_holes(alpha_punched, holes, rgb):
    """Guided-filter the punched alpha, applied only in a rim around holes."""
    rim = _rim_around(holes)
    if not rim.any():
        return alpha_punched
    guide = rgb.astype(np.float32) / 255.0
    q = _require_ximgproc().guidedFilter(guide, alpha_punched,
                                         GUIDE_RADIUS, float(GUIDE_EPS))
    out = alpha_punched.copy()
    out[rim] = np.clip(q[rim], 0.0, 1.0)
    return out.astype(np.float32)


def _leg_region(mask):
    """Lower 35% of the mask bbox (rows); empty mask -> all-False."""
    ys = np.where(mask)[0]
    if len(ys) == 0:
        return np.zeros_like(mask)
    y0, y1 = int(ys.min()), int(ys.max())
    cut = y0 + 0.65 * (y1 - y0)
    return (np.arange(mask.shape[0])[:, None] >= cut) & mask


def remove_occluders(rgb_uint8_HxWx3, alpha_float32_HxW, *,
                     margin=MARGIN, dsub_min=DSUB_MIN, dbg_max=DBG_MAX,
                     k_sub=K_SUB, k_bg=K_BG, min_area=MIN_AREA,
                     thin_radius=THIN_RADIUS, elong_min=ELONG_MIN,
                     touch_px=TOUCH_PX, opaque_min=OPAQUE_MIN,
                     return_fg=False):
    """Punch background-coloured occluders out of a subject matte.

    Args:
        rgb_uint8_HxWx3: HxWx3 uint8 frame (BGR as loaded by cv2).
        alpha_float32_HxW: HxW matte in [0, 1] (or 0-255; resized
            bilinearly if it differs in size from rgb, never nearest).
        margin/dsub_min/dbg_max/...: gates documented in OCCLUDER.md.
        return_fg: when False (default) return (alpha_out, report) exactly
            as v1. When True return (alpha_out, fg_out_BGR, report) where
            fg_out is rgb with the hole rim recoloured from the nearest
            subject-coloured interior donor (bit-identical outside rim).

    Returns:
        (alpha_out_float32_HxW in [0, 1], report dict) -- or with fg when
        requested. Report keys: removed_mass/removed_px/mask_px/
        removed_frac (of mask), leg_before/leg_after (alpha mass in lower
        35% of mask bbox), candidate_px/kept_px/n_components,
        fg_fixed_px (rim px recoloured; 0 unless return_fg), note.
    """
    rgb = np.asarray(rgb_uint8_HxWx3)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must be HxWx3 uint8")
    h, w = rgb.shape[:2]
    a = np.asarray(alpha_float32_HxW, dtype=np.float32)
    if a.ndim == 3:
        a = a[:, :, 0] if a.shape[2] != 4 else a[:, :, 3] / 1.0
        if a.max() > 1.0:
            a = a / 255.0
    elif a.max() > 1.0:
        a = a / 255.0
    if a.shape != (h, w):
        a = cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
    alpha = np.clip(a, 0.0, 1.0).astype(np.float32)

    mask, conf, ring = _mask_regions(alpha)
    mask_px = int(mask.sum())
    report = {
        "removed_mass": 0.0, "removed_px": 0, "mask_px": mask_px,
        "removed_frac": 0.0, "leg_before": 0.0, "leg_after": 0.0,
        "candidate_px": 0, "kept_px": 0, "n_components": 0,
        "fg_fixed_px": 0, "note": "",
    }
    leg = _leg_region(mask)
    report["leg_before"] = float(alpha[leg].sum()) if leg.any() else 0.0
    report["leg_after"] = report["leg_before"]
    if mask_px == 0 or not ring.any():
        report["note"] = "empty mask or no background ring; unchanged"
        if return_fg:
            return alpha, np.asarray(rgb).copy(), report
        return alpha, report

    lab = _to_lab(rgb)
    bg_pal = _palette(lab[ring], k_bg)
    # Subject palette from interior pixels the background model does NOT
    # explain: otherwise k-means++ seeds a centroid on interior grass blades
    # and they read as subject colour. Only while such pixels are a small
    # minority (SUB_EXCLUDE_MAX); a green-shirted subject keeps them all.
    conf_lab = lab[conf]
    bg_like = _nearest_dist(conf_lab[:, None, :], bg_pal)[:, 0] < dbg_max
    if 0 < bg_like.mean() < SUB_EXCLUDE_MAX and (~bg_like).sum() > k_sub:
        conf_lab = conf_lab[~bg_like]
    sub_pal = _palette(conf_lab, k_sub)
    d_sub = _nearest_dist(lab, sub_pal)
    d_bg = _nearest_dist(lab, bg_pal)

    candidates = (mask & (alpha >= opaque_min)
                  & ((d_sub - d_bg) > margin)
                  & (d_sub > dsub_min) & (d_bg < dbg_max))
    report["candidate_px"] = int(candidates.sum())
    n, _labels, _stats, _c = cv2.connectedComponentsWithStats(
        candidates.astype(np.uint8), 8)
    report["n_components"] = int(n - 1)
    holes = _shape_gate(candidates, mask, min_area=min_area,
                        thin_radius=thin_radius, elong_min=elong_min,
                        touch_px=touch_px)
    report["kept_px"] = int(holes.sum())
    if not holes.any():
        report["note"] = "no occluder components; unchanged"
        if return_fg:
            return alpha, np.asarray(rgb).copy(), report
        return alpha, report

    punched = alpha.copy()
    punched[holes] = 0.0
    out = _soften_holes(punched, holes, rgb)
    out = np.clip(out, 0.0, 1.0).astype(np.float32)
    # The punched blob's own old soft edge (alpha < opaque_min, never a
    # candidate) survives as a thin outline ring: clear soft pixels that
    # border a hole but sit away from the remaining opaque subject.
    k5 = np.ones((5, 5), np.uint8)
    near_hole = cv2.dilate(holes.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    near_subj = cv2.dilate((out >= opaque_min).astype(np.uint8), k5).astype(bool)
    out[(out < opaque_min) & near_hole & ~near_subj & ~holes] = 0.0

    report["removed_mass"] = float((alpha - out).sum())
    report["removed_px"] = int(holes.sum())
    report["removed_frac"] = (report["removed_mass"] / mask_px
                              if mask_px else 0.0)
    report["leg_after"] = float(out[leg].sum()) if leg.any() else 0.0
    if not return_fg:
        return out, report
    # v2: recolour the hole rim from subject-coloured interior donors so
    # the soft rim carries deer colour, not grass. The donor pool is the
    # confident interior MINUS every colour candidate (all grass-like px,
    # not just punched holes), so the LUT can never return a blade pixel.
    rim = _rim_around(holes)
    # Safety margin: spill tints fur a few px around every blade, and those
    # spilt pixels fail the colour gate (they stay in conf). Keep donors
    # >=3 px from any colour candidate so medians sample clean fur.
    safe = cv2.dilate(candidates.astype(np.uint8),
                       np.ones((7, 7), np.uint8)).astype(bool)
    donor = conf & ~safe
    if not donor.any():
        donor = conf & ~holes
    if not donor.any():
        donor = conf
    fg = _decontaminate_rim(rgb, holes, rim, donor)
    report["fg_fixed_px"] = int(rim.sum())
    return out, fg, report


def _load_matte(path):
    """Load a matte: RGBA (alpha channel), gray 0-255, or label 0/1."""
    m = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if m is None:
        raise FileNotFoundError(path)
    if m.ndim == 3 and m.shape[2] == 4:
        return m[:, :, 3].astype(np.float32) / 255.0
    if m.ndim == 3:
        m = m[:, :, 0]  # label PNGs may load as RGB; channel 0 holds ids
    m = m.astype(np.float32)
    if m.max() <= 1.0:
        return m  # 0/1 soft or label matte
    return m / 255.0


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Punch foreground occluders (grass) out of a matte.")
    ap.add_argument("--rgb", required=True, help="Input frame (BGR image).")
    ap.add_argument("--matte", required=True,
                    help="Input matte: RGBA (uses A), gray 0-255, or 0/1.")
    ap.add_argument("--out-alpha", required=True,
                    help="Output alpha PNG (0-255).")
    ap.add_argument("--out-fg", default=None,
                    help="Optional output FG PNG (BGR, rim decontaminated).")
    ap.add_argument("--out-report", default=None,
                    help="Optional text file for the report line.")
    args = ap.parse_args(argv)

    rgb = cv2.imread(args.rgb, cv2.IMREAD_COLOR)
    if rgb is None:
        raise FileNotFoundError(args.rgb)
    alpha = _load_matte(args.matte)
    out, fg, report = remove_occluders(rgb, alpha, return_fg=True)
    cv2.imwrite(args.out_alpha, np.round(out * 255).astype(np.uint8))
    if args.out_fg is not None:
        cv2.imwrite(args.out_fg, fg)
    line = ("removed_mass=%.1f removed_px=%d mask_px=%d removed_frac=%.4f "
            "leg_before=%.1f leg_after=%.1f candidates=%d kept=%d ncomp=%d %s"
            % (report["removed_mass"], report["removed_px"],
               report["mask_px"], report["removed_frac"],
               report["leg_before"], report["leg_after"],
               report["candidate_px"], report["kept_px"],
               report["n_components"], report["note"]))
    print(line)
    if args.out_report is not None:
        with open(args.out_report, "w") as f:
            f.write(line + "\n")


if __name__ == "__main__":
    main()
