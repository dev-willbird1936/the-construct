// End to end, no server: probe -> track -> bake, as /api/auto does. Usage: run-world.mjs <video> <concept> <name>
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWorld, probeClip } from "../lib/world.js";

const [video, concept, name] = process.argv.slice(2);
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [width, height, duration] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0:s=,", video])
  .toString().trim().split(/[,\n]/).map(Number);
const probe = await probeClip(path.resolve(video));
console.log("probe", JSON.stringify(probe));
if (!probe?.fixed && !probe?.stabilizable) throw new Error("not a fixed-camera clip");
const build = new Proxy({}, { set(o, k, v) { o[k] = v; if (k === "detail" || k === "stage") console.log(`[${o.stage}] ${o.detail ?? ""}`); return true; } });
const url = await buildWorld({
  build, concept, probe, name, site,
  job: { jobDir: `local-models/runs/${name}`, videoPath: path.resolve(video), width, height, duration },
  clipPath: path.join(site, "assets", "clips", "uploads"),
});
console.log("done", url);
