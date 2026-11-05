"""Soft edges for the animal shells.

SAM gives a hard on/off mask: it cuts fur, whiskers and thin legs into steps, and misses patches. ViTMatte
(hustvl/vitmatte-small-composition-1k, Apache-2.0) turns that mask into a trimap -- sure body, sure ground,
and a narrow unknown band along the edge -- and solves the band's partial opacity from the picture itself.
The body colours are then carried out through the band, so the edge holds the animal's colour and not the
ground's. Without the model the mask is still tidied and lightly feathered.
"""
import os
from pathlib import Path

import cv2
import numpy as np
from scipy import ndimage

MODEL = Path(os.environ.get("MATTE_MODEL", "local-models/tools/vitmatte/small-comp"))
INNER = 2        # px of the mask treated as unknown, inward
OUTER = 4        # and outward: the mask is often a little short of the true edge
WORK_LONG = 512  # a small crop is enlarged toward this before matting; the model was trained on large crops
MAX_LONG = 1100
SOLID = 0.97
CARRY_SIGMA = 1.5  # px: the body colour an edge pixel takes is the solid body's local mean, not one noisy pixel


HOLE_MIN = 12    # px: a hole smaller than this is always the mask's mistake
HOLE_SEEN = 18   # levels: a hole that looks like the empty scene behind it is the scene (sky between antler tines)


def tidy(inside, others, rgb=None, bg=None):
    """one animal's mask in its crop: holes filled, hairline gaps closed, specks dropped. `others` is the
    other animals' pixels, which this one may not take. With the crop (`rgb`) and the clean plate behind it
    (`bg`), a hole that shows the plate is left open: the sky enclosed by a moose's antlers is not moose,
    and filled it rode along with the antlers as grey triangles once the eye left the lens."""
    closed = cv2.morphologyEx(inside.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)) > 0
    m = ndimage.binary_fill_holes(closed)
    if rgb is not None and bg is not None:
        n, comp = cv2.connectedComponents((m & ~inside.astype(bool)).astype(np.uint8), connectivity=4)
        if n > 1:
            diff = np.abs(rgb.astype(np.int16) - bg.astype(np.int16)).max(-1)
            sizes = np.bincount(comp.ravel(), minlength=n)
            body = inside.astype(bool)
            for k in np.nonzero(sizes[1:] >= HOLE_MIN)[0] + 1:
                px = comp == k
                ring = (cv2.dilate(px.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=3) > 0) & body
                # only when the animal around it does NOT look like the scene: a white wolf on snow can't tell
                if np.median(diff[px]) < HOLE_SEEN and ring.any() and np.median(diff[ring]) >= 2 * HOLE_SEEN:
                    m &= ~px
    m &= ~others
    n, comp, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
    if n > 2:
        keep = [k for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] >= 0.03 * stats[1:, cv2.CC_STAT_AREA].max()]
        m = np.isin(comp, keep)
    return m


class Matter:
    def __init__(self):
        self.model = None
        self.failed = False

    def _load(self):
        if self.model is not None or self.failed:
            return
        try:
            import torch
            from transformers import VitMatteForImageMatting
            self.torch = torch
            self.model = VitMatteForImageMatting.from_pretrained(str(MODEL)).cuda().eval().half()
            self.mean = torch.tensor([0.485, 0.456, 0.406], device="cuda").view(1, 3, 1, 1)
            self.std = torch.tensor([0.229, 0.224, 0.225], device="cuda").view(1, 3, 1, 1)
        except Exception as e:                      # no model, no GPU: feather the mask instead
            print(f"matte: model unavailable ({e}); feathering the mask", flush=True)
            self.failed = True

    def alpha(self, rgb, inside, others):
        """float alpha 0..1 for the crop, `inside` being the tidied mask"""
        self._load()
        hard = cv2.GaussianBlur(inside.astype(np.float32), (0, 0), 0.8)
        if self.failed:
            return hard
        k = np.ones((3, 3), np.uint8)
        m8 = inside.astype(np.uint8)
        sure_fg = cv2.erode(m8, k, iterations=INNER) > 0
        near = cv2.dilate(m8, k, iterations=OUTER) > 0
        near &= ~others                                  # a neighbour's pixels are the neighbour's
        tri = np.zeros(m8.shape, np.float32)
        tri[near] = 0.5
        tri[sure_fg] = 1.0
        h, w = m8.shape
        s = float(np.clip(WORK_LONG / max(h, w), 1.0, 4.0))
        s = min(s, MAX_LONG / max(h, w))
        sh, sw = max(32, int(round(h * s))), max(32, int(round(w * s)))
        H, W = (sh + 31) // 32 * 32, (sw + 31) // 32 * 32
        img = cv2.resize(rgb, (sw, sh), interpolation=cv2.INTER_CUBIC)
        tr = cv2.resize(tri, (sw, sh), interpolation=cv2.INTER_NEAREST)
        img = np.pad(img, ((0, H - sh), (0, W - sw), (0, 0)), mode="edge")
        tr = np.pad(tr, ((0, H - sh), (0, W - sw)), mode="edge")
        torch = self.torch
        x = (torch.from_numpy(img).permute(2, 0, 1)[None].float().cuda() / 255 - self.mean) / self.std
        t = torch.from_numpy(tr)[None, None].float().cuda()
        with torch.no_grad():
            a = self.model(pixel_values=torch.cat([x, t], 1).half()).alphas[0, 0].float().cpu().numpy()
        a = cv2.resize(a[:sh, :sw], (w, h), interpolation=cv2.INTER_AREA)
        a[sure_fg] = 1.0
        a[~near] = 0.0
        a = np.clip(a, 0, 1)
        # a matte that has wandered far from the mask is distrusted
        if abs(a.sum() - inside.sum()) > 0.4 * max(inside.sum(), 1):
            return hard
        return a

    def close(self):
        if self.model is not None:
            import gc
            del self.model
            gc.collect()
            self.torch.cuda.empty_cache()


def carry_colour(rgb, alpha):
    """the colours of the solid body, carried outward through the soft edge, so it holds the animal's colour.
    The body is the only source: each edge pixel takes the local mean colour of the solid body at its nearest
    point. (An inpaint also reads the ground just past the band and tinted the edge with it: a light rim round
    a moose's antlers wherever they stood against anything but the sky they were filmed against.)"""
    solid = alpha >= SOLID
    if solid.all() or solid.sum() < 16:
        return rgb
    reach = cv2.dilate((alpha > 0.02).astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2) > 0
    fill = ~solid & reach
    if not fill.any():
        return rgb
    s8 = solid.astype(np.uint8)
    num = cv2.GaussianBlur(rgb.astype(np.float32) * s8[..., None], (0, 0), CARRY_SIGMA)
    den = cv2.GaussianBlur(s8.astype(np.float32), (0, 0), CARRY_SIGMA)
    ys, xs = np.nonzero(s8)
    # every pixel's nearest solid pixel: labels number the zero pixels of (1 - solid), i.e. the solid ones, in
    # row order, which is np.nonzero's order
    _, near = cv2.distanceTransformWithLabels(1 - s8, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    k = near[fill] - 1
    py, px = ys[k], xs[k]
    out = rgb.copy()
    out[fill] = np.clip(num[py, px] / den[py, px, None] + 0.5, 0, 255).astype(np.uint8)
    return out
