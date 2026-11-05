import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { killTree, isCancelError } from "./cancel.js";
import express from "express";
import sharp from "sharp";
import { client } from "./meta.js";
import { extractFrame, transcodeForWeb } from "./ffmpeg.js";
import { detectObjects, detectBox, segmentImageConcept } from "./detect.js";
import { imageBoxPixels } from "./sam-image-seed.mjs";
import { AUTO_CONCEPTS } from "./vocab.js";
import { buildWorld, probeClip } from "./world.js";
import { reconstructAvailable } from "./reconstruct.js";
import { extractText, SPARK_MODEL } from "../app/spark.js";

// live.html: the Advanced tier one step at a time, each step visible as it happens.
//
//   prepare  upload -> a web copy to scrub, and a look at the camera
//   detect   one frame: Muse Spark names what is in it, SAM 3.1 cuts each name out, DINOv3 reads the patches
//   build    the chosen subjects: tracked frame by frame, the empty scene, its depth, where each subject is heading,
//            the first cloud trail, then the rest of the world builder (shells, live water), everything but Marble
//
// A run is an ordered list of events. The page reads them over server-sent events and can rejoin at any point.

const run = promisify(execFile);
const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");
const PYTHON = process.env.DA3_PYTHON || "python";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export const MAX_SAMPLES = 600;      // tracking every frame stops here; a longer clip is sampled less often
export const MAX_SAMPLE_FPS = 30;
export const MAX_FRAME_STRIDE = 10;
const PREVIEW_W = 720;               // the width of the cut-outs and frames the page draws
const pad5 = (n) => String(n).padStart(5, "0");

const RUNS = new Map();

export const LIVE_BASE = "/api/live";

export class Run {
  constructor(kind, jobKey, dir, { owner = null } = {}) {
    this.id = `r${crypto.randomBytes(5).toString("hex")}`;
    this.kind = kind;
    this.jobKey = jobKey;
    this.owner = owner;
    this.dir = dir;
    this.events = [];
    this.listeners = new Set();
    this.status = "running";
    this.started = Date.now();
    this.stages = new Map();
    this.abort = new AbortController();     // lets Stop reach the model calls and the python children
    this.children = new Set();
    RUNS.set(this.id, this);
  }

  /** Stop this run now: abort its model calls, kill the processes it started, and tell the page. */
  cancel(message = "Stopped.") {
    if (this.status !== "running") return false;
    this.abort.abort();
    for (const child of this.children) killTree(child);
    this.finish("cancelled", { type: "cancelled", message });
    return true;
  }

  /** where a file under this run's folder is served from (liveRouter's /:id/files/*) */
  url(rel) { return `${LIVE_BASE}/${this.id}/files/${String(rel).split(path.sep).join("/")}`; }

  emit(event) {
    const e = { seq: this.events.length, at: Date.now() - this.started, ...event };
    this.events.push(e);
    for (const send of this.listeners) send(e);
    return e;
  }

  stage(id, label, extra = {}) {
    const now = Date.now();
    for (const [other, s] of this.stages) if (other !== id && !s.end) { s.end = now; this.emit({ type: "stage-end", id: other, seconds: (now - s.start) / 1000 }); }
    if (!this.stages.has(id)) { this.stages.set(id, { start: now }); this.emit({ type: "stage", id, label, ...extra }); }
    else if (label) this.emit({ type: "stage-detail", id, label });
  }

  finish(status, event) {
    if (this.status !== "running") return;
    const now = Date.now();
    for (const [id, s] of this.stages) if (!s.end) { s.end = now; this.emit({ type: "stage-end", id, seconds: (now - s.start) / 1000 }); }
    this.status = status;
    const last = this.emit({ ...event, seconds: (now - this.started) / 1000 });
    for (const send of this.listeners) send(null);
    try { this.onFinish?.(status, last); } catch (error) { console.warn("live onFinish:", error.message); }
  }
}

export const getRun = (id) => RUNS.get(id);

/** server-sent events: replays from `from`, then follows */
export function stream(run, req, res, from = 0) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (e) => {
    if (e === null) { res.write("event: end\ndata: {}\n\n"); return res.end(); }
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  res.write("retry: 2000\n\n");
  for (const e of run.events.slice(from)) send(e);
  if (run.status !== "running") return send(null);
  run.listeners.add(send);
  const beat = setInterval(() => res.write(": beat\n\n"), 15000);
  req.on("close", () => { clearInterval(beat); run.listeners.delete(send); });
}

// ── prepare ──────────────────────────────────────────────────────────────

export async function prepare(job, key) {
  const preview = path.join(job.jobDir, "preview.mp4");
  if (!fs.existsSync(preview)) await transcodeForWeb(job.videoPath, preview);
  const probe = await probeClip(job.videoPath);
  const moving = Boolean(probe && !probe.fixed && !probe.stabilizable);
  return {
    previewUrl: `${LIVE_BASE}/preview/${encodeURIComponent(key)}`,
    width: job.width, height: job.height, fps: job.fps, frameCount: job.frameCount, duration: job.duration,
    camera: probe ? { fixed: probe.fixed, stabilizable: probe.stabilizable, moving, shift: probe.shift, overlay: probe.overlay, crop: probe.crop ?? null } : null,
    supported: true,
    reason: null,
  };
}

// ── detect ───────────────────────────────────────────────────────────────

async function nameSubjects(jpeg) {
  const text = [
    "List the distinct subjects in this video frame that a viewer might want to follow: animals, people, vehicles,",
    "things that move or could. Never list scenery (trees, water, grass, sky, ground). Reply with JSON only:",
    '{"scene": "<at most 8 words: where this is>", "subjects": [{"label": "<short singular common noun phrase usable as an',
    'object-detection prompt, e.g. grizzly bear>", "main": <true for the one or two a viewer would follow>}]} with at most 6 subjects.',
  ].join(" ");
  const response = await Promise.race([
    client.responses.create({ model: SPARK_MODEL, input: [{ type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}` }] }] }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Muse Spark timed out")), 60_000)),
  ]);
  const out = extractText(response);
  const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  const subjects = (Array.isArray(parsed.subjects) ? parsed.subjects : [])
    .filter((s) => s && typeof s.label === "string" && s.label.trim())
    .slice(0, 6)
    .map((s) => ({ label: s.label.trim().toLowerCase().slice(0, 40), main: Boolean(s.main) }));
  return { scene: typeof parsed.scene === "string" ? parsed.scene.slice(0, 80) : "", subjects };
}

function runPython(script, args, { onLine, run } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-I", path.join(TOOLS, script), ...args], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" } });
    run?.children.add(child);
    let tail = "";
    const take = (c) => { tail = (tail + c).slice(-1500); onLine?.(String(c)); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", (code) => (run?.children.delete(child), code === 0 ? resolve(tail) : reject(new Error(`${script} failed (exit ${code}). ${tail.trim().split("\n").slice(-2).join(" | ")}`))));
  });
}

export function startDetect(job, jobKey, time, { owner = null, spend = () => {} } = {}) {
  const frameIndex = Math.max(0, Math.min(Math.round(time * job.fps), job.frameCount - 1));
  const dir = path.join(job.jobDir, `live-${crypto.randomBytes(4).toString("hex")}`);
  const r = new Run("detect", jobKey, dir, { owner });
  (async () => {
    await fsp.mkdir(dir, { recursive: true });
    r.stage("frame", "Pulling the frame");
    const png = path.join(dir, "frame.png");
    await extractFrame(job.videoPath, frameIndex, png);
    const buffer = await fsp.readFile(png);
    const jpeg = await sharp(buffer).resize({ width: 960, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    await fsp.writeFile(path.join(dir, "frame.jpg"), jpeg);
    r.emit({ type: "frame", url: r.url("frame.jpg"), width: job.width, height: job.height, frameIndex, time: frameIndex / job.fps });

    r.stage("spark", "Muse Spark is naming what it sees");
    let named = { scene: "", subjects: [] };
    spend("route", SPARK_MODEL, 1);
    try { named = await nameSubjects(jpeg); } catch (error) { r.emit({ type: "note", text: `Muse Spark unavailable (${error.message}); searching for people, animals and vehicles instead.` }); }
    r.emit({ type: "names", scene: named.scene, subjects: named.subjects });

    const concepts = [...new Set([...named.subjects.map((s) => s.label), ...AUTO_CONCEPTS])];
    r.stage("sam", "SAM 3.1 is cutting each of them out", { concepts });
    const finished = [];
    const segment = async (concept, dataUrl, options) => {
      const hits = await segmentImageConcept(concept, dataUrl, options);
      finished.push(concept);
      r.emit({
        type: "concept", concept, done: finished.length, of: concepts.length,
        boxes: hits.map((h) => [h.box.left / job.width, h.box.top / job.height, h.box.right / job.width, h.box.bottom / job.height]),
      });
      return hits;
    };
    spend("detect", "sam-3.1", concepts.length);
    const result = await detectObjects(buffer, job.width, job.height, [], concepts, { _segment: segment, signal: r.abort.signal });
    await fsp.writeFile(path.join(dir, "index.png"), Buffer.from(result.indexMapPngBase64, "base64"));
    // a cut-out of each, so the page can show what was found without a second pass over the index map
    const mains = new Set(named.subjects.filter((s) => s.main).map((s) => s.label));
    const objects = result.objects.map((o) => ({ ...o, suggested: mains.has(o.label) }));
    r.emit({ type: "objects", objects, indexUrl: r.url("index.png"), width: job.width, height: job.height });

    r.stage("dino", "DINOv3 is reading the frame");
    let dino = null;
    try {
      await runPython("dino-embed.py", [png, path.join(dir, "index.png"), path.join(dir, "dino")], { run: r });
      dino = JSON.parse(await fsp.readFile(path.join(dir, "dino", "dino.json"), "utf8"));
      dino.pca = r.url("dino/pca.jpg");
      dino.heat = Object.fromEntries(objects.map((o) => [o.id, r.url(`dino/heat_${o.id}.png`)]));
      r.emit({ type: "dino", ...dino });
    } catch (error) {
      r.emit({ type: "dino", error: error.message });
    }
    r.finish("done", { type: "done", frameIndex, time: frameIndex / job.fps });
  })().catch((error) => { console.error("detect:", error); r.finish("failed", { type: "error", message: error.message }); });
  return r;
}

// More selections use the exact original frame, not a newly extracted one.
function startDetectMore(job, key, source, { concept, box }, { owner, spend = () => {} }) {
  const dir = path.join(job.jobDir, `live-${crypto.randomBytes(4).toString("hex")}`);
  const r = new Run("detect-more", key, dir, { owner });
  (async () => {
    await fsp.mkdir(dir, { recursive: true });
    const buffer = await fsp.readFile(path.join(source.dir, "frame.png"));
    let result;
    if (concept) {
      spend("detect", "sam-3.1", 1);
      const hits = await segmentImageConcept(concept, `data:image/png;base64,${buffer.toString("base64")}`);
      result = await detectObjects(buffer, job.width, job.height, [], [concept], { _segment: async () => hits });
    } else {
      result = await detectBox(buffer, job.width, job.height, box, { onRequest: () => spend("detect", "sam-3.1", 1) });
      for (const object of result.objects) {
        const b = imageBoxPixels(object.box, job.width, job.height);
        const crop = await sharp(buffer).extract({ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top }).resize({ width: 960, withoutEnlargement: true }).jpeg().toBuffer();
        let label = "object";
        spend("route", SPARK_MODEL, 1);
        try { label = (await nameSubjects(crop)).subjects[0]?.label || label; } catch { /* The user can edit the fallback. */ }
        object.label = label;
      }
    }
    r.emit({ type: "concept", concept: concept || "selection", boxes: result.objects.map(o => [o.box.left, o.box.top, o.box.right, o.box.bottom]) });
    await fsp.writeFile(path.join(dir, "index.png"), Buffer.from(result.indexMapPngBase64, "base64"));
    r.emit({ type: "objects", objects: result.objects, indexUrl: r.url("index.png"), width: job.width, height: job.height });
    r.finish("done", { type: "done" });
  })().catch(error => r.finish("failed", { type: "error", message: error.message }));
  return r;
}

// ── build ────────────────────────────────────────────────────────────────

/** the longest every-frame rate that keeps the whole clip under MAX_SAMPLES */
export function sampleRate(fps, seconds, frameStride = 1) {
  if (!Number.isInteger(frameStride) || frameStride < 1 || frameStride > MAX_FRAME_STRIDE) throw Object.assign(new Error("Choose an integer frameStride from 1 to 10."), { status: 400 });
  return Math.max(2, Math.min(MAX_SAMPLE_FPS, Math.round(fps), Math.floor(MAX_SAMPLES / Math.max(seconds, 0.1)))) / frameStride;
}

export function startBuild(job, jobKey, { time, objects, clipDir, site, tier = "advanced", frameStride = 1, owner = null, spend = () => {}, onFinish }) {
  if (!['lite', 'basic', 'advanced'].includes(tier)) throw Object.assign(new Error("Choose tier lite, basic or advanced."), { status: 400 });
  if (tier !== "lite" && !reconstructAvailable()) throw Object.assign(new Error("3D reconstruction is not set up on this server (set DA3_PYTHON)."), { status: 503 });
  sampleRate(job.fps, job.duration, frameStride); // validate before creating a run
  if (tier !== "lite" && frameStride !== 1) throw Object.assign(new Error("Frame sampling is available for Lite builds only."), { status: 400 });
  const labels = [...new Set(objects.map((o) => o.label))];
  if (!objects.length || objects.length > 3) throw Object.assign(new Error("Pick one to three subjects."), { status: 400 });
  if (labels.length > 1) throw Object.assign(new Error("Pick subjects of one kind at a time (for example, only bears)."), { status: 400 });
  const dir = path.join(job.jobDir, `live-${crypto.randomBytes(4).toString("hex")}`);
  const r = new Run("build", jobKey, dir, { owner });
  r.onFinish = onFinish;
  const name = `up-${r.id}`;
  (async () => {
    await fsp.mkdir(dir, { recursive: true });
    // the clip begins where the viewer chose: everything before it is left out
    r.stage("trim", "Starting the clip at your frame");
    const from = Math.max(0, Math.min(time, job.duration - 0.2));
    let videoPath = job.videoPath;
    if (from > 0.01) {
      videoPath = path.join(dir, "from-start-frame.mp4");
      await run(FFMPEG, ["-y", "-v", "error", "-ss", String(from), "-i", job.videoPath, "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", videoPath], { signal: r.abort.signal });
    }
    const duration = Math.max(job.duration - from, 0.2);
    const sampleFps = sampleRate(job.fps, duration, frameStride);
    const trimmed = { ...job, jobDir: dir, videoPath, duration, frameCount: Math.round(duration * job.fps), selectionSnapshot: { version: 1, seedTime: 0, objects }, seedTime: 0, requireSelection: true };
    const samples = Math.round(Math.min(duration, 120) * sampleFps);
    spend("job", "sam-3.1", samples);
    r.emit({ type: "plan", from, duration, sampleFps, samples, frameStride, everyFrame: frameStride === 1 && sampleFps >= Math.round(job.fps) - 1, nativeFps: job.fps, subjects: objects, name });

    r.stage("probe", "Looking at the camera");
    const probe = await probeClip(videoPath);
    const moving = Boolean(probe && !probe.fixed && !probe.stabilizable);
    r.emit({ type: "probe", camera: probe ? { fixed: probe.fixed, stabilizable: probe.stabilizable, moving, shift: probe.shift, overlay: probe.overlay, crop: probe.crop ?? null } : null });

    const build = new Proxy({}, {
      set(o, key, value) {
        o[key] = value;
        if (key === "stage") r.stage({ stabilizing: "prepare", tracking: "track", solving: "world" }[value] ?? value, "");
        return true;
      },
    });
    const cuts = { queue: Promise.resolve(), previewW: 0, previewH: 0, frames: null, seen: 0, samples: 0, lite: tier === "lite" };
    const live = makeHooks(r, cuts, objects);
    live.signal = r.abort.signal; live.onChild = (child) => { r.children.add(child); child.on("close", () => r.children.delete(child)); };
    const viewer = await buildWorld({ build, job: trimmed, concept: labels[0], probe: tier === "lite" ? null : probe, name, clipPath: clipDir, site, sampleFps, live, lite: tier === "lite", moving, ...(tier === "basic" || moving ? { stopAfter: "cloud" } : {}) });
    await cuts.queue;
    if (tier === "lite") {
      const result = liteResult(r, cuts);
      await fsp.writeFile(path.join(dir, "lite.json"), JSON.stringify(result));
      r.finish("done", { type: "done", tier, ...result, viewer: `lite.html?run=${r.id}`, name, pack: path.basename(dir), runId: r.id });
    } else if (tier === "basic") {
      r.finish("done", { type: "done", tier: "basic", viewer: `basic-cloud.html?run=${r.id}`, name, pack: path.basename(dir) });
    } else if (moving) r.finish("done", { type: "done", tier, viewer: `basic-cloud.html?run=${r.id}`, name, pack: path.basename(dir), note: "Moving-camera output stops at the cloud; shells and live footage need a fixed camera." });
    else r.finish("done", { type: "done", viewer, name });
  })().catch((error) => { if (!r.abort.signal.aborted) console.error("build:", error); r.finish("failed", { type: "error", message: error.message }); });
  return r;
}

export function liteResult(r, cuts) {
  const ghosts = [], heading = [];
  for (const [track, points] of cuts.litePoints ?? []) {
    if (!points.length) continue;
    // The input has already been sampled. Keep every retained pose, including
    // in-place movement: a position-only filter makes playback appear frozen.
    ghosts.push(...points);
    const first = points[0], last = points.at(-1);
    const dx = (last.x - first.x) * cuts.maskW, dy = (last.y - first.y) * cuts.maskH;
    heading.push({ track, from: [first.x, first.y], to: [last.x, last.y], angle: Math.atan2(dy, dx), length: Math.hypot(dx, dy) });
  }
  ghosts.sort((a, b) => a.sample - b.sample || a.track - b.track);
  return { ghosts, heading, width: cuts.previewW || cuts.maskW, height: cuts.previewH || cuts.maskH,
    samples: cuts.tracked?.samples ?? cuts.samples, fps: cuts.tracked?.fps ?? cuts.fps,
    frame: r.url("world/live/frames/f00001.jpg") };
}

export function makeHooks(r, cuts, objects) {
  const worldLive = path.join("world", "live");
  const framesRel = path.join(worldLive, "frames");
  const cutsRel = path.join(worldLive, "cuts");
  const toUrl = (rel) => r.url(path.join(worldLive, rel));

  /** a cut-out of one mask: RGBA of its bounding box, from the preview-size frame */
  async function cutOut(frame, mask, maskW, maskH, rel, value = 1) {
    const { data, info } = frame;
    const sx = maskW / info.width, sy = maskH / info.height;
    let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
    for (let y = 0; y < info.height; y += 1) {
      const row = Math.min(maskH - 1, Math.floor(y * sy)) * maskW;
      for (let x = 0; x < info.width; x += 1) {
        if (mask[row + Math.min(maskW - 1, Math.floor(x * sx))] !== value) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0 || x1 - x0 < 2 || y1 - y0 < 2) return null;
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const rgba = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y += 1) {
      const row = Math.min(maskH - 1, Math.floor((y0 + y) * sy)) * maskW;
      for (let x = 0; x < cw; x += 1) {
        if (mask[row + Math.min(maskW - 1, Math.floor((x0 + x) * sx))] !== value) continue;
        const from = ((y0 + y) * info.width + x0 + x) * info.channels;
        const to = (y * cw + x) * 4;
        rgba[to] = data[from]; rgba[to + 1] = data[from + 1]; rgba[to + 2] = data[from + 2]; rgba[to + 3] = 255;
      }
    }
    await fsp.mkdir(path.dirname(path.join(r.dir, rel)), { recursive: true });
    await sharp(rgba, { raw: { width: cw, height: ch, channels: 4 } }).webp({ quality: 82, alphaQuality: 90 }).toFile(path.join(r.dir, rel));
    return [x0 / info.width, y0 / info.height, (x1 + 1) / info.width, (y1 + 1) / info.height];
  }

  const decode = (sample) => sharp(path.join(r.dir, framesRel, `f${pad5(sample + 1)}.jpg`)).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  return {
    dir: path.join(r.dir, "world", "live"),
    detail: (text) => r.stage("track", text),

    async beforeTrack({ videoPath, width, height, fps, seconds }) {
      await fsp.mkdir(path.join(r.dir, framesRel), { recursive: true });
      // the frames the page draws the cut-outs from: the clip as it is tracked, at the tracking rate
      const pw = Math.min(PREVIEW_W, width);
      await run(FFMPEG, ["-y", "-v", "error", "-i", videoPath, "-t", String(seconds), "-vf", `fps=${fps},scale=${pw}:-2`, "-q:v", "3", "-start_number", "1", path.join(r.dir, framesRel, "f%05d.jpg")]);
      cuts.samples = Math.round(seconds * fps);
      cuts.maskW = width;
      cuts.maskH = height;
      const first = await sharp(path.join(r.dir, framesRel, "f00001.jpg")).metadata();
      cuts.previewW = first.width; cuts.previewH = first.height; cuts.fps = fps;
      r.emit({ type: "track-start", samples: cuts.samples, fps, width: first.width, height: first.height, source: { width, height }, frameUrl: toUrl("frames/f00001.jpg"), frameBase: toUrl("frames") });
      r.stage("track", "SAM 3.1 is following your subjects, frame by frame");
    },

    // SAM's own ids, as frames arrive: provisional until the tracker has linked them
    onFrame(sample, items, meta) {
      cuts.queue = cuts.queue.then(async () => {
        try {
          const frame = await decode(sample);
          for (const item of items) {
            const rel = path.join(cutsRel, `p${meta.chunk}_${item.id}_${pad5(sample)}.webp`);
            const box = await cutOut(frame, item.raster, cuts.maskW, cuts.maskH, rel);
            if (box) r.emit({ type: "cut", provisional: true, sample, chunk: meta.chunk, id: item.id, box, url: toUrl(path.join("cuts", path.basename(rel))) });
          }
          cuts.seen = Math.max(cuts.seen, sample + 1);
          r.emit({ type: "track-progress", sample, samples: cuts.samples });
        } catch (error) { console.warn("cut-out failed:", error.message); }
      });
    },

    async afterTrack(tracked) {
      await cuts.queue;
      cuts.tracked = tracked;
      r.emit({ type: "tracked", tracks: tracked.tracks, samples: tracked.samples, fps: tracked.fps, concept: tracked.concept });
    },

    // the tracker's final ids: the selected subjects, cut out again under them, in order
    async selection(trackIds, allTracks) {
      const tracked = cuts.tracked;
      r.emit({ type: "selection", trackIds, tracks: allTracks.filter((t) => trackIds.includes(t.id)), others: allTracks.length - trackIds.length });
      r.stage("ghosts", "Cutting your subjects out of every frame");
      const keep = new Set(trackIds);
      cuts.litePoints = new Map(trackIds.map((id) => [id, []]));
      for (let sample = 0; sample < tracked.samples; sample += 1) {
        let label;
        try { label = await sharp(path.join(r.dir, "world", "labels", `l${pad5(sample)}.png`)).extractChannel(0).raw().toBuffer(); } catch { continue; }
        const present = [...new Set(label)].filter((id) => keep.has(id));
        if (!present.length) continue;
        const frame = await decode(sample);
        for (const id of present) {
          const rel = path.join(cutsRel, `t${id}_${pad5(sample)}.webp`);
          const box = await cutOut(frame, label, tracked.width, tracked.height, rel, id);
          if (box) {
            const url = toUrl(path.join("cuts", path.basename(rel)));
            r.emit({ type: "cut", sample, track: id, box, url });
            if (cuts.lite) {
              let sx = 0, sy = 0, count = 0;
              for (let p = 0; p < label.length; p += 1) if (label[p] === id) { sx += p % tracked.width; sy += Math.floor(p / tracked.width); count += 1; }
              cuts.litePoints.get(id).push({ sample, track: id, box, url, x: sx / count / tracked.width, y: sy / count / tracked.height, width: box[2] - box[0] });
            }
          }
        }
        if (sample % 5 === 0) r.emit({ type: "ghost-progress", sample, samples: tracked.samples });
      }
      r.emit({ type: "ghosts-done" });
    },

    onPython(event) {
      const mapped = { ...event };
      for (const key of ["file", "snapped", "ground", "json"]) if (typeof mapped[key] === "string") mapped[key] = toUrl(mapped[key]);
      if (mapped.kind === "stage") return r.stage(mapped.id, mapped.label);
      r.emit({ type: mapped.kind, ...mapped, kind: undefined });
    },
  };
}

// ── the routes, shared by the dev server (server.js) and the production app (app/routes.js) ──

/**
 * opts.resolveJob(req, res, key) -> { videoPath, jobDir, width, height, fps, frameCount, duration } | null
 *     (answers the request itself when it returns null); key is the upload/job id.
 * opts.owner(req)  -> the user a run belongs to (null: no accounts)
 * opts.guard(req, res, kind, job, info) -> true to go on (kind: "prepare" | "detect" | "build"); answers the request when false
 * opts.spend(req, job) -> (kind, model, units) => void : books a Meta call
 * opts.clipDir, opts.site: where the finished world's web clip and viewer data go
 * opts.onBuildFinish(req, job, status, event)
 */
export function liveRouter(opts) {
  const router = express.Router();
  const keyOf = (req) => String(req.body?.uploadId || req.body?.jobId || "");
  const route = (handler) => async (req, res) => {
    try { await handler(req, res); } catch (error) { console.error("live:", error); res.status(error.status || 500).json({ error: error.status ? error.message : "That step failed. Try again." }); }
  };
  const mine = (req, res) => {
    const run = getRun(req.params.id);
    if (!run || (run.owner != null && run.owner !== opts.owner?.(req))) { res.status(404).json({ error: "Unknown run." }); return null; }
    return run;
  };

  router.post("/prepare", route(async (req, res) => {
    const key = keyOf(req);
    const job = opts.resolveJob(req, res, key);
    if (!job) return;
    if (opts.guard && !opts.guard(req, res, "prepare", job)) return;
    res.json(await prepare(job, key));
  }));

  router.get("/preview/:key", route((req, res) => {
    const job = opts.resolveJob(req, res, req.params.key);
    if (!job) return;
    const file = path.join(job.jobDir, "preview.mp4");
    if (!fs.existsSync(file)) return res.status(404).json({ error: "No preview yet." });
    res.sendFile(file, { headers: { "Cache-Control": "no-store" } });
  }));

  router.post("/detect", route(async (req, res) => {
    const key = keyOf(req);
    const job = opts.resolveJob(req, res, key);
    if (!job) return;
    if (opts.guard && !opts.guard(req, res, "detect", job)) return;
    const run = startDetect(job, key, Number(req.body?.time) || 0, { owner: opts.owner?.(req) ?? null, spend: opts.spend?.(req, job) });
    res.json({ runId: run.id });
  }));

  router.post("/detect-more", route(async (req, res) => {
    const key = keyOf(req);
    const job = opts.resolveJob(req, res, key);
    if (!job) return;
    const source = getRun(String(req.body?.runId || ""));
    if (!source || source.kind !== "detect" || source.jobKey !== key || (source.owner != null && source.owner !== opts.owner?.(req))) return res.status(404).json({ error: "Unknown detection." });
    const concept = typeof req.body?.concept === "string" ? req.body.concept.trim().toLowerCase() : "";
    if (concept.length > 80 || (!!concept === !!req.body?.box)) return res.status(400).json({ error: "Enter a subject or draw a box." });
    let box;
    if (!concept) {
      try { box = imageBoxPixels(req.body.box, job.width, job.height); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
    if (opts.guard && !opts.guard(req, res, "detect-more", job)) return;
    const run = startDetectMore(job, key, source, { concept, box }, { owner: opts.owner?.(req) ?? null, spend: opts.spend?.(req, job) });
    res.json({ runId: run.id });
  }));

  router.post("/build", route(async (req, res) => {
    const key = keyOf(req);
    const job = opts.resolveJob(req, res, key);
    if (!job) return;
    const objects = (Array.isArray(req.body?.objects) ? req.body.objects : []).map((o) => ({ label: String(o?.label ?? "").trim(), box: o?.box }));
    const time = Number(req.body?.time) || 0;
    const tier = req.body?.tier ?? "advanced";
    if (!["lite", "basic", "advanced"].includes(tier)) return res.status(400).json({ error: "Choose tier lite, basic or advanced." });
    const frameStride = req.body?.frameStride ?? 1;
    if (!Number.isInteger(frameStride) || frameStride < 1 || frameStride > MAX_FRAME_STRIDE) return res.status(400).json({ error: "Choose an integer frameStride from 1 to 10." });
    if (tier !== "lite" && frameStride !== 1) return res.status(400).json({ error: "Frame sampling is available for Lite builds only." });
    if (opts.guard && !opts.guard(req, res, "build", job, { objects, time, tier, frameStride })) return;
    let run;
    try {
      run = startBuild(job, key, {
        time, objects, tier, frameStride, clipDir: opts.clipDir, site: opts.site, owner: opts.owner?.(req) ?? null, spend: opts.spend?.(req, job),
        onFinish: (status, event) => opts.onBuildFinish?.(req, job, status, event, { objects, time, tier }),
      });
    } catch (error) { opts.onBuildAbort?.(req); throw error; }
    res.json({ runId: run.id, tier, frameStride });
  }));

  // Stop what is running: one run, or everything of this user's (also clears a stuck "already building" flag)
  router.post("/cancel-all", (req, res) => {
    const owner = opts.owner?.(req) ?? null;
    let stopped = 0;
    for (const run of RUNS.values()) if (run.status === "running" && run.owner === owner && run.cancel("Stopped by you.")) stopped += 1;
    opts.onBuildAbort?.(req);
    res.json({ stopped });
  });
  router.post("/:id/cancel", (req, res) => {
    const run = mine(req, res);
    if (!run) return;
    const stopped = run.cancel("Stopped by you.");
    if (run.kind === "build") opts.onBuildAbort?.(req);
    res.json({ stopped });
  });

  router.get("/:id/events", (req, res) => {
    const run = mine(req, res);
    if (!run) return;
    const last = req.headers["last-event-id"];
    stream(run, req, res, Number(req.query.from) || (last === undefined ? 0 : Number(last) + 1));
  });

  router.get("/:id/files/*", (req, res) => {
    const run = mine(req, res);
    if (!run) return;
    const file = path.resolve(run.dir, req.params[0] || "");
    if (!file.startsWith(path.resolve(run.dir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).json({ error: "No such file." });
    res.sendFile(file, { headers: { "Cache-Control": "private, max-age=3600" } });
  });

  return router;
}
