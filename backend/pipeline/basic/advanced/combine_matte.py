"""Advanced tier -- SAM selects, BiRefNet refines ("combine_matte").

Pure function module. No network, no models, no GPU.

combine(sam_mask_bool, birefnet_alpha_float, rgb) -> (alpha, fg):

  (a) Connected-component gate: BiRefNet components (alpha > 0.1,
      8-connected) that intersect the SAM mask are kept; all others are
      dropped. Surviving components all touch the subject, so no
      disconnected object can be added downstream.
  (b) Final alpha = max(birefnet_gated, refined SAM alpha from
      refine_alpha) inside a 6 px half-band of the SAM edge; outside that
      band, birefnet_gated values are taken only where they ADD connected
      thin structure (gated > 0.1 and above the SAM matte), tracked as
      'addedThinPx' in combine.last_added_thin_px. Fat AND colour-foreign
      additions (opaque grass tufts) are zeroed back to the SAM matte first
      (ADD_FAT_RADIUS / ADD_COLOR_DIST; count in
      combine.last_rule_dropped_px) and thin background-coloured ones
      (grass blades via thin_colour.py, count in
      combine.last_thin_dropped_px) while thin subject-coloured ones
      (antenna, edge strips) survive. Isolated specks can only
      come from SAM itself (refine_alpha's own cleanup); the gate plus the
      connectivity rule keep BiRefNet additions attached to the subject.
  (c) Foreground decontamination over the WHOLE +-2 px SAM edge band
      (opaque outer ring included -- it still carries background spill).

Lessons from Main's integration fixes (applied here, not repeated):
  - cv2.imwrite expects BGR(A) arrays and swaps R/B on disk; never dstack
    R,G,B for cv2. This module keeps BGR order throughout (as loaded) and
    verifies on-disk order through an independent zlib PNG decoder in
    test_combine_matte.py.
  - Batch work belongs outside per-frame loops (no pipeline code here, but
    the keyframe tests refine each frame independently, never nested).
  - Single-component assumptions are not made about BiRefNet: every
    component intersecting SAM is kept (union-ids safe).
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # `python -I` strips cwd from sys.path

import cv2
import numpy as np

from refine_alpha import (BAND_HALF_WIDTH, nearest_interior_lut,
                           refine_alpha)

BIREFNET_GATE = 0.1  # component binarisation threshold for the gate
EDGE_AGREE_BAND = 6  # half-width (px) of the SAM-edge band where max() applies
# Fat-and-foreign addition rule (muzzle-blob fix): an addition component
# (birefnet above the SAM matte) is dropped only if it is BOTH thick
# (max inscribed radius > ADD_FAT_RADIUS px) AND colour-inconsistent with
# the adjacent subject (BGR distance > ADD_COLOR_DIST). Thin structure
# (antenna shaft, edge strips) is always kept; thick colour-consistent
# structure (antenna + ball + head overshoot in one merged component) is
# kept. Calibrated on deer kf_00120 (blob 6.71/54.3) vs fullres antenna
# (5.00/15.1); verified to hold 91/93 antenna recovery.
ADD_FAT_RADIUS = 4.0
ADD_COLOR_DIST = 40.0
# Cast-shadow gate: drop an outside-SAM addition component only if ALL hold:
# achromatic dimming (luminance ratio < SHADOW_RATIO with per-channel
# spread < SHADOW_SPREAD), shape/size (thin components are exempt ONLY
# when small: area < SHADOW_THIN_AREA, so antenna/edge strips survive;
# a thin component with area >= SHADOW_THIN_AREA goes through the same
# ratio/spread/texture tests as fat ones), and texture (background match
# EITHER by Pearson > SHADOW_PEARSON on non-degenerate components OR by
# attenuation uniformity, ratio CV < SHADOW_RATIO_CV -- a shadow scales
# the background nearly constantly while a dark object adds its own
# texture; flat components are still kept). Grayscale footage skips the gate entirely
# (spread is vacuous there): see _colorful_enough.
SHADOW_RATIO = 0.92
SHADOW_SPREAD = 0.15
SHADOW_MAXR = 3.5
SHADOW_AREA = 100
SHADOW_PEARSON = 0.2
# Thin exemption applies only below this area (antenna-sized). Thin but
# large additions (>= this) go through the same tests as fat ones.
# 500 px ~= 4x the largest antenna component (173 px), ~2x the largest
# small grey-anatomy component kept by texture (clip-a 262 px), and < half
# the smallest cast shadow (1152 px): margins 327 / 238 / 652 px.
# Round, not fitted. No thin component >= 500 px exists in the fixtures
# (max thin is 145 px), so this changes no fixture output by itself.
SHADOW_THIN_AREA = 500
SHADOW_RATIO_CV = 0.25
SHADOW_BG_FLOOR = 20.0
# Attenuation-uniformity texture: a cast shadow multiplies the background,
# so the per-pixel luminance ratio src/bg is nearly constant across the
# component; a dark textured object has its own texture, so the ratio
# varies. Texture passes if Pearson > SHADOW_PEARSON (as before) OR the
# ratio CV (std/mean over pixels with bg luminance > SHADOW_BG_FLOOR)
# is < SHADOW_RATIO_CV. Measured: 10 CG shadow components incl kf82/87
# have CV 0.136-0.175 (kf82 0.156, kf87 0.160); at-risk non-shadows have
# CV 0.356 (clip-a kf00119 top-border 174 px), 0.430 (clip-b edge 116 px) and
# 3.24 (clip-a kf00000 border-black 260 px). 0.25 is the geometric midpoint
# sqrt(0.175*0.356) ~= 0.25: 1.43x above the worst shadow, 1.42x below
# the nearest anatomy. MAD/median was evaluated and rejected: it
# separates too (shadows <= 0.046 vs clip-a/clip-b >= 0.308) but degenerates
# to 0.0 on the flat-black clip-a border component, while CV blows up to
# 3.24 there (safe direction). Per-channel achromaticity stays covered
# by the spread test.


def _to_float_alpha(bi, shape):
    """BiRefNet alpha as float32 in [0, 1] at ``shape`` (bilinear if resized)."""
    f = np.asarray(bi).astype(np.float32)
    if f.ndim == 3:
        f = f[:, :, 0]
    if f.max() > 1.0:
        f = f / 255.0
    if f.shape != shape:
        f = cv2.resize(f, (shape[1], shape[0]),
                       interpolation=cv2.INTER_LINEAR)
    return np.clip(f, 0.0, 1.0)


def _luminance(bgr):
    bgr = np.asarray(bgr, dtype=np.float64)
    return 0.114 * bgr[:, :, 0] + 0.587 * bgr[:, :, 1] + 0.299 * bgr[:, :, 2]


def _colorful_enough(bgr, frac=0.01):
    """False for grayscale footage (then the spread test is vacuous)."""
    d = np.abs(bgr.astype(np.int32)[:, :, 0] - bgr.astype(np.int32)[:, :, 1])
    return bool((d > 8).mean() >= frac)


def _drop_shadow(gated, sam, sam_alpha, kept, rgb, bg):
    """Zero shadow-like outside-SAM additions (cast shadows on the ground).

    Drop an 8-connected addition component only if ALL hold: strictly
    outside SAM (interior is never touched), achromatic dimming versus
    the background (mean luminance ratio < SHADOW_RATIO with per-channel
    spread < SHADOW_SPREAD), shape/size (thin components are exempt only
    when small: area < SHADOW_THIN_AREA, so antenna/legs survive; thin
    but large components go through the same ratio/spread/texture tests
    as fat ones), and texture (background match EITHER by Pearson >
    SHADOW_PEARSON on non-degenerate components OR by attenuation
    uniformity, ratio CV < SHADOW_RATIO_CV -- a cast shadow scales the
    background nearly constantly while a dark object adds its own
    texture; flat components are still kept). Grayscale footage skips the gate entirely (spread is
    vacuous there). Returns the filtered gated matte; count in
    combine.last_shadow_dropped_px."""
    combine.last_shadow_dropped_px = 0
    combine.last_shadow_skipped = False
    if bg is None:
        return gated
    bg = np.asarray(bg)
    if bg.shape != rgb.shape:
        raise ValueError("shadow bg must match frame shape")
    if not _colorful_enough(rgb):
        combine.last_shadow_skipped = True
        return gated  # safe failure: keep everything
    # NOTE: only the frame is tested. The background reference may be a
    # legitimately gray clean plate; the spread test only needs color
    # information in the frame itself.
    lb = _luminance(bg)
    ls = _luminance(rgb)
    ratio = ls / np.maximum(lb, 1.0)
    rr = rgb.astype(float) / np.maximum(bg.astype(float), 1.0)
    spread = rr.max(axis=2) - rr.min(axis=2)
    add = kept & (gated > BIREFNET_GATE) & (gated > sam_alpha + 1e-6) & ~sam
    n, lab, stats, _ = cv2.connectedComponentsWithStats(add.astype(np.uint8), 8)
    if n <= 1:
        return gated
    out = gated.copy()
    dropped = 0
    for cid in range(1, n):
        comp = (lab == cid)
        area = int(stats[cid, cv2.CC_STAT_AREA])
        if area < SHADOW_AREA:
            continue
        inscribed = float(cv2.distanceTransform(comp.astype(np.uint8),
                                                  cv2.DIST_L2, 5).max())
        if inscribed <= SHADOW_MAXR and area < SHADOW_THIN_AREA:
            continue  # thin and small: always keep (antenna, legs)
        # thin but large (>= SHADOW_THIN_AREA) falls through to the same
        # ratio/spread/texture tests as fat components.
        if float(ratio[comp].mean()) >= SHADOW_RATIO:
            continue
        if float(spread[comp].mean()) >= SHADOW_SPREAD:
            continue
        x, y = ls[comp], lb[comp]
        if x.std() < 1e-9 or y.std() < 1e-9:
            continue  # flat: cannot confirm texture, keep
        if float(np.corrcoef(x, y)[0, 1]) > SHADOW_PEARSON:
            textured = True
        else:
            # Attenuation uniformity: shadow scales bg nearly constantly.
            sel = comp & (lb > SHADOW_BG_FLOOR)
            if int(sel.sum()) < 10:
                sel = comp
            r = ratio[sel]
            textured = (float(r.std()) / max(float(r.mean()), 1e-9)
                         < SHADOW_RATIO_CV)
        if not textured:
            continue
        out[comp] = np.minimum(gated[comp], sam_alpha[comp])
        dropped += area
    combine.last_shadow_dropped_px = dropped
    return out


def _drop_fat_foreign(gated, sam_alpha, kept, rgb):
    """Zero gated pixels of fat, colour-inconsistent addition components.

    Addition = kept pixels where birefnet exceeds the SAM matte. Each
    8-connected addition component thicker than ADD_FAT_RADIUS is compared
    (mean BGR) against the adjacent confident SAM interior; dropped when
    farther than ADD_COLOR_DIST. Returns the filtered gated matte."""
    add = kept & (gated > BIREFNET_GATE) & (gated > sam_alpha + 1e-6)
    n, lab, _, _ = cv2.connectedComponentsWithStats(add.astype(np.uint8), 8)
    if n <= 1:
        combine.last_rule_dropped_px = 0
        return gated
    sam = kept | (sam_alpha > 0.5)  # kept pixels intersect SAM by gate
    conf = cv2.erode(sam.astype(np.uint8),
                      np.ones((3, 3), np.uint8)).astype(bool)
    if not conf.any():
        combine.last_rule_dropped_px = 0
        return gated
    out = gated.copy()
    dropped = 0
    k_adj = np.ones((31, 31), np.uint8)
    for cid in range(1, n):
        comp = (lab == cid)
        inscribed = float(cv2.distanceTransform(comp.astype(np.uint8),
                                                  cv2.DIST_L2, 5).max())
        if inscribed <= ADD_FAT_RADIUS:
            continue  # thin: always keep
        adj = cv2.dilate(comp.astype(np.uint8), k_adj).astype(bool) & conf
        if not adj.any():
            continue  # no adjacent subject to judge by: keep
        c_add = rgb[comp].reshape(-1, 3).mean(axis=0)
        c_sub = rgb[adj].reshape(-1, 3).mean(axis=0)
        if float(np.linalg.norm(c_add - c_sub)) > ADD_COLOR_DIST:
            out[comp] = np.minimum(gated[comp], sam_alpha[comp])
            dropped += int(comp.sum())
    combine.last_rule_dropped_px = dropped
    return out


def combine(sam_mask_bool, birefnet_alpha_float, rgb_uint8_HxWx3, bg=None):
    """Fuse a SAM hard mask with a BiRefNet soft alpha.

    Args:
        sam_mask_bool: HxW subject mask (bool, 0/1 or 0/255; may differ
            in size from rgb -- upsampled bilinearly, never nearest).
        birefnet_alpha_float: HxW alpha in [0, 1] (or 0-255; resized
            bilinearly if needed).
        rgb_uint8_HxWx3: HxWx3 uint8 frame (BGR as loaded by cv2).
        bg: optional HxWx3 uint8 background reference (same size, BGR).
            Enables cast-shadow suppression (see _drop_shadow); None
            keeps the old behaviour. A static-subject bg contaminates to
            ratio ~1, so nothing is dropped (documented safe failure).

    Returns:
        (alpha_float32_HxW in [0, 1], fg_rgb_uint8 HxWx3 in BGR order --
        pass BGR(A) arrays to cv2.imwrite, never pre-swapped RGB).
    """
    rgb = np.asarray(rgb_uint8_HxWx3)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must be HxWx3 uint8")
    h, w = rgb.shape[:2]
    m = np.asarray(sam_mask_bool)
    if m.ndim == 3:
        m = m[:, :, 0]
    sam = (m > 0) if m.dtype != bool else m
    if sam.shape != (h, w):
        f = sam.astype(np.float32)
        sam = (cv2.resize(f, (w, h), interpolation=cv2.INTER_LINEAR) >= 0.5)
    bi = _to_float_alpha(birefnet_alpha_float, (h, w))

    # (a) Gate: keep BiRefNet components (8-connected over alpha > 0.1)
    # that intersect the SAM mask; drop the rest.
    n, labels, _stats, _cent = cv2.connectedComponentsWithStats(
        (bi > BIREFNET_GATE).astype(np.uint8), 8)
    kept = np.zeros_like(sam)
    for cid in range(1, n):
        comp = (labels == cid)
        if np.any(comp & sam):
            kept |= comp
    dropped = int((((bi > BIREFNET_GATE).astype(bool)) & ~kept).sum())
    gated = np.where(kept, bi, 0.0).astype(np.float32)

    # Refined SAM matte (Lane A: RGB guide, band +-2, edge snap, no temporal).
    sam_alpha, _sam_fg = refine_alpha(rgb, sam, None, radius=1, eps=1e-3)

    # (b) Fuse: max() inside the agree band; connected additions outside it.
    # Fat-and-foreign additions (e.g. an opaque grass tuft at the muzzle)
    # are zeroed back to the SAM matte first; thin or colour-consistent
    # additions (antenna, edge strips) survive.
    mu = sam.astype(np.uint8)
    k6 = np.ones((2 * EDGE_AGREE_BAND + 1, 2 * EDGE_AGREE_BAND + 1), np.uint8)
    band6 = (cv2.dilate(mu, k6) & ~cv2.erode(mu, k6)).astype(bool)
    gated = _drop_shadow(gated, sam, sam_alpha, kept, rgb, bg)
    gated = _drop_fat_foreign(gated, sam_alpha, kept, rgb)
    from thin_colour import drop_background_thin
    gated = drop_background_thin(gated, sam, sam_alpha, kept, rgb)
    combine.last_thin_dropped_px = drop_background_thin.last_dropped_px
    combine.last_thin_components = drop_background_thin.last_components
    final = sam_alpha.copy()
    final[band6] = np.maximum(gated[band6], sam_alpha[band6])
    from thin_colour import drop_background_protrusions_at
    gated = drop_background_protrusions_at(gated, final, kept, band6,
                                           rgb, sam, sam_alpha)
    combine.last_protrusion_dropped_px = \
        drop_background_protrusions_at.last_dropped_px
    combine.last_protrusion_components = \
        drop_background_protrusions_at.last_components
    admit = (gated > BIREFNET_GATE) & (gated > final) & kept & ~band6
    final[admit] = gated[admit]
    combine.last_added_thin_px = int(admit.sum())
    combine.last_gated_dropped_px = dropped

    # (c) Whole-band decontamination from the nearest confident-interior px.
    b = BAND_HALF_WIDTH
    kb = np.ones((2 * b + 1, 2 * b + 1), np.uint8)
    band = (cv2.dilate(mu, kb) & ~cv2.erode(mu, kb)).astype(bool)
    fg = rgb.copy()
    if band.any():
        kc = np.ones((2 * (b + 1) + 1, 2 * (b + 1) + 1), np.uint8)
        conf = cv2.erode(mu, kc).astype(bool)
        if not conf.any():
            conf = sam
        nrow, ncol = nearest_interior_lut(conf)
        fg[band] = rgb[nrow[band], ncol[band]]

    return np.clip(final, 0.0, 1.0).astype(np.float32), fg


combine.last_added_thin_px = 0
combine.last_gated_dropped_px = 0
combine.last_shadow_dropped_px = 0
combine.last_shadow_skipped = False
combine.last_rule_dropped_px = 0
combine.last_thin_dropped_px = 0
combine.last_thin_components = []
combine.last_protrusion_dropped_px = 0
combine.last_protrusion_components = []
