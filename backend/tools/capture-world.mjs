// Renders a baked world the way a visitor sees it, to files an agent (or a person) can rate.
//   node backend/tools/capture-world.mjs <clip name> <out dir> [--video]
// Writes, in <out dir>: sheet.jpg (6 moments x 3 views: through the lens, orbit left, orbit right),
// view_<moment>_<view>.png, and with --video orbit.mp4 (an 8 s orbit sweep through the clip's busiest moment).
// Needs the static server on :4180 (python serve.py 4180). Prints a JSON line of measured render facts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const [name, out, ...flags] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const base = process.env.SITE || "http://127.0.0.1:4180";
const exe = path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe");

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
await page.goto(`${base}/stable.html?clip=${name}&embed=1&source=1`);
await page.waitForFunction(() => window.__stable && window.__stable.meta, null, { timeout: 120000 });
await page.waitForTimeout(8000);

const meta = await page.evaluate(() => ({ duration: window.__stable.meta.times.at(-1), tracks: window.__stable.meta.tracks, shells: window.__stable.shells.length }));
// moments: spread through the clip, plus the busiest (most shells alive) as the video's centre
const moments = [0.08, 0.25, 0.42, 0.58, 0.75, 0.92].map((f) => +(f * meta.duration).toFixed(2));
const looks = { lens: [0, 0, true], left: [-1, 0.3, false], right: [1, 0.3, false] };

async function settle(t, look, lens) {
  await page.evaluate(async ([t, look, lens]) => {
    const s = window.__stable;
    s.setPlaying(false);
    s.setMode(lens ? "recorded" : "orbit");
    s.seek(t);
    if (!lens) s.setLook(look[0], look[1]);
    for (let k = 0; k < 14; k++) { s.frame(true); await new Promise((r) => setTimeout(r, 60)); }
  }, [t, look, lens]);
}

const files = [];
for (const t of moments) {
  for (const [view, [x, y, lens]] of Object.entries(looks)) {
    await settle(t, [x, y], lens);
    const file = path.join(out, `view_${String(Math.round(t)).padStart(3, "0")}_${view}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
}
// through-lens fidelity: the lens view against the footage itself on the picture's top third (sky, trees,
// far shore: static, animal-free) - registration and colour in one number, in dB
const clipUrl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "assets", "stable", name, "stable.json"), "utf8")).clip;
const psnrs = [];
for (const t of moments) {
  const lens = path.join(out, `view_${String(Math.round(t)).padStart(3, "0")}_lens.png`);
  const run = spawnSync("ffmpeg", ["-v", "info", "-ss", String(t), "-i", path.join(process.cwd(), clipUrl), "-i", lens, "-frames:v", "1", "-lavfi",
    "[0:v]scale=1280:720,crop=1280:216:0:0[a];[1:v]scale=1280:720,crop=1280:216:0:0[b];[a][b]psnr", "-f", "null", "-"], { encoding: "utf8" });
  const m = /average:([\d.]+)/.exec(run.stderr || "");
  if (m) psnrs.push(+m[1]);
}
// sheet: rows = moments, columns = views
const args = files.flatMap((f) => ["-i", f]);
execFileSync("ffmpeg", ["-y", "-v", "error", ...args, "-filter_complex", `${files.map((_, i) => `[${i}:v]scale=640:360[v${i}]`).join(";")};${files.map((_, i) => `[v${i}]`).join("")}xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % 3) * 640}_${Math.floor(i / 3) * 360}`).join("|")}[o]`, "-map", "[o]", "-q:v", "3", path.join(out, "sheet.jpg")]);

if (flags.includes("--video")) {
  const frames = path.join(out, "frames");
  fs.mkdirSync(frames, { recursive: true });
  const centre = meta.duration * 0.5;
  const n = 80;
  for (let k = 0; k < n; k++) {
    const t = Math.max(0, Math.min(meta.duration - 0.1, centre - 4 + (8 * k) / n));
    const look = Math.sin((k / n) * Math.PI * 2);
    await page.evaluate(async ([t, look]) => {
      const s = window.__stable;
      s.setPlaying(false); s.setMode("orbit"); s.seek(t); s.setLook(look, 0.3);
      for (let j = 0; j < 4; j++) { s.frame(true); await new Promise((r) => setTimeout(r, 40)); }
    }, [t, look]);
    await page.screenshot({ path: path.join(frames, `f${String(k).padStart(3, "0")}.png`) });
  }
  execFileSync("ffmpeg", ["-y", "-v", "error", "-framerate", "10", "-i", path.join(frames, "f%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", path.join(out, "orbit.mp4")]);
}
await browser.close();
console.log(JSON.stringify({ name, ...meta, tracks: meta.tracks.length, lensPsnrDb: psnrs.length ? +(psnrs.reduce((a, b) => a + b, 0) / psnrs.length).toFixed(1) : null, errors: [...new Set(errors)] }));
