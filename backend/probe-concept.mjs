import fs from "node:fs";
import sharp from "sharp";
import { detectObjects } from "./lib/detect.js";

const buf = fs.readFileSync(process.argv[2]);
const png = await sharp(buf).png().toBuffer();
const meta = await sharp(buf).metadata();
const concepts = process.argv.slice(3);
for (const c of concepts) {
  try {
    const r = await detectObjects(png, meta.width, meta.height, [c], []);
    console.log(
      JSON.stringify(c), "->",
      r.objects.map((o) => `${o.label}:${((o.box.right - o.box.left) * (o.box.bottom - o.box.top)).toFixed(3)}`).join(" ") || "(none)"
    );
  } catch (e) {
    console.log(JSON.stringify(c), "ERR", e.message.slice(0, 160));
  }
}
