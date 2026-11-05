import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Shutdown-cancellation contract shared by the server runners and the model
// helpers. A cancelled job must never spend, spawn, retry-reserve, or requeue:
// runners reject with this code and the queue pump drops the job silently
// (its row stays `running` for boot recovery, like a killed process).
export const CANCEL_CODE = "APP_SHUTDOWN";
export const CANCEL_MESSAGE = "Job cancelled during shutdown.";

export function cancelledError(message = CANCEL_MESSAGE) {
  return Object.assign(new Error(message), { code: CANCEL_CODE });
}

export function isCancelError(error) {
  return error?.code === CANCEL_CODE;
}

export function throwIfCancelled(signal, message) {
  if (signal?.aborted) throw cancelledError(message);
}

// Abort-aware sleep for retry backoffs: resolves after ms, rejects with the
// cancellation error as soon as signal aborts. Never leaves a listener behind.
export function sleepAbortable(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Kill ONLY the owned child process tree: the direct child plus the
// Python/ffmpeg grandchildren the Basic pipeline leaves behind when only the
// Node parent is signalled. Never touches any other PID.
//   win32: taskkill /PID <pid> /T /F (whole tree), SIGKILL fallback.
//   posix: negative-PID SIGKILL (whole group; the runner spawns its child
//     detached so the child leads its own group), direct SIGKILL fallback.
// Stub children without a numeric pid (tests) get a plain .kill() attempt.
// Returns true when a kill was attempted, false when there was nothing live.
export async function killProcessTree(child) {
  if (!child) return false;
  try {
    const pid = typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
    if (pid === null) {
      try {
        child.kill("SIGTERM");
        return true;
      } catch {
        return false;
      }
    }
    // Already reaped: nothing to do.
    if (child.exitCode !== null && child.exitCode !== undefined) return false;
    if (process.platform === "win32") {
      try {
        await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
        return true;
      } catch {
        // fall through to SIGKILL
      }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
        return true;
      } catch {
        // fall through to direct kill (child may not lead a group)
      }
    }
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      try {
        child.kill("SIGKILL");
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    return false;
  }
}

// Stops a spawned process and everything it started (python -> ffmpeg ...). Windows needs taskkill /T for the tree.
export function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => {});
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  } catch { /* already gone */ }
}
