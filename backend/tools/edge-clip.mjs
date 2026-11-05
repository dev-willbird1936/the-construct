// Adds the edge-strip pass (backend/lib/edges.js) to a work folder already tracked by track-clip.mjs.
//   node backend/tools/edge-clip.mjs <video> <concept> <work>
import path from "node:path";
import fs from "node:fs";
import { trackEdges } from "../lib/edges.js";

const [video, concept, work] = process.argv.slice(2);
const tracked = JSON.parse(fs.readFileSync(path.join(work, "tracks.json"), "utf8"));
const added = await trackEdges({ videoPath: path.resolve(video), concept, outDir: path.resolve(work), tracked, seconds: tracked.samples / tracked.fps });
console.log(JSON.stringify({ added }));
