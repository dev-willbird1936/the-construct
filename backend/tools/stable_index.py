"""Inventory optional merge bakes without probing nonexistent HTTP resources."""
import json
import os
import tempfile
from pathlib import Path


def update_index(root):
    root = Path(root)
    clips = sorted(p.parent.name for p in root.glob("*/stable.dedup.json")
                   if not p.parent.name.endswith((".old", ".building"))
                   and p.with_name("idx.dedup.u32").is_file() and p.with_name("stable.json").is_file())
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=root, suffix=".tmp", delete=False) as f:
        json.dump(clips, f)
        f.write("\n")
        temporary = f.name
    try:
        os.replace(temporary, root / "merged-clips.json")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return clips
