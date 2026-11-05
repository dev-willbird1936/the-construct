"""Bakes the data behind stable.html for a fixed-camera clip with any number of animals.

The bear stack, made automatic: the scene is rebuilt as depth surfaces textured by the footage
itself, with the animals painted out and the real video playing on them (so water keeps moving);
every animal at every sampled moment is a shell left where it stood, so the ghost trail is exact.

  node backend/tools/track-clip.mjs <video> <concept> <work>        (SAM 3.1: labels/, tracks.json)
  <da3 python> backend/tools/make-world.py <work> <video> <name> [<clip the page plays, relative to the site>] [--select-tracks <csv video-track ids>]
writes assets/stable/<name>/; stable.html?clip=<name> shows it.
Env: OVERLAY (0.93 drops a trail camera's burnt-in bottom strip), CRF (live video quality).
"""
import gc
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

import world_masks
import world_shells

SHELL_BUDGET = int(os.environ.get("SHELL_BUDGET", "1500"))   # shells a world bakes at most (see the shell loop)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from world_common import Work, Mesh, extract_frames, hide_strip  # noqa: E402
from world_env import leftovers, build_plate, plate_depth, make_camera, fit_ground, snap_to_ground, env_geometry, backdrop_hidden, union_mask, plate_fingerprint  # noqa: E402
from world_inpaint import fill as inpaint_fill, outpaint  # noqa: E402
from world_matte import Matter
from world_shells import MIN_AREA, Mono, make_shell, smooth_track, regularise, contact_shift, smooth_values, cap_to_scene  # noqa: E402
from world_masks import repair, identity_report  # noqa: E402
from world_live import Painter  # noqa: E402
from world_checks import shell_metrics, jitter, live_metrics, report  # noqa: E402
import world_preview as live_page  # noqa: E402  (no-ops unless LIVE_DIR is set: live.html)


def rename_retry(src, dst, tries=30):
    """Windows briefly locks a freshly written folder (sync clients, indexers); wait it out"""
    for k in range(tries):
        try:
            return src.rename(dst)
        except PermissionError:
            if k == tries - 1:
                raise
            time.sleep(1)


def make_live(work, plate, overlay, path, noise=60.0, tracks=None):
    """the clip at 30 fps with every animal painted out (and its shadow and reflection), over the plate,
    so the surface it plays on shows what moves (water above all) but never an animal that has a shell.
    With `tracks` (the customer's selection) only those are painted out: the others stay as filmed."""
    fps, W, H = 30, work.w, work.h
    seconds = work.n / work.fps
    n = int(round(seconds * fps))
    decode = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", str(work.start), "-i", str(work.clip), "-frames:v", str(n),
                               "-vf", f"fps={fps},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps),
                            "-i", "-", "-c:v", "libx264", "-crf", os.environ.get("CRF", "23"), "-preset", "fast", "-pix_fmt", "yuv420p",
                            "-g", "10", "-movflags", "+faststart", str(path)], stdin=subprocess.PIPE)
    painter = Painter(work, plate, overlay, noise, tracks)
    size = W * H * 3
    done = 0
    frame = None
    for j in range(n):
        raw = decode.stdout.read(size)
        # a clip's last frame can fall just past its stated duration: hold the one before it
        frame = np.frombuffer(raw, np.uint8).reshape(H, W, 3) if len(raw) == size else frame
        painted = painter.paint(frame, int(j / fps * work.fps))
        enc.stdin.write(painted.tobytes())
        live_page.publish_water(painted, j, n, fps)
        done += 1
        if j % 300 == 0:
            print(f"live: frame {j}/{n}", flush=True)
    enc.stdin.close()
    decode.stdout.close()
    assert enc.wait() == 0 and done == n, f"live video: wrote {done} of {n} frames"
    return n


def main():
    # Explicit --select-tracks (comma video-track ids) scopes SHELL emission
    # to the selected instances only. The plate and its checks keep seeing ALL
    # tracks (the still scene stays clean); the live video paints out only the
    # selected ones, so an animal nobody picked stays in the footage as filmed
    # (the pack the camera saw, not three wolves of nineteen). Legacy argv
    # without the flag paints every animal out, as before.
    argv = sys.argv[1:]
    selected = None
    if "--select-tracks" in argv:
        idx = argv.index("--select-tracks")
        try:
            selected = {int(x) for x in argv[idx + 1].split(",") if x.strip()}
        except (IndexError, ValueError):
            raise SystemExit("make-world.py: --select-tracks wants comma video-track ids")
        if not selected:
            raise SystemExit("make-world.py: --select-tracks wants comma video-track ids")
        del argv[idx:idx + 2]
    work_dir, clip, name = argv[0], argv[1], argv[2]
    overlay = float(os.environ.get("OVERLAY", "1"))
    work = Work(work_dir, clip)
    # a few limits are counts of samples, tuned at the tracker's usual 15 per second; live.html tracks every frame
    per = work.fps / 15.0
    world_shells.SMOOTH = int(round(11 * per)) | 1
    world_masks.MAX_GAP = int(round(60 * per))
    # the page plays this copy beside the world; the source stays what the live video is cut from
    web_clip = argv[3] if len(argv) > 3 else str(Path(clip).resolve().relative_to(Path(__file__).resolve().parents[2])).replace("\\", "/")
    final = Path(__file__).resolve().parents[2] / "assets" / "stable" / name
    out = final.with_name(final.name + ".building")
    stop_after_cloud = os.environ.get("WORLD_STOP_AFTER") == "cloud"
    if not stop_after_cloud:
        shutil.rmtree(out, ignore_errors=True)
        (out / "env").mkdir(parents=True)
        (out / "sub").mkdir()

    print(f"world: {work.n} samples at {work.fps} fps, {work.w}x{work.h}, {len(work.tracks['tracks'])} tracks", flush=True)
    # seconds per stage, kept in stable.json: where a job's time goes, measured on every customer's run
    timings, clock = {}, [time.time()]
    def lap(stage):
        now = time.time()
        timings[stage] = round(timings.get(stage, 0.0) + now - clock[0], 2)
        clock[0] = now
    live_page.stage("plate", "Building the empty scene…")
    live_page.detail("plate", "Reading every frame…")
    extract_frames(work)
    lap("frames")
    live_page.detail("plate", "Taking the animals out and keeping what was behind them…")
    plate, never, unseen = build_plate(work, overlay)
    lap("plate")
    # The tracker's masks are repaired against the plate they leave behind, and the plate is then
    # rebuilt from the repaired masks (a dropout leaks the animal into the first plate): twice is enough.
    repairs = {}
    if not (work.dir / "repaired").exists():
        for k in range(2):
            live_page.detail("plate", f"Mending the masks where the tracker dropped an animal (pass {k + 1} of 2)…")
            repairs = repair(work, plate, work.frame, overlay)
            print(f"masks: {repairs}", flush=True)
            for f in ("plate.png", "never.png", "plate.json", "plate_depth.npz"):
                (work.dir / f).unlink(missing_ok=True)
            live_page.detail("plate", f"Rebuilding the scene without the mended animals (pass {k + 1} of 2)…")
            plate, never, unseen = build_plate(work, overlay)
        (work.dir / "repaired").write_text(json.dumps(repairs))
    else:
        repairs = json.loads((work.dir / "repaired").read_text())
    if selected is not None and os.environ.get("WORLD_GROUP_PICK") == "1":
        # a pick drawn round a group (world.js) lifts the members mostly in view; one cut by the frame or half behind
        # another would be a fragment off-lens, so it stays in the footage as filmed. None in view: the whole group
        shares = world_masks.in_view(work, selected, overlay, MIN_AREA)
        if shares:
            selected = world_masks.keep_in_view(shares)
            print(f"selection: the group pick lifts the {len(selected)} of {len(shares)} animals mostly in view ("
                  + ", ".join(f"{t}: {s:.0%}" for t, (s, _) in sorted(shares.items())) + ")", flush=True)
    lap("mask repair")
    left = None  # skipped diagnostics have no measured cleanliness value
    if not stop_after_cloud and not os.environ.get("SKIP_PLATE_CHECK"):
        before_check = plate_fingerprint(plate)
        live_page.detail("plate", "Asking SAM whether any animal is left in the scene…")
        plate, left = leftovers(work, plate, overlay)
        if plate_fingerprint(plate) != before_check:
            Image.fromarray(plate).save(work.dir / "plate.png")
            (work.dir / "plate_depth.npz").unlink(missing_ok=True)
    lap("plate check")
    live_page.publish_plate(plate, unseen, repairs)
    live_page.stage("depth", "Depth Anything 3 reading the empty scene…")
    pd = plate_depth(work, plate)
    lap("plate depth")
    cam = make_camera(work, pd)
    depth = pd["depth"].astype(np.float64)
    plane = fit_ground(cam, depth)
    print(f"ground: plane fitted to {plane[2]:.0%} of the lower frame; da3: plate at {depth.shape[1]}x{depth.shape[0]}", flush=True)
    env_depth, weight = snap_to_ground(cam, depth, plane)
    h, w = depth.shape
    ys = np.mgrid[0:h, 0:w][0]
    conf_floor = np.percentile(pd["conf"], 25)
    valid = ~pd["sky"].astype(bool) & (pd["conf"] >= conf_floor) & (ys < h * overlay)

    # How far the eye may swing before the nearest of the scene is seen from too far aside: the parallax
    # angle to a point at distance d (median depth = 1) after a yaw of y about a pivot near the animals is
    # about y / 2 * (pivot / d); keeping it under 30 degrees for the nearest 5 % gives the cap below.
    near = float(np.percentile((env_depth / cam.scale)[valid], 5))
    yaw_limit = float(np.clip(np.degrees(2 * np.arcsin(min(1.0, near * np.tan(np.radians(30)) / 2))), 10.0, 20.0))
    print(f"orbit: nearest scene {near:.2f} of the median depth -> yaw limit {yaw_limit:.0f} degrees", flush=True)
    live_page.publish_depth(plate, cam, depth, env_depth, plane, near, yaw_limit)
    motion_summaries = live_page.publish_cloud(work, cam, plane, env_depth, plate, valid, overlay, selected)
    if stop_after_cloud:
        if not live_page.on() or motion_summaries is None:
            raise RuntimeError("Basic cloud requires LIVE_DIR and at least one tracked path")
        live_page.save_image("plate_hi.jpg", plate)
        print("world: done after cloud", flush=True)
        return
    live_page.stage("environment", "Rebuilding the scene as a surface…")
    mesh = Mesh()
    rec, fill = env_geometry(mesh, cam, env_depth, weight, valid, pad=0.5)   # an orbit of 20 degrees sees past the frame by about 45 %
    rec.update(frame=0, tex="env/plate_hi.jpg", live={"video": "env/live.mp4", "plate": "env/plate_hi.jpg", "fps": 30})
    Image.fromarray(plate).save(out / "env" / "plate_hi.jpg", quality=92)
    # the backdrop's own picture: the plate with whatever stands in front of the backdrop inpainted away,
    # shown (stable.js) once the eye leaves the lens, where an orbit looks behind near bushes and banks
    hidden = cv2.resize(backdrop_hidden(cam, env_depth, valid).astype(np.uint8), (work.w, work.h), interpolation=cv2.INTER_NEAREST) > 0
    hidden[int(work.h * overlay):] = False
    if hidden.mean() > 0.002:
        hidden = cv2.dilate(hidden.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
        Image.fromarray(hide_strip(inpaint_fill(plate, hidden), overlay)).save(out / "env" / "back.jpg", quality=90)
        fill["tex"] = "env/back.jpg"
    print(f"backdrop: {hidden.mean():.1%} of the frame hidden behind nearer surfaces" + (", inpainted" if "tex" in fill else ""), flush=True)
    # past the frame: the picture continued a quarter of the frame further on every side (LaMa), which stable.js shows
    # dimmed off the lens, where the frame's edge was a cut to black. A data strip is continued over, not kept
    if os.environ.get("WORLD_SURROUND", "1") != "0":
        # from one moment of the footage, the animals in it taken from the plate: moving water continues as water, not
        # as the plate's still median of it (a flat grey that read as a pool's concrete edge round the river)
        k = work.n // 2
        moment = work.frame(k)
        lab = work.label(k)
        if lab is not None and moment.shape == plate.shape:
            animals = cv2.dilate((lab > 0).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
            moment[animals] = plate[animals]
        else:
            moment = plate
        wide = outpaint(moment, top=int(work.h * overlay))
        half = cv2.resize(wide, (wide.shape[1] // 2, wide.shape[0] // 2), interpolation=cv2.INTER_AREA)
        Image.fromarray(half).save(out / "env" / "surround.jpg", quality=88)
        fill["surround"] = {"tex": "env/surround.jpg", "pad": [round((wide.shape[1] - plate.shape[1]) / 2 / plate.shape[1], 6),
                                                               round((wide.shape[0] - plate.shape[0]) / 2 / plate.shape[0], 6)]}
    print(f"environment: 1 merged surface, {rec['idxCount'] // 3} triangles", flush=True)
    lap("environment")

    # ── animals ──────────────────────────────────────────────────────────
    if selected is not None:
        print(f"selection: shells for tracks {sorted(selected)} only (the plate keeps all tracks out; the live video only these)", flush=True)
    live_page.stage("shells", "Cutting each animal out as a depth shell…")
    mono = Mono(work.dir / "crops")
    matter = Matter()
    by_track, present, last = {}, {}, {}
    STATIC_IOU, HOLD = 0.97, work.fps   # an animal that has not changed is not baked again, for up to a second
    # A world bakes at most SHELL_BUDGET shells (each a DA3 crop and a matte, 0.2-0.3 s): past it, each animal is
    # baked every k-th sample and held between, as an unchanged one already is. A lifted pack over a long clip
    # (ten wolves for 30 s: 4,500 shells, about 15 min) otherwise ran past the job's time limit.
    seen = {}
    for i in range(work.n):
        lab = work.label(i)
        for t, n in zip(*np.unique(lab, return_counts=True)):
            if t and n >= MIN_AREA and (selected is None or int(t) in selected):
                seen[int(t)] = seen.get(int(t), 0) + 1
    stride = world_shells.shell_stride(seen, SHELL_BUDGET)
    if stride > 1:
        print(f"shells: {sum(seen.values())} animal-moments over the budget of {SHELL_BUDGET}: every {stride}th is baked", flush=True)
    for i in range(work.n):
        lab = work.label(i)
        for t in np.unique(lab):
            if t == 0:
                continue
            if selected is not None and int(t) not in selected:
                continue
            m = lab == t
            if m.sum() < MIN_AREA:
                continue
            present.setdefault(int(t), []).append(i)
            before = last.get(int(t))
            if before and i - before[1] < HOLD and (m & before[0]).sum() / max((m | before[0]).sum(), 1) >= STATIC_IOU:
                continue
            if before and i - before[1] < stride:
                continue
            s = make_shell(work, cam, env_depth, mono, matter, i, int(t), lab, overlay, plate=plate)
            if s:
                by_track.setdefault(int(t), []).append(s)
                last[int(t)] = (m, i)
                live_page.publish_shell(s, work)
        if i % 100 == 0:
            print(f"subject: sample {i}/{work.n}", flush=True)
    mono.close()
    matter.close()
    lap("shells")

    shells, blob = [], []
    gaps, pens, raw_jitter, raw_gaps, hits, capped = [], [], [], [], [], []
    for t, items in sorted(by_track.items()):
        raw_jitter.append(jitter([(s["i"], s["med"]) for s in sorted(items, key=lambda s: s["i"])]))
        order = smooth_track(items)
        for s in order:
            s["depth"] = s["depth"] * (s["med_s"] / s["med"])
            s["med"] = s["med_s"]
            regularise(cam, s)
            raw = shell_metrics(cam, env_depth, s, work)      # before any correction: what the depth really said
            if raw:
                raw_gaps.append(raw[0])
            s["shift"] = contact_shift(env_depth, s, work)
        # the correction is smoothed along the track too, or a hidden hoof would make the animal jump
        smooth_values(order, "shift", window=int(round(5 * per)) | 1)
        for s in order:
            s["depth"] = s["depth"] + s["shift_s"]
            cap_to_scene(env_depth, s, work)
            hits.append(s["hit"])
            capped.append(s["capped"])
            s["med"] = float(np.median(s["depth"][s["body"]]))
            measured = shell_metrics(cam, env_depth, s, work)
            if measured:
                gaps.append(measured[0])
                pens.append(measured[1])
            d = s["depth"] / cam.scale
            lo, hi = float(d.min()), float(d.max())
            q = np.round((d - lo) / max(hi - lo, 1e-9) * 65535).astype(np.uint16)
            x0, y0, x1, y1 = s["box"]
            tex = f"sub/t{t}_{s['i']:05d}.webp"
            # WebP lossy at q86 banded high-frequency fur/grass into visible horizontal stripes on the
            # shells (squirrel hero-room defect, Oct 2026); q95 is clean for ~+50% shell bytes (shells are
            # a few percent of the package).
            Image.fromarray(s["rgba"]).save(out / tex, quality=95, alpha_quality=100, method=4)
            centre = cam.to_world(cam.lift(np.array([(x0 + x1) / 2 / work.w]), np.array([(y0 + y1) / 2 / work.h]), np.array([s["med"]])))[0]
            foot = cam.to_world(cam.lift(np.array([s["foot_uv"][0]]), np.array([s["foot_uv"][1]]), np.array([s["ground"]])))[0]
            shells.append({"track": t, "i": s["i"], "t": work.time(s["i"]), "box": [x0, y0, x1, y1], "gw": s["gw"], "gh": s["gh"],
                           "d": [lo, hi], "off": sum(len(b) for b in blob), "tex": tex, "centroid": centre.tolist(), "foot": foot.tolist()})
            blob.append(q.ravel())
    np.concatenate(blob).tofile(out / "shells.u16")
    shells.sort(key=lambda s: (s["i"], s["track"]))
    final_jitter = [jitter([(s["i"], s["med"]) for s in sorted(v, key=lambda s: s["i"])]) for v in by_track.values()]
    def spans(samples, gap=int(3 * work.fps)):   # an animal hidden or lost for up to 3 s is held where it was
        out = [[samples[0], samples[0]]]
        for i in samples[1:]:
            if i - out[-1][1] <= gap:
                out[-1][1] = i
            else:
                out.append([i, i])
        return out
    tracks = [{"id": t, "first": min(s["i"] for s in v), "last": max(s["i"] for s in v), "shells": len(v), "spans": spans(present[t])}
              for t, v in sorted(by_track.items())]
    print(f"subject: {len(shells)} shells in {len(tracks)} tracks", flush=True)

    # grid.bin (the environment as grids, stable-grid.mjs) is what a current viewer downloads; pos/uv/idx stay
    # for a viewer that predates it
    # the environment ships as grid.bin alone (about 1.6 MB, not 17): the viewer reads it since deploy B. WORLD_LEGACY_BUFFERS=1
    # also writes pos.f32 / uv.f32 / idx.u32, for a viewer older than that
    grid = mesh.save(out, cam.tan_x, cam.tan_y, buffers=os.environ.get("WORLD_LEGACY_BUFFERS") == "1")
    previous = final / "env" / "live.mp4"
    if os.environ.get("REUSE_LIVE") and previous.exists():     # iterating on geometry: the footage has not changed
        shutil.copy(previous, out / "env" / "live.mp4")
        print("live: reused", flush=True)
    else:
        print("live: painting the animals out of the footage…", flush=True)
        live_page.stage("water", "Painting the animals out of the live footage…")
        try:
            n_live = make_live(work, plate, overlay, out / "env" / "live.mp4", float(repairs.get("noise", 60.0)), selected)
        except (OSError, AssertionError) as error:      # an encoder that dies mid-way (this machine's memory) gets one more try
            print(f"live: {error}; trying once more", flush=True)
            gc.collect()
            n_live = make_live(work, plate, overlay, out / "env" / "live.mp4", float(repairs.get("noise", 60.0)), selected)
        print(f"live: {n_live} frames, {(out / 'env' / 'live.mp4').stat().st_size / 1e6:.1f} MB", flush=True)

    lap("live video")
    residue, liveness = live_metrics(work, plate, out / "env" / "live.mp4", overlay, selected)
    # Honest checks: each one measures what the depth and the tracker said, before a correction that
    # would make it true by construction. (After the slide and the cap, contact and penetration are ~0.)
    ident = identity_report(work)
    values = {
        "identity switches": (ident["switches"], 1 + len(by_track) // 8, "<", "an animal may be shown under two ids"),
        "unexplained tracker gaps (% of track life)": (100 * ident["unexplained"], 5.0, "<", "an animal blinks out where nothing hides it"),
        "longest unexplained gap (s)": (ident["longest"], 3.0, "<", "an animal blinks out for a while"),
        "contact gap (before slide)": (100 * float(np.median(raw_gaps)) if raw_gaps else None, 8.0, "<", "feet placement is uncertain"),
        "contact slide clamped": (100 * float(np.mean(hits)) if hits else None, 15.0, "<", "feet placement is uncertain"),
        "body behind the scene (before cap)": (100 * float(np.mean(capped)) if capped else None, 10.0, "<", "something may stand in front of an animal"),
        "jitter (raw depth)": (100 * float(np.max(raw_jitter)) if raw_jitter and all(v is not None for v in raw_jitter) else None, 8.0, "<", None),
        "jitter (final)": (100 * float(np.max(final_jitter)) if final_jitter and all(v is not None for v in final_jitter) else None, 2.0, "<", "an animal's distance wobbles"),
        "plate filled (never seen well)": (100 * float(unseen), 6.0, "<", None),
        "paint-out residue": (residue, 6.0, "<", None),
        "water liveness": (liveness, 0.8, ">=", None),
    }
    if left is not None:
        values["animal left in the plate (filled)"] = (100 * left, 5.0, "<", None)
    checks = report([(k, v[0], v[1], v[2]) for k, v in values.items()])
    # The gate: a world that fails one of these is still shown, but with the orbit narrowed, the trail
    # off and a sentence saying why, instead of looking broken to someone who cannot know better.
    # the two feet checks lean on each other (a slide that was clamped leaves a gap): one failing alone
    # is a warning, both failing (or either by double) means the feet really are uncertain
    feet = [checks["contact gap (before slide)"], checks["contact slide clamped"]]
    feet_bad = (all(c["pass"] is False for c in feet) and any(c["value"] is not None and c["value"] > 1.5 * c["limit"] for c in feet)) or any(c["value"] is not None and c["value"] > 2 * c["limit"] for c in feet)
    notes = sorted({v[3] for k, v in values.items() if v[3] and checks[k]["pass"] is False and not k.startswith("contact")} | ({values["contact slide clamped"][3]} if feet_bad else set()))
    tier = "narrow" if notes else "full"
    unverified_checks = [k for k, c in checks.items() if c["pass"] is None]
    if left is None:
        unverified_checks.append("animal left in the plate (filled)")
    # Keep availability in structured metadata: legacy viewers interpret notes
    # as an orbit-narrowing explanation, not a generic quality warning.
    print(f"gate: {tier}" + (f" ({'; '.join(notes)})" if notes else ""), flush=True)
    live_page.emit("checks", tier=tier, notes=notes, checks=checks)
    lap("checks")
    print("timing: " + ", ".join(f"{k} {v:.1f}s" for k, v in timings.items()), flush=True)
    live_page.stage("pack", "Packing the world…")
    big = max(by_track.values(), key=len)
    near0, near1 = float(big[0]["med"]) / cam.scale, float(big[-1]["med"]) / cam.scale
    mine = [s for s in shells if s["track"] == tracks[0]["id"]]
    ca, cb = mine[0]["centroid"], mine[-1]["centroid"]
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    (out / "stable.json").write_text(json.dumps({
        "version": 2, "concept": work.tracks["concept"], "clip": web_clip,
        "fps": work.fps, "width": work.w, "height": work.h, "fixed": True, "fill": fill, "overlay": overlay,
        "fovY": cam.fov_y, "tanY": cam.tan_y, "tanX": cam.tan_x,
        "times": [work.time(i) for i in range(work.n)], "cameras": [identity] * work.n,
        "env": [rec], "sub": [], "shells": shells, "tracks": tracks, "checks": checks, "repairs": repairs, "yawLimit": yaw_limit if tier == "full" else min(yaw_limit, 8.0), "tier": tier, "notes": notes, "unverifiedChecks": unverified_checks, "timings": timings,
        "selection": ({"mode": "selected", "tracks": sorted(selected)} if selected is not None else None),
        **({"grid": grid} if grid else {}),
        "motion": {"distStart": near0, "distEnd": near1, "travel": (np.array(cb) - np.array(ca)).tolist(), "cameraTravel": [0, 0, 0]},
    }))

    old = final.with_name(final.name + ".old")
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        rename_retry(final, old)
    try:
        rename_retry(out, final)
    except OSError:
        if old.exists():
            rename_retry(old, final)
        raise
    shutil.rmtree(old, ignore_errors=True)
    print(f"world: done -> {final}", flush=True)


if __name__ == "__main__":
    main()
