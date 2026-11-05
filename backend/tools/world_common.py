"""Shared pieces of the fixed-camera world builder (make-world.py).

A work folder holds what the tracker (backend/lib/track.js) wrote, plus what each stage caches:
  labels/l<sample>.png   8-bit track ids per sampled frame (0 = background)
  tracks.json            { fps, start, samples, width, height, tracks: [...] }
  frames/f<sample>.jpg   full-resolution frames at the sampling rate
  plate.png, never.png   median of what was ever seen without an animal; where one always stood
"""
import json
import os
import shutil
import subprocess
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np


class Work:
    def __init__(self, folder, clip):
        self.dir = Path(folder)
        self.clip = Path(clip)
        self.tracks = json.loads((self.dir / "tracks.json").read_text())
        self.fps = self.tracks["fps"]
        self.start = self.tracks["start"]
        self.n = self.tracks["samples"]
        self.w, self.h = self.tracks["width"], self.tracks["height"]

    def time(self, i):
        """seconds into the clip of sample i"""
        return self.start + i / self.fps

    LABEL_CACHE = 160   # decoded label rasters kept (~0.9 MB each at 1280 x 720): the mask repair reads each a few times

    def label(self, i):
        """sample i's track ids (a fresh array the caller may change). Kept decoded while the file is unchanged:
        the cache is keyed on the file's modification time and size, so a rewritten label is read again."""
        path = self.dir / "labels" / f"l{i:05d}.png"
        try:
            st = os.stat(path)
        except OSError:
            return None
        key = (st.st_mtime_ns, st.st_size)
        cache = self.__dict__.setdefault("_labels", OrderedDict())
        hit = cache.get(i)
        if hit is not None and hit[0] == key:
            cache.move_to_end(i)
            return hit[1].copy()
        lab = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if lab is not None:
            cache[i] = (key, lab)
            cache.move_to_end(i)
            while len(cache) > self.LABEL_CACHE:
                cache.popitem(last=False)
            return lab.copy()
        return lab

    def frame_path(self, i):
        return self.dir / "frames" / f"f{i:05d}.jpg"

    def frame(self, i):
        return cv2.cvtColor(cv2.imread(str(self.frame_path(i))), cv2.COLOR_BGR2RGB)


def extract_frames(work):
    """every sample's full-resolution frame, once"""
    out = work.dir / "frames"
    if out.exists() and len(list(out.glob("f*.jpg"))) >= work.n:
        return
    out.mkdir(exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(work.start), "-i", str(work.clip),
                    "-frames:v", str(work.n), "-vf", f"fps={work.fps},scale={work.w}:{work.h}",
                    "-q:v", "2", "-start_number", "0", str(out / "f%05d.jpg")], check=True)
    # a clip's last sample can fall just past its end: hold the frame before it
    have = sorted(out.glob("f*.jpg"))
    for i in range(len(have), work.n):
        shutil.copy(have[-1], out / f"f{i:05d}.jpg")


def hide_strip(img, overlay):
    """cover a burnt-in data strip (rows from overlay*h down) with a mirror of the rows above it:
    the mesh there is a continuation, never a source"""
    top = int(img.shape[0] * overlay)
    k = img.shape[0] - top
    if k <= 0:
        return img
    out = img.copy()
    out[top:] = img[top - k:top][::-1] if top >= k else img[top - 1]
    return out


class Camera:
    """The fixed lens, as the viewer will rebuild it: square pixels, centred principal point.
    u, v are source coordinates in 0..1 (v down); a point is (X, Y, Z) with Z the depth along the
    optical axis, Y down. World space is three.js's: (X, -Y, -Z) / scale, so the lens sits at the
    origin looking down -z and one unit is the scene's median depth."""

    def __init__(self, tan_y, src_w, src_h, scale):
        self.src_w, self.src_h = src_w, src_h
        self.tan_y, self.tan_x, self.scale = tan_y, tan_y * src_w / src_h, scale

    def rays(self, u, v):
        return np.stack([(u - 0.5) * 2 * self.tan_x, (v - 0.5) * 2 * self.tan_y, np.ones_like(u)], -1)

    def lift(self, u, v, depth):
        """camera-space points, shape (..., 3)"""
        return self.rays(u, v) * depth[..., None]

    def to_world(self, p):
        return (p * np.array([1, -1, -1]) / self.scale).astype(np.float32)

    @property
    def fov_y(self):
        return float(2 * np.degrees(np.arctan(self.tan_y)))


class Mesh:
    """vertex/uv/index buffers shared by the environment surfaces, as stable.js reads them"""

    def __init__(self):
        self.pos, self.uv, self.idx = [], [], []
        self.nv = self.ni = 0
        self.grids = []

    def emit(self, p, uv, tri, grid=None):
        """grid: (part name, w, h, kept quads) when p is a w x h grid lifted from the lens, row by row, and tri
        is grid_triangles of those quads; it lets save() also write the part to grid.bin"""
        rec = {"vertOffset": self.nv, "vertCount": len(p), "idxOffset": self.ni, "idxCount": len(tri)}
        self.pos.append(p.astype(np.float32)), self.uv.append(uv.astype(np.float32)), self.idx.append(tri.astype(np.uint32))
        if grid is not None:
            self.grids.append((grid, len(self.pos) - 1))
        self.nv += len(p)
        self.ni += len(tri)
        return rec

    def save(self, out, tan_x=None, tan_y=None, buffers=True):
        """with the lens (tan_x, tan_y), grid.bin when every part is a lens grid that rebuilds its buffers; returns
        the record stable.json carries as "grid", or None. pos.f32 / uv.f32 / idx.u32 are written when asked
        (buffers) and always when there is no grid: a viewer reads one or the other, and the grid is a tenth the size"""
        whole = len(self.grids) == len(self.pos)
        grid = self.save_grid(out, tan_x, tan_y) if self.grids and whole and tan_x and tan_y else None
        if buffers or grid is None:
            np.concatenate(self.pos).tofile(out / "pos.f32")
            np.concatenate(self.uv).tofile(out / "uv.f32")
            np.concatenate(self.idx).tofile(out / "idx.u32")
        return grid

    def save_grid(self, out, tan_x, tan_y):
        """grid.bin, read by stable-grid.mjs: per part a row of u, a column of stored uv.y, the depth of each
        vertex along the lens axis (f32) and its kept quads as bits. A tenth of the three buffers. Checked here
        against them: a part that would not rebuild them exactly leaves the world without a grid."""
        blob, parts = bytearray(), []

        def put(a):
            while len(blob) % 4:
                blob.append(0)
            at = len(blob)
            blob.extend(np.ascontiguousarray(a).tobytes())
            return at

        for (name, w, h, keep), k in self.grids:
            p, uv, tri = self.pos[k], self.uv[k], self.idx[k]
            us, vs, z = uv[:w, 0], uv[::w, 1], -p[:, 2]
            u, v = np.tile(us.astype(np.float64), h), 1 - np.repeat(vs.astype(np.float64), w)
            back = np.stack([(u - 0.5) * 2 * tan_x * z, -(v - 0.5) * 2 * tan_y * z, -z.astype(np.float64)], 1)
            scale = np.maximum(np.abs(p).max(1, keepdims=True), 1e-6)
            if (keep.shape != (h - 1, w - 1) or len(p) != w * h or not np.array_equal(uv[:, 0], np.tile(us, h)) or
                    not np.array_equal(uv[:, 1], np.repeat(vs, w)) or not np.array_equal(tri, grid_triangles(w, h, keep)) or
                    float((np.abs(back - p) / scale).max()) > 1e-5):
                print(f"grid: {name} does not rebuild its buffers; no grid.bin", flush=True)
                return None
            parts.append({"part": name, "w": int(w), "h": int(h), "u": put(us), "v": put(vs),
                          "z": {"type": "f32", "at": put(z.astype(np.float32))},
                          "keep": None if keep.all() else put(np.packbits(keep.ravel()))})
        (out / "grid.bin").write_bytes(bytes(blob))
        return {"file": "grid.bin", "parts": parts}


def grid_triangles(gw, gh, keep):
    """two triangles per kept quad of a gw x gh vertex grid"""
    qy, qx = np.nonzero(keep)
    a = qy * gw + qx
    b, c, d = a + 1, a + gw, a + gw + 1
    return np.stack([a, c, b, b, c, d], 1).ravel().astype(np.uint32)
