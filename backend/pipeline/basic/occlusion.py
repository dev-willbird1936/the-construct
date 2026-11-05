"""Occluded-body fill for the subject atlas (tier-improve loop 11).

A moving occluder in front of the subject (a splash, swaying grass) is not
in the subject mask, so the keyframe loses that part of the body and the
viewer shows the plate through it: a see-through hole in a solid animal
(grizzly: a splash hides the bear's belly on one keyframe, and the water
behind shows through an arch-shaped gap).

A region is filled back into that keyframe's alpha when all of these hold:
  - both neighbouring keyframes cover it (masks moved onto this keyframe's
    centroid, shrunk by ERODE px for alignment slop);
  - it lies inside this keyframe's subject box;
  - it is large: at least MIN_AREA of the subject area;
  - the body surrounds it: at least MIN_CONTACT of its rim is subject;
  - the source shows something the plate does not there (at least
    OCC_SHARE of its pixels differ from the plate by DIFF_T): a static
    occluder is in the plate and stays as it is.
The first and last keyframes have one keyframe neighbour; their second is
the nearest kept track sample beyond them (--outer, a label the keyframe pick
passed over, e.g. a blurred one). Without one they are not filled.

Loop 12: the fill is painted as body, not as the occluder. Painting it with
the source pixels (the splash) showed white specks and water across the
near bear. The region takes the nearer keyframe neighbour's pixels (moved
onto this keyframe's centroid, colour-matched to the clean body ring around
it); the occluder's thin parts on the body near the region (bright specks:
white top-hat over SPECK_T, chroma under SPECK_C, within SPECK_R x
sqrt(body area) of the region) are inpainted from the fur around them.
Keyframes without a fill are untouched by this step.

Spray on the body (loop 12, any keyframe): spray or foam in front of a near
subject is inside its mask, so the atlas shows white specks and water across
the body. A speck is a bright (white top-hat over SPRAY_T, SPRAY_K px),
colourless (chroma under SPRAY_C) pixel of the body where the plate behind
is itself bright and colourless (L over PLATE_L, chroma under PLATE_C): white
water, foam, snow. A pale marking in front of grass, rock or a dark plate is
never a speck. The clip has a spray occluder when one keyframe is at least
SPRAY_CLIP specked; then every keyframe at least SPRAY_MIN specked has its
specks repainted from the fur around them (normalised convolution of the
clean body). Clips without such a keyframe are untouched.

CLI: --kf <dir of kf_NNNNN.png/jpg> --plate <plate jpg, working size>
     --frames <json [{sample, centroid:[x,y] in 0..1}]> --ids 1[,2] --out <dir>
     [--outer <json [{end, sample, file}]>: label rasters at the working size]
Writes occ_kf_NNNNN.png (255 = fill) for the keyframes that get a fill, and
for every keyframe with a fill or spray, occ_rgb_kf_NNNNN.png (the keyframe
with the fill and specks painted as body) and occ_clean_kf_NNNNN.png (255 =
repainted pixel); prints {"filled": {sample: px}, "cleaned": {sample: px},
"spray": {sample: px}, "sec": s}.
"""
import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

DIFF_T = 40
OCC_SHARE = 0.5
MIN_AREA = 0.05
MIN_CONTACT = 0.55
ERODE = 2
SPECK_T = 25
SPECK_C = 14
SPECK_R = 0.15
SPRAY_T = 25
SPRAY_K = 11
SPRAY_C = 12
PLATE_L = 150
PLATE_C = 14
SPRAY_CLIP = 0.02
SPRAY_MIN = 0.005


def read_mask(path, ids):
    lab = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if lab is None:
        raise FileNotFoundError(path)
    if lab.ndim == 3:
        lab = lab[:, :, 0]
    return np.isin(lab, ids)


def moved(mask, dx, dy):
    h, w = mask.shape
    m = cv2.warpAffine(mask.astype(np.uint8), np.float32([[1, 0, dx], [0, 1, dy]]), (w, h), flags=cv2.INTER_NEAREST)
    return cv2.erode(m, np.ones((2 * ERODE + 1, 2 * ERODE + 1), np.uint8)) > 0


def fill_for(mk, mp, mn, src, plate, ck, cp, cn):
    """Boolean fill region for keyframe k from its neighbours p and n."""
    h, w = mk.shape
    area = int(mk.sum())
    if area == 0:
        return np.zeros_like(mk)
    ap = moved(mp, (ck[0] - cp[0]) * w, (ck[1] - cp[1]) * h)
    an = moved(mn, (ck[0] - cn[0]) * w, (ck[1] - cn[1]) * h)
    ys, xs = np.where(mk)
    box = np.zeros_like(mk)
    box[ys.min():ys.max() + 1, xs.min():xs.max() + 1] = True
    region = ap & an & ~mk & box
    fill = np.zeros_like(mk)
    if region.sum() < MIN_AREA * area:
        return fill
    other = np.abs(src.astype(np.int16) - plate.astype(np.int16)).sum(axis=2) > DIFF_T
    n, lab, st, _ = cv2.connectedComponentsWithStats(region.astype(np.uint8))
    for c in range(1, n):
        if st[c, 4] < MIN_AREA * area:
            continue
        comp = lab == c
        ring = (cv2.dilate(comp.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & ~comp
        contact = float((ring & mk).sum()) / max(1, int(ring.sum()))
        if contact >= MIN_CONTACT and float(other[comp].mean()) >= OCC_SHARE:
            fill |= comp
    return fill


def clean_for(src, mk, fill, nsrc, nmask):
    """Keyframe src with the fill region and nearby occluder specks painted
    as body. nsrc/nmask: the nearer keyframe neighbour, moved onto this
    keyframe already. Returns (image, repainted mask)."""
    body = mk | fill
    r = max(5, int(round(SPECK_R * np.sqrt(float(body.sum())))))
    zone = (cv2.dilate(fill.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0) & body
    lab = cv2.cvtColor(src, cv2.COLOR_BGR2LAB).astype(np.float32)
    lum = lab[:, :, 0].copy()
    lum[~body] = float(np.median(lab[:, :, 0][body]))
    top = cv2.morphologyEx(lum, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    bright = top > SPECK_T
    speck = zone & bright & (np.hypot(lab[:, :, 1] - 128, lab[:, :, 2] - 128) < SPECK_C)
    occl = (cv2.dilate((fill | speck).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & body
    out = src.copy()
    big = (cv2.dilate(fill.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & body
    take = big & cv2.erode(nmask.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    ring = (cv2.dilate(occl.astype(np.uint8), np.ones((13, 13), np.uint8)) > 0) & body & ~occl & ~bright
    if take.sum() > 50 and ring.sum() > 50:
        nl = cv2.cvtColor(nsrc, cv2.COLOR_BGR2LAB).astype(np.float32)
        for c in range(3):
            sm, ss = nl[:, :, c][take].mean(), nl[:, :, c][take].std() + 1e-3
            tm, ts = lab[:, :, c][ring].mean(), lab[:, :, c][ring].std() + 1e-3
            nl[:, :, c] = (nl[:, :, c] - sm) * min(1.5, ts / ss) + tm
        patch = cv2.cvtColor(np.clip(nl, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
        w = cv2.GaussianBlur(take.astype(np.float32), (0, 0), 1.5)[:, :, None]
        blend = (patch * w + src * (1 - w)).astype(np.uint8)
        out[take] = blend[take]
    else:
        take = np.zeros_like(occl)
    rest = occl & ~take
    if rest.any():
        ys, xs = np.where(body)
        y0, y1 = max(0, ys.min() - 12), min(src.shape[0], ys.max() + 13)
        x0, x1 = max(0, xs.min() - 12), min(src.shape[1], xs.max() + 13)
        unk = (rest | ~body)[y0:y1, x0:x1].astype(np.uint8) * 255
        painted = cv2.inpaint(out[y0:y1, x0:x1].copy(), unk, 5, cv2.INPAINT_TELEA)
        sub = out[y0:y1, x0:x1]
        m = rest[y0:y1, x0:x1]
        sub[m] = painted[m]
    return out, occl


def white_plate(plate):
    """Where the plate is bright and colourless: white water, foam, snow."""
    lab = cv2.cvtColor(plate, cv2.COLOR_BGR2LAB).astype(np.float32)
    b = (SPRAY_K + 2, SPRAY_K + 2)
    chroma = np.hypot(lab[:, :, 1] - 128, lab[:, :, 2] - 128)
    return (cv2.blur(lab[:, :, 0], b) > PLATE_L) & (cv2.blur(chroma, b) < PLATE_C)


def box_of(mask, pad):
    ys, xs = np.where(mask)
    h, w = mask.shape
    return slice(max(0, ys.min() - pad), min(h, ys.max() + pad + 1)), slice(max(0, xs.min() - pad), min(w, xs.max() + pad + 1))


def spray_specks(src, mk, white):
    """Bright colourless specks on the body where the plate behind is white."""
    out = np.zeros_like(mk)
    if not (mk & white).any():
        return out
    box = box_of(mk, SPRAY_K)
    m = mk[box]
    lab = cv2.cvtColor(src[box], cv2.COLOR_BGR2LAB).astype(np.float32)
    lum = lab[:, :, 0].copy()
    lum[~m] = float(np.median(lum[m]))
    top = cv2.morphologyEx(lum, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (SPRAY_K, SPRAY_K)))
    chroma = np.hypot(lab[:, :, 1] - 128, lab[:, :, 2] - 128)
    out[box] = m & (top > SPRAY_T) & (chroma < SPRAY_C) & white[box]
    return out


def unspray(img, body, speck):
    """The specks (grown 1 px) repainted from the clean fur around them: a
    normalised convolution, wider where the clean fur is sparse. Returns
    (image, repainted mask)."""
    m = (cv2.dilate(speck.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & body
    if not m.any():
        return img, m
    box = box_of(m, 48)
    mm = m[box]
    known = (body & ~m)[box].astype(np.float32)
    src = img[box].astype(np.float32)
    fill, todo = np.zeros_like(src), mm.copy()
    for sig in (2.5, 7.0, 15.0):
        den = cv2.GaussianBlur(known, (0, 0), sig)
        est = cv2.GaussianBlur(src * known[:, :, None], (0, 0), sig) / np.maximum(den, 1e-4)[:, :, None]
        new = todo & ((den > 0.25) | (sig == 15.0))
        fill[new] = est[new]
        todo &= ~new
        if not todo.any():
            break
    out = img.copy()
    sub = out[box]
    sub[mm] = np.clip(fill[mm], 0, 255).astype(np.uint8)
    return out, m


def centroid(mask):
    ys, xs = np.where(mask)
    return [float(xs.mean()) / mask.shape[1], float(ys.mean()) / mask.shape[0]] if len(xs) else None


def neighbours(i, frames, outer):
    """The two neighbours of keyframe i as (("kf", frame) | ("outer", entry))
    pairs, or None: the keyframes either side inside the run; at an end, the
    one keyframe neighbour and the outer sample recorded for that end."""
    n = len(frames)
    if 0 < i < n - 1:
        return ("kf", frames[i - 1]), ("kf", frames[i + 1])
    if n < 2:
        return None
    o = outer.get(int(frames[i]["sample"]))
    if o is None:
        return None
    return ("kf", frames[1] if i == 0 else frames[n - 2]), ("outer", o)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kf", required=True)
    ap.add_argument("--plate", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--ids", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--outer", default=None)
    args = ap.parse_args()
    t0 = time.time()
    ids = [int(x) for x in args.ids.split(",") if x.strip()]
    frames = json.load(open(args.frames, encoding="utf8"))
    outer = {int(o["end"]): o for o in json.load(open(args.outer, encoding="utf8"))} if args.outer else {}
    plate = cv2.imread(args.plate, cv2.IMREAD_COLOR)
    os.makedirs(args.out, exist_ok=True)
    name = lambda s, ext: os.path.join(args.kf, f"kf_{int(s):05d}.{ext}")
    masks = {}

    def get(s):
        if s not in masks:
            masks[s] = read_mask(name(s, "png"), ids)
        return masks[s]

    def side(nb):
        kind, v = nb
        if kind == "kf":
            return get(v["sample"]), v["centroid"]
        try:
            m = read_mask(v["file"], ids)
        except FileNotFoundError:
            return np.zeros((0, 0), bool), None
        return m, centroid(m)

    white = white_plate(plate) if plate is not None else None
    if white is not None and not white.any():
        white = None
    filled, cleaned, sprayed = {}, {}, {}
    painted = {}  # sample -> (image, repainted, body) of the filled keyframes
    specks = {}   # sample -> (share of the body, speck mask)
    for i, k in enumerate(frames):
        sk = int(k["sample"])
        src = cv2.imread(name(sk, "jpg"), cv2.IMREAD_COLOR)
        if white is not None and src is not None:
            try:
                mk = get(sk)
            except FileNotFoundError:
                mk = None
            if mk is not None and mk.any() and src.shape[:2] == mk.shape == white.shape:
                sp = spray_specks(src, mk, white)
                if sp.any():
                    specks[sk] = (float(sp.sum()) / float(mk.sum()), sp)
        nbs = neighbours(i, frames, outer)
        if nbs is not None:
            mk = get(sk)
            (mp, cp), (mn, cn) = side(nbs[0]), side(nbs[1])
            if (src is not None and plate is not None and cp is not None and cn is not None
                    and src.shape[:2] == mk.shape == plate.shape[:2] == mp.shape == mn.shape):
                fill = fill_for(mk, mp, mn, src, plate, k["centroid"], cp, cn)
                if fill.any():
                    cv2.imwrite(os.path.join(args.out, f"occ_kf_{sk:05d}.png"), fill.astype(np.uint8) * 255)
                    filled[str(sk)] = int(fill.sum())
                    # body texture from the nearer keyframe neighbour
                    kfs = [v for kind, v in nbs if kind == "kf"]
                    nb = min(kfs, key=lambda v: abs(int(v["sample"]) - sk)) if kfs else None
                    nsrc = cv2.imread(name(nb["sample"], "jpg"), cv2.IMREAD_COLOR) if nb else None
                    if nsrc is not None and nsrc.shape == src.shape:
                        h, w = mk.shape
                        nm = get(nb["sample"])
                        d = (k["centroid"][0] - nb["centroid"][0]) * w, (k["centroid"][1] - nb["centroid"][1]) * h
                        mat = np.float32([[1, 0, d[0]], [0, 1, d[1]]])
                        nsh = cv2.warpAffine(nsrc, mat, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                        nmh = cv2.warpAffine(nm.astype(np.uint8), mat, (w, h), flags=cv2.INTER_NEAREST) > 0
                    else:
                        nsh, nmh = src, np.zeros_like(mk)
                    img, rep = clean_for(src, mk, fill, nsh, nmh)
                    painted[sk] = (img, rep, mk | fill)
        if i >= 1:
            masks.pop(int(frames[i - 1]["sample"]), None)  # each mask is needed by at most 3 neighbours
    # The clip has a spray occluder only when one keyframe is SPRAY_CLIP specked.
    spray = {}
    if specks and max(v[0] for v in specks.values()) >= SPRAY_CLIP:
        spray = {s: sp for s, (share, sp) in specks.items() if share >= SPRAY_MIN}
    fast = [cv2.IMWRITE_PNG_COMPRESSION, 1]
    pool = ThreadPoolExecutor(4)  # PNG encodes release the GIL
    writes = []
    for sk in sorted(set(painted) | set(spray)):
        if sk in painted:
            img, rep, body = painted[sk]
        else:
            img, body = cv2.imread(name(sk, "jpg"), cv2.IMREAD_COLOR), read_mask(name(sk, "png"), ids)
            rep = np.zeros_like(body)
        if sk in spray:
            img, sp = unspray(img, body, spray[sk] & body)
            rep = rep | sp
            sprayed[str(sk)] = int(sp.sum())
        writes.append(pool.submit(cv2.imwrite, os.path.join(args.out, f"occ_rgb_kf_{sk:05d}.png"), img, fast))
        writes.append(pool.submit(cv2.imwrite, os.path.join(args.out, f"occ_clean_kf_{sk:05d}.png"), rep.astype(np.uint8) * 255, fast))
        cleaned[str(sk)] = int(rep.sum())
    for w in writes:
        if not w.result():
            raise OSError("occlusion: an output did not write")
    pool.shutdown()
    print(json.dumps({"filled": filled, "cleaned": cleaned, "spray": sprayed, "sec": round(time.time() - t0, 2)}))


if __name__ == "__main__":
    main()
