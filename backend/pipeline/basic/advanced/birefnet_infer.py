"""BiRefNet_lite GPU inference for Advanced (SAM selects, BiRefNet refines).

Runs in the owner-worker CUDA env (BIREFNET_PYTHON), never on the public path.
Writes the RAW model alpha per keyframe as {stem}-raw.png; SAM gating and RGBA
assembly happen afterwards on CPU (advanced_matte.py). Fail-closed: any missing
input, weights hash mismatch, missing CUDA, load error or write error exits
nonzero; there is no binary fallback.

  python -I -B birefnet_infer.py --frames KF/ --out RAW/ --weights model.safetensors
      --weights-sha256 HEX --package DIR_WITH_birefnet_local[;DEPS_DIR...]

--package is an os.pathsep-separated list put first on sys.path in order (the
pinned birefnet_local code, then its staged dependencies such as timm).

Local weights only. Hardening carried over from the reviewed trials:
offline HF env, Triton hidden (its AMD backend spawns a process on import),
torch inductor/triton caches inside OUT, strict state-dict load, and an audit
hook that refuses network and process spawns.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

PHOTO_SUFFIXES = (".jpg", ".jpeg", ".webp")
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="BiRefNet GPU raw alphas.")
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--weights-sha256", required=True)
    ap.add_argument("--package", required=True)
    ap.add_argument("--size", type=int, default=1024)
    return ap.parse_args(argv)


def audit(event, args):
    if event == "socket.gethostname":  # local syscall (platform.uname)
        return
    if event.startswith(("socket.", "subprocess.", "urllib.", "http.client.", "webbrowser.")) or event in (
            "os.system", "os.exec", "os.spawn", "os.fork", "os.startfile", "os.posix_spawn"):
        raise PermissionError("birefnet_infer: refused " + event)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv=None):
    args = parse_args(argv)
    frames = sorted(p for p in Path(args.frames).glob("*") if p.suffix.lower() in PHOTO_SUFFIXES)
    if not frames:
        raise SystemExit(f"birefnet_infer: no keyframes in {args.frames}")
    if sha256(args.weights) != args.weights_sha256.lower():
        raise SystemExit("birefnet_infer: weights SHA-256 mismatch")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        os.environ[k] = "1"
    os.environ["TORCHINDUCTOR_CACHE_DIR"] = str(out / "inductor-cache")
    os.environ["TRITON_CACHE_DIR"] = str(out / "triton-cache")
    sys.modules["triton"] = None
    sys.addaudithook(audit)
    for entry in reversed([p for p in args.package.split(os.pathsep) if p]):
        sys.path.insert(0, entry)
    import cv2
    import numpy as np
    import torch
    from safetensors.torch import load_file
    from birefnet_local.BiRefNet_config import BiRefNetConfig
    from birefnet_local.birefnet import BiRefNet

    if not torch.cuda.is_available():
        raise SystemExit("birefnet_infer: no CUDA device")
    model = BiRefNet(config=BiRefNetConfig(bb_pretrained=False))
    model.load_state_dict(load_file(args.weights, device="cpu"), strict=True)
    model.eval().half().cuda()
    files = []
    for f in frames:
        bgr = cv2.imread(str(f), cv2.IMREAD_COLOR)
        if bgr is None:
            raise SystemExit(f"birefnet_infer: cannot read {f}")
        h, w = bgr.shape[:2]
        rgb = cv2.cvtColor(cv2.resize(bgr, (args.size, args.size), interpolation=cv2.INTER_LINEAR), cv2.COLOR_BGR2RGB) / 255.0
        x = torch.from_numpy(((rgb - np.array(MEAN)) / np.array(STD)).transpose(2, 0, 1)[None].astype(np.float32)).half().cuda()
        with torch.inference_mode():
            pred = model(x)[-1].sigmoid()[0, 0].float().cpu().numpy()
        a = cv2.resize(pred, (w, h), interpolation=cv2.INTER_LINEAR)
        dest = out / f"{f.stem}-raw.png"
        ok, buf = cv2.imencode(".png", np.round(np.clip(a, 0, 1) * 255).astype(np.uint8))
        if not ok:
            raise SystemExit(f"birefnet_infer: cannot encode {dest}")
        with open(dest, "wb") as fh:
            fh.write(buf.tobytes())
        files.append(dest.name)
    print(json.dumps({"frames": len(files), "device": torch.cuda.get_device_name(0), "dtype": "float16", "size": args.size}))


if __name__ == "__main__":
    main()
