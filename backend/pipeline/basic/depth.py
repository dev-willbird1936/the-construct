"""Depth Anything V2 Small (ONNX, Apache-2.0) for the Basic pipeline.

Subcommands (CPU only; threads from BASIC_THREADS, else half the usable CPUs in 2..4):
  infer  run the model on keyframes (+ plate) -> depth_<stem>.npy float32
  fit    robust scale/shift align of every frame to the reference frame over
         background pixels, bilateral smoothing, -> fitted_<stem>.npy + fit.json

Depth Anything V2 outputs relative depth with a per-image unknown scale and
shift, so frames are NOT comparable until `fit` aligns them. The alignment uses
only background pixels (label image == 0, subject dilated away), i.e. the still
world both frames saw.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def available_cpus():
    """CPUs this process may really use: the container quota first (cgroup v2
    cpu.max, then v1 cfs quota; Railway/Docker), then the scheduler affinity."""
    try:
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()[:2]
        if quota != "max":
            return max(1, int(quota) // int(period))
    except (OSError, ValueError):
        pass
    try:
        quota = int(open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read())
        period = int(open("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read())
        if quota > 0:
            return max(1, quota // period)
    except (OSError, ValueError):
        pass
    try:
        return len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        return os.cpu_count() or 2


def default_threads():
    """BASIC_THREADS wins; else half the usable CPUs, kept in 2..4. Keyframe
    depth is the critical path once the plate is in (60 frames: 22.9 s at 2
    threads, 16.1 s at 4 on the dev box, bit-identical maps); a 2-4 vCPU
    container stays at the old 2."""
    env = os.environ.get("BASIC_THREADS")
    if env:
        return int(env)
    return max(2, min(4, available_cpus() // 2))


def session(model_path, threads):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    sess = ort.InferenceSession(
        str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
    )
    name = sess.get_inputs()[0].name
    return sess, name


def preprocess(path, size):
    img = np.asarray(Image.open(path).convert("RGB"))
    h, w = img.shape[:2]
    scale = size / max(h, w)
    nw, nh = max(14, round(w * scale / 14) * 14), max(14, round(h * scale / 14) * 14)
    small = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    x = (small.astype(np.float32) / 255.0 - MEAN) / STD
    return x.transpose(2, 0, 1)[None], (w, h)


def cmd_infer(args):
    frames = sorted(Path(args.frames).glob("*.*"))
    frames = [f for f in frames if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    # Tier-improve loop 11: the thread budget runs that many frames at once,
    # one intra-op thread each, on one session (Run is thread-safe), instead
    # of one frame at a time on all threads: 60 night-bear keyframes 8.2 s ->
    # 5.2 s at 4 threads and 11.7 s -> 9.8 s at 2, the same depth maps, about
    # 25 MB more peak memory per extra frame in flight.
    workers = max(1, min(args.threads, len(frames)))
    sess, iname = session(args.model, 1 if workers > 1 else args.threads)

    def one(f):
        t0 = time.time()
        x, (w, h) = preprocess(f, args.size)
        (pred,) = sess.run(None, {iname: x})
        depth = cv2.resize(pred[0], (w, h), interpolation=cv2.INTER_LINEAR)
        np.save(out / f"depth_{f.stem}.npy", depth.astype(np.float32))
        return f, w, h, time.time() - t0

    t_all = time.time()
    if workers > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=workers) as pool:
            done = list(pool.map(one, frames))
    else:
        done = [one(f) for f in frames]
    for f, w, h, dt in done:
        print(f"infer {f.name}: {w}x{h} in {dt:.1f}s", flush=True)
    mean = (time.time() - t_all) / max(1, len(frames))  # job seconds per frame
    print(f"infer done: {len(frames)} frames, mean {mean:.1f}s/frame", flush=True)


def dilate(mask, px):
    if px <= 0:
        return mask
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * px + 1, 2 * px + 1))
    return cv2.dilate(mask, k)


def robust_fit(ref, img):
    if ref.shape != img.shape:
        raise ValueError("depth fit shape mismatch")
    if not np.isfinite(ref).all() or not np.isfinite(img).all():
        raise ValueError("nonfinite depth fit input")
    valid = np.abs(img) > 1e-9
    if valid.sum() < 50:
        raise ValueError("too few background pixels for depth fit")
    r, d = ref[valid], img[valid]
    # median-ratio start, then MAD-gated least squares (×3): exact on clean
    # data, blind to subject pixels that leaked into the background set.
    a = float(np.median(r / d))
    b = float(np.median(r - a * d))
    for _ in range(3):
        resid = np.abs(r - (a * d + b))
        gate = max(3 * float(np.median(resid)), 1e-6)
        inl = resid <= gate
        if inl.sum() < 2:
            break
        x, y = d[inl], r[inl]
        denom = inl.sum() * (x * x).sum() - x.sum() ** 2
        if abs(denom) < 1e-12:
            break
        a = float(inl.sum() * (x * y).sum() - x.sum() * y.sum()) / denom
        b = float(y.sum() - a * x.sum()) / inl.sum()
    return a, b


def cmd_fit(args):
    depth_dir = Path(args.depth)
    label_dir = Path(args.labels)
    out = Path(args.out)
    names = sorted(p.stem.replace("depth_", "") for p in depth_dir.glob("depth_*.npy"))
    if args.ref not in names:
        raise SystemExit(f"reference {args.ref} not among depth outputs")
    ref = np.load(depth_dir / f"depth_{args.ref}.npy").astype(np.float64)
    if ref.ndim != 2 or not np.isfinite(ref).all():
        raise ValueError(f"invalid reference depth {args.ref}")
    # Check the whole job before writing fitted maps. Only the explicit plate
    # may lack a label; missing observations must never become background.
    for n in names:
        depth = np.load(depth_dir / f"depth_{n}.npy", mmap_mode="r")
        if depth.shape != ref.shape or not np.isfinite(depth).all():
            raise ValueError(f"invalid depth for {n}")
        label = label_dir / f"{n}.png"
        if label.exists():
            if not label.is_file() or cv2.imread(str(label), cv2.IMREAD_GRAYSCALE) is None:
                raise ValueError(f"invalid original label for {n}")
        elif n != "plate":
            raise FileNotFoundError(f"missing original label for {n}")
    out.mkdir(parents=True, exist_ok=True)
    report = {"ref": args.ref, "frames": []}
    subject_meds = []
    track_ids = [int(x) for x in str(args.track).split(",")]

    def fit_one(n):
        d = np.load(depth_dir / f"depth_{n}.npy").astype(np.float64)
        lab_path = label_dir / f"{n}.png"
        if lab_path.exists():
            lab = cv2.imread(str(lab_path), cv2.IMREAD_GRAYSCALE)
            if lab.shape != d.shape[:2]:
                lab = cv2.resize(lab, (d.shape[1], d.shape[0]), interpolation=cv2.INTER_NEAREST)
            subj = np.isin(lab, track_ids)
            bg = ~dilate((lab > 0).astype(np.uint8), 5).astype(bool)
        else:  # the plate: everything is background
            subj = np.zeros(d.shape, bool)
            bg = np.ones(d.shape, bool)
        scale, shift = robust_fit(ref[bg], d[bg]) if n != args.ref else (1.0, 0.0)
        fitted = scale * d + shift
        # edge-aware smoothing: bilateral on a robust 0..1 range, then rescale
        lo, hi = np.percentile(fitted, [1, 99])
        span = max(hi - lo, 1e-6)
        norm = np.clip((fitted - lo) / span, 0, 1).astype(np.float32)
        smooth = cv2.bilateralFilter(norm, 7, 0.08, 7).astype(np.float64) * span + lo
        np.save(out / f"fitted_{n}.npy", smooth.astype(np.float32))
        med = float(np.median(smooth[subj])) if subj.any() else None
        return {"name": n, "scale": scale, "shift": shift, "bgPixels": int(bg.sum()), "subjectMedian": med}

    # Frames are independent, and the large numpy/OpenCV ops release the GIL,
    # so a thread pool fits several at once (tier-improve loop 11: night-bear
    # 60 frames 7.2 s serial). Same maps and report, in the same order.
    threads = getattr(args, "threads", None) or default_threads()
    if threads > 1 and len(names) > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=threads) as pool:
            records = list(pool.map(fit_one, names))
    else:
        records = [fit_one(n) for n in names]
    for r in records:
        subject_meds.append(r["subjectMedian"])
        report["frames"].append(r)
        print(f"fit {r['name']}: a={r['scale']:.3f} b={r['shift']:.3f} bg={r['bgPixels']} subjMed={r['subjectMedian']}", flush=True)
    # temporal consistency of the subject's depth: median-filter along the track
    meds = np.array([m if m is not None else np.nan for m in subject_meds])
    if np.isfinite(meds).sum() >= 3:
        kern = min(5, int(np.isfinite(meds).sum()) | 1)
        padded = np.interp(np.arange(len(meds)),
                           np.flatnonzero(np.isfinite(meds)), meds[np.isfinite(meds)])
        smooth_meds = np.array([np.median(padded[max(0, i - kern // 2):i + kern // 2 + 1])
                                for i in range(len(meds))])
        report["subjectDrift"] = float(np.nanmax(np.abs(meds - smooth_meds)) /
                                       max(np.nanmedian(np.abs(np.diff(meds[np.isfinite(meds)]))), 1e-6))
    (out / "fit.json").write_text(json.dumps(report, indent=1))
    print("fit done", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(required=True)
    a = sub.add_parser("infer")
    a.add_argument("--model", required=True)
    a.add_argument("--frames", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--size", type=int, default=350)
    a.add_argument("--threads", type=int,
                   default=default_threads())
    a.set_defaults(fn=cmd_infer)
    b = sub.add_parser("fit")
    b.add_argument("--depth", required=True)
    b.add_argument("--labels", required=True)
    b.add_argument("--track", type=str, required=True)  # subject id(s); comma list unions
    b.add_argument("--ref", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--threads", type=int, default=default_threads())
    b.set_defaults(fn=cmd_fit)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
