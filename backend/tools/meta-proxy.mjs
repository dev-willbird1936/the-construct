// Local credential-injecting proxy for the Meta Model API.
//
// Why: sub-agents run on a contributor-mode model whose context may be used for training. They must
// be able to call SAM / Muse Image / Muse Spark without ever holding the real API key. They point
// META_BASE_URL at this proxy (http://127.0.0.1:8787/v1) and send any dummy key; this process adds
// the real Authorization header and enforces daily caps so an autonomous loop cannot run up a bill.
//
// Run:  node backend/tools/meta-proxy.mjs        (reads META_API_KEY)
// Kill switch: create the file named by META_PROXY_STOP (default backend/jobs/meta-proxy.stop).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.META_PROXY_PORT || 8787);
const UPSTREAM = new URL(process.env.META_UPSTREAM || "https://api.meta.ai");
const STOP_FILE = process.env.META_PROXY_STOP || path.resolve(here, "..", "jobs", "meta-proxy.stop");
const LOG_FILE = process.env.META_PROXY_LOG || path.resolve(here, "..", "jobs", "meta-proxy-usage.jsonl");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const key = process.env.META_API_KEY?.trim();

// Daily request caps per category. Each category maps to a cost driver (see the Meta pricing page):
// images ~ $0.01 each, responses (SAM video/image, Spark) vary, files are free but bounded.
const CAPS = {
  images: Number(process.env.CAP_IMAGES || 400),
  responses: Number(process.env.CAP_RESPONSES || 3000),
  files: Number(process.env.CAP_FILES || 800),
  other: Number(process.env.CAP_OTHER || 5000),
};
const counts = { day: new Date().toISOString().slice(0, 10), images: 0, responses: 0, files: 0, other: 0 };
// Rebuild today's counts from the usage log so a restart does not reset the daily caps.
try {
  for (const line of fs.readFileSync(LOG_FILE, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.t?.slice(0, 10) === counts.day && row.method !== "GET" && row.cat in counts) counts[row.cat] += 1;
  }
} catch { /* no log yet */ }
const categoryOf = (p) => (p.includes("/images/") ? "images" : p.includes("/responses") || p.includes("/chat/") ? "responses" : p.includes("/files") ? "files" : "other");

const server = http.createServer((req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  if (counts.day !== today) Object.assign(counts, { day: today, images: 0, responses: 0, files: 0, other: 0 });
  if (fs.existsSync(STOP_FILE)) return fail(res, 503, "meta-proxy stopped by kill switch");
  if (req.url === "/_usage") return res.end(JSON.stringify({ counts, CAPS }));
  if (!req.url.startsWith("/v1/")) return fail(res, 404, "only /v1/* is proxied");
  const cat = categoryOf(req.url);
  if (req.method !== "GET" && counts[cat] >= CAPS[cat]) return fail(res, 429, `daily cap reached for ${cat} (${CAPS[cat]})`);
  if (req.method !== "GET") counts[cat] += 1;

  const headers = { ...req.headers, authorization: `Bearer ${key}`, host: UPSTREAM.host };
  delete headers["accept-encoding"]; // keep the stream uncompressed so it is forwarded byte for byte
  const upstream = https.request({ host: UPSTREAM.hostname, port: 443, path: req.url, method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
    up.on("end", () => log(req, cat, up.statusCode));
  });
  upstream.on("error", (error) => fail(res, 502, `upstream: ${error.message}`));
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});

function fail(res, status, message) {
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

function log(req, cat, status) {
  fs.appendFile(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), method: req.method, path: req.url.split("?")[0], cat, status }) + "\n", () => {});
}

server.listen(PORT, "127.0.0.1", () => console.log(`meta-proxy on http://127.0.0.1:${PORT}/v1 (caps ${JSON.stringify(CAPS)})`));
