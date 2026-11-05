import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { client } from "../lib/meta.js";
import { extractFrame } from "../lib/ffmpeg.js";

// Muse Spark describes category, camera movement, subjects and quality risks.
// Classification is advisory: no content category blocks a build attempt.
// A Meta failure never blocks: it returns the permissive default.

export const SPARK_MODEL = "muse-spark-1.3";

export const PERMISSIVE_ROUTE = Object.freeze({
  category: "unknown",
  camera: "unknown",
  subjects: [],
  warnings: ["Automatic classification was unavailable; your clip was accepted without it."],
});

export function extractText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  const chunks = [];
  const outputs = Array.isArray(response.output) ? response.output : [];
  for (const item of outputs) {
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const part of contents) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }
  if (!response.output && Array.isArray(response.content)) {
    for (const part of response.content) if (typeof part?.text === "string") chunks.push(part.text);
  }
  return chunks.join("\n");
}

export function normalizeRoute(parsed) {
  const pick = (v, fallback) => (typeof v === "string" && v ? v : fallback);
  const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, 12) : []);
  const out = {
    category: pick(parsed?.category, "unknown"),
    camera: pick(parsed?.camera, "unknown"),
    subjects: list(parsed?.subjects),
    warnings: list(parsed?.warnings),
  };
  // Older model responses may still return a rejection. Keep it as advice.
  if (typeof parsed?.decline === "string" && parsed.decline) {
    out.warnings.push(`Automatic clip check: ${parsed.decline} This is advisory; you can still try this clip.`);
  }
  return out;
}

export async function classifyUpload({ upload, dataDir, timeoutMs = 60_000 }) {
  const mid = Math.floor(upload.frames / 2);
  const dir = path.join(dataDir, "uploads", upload.id);
  const still = path.join(dir, `route_${mid}.jpg`);
  try {
    await extractFrame(upload.path, mid, still);
    const jpeg = await sharp(still).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    const response = await Promise.race([
      client.responses.create({
        model: SPARK_MODEL,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "Classify this video frame for a 3D-visualisation pipeline. Reply with JSON only:",
                  '{"category": one of wildlife|pet|person|street-sport|product|drone|other|unknown,',
                  '"camera": one of fixed|handheld|drone|unknown,',
                  '"subjects": [short visible-subject labels, max 6],',
                  '"warnings": [brief quality risks, such as occlusion, tiny subjects, night noise or transparency]}.',
                  'All content categories are accepted, including CGI, animation, screen recordings, aerial footage, crowds, glass, liquid and steam.',
                  'Describe visible subjects even when they are synthetic. Never reject a clip or return a decline field.',
                  'Quality risks are advice only; do not say a clip is unsupported or cannot be processed.',
                ].join(" "),
              },
              { type: "input_image", image_url: dataUrl },
            ],
          },
        ],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("spark timeout")), timeoutMs)),
    ]);
    const text = extractText(response);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("spark returned no JSON");
    return normalizeRoute(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return { ...PERMISSIVE_ROUTE };
  } finally {
    await fs.rm(still, { force: true }).catch(() => {});
  }
}
