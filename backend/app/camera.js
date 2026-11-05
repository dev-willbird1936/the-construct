import { spawn } from "node:child_process";
import { cancelledError } from "../lib/cancel.js";

// Measured camera motion for the route card. A single Spark still cannot see a pan or a dolly, so this compares
// a handful of small grey frames across the clip: it estimates the shift of a 3x3 grid of blocks between the
// first frame and each later frame and takes the MEDIAN, so a moving subject (a minority of blocks) does not
// read as camera motion. It is free (no Meta call) and deliberately conservative: "moving" only when most of the
// picture shifts by more than a couple of pixels at 128 px wide.

const W = 128;
const H = 72;
const SEARCH = 10; // +- px at 128 wide
export const MOVING_PX = 2.5;

// Abort-aware spawn wrapper for the short-lived local ffmpeg probes below.
// On abort the owned ffmpeg is SIGKILLed and the promise rejects with the
// shutdown-cancellation error; listeners are always removed on settle.
function abortableSpawn(ffmpeg, args, { signal } = {}) {
  const child = spawn(ffmpeg, args, { windowsHide: true });
  let onAbort = null;
  const cleanup = () => {
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    onAbort = null;
  };
  if (signal) {
    if (signal.aborted) {
      child.kill("SIGKILL");
      return {
        child,
        aborted: () => true,
        done: () => {},
        fail: () => cancelledError(),
      };
    }
    onAbort = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return { child, aborted: () => Boolean(signal?.aborted), done: cleanup, fail: () => null };
}

function grabFrames(videoPath, count, duration, { ffmpeg = "ffmpeg", signal } = {}) {
  return new Promise((resolve, reject) => {
    const fps = Math.max(0.2, (count - 1) / Math.max(0.5, duration));
    const probe = abortableSpawn(ffmpeg, ["-v", "error", "-i", videoPath, "-vf", `fps=${fps},scale=${W}:${H},format=gray`, "-frames:v", String(count), "-f", "rawvideo", "-"], { signal });
    if (probe.aborted()) return reject(probe.fail());
    const { child } = probe;
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", (error) => { probe.done(); reject(probe.aborted() ? cancelledError() : error); });
    child.on("close", (code) => {
      probe.done();
      if (probe.aborted()) return reject(cancelledError());
      const all = Buffer.concat(chunks);
      const frames = [];
      for (let i = 0; i + W * H <= all.length; i += W * H) frames.push(all.subarray(i, i + W * H));
      if (code !== 0 && !frames.length) return reject(new Error("ffmpeg frame grab failed"));
      resolve(frames);
    });
  });
}

// mean absolute difference of the block at (bx,by,bw,bh) in `a` against `b` displaced by (dx,dy)
function mad(a, b, bx, by, bw, bh, dx, dy) {
  let sum = 0;
  for (let y = by; y < by + bh; y += 1) {
    const row = y * W;
    const row2 = (y + dy) * W + dx;
    for (let x = bx; x < bx + bw; x += 1) sum += Math.abs(a[row + x] - b[row2 + x]);
  }
  return sum / (bw * bh);
}

// Median magnitude (px at 128 wide) of the block shifts between two frames, and how many blocks hit the search edge.
export function frameShift(a, b) {
  const mags = [];
  let edge = 0;
  const bw = 32;
  const bh = 18;
  for (let gy = 0; gy < 3; gy += 1) {
    for (let gx = 0; gx < 3; gx += 1) {
      const bx = SEARCH + Math.round(((W - 2 * SEARCH - bw) * gx) / 2);
      const by = SEARCH + Math.round(((H - 2 * SEARCH - bh) * gy) / 2);
      let best = Infinity;
      let bdx = 0;
      let bdy = 0;
      for (let dy = -SEARCH; dy <= SEARCH; dy += 1) {
        for (let dx = -SEARCH; dx <= SEARCH; dx += 1) {
          const score = mad(a, b, bx, by, bw, bh, dx, dy);
          if (score < best - 1e-9 || (Math.abs(score - best) < 1e-9 && Math.hypot(dx, dy) < Math.hypot(bdx, bdy))) {
            best = score;
            bdx = dx;
            bdy = dy;
          }
        }
      }
      // A shift only counts when it explains the block clearly better than no shift. Flat, noisy or churning
      // blocks (water, foliage, compression noise) have no real match and would otherwise vote for random shifts.
      const zero = mad(a, b, bx, by, bw, bh, 0, 0);
      if (zero < 2 || best > zero * 0.8) {
        mags.push(0);
        continue;
      }
      if (Math.abs(bdx) === SEARCH || Math.abs(bdy) === SEARCH) edge += 1;
      mags.push(Math.hypot(bdx, bdy));
    }
  }
  mags.sort((p, q) => p - q);
  return { median: mags[4], edge };
}

export function judgeFrames(frames) {
  if (frames.length < 2) return { moving: false, shiftPx: 0, confident: false };
  let worst = 0;
  let edgeHits = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const { median, edge } = frameShift(frames[0], frames[i]);
    worst = Math.max(worst, median);
    if (edge >= 5) edgeHits += 1;
  }
  const moving = worst >= MOVING_PX || edgeHits > 0;
  return { moving, shiftPx: Math.round(worst * 10) / 10, confident: frames.length >= 4 };
}

export async function measureCamera(videoPath, duration, { frames = 6, ffmpeg, signal } = {}) {
  const grabbed = await grabFrames(videoPath, frames, duration, { ffmpeg, signal });
  if (signal?.aborted) throw cancelledError();
  return judgeFrames(grabbed);
}

// Hard cuts can interrupt subject tracking; expose them as a quality warning.
// ffmpeg's scene score is 0..1 between consecutive frames.
export function detectCuts(videoPath, { ffmpeg = "ffmpeg", threshold = 0.4, signal } = {}) {
  return new Promise((resolve, reject) => {
    const probe = abortableSpawn(ffmpeg, ["-v", "info", "-i", videoPath, "-vf", `select=gt(scene\\,${threshold}),showinfo`, "-an", "-f", "null", "-"], { signal });
    if (probe.aborted()) return reject(probe.fail());
    const { child } = probe;
    let log = "";
    child.stderr.on("data", (c) => { log += c; if (log.length > 400_000) log = log.slice(-200_000); });
    child.on("error", (error) => { probe.done(); reject(probe.aborted() ? cancelledError() : error); });
    child.on("close", () => {
      probe.done();
      if (probe.aborted()) return reject(cancelledError());
      resolve(log.split("\n").filter((line) => line.includes("Parsed_showinfo") && / n:\s*\d+/.test(line)).length);
    });
  });
}

// Suggest a tier based on the subject and scene. Camera motion steers only
// when confidently measured, and then away from Basic, which refuses it.
export function recommendTier(route, measured) {
  if (route?.category === "drone") return { tier: "lite", why: "For aerial footage, try Lite to follow a visible subject. Small subjects and camera motion can reduce tracking quality." };
  if (route?.category === "street-sport" || (route?.subjects?.length ?? 0) > 4) {
    return { tier: "lite", why: "A busy scene: Lite follows the one subject you pick. Basic works best when one subject stands out." };
  }
  if (route?.category === "product") {
    return { tier: "advanced", why: "An object up close: try Advanced for a richer scene. A fixed camera is fastest; moving cameras end at the cloud trail." };
  }
  // runner-basic refuses exactly this measurement at job start (free), so the route must not preselect Basic.
  if (measured?.confident && measured.moving) return { tier: "lite", why: "The camera moves in this clip. Lite follows the subject you pick; Basic needs a steady camera." };
  return { tier: "basic", why: "Basic builds a scene and cloud trail for the subjects you pick. It needs a steady camera." };
}
