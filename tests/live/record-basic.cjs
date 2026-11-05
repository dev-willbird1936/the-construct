// Records a real Basic build and checks that its finished cloud viewer renders.
//   node tests/live/record-basic.cjs <clip> <out dir> [base=http://127.0.0.1:8013] [start seconds=5]
//
// Playwright comes from the globally installed promptfoo; the browser from ms-playwright.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const [clip, out, base = "http://127.0.0.1:8013", startArg = "5"] = process.argv.slice(2);
const { chromium } = require(path.join(process.env.APPDATA, "npm/node_modules/promptfoo/node_modules/playwright-core"));
const browser = path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe");

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ headless: true, executablePath: browser, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: out, size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
  const t0 = Date.now();
  const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

  await page.goto(base + "/");
  await page.waitForTimeout(4000);
  await page.getByText("Upload your clip").first().click();
  await page.waitForTimeout(2500);
  await page.locator("input[name=tier][value=basic]").check({ force: true });
  await page.waitForTimeout(1200);
  await page.locator("#rightsBox").check({ force: true });
  await page.setInputFiles("#videoInput", path.resolve(clip));
  await page.waitForSelector("#stepRoute:not(.is-hidden)", { timeout: 90000 });
  await page.waitForTimeout(2500);
  log("routed");
  await page.click("#routeGo", { timeout: 180000 }).catch(async (error) => { console.error("route:", await page.textContent("#routeCard")); throw error; });
  await page.waitForURL(/live\.html/, { timeout: 20000 });
  await page.waitForSelector("#card-frame:not([hidden])", { timeout: 120000 }).catch(async (error) => { console.error("live:", page.url(), await page.textContent("#fail"), errors); throw error; });
  await page.waitForTimeout(2500);
  // scrub to the start frame the way a visitor would: drag, then nudge a frame each way
  await page.evaluate((t) => { const s = document.querySelector("#time"); s.value = t; s.dispatchEvent(new Event("input")); }, startArg);
  await page.waitForTimeout(1500);
  await page.click("#fwd"); await page.waitForTimeout(500); await page.click("#back");
  await page.waitForTimeout(1500);
  await page.click("#useFrame");
  await page.waitForSelector("#objects li", { timeout: 120000 });
  log("subjects found");
  await page.waitForTimeout(3000);
  await page.waitForSelector("#dinoView:not([hidden])", { timeout: 90000 }).catch(() => {});
  for (const v of ["pca", "heat", "frame"]) { await page.click(`#dinoView button[data-v=${v}]`).catch(() => {}); await page.waitForTimeout(1800); }
  await page.waitForFunction(() => !document.querySelector("#build").disabled, null, { timeout: 30000 });
  await page.click("#build");
  log("building");
  await page.waitForSelector("#card-done:not([hidden])", { timeout: 40 * 60 * 1000 });
  log("done");
  const frame = page.frameLocator("#world");
  await frame.getByText(/scene points/).waitFor({ timeout: 60000 });
  if (await frame.locator("#fail").isVisible()) throw new Error(await frame.locator("#fail").textContent());
  await frame.locator("#view").screenshot({ path: path.join(out, "cloud.png") });
  const headline = await page.textContent("#headline");
  console.log(JSON.stringify({ errors, headline, viewer: await page.locator("#openWorld").getAttribute("href"), info: await frame.locator("#info").textContent() }));
  if (errors.length) throw new Error("Browser console or page errors occurred.");
  await ctx.close();
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
