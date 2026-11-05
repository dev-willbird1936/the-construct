"""Lite 2D composite entry point for the product runner (single batch call).

Called ONCE per job by backend/app/runner-lite.js after packing, before
work/ cleanup. Never called inside a per-frame loop.

Inputs (data contract, see INTEGRATION.md):
  --specimen DIR       specimen dir; composite.png + composite.json go here.
  --video MP4          the upload clip; kept source frames are decoded with
      --frames-dir DIR cv2.VideoCapture seeks (exactly one of the two).
      --frames-dir holds kf_*.jpg stills used directly (fixture tests).
  --frames-json PATH   {"fps":..,"width":..,"height":..,"maskValue":1,
      "frames":[{"mask":path,"image":path|null,"sourceFrameIndex":int,
      "timestamp":float,"concept":str}]}. mask files: 4-channel RGBA ->
      alpha>127 is the mask; otherwise channel 0 == maskValue. Entries may
      share a sourceFrameIndex (multi-object jobs); masks union per frame
      and every object is composited -- a second object is never dropped.
      image=null decodes from --video; otherwise the still is used.

Behaviour: travel (cumulative bbox-centroid path / median width over
union masks) >= 1.5W -> chronophotograph (opaque poses, 0.8W spacing,
dilated-3px overlap veto, min 5, 16:9 union+8% frame to 1920x1080 at
<=2.5x); else -> pose filmstrip (<=6 diverse poses; unusable small-area
or border-truncated frames excluded unless full-bleed close-up; pose
change counts shape+scale+position; subject-following landscape tiles when
kept scale varies >1.6x or the camera jumps, else the shared tile (tighter
per-tile crops on portrait), dark canvas grid, timestamps). Filmstrip tiles show source pixels directly; the matte only
decides crop and framing, never a recomposite (which bakes a dark edge). A 1080x1350 portrait twin is always rendered
too (composite-portrait.png): same route and poses, layouts re-searched
for the tall canvas (grids, or chrono row-stacks). Matte:
vendor/refine_alpha.py next to this file, defaults, temporal OFF
(no prev_alpha). Never stacks a low-motion clip; never invents pixels
beyond the 2.5x cap.

Fail closed: any contract/decoding/selection violation exits 2 with a
clear stderr message and writes NOTHING (outputs are built in memory and
written last). All pixels stay BGR (cv2.imwrite order); the test suite
verifies channel order with an independent zlib PNG decoder.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util as _ilu
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = _ilu.spec_from_file_location(
    "vendor_refine_alpha", os.path.join(_HERE, "vendor", "refine_alpha.py"))
_vendor = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_vendor)
refine_alpha = _vendor.refine_alpha

TRAVEL_ROUTE = 1.5
IOU_T = 0.3
MIN_SPACING_W = 0.8
DILATE_PX = 3
MIN_KEEP, MAX_KEEP = 5, 8
# V5 filmstrip: total-pose-change threshold (max pairwise 1-IoU over usable
# frames). Below it, four distinct poses do not exist: exactly 3 honest
# panels (first, last + most-distant middle) at a larger size. Measured:
# clip-b 0.11 < 0.30; roedeer/clip-a ~0.37, slovakdeer 0.45 keep the full set.
DMAX_FEW_PANELS = 0.30
# V6 usable-frame rules: drop present frames whose mask area is below
# 40% of the clip median, or whose border-touch share (border pixels /
# perimeter pixels) exceeds 0.15. Exception: when >=80% of present frames
# exceed the touch share the subject is full-bleed/close-up (walker path,
# clip-a) and the touch rule is skipped; the area rule still applies.
AREA_FRAC = 0.4
TOUCH_T = 0.15
CLOSEUP_FRAC = 0.8
# V6 motion: total pose change counts centred-shape change plus linear
# scale change (|ln(areaA/areaB)|) plus in-frame position change (centroid
# step / bodySize, bodySize = sqrt(median usable area)). Threshold 0.30
# unchanged; genuinely static subjects (clip-b) stay under it.
# V6 tiles: linear scale sqrt(maxArea/minArea) > 1.6 over the kept frames,
# or a consecutive-kept centroid jump > 0.5 body sizes (camera move),
# selects per-frame subject-following crops at one common tile size with
# the largest subject filling 60% of the tile height; else the shared crop.
TILE_SCALE_T = 1.6
TILE_JUMP_T = 0.5
SUBJECT_FILL = 0.6
# V6 picker: a candidate within 0.3 s of an already-chosen panel is
# skipped while other usable frames exist (endpoints anchored first).
MIN_GAP_S = 0.3
# V10 sharpness snap (fast subjects): after the v9 pick, each chosen frame
# looks at neighbours within +-3 source frames that have a usable mask.
# Sharpness = variance of the Laplacian (ksize 3) of grey inside the
# subject mask dilated 3 px. Snap to the sharpest neighbour only when
# gain >= 1.15x, centred IoU >= 0.85, area ratio within 0.9-1.1, and the
# existing time-gap (>= 0.3 s) plus usable/truncation rules still hold.
SHARP_SNAP_RADIUS = 3
SHARP_GAIN_T = 1.15
SHARP_IOU_T = 0.85
SHARP_AREA_LO = 0.9
SHARP_AREA_HI = 1.1
# V5 landscape layout floor: grid-fill may not shrink the min
# subject-height fraction below this (worst V2 value is 0.33).
SUBJ_FLOOR = 0.28
MARGIN = 0.08
MAX_UPSCALE = 2.5
GUTTER = 16
MIN_MARGIN = 48
TS_BLOCK = 46
# V12 sensor-grain gate (roedeer IR): visible grain load V = mres x
# lowfrac x scale, where mres = mean |display panel - medianBlur5| on
# low-texture display background (local 5x5 variance < 25), lowfrac =
# share of panel bg that is low-texture (grain has nowhere to hide),
# scale = display magnification (subpixel noise becomes visible grain
# when magnified). Gate fires at V >= GRAIN_GATE: roedeer measures 1.49,
# the nearest clip 0.79. Daylight texture (blackcat grass) holds V down
# through lowfrac even when raw amplitude is high; clean clips
# (clip-b/clip-a) read near zero through mres. When the gate fires, each
# panel crop is NLM-denoised at source scale BEFORE compositing
# (edge-preserving, h tied to mres/scale); otherwise the pixel path is
# untouched and the JSON gains no keys (byte-identical outputs).
GRAIN_GATE = 1.1
GRAIN_H_MIN, GRAIN_H_MAX = 3.0, 8.0
GRAIN_LOWTEX_VAR = 25.0
GRAIN_MIN_LOWTEX_PX = 200
# V7 LEG / V8 TILE / V7 CLAHE were dropped in v9 (per Main): landscape
# and portrait are scored per-stage by choose_stage_grid; panels stay
# source-identical (no lift, no aspect change). Their constants and
# choosers were removed in v11; layout_score + layout_candidates remain
# (v9 per-stage scoring uses them).


def fail(msg: str) -> int:
    sys.stderr.write(f"composite_lite: error: {msg}\n")
    return 2


def load_mask(path: str, value: int) -> np.ndarray:
    m = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if m is None:
        raise ValueError(f"unreadable mask {path}")
    if m.ndim == 3 and m.shape[2] == 4:
        return m[:, :, 3] > 127
    if m.ndim == 3:
        m = m[:, :, 0]
    return m == value


def border_touch_share(mask: np.ndarray) -> float:
    """Share of the mask perimeter that touches the image border.
    Counted by erosion (perimeter pixels) and a 1px border mask: no
    contour degeneracy on masks that span the frame."""
    mu = mask.astype(np.uint8)
    # Zero border: a mask pixel on the image edge counts as perimeter
    # (cv2's default replicate border would hide it, and a full-frame
    # mask would score perimeter 0).
    er = cv2.erode(mu, np.ones((3, 3), np.uint8),
                   borderType=cv2.BORDER_CONSTANT, borderValue=0)
    per = int(np.count_nonzero(mu & (1 - er)))
    if per == 0:
        return 0.0
    bd = np.zeros_like(mu)
    bd[0, :] = bd[-1, :] = bd[:, 0] = bd[:, -1] = 1
    return float(np.count_nonzero(mu & bd)) / per


_USABLE_MEMO: dict = {}


def usable_frames(union, present):
    """V6 usable filter over present (non-empty) frames. Returns
    (usable list, stats dict). Never invents or alters pixels.
    Memoised per (union, present): the landscape and portrait passes ask
    the same question of the same masks."""
    key = (id(union), tuple(present))
    if key in _USABLE_MEMO:
        usable, stats = _USABLE_MEMO[key]
        return list(usable), dict(stats)
    areas = {i: int(np.count_nonzero(union[i])) for i in present}
    med = float(np.median([areas[i] for i in present]))
    shares = {i: border_touch_share(union[i]) for i in present}
    closeup = sum(1 for i in present if shares[i] > TOUCH_T) / len(present) \
        >= CLOSEUP_FRAC
    usable, ex_area, ex_touch = [], 0, 0
    for i in present:
        if areas[i] < AREA_FRAC * med:
            ex_area += 1
            continue
        if not closeup and shares[i] > TOUCH_T:
            ex_touch += 1
            continue
        usable.append(i)
    stats = {"present": len(present), "usable": len(usable),
             "excludedSmallArea": ex_area, "excludedBorderTruncated": ex_touch,
             "closeupException": bool(closeup),
             "medianAreaPx": round(med, 1)}
    _USABLE_MEMO[key] = (list(usable), dict(stats))
    return usable, stats


def tile_decision(sub, boxes, cen, uareas, body_units, fw, fh):
    """V6 tile mode over the kept frames. Linear scale
    sqrt(maxArea/minArea) > 1.6, or a consecutive-kept centroid jump
    > 0.5 body sizes (camera move), selects subject-following crops:
    one common tile centred on each frame's own subject, the largest
    subject filling SUBJECT_FILL of the tile height (never cropped).
    Returns (mode, tw, th, uw, uh, scaleRatio, jump)."""
    aa = [uareas[i] for i in sub]
    sratio = float(np.sqrt(max(aa) / min(aa)))
    steps = [float(np.hypot(cen[sub[k + 1]][0] - cen[sub[k]][0],
                            cen[sub[k + 1]][1] - cen[sub[k]][1])) / body_units
             for k in range(len(sub) - 1)]
    jump = max(steps) if steps else 0.0
    if sratio > TILE_SCALE_T or jump > TILE_JUMP_T:
        kh = max(boxes[i][3] - boxes[i][1] + 1 for i in sub)
        kw = max(boxes[i][2] - boxes[i][0] + 1 for i in sub)
        return ("subject", min(int(np.ceil(kw / SUBJECT_FILL)), fw),
                min(int(np.ceil(kh / SUBJECT_FILL)), fh),
                kw, kh, sratio, jump)
    tw, th, uw, uh = shared_tile_for(sub, boxes, fw, fh)
    return ("shared", tw, th, uw, uh, sratio, jump)


def shared_tile_for(sub, boxes, fw, fh):
    """Shared crop over kept frames: union of centred bboxes + 20%.
    (V5 tile_for, lifted to module level for reuse and testing.)"""
    bb = [boxes[i] for i in sub]
    ux0 = min(b[0] - (b[2] + b[0]) / 2 for b in bb)
    ux1 = max(b[2] - (b[2] + b[0]) / 2 for b in bb)
    uy0 = min(b[1] - (b[3] + b[1]) / 2 for b in bb)
    uy1 = max(b[3] - (b[3] + b[1]) / 2 for b in bb)
    uw, uh = ux1 - ux0 + 1, uy1 - uy0 + 1
    return min(int(round(uw * 1.2)), fw), min(int(round(uh * 1.2)), fh), uw, uh


def bbox_of(mask: np.ndarray):
    # Row/column any() instead of nonzero(): same box, no index arrays.
    m = np.asarray(mask)
    rows = np.flatnonzero(m.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(m.any(axis=0))
    return (int(cols[0]), int(rows[0]), int(cols[-1]), int(rows[-1]))


def iou(a: np.ndarray, b: np.ndarray) -> float:
    # count_nonzero: same counts as .sum() on bool masks, ~5x faster.
    inter = np.count_nonzero(np.logical_and(a, b))
    union = np.count_nonzero(np.logical_or(a, b))
    return float(inter) / float(union) if union else 1.0


def centred_pair_iou(ua: np.ndarray, ub: np.ndarray) -> float:
    """V10 centred pose IoU: each mask's bbox crop centred in the shared
    max(H, W) canvas. Pair-specific (no global normalisation)."""
    ba, bb = bbox_of(ua), bbox_of(ub)
    if ba is None or bb is None:
        return 0.0
    ha, wa = ba[3] - ba[1] + 1, ba[2] - ba[0] + 1
    hb, wb = bb[3] - bb[1] + 1, bb[2] - bb[0] + 1
    H, W = max(ha, hb), max(wa, wb)
    ca = np.zeros((H, W), bool)
    cb = np.zeros((H, W), bool)
    a = np.asarray(ua)[ba[1]:ba[3] + 1, ba[0]:ba[2] + 1]
    b = np.asarray(ub)[bb[1]:bb[3] + 1, bb[0]:bb[2] + 1]
    ca[(H - ha) // 2:(H - ha) // 2 + ha,
       (W - wa) // 2:(W - wa) // 2 + wa] = a
    cb[(H - hb) // 2:(H - hb) // 2 + hb,
       (W - wb) // 2:(W - wb) // 2 + wb] = b
    return iou(ca, cb)


def sharp_dilated_var(gray: np.ndarray, mask: np.ndarray) -> float:
    """V10 sharpness: variance of Laplacian (ksize 3) inside the mask
    dilated 3 px (3x3 kernel, 3 iterations)."""
    mu = np.asarray(mask).astype(np.uint8)
    dil = cv2.dilate(mu, np.ones((3, 3), np.uint8), iterations=3) > 0
    if dil.sum() < 50:
        return float("nan")
    lap = cv2.Laplacian(gray, cv2.CV_64F, ksize=3)
    return float(lap[dil].var())


def snap_picks(picks_sorted: list, union: dict, usable_set: set,
               t_of: dict, sharp_dil: dict) -> tuple:
    """V10 sharpness snap over a time-sorted pick list.
    Returns (new_sorted, infos) where infos aligns with new_sorted:
    {"from": int, "to": int, "gain": float} or None per panel.
    Neighbours: usable frames within +-SHARP_SNAP_RADIUS source frames.
    Snap to the sharpest neighbour only when gain >= SHARP_GAIN_T,
    centred IoU >= SHARP_IOU_T, area ratio within [LO, HI], and the
    MIN_GAP_S time gap holds vs already-snapped plus remaining picks."""
    picks_sorted = sorted(picks_sorted)
    picked = set(picks_sorted)
    result, info_of = [], {}
    taken = set()
    processed = set()
    for pos, p in enumerate(picks_sorted):
        sp = sharp_dil.get(p, float("nan"))
        best, best_s = None, None
        if np.isfinite(sp) and sp > 0:
            for fj in sorted(usable_set):
                if fj == p or abs(fj - p) > SHARP_SNAP_RADIUS:
                    continue
                if fj in picked or fj in taken:
                    continue
                sn = sharp_dil.get(fj, float("nan"))
                if not np.isfinite(sn):
                    continue
                gain = float(sn) / float(sp)
                if gain < SHARP_GAIN_T:
                    continue
                ap = int(np.count_nonzero(np.asarray(union[p])))
                an = int(np.count_nonzero(np.asarray(union[fj])))
                if ap <= 0:
                    continue
                ratio = an / ap
                if not (SHARP_AREA_LO <= ratio <= SHARP_AREA_HI):
                    continue
                if centred_pair_iou(union[p], union[fj]) < SHARP_IOU_T:
                    continue
                tn = float(t_of[fj])
                ok = True
                for r in result:
                    if abs(tn - float(t_of[r])) < MIN_GAP_S - 1e-9:
                        ok = False
                        break
                if ok:
                    for q in picks_sorted:
                        if q == p or q in processed:
                            continue  # past picks checked via result times
                        if abs(tn - float(t_of[q])) < MIN_GAP_S - 1e-9:
                            ok = False
                            break
                if not ok:
                    continue
                if best is None or sn > best_s:
                    best, best_s = fj, sn
        if best is not None:
            result.append(best)
            taken.add(best)
            processed.add(p)
            info_of[best] = {"from": int(p), "to": int(best),
                             "gain": round(float(best_s) / float(sp), 4)}
        else:
            result.append(p)
            processed.add(p)
            info_of[p] = None
    order = sorted(result)
    return order, [info_of[v] for v in order]


def snap_insertion_order(chosen: list, union: dict, usable_set: set,
                         t_of: dict, sharp_dil: dict) -> tuple:
    """Snap a filmstrip `chosen` list (insertion order) via the sorted
    snap, preserving insertion order. Returns (snapped_chosen, old_to_new,
    gain_of_new)."""
    srt = sorted(chosen)
    _, infos = snap_picks(srt, union, usable_set, t_of, sharp_dil)
    # Rebuild mapping from infos (from/to) which carry true old->new.
    mapping = {int(p): int(p) for p in srt}
    gain_of = {}
    for inf in infos:
        if inf is not None:
            mapping[int(inf["from"])] = int(inf["to"])
            gain_of[int(inf["to"])] = float(inf["gain"])
    return [mapping[int(x)] for x in chosen], mapping, gain_of


def decode_at(cap: cv2.VideoCapture, t: float, ref_shape) -> np.ndarray:
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
    ok, fr = cap.read()
    if not ok or fr is None:
        raise ValueError(f"could not decode t={t:.3f}s")
    if fr.shape[:2] != ref_shape:
        raise ValueError(f"frame size {fr.shape[:2]} != declared {ref_shape}")
    return fr


class SeqFrames:
    """Decode-order frame access by source frame index, without seeks.

    A CAP_PROP_POS_MSEC seek re-decodes from the previous keyframe on every
    call (measured: ~0.13 s per frame, 13 s of a 21 s composite on a
    210-frame clip). Requests arrive mostly in ascending order, so frames
    are read forward once (grab() skips colour conversion for frames
    nobody asked for); a backward request reopens the clip. A small LRU
    keeps the frames the landscape and portrait passes re-ask for.
    Frame index n is the same decode-order index ffmpeg's select=n uses
    for the masks, so this is at least as exact as the time seek."""

    def __init__(self, path: str, shape, keep: int = 24):
        from collections import OrderedDict
        self.path, self.shape, self.keep = path, shape, keep
        self.cache = OrderedDict()
        self.cap = None
        self.next = 0

    def _open(self):
        if self.cap is not None:
            self.cap.release()
        self.cap = cv2.VideoCapture(self.path)
        if not self.cap.isOpened():
            raise ValueError(f"cannot open video {self.path}")
        self.next = 0

    def get(self, fi: int) -> np.ndarray:
        fi = int(fi)
        if fi in self.cache:
            self.cache.move_to_end(fi)
            return self.cache[fi]
        if self.cap is None or fi < self.next:
            self._open()
        while self.next < fi:
            if not self.cap.grab():
                raise ValueError(f"could not decode frame {fi}")
            self.next += 1
        ok, fr = self.cap.read()
        if not ok or fr is None:
            raise ValueError(f"could not decode frame {fi}")
        self.next += 1
        if fr.shape[:2] != self.shape:
            raise ValueError(f"frame size {fr.shape[:2]} != declared {self.shape}")
        self.cache[fi] = fr
        while len(self.cache) > self.keep:
            self.cache.popitem(last=False)
        return fr

    def release(self):
        if self.cap is not None:
            self.cap.release()


def refine_default(frame: np.ndarray, mask: np.ndarray):
    """Vendor matte, defaults, temporal OFF. Returns (alpha, fg)."""
    return refine_alpha(frame, mask)


def soften_band(rgb: np.ndarray, fg: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """v5 rim treatment: 0.5/0.5 source blend in the +-2px band, then band
    saturation clamped to interior-median x1.10."""
    mu = mask.astype(np.uint8)
    k = np.ones((5, 5), np.uint8)
    band = (cv2.dilate(mu, k) & ~cv2.erode(mu, k)).astype(bool)
    if not band.any():
        return fg
    inner = cv2.erode(mu, np.ones((3, 3), np.uint8), iterations=2).astype(bool)
    out = fg.copy()
    blend = np.clip(np.round(0.5 * rgb.astype(np.float32)
                             + 0.5 * fg.astype(np.float32)), 0, 255).astype(np.uint8)
    out[band] = blend[band]
    med = float(np.median(cv2.cvtColor(rgb, cv2.COLOR_BGR2HSV)[:, :, 1][inner])) \
        if inner.any() else 255.0
    hsv = cv2.cvtColor(out, cv2.COLOR_BGR2HSV).astype(np.float32)
    s = hsv[:, :, 1]
    over = band & (s > med * 1.10)
    s[over] = med * 1.10
    hsv[:, :, 1] = np.clip(np.round(s), 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


def tile_crop(fr: np.ndarray, cx: float, cy: float, tw_: int, th_: int):
    """Source-pixel tile crop centred on (cx, cy), clamped to frame.
    Returns (crop float32, tx0, ty0). Byte-identical to the source."""
    fwh, fhh = fr.shape[1], fr.shape[0]
    tx0 = int(round(min(max(cx - tw_ / 2.0, 0.0), fwh - tw_)))
    ty0 = int(round(min(max(cy - th_ / 2.0, 0.0), fhh - th_)))
    return fr[ty0:ty0 + th_, tx0:tx0 + tw_].astype(np.float32), tx0, ty0


def layout_candidates(n: int) -> list:
    """V7 exact-N grid candidates: (1,N), (N,1), plus (2,N/2) and
    (N/2,2) when N is even. Order is deterministic; ties keep (1,N)."""
    grids = [(1, n), (n, 1)]
    if n % 2 == 0:
        grids += [(2, n // 2), (n // 2, 2)]
    seen, out = set(), []
    for g in grids:
        if g not in seen:
            seen.add(g)
            out.append(g)
    return out


def layout_score(areas: list) -> list:
    """V7 grid score from per-candidate (area720, areaPhone):
    min-normalised + 1e-3 x sum (worst viewport first, sum breaks ties)."""
    m1 = max(a[0] for a in areas)
    m2 = max(a[1] for a in areas)
    return [min(a1 / m1, a2 / m2) + 1e-3 * (a1 / m1 + a2 / m2)
            for a1, a2 in areas]


STAGE_PAD = 20
VIEWPORTS_LAND = ((1280, 720), (1440, 900))
VIEWPORTS_PORT = ((390, 844), (412, 915))


def stage_viewport_areas(rows: int, cols: int, tw: int, th: int, s: float,
                           mask_sum: float, viewports) -> list:
    """V9 per-stage displayed subject area through the product viewer crop.
    Content bbox = tiles + gutters + caption blocks (TS_BLOCK) at display
    scale, expanded by STAGE_PAD (20px each side) exactly as the viewer
    crops tileRects (+20 pad, +46 caption) before fitting into the stage.
    Display scale source->viewport is s (canvas fit) x vs (viewport fit);
    subject px = mask_sum x scale^2."""
    dw, dh = tw * s, th * s
    gw = cols * dw + (cols - 1) * GUTTER + 2 * STAGE_PAD
    gh = rows * (dh + TS_BLOCK) + (rows - 1) * GUTTER + 2 * STAGE_PAD
    out = []
    for vw, vh in viewports:
        vs = min(vw / gw, vh / gh)
        area = mask_sum * (s * vs) ** 2
        out.append({"viewport": [vw, vh], "fitScale": round(vs, 4),
                    "subjectPx": round(area, 1),
                    "share": round(area / (vw * vh), 5)})
    return out


def choose_stage_grid(v6rows: int, v6cols: int, tw: int, th: int,
                        mask_sum: float, cw: int = 1920, ch: int = 1080,
                        cap: float = MAX_UPSCALE, viewports=VIEWPORTS_LAND,
                        stage: str = "landscape") -> tuple:
    """V9 per-stage grid choice over exact-N grids (N = v6rows x v6cols).
    Scores each candidate by displayed subject area through the viewer
    crop (stage_viewport_areas) into the two stage viewports, with the
    v7 min-normalised worst-viewport-first score. The winner is adopted
    only when its displayed area strictly beats the v6 grid on BOTH
    stage viewports (never shrink vs v6); else the v6 grid stands.
    Deterministic."""
    n = v6rows * v6cols
    cands = layout_candidates(n)
    areas, scales = [], []
    for (r, c) in cands:
        sr = min((cw - 96 - (c - 1) * GUTTER) / (c * tw),
                 (ch - 96 - r * TS_BLOCK - (r - 1) * GUTTER) / (r * th))
        s = min(sr, cap)
        va = stage_viewport_areas(r, c, tw, th, s, mask_sum, viewports)
        areas.append((va[0]["subjectPx"], va[1]["subjectPx"]))
        scales.append((sr, s, va))
    scores = layout_score(areas)
    win, win_key = 0, None
    for k in range(len(cands)):
        key = round(scores[k], 9)
        if win_key is None or key > win_key:
            win, win_key = k, key
    v6idx = cands.index((v6rows, v6cols))
    v6a, wina = areas[v6idx], areas[win]
    adopted = (wina[0] > v6a[0] * (1 + 1e-9)
               and wina[1] > v6a[1] * (1 + 1e-9))
    pick = win if adopted else v6idx
    r, c = cands[pick]
    sr, s, _ = scales[pick]
    info = {"rule": "per-stage min-normalised viewport subject area "
                      "through viewer crop (tileRects +20 pad +46 caption)",
            "stage": stage,
            "viewports": [list(v) for v in viewports],
            "v6Grid": [v6rows, v6cols],
            "chosenGrid": [r, c],
            "adoptedStageWinner": bool(adopted),
            "maskSumPx": round(mask_sum, 1),
            "candidates": [{"grid": [cr, cc],
                              "area0Px": a[0], "share0": scales[k][2][0]["share"],
                              "area1Px": a[1], "share1": scales[k][2][1]["share"],
                              "canvasScale": round(scales[k][1], 4),
                              "score": round(scores[k], 5)}
                             for k, ((cr, cc), a) in enumerate(zip(cands, areas))]}
    return (r, c), sr, s, info


def grid_misalignment(rects: list, rows: int, cols: int) -> int:
    """Max tile-edge deviation inside shared rows/cols, in px. Tiles in
    one row must share top and height; tiles in one column share left
    and width. Uniform grids score 0."""
    worst = 0
    for r in range(rows):
        row = rects[r * cols:(r + 1) * cols]
        if len(row) > 1:
            worst = max(worst, max(b[1] for b in row) - min(b[1] for b in row))
            worst = max(worst, max(b[3] for b in row) - min(b[3] for b in row))
    for c in range(cols):
        col = [rects[r * cols + c] for r in range(rows)
               if r * cols + c < len(rects)]
        if len(col) > 1:
            worst = max(worst, max(b[0] for b in col) - min(b[0] for b in col))
            worst = max(worst, max(b[2] for b in col) - min(b[2] for b in col))
    return worst


def rounded_mask(h: int, w: int, r: int) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    cv2.rectangle(m, (r, 0), (w - r - 1, h - 1), 1, -1)
    cv2.rectangle(m, (0, r), (w - 1, h - r - 1), 1, -1)
    for cx, cy in [(r, r), (w - r - 1, r), (r, h - r - 1), (w - r - 1, h - r - 1)]:
        cv2.circle(m, (cx, cy), r, 1, -1)
    return m.astype(bool)


def dark_canvas(w: int, h: int) -> np.ndarray:
    """Product dark-theme vertical gradient #0b0d12 -> #141821 (float)."""
    tt = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    return np.repeat((((1 - tt) * np.array([18, 13, 11], np.float32)
                       + tt * np.array([33, 24, 20], np.float32))[:, None, :]),
                     w, axis=1) / 255.0


# OpenCV sizes a float Gaussian kernel as round(sigma * 8 + 1) | 1, so the
# tile shadow (sigma 14) is exactly 0 more than 56 px from the tile. The
# shadow and the hairline are computed in a window around the tile instead
# of over the whole canvas (same pixels; the canvas-sized passes cost
# ~90 ms a tile, 8 tiles a job).
SHADOW_SIGMA = 14
SHADOW_REACH = (int(round(SHADOW_SIGMA * 8 + 1)) | 1) // 2 + 8


def place_tile(canvas: np.ndarray, disp01: np.ndarray, dx: int, dy: int) -> list:
    """Blit a float tile with soft drop shadow, 10px rounded corners and
    a 1px rgba(255,255,255,0.12) hairline. Returns [x, y, w, h]."""
    th_, tw_ = disp01.shape[:2]
    H, W = canvas.shape[:2]
    tm = rounded_mask(th_, tw_, min(10, th_ // 2, tw_ // 2))
    R = SHADOW_REACH
    sy0, sx0 = dy + 10, dx
    # blur input: the shadow rect +- 2R (inside the canvas); output +- R
    iy0, iy1 = max(0, sy0 - 2 * R), min(H, sy0 + th_ + 2 * R)
    ix0, ix1 = max(0, sx0 - 2 * R), min(W, sx0 + tw_ + 2 * R)
    sh = np.zeros((iy1 - iy0, ix1 - ix0), np.float32)
    sh[sy0 - iy0:sy0 - iy0 + th_, sx0 - ix0:sx0 - ix0 + tw_] = tm.astype(np.float32)
    sh = cv2.GaussianBlur(sh, (0, 0), sigmaX=SHADOW_SIGMA)
    oy0, oy1 = max(0, sy0 - R), min(H, sy0 + th_ + R)
    ox0, ox1 = max(0, sx0 - R), min(W, sx0 + tw_ + R)
    win = canvas[oy0:oy1, ox0:ox1]
    win -= win * (0.5 * sh[oy0 - iy0:oy1 - iy0, ox0 - ix0:ox1 - ix0])[..., None]
    canvas[dy:dy + th_, dx:dx + tw_] = (
        disp01 * tm[..., None] + canvas[dy:dy + th_, dx:dx + tw_] * ~tm[..., None])
    ry0, ry1 = max(0, dy - 2), min(H, dy + th_ + 2)
    rx0, rx1 = max(0, dx - 2), min(W, dx + tw_ + 2)
    full = np.zeros((ry1 - ry0, rx1 - rx0), np.uint8)
    full[dy - ry0:dy - ry0 + th_, dx - rx0:dx - rx0 + tw_] = tm.astype(np.uint8)
    ring = (cv2.dilate(full, np.ones((3, 3), np.uint8)) & ~full).astype(bool)
    rim = canvas[ry0:ry1, rx0:rx1]
    rim[ring] = rim[ring] * 0.88 + 0.12
    return [dx, dy, tw_, th_]


def union_rect(boxes: list) -> tuple[int, int, int, int]:
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes) + 1, max(b[3] for b in boxes) + 1)


def framing_crop(union, img_w, img_h, margin=MARGIN, aspect=16.0 / 9.0,
                 out_w=1920, cap=MAX_UPSCALE) -> dict:
    ux0, uy0, ux1, uy1 = union
    uw, uh = float(ux1 - ux0), float(uy1 - uy0)
    cx, cy = (ux0 + ux1) / 2.0, (uy0 + uy1) / 2.0
    w, h = uw * (1 + 2 * margin), uh * (1 + 2 * margin)
    if w / h > aspect:
        h = w / aspect
    else:
        w = h * aspect
    if out_w / w > cap:
        w, h = out_w / cap, out_w / cap / aspect
    x0 = min(max(cx - w / 2.0, 0.0), max(img_w - w, 0.0))
    y0 = min(max(cy - h / 2.0, 0.0), max(img_h - h, 0.0))
    rect = (int(round(x0)), int(round(y0)), int(round(w)), int(round(h)))
    rect = (max(rect[0], 0), max(rect[1], 0),
            min(rect[2], img_w - max(rect[0], 0)),
            min(rect[3], img_h - max(rect[1], 0)))
    return {"rect": rect, "scale": out_w / rect[2], "subject_frac": uh / rect[3],
            "union": (ux0, uy0, ux1, uy1)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Lite 2D composite (single batch call).")
    ap.add_argument("--specimen", required=True)
    ap.add_argument("--video", default=None)
    ap.add_argument("--frames-dir", default=None)
    ap.add_argument("--frames-json", required=True)
    ap.add_argument("--portrait-cap", type=float, default=MAX_UPSCALE,
                    help="portrait upscale cap (default 2.5x; lift per clip only "
                    "with 4x zoom evidence of no softness/halo)")
    ap.add_argument("--crop-bottom", type=int, default=0,
                    help="first source row of a burnt-in data bar (lite-decode.js "
                    "detectOsdBar); frames and masks are cut above it. 0 = none")
    args = ap.parse_args(argv)
    if bool(args.video) == bool(args.frames_dir):
        return fail("exactly one of --video / --frames-dir is required")
    try:
        spec = json.load(open(args.frames_json, encoding="utf-8"))
        fps = float(spec["fps"])
        fw, fh = int(spec["width"]), int(spec["height"])
        # A trail camera's burnt-in date/temperature bar never reaches a
        # tile: everything below works on the picture above it.
        src_h = fh
        if 0 < args.crop_bottom < fh:
            fh = int(args.crop_bottom)
        mval = int(spec.get("maskValue", 1))
        entries = spec["frames"]
        if not entries:
            return fail("frames-json holds no frames")
    except (KeyError, ValueError, OSError) as e:
        return fail(f"bad frames-json: {e}")

    try:
        # Per frame: union mask over objects; keep every object's mask.
        by_frame: dict[int, dict] = {}

        # PNG decode dominates mask loading; cv2.imread releases the GIL, so
        # decode them on a few threads first. Any failure here falls back
        # to the original sequential load (same errors, same messages).
        def _pre(e):
            try:
                return load_mask(e["mask"], mval)
            except Exception:  # noqa: BLE001 - re-raised by the loop below
                return None
        with ThreadPoolExecutor(max_workers=6) as _ex:
            preloaded = list(_ex.map(_pre, entries))
        for _ix, e in enumerate(entries):
            try:
                m = preloaded[_ix] if preloaded[_ix] is not None else load_mask(e["mask"], mval)
                t, c = float(e["timestamp"]), str(e.get("concept", "object"))
                fi = int(e["sourceFrameIndex"])
            except (KeyError, ValueError, TypeError) as ex:
                return fail(f"bad frames-json entry: {ex}")
            if m.shape != (src_h, fw):
                f = cv2.resize(m.astype(np.float32), (fw, src_h),
                               interpolation=cv2.INTER_LINEAR) > 0.5
            else:
                f = m
            if fh != src_h:
                f = f[:fh]
            d = by_frame.setdefault(fi, {"masks": [], "t": t})
            d["masks"].append(f)
        order = sorted(by_frame)
        union = {fi: np.logical_or.reduce(by_frame[fi]["masks"]) for fi in order}
        present = [fi for fi in order if union[fi].any()]
        if len(present) < 2:
            return fail("fewer than 2 frames carry the subject; refusing to fake motion")

        # Images: stills or video seeks.
        stills = {}
        if args.frames_dir:
            for fi in present:
                p = os.path.join(args.frames_dir, f"kf_{fi:05d}.jpg")
                fr = cv2.imread(p, cv2.IMREAD_COLOR)
                if fr is None:
                    return fail(f"missing still {p}")
                if fr.shape[:2] != (src_h, fw):
                    fr = cv2.resize(fr, (fw, src_h), interpolation=cv2.INTER_LINEAR)
                stills[fi] = fr[:fh]
            cap = None
        else:
            cap = SeqFrames(args.video, (src_h, fw))
            cap._open()

        def image_of(fi: int) -> np.ndarray:
            if cap is None:
                return stills[fi]
            fr = cap.get(fi)
            return fr if fh == src_h else fr[:fh]

        # Sharpness (subject region) + travel on union masks.
        # V10 also keeps the dilated-3px sharpness used by the snap.
        sharp, sharp_dil, cents, widths = {}, {}, [], []
        k3 = np.ones((3, 3), np.uint8)
        for fi in present:
            fr = image_of(fi)
            u = union[fi]
            dil = cv2.dilate(u.astype(np.uint8), k3, iterations=3) > 0
            # Laplacian only over the dilated subject box plus a 1-px ring
            # (the 3x3 kernel's support): every value read below is the
            # full-frame value (image borders reflect the same way).
            db = bbox_of(dil)
            cy0, cy1 = max(0, db[1] - 1), min(fh, db[3] + 2)
            cx0, cx1 = max(0, db[0] - 1), min(fw, db[2] + 2)
            g = cv2.cvtColor(fr[cy0:cy1, cx0:cx1], cv2.COLOR_BGR2GRAY)
            lap = cv2.Laplacian(g, cv2.CV_64F, ksize=3)
            uc, dc = u[cy0:cy1, cx0:cx1], dil[cy0:cy1, cx0:cx1]
            sharp[fi] = float(lap[uc].var()) \
                if np.count_nonzero(u) >= 50 else float("nan")
            sharp_dil[fi] = float(lap[dc].var()) \
                if np.count_nonzero(dil) >= 50 else float("nan")
            b = bbox_of(u)
            cents.append(((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0))
            widths.append(float(b[2] - b[0] + 1))
        cents = np.array(cents)
        body_w = float(np.median(widths))
        travel_w = float(np.hypot(np.diff(cents[:, 0]),
                                  np.diff(cents[:, 1])).sum()) / body_w
        route = "chronophotograph" if travel_w >= TRAVEL_ROUTE else "filmstrip"
        print(f"travel: {travel_w:.3f}W -> {route}")

        chrono_veto = None
        if route == "chronophotograph":
            # Path length counts camera jitter as travel; when the poses
            # cannot separate, the chrono selector vetoes. Show the motion
            # that exists as a filmstrip instead of shipping no composite.
            try:
                out_img, meta = run_chrono(by_frame, union, present, sharp, image_of,
                                           body_w, (fw, fh), sharp_dil=sharp_dil)
                p_img, p_meta = run_chrono(by_frame, union, present, sharp, image_of,
                                           body_w, (fw, fh), portrait=True,
                                           pcap=args.portrait_cap, sharp_dil=sharp_dil)
            except ValueError as error:
                chrono_veto = str(error)
                route = "filmstrip"
                print(f"chrono veto ({chrono_veto}) -> filmstrip")
        if route == "filmstrip":
            out_img, meta = run_filmstrip(by_frame, union, present, sharp, image_of,
                                          body_w, (fw, fh), sharp_dil=sharp_dil)
            p_img, p_meta = run_filmstrip(by_frame, union, present, sharp, image_of,
                                          body_w, (fw, fh), portrait=True,
                                          pcap=args.portrait_cap, sharp_dil=sharp_dil)
        meta.update({"route": route, "chronoVeto": chrono_veto,
                     "travelWidths": round(travel_w, 3),
                     "travelThreshold": TRAVEL_ROUTE,
                     "medianBodyWidthPx": round(body_w, 1),
                     "alpha": "vendor.refine_alpha defaults, temporal OFF",
                     "outputSize": [1920, 1080],
                     "frames": [{"source": int(k), "time": round(t, 2)}
                                for k, t in zip(meta["keptFrames"],
                                                meta["sourceTimes"])],
                     "portrait": {"file": "composite-portrait.png",
                                  "layout": p_meta["layout"],
                                  "stageLayout": p_meta.get("layoutScore"),
                                  "tileRects": p_meta.get(
                                      "tileRects",
                                      p_meta["layout"].get("stripRects")),
                                  "gridMisalignmentPx": p_meta.get(
                                      "gridMisalignmentPx"),
                                  "subjectHeightFraction":
                                  p_meta["subjectHeightFraction"],
                                  "scaleCap": args.portrait_cap}})
        # V12: portrait denoise record only when its own gate fired
        # (never a null key: gate-off JSON stays byte-identical).
        if p_meta.get("grainDenoise") is not None:
            meta["portrait"]["grainDenoise"] = p_meta["grainDenoise"]
        os.makedirs(args.specimen, exist_ok=True)
        ok = cv2.imwrite(os.path.join(args.specimen, "composite.png"), out_img)
        ok2 = cv2.imwrite(os.path.join(args.specimen, "composite-portrait.png"),
                           p_img)
        if not (ok and ok2):
            return fail("cv2.imwrite failed")
        with open(os.path.join(args.specimen, "composite.json"), "w",
                  encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        print(f"kept {len(meta['keptFrames'])}: {', '.join(meta['keptFrames'])}")
        print(f"subject-height {meta['subjectHeightFraction'] * 100:.1f}% "
              f"portrait {p_meta['subjectHeightFraction'] * 100:.1f}% "
              f"({p_meta['layout'].get('rows', '?')}x"
              f"{p_meta['layout'].get('cols', '?')})")
        return 0
    except ValueError as e:
        return fail(str(e))
    finally:
        try:
            cap.release()
        except Exception:
            pass


def select_chrono(union, present, sharp, body_w):
    thr = float(np.nanpercentile([sharp[i] for i in present], 10))
    good = [i for i in present if sharp[i] >= thr]
    if not good:
        raise ValueError("every frame is motion-blurred; refusing to fake motion")
    cands = [good[0]]
    for i in good[1:]:
        if iou(union[cands[-1]], union[i]) < IOU_T:
            cands.append(i)

    def gap(a, b):
        ca = np.array([union[a].nonzero()[1].mean(), union[a].nonzero()[0].mean()])
        cb = np.array([union[b].nonzero()[1].mean(), union[b].nonzero()[0].mean()])
        return float(np.hypot(*(cb - ca))) / body_w

    k3 = np.ones((3, 3), np.uint8)
    dil_cache = {}

    def dil(i):
        # Lazy: the MIN_KEEP top-up below tests any present frame, not only
        # the IoU-filtered candidates (a fixed dict raised KeyError there).
        if i not in dil_cache:
            dil_cache[i] = cv2.dilate(union[i].astype(np.uint8), k3,
                                      iterations=DILATE_PX) > 0
        return dil_cache[i]

    def hits(i, kept):
        return sum(int(np.count_nonzero(np.logical_and(dil(i), dil(k)))) for k in kept)

    kept = [cands[0]]
    for i in cands[1:]:
        if hits(i, kept) == 0 and gap(kept[-1], i) >= MIN_SPACING_W:
            kept.append(i)
    if len(kept) > MAX_KEEP:
        idx = np.linspace(0, len(kept) - 1, MAX_KEEP).round().astype(int)
        kept = sorted({kept[k] for k in idx})
    while 0 < len(kept) < MIN_KEEP:
        best, bs = None, None
        for i in present:
            if i in kept or not np.isfinite(sharp[i]):
                continue
            if any(hits(i, [k]) for k in kept):
                continue
            s = min(gap(i, k) for k in kept)
            if s >= MIN_SPACING_W and (bs is None or s > bs):
                best, bs = i, s
        if best is None:
            break
        kept.append(best)
        kept.sort()
    if len(kept) < MIN_KEEP:
        raise ValueError(f"only {len(kept)} non-overlapping poses exist "
                         f"(need {MIN_KEEP}); veto not relaxed")
    return kept, [gap(kept[k], kept[k + 1]) for k in range(len(kept) - 1)]


def chrono_base(by_frame, union, kept, image_of, size, layer=None):
    """Kept poses at opacity 1.0 over the masked-median plate (median over
    ``kept``, only ``layer`` poses re-layered). Returns the uint8
    composite at source-frame size (true positions)."""
    fw, fh = size
    if layer is None:
        layer = kept
    # The landscape still and both portrait rows use the same kept poses:
    # the masked-median plate and each pose's matte are built once per job
    # (they were rebuilt for every call, ~2 s each on a 5-pose clip).
    key = (tuple(kept), fw, fh)
    plate = _CHRONO_PLATES.get(key)
    if plate is None:
        k8 = np.ones((3, 3), np.uint8)
        stack, hide = [], []
        for fi in kept:
            fr = image_of(fi)
            stack.append(fr.astype(np.float32))
            hide.append(cv2.dilate(union[fi].astype(np.uint8), k8, iterations=8) > 0)
        arr = np.stack(stack)
        arr[np.stack(hide)[..., None] * np.ones((1, 1, 1, 3), bool)] = np.nan
        med = nanmedian0(arr)
        grad = np.repeat(np.linspace(11, 20, fh, dtype=np.float32)[:, None, None]
                         * np.ones((1, fw, 1), np.float32), 3, axis=2)
        med = np.where(np.isnan(med), grad, med)
        plate = _CHRONO_PLATES[key] = med / 255.0
    base = plate
    # Re-layer subjects over the clean backdrop (all objects, opaque).
    for fi in layer:
        for j, m in enumerate(by_frame[fi]["masks"]):
            matte = _CHRONO_MATTES.get((fi, j))
            if matte is None:
                fr = image_of(fi)
                a, fg = refine_default(fr, m)
                fg = soften_band(fr, fg, m)
                matte = _CHRONO_MATTES[(fi, j)] = (a[..., None], fg.astype(np.float32) / 255.0)
            a3, fg01 = matte
            base = base * (1 - a3) + fg01 * a3
    return np.clip(base * 255.0, 0, 255).astype(np.uint8)


_CHRONO_PLATES: dict = {}
_CHRONO_MATTES: dict = {}


def nanmedian0(arr: np.ndarray) -> np.ndarray:
    """np.nanmedian(arr, axis=0), same values: sort (NaN last), then the mean
    of the two middle valid values ((x + x) / 2 == x for an odd count), NaN
    where every value is NaN. np.nanmedian goes through masked arrays for a
    short axis and took ~1.8 s on a 5-frame 1280x720 stack."""
    s = np.sort(arr, axis=0)
    n = (~np.isnan(arr)).sum(axis=0)
    h = n // 2
    lo = np.where(n % 2 == 1, h, h - 1)
    low = np.take_along_axis(s, np.maximum(lo, 0)[None], axis=0)[0]
    high = np.take_along_axis(s, h[None], axis=0)[0]
    med = (low + high) / np.asarray(2.0, arr.dtype)
    med[n == 0] = np.nan
    return med


def run_chrono(by_frame, union, present, sharp, image_of, body_w, size,
               portrait: bool = False, pcap: float = MAX_UPSCALE,
               sharp_dil: dict | None = None):
    fw, fh = size
    kept, spacings = select_chrono(union, present, sharp, body_w)
    # V10 sharpness snap on the kept poses (neighbours +-3 usable frames).
    sd = sharp_dil if sharp_dil is not None else sharp
    _usable, _ = usable_frames(union, present)
    _uset, _tall = set(_usable), {fi: by_frame[fi]["t"] for fi in present}
    kept, snap_infos = snap_picks(sorted(kept), union, _uset, _tall, sd)
    if any(v is not None for v in snap_infos):
        print(f"  sharp snap (chrono): "
              f"{[(v['from'], v['to'], v['gain']) for v in snap_infos if v]}")
        kept, spacings = kept, [
            float(np.hypot(
                *(np.array([union[kept[k + 1]].nonzero()[1].mean(),
                             union[kept[k + 1]].nonzero()[0].mean()])
                 - np.array([union[kept[k]].nonzero()[1].mean(),
                             union[kept[k]].nonzero()[0].mean()])))) / body_w
            for k in range(len(kept) - 1)]
    boxes = [bbox_of(union[fi]) for fi in kept]
    if not portrait:
        out8 = chrono_base(by_frame, union, kept, image_of, size)
        fr1 = framing_crop(union_rect(boxes), fw, fh)
        fx, fy, fw_, fh_ = fr1["rect"]
        framed = cv2.resize(out8[fy:fy + fh_, fx:fx + fw_], (1920, 1080),
                            interpolation=cv2.INTER_LANCZOS4)
        return framed, {"mode": "chrono-still", "keptFrames": [str(fi) for fi in kept],
                        "sourceTimes": [round(by_frame[fi]["t"], 3) for fi in kept],
                        "spacingWidths": [round(s, 3) for s in spacings],
                        "sharpSnap": snap_infos,
                        "subjectHeightFraction": round(fr1["subject_frac"], 3),
                        "layout": {"crop": list(fr1["rect"]),
                                   "scale": round(fr1["scale"], 3)}}
    # Portrait 1080x1350: the kept poses stack into time-ordered rows over
    # the same plate; each row is cropped to its own union + 8% and the
    # rows share the canvas width (16px gutter, >=48px margins, <=2.5x).
    groups = [kept] if len(kept) <= 4 else \
        [kept[:len(kept) // 2], kept[len(kept) // 2:]]
    rows = len(groups)
    cell_w = 1080 - 2 * MIN_MARGIN
    cell_h = (1350 - 2 * MIN_MARGIN - (rows - 1) * GUTTER) / rows
    # One shared crop size per layout: max group union + margin, common
    # aspect. Every strip shows exactly this size centred on its group, so
    # all strips share one display size and the rows align. Clamped to the
    # frame; anatomy is never cut (full group union always inside).
    gcrops = []
    for g in groups:
        gb = [boxes[kept.index(fi)] for fi in g]
        ux0, uy0, ux1, uy1 = union_rect(gb)
        gcrops.append((float(ux1 - ux0), float(uy1 - uy0),
                       (ux0 + ux1) / 2.0, (uy0 + uy1) / 2.0))
    shw = min(max(c[0] for c in gcrops) * 1.16, float(fw))
    shh = min(max(c[1] for c in gcrops) * 1.16, float(fh))
    # Portrait cap (default 2.5x) liftable per clip only with 4x zoom
    # evidence of no softness/halo (see INTEGRATION.md).
    s = min(cell_w / shw, cell_h / shh, pcap)
    dw, dh = shw * s, shh * s
    canvas = dark_canvas(1080, 1350)
    rects, fracs, crops = [], [], []
    y = (1350 - (rows * dh + (rows - 1) * GUTTER)) / 2.0
    for g, (guw, guh, gcx, gcy) in zip(groups, gcrops):
        out8 = chrono_base(by_frame, union, kept, image_of, size, layer=g)
        sx0 = int(round(min(max(gcx - shw / 2.0, 0.0), max(fw - shw, 0.0))))
        sy0 = int(round(min(max(gcy - shh / 2.0, 0.0), max(fh - shh, 0.0))))
        sw, sh = int(round(shw)), int(round(shh))
        strip = cv2.resize(out8[sy0:sy0 + sh, sx0:sx0 + sw],
                           (int(round(sw * s)), int(round(sh * s))),
                           interpolation=cv2.INTER_LANCZOS4).astype(np.float32) / 255.0
        dx = int(round((1080 - strip.shape[1]) / 2.0))
        dy = int(round(y))
        rects.append(place_tile(canvas, np.clip(strip, 0.0, 1.0), dx, dy))
        fracs.append(guh * s / 1350.0)
        crops.append([sx0, sy0, sw, sh])
        y += dh + GUTTER
    out = np.clip(canvas * 255.0, 0, 255).astype(np.uint8)
    mis = grid_misalignment(rects, rows, 1)
    print(f"  portrait rows: shared crop {shw:.0f}x{shh:.0f} "
          f"scale x{s:.2f} misalignment {mis}px")
    return out, {"mode": "chrono-rows", "keptFrames": [str(fi) for fi in kept],
                 "sourceTimes": [round(by_frame[fi]["t"], 3) for fi in kept],
                 "spacingWidths": [round(s, 3) for s in spacings],
                 "sharpSnap": snap_infos,
                 "subjectHeightFraction": round(min(fracs), 3),
                 "gridMisalignmentPx": mis,
                 "layout": {"rows": rows, "sharedCrop": [round(shw, 1), round(shh, 1)],
                            "scale": round(s, 3), "stripRects": rects,
                            "sourceCrops": crops}}


def grain_display_mask(union_mask: np.ndarray, tx0: int, ty0: int,
                          tw: int, th: int, dsize: tuple) -> np.ndarray:
    """Subject mask in display-panel coordinates (nearest). Mirrors the
    tile_crop window, then the LANCZOS display resize."""
    mu = np.zeros((th, tw), bool)
    uh, uw = union_mask.shape
    sy0, sy1 = max(-ty0, 0), min(-ty0 + uh, th)
    sx0, sx1 = max(-tx0, 0), min(-tx0 + uw, tw)
    mu[sy0:sy1, sx0:sx1] = union_mask[
        max(ty0, 0):max(ty0, 0) + (sy1 - sy0),
        max(tx0, 0):max(tx0, 0) + (sx1 - sx0)]
    if (dsize[0], dsize[1]) != (tw, th):
        return cv2.resize(mu.astype(np.float32), dsize,
                         interpolation=cv2.INTER_NEAREST) > 0.5
    return mu


def grain_visible_load(panels: list, scale: float) -> tuple:
    """Visible grain load over delivered display panels.
    panels: list of (disp_gray_u8, bg_display_bool). Returns
    (V, mres, lowfrac): median over panels with enough low-texture bg.
    Pure function of delivered pixels; deterministic."""
    mrs, frs = [], []
    ones = np.ones((5, 5), np.float32)
    for disp, bg in panels:
        d32 = disp.astype(np.float32)
        n = cv2.filter2D(np.ones_like(d32), -1, ones)
        mn = cv2.filter2D(d32, -1, ones) / n
        vr = np.clip(cv2.filter2D(d32 * d32, -1, ones) / n - mn * mn,
                     0, None)
        low = bg & (vr < GRAIN_LOWTEX_VAR)
        if low.sum() >= GRAIN_MIN_LOWTEX_PX and bg.sum() > 0:
            res = np.abs(d32
                         - cv2.medianBlur(disp, 5).astype(np.float32))
            mrs.append(float(np.mean(res[low])))
            frs.append(float(low.sum()) / float(bg.sum()))
    if not mrs:
        return 0.0, 0.0, 0.0
    mres, lowfrac = float(np.median(mrs)), float(np.median(frs))
    return mres * lowfrac * scale, mres, lowfrac


def grain_h(mres: float, scale: float) -> float:
    """NLM strength in source-scale units, tied to the measured
    residual. Floor 3.0 = light touch for just-over-gate clips; cap 8.0
    avoids wax."""
    return float(min(max(6.0 * mres / max(scale, 1e-6),
                         GRAIN_H_MIN), GRAIN_H_MAX))


_DENOISE_MEMO: dict = {}


def denoise_panel_crop(crop_f32: np.ndarray, h: float) -> np.ndarray:
    """Edge-preserving NLM denoise of a float32 BGR panel crop (0-255).
    No sharpening, no colour lift: photometric NLM only. Memoised on the
    exact crop bytes: the portrait twin re-stages the same panels, and NLM
    is the most expensive step of the still."""
    u8 = np.clip(np.round(crop_f32), 0, 255).astype(np.uint8)
    key = (float(h), u8.shape, hashlib.blake2b(u8.tobytes(), digest_size=16).digest())
    hit = _DENOISE_MEMO.get(key)
    if hit is None:
        hit = cv2.fastNlMeansDenoisingColored(u8, None, h, h, 7, 21)
        _DENOISE_MEMO[key] = hit
    return hit.astype(np.float32)


def run_filmstrip(by_frame, union, present, sharp, image_of, body_w, size,
                  portrait: bool = False, pcap: float = MAX_UPSCALE,
                  sharp_dil: dict | None = None):
    fw, fh = size
    CW, CH = (1080, 1350) if portrait else (1920, 1080)
    usable, ustats = usable_frames(union, present)
    if len(usable) < 2:
        raise ValueError("fewer than 2 usable frames; refusing to fake motion")
    print(f"  usable: {ustats['usable']}/{ustats['present']} "
          f"(small-area<{ustats['excludedSmallArea']} "
          f"truncated<{ustats['excludedBorderTruncated']} "
          f"closeup-exception={ustats['closeupException']})")
    med_s = float(np.nanmedian([sharp[i] for i in usable]))
    cands = [i for i in usable if sharp[i] >= med_s]
    # Centred diverse pick (up to 6, insertion order).
    boxes = {i: bbox_of(union[i]) for i in cands}
    W = max(b[2] - b[0] + 1 for b in boxes.values())
    H = max(b[3] - b[1] + 1 for b in boxes.values())
    C = {}
    for i in cands:
        x0, y0, x1, y1 = boxes[i]
        c = np.zeros((H, W), bool)
        h, w = y1 - y0 + 1, x1 - x0 + 1
        c[(H - h) // 2:(H - h) // 2 + h, (W - w) // 2:(W - w) // 2 + w] = \
            union[i][y0:y1 + 1, x0:x1 + 1]
        C[i] = c
    order = sorted(cands, key=lambda i: (-sharp[i], i))
    t_of = {i: by_frame[i]["t"] for i in cands}
    # V6 total pose change over usable sharp frames: centred-shape change
    # plus linear scale change plus in-frame position change (body units).
    uareas = {i: int(np.count_nonzero(union[i])) for i in usable}
    body_units = float(np.sqrt(np.median([uareas[i] for i in usable])))
    cen = {i: ((boxes[i][0] + boxes[i][2]) / 2.0,
                (boxes[i][1] + boxes[i][3]) / 2.0) for i in cands}
    dmax = dshape = dscale = dpos = 0.0
    for x, a in enumerate(cands):
        for b in cands[x + 1:]:
            s = 1.0 - iou(C[a], C[b])
            sc = abs(float(np.log(uareas[a] / uareas[b])))
            ps = float(np.hypot(cen[a][0] - cen[b][0],
                                cen[a][1] - cen[b][1])) / body_units
            dmax = max(dmax, s + sc + ps)
            dshape, dscale, dpos = max(dshape, s), max(dscale, sc), max(dpos, ps)
    few = dmax < DMAX_FEW_PANELS

    def far_enough(i, chosen):
        """V6 near-duplicate guard: no panel within MIN_GAP_S of chosen."""
        return all(abs(t_of[i] - t_of[k]) >= MIN_GAP_S for k in chosen)

    def pick_v5():
        """V5 endpoint-anchored greedy order: first + last usable fixed
        (time order = story order), middles fill by max min-(1-IoU) with
        ties (2dp) toward the largest time gap. Strict > is deterministic.
        Prefix 3 = the honest little-motion strip. V6 skips candidates
        within MIN_GAP_S of a chosen panel while others exist."""
        chosen = [cands[0]] if len(cands) == 1 else [cands[0], cands[-1]]
        while len(chosen) < min(6, len(cands)):
            pool = [i for i in cands if i not in chosen and far_enough(i, chosen)]
            if not pool:
                pool = [i for i in cands if i not in chosen]
            best, bk = None, None
            for i in pool:
                d = min(1.0 - iou(C[i], C[k]) for k in chosen)
                g = min(abs(t_of[i] - t_of[k]) for k in chosen)
                key = (round(d, 2), round(g, 2))
                if bk is None or key > bk:
                    best, bk = i, key
            chosen.append(best)
        return chosen

    def pick(time_spread: bool):
        """V2-style pick (baseline only): greedy farthest-point from the
        sharpest candidate. With time_spread, ties (2dp) break toward the
        largest time gap. Strict > keeps it deterministic."""
        chosen = [order[0]]
        while len(chosen) < min(6, len(order)):
            pool = [i for i in order if i not in chosen and far_enough(i, chosen)]
            if not pool:
                pool = [i for i in order if i not in chosen]
            best, bk = None, None
            for i in pool:
                d = min(1.0 - iou(C[i], C[k]) for k in chosen)
                g = min(abs(t_of[i] - t_of[k]) for k in chosen)
                key = (round(d, 2), round(g, 2)) if time_spread else (round(d, 2), 0.0)
                if bk is None or key > bk:
                    best, bk = i, key
            chosen.append(best)
        return chosen

    chosen = pick_v5()
    baseline = sorted(pick(False))
    # V10 sharpness snap on the diverse picks (insertion order kept for
    # the grid search; neighbours +-3 usable frames, dilated sharpness).
    _sd = sharp_dil if sharp_dil is not None else sharp
    _tall = {fi: by_frame[fi]["t"] for fi in present}
    _uset = set(usable)
    chosen, _map, _gains = snap_insertion_order(chosen, union, _uset,
                                                _tall, _sd)
    if any(v != k for k, v in _map.items()):
        print(f"  sharp snap (filmstrip): "
              f"{sorted([(k, v, _gains[v]) for k, v in _map.items() if v != k])}")
    for _ni in [x for x in chosen if x not in boxes]:
        boxes[_ni] = bbox_of(union[_ni])
        uareas[_ni] = int(np.count_nonzero(union[_ni]))
        cen[_ni] = ((boxes[_ni][0] + boxes[_ni][2]) / 2.0,
                    (boxes[_ni][1] + boxes[_ni][3]) / 2.0)
        t_of[_ni] = by_frame[_ni]["t"]
    _need_c = [x for x in chosen if x not in C]
    if _need_c:
        _W = max([W] + [boxes[x][2] - boxes[x][0] + 1 for x in _need_c])
        _H = max([H] + [boxes[x][3] - boxes[x][1] + 1 for x in _need_c])
        if _W != W or _H != H:
            W, H = _W, _H
            C = {}
            for _i in list(boxes):
                if _i not in union:
                    continue
                _b = boxes[_i]
                _c = np.zeros((H, W), bool)
                _hh, _ww = _b[3] - _b[1] + 1, _b[2] - _b[0] + 1
                if _hh <= H and _ww <= W:
                    _c[(H - _hh) // 2:(H - _hh) // 2 + _hh,
                       (W - _ww) // 2:(W - _ww) // 2 + _ww] = \
                        union[_i][_b[1]:_b[3] + 1, _b[0]:_b[2] + 1]
                    C[_i] = _c
        else:
            for _i in _need_c:
                _b = boxes[_i]
                _c = np.zeros((H, W), bool)
                _hh, _ww = _b[3] - _b[1] + 1, _b[2] - _b[0] + 1
                _c[(H - _hh) // 2:(H - _hh) // 2 + _hh,
                   (W - _ww) // 2:(W - _ww) // 2 + _ww] = \
                    union[_i][_b[1]:_b[3] + 1, _b[0]:_b[2] + 1]
                C[_i] = _c

    def pair_ious(sub):
        return [[a, b, round(iou(C[a], C[b]), 4)]
                for x, a in enumerate(sub) for b in sub[x + 1:]]

    def iou_stats(pairs):
        v = [p[2] for p in pairs]
        return (min(v), float(np.median(v)), max(v))

    def tile_for(sub):
        return shared_tile_for(sub, boxes, fw, fh)

    def own_tile(i):
        """Per-tile crop: own subject bbox + 20% margin, own aspect."""
        b = boxes[i]
        return (min(int(round((b[2] - b[0] + 1) * 1.2)), fw),
                min(int(round((b[3] - b[1] + 1) * 1.2)), fh))

    best, best_l = None, None
    if portrait:
        # Single column, 2x2, or 3 rows x 2 cols on the tall canvas.
        # Little-motion clips stack exactly 3 (3x1).
        opts = [(k, 1) for k in range(3 if few else 4, min(6, len(chosen)) + 1)]
        if not few and len(chosen) >= 4:
            opts.append((2, 2))
        if not few and len(chosen) >= 6:
            opts.append((3, 2))
    else:
        # V5: little-motion clips use exactly 3 panels (1x3); the rest try
        # 1xN (N=4..6), 2x2, 2x3. Winner = largest grid-height fraction
        # subject to the subject-height floor (uniform grid kept).
        opts = []
        if few:
            opts.append((1, 3))
        else:
            for k in range(4, min(6, len(chosen)) + 1):
                opts.append((1, k))
            if len(chosen) >= 4:
                opts.append((2, 2))
            if len(chosen) >= 6:
                opts.append((2, 3))
    key_best = None
    best_mode = None
    for rows, cols in opts:
        sub = sorted(chosen[:rows * cols])
        if len(sub) != rows * cols:
            continue
        mode, mtw, mth, muw, muh, sratio, jump = tile_decision(
            sub, boxes, cen, uareas, body_units, fw, fh)
        tw, th, uw, uh = tile_for(sub)
        if mode == "subject" and not portrait:
            tw, th, uw, uh = mtw, mth, muw, muh
        per = None
        if portrait:
            # Tighter per-tile crops (own bbox + margin, own aspect);
            # grid cells fit the largest tile.
            per = {i: own_tile(i) for i in sub}
            tw, th = (max(v[0] for v in per.values()),
                      max(v[1] for v in per.values()))
        sr = min((CW - 96 - (cols - 1) * GUTTER) / (cols * tw),
                 (CH - 96 - rows * TS_BLOCK - (rows - 1) * GUTTER) / (rows * th))
        s = min(sr, pcap if portrait else MAX_UPSCALE)
        hs = [boxes[i][3] - boxes[i][1] + 1 for i in sub]
        frac = min(hs) * s / float(CH)
        if portrait:
            if best_l is None or frac > best_l["frac"]:
                best = (rows, cols, sub, (tw, th), (uw, uh), sr, s, frac, per)
                best_l = {"frac": frac}
                best_mode = (mode, sratio, jump)
        else:
            if frac < SUBJ_FLOOR:
                continue  # never shrink the subject past the floor for fill
            grid = (rows * (th * s + TS_BLOCK) + (rows - 1) * GUTTER) / float(CH)
            key = (round(grid, 4), round(frac, 4), -(rows * cols))
            if key_best is None or key > key_best:
                best = (rows, cols, sub, (tw, th), (uw, uh), sr, s, frac, per)
                best_l = {"frac": frac}
                best_mode = (mode, sratio, jump)
                key_best = key
    if best is None:  # floor unreachable: fall back to max subject fraction
        for rows, cols in opts:
            sub = sorted(chosen[:rows * cols])
            if len(sub) != rows * cols:
                continue
            mode, mtw, mth, muw, muh, sratio, jump = tile_decision(
                sub, boxes, cen, uareas, body_units, fw, fh)
            tw, th, uw, uh = tile_for(sub)
            if mode == "subject" and not portrait:
                tw, th, uw, uh = mtw, mth, muw, muh
            per = None
            sr = min((CW - 96 - (cols - 1) * GUTTER) / (cols * tw),
                     (CH - 96 - rows * TS_BLOCK - (rows - 1) * GUTTER) / (rows * th))
            s = min(sr, MAX_UPSCALE)
            hs = [boxes[i][3] - boxes[i][1] + 1 for i in sub]
            frac = min(hs) * s / float(CH)
            if best_l is None or frac > best_l["frac"]:
                best = (rows, cols, sub, (tw, th), (uw, uh), sr, s, frac, per)
                best_l = {"frac": frac}
                best_mode = (mode, sratio, jump)
    rows, cols, sub, (tw, th), (uw, uh), sr, s, frac, per = best
    mode, sratio, jump = best_mode
    # V9 per-stage (from v7 logic minus CLAHE; v8 tile-aspect dropped per
    # Main): landscape scored on desktops (1280x720, 1440x900), portrait
    # on phones (390x844, 412x915), through the viewer crop (tileRects
    # bbox +20 pad +46 caption). Adopted only on strict both-viewport win;
    # else v6 tile/grid/scale are kept bit-exact so unchanged clips stay
    # byte-identical to v6.
    mask_sum_v9 = float(sum(uareas[i] for i in sub))
    if portrait:
        (r9, c9), sr9, s9, layout_info = choose_stage_grid(
            rows, cols, tw, th, mask_sum_v9, CW, CH, pcap,
            VIEWPORTS_PORT, "portrait")
    else:
        (r9, c9), sr9, s9, layout_info = choose_stage_grid(
            rows, cols, tw, th, mask_sum_v9, CW, CH, MAX_UPSCALE,
            VIEWPORTS_LAND, "landscape")
    if layout_info["adoptedStageWinner"]:
        rows, cols, sr, s = r9, c9, sr9, s9
        hs9 = [boxes[i][3] - boxes[i][1] + 1 for i in sub]
        frac = min(hs9) * s / float(CH)
    print(f"  stage layout ({layout_info['stage']} "
          f"{layout_info['viewports'][0]}|{layout_info['viewports'][1]}): "
          f"v6 {layout_info['v6Grid']} -> {layout_info['chosenGrid']} "
          f"adopted={layout_info['adoptedStageWinner']}")
    # V9: no CLAHE (dropped with v8 halo x1.14); panels stay source-identical.
    dw, dh = tw * s, th * s
    gw = cols * dw + (cols - 1) * GUTTER
    gh = rows * (dh + TS_BLOCK) + (rows - 1) * GUTTER
    x0, y0 = (CW - gw) / 2.0, (CH - gh) / 2.0
    canvas = dark_canvas(CW, CH)
    (_, th0), _ = cv2.getTextSize("0.0 s", cv2.FONT_HERSHEY_SIMPLEX, 1.0, 2)
    tscale = 22.0 / th0
    rects = []
    staged = []
    for rank, fi in enumerate(sub):
        fr = image_of(fi)
        b = boxes[fi]
        cx, cy = (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0
        # Uniform grid: every tile crops the shared size centred on its
        # own subject (shifted into frame; padded only if the frame is
        # smaller, which the shared-size clamp prevents). Source pixels
        # directly: the matte only decides crop and framing, never a
        # recomposite (which bakes a dark edge contour).
        crop, tx0, ty0 = tile_crop(fr, cx, cy, tw, th)
        staged.append((fi, crop, tx0, ty0, rank))
    # V12 grain gate on the delivered (display-scale) panels. Measured
    # from display greys + display masks; the pixel path below is
    # untouched unless the gate fires.
    _panels = []
    _dsize = (int(round(tw * s)), int(round(th * s)))
    _k3 = np.ones((15, 15), np.uint8)
    for fi, crop, tx0, ty0, rank in staged:
        gc = cv2.cvtColor(np.clip(np.round(crop), 0, 255).astype(np.uint8),
                          cv2.COLOR_BGR2GRAY)
        disp_g = cv2.resize(gc, _dsize, interpolation=cv2.INTER_LANCZOS4) \
            if _dsize != (tw, th) else gc
        mud = grain_display_mask(union[fi], tx0, ty0, tw, th, _dsize)
        bgd = ~cv2.dilate(mud.astype(np.uint8), _k3).astype(bool)
        _panels.append((disp_g, bgd))
    _V, _mres, _lowfrac = grain_visible_load(_panels, s)
    _h = grain_h(_mres, s)
    _denoise = bool(_V >= GRAIN_GATE)
    if _denoise:
        print(f"  grain gate: V={_V:.2f} >= {GRAIN_GATE} "
              f"(mres={_mres:.2f} lowfrac={_lowfrac:.2f} s={s:.2f}): "
              f"NLM h={_h:.1f} on {len(staged)} panels")
        # panels are independent (and cv2 releases the GIL): denoise them
        # side by side, same results in the same order
        with ThreadPoolExecutor(max_workers=4) as _ex:
            _dn = list(_ex.map(lambda p: denoise_panel_crop(p[1], _h), staged))
        staged = [(fi, d, tx0, ty0, rank)
                  for (fi, _crop, tx0, ty0, rank), d in zip(staged, _dn)]
    for fi, crop, tx0, ty0, rank in staged:
        dsize = (int(round(tw * s)), int(round(th * s)))
        disp = cv2.resize(crop / 255.0, dsize, interpolation=cv2.INTER_LANCZOS4) \
            if dsize != (tw, th) else (crop / 255.0).copy()
        r, c = divmod(rank, cols)
        cellx = x0 + c * (dw + GUTTER)
        celly = y0 + r * (dh + TS_BLOCK + GUTTER)
        dx = int(round(cellx + (dw - disp.shape[1]) / 2.0))
        dy = int(round(celly + (dh - disp.shape[0]) / 2.0))
        rects.append(place_tile(canvas, disp, dx, dy))
    out = np.clip(canvas * 255.0, 0, 255).astype(np.uint8)
    for (dx, dy, dw_, dh_), fi in zip(rects, sub):
        txt = f"{by_frame[fi]['t']:.1f} s"
        cv2.putText(out, txt, (dx + 2, dy + dh_ + 8 + 22),
                    cv2.FONT_HERSHEY_SIMPLEX, tscale, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(out, txt, (dx + 2, dy + dh_ + 8 + 22),
                    cv2.FONT_HERSHEY_SIMPLEX, tscale, (214, 205, 201), 2, cv2.LINE_AA)
    ov = 0
    for a in range(len(rects)):
        for b in range(a + 1, len(rects)):
            ax, ay, aw, ah = rects[a]
            bx, by, bw, bh_ = rects[b]
            ov += max(0, min(ax + aw, bx + bw) - max(ax, bx)) * \
                max(0, min(ay + ah, by + bh_) - max(ay, by))
    mis = grid_misalignment(rects, rows, cols)
    print(f"  grid {rows}x{cols}: {mode} tile {tw}x{th} "
          f"(scaleRatio={sratio:.2f} jump={jump:.2f}W) "
          f"misalignment {mis}px overlap {ov}px")
    base_sub = baseline[:len(sub)]
    new_pairs, old_pairs = pair_ious(sub), pair_ious(base_sub)
    bn, bm, bx = iou_stats(old_pairs)
    nn, nm, nx = iou_stats(new_pairs)
    print(f"  pose pick: base {base_sub} IoU {bn:.3f}/{bm:.3f}/{bx:.3f} -> "
          f"endpoint {sub} IoU {nn:.3f}/{nm:.3f}/{nx:.3f} "
          f"Dmax={dmax:.3f} (shape={dshape:.3f} scale={dscale:.3f} "
          f"pos={dpos:.3f}) {'few(3)' if few else 'full'}")
    grid_frac = (rows * (th * s + TS_BLOCK) + (rows - 1) * GUTTER) / float(CH)
    _rev = {v: k for k, v in _map.items()}
    _snap_list = [({"from": int(_rev.get(i, i)), "to": int(i),
                    "gain": round(float(_gains.get(i, 1.0)), 4)}
                   if int(_rev.get(i, i)) != int(i) else None) for i in sub]
    meta = {"mode": "filmstrip", "keptFrames": [str(i) for i in sub],
                 "layoutScore": layout_info,
                 "sourceTimes": [round(by_frame[i]["t"], 3) for i in sub],
                 "pairwiseCentredIoU": new_pairs,
                 "pairwiseCentredIoU_baseline": old_pairs,
                 "panelRule": ("little-motion-3" if few else "diverse-set"),
                 "totalPoseChange": round(dmax, 4),
                 "poseShapeChange": round(dshape, 4),
                 "poseScaleChange": round(dscale, 4),
                 "posePositionChange": round(dpos, 4),
                 "littleMotionThreshold": DMAX_FEW_PANELS,
                 "minGapS": MIN_GAP_S,
                 "tileMode": mode,
                 "tileScaleRatio": round(sratio, 3),
                 "tileJumpWidths": round(jump, 3),
                 "tileFill": (SUBJECT_FILL if mode == "subject" else None),
                 "usableStats": ustats,
                 "gridHeightFraction": round(grid_frac, 3),
                 "sharpness": {str(i): round(sharp[i], 1) for i in sub},
                 "sharpnessFloor": round(med_s, 1),
                 "sharpSnap": _snap_list,
                 "tileOverlapPx": ov,
                 "tileSource": "source pixels (no recomposite)",
                 "tileRects": rects,
                 "gridMisalignmentPx": mis,
                 "subjectHeightFraction": round(frac, 3),
                 "layout": {"rows": rows, "cols": cols, "tile": [tw, th],
                            "perTile": ({str(i): list(per[i]) for i in sub}
                                         if per is not None else None),
                            "scale": round(s, 3),
                            "scaleRequested": round(sr, 3),
                            "canvas": [CW, CH]}}
    # V12: record the denoise ONLY when the gate fired, so gate-off
    # clips keep byte-identical JSON.
    if _denoise:
        meta["grainDenoise"] = {"gate": GRAIN_GATE,
                                 "visibleLoad": round(_V, 3),
                                 "mres": round(_mres, 3),
                                 "lowtexFrac": round(_lowfrac, 3),
                                 "scale": round(s, 3), "nlmH": round(_h, 2),
                                 "panels": len(sub)}
    return out, meta


if __name__ == "__main__":
    raise SystemExit(main())
