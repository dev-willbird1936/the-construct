"""Sub-keyframe motion field for the Basic viewer (tier-improve loop 10).

Between keyframes i and i+1 the viewer slides both poses along the centroid
path and cross-fades them. Where the body changes shape (a stride, a head
turn) the two poses do not line up, so the fade shows a doubled, see-through
body. This writes, per consecutive pair, a coarse residual motion field (what
is left after the centroid slide) that the viewer uses to warp both meshes
toward each other: the outgoing pose moves by f*fwd, the incoming one by
(1-f)*bwd, so they meet in one body instead of two.

Fields come from DIS optical flow on the atlas cells the viewer draws
(alpha-weighted grey), averaged onto a GX x GY grid with the alpha as the
weight, then clamped. A pair whose warp does not beat the plain slide on the
cells themselves is written as zero, so a bad field never makes a pair worse
than the plain blend.

usage: python flow.py --atlas subject.webp --meta flow-in.json --out flow.bin
flow-in.json: {"cols", "cellW", "cellH", "count", "centroids": [[x, y] in cell px]}
flow.bin: int8, (count-1) x GY x GX x 4 = (fwd dx, fwd dy, bwd dx, bwd dy);
value = q * scale cell px. Grid node (0, 0) sits on the cell's top-left
corner and node (GX-1, GY-1) on its bottom-right one. Prints one JSON line.
"""
import argparse
import json
import sys
import time

import cv2
import numpy as np

GX = 32          # grid nodes across a cell (the viewer's mesh is 96 wide)
CLAMP = 0.25     # max residual, as a fraction of the cell width
GAIN_MIN = 0.02  # a pair keeps its field only when it cuts the error by >= 2%


def cells(atlas, meta):
    cw, ch, cols = meta["cellW"], meta["cellH"], meta["cols"]
    out = []
    for i in range(meta["count"]):
        r, c = divmod(i, cols)
        out.append(atlas[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw].astype(np.float32) / 255)
    return out


def shift(img, dx, dy):
    h, w = img.shape[:2]
    return cv2.warpAffine(img, np.float32([[1, 0, dx], [0, 1, dy]]), (w, h),
                          flags=cv2.INTER_LINEAR, borderValue=0)


def grey8(rgba):
    a = rgba[:, :, 3]
    g = cv2.cvtColor(np.ascontiguousarray(rgba[:, :, :3]), cv2.COLOR_BGR2GRAY)
    return np.clip((g * a * 0.7 + a * 0.3) * 255, 0, 255).astype(np.uint8)


def coarse(flow, alpha, gx, gy):
    """Alpha-weighted mean flow per grid node (subject motion dominates)."""
    w = cv2.GaussianBlur(alpha, (0, 0), 3) + 1e-3
    den = cv2.resize(w, (gx, gy), interpolation=cv2.INTER_AREA)
    fx = cv2.resize(flow[:, :, 0] * w, (gx, gy), interpolation=cv2.INTER_AREA) / den
    fy = cv2.resize(flow[:, :, 1] * w, (gx, gy), interpolation=cv2.INTER_AREA) / den
    return np.dstack([fx, fy]).astype(np.float32)


def dense(grid, w, h):
    """Bilinear field at every pixel, sampled exactly as the viewer samples
    the grid at its mesh vertices (node 0 on the left/top edge)."""
    gy, gx = grid.shape[:2]
    mx, my = np.meshgrid(np.linspace(0, gx - 1, w, dtype=np.float32),
                         np.linspace(0, gy - 1, h, dtype=np.float32))
    return cv2.remap(grid, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def move_err(a, b, field):
    """Mismatch after moving a's content by `field` onto b, weighted where
    either pose is opaque (backward sampling; close for these smooth fields)."""
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    wa = cv2.remap(a, xx - field[:, :, 0], yy - field[:, :, 1], cv2.INTER_LINEAR, borderValue=0)
    m = np.maximum(wa[:, :, 3], b[:, :, 3])
    d = np.abs(wa[:, :, 3] - b[:, :, 3]) + np.abs(wa[:, :, :3] * wa[:, :, 3:4] - b[:, :, :3] * b[:, :, 3:4]).mean(axis=2)
    return float((d * m).sum() / max(float(m.sum()), 1e-6))


def pair_fields(a, b, d, gx, gy, dis):
    """(fwd, bwd, gain) for poses a -> b whose centroids differ by d (cell px)."""
    ch, cw = a.shape[:2]
    if a[:, :, 3].max() < 0.05 or b[:, :, 3].max() < 0.05:
        return None, None, 0.0
    b_on_a = shift(b, -d[0], -d[1])  # b slid onto a's centroid (the viewer's slide)
    a_on_b = shift(a, d[0], d[1])
    lim = CLAMP * cw
    # Flow and the gain check run at half resolution: the field is a 32-node
    # grid anyway (e7 cells: median gain 0.45/0.54/0.34 vs 0.47/0.52/0.36 at
    # full size, 40-45% less time).
    hw, hh = max(8, cw // 2), max(8, ch // 2)
    up = np.float32([cw / hw, ch / hh])
    half = lambda x: cv2.resize(x, (hw, hh), interpolation=cv2.INTER_AREA)
    ha, hb, hab, hba = half(a), half(b), half(a_on_b), half(b_on_a)
    fwd = np.clip(coarse(dis.calc(grey8(ha), grey8(hba), None), ha[:, :, 3], gx, gy) * up, -lim, lim)
    bwd = np.clip(coarse(dis.calc(grey8(hb), grey8(hab), None), hb[:, :, 3], gx, gy) * up, -lim, lim)
    base = move_err(ha, hba, np.zeros((hh, hw, 2), np.float32))
    if base < 1e-4:  # the slide alone already lines the poses up
        return None, None, 0.0
    moved = move_err(ha, hba, dense(fwd, hw, hh) / up)
    return fwd, bwd, 1 - moved / max(base, 1e-9)


def build(atlas, meta):
    cw, ch = meta["cellW"], meta["cellH"]
    gx, gy = GX, max(4, round(GX * ch / cw))
    cs = cells(atlas, meta)
    cen = meta["centroids"]
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    n = max(len(cs) - 1, 0)
    fields = np.zeros((n, gy, gx, 4), np.float32)
    gains, kept = [], 0
    for i in range(n):
        d = (cen[i + 1][0] - cen[i][0], cen[i + 1][1] - cen[i][1])
        fwd, bwd, gain = pair_fields(cs[i], cs[i + 1], d, gx, gy, dis)
        gains.append(round(float(gain), 3))
        if fwd is not None and gain >= GAIN_MIN:
            fields[i, :, :, :2] = fwd
            fields[i, :, :, 2:] = bwd
            kept += 1
    return fields, gx, gy, gains, kept


def encode(fields):
    peak = float(np.abs(fields).max()) if fields.size else 0.0
    scale = max(0.05, peak / 127)
    return np.clip(np.round(fields / scale), -127, 127).astype(np.int8), scale, peak


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    t0 = time.time()
    meta = json.load(open(args.meta))
    atlas = cv2.imread(args.atlas, cv2.IMREAD_UNCHANGED)
    if atlas is None or atlas.ndim != 3 or atlas.shape[2] != 4:
        raise SystemExit("atlas must be RGBA")
    if len(meta["centroids"]) != meta["count"]:
        raise SystemExit("one centroid per keyframe is required")
    fields, gx, gy, gains, kept = build(atlas, meta)
    q, scale, peak = encode(fields)
    q.tofile(args.out)
    print(json.dumps({"gx": gx, "gy": gy, "scale": round(scale, 6), "pairs": int(fields.shape[0]), "kept": kept,
                      "gainMedian": float(np.median(gains)) if gains else 0.0, "peakPx": round(peak, 2),
                      "bytes": int(q.nbytes), "sec": round(time.time() - t0, 2)}))


if __name__ == "__main__":
    sys.exit(main())
