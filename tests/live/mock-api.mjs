// A stand-in for backend/server.js's /api/live routes that replays a recorded run (tests/live/record.mjs),
// so live.html can be exercised with no Meta key, no GPU and no spend. Everything it sends was produced by
// the real hooks and the real Python stages over a clip we already hold labels for; only the timing is made up.
//
//   node tests/live/mock-api.mjs <fixture dir> <clip> [port=8100]
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const [fixtureArg, clipArg, portArg] = process.argv.slice(2);
const fixture = path.resolve(fixtureArg), clip = path.resolve(clipArg), port = Number(portArg || 8100);
const events = { detect: JSON.parse(fs.readFileSync(path.join(fixture, "detect-events.json"), "utf8")), build: JSON.parse(fs.readFileSync(path.join(fixture, "build-events.json"), "utf8")) };
const SPEED = Number(process.env.SPEED || 1);
const GAP = { cut: 18, "track-progress": 0, "ghost-progress": 0, shell: 22, water: 90, concept: 500, names: 700, default: 250 };
const runs = new Map();
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s ? JSON.parse(s) : {})); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST" }); return res.end(); }
  if (url.pathname === "/api/upload") { req.resume(); return req.on("end", () => send(res, 200, { jobId: "mock", width: 1280, height: 720, fps: 30, frameCount: 606, duration: 20.2 })); }
  if (url.pathname === "/api/live/prepare") return send(res, 200, { previewUrl: "/api/jobs/mock/preview.mp4", width: 1280, height: 720, fps: 30, frameCount: 606, duration: 20.2, camera: { fixed: true, stabilizable: false, shift: 0.4, overlay: 0.9, crop: null }, supported: true, reason: null });
  if (url.pathname === "/api/live/detect" || url.pathname === "/api/live/build") {
    await body(req);
    const kind = url.pathname.endsWith("detect") ? "detect" : "build";
    const id = `r${runs.size.toString(16).padStart(10, "0")}`;
    runs.set(id, kind);
    return send(res, 200, { runId: id });
  }
  const m = url.pathname.match(/^\/api\/live\/(r[0-9a-f]{10})\/events$/);
  if (m) {
    const list = events[runs.get(m[1])];
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    let i = Number(url.searchParams.get("from") || 0), closed = false;
    req.on("close", () => { closed = true; });
    const step = () => {
      if (closed) return;
      if (i >= list.length) { res.write("event: end\ndata: {}\n\n"); return res.end(); }
      const e = list[i++];
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      setTimeout(step, (GAP[e.type] ?? GAP.default) / SPEED);
    };
    return step();
  }
  if (url.pathname === "/stable.html") { res.writeHead(302, { Location: `http://127.0.0.1:8017${url.pathname}${url.search}` }); return res.end(); }
  const liveFile = url.pathname.match(/^\/api\/live\/(r[0-9a-f]{10})\/files\/(.+)$/);
  if (liveFile && runs.get(liveFile[1]) === "build") {
    const root = path.join(fixture, "live-build"), file = path.resolve(root, decodeURIComponent(liveFile[2]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: "no such file" });
    return serve(req, res, file, { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" }[path.extname(file)] ?? "application/octet-stream");
  }
  if (url.pathname === "/api/jobs/mock/preview.mp4") return serve(req, res, clip, "video/mp4");
  const f = url.pathname.match(/^\/api\/jobs\/mock\/(.+)$/);
  if (f) {
    const file = path.join(fixture, decodeURIComponent(f[1]));
    if (!file.startsWith(fixture) || !fs.existsSync(file)) return send(res, 404, { error: "no such file" });
    return serve(req, res, file, { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" }[path.extname(file)] ?? "application/octet-stream");
  }
  send(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => console.log(`mock live API on http://127.0.0.1:${port}`));

function serve(req, res, file, type) {
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  fs.createReadStream(file).pipe(res);
}
