"""Bakes the data behind stable.html: a moving-camera clip rebuilt as one still
world with its subject left behind at every moment.

Depth Anything 3 recovers every frame's camera and depth in one shared world.
Each depth map becomes a surface, textured with the full-resolution frame, so
nothing is drawn as dots:
  * the environment is a set of keyframe surfaces with the subject cut out;
    together they hold still while the recording camera moves through them
  * the subject is one small surface per frame, textured by a crop of that
    frame whose alpha is the SAM 3.1 mask, so its outline is pixel-sharp

  OUT=<bake> node backend/tools/make-lab.mjs <video> <concept> <seed>
  ffmpeg -i <video> -q:v 2 <frames>/f%04d.jpg
  <da3 python> backend/tools/make-stable.py <bake> <frames> <name> <clip>
writes assets/stable/<name>/; stable.html?clip=<name> shows it.
"""
import atexit
import gc
import json
import os
import shutil
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image, ImageFilter
from depth_anything_3.api import DepthAnything3
from stable_index import update_index


def rename_retry(src, dst, tries=30):
    """Windows briefly locks a freshly written folder (sync clients, indexers); wait it out"""
    for k in range(tries):
        try:
            return src.rename(dst)
        except PermissionError:
            if k == tries - 1:
                raise
            time.sleep(1)

bake, full, name, clip = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
# bake into a scratch folder and swap it in only once everything below has
# written successfully, so a crash mid-bake never leaves the live page
# pointing at a half-written folder
final_out = Path(__file__).resolve().parents[2] / "assets" / "stable" / name
# Inventory the final on-disk result even when a failed bake rolls back.
atexit.register(update_index, final_out.parent)
out = final_out.with_name(final_out.name + ".building")
shutil.rmtree(out, ignore_errors=True)
(out / "env").mkdir(parents=True)
(out / "sub").mkdir()
meta = json.loads((bake / "lab.json").read_text())
frames = meta["frames"]
KEY_EVERY = 3   # environment surfaces: one per this many frames
ENV_STEP = 2    # environment grid: every other depth sample
# OVERLAY=0.9 drops the bottom 10% of the frame: a trail camera's burnt-in
# timestamp would otherwise stand in the world as a wall
OVERLAY = float(os.environ.get("OVERLAY", "1"))


def hide_strip(img):
    """Cover the dropped overlay rows with a mirror of the rows above them."""
    if OVERLAY >= 1:
        return img
    top = int(img.shape[0] * OVERLAY)
    out = img.copy()
    out[top:] = img[max(0, 2 * top - img.shape[0]):top][::-1]
    return out

# the solve is the slow part; keep it next to the bake and reuse it
cache = bake / "da3.npz"
if not cache.exists():
    model = DepthAnything3.from_pretrained("depth-anything/DA3-LARGE").to("cuda").eval()
    with torch.no_grad():
        pred = model.inference([str(bake / f["src"]) for f in frames], process_res=504)
    np.savez(cache, depth=pred.depth, conf=pred.conf, K=pred.intrinsics, E=pred.extrinsics,
             rgb=pred.processed_images, sky=pred.sky if pred.sky is not None else np.zeros_like(pred.depth, dtype=bool))
    del model
    gc.collect()
    torch.cuda.empty_cache()
pred = np.load(cache)
depth, conf, K, E, rgb = pred["depth"], pred["conf"], pred["K"], pred["E"], pred["rgb"]
n, h, w = depth.shape
print(f"da3: {n} frames at {w}x{h}")

if E.shape[1] == 3:
    E = np.concatenate([E, np.tile([[[0, 0, 0, 1]]], (n, 1, 1))], axis=1)
c2w = np.linalg.inv(E)
sky = pred["sky"].astype(bool)
scale = float(np.median(depth))
ys, xs = np.mgrid[0:h, 0:w]
conf_floor = np.percentile(conf, 25)


def mask_for(i, size=(w, h)):
    return np.asarray(Image.open(bake / frames[i]["file"]).getchannel("A").resize(size, Image.BILINEAR)) / 255.0


def environment_mask_for(i, size=(w, h)):
    # Multi-target bakes can remove every tracked subject from the background
    # while keeping each frame's subject shell limited to its own mask.
    filename = frames[i].get("envFile", frames[i]["file"])
    return np.asarray(Image.open(bake / filename).getchannel("A").resize(size, Image.BILINEAR)) / 255.0


def grow(m, r):
    """binary dilation by r pixels (square), numpy only"""
    o = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            o |= np.roll(np.roll(m, dy, 0), dx, 1)
    return o


def lift(i, d, gx, gy):
    """pixel grid + depth -> three.js world (y up, z back), unit = median depth"""
    pix = np.stack([gx.ravel(), gy.ravel(), np.ones(gx.size)], 0)
    cam = (np.linalg.inv(K[i]) @ pix) * d.ravel()
    world = c2w[i, :3, :3] @ cam + c2w[i, :3, 3:4]
    return (world.T * np.array([1, -1, -1]) / scale).astype(np.float32)


def grid_triangles(gw, gh, keep_quad):
    """two triangles per kept quad of a gw x gh vertex grid"""
    qy, qx = np.nonzero(keep_quad)
    a = qy * gw + qx
    b, c, d = a + 1, a + gw, a + gw + 1
    return np.stack([a, c, b, b, c, d], 1).ravel().astype(np.uint32)


def source(i):
    return Image.open(full / Path(frames[i]["src"]).name).convert("RGB")


pos, uvs, idx = [], [], []
n_vert = 0


def emit(p, uv, tri):
    global n_vert
    rec = {"vertOffset": n_vert, "vertCount": len(p), "idxOffset": sum(len(x) for x in idx), "idxCount": len(tri)}
    pos.append(p), uvs.append(uv.astype(np.float32)), idx.append(tri + 0)
    n_vert += len(p)
    return rec


# ── environment ──────────────────────────────────────────────────────────
# A fixed camera (trail cams; DA3's per-frame pose estimate still jitters a
# little even though the real camera never moved) gains nothing from more
# than one keyframe surface: extra copies only differ by that jitter and by
# which pixels the subject happened to cover, so ranking them by nearness to
# "now" every frame made whichever copy won keep changing as playback moved.
# Below this spread, every frame's depth/colour is folded into ONE median
# surface instead, the same trick make-lab.mjs already uses for its plate:
# the union of ~n frames fills in whatever any single frame had covered.
FIXED_SPREAD = 0.05  # camera position spread, in units of median scene depth
cam_pos_u = (c2w[:, :3, 3] * np.array([1, -1, -1])) / scale
# a pan turns the camera without moving it, so position alone would call it fixed
FIXED_TURN = 2.0  # degrees
turn = max(np.degrees(np.arccos(np.clip((np.trace(c2w[0, :3, :3].T @ c2w[i, :3, :3]) - 1) / 2, -1, 1))) for i in range(n))
fixed_camera = bool(np.linalg.norm(cam_pos_u.max(0) - cam_pos_u.min(0)) < FIXED_SPREAD and turn < FIXED_TURN)


def env_validity(i, subject=True):
    c = rgb[i].astype(np.int16)
    # bright blue AND far: that is sky. White water is bright and bluish too,
    # but near, and must stay
    blue = (c[..., 2] > c[..., 0] + 18) & (c[..., 2] >= c[..., 1]) & (c.sum(-1) > 360) & (depth[i] > np.percentile(depth[i], 85))
    ok = ~sky[i] & ~blue & (conf[i] >= conf_floor) & (ys < h * OVERLAY)
    return ok & ~grow(environment_mask_for(i) > 0.2, 5) if subject else ok


def env_surface(gd, gok, ref, hole=None):
    """one surface from a depth+validity grid, viewed from frame `ref`'s pose.
    Quads over `hole` (painted-in, not seen) are ordered last: holeCount."""
    gh, gw = gd.shape
    # a quad survives if its corners are valid and lie on one surface: a big
    # depth ratio across it is an occlusion edge, which would be a stretched sheet
    q = [gd[:-1, :-1], gd[:-1, 1:], gd[1:, :-1], gd[1:, 1:]]
    ratio = np.maximum.reduce(q) / np.maximum(np.minimum.reduce(q), 1e-6)
    keep = gok[:-1, :-1] & gok[:-1, 1:] & gok[1:, :-1] & gok[1:, 1:] & (ratio < 1.05)
    # and it must face its own camera: a surface seen edge-on was guessed,
    # not seen, and turns into a smeared sheet from any other angle
    p = lift(ref, gd, gx, gy).reshape(gh, gw, 3)
    nrm = np.cross(p[1:, :-1] - p[:-1, :-1], p[:-1, 1:] - p[:-1, :-1])
    ray = p[:-1, :-1] - (c2w[ref, :3, 3] * np.array([1, -1, -1]) / scale)
    facing = np.abs((nrm * ray).sum(-1)) / (np.linalg.norm(nrm, axis=-1) * np.linalg.norm(ray, axis=-1) + 1e-9)
    keep &= facing > 0.07
    uv = np.stack([(gx.ravel() + 0.5) / w, 1 - (gy.ravel() + 0.5) / h], 1)
    if hole is None:
        return emit(p.reshape(-1, 3), uv, grid_triangles(gw, gh, keep))
    hq = hole[:-1, :-1] | hole[:-1, 1:] | hole[1:, :-1] | hole[1:, 1:]
    seen, guessed = grid_triangles(gw, gh, keep & ~hq), grid_triangles(gw, gh, keep & hq)
    rec = emit(p.reshape(-1, 3), uv, np.concatenate([seen, guessed]))
    rec["holeCount"] = len(guessed)
    return rec


def paint_out(img, m):
    """the frame with mask m (at depth-map size) painted in from its surroundings"""
    img = np.asarray(img)
    H, W = img.shape[:2]
    m = cv2.dilate(cv2.resize(m.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST), np.ones((3, 3), np.uint8))
    small = cv2.inpaint(cv2.resize(img, (W // 4, H // 4), interpolation=cv2.INTER_AREA),
                        cv2.resize(m, (W // 4, H // 4), interpolation=cv2.INTER_NEAREST), 6, cv2.INPAINT_TELEA)
    soft = cv2.GaussianBlur(cv2.resize(small, (W, H), interpolation=cv2.INTER_CUBIC), (0, 0), 5)
    return np.where(m[..., None] > 0, soft, img)


def fill_depth(gd, ok):
    """depth for the cells the environment left out: nearest valid, then diffused"""
    from scipy import ndimage
    f = gd[tuple(ndimage.distance_transform_edt(~ok, return_distances=False, return_indices=True))]
    for _ in range(8):
        f = np.where(ok, gd, ndimage.gaussian_filter(f, 3))
    return f


gx, gy = xs[::ENV_STEP, ::ENV_STEP], ys[::ENV_STEP, ::ENV_STEP]
env = []
fill = None
if fixed_camera:
    ref = 0  # near-identical poses; any one frame's is representative
    gd = np.median(depth[:, ::ENV_STEP, ::ENV_STEP], axis=0)
    med_rgb = np.median(rgb[:, ::ENV_STEP, ::ENV_STEP, :].astype(np.float32), axis=0).astype(np.uint8)
    votes = sum(env_validity(i)[::ENV_STEP, ::ENV_STEP].astype(np.int32) for i in range(n))
    gok = votes > n // 2  # a pixel counts once most frames agreed it was clean background
    rec = env_surface(gd, gok, ref)
    rec.update(frame=ref, tex="env/plate.jpg")
    Image.fromarray(hide_strip(med_rgb)).save(out / rec["tex"], quality=88)
    env.append(rec)
    # Backdrop: the whole frame, no quad dropped, holes and the cropped overlay
    # filled from their surroundings, and PAD of the frame beyond every edge.
    # It sits behind the crisp surface, so the lens sees only what that one
    # left out (the subject's footprint, sky, depth edges) instead of black.
    PAD = 0.25
    pw, ph = int(w * PAD) // ENV_STEP, int(h * PAD) // ENV_STEP
    fd = np.pad(fill_depth(gd, gok), ((ph, ph), (pw, pw)), mode="edge")
    egx, egy = np.meshgrid(np.arange(-pw, gd.shape[1] + pw) * ENV_STEP, np.arange(-ph, gd.shape[0] + ph) * ENV_STEP)
    fill = emit(lift(ref, fd, egx, egy), np.stack([(egx.ravel() + 0.5) / w, 1 - (egy.ravel() + 0.5) / h], 1),
                grid_triangles(fd.shape[1], fd.shape[0], np.ones((fd.shape[0] - 1, fd.shape[1] - 1), bool)))
else:
    PAD = 0.15
    # a margin is a flat guess perpendicular to the view; when the camera has
    # travelled far, thirty of them seen from the side are streaked slabs
    PAD_MAX_TRAVEL = 0.3  # camera position spread, in median-depth units
    PAD_MAX_TURN = 30.0  # degrees; a wide pan turns the margin into streaked slabs
    pad_on = bool(np.linalg.norm(cam_pos_u.max(0) - cam_pos_u.min(0)) < PAD_MAX_TRAVEL and turn < PAD_MAX_TURN)
    PW, PH = int(w * PAD) // (ENV_STEP * 3), int(h * PAD) // (ENV_STEP * 3)
    for i in range(0, n, KEY_EVERY):
        # Where the subject stood the keyframe has no background. Rather than
        # cut a hole, take depth from the surroundings and paint the texture in
        # from them: from the lens the subject hides it, from anywhere else it
        # reads as blurred ground instead of black.
        sub_m = grow(environment_mask_for(i) > 0.2, 5)[::ENV_STEP, ::ENV_STEP]
        ok = env_validity(i, subject=False)[::ENV_STEP, ::ENV_STEP]
        gd = depth[i][::ENV_STEP, ::ENV_STEP]
        gd = np.where(sub_m, fill_depth(gd, ok & ~sub_m), gd)
        rec = env_surface(gd, ok, i, hole=sub_m)
        rec.update(frame=i, tex=f"env/k{i:03d}.jpg")
        # a ring of PAD beyond every edge, coarse: rendered behind everything, so
        # what no keyframe saw is a dim continuation of the nearest one instead
        # of black. Only the ring: filling the interior too would bring back the
        # occlusion-edge quads that were dropped as stretched sheets.
        if pad_on:
            ps = ENV_STEP * 3
            okf = env_validity(i)[::ps, ::ps]
            fd = np.pad(fill_depth(depth[i][::ps, ::ps], okf), ((PH, PH), (PW, PW)), mode="edge")
            pgx, pgy = np.meshgrid(np.arange(-PW, okf.shape[1] + PW) * ps, np.arange(-PH, okf.shape[0] + PH) * ps)
            ring = np.ones((fd.shape[0] - 1, fd.shape[1] - 1), bool)
            ring[PH:-PH, PW:-PW] = False
            rec["pad"] = emit(lift(i, fd, pgx, pgy), np.stack([(pgx.ravel() + 0.5) / w, 1 - (pgy.ravel() + 0.5) / h], 1),
                              grid_triangles(fd.shape[1], fd.shape[0], ring))
        Image.fromarray(hide_strip(paint_out(source(i), grow(environment_mask_for(i) > 0.2, 5)))).save(out / rec["tex"], quality=86)
        env.append(rec)
print(f"environment: {'fixed camera, 1 merged plate' if fixed_camera else str(len(env)) + ' keyframe'} surface(s), "
      f"{sum(e['idxCount'] + e.get('pad', {}).get('idxCount', 0) for e in env) // 3} triangles")

# ── subject ──────────────────────────────────────────────────────────────
# In the whole-frame solve the animal is only a few dozen depth samples
# across, too coarse for its shape. So each frame's subject gets a second
# depth pass of its own: a full-resolution crop, fitted (scale and offset)
# onto the scene depth inside the mask so it still sits where it was seen.
RELIEF = float(os.environ.get("RELIEF", "0.8"))  # 1 = the crop's full relief
GRID = 140                                       # mesh samples on the long side
crop_cache = bake / "da3_crops.npz"
crop_depth = dict(np.load(crop_cache)) if crop_cache.exists() else {}
mono = None

sub = []
for i in range(n):
    inside = mask_for(i) > 0.5
    if inside.sum() < 20:
        sub.append(None)
        continue
    cover = grow(inside, 2)
    y0, y1 = np.nonzero(cover.any(1))[0][[0, -1]]
    x0, x1 = np.nonzero(cover.any(0))[0][[0, -1]]
    src = source(i)
    W, H = src.size
    px0, py0 = int(np.floor(x0 / w * W)), int(np.floor(y0 / h * H))
    px1, py1 = int(np.ceil((x1 + 1) / w * W)), int(np.ceil((y1 + 1) / h * H))
    crop = src.crop((px0, py0, px1, py1))
    cw, ch = crop.size

    # keyed on the crop box too: a different SAM run or a changed box for
    # the same frame index must not silently reuse another shape's depth
    key = f"f{i:03d}_{px0}_{py0}_{px1}_{py1}"
    if key not in crop_depth:
        if mono is None:
            mono = DepthAnything3.from_pretrained("depth-anything/DA3-LARGE").to("cuda").eval()
        with torch.no_grad():
            crop_depth[key] = mono.inference([np.asarray(crop)], process_res=504).depth[0]
    dc = crop_depth[key]

    # mesh grid over the crop, in full-frame pixels
    step = max(cw, ch) / GRID
    gw, gh = max(2, int(round(cw / step)) + 1), max(2, int(round(ch / step)) + 1)
    fx = np.linspace(px0, px1, gw)[None, :].repeat(gh, 0)
    fy = np.linspace(py0, py1, gh)[:, None].repeat(gw, 1)
    sample = lambda img, x, y: np.asarray(Image.fromarray(img.astype(np.float32)).resize((gw, gh), Image.BILINEAR)) if img.shape != (gh, gw) else img
    local = sample(dc, fx, fy)                                   # crop depth at the grid
    msk = np.asarray(Image.fromarray((mask_for(i, (W, H)) * 255).astype(np.uint8)).crop((px0, py0, px1, py1)).resize((gw, gh), Image.BILINEAR)) / 255
    body = msk > 0.5
    interior = body & ~grow(~body, 1)
    if interior.sum() < 8:
        interior = body
    # scene depth at the same grid points
    gx, gy = fx / W * w - 0.5, fy / H * h - 0.5
    scene = depth[i][np.clip(np.round(gy).astype(int), 0, h - 1), np.clip(np.round(gx).astype(int), 0, w - 1)]
    a, b = np.linalg.lstsq(np.stack([local[interior], np.ones(interior.sum())], 1), scene[interior], rcond=None)[0]
    if a <= 0:  # fit went wrong way round: fall back to the scene's own depth
        a, b = 0.0, 0.0
        fitted = scene
    else:
        fitted = a * local + b
    core = fitted[interior]
    med = np.median(core)
    lo, hi = np.percentile(core, [2, 98])
    d = med + (np.clip(fitted, lo, hi) - med) * RELIEF
    # the rim of the silhouette sees background depth and would stretch out
    # into spikes (ears become pegs); grow the interior's depth over it
    known = interior.copy()
    for _ in range(4):
        acc = np.zeros_like(d); cnt = np.zeros_like(d)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            acc += np.roll(np.roll(np.where(known, d, 0), dy, 0), dx, 1)
            cnt += np.roll(np.roll(known, dy, 0), dx, 1)
        grow_in = ~known & (cnt > 0)
        d = np.where(grow_in, acc / np.maximum(cnt, 1), d)
        known |= grow_in

    cv = grow(body, 1)
    keep = cv[:-1, :-1] | cv[:-1, 1:] | cv[1:, :-1] | cv[1:, 1:]
    # trimmed 2 px inside the mask: its edge carries a rim of the background
    alpha = Image.fromarray((mask_for(i, (W, H)) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5))
    crop.putalpha(alpha.crop((px0, py0, px1, py1)))
    uv = np.stack([(fx.ravel() - px0) / (px1 - px0), 1 - (fy.ravel() - py0) / (py1 - py0)], 1)
    rec = emit(lift(i, d, gx, gy), uv, grid_triangles(gw, gh, keep))
    rec.update(tex=f"sub/s{i:03d}.webp", centroid=lift(i, np.array([med]),
               np.array([(x0 + x1) / 2]), np.array([(y0 + y1) / 2]))[0].tolist())
    crop.save(out / rec["tex"], quality=90, alpha_quality=100)
    sub.append(rec)
np.savez(crop_cache, **crop_depth)

np.concatenate(pos).tofile(out / "pos.f32")
np.concatenate(uvs).tofile(out / "uv.f32")
np.concatenate(idx).tofile(out / "idx.u32")

flip = np.diag([1, -1, -1, 1])
cams = []
for i in range(n):
    m = flip @ c2w[i] @ flip
    m[:3, 3] /= scale
    cams.append(m.T.reshape(-1).tolist())  # column-major, for Matrix4.fromArray

# which way does the subject travel, relative to the camera that filmed it?
seen = [i for i in range(n) if sub[i]]
a, b = seen[0], seen[-1]
cpos = lambda i: np.array(cams[i]).reshape(4, 4).T[:3, 3]
dist0 = np.linalg.norm(np.array(sub[a]["centroid"]) - cpos(a))
dist1 = np.linalg.norm(np.array(sub[b]["centroid"]) - cpos(b))
(out / "stable.json").write_text(json.dumps({
    "concept": meta["concept"], "clip": clip, "fps": meta["fps"], "width": w, "height": h, "fixed": fixed_camera, "fill": fill, "overlay": OVERLAY,
    "fovY": float(2 * np.degrees(np.arctan(h / 2 / K[0, 1, 1]))),
    "times": [f["t"] for f in frames], "cameras": cams, "env": env, "sub": sub,
    "motion": {"distStart": float(dist0), "distEnd": float(dist1),
               "travel": (np.array(sub[b]["centroid"]) - sub[a]["centroid"]).tolist(),
               "cameraTravel": (cpos(b) - cpos(a)).tolist()},
}))
print(f"subject: {len(seen)} surfaces; distance to lens {dist0:.2f} -> {dist1:.2f}; "
      f"{n_vert} vertices total")

# Everything above succeeded: swap the scratch folder in as the live one.
# Rename the OLD folder out of the way first, not delete it first -- a first
# attempt at this deleted the live folder, then hit a transient Windows
# file-lock error on the rename that was supposed to replace it, leaving the
# live path pointing at nothing. Renaming old->`.old` before touching the
# live path means a failure on the critical rename can still be rolled back.
old = final_out.with_name(final_out.name + ".old")
shutil.rmtree(old, ignore_errors=True)
if final_out.exists():
    rename_retry(final_out, old)
try:
    rename_retry(out, final_out)
except OSError:
    if old.exists():
        rename_retry(old, final_out)  # roll back: the live path must never end up empty
    raise
shutil.rmtree(old, ignore_errors=True)
