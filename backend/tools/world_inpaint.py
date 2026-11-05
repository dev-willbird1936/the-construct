"""Fills what the camera never saw: the ground an animal covered for the whole clip.

LaMa (big-lama, Apache-2.0, TorchScript) continues the surrounding texture and does not invent
objects, which is what a plate needs: this surface is seen only at a glancing angle, a few tens of
pixels either side of the silhouette, when the view is orbited. Weights are not part of the repository:
set LAMA_MODEL, or place big-lama.pt at the default path below; without it a blurred diffusion fill is used.
"""
import os
from pathlib import Path

import cv2
import numpy as np

MODEL = Path(os.environ.get("LAMA_MODEL", "local-models/tools/lama_model/big-lama.pt"))


def diffuse(image, hole):
    """the fallback: Telea inpainting at quarter size, softened"""
    h, w = hole.shape
    small = cv2.inpaint(cv2.resize(image, (w // 4, h // 4), interpolation=cv2.INTER_AREA),
                        cv2.resize(hole.astype(np.uint8), (w // 4, h // 4), interpolation=cv2.INTER_NEAREST), 6, cv2.INPAINT_TELEA)
    soft = cv2.GaussianBlur(cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC), (0, 0), 6)
    out = image.copy()
    out[hole] = soft[hole]
    return out


WORK_LONG = 640   # px: LaMa sees each hole in a crop around it at about its training scale
_loaded = {}      # the TorchScript model, read from disk once per process and kept on the CPU between fills


def _lama(model, device, img, hole):
    """one LaMa pass; the hole is zeroed so nothing of what stood there leaks in"""
    import torch
    h, w = hole.shape
    ph, pw = (-h) % 8, (-w) % 8
    x = np.pad(img, ((0, ph), (0, pw), (0, 0)), mode="symmetric").astype(np.float32) / 255
    m = np.pad(hole.astype(np.float32), ((0, ph), (0, pw)), mode="symmetric")
    x *= 1 - m[..., None]
    with torch.inference_mode():
        out = model(torch.from_numpy(x.transpose(2, 0, 1))[None].to(device), (torch.from_numpy(m)[None, None].to(device) > 0).float())
    return np.clip(out[0].permute(1, 2, 0).cpu().numpy() * 255, 0, 255).astype(np.uint8)[:h, :w]


def fill(image, hole):
    """image uint8 HxWx3, hole bool HxW -> image with the hole continued from its surroundings.
    Each hole is filled in a crop around it (a margin of three quarters of its size), brought to WORK_LONG
    on its long side: run on the whole 1280 x 720 plate, LaMa smeared a moose-sized hole into haze, while
    at its own scale it continued the lake's ripples and the bushes' leaves."""
    if not hole.any():
        return image
    if not MODEL.exists():
        print("inpaint: no LaMa weights, using a diffusion fill", flush=True)
        return diffuse(image, hole)
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if "cpu" not in _loaded:
        _loaded["cpu"] = torch.jit.load(str(MODEL), map_location="cpu").eval()
    model = _loaded["cpu"].to(device)
    out = image.copy()
    H, W = hole.shape
    n, comp, stats, _ = cv2.connectedComponentsWithStats(cv2.dilate(hole.astype(np.uint8), np.ones((31, 31), np.uint8)))
    for c in range(1, n):
        x, y, bw, bh = stats[c, :4]
        pad = max(48, int(0.75 * max(bw, bh)))
        x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(W, x + bw + pad), min(H, y + bh + pad)
        crop, ch = out[y0:y1, x0:x1], hole[y0:y1, x0:x1]
        s = min(1.0, WORK_LONG / max(crop.shape[:2]))
        if s < 1:
            size = (max(8, round(crop.shape[1] * s)), max(8, round(crop.shape[0] * s)))
            small_hole = cv2.dilate((cv2.resize(ch.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST) > 0).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
            res = cv2.resize(_lama(model, device, cv2.resize(crop, size, interpolation=cv2.INTER_AREA), small_hole), (crop.shape[1], crop.shape[0]), interpolation=cv2.INTER_CUBIC)
        else:
            res = _lama(model, device, crop, ch)
        # only the hole changes; its rim is feathered so there is no seam
        f = np.maximum(cv2.GaussianBlur(ch.astype(np.float32), (0, 0), 2.0), ch)[..., None]
        out[y0:y1, x0:x1] = (res * f + crop * (1 - f)).astype(np.uint8)
    _loaded["cpu"] = model.to("cpu")      # off the card between fills: the depth and matting models need it
    del model
    if device == "cuda":
        torch.cuda.empty_cache()
    return out


SURROUND = 0.25   # of the frame's width and height: how far past each edge the picture is continued


def outpaint(image, margin=SURROUND, top=None):
    """image uint8 HxWx3 -> the picture continued `margin` of its size past every edge, (H + 2my) x (W + 2mx) x 3,
    the picture itself unchanged in the middle. LaMa sees the whole canvas at WORK_LONG, so what it adds is soft:
    it is seen only off the lens, dimmed, where the frame's edge was a cut to black. Rows from `top` down (a burnt-in
    data strip) are continued too, from the picture above them, not kept."""
    H, W = image.shape[:2]
    top = H if top is None else max(1, min(H, int(top)))
    mx, my = int(round(W * margin)), int(round(H * margin))
    canvas = cv2.copyMakeBorder(image, my, my, mx, mx, cv2.BORDER_REFLECT)
    hole = np.ones(canvas.shape[:2], bool)
    hole[my:my + top, mx:mx + W] = False
    s = min(1.0, WORK_LONG / max(canvas.shape[:2]))
    size = (max(8, round(canvas.shape[1] * s)), max(8, round(canvas.shape[0] * s)))
    if not MODEL.exists():
        small = diffuse(cv2.resize(canvas, size, interpolation=cv2.INTER_AREA), cv2.resize(hole.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST) > 0)
    else:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        if "cpu" not in _loaded:
            _loaded["cpu"] = torch.jit.load(str(MODEL), map_location="cpu").eval()
        model = _loaded["cpu"].to(device)
        small = _lama(model, device, cv2.resize(canvas, size, interpolation=cv2.INTER_AREA),
                      cv2.resize(hole.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST) > 0)
        _loaded["cpu"] = model.to("cpu")
        del model
        if device == "cuda":
            torch.cuda.empty_cache()
    out = cv2.resize(small, (canvas.shape[1], canvas.shape[0]), interpolation=cv2.INTER_CUBIC)
    out[my:my + top, mx:mx + W] = image[:top]
    return out
