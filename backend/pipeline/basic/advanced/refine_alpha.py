"""Lane A -- shared edge refinement for Basic + Lite tiers.

Pure function module plus a small CLI. No network, no models, no GPU.

Pipeline (see BOUNDARY.md):
  1. Work at frame resolution; a differently-sized mask is upsampled
     bilinearly as float, never nearest.
  2. Island cleanup on the HARD mask: keep the largest component plus any
     component overlapping prev_alpha (if given). Runs pre-feathering so the
     smoother can never thin a structure below the cutoff and lose it. The
     removed pixel count is reported via the
     ``refine_alpha.last_removed_pixels`` attribute (set on every call) and
     by the CLI on stdout. Never erodes the mask: thin parts survive.
  3. Guided feathering (cv2.ximgproc.guidedFilter, RGB guide -- colour
     separates brown deer from green grass where luma does not) applied only
     to a narrow band (+-BAND_HALF_WIDTH px) around the cleaned mask's edge;
     interior stays 1, far exterior 0. A smoothstep snap inside the band
     keeps the 10-90% transition at ~2 px instead of a wide blurry glow.
     Output stays SOFT (float alpha in [0, 1]).
  4. Temporal smoothing is OFF by default: keyframes are ~5 source frames
     apart while the subject moves, so blending with the previous keyframe
     ghosts (semi-transparent doubles). Pass consecutive=True only for truly
     consecutive frames; even then smoothing applies solely inside the
     current mask dilated by 1 px, never adding alpha outside it.
  5. Foreground colour decontamination in the band: semi-transparent edge
     pixels are re-estimated from the nearest confident-interior pixel so
     background colour (e.g. green grass) does not tint them.

How this differs from plate.py cmd_refine_mask: that command filters at
full resolution with a luma guide and then RE-BINARISES (adaptive threshold
at half the peak) plus INTER_AREA downscale, so its output is a binary
working-res mask -- the soft edge is discarded by design, and the
selected-subject path (run-basic.mjs) never calls it. refine_alpha keeps
the filtered result as float alpha, works at frame resolution, and adds
island cleanup, opt-in consecutive-only temporal smoothing and foreground
decontamination.
"""

import argparse

import cv2
import numpy as np

# Edge-band half-width in px. Alpha outside the dilated edge is exactly the
# mask (1 interior, 0 exterior), so no halo or ghost can leak beyond it.
BAND_HALF_WIDTH = 2

# Fixed blend used for temporal smoothing inside the allowed region.
_TEMPORAL_BETA = 0.5


def _require_ximgproc():
    """Return cv2.ximgproc, or fail closed (no silent luma fallback)."""
    xf = getattr(cv2, "ximgproc", None)
    if xf is None or not hasattr(xf, "guidedFilter"):
        raise RuntimeError(
            "refine_alpha needs cv2.ximgproc.guidedFilter "
            "(opencv-contrib); refusing to run without it")
    return xf


def nearest_interior_lut(confident_interior_bool):
    """(rows, cols) index maps of the nearest confident-interior pixel.

    Exact nearest-interior lookup without scipy (production venvs lack it):
    cv2.distanceTransformWithLabels(..., labelType=DIST_LABEL_PIXEL)
    enumerates the zero pixels in scan order, so each label is mapped back
    through that enumeration (label k -> k-th zero pixel, 1-based).
    """
    conf = np.asarray(confident_interior_bool, dtype=bool)
    src = (~conf).astype(np.uint8)  # zeros = interior candidates
    _d, labels = cv2.distanceTransformWithLabels(
        src, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    zy, zx = np.where(src == 0)
    if len(zy) == 0:
        raise ValueError("nearest_interior_lut: empty interior")
    lab = labels.astype(np.int64) - 1
    np.clip(lab, 0, len(zy) - 1, out=lab)
    return zy[lab], zx[lab]


def _to_bool_mask(mask, shape):
    """Return a 2-D bool mask at ``shape`` (H, W).

    A differently-sized mask is upsampled bilinearly as float32 and thresholded
    at 0.5 -- never nearest-neighbour. Multi-channel input uses channel 0
    (fixture label PNGs may load as RGB).
    """
    m = np.asarray(mask)
    if m.ndim == 3:
        m = m[:, :, 0]
    if m.dtype == bool:
        f = m.astype(np.float32)
    else:
        f = m.astype(np.float32)
        if f.max() > 1.0:
            f = f / 255.0
    if f.shape != shape:
        f = cv2.resize(f, (shape[1], shape[0]),
                       interpolation=cv2.INTER_LINEAR)
    return (f >= 0.5)


def _band_and_interiors(mask_bool):
    """Edge band plus confident interior region."""
    b = BAND_HALF_WIDTH
    mu = mask_bool.astype(np.uint8)
    k = np.ones((2 * b + 1, 2 * b + 1), np.uint8)
    dilated = cv2.dilate(mu, k).astype(bool)
    eroded = cv2.erode(mu, k).astype(bool)
    band = dilated & ~eroded
    k_conf = np.ones((2 * (b + 1) + 1, 2 * (b + 1) + 1), np.uint8)
    confident_interior = cv2.erode(mu, k_conf).astype(bool)
    if not confident_interior.any():
        confident_interior = mask_bool  # tiny mask: fall back to the mask itself
    return band, confident_interior, eroded, dilated


def refine_alpha(rgb_uint8_HxWx3, hard_mask_bool, prev_alpha=None, *,
                 radius=1, eps=1e-3, consecutive=False):
    """Refine a hard binary mask into a soft alpha matte.

    Args:
        rgb_uint8_HxWx3: HxWx3 uint8 frame (BGR as loaded by cv2).
        hard_mask_bool: HxW mask (bool, 0/1 or 0/255; may differ in size).
        prev_alpha: optional previous-frame alpha, H'xW' float in [0, 1].
            Ignored unless consecutive=True (see below).
        radius: guided-filter window radius in px (window is 2r+1).
        eps: guided-filter regularisation for a [0, 1] float guide.
        consecutive: set True only when prev_alpha is the immediately
            previous frame. Keyframes ~5 frames apart are NOT consecutive:
            blending those ghosts. Even when True, smoothing never adds
            alpha outside the current mask dilated by 1 px.

    Returns:
        (alpha_float32_HxW in [0, 1], fg_rgb_uint8 HxWx3).
    """
    rgb = np.asarray(rgb_uint8_HxWx3)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must be HxWx3 uint8")
    h, w = rgb.shape[:2]
    mask = _to_bool_mask(hard_mask_bool, (h, w))

    # Resize once, reuse for cleanup overlap and temporal smoothing.
    prev_resized = None
    if prev_alpha is not None and consecutive:
        prev_resized = cv2.resize(np.asarray(prev_alpha, dtype=np.float32),
                                  (w, h), interpolation=cv2.INTER_LINEAR)
        prev_resized = np.clip(prev_resized, 0.0, 1.0)

    # (2) Island cleanup on the hard mask (pre-feathering); never an erosion.
    n_comp, labels, stats, _ = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), 8)
    removed = 0
    if n_comp > 2 or (n_comp == 2 and prev_resized is not None):
        # Component 0 is the background; keep the largest foreground one.
        areas = stats[1:, cv2.CC_STAT_AREA]
        keep = {int(np.argmax(areas)) + 1}
        if prev_resized is not None:
            prev_bin = prev_resized > 0.5
            for cid in range(1, n_comp):
                if np.any((labels == cid) & prev_bin):
                    keep.add(cid)
        drop = mask & ~np.isin(labels, list(keep))
        removed = int(drop.sum())
        mask = mask & ~drop
    refine_alpha.last_removed_pixels = removed

    # (3) Guided feathering, restricted to the edge band of the cleaned mask.
    band, confident_interior, _eroded, _dilated = _band_and_interiors(mask)
    base = mask.astype(np.float32)
    alpha = base.copy()
    if band.any():
        guide = rgb.astype(np.float32) / 255.0
        q = _require_ximgproc().guidedFilter(guide, base, radius,
                                             float(eps))
        t = np.clip(q[band], 0.0, 1.0)
        alpha[band] = (t * t * (3.0 - 2.0 * t)).astype(np.float32)  # snap

    # (4) Temporal smoothing: consecutive frames only, and never outside the
    # current mask dilated by 1 px (no ghost doubles).
    if prev_resized is not None and band.any():
        dil1 = cv2.dilate(mask.astype(np.uint8),
                          np.ones((3, 3), np.uint8)).astype(bool)
        allow = band & dil1
        alpha[allow] = ((1.0 - _TEMPORAL_BETA) * alpha[allow]
                        + _TEMPORAL_BETA * prev_resized[allow])
        np.clip(alpha, 0.0, 1.0, out=alpha)

    # (5) Foreground decontamination in the band.
    fg = rgb.copy()
    fix = band & (alpha < 0.98)
    if fix.any():
        nrow, ncol = nearest_interior_lut(confident_interior)
        fg[fix] = rgb[nrow[fix], ncol[fix]]

    return alpha.astype(np.float32), fg


# Set on every refine_alpha() call: mask pixels dropped by island cleanup.
refine_alpha.last_removed_pixels = 0


def _load_mask_bool(path):
    m = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if m is None:
        raise FileNotFoundError(path)
    if m.ndim == 3:
        m = m[:, :, 0]
    if m.dtype == bool:
        return m
    if m.max() <= 1:
        return m > 0
    return m > 127


def main(argv=None):
    ap = argparse.ArgumentParser(description="Lane A edge refinement CLI.")
    ap.add_argument("--rgb", required=True, help="Input frame (BGR image).")
    ap.add_argument("--mask", required=True, help="Hard mask image (0/1 or 0/255).")
    ap.add_argument("--out-alpha", required=True, help="Output alpha PNG (0-255).")
    ap.add_argument("--out-fg", required=True, help="Output decontaminated FG PNG.")
    ap.add_argument("--prev-alpha", default=None,
                    help="Optional previous alpha PNG (0-255).")
    ap.add_argument("--consecutive", action="store_true",
                    help="prev-alpha is the immediately previous frame.")
    ap.add_argument("--radius", type=int, default=1)
    ap.add_argument("--eps", type=float, default=1e-3)
    args = ap.parse_args(argv)

    rgb = cv2.imread(args.rgb, cv2.IMREAD_COLOR)
    if rgb is None:
        raise FileNotFoundError(args.rgb)
    mask = _load_mask_bool(args.mask)
    prev = None
    if args.prev_alpha is not None:
        prev = cv2.imread(args.prev_alpha, cv2.IMREAD_UNCHANGED)
        if prev is None:
            raise FileNotFoundError(args.prev_alpha)
        if prev.ndim == 3:
            prev = prev[:, :, 0]
        prev = prev.astype(np.float32) / 255.0

    alpha, fg = refine_alpha(rgb, mask, prev, radius=args.radius, eps=args.eps,
                             consecutive=args.consecutive)
    cv2.imwrite(args.out_alpha, np.round(alpha * 255).astype(np.uint8))
    cv2.imwrite(args.out_fg, fg)
    print("removed_pixels=%d" % refine_alpha.last_removed_pixels)
    print("alpha_min=%.4f alpha_max=%.4f alpha_mean=%.4f"
          % (float(alpha.min()), float(alpha.max()), float(alpha.mean())))


if __name__ == "__main__":
    main()
