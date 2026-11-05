// Tracks every instance of a concept through a clip (backend/lib/track.js).
//   node backend/tools/track-clip.mjs <video> <concept> <outDir> [--start s] [--seconds s] [--chunk s]
// Costs one SAM 3.1 pass per chunk.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { trackInstances } from "../lib/track.js";

const args = process.argv.slice(2);
const [video, concept, outArg] = args;
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(args[i + 1]);
};
if (!video || !concept || !outArg) {
  console.error("usage: track-clip.mjs <video> <concept> <outDir> [--start s] [--seconds s] [--chunk s]");
  process.exit(1);
}
const probe = JSON.parse(execFileSync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", video]).toString());
const { width, height } = probe.streams[0];
const result = await trackInstances({
  videoPath: path.resolve(video), concept, outDir: path.resolve(outArg), width, height,
  duration: Number(probe.format.duration), start: flag("start", 0), seconds: flag("seconds", undefined), chunkSeconds: flag("chunk", 15),
});
console.log(JSON.stringify({ tracks: result.tracks, samples: result.samples }));
