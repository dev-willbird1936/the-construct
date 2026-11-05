"""Live, full-resolution texture for a fixed-camera stable world.

The environment surface of a fixed-camera clip is one depth mesh seen from the
recording lens, so the footage itself maps onto it 1:1 through the mesh's UVs.
A median plate cannot show anything that moves (a river becomes grey mush) and
was baked at 252x140. Instead this writes
  env/live.mp4       the clip over the stable.json time range, the subject
                     painted out with the SAM mask (over the median there)
  env/plate_hi.jpg   full-resolution median of the unmasked pixels: the still
                     shown until the video is ready, and the fill under the subject
and points env[0].live at them; stable.js plays the video on the surface.

  <da3 python> backend/tools/make-env-video.py <name> <bake>
<bake> is the scratch folder of make-lab.mjs (lab.json and cut/ masks).
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

root = Path(__file__).resolve().parents[2]
name, bake = sys.argv[1], Path(sys.argv[2])
base = root / "assets" / "stable" / name
meta = json.loads((base / "stable.json").read_text())
assert len(meta["env"]) == 1 and meta.get("fixed"), "fixed-camera clips only (one environment surface)"
lab = json.loads((bake / "lab.json").read_text())
clip = root / meta["clip"].replace("\\", "/")
times = meta["times"]
FPS, W, H = 30, 1280, 720
t0, t1 = times[0], times[-1]
n = round((t1 - t0) * FPS) + 1

raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t0), "-i", str(clip), "-frames:v", str(n),
                      "-vf", f"fps={FPS},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                     capture_output=True, check=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
assert len(frames) == n, f"decoded {len(frames)} of {n} frames"

# subject masks: nearest lab frame in time, grown and feathered so no rim of it survives
masks = []
for f in lab["frames"]:
    a = Image.open(bake / f["file"]).getchannel("A").resize((W, H), Image.BILINEAR)
    masks.append(np.asarray(a.filter(ImageFilter.MaxFilter(17)).filter(ImageFilter.GaussianBlur(4)), np.float32) / 255)
lab_t = np.array([f["t"] for f in lab["frames"]])
pick = [int(np.abs(lab_t - (t0 + j / FPS)).argmin()) for j in range(n)]
mask = np.stack([masks[k] for k in pick])                       # (n, H, W)

# rows below the overlay cut (a trail camera's burnt-in timestamp) are the
# rows above them, mirrored: the mesh there is a continuation, not a source
y0 = int(H * meta.get("overlay", 1.0))


def no_overlay(img):
    if y0 < H:
        img[y0:] = img[2 * y0 - H:y0][::-1] if 2 * y0 - H >= 0 else img[y0 - 1]
    return img


# median of what was ever seen unmasked, in stripes to bound memory
plate = np.empty((H, W, 3), np.uint8)
never = np.zeros((H, W), bool)
for y in range(0, H, 48):
    s = frames[:, y:y + 48].astype(np.float32)
    s[mask[:, y:y + 48] > 0.05] = np.nan
    never[y:y + 48] = np.isnan(s[..., 0]).all(axis=0)
    plate[y:y + 48] = np.nan_to_num(np.nanmedian(s, axis=0), nan=0).astype(np.uint8)
# where the subject always stood there is no clean pixel: paint it in from the
# surroundings (small, so smooth) rather than leave a black hole
if never.any():
    hole = cv2.dilate(never.astype(np.uint8), np.ones((5, 5), np.uint8))
    small = cv2.inpaint(cv2.resize(plate, (W // 4, H // 4), interpolation=cv2.INTER_AREA),
                        cv2.resize(hole, (W // 4, H // 4), interpolation=cv2.INTER_NEAREST), 6, cv2.INPAINT_TELEA)
    soft = cv2.GaussianBlur(cv2.resize(small, (W, H), interpolation=cv2.INTER_CUBIC), (0, 0), 6)
    plate[hole > 0] = soft[hole > 0]
plate = no_overlay(plate)
Image.fromarray(plate).save(base / "env" / "plate_hi.jpg", quality=92)

enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                        "-i", "-", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p", "-g", "6",
                        "-movflags", "+faststart", str(base / "env" / "live.mp4")], stdin=subprocess.PIPE)
for j in range(n):
    m = mask[j][..., None]
    enc.stdin.write(no_overlay((plate * m + frames[j] * (1 - m)).astype(np.uint8)).tobytes())
enc.stdin.close()
assert enc.wait() == 0

meta["env"][0]["live"] = {"video": "env/live.mp4", "plate": "env/plate_hi.jpg", "fps": FPS}
(base / "stable.json").write_text(json.dumps(meta))
print(f"{name}: {n} frames {W}x{H}, live.mp4 {(base / 'env' / 'live.mp4').stat().st_size / 1e6:.1f} MB")
