"""Behind-layer builder: layered disocclusion fill, CPU only (numpy/OpenCV).

Reads a finished specimen directory (plate.webp, depth.webp cell 0,
subject.webp seed-cell alpha, specimen.json) and writes behind.webp
(1.3x canvas: plate + push-pull surround, depth-edge bands and the
subject-silhouette ring inpainted with nearest-valid colours) plus
plateAlpha.png (front alphaMap: opaque in-photo, 2px border feather to 0
outside). The viewer mixes the relief front over this flat far behind;
at rest the bands sit under near-identical colours so nothing changes,
at orbit they read as background continuation instead of stretched
triangles. No GPU, no network, no gate changes: pure synthesis.

Usage: python behind.py <runsDir>
Stdout: one JSON line with band stats + the ghost metric (median residue
the rim/seam counters miss: long-thin smooth-bias blobs; reported, the
k-ladder gates).
"""
import json
import os
import sys
import time

import cv2
import numpy as np

AMP = 0.10
CANVAS = 1.3
# Broad-residue reporter mirrors plate.py (RESIDUE_MIN_FRAC /
# COLOR_DIST_LIMIT): same values, duplicated so this script stays
# dependency-free, with the same calmer-than-ring bias guard. Reported,
# never gated.
RESIDUE_MIN_FRAC = 0.01
RESIDUE_COLOR_DIST = 25.0
# Fill bands (inpaint, tiered by depth gradient): strong+medium cliffs whose
# disocclusion opens visibly. Weak gradients stay plate (subpixel).
BAND_TIERS = [(0.20, 10), (0.08, 6)]


def load(runs_dir):
    spec = json.load(open(os.path.join(runs_dir, "specimen.json")))
    W, H = spec["working"]["width"], spec["working"]["height"]
    lay = spec["layout"]
    plate = cv2.imread(os.path.join(runs_dir, spec["files"]["plate"]), cv2.IMREAD_COLOR)
    depth_atlas = cv2.imread(os.path.join(runs_dir, spec["files"]["depth"]), cv2.IMREAD_GRAYSCALE)
    subj_atlas = cv2.imread(os.path.join(runs_dir, spec["files"]["subject"]), cv2.IMREAD_UNCHANGED)
    if plate is None or depth_atlas is None or subj_atlas is None:
        raise SystemExit(f"behind: unreadable inputs in {runs_dir}")
    cw, ch, cols = lay["cellW"], lay["cellH"], lay["cols"]
    d0 = depth_atlas[0:ch, 0:cw].astype(np.float32)
    d0 = cv2.resize(d0, (W, H), interpolation=cv2.INTER_LINEAR) / 255.0
    return spec, plate.astype(np.float32), d0, subj_atlas, (cw, ch, cols), W, H


def push_pull(img, valid, levels=8):
    # Diffusion-ish fill from valid pixels: average down with validity
    # weights, then upsample blending known pixels back at each level.
    pyr_img, pyr_w = [img], [valid]
    for _ in range(levels):
        pimg, pw = pyr_img[-1], pyr_w[-1]
        h, w = pimg.shape[:2]
        if min(h, w) <= 4:
            break
        nw, nh = max(2, w // 2), max(2, h // 2)
        dw = cv2.resize(pw, (nw, nh), interpolation=cv2.INTER_AREA)
        di = cv2.resize(pimg * pw[..., None], (nw, nh), interpolation=cv2.INTER_AREA)
        di /= np.maximum(dw, 1e-6)[..., None]
        pyr_img.append(di)
        pyr_w.append(dw)
    out = pyr_img[-1].copy()
    for i in range(len(pyr_img) - 2, -1, -1):
        h, w = pyr_img[i].shape[:2]
        up = cv2.resize(out, (w, h), interpolation=cv2.INTER_LINEAR)
        v = pyr_w[i][..., None]
        out = np.where(v > 1e-6, pyr_img[i], up)
    return np.clip(out, 0, 255)


def build(runs_dir):
    t0 = time.time()
    spec, plate, d0, subj_atlas, (cw, ch, cols), W, H = load(runs_dir)
    gy, gx = np.gradient(d0)
    grad = np.maximum(np.abs(gx), np.abs(gy))
    edge = np.zeros_like(grad, dtype=bool)
    for thr, _ in BAND_TIERS:
        edge |= grad > thr
    # subject silhouette ring (seed frame cell): just the boundary strip
    # (~8px out, ~2px in). The interior keeps the plate's own validated
    # subject-removal fill; re-hallucinating it would only add blur where
    # the front billboard already covers.
    seed_sample = spec["plate"]["validation"].get("seedSample")
    frames = spec["keyframes"]
    fidx = next((i for i, f in enumerate(frames) if f["sample"] == seed_sample), len(frames) // 2)
    # NOTE: the subject atlas is 0-based per frame (cell fidx), unlike the
    # depth atlas whose cell 0 is the plate (frame fidx lives at fidx+1).
    # Indexing the subject with +1 reads the neighbour frame's silhouette.
    cx, cy = fidx % cols * cw, fidx // cols * ch
    alpha = subj_atlas[cy:cy + ch, cx:cx + cw, 3]
    alpha = cv2.resize(alpha, (W, H), interpolation=cv2.INTER_LINEAR)
    core = (alpha > 128).astype(np.uint8)
    sil = cv2.dilate(core, np.ones((9, 9), np.uint8)) > 0
    ring = (cv2.dilate(core, np.ones((17, 17), np.uint8)) &
            ~cv2.erode(core, np.ones((5, 5), np.uint8))) > 0
    valid = np.ones((H, W), np.float32)
    band = np.zeros((H, W), bool)
    for thr, wpx in BAND_TIERS:
        band |= cv2.dilate((grad > thr).astype(np.uint8), np.ones((2 * wpx + 1, 2 * wpx + 1), np.uint8)) > 0
    # Far-field guard (smear lane F): the viewer floats the flat behind
    # plane near median relief (view-basic.js: behind.position.z =
    # plateStats.bgZ - 0.003), so across far-field foliage the plane sits
    # IN FRONT of the plate relief and any inpaint there is front-visible
    # at every pose, not just through disocclusion cuts. Keep the plate's
    # own validated pixels there; inpaint only the near field the front
    # plate actually covers at rest. Substituting plate for fill can only
    # ever degrade to plate quality, never invent a smear.
    _pm = sorted(d0[int((yi + 0.5) / 18 * (H - 1)),
                      int((xi + 0.5) / 32 * (W - 1))]
                 for yi in range(18) for xi in range(32))
    _pmed = _pm[len(_pm) // 2]
    _far = d0 < _pmed - 0.02  # relief clearly behind any behind-plane level
    band |= ring & ~_far
    valid[band] = 0
    # nearest-valid fill: the bands sit under opaque front at rest, so the
    # fill must match the plate (a background-only seed diverges mid-band
    # and reads as ribbons even at rest).
    fill = push_pull(plate, valid)
    fill = cv2.GaussianBlur(fill, (0, 0), 1.0)
    behind_plate = np.where(band[..., None], fill, plate)
    # expanded canvas + surround continuation (heavy wash: soft continuation
    # beats sharp streaks; it only ever shows at frame edges, in motion).
    CW, CH = int(round(W * CANVAS)), int(round(H * CANVAS))
    ox, oy = (CW - W) // 2, (CH - H) // 2
    canvas = np.zeros((CH, CW, 3), np.float32)
    vmask = np.zeros((CH, CW), np.float32)
    canvas[oy:oy + H, ox:ox + W] = behind_plate
    vmask[oy:oy + H, ox:ox + W] = 1
    sur = push_pull(canvas, vmask)
    sur = cv2.GaussianBlur(sur, (0, 0), 5.0)
    canvas = np.where(vmask[..., None] > 0.5, canvas, sur)
    cv2.imwrite(os.path.join(runs_dir, "behind.webp"), np.clip(canvas, 0, 255).astype(np.uint8),
                [cv2.IMWRITE_WEBP_QUALITY, 88])
    # front alphaMap: opaque in-photo, 2px border feather to 0 outside.
    # No depth-edge cuts (a cut veil blending front-shaded photo with
    # flat-shaded behind over a staircase boundary reads as blocks;
    # opaque front over inpainted bands is pixel-clean by isolation test).
    am = np.full((H, W), 255, np.float32)
    am[:2, :] *= 0.5
    am[-2:, :] *= 0.5
    am[:, :2] *= 0.5
    am[:, -2:] *= 0.5
    am[0, :] = 0
    am[-1, :] = 0
    am[:, 0] = 0
    am[:, -1] = 0
    cv2.imwrite(os.path.join(runs_dir, "plateAlpha.png"), np.clip(am, 0, 255).astype(np.uint8))
    # ghost metric (what the rim/seam counters miss): median residue glows
    # as a smooth luminance bias against texture. |plate - wide blur| over
    # evaluable regions (silhouette, text rows, border excluded; bands kept
    # IN: they hold the suspects), connected components above 150px with
    # bbox aspect above 2.5 (snakes/strips are long-thin; illumination wash
    # is blobby). Reported, not gated (the k-ladder is the gate).
    smooth8 = cv2.GaussianBlur(plate, (0, 0), 8.0)
    bias = np.abs(plate.astype(np.float32) - smooth8).mean(axis=2)
    evaluable = ~(cv2.dilate((alpha > 128).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0)
    evaluable[:2, :] = False
    evaluable[-2:, :] = False
    evaluable[:, :2] = False
    evaluable[:, -2:] = False
    evaluable[int(H * 0.92):, :] = False
    candles = ((bias > 6) & evaluable).astype(np.uint8)
    nlab, _, stats, _ = cv2.connectedComponentsWithStats(candles, 8)
    big = []
    for i in range(1, nlab):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < 150:
            continue
        wpx = max(1, stats[i, cv2.CC_STAT_WIDTH])
        hpx = max(1, stats[i, cv2.CC_STAT_HEIGHT])
        if max(wpx, hpx) / min(wpx, hpx) > 2.5:
            big.append(i)
    ghost_px = int(sum(stats[i, cv2.CC_STAT_AREA] for i in big))
    ghost_share = ghost_px / max(1, int(evaluable.sum()))
    # Broad-residue mirror (same rule as plate.py residue_stats: zone-
    # interior colour modes unexplained by the ring and calmer than it).
    # Reported alongside the thin-blob numbers, which are unchanged.
    smoothB = cv2.GaussianBlur(plate, (0, 0), 8.0)
    bbias = np.abs(plate.astype(np.float32) - smoothB).mean(axis=2)
    core = cv2.erode(evaluable.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    bring = (cv2.dilate(evaluable.astype(np.uint8), np.ones((31, 31), np.uint8))
             & ~cv2.dilate(evaluable.astype(np.uint8), np.ones((9, 9), np.uint8))) > 0
    res_px, res_n = 0, 0
    if int(core.sum()) >= 20 and int(bring.sum()) >= 50:
        rpx = plate[core].reshape(-1, 3).astype(np.float64)[::7]
        rl = rpx @ np.array([0.114, 0.587, 0.299])
        rm0, rm1 = rpx[int(rl.argmin())].copy(), rpx[int(rl.argmax())].copy()
        for _ in range(10):
            rs = ((rpx - rm1) ** 2).sum(1) < ((rpx - rm0) ** 2).sum(1)
            if rs.all() or not rs.any():
                break
            rm0, rm1 = rpx[~rs].mean(0), rpx[rs].mean(0)
        cpx = plate[core].reshape(-1, 3).astype(np.float64)[::3]
        cl = cpx @ np.array([0.114, 0.587, 0.299])
        ca, cb = cpx[int(cl.argmin())].copy(), cpx[int(cl.argmax())].copy()
        for _ in range(10):
            cs = ((cpx - cb) ** 2).sum(1) < ((cpx - ca) ** 2).sum(1)
            if cs.all() or not cs.any():
                break
            ca, cb = cpx[~cs].mean(0), cpx[cs].mean(0)
        cs = ((cpx - cb) ** 2).sum(1) < ((cpx - ca) ** 2).sum(1)
        bpx = bbias[core].reshape(-1)[::3]
        rbi = float(bbias[bring].mean())
        for centre, sel in ((ca, ~cs), (cb, cs)):
            wpx = int(sel.sum()) * 3
            if wpx < RESIDUE_MIN_FRAC * max(1, int(evaluable.sum())):
                continue
            dd = float(min(np.linalg.norm(centre - rm0), np.linalg.norm(centre - rm1)))
            cc = float(bpx[sel].mean() / max(rbi, 1e-6)) if int(sel.sum()) else 1.0
            if dd > RESIDUE_COLOR_DIST and cc < 1.0:
                res_px += wpx
                res_n += 1
                res_px += wpx
                res_n += 1
    report = {"edgePx": int(edge.sum()), "bandPx": int(band.sum()),
              "silPx": int(sil.sum()), "canvas": [CW, CH],
              "ghostBlobs": len(big), "ghostShare": round(ghost_share, 4),
              "residueBlobs": res_n,
              "residueShare": round(res_px / max(1, int(evaluable.sum())), 4),
              "seconds": round(time.time() - t0, 1)}
    print(json.dumps(report))
    return report


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: behind.py <runsDir>")
    build(sys.argv[1])
