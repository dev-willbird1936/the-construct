"""The animals of a fixed-camera world: one shell per animal per sampled moment.

A shell is a small depth grid plus a crop of that moment's footage whose alpha is the animal's own
SAM mask. It stays where it was seen, so past moments remain in the scene as an exact ghost trail.

Where it sits comes from where the animal touches the ground: the lowest pixels of its mask are
hooves, and the scene's depth there is known (the clean plate, with the lake a fitted plane). Its
own depth structure comes from Depth Anything 3 on the crop, scaled to that contact depth. No
whole-frame solve per moment is needed, because the camera never moves.
"""
import gc
import warnings
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from world_common import hide_strip
from world_matte import carry_colour, tidy

TEX_MAX = 640        # texture long side, px. 320 left a bear soft in the viewer's resting view (6 degrees off
                     # the lens, where the shell shows its own texture): a 720 p crop is kept whole up to here
GRID_STEP = 6        # source px between mesh samples
GRID_MIN, GRID_MAX = 20, 56
MIN_AREA = 250       # px: a smaller mask is a sliver at the frame edge
RELIEF = 0.8         # 1 = the crop's full relief
CONTACT = 0.08       # share of the mask's height, from the bottom, taken as touching the ground
SKIRT = 0.06        # share of a shell's height it is extended below its lowest pixels
OUTLIER = 0.04       # of the body's median depth: a body cell this far off the body around it has the background's depth
SMOOTH = 11          # samples: a track's distance is median-filtered over about a second


def shell_stride(moments, budget):
    """how many samples apart each animal is baked so a world stays within `budget` shells: 1 (every sample) when
    it fits, or `budget` is 0 or less. `moments`: {track: samples it is seen at}"""
    total = sum(moments.values())
    return max(1, int(np.ceil(total / budget))) if budget > 0 and total > budget else 1


def grow(m, r):
    return cv2.dilate(m.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)) > 0


def despeckle(dg, body, med):
    """a thin part (a tine, a tail) is a cell or two across, and the crop's depth there is often the background's:
    drawn that far back, it joined the body as a fan seen from aside (the moose's antlers). A body cell more than
    OUTLIER * med off the median of the body cells in the 5 x 5 around it takes that median"""
    gh, gw = dg.shape
    win = np.lib.stride_tricks.sliding_window_view(np.pad(np.where(body, dg, np.nan), 2, constant_values=np.nan), (5, 5))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)        # a window with no body cell: its median is nan
        local = np.nanmedian(win.reshape(gh, gw, 25), axis=-1)
    return np.where(body & np.isfinite(local) & (np.abs(dg - local) > OUTLIER * med), local, dg)


def nearest_known(dg, known):
    """the cells past the grown rim keep the crop's own depth, the background's, and a tip joined to one became a
    spike: they take the depth of the nearest known cell"""
    if known.all() or not known.any():
        return dg
    from scipy import ndimage
    return dg[tuple(ndimage.distance_transform_edt(~known, return_distances=False, return_indices=True))]


def sample_depth(env_depth, xs, ys, w, h):
    eh, ew = env_depth.shape
    ix = np.clip((xs / w * ew).astype(int), 0, ew - 1)
    iy = np.clip((ys / h * eh).astype(int), 0, eh - 1)
    return env_depth[iy, ix]


class Mono:
    """Depth Anything 3 on single crops. Each result is kept as its own file the moment it exists, so
    a crash (this machine's memory is not always kind) loses one crop, and a re-run costs nothing."""

    def __init__(self, folder):
        self.folder, self.model = Path(folder), None
        self.folder.mkdir(exist_ok=True)

    def depth(self, key, image):
        path = self.folder / f"{key}.npy"
        if path.exists():
            return np.load(path).astype(np.float32)
        if self.model is None:
            import torch
            from depth_anything_3.api import DepthAnything3
            self.model = DepthAnything3.from_pretrained("depth-anything/DA3-LARGE").to("cuda").eval()
        import torch
        res = int(min(504, max(224, np.ceil(max(image.shape[:2]) / 14) * 14)))
        with torch.no_grad():
            d = self.model.inference([image], process_res=res).depth[0]
        np.save(path.with_suffix(".tmp.npy"), d.astype(np.float16))
        path.with_suffix(".tmp.npy").replace(path)
        return d

    def close(self):
        if self.model is not None:
            import torch
            del self.model
            gc.collect()
            torch.cuda.empty_cache()


def make_shell(work, cam, env_depth, mono, matter, i, track, lab, overlay, plate=None):
    """one shell, or None. Returns a dict holding the texture and the raw depth grid. `plate`, the clean
    scene, tells the animal's true holes (sky between antlers) from the mask's mistakes."""
    m = lab == track
    if m.sum() < MIN_AREA:
        return None
    W, H = work.w, work.h
    ys, xs = np.nonzero(grow(m, 2))
    x0, x1 = max(0, xs.min() - 4), min(W, xs.max() + 5)
    y0, y1 = max(0, ys.min() - 4), min(int(H * overlay), ys.max() + 5)
    # a skirt below the animal: its silhouette ends along the waterline or the grass, and from the side
    # that edge is a cut. Below the ground the shell goes on a little; the ground hides it.
    skirt = int(SKIRT * (y1 - y0))
    y1_tight = y1
    y1 = min(int(H * overlay), y1 + skirt)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    frame = work.frame(i)
    crop = frame[y0:y1, x0:x1]
    cw, ch = x1 - x0, y1 - y0
    others = (lab > 0)[y0:y1, x0:x1] & ~m[y0:y1, x0:x1]
    inside = tidy(m[y0:y1, x0:x1], others, crop, None if plate is None else plate[y0:y1, x0:x1])
    if inside.sum() < MIN_AREA // 2:
        return None
    # depth is read from the tight crop (the skirt is not scenery) and carried down by its last row
    tight = y1_tight - y0
    dc = mono.depth(f"t{track}_f{i}_{x0}_{y0}_{x1}_{y1_tight}", crop[:tight])
    dc = cv2.resize(dc, (cw, tight), interpolation=cv2.INTER_LINEAR)
    if ch > tight:
        dc = np.vstack([dc, np.repeat(dc[-1:], ch - tight, axis=0)])

    # where the animal touches the ground, in source pixels
    yy, xx = np.nonzero(inside)
    low = yy >= yy.max() - max(3, int(CONTACT * (yy.max() - yy.min())))
    cx, cy = xx[low] + x0, yy[low] + y0
    ground = np.median(sample_depth(env_depth, cx + 0.5, cy + 0.5, W, H))
    local = np.median(dc[yy[low], xx[low]])
    if not np.isfinite(local) or local <= 0:
        return None
    d = dc * (ground / local)

    # a grid over the crop
    long = max(cw, ch)
    G = int(np.clip(round(long / GRID_STEP), GRID_MIN, GRID_MAX))
    gw, gh = (G, max(2, round(G * ch / cw))) if cw >= ch else (max(2, round(G * cw / ch)), G)
    dg = cv2.resize(d, (gw, gh), interpolation=cv2.INTER_AREA)
    mg = cv2.resize(inside.astype(np.float32), (gw, gh), interpolation=cv2.INTER_AREA)
    body = mg > 0.5
    interior = body & ~grow(~body, 1)
    if interior.sum() < 8:
        interior = body
    if interior.sum() < 4:
        return None
    core = dg[interior]
    med = float(np.median(core))
    lo, hi = np.percentile(core, [2, 98])
    dg = med + (np.clip(dg, lo, hi) - med) * RELIEF
    dg = despeckle(dg, body, med)
    # the silhouette's rim sees background depth and would stretch into spikes: grow the interior over it
    known = interior.copy()
    for _ in range(4):
        acc = np.zeros_like(dg)
        cnt = np.zeros_like(dg)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            acc += np.roll(np.roll(np.where(known, dg, 0), dy, 0), dx, 1)
            cnt += np.roll(np.roll(known, dy, 0), dx, 1)
        add = ~known & (cnt > 0)
        dg = np.where(add, acc / np.maximum(cnt, 1), dg)
        known |= add
    dg = nearest_known(dg, known)

    # the skirt hangs straight down from the lowest body vertex of each column
    for x in range(gw):
        rows = np.nonzero(body[:, x])[0]
        if len(rows) and rows[-1] < gh - 1:
            dg[rows[-1] + 1:, x] = dg[rows[-1], x]

    # texture: the crop, its alpha matted from the animal's mask, the edge colours taken from the body
    soft = matter.alpha(crop, inside, others)
    alpha = (soft * 255 + 0.5).astype(np.uint8)
    rgba = np.dstack([carry_colour(crop, soft), alpha])
    if skirt >= 2:
        floor = np.where(inside.any(axis=0), ch - 1 - np.argmax(inside[::-1], axis=0), -1)     # lowest mask row of each column
        # only along the animal's footing: a column that ends high is the belly between two legs, and a
        # skirt there hangs as a fringe under the body
        rows = np.nonzero(inside.any(axis=1))[0]
        footing = rows.max() - 0.2 * (rows.max() - rows.min())
        for x in np.nonzero(floor >= max(4, footing))[0]:
            yb = int(floor[x])
            if alpha[min(yb, ch - 1), x] < 128 and alpha[max(0, yb - 3), x] < 128:
                continue
            n = min(skirt, ch - 1 - yb)
            if n < 1:
                continue
            rgba[yb + 1:yb + 1 + n, x, :3] = rgba[max(0, yb - 2), x, :3]
            rgba[yb + 1:yb + 1 + n, x, 3] = (alpha[max(0, yb - 3), x] * np.linspace(0.9, 0.0, n, endpoint=False)).astype(np.uint8)
    s = min(1.0, TEX_MAX / long)
    if s < 1:
        rgba = cv2.resize(rgba, (max(2, round(cw * s)), max(2, round(ch * s))), interpolation=cv2.INTER_AREA)
    return dict(i=i, track=track, box=(int(x0), int(y0), int(x1), int(y1)), gw=gw, gh=gh, depth=dg.astype(np.float32),
                body=body, med=med, rgba=rgba, area=int(m.sum()),
                ground=float(ground), foot_uv=(float(np.median(cx)) / W, float(np.median(cy)) / H))


def smooth_track(shells):
    """median-filter each track's distance over time, so a hoof hidden in the grass cannot make the
    animal jump toward or away from the lens, then rescale each shell about its own median"""
    order = sorted(shells, key=lambda s: s["i"])
    logs = np.log([s["med"] for s in order])
    half = SMOOTH // 2
    for k, s in enumerate(order):
        lo, hi = max(0, k - half), min(len(order), k + half + 1)
        s["med_s"] = float(np.exp(np.median(logs[lo:hi])))
    return order


def regularise(cam, shell):
    """thin the relief of a shell along its camera rays, so it never gets thicker than ~half its width
    (stable.js did this on load: stable-math.mjs regularisePositions). Source projection is unchanged."""
    dg, body = shell["depth"], shell["body"]
    gh, gw = dg.shape
    x0, y0, x1, y1 = shell["box"]
    u = (x0 + (np.arange(gw) + 0.5) / gw * (x1 - x0)) / cam.src_w
    v = (y0 + (np.arange(gh) + 0.5) / gh * (y1 - y0)) / cam.src_h
    uu, vv = np.meshgrid(u, v)
    p = cam.lift(uu, vv, dg)
    centre = shell["med"]
    z = p[..., 2][body]
    if len(z) < 4:
        return 1.0
    cross = lambda a: np.percentile(a, 90) - np.percentile(a, 10)
    wx = (p[..., 0] * centre / p[..., 2])[body]
    wy = (p[..., 1] * centre / p[..., 2])[body]
    relief = float(np.clip(0.45 * min(cross(wx), cross(wy)) / max(cross(z), 1e-6), 0.05, 1.0))
    shell["depth"] = (centre + (dg - centre) * relief).astype(np.float32)
    return relief



def contact_shift(env_depth, s, work, limit=0.15):
    """how far, along its camera rays, a shell must slide for its lowest vertices (hooves) to sit on
    the ground under them. Clamped: hooves hidden in grass make a belly look like the ground.
    s["hit"] records whether the clamp had to act: the contact was then not believable."""
    dg, body = s["depth"], s["body"]
    gh, gw = dg.shape
    ys, xs = np.nonzero(body)
    s["hit"] = False
    if len(ys) < 8:
        return 0.0
    x0, y0, x1, y1 = s["box"]
    px = x0 + (xs + 0.5) / gw * (x1 - x0)
    py = y0 + (ys + 0.5) / gh * (y1 - y0)
    low = py >= np.percentile(py, 92)
    ground = np.median(sample_depth(env_depth, px[low], py[low], work.w, work.h))
    mine = np.median(dg[ys[low], xs[low]])
    want = ground - mine
    s["hit"] = bool(abs(want) > limit * ground)
    return float(np.clip(want, -limit * ground, limit * ground))


CAP_EPS = 0.003  # capped vertices stop this share short of the scene: exactly coplanar shell
                 # triangles z-fight against the environment into a stable mosaic (squirrel, Oct 2026).
                 # Far below the 5 % the capped-share check counts, so the honesty metrics are untouched.


def cap_to_scene(env_depth, s, work):
    """an animal visible at a pixel is nearer than whatever the empty scene shows there, so no body
    vertex may lie behind it. Depth estimates say otherwise now and then; the physics wins.
    s["capped"]: share of body vertices that had to move by more than 5 % of the scene's distance there
    (a lot of them means something stands in front of the animal, or its depth was wrong)."""
    dg, body = s["depth"], s["body"]
    gh, gw = dg.shape
    x0, y0, x1, y1 = s["box"]
    px = x0 + (np.arange(gw)[None, :] + 0.5) / gw * (x1 - x0) + np.zeros((gh, 1))
    py = y0 + (np.arange(gh)[:, None] + 0.5) / gh * (y1 - y0) + np.zeros((1, gw))
    scene = sample_depth(env_depth, px.ravel(), py.ravel(), work.w, work.h).reshape(gh, gw)
    capped = np.minimum(dg, scene * (1 - CAP_EPS))
    s["capped"] = float(((dg - capped) > 0.05 * scene)[body].mean()) if body.any() else 0.0
    s["depth"] = np.where(body, capped, dg)


def smooth_values(order, key, window=SMOOTH):
    """median of `key` over `window` samples of the track, written back as key + '_s'"""
    values = np.array([s[key] for s in order])
    half = window // 2
    for k, s in enumerate(order):
        s[key + "_s"] = float(np.median(values[max(0, k - half):min(len(order), k + half + 1)]))
