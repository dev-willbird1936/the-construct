// Shared look for every email the site sends (build ready, build stopped, sign-in code): the construct's dark
// panel, amber accents and monospace headings. Table layout with inline styles, because mail clients drop most CSS.
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const C = { page: "#04050a", panel: "#0a0c16", line: "#2a2d3a", amber: "#d9a441", ink: "#f4efe2", body: "#c4bfb1", dim: "#8d897d", faint: "#6c6a62" };
export const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono','Courier New',monospace";
export const SANS = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Header-safe single line (no CR/LF or control characters), trimmed to `max` characters. */
export const oneLine = (s, max = 120) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const p = (html, extra = "") =>
  `<p style="margin:0 0 16px;font:15px/1.6 ${SANS};color:${C.body};${extra}">${html}</p>`;

export const kicker = (text) =>
  `<p style="margin:0 0 10px;font:600 11px/1.4 ${MONO};letter-spacing:.22em;text-transform:uppercase;color:${C.amber}">${esc(text)}</p>`;

export const heading = (text) =>
  `<h1 class="h1" style="margin:0 0 14px;font:700 24px/1.3 ${MONO};letter-spacing:-.01em;color:${C.ink}">${esc(text)}</h1>`;

/** One obvious call to action: a full-width amber block that survives clients without CSS support. */
export const button = (href, label) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 14px"><tr>
<td align="center" bgcolor="${C.amber}" style="background:${C.amber};border-radius:3px">
<a href="${esc(href)}" target="_blank" style="display:block;padding:15px 18px;font:700 14px/1.2 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:#120d02;text-decoration:none;border-radius:3px">${esc(label)}&nbsp;&rarr;</a>
</td></tr></table>`;

/** Label / value rows in the style of a specimen card. */
export const facts = (rows) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-top:1px solid ${C.line}">
${rows.map(([k, v]) => `<tr><td style="padding:9px 0;border-bottom:1px solid ${C.line};font:600 11px/1.4 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:${C.dim};width:34%;vertical-align:top">${esc(k)}</td><td style="padding:9px 0;border-bottom:1px solid ${C.line};font:14px/1.4 ${MONO};color:${C.ink};vertical-align:top">${esc(v)}</td></tr>`).join("")}
</table>`;

export function layout({ title, preheader, body, footer }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(title)}</title>
<style>
body{margin:0;padding:0;background:${C.page}}
a{color:${C.amber}}
@media (max-width:600px){.outer{padding:18px 10px!important}.card{padding:24px 18px!important}.h1{font-size:21px!important}}
</style></head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.page}">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td class="outer" align="center" style="padding:32px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 2px 14px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="width:14px;height:14px;border:2px solid ${C.amber};font-size:0;line-height:0">&nbsp;</td>
<td style="padding-left:10px;font:700 12px/1 ${MONO};letter-spacing:.3em;text-transform:uppercase;color:${C.amber}">The Construct</td>
</tr></table></td></tr>
<tr><td class="card" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.line};border-top:2px solid ${C.amber};padding:30px 30px 24px">
${body}
</td></tr>
<tr><td style="padding:16px 4px 0;font:12px/1.6 ${SANS};color:${C.faint}">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}
