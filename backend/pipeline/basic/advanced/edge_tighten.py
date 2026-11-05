"""Lane A -- tighten the matte edge when the source is sharper (BRIEF-EDGE-TIGHTEN-V1).

Mirror of ``edge_defocus.match_defocus``: the viewer now uses the baked
alpha linearly (no smoothstep remap), so the matte transition width is
what the user sees. On sharp CG footage the refined matte (~2.4 px
10-90%) is systematically SOFTER than the photo edge it is cut from
(cg-robot ~1.6 px, clip-b ~1.7 px), which reads as soft/blurry limbs.

``match_tighten(rgb, alpha, fg, *, source_width, ...)`` steepens the
alpha transition toward the measured source width with a monotone
contrast curve around 0.5 (normalised logistic, ``f(0)=0, f(0.5)=0.5,
f(1)=1``). It fires only when the source is clearly sharper than the
matte (``source_width < ratio * matte_width``, default ``ratio=0.8``);
otherwise it returns unchanged copies (strict no-op -- soft natural
footage such as slovakdeer/clip-a/roedeer stays bit-identical).

Why a pointwise curve instead of a joint-bilateral/luma-guided
refinement: the curve is exactly iso-preserving (``f(0.5)=0.5`` for
every pixel, so the 0.5 contour cannot drift by construction), monotone
(no new halos or reversals), and introduces no new colours (the
decontaminated fg from ``refine_alpha`` stays valid pixel-for-pixel, so
fg is returned unchanged). Steepening concentrates mass instead of
spreading it, so unlike Gaussian feathering it cannot erode thin
structures -- hence there is NO thin-structure guard: the antenna keeps
0.999x of its input mass unguarded (measured), and the 0.5 iso shift is
subpixel (measured <= 0.30 px). The curve is applied only inside the
+-2 px SAM-edge band; everything outside is re-pinned (interior 1,
exterior 0 -- identical values anyway since f fixes 0 and 1 exactly).

Calibration is closed-loop: the open-loop slope ``matte/target``
undershoots (a 1.53x slope narrows 2.43 px to only 1.94 px), so the
slope is corrected multiplicatively (``s *= measured/target``, capped
at ``slope_cap``) and re-applied to the ORIGINAL matte until the
measured width lands within ``tol`` of the target (default 0.12 px,
max 4 iterations). Deterministic: ``matte_edge_width`` has no
randomness.

``match_edge`` is the integration dispatcher (Basic ``refine-alpha``
and Advanced ``combine`` output): exactly one of ``tighten`` /
``defocus`` (v2, ``match_defocus_v2``) / ``noop`` fires per frame, so
the two corrections can never fight each other.

No network, no models, no GPU.
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # `python -I` strips cwd from sys.path

import cv2
import numpy as np

from edge_defocus import (_band, matte_edge_width, match_defocus_v2,
                          NOOP_TOL)

TIGHTEN_RATIO = 0.8   # fire only when source < 0.8x matte (brief's rule)
TIGHTEN_FLOOR = 1.0   # never target below 1.0 px (avoids absurd slopes)
TIGHTEN_SLOPE_CAP = 3.0  # steepest allowed midpoint slope (no posterizing)
TIGHTEN_TOL = 0.12    # stop when |measured - target| <= tol (px)
TIGHTEN_MAX_ITER = 4


def _slope_to_k(slope):
    """Logistic steepness k whose midpoint slope is ``slope``.

    f(a) = (sigmoid(k*(a-0.5)) - g0) / (g1 - g0), g0 = sigmoid(-k/2),
    g1 = sigmoid(k/2). Midpoint slope = (k/4) / tanh(k/4), solved by
    bisection (monotone in k). Slope 1 -> k -> 0 -> identity.
    """
    slope = max(float(slope), 1.0 + 1e-9)
    lo, hi = 1e-9, 100.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if (mid / 4.0) / np.tanh(mid / 4.0) < slope:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def _contrast_curve(a, k):
    """Monotone steepening remap, f(0)=0, f(0.5)=0.5, f(1)=1 exactly."""
    g0 = 1.0 / (1.0 + np.exp(k * 0.5))
    g1 = 1.0 / (1.0 + np.exp(-k * 0.5))
    d = g1 - g0
    v = np.asarray(a, dtype=np.float64)
    return np.clip((1.0 / (1.0 + np.exp(-k * (v - 0.5))) - g0) / d,
                   0.0, 1.0).astype(np.float32)


def match_tighten(rgb_uint8_HxWx3, alpha_float32_HxW, fg_rgb_uint8_HxWx3, *,
                  source_width, ratio=TIGHTEN_RATIO, floor=TIGHTEN_FLOOR,
                  slope_cap=TIGHTEN_SLOPE_CAP, tol=TIGHTEN_TOL,
                  max_iter=TIGHTEN_MAX_ITER):
    """Steepen the matte transition toward ``source_width`` -- or no-op.

    Returns (alpha', fg'). When ``source_width >= ratio * matte_width``
    (matte already as crisp as, or crisper than, the photo) both outputs
    are unchanged copies. Otherwise the contrast curve fires inside the
    +-2 px SAM-edge band; fg is returned unchanged (the curve adds no
    colour -- every band pixel keeps its decontaminated interior colour).
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

    def _noop():
        match_tighten.last_noop = True
        match_tighten.last_iterations = 0
        match_tighten.last_slope = 1.0
        match_tighten.last_k = 0.0
        match_tighten.last_residue = 0.0
        match_tighten.last_tightened_pixels = 0
        return a.copy(), fg.copy()

    sam = a > 0.5
    if not sam.any():
        match_tighten.last_matte_width = 0.0
        match_tighten.last_target_width = float(source_width)
        return _noop()

    matte_w, _, _ = matte_edge_width(a)
    match_tighten.last_matte_width = matte_w
    target = min(max(float(source_width), float(floor)), matte_w)
    match_tighten.last_target_width = target
    if float(source_width) >= ratio * matte_w:
        return _noop()

    band = _band(sam)  # +-2 px, same band as refine_alpha / defocus
    match_tighten.last_noop = False
    match_tighten.last_tightened_pixels = int(band.sum())

    slope = max(matte_w / max(target, 1e-9), 1.0 + 1e-9)
    best = None  # (residue, out)
    out = a.copy()
    for it in range(max(1, int(max_iter))):
        k = _slope_to_k(min(slope, float(slope_cap)))
        trial = a.copy()
        trial[band] = _contrast_curve(a[band], k)
        m, _, _ = matte_edge_width(trial)
        residue = abs(m - target)
        if best is None or residue < best[0]:
            best = (residue, trial, m, min(slope, float(slope_cap)), k)
        if residue <= tol:
            break
        if slope >= float(slope_cap) - 1e-12 and m < target:
            break  # at the cap and already past the target: best effort
        slope = float(np.clip(slope * m / max(target, 1e-9),
                              1.0 + 1e-9, float(slope_cap)))
    residue, out, m, slope, k = best
    match_tighten.last_iterations = it + 1
    match_tighten.last_slope = slope
    match_tighten.last_k = k
    match_tighten.last_residue = m - target
    return out.astype(np.float32), fg.copy()


match_tighten.last_noop = True
match_tighten.last_matte_width = 0.0
match_tighten.last_target_width = 0.0
match_tighten.last_slope = 1.0
match_tighten.last_k = 0.0
match_tighten.last_iterations = 0
match_tighten.last_residue = 0.0
match_tighten.last_tightened_pixels = 0


def match_edge(rgb_uint8_HxWx3, alpha_float32_HxW, fg_rgb_uint8_HxWx3, *,
               source_width, defocus_cap=4.5, defocus_margin=0.3,
               tighten_ratio=TIGHTEN_RATIO):
    """Route to tighten / defocus-v2 / noop -- exactly one fires.

    - ``tighten`` when the photo edge is clearly sharper than the matte
      (``source < ratio * matte``).
    - ``defocus`` (``match_defocus_v2``) when the matte is clearly
      crisper than the photo (``matte < min(source - margin, cap)``).
    - otherwise ``noop`` (unchanged copies).
    The two corrections are mutually exclusive by construction: the
    tighten trigger implies ``matte > source / ratio > source`` while
    defocus needs ``matte < source - margin``.
    Returns (alpha', fg', mode) with mode in {'tighten','defocus','noop'}.
    """
    a = np.asarray(alpha_float32_HxW, dtype=np.float32)
    if a.ndim == 3:
        a = a[:, :, 0]
    sam = np.clip(a, 0.0, 1.0) > 0.5
    if not sam.any():
        match_edge.last_mode = "noop"
        return a.copy(), np.asarray(fg_rgb_uint8_HxWx3).copy(), "noop"
    matte_w, _, _ = matte_edge_width(a)
    if float(source_width) < tighten_ratio * matte_w:
        out = match_tighten(rgb_uint8_HxWx3, alpha_float32_HxW,
                            fg_rgb_uint8_HxWx3, source_width=source_width,
                            ratio=tighten_ratio)
        match_edge.last_mode = "tighten"
        return out[0], out[1], "tighten"
    dtgt = min(float(source_width) - defocus_margin, float(defocus_cap))
    if matte_w < dtgt - NOOP_TOL:
        out = match_defocus_v2(rgb_uint8_HxWx3, alpha_float32_HxW,
                               fg_rgb_uint8_HxWx3,
                               source_width=source_width,
                               cap=defocus_cap, margin=defocus_margin)
        match_edge.last_mode = "defocus"
        return out[0], out[1], "defocus"
    match_edge.last_mode = "noop"
    return (np.asarray(alpha_float32_HxW, dtype=np.float32).copy(),
            np.asarray(fg_rgb_uint8_HxWx3).copy(), "noop")


match_edge.last_mode = "noop"
