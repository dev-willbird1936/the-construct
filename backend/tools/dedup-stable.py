"""Voxel de-duplication of a baked stable world, after TrackEverything
(Jain et al. 2026, arXiv 2609.30222): co-located observations of one surface
are merged so each place is kept once, from its best view.

Keyframe surfaces overlap wherever the moving camera saw the same wall twice.
Here the environment's triangles are binned into a world voxel grid; in each
voxel only the keyframe that saw it at the finest texel density (smallest
world area per triangle: near and face-on) is kept.

  python backend/tools/dedup-stable.py <name> [voxel=0.02] [cover=0.8]
reads assets/stable/<name>/, writes idx.dedup.u32 + stable.dedup.json beside
them; stable.html?clip=<name>&dedup=1 shows it. The bake itself is untouched.
"""
import json
import sys
from pathlib import Path

import numpy as np
from stable_index import update_index

name = sys.argv[1]
voxel = float(sys.argv[2]) if len(sys.argv) > 2 else 0.02
COVER = float(sys.argv[3]) if len(sys.argv) > 3 else 0.8
base = Path(__file__).resolve().parents[2] / "assets" / "stable" / name
meta = json.loads((base / "stable.json").read_text())
pos = np.fromfile(base / "pos.f32", np.float32).reshape(-1, 3)
idx = np.fromfile(base / "idx.u32", np.uint32).reshape(-1, 3)

tri_env, tri_idx = [], []
for k, e in enumerate(meta["env"]):
    t = idx[e["idxOffset"] // 3:(e["idxOffset"] + e["idxCount"]) // 3] + e["vertOffset"]
    tri_env.append(np.full(len(t), k)), tri_idx.append(t)
tri_env, tri = np.concatenate(tri_env), np.concatenate(tri_idx)
p = pos[tri]                                   # (T, 3, 3)
area = 0.5 * np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1)
# voxel of the centroid and of each corner (a triangle straddling a border
# must survive if it wins either side, or the seam opens a crack)
pts = np.concatenate([p.mean(1)[:, None], p], 1)
_, cid = np.unique(np.floor(pts / voxel).astype(np.int64).reshape(-1, 3), axis=0, return_inverse=True)
cid = cid.reshape(-1, 4)
vox = cid[:, 0]

# per (voxel, keyframe): surface area covered and mean triangle area
pair, pid = np.unique(vox * len(meta["env"]) + tri_env, return_inverse=True)
pair_sum = np.bincount(pid, area)
pair_area = pair_sum / np.bincount(pid)
pv, pk = pair // len(meta["env"]), pair % len(meta["env"])
best = np.zeros(vox.max() + 1)
np.maximum.at(best, pv, pair_sum)
thin = pair_sum < COVER * best[pv]
order = np.lexsort((pair_area, thin, pv))      # by voxel, well-covering first, then finest
first = order[np.r_[True, pv[order][1:] != pv[order][:-1]]]
winner = np.full(cid.max() + 1, -1, np.int64)
winner[pv[first]] = pk[first]
seen = winner[cid]
keep = ((seen == tri_env[:, None]) | (seen < 0)).any(1)

sub0 = next(r["idxOffset"] for r in meta["sub"] if r)  # subject indices start here
# per keyframe: winning triangles first, then the redundant ones. The viewer
# draws the second group behind the first (soft merge, no cracks) or not at
# all (?dedup=hard, fewest triangles, thin seams)
out, env = [], []
for k, e in enumerate(meta["env"]):
    win = tri[keep & (tri_env == k)] - e["vertOffset"]
    lose = tri[~keep & (tri_env == k)] - e["vertOffset"]
    env.append({"idxOffset": sum(len(x) for x in out) * 3, "idxCount": len(win) * 3, "loseCount": len(lose) * 3})
    out += [win.astype(np.uint32), lose.astype(np.uint32)]
# the subject's triangles ride along unchanged, after the merged environment
n_env = sum(len(x) for x in out) * 3
sub = [None if r is None else {"idxOffset": r["idxOffset"] - sub0 + n_env} for r in meta["sub"]]
np.concatenate(out + [idx[sub0 // 3:].astype(np.uint32)]).tofile(base / "idx.dedup.u32")
(base / "stable.dedup.json").write_text(json.dumps({"voxel": voxel, "env": env, "sub": sub, "tris": [len(tri), int(keep.sum())]}))
update_index(base.parent)
print(f"{name}: voxel {voxel}, cover {COVER}: {len(tri):,} -> {int(keep.sum()):,} triangles ({keep.mean():.1%} kept), "
      f"{len(set(vox))} voxels, winners spread over {len(set(winner) - {-1})}/{len(meta['env'])} keyframes")
