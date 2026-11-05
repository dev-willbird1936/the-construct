// Fetches the Depth Anything V2 Small ONNX weights into MODELS_DIR.
// Licence: Apache-2.0 (base: depth-anything/Depth-Anything-V2-Small, ONNX export:
// onnx-community/depth-anything-v2-small). NOT Base/Large (CC BY-NC) — this
// script refuses any other model id unless BASIC_MODEL_ID is set explicitly.
//
// Usage: node backend/pipeline/basic/fetch-models.mjs [--check]
//   --check: verify the files exist and the licence tag, do not download.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODELS_DIR =
  process.env.MODELS_DIR || path.join(here, "models");
const MODEL_ID =
  process.env.BASIC_MODEL_ID || "onnx-community/depth-anything-v2-small";
const MODEL_FILE = process.env.BASIC_MODEL_FILE || "onnx/model.onnx";
const EXPECTED_LICENSE = "apache-2.0";

if (
  !process.env.BASIC_MODEL_ID &&
  !MODEL_ID.toLowerCase().includes("v2-small")
) {
  throw new Error(`refusing unexpected model ${MODEL_ID}`);
}

const dest = path.join(MODELS_DIR, "depth-anything-v2-small.onnx");
const metaDest = path.join(MODELS_DIR, "depth-anything-v2-small.meta.json");

async function checkLicense() {
  const res = await fetch(`https://huggingface.co/api/models/${MODEL_ID}`);
  if (!res.ok) throw new Error(`model card fetch failed: HTTP ${res.status}`);
  const card = await res.json();
  const tags = card.tags || [];
  const license = card.cardData?.license || tags.find((t) => t.startsWith("license:"))?.slice(8);
  return { license, sha: card.sha };
}

async function download(url, out) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.part`;
  const file = fs.createWriteStream(tmp);
  let bytes = 0;
  for await (const chunk of res.body) {
    file.write(chunk);
    bytes += chunk.length;
  }
  await new Promise((resolve, reject) => {
    file.on("finish", resolve);
    file.on("error", reject);
    file.end();
  });
  await fsp.rename(tmp, out);
  return bytes;
}

const onlyCheck = process.argv.includes("--check");
const { license, sha } = await checkLicense();
console.log(`model: ${MODEL_ID} licence=${license} sha=${sha}`);
if (license !== EXPECTED_LICENSE) {
  throw new Error(`licence mismatch: expected ${EXPECTED_LICENSE}, got ${license}`);
}
if (onlyCheck) {
  console.log(fs.existsSync(dest) ? `present: ${dest}` : `missing: ${dest}`);
  process.exit(fs.existsSync(dest) ? 0 : 2);
}
if (fs.existsSync(dest) && fs.existsSync(metaDest)) {
  try {
    const meta = JSON.parse(await fsp.readFile(metaDest, "utf8"));
    if (meta.sha === sha && meta.bytes === fs.statSync(dest).size) {
      console.log(`up to date: ${dest}`);
      process.exit(0);
    }
  } catch { /* re-download */ }
}
console.log(`downloading ${MODEL_ID}/${MODEL_FILE} …`);
const bytes = await download(
  `https://huggingface.co/${MODEL_ID}/resolve/main/${MODEL_FILE}`,
  dest
);
await fsp.writeFile(metaDest, JSON.stringify({ id: MODEL_ID, file: MODEL_FILE, license, sha, bytes }));
console.log(`wrote ${dest} (${(bytes / 1048576).toFixed(1)} MB)`);
