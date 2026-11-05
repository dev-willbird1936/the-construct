"""Lane A -- reject background-coloured thin additions (grass blades).

Pure function module, no network/models/GPU. Called from combine_matte
after the fat+foreign rule. See GRASSBLADE.md for method and numbers.

Rule: for each 8-connected ADD component (kept & gated>0.1 &
gated>sam_alpha, same as the fat rule) with inscribed radius <= 4.0 px
(thin only), compare per-pixel Lab distances to (a) the subject interior
palette (k-means K=6 over confident interior) and (b) the background ring
palette (k-means K=3 over 6-20 px outside SAM). A pixel is bg-like iff
(d_sub - d_bg) > MARGIN & d_sub > DSUB_MIN & d_bg < DBG_MAX (occluder
margins). The component is rejected (gated zeroed to sam_alpha) iff the
bg-like fraction > FRAC. Grayscale footage skips (colour test vacuous).

The antenna passes: fullres admit is fat-exempt (ins 5.0) and even
evaluated its frac is <= 0.033 (subject-coloured grey, ds 5-9).
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # `python -I` strips cwd from sys.path

import cv2
import numpy as np

THIN_RADIUS = 4.0  # same split as combine ADD_FAT_RADIUS; fat stays there
MARGIN = 14.0
DSUB_MIN = 10.0
DBG_MAX = 30.0
FRAC = 0.5
K_SUB = 6
K_BG = 3
RING_IN = 6
RING_OUT = 20


def _colorful_enough(bgr, frac=0.01):
    d = np.abs(bgr.astype(np.int32)[:, :, 0] - bgr.astype(np.int32)[:, :, 1])
    return bool((d > 8).mean() >= frac)


def drop_background_thin(gated, sam, sam_alpha, kept, rgb):
    """Zero thin background-coloured ADD components.

    Returns the filtered gated matte. Sets last_dropped_px /
    last_components on the function (count + per-component details for
    tests/docs). Never touches fat components or the interior matte.
    """
    from occluder import _to_lab, _palette, _nearest_dist

    drop_background_thin.last_dropped_px = 0
    drop_background_thin.last_components = []
    add = (kept & (gated > 0.1) & (gated > sam_alpha + 1e-6))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(
        add.astype(np.uint8), 8)
    if n <= 1 or not _colorful_enough(np.asarray(rgb)):
        return gated
    rgb = np.asarray(rgb)
    h, w = rgb.shape[:2]
    mu = np.asarray(sam).astype(np.uint8)
    if mu.shape != (h, w):
        raise ValueError("thin_colour: sam/rgb shape mismatch")
    conf = cv2.erode((np.asarray(sam_alpha) >= 0.98).astype(np.uint8),
                      np.ones((9, 9), np.uint8)).astype(bool)
    if not conf.any():
        conf = sam.astype(bool)
    outer = cv2.dilate(mu, np.ones((2 * RING_OUT + 1, 2 * RING_OUT + 1),
                                   np.uint8)).astype(bool)
    inner = cv2.dilate(mu, np.ones((2 * RING_IN + 1, 2 * RING_IN + 1),
                                   np.uint8)).astype(bool)
    ring = outer & ~inner
    if not ring.any() or not conf.any():
        return gated
    lab_img = _to_lab(rgb)
    sub_pal = _palette(lab_img[conf], K_SUB)
    bg_pal = _palette(lab_img[ring], K_BG)
    d_sub = _nearest_dist(lab_img, sub_pal)
    d_bg = _nearest_dist(lab_img, bg_pal)
    out = gated.copy()
    dropped = 0
    comps = []
    for cid in range(1, n):
        comp = (lab == cid)
        area = int(stats[cid, cv2.CC_STAT_AREA])
        ins = float(cv2.distanceTransform(comp.astype(np.uint8),
                                          cv2.DIST_L2, 5).max())
        if ins > THIN_RADIUS:
            continue  # fat: the fat rule owns it
        ds = d_sub[comp]
        db = d_bg[comp]
        frac = float((((ds - db) > MARGIN) & (ds > DSUB_MIN)
                      & (db < DBG_MAX)).mean())
        rec = {"id": cid, "area": area, "inscribed": ins,
               "ds_med": float(np.median(ds)),
               "db_med": float(np.median(db)),
               "gap_med": float(np.median(ds - db)), "frac": frac,
               "dropped": bool(frac > FRAC)}
        comps.append(rec)
        if frac > FRAC:
            out[comp] = np.minimum(gated[comp], sam_alpha[comp])
            dropped += area
    drop_background_thin.last_dropped_px = dropped
    drop_background_thin.last_components = comps
    return out


def drop_background_protrusions_at(gated, final, kept, band6, rgb, sam,
                                   sam_alpha):
    """Zero outside-band thin protrusions that are background-coloured.

    An attached blade (grass touching the head) merges with edge strips
    inside the band into one fat/mixed ADD component, so the ADD-level
    thin rule above skips it. The protrusion itself (outside band6) is
    still thin and background-like: evaluate each 8-connected admit
    component (gated>0.1 & gated>final & kept & ~band6, ins <= radius)
    with the same Lab frac rule and zero it. Antenna protrusions are
    fat-exempt (fullres ins 5.0) or subject-coloured (frac ~0).
    Returns filtered gated."""
    from occluder import _to_lab, _palette, _nearest_dist

    drop_background_protrusions_at.last_dropped_px = 0
    drop_background_protrusions_at.last_components = []
    rgb = np.asarray(rgb)
    admit = ((gated > 0.1) & (gated > final) & np.asarray(kept)
             & ~np.asarray(band6))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(
        admit.astype(np.uint8), 8)
    if n <= 1 or not _colorful_enough(rgb):
        return gated
    mu = np.asarray(sam).astype(np.uint8)
    conf = cv2.erode((np.asarray(sam_alpha) >= 0.98).astype(np.uint8),
                      np.ones((9, 9), np.uint8)).astype(bool)
    if not conf.any():
        conf = np.asarray(sam).astype(bool)
    outer = cv2.dilate(mu, np.ones((2 * RING_OUT + 1, 2 * RING_OUT + 1),
                                   np.uint8)).astype(bool)
    inner = cv2.dilate(mu, np.ones((2 * RING_IN + 1, 2 * RING_IN + 1),
                                   np.uint8)).astype(bool)
    ring = outer & ~inner
    if not ring.any():
        return gated
    lab_img = _to_lab(rgb)
    sub_pal = _palette(lab_img[conf], K_SUB)
    bg_pal = _palette(lab_img[ring], K_BG)
    d_sub = _nearest_dist(lab_img, sub_pal)
    d_bg = _nearest_dist(lab_img, bg_pal)
    out = gated.copy()
    dropped = 0
    comps = []
    for cid in range(1, n):
        comp = (lab == cid)
        area = int(stats[cid, cv2.CC_STAT_AREA])
        ins = float(cv2.distanceTransform(comp.astype(np.uint8),
                                          cv2.DIST_L2, 5).max())
        if ins > THIN_RADIUS:
            continue  # fat protrusion: fat rule owns it
        ds = d_sub[comp]
        db = d_bg[comp]
        frac = float((((ds - db) > MARGIN) & (ds > DSUB_MIN)
                      & (db < DBG_MAX)).mean())
        rec = {"id": cid, "area": area, "inscribed": ins,
               "ds_med": float(np.median(ds)),
               "db_med": float(np.median(db)),
               "gap_med": float(np.median(ds - db)), "frac": frac,
               "dropped": bool(frac > FRAC)}
        comps.append(rec)
        if frac > FRAC:
            out[comp] = np.minimum(gated[comp], sam_alpha[comp])
            dropped += area
    drop_background_protrusions_at.last_dropped_px = dropped
    drop_background_protrusions_at.last_components = comps
    return out


drop_background_thin.last_dropped_px = 0
drop_background_thin.last_components = []
drop_background_protrusions_at.last_dropped_px = 0
drop_background_protrusions_at.last_components = []
