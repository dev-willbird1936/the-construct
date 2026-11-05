const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Guards the licensed-default milestone: the public entry (site.js + index.html)
// must not reference uncleared trail-cam volumes/streaks/stable assets, and must
// mount the two licensed seeds with correct Example labelling.
const FORBIDDEN_SITE = [
  "assets/volumes",
  "assets/streaks",
  "assets/stable",
  "stable.html",
  "trailcam",
  "grizzly",
  "wolves2106504576",
  "clip=wolves",
  "clip=walker",
  "WOLF_PORTAL_MODE",
  "WOLF_SPECIMENS",
  "PORTAL_SPECIMEN",
  "PORTAL_CLIP",
  "openPortal",
  "upgradeShellSpecimens",
  "SHELL_SPECIMENS",
  "portalSize",
];

// "trailcam"/"trail_cams" (the uncleared footage source), not the word "trail":
// the studio's own "ghost trail" / "cloud trail" button copy is not an asset.
const FORBIDDEN_SITE_LOWER = ["cougar", "wolves", "grizzly", "trailcam", "trail_cams", "walker", "bear", "forest", "river"];

test("licensed default issues no uncleared volume/streak/stable requests", () => {
  const site = read("site.js");
  for (const needle of FORBIDDEN_SITE) {
    assert.ok(!site.includes(needle), `site.js must not contain ${needle}`);
  }
  const lower = site.toLowerCase();
  for (const needle of FORBIDDEN_SITE_LOWER) {
    assert.ok(!lower.includes(needle), `site.js must not mention ${needle} (case-insensitive)`);
  }
  assert.ok(!site.includes('location.search') || !site.match(/get\(["']clip["']\)/), "site.js must not branch on ?clip=");
  // Featured seeds mount via the chrono API with manifest attribution.
  assert.ok(site.includes('"assets/gallery-seed"'), "featured seeds use seedBase");
  assert.ok(site.includes("blackcat-atlas"), "blackcat seed mounted");
  assert.ok(site.includes("muntjac-atlas"), "muntjac seed mounted");
  assert.ok(site.includes("EXAMPLE · BLACK CAT"), "blackcat Example plaque");
  assert.ok(site.includes("EXAMPLE · MUNTJAC"), "muntjac Example plaque");
  assert.ok(site.includes("Dzkouslavia, CC0"), "blackcat attribution");
  assert.ok(site.includes("Mvolz, CC BY 3.0"), "muntjac attribution");
  // No footage-derived palette fetches; deterministic tints only.
  assert.ok(!site.includes("assets/streaks"), "no streak texture fetch");
});

test("sample button uses a licensed local corpus clip with visible credit", () => {
  const html = read("index.html");
  assert.ok(!html.includes("trailcam"), "sample must not point at trailcam");
  assert.ok(!html.includes("cougar.mp4"), "sample must not be the cougar clip");
  assert.ok(html.includes('data-sample="assets/corpus/blackcat.mp4"'), "sample is the licensed blackcat corpus clip");
  assert.ok(html.includes("Black Cat walking by Dzkouslavia"), "sample credit visible");
  assert.ok(html.includes("creativecommons.org/publicdomain/zero/1.0"), "sample licence link visible");
  assert.ok(fs.existsSync(path.join(ROOT, "assets/corpus/blackcat.mp4")), "licensed sample file exists in repo");
});

test("deployment packaging includes only the licensed default corpus sample", () => {
  for (const file of [".railwayignore", ".dockerignore"]) {
    const lines = read(file).split(/\r?\n/).map(s => s.trim());
    assert.ok(lines.includes("/assets/corpus/*"), `${file}: exclude corpus contents, not the parent`);
    assert.ok(lines.includes("!/assets/corpus/blackcat.mp4"), `${file}: retain the CC0 sample`);
    assert.ok(!lines.includes("/assets/corpus"), `${file}: parent exclusion would swallow the exception`);
    assert.deepEqual(lines.filter(s => s.startsWith("!/assets/corpus/")), ["!/assets/corpus/blackcat.mp4"]);
    assert.ok(lines.includes(".env*"), `${file}: private environment files stay excluded`);
  }
});

test("deployment packaging excludes local caches and rooted scratch artifacts", () => {
  for (const file of [".railwayignore", ".dockerignore"]) {
    const lines = read(file).split(/\r?\n/).map(s => s.trim());
    for (const rule of ["/.pytest_cache", "**/__pycache__", "/*hackathon-scratch*"]) {
      assert.ok(lines.includes(rule), `${file}: missing scratch/cache exclusion ${rule}`);
    }
  }
});

test("seed atlases carry no bogus backdrop metadata", () => {
  for (const f of ["assets/gallery-seed/blackcat-atlas.json", "assets/gallery-seed/muntjac-atlas.json"]) {
    const j = JSON.parse(read(f));
    assert.ok(!j.backdrop, `${f} must not declare an inert backdrop file`);
  }
  const manifest = JSON.parse(read("assets/gallery-seed.json"));
  const names = manifest.examples.map((e) => e.seedName).sort();
  assert.deepEqual(names, ["blackcat-atlas", "muntjac-atlas", "roedeer-basic", "squirrel-advanced"]);
  // Every example's files live under the seed folder and it carries its credit.
  for (const e of manifest.examples) {
    assert.ok(e.seedBase.startsWith("assets/gallery-seed"), `${e.id}: seedBase stays in the seed folder`);
    assert.ok(/CC0|CC BY [34]\.0/.test(e.note), `${e.id}: note carries the licence`);
    assert.ok(!/BY-(?:NC|SA|ND)/i.test(e.note), `${e.id}: no share-alike, non-commercial or no-derivatives source`);
  }
  const squirrel = manifest.examples.find((e) => e.seedName === "squirrel-advanced");
  assert.equal(squirrel.tier, "advanced");
  assert.ok(fs.existsSync(path.join(ROOT, squirrel.seedBase, "stable.json")), "squirrel Advanced seed is shipped");
  assert.ok(squirrel.note.includes("Anton Porsche"), "squirrel attribution");
  const roe = manifest.examples.find((e) => e.seedName === "roedeer-basic");
  assert.equal(roe.tier, "basic");
  assert.ok(fs.existsSync(path.join(ROOT, roe.seedBase, "specimen.json")), "roe deer Basic seed is shipped");
  assert.ok(roe.note.includes("The Nature Box"), "roe deer attribution");
});

test("terms carries accurate default-sample attribution", () => {
  const terms = read("terms.html");
  assert.ok(terms.includes("Black Cat walking"), "terms names the blackcat source");
  assert.ok(terms.includes("Muntjac Deer Barking"), "terms names the muntjac source");
  assert.ok(terms.includes("https://commons.wikimedia.org/wiki/File:Black_Cat_walking.webm"), "terms links blackcat source");
  assert.ok(terms.includes("https://commons.wikimedia.org/wiki/File:Muntjac_Deer_Barking.webm"), "terms links muntjac source");
  assert.ok(terms.includes("European roe deer (Capreolus capreolus) in Slovakia"), "terms names the roe deer source");
  assert.ok(terms.includes("https://commons.wikimedia.org/wiki/File:Squirrel_eating_nut.webmhd.webm"), "terms links squirrel source");
  assert.ok(terms.includes("creativecommons.org/licenses/by/4.0"), "terms links CC BY 4.0");
  assert.ok(terms.includes("https://commons.wikimedia.org/wiki/File:European_roe_deer_(Capreolus_capreolus)_in_Slovakia.webm"), "terms links roe deer source");
  assert.ok(terms.includes("creativecommons.org/publicdomain/zero/1.0"), "terms links CC0");
  assert.ok(terms.includes("creativecommons.org/licenses/by/3.0"), "terms links CC BY 3.0");
  const lower = terms.toLowerCase();
  assert.ok(!lower.includes("sublicens"), "terms makes no sublicensing claim");
  assert.ok(!lower.includes("cc by-sa"), "terms does not overclaim SA as unrestricted");
});
