import * as THREE from "three";

// Basic tier ("Specimen"): a SAM-tracked subject as depth-relief billboards
// riding in front of a depth-displaced clean plate (median or Muse Image).
// Scroll runs time, drag slides the camera sideways inside a small bounded
// window (yaw +-8 deg coupled, subject-anchored look-at: the subject holds
// while the background slides, 3D-photos style). The ghost trail is OFF by
// default (toggle in the dock). `?id=<specimenBase-or-id>` selects the
// specimen; `?embed=1` hides the HUD for tesseract cells (paused, honours
// reduced motion, host pointer drives the eye via __basic.setLook);
// `?path=auto` runs the scripted default path for eval and video capture
// (slow dolly + small arc + 3% push-in, yaw <= ~4 deg; any pointer input
// cancels it). The plate is overscanned so
// no plate edge ever enters the frame; provenance stays on the chips.

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const EMBED = params.has("embed");
if (EMBED) document.body.classList.add("embed");
const PATH_AUTO = params.get("path") === "auto";
// ?nochrome=1 hides the HUD chrome (dock, top bar, keys) but keeps
// playback + interaction: captures judge only the render. The product
// keeps its chrome; this is a capture/eval mode like ?embed=1.
if (params.has("nochrome")) {
  for (const s of ["header.top", "div.dock", "p.keys"]) {
    const n = document.querySelector(s);
    if (n) n.style.display = "none";
  }
}
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const rawId = params.get("id") || "";
if (!/^[a-z0-9][a-z0-9_./:-]*$/i.test(rawId) || rawId.includes("..")) {
  fail("No specimen selected. Open this page as view-basic.html?id=<specimen>.");
}
const BASE = rawId.includes("/") ? rawId.replace(/\/$/, "") + "/" : `specimens/${rawId}/`;

function fail(message) {
  const el = $("#fail");
  el.hidden = false;
  el.textContent = `Unable to open this specimen. ${message}`;
  throw new Error(message);
}

const get = async (url) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) fail(`missing ${url} (HTTP ${response.status}).`);
  return response;
};
const specimen = await get(BASE + "specimen.json").then((r) => r.json());
for (const key of ["working", "keyframes", "crop", "layout", "depth", "files"]) {
  if (specimen[key] == null) fail("specimen.json is incomplete.");
}
const K = specimen.keyframes.length;
if (!K) fail("specimen.json holds no keyframes.");

const tex = (name) =>
  get(BASE + name).then(async (r) => {
    const img = await createImageBitmap(await r.blob());
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { canvas, ctx, w: img.width, h: img.height };
  });
const [plateImg, subjectImg, depthImg] = await Promise.all([
  tex(specimen.files.plate), tex(specimen.files.subject), tex(specimen.files.depth),
]);
// Behind layer (optional, load-if-present): layered disocclusion fill as
// behind.webp (expanded canvas) + plateAlpha.png (front alphaMap). Absent
// on older specimens: the shrink-wrap backing path below stays.
const texOpt = async (name) => {
  try {
    const r = await fetch(BASE + name, { cache: "no-store" });
    if (!r.ok) return null;
    const img = await createImageBitmap(await r.blob());
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
    return { canvas, w: img.width, h: img.height };
  } catch { return null; }
};
const [behindImg, plateAlphaImg] = await Promise.all([texOpt("behind.webp"), texOpt("plateAlpha.png")]);
const hasBehind = !!behindImg && !!plateAlphaImg;
// Burnt-in camera band (tier-improve loop 10): trail cams stamp a bar of
// text (temperature, date, time) across the bottom of every frame. It is not
// part of the scene, but the orbit extremes look into the bottom rows, so the
// text slid into view as a tilted plate edge. When glyph rows are found in
// the bottom 15% (same test as the text-row flatten below), the band from
// the bar's top edge down is refilled with the scene rows just above it,
// mirrored at the edge (continuous there), and plate depth there samples the
// same mirrored rows. No glyph rows: nothing changes.
const plateBandV = (() => {
  const pw = plateImg.w, ph = plateImg.h;
  const ctx = plateImg.ctx, px = ctx.getImageData(0, 0, pw, ph);
  const d = px.data;
  const lum = (x, r) => { const o = (r * pw + x) * 4; return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; };
  const r0 = Math.floor(ph * 0.85), scores = [];
  for (let r = r0; r < ph; r += 1) {
    let mean = 0;
    for (let x = 0; x < pw; x += 1) mean += lum(x, r);
    mean /= pw;
    let hi = 0;
    for (let x = 0; x < pw; x += 1) if (Math.abs(lum(x, r) - mean) > 50) hi += 1;
    scores.push(hi / pw);
  }
  const med = [...scores].sort((a, b) => a - b)[scores.length >> 1];
  const th = Math.max(0.10, 2.5 * med);
  let glyph = -1;
  for (let k = 0; k < scores.length; k += 1) if (scores[k] > th && scores[k] >= 3 * scores[Math.max(0, k - 2)] + 0.02) { glyph = r0 + k; break; }
  if (glyph < 0) return null;
  // The bar: rows whose median brightness matches the band's own median
  // (glyphs are a minority of each row), walking up from the glyphs.
  const rowMed = (r) => { const v = []; for (let x = 0; x < pw; x += 4) v.push(lum(x, r)); v.sort((a, b) => a - b); return v[v.length >> 1]; };
  const band = []; for (let r = glyph; r < ph; r += 1) band.push(rowMed(r));
  band.sort((a, b) => a - b);
  const barMed = band[band.length >> 1];
  let top = glyph;
  while (top - 1 >= Math.max(1, glyph - Math.round(ph * 0.06)) && Math.abs(rowMed(top - 1) - barMed) < 18) top -= 1;
  top = Math.max(Math.round(ph * 0.8), top - 1); // take the bar's soft top edge too
  const H0 = ph - top;
  if (H0 <= 0 || 2 * top - ph < 0) return null;
  // Loop 11: a pure mirror repeats every bright blob right at the seam as a
  // symmetric pair ("( )" foam on grizzly's water at the orbit extreme).
  // The mirror now only bridges the seam: over its first 4 rows it hands over
  // to the block straight above the bar, translated down (no symmetry).
  const FEATHER = Math.min(4, H0);
  const src = new Uint8ClampedArray(d.subarray((top - H0) * pw * 4, top * pw * 4)); // rows top-H0 .. top-1
  for (let r = top; r < ph; r += 1) {
    const k = r - top, w = Math.min(1, k / FEATHER);
    const m = (H0 - 1 - k) * pw * 4, t = k * pw * 4; // mirrored row, translated row (in src)
    const o = r * pw * 4;
    for (let x = 0; x < pw * 4; x += 1) d[o + x] = (x & 3) === 3 ? 255 : src[m + x] * (1 - w) + src[t + x] * w;
  }
  ctx.putImageData(px, 0, 0);
  return top / ph;
})();
// Sub-keyframe motion field (optional, load-if-present; tier-improve loop
// 10): per consecutive keyframe pair, a coarse warp left over after the
// centroid slide, for the outgoing (fwd) and incoming (bwd) pose. Absent,
// malformed or ?flow=0: the plain slide + fade below is unchanged.
const flowField = await (async () => {
  const fl = specimen.flow;
  if (!fl || !specimen.files.flow || /[?&]flow=0\b/.test(location.search)) return null;
  if (fl.pairs !== K - 1 || !(fl.gx >= 2) || !(fl.gy >= 2) || !(fl.scale > 0)) return null;
  try {
    const r = await fetch(BASE + specimen.files.flow, { cache: "no-store" });
    if (!r.ok) return null;
    const q = new Int8Array(await r.arrayBuffer());
    return q.length === fl.pairs * fl.gy * fl.gx * 4 ? { q, gx: fl.gx, gy: fl.gy, scale: fl.scale } : null;
  } catch { return null; }
})();

const { W, H } = { W: specimen.working.width, H: specimen.working.height };
const { cols, cellW, cellH, dRows } = specimen.layout;
const rows = specimen.layout.rows;
const aspectH = H / W; // world height when the plate is 2 wide
// Sources narrower than 16:9 (phone portrait, square, 4:3) keep the 16:9
// plate HEIGHT (1.125) and narrow the width instead, so the rig (rest
// distance, FOV, relief amplitude) frames them exactly as it frames a 16:9
// plate vertically; desktop then pillarboxes to the source aspect (fitUpdate).
// 16:9 and wider: WS = 1, legacy geometry byte-identical.
const WS = Math.min(1, 0.5625 / aspectH);
const worldW = 2 * WS, worldH = 2 * aspectH * WS;
// Zero-rim footprint: the photo — or the expanded behind canvas when the
// layered fill ships. The envelope measures against inpainted surround
// then, which is why k can grow past the photo border.
// Overscan: plate+backing extend past the viewport at every allowed pose so
// no plate edge ever shows. 1.5 is sized by frustumCoverage() below for the
// widest window; the zero-rim envelope then keeps the view inside the photo.
let footW = worldW, footH = worldH;
if (hasBehind) { footW = worldW * (behindImg.w / W); footH = worldH * (behindImg.h / H); }
const OVERSCAN = 1.5;
const plateW = worldW * OVERSCAN, plateH = worldH * OVERSCAN;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Photo UV for a point on the overscanned quad (x right, y up, world units).
// Depth and color both clamp to the edge texel. No mirror sampling
// anywhere (doubling, ghost text, broken reflections all came from
// mirrors); the zero-rim envelope keeps every allowed pose inside the
// photo, so clamped edges only pad the coverage footprint, never show.
const rimUV = (x, y) => [clamp01(x / worldW + 0.5), clamp01(0.5 - y / worldH)];
const rimUVColor = (x, y) => {
  const vc = 0.5 - y / worldH;
  const u = x / worldW + 0.5;
  const rim = Math.abs(x) > worldW / 2 || Math.abs(y) > worldH / 2;
  if (rim) return rimUV(x, y);
  return [u, vc];
};
function setRimUVs(geo) {
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let k = 0; k < p.count; k += 1) {
    const [u, v] = rimUVColor(p.getX(k), p.getY(k));
    uv.setXY(k, u, 1 - v);
  }
}

// ── Atlas sampling ─────────────────────────────────────────────────────
// depth.webp holds (K+1) cells in the same column flow: cell 0 is the plate
// depth (full frame squeezed to a cell), cells 1..K track the subject cells.
const cellXY = (i) => ({ x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH });
const depthData = depthImg.ctx.getImageData(0, 0, depthImg.w, depthImg.h).data;
const subjectData = subjectImg.ctx.getImageData(0, 0, subjectImg.w, subjectImg.h).data;
function sampleCell(data, imgW, i, u, v) {
  const { x: cx, y: cy } = cellXY(i);
  const px = Math.min(imgW - 1, Math.max(0, Math.round(cx + u * (cellW - 1))));
  const py = Math.min(depthImg.h - 1, Math.max(0, Math.round(cy + v * (cellH - 1))));
  const o = (py * imgW + px) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
}
const plateDepth01 = (u, v) => sampleCell(depthData, depthImg.w, 0, u, v)[0] / 255;
// Subject cells may carry their own window (specimen.depth.subject, wider
// than the plate's when the subject is nearer): map back to plate-01 units,
// so values past 1 mean "nearer than the plate's 99th percentile". Older
// specimens have no window and read as before.
const subjWin = (() => {
  const d = specimen.depth || {}, s = d.subject;
  const span = (d.max - d.min) || 1;
  if (!s || !Number.isFinite(s.min) || !Number.isFinite(s.max) || !Number.isFinite(d.min)) return { a: 1, b: 0 };
  return { a: (s.max - s.min) / span, b: (s.min - d.min) / span };
})();
const subjDepth01 = (frame, u, v) => subjWin.b + subjWin.a * sampleCell(depthData, depthImg.w, frame + 1, u, v)[0] / 255;
const subjAlpha = (frame, u, v) => {
  const { x: cx, y: cy } = cellXY(frame);
  const sx = subjectImg.w / (cols * cellW), sy = subjectImg.h / (rows * cellH);
  const px = Math.min(subjectImg.w - 1, Math.max(0, Math.round((cx + u * (cellW - 1)) * sx)));
  const py = Math.min(subjectImg.h - 1, Math.max(0, Math.round((cy + v * (cellH - 1)) * sy)));
  return subjectData[(py * subjectImg.w + px) * 4 + 3];
};

// Bilinear plate depth in normalized frame UV (v origin top-left here).
function plateDepthBilinear(u, v) {
  if (plateBandV !== null && v > plateBandV) v = 2 * plateBandV - v; // band refill (above)
  const gx = Math.min(0.9999, Math.max(0, u)) * (cellW - 1);
  const gy = Math.min(0.9999, Math.max(0, v)) * (cellH - 1);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const at = (x, y) => sampleCell(depthData, depthImg.w, 0, x / (cellW - 1), y / (cellH - 1))[0] / 255;
  return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
         at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
}

// Depth sign: the subject must sit IN FRONT of the plate behind it. Larger
// DAV2 values usually mean closer, but verify against the actual planes:
// compare the subject depth median to the plate median over the crop ring.
const plateMedian = (() => {
  const vals = [];
  for (let gy = 0; gy < 18; gy += 1) {
    for (let gx = 0; gx < 32; gx += 1) {
      vals.push(plateDepthBilinear((gx + 0.5) / 32, (gy + 0.5) / 18));
    }
  }
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
})();
const subjMed01 = (() => {
  const meds = specimen.keyframes.map((f) => (f.depthMedian - specimen.depth.min) / (specimen.depth.max - specimen.depth.min));
  meds.sort((a, b) => a - b);
  return meds[meds.length >> 1];
})();
const SIGN = subjMed01 >= plateMedian ? 1 : -1;
// Relief amplitude: ±5% of the plate width. Enough to read as 3D when you
// orbit; small enough that discontinuity walls stay lit and gaps stay thin.
const AMP = 0.10;
const plateZ = (v01) => SIGN * (v01 - plateMedian) * AMP; // capped relief

// ── Scene ──────────────────────────────────────────────────────────────
THREE.ColorManagement.enabled = false;
const renderer = new THREE.WebGLRenderer({ canvas: $("#view"), antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05070a, 0.055);
// Narrow 36 deg field (was 40): the photo must COVER the viewport at rest
// (half-height 0.526 < photo 0.5625), otherwise rim bands show at every
// pose by construction and no envelope can reach a zero-rim count.
const FOV_DEG = 33; // was 36: a slight crop-zoom so the photo itself covers the orbit extremes (no blur surround)
const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.01, 60);

scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x1a1410, 1.15));
const key = new THREE.DirectionalLight(0xfff2df, 1.35);
key.position.set(-1.4, 1.8, 2.6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fd8ff, 0.5);
rim.position.set(1.6, -0.4, 1.8);
scene.add(rim);

const plateTex = new THREE.CanvasTexture(plateImg.canvas);
plateTex.colorSpace = THREE.SRGBColorSpace;
plateTex.anisotropy = 4;
plateTex.wrapS = THREE.MirroredRepeatWrapping;
plateTex.wrapT = THREE.MirroredRepeatWrapping; // legacy: rim UVs clamp so wrap never triggers
// Mirrored repeat sideways: the overscan rim shows the photo continuing
// (mirrored) instead of a smeared dark bar or a hard edge. Top/bottom stay
// clamped (the timestamp band must not mirror into readable ghost text).

// Plate depth statistics for the stretch envelope (assigned by the builder).
let plateStats = null;
// Plate: displaced by its own depth, capped so nothing stretches; faces that
// span a depth discontinuity are dropped (degenerate) instead of smeared.
const plateMesh = (() => {
  // Dense enough that per-quad depth steps stay below the GAP threshold
  // except at true silhouettes: coarse quads turn DAV2 speckle into dropped
  // faces + shade-dark walls (venetian chop at 1.5x overscan).
  const segX = 300, segY = Math.max(80, Math.round((300 * H) / W));
  const geo = new THREE.PlaneGeometry(plateW, plateH, segX, segY);
  const pos = geo.attributes.position;
  const grid = [];
  for (let iy = 0; iy <= segY; iy += 1) {
    grid[iy] = [];
    for (let ix = 0; ix <= segX; ix += 1) {
      const x = -plateW / 2 + (ix / segX) * plateW;
      const y = plateH / 2 - (iy / segY) * plateH;
      const [u, v] = rimUV(x, y); // v=0 is the TOP row, edge-clamped
      const z = plateZ(plateDepthBilinear(u, v));
      grid[iy][ix] = z;
      pos.setZ(iy * (segX + 1) + ix, z);
    }
  }
  setRimUVs(geo);
  // Tame DAV2 speckle: two 3x3 box passes (5x5 effective) over the relief.
  // Speckle micro-cliffs would otherwise trip the GAP test below (dropped
  // faces) and shade as faceted dark walls; true silhouettes survive, only
  // their shading facets soften. Blur runs BEFORE the rim pin so the
  // timestamp band still ends dead flat.
  for (let pass = 0; pass < 2; pass += 1) {
    const blur = grid.map((row) => row.slice());
    for (let iy = 1; iy < segY; iy += 1) {
      for (let ix = 1; ix < segX; ix += 1) {
        let s = 0;
        for (let jy = -1; jy <= 1; jy += 1) for (let jx = -1; jx <= 1; jx += 1) s += grid[iy + jy][ix + jx];
        blur[iy][ix] = s / 9;
      }
    }
    for (let iy = 0; iy <= segY; iy += 1) {
      for (let ix = 0; ix <= segX; ix += 1) {
        grid[iy][ix] = blur[iy][ix];
        pos.setZ(iy * (segX + 1) + ix, blur[iy][ix]);
      }
    }
  }
  const GAP = 0.02; // depth-01 step that counts as an occlusion edge
  const ZBACK = -(AMP / 2 + 0.008); // backing depth: relief never goes deeper
  // Pin the rim flat: frame-border depth is unreliable (DAV2 extrapolates
  // at edges) and a displaced rim zigzags against the background at
  // orbit angles. Rows within 8% of top/bottom and cols within 5% of
  // the sides go to the backing plane. PLUS the bottom photo rows:
  // trail-cam timestamps (bottom rows) shear and tear on DAV2 noise
  // unless uniformly flat — but flattening text-free ground carves a
  // visible seam where that ground has relief (flat normals + dropped
  // slope faces read as a dark line). So glyph rows are DETECTED (pixels
  // far from the row median across the bottom 15%: overlay text spikes
  // them; texture self-normalizes) and only they flatten, feathered, to
  // the BACKGROUND level (median interior relief: flush, one mesh, depth
  // only). Ground without text keeps its relief and shading, seam-free.
  let textTopV = 2; // no text -> no row flatten
  {
    const pw = plateImg.w, ph = plateImg.h;
    const px = plateImg.ctx.getImageData(0, 0, pw, ph).data;
    const scores = [];
    for (let r = Math.floor(ph * 0.85); r < ph; r += 1) {
      let mean = 0;
      for (let x = 0; x < pw; x += 1) {
        const o = (r * pw + x) * 4;
        mean += 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
      }
      mean /= pw;
      let hi = 0;
      for (let x = 0; x < pw; x += 1) {
        const o = (r * pw + x) * 4;
        const l = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
        if (Math.abs(l - mean) > 50) hi += 1;
      }
      scores.push(hi / pw);
    }
    // Overlay text is a sharp band (rows ~0.00 then 0.12+); natural texture
    // (flowers in grass, a cup rim) stays low or ramps smoothly, and a false
    // hit flattens real ground into a visible seam. So a hit needs an
    // absolute floor AND a jump over the row two above.
    const med = [...scores].sort((a, b) => a - b)[scores.length >> 1];
    const th = Math.max(0.10, 2.5 * med);
    for (let k = 0; k < scores.length; k += 1)
      if (scores[k] > th && scores[k] >= 3 * scores[Math.max(0, k - 2)] + 0.02) { textTopV = (Math.floor(ph * 0.85) + k) / ph; break; }
  }
  const rimRow = (iy) => iy / segY < 0.08 || iy / segY > 0.92;
  const rimCol = (ix) => ix / segX < 0.05 || ix / segX > 0.95;
  const bgSamp = [];
  for (let jy = 0; jy <= segY; jy += 5)
    for (let jx = 0; jx <= segX; jx += 5) {
      const jyY = plateH / 2 - (jy / segY) * plateH;
      const jv = 0.5 - jyY / worldH;
      if (jv > 0.3 && jv < 0.7) bgSamp.push(grid[jy][jx]);
    }
  bgSamp.sort((a, b) => a - b);
  const bgZ = bgSamp.length ? bgSamp[bgSamp.length >> 1] : ZBACK;
  const sstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let iy = 0; iy <= segY; iy += 1) {
    const y = plateH / 2 - (iy / segY) * plateH;
    const photoV = 0.5 - y / worldH;
    const fRow = textTopV > 1 ? 0 : sstep(textTopV - 0.036, textTopV, photoV); // ~2 quads
    for (let ix = 0; ix <= segX; ix += 1) {
      const rimF = rimRow(iy) || rimCol(ix) ? 1 : 0;
      // Sunk rim pins to the backing plane; the text zone pins to the
      // background level (flush, no floating card). One loop, two targets.
      const target = rimF ? ZBACK : bgZ;
      const f = Math.max(fRow, rimF);
      if (f > 0) {
        const z = grid[iy][ix] * (1 - f) + target * f;
        grid[iy][ix] = z;
        pos.setZ(iy * (segX + 1) + ix, z);
      }
    }
  }
  const idx = [];
  // Per-quad depth steps feed the disocclusion/stretch envelope below:
  // a quad spanning a step delta grows ~ (1+delta*tan/yaw /quadW)/cos on
  // screen when the camera turns, and past 2.5x its rest size it smears.
  const deltas = new Float32Array(segX * segY);
  let degenQuads = 0;
  for (let iy = 0; iy < segY; iy += 1) {
    for (let ix = 0; ix < segX; ix += 1) {
      // three.js winding: b is the row below, d the next column (front = +z)
      const a = iy * (segX + 1) + ix, b = a + segX + 1, c = b + 1, d = a + 1;
      const zs = [grid[iy][ix], grid[iy + 1][ix], grid[iy + 1][ix + 1], grid[iy][ix + 1]];
      const step = Math.max(...zs) - Math.min(...zs);
      deltas[iy * segX + ix] = step;
      if (step > GAP * AMP * 2) {
        degenQuads += 1;
        idx.push(a, a, a, a, a, a); // degenerate: no stretched triangle
      } else {
        idx.push(a, b, d, b, c, d);
      }
    }
  }
  plateStats = {
    deltas, quadW: plateW / segX, quads: segX * segY,
    degenShare: degenQuads / (segX * segY),
    gapCut: GAP * AMP * 2, // seam threshold, shared with the envelope
    nx: segX, ny: segY, // grid dims for the seam-run census
    grid, // blurred relief (reference): the census tests foreground edges
    bgZ, // background level for the seam census and text-zone pin
    qnx: null, qny: null, qnz: null, qdark: null, // filled below (quad normals + relative darkness)
  };
  geo.setIndex(idx);
  // Analytic heightfield normals from the depth grid: computeVertexNormals
  // averages across the dropped discontinuity faces, and near-degenerate
  // slivers contribute near-zero garbage vectors that normalize into
  // arbitrary (often backwards) directions = black patches. Central
  // differences of the grid stay finite everywhere (cliffs become steep but
  // valid slopes, which shade as correct occlusion walls).
  const nrm = geo.attributes.normal;
  const hx = plateW / segX, hy = plateH / segY;
  for (let iy = 0; iy <= segY; iy += 1) {
    for (let ix = 0; ix <= segX; ix += 1) {
      const dzdx = (grid[iy][Math.min(segX, ix + 1)] - grid[iy][Math.max(0, ix - 1)]) / (2 * hx);
      const dzdy = (grid[Math.max(0, iy - 1)][ix] - grid[Math.min(segY, iy + 1)][ix]) / (2 * hy);
      const inv = 1 / Math.hypot(dzdx, dzdy, 1);
      nrm.setXYZ(iy * (segX + 1) + ix, -dzdx * inv, -dzdy * inv, inv);
    }
  }
  nrm.needsUpdate = true;
  // Per-quad normals + relative darkness for the disocclusion envelope:
  // walls facing away from the key read near-black against dark ground,
  // and oblique views expose much more wall area than rest. darkness is
  // relative to a flat quad under the same three lights (monochrome).
  {
    const key = new THREE.Vector3(-1.4, 1.8, 2.6).normalize();
    const rimL = new THREE.Vector3(1.6, -0.4, 1.8).normalize();
    const lum = (nx, ny, nz) => 1.35 * Math.max(0, nx * key.x + ny * key.y + nz * key.z)
      + 0.5 * Math.max(0, nx * rimL.x + ny * rimL.y + nz * rimL.z)
      + 1.15 * (0.62 + 0.38 * ny);
    const flat = lum(0, 0, 1);
    const n = segX * segY;
    const qnx = new Float32Array(n), qny = new Float32Array(n);
    const qnz = new Float32Array(n), qdark = new Float32Array(n);
    for (let iy = 0; iy < segY; iy += 1) {
      for (let ix = 0; ix < segX; ix += 1) {
        const q = iy * segX + ix;
        let x = 0, y = 0, z = 0;
        for (const [jx, jy] of [[ix, iy], [ix + 1, iy], [ix, iy + 1], [ix + 1, iy + 1]]) {
          const k = jy * (segX + 1) + jx;
          x += nrm.getX(k); y += nrm.getY(k); z += nrm.getZ(k);
        }
        const l = Math.hypot(x, y, z) || 1;
        x /= l; y /= l; z /= l;
        qnx[q] = x; qny[q] = y; qnz[q] = z;
        qdark[q] = Math.min(1, Math.max(0, 1 - lum(x, y, z) / flat));
      }
    }
    Object.assign(plateStats, { qnx, qny, qnz, qdark });
  }
  // Photo-subject patch (Lane F): unlit plate + subject so a rendered
  // pixel equals its source texel at rest. MeshBasicMaterial ignores the
  // scene lights; relief geometry (and parallax) is untouched. fog:false
  // keeps the FogExp2 tint off the photo; toneMapped:false locks the match.
  const plateMat = new THREE.MeshBasicMaterial({ map: plateTex, toneMapped: false, fog: false });
  if (hasBehind) {
    // Layered disocclusion: the front keeps its relief + photo but turns
    // translucent on depth-edge cuts (alphaMap); the behind plane carries
    // the inpainted continuation at the far level. At rest the cuts sit
    // over near-identical inpaint so nothing changes; at orbit they open
    // onto plausible background instead of stretched triangles.
    const alphaTex = new THREE.CanvasTexture(plateAlphaImg.canvas);
    plateMat.transparent = true;
    plateMat.alphaMap = alphaTex;
    const behindTex = new THREE.CanvasTexture(behindImg.canvas);
    behindTex.colorSpace = THREE.SRGBColorSpace;
    behindTex.anisotropy = 4;
    const behind = new THREE.Mesh(
      new THREE.PlaneGeometry(footW, footH),
      new THREE.MeshBasicMaterial({ map: behindTex, toneMapped: false, fog: false })
    );
    behind.position.z = plateStats.bgZ - 0.003;
    scene.add(behind);
  }
  const mesh = new THREE.Mesh(geo, plateMat);
  scene.add(mesh);
  // Backing (legacy path, only without the behind layer: the backing's
  // same-photo safety net would sit in FRONT of the flat far behind
  // plane and hide the inpaint wherever they overlap). The same photo with the same rim mapping, shrink-wrapped a
  // hair behind the plate surface (never coplanar: no z-fighting), same
  // extent as the plate. Gaps in the plate (dropped discontinuity faces)
  // show photo from near-matching depth instead of flat black: the old
  // flat backing parallax-doubled at oblique angles, reading as holes.
  // No faces are dropped here: stretched backing photo under a gap still
  // beats background, and the shrink-wrap keeps the stretch minimal.
  if (!hasBehind) {
  const backingGeo = new THREE.PlaneGeometry(plateW, plateH, segX, segY);
  setRimUVs(backingGeo);
  {
    const bp = backingGeo.attributes.position;
    for (let iy = 0; iy <= segY; iy += 1)
      for (let ix = 0; ix <= segX; ix += 1)
        bp.setZ(iy * (segX + 1) + ix, grid[iy][ix] - 0.004);
    bp.needsUpdate = true;
    backingGeo.computeVertexNormals();
  }
  const backing = new THREE.Mesh(
    backingGeo,
    new THREE.MeshBasicMaterial({ map: plateTex, toneMapped: false, fog: false })
  );
  // A hair behind the pinned border (never coplanar: no z-fighting where
  // the plate's timestamp strip meets the backing). Position stays 0: the
  // shrink-wrap above already carries the per-vertex offset.
  backing.position.z = 0;
  scene.add(backing);
  }
  return mesh;
})();
void plateMesh;

// Subject: one depth-relief billboard per keyframe, all parallel to the plate
// (small orbit angles only — billboarding toward the camera would swim).
const subjectTex = new THREE.CanvasTexture(subjectImg.canvas);
// Premultiplied + raw bytes: a canvas keeps no RGB under alpha 0, so
// straight-alpha bilinear filtering mixed black into every edge texel and
// the alpha remap below then showed it opaque (a dark rim). The shader
// un-premultiplies after filtering and decodes sRGB itself.
subjectTex.colorSpace = THREE.NoColorSpace;
subjectTex.premultiplyAlpha = true;
subjectTex.anisotropy = 4;
const cropWU = specimen.crop.w * worldW, cropHU = specimen.crop.h * worldH;
const subjPlanes = specimen.keyframes.map((f, i) => {
  // 96-wide grid (was 44): silhouette and relief detail survive the orbit.
  const nx = 96, ny = Math.max(20, Math.round((96 * cropHU) / cropWU));
  const geo = new THREE.PlaneGeometry(cropWU, cropHU, nx, ny);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const col = i % cols, row = Math.floor(i / cols);
  const atlasW = cols * cellW, atlasH = rows * cellH;
  const insetU = 0.6 / atlasW, insetV = 0.6 / atlasH;
  for (let k = 0; k < pos.count; k += 1) {
    const u = uv.getX(k), v = uv.getY(k); // v=1 top
    const cu = (col * cellW + insetU * atlasW + u * (cellW - 2 * insetU * atlasW)) / atlasW;
    const cv = 1 - ((row * cellH + insetV * atlasH + (1 - v) * (cellH - 2 * insetV * atlasH)) / atlasH);
    uv.setXY(k, cu, cv);
  }
  // relief centred on this cell's own depth median: the full range works
  // the subject's internal variation instead of the shared plate mapping.
  const samples = [];
  for (let gy = 0; gy < 9; gy += 1) {
    for (let gx = 0; gx < 9; gx += 1) {
      samples.push(subjDepth01(i, (gx + 0.5) / 9, (gy + 0.5) / 9));
    }
  }
  samples.sort((a, b) => a - b);
  const cellMed = samples[samples.length >> 1];
  // Body volume from the alpha distance transform: DAV2 gives surface
  // detail but goes flat across uniform regions (bellies read hollow).
  // dome() rises smoothly inside the silhouette; detail fades to the dome
  // at the rim (edge-aware: no cliff-shading fringe on the outline).
  const gw = nx + 1, gh = ny + 1;
  const amask = new Uint8Array(gw * gh);
  for (let k = 0; k < pos.count; k += 1) {
    const gu = (k % gw) / nx, gv = 1 - (Math.floor(k / gw) / ny);
    if (subjAlpha(i, gu, 1 - gv) >= 8) amask[k] = 1;
  }
  // Interiority depth: 0 outside and at the rim, rising inside (chamfer
  // distance transform of the silhouette, in vertex steps).
  const dt = new Float32Array(gw * gh);
  for (let k = 0; k < pos.count; k += 1) dt[k] = amask[k] ? 1e9 : 0;
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const k = y * gw + x;
      if (!amask[k]) continue;
      if (x > 0) dt[k] = Math.min(dt[k], dt[k - 1] + 1);
      if (y > 0) dt[k] = Math.min(dt[k], dt[k - gw] + 1);
    }
  }
  for (let y = gh - 1; y >= 0; y -= 1) {
    for (let x = gw - 1; x >= 0; x -= 1) {
      const k = y * gw + x;
      if (x + 1 < gw) dt[k] = Math.min(dt[k], dt[k + 1] + 1);
      if (y + 1 < gh) dt[k] = Math.min(dt[k], dt[k + gw] + 1);
    }
  }
  const zf = new Float32Array(pos.count);
  for (let k = 0; k < pos.count; k += 1) {
    // vertex grid position recovered from the index (uv already atlas-space)
    const gu = (k % (nx + 1)) / nx, gv = 1 - (Math.floor(k / (nx + 1)) / ny);
    const d = subjDepth01(i, gu, 1 - gv);
    const w = amask[k] ? Math.min(1, dt[k] / 6) : 0; // interiority: 0 at rim
    const dome = Math.sin(Math.min(1, dt[k] / 6) * Math.PI / 2);
    // Rigidity near the camera plane (X=50): DAV2 detail clamped to half
    // the relief amplitude (+-AMP/4). Detail spikes (sensor noise on near
    // limbs) stretch-smear at oblique views; the inflation dome (smooth,
    // broad) is untouched, so body volume survives while arms stop smearing.
    const detail = THREE.MathUtils.clamp(SIGN * (d - cellMed) * AMP * 2, -AMP / 4, AMP / 4);
    // Half DAV2 detail (edge-faded) + half inflation dome (body volume).
    // No recessed outline trench: rim verts stay coplanar and the edge is
    // carried by the feathered alpha alone. The old -0.035 push put a
    // vertex-quantized dark step around every silhouette (venetian slicing
    // at orbit angles); the shader smoothstep edge made it redundant.
    zf[k] = 0.5 * detail * (0.2 + 0.8 * w) + 0.5 * dome * (AMP / 2);
  }
  // Gaussian-smooth the relief field (sigma ~1.4 verts, separable 5-tap):
  // kills the DT/detail vertex-step banding on thin limbs and necks.
  // Alpha is untouched (separate path); transparent verts don't render.
  {
    const ker = [1, 4, 6, 4, 1], kn = 16;
    const tmp = new Float32Array(pos.count);
    for (let y = 0; y < gh; y += 1)
      for (let x = 0; x < gw; x += 1) {
        let s = 0;
        for (let j = -2; j <= 2; j += 1) s += zf[y * gw + Math.min(gw - 1, Math.max(0, x + j))] * ker[j + 2];
        tmp[y * gw + x] = s / kn;
      }
    for (let y = 0; y < gh; y += 1)
      for (let x = 0; x < gw; x += 1) {
        let s = 0;
        for (let j = -2; j <= 2; j += 1) s += tmp[Math.min(gh - 1, Math.max(0, y + j)) * gw + x] * ker[j + 2];
        pos.setZ(y * gw + x, s / kn);
      }
  }
  // Silhouette-depth pin (Lane F v2): the feather band sat ~0.024 world
  // behind the body median (dome foot + detail edge-fade + blur pull-down),
  // ~7 screen px of rim-vs-body shift at +-20 deg yaw. Re-pin the rim zone
  // (verts within 1 step of any non-opaque vert: band + outside ring +
  // opaque rim) to the local full-interior height, so the rendered contour
  // rides at body depth. Interior (dt>=3) untouched; alpha untouched.
  {
    const av = new Uint8Array(pos.count);
    for (let k = 0; k < pos.count; k += 1) {
      const gu = (k % gw) / nx, gv = 1 - (Math.floor(k / gw) / ny);
      av[k] = subjAlpha(i, gu, 1 - gv);
    }
    const tgt = new Uint8Array(pos.count);
    for (let y = 0; y < gh; y += 1) for (let x = 0; x < gw; x += 1) {
      let t = 0;
      for (let jy = -1; jy <= 1 && !t; jy += 1) for (let jx = -1; jx <= 1; jx += 1) {
        const xx = x + jx, yy = y + jy;
        if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && av[yy * gw + xx] < 255) t = 1;
      }
      tgt[y * gw + x] = t;
    }
    const R = 6, NEED = 6; // smallest window that reaches full-dome (dt>=6) verts
    for (let y = 0; y < gh; y += 1) for (let x = 0; x < gw; x += 1) {
      if (!tgt[y * gw + x]) continue;
      const vals = [];
      let bd = -1, bz = 0;
      for (let jy = -R; jy <= R; jy += 1) for (let jx = -R; jx <= R; jx += 1) {
        const xx = x + jx, yy = y + jy;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const k = yy * gw + xx;
        if (dt[k] >= NEED) vals.push(pos.getZ(k));
        if (amask[k] && dt[k] > bd) { bd = dt[k]; bz = pos.getZ(k); }
      }
      if (vals.length) { vals.sort((a, b) => a - b); pos.setZ(y * gw + x, vals[vals.length >> 1]); }
      else if (bd >= 0) pos.setZ(y * gw + x, bz); // thin part: local spine, alpha untouched
    }
  }
  // Cull jump triangles (the mesh fault from the depth check): the depth
  // itself is smooth, so streaks/scallops at silhouettes are quads
  // straddling the depth cliff. Drop them (degenerate) like the plate's
  // GAP faces: the behind inpaint shows through instead of stretched
  // texture. Interior relief never steps this far (detail is clamped).
  {
    const CULL = 0.3 * AMP;
    const idx = geo.index.array;
    for (let qy = 0; qy < ny; qy += 1) for (let qx = 0; qx < nx; qx += 1) {
      const a = qy * gw + qx;
      const za = pos.getZ(a), zb = pos.getZ(a + 1), zc = pos.getZ(a + gw), zd = pos.getZ(a + gw + 1);
      const step = Math.max(Math.abs(zb - za), Math.abs(zc - za), Math.abs(zd - za),
        Math.abs(zd - zb), Math.abs(zd - zc), Math.abs(zb - zc));
      if (step > CULL) {
        const o = (qy * nx + qx) * 6;
        idx[o] = idx[o + 1] = idx[o + 2] = idx[o + 3] = idx[o + 4] = idx[o + 5] = a;
      }
    }
    geo.index.needsUpdate = true;
  }
  geo.computeVertexNormals();
  // Photo-subject patch (Lane F): unlit subject. Same premultiplied +
  // manual-sRGB-decode upload (edge correctness) and same smoothstep
  // alpha remap; only the Standard lighting is gone, so flat areas render
  // their source texel instead of albedo x lights (~0.55 + cool tint).
  const mat = new THREE.MeshBasicMaterial({
    map: subjectTex, transparent: true, toneMapped: false, fog: false,
    alphaTest: 0.004, depthWrite: true, // cut only at the gradient foot
  });
  // Threshold-free smooth edge in the shader: the baked alpha is a real
  // soft matte (measured 10-90 pct 4.5-4.8 px, edge-fidelity lane F), so use
  // it directly. The old smoothstep(0.0,0.5) remap pushed a=0.25->0.5 and
  // fattened the silhouette 1-2 px by itself (ear +4 px with lift), making
  // feather-zone RGB show opaque as dark/bright halo. Opacity multiplies
  // after the linear alpha so ghost fades are unaffected. The 0.004
  // foot-discard keeps exact-zero texels from writing depth (they would
  // stand as invisible walls at orbit angles).
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <alphatest_fragment>",
      `vec3 pm = diffuseColor.rgb / max(sampledDiffuseColor.a, 1e-4);
       diffuseColor.rgb = mix(pm / 12.92, pow((pm + 0.055) / 1.055, vec3(2.4)), step(0.04045, pm));
       diffuseColor.a = sampledDiffuseColor.a * opacity;
       if (diffuseColor.a < 0.004) discard;`
    );
  };
  // Ghosts read as dark duplicates on bright ground at hard cutout edges:
  // smooth their alpha (no cutout) and fade them harder than the present.
  mat.userData.isGhost = false;
  const mesh = new THREE.Mesh(geo, mat);
  // The plane is the cell's crop rectangle (f.box), with the subject already
  // at its true place inside it, so the plane sits at the box centre. Using
  // the centroid applied the subject's offset twice: on walk-across clips the
  // subject ran off the plate at both ends. Depth still samples the centroid.
  const cx = ((f.box[0] + f.box[2]) / 2 - 0.5) * worldW;
  const cy = (0.5 - (f.box[1] + f.box[3]) / 2) * worldH;
  // Lift is always toward the camera (+z): SIGN only orients the depth axis.
  const lift = Math.max(0.012, (subjMed01 - plateDepthBilinear(f.centroid[0], f.centroid[1])) * SIGN * AMP) + 0.022;
  mesh.position.set(cx, cy, plateZ(plateDepthBilinear(f.centroid[0], f.centroid[1])) + lift);
  mesh.userData.base = mesh.position.clone(); // sub-keyframe blend offsets from here
  if (flowField) { // the flow warp moves vertices from these rest x/y
    mesh.userData.grid = { nx, ny };
    mesh.userData.bxy = new Float32Array(pos.count * 2);
    for (let k = 0; k < pos.count; k += 1) { mesh.userData.bxy[k * 2] = pos.getX(k); mesh.userData.bxy[k * 2 + 1] = pos.getY(k); }
  }
  mesh.visible = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  return mesh;
});

// ── Camera: MOVE sideways, don't spin. The look-at sits at the plate
// centre but at the present subject's depth, so the subject holds while the
// background slides (3D-photos effect). Drag strafes (+-0.12 x, +-0.05 y)
// with yaw coupled inside +-8 deg; hard clamps, no free orbit past that.
// Pitch stays at rest (vertical moves translate); pointer parallax nudges.
const lookZ = { v: 0.02 }; // eased subject depth for the look-at plane
const middle = new THREE.Vector3(0, 0, 0.02); // legacy pivot export
// ── Portrait subject framing: portrait subject framing ──
// Desktop (device aspect >= 1) is byte-identical legacy: pivot 0, full
// viewport. Phones (aspect < 1) pivot x onto the union of the subject
// keyframe bboxes and letterbox (honest page-background bars) to the
// viewport aspect that contains the union half-width at rest distance.
// No geometry distortion, no new UX, no gate relaxation.
const FIT_SRC = (() => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of specimen.keyframes) {
    const b = f.box;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  return { x0, y0, x1, y1 };
})();
const FIT_U = {
  x0w: (FIT_SRC.x0 - 0.5) * worldW, x1w: (FIT_SRC.x1 - 0.5) * worldW,
  yTop: (0.5 - FIT_SRC.y0) * worldH, yBot: (0.5 - FIT_SRC.y1) * worldH,
};
FIT_U.cx = (FIT_U.x0w + FIT_U.x1w) / 2;
FIT_U.hw = (FIT_U.x1w - FIT_U.x0w) / 2;
FIT_U.srcLeft = FIT_SRC.x0 <= 0.002;
FIT_U.srcRight = FIT_SRC.x1 >= 0.998;
FIT_U.srcTop = FIT_SRC.y0 <= 0.002;
FIT_U.srcBottom = FIT_SRC.y1 >= 0.998; // this specimen: legs cut in SOURCE
const FIT_TAN = Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2);
const FIT_LIMIT = 0.92; // keep non-cut subject 8% inside the frame edge
const FIT_MARGIN = 0.03; // world-unit slack around the union half-width
const FIT_PIVOT_X = FIT_U.cx, FIT_PIVOT_Y = 0; // keep legacy vertical: rim-safe
const FIT_R_MIN = 1.5; // rest distance (== RADIUS, declared below; literal avoids its TDZ)
// NOTE: spec yaw written as a literal: YAW_SPEC is declared below this
// block (same 8 deg value); referencing it here would hit its TDZ.
const FIT_SPEC_YAW = THREE.MathUtils.degToRad(8);
let FIT_HALF_NEED = FIT_U.hw * Math.cos(FIT_SPEC_YAW) + (AMP / 2) * Math.sin(FIT_SPEC_YAW) + FIT_MARGIN;
let FIT_VIEW_ASPECT = FIT_HALF_NEED / (FIT_R_MIN * FIT_TAN * FIT_LIMIT);
// Travel clips fit the subject, not the union: half-width of the present
// subject (world x), refreshed per resize. In-place clips keep the union
// half-width, so these recompute to the identical consts above.
function refreshFitNeed() {
  const hw = (typeof follow !== "undefined" && follow.active) ? follow.subjHW : FIT_U.hw;
  FIT_HALF_NEED = hw * Math.cos(FIT_SPEC_YAW) + (AMP / 2) * Math.sin(FIT_SPEC_YAW) + FIT_MARGIN;
  FIT_VIEW_ASPECT = FIT_HALF_NEED / (FIT_R_MIN * FIT_TAN * FIT_LIMIT);
}
let fitView = { active: false, aspect: 1, viewW: 0, viewH: 0, barH: 0, barW: 0 };
function fitUpdate() {
  refreshFitNeed(); // subject-based need when following (identical math otherwise)
  const w = innerWidth, h = innerHeight, dev = w / Math.max(1, h);
  if (dev >= 1) {
    // Narrow source (WS < 1) on a wider window: pillarbox to the source
    // aspect with honest page-background bars, never a cropped zoom.
    if (WS < 1 && dev > W / H) {
      const vw = Math.max(2, Math.round(h * W / H));
      fitView = { active: false, aspect: vw / h, viewW: vw, viewH: h, barH: 0, barW: Math.floor((w - vw) / 2) };
      return fitView;
    }
    fitView = { active: false, aspect: dev, viewW: w, viewH: h, barH: 0, barW: 0 };
    return fitView;
  }
  let eff = Math.max(FIT_VIEW_ASPECT, w / h); // letterbox only ever widens
  if (WS < 1) eff = Math.min(eff, Math.max(w / h, W / H)); // never wider than a narrow source
  const vh = Math.min(h, Math.round(w / eff));
  fitView = { active: true, aspect: w / vh, viewW: w, viewH: vh, barH: Math.floor((h - vh) / 2), barW: 0 };
  return fitView;
}
// ── Desktop subject framing (Lane D FRAMING.md) ──
// Phones (fitView.active) byte-identical. Desktop in-place clips pivot X
// onto the union centre (FIT_PIVOT_X) and zoom so the union spans >=45%
// in its constraining dimension (implies the brief's OR). Y stays 0
// (rim-safe; clip-b legs cut in source). Travel clips defer to follow.
let frameState = { active: false, pivX: 0, r: 1.5, zoom: 1, fallback: false, range: 1 };
const fitPivotX = () => (fitView.active ? FIT_PIVOT_X : (frameState.active ? frameState.pivX : 0));
const RADIUS = 1.5; // rest distance: the photo (half-height 0.5625) must
// cover the FOV36 viewport (half-height 0.50) with margin left for the
// whole envelope; closer than 1.62 buys vertical slack for the extremes.
const restOff = new THREE.Vector3(0, 0.103, 1.617);
restOff.setLength(RADIUS); // keep the frontal-rest direction
const restYaw = Math.atan2(restOff.x, restOff.z);
const restPitch = Math.asin(THREE.MathUtils.clamp(restOff.y / restOff.length(), -1, 1));
// Spec caps (the brief): yaw +-8 deg, slide +-0.12 x / +-0.05 y. The
// disocclusion envelope below may tighten them per specimen (never loosen).
const YAW_SPEC = THREE.MathUtils.degToRad(8);
const SX_SPEC = 0.12, SY_SPEC = 0.05;
let YAW = YAW_SPEC, SLIDE_X = SX_SPEC, SLIDE_Y = SY_SPEC;
let envelope = { k: 1, yawDeg: 8, sx: SX_SPEC, sy: SY_SPEC, mirror: 0, stretch: 0, bad: 0 };
const view = { yaw: restYaw, sx: 0, sy: 0, r: RADIUS };
const viewT = { ...view };
let pathOff = false; // user drag cancels the scripted autoplay path
// Opening glide (see tick): on by default for visitors; ?glide=0 turns it
// off, and embeds, the scripted path and reduced motion never run it.
const GLIDE = !EMBED && !PATH_AUTO && params.get("glide") !== "0";
const GLIDE_PERIOD = Number(params.get("glidePeriod")) || 8; // s per full sway
const GLIDE_AMP = Math.min(1, Number(params.get("glideAmp")) || 0.9); // share of the drag window
const GLIDE_RAMP = 1.5; // s to ease in from rest
let glideOff = false;
const glideT0 = performance.now();
for (const type of ["pointerdown", "wheel", "keydown", "touchstart"]) {
  addEventListener(type, () => { glideOff = true; }, { capture: true, passive: true });
}
function clampView(v) {
  v.yaw = THREE.MathUtils.clamp(v.yaw, restYaw - YAW, restYaw + YAW);
  v.sx = THREE.MathUtils.clamp(v.sx, -SLIDE_X, SLIDE_X);
  v.sy = THREE.MathUtils.clamp(v.sy, -SLIDE_Y, SLIDE_Y);
  v.r = THREE.MathUtils.clamp(v.r, (typeof follow !== "undefined" && follow.active) ? follow.rMin : (frameState.active ? Math.min(RADIUS * 0.8, frameState.r) : RADIUS * 0.8), RADIUS);
}
// ── Follow camera for travel clips (proposal; see Lane D FOLLOW.md) ──
// Travel metric: union width of keyframe boxes >= 2x the median subject
// width (alpha-measured, sqrt(pixels) fallback). In-place clips keep
// follow.dx == 0 and the legacy pivot/zoom/coverage path byte-identical.
// Pure helpers below mirror viewer/follow-math.mjs (drift-tested).
function unionWidth(keyframes) {
  let x0 = Infinity, x1 = -Infinity;
  for (const f of keyframes) {
    if (f.box[0] < x0) x0 = f.box[0];
    if (f.box[2] > x1) x1 = f.box[2];
  }
  return x1 - x0;
}
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function proxyWidths(keyframes, workingW) {
  return keyframes.map((f) => Math.sqrt(f.pixels) / workingW);
}
function travelReport(keyframes, widths) {
  const unionW = unionWidth(keyframes);
  const subjW = median(widths);
  const ratio = unionW / subjW;
  return { unionW, subjW, ratio, travel: ratio >= 2 };
}
function measureBoxes(keyframes, alphaAt, GU = 64, GV = 36, thresh = 8) {
  return keyframes.map((f, i) => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0, any = false;
    for (let gy = 0; gy < GV; gy += 1) {
      for (let gx = 0; gx < GU; gx += 1) {
        if (alphaAt(i, (gx + 0.5) / GU, (gy + 0.5) / GV) >= thresh) {
          any = true;
          const u = gx / (GU - 1), v = gy / (GV - 1);
          if (u < x0) x0 = u;
          if (u > x1) x1 = u;
          if (v < y0) y0 = v;
          if (v > y1) y1 = v;
        }
      }
    }
    return any ? { x0, x1, y0, y1 } : null;
  });
}
function centeredTargets(xs, halfWin = 2) {
  const n = xs.length;
  return xs.map((_, i) => {
    let s = 0, c = 0;
    for (let j = i - halfWin; j <= i + halfWin; j += 1) {
      if (j < 0 || j >= n) continue;
      s += xs[j]; c += 1;
    }
    return s / c;
  });
}
function targetAt(targets, times, t) {
  const n = targets.length;
  if (t <= times[0]) return targets[0];
  if (t >= times[n - 1]) return targets[n - 1];
  for (let i = 0; i < n - 1; i += 1) {
    if (t >= times[i] && t <= times[i + 1]) {
      const u = (t - times[i]) / Math.max(times[i + 1] - times[i], 1e-9);
      return targets[i] + (targets[i + 1] - targets[i]) * u;
    }
  }
  return targets[n - 1];
}
function zoomDistance(subjH, frac, tanHalfFov) {
  return subjH / (frac * 2 * tanHalfFov);
}
function clampRange(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function maxStep(xs) {
  let m = 0;
  for (let i = 1; i < xs.length; i += 1) m = Math.max(m, Math.abs(xs[i] - xs[i - 1]));
  return m;
}
function shrinkRanges(lo, hi, scales = [1, 0.75, 0.5, 0.25]) {
  const mid = (lo + hi) / 2;
  return scales.map((s) => [mid - (mid - lo) * s, mid + (hi - mid) * s]);
}
function selectLadder(rWant, rGridAsc, ranges, marginAt, containAt = () => 0, containMax = 0.95, aimAt = () => 0) {
  for (const [lo, hi] of ranges) {
    const ok = (r) => {
      const ty = aimAt(r, lo, hi);
      return marginAt(r, lo, hi, ty) >= 0 && containAt(r, lo, hi, ty) <= containMax;
    };
    if (!rGridAsc.some(ok)) continue;
    const rMin = rGridAsc.find(ok);
    const cands = [...new Set([rWant, ...rGridAsc.filter((r) => r >= rMin - 1e-9)])]
      .filter((r) => r >= rMin - 1e-9)
      .sort((a, b) => Math.abs(a - rWant) - Math.abs(b - rWant));
    const pick = cands.find(ok) ?? rMin;
    return { r: pick, lo, hi, rMin, ty: aimAt(pick, lo, hi) };
  }
  return null;
}
// Scale follow plan (tier-improve loop 11; see zoomFollowRefresh): per
// keyframe, the closest distance in 0.01 steps down from rBase, not below
// max(rFloor, rWantAt(i)), that is still okAt(i, r); then the farthest of
// the +-3 neighbours, then a +-2 mean. okAt must hold at every r farther
// than one where it holds (containment and the rest-relative photo margin
// do), so both smoothing steps keep every keyframe ok: they only move it
// farther. Pure.
function scaleFollowPlan(n, rBase, rFloor, rWantAt, okAt) {
  const win = (xs, i, k) => xs.slice(Math.max(0, i - k), i + k + 1);
  const raw = [];
  for (let i = 0; i < n; i += 1) {
    let best = rBase;
    for (let r = rBase - 0.01; r >= Math.max(rFloor, rWantAt(i)) - 1e-9; r -= 0.01) {
      if (!okAt(i, r)) break;
      best = r;
    }
    raw.push(best);
  }
  const far = raw.map((_, i) => Math.max(...win(raw, i, 3)));
  const smooth = far.map((_, i) => { const w = win(far, i, 2); return w.reduce((a, v) => a + v, 0) / w.length; });
  return { raw, smooth };
}
// Per-frame subject boxes measured from the baked atlas alpha (same >=8
// threshold the builder uses for its silhouette mask).
const followBoxes = measureBoxes(specimen.keyframes, (i, u, v) => subjAlpha(i, u, v));
const followWidths = followBoxes.map((b, i) =>
  b ? (b.x1 - b.x0) * specimen.crop.w : Math.sqrt(specimen.keyframes[i].pixels) / W);
const followTravel = travelReport(specimen.keyframes, followWidths);
const followSubjH = Math.max(...followBoxes.map((b, i) =>
  b ? (b.y1 - b.y0) * specimen.crop.h * worldH : 0), 1e-6);
const followSubjHW = Math.max(...followWidths) / 2 * worldW;
const followTargets = centeredTargets(specimen.keyframes.map((f) => (f.centroid[0] - 0.5) * worldW));
const followTimes = specimen.keyframes.map((f) => f.t);
const followT0 = followTimes[0];
const followT1 = followTimes[followTimes.length - 1];
const follow = {
  active: followTravel.travel, degraded: false, dx: 0, target: 0,
  r: RADIUS, rMin: RADIUS * 0.8, pivMin: 0, pivMax: 0,
  subjHW: followSubjHW, ratio: followTravel.ratio, frac: 0.40, ty: 0,
};
const followState = {
  active: follow.active, targetX: 0, zoom: 1,
  ratio: +followTravel.ratio.toFixed(2), degraded: false,
  pivMin: 0, pivMax: 0, rMin: +follow.rMin.toFixed(3), ty: 0,
};
// Photo-bounded margin at an explicit pivot (like the envelope's
// mirrorShare): the frustum must not leave the photo; the behind
// surround is a blur, not valid backdrop.
function followMargin(piv, r) {
  let margin = Infinity;
  for (const s of [-1, 1]) {
    const yaw = restYaw + s * YAW_SPEC, sx = s * (SX_SPEC + 0.03);
    for (const sy of [-(SY_SPEC + 0.02), SY_SPEC + 0.02]) {
      poseCamera(yaw, sx, sy, r, 0, piv);
      for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const hit = rayPlane(nx, ny, -0.06);
        if (!hit) return -1;
        margin = Math.min(margin,
          worldW / 2 * 0.98 - Math.abs(hit[0]), worldH / 2 * 0.98 - Math.abs(hit[1]));
      }
    }
  }
  return margin;
}
// Joint distance/pivot ladder: widest valid pivot range first, then the
// framing closest to rWant. Validity is always checked at the r actually
// used: a narrow view at the floor can pass where the wider used view
// fails, so the floor alone never decides (that was the old bug).
// Vertical containment (judge: "antenna tip cropped at top edge"): max
// |NDC y| of every present subject box over the orbit extremes, both
// subject depths and the autoplay push-in, with the real camera. The
// ladder only zooms while the whole subject stays inside the view (<=0.95).
// HEADROOM-V1: re-aim-first containment (headroomShift mirrors
// viewer/headroom-math.mjs verbatim; the rest is product glue).
function headroomShift(yBot, yTop, headroom) {
  const mid = (yBot + yTop) / 2;
  const lim = Math.max(0, headroom);
  return Math.min(lim, Math.max(-lim, mid));
}
// World-y span of the present subject over all keyframes (same cy/hh the
// containment probe uses). Null when no keyframe measured a box.
function subjectSpanY() {
  let yBot = Infinity, yTop = -Infinity;
  for (let i = 0; i < K; i += 1) {
    const f = specimen.keyframes[i], b = followBoxes[i];
    if (!b) continue;
    const hh = (b.y1 - b.y0) * specimen.crop.h * worldH / 2;
    const cy = (0.5 - (f.box[1] + f.box[3]) / 2) * worldH;
    if (cy - hh < yBot) yBot = cy - hh;
    if (cy + hh > yTop) yTop = cy + hh;
  }
  return yBot <= yTop ? [yBot, yTop] : null;
}
// Re-aim first: centre the span, clamped to the rim-safe headroom.
// Shifting the look target by ty moves the plate footprint ~1:1, so the
// shift must fit inside the unshifted margin (else plate edges show).
// The ladder re-proves marginAt with the shifted target exactly.
function headroomTY(r, lo, hi) {
  const span = subjectSpanY();
  if (!span) return 0;
  const m = Math.max(0, Math.min(followMargin(lo, r), followMargin(hi, r)));
  return headroomShift(span[0], span[1], m);
}
// Photo-bounded margin with a vertical look-target shift (same sweep as
// followMargin, re-posed; frameRefresh keeps calling followMargin = ty 0).
function followMarginTy(piv, r, ty) {
  let margin = Infinity;
  for (const s of [-1, 1]) {
    const yaw = restYaw + s * YAW_SPEC, sx = s * (SX_SPEC + 0.03);
    for (const sy of [-(SY_SPEC + 0.02), SY_SPEC + 0.02]) {
      poseCamera(yaw, sx, sy, r, 0, piv, ty);
      for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const hit = rayPlane(nx, ny, -0.06);
        if (!hit) return -1;
        margin = Math.min(margin,
          worldW / 2 * 0.98 - Math.abs(hit[0]), worldH / 2 * 0.98 - Math.abs(hit[1]));
      }
    }
  }
  return margin;
}
const _containV = new THREE.Vector3();
function subjectContainYAt(r, lo, hi, ty = 0) {
  let worst = 0;
  for (let i = 0; i < K; i += 1) {
    const f = specimen.keyframes[i], b = followBoxes[i];
    if (!b) continue;
    const hw = (b.x1 - b.x0) * specimen.crop.w * worldW / 2;
    const hh = (b.y1 - b.y0) * specimen.crop.h * worldH / 2;
    const cx = (f.centroid[0] - 0.5) * worldW;
    const cy = (0.5 - (f.box[1] + f.box[3]) / 2) * worldH;
    const piv = clampRange(followTargets[i], lo, hi);
    for (const s of [-1, 1]) for (const sy of [-(SY_SPEC + 0.02), SY_SPEC + 0.02]) for (const rr of [r, r * 0.97]) {
      poseCamera(restYaw + s * YAW_SPEC, s * (SX_SPEC + 0.03), sy, rr, 0, piv, ty);
      for (const z of [0.0, 0.09]) for (const y of [cy - hh, cy + hh]) for (const x of [cx - hw, cx + hw]) {
        worst = Math.max(worst, Math.abs(_containV.set(x, y, z).project(camera).y));
      }
    }
  }
  return worst;
}
function subjectContainY(r, lo, hi) {
  return subjectContainYAt(r, lo, hi, 0);
}
function followRefresh() {
  if (!followTravel.travel) { follow.active = false; followState.active = false; return; }
  // HEADROOM-V1: desktop targets the close framing (subject ~80% of view
  // height) so the ladder holds subject size; containment is met by
  // re-aiming first and only zooms out past rWant when the subject is
  // genuinely taller than the frame allows. Phone keeps 0.35 (band fix).
  follow.frac = innerWidth < innerHeight ? 0.35 : 0.80;
  const rWant = Math.min(RADIUS, zoomDistance(followSubjH, follow.frac, FIT_TAN));
  const plo = Math.min(...followTargets), phi = Math.max(...followTargets);
  const rGrid = [];
  for (let i = 10; i <= 20; i += 1) rGrid.push((i / 20) * RADIUS);
  const marginAt = (r, a, b, ty = 0) => Math.min(followMarginTy(a, r, ty), followMarginTy(b, r, ty));
  const aimAt = (r, a, b) => headroomTY(r, a, b);
  const pick = selectLadder(rWant, rGrid, shrinkRanges(plo, phi, [1, 0.75, 0.5, 0.25]), marginAt, subjectContainYAt, 0.95, aimAt);
  if (!pick) {
    follow.active = false; follow.degraded = true;
    followState.active = false; followState.degraded = true;
    follow.ty = 0; followState.ty = 0;
    return;
  }
  follow.rMin = pick.rMin; follow.pivMin = pick.lo; follow.pivMax = pick.hi;
  follow.r = pick.r;
  follow.ty = pick.ty;
  follow.degraded = false;
  followState.active = true; followState.degraded = false;
  followState.pivMin = +follow.pivMin.toFixed(3); followState.pivMax = +follow.pivMax.toFixed(3);
  followState.rMin = +follow.rMin.toFixed(3);
  followState.zoom = +(RADIUS / follow.r).toFixed(3);
  followState.ty = +follow.ty.toFixed(3);
}
// ── Scale follow (tier-improve loop 11) ──
// A subject that walks toward the lens fails the ladder above at every
// constant zoom: its last, largest poses already touch the frame at the
// rest distance (grizzly: legacy containment 1.013), so the whole clip
// played at the rest distance and the far poses filled ~38% of the view.
// Here the distance follows the clip time instead. Each keyframe gets the
// closest distance (down to the user zoom limit, and no closer than its
// subject, median height over +-3 keyframes, at ZOOM_FRAC of the view
// height) at which its own measured box stays inside 0.95 of the view on
// both axes at the orbit extremes, with no more of the view off the photo
// than at rest. Then the farthest of the +-3 neighbours wins (the camera
// eases out before a near pose, never late) and a +-2 mean smooths the
// curve; both only move a keyframe farther, so each keeps its containment.
// The pivot stays the rest pivot. Applied as a scale on the viewer's own
// distance (user zoom and autoplay keep working); 1 everywhere else, so
// in-place clips, ladder-accepted travel clips and phones are unchanged.
const ZOOM_FRAC = 0.5;
const zoomFollow = { active: false, rs: [], rBase: RADIUS, s: 1 };
const _zfV = new THREE.Vector3();
function subjectContainAt(i, r, piv) {
  const b = followBoxes[i];
  if (!b) return 0;
  const c = specimen.crop;
  const xs = [(c.x + b.x0 * c.w - 0.5) * worldW, (c.x + b.x1 * c.w - 0.5) * worldW];
  const ys = [(0.5 - (c.y + b.y1 * c.h)) * worldH, (0.5 - (c.y + b.y0 * c.h)) * worldH];
  let worst = 0;
  for (const s of [-1, 1]) for (const sy of [-(SY_SPEC + 0.02), SY_SPEC + 0.02]) for (const rr of [r, r * 0.97]) {
    poseCamera(restYaw + s * YAW_SPEC, s * (SX_SPEC + 0.03), sy, rr, 0, piv);
    for (const z of [0.0, 0.09]) for (const y of ys) for (const x of xs) {
      _zfV.set(x, y, z).project(camera);
      worst = Math.max(worst, Math.abs(_zfV.x), Math.abs(_zfV.y));
    }
  }
  return worst;
}
function zoomFollowRefresh() {
  zoomFollow.active = false; zoomFollow.rs = []; zoomFollow.s = 1; zoomFollow.why = "";
  if (!followTravel.travel || follow.active || fitView.active || innerWidth < innerHeight) {
    zoomFollow.why = !followTravel.travel ? "in-place" : follow.active ? "ladder" : "phone";
    return;
  }
  const piv = fitPivotX();
  const rBase = frameState.active ? frameState.r : RADIUS;
  const rFloor = frameState.active ? Math.min(RADIUS * 0.8, frameState.r) : RADIUS * 0.8; // clampView's limit
  // A closer camera on the same pivot sees less of the photo, so the photo
  // margin can only improve on the rest view's (checked, not assumed).
  const m0 = Math.min(0, followMarginTy(piv, rBase, 0));
  const hs = followBoxes.map((b) => (b ? (b.y1 - b.y0) * specimen.crop.h * worldH : 0));
  const near = (i) => hs.slice(Math.max(0, i - 3), i + 4).filter((v) => v > 0);
  const { raw, smooth } = scaleFollowPlan(K, rBase, rFloor,
    (i) => (followBoxes[i] ? zoomDistance(median(near(i)), ZOOM_FRAC, FIT_TAN) : rBase),
    (i, r) => followMarginTy(piv, r, 0) >= m0 && subjectContainAt(i, r, piv) <= 0.95);
  zoomFollow.raw = raw;
  if (!smooth.some((r) => r < rBase - 1e-3)) { zoomFollow.why = "no keyframe can zoom"; return; }
  Object.assign(zoomFollow, { active: true, rs: smooth, rBase });
  zoomFollow.s = zoomScaleAt(0);
}
function zoomScaleAt(tRel) {
  if (!zoomFollow.active) return 1;
  const t = reducedMotion.matches ? (followT0 + followT1) / 2 : followT0 + tRel;
  return targetAt(zoomFollow.rs, followTimes, t) / zoomFollow.rBase;
}
// ── Desktop framing (pure helpers mirror viewer/framing-math.mjs) ──
// v2 orbit-range gate: embedded copy of the framing-math.mjs grid block
// (K_LADDER..rangeRatioPp, `export` stripped). Drift-checked verbatim in
// framing-math.test.mjs against view-basic-framing-v2.patch. Pinhole
// twins of poseCamera/rayPlane for the gate math only; three.js stays
// the renderer. See FRAMING.md v2 for the rule.
const K_LADDER = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2];
const GRID_COLS = 24;
const GRID_ROWS = 14;
const RANGE_MIN = 0.85;
function gridPose(piv, r, yaw, sx, sy, az, restPitch) {
  const cp = Math.cos(restPitch);
  const sp = Math.sin(restPitch);
  const pos = [
    piv + r * cp * Math.sin(yaw) + sx,
    r * sp + sy,
    az + r * cp * Math.cos(yaw),
  ];
  return { pos, tgt: [piv, 0, az] };
}
function gridHit(nx, ny, pos, tgt, aspect, tanH, pz) {
  let zx = pos[0] - tgt[0];
  let zy = pos[1] - tgt[1];
  let zz = pos[2] - tgt[2];
  const zl = Math.hypot(zx, zy, zz);
  zx /= zl; zy /= zl; zz /= zl;
  let xx = zz, xy = 0, xz = -zx;
  const xl = Math.hypot(xx, xy, xz);
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  let dx = xx * (nx * tanH * aspect) + yx * (ny * tanH) + zx * -1;
  let dy = xy * (nx * tanH * aspect) + yy * (ny * tanH) + zy * -1;
  let dz = xz * (nx * tanH * aspect) + yz * (ny * tanH) + zz * -1;
  const dl = Math.hypot(dx, dy, dz);
  dx /= dl; dy /= dl; dz /= dl;
  if (Math.abs(dz) < 1e-9) return null;
  const t = (pz - pos[2]) / dz;
  if (t < 0) return null;
  return [pos[0] + dx * t, pos[1] + dy * t];
}
function gridSideMargin(piv, aspect, G, k, s) {
  let m = Infinity;
  const yaw = G.restYaw + s * G.yawSpec * k;
  const sx = s * (G.sxSpec * k + 0.03);
  for (const sy of [-(G.sySpec * k + 0.02), G.sySpec * k + 0.02]) {
    for (const r of [G.rRest * 0.85, G.rRest]) {
      const { pos, tgt } = gridPose(piv, r, yaw, sx, sy, G.az, G.restPitch);
      for (let iy = 0; iy < GRID_ROWS; iy += 1) {
        for (let ix = 0; ix < GRID_COLS; ix += 1) {
          const nx = -1 + (2 * ix + 1) / GRID_COLS;
          const ny = -1 + (2 * iy + 1) / GRID_ROWS;
          const hit = gridHit(nx, ny, pos, tgt, aspect, G.tanH, G.pz);
          if (!hit) return -1;
          m = Math.min(m, G.footHW - Math.abs(hit[0]), G.footHH - Math.abs(hit[1]));
        }
      }
    }
  }
  return m;
}
function sideRangeK(piv, aspect, G) {
  const out = { 1: 0, "-1": 0 };
  for (const s of [1, -1]) {
    for (const k of K_LADDER) {
      if (gridSideMargin(piv, aspect, G, k, s) >= 0) { out[s] = k; break; }
    }
  }
  return out;
}
function rangeRatioPp(piv, aspect, G) {
  const leg = sideRangeK(0, aspect, G);
  const fra = sideRangeK(piv, aspect, G);
  const denom = leg[1] + leg[-1];
  if (denom <= 0) return 0;
  return (fra[1] + fra[-1]) / denom;
}
function frameWanted() {
  const subjW = FIT_U.x1w - FIT_U.x0w, subjH = FIT_U.yTop - FIT_U.yBot;
  const aspect = fitView.aspect; // == window aspect on desktop unless a narrow source pillarboxes
  const rH = subjH / (0.45 * 2 * FIT_TAN);
  const rW = subjW / (0.45 * 2 * FIT_TAN * aspect);
  return Math.max(RADIUS / 1.8, Math.min(RADIUS, Math.min(rH, rW)));
}
function frameRefresh() {
  frameState.active = false; frameState.fallback = false;
  frameState.pivX = 0; frameState.r = RADIUS; frameState.zoom = 1; frameState.range = 1;
  if (fitView.active) return; // phones byte-identical
  if (typeof follow !== "undefined" && follow.active) return; // travel defers to follow
  if (innerWidth < innerHeight) return; // desktop only (aspect >= 1)
  // v2 orbit-range gate (FRAMING.md v2): the envelope measures rim at its
  // fixed push-in pair, never at the framed r, so a pivot that fails there
  // cannot be rescued by zoom. Below RANGE_MIN peak-to-peak vs legacy,
  // keep legacy (unpivot, no zoom): the orbit keeps 100% of its range.
  const frameG = { restYaw, restPitch, yawSpec: YAW_SPEC, sxSpec: SX_SPEC, sySpec: SY_SPEC, footHW: worldW / 2, footHH: worldH / 2, tanH: FIT_TAN, rRest: RADIUS, az: 0.05, pz: -0.06 };
  frameState.range = +rangeRatioPp(FIT_PIVOT_X, fitView.aspect, frameG).toFixed(3);
  if (frameState.range < RANGE_MIN) { frameState.fallback = true; return; }
  const rWant = frameWanted(), pivX = FIT_PIVOT_X, floor = RADIUS / 1.8;
  for (let r = rWant; r >= floor - 1e-9; r -= 0.01) {
    const rr = +Math.max(r, floor).toFixed(4);
    if (followMargin(pivX, rr) >= 0) {
      frameState.pivX = pivX; frameState.r = rr; frameState.zoom = +(RADIUS / rr).toFixed(3);
      frameState.active = (rr < RADIUS - 1e-9) || (Math.abs(pivX) > 1e-9);
      return;
    }
  }
  frameState.fallback = true; // even max zoom fails: legacy (pivot 0, R)
}
// Per-tick follow: smoothed target clamped to the validated pivot range;
// fast ease (~100 ms, inside the 150 ms budget), snap under reduced
// motion, which instead holds a static mid-clip framing (no animation).
function followTick(dt, tRel) {
  if (!follow.active) return;
  const t = reducedMotion.matches
    ? (followT0 + followT1) / 2
    : followT0 + tRel;
  follow.target = clampRange(targetAt(followTargets, followTimes, t), follow.pivMin, follow.pivMax);
  const want = follow.target - fitPivotX();
  if (reducedMotion.matches) follow.dx = want;
  else follow.dx += (want - follow.dx) * Math.min(1, dt * 10);
  followState.targetX = +follow.target.toFixed(3);
}
function composeCamera() {
  const PIV = fitPivotX() + follow.dx; // follow delta: 0 unless travelling
  if (zoomFollow.active) zoomFollow.s = zoomScaleAt(clock.t); // snap, like the follow snap
  const R = view.r * zoomFollow.s; // scale follow: 1 unless a refused travel clip
  camera.position.set(
    PIV + R * Math.cos(restPitch) * Math.sin(view.yaw) + view.sx,
    R * Math.sin(restPitch) + view.sy,
    lookZ.v + R * Math.cos(restPitch) * Math.cos(view.yaw)
  );
  camera.lookAt(PIV, FIT_PIVOT_Y + (follow.active ? follow.ty : 0), lookZ.v);
}
// Numeric coverage check: at every extreme of the allowed view, all four
// viewport corners must still hit the plate (photo region, 2% margin).
// eval/shoot asserts __basic.coverage().ok after every viewer change.
const _ray = new THREE.Raycaster();
function poseCamera(yaw, sx, sy, r, az, piv, lookY) {
  const PIV = piv !== undefined ? piv : fitPivotX(); // 0 on desktop: legacy coverage byte-identical
  camera.position.set(
    PIV + r * Math.cos(restPitch) * Math.sin(yaw) + sx,
    r * Math.sin(restPitch) + sy,
    az + r * Math.cos(restPitch) * Math.cos(yaw)
  );
  camera.lookAt(PIV, lookY !== undefined ? lookY : FIT_PIVOT_Y, az);
  camera.updateMatrixWorld();
}
function rayPlane(nx, ny, pz) {
  // NDC point -> hit on the z=pz plane (null when the ray misses it).
  _ray.setFromCamera({ x: nx, y: ny }, camera);
  const o = _ray.ray.origin, d = _ray.ray.direction;
  if (Math.abs(d.z) < 1e-6) return null;
  const t = (pz - o.z) / d.z;
  if (t < 0) return null;
  return [o.x + d.x * t, o.y + d.y * t];
}
function poseMargin(yaw, sx, sy, r, hits) {
  poseCamera(yaw, sx, sy, r, 0);
  let margin = Infinity;
  for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const hit = rayPlane(nx, ny, -0.06);
    if (!hit) return -1;
    // deepest plate surface (conservative spread); relief never goes deeper
    const [px, py] = hit;
    if (hits) hits.push([+px.toFixed(3), +py.toFixed(3)]);
    margin = Math.min(margin, plateW / 2 * 0.98 - Math.abs(px), plateH / 2 * 0.98 - Math.abs(py));
  }
  return margin;
}
function mirrorShare(yaw, sx, sy, r) {
  // Visible-frame share outside the PHOTO: any rim sampling at all,
  // counted as damage. Not the expanded behind canvas: its surround is a
  // push-pull blur and the front plate there is clamped edge texels, so
  // either reads as a smeared band at the orbit extremes (slovakdeer QA).
  // 24x14 NDC subgrid to the plate.
  poseCamera(yaw, sx, sy, r, 0.05);
  let mirror = 0, clamp = 0, gap = 0, total = 0;
  for (let iy = 0; iy < 14; iy += 1) {
    for (let ix = 0; ix < 24; ix += 1) {
      const hit = rayPlane(-1 + (2 * ix + 1) / 24, -1 + (2 * iy + 1) / 14, -0.06);
      total += 1;
      if (!hit) { gap += 1; continue; }
      if (Math.abs(hit[0]) > worldW / 2 || Math.abs(hit[1]) > worldH / 2) {
        if (hit[1] < -worldH / 2) clamp += 1;
        else mirror += 1;
      }
    }
  }
  return { mirror: mirror / total, clamp: clamp / total, gap: gap / total };
}
function stretchShare(yawAbs) {
  // Screen-area share of plate quads stretched past 2.5x their rest size
  // at this yaw (rest-relative, from the specimen's own depth steps),
  // AREA-weighted by rest facing: edge-on walls cover few pixels even
  // when they stretch far, so count-share would over-gate relief scenes.
  const { deltas, qnz, quadW, quads } = plateStats;
  const th = yawAbs + restPitch, tr = restPitch;
  const a = Math.tan(th) / quadW, ar = Math.tan(tr) / quadW;
  const c = Math.cos(th), cr = Math.cos(tr);
  let flagged = 0, total = 0;
  for (let i = 0; i < quads; i += 1) {
    const facing = Math.max(qnz[i], 0.02);
    total += facing;
    const d = deltas[i];
    if (((1 + d * a) / c) / ((1 + d * ar) / cr) > 2.5) flagged += facing;
  }
  return flagged / total;
}
function smearShare(yawAbs) {
  // Smear bands: quads too gradual to drop (below the GAP cut) but steep
  // enough to stretch-smear texture and shade dark at oblique views.
  // Absolute growth in [1.3, 2.5) with darker-than-flat shading.
  const { deltas, qdark, quadW, quads } = plateStats;
  const t = Math.tan(yawAbs + restPitch) / quadW;
  const c = Math.cos(yawAbs + restPitch);
  let flagged = 0;
  for (let i = 0; i < quads; i += 1) {
    const g = (1 + deltas[i] * t) / c;
    if (g >= 1.3 && g < 2.5 && qdark[i] > 0.35) flagged += 1;
  }
  return flagged / quads;
}
function darkVisible(yawAbs) {
  // Visible-frame share of wall-darkness at this yaw (parallel-projection
  // approx with the rest pitch): faces turning toward the camera count by
  // projected area, weighted by relative darkness under the scene lights.
  const { qnx, qny, qnz, qdark, quads } = plateStats;
  const sy = Math.sin(yawAbs) * Math.cos(restPitch);
  const cy = Math.cos(yawAbs) * Math.cos(restPitch);
  const sp = Math.sin(restPitch);
  let dark = 0, area = 0;
  for (let i = 0; i < quads; i += 1) {
    const facing = Math.max(0, qnx[i] * sy + qny[i] * sp + qnz[i] * cy);
    area += facing;
    dark += facing * qdark[i];
  }
  return area > 0 ? dark / area : 0;
}
function seamRunPx() {
  // Longest connected run of dropped (discontinuity) quads, 4-connected,
  // in ~screen px at rest zoom — FOREGROUND edges only (|z-bgZ| > AMP/4).
  // Blanket noise across the background (DAV2 grain past the GAP cut)
  // forms huge runs that read as nothing (the backing matches there); the
  // visible seams the fix list names (trunk diagonals, room edges, mug
  // lips) are all foreground silhouettes. REPORTED, not gated: outlines
  // read correctly as crisp occlusion edges at every pose including rest.
  const { deltas, gapCut, nx, ny, bgZ, grid } = plateStats;
  const n = nx * ny;
  const flag = new Uint8Array(n);
  const fgCut = AMP / 4;
  for (let qy = 0; qy < ny; qy += 1) for (let qx = 0; qx < nx; qx += 1) {
    const i = qy * nx + qx;
    if (deltas[i] <= gapCut) continue;
    // Foreground silhouette only: at least one corner stands off bg.
    if (Math.abs(grid[qy][qx] - bgZ) > fgCut ||
        Math.abs(grid[qy][qx + 1] - bgZ) > fgCut ||
        Math.abs(grid[qy + 1][qx] - bgZ) > fgCut ||
        Math.abs(grid[qy + 1][qx + 1] - bgZ) > fgCut) flag[i] = 1;
  }
  const seen = new Uint8Array(n);
  const stack = [];
  let best = 0;
  const push = (c) => { if (flag[c] && !seen[c]) { seen[c] = 1; stack.push(c); } };
  for (let s = 0; s < n; s += 1) {
    if (!flag[s] || seen[s]) continue;
    let run = 0;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const c = stack.pop(); run += 1;
      const cx = c % nx;
      if (cx > 0) push(c - 1);
      if (cx < nx - 1) push(c + 1);
      if (c >= nx) push(c - nx);
      if (c < n - nx) push(c + nx);
    }
    if (run > best) best = run;
  }
  return +(best * 7.6).toFixed(1); // quad ~= 0.01 world ~= 7.6px at rest
}
function envelopeBad(yawMax, sxMax, syMax) {
  // Automatic per-specimen envelope from objective measures only (no hand
  // k): the worst visible-frame share OUTSIDE the footprint (rim +
  // uncovered gap; both must be exactly 0) plus the stretched-triangle
  // screen-area share (must stay under 2%) over the reachable extremes
  // at both ends of the push-in. The ghost metric is pose-independent:
  // it gates the BUILD (decline past the limit), not the step. Shading
  // diagnostics and the seam census ride along (reported, not gated).
  let worst = { bad: 0, mirror: 0, clamp: 0, gap: 0, stretch: 0, dark: 0, smear: 0 };
  const st = stretchShare(yawMax);
  const darkAdd = Math.max(0, darkVisible(yawMax) - darkVisible(0));
  const sm = smearShare(yawMax);
  for (const s of [-1, 1]) {
    const yaw = restYaw + s * yawMax, sx = s * (sxMax + 0.03);
    for (const sy of [-(syMax + 0.02), syMax + 0.02])
      for (const r of [RADIUS * 0.85, RADIUS]) {
        const m = mirrorShare(yaw, sx, sy, r);
        const bad = m.mirror + m.clamp + m.gap;
        if (bad > worst.bad) worst.bad = bad;
        if (m.mirror > worst.mirror) worst.mirror = m.mirror;
        if (m.clamp > worst.clamp) worst.clamp = m.clamp;
        if (m.gap > worst.gap) worst.gap = m.gap;
      }
  }
  worst.stretch = st;
  worst.dark = +darkAdd.toFixed(4);
  worst.smear = +sm.toFixed(4);
  worst.seamPx = seamRunPx();
  return worst;
}
// The automatic envelope: the largest k with zero outside-footprint
// sampling AND stretched-triangle area under 2%. Low-relief scenes keep
// a wide window; deep relief gets less. ?path=auto, drag, embed and the
// orbit test hook all derive from these, so they stay inside by
// construction. The manual cap (--envelope-k) only ever tightens.
resize(); // aspect must be final before measuring (PerspectiveCamera starts at 1.0)
// Per-specimen default cap (k-ladder pick, pipeline --envelope-k, default
// 1): search downward from the cap instead of from the full window.
const maxK = Math.min(1, Math.max(0.2, specimen.envelopeK ?? 1));
for (const k of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2].filter((v) => v <= maxK + 1e-9)) {
  const w = envelopeBad(YAW_SPEC * k, SX_SPEC * k, SY_SPEC * k);
  if (w.bad === 0 && w.stretch < 0.02) {
    YAW = YAW_SPEC * k; SLIDE_X = SX_SPEC * k; SLIDE_Y = SY_SPEC * k;
    envelope = {
      k, yawDeg: +(YAW * 180 / Math.PI).toFixed(2),
      sx: +SLIDE_X.toFixed(3), sy: +SLIDE_Y.toFixed(3),
      mirror: +w.mirror.toFixed(4), clamp: +w.clamp.toFixed(4), gap: +w.gap.toFixed(4),
      stretch: +w.stretch.toFixed(4), bad: +w.bad.toFixed(4),
      seamPx: w.seamPx,
    };
    break;
  }
  if (k === 0.2) {
    // Even the tightest tried window fails: hold it anyway (never
    // looser) and let the shoot gate fail loudly with the numbers.
    YAW = YAW_SPEC * k; SLIDE_X = SX_SPEC * k; SLIDE_Y = SY_SPEC * k;
    envelope = {
      k, yawDeg: +(YAW * 180 / Math.PI).toFixed(2),
      sx: +SLIDE_X.toFixed(3), sy: +SLIDE_Y.toFixed(3),
      mirror: +w.mirror.toFixed(4), clamp: +w.clamp.toFixed(4), gap: +w.gap.toFixed(4),
      stretch: +w.stretch.toFixed(4), bad: +w.bad.toFixed(4),
      seamPx: w.seamPx,
    };
  }
}
function frustumCoverage() {
  // Reachable extremes (drag/path/embed couple yaw to slide, same sign)
  // plus parallax slack. The look-at is plate-centred, so anchors don't
  // roam: one evaluation covers all times.
  let worst = Infinity, worstPose = null;
  for (const s of [-1, 1]) {
    const yaw = restYaw + s * YAW, sx = s * (SLIDE_X + 0.03);
    for (const sy of [-(SLIDE_Y + 0.02), SLIDE_Y + 0.02])
      for (const r of [RADIUS * 0.85, RADIUS]) {
        const hits = [];
        const m = poseMargin(yaw, sx, sy, r, hits);
        if (m < worst) { worst = m; worstPose = { yaw: +yaw.toFixed(3), sx, sy, r: +r.toFixed(3), hits }; }
      }
  }
  return { ok: worst >= 0, margin: +worst.toFixed(4), worst: worstPose, stretch: envelopeBad(YAW, SLIDE_X, SLIDE_Y), envelope };
}
// Drag strafes: horizontal dx drives slide (+-0.12) with yaw coupled to it
// (+-8 deg at full slide); vertical dy drives the y slide (+-0.05).
let dragging = false, dragStart = null;
const el = renderer.domElement;
el.style.touchAction = "none";
el.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  dragging = true;
  pathOff = true;
  dragStart = { x: e.clientX, y: e.clientY, sx: viewT.sx, sy: viewT.sy };
  el.setPointerCapture?.(e.pointerId);
});
el.addEventListener("pointermove", (e) => {
  if (!dragging || !dragStart) return;
  const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
  viewT.sx = dragStart.sx + dx * 0.0006;
  viewT.yaw = restYaw + (THREE.MathUtils.clamp(viewT.sx, -SLIDE_X, SLIDE_X) / SLIDE_X) * YAW;
  viewT.sy = dragStart.sy + dy * 0.00025;
  clampView(viewT);
});
const endDrag = () => { dragging = false; dragStart = null; };
el.addEventListener("pointerup", endDrag);
el.addEventListener("pointercancel", endDrag);

// Pointer parallax (skipped while dragging, in embed the host drives it).
const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
addEventListener("pointermove", (e) => {
  if (EMBED || reducedMotion.matches) return;
  parallax.tx = (e.clientX / innerWidth - 0.5) * 2;
  parallax.ty = (e.clientY / innerHeight - 0.5) * 2;
});
const embedLook = { x: 0, y: 0, applied: "" };
function applyEmbedLook() {
  if (!EMBED) return;
  const k = `${embedLook.x.toFixed(4)},${embedLook.y.toFixed(4)}`;
  if (embedLook.applied === k) return;
  embedLook.applied = k;
  viewT.sx = embedLook.x * SLIDE_X;
  viewT.sy = embedLook.y * SLIDE_Y;
  viewT.yaw = restYaw + embedLook.x * YAW;
  clampView(viewT);
}

// ── Time: scroll runs it, the trail follows ────────────────────────────
const times = specimen.keyframes.map((f) => f.t);
const T0 = times[0], DURATION = Math.max(times[K - 1] - T0, 0.1);
const clock = { t: 0, playing: !reducedMotion.matches && !EMBED };
// Fewer ghosts when the subject fills the frame: overlapping full-frame
// quads stack into visible doubles (cat), while small subjects (cougar)
// read as motion blur either way.
const TRAIL = specimen.crop.w * specimen.crop.h > 0.5 ? 3 : 5; // recent poses kept visible, fading back
function frameAt(t) {
  let best = 0;
  for (let i = 0; i < K; i += 1) if (Math.abs(times[i] - T0 - t) < Math.abs(times[best] - T0 - t)) best = i;
  return best;
}
// Sub-keyframe motion (tier-improve loop 7): poses sample the clip at
// 5-6 Hz, so a nearest-pose swap reads as stop-motion. Between keyframes i
// and i+1 both poses slide along the centroid path (continuous body motion)
// and the incoming pose fades in over the middle of the interval on top of
// the outgoing one, which fades out late so coverage stays near opaque.
// Zero pipeline cost: same atlas cells, same keyframes. On by default after
// the A/B (basic/EXPERIMENTS.md #1); ?blend=0 restores the nearest-pose swap.
const BLEND = !/[?&]blend=0\b/.test(location.search);
const cen = specimen.keyframes.map((f) => new THREE.Vector2((f.centroid[0] - 0.5) * worldW, (0.5 - f.centroid[1]) * worldH));
function blendAt(t) {
  if (!BLEND || K < 2) return { i: frameAt(t), j: -1, f: 0 };
  const tt = T0 + t;
  let i = 0;
  while (i < K - 2 && times[i + 1] <= tt) i += 1;
  const span = times[i + 1] - times[i];
  const f = span > 1e-6 ? THREE.MathUtils.clamp((tt - times[i]) / span, 0, 1) : 0;
  return { i, j: i + 1, f };
}
// Flow warp (loop 10): per-vertex world displacement for keyframe pair p
// (role 0 = outgoing pose p, fwd field; role 1 = incoming pose p+1, bwd
// field). Mesh vertex (ix, iy) of an (nx+1) x (ny+1) grid samples the
// gx x gy field bilinearly with node 0 on the cell's left/top edge, as
// flow.py samples it. sx, sy turn cell px into world units (y flips).
function flowVertexDisp(field, p, role, nx, ny, sx, sy) {
  const { q, gx, gy, scale } = field;
  const base = p * gy * gx * 4 + role * 2;
  const n = (nx + 1) * (ny + 1), out = new Float32Array(n * 2);
  for (let k = 0; k < n; k += 1) {
    const u = ((k % (nx + 1)) / nx) * (gx - 1), v = (Math.floor(k / (nx + 1)) / ny) * (gy - 1);
    const x0 = Math.min(gx - 2, Math.floor(u)), y0 = Math.min(gy - 2, Math.floor(v));
    const tx = u - x0, ty = v - y0;
    for (let c = 0; c < 2; c += 1) {
      const at = (x, y) => q[base + (y * gx + x) * 4 + c];
      const val = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
      out[k * 2 + c] = c === 0 ? val * scale * sx : -val * scale * sy;
    }
  }
  return out;
}
const warpCache = new Map();
function warpDisp(p, role) {
  const key = p * 2 + role;
  if (!warpCache.has(key)) {
    const { nx, ny } = subjPlanes[p + role].userData.grid;
    if (warpCache.size >= 8) warpCache.delete(warpCache.keys().next().value);
    warpCache.set(key, flowVertexDisp(flowField, p, role, nx, ny, cropWU / cellW, cropHU / cellH));
  }
  return warpCache.get(key);
}
const warpedMeshes = new Set();
function applyWarp(i, disp, s) {
  const mesh = subjPlanes[i], pos = mesh.geometry.attributes.position, b = mesh.userData.bxy;
  if (!disp || s <= 0) {
    if (!warpedMeshes.has(i)) return;
    for (let k = 0; k < pos.count; k += 1) pos.setXY(k, b[k * 2], b[k * 2 + 1]);
    warpedMeshes.delete(i);
  } else {
    for (let k = 0; k < pos.count; k += 1) pos.setXY(k, b[k * 2] + s * disp[k * 2], b[k * 2 + 1] + s * disp[k * 2 + 1]);
    warpedMeshes.add(i);
  }
  pos.needsUpdate = true;
}
// Pose blend (tier-improve loop 12): the outgoing pose stays opaque under
// the incoming one until the incoming is opaque, so the body never turns
// see-through mid-blend (both half-faded let the scene show through the
// bear). The flow warp carries the shape; the texture hand-over is a short
// window in the middle, where the two warped shapes agree best.
const BLEND_UNDER = params.get("blendUnder") !== "0";
const BLEND_A = Number(params.get("blendA") ?? (BLEND_UNDER ? 0.45 : 0.2));
const BLEND_B = Number(params.get("blendB") ?? (BLEND_UNDER ? 0.55 : 0.8));
// f in 0..1 between two keyframes -> incoming and outgoing opacity
function blendWeights(f) {
  const x = Math.min(1, Math.max(0, (f - BLEND_A) / Math.max(1e-6, BLEND_B - BLEND_A)));
  const wIn = x * x * (3 - 2 * x);
  return { wIn, outW: BLEND_UNDER ? (wIn >= 1 ? 0 : 1) : 1 - wIn ** 4 };
}
function showFrame(cur, blend = null) {
  if (flowField) {
    // only the two poses of the active pair are warped; others rest
    const jj = blend && blend.j === cur + 1 ? blend.j : -1, ff = jj >= 0 ? blend.f : 0;
    for (const i of [...warpedMeshes]) if (jj < 0 || (i !== cur && i !== jj)) applyWarp(i, null, 0);
    if (jj >= 0) {
      applyWarp(cur, warpDisp(cur, 0), ff);
      applyWarp(jj, warpDisp(cur, 1), 1 - ff);
    }
  }
  const j = blend && blend.j >= 0 ? blend.j : -1;
  const f = j >= 0 ? blend.f : 0;
  const bw = j >= 0 ? blendWeights(f) : { wIn: 0, outW: 1 };
  const wIn = bw.wIn;
  const ghosts = momentsOn ? momentGhosts(cur) : null;
  for (const [i, p] of momentPts) if (!ghosts || !ghosts.has(i) || (trailOn && cur - i < TRAIL)) p.visible = false;
  subjPlanes.forEach((mesh, i) => {
    mesh.position.copy(mesh.userData.base);
    if (i === j && wIn > 0) {
      // incoming pose: slides from the outgoing pose's place to its own
      const a = subjPlanes[cur].userData.base, b = mesh.userData.base;
      mesh.position.x -= (1 - f) * (cen[j].x - cen[cur].x);
      mesh.position.y -= (1 - f) * (cen[j].y - cen[cur].y);
      mesh.position.z = a.z + (b.z - a.z) * f;
      mesh.visible = true;
      mesh.material.opacity = wIn;
      mesh.material.userData.isGhost = false;
      mesh.material.depthWrite = true;
      mesh.renderOrder = 4;
      return;
    }
    const behind = cur - i;
    if (ghosts && ghosts.has(i) && !(trailOn && behind < TRAIL)) {
      // an earlier moment that stands apart from the present pose
      if (MOMENT_POINTS) {
        mesh.visible = false;
        const p = momentCloud(i);
        p.position.copy(mesh.userData.base);
        p.material.uniforms.opacity.value = Math.min(1, ghosts.get(i) * 2);
        p.material.uniforms.vh.value = renderer.domElement.height;
        p.visible = true;
        return;
      }
      mesh.visible = true;
      mesh.material.opacity = ghosts.get(i);
      mesh.material.userData.isGhost = true;
      mesh.material.depthWrite = false;
      mesh.renderOrder = 2;
      return;
    }
    if (behind < 0 || behind >= TRAIL || (!trailOn && behind > 0)) { mesh.visible = false; return; }
    const present = behind === 0;
    if (present && j >= 0) {
      // outgoing pose slides toward the incoming one (the look-at reads this z)
      const b = subjPlanes[j].userData.base, a = mesh.userData.base;
      mesh.position.x += f * (cen[j].x - cen[cur].x);
      mesh.position.y += f * (cen[j].y - cen[cur].y);
      mesh.position.z = a.z + (b.z - a.z) * f;
    }
    const outW = present && j >= 0 ? bw.outW : 1;
    if (present && outW <= 0.002) { mesh.visible = false; return; }
    mesh.visible = true;
    mesh.material.opacity = present ? outW : 0.30 * (1 - behind / TRAIL);
    // Edge softness lives in the shader remap (same for ghosts); only
    // depth-write differs so ghosts never occlude the present. While the
    // incoming pose draws over it, the outgoing one must not occlude it.
    mesh.material.userData.isGhost = !present;
    mesh.material.depthWrite = present && !(j >= 0 && wIn > 0);
    mesh.renderOrder = present ? 3 : 2;
  });
}

// Ghost trail is OFF by default (it reads as doubled legs on bright
// ground); the dock toggle (and `t`) turns it on. Present pose always shows.
let trailOn = false;
const trailBtn = $("#trail");
const setTrail = (on) => {
  trailOn = on;
  trailBtn.setAttribute("aria-pressed", String(on));
};
trailBtn.onclick = () => setTrail(!trailOn);
if (params.get("trail") === "1") setTrail(true);
// Earlier moments (tier-improve loop 11): the present pose alone read as
// the video replayed. Up to MOMENTS earlier poses, MOMENT_DT apart, stay
// visible at their own depth, fading with age, but only those that stand
// apart from the present pose and from each other (box IoU <= MOMENT_IOU):
// a subject that moves leaves its moments along its path, one grazing in
// place shows no doubled legs. A moment larger than the present pose
// (MOMENT_GROW) or than MOMENT_MAX of the frame is left out: a subject that
// passed close to the lens would otherwise screen the scene with dots
// (puma walking up to a trail camera). ?moments=0 turns them off.
const MOMENT_DT = Number(params.get("momentDt")) || 0.6, MOMENTS = 4;
const MOMENT_IOU = Number(params.get("momentIou")) || 0.6;
const MOMENT_GROW = 1.5, MOMENT_MAX = 0.25;
const boxArea = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const momentsOn = params.get("moments") !== "0";
const kfBox = followBoxes.map((b) => b && [specimen.crop.x + b.x0 * specimen.crop.w, specimen.crop.y + b.y0 * specimen.crop.h,
  specimen.crop.x + b.x1 * specimen.crop.w, specimen.crop.y + b.y1 * specimen.crop.h]);
function boxIoU(a, b) {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih, uni = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return uni > 0 ? inter / uni : 0;
}
const momentCache = new Map();
function momentGhosts(cur) {
  if (momentCache.has(cur)) return momentCache.get(cur);
  const out = new Map(), ts = specimen.keyframes.map((f) => f.t), kept = [kfBox[cur]];
  const cap = kfBox[cur] ? Math.min(MOMENT_MAX, boxArea(kfBox[cur]) * MOMENT_GROW) : 0;
  let g = cur;
  for (let m = 1; m <= MOMENTS && cap > 0; m += 1) {
    const want = ts[cur] - m * MOMENT_DT;
    if (want < ts[0] - 1e-6) break;
    while (g > 0 && ts[g] > want + 1e-6) g -= 1;
    const b = kfBox[g];
    if (!b || g === cur || boxArea(b) > cap || kept.some((k) => k && boxIoU(k, b) > MOMENT_IOU)) continue;
    out.set(g, 0.42 * (1 - (m - 1) / MOMENTS));
    kept.push(b);
  }
  momentCache.set(cur, out);
  return out;
}
// Moments draw as points (Basic's form: a subject's moments as points in
// estimated depth): one dot per relief-grid vertex inside the matte, at
// that vertex's depth, in the photo's colour. A dotted earlier pose cannot
// be mistaken for a doubled subject, and the dots part from the scene as
// the camera moves. ?momentForm=photo keeps the faded photo instead.
const MOMENT_POINTS = params.get("momentForm") !== "photo";
const momentPts = new Map();
// Loop 12: a regular grid of hard round dots read as a halftone screen.
// The cloud is finer (MOMENT_SUB dots per grid step), each dot jittered off
// the grid by up to MOMENT_JIT of a step and kept with chance MOMENT_KEEP
// (a fixed hash, so the cloud does not shimmer), and drawn soft: a Gaussian
// falloff over MOMENT_DOT steps instead of a hard disc.
const MOMENT_SUB = Number(params.get("momentSub")) || 6;
const MOMENT_KEEP = Number(params.get("momentKeep")) || 0.85;
const MOMENT_JIT = params.has("momentJit") ? Number(params.get("momentJit")) : 0.6;
const MOMENT_DOT = Number(params.get("momentDot")) || 1.3;
const MOMENT_SOFT = params.get("momentSoft") !== "0";
const hash01 = (a, b, c) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};
function momentCloud(i) {
  if (momentPts.has(i)) return momentPts.get(i);
  // The relief grid at rest, MOMENT_SUB times denser by bilinear steps,
  // kept only inside the matte. Culled cliff quads keep their corner dot
  // only, so no dots hang between a near and a far part.
  const src = subjPlanes[i].geometry, P = src.attributes.position, UV = src.attributes.uv, idx = src.index.array;
  const nx = src.parameters.widthSegments, ny = src.parameters.heightSegments, gw = nx + 1, S = MOMENT_SUB;
  const W = nx * S + 1, H = ny * S + 1, pos = [], uvs = [];
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const qx = Math.min(nx - 1, Math.floor(x / S)), qy = Math.min(ny - 1, Math.floor(y / S));
    const fx = x / S - qx, fy = y / S - qy, a = qy * gw + qx, o = (qy * nx + qx) * 6;
    if ((fx > 0 && fx < 1) || (fy > 0 && fy < 1)) if (idx[o] === idx[o + 1] && idx[o] === idx[o + 2]) continue;
    if (hash01(i, x, y) >= MOMENT_KEEP) continue;
    if (subjAlpha(i, x / (W - 1), y / (H - 1)) < 128) continue;
    // jitter off the grid inside this quad (never across a culled cliff)
    const jx = (hash01(i + 7, x, y) - 0.5) * MOMENT_JIT / S, jy = (hash01(i + 13, x, y) - 0.5) * MOMENT_JIT / S;
    const gx = Math.min(1, Math.max(0, fx + jx)), gy = Math.min(1, Math.max(0, fy + jy));
    const w = [(1 - gx) * (1 - gy), gx * (1 - gy), (1 - gx) * gy, gx * gy], c = [a, a + 1, a + gw, a + gw + 1];
    let px = 0, py = 0, pz = 0, u = 0, v = 0;
    for (let k = 0; k < 4; k += 1) {
      px += w[k] * P.getX(c[k]); py += w[k] * P.getY(c[k]); pz += w[k] * P.getZ(c[k]);
      u += w[k] * UV.getX(c[k]); v += w[k] * UV.getY(c[k]);
    }
    pos.push(px, py, pz); uvs.push(u, v);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { map: { value: subjectTex }, opacity: { value: 1 }, dotW: { value: (cropWU / nx / S) * (MOMENT_SOFT ? MOMENT_DOT : 0.8) }, vh: { value: 720 } },
    vertexShader: `uniform sampler2D map; uniform float dotW, vh; varying vec4 vC;
      void main() { vC = texture2D(map, uv); vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.5, dotW * vh * 0.5 * projectionMatrix[1][1] / -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: MOMENT_SOFT ? `uniform float opacity; varying vec4 vC;
      void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (vC.a < 0.5 || r > 1.0) discard;
        gl_FragColor = vec4(vC.rgb / vC.a, opacity * exp(-3.0 * r * r)); }` : `uniform float opacity; varying vec4 vC;
      void main() { if (vC.a < 0.5 || length(gl_PointCoord - 0.5) > 0.5) discard;
        gl_FragColor = vec4(vC.rgb / vC.a, opacity); }`,
  });
  const p = new THREE.Points(g, mat);
  p.visible = false; p.renderOrder = 2; p.frustumCulled = false;
  scene.add(p);
  momentPts.set(i, p);
  return p;
}

const play = $("#play"), scrub = $("#scrub");
const setPlaying = (on) => { clock.playing = on; play.textContent = on ? "❚❚" : "▶"; };
play.onclick = () => setPlaying(!clock.playing);
scrub.oninput = () => { clock.t = (+scrub.value / 1000) * DURATION; };
addEventListener("wheel", (e) => {
  if (e.target.closest?.(".dock")) return;
  e.preventDefault();
  const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  clock.t = THREE.MathUtils.clamp(clock.t + (pixels / 700) * DURATION, 0, DURATION);
}, { passive: false });
addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target === document.body) { e.preventDefault(); setPlaying(!clock.playing); }
  else if (e.code === "KeyT" && e.target === document.body) { setTrail(!trailOn); }
  else if (e.code === "ArrowRight") { clock.t = Math.min(DURATION, clock.t + DURATION / (K - 1)); setPlaying(false); }
  else if (e.code === "ArrowLeft") { clock.t = Math.max(0, clock.t - DURATION / (K - 1)); setPlaying(false); }
});
const seek = (t) => { clock.t = THREE.MathUtils.clamp(t, 0, DURATION); setPlaying(false); };

// ── HUD ────────────────────────────────────────────────────────────────
// A seed-base plate means the median was scene-rejected (source drift or a
// subject too big to median away): say so next to the camera verdict so a
// `fixed` label on a seed-base build is never read as a static-source claim.
const seedBase = /scene-rejected/.test(specimen.plate.validation?.base || "");
// Visitors see what the build is; the lab readout stays behind ?debug=1
// (and in the title's tooltip). Examples take their gallery title and credit.
const labInfo = `${specimen.subject} · ${K} keyframes · ${specimen.camera} camera${seedBase ? " · seed-base plate" : ""} · ${specimen.working.width}×${specimen.working.height}`;
if (params.has("debug")) $("#info").textContent = labInfo;
else {
  $(".top b").textContent = "CLOUD TRAIL";
  $("#info").textContent = `Your ${specimen.subject || "build"}`;
  $("#info").title = labInfo;
  if (rawId.startsWith("assets/gallery-seed/")) {
    fetch("assets/gallery-seed.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((m) => {
      const ex = m?.examples?.find((e) => e.seedBase === rawId.replace(/\/$/, ""));
      if (ex) $("#info").textContent = `Example · ${ex.title}${ex.note ? ` — ${ex.note.replace(/^Example\.\s*/, "")}` : ""}`;
    }).catch(() => {});
  }
}
// Honest plate labels: the metadata blend tells what the pixels are —
// a median/seed base with Muse-filled holes is not a fully Muse plate.
const blendNames = { "median-base+muse-holes": "median + Muse fill", "seed-base+muse-holes": "seed frame + Muse fill" };
const blendLabel = specimen.plate.validation?.blend ? (blendNames[specimen.plate.validation.blend] || specimen.plate.validation.blend) : null;
const plateNames = { "muse-image": blendLabel || "Muse Image plate", median: "median plate", inpaint: "inpainted plate", migan: "Mi-GAN plate", soft: "soft background" };
$("#plateBadge").textContent = plateNames[specimen.plate.method] || `${specimen.plate.method} plate`;
// Soft fallback (plate.fallback, loop 6): no clean scene could be rebuilt,
// so the hidden area is blurred, never invented. Say so; older specimens
// have no fallback field and keep their label.
const fallbackWhy = { "close-up": "the subject fills too much of the frame", "still-subject": "the subject never moved off its spot",
  "ghost-qa": "leftovers of the subject failed the clean-scene check", "no-clean-plate": "no generated background passed the clean-scene check",
  "muse-unreachable": "the background generator was unavailable" };
if (specimen.plate.fallback) {
  $("#plateBadge").title = `Background softened where the subject hid it: ${fallbackWhy[specimen.plate.fallback.reason] || specimen.plate.fallback.reason}. Nothing there is invented.`;
}
$("#meta-story").textContent = params.has("debug")
  ? `tracked by SAM 3.1${specimen.provenance?.includes("birefnet-matte") ? " · matte by BiRefNet" : ""} · plate: ${$("#plateBadge").textContent} · depth by Depth Anything V2-Small`
  : `Subject tracked by Meta SAM 3.1 · ${specimen.plate.method === "muse-image" ? "background rebuilt with Muse Image" : "background softened where it hid"} · depth estimated${specimen.provenance?.includes("birefnet-matte") ? " · edges by BiRefNet" : ""}`;

// ── Loop ───────────────────────────────────────────────────────────────
function resize() {
  fitUpdate(); // desktop: full viewport, aspect unchanged (legacy path)
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = fitView.aspect;
  camera.updateProjectionMatrix();
  if (fitView.active) {
    // Honest contained viewport: NDC maps to the centered sub-rect;
    // untouched bars stay transparent (page background), never fake scene.
    renderer.setScissorTest(true);
    renderer.setScissor(0, fitView.barH, fitView.viewW, fitView.viewH);
    renderer.setViewport(0, fitView.barH, fitView.viewW, fitView.viewH);
  } else if (fitView.barW > 0) {
    // Narrow-source pillarbox: same honest bars, left and right.
    renderer.setScissorTest(true);
    renderer.setScissor(fitView.barW, 0, fitView.viewW, fitView.viewH);
    renderer.setViewport(fitView.barW, 0, fitView.viewW, fitView.viewH);
  } else {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
  }
  followRefresh(); // travel clips only; instant no-op otherwise
  frameRefresh(); // desktop in-place only; phones/travel no-op
  zoomFollowRefresh(); // travel clips the ladder refused only; scale 1 otherwise
}
addEventListener("resize", resize);
resize();

let last = performance.now();
showFrame(0);
followTick(1, clock.t); // snap (ease factor 1): embed renders once, before any tick
// Snap the validated zoom too: the first frame (and every embed settle) must
// already show the follow / in-place framing, not the wide legacy radius.
if (follow.active) view.r = viewT.r = Math.min(view.r, follow.r);
else if (frameState.active) view.r = viewT.r = Math.min(view.r, frameState.r);
composeCamera();
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (clock.playing) {
    clock.t += dt;
    if (clock.t >= DURATION) clock.t = 0;
  }
  const bl = blendAt(clock.t);
  const cur = BLEND ? bl.i : frameAt(clock.t);
  showFrame(cur, bl);
  scrub.value = String(Math.round((clock.t / DURATION) * 1000));
  $("#clock").textContent = `${(T0 + clock.t).toFixed(2)}s · ${cur + 1}/${K}`;
  followTick(dt, clock.t); // no-op unless a travel clip validated the ladder
  // look-at rides at the present subject's depth (eased: no jumps on cuts)
  const k = Math.min(1, dt * 3);
  lookZ.v += (subjPlanes[cur].position.z - lookZ.v) * (clock.playing || EMBED ? k : 1);
  // scripted autoplay path for eval/video capture (user input cancels it)
  // Default path = slow dolly + small sideways arc + slight push-in
  // (translation, not wide yaw): yaw glides +-4 deg, slide drifts at half
  // the envelope, push-in 3% over the duration.
  if (PATH_AUTO && !pathOff && !reducedMotion.matches) {
    setPlaying(true);
    const u = clock.t / DURATION;
    viewT.r = RADIUS * (1 - 0.03 * u);
    viewT.yaw = restYaw + Math.sin(u * Math.PI * 2) * THREE.MathUtils.degToRad(4);
    viewT.sx = Math.sin(u * Math.PI * 2 + 1.1) * SLIDE_X * 0.5;
    viewT.sy = 0;
    clampView(viewT);
  }
  // Opening glide (tier-improve loop 11): at rest the page read as the
  // video replayed. Until the visitor's first input the camera sways
  // through the drag window, so the subject holds while the scene slides
  // behind it at its own depth. Eases in from rest; any pointer, wheel or
  // key input stops it where it is (the drag then starts from there).
  if (GLIDE && !glideOff && !pathOff && !reducedMotion.matches) {
    const tau = (now - glideT0) / 1000;
    const u = Math.sin((tau / GLIDE_PERIOD) * Math.PI * 2) * Math.min(1, tau / GLIDE_RAMP);
    viewT.sx = u * SLIDE_X * GLIDE_AMP;
    viewT.yaw = restYaw + u * YAW * GLIDE_AMP;
    clampView(viewT);
  }
  // Follow zoom rides under the autoplay push-in (closer of the two wins);
  // reduced motion snaps to the static mid-clip framing.
  if (follow.active) {
    viewT.r = reducedMotion.matches ? follow.r : Math.min(viewT.r, follow.r);
    clampView(viewT);
  }
  if (frameState.active && !follow.active) {
    viewT.r = Math.min(viewT.r, frameState.r);
    clampView(viewT);
  }
  // pointer parallax eases toward the pointer, composed after the slide
  parallax.x += (parallax.tx - parallax.x) * Math.min(1, dt * 4);
  parallax.y += (parallax.ty - parallax.y) * Math.min(1, dt * 4);
  const ease = Math.min(1, dt * 6); // follow snap lands here too (see below)
  for (const key of ["yaw", "sx", "sy", "r"]) {
    view[key] += (viewT[key] - view[key]) * ease;
  }
  if (follow.active && reducedMotion.matches) view.r = viewT.r; // static mid-clip framing
  if (frameState.active && !follow.active && reducedMotion.matches) view.r = viewT.r;
  // scale follow: exact under embed (the harness drives each frame) and
  // reduced motion (static mid-clip scale), eased otherwise
  if (zoomFollow.active) {
    const want = zoomScaleAt(clock.t);
    zoomFollow.s = (EMBED || reducedMotion.matches) ? want : zoomFollow.s + (want - zoomFollow.s) * Math.min(1, dt * 3);
  }
  applyEmbedLook();
  const px = (!dragging && !EMBED && !reducedMotion.matches) ? parallax.x * 0.03 : 0;
  const py = (!dragging && !EMBED && !reducedMotion.matches) ? parallax.y * 0.02 : 0;
  const PIVF = fitPivotX() + follow.dx; // follow delta: 0 unless travelling
  const RF = view.r * zoomFollow.s; // scale follow: 1 unless a refused travel clip
  camera.position.set(
    PIVF + RF * Math.cos(restPitch) * Math.sin(view.yaw) + view.sx + px,
    RF * Math.sin(restPitch) + view.sy + py,
    lookZ.v + RF * Math.cos(restPitch) * Math.cos(view.yaw)
  );
  camera.lookAt(PIVF, FIT_PIVOT_Y + (follow.active ? follow.ty : 0), lookZ.v);
  renderer.render(scene, camera);
  if (!EMBED) requestAnimationFrame(tick);
}
if (!EMBED) requestAnimationFrame(tick);
else { applyEmbedLook(); composeCamera(); renderer.render(scene, camera); }

function subjectCoverage() {
  // Subject-visibility proof (SEPARATE from the background-hole gate).
  // Projects the union-bbox corners + head/torso/centroid probes at the
  // present subject depth with the ACTUAL (fitted) camera AND with the
  // canonical desktop reference (legacy pivot 0, 1280x720 aspect, same
  // pose/time). Source-border contact is reported PER EDGE (a probe is
  // only flagged for borders it touches) and NEVER masks NEW clipping:
  // pass = no probe that is visible on desktop is clipped on phone
  // (newLoss). Probes cropped on BOTH (e.g. clip-b legs: cut in SOURCE at
  // y1=1 AND outside the desktop frustum) report outBoth — pre-existing,
  // quantified, not NEW. Thresholds of coverage() untouched.
  const cur = frameAt(clock.t);
  const z = subjPlanes[cur].position.z;
  const cx = (FIT_U.x0w + FIT_U.x1w) / 2;
  const cyMid = (FIT_U.yTop + FIT_U.yBot) / 2;
  const F = (l, r, t, b) => ({ left: !!l, right: !!r, top: !!t, bottom: !!b });
  const probes = [
    { name: "topLeft", x: FIT_U.x0w, y: FIT_U.yTop, src: F(FIT_U.srcLeft, 0, FIT_U.srcTop, 0) },
    { name: "topRight", x: FIT_U.x1w, y: FIT_U.yTop, src: F(0, FIT_U.srcRight, FIT_U.srcTop, 0) },
    { name: "botLeft", x: FIT_U.x0w, y: FIT_U.yBot, src: F(FIT_U.srcLeft, 0, 0, FIT_U.srcBottom) },
    { name: "botRight", x: FIT_U.x1w, y: FIT_U.yBot, src: F(0, FIT_U.srcRight, 0, FIT_U.srcBottom) },
    { name: "head", x: cx, y: FIT_U.yTop, src: F(0, 0, FIT_U.srcTop, 0) },
    { name: "torso", x: cx, y: cyMid, src: F(0, 0, 0, 0) },
    { name: "centroid", x: (specimen.keyframes[cur].centroid[0] - 0.5) * worldW, y: (0.5 - specimen.keyframes[cur].centroid[1]) * worldH, src: F(0, 0, 0, 0) },
  ];
  const v = new THREE.Vector3();
  const projectAll = () => probes.map((p) => {
    v.set(p.x, p.y, z).project(camera);
    return [+v.x.toFixed(3), +v.y.toFixed(3)];
  });
  camera.updateMatrixWorld();
  const phone = projectAll();
  // Canonical desktop reference: same pose/time, legacy pivot, 1280x720.
  const savedAspect = camera.aspect;
  const savedPosition = camera.position.clone(), savedQuaternion = camera.quaternion.clone();
  camera.aspect = 1280 / 720; camera.updateProjectionMatrix();
  poseCamera(view.yaw, view.sx, view.sy, view.r, lookZ.v, 0);
  const desk = projectAll();
  // Restore the fitted camera exactly.
  camera.aspect = savedAspect; camera.updateProjectionMatrix();
  camera.position.copy(savedPosition);
  camera.quaternion.copy(savedQuaternion);
  camera.updateMatrixWorld();
  const inF = (n) => Math.abs(n[0]) <= 1 && Math.abs(n[1]) <= 1;
  const pts = probes.map((p, i) => {
    const deskIn = inF(desk[i]), phoneIn = inF(phone[i]);
    return {
      name: p.name, src: p.src, ndc: phone[i], ref: desk[i],
      deskIn, phoneIn,
      newLoss: deskIn && !phoneIn,
      outBoth: !deskIn && !phoneIn,
      gain: !deskIn && phoneIn,
    };
  });
  return {
    pass: pts.every((p) => !p.newLoss),
    newLoss: pts.filter((p) => p.newLoss).map((p) => p.name),
    outBoth: pts.filter((p) => p.outBoth).map((p) => p.name),
    maxAbs: +Math.max(...pts.map((p) => Math.max(Math.abs(p.ndc[0]), Math.abs(p.ndc[1])))).toFixed(3),
    ref: "canonical-desktop-1280x720-legacy-pivot0",
    pts,
  };
}
window.__basic = {
  meta: specimen, clock, seek, setPlaying, setTrail, camera, middle, scene,
  planes: subjPlanes, coverage: frustumCoverage, subjectCoverage, pathAuto: PATH_AUTO,
  follow: followState,
  zoomFollow: () => ({ active: zoomFollow.active, scale: +zoomFollow.s.toFixed(4),
    zooms: zoomFollow.rs.map((r) => +(zoomFollow.rBase / r).toFixed(3)), why: zoomFollow.why,
    raw: (zoomFollow.raw || []).map((r) => +r.toFixed(3)) }),
  flowOn: !!flowField,
  bandV: plateBandV,
  frame: frameState,
  fit: () => ({
    active: fitView.active, devAspect: +(innerWidth / Math.max(1, innerHeight)).toFixed(4),
    viewAspect: +fitView.aspect.toFixed(4), viewport: { ...fitView },
    pivotX: +FIT_PIVOT_X.toFixed(4), union: { ...FIT_U },
    need: { halfNeed: +FIT_HALF_NEED.toFixed(4), viewAspect: +FIT_VIEW_ASPECT.toFixed(4) },
    sourceCrop: { left: FIT_U.srcLeft, right: FIT_U.srcRight, top: FIT_U.srcTop, bottom: FIT_U.srcBottom },
    ref: "canonical-desktop-1280x720-legacy-pivot0",
  }),
  orbitBy: (deg) => {
    // test hook: yaw offset in degrees from rest, hard-clamped to the
    // specimen envelope like drag (the shoot's +-8 requests saturate here)
    const lim = envelope.yawDeg;
    const c = THREE.MathUtils.clamp(deg, -lim, lim);
    viewT.yaw = restYaw + THREE.MathUtils.degToRad(c);
    viewT.sx = (lim > 0 ? c / lim : 0) * SLIDE_X;
    clampView(viewT);
    for (const key of ["yaw", "sx", "sy", "r"]) view[key] = viewT[key];
    composeCamera();
    renderer.render(scene, camera);
  },
  setLook: (x, y) => {
    embedLook.x = THREE.MathUtils.clamp(x, -1, 1);
    embedLook.y = THREE.MathUtils.clamp(y, -1, 1);
    applyEmbedLook();
    for (const key of ["yaw", "sx", "sy", "r"]) view[key] = viewT[key];
    lookZ.v = subjPlanes[frameAt(clock.t)].position.z;
    composeCamera();
    renderer.render(scene, camera);
  },
  frame: () => tick(performance.now()),
};
