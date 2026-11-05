"""What the live page (live.html) shows while a world is built.

make-world.py calls these between its stages. Each writes a small file under $LIVE_DIR and prints one
`@@live {json}` line that backend/lib/reconstruct.js turns into an event; with LIVE_DIR unset every
call is a no-op, so a plain run of the builder is unchanged.

The 3D part works from what the builder already has: the fixed camera, the clean plate's depth with the
ground snapped flat, and the tracker's masks. An animal's place at each moment is where its lowest pixels
touch that ground, so its path, the way it is heading and how far it goes follow from the masks alone,
before a single shell is baked.
"""
import json
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from world_shells import sample_depth

LIVE = Path(os.environ["LIVE_DIR"]) if os.environ.get("LIVE_DIR") else None
PREVIEW_W = 960
BG_POINTS = 90_000          # background cloud size
GHOST_POINTS = 2600         # points per ghost in the trail cloud
MAX_GHOSTS = 14             # per animal
CONTACT = 0.08              # same share of the mask's height as world_shells
PATH_WINDOW = 0.5           # seconds: a path is median-filtered over this long
STILL = 0.04                # scene units (1 = the scene's median depth): moving less than this is standing


def on():
    return LIVE is not None


def _plain(o):
    return o.item() if hasattr(o, "item") else str(o)


def emit(kind, **data):
    if LIVE is not None:
        print("@@live " + json.dumps({"kind": kind, **data}, default=_plain), flush=True)


def _path(rel):
    p = LIVE / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def save_image(rel, rgb, width=PREVIEW_W, quality=88):
    img = Image.fromarray(np.ascontiguousarray(rgb))
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    img.save(_path(rel), quality=quality)
    return rel


# ── depth ────────────────────────────────────────────────────────────────

def depth_picture(depth, valid=None):
    """near = warm, far = cool, on a perceptual map; what Depth Anything 3 read from the empty scene"""
    inv = 1.0 / np.maximum(depth, 1e-6)
    lo, hi = np.percentile(inv, [2, 98])
    t = np.clip((inv - lo) / max(hi - lo, 1e-9), 0, 1)
    img = cv2.applyColorMap((t * 255).astype(np.uint8), cv2.COLORMAP_TURBO)[..., ::-1]
    return img


def ground_picture(plate, cam, depth, plane, tol=0.02):
    """the plate with the fitted ground plane tinted wherever the depth agrees with it"""
    n, off, _ = plane
    h, w = depth.shape
    ys, xs = np.mgrid[0:h, 0:w]
    pts = cam.lift((xs + 0.5) / w, (ys + 0.5) / h, depth)
    near = np.abs(pts @ n + off) < tol * cam.scale
    base = cv2.resize(plate, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
    tint = np.array([40, 220, 255], np.float32)
    out = np.where(near[..., None], base * 0.45 + tint * 0.55, base * 0.55)
    return np.clip(out, 0, 255).astype(np.uint8), float(near.mean())


# ── where each animal goes ───────────────────────────────────────────────

def _median_filter(a, k):
    k = max(1, k | 1)
    if len(a) < 3 or k == 1:
        return a
    pad = k // 2
    p = np.pad(a, ((pad, pad), (0, 0)), mode="edge")
    return np.stack([np.median(p[i:i + k], axis=0) for i in range(len(a))])


def ground_frame(plane):
    """in-plane unit vectors (forward = away from the lens, right) of the fitted ground, camera space"""
    n = np.asarray(plane[0], float)
    f = np.array([0.0, 0.0, 1.0])
    f = f - (f @ n) * n
    f /= np.linalg.norm(f)
    r = np.array([1.0, 0.0, 0.0])
    r = r - (r @ n) * n - (r @ f) * f
    r /= np.linalg.norm(r)
    return f, r


def track_paths(work, cam, env_depth, overlay, selected=None):
    """per track: one record per sampled moment where the animal stands on the ground"""
    out = {}
    for i in range(work.n):
        lab = work.label(i)
        for t in np.unique(lab):
            if t == 0 or (selected is not None and int(t) not in selected):
                continue
            ys, xs = np.nonzero(lab == t)
            if len(ys) < 250:
                continue
            ys = np.minimum(ys, int(work.h * overlay) - 1)
            low = ys >= ys.max() - max(3, int(CONTACT * (ys.max() - ys.min())))
            fx, fy = float(np.median(xs[low])), float(np.median(ys[low]))
            ground = float(np.median(sample_depth(env_depth, xs[low] + 0.5, ys[low] + 0.5, work.w, work.h)))
            out.setdefault(int(t), []).append(dict(
                i=i, t=work.time(i), fx=fx, fy=fy, ground=ground, area=int(len(ys)),
                width=int(xs.max() - xs.min() + 1), height=int(ys.max() - ys.min() + 1),
                cx=float(xs.mean()), cy=float(ys.mean())))
    return out


def motion(work, cam, plane, paths):
    """smooth each path, then say how the animal is heading, how far it goes and how fast.
    Returns (summaries, world paths): positions are in scene units, lens at the origin looking down -z."""
    fwd, right = ground_frame(plane)
    summaries, world = [], {}
    k = int(round(PATH_WINDOW * work.fps))
    for t, rows in sorted(paths.items()):
        rows.sort(key=lambda r: r["i"])
        uv = np.array([[r["fx"] / work.w, r["fy"] / work.h] for r in rows])
        d = np.array([r["ground"] for r in rows])
        d = np.exp(_median_filter(np.log(np.maximum(d, 1e-6))[:, None], k)[:, 0])     # the distance, like shells', in log
        uv = _median_filter(uv, k)
        cam_pts = cam.lift(uv[:, 0], uv[:, 1], d)                                     # camera space, metres-of-the-scene
        pts = cam.to_world(cam_pts).astype(np.float64)
        world[t] = pts
        rel = (cam_pts - cam_pts[0]) / cam.scale
        along, across = rel @ fwd, rel @ right                                       # +along = away from the lens
        step = np.hypot(np.diff(along), np.diff(across))
        length = float(np.hypot(along[-1] - along[0], across[-1] - across[0]))
        path_len = float(step.sum())
        # direction: the principal axis of the path, signed by its start-to-end
        v = np.array([across[-1] - across[0], along[-1] - along[0]])
        if length > 1e-9:
            c = np.stack([across, along], 1)
            axis = np.linalg.svd(c - c.mean(0), full_matrices=False)[2][0]
            v = axis if axis @ v >= 0 else -axis
        v = v / max(np.linalg.norm(v), 1e-9)
        toward = -v[1]            # +1 = straight at the lens
        lateral = v[0]            # +1 = to the right of the picture
        angle = float(np.degrees(np.arctan2(lateral, toward)))     # 0 toward, +90 right, 180 away
        seconds = max(rows[-1]["t"] - rows[0]["t"], 1e-6)
        if length < STILL:
            label = "standing about"
        else:
            a = abs(angle)
            side = "right" if angle > 0 else "left"
            if a < 25:
                label = "straight at the camera"
            elif a < 65:
                label = f"toward the camera, to the {side}"
            elif a < 115:
                label = f"across the scene, {'left to right' if angle > 0 else 'right to left'}"
            elif a < 155:
                label = f"away from the camera, to the {side}"
            else:
                label = "straight away from the camera"
        summaries.append(dict(
            track=t, first=rows[0]["i"], last=rows[-1]["i"], samples=len(rows),
            label=label, angle=round(angle, 1), length=round(length, 3), pathLength=round(path_len, 3),
            straight=round(length / path_len, 3) if path_len > 1e-9 else 1.0,
            speed=round(path_len / seconds, 3),
            distStart=round(float(d[0] / cam.scale), 3), distEnd=round(float(d[-1] / cam.scale), 3),
            bodyWidth=round(float(np.median([r["width"] for r in rows]) / work.w * 2 * cam.tan_x * np.median(d) / cam.scale), 3)))
    return summaries, world


def motion_picture(plate, work, paths, world, summaries, overlay):
    """the plate with each animal's path drawn on it and an arrow where it is heading"""
    img = plate.copy()
    pal = [(255, 200, 40), (60, 220, 255), (255, 90, 160), (120, 255, 120), (200, 140, 255), (255, 140, 60)]
    for n, s in enumerate(summaries):
        rows = sorted(paths[s["track"]], key=lambda r: r["i"])
        pts = np.array([[r["fx"], r["fy"]] for r in rows])
        pts = _median_filter(pts, int(round(PATH_WINDOW * work.fps)) | 1).astype(np.int32)
        col = pal[n % len(pal)]
        cv2.polylines(img, [pts.reshape(-1, 1, 2)], False, col, max(2, work.h // 300), cv2.LINE_AA)
        if len(pts) > 4 and np.linalg.norm(pts[-1] - pts[max(0, len(pts) - 8)]) > 2:
            cv2.arrowedLine(img, tuple(pts[max(0, len(pts) - 8)]), tuple(pts[-1]), col, max(3, work.h // 200), cv2.LINE_AA, tipLength=0.6)
        cv2.circle(img, tuple(pts[0]), max(4, work.h // 120), col, -1, cv2.LINE_AA)
    return img


# ── the clouds ───────────────────────────────────────────────────────────

def background_cloud(cam, depth, plate, valid):
    """the empty scene as points: one per grid cell of the depth map, coloured from the plate"""
    h, w = depth.shape
    step = max(1, int(np.ceil(np.sqrt(h * w / BG_POINTS))))
    ys, xs = np.mgrid[0:h:step, 0:w:step]
    ok = valid[ys, xs]
    u, v = (xs + 0.5) / w, (ys + 0.5) / h
    pos = cam.to_world(cam.lift(u[ok], v[ok], depth[ys, xs][ok]))
    rgb = cv2.resize(plate, (w, h), interpolation=cv2.INTER_AREA)[ys, xs][ok]
    return pos.astype(np.float32), rgb.astype(np.uint8)


def ghost_samples(rows, world_pts, body_width):
    """moments spaced along the path by about a body width, as many as fit (never more than MAX_GHOSTS):
    where an animal was, spread as far apart as it actually moved"""
    dist = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(world_pts, axis=0), axis=1))])
    total = dist[-1]
    gap = max(body_width * 0.9, total / MAX_GHOSTS) if total > 1e-6 else 1.0
    picks, last = [0], 0.0
    for j in range(1, len(dist)):
        if dist[j] - last >= gap:
            picks.append(j)
            last = dist[j]
    if picks[-1] != len(dist) - 1 and dist[-1] - last > 0.35 * gap:
        picks.append(len(dist) - 1)
    return picks


def trail_cloud(work, cam, paths, world, summaries, overlay, rng=np.random.default_rng(3)):
    """each chosen moment's animal as a flat cloud of its own pixels, standing at its distance on the ground"""
    pos, rgb, ghosts = [], [], []
    for s in summaries:
        t = s["track"]
        rows = sorted(paths[t], key=lambda r: r["i"])
        wp = world[t]
        for j in ghost_samples(rows, wp, s["bodyWidth"]):
            r = rows[j]
            lab = work.label(r["i"])
            ys, xs = np.nonzero(lab == t)
            if len(ys) > GHOST_POINTS:
                pick = rng.choice(len(ys), GHOST_POINTS, replace=False)
                ys, xs = ys[pick], xs[pick]
            d = np.full(len(ys), world_depth_at(cam, wp[j]))
            p = cam.to_world(cam.lift((xs + 0.5) / work.w, (ys + 0.5) / work.h, d))
            frame = work.frame(r["i"])
            ghosts.append(dict(track=t, i=r["i"], t=r["t"], n=int(len(ys)), off=int(sum(len(a) for a in pos))))
            pos.append(p.astype(np.float32))
            rgb.append(frame[ys, xs].astype(np.uint8))
    if not pos:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8), []
    return np.concatenate(pos), np.concatenate(rgb), ghosts


def world_depth_at(cam, p):
    """camera-space depth of a world point (the inverse of Camera.to_world on z)"""
    return float(-p[2] * cam.scale)


# ── what make-world.py calls ─────────────────────────────────────────────

def stage(id_, label):
    emit("stage", id=id_, label=label)


def detail(id_, text):
    """a line of progress inside a stage that takes a while"""
    emit("detail", id=id_, label=text)


def publish_plate(plate, unseen, repairs):
    if on():
        emit("plate", file=save_image("plate.jpg", plate), unseen=float(unseen), repairs=repairs)


def publish_depth(plate, cam, raw_depth, env_depth, plane, near, yaw_limit):
    if not on():
        return
    ground, share = ground_picture(plate, cam, raw_depth, plane)
    emit("depth", file=save_image("depth.jpg", depth_picture(raw_depth)), snapped=save_image("depth_ground.jpg", depth_picture(env_depth)),
         ground=save_image("ground.jpg", ground), groundShare=share, fovY=cam.fov_y, depthSize=list(raw_depth.shape[::-1]),
         nearest=near, yawLimit=yaw_limit)


def publish_cloud(work, cam, plane, env_depth, plate, valid, overlay, selected):
    """paths, headings, the background cloud and the trail cloud; returns the motion summaries"""
    if not on():
        return None
    stage("motion", "Reading where each animal is heading…")
    paths = track_paths(work, cam, env_depth, overlay, selected)
    if not paths:
        emit("motion", tracks=[], file=None)
        return None
    summaries, world = motion(work, cam, plane, paths)
    save_image("motion.jpg", motion_picture(plate, work, paths, world, summaries, overlay))
    (LIVE / "motion.json").write_text(json.dumps({
        "fps": work.fps, "scale": 1.0,
        "tracks": [dict(s, path=np.round(world[s["track"]], 4).tolist(),
                        times=[r["t"] for r in sorted(paths[s["track"]], key=lambda r: r["i"])]) for s in summaries]}))
    emit("motion", file="motion.jpg", json="motion.json", tracks=summaries)

    stage("cloud", "Laying the first cloud trail…")
    bg_pos, bg_rgb = background_cloud(cam, env_depth, plate, valid)
    bg_pos.tofile(_path("bg.f32")), bg_rgb.tofile(_path("bg.u8"))
    tr_pos, tr_rgb, ghosts = trail_cloud(work, cam, paths, world, summaries, overlay)
    tr_pos.tofile(_path("trail.f32")), tr_rgb.tofile(_path("trail.u8"))
    (LIVE / "cloud.json").write_text(json.dumps({
        "fovY": cam.fov_y, "aspect": work.w / work.h,
        "bg": {"pos": "bg.f32", "rgb": "bg.u8", "n": int(len(bg_pos))},
        "trail": {"pos": "trail.f32", "rgb": "trail.u8", "n": int(len(tr_pos)), "ghosts": ghosts},
        "motion": "motion.json"}))
    emit("cloud", json="cloud.json", background=int(len(bg_pos)), trail=int(len(tr_pos)), ghosts=len(ghosts))
    return summaries


def publish_moving_cloud(work, plate, paths, positions, bg_pos, bg_rgb, tr_pos, tr_rgb, ghosts, fov_y, camera_path):
    """Publish pose-compensated keyframe paths and clouds in the live schema."""
    stage("motion", "Reading where each animal is heading…")
    summaries, world = [], {}
    for track, rows in sorted(paths.items()):
        pts = np.asarray(positions[track], dtype=np.float64)
        world[track] = pts
        delta = pts[-1] - pts[0]
        length = float(np.hypot(delta[0], delta[2]))
        steps = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        path_length = float(steps.sum())
        angle = float(np.degrees(np.arctan2(delta[0], delta[2]))) if length else 0.0
        label = "standing about" if length < STILL else ("across the scene, left to right" if abs(angle) >= 65 and abs(angle) < 115 and angle > 0 else "across the scene, right to left" if abs(angle) >= 65 and abs(angle) < 115 else "toward the camera" if abs(angle) < 65 else "away from the camera")
        summaries.append(dict(track=track, first=rows[0]["i"], last=rows[-1]["i"], samples=len(rows), label=label,
                              angle=round(angle, 1), length=round(length, 3), pathLength=round(path_length, 3),
                              straight=round(length / path_length, 3) if path_length else 1.0,
                              speed=round(path_length / max(rows[-1]["t"] - rows[0]["t"], 1e-6), 3),
                              distStart=round(rows[0]["ground"], 3), distEnd=round(rows[-1]["ground"], 3),
                              bodyWidth=round(float(np.median([r["body_width"] for r in rows])), 3)))
    # Image-plane paths from different viewpoints cannot be drawn on one keyframe.
    save_image("motion.jpg", plate)
    (LIVE / "motion.json").write_text(json.dumps({"fps": work.fps, "scale": 1.0, "tracks": [dict(s, path=np.round(world[s["track"]], 4).tolist(), times=[r["t"] for r in paths[s["track"]]]) for s in summaries]}))
    emit("motion", file="motion.jpg", json="motion.json", tracks=summaries)
    stage("cloud", "Laying the first cloud trail…")
    bg_pos.astype(np.float32).tofile(_path("bg.f32"))
    bg_rgb.astype(np.uint8).tofile(_path("bg.u8"))
    tr_pos.astype(np.float32).tofile(_path("trail.f32"))
    tr_rgb.astype(np.uint8).tofile(_path("trail.u8"))
    (LIVE / "cloud.json").write_text(json.dumps({"fovY": fov_y, "aspect": work.w / work.h,
        "bg": {"pos": "bg.f32", "rgb": "bg.u8", "n": len(bg_pos)},
        "trail": {"pos": "trail.f32", "rgb": "trail.u8", "n": len(tr_pos), "ghosts": ghosts}, "motion": "motion.json",
        "cameraPath": np.round(camera_path, 4).tolist()}))
    emit("cloud", json="cloud.json", background=len(bg_pos), trail=len(tr_pos), ghosts=len(ghosts))
    return summaries


def publish_shell(s, work):
    """the shell's own cut-out, small, the moment it is made"""
    if on():
        img = Image.fromarray(s["rgba"])
        if max(img.size) > 200:
            img.thumbnail((200, 200), Image.LANCZOS)
        rel = f"shells/t{s['track']}_{s['i']:05d}.webp"
        img.save(_path(rel), quality=85)
        x0, y0, x1, y1 = s["box"]
        emit("shell", track=s["track"], i=s["i"], n=work.n, file=rel, box=[x0 / work.w, y0 / work.h, x1 / work.w, y1 / work.h])


def publish_water(frame, j, n, fps):
    if on() and j % 6 == 0:
        emit("water", j=j, n=n, t=j / fps, file=save_image(f"water/f{j:05d}.jpg", frame, 640, 80))
