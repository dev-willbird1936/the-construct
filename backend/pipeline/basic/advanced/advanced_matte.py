"""CPU matte assembly (Advanced tier): SAM labels + BiRefNet raw alphas -> RGBA.

Batch CLI over a keyframe dir (one call for all frames):

  python -I advanced_matte.py --frames KF/ --labels KF/ --ids 1,2
      --raw RAW/ --out OUT/

For each kf_NNNNN.jpg: SAM label kf_NNNNN.png (id-valued, channel 0) plus
BiRefNet raw alpha {stem}-raw.png (uint8, same size or bilinear-resized to
the frame with INTER_LINEAR). Runs combine() (gate + muzzle rule +
cast-shadow suppression + decontamination; temporal is OFF -- keyframes
are not consecutive) and
writes rgba_kf_NNNNN.png: straight alpha, BGRA array for cv2.imwrite
(cv2 swaps R/B on disk, so BGR input lands as correct RGB), transparent
pixels zeroed -- exactly like the product plate.py refine-alpha output.

Fail-closed: any missing/unreadable label or raw file, any shape mismatch
that is not resizable, any write error, or a missing cv2.ximgproc aborts
nonzero with a clear message -- never a silent fallback. An all-background
union mask writes a transparent RGBA and is reported (downstream drop/keep
logic unchanged). The background reference is the per-pixel median of
the run frames (static camera assumed); a static subject contaminates it,
the ratio is ~1 and nothing is dropped (documented safe failure). Prints
one JSON summary line including per-frame antenna/rule/shadow counts
(addedThinPx / ruleDroppedPx / gateDroppedPx / shadowDroppedPx).
"""

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # `python -I` strips cwd from sys.path

PHOTO_SUFFIXES = (".jpg", ".jpeg", ".webp")


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="CPU matte assembly.")
    ap.add_argument("--frames", required=True, help="Keyframe JPGs.")
    ap.add_argument("--labels", required=True, help="SAM label PNGs beside them.")
    ap.add_argument("--ids", required=True, help="Comma-separated union track ids.")
    ap.add_argument("--raw", required=True, help="BiRefNet raw alpha PNGs ({stem}-raw.png).")
    ap.add_argument("--out", required=True, help="Straight-alpha RGBA PNGs (rgba_{stem}.png).")
    return ap.parse_args(argv)


def pair_frames(frames_dir, labels_dir, raw_dir):
    """(frame, label, raw) triples, fail-closed on any missing input."""
    triples = []
    for f in sorted(Path(frames_dir).glob("*")):
        if f.suffix.lower() not in PHOTO_SUFFIXES:
            continue
        lab = Path(labels_dir) / (f.stem + ".png")
        if not lab.exists():
            raise SystemExit(f"advanced_matte: missing label {lab}")
        raw = Path(raw_dir) / (f.stem + "-raw.png")
        if not raw.exists():
            raise SystemExit(f"advanced_matte: missing raw alpha {raw}")
        triples.append((f, lab, raw))
    if not triples:
        raise SystemExit(f"advanced_matte: no keyframes in {frames_dir}")
    return triples


def _background_median(frame_paths):
    """Per-pixel median of the run frames (static camera assumed)."""
    import cv2
    import numpy as np

    first = cv2.imread(str(frame_paths[0]), cv2.IMREAD_COLOR)
    if first is None:
        raise SystemExit(f"advanced_matte: cannot read {frame_paths[0]}")
    h, w = first.shape[:2]
    stack = np.empty((len(frame_paths), h, w, 3), np.uint8)
    stack[0] = first
    for i, p in enumerate(frame_paths[1:], 1):
        img = cv2.imread(str(p), cv2.IMREAD_COLOR)
        if img is None:
            raise SystemExit(f"advanced_matte: cannot read {p}")
        if img.shape[:2] != (h, w):
            raise SystemExit(f"advanced_matte: frame size mismatch {p}")
        stack[i] = img
    # Row chunks: np.median promotes to float64, ~0.9 GB for 40 HD frames at once.
    out = np.empty((h, w, 3), np.uint8)
    for y in range(0, h, 64):
        out[y:y + 64] = np.median(stack[:, y:y + 64], axis=0).astype(np.uint8)
    return out


def _load_frame_mask(frame_p, label_p, ids):
    import cv2
    import numpy as np

    rgb = cv2.imread(str(frame_p), cv2.IMREAD_COLOR)
    if rgb is None:
        raise SystemExit(f"advanced_matte: cannot read {frame_p}")
    raw = cv2.imread(str(label_p), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise SystemExit(f"advanced_matte: cannot read {label_p}")
    if raw.ndim == 3:
        raw = raw[:, :, 0]  # palette-proof channel-0 read
    if raw.shape[:2] != rgb.shape[:2]:
        raise SystemExit(
            f"advanced_matte: shape mismatch {label_p} {raw.shape} "
            f"vs {frame_p} {rgb.shape[:2]}")
    return rgb, np.isin(raw, ids)


def drop_specks(alpha, share=0.01, rim=3):
    """Zero components (alpha > 0.5) smaller than share x mask area, plus
    soft alpha that is not within rim px of a kept component. Components
    touching the image border are kept: they are anatomy cut by the frame
    (clip-b kf108: trousers at the bottom edge), not floating grass."""
    import cv2
    import numpy as np

    solid = (alpha > 0.5).astype(np.uint8)
    total = int(solid.sum())
    if not total:
        return alpha, 0
    n, labels, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    h, w = solid.shape
    keep_ids = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= share * total
                or stats[i, cv2.CC_STAT_LEFT] == 0 or stats[i, cv2.CC_STAT_TOP] == 0
                or stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] >= w
                or stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT] >= h]
    if len(keep_ids) == n - 1:
        return alpha, 0
    keep = np.isin(labels, keep_ids).astype(np.uint8)
    near = cv2.dilate(keep, np.ones((2 * rim + 1, 2 * rim + 1), np.uint8)).astype(bool)
    dropped = int((solid.astype(bool) & ~keep.astype(bool)).sum())
    return np.where(near, alpha, 0.0).astype(alpha.dtype), dropped


def main(argv=None):
    import cv2
    import numpy as np

    from combine_matte import combine
    from occluder import remove_occluders

    args = parse_args(argv)
    ids = [int(x) for x in str(args.ids).split(",") if x.strip() != ""]
    if not ids:
        raise SystemExit("advanced_matte: --ids is empty")
    out = Path(args.out)
    triples = pair_frames(args.frames, args.labels, args.raw)
    out.mkdir(parents=True, exist_ok=True)
    bg = _background_median([t[0] for t in triples])
    files, empty, per_frame, done = [], [], {}, []
    for frame_p, label_p, raw_p in triples:
        rgb, sam = _load_frame_mask(frame_p, label_p, ids)
        bi = cv2.imread(str(raw_p), cv2.IMREAD_UNCHANGED)
        if bi is None:
            raise SystemExit(f"advanced_matte: cannot read {raw_p}")
        if bi.ndim == 3:
            bi = bi[:, :, 0]
        if bi.max() > 1.0:
            bi = bi.astype(np.float32) / 255.0
        h, w = rgb.shape[:2]
        if bi.shape != (h, w):
            bi = cv2.resize(bi.astype(np.float32), (w, h),
                            interpolation=cv2.INTER_LINEAR)
        alpha, fg = combine(sam, np.clip(bi, 0.0, 1.0).astype(np.float32),
                            rgb, bg=bg)  # BGR fg, like cv2 loads
        # Punch background-coloured occluders (grass blades in front of the
        # subject) out of the matte; the plate shows grass there. Only the
        # recoloured hole rim replaces combine's fg. An occluder failure
        # keeps the combine result: an enhancement never fails the job.
        occ_px, occ_err = 0, None
        try:
            alpha2, fg2, rep = remove_occluders(rgb, alpha, return_fg=True)
            rim = (fg2 != rgb).any(axis=2)
            fg = np.where(rim[..., None], fg2, fg)
            alpha, occ_px = alpha2, int(rep.get("removed_px", 0))
        except Exception as error:  # noqa: BLE001 - reported, not fatal
            occ_err = str(error)[:200]
        # Speck cleanup, same rule as Basic refine-alpha: components under
        # 1% of the mask (punched blades leave floating grass bits) go, with
        # their soft rim; every larger component (a 2nd object) stays.
        alpha, speck_px = drop_specks(alpha)
        a8 = np.round(np.clip(alpha, 0.0, 1.0) * 255).astype(np.uint8)
        # BGRA array: cv2.imwrite swaps R/B on disk, so this lands as
        # correct R,G,B,A. NEVER dstack R,G,B for cv2 (defect #2).
        bgra = np.dstack([fg[:, :, 0], fg[:, :, 1], fg[:, :, 2], a8])
        bgra[a8 == 0] = 0  # product convention: transparent pixels are 0
        done.append((frame_p, rgb, bgra))
        is_empty = not bool(sam.any())
        if is_empty:
            empty.append(frame_p.stem)
        per_frame[frame_p.stem] = {
            "addedThinPx": combine.last_added_thin_px,
            "ruleDroppedPx": combine.last_rule_dropped_px,
            "gateDroppedPx": combine.last_gated_dropped_px,
            "shadowDroppedPx": combine.last_shadow_dropped_px,
            "occluderRemovedPx": occ_px,
            "speckDroppedPx": speck_px,
            "occluderError": occ_err,
            "empty": is_empty,
        }
    # Edge-matched matte (Lane A tighten integration, frozen patch): one
    # clip-level source width measured at working resolution, then
    # match_edge per keyframe -- exactly one of tighten / defocus-v2 /
    # noop fires, so the two corrections stay mutually exclusive.
    # BASIC_EDGE_TIGHTEN=0 restores today's exact behaviour (defocus-v2
    # only, bit-identical). Fail-soft: any exception keeps the untightened
    # alpha and logs one line.
    width = None
    try:
        from edge_defocus import clip_source_width, defocus_bgra
        width = clip_source_width([(b, r[:, :, 3] > 127) for _, b, r in done])
    except Exception:  # noqa: BLE001
        defocus_bgra = None
    try:
        from edge_tighten import match_edge
    except Exception:  # noqa: BLE001
        match_edge = None
    for frame_p, rgb, bgra in done:
        if defocus_bgra is not None:
            if os.environ.get("BASIC_EDGE_TIGHTEN", "1") == "0" \
                    or match_edge is None or width is None:
                bgra = defocus_bgra(rgb, bgra, width)
            else:
                try:
                    a, fg = match_edge(
                        rgb,
                        bgra[:, :, 3].astype(np.float32) / 255.0,
                        np.ascontiguousarray(bgra[:, :, :3]),
                        source_width=width)[:2]
                    a8 = np.round(np.clip(a, 0.0, 1.0) * 255).astype(np.uint8)
                    out = np.dstack([fg, a8])
                    out[a8 == 0] = 0  # product convention
                    bgra = out
                except Exception as error:  # noqa: BLE001
                    print(f"advanced_matte: match_edge failed "
                          f"for {frame_p.stem}: {error}", file=sys.stderr)
        dest = out / f"rgba_{frame_p.stem}.png"
        if not cv2.imwrite(str(dest), bgra):
            raise SystemExit(f"advanced_matte: cannot write {dest}")
        files.append(dest.name)
    print(json.dumps({"frames": len(files), "out": str(args.out), "edgeSourceWidth": width,
                      "files": files, "empty": empty, "perFrame": per_frame,
                      "shadowGrayscaleSkip": bool(combine.last_shadow_skipped)}))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # fail closed with a clear message
        print(f"advanced_matte: {error}", file=sys.stderr)
        sys.exit(1)
