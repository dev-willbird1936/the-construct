import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { worldScriptArgs } from "./seed-match.mjs";

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");

// A Python with CUDA PyTorch and Depth-Anything-3 importable (see README, "Stable").
const PYTHON = process.env.DA3_PYTHON || "python";

export const reconstructAvailable = () => fs.existsSync(PYTHON);

// A small clip (under SMALL_LONG px on its long side) is doubled with Real-ESRGAN before anything looks at it.
export const SR_WEIGHTS = process.env.SR_MODEL || "local-models/tools/sr/realesr-general-x4v3.pth";
export const enhanceAvailable = () => fs.existsSync(PYTHON) && fs.existsSync(SR_WEIGHTS);
export function enhanceClip(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-I", path.join(TOOLS, "enhance-clip.py"), input, output], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let tail = "";
    child.stdout.on("data", (c) => { tail = (tail + c).slice(-500); });
    child.stderr.on("data", (c) => { tail = (tail + c).slice(-500); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`Enhancing the clip failed (exit ${code}). ${tail.trim().split("\n").slice(-2).join(" | ")}`))));
  });
}

const SCRIPT = { basic: "make-cloud.py", advanced: "make-stable.py", world: "make-world.py" };

// What each tier's script prints, in order, as plain-language progress.
const STAGES = {
  basic: [[/^da3:/, "Placing the points in space…"], [/^cloud:/, "Packing the trail…"]],
  advanced: [[/^da3:/, "Building the scene from depth…"], [/^environment:/, "Lifting the subject, frame by frame…"], [/^subject:/, "Packing the world…"]],
  world: [
    [/^ground:/, "Building the scene from depth…"],
    [/^environment:/, "Lifting your subject, frame by frame…"],
    [/^subject: \d+ shells/, "Painting your subject out of the footage…"],
    [/^live:/, "Painting your subject out of the footage…"],
    [/^world: done/, "Packing the world…"],
  ],
};

// One GPU: builds run one at a time.
let gpu = Promise.resolve();

// The solve holds the clip's frames and depth maps in RAM. On a busy machine an allocation can
// fail; that is transient, so wait and run the (restartable) script again before giving up.
const MEMORY_RETRIES = 4;
const MEMORY_RETRY_MS = 45_000;

export function reconstruct({ mode, bakeDir, fullDir, name, clip, overlay = 1, onStage }) {
  return runScript(mode, [bakeDir, fullDir, name, clip], overlay, onStage);
}

// A fixed-camera clip with any number of animals: <work> holds what the tracker wrote.
// selectedTrackIds scopes shell emission only; null keeps the legacy argv byte-identical.
// groupPick: the selection is a pick read as a group (world.js); make-world lifts the members mostly in view.
export function reconstructWorld({ workDir, videoPath, name, webClip, overlay = 1, onStage, selectedTrackIds = null, groupPick = false, liveDir, onEvent, stopAfter, moving = false, onChild }) {
  return runScript("world", worldScriptArgs({ workDir, videoPath, name, webClip, selectedTrackIds }), overlay, onStage, { liveDir, onEvent, stopAfter, moving, onChild, groupPick: Boolean(selectedTrackIds && groupPick) });
}

function runScript(mode, args, overlay, onStage, { liveDir, onEvent, stopAfter, moving = false, onChild, groupPick = false } = {}) {
  const attempt = () => new Promise((resolve, reject) => {
    onStage("Solving camera and depth…");
    const child = spawn(PYTHON, [path.join(TOOLS, mode === "world" && moving ? "make-world-moving.py" : SCRIPT[mode]), ...args], {
      cwd: TOOLS,
      windowsHide: true,
      env: { ...process.env, OVERLAY: String(overlay), PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", ...(liveDir ? { LIVE_DIR: liveDir } : {}), ...(stopAfter ? { WORLD_STOP_AFTER: stopAfter } : {}), ...(groupPick ? { WORLD_GROUP_PICK: "1" } : {}) },
    });
    onChild?.(child);
    let tail = "";
    const reader = () => {
      let pending = ""; // a pipe can cut a line in two
      return (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith("@@live ")) {
          try { onEvent?.(JSON.parse(line.slice(7))); } catch { /* not ours */ }
          continue;
        }
        const stage = STAGES[mode].find(([pattern]) => pattern.test(line));
        if (stage) onStage(stage[1]);
        if (line.trim()) tail = (tail + line + "\n").slice(-1500);
      }
      };
    };
    child.stdout.on("data", reader());
    child.stderr.on("data", reader());
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      // Windows reports exhausted commit as "paging file is too small" (os error 1455)
      // A native crash (no Python traceback, e.g. torch aborting with exit 3) on this setup is memory too.
      const nativeCrash = !/Traceback/.test(tail) && [3, 0xC0000005, 0xC0000409, 3221226505].includes(code);
      const memory = nativeCrash || /MemoryError|out of memory|paging file|os error 1455/i.test(tail);
      const last = tail.trim().split("\n").slice(-3).join(" | ");
      reject(Object.assign(new Error(memory
        ? "The server ran out of memory while rebuilding this clip. Close other programs and try again."
        : `Reconstruction failed (exit ${code}). ${last}`), { memory }));
    });
  });

  const run = gpu.then(async () => {
    for (let tries = 1; ; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (!error.memory || tries >= MEMORY_RETRIES) throw error;
        onStage("Waiting for free memory…");
        await new Promise((resolve) => setTimeout(resolve, MEMORY_RETRY_MS));
      }
    }
  });
  gpu = run.catch(() => {});
  return run;
}
