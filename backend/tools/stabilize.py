"""Holds a trail camera still: a bump, a wind gust or a bear's nudge moves the picture by a few pixels
and the world builder (one background for the whole clip) would smear. This registers every frame to
the first and writes the clip back with the camera not moving.

  <python with cv2> backend/tools/stabilize.py <in.mp4> <out.mp4> [overlay]

overlay: the share of the height above a burnt-in data strip; the strip belongs to the camera, not the
scene, so it is copied back unwarped. Prints one JSON line: { moved, max, steps }.
"""
import json
import subprocess
import sys

import cv2
import numpy as np

PROC = (640, 360)
GRID = (4, 3)
CONFIDENT = 0.3     # phase-correlation peak worth trusting
MIN_TILES = 3
JUMP_PX = 1.5       # a step between neighbouring frames larger than this is a bump, not noise


def edges(frame):
    g = cv2.cvtColor(cv2.resize(frame, PROC, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = cv2.GaussianBlur(g, (0, 0), 1.2)
    m = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
    return m / (np.percentile(m, 99) + 1e-3)


def offset(ref, cur, win, top):
    """(dx, dy) in processing pixels that moves cur onto ref, from the tiles that agree; None if unsure"""
    cols, rows = GRID
    tw, th = PROC[0] // cols, int(PROC[1] * top) // rows
    found = []
    for r in range(rows):
        for c in range(cols):
            a = ref[r * th:(r + 1) * th, c * tw:(c + 1) * tw]
            b = cur[r * th:(r + 1) * th, c * tw:(c + 1) * tw]
            (dx, dy), resp = cv2.phaseCorrelate(a, b, win)
            if resp > CONFIDENT:
                found.append((dx, dy))
    if len(found) < MIN_TILES:
        return None
    f = np.array(found)
    med = np.median(f, axis=0)
    keep = f[np.hypot(*(f - med).T) < 1.5]       # tiles that disagree with the rest are on something that moves
    return tuple(np.median(keep, axis=0)) if len(keep) >= MIN_TILES else None


def main():
    src, dst = sys.argv[1], sys.argv[2]
    top = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    cap = cv2.VideoCapture(src)
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames, offsets = [], []
    ok, f = cap.read()
    ref = edges(f)
    tw, th = PROC[0] // GRID[0], int(PROC[1] * top) // GRID[1]
    win = cv2.createHanningWindow((tw, th), cv2.CV_32F)
    last = (0.0, 0.0)
    while ok:
        o = offset(ref, edges(f), win, top) if frames else (0.0, 0.0)
        last = o if o is not None else last      # nothing to lock onto: the camera has not moved since
        offsets.append(last)
        frames.append(None)
        ok, f = cap.read()
    cap.release()
    off = np.array(offsets)
    # a bump is a step: a 5-frame median removes the per-frame noise and keeps the step
    k = 2
    pad = np.pad(off, ((k, k), (0, 0)), mode="edge")
    smooth = np.median(np.stack([pad[i:i + len(off)] for i in range(2 * k + 1)]), axis=0)
    scale = w / PROC[0]
    shifts = smooth * scale
    steps = int((np.hypot(*np.diff(shifts, axis=0).T) > JUMP_PX).sum()) if len(shifts) > 1 else 0
    biggest = float(np.hypot(*shifts.T).max())
    if biggest < 0.75:
        print(json.dumps({"moved": False, "max": round(biggest, 2), "steps": steps}))
        return
    cap = cv2.VideoCapture(src)
    ff = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                           "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", dst], stdin=subprocess.PIPE)
    strip_from = int(round(h * top))
    for i in range(len(shifts)):
        ok, f = cap.read()
        if not ok:
            break
        m = np.float32([[1, 0, -shifts[i][0]], [0, 1, -shifts[i][1]]])
        out = cv2.warpAffine(f, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        out[strip_from:] = f[strip_from:]
        ff.stdin.write(out.tobytes())
    ff.stdin.close()
    ff.wait()
    print(json.dumps({"moved": True, "max": round(biggest, 2), "steps": steps}))


main()
