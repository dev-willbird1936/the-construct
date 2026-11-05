// App-local mailer for build emails (the gate sends sign-in codes itself).
//   MAIL_MODE=console -> log the send (local dev, default)
//   MAIL_MODE=resend  -> POST https://api.resend.com/emails (key from RESEND_API_KEY, sender from MAIL_FROM)
// Never logs the key, the recipient in full or message bodies.
//
// Build emails carry the build's own thumbnail as an inline (cid:) attachment, so no image URL is ever made public:
// the picture travels inside the message to the build's owner and nowhere else.
import fs from "node:fs";
import path from "node:path";
import { C, MONO, SANS, button, esc, facts, heading, kicker, layout, oneLine, p } from "./mail-layout.js";

const maskEmail = (email) => String(email).replace(/^(.).*(@.*)$/, "$1***$2");

export async function sendMail({ to, subject, html, text, attachments }) {
  const mode = process.env.MAIL_MODE || "console";
  if (!to) return;
  if (mode === "resend") {
    const key = process.env.RESEND_API_KEY || "";
    if (!key) throw new Error("MAIL_MODE=resend but RESEND_API_KEY is not set.");
    const from = process.env.MAIL_FROM || "The Construct <noreply@localhost>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, ...(text ? { text } : {}), ...(attachments?.length ? { attachments } : {}) }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Resend failed with status ${res.status}.`);
    return;
  }
  console.log(`[mail:console] to=${maskEmail(to)} subject=${subject}${attachments?.length ? ` inline=${attachments.length}` : ""}`);
}

// What each tier makes, in the words the site uses.
export const TIER_WORK = {
  lite: {
    name: "Lite", noun: "ghost trail",
    made: (s) => `Lite cut the ${s} out of every frame and stacked the poses into a ghost trail: the newest pose solid, the older ones fading behind it. Scrub through time or turn it around in the viewer.`,
  },
  basic: {
    name: "Basic", noun: "cloud trail",
    made: (s) => `Basic gave the ${s} depth and laid its movement out as a cloud trail in front of the scene, so you can orbit around the whole path.`,
  },
  advanced: {
    name: "Advanced", noun: "world",
    made: (s) => `Advanced rebuilt the scene around the ${s} as a world you can step into, with its path through time running through it.`,
  },
};
const tierOf = (tier) => TIER_WORK[tier] || { name: "Your", noun: "build", made: (s) => `Your build of the ${s} is finished.` };

const GENERIC = /^(subject|object|objects|thing|clip|your clip|)$/i;
/** "black cat" from the result or job; empty when the label says nothing. */
export function subjectOf(...labels) {
  for (const label of labels) {
    const s = oneLine(label, 40).toLowerCase().replace(/[^\p{L}\p{N} '\-,]/gu, "").trim();
    if (s && !GENERIC.test(s)) return s;
  }
  return "";
}

export function siteBase(env = process.env) {
  const base = String(env.BASE_URL || env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+$/i.test(base) ? base : "https://www.thefourthtesseract.com";
}

/** Absolute link to a viewer path the server itself produced (never a worker string the gate did not vet). */
function viewerUrl(base, viewer, job) {
  const v = String(viewer || "");
  if (/^(stable|view-basic|view-lite|lite|basic-cloud)\.html\?[A-Za-z0-9_=&.-]{1,160}$/.test(v)) return `${base}/${v}`;
  return job?.tier === "advanced" && job?.id ? `${base}/stable.html?specimen=${encodeURIComponent(job.id)}` : `${base}/`;
}

/** The build's own thumbnail as a small JPEG, read only from inside that build's specimen folder. */
export async function thumbAttachment({ dataDir, job, result }) {
  try {
    const rel = String(result?.thumb || "");
    const id = String(job?.id || result?.id || "");
    if (!dataDir || !id || !/^[A-Za-z0-9-]{8,80}$/.test(id)) return null;
    if (!new RegExp(`^specimens/${id}/[A-Za-z0-9_./-]{1,100}\\.(webp|jpe?g|png)$`, "i").test(rel) || rel.includes("..")) return null;
    const root = path.resolve(dataDir, "specimens", id);
    const file = path.resolve(dataDir, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return null;
    const { default: sharp } = await import("sharp");
    let quality = 80;
    let jpeg = await sharp(file).rotate().resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true }).flatten({ background: C.page }).jpeg({ quality, mozjpeg: true }).toBuffer();
    while (jpeg.length > 350_000 && quality > 40) {
      quality -= 15;
      jpeg = await sharp(file).resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true }).flatten({ background: C.page }).jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    if (jpeg.length > 450_000) return null;
    return { filename: "build-preview.jpg", content: jpeg.toString("base64"), content_type: "image/jpeg", content_id: "build-preview" };
  } catch {
    return null; // a missing or unreadable thumbnail never blocks the email
  }
}

const footerFor = (base, email) =>
  `Sent to ${esc(email || "you")} because you started this build on <a href="${esc(base)}/" style="color:${C.dim}">The Construct</a>. Builds stay private until you publish them.`;

export async function jobDoneMail({ job, result, dataDir, env = process.env }) {
  const base = siteBase(env);
  const tier = tierOf(result?.tier || job?.tier);
  const s = subjectOf(result?.subject, job?.subject);
  const thing = s ? `${s} ${tier.noun}` : tier.noun;
  const subject = oneLine(`Your ${thing} is ready`, 120);
  const link = viewerUrl(base, result?.viewer, job);
  const thumb = await thumbAttachment({ dataDir, job, result });
  const secs = Number(result?.durationSec) || 0;
  const rows = [["Tier", `${tier.name} · ${tier.noun}`], ...(s ? [["Subject", s]] : []), ...(secs > 0 ? [["Clip", `${secs.toFixed(secs < 10 ? 1 : 0)} s`]] : [])];
  const picture = thumb
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px"><tr><td bgcolor="#000000" style="background:#000;border:1px solid ${C.line};padding:0">
<a href="${esc(link)}" target="_blank" style="text-decoration:none"><img src="cid:${thumb.content_id}" width="498" alt="Your ${esc(thing)}" style="display:block;width:100%;max-width:498px;height:auto;border:0;color:${C.dim};font:13px ${SANS}"></a>
</td></tr><tr><td style="padding:8px 0 0;font:600 10px/1.4 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:${C.dim}">Fig. 1 &mdash; ${esc(s || "your subject")}, from your clip</td></tr></table>`
    : "";
  const html = layout({
    title: subject,
    preheader: `Your ${thing} is built and waiting. One click opens it in the viewer.`,
    body: `${kicker(`Build ready · ${tier.name}`)}${heading(subject)}
${p(esc(tier.made(s || "subject")))}
${picture}
${button(link, `Open your ${tier.noun}`)}
${facts(rows)}
${p(`Only you can see it. To share it with other visitors, choose <b style="color:${C.ink}">Publish to the construct</b> in the studio; the owner approves each build first.`, `font-size:13px;color:${C.dim};margin:0`)}`,
    footer: footerFor(base, job?.email),
  });
  const text = [
    `THE CONSTRUCT — BUILD READY (${tier.name.toUpperCase()})`,
    "",
    `${subject}.`,
    "",
    tier.made(s || "subject"),
    "",
    `Open your ${tier.noun}: ${link}`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Only you can see it. To share it with other visitors, choose Publish to the construct in the studio; the owner approves each build first.",
    "",
    `Sent to ${job?.email || "you"} because you started this build on The Construct (${base}/).`,
  ].join("\n");
  return { to: job?.email, subject, html, text, ...(thumb ? { attachments: [thumb] } : {}) };
}

// Plain next steps for a stopped build, matched on the (already user-safe) reason text.
function nextSteps(reason, tierKey, s) {
  const it = s || "subject";
  const r = String(reason || "");
  if (/limit|budget|tomorrow/i.test(r)) return ["Come back tomorrow: the daily build allowance resets at midnight UTC.", "Your sign-in and earlier builds are unaffected."];
  if (/busy|unavailable|Meta'?s model/i.test(r)) return ["Wait a few minutes and build again. Nothing is wrong with your clip.", "If it stops again, try a shorter clip."];
  if (/camera|viewpoint|moving/i.test(r)) return ["Use a clip from a steady camera: a tripod, a trail camera or a phone held still.", `Pick a stretch where the ${it} moves and the background does not.`];
  if (/too long|length|seconds|shorter/i.test(r)) return [`Trim the clip to the few seconds where the ${it} moves.`, "Then pick it again and build."];
  if (/close|fills|ghost/i.test(r)) return [`Pick a clip where the ${it} is smaller in the frame and moves across it.`, "Wide shots work better than close-ups."];
  if (/match|selection|select|pick|expired|frame|seed|object|concept/i.test(r))
    return [`Scrub to a frame where the ${it} is clear and whole, not cut off by the edge.`, `Draw the box tight around the ${it} only, then build again.`, ...(tierKey === "advanced" ? ["Pick one kind of subject per build."] : [])];
  if (/subject|follow/i.test(r)) return [`Pick a clip where one ${it} stays in view and is not hidden behind anything.`, "Scrub to a clear frame and pick it again."];
  return ["Try another frame, or a shorter clip with one clear subject.", ...(tierKey !== "lite" ? ["Lite is the quickest tier and works on the widest range of clips."] : ["Try again in a few minutes."])];
}

export async function jobFailedMail({ job, reason, env = process.env }) {
  const base = siteBase(env);
  const tierKey = job?.tier;
  const tier = tierOf(tierKey);
  const s = subjectOf(job?.subject);
  const thing = s ? `${s} ${tier.noun}` : tier.noun;
  const subject = oneLine(`Your ${thing} could not be built`, 120);
  const why = oneLine(reason || "The build stopped before it finished.", 400);
  const steps = nextSteps(why, tierKey, s);
  const html = layout({
    title: subject,
    preheader: `${why} Here is what to try next.`,
    body: `${kicker(`Build stopped · ${tier.name}`)}${heading(subject)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px"><tr>
<td style="border-left:3px solid ${C.amber};background:#11131f;padding:14px 16px" bgcolor="#11131f">
<p style="margin:0 0 6px;font:600 10px/1.4 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:${C.dim}">What happened</p>
<p style="margin:0;font:15px/1.55 ${SANS};color:${C.ink}">${esc(why)}</p></td></tr></table>
<p style="margin:0 0 10px;font:600 11px/1.4 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:${C.amber}">What to try next</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
${steps.map((t, i) => `<tr><td style="width:28px;vertical-align:top;padding:0 0 10px;font:700 13px/1.55 ${MONO};color:${C.amber}">0${i + 1}</td><td style="vertical-align:top;padding:0 0 10px;font:15px/1.55 ${SANS};color:${C.body}">${esc(t)}</td></tr>`).join("")}
</table>
${button(`${base}/`, "Try again in the studio")}
${p("Nothing was published, and your other builds are untouched.", `font-size:13px;color:${C.dim};margin:0`)}`,
    footer: `Sent to ${esc(job?.email || "you")} because you started this build on <a href="${esc(base)}/" style="color:${C.dim}">The Construct</a>.`,
  });
  const text = [
    `THE CONSTRUCT — BUILD STOPPED (${tier.name.toUpperCase()})`,
    "",
    `${subject}.`,
    "",
    `What happened: ${why}`,
    "",
    "What to try next:",
    ...steps.map((t, i) => `${i + 1}. ${t}`),
    "",
    `Try again in the studio: ${base}/`,
    "",
    "Nothing was published, and your other builds are untouched.",
  ].join("\n");
  return { to: job?.email, subject, html, text };
}

/** Fire-and-forget helpers for the call sites: a mail problem never changes a job's outcome. */
export async function notifyJobDone({ job, result, dataDir }) {
  if (!job?.email) return;
  try { await sendMail(await jobDoneMail({ job, result, dataDir })); }
  catch (error) { console.warn(`[mail] ready mail for ${job.id} not sent: ${String(error?.message || error).slice(0, 120)}`); }
}

export async function notifyJobFailed({ job, reason }) {
  if (!job?.email) return;
  try { await sendMail(await jobFailedMail({ job, reason })); }
  catch (error) { console.warn(`[mail] failure mail for ${job.id} not sent: ${String(error?.message || error).slice(0, 120)}`); }
}
