// Probes the Meta Model API every INTERVAL seconds and writes backend/jobs/meta-health.json (latest) and
// meta-health.jsonl (history), so agents can check availability instead of burning retries on an outage.
// A tiny SAM image call costs ~$0.0025 and is only billed when it succeeds; Spark/Muse Image are not probed.
// Run: node backend/tools/meta-health.mjs   (key from META_API_KEY)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const jobs = path.resolve(here, "..", "jobs");
fs.mkdirSync(jobs, { recursive: true });
const INTERVAL = Number(process.env.HEALTH_INTERVAL_SEC || 120) * 1000;
const key = process.env.META_API_KEY?.trim();
const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
// 1x1 transparent PNG: enough to reach the model router without costing real work
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function status(body, url = "https://api.meta.ai/v1/responses") {
  try {
    const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    await r.text().catch(() => "");
    return r.status;
  } catch {
    return 0;
  }
}

const MUSE_EVERY_MIN = Number(process.env.MUSE_PROBE_EVERY_MIN || 30);
let lastMuse = 0;
let lastMuseAt = 0;
// Meta's serving is bursty (every call 404s for minutes, then recovers), so one sample is not availability: take three.
async function probe() {
  const samBody = { model: "sam-3.1", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "dot" }, { type: "input_image", image_url: PNG }] }] };
  const samCodes = [];
  for (let i = 0; i < 3; i += 1) {
    samCodes.push(await status(samBody));
    if (i < 2) await new Promise((r) => setTimeout(r, 2000));
  }
  const spark = await status({ model: "muse-spark-1.3", input: "ok", max_output_tokens: 16 });
  // Muse Image has no free probe (an invalid size still generates), so it is sampled at most every MUSE_EVERY_MIN
  // minutes (~1 cent each) and carried forward in between.
  let muse = lastMuse;
  if (Date.now() - lastMuseAt > MUSE_EVERY_MIN * 60_000) {
    muse = await status({ model: "muse-image-1.0", prompt: "a grey square", size: "256x256", n: 1 }, "https://api.meta.ai/v1/images/generations");
    lastMuse = muse;
    lastMuseAt = Date.now();
  }
  const ok = samCodes.filter((c) => c === 200).length;
  const row = { t: new Date().toISOString(), sam31: samCodes.at(-1), samOk: `${ok}/3`, spark13: spark, muse: muse, museUp: muse === 200, samUp: ok > 0 };
  fs.writeFileSync(path.join(jobs, "meta-health.json"), JSON.stringify(row));
  fs.appendFileSync(path.join(jobs, "meta-health.jsonl"), `${JSON.stringify(row)}\n`);
  console.log(`${row.t} sam-3.1=${row.samOk} spark=${spark} muse=${muse}`);
}

await probe();
setInterval(probe, INTERVAL);
