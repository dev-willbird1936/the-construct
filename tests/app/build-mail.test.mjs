// Build emails (backend/app/mailer.js): wording per tier, absolute links, inline thumbnail only from the build's own folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { jobDoneMail, jobFailedMail, siteBase, subjectOf } from "../../backend/app/mailer.js";

const sharp = createRequire(new URL("../../backend/package.json", import.meta.url))("sharp");
const ENV = { BASE_URL: "https://www.thefourthtesseract.com" };
const ID = "0f2a6c1e-1111-4222-8333-444455556666";

async function dataDirWithThumb() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-"));
  const dir = path.join(dataDir, "specimens", ID);
  fs.mkdirSync(dir, { recursive: true });
  await sharp({ create: { width: 64, height: 36, channels: 3, background: "#335533" } }).webp().toFile(path.join(dir, "thumb.webp"));
  fs.writeFileSync(path.join(dataDir, "secret.webp"), "not yours");
  return dataDir;
}

test("ready mail: tier wording, absolute viewer link, inline thumbnail, text part", async () => {
  const dataDir = await dataDirWithThumb();
  const mail = await jobDoneMail({
    dataDir, env: ENV,
    job: { id: ID, tier: "lite", email: "a@example.com", subject: "cat" },
    result: { tier: "lite", subject: "Black Cat", viewer: `view-lite.html?id=${ID}`, thumb: `specimens/${ID}/thumb.webp`, durationSec: 7.3 },
  });
  assert.equal(mail.to, "a@example.com");
  assert.equal(mail.subject, "Your black cat ghost trail is ready");
  assert.ok(mail.html.includes(`href="https://www.thefourthtesseract.com/view-lite.html?id=${ID}"`));
  assert.ok(mail.text.includes(`https://www.thefourthtesseract.com/view-lite.html?id=${ID}`));
  assert.ok(!/href="(?!https:)/.test(mail.html), "every link is absolute");
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].content_type, "image/jpeg");
  assert.ok(mail.html.includes(`cid:${mail.attachments[0].content_id}`));
  assert.ok(Buffer.from(mail.attachments[0].content, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
  for (const [tier, noun] of [["basic", "cloud trail"], ["advanced", "world"]]) {
    const m = await jobDoneMail({ env: ENV, job: { id: ID, tier, email: "a@example.com" }, result: { tier, subject: "roe deer" } });
    assert.equal(m.subject, `Your roe deer ${noun} is ready`);
  }
});

test("ready mail: a thumbnail outside the build's own folder or a foreign viewer string is never used", async () => {
  const dataDir = await dataDirWithThumb();
  for (const thumb of ["secret.webp", `specimens/${ID}/../../secret.webp`, "specimens/other-id-1234/thumb.webp", "/etc/passwd"]) {
    const m = await jobDoneMail({ dataDir, env: ENV, job: { id: ID, tier: "lite", email: "a@example.com" }, result: { tier: "lite", thumb, viewer: "https://evil.example/x" } });
    assert.equal(m.attachments, undefined, thumb);
    assert.ok(!m.html.includes("evil.example"));
  }
});

test("ready mail: subject is one header-safe line and the HTML is escaped", async () => {
  const m = await jobDoneMail({ env: ENV, job: { id: ID, tier: "advanced", email: "a@example.com" }, result: { tier: "advanced", subject: "fox\r\nBcc: x@evil.example <b>" } });
  assert.ok(!/[\r\n]/.test(m.subject));
  assert.ok(!m.html.includes("<b>"));
  assert.equal(subjectOf("subject", ""), "");
  assert.equal((await jobDoneMail({ env: ENV, job: { id: ID, tier: "lite", email: "a@example.com" }, result: { tier: "lite", subject: "subject" } })).subject, "Your ghost trail is ready");
});

test("stopped mail: plain reason, next steps, a way back", async () => {
  const m = await jobFailedMail({ env: ENV, job: { id: ID, tier: "advanced", email: "a@example.com", subject: "grey squirrel" }, reason: "We could not build a scene from this clip's camera movement. Try another clip." });
  assert.equal(m.subject, "Your grey squirrel world could not be built");
  assert.ok(m.text.includes("What happened: We could not build a scene"));
  assert.match(m.text, /What to try next:\n1\. Use a clip from a steady camera/);
  assert.ok(m.html.includes('href="https://www.thefourthtesseract.com/"'));
});

test("site base comes from BASE_URL and falls back to the live site", () => {
  assert.equal(siteBase({ BASE_URL: "http://127.0.0.1:4411/" }), "http://127.0.0.1:4411");
  assert.equal(siteBase({}), "https://www.thefourthtesseract.com");
  assert.equal(siteBase({ BASE_URL: "javascript:alert(1)" }), "https://www.thefourthtesseract.com");
});
