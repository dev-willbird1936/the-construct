// Numeric half of a world review; never a substitute for image/video/human gates.
// node backend/tools/rate-world.mjs <name> [--json]
// Missing/invalid measurements leave the overall score unknown, not a default pass.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const low = (v, limit) => v === undefined ? null : Math.max(0, Math.min(10, v <= limit / 2 ? 10 : v <= limit ? 10 - 5 * ((v - limit / 2) / (limit / 2)) : 5 - 5 * ((v - limit) / limit)));
const high = (v, limit) => v === undefined ? null : Math.max(0, Math.min(10, v >= limit * 1.25 ? 10 : v >= limit ? 5 + 5 * ((v - limit) / (limit * 0.25)) : 5 * (v / limit)));
const min = (...values) => values.includes(null) ? null : Math.min(...values);
const rounded = value => value === null ? null : +value.toFixed(1);

export function rateWorld(name, meta) {
  const missing = new Set();
  // Old worlds may contain fabricated zeros from skipped/failed checks.
  // This is a format marker, not a signed provenance or human certificate.
  const currentEvidence = Array.isArray(meta.unverifiedChecks);
  const get = key => {
    const value = meta.checks?.[key]?.value;
    if (currentEvidence && !meta.unverifiedChecks.includes(key) &&
        typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    missing.add(key);
    return undefined;
  };
  const rows = [
    ["identity", 12, min(low(get("identity switches"), 1), low(get("unexplained tracker gaps (% of track life)"), 5), low(get("longest unexplained gap (s)"), 3)), true],
    ["grounding", 14, min(low(get("contact gap (before slide)"), 8), low(get("contact slide clamped"), 15)), true],
    ["plate clean", 12, min(low(get("plate filled (never seen well)"), 6), low(get("animal left in the plate (filled)"), 5)), true],
    ["occlusion order", 8, low(get("body behind the scene (before cap)"), 10), false],
    ["temporal stability", 12, min(low(get("jitter (final)"), 2), low(get("jitter (raw depth)"), 8)), false],
    ["paint-out", 10, low(get("paint-out residue"), 6), false],
    ["liveness", 8, high(get("water liveness"), 0.8), false],
  ];
  const complete = currentEvidence && meta.unverifiedChecks.length === 0 && missing.size === 0;
  const total = rows.reduce((a, r) => a + r[1], 0);
  const mean = complete ? rows.reduce((a, r) => a + r[1] * r[2], 0) / total : null;
  const worstHard = complete ? Math.min(...rows.filter(r => r[3]).map(r => r[2])) : null;
  return {
    name, complete, missingMeasurements: [...missing],
    evidenceStatus: !currentEvidence ? "legacy-unknown" : complete ? "complete" : "unverified",
    score: complete ? rounded(Math.min(mean, worstHard + 2.5)) : null,
    mean: rounded(mean), tier: meta.tier, yawLimit: meta.yawLimit, notes: meta.notes,
    rows: rows.map(([row, weight, score]) => ({ row, weight, score: rounded(score) })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...flags] = process.argv.slice(2);
  const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const meta = JSON.parse(fs.readFileSync(path.join(site, "assets", "stable", name, "stable.json"), "utf8"));
  const out = rateWorld(name, meta);
  if (flags.includes("--json")) console.log(JSON.stringify(out));
  else {
    console.log(`${name}: ${out.complete ? `${out.score}/10 (mean ${out.mean})` : "UNVERIFIED (missing or invalid measurements)"}; tier ${out.tier ?? "legacy"}; yaw ${out.yawLimit ?? "-"}°`);
    for (const r of out.rows) console.log(`  ${r.row.padEnd(20)} ${String(r.score ?? "unknown").padStart(7)}  (weight ${r.weight})`);
    if (out.missingMeasurements.length) console.log(`  unverified: ${out.missingMeasurements.join("; ")}`);
    if (out.notes?.length) console.log(`  notes: ${out.notes.join("; ")}`);
  }
  if (!out.complete) process.exitCode = 1;
}
