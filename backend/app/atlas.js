import sharp from "sharp";
import { frameStats, selectPoses, meanPairwiseMotion, STATIC_MOTION } from "./lite-pose.js";
import { fitChronoRow, fitChronoPoints, portraitChronoPoints } from "./lite-frame.js";

// Packs tracked cut-out slices into the compact atlas the tesseract cells
// read (same layout backend/tools/make-volume.mjs produces): one .webp
// grid plus a .json sidecar. Also renders thumb.webp.

export const ATLAS_CELL = 224;
// Chrono default: inside the 320-384 band; 22 cells at 336px peak at
// 5 cols x 336 = 1680px wide, far inside the 4096 texture limit.
export const CHRONO_CELL = 336;
export const CHRONO_MAX_BYTES = 2000000;

// Erode the alpha by `erode` px (3x3 minimum, repeated), soften the edge
// with a box blur of radius `feather`, and bleed interior RGB outward up
// to `bleed` px so resampling never smears a light halo ring around the
// cut-out. Pure on the pixel buffer (a copy is returned); operates at
// source resolution before the cell resize.
export function defringe(rgba, w, h, { erode = 1, feather = 1, bleed = 3, alphaT = 8, preserveAlpha = false } = {}) {
  // Explicit selections keep every observed component. Standard atlas resampling remains lossy.
  if (preserveAlpha) return Buffer.from(rgba);
  const n = w * h;
  const src = Buffer.from(rgba);
  let alpha = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) alpha[p] = src[p * 4 + 3] > alphaT ? src[p * 4 + 3] : 0;
  const min3 = (a) => {
    const out = new Uint8Array(n);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let m = 255;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx, yy = y + dy;
            const v = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : a[yy * w + xx];
            if (v < m) m = v;
            if (m === 0) break;
          }
          if (m === 0) break;
        }
        out[y * w + x] = m;
      }
    }
    return out;
  };
  for (let k = 0; k < Math.max(0, erode); k += 1) alpha = min3(alpha);
  const solid = alpha.map((a) => (a > 0 ? 1 : 0));
  // Despeckle: keep only the largest connected solid component, so a
  // detached droplet (mask noise, feather drip) cannot float beside the pose.
  {
    const seen = new Uint8Array(n);
    let best = null;
    for (let s = 0; s < n; s += 1) {
      if (!solid[s] || seen[s]) continue;
      const stack = [s];
      seen[s] = 1;
      const comp = [];
      while (stack.length) {
        const p = stack.pop();
        comp.push(p);
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && solid[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x + 1 < w && solid[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && solid[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
        if (y + 1 < h && solid[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
      }
      if (!best || comp.length > best.length) best = comp;
    }
    if (best && best.length < n) {
      const keep = new Set(best);
      for (let p = 0; p < n; p += 1) {
        if (solid[p] && !keep.has(p)) { solid[p] = 0; alpha[p] = 0; }
      }
    }
  }
  // Feather: separable box blur (edge-replicated) of the eroded alpha.
  const r = Math.max(0, Math.floor(feather));
  if (r > 0) {
    const span = 2 * r + 1;
    const at = (a, i, lo, hi) => a[Math.min(hi, Math.max(lo, i))];
    const tmp = new Float32Array(n);
    for (let y = 0; y < h; y += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) acc += at(alpha, y * w + i, y * w, y * w + w - 1);
      tmp[y * w] = acc / span;
      for (let x = 1; x < w; x += 1) {
        acc += at(alpha, y * w + x + r, y * w, y * w + w - 1) - at(alpha, y * w + x - r - 1, y * w, y * w + w - 1);
        tmp[y * w + x] = acc / span;
      }
    }
    const out = new Uint8Array(n);
    const row = (i) => Math.min(h - 1, Math.max(0, i));
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) acc += tmp[row(i) * w + x];
      out[x] = Math.round(acc / span);
      for (let y = 1; y < h; y += 1) {
        acc += tmp[row(y + r) * w + x] - tmp[row(y - r - 1) * w + x];
        out[y * w + x] = Math.round(acc / span);
      }
    }
    alpha = out;
  }
  // Bleed interior colour outward: transparent pixels near the solid take
  // the mean RGB of solid neighbours (alpha untouched), repeated outward.
  const rgb = new Uint8Array(src);
  for (let k = 0; k < Math.max(0, bleed); k += 1) {
    const next = new Uint8Array(rgb);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = y * w + x;
        if (solid[p]) continue;
        let rS = 0, gS = 0, bS = 0, cN = 0;
        if (x > 0 && solid[p - 1]) { rS += rgb[(p - 1) * 4]; gS += rgb[(p - 1) * 4 + 1]; bS += rgb[(p - 1) * 4 + 2]; cN += 1; }
        if (x + 1 < w && solid[p + 1]) { rS += rgb[(p + 1) * 4]; gS += rgb[(p + 1) * 4 + 1]; bS += rgb[(p + 1) * 4 + 2]; cN += 1; }
        if (y > 0 && solid[p - w]) { rS += rgb[(p - w) * 4]; gS += rgb[(p - w) * 4 + 1]; bS += rgb[(p - w) * 4 + 2]; cN += 1; }
        if (y + 1 < h && solid[p + w]) { rS += rgb[(p + w) * 4]; gS += rgb[(p + w) * 4 + 1]; bS += rgb[(p + w) * 4 + 2]; cN += 1; }
        if (cN) {
          next[p * 4] = Math.round(rS / cN);
          next[p * 4 + 1] = Math.round(gS / cN);
          next[p * 4 + 2] = Math.round(bS / cN);
          solid[p] = 1;
        }
      }
    }
    rgb.set(next);
  }
  const out = Buffer.from(rgb);
  for (let p = 0; p < n; p += 1) out[p * 4 + 3] = alpha[p];
  return out;
}

// Premultiplied-alpha helpers: sharp resamples straight-alpha RGBA, which
// smears the transparent-black background into silhouettes as a dark (or,
// after JPEG-ish ringing, light) fringe. Resizing premultiplied and dividing
// back out keeps edge RGB honest. Both pure on the pixel buffer.
export function premultiplyAlpha(rgba, w, h) {
  const out = Buffer.from(rgba);
  for (let p = 0, o = 0; p < w * h; p += 1, o += 4) {
    const a = out[o + 3] / 255;
    out[o] = Math.round(out[o] * a);
    out[o + 1] = Math.round(out[o + 1] * a);
    out[o + 2] = Math.round(out[o + 2] * a);
  }
  return out;
}

export function unpremultiplyAlpha(rgba, w, h) {
  const out = Buffer.from(rgba);
  for (let p = 0, o = 0; p < w * h; p += 1, o += 4) {
    const a = out[o + 3];
    if (a === 0 || a === 255) continue;
    out[o] = Math.min(255, Math.round((out[o] * 255) / a));
    out[o + 1] = Math.min(255, Math.round((out[o + 1] * 255) / a));
    out[o + 2] = Math.min(255, Math.round((out[o + 2] * 255) / a));
  }
  return out;
}

// ---- Ambient backdrop + dark-subject auto-exposure --------------------
// Median Rec.709 luma (0..1) of the opaque pixels. Drives auto-exposure.
export function medianLuma(rgba, w, h, alphaMin = 128) {
  // Exact median without sorting every pixel: count the lumas per integer
  // bin, then sort only the bin that holds the middle value (the same
  // floats as a full sort; a 1 Mpx pose took ~150 ms, now a few).
  const n = w * h;
  const bins = new Uint32Array(257);
  let count = 0;
  for (let p = 0, o = 0; p < n; p += 1, o += 4) {
    if (rgba[o + 3] >= alphaMin) { bins[Math.floor(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2])] += 1; count += 1; }
  }
  if (!count) return 0;
  const k = Math.floor(count / 2);
  let bin = 0, before = 0;
  while (before + bins[bin] <= k) before += bins[bin++];
  const vals = new Float64Array(bins[bin]);
  for (let p = 0, o = 0, j = 0; p < n; p += 1, o += 4) {
    if (rgba[o + 3] < alphaMin) continue;
    const v = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    if (Math.floor(v) === bin) vals[j++] = v;
  }
  vals.sort();
  return vals[k - before] / 255;
}

// Gamma lift REMOVED (it pushed dark fur mauve — worse than dark). Dark
// subjects are flagged (pack `dark`) and read via the viewer's lifted
// brightness floor plus a brighter backdrop; cell pixels stay untouched.
// medianLuma above is the only exposure helper still in the path.





// Fractional union rect {x,y,w,h in 0..1} over pixel boxes (dilated by pad
// px), so a plate at ANY resolution can mask the same subject region.
export function unionRect(boxes, pad, W, H) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  }
  if (x1 < 0) return null;
  const rx0 = Math.max(0, x0 - pad) / W, ry0 = Math.max(0, y0 - pad) / H;
  const rx1 = Math.min(W - 1, x1 + pad) / W, ry1 = Math.min(H - 1, y1 + pad) / H;
  return { x: rx0, y: ry0, w: Math.max(0, rx1 - rx0), h: Math.max(0, ry1 - ry0) };
}

// Ambient stage backdrop from a full plate frame: the fractional subject
// rect is filled by push-pull (CPU only: small-grid neighbour fill, no
// models), then the plate is shrunk to ~384px wide, blurred hard
// (sigma ~6% of width), darkened to ~27% luma and slightly desaturated —
// the stage reads as 'this subject, in that place' without competing with
// the poses. Returns {buffer, width, height} (webp, quality 70).
export async function buildBackdrop(plateBuffer, maskRect, { width = 384, quality = 70, sigmaPct = 0.06, luma = 0.27, desat = 0.3 } = {}) {
  const { data, info } = await sharp(plateBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  // Fill on a small grid (fast), then upscale: equivalent to a heavy blur
  // of the filled plate.
  const SW = 160, SH = Math.max(1, Math.round((SW * H) / W));
  const small = await sharp(data, { raw: { width: W, height: H, channels: C } })
    .resize(SW, SH, { fit: "fill" }).raw().toBuffer();
  const dil = 2;
  const rx0 = Math.max(0, Math.floor((maskRect?.x || 0) * SW) - dil);
  const ry0 = Math.max(0, Math.floor((maskRect?.y || 0) * SH) - dil);
  const rx1 = Math.min(SW - 1, Math.ceil(((maskRect?.x || 0) + (maskRect?.w || 0)) * SW) + dil);
  const ry1 = Math.min(SH - 1, Math.ceil(((maskRect?.y || 0) + (maskRect?.h || 0)) * SH) + dil);
  const valid = new Uint8Array(SW * SH).fill(1);
  for (let y = ry0; y <= ry1; y += 1) for (let x = rx0; x <= rx1; x += 1) valid[y * SW + x] = 0;
  let px = new Uint8Array(small);
  if (valid.includes(1)) {
    for (let iter = 0; iter < 2000; iter += 1) {
      let pending = 0;
      const next = new Uint8Array(px);
      const nextValid = new Uint8Array(valid);
      for (let y = 0; y < SH; y += 1) {
        for (let x = 0; x < SW; x += 1) {
          const p = y * SW + x;
          if (valid[p]) continue;
          let r = 0, g = 0, b = 0, c = 0;
          if (x > 0 && valid[p - 1]) { r += px[(p - 1) * 3]; g += px[(p - 1) * 3 + 1]; b += px[(p - 1) * 3 + 2]; c += 1; }
          if (x + 1 < SW && valid[p + 1]) { r += px[(p + 1) * 3]; g += px[(p + 1) * 3 + 1]; b += px[(p + 1) * 3 + 2]; c += 1; }
          if (y > 0 && valid[p - SW]) { r += px[(p - SW) * 3]; g += px[(p - SW) * 3 + 1]; b += px[(p - SW) * 3 + 2]; c += 1; }
          if (y + 1 < SH && valid[p + SW]) { r += px[(p + SW) * 3]; g += px[(p + SW) * 3 + 1]; b += px[(p + SW) * 3 + 2]; c += 1; }
          if (c) {
            next[p * 3] = Math.round(r / c); next[p * 3 + 1] = Math.round(g / c); next[p * 3 + 2] = Math.round(b / c);
            nextValid[p] = 1;
          } else pending += 1;
        }
      }
      px = next;
      valid.set(nextValid);
      if (!pending) break;
    }
  }
  const BW = width, BH = Math.max(1, Math.round((width * H) / W));
  const blurred = await sharp(px, { raw: { width: SW, height: SH, channels: 3 } })
    .resize(BW, BH)
    .blur(Math.max(2, Math.round(BW * sigmaPct)))
    .raw().toBuffer();
  // Darken toward target luma (never brighten) + slight desaturation.
  const n = BW * BH;
  let sum = 0;
  const lum = new Float32Array(n);
  for (let p = 0, o = 0; p < n; p += 1, o += 3) {
    const l = (0.299 * blurred[o] + 0.587 * blurred[o + 1] + 0.114 * blurred[o + 2]) / 255;
    lum[p] = l; sum += l;
  }
  const gain = sum / n > luma ? luma / (sum / n) : 1;
  const keep = 1 - desat;
  const out = Buffer.alloc(n * 3);
  for (let p = 0, o = 0; p < n; p += 1, o += 3) {
    const r = blurred[o] * gain, g = blurred[o + 1] * gain, b = blurred[o + 2] * gain;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    out[o] = Math.min(255, Math.max(0, Math.round(l + (r - l) * keep)));
    out[o + 1] = Math.min(255, Math.max(0, Math.round(l + (g - l) * keep)));
    out[o + 2] = Math.min(255, Math.max(0, Math.round(l + (b - l) * keep)));
  }
  const buffer = await sharp(out, { raw: { width: BW, height: BH, channels: 3 } })
    .webp({ quality }).toBuffer();
  return { buffer, width: BW, height: BH };
}

// Sharp stage backdrop for FIXED-camera clips: temporal median over full
// source frames with the fractional subject rect masked out (CPU only, no
// models — the median itself rejects anything that moves). Kept sharp and
// only slightly dimmed (~70% luma) so the place reads as the place. Moving-
// camera clips keep the blurred card above. Returns {buffer,width,height}.
// Sharp stage backdrop for FIXED-camera clips: temporal median over full
// source frames using PER-FRAME subject masks (SAM cut-out alpha from the
// runner; motion masks in the cougar driver — CPU only, no models). A pixel
// only votes while it is NOT inside the dilated subject mask. Pixels with
// fewer than 3 clean samples are 'unknown' and filled from the blurred
// reference; if the unknown share exceeds ~4%, or the plate differs from
// the blurred reference inside the unknown region above GHOST_MAX (a
// subject the median failed to reject), the whole stage FALLS BACK to the
// blurred card — no half-clean plates. masks[i] is null (clean frame) or
// an array of RGBA buffers whose alpha marks the subject (multi-object
// frames union their alphas). Returns {buffer,width,height,kind} or
// {fallback:true, blur, unknownShare, ghost}.
export const SHARP_UNKNOWN_MAX = 0.04;
export const SHARP_GHOST_MAX = 0.08;
export async function buildSharpBackdrop(frameBuffers, masks, { width = 640, quality = 75, luma = 0.70, blurLuma = 0.27, unknownMax = SHARP_UNKNOWN_MAX, ghostMax = SHARP_GHOST_MAX, dilate = 2 } = {}) {
  if (!Array.isArray(frameBuffers) || frameBuffers.length < 3) throw new Error("buildSharpBackdrop needs >= 3 frames.");
  const raws = await Promise.all(frameBuffers.map(async (b) => {
    const r = await sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return r;
  }));
  const W = raws[0].info.width, H = raws[0].info.height;
  // Median at output scale (fast, and the median is scale-robust).
  const SW = width, SH = Math.max(1, Math.round((width * H) / W));
  const small = await Promise.all(raws.map(({ data, info }) =>
    sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .resize(SW, SH, { fit: "fill" }).raw().toBuffer()
  ));
  // Per-frame subject alpha at plate scale, dilated (feathered cut-out
  // edges must not vote either).
  const subj = [];
  for (let i = 0; i < small.length; i += 1) {
    const entry = Array.isArray(masks) ? masks[i] : null;
    const list = Array.isArray(entry) ? entry : (entry ? [entry] : []);
    const acc = new Uint8Array(SW * SH);
    for (const m of list) {
      const { data, info } = await sharp(m).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const aw = info.width, ah = info.height;
      for (let y = 0; y < SH; y += 1) {
        const sy = Math.min(ah - 1, Math.floor((y * ah) / SH));
        for (let x = 0; x < SW; x += 1) {
          const sx = Math.min(aw - 1, Math.floor((x * aw) / SW));
          if (data[(sy * aw + sx) * info.channels + info.channels - 1] > 8) acc[y * SW + x] = 1;
        }
      }
    }
    if (dilate > 0 && acc.includes(1)) {
      const dil = new Uint8Array(acc);
      for (let y = 0; y < SH; y += 1) {
        for (let x = 0; x < SW; x += 1) {
          if (!acc[y * SW + x]) continue;
          for (let dy = -dilate; dy <= dilate; dy += 1) {
            const yy = y + dy;
            if (yy < 0 || yy >= SH) continue;
            for (let dx = -dilate; dx <= dilate; dx += 1) {
              const xx = x + dx;
              if (xx < 0 || xx >= SW) continue;
              dil[yy * SW + xx] = 1;
            }
          }
        }
      }
      subj.push(dil);
    } else subj.push(acc);
  }
  // Masked median + clean-sample counts.
  const out = Buffer.alloc(SW * SH * 3);
  const counts = new Uint8Array(SW * SH);
  const vs = [];
  for (let y = 0; y < SH; y += 1) {
    for (let x = 0; x < SW; x += 1) {
      const p = y * SW + x, o = p * 3;
      for (let c = 0; c < 3; c += 1) {
        vs.length = 0;
        for (let i = 0; i < small.length; i += 1) if (!subj[i][p]) vs.push(small[i][o + c]);
        counts[p] = vs.length;
        if (!vs.length) { out[o + c] = 0; continue; }
        vs.sort((a, b) => a - b);
        out[o + c] = vs[Math.floor(vs.length / 2)];
      }
    }
  }
  let unknown = 0;
  for (let p = 0; p < SW * SH; p += 1) if (counts[p] < 3) unknown += 1;
  const unknownShare = unknown / (SW * SH);
  // Blurred reference doubles as the unknown fill AND the fallback card:
  // union bbox of every mask as the fill rect over the middle frame.
  let ux0 = SW, uy0 = SH, ux1 = -1, uy1 = -1;
  for (const m of subj) {
    for (let y = 0; y < SH; y += 1) for (let x = 0; x < SW; x += 1) {
      if (!m[y * SW + x]) continue;
      if (x < ux0) ux0 = x; if (x > ux1) ux1 = x;
      if (y < uy0) uy0 = y; if (y > uy1) uy1 = y;
    }
  }
  const unionRect = ux1 >= 0
    ? { x: ux0 / SW, y: uy0 / SH, w: (ux1 - ux0 + 1) / SW, h: (uy1 - uy0 + 1) / SH }
    : { x: 0, y: 0, w: 0, h: 0 };
  const mid = frameBuffers[Math.floor(frameBuffers.length / 2)];
  const ref = await buildBackdrop(mid, unionRect, { luma: blurLuma });
  const refSmall = await sharp(ref.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const RW = refSmall.info.width, RH = refSmall.info.height;
  // Ghost metric compares against an UNDIMMED smooth reference (same
  // brightness as the sharp plate): comparing to the darkened fallback
  // card would indict every textured pixel via the dimming alone.
  const mref = await buildBackdrop(mid, unionRect, { luma: 1.0, desat: 0 });
  const mrefSmall = await sharp(mref.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Ghost metric: mean |luma plate - luma blur| over unknown pixels that
  // still have 1-2 votes. Zero-sample pixels carry no signal (the share
  // rule governs them); a rejected subject leaves subject colours where
  // the blur is smooth.
  // Every unknown pixel (0-2 clean votes) is then filled from the UNDIMMED
  // smooth reference, so the whole plate dims together below. Zero-vote
  // pixels used to stay black: a subject that never left its spot (a deer
  // standing, a sleeping cat) stood behind its own row as a black
  // silhouette while the share stayed under the QA limit.
  let gSum = 0, gN = 0;
  for (let y = 0; y < SH; y += 1) {
    const sy = Math.min(RH - 1, Math.floor((y * RH) / SH));
    for (let x = 0; x < SW; x += 1) {
      const p = y * SW + x;
      if (counts[p] >= 3) continue;
      const sx = Math.min(RW - 1, Math.floor((x * RW) / SW));
      const ro = (sy * RW + sx) * mrefSmall.info.channels;
      const o = p * 3;
      if (counts[p] > 0) {
        gN += 1;
        const rl = (0.299 * mrefSmall.data[ro] + 0.587 * mrefSmall.data[ro + 1] + 0.114 * mrefSmall.data[ro + 2]) / 255;
        const pl = (0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2]) / 255;
        gSum += Math.abs(pl - rl);
      }
      out[o] = mrefSmall.data[ro]; out[o + 1] = mrefSmall.data[ro + 1]; out[o + 2] = mrefSmall.data[ro + 2];
    }
  }
  const ghost = gN ? gSum / gN : 0;
  if (unknownShare > unknownMax || ghost > ghostMax) {
    return { fallback: true, blur: ref, unknownShare, ghost };
  }
  // Dim toward target luma (never brighten) — no desaturation: the sharp
  // plate earns its keep by reading as the real place.
  const n = SW * SH;
  let sum = 0;
  for (let p = 0, o = 0; p < n; p += 1, o += 3) {
    sum += (0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2]) / 255;
  }
  const gain = sum / n > luma ? luma / (sum / n) : 1;
  if (gain < 1) {
    for (let o = 0; o < out.length; o += 1) out[o] = Math.round(out[o] * gain);
  }
  const buffer = await sharp(out, { raw: { width: SW, height: SH, channels: 3 } })
    .webp({ quality }).toBuffer();
  return { buffer, width: SW, height: SH, kind: "sharp", unknownShare, ghost };
}

// Tight per-slice alpha boxes over decoded raws (shared by both packers).
function alphaBoxes(raws, alphaT = 8) {
  const boxes = [];
  for (const { data, info } of raws) {
    let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (data[(y * info.width + x) * 4 + 3] > alphaT) {
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
    }
    if (bx1 >= 0) boxes.push({ x0: bx0, y0: by0, x1: bx1, y1: by1 });
  }
  return boxes;
}

async function alphaCoverage(png) {
  const { data } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let on = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] > 8) on += 1;
  return on;
}

// Drops frames where the subject has all but left, then packs each pose
// into its own cell: every slice is cropped to its OWN tight alpha box and
// contain-fit into a uniform cell, so a travelling subject fills its cell
// instead of rattling around inside its whole travel (the union crop). The
// atlas contract is unchanged (one .webp grid + cols/rows/cellW/cellH +
// aspect + kept timestamps); each pose is centred, so the viewer frames the
// subject at ~55% view height whatever path it took through the frame.
export async function packAtlas(slices, { cell = ATLAS_CELL } = {}) {
  if (!slices.length) throw new Error("No tracked frames to pack.");
  const coverage = await Promise.all(slices.map((s) => alphaCoverage(s.buffer)));
  const median = [...coverage].sort((a, b) => a - b)[Math.floor(coverage.length / 2)];
  const kept = slices.filter((_, i) => coverage[i] >= median * 0.2);
  if (!kept.length) throw new Error("Every tracked frame was empty.");

  let srcW = 0, srcH = 0;
  const raws = await Promise.all(
    kept.map(async (s) => {
      const { data, info } = await sharp(s.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, info };
    })
  );
  srcW = raws[0].info.width;
  srcH = raws[0].info.height;
  // Per-slice tight alpha boxes: the union crop below spans the subject's
  // whole travel, but each pose usually fills only part of it. The median
  // box (as a fraction of the union crop) lets the viewer fit the subject
  // instead of its travel (see backend/app/lite-frame.js).
  const boxes = alphaBoxes(raws);
  if (!boxes.length) throw new Error("Every tracked frame was empty.");
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (const b of boxes) {
    if (b.x0 < minX) minX = b.x0;
    if (b.y0 < minY) minY = b.y0;
    if (b.x1 > maxX) maxX = b.x1;
    if (b.y1 > maxY) maxY = b.y1;
  }
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(srcW - 1, maxX + pad);
  maxY = Math.min(srcH - 1, maxY + pad);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const medianOf = (vals) => [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  // Cells are sized by the MEDIAN pose box (not the union travel): each
  // pose then fills its cell whatever path the subject took. cellH is
  // capped at 2x cell width so a degenerate sliver cannot blow up the atlas
  // (the 4096-wide budget + bigger cells land in item 3).
  const medBW = Math.max(1, medianOf(boxes.map((b) => b.x1 - b.x0 + 1)));
  const medBH = Math.max(1, medianOf(boxes.map((b) => b.y1 - b.y0 + 1)));

  const cellW = cell;
  const cellH = Math.min(cell * 2, Math.max(1, Math.round((medBH / medBW) * cell)));
  const cols = Math.ceil(Math.sqrt(kept.length));
  const rows = Math.ceil(kept.length / cols);
  // Achieved fill of the median pose inside its cell (contain-fit): ~1 on
  // the long side. The viewer fits the planes at ~55% view height.
  const fitScale = Math.min(cellW / medBW, cellH / medBH);
  const subjectFill = {
    w: Math.min(1, (medBW * fitScale) / cellW),
    h: Math.min(1, (medBH * fitScale) / cellH),
  };

  const padBox = (b) => ({
    left: Math.max(0, b.x0 - pad),
    top: Math.max(0, b.y0 - pad),
    width: Math.min(srcW - Math.max(0, b.x0 - pad), b.x1 - b.x0 + 1 + 2 * pad),
    height: Math.min(srcH - Math.max(0, b.y0 - pad), b.y1 - b.y0 + 1 + 2 * pad),
  });
  const cells = await Promise.all(
    kept.map((s, i) =>
      sharp(s.buffer)
        .extract(padBox(boxes[i]))
        .resize(cellW, cellH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer()
    )
  );
  const atlas = await sharp({
    create: { width: cols * cellW, height: rows * cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(cells.map((input, i) => ({ input, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH })))
    .webp({ quality: 82, alphaQuality: 90, effort: 6 })
    .toBuffer();

  return {
    atlas,
    kept: kept.map((s) => ({ timestamp: s.timestamp, sourceFrameIndex: s.sourceFrameIndex, concept: s.concept })),
    cols,
    rows,
    cellW,
    cellH,
    crop: { x: minX, y: minY, w: cropW, h: cropH },
    subjectFill,
  };
}

// Even subsample of index list keeping first/last (time order preserved).
export function evenSubsample(idx, n) {
  if (n >= idx.length) return [...idx];
  const out = [];
  for (let j = 0; j < n; j += 1) out.push(idx[Math.round((j * (idx.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

// Median opaque fraction inside the kept alpha boxes: area -> length via
// sqrt, so thin-legged subjects count their visible extent honestly.
export function medianCoverage(raws, boxes, alphaMin = 8) {
  const fr = [];
  for (let k = 0; k < raws.length; k += 1) {
    const { data, info } = raws[k];
    const b = boxes[k];
    if (!b) continue;
    let n = 0;
    for (let y = b.y0; y <= b.y1; y += 1) {
      for (let x = b.x0; x <= b.x1; x += 1) {
        if (data[(y * info.width + x) * 4 + 3] > alphaMin) n += 1;
      }
    }
    const area = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
    if (area > 0) fr.push(n / area);
  }
  if (!fr.length) return 1;
  fr.sort((a, b2) => a - b2);
  return fr[Math.floor(fr.length / 2)];
}

// Cap pose count by rendered SIZE, not count: largest n in [3..min(7,
// picked)] whose visible subjects clear ~14% of canvas height on wide (~9%
// phone hero through the portrait subset the viewer actually shows). Never
// more than 7: twelve near-identical stamps read as a pattern. Uses the
// same canonical fit the viewer fits with, so the stills match the math.
export function sizeCapCount(picked, pickedTs, { poseW, poseH = 3.4, coverage = 1, wideFloor = 0.15, phoneFloor = 0.09 } = {}) {  const tanHalf = Math.tan((38 * Math.PI) / 360);
  const lin = Math.sqrt(Math.max(0.05, Math.min(1, coverage)));
  const wideFrac = (n) => {
    const rowLen = 0.85 * poseW * (n - 1);
    const depth = Math.min(4.6, Math.max(0.8, rowLen * 0.15));
    const D = fitChronoRow(
      { count: n, poseW, poseH, rowLen, depth },
      { fovDeg: 38, aspect: 2.19, yawRest: -0.3, yawBound: 0.52, pitchBound: 0.28, fill: 0.9, widthFill: 0.97, aimY: -0.2 }
    );
    return (poseH * lin) / (2 * D * tanHalf);
  };
  const phoneHero = (sub, tsSub) => {
    const n = sub.length;
    const { points } = portraitChronoPoints({ count: n, poseW, poseH, timestamps: tsSub });
    const Dp = fitChronoPoints(points,
      { fovDeg: 38, aspect: 0.673, yawRest: -0.3, yawBound: 0.28, pitchBound: 0.28, fill: 0.8, widthFill: 0.95, aimY: 0 });
    const near = points[points.length - 1];
    return (poseH * lin * near.s) / (2 * (Dp - near.z) * tanHalf);
  };
  for (let n = Math.min(picked.length, 7); n >= 3; n -= 1) {
    const sub = evenSubsample(picked, n);
    if (sub.length < 3) continue;
    const tsSub = pickedTs && pickedTs.length === picked.length
      ? sub.map((_, k) => pickedTs[picked.indexOf(sub[k])])
      : null;
    if (wideFrac(n) >= wideFloor && phoneHero(sub, tsSub) >= phoneFloor) return sub;
  }
  return evenSubsample(picked, 3);
}

// Colour bleed for the smooth-edge path: transparent pixels within `k` px
// of the cut-out take the mean RGB of their solid 4-neighbours (repeated
// outward). Returns an OPAQUE copy (alpha 255) so resampling can never pull
// transparent black into the silhouette edge.
export function bleedOpaque(rgba, w, h, k = 3, alphaT = 0) {
  const n = w * h;
  const rgb = Buffer.from(rgba);
  const solid = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) solid[p] = rgba[p * 4 + 3] > alphaT ? 1 : 0;
  for (let it = 0; it < k; it += 1) {
    const add = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = y * w + x;
        if (solid[p]) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1]) {
          if (q < 0 || !solid[q]) continue;
          r += rgb[q * 4]; g += rgb[q * 4 + 1]; b += rgb[q * 4 + 2]; c += 1;
        }
        if (c) add.push(p, Math.round(r / c), Math.round(g / c), Math.round(b / c));
      }
    }
    for (let j = 0; j < add.length; j += 4) {
      const p = add[j];
      rgb[p * 4] = add[j + 1]; rgb[p * 4 + 1] = add[j + 2]; rgb[p * 4 + 2] = add[j + 3];
      solid[p] = 1;
    }
  }
  for (let p = 0; p < n; p += 1) rgb[p * 4 + 3] = 255;
  return rgb;
}

// Cell resample. Downscales (most subjects) keep the premultiplied path.
// Upscales (small or distant subjects, > 1.25x) used to magnify the binary
// SAM mask into visible stair-steps; they now resample colour from a bled
// opaque copy and rebuild the edge from a lightly pre-smoothed alpha
// (sigma 0.7 source px) with a smoothstep(0.25, 0.75) snap at cell
// resolution: a clean anti-aliased contour that follows the mask, no halo,
// no dark fringe. Observed pixels only; the edge stays within ~1 source px.
export const UPSCALE_SMOOTH_T = 1.25;
export async function cellResize(rgba, w, h, cellW, cellH) {
  const s = Math.min(cellW / w, cellH / h);
  const contain = { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } };
  if (!(s > UPSCALE_SMOOTH_T)) {
    // Premultiplied-alpha-correct sampling: resize premultiplied, divide
    // back out, so fringe RGB never leaks into the silhouette.
    const premul = premultiplyAlpha(rgba, w, h);
    const resized = await sharp(premul, { raw: { width: w, height: h, channels: 4 } })
      .resize(cellW, cellH, contain).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: unpremultiplyAlpha(Buffer.from(resized.data), resized.info.width, resized.info.height), info: resized.info };
  }
  const opaque = bleedOpaque(rgba, w, h, 3);
  const colour = await sharp(opaque, { raw: { width: w, height: h, channels: 4 } })
    .resize(cellW, cellH, contain).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = Buffer.alloc(w * h);
  for (let p = 0; p < w * h; p += 1) alpha[p] = rgba[p * 4 + 3];
  const a = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } })
    .blur(0.7).resize(cellW, cellH, { ...contain, background: { r: 0, g: 0, b: 0 } })
    .extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(colour.data);
  const ch = a.info.channels;
  for (let p = 0, o = 0; p < cellW * cellH; p += 1, o += 4) {
    const v = a.data[p * ch] / 255;
    const t = Math.min(1, Math.max(0, (v - 0.25) / 0.5));
    out[o + 3] = colour.data[o + 3] ? Math.round(255 * t * t * (3 - 2 * t)) : 0;
  }
  return { data: out, info: colour.info };
}

// Edge colour decontamination. A cut-out's outermost pixels are a mix of
// the subject and what stood behind it (motion blur, defocus, the mask's
// own pixel step), so a dark animal on dry grass gets a light outline and
// a night-IR deer a dark one; the viewer draws them opaque. Every visible
// pixel within `ring` px of the matte edge (alpha >= `alphaT` is inside)
// takes the colour of the subject just inside it: the core (deeper than
// `ring`) is bled outward, nearest first. Parts thinner than the ring with
// no core within reach (a leg, an ear tip) keep their own colour. Alpha is
// untouched. Pure on the cell buffer (a copy is returned).
export const EDGE_RING = 2;
export function decontaminateEdge(rgba, w, h, { ring = EDGE_RING, alphaT = 128 } = {}) {
  const n = w * h;
  const out = Buffer.from(rgba);
  if (!(ring > 0)) return out;
  // Inside depth by 4-neighbour layers from the outside, capped at ring + 1.
  const depth = new Uint8Array(n);
  let layer = [];
  for (let p = 0; p < n; p += 1) {
    if (rgba[p * 4 + 3] < alphaT) continue;
    const x = p % w, y = (p / w) | 0;
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1
      || rgba[(p - 1) * 4 + 3] < alphaT || rgba[(p + 1) * 4 + 3] < alphaT
      || rgba[(p - w) * 4 + 3] < alphaT || rgba[(p + w) * 4 + 3] < alphaT;
    depth[p] = edge ? 1 : ring + 1;
    if (edge) layer.push(p);
  }
  for (let d = 2; d <= ring; d += 1) {
    const next = [];
    for (const p of layer) {
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || depth[q] !== ring + 1) continue;
        depth[q] = d; next.push(q);
      }
    }
    layer = next;
  }
  // Bleed the core's colour over the ring and the soft pixels outside it.
  const done = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) if (depth[p] > ring) done[p] = 1;
  for (let it = 0; it < ring + 2; it += 1) {
    const add = [];
    for (let p = 0; p < n; p += 1) {
      if (done[p] || !rgba[p * 4 + 3]) continue;
      const x = p % w;
      let r = 0, g = 0, b = 0, c = 0;
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || !done[q]) continue;
        r += out[q * 4]; g += out[q * 4 + 1]; b += out[q * 4 + 2]; c += 1;
      }
      if (c) add.push(p, Math.round(r / c), Math.round(g / c), Math.round(b / c));
    }
    if (!add.length) break;
    for (let j = 0; j < add.length; j += 4) {
      const p = add[j];
      out[p * 4] = add[j + 1]; out[p * 4 + 1] = add[j + 2]; out[p * 4 + 2] = add[j + 3];
      done[p] = 1;
    }
  }
  return out;
}

// Bounded-concurrency map (order preserved).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Everything the chrono pack needs from one slice's RGBA pixels:
// coverage (alpha > 8), tight alpha box, pose stats (lite-pose.js), the
// in-box fill and how much of the subject's outline lies on the picture
// edge (touch = edge pixels / perimeter pixels, the Still's V6 rule).
export function scanSlice(data, w, h, { alphaT = 8, solidT = 127, bottom = h } = {}) {
  // `bottom`: rows from here down are a burnt-in data bar (cut away), so the
  // subject's outline there counts as the picture edge, like the frame edge.
  const lastRow = Math.min(h, Math.max(1, bottom)) - 1;
  let coverage = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      if (data[(row + x) * 4 + 3] > alphaT) {
        coverage += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const box = x1 >= 0 ? { x0, y0, x1, y1 } : null;
  let perimeter = 0, edge = 0, solid = 0;
  // Per side, the rows (left/right) or columns (top/bottom) where the
  // subject reaches the picture edge (within 2 px): where the frame cuts it.
  const sideL = new Uint8Array(h), sideR = new Uint8Array(h), sideT = new Uint8Array(w), sideB = new Uint8Array(w);
  // Coarse solid grid (about MEMBER_GRID blocks across) for the separate
  // bodies in the mask (memberGrid).
  const f = Math.max(1, Math.round(Math.max(w, h) / MEMBER_GRID));
  const gw = Math.ceil(w / f), gh = Math.ceil(h / f);
  const grid = box ? new Uint8Array(gw * gh) : null;
  if (box) {
    // Solid bitmap of the box with a 1-px zero margin (outside = off).
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
    const m = new Uint8Array(bw * bh);
    for (let y = y0; y <= y1; y += 1) {
      const src = y * w, dst = (y - y0 + 1) * bw + 1 - x0, gRow = ((y / f) | 0) * gw;
      for (let x = x0; x <= x1; x += 1) if (data[(src + x) * 4 + 3] > solidT) { m[dst + x] = 1; grid[gRow + ((x / f) | 0)] = 1; }
    }
    for (let y = 1; y < bh - 1; y += 1) {
      for (let x = 1; x < bw - 1; x += 1) {
        const p = y * bw + x;
        if (!m[p]) continue;
        solid += 1;
        const fx = x - 1 + x0, fy = y - 1 + y0;
        const border = fx === 0 || fy === 0 || fx === w - 1 || fy >= lastRow;
        if (border) edge += 1;
        if (fx <= 1) sideL[fy] = 1;
        if (fx >= w - 2) sideR[fy] = 1;
        if (fy <= 1) sideT[fx] = 1;
        if (fy >= lastRow - 1) sideB[fx] = 1;
        if (border || !m[p - 1] || !m[p + 1] || !m[p - bw] || !m[p + bw] ||
            !m[p - bw - 1] || !m[p - bw + 1] || !m[p + bw - 1] || !m[p + bw + 1]) perimeter += 1;
      }
    }
  }
  const area = box ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0;
  const count = (a) => a.reduce((s, v) => s + v, 0);
  // [left, right, top, bottom]: share of the box side the frame cuts.
  const cut = box
    ? [count(sideL) / (y1 - y0 + 1), count(sideR) / (y1 - y0 + 1), count(sideT) / (x1 - x0 + 1), count(sideB) / (x1 - x0 + 1)]
    : [0, 0, 0, 0];
  return {
    width: w, height: h, coverage, box,
    fill: area ? coverage / area : 1,
    solid,
    touch: perimeter ? edge / perimeter : 0,
    cut,
    members: grid ? memberGrid(grid, gw, gh, f) : null,
    stats: frameStats(data, w, h),
  };
}

// Separate bodies of one mask on the coarse grid (8-connected; members
// closer than a block merge). Components sorted by area, largest first, as
// {area (blocks), x0, y0, x1, y1 (px), id}; `labels` (grid label per block,
// 0 = empty) is kept only when there is more than one body.
export const MEMBER_GRID = 320;
export function memberGrid(grid, gw, gh, f) {
  const labels = new Uint16Array(gw * gh);
  const stack = new Int32Array(gw * gh);
  const comps = [];
  for (let start = 0; start < grid.length; start += 1) {
    if (!grid[start] || labels[start] || comps.length >= 65535) continue;
    const id = comps.length + 1;
    let top = 0, area = 0, gx0 = gw, gy0 = gh, gx1 = -1, gy1 = -1;
    stack[top++] = start;
    labels[start] = id;
    while (top) {
      const p = stack[--top], px = p % gw, py = (p - px) / gw;
      area += 1;
      if (px < gx0) gx0 = px;
      if (px > gx1) gx1 = px;
      if (py < gy0) gy0 = py;
      if (py > gy1) gy1 = py;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = py + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = px + dx, q = ny * gw + nx;
          if (nx < 0 || nx >= gw || !grid[q] || labels[q]) continue;
          labels[q] = id;
          stack[top++] = q;
        }
      }
    }
    comps.push({ id, area, x0: gx0 * f, y0: gy0 * f, x1: (gx1 + 1) * f - 1, y1: (gy1 + 1) * f - 1 });
  }
  comps.sort((a, b) => b.area - a.area);
  return { f, gw, gh, comps, labels: comps.length > 1 ? labels : null };
}

// Group objects (a herd, a pack picked as one object). A clip is a group
// when at least GROUP_SHARE of its masks hold a second body of at least
// GROUP_SECOND x the main body's area; single subjects (a stray speck, a
// tail cut off by grass) never reach that, so they are left untouched. In
// a group, a member under MEMBER_DROP_AREA x the main body that floats
// (its feet above the main body's mid-height: someone further back, or
// half a body at the frame edge) or stands more than MEMBER_DROP_GAP main
// heights away is left out of the pose, so the row is the group on one
// floor line instead of a crowd with clumps hanging over it.
export const GROUP_SECOND = 0.05;
export const GROUP_SHARE = 0.25;
export const MEMBER_DROP_AREA = 0.25;
export const MEMBER_DROP_GAP = 0.5;
export function isGroupClip(scans) {
  const withBody = scans.filter((s) => s.members?.comps?.length);
  if (!withBody.length) return false;
  const second = withBody.filter((s) => s.members.comps.length > 1 && s.members.comps[1].area >= GROUP_SECOND * s.members.comps[0].area).length;
  return second >= GROUP_SHARE * withBody.length;
}
export function strayMembers(members) {
  if (!members?.labels || members.comps.length < 2) return [];
  const [main, ...rest] = members.comps;
  const mh = main.y1 - main.y0 + 1;
  return rest.filter((c) => {
    if (c.area >= MEMBER_DROP_AREA * main.area) return false;
    const gx = Math.max(0, main.x0 - c.x1, c.x0 - main.x1), gy = Math.max(0, main.y0 - c.y1, c.y0 - main.y1);
    return c.y1 < main.y0 + 0.5 * mh || Math.hypot(gx, gy) > MEMBER_DROP_GAP * mh;
  }).map((c) => c.id);
}
// Clear the dropped members' blocks (and empty blocks touching them, for
// their soft edge) from an RGBA buffer, in place.
export function clearMembers(data, w, h, members, drop) {
  const { f, gw, gh, labels } = members || {};
  if (!labels || !drop?.length) return data;
  const gone = new Uint8Array(gw * gh);
  const ids = new Set(drop);
  for (let p = 0; p < labels.length; p += 1) {
    if (!ids.has(labels[p])) continue;
    const px = p % gw, py = (p - px) / gw;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const q = ny * gw + nx;
      if (!labels[q] || ids.has(labels[q])) gone[q] = 1;
    }
  }
  for (let y = 0; y < h; y += 1) {
    const gRow = ((y / f) | 0) * gw;
    for (let x = 0; x < w; x += 1) if (gone[gRow + ((x / f) | 0)]) data[(y * w + x) * 4 + 3] = 0;
  }
  return data;
}

// Live-tail cells for the now-pose: up to `count` usable kept frames that
// END on the last picked pose. Usable = touch <= 0.15 (unless >= 80% of the
// kept frames touch, i.e. a close-up clip) and solid area >= 40% of the
// median. Fewer than 3 usable lead-in frames -> no live tail (the head
// holds its own observed pose instead of looping a broken one).
export const LIVE_TOUCH_T = 0.15;
// A side counts as cut by the frame when the subject reaches it along at
// least this share of the box side (a hoof or a tail tip grazing the edge
// does not); the viewer scales the dissolve by the share.
export const EDGE_CUT_MIN = 0.1;
// The loop plays ON the now-pose, so it must read as that pose moving.
// Each cell is fitted to its own frame's box, so a lead-in frame whose box
// is much wider or taller than the head's jumps the pose's scale and shape
// on every loop (a subject turning, approaching or stretching): a frame
// joins only while both box sides stay within LIVE_SIZE_T of the head's,
// and the first frame that does not ends the tail.
export const LIVE_SIZE_T = 0.2;
export function liveTail(scans, picked, count = 10) {
  if (!picked.length || count <= 0) return [];
  const head = Math.max(...picked);
  const solids = scans.map((s) => s.solid).sort((a, b) => a - b);
  const medSolid = solids[Math.floor(solids.length / 2)] || 0;
  const closeup = scans.filter((s) => s.touch > LIVE_TOUCH_T).length / scans.length >= 0.8;
  const usable = (i) => scans[i].solid >= 0.4 * medSolid && (closeup || scans[i].touch <= LIVE_TOUCH_T);
  const dims = (i) => { const b = scans[i].box; return b ? [b.x1 - b.x0 + 1, b.y1 - b.y0 + 1] : null; };
  const hd = dims(head);
  const sized = (i) => {
    const d = dims(i);
    return !hd || (d && Math.abs(d[0] / hd[0] - 1) <= LIVE_SIZE_T && Math.abs(d[1] / hd[1] - 1) <= LIVE_SIZE_T);
  };
  const tail = [head];
  for (let i = head - 1; i >= 0 && tail.length < count; i -= 1) {
    if (!usable(i)) continue;
    if (!sized(i)) break;
    tail.unshift(i);
  }
  return tail.length >= 3 ? tail : [];
}

// Ghost trail (atlas.json `trail`; volume.js chronoTrail draws it): the
// tracked frames between consecutive poses, which the viewer picks from to
// lay a stroboscopic row (volume.js STROBE_COUNT cards) instead of a few
// separate copies. Each gap between two poses gets the
// same number of frames (`total` frames on the row, poses included, at most
// `perGap` per gap), the usable frames (the live tail's rule) nearest to
// evenly spaced times; `at` is the frame's place on the row as a fractional
// pose index (g + its share of the gap's time). SAM already tracked every
// one of these frames, so a trail costs packing, never a model call.
export const TRAIL_TOTAL = 24;
export const TRAIL_PER_GAP = 6;
export function trailFrames(scans, picked, timestamps, { total = TRAIL_TOTAL, perGap = TRAIL_PER_GAP } = {}) {
  if (!Array.isArray(picked) || picked.length < 2 || !(total > picked.length)) return [];
  for (let g = 1; g < picked.length; g += 1) if (!(picked[g] > picked[g - 1])) return [];
  const solids = scans.map((s) => s.solid).sort((a, b) => a - b);
  const medSolid = solids[Math.floor(solids.length / 2)] || 0;
  const closeup = scans.filter((s) => s.touch > LIVE_TOUCH_T).length / scans.length >= 0.8;
  const usable = (i) => scans[i].solid >= 0.4 * medSolid && (closeup || scans[i].touch <= LIVE_TOUCH_T);
  const want = Math.min(perGap, Math.max(1, Math.round((total - picked.length) / (picked.length - 1))));
  const out = [];
  for (let g = 0; g + 1 < picked.length; g += 1) {
    const a = picked[g], b = picked[g + 1];
    const ta = Number(timestamps[a]), tb = Number(timestamps[b]);
    if (!(tb > ta)) continue;
    const cands = [];
    for (let i = a + 1; i < b; i += 1) {
      const t = Number(timestamps[i]);
      if (t > ta && t < tb && usable(i)) cands.push(i);
    }
    const used = new Set();
    for (let k = 1; k <= want && used.size < cands.length; k += 1) {
      const target = ta + (k / (want + 1)) * (tb - ta);
      let best = -1, bd = Infinity;
      for (const i of cands) {
        const d = Math.abs(Number(timestamps[i]) - target);
        if (!used.has(i) && d < bd) { bd = d; best = i; }
      }
      used.add(best);
    }
    for (const i of [...used].sort((x, y) => x - y)) out.push({ index: i, at: g + (Number(timestamps[i]) - ta) / (tb - ta) });
  }
  return out;
}

// Grid for `n` cells of cellW x cellH: the column count with the smallest
// texture side, and the cell scale that keeps that side under `maxSide`.
export const ATLAS_MAX_SIDE = 2048;
export function atlasGrid(n, cellW, cellH, maxSide = ATLAS_MAX_SIDE) {
  let best = null;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const side = Math.max(cols * cellW, rows * cellH);
    if (!best || side < best.side) best = { cols, rows, side };
  }
  const s = Math.min(1, maxSide / best.side);
  return { cols: best.cols, rows: best.rows, cellW: Math.max(8, Math.floor(cellW * s)), cellH: Math.max(8, Math.floor(cellH * s)) };
}

// Far poses. A subject that approaches from the distance starts as a few
// dozen pixels, and contain-fit blows that pose up 10x into a smeared blob
// (a cyclist 50 px tall, slovenska). Drop poses that need more than
// max(FAR_POSE_ABS, FAR_POSE_REL x the least-enlarged pose's) enlargement;
// the now-pose always stays and at least `min` poses remain (the least
// enlarged of the dropped ones come back first). Rows of similar-sized
// poses never change: nothing is enlarged past 2.5x there.
export const FAR_POSE_ABS = 2.5;
export const FAR_POSE_REL = 2;
export function dropFarPoses(picked, boxes, cell, { min = 3 } = {}) {
  if (picked.length <= min) return picked;
  const bw = (i) => boxes[i].x1 - boxes[i].x0 + 5, bh = (i) => boxes[i].y1 - boxes[i].y0 + 5;
  const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const mw = Math.max(1, med(picked.map(bw))), mh = Math.max(1, med(picked.map(bh)));
  const cellH = Math.min(cell * 2, Math.max(1, Math.round((mh / mw) * cell)));
  const up = (i) => Math.min(cell / bw(i), cellH / bh(i));
  const limit = Math.max(FAR_POSE_ABS, FAR_POSE_REL * Math.min(...picked.map(up)));
  const last = picked[picked.length - 1];
  const keep = picked.filter((i) => i === last || up(i) <= limit);
  const dropped = picked.filter((i) => !keep.includes(i)).sort((a, b) => up(a) - up(b));
  while (keep.length < min && dropped.length) keep.push(dropped.shift());
  return keep.sort((a, b) => a - b);
}

// Living still: a subject that barely moves (a mug changing colour, a
// person talking) has no sequence, and used to FAIL the job after tracking
// was paid for. It ships as one pose instead, whose live loop plays the
// whole clip as a time-lapse: up to `count` usable frames evenly spread,
// ending on the pose (same usability rule as the live tail).
export function stillLoop(scans, head, count = 15) {
  if (!Number.isInteger(head) || count <= 0) return [];
  const solids = scans.map((s) => s.solid).sort((a, b) => a - b);
  const medSolid = solids[Math.floor(solids.length / 2)] || 0;
  const closeup = scans.filter((s) => s.touch > LIVE_TOUCH_T).length / scans.length >= 0.8;
  const usable = [];
  for (let i = 0; i < head; i += 1) if (scans[i].solid >= 0.4 * medSolid && (closeup || scans[i].touch <= LIVE_TOUCH_T)) usable.push(i);
  const lead = usable.length <= count - 1 ? usable : evenSubsample(usable, count - 1);
  const loop = [...lead, head];
  return loop.length >= 3 ? loop : [];
}

// Chrono pack: the generate path for the product viewer. Coverage-filter,
// motion-select (lite-pose.js), defringe every kept pose, contain-fit into
// uniform CHRONO-scale cells, then append the clip tail as live cells for
// the now-pose. Contract: same grid fields as packAtlas (cols/rows/cellW/
// cellH/aspect/timestamps) plus additive poses/live/anchors/subjectFill.
// `poses` are sourceFrameIndex values in row order; `live` is a cell range
// {start, count}; `anchors` are per-pose {top, bottom} bbox fractions (from
// the cell top) so the viewer can sit every bbox bottom on the ground.
export async function packChronoAtlas(slices, {
  cell = CHRONO_CELL, maxPoses = 12, liveCount = 10, quality = 82,
  erode = 1, feather = 1, bleed = 3, preserveAlpha = false, plate = null, plates = null, plateMasks = null, cameraFixed = false,
  edgeBottom = null,
  // true: a static subject packs as a living still (one pose + a time-lapse
  // loop) instead of returning motion.static for the caller to fail on.
  staticStill = false,
  // Edge colour decontamination ring in cell px (0 = off): decontaminateEdge.
  edgeRing = EDGE_RING,
  // Ghost-trail frames on the row, poses included (0 = no trail): trailFrames.
  trail = TRAIL_TOTAL,
} = {}) {
  if (!slices.length) throw new Error("No tracked frames to pack.");
  // One decode per slice: coverage, alpha box, pose stats, in-box fill and
  // frame-edge truncation all come from the same pixels, then the raw
  // buffer is dropped. (Slices are full source resolution now; holding 90
  // raw frames would cost ~330 MB.)
  const scanOpts = edgeBottom > 0 ? { bottom: edgeBottom } : {};
  const scans = await mapLimit(slices, 6, async (s) => {
    const { data, info } = await sharp(s.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return scanSlice(data, info.width, info.height, scanOpts);
  });
  // A group object leaves its stray members out (see isGroupClip): those
  // slices are re-decoded, cleared, re-scanned and re-encoded once, so
  // everything below sees the cleaned masks. Single subjects skip this.
  const group = isGroupClip(scans);
  if (group) {
    slices = [...slices];
    await mapLimit(slices.map((_, i) => i), 6, async (i) => {
      const drop = strayMembers(scans[i].members);
      if (!drop.length) return;
      const { data, info } = await sharp(slices[i].buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      clearMembers(data, info.width, info.height, scans[i].members, drop);
      scans[i] = scanSlice(data, info.width, info.height, scanOpts);
      const buffer = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
      slices[i] = { ...slices[i], buffer };
    });
  }
  const coverage = scans.map((r) => r.coverage);
  const median = [...coverage].sort((a, b) => a - b)[Math.floor(coverage.length / 2)];
  const keptIdx = slices.map((_, i) => i).filter((i) => coverage[i] >= median * 0.2 && scans[i].box);
  if (!keptIdx.length) throw new Error("Every tracked frame was empty.");
  const keptAll = keptIdx.map((i) => slices[i]);
  const keptScans = keptIdx.map((i) => scans[i]);
  const srcW = keptScans[0].width;
  const srcH = keptScans[0].height;
  const boxes = keptScans.map((r) => r.box);
  if (!boxes.length) throw new Error("Every tracked frame was empty.");
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (const b of boxes) {
    if (b.x0 < minX) minX = b.x0;
    if (b.y0 < minY) minY = b.y0;
    if (b.x1 > maxX) maxX = b.x1;
    if (b.y1 > maxY) maxY = b.y1;
  }
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(srcW - 1, maxX + pad);
  maxY = Math.min(srcH - 1, maxY + pad);

  const stats = keptScans.map((r) => r.stats);
  let picked = selectPoses(stats, {
    max: maxPoses,
    timestamps: keptAll.map((s) => s.timestamp),
  });
  // Cap by rendered size, not count: thin the line until visible subjects
  // clear ~14% canvas height wide. First/last kept, time order preserved.
  {
    const tsAll = keptAll.map((s) => s.timestamp);
    const dims = picked.map((i) => boxes[i]);
    const med = (vals) => [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
    const bw = Math.max(1, med(dims.map((b) => b.x1 - b.x0 + 1)));
    const bh = Math.max(1, med(dims.map((b) => b.y1 - b.y0 + 1)));
    const fills = keptScans.map((r) => r.fill).sort((a, b) => a - b);
    picked = sizeCapCount(picked, picked.map((i) => tsAll[i]), {
      poseW: 3.4 * (bw / bh),
      coverage: fills.length ? fills[Math.floor(fills.length / 2)] : 1,
    });
  }
  picked = dropFarPoses(picked, boxes, cell);
  // Motion gate data: mean pairwise travel+appearance over the picked set.
  // A static subject either becomes a living still (staticStill) or is
  // reported for the caller to fail (a still mug would otherwise render as
  // 2-3 identical copies).
  const motionMean = meanPairwiseMotion(picked.map((i) => stats[i]));
  const motion = { mean: motionMean, static: motionMean < STATIC_MOTION };
  const still = staticStill && motion.static;
  if (still) picked = [picked[picked.length - 1]];
  // Live tail: the frames leading up to the now-pose play on it, ending ON
  // it. Only usable frames (same rule as the Still: not cut by the picture
  // edge unless the whole clip is a close-up, and at least 40% of the
  // median area) — the clip's last frames are often the subject leaving,
  // and those used to loop on the most prominent pose as a truncated blob.
  const tailIdx = still ? stillLoop(keptScans, picked[0], 15) : liveTail(keptScans, picked, liveCount);
  const trailSel = still || !(trail > 0) ? [] : trailFrames(keptScans, picked, keptAll.map((s) => s.timestamp), { total: trail });

  const medianOf = (vals) => [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  const selBoxes = picked.map((i) => boxes[i]);
  const medBW = Math.max(1, medianOf(selBoxes.map((b) => b.x1 - b.x0 + 1)));
  const medBH = Math.max(1, medianOf(selBoxes.map((b) => b.y1 - b.y0 + 1)));
  const order = [...picked, ...tailIdx.filter((i) => !picked.includes(i))];
  for (const { index } of trailSel) if (!order.includes(index)) order.push(index);
  let cellW = cell;
  let cellH = Math.min(cell * 2, Math.max(1, Math.round((medBH / medBW) * cell)));
  let cols = Math.ceil(Math.sqrt(order.length));
  let rows = Math.ceil(order.length / cols);
  // A trail triples the cells: pick the squarest grid and keep the texture
  // side at ATLAS_MAX_SIDE (16 MB of GPU memory), shrinking the cells if needed.
  if (trailSel.length) ({ cols, rows, cellW, cellH } = atlasGrid(order.length, cellW, cellH));
  const fitScale = Math.min(cellW / medBW, cellH / medBH);
  const subjectFill = {
    w: Math.min(1, (medBW * fitScale) / cellW),
    h: Math.min(1, (medBH * fitScale) / cellH),
  };

  const padBox = (b) => ({
    left: Math.max(0, b.x0 - pad),
    top: Math.max(0, b.y0 - pad),
    width: Math.min(srcW - Math.max(0, b.x0 - pad), b.x1 - b.x0 + 1 + 2 * pad),
    height: Math.min(srcH - Math.max(0, b.y0 - pad), b.y1 - b.y0 + 1 + 2 * pad),
  });
  // Defringed cell PNGs + per-pose cell-space anchors (fractions from top).
  // No auto-exposure bake: subject chroma/luma stay byte-identical (a gamma
  // lift turned black fur mauve). Dark subjects are flagged (meta.dark) so
  // the viewer can lift its brightness FLOOR (chroma-safe flat multiply)
  // and the pack renders their backdrop brighter for silhouette contrast.
  // Promise.all preserves cell order, not callback completion order.
  const cellAnchors = new Array(order.length);
  // Each cell's enlargement from source pixels (its box fits the cell on its
  // own): a ghost trail draws every frame at its true size beside the now-pose.
  const cellFit = new Array(order.length).fill(1);
  const exposure = new Array(picked.length);
  const medians = new Array(picked.length);
  const cuts = new Array(order.length).fill(null);
  const cells = await Promise.all(
    order.map(async (i, n) => {
      const b = boxes[i];
      const box = padBox(b);
      const { data, info } = await sharp(keptAll[i].buffer)
        .extract(box).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const clean = defringe(Buffer.from(data), info.width, info.height, { erode, feather, bleed, preserveAlpha });
      // Luminance recorded, never baked: the median decides the dark flag
      // (poses only; live cells never used it).
      if (n < picked.length) {
        const med = medianLuma(clean, info.width, info.height);
        medians[n] = med;
        exposure[n] = { gamma: 1, median: Math.round(med * 1000) / 1000 };
      }
      const lifted = clean;
      const resized = await cellResize(lifted, info.width, info.height, cellW, cellH);
      const bw = box.width, bh = box.height;
      const s = Math.min(cellW / bw, cellH / bh);
      cellFit[n] = s;
      // The mixed edge is ~2 source px wide: an upscaled cell (a small or far
      // subject) gets a proportionally wider ring, at most twice as wide.
      const ring = edgeRing > 0 ? Math.min(2 * edgeRing, Math.max(edgeRing, Math.round(edgeRing * s))) : 0;
      const final = ring > 0 ? decontaminateEdge(resized.data, resized.info.width, resized.info.height, { ring }) : resized.data;
      const dw = Math.max(1, Math.round(bw * s)), dh = Math.max(1, Math.round(bh * s));
      const ox = Math.round((cellW - dw) / 2), oy = Math.round((cellH - dh) / 2);
      cellAnchors[n] = {
        top: oy / cellH,
        bottom: Math.min(1, (oy + dh) / cellH),
        left: ox / cellW,
        right: Math.min(1, (ox + dw) / cellW),
      };
      // Frame-cut sides of this cell (poses and live cells alike): the share
      // of each side [left, right, top, bottom] the frame cuts, with the
      // cut-out's rect in the cell, so the viewer dissolves the body toward
      // that side instead of ending it in a straight line.
      const sides = keptScans[i].cut.map((c) => (c >= EDGE_CUT_MIN ? Math.round(c * 100) / 100 : 0));
      if (sides.some(Boolean)) {
        const r4 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
        cuts[n] = { sides, rect: [r4(ox / cellW), r4(oy / cellH), r4((ox + dw) / cellW), r4((oy + dh) / cellH)] };
      }
      return sharp(final, { raw: { width: resized.info.width, height: resized.info.height, channels: 4 } })
        .png()
        .toBuffer();
    })
  );
  const encode = (q) => sharp({
    create: { width: cols * cellW, height: rows * cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(cells.map((input, i) => ({ input, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH })))
    .webp({ quality: q, alphaQuality: 90, effort: 6 })
    .toBuffer();
  let atlas = await encode(quality);
  // Hard file budget (~2 MB): step quality down twice before accepting.
  for (const q of [70, 60]) {
    if (atlas.length <= CHRONO_MAX_BYTES) break;
    atlas = await encode(q);
  }
  const anchors = cellAnchors.slice(0, picked.length);
  const liveStart = picked.length;
  const liveCounted = Math.min(order.length, picked.length + tailIdx.filter((i) => !picked.includes(i)).length) - picked.length;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const trailOut = trailSel.length ? {
    cells: trailSel.map((s) => order.indexOf(s.index)),
    at: trailSel.map((s) => r4(s.at)),
    bottom: trailSel.map((s) => r4(cellAnchors[order.indexOf(s.index)].bottom)),
    fit: trailSel.map((s) => r4(cellFit[order.indexOf(s.index)])),
    poseFit: picked.map((_, n) => r4(cellFit[n])),
  } : null;
  // Dark-subject flag: median picked luminance below the floor. The viewer
  // lifts its brightness FLOOR (chroma-safe flat multiply) and the pack
  // renders the backdrop brighter behind them; cell pixels stay untouched.
  const medSorted = [...medians].sort((a, b) => a - b);
  const dark = medians.length > 0 && medSorted[Math.floor(medSorted.length / 2)] < 0.22;
  // Optional ambient stage (see buildChronoBackdrop). A plate failure (or
  // none) leaves the atlas without it and the viewer keeps the void.
  const rect = unionRect(boxes, 16, srcW, srcH);
  const { backdrop, backdropKind, backdropQa } = await buildChronoBackdrop({ plate, plates, plateMasks, cameraFixed, rect, dark });
  return {
    atlas,
    bytes: atlas.length,
    kept: picked.map((i) => ({
      timestamp: keptAll[i].timestamp,
      sourceFrameIndex: keptAll[i].sourceFrameIndex,
      concept: keptAll[i].concept,
    })),
    cols,
    rows,
    cellW,
    cellH,
    crop: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    subjectFill,
    poses: picked.map((i) => keptAll[i].sourceFrameIndex),
    live: { start: liveStart, count: liveCounted },
    liveFrames: order.slice(picked.length, picked.length + liveCounted).map((i) => keptAll[i].sourceFrameIndex),
    trail: trailOut,
    trailFrames: trailSel.map((s) => keptAll[s.index].sourceFrameIndex),
    // the subject's sideways travel in the frame, first pose to the now-pose (frame widths)
    frameTravel: picked.length > 1 ? Math.round((((boxes[picked[picked.length - 1]].x0 + boxes[picked[picked.length - 1]].x1) - (boxes[picked[0]].x0 + boxes[picked[0]].x1)) / 2 / srcW) * 1000) / 1000 : 0,
    anchors,
    cuts: cuts.some(Boolean) ? cuts : null,
    firstPose: cells[0],
    exposure,
    dark,
    motion,
    still,
    group,
    backdropQa,
    backdrop,
    backdropKind,
    stageRect: rect,
  };
}

// Ambient stage from the JS plates. Fixed-camera clips get the sharp
// temporal-median plate; moving cameras keep the blurred card. Never
// throws: a failure is {backdrop: null}. (The runner prefers the
// registered plate from lite_plate.py and uses this as its fallback.)
export async function buildChronoBackdrop({ plate = null, plates = null, plateMasks = null, cameraFixed = false, rect = null, dark = false } = {}) {
  let backdrop = null;
  let backdropKind = null;
  let backdropQa = null;
  if (rect) {
    try {
      if (cameraFixed && Array.isArray(plates) && plates.length >= 3) {
        // Sharp plate with per-frame SAM masks + QA: unknown share or a
        // ghost metric above threshold falls back to the blurred card for
        // the whole stage (a plate needs QA before it ships).
        const sharp = await buildSharpBackdrop(plates, plateMasks, dark ? { luma: 0.76, blurLuma: 0.38 } : {});
        backdropQa = { decision: sharp.fallback ? "blur" : "sharp", unknownShare: sharp.unknownShare, ghost: sharp.ghost };
        if (sharp.fallback) {
          backdrop = sharp.blur;
          backdropKind = "blur";
        } else {
          backdrop = sharp;
          backdropKind = "sharp";
        }
      } else if (plate) {
        backdrop = await buildBackdrop(plate, rect, dark ? { luma: 0.38 } : {});
        backdropKind = "blur";
      }
    } catch {
      backdrop = null;
      backdropKind = null;
    }
  }
  return { backdrop, backdropKind, backdropQa };
}

// Registered plate (lite_plate.py PNG) -> stage backdrop: dimmed toward the
// sharp plate's luma (never brightened), webp. Same output shape as
// buildSharpBackdrop's success value.
export async function finishPlate(png, { luma = 0.70, quality = 75 } = {}) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const ch = info.channels;
  let sum = 0;
  for (let p = 0, o = 0; p < n; p += 1, o += ch) sum += (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  const gain = sum / n > luma ? luma / (sum / n) : 1;
  const out = Buffer.from(data);
  if (gain < 1) for (let o = 0; o < out.length; o += 1) out[o] = Math.round(out[o] * gain);
  const buffer = await sharp(out, { raw: { width: info.width, height: info.height, channels: ch } }).webp({ quality }).toBuffer();
  return { buffer, width: info.width, height: info.height, kind: "sharp" };
}

// With a backdrop (the build's own plate) the cut-out stands in its place,
// 16:9, as the viewer shows it: a cut-out alone on the site's dark lists
// reads in a false colour (black fur looked mauve on navy).
export async function makeThumb(firstSliceBuffer, width = 480, { backdrop = null } = {}) {
  if (!backdrop) return sharp(firstSliceBuffer).resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  const W = width, H = Math.round((width * 9) / 16);
  const pose = await sharp(firstSliceBuffer)
    .resize({ width: Math.round(W * 0.8), height: Math.round(H * 0.86), fit: "inside" })
    .png().toBuffer({ resolveWithObject: true });
  const left = Math.round((W - pose.info.width) / 2), top = Math.max(0, H - pose.info.height - Math.round(H * 0.04));
  return sharp(backdrop).resize(W, H, { fit: "cover" })
    .composite([{ input: pose.data, left, top }])
    .webp({ quality: 80 }).toBuffer();
}
