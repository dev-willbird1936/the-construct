"""Bakes the data behind cloud.html: the basic tier. A clip becomes a 4D point
cloud: every frame's subject is lifted into one shared world and left where it
was, and the still environment around it is a static point set.

Depth Anything 3 recovers each frame's camera and depth in one shared world
(fewer frames and a lower resolution than make-stable.py, no second pass on the
subject, no meshes and no live footage on the world), so it is quick.

  OUT=<bake> node backend/tools/make-lab.mjs <video> <concept> <seed>   (or the backend's bake step)
  <da3 python> backend/tools/make-cloud.py <bake> <full-res frames> <name> <clip>
writes assets/cloud/<name>/; cloud.html?job=<name> shows it.
Env: OVERLAY (0.9 drops a trail camera's burnt-in bottom strip), MAX_FRAMES, PROCESS_RES.
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from depth_anything_3.api import DepthAnything3


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
final_out = Path(__file__).resolve().parents[2] / "assets" / "cloud" / name
out = final_out.with_name(final_out.name + ".building")
shutil.rmtree(out, ignore_errors=True)
out.mkdir(parents=True)

lab = json.loads((bake / "lab.json").read_text())
MAX_FRAMES = int(os.environ.get("MAX_FRAMES", "40"))
PROCESS_RES = int(os.environ.get("PROCESS_RES", "392"))  # a multiple of 14
OVERLAY = float(os.environ.get("OVERLAY", "1"))
UP = 2                 # the subject is lifted on a grid this much finer than the solve
ENV_STEP = 1           # environment sample spacing in solve pixels (fixed camera)
ENV_STEP_MOVING = 4    # ... and for a moving camera, whose frames each add a share
ENV_MAX = 250_000
SUBJECT_KEEP = 0.35    # share of each frame's subject points kept: a trail, not a solid
rng = np.random.default_rng(0)
pick = np.unique(np.round(np.linspace(0, len(lab["frames"]) - 1, min(MAX_FRAMES, len(lab["frames"])))).astype(int))
frames = [lab["frames"][i] for i in pick]

model = DepthAnything3.from_pretrained("depth-anything/DA3-LARGE").to("cuda").eval()
with torch.no_grad():
    pred = model.inference([str(bake / f["src"]) for f in frames], process_res=PROCESS_RES)
depth, conf, K, E, rgb = pred.depth, pred.conf, pred.intrinsics, pred.extrinsics, pred.processed_images
sky = pred.sky.astype(bool) if pred.sky is not None else np.zeros_like(depth, dtype=bool)
del model
torch.cuda.empty_cache()
n, h, w = depth.shape
print(f"da3: {n} frames at {w}x{h}", flush=True)

if E.shape[1] == 3:
    E = np.concatenate([E, np.tile([[[0, 0, 0, 1]]], (n, 1, 1))], axis=1)
c2w = np.linalg.inv(E)
scale = float(np.median(depth))
FLIP = np.array([1, -1, -1])
conf_floor = np.percentile(conf, 25)
ys, xs = np.mgrid[0:h, 0:w]


def alpha(i, size):
    return np.asarray(Image.open(bake / frames[i]["file"]).getchannel("A").resize(size, Image.BILINEAR)) / 255.0


def lift(i, d, gx, gy, k):
    """pixel grid + depth -> three.js world (y up, z back), unit = median depth"""
    pix = np.stack([gx.ravel(), gy.ravel(), np.ones(gx.size)], 0)
    cam = (np.linalg.inv(k) @ pix) * d.ravel()
    world = c2w[i, :3, :3] @ cam + c2w[i, :3, 3:4]
    return (world.T * FLIP / scale).astype(np.float32)


# ── still environment ────────────────────────────────────────────────────
cam_pos = (c2w[:, :3, 3] * FLIP) / scale
turn = max(np.degrees(np.arccos(np.clip((np.trace(c2w[0, :3, :3].T @ c2w[i, :3, :3]) - 1) / 2, -1, 1))) for i in range(n))
fixed = bool(np.linalg.norm(cam_pos.max(0) - cam_pos.min(0)) < 0.05 and turn < 2.0)
grow = lambda m: cv2.dilate(m.astype(np.uint8), np.ones((11, 11), np.uint8)) > 0


def clean(i):
    c = rgb[i].astype(np.int16)
    # bright blue AND far is sky; white water is bright and bluish too, but near
    blue = (c[..., 2] > c[..., 0] + 18) & (c[..., 2] >= c[..., 1]) & (c.sum(-1) > 360) & (depth[i] > np.percentile(depth[i], 85))
    return ~sky[i] & ~blue & (conf[i] >= conf_floor) & (ys < h * OVERLAY) & ~grow(alpha(i, (w, h)) > 0.2)


env_p, env_c = [], []
if fixed:
    gd = np.median(depth[:, ::ENV_STEP, ::ENV_STEP], axis=0)
    med = np.median(rgb[:, ::ENV_STEP, ::ENV_STEP].astype(np.float32), axis=0).astype(np.uint8)
    ok = sum(clean(i)[::ENV_STEP, ::ENV_STEP].astype(np.int32) for i in range(n)) > n // 2  # clean in most frames
    gx, gy = xs[::ENV_STEP, ::ENV_STEP][ok], ys[::ENV_STEP, ::ENV_STEP][ok]
    env_p.append(lift(0, gd[ok], gx, gy, K[0]))
    env_c.append(med[ok])
else:
    for i in range(n):
        ok = clean(i)[::ENV_STEP_MOVING, ::ENV_STEP_MOVING]
        gx, gy = xs[::ENV_STEP_MOVING, ::ENV_STEP_MOVING][ok], ys[::ENV_STEP_MOVING, ::ENV_STEP_MOVING][ok]
        env_p.append(lift(i, depth[i][::ENV_STEP_MOVING, ::ENV_STEP_MOVING][ok], gx, gy, K[i]))
        env_c.append(rgb[i][::ENV_STEP_MOVING, ::ENV_STEP_MOVING][ok])
env_p, env_c = np.concatenate(env_p), np.concatenate(env_c)
if len(env_p) > ENV_MAX:
    keep = rng.choice(len(env_p), ENV_MAX, replace=False)
    env_p, env_c = env_p[keep], env_c[keep]

# ── subject: every frame, left where it stood ────────────────────────────
W2, H2 = w * UP, h * UP
gx2, gy2 = np.meshgrid(np.arange(W2) + 0.0, np.arange(H2) + 0.0)
sub_p, sub_c, sub_f = [], [], []
for i, f in enumerate(frames):
    m = cv2.erode((alpha(i, (W2, H2)) > 0.5).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    if m.sum() < 30:
        continue
    d = cv2.resize(depth[i], (W2, H2), interpolation=cv2.INTER_LINEAR)
    # the rim sees background depth; keep the body's own depth range
    lo, hi = np.percentile(d[m], [2, 98])
    m &= (d >= lo) & (d <= hi) & (rng.random(m.shape) < SUBJECT_KEEP)
    k = K[i].copy()
    k[:2] *= UP
    img = np.asarray(Image.open(full / Path(f["src"]).name).convert("RGB").resize((W2, H2), Image.BILINEAR))
    sub_p.append(lift(i, d[m], gx2[m], gy2[m], k))
    sub_c.append(img[m])
    sub_f.append(np.full(m.sum(), i, np.uint16))
sub_p, sub_c, sub_f = np.concatenate(sub_p), np.concatenate(sub_c), np.concatenate(sub_f)

flip4 = np.diag([1, -1, -1, 1])
cams = []
for i in range(n):
    mat = flip4 @ c2w[i] @ flip4
    mat[:3, 3] /= scale
    cams.append(mat.T.reshape(-1).tolist())  # column-major, for Matrix4.fromArray

env_p.tofile(out / "env.pos.f32")
env_c.astype(np.uint8).tofile(out / "env.rgb.u8")
sub_p.tofile(out / "subject.pos.f32")
sub_c.astype(np.uint8).tofile(out / "subject.rgb.u8")
sub_f.tofile(out / "subject.fid.u16")
(out / "cloud.json").write_text(json.dumps({
    "clip": clip, "concept": lab["concept"], "fps": lab["fps"], "fixed": fixed, "overlay": OVERLAY,
    "width": w, "height": h, "fovY": float(2 * np.degrees(np.arctan(h / 2 / K[0, 1, 1]))),
    "times": [f["t"] for f in frames], "cameras": cams,
    "env": len(env_p), "subject": len(sub_p),
}))
print(f"cloud: {len(sub_p)} subject points over {n} frames, {len(env_p)} environment points, "
      f"{'fixed camera' if fixed else 'moving camera'}", flush=True)

old = final_out.with_name(final_out.name + ".old")
shutil.rmtree(old, ignore_errors=True)
if final_out.exists():
    rename_retry(final_out, old)
try:
    rename_retry(out, final_out)
except OSError:
    if old.exists():
        rename_retry(old, final_out)  # the live path must never end up empty
    raise
shutil.rmtree(old, ignore_errors=True)
