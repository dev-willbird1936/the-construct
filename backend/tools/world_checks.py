"""Acceptance checks for a baked world, so quality is measured, not eyeballed.

Each check returns (value, limit, passed). Limits are starting points taken from the advisor's
review and meant to be recalibrated against clips that were judged good by eye.

  contact      lowest body vertices vs the ground under them, share of distance     < 2 %
  penetration  body vertices that lie behind the surface they stand in front of      < 1 %
  jitter       a track's distance minus its 1 s median, share of distance           < 2 %
  paint-out    what is left of an animal in the live video: mean |live - plate| in
               its mask, against the plate's own noise                               < 6 levels
  water        temporal std of the live video's water vs the footage's                >= 0.8
"""
import math
import subprocess

import cv2
import numpy as np


def shell_metrics(cam, env_depth, s, work):
    """contact gap and penetration of one shell (depth grid s['depth'], world-normalised later)"""
    dg, body = s["depth"], s["body"]
    gh, gw = dg.shape
    x0, y0, x1, y1 = s["box"]
    ys, xs = np.nonzero(body)
    if len(ys) < 8:
        return None
    px = x0 + (xs + 0.5) / gw * (x1 - x0)
    py = y0 + (ys + 0.5) / gh * (y1 - y0)
    eh, ew = env_depth.shape
    env = env_depth[np.clip((py / work.h * eh).astype(int), 0, eh - 1), np.clip((px / work.w * ew).astype(int), 0, ew - 1)]
    mine = dg[ys, xs]
    low = py >= np.percentile(py, 92)
    gap = float(np.median(np.abs(mine[low] - env[low]) / env[low]))
    pen = float(np.mean(mine > env * 1.02))
    return gap, pen


def jitter(track_shells):
    """track_shells: [(i, distance)] sorted by i. median |d - 1 s median(d)| / d"""
    d = np.array([m for _, m in track_shells])
    if len(d) < 12:
        return None
    k = 11
    sm = np.array([np.median(d[max(0, j - k // 2):j + k // 2 + 1]) for j in range(len(d))])
    return float(np.median(np.abs(d - sm) / sm))


def decode(path, frames, width, height, start=0.0, fps=None):
    args = ["ffmpeg", "-v", "error", "-ss", str(start), "-i", str(path), "-frames:v", str(frames)]
    if fps:
        args += ["-vf", f"fps={fps},scale={width}:{height}"]
    else:
        args += ["-vf", f"scale={width}:{height}"]
    raw = subprocess.run(args + ["-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, height, width, 3)


def live_metrics(work, plate, live_path, overlay, tracks=None):
    """paint-out residue and water liveness, on ten moments through the clip. Residue is measured inside
    the animals that were painted out (`tracks`, None for all): one left in the footage on purpose is no residue."""
    W, H = work.w, work.h
    # moments from 2 s in to 2 s before the end; a clip under 4 s keeps a quarter of itself clear at each end instead
    # (a 2 s clip's moments ran from 2 s back to 0, and the first, at the very end, decoded no frame and stopped the build)
    seconds = work.n / work.fps
    edge = 2.0 if seconds >= 4 else seconds / 4
    moments = np.linspace(edge, seconds - edge, 10)
    residue, std_live, std_src = [], [], []
    water = np.zeros((H, W), bool)
    water[int(0.45 * H):int(overlay * H) - 8, :] = True
    for t in moments:
        live = decode(live_path, 12, W, H, start=t, fps=30).astype(np.float32)
        src = decode(work.clip, 12, W, H, start=work.start + t, fps=30).astype(np.float32)
        if not len(live) or not len(src):
            continue                                   # past a stream's last frame: nothing to measure here
        i = int(round(t * work.fps))
        every = work.label(min(i, work.n - 1))
        lab = every > 0
        painted = lab if tracks is None else np.isin(every, list(tracks))
        inner = cv2.erode(painted.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0   # well inside the animal
        if inner.sum() > 400:
            residue.append(float(np.abs(live[0] - plate.astype(np.float32))[inner].mean()))
        clear = water & ~(cv2.dilate(lab.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0)
        std_live.append(float(live[:, clear].std(0).mean()))
        std_src.append(float(src[:, clear].std(0).mean()))
    liveness = float(np.mean(std_live) / max(np.mean(std_src), 1e-6)) if std_src else None
    return (float(np.mean(residue)) if residue else None), liveness


def report(rows):
    """rows: [(name, value, limit, kind)] kind '<' or '>='. Prints a table, returns {name: {...}}"""
    out = {}
    width = max(len(r[0]) for r in rows)
    for name, value, limit, kind in rows:
        numeric = isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, (bool, np.bool_))
        measured = float(value) if numeric else float("nan")
        if not math.isfinite(measured) or measured < 0:
            out[name] = {"value": None, "limit": limit, "kind": kind, "pass": None}
            print(f"check: {name:<{width}}  {'unknown':>8} {kind} {limit:<6}  UNKNOWN", flush=True)
            continue
        ok = measured < limit if kind == "<" else measured >= limit
        out[name] = {"value": round(measured, 4), "limit": limit, "kind": kind, "pass": bool(ok)}
        print(f"check: {name:<{width}}  {measured:8.3f} {kind} {limit:<6}  {'PASS' if ok else 'FAIL'}", flush=True)
    return out
