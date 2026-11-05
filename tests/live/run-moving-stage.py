"""No-SAM smoke test: crude rectangular masks, not a segmentation quality test."""
import json
import os
from pathlib import Path
import subprocess
import sys

import cv2
import numpy as np

root = Path(__file__).resolve().parents[2]
clip = root / 'assets/clips/walker.mp4'
work = root / 'backend/jobs/_moving-stage-smoke'
(work / 'labels').mkdir(parents=True, exist_ok=True)
cap = cv2.VideoCapture(str(clip))
w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = 2
n = min(20, int(cap.get(cv2.CAP_PROP_FRAME_COUNT) / cap.get(cv2.CAP_PROP_FPS) * fps))
cap.release()
for i in range(n):
    mask = np.zeros((h, w), np.uint8)
    mask[int(h * .18):int(h * .8), int(w * .31):int(w * .63)] = 1
    cv2.imwrite(str(work / 'labels' / f'l{i:05d}.png'), mask)
(work / 'tracks.json').write_text(json.dumps(dict(fps=fps, start=0, samples=n, width=w, height=h, tracks=[dict(id=1)])))
env = dict(os.environ, LIVE_DIR=str(work / 'live'), WORLD_STOP_AFTER='cloud', PYTHONUNBUFFERED='1')
subprocess.run([sys.executable, str(root / 'backend/tools/make-world-moving.py'), str(work), str(clip), 'smoke'], env=env, check=True)
live = work / 'live'
cloud = json.loads((live / 'cloud.json').read_text())
motion = json.loads((live / 'motion.json').read_text())
for key in ('bg', 'trail'):
    rec = cloud[key]
    assert (live / rec['pos']).stat().st_size == rec['n'] * 12
    assert (live / rec['rgb']).stat().st_size == rec['n'] * 3
assert cloud['bg']['n'] > 50000 and motion['tracks'] and (live / 'plate_hi.jpg').exists()
camera = np.array(cloud['cameraPath'])
path = np.array(motion['tracks'][0]['path'])
assert np.isfinite(camera).all() and len(camera) == n
print('smoke:', cloud['bg']['n'], 'background points;', cloud['trail']['n'], 'trail points;', len(path), 'path samples; camera displacement', np.linalg.norm(camera[-1] - camera[0]), 'world heading', motion['tracks'][0]['angle'], 'degrees; synthetic rectangle has zero image-plane displacement', flush=True)
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
points = np.fromfile(live / cloud['bg']['pos'], np.float32).reshape(-1, 3)[::8]
colors = np.fromfile(live / cloud['bg']['rgb'], np.uint8).reshape(-1, 3)[::8] / 255
fig, ax = plt.subplots(figsize=(10, 8))
ax.scatter(points[:, 0], points[:, 2], c=colors, s=.3, alpha=.5)
ax.plot(path[:, 0], path[:, 2], 'r.-', label='synthetic subject')
ax.plot(camera[:, 0], camera[:, 2], 'c.-', label='camera')
ax.set_aspect('equal'); ax.legend(); ax.set_xlabel('world X'); ax.set_ylabel('world Z')
fig.savefig(work / 'top-view.png', dpi=120)

