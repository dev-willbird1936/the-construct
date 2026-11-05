import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { cancelledError, isCancelError, throwIfCancelled } from "./cancel.js";

function loadApiKey() {
  // Through the local credential-injecting proxy (tools/meta-proxy.mjs) no real key is needed or held.
  if (process.env.META_BASE_URL && !process.env.META_API_KEY) return "via-meta-proxy";
  if (process.env.META_API_KEY) return process.env.META_API_KEY.trim();
  throw new Error(
    "No Meta Model API key found. Set META_API_KEY"
  );
}

export const client = new OpenAI({
  baseURL: process.env.META_BASE_URL || "https://api.meta.ai/v1",
  apiKey: loadApiKey(),
});

// Meta's API intermittently answers `404 The requested model was not found` for models that exist (observed Oct 24:
// ~3 in 4 sam-3.1 calls and ~2 in 3 muse-spark-1.3 calls failed in a burst, muse-image-1.0 did not). The OpenAI SDK does
// not retry a 404, so every caller was fragile. Treat that one error as transient: retry the model call with exponential
// backoff and jitter. Wrapping the calls (not the transport) leaves multipart file uploads on the SDK's own fetch shim.
const MODEL_404 = /model was not found|model_not_found/i;
export const MAX_MODEL_RETRIES = Number(process.env.META_MODEL_RETRIES || 12);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const isTransientModel404 = (error) => error?.status === 404 && MODEL_404.test(String(error?.message ?? ""));

// Abort-aware sleep for the backoff above: the injected `wait` (tests stub
// it) is raced against the signal so shutdown never waits out a backoff.
async function abortableWait(ms, signal, wait) {
  if (!signal) return wait(ms);
  if (signal.aborted) throw cancelledError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([wait(ms), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function withModelRetry(call, { retries = MAX_MODEL_RETRIES, baseMs = 500, capMs = 10_000, wait = sleep, signal } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    throwIfCancelled(signal);
    try {
      return await call();
    } catch (error) {
      // Shutdown wins over every other outcome: never retry, never report
      // an outage, never let a raw SDK abort escape as a generic failure.
      if (isCancelError(error)) throw error;
      if (signal?.aborted) throw cancelledError();
      if (!isTransientModel404(error) || attempt >= retries) throw error;
      await abortableWait(Math.min(capMs, baseMs * 2 ** attempt) * (0.5 + Math.random()), signal, wait);
    }
  }
}

// Duck-typed AbortSignal on the trailing SDK options argument (all wrapped
// methods accept (body, options)); lets callers forward cancellation where
// the SDK supports it while leaving single-arg calls untouched.
function signalFromArgs(args) {
  const last = args.length > 1 ? args[args.length - 1] : null;
  return last && typeof last === "object" && typeof last.signal?.aborted === "boolean" ? last.signal : undefined;
}

for (const [group, method] of [["responses", "create"], ["images", "generate"], ["images", "edit"]]) {
  const target = client[group];
  const original = target[method].bind(target);
  // An explicit SDK no-retry budget must also disable this extra model-404 retry layer.
  target[method] = (...args) => withModelRetry(() => original(...args), {
    signal: signalFromArgs(args),
    ...(args.length > 1 && args.at(-1)?.maxRetries === 0 ? { retries: 0 } : {}),
  });
}
