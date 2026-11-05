// Outbound mail: Resend over fetch in production, a captured outbox in development/tests.
// Production never prints message bodies (they contain sign-in codes).
import { C, MONO, button, esc, heading, kicker, layout, p } from "../mail-layout.js";

export const outbox = [];

/** The sign-in code email. The plain-text part keeps its wording (tests and mail filters read it). */
export function codeMessage({ code, link }) {
  const text = `Your sign-in code for The Construct is ${code}\n\nIt works once and expires in 15 minutes.\nOr open this link on the device you want to sign in: ${link}\n\nIf you did not ask for this, ignore this email.`;
  const html = layout({
    title: `Your sign-in code: ${code}`,
    preheader: `${code} is your code. It works once and expires in 15 minutes.`,
    body: `${kicker("Sign-in code")}${heading("Your code for The Construct")}
${p("Type this code on the sign-in page. It works once and expires in 15 minutes.")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px"><tr>
<td align="center" bgcolor="#070914" style="background:#070914;border:1px solid ${C.amber};padding:18px 10px">
<span style="font:700 32px/1 ${MONO};letter-spacing:.32em;color:${C.ink};padding-left:.32em">${esc(code)}</span></td></tr></table>
${p("Or sign in with one click on the device you want to use:", "margin-bottom:10px")}
${button(link, "Sign in on this device")}
${p("If you did not ask for this, ignore this email. Nobody can sign in without the code.", `font-size:13px;color:${C.dim};margin:0`)}`,
    footer: "The Construct &middot; thefourthtesseract.com",
  });
  return { text, html };
}

export const maskEmail = (email) => String(email).replace(/^(.).*(@.*)$/, "$1***$2");

/** True when mail can really be delivered (or captured in a non-production process). */
export function mailAvailable(env = process.env) {
  if (env.RESEND_API_KEY && env.MAIL_FROM) return true;
  return env.NODE_ENV !== "production" && (env.MAIL_MODE || "console") === "console";
}

export async function sendMail({ to, subject, text, html }, env = process.env, fetchImpl = fetch) {
  if (env.RESEND_API_KEY && env.MAIL_FROM && env.MAIL_MODE !== "console") {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, html }),
    });
    if (!response.ok) throw new Error(`Resend rejected the message (HTTP ${response.status})`);
    return { delivered: true };
  }
  if (env.NODE_ENV === "production") throw new Error("mail is not configured (RESEND_API_KEY and MAIL_FROM)");
  outbox.push({ to, subject, text, html, at: Date.now() });
  console.log(`[mail:console] to=${maskEmail(to)} subject=${subject}`);
  return { delivered: false, captured: true };
}
