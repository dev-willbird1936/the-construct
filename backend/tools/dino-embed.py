"""DINOv3 features of one frame, and what they say about the objects SAM found in it.

  <da3 python> dino-embed.py <frame.png> <objects.png> <out dir>

<objects.png> is an 8-bit index map: 0 = nothing, n = object n (what detectObjects paints). Writes into <out dir>:
  pca.jpg          the frame's patch features, three principal components as colour: what the model sees
  heat_<n>.png     per object, how alike every patch is to it (cosine to the object's mean feature), patch resolution
  dino.json        model used, patch grid, object-to-object similarity, and the objects grouped by kind

DINOv3 is gated on Hugging Face (licence acceptance and a token). Order tried: $DINOV3_MODEL (a folder or repo id),
folders under local-models/models/dinov3, facebook/dinov3-vitb16-pretrain-lvd1689m. If none opens, DINOv2 (Apache-2.0,
open) is used and dino.json says so: the page never claims a model that did not run.
"""
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image

DINOV3_HUB = "facebook/dinov3-vitb16-pretrain-lvd1689m"
FALLBACK = "facebook/dinov2-base"
LONG_SIDE = 896
GROUP_COS = 0.62      # two objects whose mean features agree this much are one kind


def candidates():
    env = os.environ.get("DINOV3_MODEL")
    if env:
        yield env, True
    local = Path("local-models/models/dinov3")
    if local.is_dir():
        for d in sorted(local.iterdir()):
            if (d / "config.json").exists():
                yield str(d), True
    yield DINOV3_HUB, True
    yield FALLBACK, False


def load():
    from transformers import AutoModel
    errors = []
    for name, is_v3 in candidates():
        try:
            token = os.environ.get("HF_TOKEN") or None
            model = AutoModel.from_pretrained(name, token=token, dtype=torch.float16 if torch.cuda.is_available() else torch.float32)
            return model.eval().to("cuda" if torch.cuda.is_available() else "cpu"), name, is_v3, errors
        except Exception as error:     # gated, offline, wrong folder
            errors.append(f"{name}: {type(error).__name__}: {str(error).splitlines()[0][:140] if str(error) else ''}")
    raise SystemExit("no DINO model could be loaded: " + " | ".join(errors))


def main():
    frame_path, objects_path, out = sys.argv[1:4]
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    model, name, is_v3, errors = load()
    cfg = model.config
    patch = int(getattr(cfg, "patch_size", 16))
    prefix = 1 + int(getattr(cfg, "num_register_tokens", 0))
    img = Image.open(frame_path).convert("RGB")
    w, h = img.size
    s = LONG_SIDE / max(w, h)
    gw, gh = max(1, round(w * s / patch)), max(1, round(h * s / patch))
    x = np.asarray(img.resize((gw * patch, gh * patch), Image.BICUBIC), np.float32) / 255
    x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    x = torch.from_numpy(x).permute(2, 0, 1)[None].to(model.device, model.dtype)
    with torch.no_grad():
        tokens = model(pixel_values=x).last_hidden_state[0, prefix:prefix + gw * gh].float()
    feats = torch.nn.functional.normalize(tokens, dim=-1)                 # (gh*gw, C)

    # what the model sees: the three strongest directions of variation as colour
    f = feats.cpu().numpy()
    centred = f - f.mean(0)
    comp = np.linalg.svd(centred[:: max(1, len(f) // 6000)], full_matrices=False)[2][:3]
    pca = centred @ comp.T
    lo, hi = np.percentile(pca, [2, 98], axis=0)
    pca = np.clip((pca - lo) / np.maximum(hi - lo, 1e-9), 0, 1).reshape(gh, gw, 3)
    Image.fromarray((pca * 255).astype(np.uint8)).resize((gw * 6, gh * 6), Image.BICUBIC).save(out / "pca.jpg", quality=90)

    idx = np.asarray(Image.open(objects_path).convert("L"))
    ids = [int(i) for i in np.unique(idx) if i > 0]
    desc = {}
    for i in ids:
        m = cv2.resize((idx == i).astype(np.float32), (gw, gh), interpolation=cv2.INTER_AREA).reshape(-1)
        sel = m > 0.35
        if sel.sum() == 0:
            sel = m >= m.max()
        d = torch.nn.functional.normalize(feats[torch.from_numpy(sel).to(feats.device)].mean(0), dim=0)
        desc[i] = d
        heat = (feats @ d).reshape(gh, gw).cpu().numpy()
        Image.fromarray((np.clip((heat - 0.15) / 0.6, 0, 1) * 255).astype(np.uint8)).save(out / f"heat_{i}.png")

    sim = {i: {j: round(float(desc[i] @ desc[j]), 3) for j in ids} for i in ids}
    # group by kind: connected components of "agree above GROUP_COS"
    parent = {i: i for i in ids}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a in ids:
        for b in ids:
            if a < b and sim[a][b] >= GROUP_COS:
                parent[find(a)] = find(b)
    groups = {}
    for i in ids:
        groups.setdefault(find(i), []).append(i)
    (out / "dino.json").write_text(json.dumps({
        "model": name, "dinov3": bool(is_v3), "patch": patch, "grid": [gw, gh], "registers": prefix - 1,
        "fallbackReason": None if is_v3 else errors, "groupCos": GROUP_COS,
        "sim": sim, "groups": [sorted(g) for g in groups.values()]}))
    print(f"dino: {name} ({'DINOv3' if is_v3 else 'DINOv2 fallback'}), grid {gw}x{gh}, {len(ids)} objects in {len(groups)} kinds", flush=True)


if __name__ == "__main__":
    main()
