"""Lane A -- defocus-matched feather (BRIEF-EDGE-DEFOCUS-V1).

The judged frames show the subject with a crisper silhouette than the photo
it is cut from (camera blur, compression, motion soften the source edges;
legs end in hard cuts). When the matte's alpha transition is systematically
narrower than the source's own 10-90% intensity transition at the subject
boundary, this module widens it to the measured source width, capped at
``cap`` (default 2.5 px) and never exceeding the measured width.

Usable by both mattes: input (rgb, alpha, fg) -> (alpha', fg').

  - ``source_edge_width(rgb, mask)``: median 10-90% luma transition width
    across the true boundary, sampled along normals of the SAM contour.
    Centres on the steepest gradient within +-8 px, so 1-3 px SAM
    overshoot does not bias it; low-contrast samples are rejected.
  - ``matte_edge_width(alpha)``: same procedure on the alpha matte with
    fixed 0.1/0.9 levels.
  - ``match_defocus(rgb, alpha, fg, *, source_width, cap=2.5)``: if the
    matte is already as soft as ``min(source_width, cap)``, returns the
    inputs unchanged (no-op). Otherwise applies the extra Gaussian sigma
    (quadrature: 10-90% width of a Gaussian step is 2.563*sigma) restricted
    to the +-2 px edge band, re-pins everything outside the band (interior
    stays 1, exterior 0 -- never an erosion), refreshes fg inside the
    feathered pixels from the nearest confident-interior pixel (so no
    colour halo is introduced), and skips thin structures whose local
    half-thickness is below the target width (antenna mass >= 0.90, deer
    legs >= 0.95x).

No network, no models, no GPU.
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # `python -I` strips cwd from sys.path

import cv2
import numpy as np

from refine_alpha import nearest_interior_lut

# Gaussian-step constant: 10-90% transition width = GAUSS_W10_90 * sigma.
GAUSS_W10_90 = 2.561844  # 2 * Phi^-1(0.9); computed below at import
try:
    from scipy.stats import norm as _norm
    GAUSS_W10_90 = float(2 * _norm.ppf(0.9))
except Exception:
    pass

BAND = 2          # edge-band half-width (px), same as refine_alpha
PROFILE_HALF = 8.0  # normal-profile half-length (px) for width measurement
LUMA_CONTRAST = 15.0  # minimum inner/outer luma span for a valid sample
NOOP_TOL = 0.05   # matte within this of target counts as "already as soft"

# v2 (BRIEF-EDGE-DEFOCUS-V2): real target for soft natural footage.
V2_CAP = 4.5     # covers slovak/clip-a/roedeer sources (3.7-4.7 px)
V2_MARGIN = 0.3  # target sits this far below the source (slightly crisper)
V2_HALF = 3      # edge-band half-width once the target exceeds 2.5 px


def _contour_samples(binmask, n=200):
    """(point, outward_normal) samples along the largest external contour."""
    mu = np.asarray(binmask).astype(np.uint8)
    cnts, _ = cv2.findContours(mu, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return []
    cnt = max(cnts, key=len).squeeze(1)
    if cnt.ndim != 2 or len(cnt) < 40:
        return []
    h, w = mu.shape
    m = (mu > 0)
    step = max(1, len(cnt) // n)
    out = []
    for i in range(0, len(cnt), step):
        p0 = cnt[max(0, i - 5)].astype(float)
        p1 = cnt[min(len(cnt) - 1, i + 5)].astype(float)
        t = p1 - p0
        nl = float(np.hypot(t[0], t[1]))
        if nl < 1e-6:
            continue
        t = t / nl
        nrm = np.array([-t[1], t[0]])
        p = cnt[i].astype(float)
        qx, qy = int(round(p[0] + nrm[0] * 3.0)), int(round(p[1] + nrm[1] * 3.0))
        if 0 <= qx < w and 0 <= qy < h and m[qy, qx]:
            nrm = -nrm
        out.append((p, nrm))
    return out


def _bilinear(img, xs, ys):
    h, w = img.shape
    x0 = np.floor(xs).astype(int)
    y0 = np.floor(ys).astype(int)
    fx = np.clip(xs - x0, 0.0, 1.0)
    fy = np.clip(ys - y0, 0.0, 1.0)
    x0c = np.clip(x0, 0, w - 1)
    x1c = np.clip(x0 + 1, 0, w - 1)
    y0c = np.clip(y0, 0, h - 1)
    y1c = np.clip(y0 + 1, 0, h - 1)
    return (img[y0c, x0c] * (1 - fx) * (1 - fy) + img[y0c, x1c] * fx * (1 - fy)
            + img[y1c, x0c] * (1 - fx) * fy + img[y1c, x1c] * fx * fy)


def _cross(s, v, level):
    """Linear-interpolated positions where profile v crosses level."""
    outs = []
    for i in range(len(s) - 1):
        a, b = v[i] - level, v[i + 1] - level
        if (a <= 0 <= b) or (b <= 0 <= a):
            t = abs(a) / (abs(a) + abs(b) + 1e-12)
            outs.append(s[i] + t * (s[i + 1] - s[i]))
    return outs


def _width_outside_inside(s, v, lo, hi, cmin):
    span = hi - lo
    if abs(span) < cmin:
        return None
    v10, v90 = lo + 0.1 * span, lo + 0.9 * span
    c10, c90 = _cross(s, v, v10), _cross(s, v, v90)
    if not c10 or not c90:
        return None
    g = np.abs(np.gradient(np.asarray(v, dtype=float), s))
    gc = s[int(np.argmax(g))]
    w = abs(min(c10, key=lambda x: abs(x - gc))
            - min(c90, key=lambda x: abs(x - gc)))
    return float(w) if w <= 12.0 else None


def _luma(bgr):
    b = np.asarray(bgr, dtype=np.float32)
    return 0.114 * b[:, :, 0] + 0.587 * b[:, :, 1] + 0.299 * b[:, :, 2]


def source_edge_width(rgb_uint8_HxWx3, mask_bool, n=200):
    """Median (median, mean, count) of the source 10-90% luma edge width."""
    rgb = np.asarray(rgb_uint8_HxWx3)
    mask = np.asarray(mask_bool, dtype=bool)
    lum = _luma(rgb)
    s = np.linspace(-PROFILE_HALF, PROFILE_HALF, 33)
    ws = []
    for p, nrm in _contour_samples(mask, n):
        v = _bilinear(lum, p[0] + nrm[0] * s, p[1] + nrm[1] * s)
        w = _width_outside_inside(s, v, float(np.median(v[:5])),
                                  float(np.median(v[-5:])), LUMA_CONTRAST)
        if w is not None:
            ws.append(w)
    if not ws:
        raise ValueError("source_edge_width: no valid edge samples")
    return float(np.median(ws)), float(np.mean(ws)), len(ws)


def matte_edge_width(alpha_float32, n=150):
    """Median (median, mean, count) of the matte 10-90% alpha edge width."""
    a = np.clip(np.asarray(alpha_float32, dtype=np.float32), 0.0, 1.0)
    if a.ndim == 3:
        a = a[:, :, 0]
    s = np.linspace(-PROFILE_HALF, PROFILE_HALF, 33)
    ws = []
    for p, nrm in _contour_samples(a > 0.5, n):
        v = _bilinear(a, p[0] + nrm[0] * s, p[1] + nrm[1] * s)
        w = _width_outside_inside(s, v, 0.0, 1.0, 0.5)
        if w is not None:
            ws.append(w)
    if not ws:
        raise ValueError("matte_edge_width: no valid edge samples")
    return float(np.median(ws)), float(np.mean(ws)), len(ws)


def _band(sam_bool, half=BAND):
    mu = np.asarray(sam_bool, dtype=np.uint8)
    k = np.ones((2 * half + 1, 2 * half + 1), np.uint8)
    return ((cv2.dilate(mu, k) & ~cv2.erode(mu, k)) > 0)


def match_defocus(rgb_uint8_HxWx3, alpha_float32_HxW, fg_rgb_uint8_HxWx3, *,
                  source_width, cap=2.5):
    """Widen the matte transition to min(source_width, cap) -- or no-op.

    Returns (alpha', fg'). When the matte median width already reaches the
    target (within NOOP_TOL), both outputs are unchanged copies.
    """
    rgb = np.asarray(rgb_uint8_HxWx3)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must be HxWx3 uint8")
    h, w = rgb.shape[:2]
    a = np.asarray(alpha_float32_HxW, dtype=np.float32)
    if a.ndim == 3:
        a = a[:, :, 0]
    if a.shape != (h, w):
        a = cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
    a = np.clip(a, 0.0, 1.0)
    fg = np.asarray(fg_rgb_uint8_HxWx3)
    if fg.shape != rgb.shape:
        raise ValueError("fg must match rgb shape")

    sam = a > 0.5
    target = min(float(source_width), float(cap))
    if not sam.any():
        match_defocus.last_noop = True
        match_defocus.last_matte_width = 0.0
        match_defocus.last_target_width = target
        match_defocus.last_sigma = 0.0
        match_defocus.last_feathered_pixels = 0
        return a.copy(), fg.copy()

    matte_w, _, _ = matte_edge_width(a)
    match_defocus.last_matte_width = matte_w
    match_defocus.last_target_width = target
    if matte_w >= target - NOOP_TOL:
        match_defocus.last_noop = True
        match_defocus.last_sigma = 0.0
        match_defocus.last_feathered_pixels = 0
        return a.copy(), fg.copy()

    sigma = float(np.sqrt(max(target * target - matte_w * matte_w, 0.0))
                  / GAUSS_W10_90)
    match_defocus.last_noop = False
    match_defocus.last_sigma = sigma
    ksize = max(3, 2 * int(np.ceil(3 * sigma)) + 1)
    blurred = cv2.GaussianBlur(a, (ksize, ksize), sigma)

    # Thin-structure guard: local half-thickness within 6 px; feather only
    # where a core at least as thick as the target sits nearby. A 3-4 px
    # antenna shaft (half-thickness <= 2 < target) is fully protected,
    # while a body edge keeps its feather (thick core nearby). No erosion:
    # protected pixels keep their exact input alpha.
    dist_in = cv2.distanceTransform(sam.astype(np.uint8), cv2.DIST_L2, 5)
    local_thick = cv2.dilate(dist_in, np.ones((13, 13), np.uint8))
    protect = local_thick < target
    allow = _band(sam) & ~protect

    out = a.copy()
    out[allow] = np.clip(blurred[allow], 0.0, 1.0)
    match_defocus.last_feathered_pixels = int(allow.sum())

    # Decontaminated colour only: refresh feathered fg from the nearest
    # confident-interior pixel (same rule as refine_alpha step 5).
    fg_out = fg.copy()
    if allow.any():
        kc = np.ones((2 * (BAND + 1) + 1, 2 * (BAND + 1) + 1), np.uint8)
        conf = (cv2.erode(sam.astype(np.uint8), kc) > 0)
        if not conf.any():
            conf = sam
        nrow, ncol = nearest_interior_lut(conf)
        fg_out[allow] = rgb[nrow[allow], ncol[allow]]
    return out.astype(np.float32), fg_out


match_defocus.last_noop = True
match_defocus.last_matte_width = 0.0
match_defocus.last_target_width = 0.0
match_defocus.last_sigma = 0.0
match_defocus.last_feathered_pixels = 0


def match_defocus_v2(rgb_uint8_HxWx3, alpha_float32_HxW, fg_rgb_uint8_HxWx3, *,
                     source_width, cap=V2_CAP, margin=V2_MARGIN):
    """V2 defocus match (BRIEF-EDGE-DEFOCUS-V2).

    Target = min(source_width - margin, cap); a slightly crisper edge than
    the photo is fine. No-op (unchanged copies) when the matte median
    already reaches the target within NOOP_TOL, so sharp footage
    (clip-b, cg-robot) stays bit-identical. Otherwise the extra Gaussian
    sigma (quadrature) is applied only inside the edge band, re-pinned
    outside it, with fg refreshed from the nearest confident-interior
    pixel and thin structures guard-protected exactly as v1.

    The band widens from +-2 to +-3 px once the target exceeds 2.5 px:
    a +-2 px pin cannot carry a 3.3-4.4 px transition (roedeer median
    stalls at 4.05 vs a 4.43 target); +-3 px reaches 4.33 (guard-limited
    residue 0.10) while slovak/clip-a stay within 0.04 of target. +-4 px
    adds no further width (same 4.33) so 3 px is the minimal sufficient
    band. Returns (alpha', fg').
    """
    import math
    rgb = np.asarray(rgb_uint8_HxWx3)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must be HxWx3 uint8")
    h, w = rgb.shape[:2]
    a = np.asarray(alpha_float32_HxW, dtype=np.float32)
    if a.ndim == 3:
        a = a[:, :, 0]
    if a.shape != (h, w):
        a = cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
    a = np.clip(a, 0.0, 1.0)
    fg = np.asarray(fg_rgb_uint8_HxWx3)
    if fg.shape != rgb.shape:
        raise ValueError("fg must match rgb shape")

    sam = a > 0.5
    target = min(float(source_width) - float(margin), float(cap))
    half = BAND if target <= 2.5 + 1e-9 else V2_HALF
    if not sam.any():
        match_defocus_v2.last_noop = True
        match_defocus_v2.last_matte_width = 0.0
        match_defocus_v2.last_target_width = target
        match_defocus_v2.last_sigma = 0.0
        match_defocus_v2.last_feathered_pixels = 0
        return a.copy(), fg.copy()

    matte_w, _, _ = matte_edge_width(a)
    match_defocus_v2.last_matte_width = matte_w
    match_defocus_v2.last_target_width = target
    if matte_w >= target - NOOP_TOL:
        match_defocus_v2.last_noop = True
        match_defocus_v2.last_sigma = 0.0
        match_defocus_v2.last_feathered_pixels = 0
        return a.copy(), fg.copy()

    sigma = float(math.sqrt(max(target * target - matte_w * matte_w, 0.0))
                  / GAUSS_W10_90)
    match_defocus_v2.last_noop = False
    match_defocus_v2.last_sigma = sigma
    ksize = max(3, 2 * int(math.ceil(3 * sigma)) + 1)
    blurred = cv2.GaussianBlur(a, (ksize, ksize), sigma)

    # Same thin-structure guard as v1: feather only where a core at least
    # as thick as the target sits within 6 px. No erosion: protected
    # pixels keep their exact input alpha.
    dist_in = cv2.distanceTransform(sam.astype(np.uint8), cv2.DIST_L2, 5)
    local_thick = cv2.dilate(dist_in, np.ones((13, 13), np.uint8))
    protect = local_thick < target
    allow = _band(sam, half) & ~protect

    out = a.copy()
    out[allow] = np.clip(blurred[allow], 0.0, 1.0)
    match_defocus_v2.last_feathered_pixels = int(allow.sum())

    fg_out = fg.copy()
    if allow.any():
        kc = np.ones((2 * (half + 1) + 1, 2 * (half + 1) + 1), np.uint8)
        conf = (cv2.erode(sam.astype(np.uint8), kc) > 0)
        if not conf.any():
            conf = sam
        nrow, ncol = nearest_interior_lut(conf)
        fg_out[allow] = rgb[nrow[allow], ncol[allow]]
    return out.astype(np.float32), fg_out


match_defocus_v2.last_noop = True
match_defocus_v2.last_matte_width = 0.0
match_defocus_v2.last_target_width = 0.0
match_defocus_v2.last_sigma = 0.0
match_defocus_v2.last_feathered_pixels = 0


# Product integration (Main): one clip-level source width, so the feather
# does not pulse frame to frame, then v2 per frame on the written BGRA.
def clip_source_width(pairs, k=8):
    """Median source edge width over <= k evenly spaced (bgr, mask) pairs."""
    pairs = [p for p in pairs if np.asarray(p[1]).any()]
    if not pairs:
        return None
    idx = np.unique(np.linspace(0, len(pairs) - 1, min(k, len(pairs))).round().astype(int))
    ws = []
    for i in idx:
        try:
            ws.append(source_edge_width(pairs[i][0], pairs[i][1])[0])
        except ValueError:
            pass
    return float(np.median(ws)) if ws else None


def defocus_bgra(bgr, bgra, width):
    """v2 feather on a straight-alpha BGRA (cv2 order); fail-soft to input."""
    if width is None:
        return bgra
    try:
        a, fg = match_defocus_v2(bgr, bgra[:, :, 3].astype(np.float32) / 255.0,
                                 np.ascontiguousarray(bgra[:, :, :3]), source_width=width)
        a8 = np.round(np.clip(a, 0.0, 1.0) * 255).astype(np.uint8)
        out = np.dstack([fg, a8])
        out[a8 == 0] = 0  # product convention: transparent pixels are 0
        return out
    except Exception:  # noqa: BLE001 - an enhancement never fails the job
        return bgra
