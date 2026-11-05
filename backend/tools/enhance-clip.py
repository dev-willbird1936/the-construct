"""Doubles a small clip's resolution with Real-ESRGAN (realesr-general-x4v3, BSD-3), frame by frame.

  <da3 python> enhance-clip.py <in.mp4> <out.mp4> [scale]

A phone clip of 360 x 640 gives SAM, depth and the textures too little to work with: faces, legs and
snow texture come out soft and the masks come out blobby. The compact general model sharpens without
the painterly fur of x4plus; its frame-to-frame flicker on static snow is about 1.3x the source's.
Weights: local-models/tools/sr/realesr-general-x4v3.pth (SR_MODEL overrides).
"""
import os
import subprocess
import sys

import cv2
import numpy as np
import torch
from spandrel import ModelLoader

WEIGHTS = os.environ.get("SR_MODEL", "local-models/tools/sr/realesr-general-x4v3.pth")

src, out = sys.argv[1], sys.argv[2]
scale = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
cap = cv2.VideoCapture(src)
fps = cap.get(cv2.CAP_PROP_FPS)
w0, h0 = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
W, H = int(round(w0 * scale / 2) * 2), int(round(h0 * scale / 2) * 2)
model = ModelLoader().load_from_file(WEIGHTS).cuda().eval().half()
ffmpeg = subprocess.Popen(
    ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
     "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", out],
    stdin=subprocess.PIPE)
n = 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    x = torch.from_numpy(frame[:, :, ::-1].copy()).permute(2, 0, 1)[None].float().div(255).cuda().half()
    with torch.no_grad():
        y = model(x)
    y = (y[0].float().clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)[:, :, ::-1]
    ffmpeg.stdin.write(cv2.resize(y, (W, H), interpolation=cv2.INTER_AREA).tobytes())
    n += 1
ffmpeg.stdin.close()
ffmpeg.wait()
print(f"enhance: {n} frames, {w0}x{h0} -> {W}x{H}", flush=True)
