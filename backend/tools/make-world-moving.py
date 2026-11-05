"""Build the live cloud from one multi-view DA3 solve of a moving camera."""
import os
import sys
from pathlib import Path

import cv2
import numpy as np

from world_common import Work, extract_frames
from world_moving import MovingCameras, background_mask
import world_preview as live


def main():
    args = sys.argv[1:]
    selected = None
    if '--select-tracks' in args:
        i = args.index('--select-tracks')
        try:
            selected = {int(x) for x in args[i + 1].split(',') if x.strip()}
        except (IndexError, ValueError):
            raise SystemExit('--select-tracks wants comma video-track ids')
        if not selected:
            raise SystemExit('--select-tracks wants comma video-track ids')
        del args[i:i + 2]
    work = Work(args[0], args[1])
    if not live.on():
        raise RuntimeError('Moving cloud requires LIVE_DIR')
    live.stage('plate', 'Building the moving-camera scene…')
    live.detail('plate', 'Your camera moves: choosing keyframes')
    extract_frames(work)
    picks = np.unique(np.round(np.linspace(0, work.n - 1, min(40, work.n))).astype(int))
    live.detail('plate', f'DA3 on {len(picks)} viewpoints')
    import torch
    from depth_anything_3.api import DepthAnything3
    model = DepthAnything3.from_pretrained('depth-anything/DA3-LARGE').to('cuda').eval()
    with torch.no_grad():
        pred = model.inference([str(work.frame_path(int(i))) for i in picks], process_res=392)
    depth, conf, rgb = pred.depth, pred.conf, pred.processed_images
    sky = pred.sky.astype(bool) if pred.sky is not None else np.zeros_like(depth, dtype=bool)
    scale = float(np.median(depth[np.isfinite(depth) & (depth > 0)]))
    cameras = MovingCameras(pred.intrinsics, pred.extrinsics, scale)
    live.detail('plate', 'Removing the animals from every viewpoint')
    overlay = float(os.environ.get('OVERLAY', '1'))
    floor = np.percentile(conf[np.isfinite(conf)], 25)
    bg_pos, bg_rgb = [], []
    h, w = depth.shape[1:]
    ys, xs = np.mgrid[0:h:2, 0:w:2]
    paths, positions, trail_pos, trail_rgb, ghosts = {}, {}, [], [], []
    rng = np.random.default_rng(3)
    for j, sample in enumerate(picks):
        sample = int(sample)
        lab = work.label(sample)
        if lab is None:
            raise RuntimeError(f'Missing label raster for sample {sample}')
        valid = background_mask(lab, conf[j], sky[j], overlay, floor)
        valid &= np.isfinite(depth[j]) & (depth[j] > 0)
        ok = valid[ys, xs]
        bg_pos.append(cameras.lift(j, xs[ok], ys[ok], depth[j, ys[ok], xs[ok]]))
        bg_rgb.append(rgb[j, ys[ok], xs[ok]])
        small = cv2.resize(lab, (w, h), interpolation=cv2.INTER_NEAREST)
        for track in np.unique(small):
            track = int(track)
            if not track or (selected is not None and track not in selected):
                continue
            sy, sx = np.nonzero((small == track) & np.isfinite(depth[j]) & (depth[j] > 0))
            if len(sy) < 20:
                continue
            low = sy >= sy.max() - max(1, int((sy.max() - sy.min()) * 0.08))
            x, y = float(np.median(sx[low])), float(np.median(sy[low]))
            d = float(np.median(depth[j, sy[low], sx[low]]))
            p = cameras.lift(j, x, y, d)
            row = dict(i=sample, t=work.time(sample), fx=x / w * work.w, fy=y / h * work.h,
                       ground=d / scale, width=(sx.max() - sx.min() + 1) / w * work.w,
                       body_width=float((sx.max() - sx.min() + 1) * d / (pred.intrinsics[j, 0, 0] * scale)))
            paths.setdefault(track, []).append(row)
            positions.setdefault(track, []).append(p)
            if len(sy) > live.GHOST_POINTS:
                take = rng.choice(len(sy), live.GHOST_POINTS, replace=False)
                sy, sx = sy[take], sx[take]
            ghosts.append(dict(track=track, i=sample, t=work.time(sample), n=len(sy), off=sum(len(p) for p in trail_pos)))
            trail_pos.append(cameras.lift(j, sx, sy, depth[j, sy, sx]))
            trail_rgb.append(rgb[j, sy, sx])
    if not paths:
        raise RuntimeError('Moving cloud requires at least one tracked path')
    first = int(picks[0])
    plate = work.frame(first)
    mask = cv2.dilate((work.label(first) != 0).astype(np.uint8), np.ones((11, 11), np.uint8))
    plate = cv2.inpaint(plate, mask, 3, cv2.INPAINT_TELEA)
    live.publish_plate(plate, float(mask.mean()), {})
    live.save_image('plate_hi.jpg', plate)
    live.publish_moving_cloud(work, plate, paths, positions, np.concatenate(bg_pos), np.concatenate(bg_rgb),
                              np.concatenate(trail_pos), np.concatenate(trail_rgb), ghosts,
                              float(2 * np.degrees(np.arctan(h / (2 * pred.intrinsics[0, 1, 1])))),
                              cameras.camera_to_world[:, :3, 3] * np.array([1, -1, -1]) / scale)
    live.emit('note', text='Moving-camera output stops at the cloud; shells and live footage need a fixed camera.')
    print('world: done after moving cloud', flush=True)


if __name__ == '__main__':
    main()
