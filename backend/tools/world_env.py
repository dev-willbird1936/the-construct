"""The still half of a fixed-camera world: a clean plate, and the depth of it."""
import gc
import hashlib
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from world_common import hide_strip
from world_inpaint import fill

PLATE_FRAMES = 120   # frames the median is taken over, spread through the clip
MASK_GROW = 9        # px: a rim of the animal must never reach the plate


def animals(work, i, tracks=None):
    """sample i's animal pixels: every track's, or only those of `tracks` (ids)"""
    lab = work.label(i)
    return lab > 0 if tracks is None else np.isin(lab, list(tracks))


def union_mask(work, i, grow=MASK_GROW, tracks=None):
    m = animals(work, i, tracks).astype(np.uint8)
    return cv2.dilate(m, np.ones((grow, grow), np.uint8)) > 0 if grow else m > 0


FAR_SHARE = 0.0225  # of the frame's height: a witness this far from every mask cannot be a mask's mistake (24 px at 1080 p)
MIN_EVIDENCE = 5    # such witnesses a pixel needs; fewer and it is filled, not measured (a median of three survives one bad witness)
TRUST_SHARE = 0.045  # of the frame's height (48 px at 1080 p): where a pixel counts as a fully trustworthy witness
MIN_FREE = 8         # moments a pixel must be seen animal-free for its median to be a measurement
EXTRA_FRAMES = 40    # frames added beyond the even spread, chosen to cover what the spread left thin


def free_maps(work, overlay):
    """For every sample, a quarter-size mask of where an animal was (grown), and the number of samples
    in which each pixel was free of any. Cheap: no footage is read, only the tracker's labels.
    Where the tracker loses an animal (it is somewhere, unmasked), the pixels it may occupy are not
    free: the box that spans where it was and where it reappears, for the samples in between. A sample
    whose animals all but vanish (or lose half their area) while the seconds around it are busy is
    not free anywhere; but if that is most of the clip the rule is not trusted and is dropped."""
    h4, w4 = work.h // 4, work.w // 4
    masks = np.zeros((work.n, h4, w4), bool)
    boxes = {}
    for i in range(work.n):
        lab = cv2.resize(work.label(i), (w4, h4), interpolation=cv2.INTER_NEAREST)
        masks[i] = lab > 0
        for t in np.unique(lab):
            if t:
                ys, xs = np.nonzero(lab == t)
                boxes[(i, int(t))] = (xs.min(), ys.min(), xs.max(), ys.max())
        masks[i] = cv2.dilate(masks[i].astype(np.uint8), np.ones((MASK_GROW // 4 + 1, MASK_GROW // 4 + 1), np.uint8)) > 0
    area = masks.reshape(work.n, -1).mean(1)
    sudden = np.zeros(work.n, bool)
    for i in range(work.n):
        near = np.r_[area[max(0, i - 45):i], area[i + 1:i + 46]]
        if len(near) and np.median(near) > 0.004 and area[i] < 0.3 * np.median(near):
            sudden[i] = True
        # a valley: the animal is much larger a second before AND a second after (half a mask is gone)
        before, after = area[max(0, i - 30):i], area[i + 1:i + 31]
        if len(before) and len(after) and min(before.max(), after.max()) > 0.004 and area[i] < 0.7 * min(before.max(), after.max()):
            sudden[i] = True
    if sudden.mean() <= 0.4:
        masks[sudden] = True
    present = {}
    for (i, t) in boxes:
        present.setdefault(t, []).append(i)
    pad = max(2, MASK_GROW // 2)
    for t, seen in present.items():
        seen.sort()
        for a, b in zip(seen, seen[1:]):
            if b - a > 1:
                x0 = min(boxes[(a, t)][0], boxes[(b, t)][0]) - pad
                y0 = min(boxes[(a, t)][1], boxes[(b, t)][1]) - pad
                x1 = max(boxes[(a, t)][2], boxes[(b, t)][2]) + pad
                y1 = max(boxes[(a, t)][3], boxes[(b, t)][3]) + pad
                masks[a + 1:b, max(0, y0):y1 + 1, max(0, x0):x1 + 1] = True
    return masks, (~masks).sum(0).astype(np.int32)


def suspect_samples(masks):
    return masks.reshape(len(masks), -1).all(1)


def choose_frames(work, masks, free_all):
    """an even spread through the clip, plus frames picked greedily to cover pixels the spread saw
    animal-free fewer than MIN_FREE times although the clip did (an animal that stood still, then left)"""
    spread = np.linspace(0, work.n - 1, min(PLATE_FRAMES, work.n)).round().astype(int)
    have = (~masks[spread]).sum(0)
    chosen = list(dict.fromkeys(spread.tolist()))
    for _ in range(EXTRA_FRAMES):
        need = (have < MIN_FREE) & (free_all > have)
        if need.mean() < 0.0005:
            break
        gain = (~masks & need).reshape(work.n, -1).sum(1)
        gain[chosen] = 0
        best = int(gain.argmax())
        if gain[best] < 20:
            break
        chosen.append(best)
        have = have + (~masks[best])
    return np.array(sorted(chosen))


def median_weights(trust, full):
    """integer weights, so the CPU and GPU medians agree to the last pixel: a free pixel's trust (0-255)
    in thousandths, and a free pixel is never worth less than nothing (one thousandth)"""
    return trust.astype(np.int32) * 1000 + (~full)


def weighted_median(frames, trust, full, rows=None):
    """per pixel and channel, the median of `frames` (N x H x W x 3 uint8) weighted by trust over the N
    moments: the first value, in sorted order, whose cumulative weight reaches half the total. Where a pixel
    has no weight at all (every moment masked), its smallest value. On the GPU when there is one (the same
    result in a second or two instead of half a minute), else on the CPU."""
    n, h, w, _ = frames.shape
    plate = np.empty((h, w, 3), np.uint8)
    try:
        import os
        import torch
        if os.environ.get("PLATE_GPU", "1") == "0" or not torch.cuda.is_available():
            raise ImportError
        # row blocks bounded to ~64 MB of samples, so the sort fits beside anything else on the card
        step = rows or max(1, min(h, (64 << 20) // max(1, n * w * 3)))
        with torch.no_grad():
            for y in range(0, h, step):
                v = torch.from_numpy(np.ascontiguousarray(frames[:, y:y + step])).cuda()
                wt = torch.from_numpy(median_weights(trust[:, y:y + step], full[:, y:y + step])).cuda()
                vs, order = torch.sort(v, dim=0)
                cs = torch.cumsum(torch.gather(wt.unsqueeze(-1).expand_as(v), 0, order).long(), dim=0)
                pos = (2 * cs >= cs[-1:]).to(torch.uint8).argmax(dim=0, keepdim=True)
                plate[y:y + step] = torch.gather(vs, 0, pos)[0].cpu().numpy()
                del v, wt, vs, order, cs, pos
        torch.cuda.empty_cache()
        return plate
    except (ImportError, RuntimeError) as error:     # no card, or no room on it: the CPU gives the same plate
        if not isinstance(error, ImportError):
            print(f"plate: GPU median failed ({str(error)[:80]}); on the CPU", flush=True)
    # Smaller row blocks keep the gathers in cache without changing their order.
    for y in range(0, h, rows or 4):
        b = slice(y, y + (rows or 4))
        v = np.ascontiguousarray(frames[:, b].transpose(1, 2, 3, 0))
        wt = median_weights(trust[:, b], full[:, b]).transpose(1, 2, 0)[:, :, None, :]
        order = np.argsort(v, axis=-1)
        vs = np.take_along_axis(v, order, axis=-1)
        cs = np.cumsum(np.take_along_axis(np.broadcast_to(wt, v.shape), order, axis=-1), axis=-1, dtype=np.int64)
        pos = (2 * cs >= cs[..., -1:]).argmax(axis=-1)
        plate[b] = np.take_along_axis(vs, pos[..., None], axis=-1)[..., 0]
    return plate


def build_plate(work, overlay):
    """per-pixel median of every chosen moment that pixel was free of animals.
    Returns (plate uint8 HxWx3, never bool HxW: pixels never seen well, now filled,
    unseen: their share of the frame)."""
    cache = work.dir / "plate.png"
    info = work.dir / "plate.json"
    if cache.exists() and (work.dir / "never.png").exists() and info.exists():
        return (np.asarray(Image.open(cache).convert("RGB")), np.asarray(Image.open(work.dir / "never.png")) > 0,
                json.loads(info.read_text())["unseen"])
    masks, free_all = free_maps(work, overlay)
    pick = choose_frames(work, masks, free_all)
    print(f"plate: {len(pick)} frames", flush=True)
    frames = np.stack([work.frame(i) for i in pick])
    # the tracker's masks plus what free_maps took out (the boxes of lost animals, whole suspect samples)
    full = np.stack([union_mask(work, i) | (cv2.resize(masks[i].astype(np.uint8), (work.w, work.h), interpolation=cv2.INTER_NEAREST) > 0) for i in pick])
    # A tracker's mask is wrong at its edges first (a black bear in infrared loses its flank): a
    # pixel seen just beside an animal is a worse witness than one seen far from every animal.
    # Weighted median, the weight growing with the distance to the nearest mask over TRUST_PX.
    TRUST_PX, FAR_PX = TRUST_SHARE * work.h, FAR_SHARE * work.h
    trust = np.stack([np.clip(cv2.distanceTransform((~m).astype(np.uint8), cv2.DIST_L2, 3), 0, TRUST_PX) / TRUST_PX * 255 for m in full]).astype(np.uint8)
    trust[full] = 0
    h, w = work.h, work.w
    evidence = (trust >= FAR_PX / TRUST_PX * 255).sum(axis=0)   # witnesses well away from every mask
    never = full.all(axis=0)
    plate = weighted_median(frames, trust, full)
    del frames, full
    gc.collect()
    # Where almost no pixel was ever seen well (under an animal that never left, or beside one whose
    # mask was wrong), the median is the animal itself: continue the surroundings instead.
    never = never | (evidence < MIN_EVIDENCE)
    never[int(h * overlay):] = False
    unseen = float(never.mean())
    if never.any():
        hole = cv2.dilate(never.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        hole[int(h * overlay):] = False
        plate = fill(plate, hole)
    plate = hide_strip(plate, overlay)
    Image.fromarray(plate).save(cache)
    Image.fromarray((never * 255).astype(np.uint8)).save(work.dir / "never.png")
    info.write_text(json.dumps({"unseen": unseen}))
    print(f"plate: {unseen:.2%} of the frame never seen well, continued from its surroundings", flush=True)
    return plate, never, unseen


def plate_depth(work, plate, process_res=756):
    """Depth Anything 3 on the clean plate: one sharp view of the scene with nothing in front of it.
    Returns dict(depth, conf, K (3x3 at depth-map size), sky)."""
    cache = work.dir / "plate_depth.npz"
    if cache.exists():
        return dict(np.load(cache))
    import torch
    from depth_anything_3.api import DepthAnything3
    model = DepthAnything3.from_pretrained("depth-anything/DA3-LARGE").to("cuda").eval()
    with torch.no_grad():
        pred = model.inference([Image.fromarray(plate)], process_res=process_res)
    out = dict(depth=pred.depth[0], conf=pred.conf[0], K=pred.intrinsics[0],
               sky=(pred.sky[0] if pred.sky is not None else np.zeros_like(pred.depth[0], dtype=bool)))
    np.savez(cache, **out)
    del model
    gc.collect()
    torch.cuda.empty_cache()
    return out


# ── geometry ─────────────────────────────────────────────────────────────

from world_common import Camera, grid_triangles  # noqa: E402


def make_camera(work, plate_depth_out):
    dep, K = plate_depth_out["depth"], plate_depth_out["K"]
    h, w = dep.shape
    return Camera(tan_y=(h / 2) / float(K[1, 1]), src_w=work.w, src_h=work.h, scale=float(np.median(dep)))


def depth_uv(shape):
    h, w = shape
    ys, xs = np.mgrid[0:h, 0:w]
    return (xs + 0.5) / w, (ys + 0.5) / h


def fit_ground(cam, depth, below=0.36, tries=800, tol=0.02, seed=0):
    """One plane through the lake and the shore: RANSAC over everything under the far shore line.
    Returns (n, off) with n . P + off = 0 in camera space."""
    h, w = depth.shape
    u, v = depth_uv(depth.shape)
    pts = cam.lift(u, v, depth).reshape(-1, 3)
    rows = np.repeat(np.arange(h), w)
    pool = np.flatnonzero(rows > below * h)
    rng = np.random.default_rng(seed)
    best = None
    for _ in range(tries):
        s = pts[rng.choice(pool, 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0])
        length = np.linalg.norm(n)
        if length < 1e-9:
            continue
        n /= length
        if n[1] < 0:           # the ground faces up: Y is down, so its normal must point up (-Y)
            n = -n
        off = -n @ s[0]
        count = (np.abs(pts[pool] @ n + off) < tol * cam.scale).sum()
        if best is None or count > best[0]:
            best = (count, n, off)
    _, n, off = best
    # refine on the inliers
    inl = pool[np.abs(pts[pool] @ n + off) < tol * cam.scale]
    c = pts[inl].mean(0)
    n = np.linalg.svd(pts[inl] - c, full_matrices=False)[2][-1]
    if n[1] < 0:
        n = -n
    return n, float(-n @ c), len(inl) / len(pool)


def snap_to_ground(cam, depth, plane, tol=0.04):
    """depth with the ground plane's own depth wherever the map agrees with it: a lake is flat, and
    a flat lake takes the live footage as a texture without wobble. Returns (depth, weight)."""
    n, off, _ = plane
    u, v = depth_uv(depth.shape)
    ray = cam.rays(u, v)
    denom = ray @ n
    with np.errstate(divide="ignore", invalid="ignore"):
        on_plane = np.where(denom < -1e-4, -off / denom, np.inf)
    on_plane = np.where(np.isfinite(on_plane) & (on_plane > 0), on_plane, depth)
    res = np.abs(depth - on_plane) / cam.scale
    t = np.clip((res - tol * 0.5) / (tol * 0.5), 0, 1)
    wgt = 1 - t * t * (3 - 2 * t)
    # only under the far shore line; trees and grass above it keep their own depth
    h = depth.shape[0]
    wgt[: int(0.3 * h)] = 0
    wgt = cv2.GaussianBlur(wgt.astype(np.float32), (0, 0), 1.5)
    return wgt * on_plane + (1 - wgt) * depth, wgt


def fill_depth(gd, ok):
    """depth for the cells the environment left out: nearest valid, then diffused"""
    from scipy import ndimage
    f = gd[tuple(ndimage.distance_transform_edt(~ok, return_distances=False, return_indices=True))]
    for _ in range(8):
        f = np.where(ok, gd, ndimage.gaussian_filter(f, 3))
    return f


STRETCH = 6.0   # a quad may be this many times longer than its own picture
ISLAND = 0.005  # of the grid: a crisp piece cut off from the rest and smaller than this is a fragment, not a surface
FAR_WINDOW = 25  # grid cells: wide enough that a pole or a reed drops out of the backdrop altogether


def scale_disp_erode(disp, k):
    """minimum disparity (farthest depth) within k x k cells"""
    return cv2.erode(disp.astype(np.float32), np.ones((k, k), np.uint8)).astype(np.float64)


def backdrop_disparity(cam, gd, gok):
    """the backdrop's disparity on the depth grid: at a depth edge the FAR side (what an occluder hides is
    the background), over FAR_WINDOW cells. The window's minimum is blocky, and a step between two blocks
    is a ramp an orbit sees edge-on as a streak; blurred, the steps become gentle slopes, and the farther
    of the two is kept so the backdrop never comes in front of a crisp surface."""
    far = scale_disp_erode(cam.scale / fill_depth(gd, gok), FAR_WINDOW)
    return np.minimum(far, cv2.GaussianBlur(far.astype(np.float32), (0, 0), FAR_WINDOW / 3).astype(np.float64))


HIDDEN = 1.25      # the crisp surface is this many times nearer (in disparity) than the backdrop behind it
HIDDEN_EDGE = 1.3  # an occlusion edge: one grid cell's corners differ this many times in disparity
HIDDEN_REACH = 12  # grid cells from an occlusion edge: about what a full orbit slides a near bush aside


def backdrop_hidden(cam, depth, valid, step=2):
    """where, on the depth map, something stands in front of the backdrop beside an occlusion edge (a near
    bush against the lake, a bank against the river): the backdrop there is what an orbit uncovers behind
    it, so its picture is inpainted rather than the occluder's own colours on the far surface (the shards
    an orbit showed beside the moose). Ground that only slopes toward the lens is no occluder: away from
    every edge the crisp surface covers the backdrop whole."""
    gd = depth[::step, ::step]
    gok = valid[::step, ::step]
    disp = cam.scale / gd
    q = [disp[:-1, :-1], disp[:-1, 1:], disp[1:, :-1], disp[1:, 1:]]
    edge = np.zeros(disp.shape, np.uint8)
    edge[:-1, :-1] = (np.maximum.reduce(q) / np.maximum(np.minimum.reduce(q), 1e-6)) >= HIDDEN_EDGE
    near_edge = cv2.dilate(edge, np.ones((2 * HIDDEN_REACH + 1, 2 * HIDDEN_REACH + 1), np.uint8)) > 0
    hidden = (disp > backdrop_disparity(cam, gd, gok) * HIDDEN) & near_edge
    return cv2.resize(hidden.astype(np.uint8), (depth.shape[1], depth.shape[0]), interpolation=cv2.INTER_NEAREST) > 0


def extend_disparity(disp, ph, pw):
    """the backdrop's disparity continued `ph` rows and `pw` columns past every edge. Across a picture a plane's
    disparity is linear, so it is continued linearly (odd reflection) from a smoothed copy, and the ground goes on
    as ground and a bank as a bank: repeating the edge stood a wall up at the frame's edge, which the surround past
    it shows as a raised frame. Kept between half the farthest and twice the nearest disparity in the frame."""
    h, w = disp.shape
    smooth = cv2.GaussianBlur(disp.astype(np.float32), (0, 0), 3).astype(np.float64)
    out = np.pad(smooth, ((min(ph, h - 1), min(ph, h - 1)), (min(pw, w - 1), min(pw, w - 1))), mode="reflect", reflect_type="odd")
    if out.shape != (h + 2 * ph, w + 2 * pw):
        out = np.pad(out, ((ph - min(ph, h - 1),) * 2, (pw - min(pw, w - 1),) * 2), mode="edge")
    out[ph:ph + h, pw:pw + w] = disp
    return np.clip(out, 0.5 * float(disp.min()), 2.0 * float(disp.max()))


def env_geometry(mesh, cam, depth, weight, valid, step=2, tau=0.03, pad=0.25):
    """the crisp environment surface and the backdrop behind it. A quad survives when its corners
    are valid and lie on one surface: a big jump in DISPARITY across it is an occlusion edge.
    (Disparity, not depth: what an orbit shows of a gap scales with 1/depth, so a distant tree line
    keeps its triangles and a near edge does not.)"""
    h, w = depth.shape
    gd = depth[::step, ::step]
    gok = valid[::step, ::step]
    gw_, gh_ = gd.shape[1], gd.shape[0]
    gu, gv = depth_uv(depth.shape)
    gu, gv = gu[::step, ::step], gv[::step, ::step]
    disp = cam.scale / gd
    q = [disp[:-1, :-1], disp[:-1, 1:], disp[1:, :-1], disp[1:, 1:]]
    jump = np.maximum.reduce(q) - np.minimum.reduce(q)
    keep = gok[:-1, :-1] & gok[:-1, 1:] & gok[1:, :-1] & gok[1:, 1:] & (jump < tau)
    p = cam.lift(gu, gv, gd)
    nrm = np.cross(p[1:, :-1] - p[:-1, :-1], p[:-1, 1:] - p[:-1, :-1])
    ray = p[:-1, :-1]
    facing = np.abs((nrm * ray).sum(-1)) / (np.linalg.norm(nrm, axis=-1) * np.linalg.norm(ray, axis=-1) + 1e-9)
    gw_wgt = weight[::step, ::step]
    flat = (gw_wgt[:-1, :-1] > 0.5) & (gw_wgt[:-1, 1:] > 0.5) & (gw_wgt[1:, :-1] > 0.5) & (gw_wgt[1:, 1:] > 0.5)
    keep &= (facing > 0.07) | flat       # a grazing quad is a guess, unless it is the plane itself
    # a quad far larger than the picture it was cut from is a stretched sheet, not a surface
    edge = np.maximum(np.linalg.norm(p[1:, :-1] - p[:-1, :-1], axis=-1), np.linalg.norm(p[:-1, 1:] - p[:-1, :-1], axis=-1))
    footprint = np.maximum(p[:-1, :-1, 2], 1e-6) * 2 * cam.tan_y * step / h
    keep &= (edge < STRETCH * footprint) | flat
    keep |= flat & gok[:-1, :-1] & gok[:-1, 1:] & gok[1:, :-1] & gok[1:, 1:]
    # a crisp piece cut off from the rest by occlusion edges and that small is a patch of foggy sky read as near, or a
    # twig: it floats in front of the backdrop and shreds when orbited (the moose's dark wisps along the frame top).
    # The backdrop, which takes the far side there, shows instead
    n, lab, stats, _ = cv2.connectedComponentsWithStats(keep.astype(np.uint8), connectivity=4)
    if n > 2:
        keep &= stats[lab, cv2.CC_STAT_AREA] >= ISLAND * keep.size
    uv = np.stack([gu.ravel(), 1 - gv.ravel()], 1)
    rec = mesh.emit(cam.to_world(p).reshape(-1, 3), uv, grid_triangles(gw_, gh_, keep), grid=("env", gw_, gh_, keep))
    # the backdrop: the whole frame with no quad dropped, holes filled from their surroundings,
    # and `pad` of the frame beyond every edge, behind the crisp surface
    pw, ph = int(gw_ * pad), int(gh_ * pad)
    # at a depth edge the backdrop takes the FAR side: what an occluder hides is the background, and
    # a sheet stretched from a near pole to a far tree line is the streak seen when orbiting
    far = backdrop_disparity(cam, gd, gok)
    fd = cam.scale / extend_disparity(far, ph, pw)
    eu = (np.arange(-pw, gw_ + pw) * step + 0.5 + (step - 1) * 0) / w
    ev = (np.arange(-ph, gh_ + ph) * step + 0.5) / h
    egu, egv = np.meshgrid(eu, ev)
    every = np.ones((fd.shape[0] - 1, fd.shape[1] - 1), bool)
    fill = mesh.emit(cam.to_world(cam.lift(egu, egv, fd)).reshape(-1, 3), np.stack([egu.ravel(), 1 - egv.ravel()], 1),
                     grid_triangles(fd.shape[1], fd.shape[0], every), grid=("fill", fd.shape[1], fd.shape[0], every))
    return rec, fill


def plate_fingerprint(plate):
    header = json.dumps({"shape": list(plate.shape), "dtype": str(plate.dtype)}, sort_keys=True).encode()
    return hashlib.sha256(header + b"\0" + plate.tobytes()).hexdigest()


def plate_evidence_path(work, fingerprint, overlay):
    backend = Path(__file__).resolve().parents[1]
    sources = ("tools/plate-check.mjs", "lib/detect.js", "lib/sam-image-result.mjs", "package-lock.json")
    config = {"version": 2, "checked_stage": "input", "output_rechecked": False,
              "source_sha256": {p: hashlib.sha256((backend / p).read_bytes()).hexdigest() for p in sources},
              "concept": work.tracks["concept"], "overlay": float(overlay), "out_sha": fingerprint}
    key = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    return work.dir / "plate-checks" / f"{key}.json", config


def leftovers(work, plate, overlay, allow_request=True):
    """SAM, on the finished plate as a still: an animal the tracker never found (and so no statistic
    flags) is still an animal. Whatever it finds is continued from its surroundings.
    Returns (plate, PRE-fill share found). An exact output-image/prompt cache
    retains that share; allow_request=False refuses an uncached SAM call."""
    import json as _json
    import subprocess
    fingerprint = plate_fingerprint(plate)
    cache_path, config = plate_evidence_path(work, fingerprint, overlay)
    if cache_path.exists():
        try:
            cached = _json.loads(cache_path.read_text())
            if not isinstance(cached, dict):
                raise ValueError("invalid evidence")
            share = cached["share"]
            if (any(cached.get(k) != v for k, v in config.items()) or cached.get("checked") is not True or
                    not isinstance(cached.get("in_sha"), str) or len(cached["in_sha"]) != 64 or
                    isinstance(share, bool) or not isinstance(share, (int, float)) or
                    not math.isfinite(share) or not 0 <= share <= 1 or
                    (share == 0 and cached["in_sha"] != cached["out_sha"])):
                raise ValueError("invalid evidence")
        except (OSError, ValueError, TypeError, KeyError):
            raise RuntimeError("cached plate evidence is invalid; plate cleanliness is unverified") from None
        return plate, float(share)
    if not allow_request:
        raise RuntimeError("plate check is uncached; a new SAM request is not permitted")
    mask_path = work.dir / "plate_leftover.png"
    Image.fromarray(plate).save(work.dir / "plate_check.png")
    backend = Path(__file__).resolve().parents[1]
    try:
        run = subprocess.run(["node", str(backend / "tools" / "plate-check.mjs"), str(work.dir / "plate_check.png"), work.tracks["concept"], str(mask_path)],
                             cwd=backend, capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        raise RuntimeError("plate check failed; plate cleanliness is unverified") from None
    if run.returncode != 0:
        raise RuntimeError("plate check failed; plate cleanliness is unverified")
    try:
        found = _json.loads(run.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        raise RuntimeError("plate check returned invalid evidence; plate cleanliness is unverified") from None
    share = found.get("share") if isinstance(found, dict) else None
    if (not isinstance(found, dict) or found.get("checked") is not True or
            not isinstance(found.get("found"), bool) or isinstance(share, bool) or
            not isinstance(share, (int, float)) or not math.isfinite(share) or
            not 0 <= share <= 1 or found["found"] != (share > 0)):
        raise RuntimeError("plate check returned invalid evidence; plate cleanliness is unverified")
    if found["found"]:
        try:
            mask = np.asarray(Image.open(mask_path).convert("L")) > 0
        except (OSError, ValueError):
            raise RuntimeError("plate check mask is unavailable; plate cleanliness is unverified") from None
        if mask.shape != plate.shape[:2] or abs(float(mask.mean()) - share) > 1e-12:
            raise RuntimeError("plate check mask disagrees with its evidence; plate cleanliness is unverified")
        hole = cv2.dilate(mask.astype(np.uint8), np.ones((19, 19), np.uint8)) > 0
        hole[int(plate.shape[0] * overlay):] = False
        print(f"plate check: an animal left in the plate ({share:.2%} of the frame): filled", flush=True)
        plate = fill(plate, hole)
    # Keep the measured PRE-fill share. Rechecking an already repaired plate
    # must not erase the original failure or quietly buy another SAM call.
    evidence_path, output_config = plate_evidence_path(work, plate_fingerprint(plate), overlay)
    evidence_path.parent.mkdir(exist_ok=True)
    record = {**output_config, "checked": True, "share": share, "in_sha": fingerprint}
    try:
        with evidence_path.open("x") as evidence:
            _json.dump(record, evidence)
    except FileExistsError:
        try:
            if _json.loads(evidence_path.read_text()) != record:
                raise ValueError("conflicting evidence")
        except (OSError, ValueError):
            raise RuntimeError("conflicting plate evidence; plate cleanliness is unverified") from None
    return plate, float(share)
