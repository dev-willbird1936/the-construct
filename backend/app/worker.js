import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

// Advanced ("World") queue + outbound-polling worker API.
//   POST /api/worker/claim                  Bearer WORKER_TOKEN -> oldest queued_gpu job + one-time download URL
//   POST /api/worker/:id/progress          {stage, detail, progress}
//   POST /api/worker/:id/result             multipart zip package + result JSON
//   GET  /api/worker/download/:uploadId     ?token= (single use, expiring, HMAC-signed)
//   GET  /api/worker/status                 {online, lastSeenAt} (public, for honest UI state)
// Leases give a visibility timeout: a claim that is never finished expires
// and the job returns to the queue. Secrets/tokens are never logged.

export function workerAuth(req, config) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || !config.workerToken) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(config.workerToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function heartbeat(db) {
  db.prepare("INSERT INTO heartbeat(id,at) VALUES('worker',?) ON CONFLICT(id) DO UPDATE SET at=excluded.at").run(Date.now());
}

export function workerStatus(db, config) {
  const row = db.prepare("SELECT at FROM heartbeat WHERE id='worker'").get();
  const lastSeenAt = row ? Number(row.at) : null;
  return { online: lastSeenAt !== null && Date.now() - lastSeenAt < config.workerOnlineSec * 1000, lastSeenAt };
}

export function claimJob(db, config, workerId) {
  const now = Date.now();
  // New jobs plus claims whose lease expired without progress (visibility
  // timeout): both are pickable, the UPDATE decides the race.
  const job = db
    .prepare("SELECT * FROM jobs WHERE tier='advanced' AND status IN ('queued_gpu','claimed') AND lease_expires<=? ORDER BY created_at ASC LIMIT 1")
    .get(now);
  if (!job) return null;
  const leaseExpires = now + config.workerLeaseSec * 1000;
  db.prepare("UPDATE jobs SET status='claimed', worker_id=?, lease_expires=?, stage='claimed', detail='GPU worker picked it up.', updated_at=? WHERE id=? AND lease_expires<=?")
    .run(workerId, leaseExpires, now, job.id, now);
  const updated = db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
  if (updated.status !== "claimed" || updated.worker_id !== workerId) return null; // lost the race
  heartbeat(db);
  return updated;
}

// ---- one-time signed download URLs for the source video ----
function hmac(config, text) {
  return crypto.createHmac("sha256", config.workerToken).update(text).digest("hex");
}

export function mintDownloadToken(db, config, uploadId) {
  const id = crypto.randomBytes(16).toString("hex");
  const expires = Date.now() + config.workerLeaseSec * 1000;
  const sig = hmac(config, `${id}.${expires}.${uploadId}`);
  db.prepare("INSERT INTO tokens(id,upload_id,expires,used) VALUES(?,?,?,0)").run(id, uploadId, expires);
  return `${id}.${expires}.${sig}`;
}

export function redeemDownloadToken(db, config, uploadId, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  const expected = hmac(config, `${id}.${expires}.${uploadId}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const row = db.prepare("SELECT * FROM tokens WHERE id=?").get(id);
  if (!row || row.upload_id !== uploadId || row.used || row.expires !== expires) return null;
  db.prepare("UPDATE tokens SET used=1 WHERE id=?").run(id);
  return row;
}

// ---- minimal ZIP extraction (stored + deflated only, no new deps) ----
// Rejects absolute paths, "..", symlinks, and oversized packages so a
// hostile worker package cannot escape specimens/<id>/.
export function extractZip(buffer, dest, { maxFiles, maxBytes }) {
  if (buffer.length < 22) throw new Error("Not a zip file.");
  // Find end-of-central-directory.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65536; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file.");
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new Error(`Zip holds ${count} files (max ${maxFiles}).`);
  let total = 0;
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip directory.");
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const external = buffer.readUInt32LE(p + 38);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory
    if (method !== 0 && method !== 8) throw new Error(`Unsupported zip method in ${name}.`);
    const unixMode = (external >>> 16) & 0o170000;
    if (unixMode === 0o120000) throw new Error(`Symlink rejected: ${name}.`);
    validateName(name);
    total += size;
    if (total > maxBytes) throw new Error("Unpacked size exceeds the limit.");
    entries.push({ name, method, localOffset });
    if (entries.length > maxFiles) throw new Error(`Zip holds too many files (max ${maxFiles}).`);
  }
  const files = [];
  let inflated = 0;
  for (const entry of entries) {
    if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error("Corrupt zip data.");
    const nameLen = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLen = buffer.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const compSize = buffer.readUInt32LE(entry.localOffset + 18);
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    let data;
    if (entry.method === 0) {
      data = Buffer.from(raw);
    } else {
      // Header sizes can lie: cap the actual inflation (zip-bomb defense).
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(0, maxBytes - inflated) });
      } catch {
        throw new Error("Unpacked size exceeds the limit.");
      }
    }
    inflated += data.length;
    if (inflated > maxBytes) throw new Error("Unpacked size exceeds the limit.");
    files.push({ name: entry.name, data });
  }
  return files;
}

function validateName(name) {
  if (!name || name.length > 512) throw new Error("Bad file name in zip.");
  if (name.includes("\0") || name.includes("\\")) throw new Error(`Bad file name: ${name}.`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error(`Absolute path rejected: ${name}.`);
  const segs = name.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) throw new Error(`Unsafe path rejected: ${name}.`);
}

export async function writePackage(dest, files) {
  await fsp.mkdir(dest, { recursive: true });
  let bytes = 0;
  for (const file of files) {
    const out = path.join(dest, file.name);
    if (!out.startsWith(dest + path.sep)) throw new Error(`Unsafe path rejected: ${file.name}.`);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    // Fresh per-job dir under our control; still never follow a symlink.
    const stat = await fsp.lstat(out).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error(`Symlink rejected: ${file.name}.`);
    await fsp.writeFile(out, file.data);
    bytes += file.data.length;
  }
  return bytes;
}

export async function dirSize(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export function pruneTokens(db) {
  try {
    db.prepare("DELETE FROM tokens WHERE used=1 OR expires<?").run(Date.now() - 3600_1000);
  } catch {
    // best effort
  }
}

export function safeUnlink(filePath) {
  fs.unlink(filePath, () => {});
}

// Provenance tokens a worker may legitimately claim. Anything else is
// dropped — a hostile or confused worker cannot smuggle new badges into
// the gallery (spend/identity style allowlist, mirrored in worker docs).
export const WORKER_PROVENANCE_ALLOW = new Set([
  "sam-3.1",
  "plate-median",
  "plate-migan",
  "plate-inpaint",
  "depth-anything-v2-small-onnx",
  "muse-image-1.0",
  "muse-spark-1.3",
  "birefnet-matte",
]);
const DEFAULT_PROVENANCE = ["sam-3.1", "muse-image-1.0", "muse-spark-1.3"];

// Merge worker-sent provenance for the result row: allowlisted tokens only,
// order preserved, capped. Anything else (missing, non-array, empty after
// filtering) falls back to the legacy default, byte-identical.
export function mergeWorkerProvenance(sent) {
  if (!Array.isArray(sent)) return DEFAULT_PROVENANCE.slice();
  const keep = [...new Set(sent.filter((s) => typeof s === "string" && WORKER_PROVENANCE_ALLOW.has(s)))].slice(0, 8);
  return keep.length ? keep : DEFAULT_PROVENANCE.slice();
}
