import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";

function run(bin, args, { collectStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    if (collectStdout) child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error(`${bin} was not found on PATH. Set FFMPEG_PATH / FFPROBE_PATH.`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited with code ${code}: ${stderr.slice(-800)}`));
    });
  });
}

export async function probeVideo(videoPath) {
  const stdout = await run(
    FFPROBE_BIN,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,avg_frame_rate,nb_frames,duration:stream_tags=rotate:stream_side_data=rotation",
      "-of", "json",
      videoPath,
    ],
    { collectStdout: true }
  );
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error("Could not read video stream info.");
  const [num, den] = String(stream.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = den ? num / den : 0;
  let frameCount = Number(stream.nb_frames) || 0;
  let duration = Number(stream.duration) || 0;
  if (!frameCount && duration && fps) frameCount = Math.round(duration * fps);
  if (!duration && frameCount && fps) duration = frameCount / fps;
  // Phone clips can store their frames sideways with a display rotation
  // (side data; older ffmpeg: a `rotate` tag). width/height stay the coded
  // size here; every decoder hands out upright frames, so the upload
  // re-encodes a rotated clip upright before anything else reads it.
  const sideRotation = (stream.side_data_list || []).map((d) => Number(d?.rotation)).find(Number.isFinite);
  const rotation = Math.round(Number.isFinite(sideRotation) ? sideRotation : Number(stream.tags?.rotate) || 0);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    fps,
    frameCount,
    duration,
    rotation: ((rotation % 360) + 360) % 360,
  };
}

// Extract the still frame at the given source frame index as a PNG buffer.
export async function extractFrame(videoPath, frameIndex, outPath) {
  await run(FFMPEG_BIN, [
    "-y",
    "-i", videoPath,
    "-vf", `select='eq(n\\,${frameIndex})'`,
    "-vsync", "0",
    "-frames:v", "1",
    outPath,
  ]);
  return outPath;
}

// Extract every frame from startFrameIndex (inclusive) to the end of the clip as
// sequential PNGs, matched 1:1 to SAM's zero-based decode-order frame index.
export async function extractFrameRange(videoPath, startFrameIndex, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const pattern = path.join(outDir, "f_%08d.png");
  await run(FFMPEG_BIN, [
    "-y",
    "-i", videoPath,
    "-vf", `select='gte(n\\,${startFrameIndex})'`,
    "-vsync", "0",
    pattern,
  ]);
  const files = (await fs.readdir(outDir)).filter((f) => f.endsWith(".png")).sort();
  return files.map((filename, offset) => ({
    sourceFrameIndex: startFrameIndex + offset,
    path: path.join(outDir, filename),
  }));
}

// Extract the given zero-based source frames at full resolution. Returns their paths in
// the order of `indices`, which must be ascending (ffmpeg's select emits frames in decode order).
export async function extractFrames(videoPath, indices, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const select = indices.map((i) => `eq(n\,${i})`).join("+");
  await run(FFMPEG_BIN, ["-y", "-i", videoPath, "-vf", `select='${select}'`, "-vsync", "0", "-q:v", "2", path.join(outDir, "pick_%04d.jpg")]);
  const files = (await fs.readdir(outDir)).filter((f) => f.startsWith("pick_")).sort();
  if (files.length !== indices.length) throw new Error(`Decoded ${files.length} of ${indices.length} requested frames.`);
  return files.map((f) => path.join(outDir, f));
}

// A web-friendly copy for the viewers: H.264, at most 1280 wide, no audio.
export async function transcodeForWeb(videoPath, outPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await run(FFMPEG_BIN, ["-y", "-i", videoPath, "-an", "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-crf", "24", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath]);
  return outPath;
}

// Cut `seconds` of video from `startSeconds` at the given size and the source frame rate, no audio.
export async function cutSegment(videoPath, startSeconds, seconds, outPath, { width, height }) {
  await run(FFMPEG_BIN, ["-y", "-ss", String(startSeconds), "-i", videoPath, "-t", String(seconds), "-an", "-vf", `scale=${width}:${height}`, "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p", outPath]);
  return outPath;
}
