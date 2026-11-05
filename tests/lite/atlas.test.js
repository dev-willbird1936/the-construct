import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const requireBackend = createRequire(new URL("../../backend/app/atlas.js", import.meta.url));
const sharp = requireBackend("sharp");
const { packAtlas, packChronoAtlas, decontaminateEdge, EDGE_RING, defringe, premultiplyAlpha, unpremultiplyAlpha, medianLuma, unionRect, buildBackdrop, buildSharpBackdrop, evenSubsample, medianCoverage, sizeCapCount } = await import("../../backend/app/atlas.js");

async function solidPng(w, h, rect) {
  // Transparent PNG with one opaque white rect {x,y,w,h}.
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const o = (y * w + x) * 4;
      buf[o] = buf[o + 1] = buf[o + 2] = 255;
      buf[o + 3] = 255;
    }
  }
  return sharp(Buffer.from(buf), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

const slice = (buffer, i) => ({ buffer, timestamp: i, sourceFrameIndex: i, concept: "cat" });

test("travelling subject: every pose fills its own centred cell", async () => {
  const left = await solidPng(100, 40, { x: 0, y: 5, w: 40, h: 30 });
  const right = await solidPng(100, 40, { x: 60, y: 5, w: 40, h: 30 });
  const packed = await packAtlas([slice(left, 0), slice(right, 1), slice(left, 2)], { cell: 32 });
  assert.equal(packed.crop.w, 100); // union still recorded for provenance
  assert.ok(packed.subjectFill.w > 0.9 && packed.subjectFill.h > 0.9,
    `fill ${JSON.stringify(packed.subjectFill)}`);
  assert.equal(packed.kept.length, 3); // contract: kept list intact
  assert.ok(packed.cols * packed.rows >= 3);
  // First cell (left pose) fills its cell: middle pixel opaque, and the
  // 1-px letterbox column on the right (31-px content in a 32-px cell) clear.
  const { data, info } = await sharp(packed.atlas)
    .extract({ left: 0, top: 0, width: packed.cellW, height: packed.cellH })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => data[(y * info.width + x) * 4 + 3];
  assert.ok(at(packed.cellW >> 1, packed.cellH >> 1) > 200, "cell centre opaque");
  assert.ok(at(packed.cellW - 1, packed.cellH >> 1) < 128, "letterbox column clear");
});

test("still subject keeps fill near 1 (no zoom surprise)", async () => {
  const a = await solidPng(80, 60, { x: 10, y: 10, w: 60, h: 40 });
  const packed = await packAtlas([slice(a, 0), slice(a, 1)], { cell: 32 });
  assert.ok(packed.subjectFill.w > 0.9, `fill.w ${packed.subjectFill.w}`);
  assert.ok(packed.subjectFill.h > 0.9, `fill.h ${packed.subjectFill.h}`);
});

test("all-empty frames still throw", async () => {
  const empty = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  await assert.rejects(() => packAtlas([slice(empty, 0)]), /empty/i);
});

function rgbaFrame(w, h, paint) {
  const buf = Buffer.alloc(w * h * 4, 0);
  paint(buf);
  return buf;
}

test("defringe erases a 1px semi halo ring", () => {
  const W = 20, H = 20;
  const buf = rgbaFrame(W, H, (b) => {
    for (let y = 6; y < 14; y += 1) for (let x = 6; x < 14; x += 1) {
      const o = (y * W + x) * 4;
      b[o] = b[o + 1] = b[o + 2] = 200; b[o + 3] = 255;
    }
    // halo ring: semi alpha, near-white (the resampling fringe)
    for (let y = 5; y < 15; y += 1) for (let x = 5; x < 15; x += 1) {
      if (x >= 6 && x < 14 && y >= 6 && y < 14) continue;
      const o = (y * W + x) * 4;
      b[o] = b[o + 1] = b[o + 2] = 250; b[o + 3] = 110;
    }
  });
  const out = defringe(buf, W, H, { erode: 1, feather: 0, bleed: 0 });
  assert.equal(out[(5 * W + 10) * 4 + 3], 0, "halo ring erased");
  assert.ok(out[(10 * W + 10) * 4 + 3] > 200, "core stays opaque");
});

test("selected alpha preservation retains detached valid parts and thin bridges before resizing", () => {
  const W = 24, H = 12;
  const rgba = rgbaFrame(W, H, b => {
    for (let y = 2; y < 10; y++) for (let x = 2; x < 12; x++) {
      const i = (y * W + x) * 4; b[i] = 170; b[i + 1] = 90; b[i + 2] = 40; b[i + 3] = 255;
    }
    // A detached real fragment cannot be distinguished from a droplet by topology alone.
    for (const [x,y] of [[20,3],[21,3],[20,4],[21,4],[12,5],[13,5],[14,5]]) {
      const i = (y * W + x) * 4; b[i] = 170; b[i + 1] = 90; b[i + 2] = 40; b[i + 3] = 255;
    }
  });
  const preserved = defringe(rgba, W, H, { preserveAlpha: true });
  assert.deepEqual(preserved, rgba);
  assert.notEqual(preserved, rgba, "returns a copy, not a mutable alias");
  assert.notDeepEqual(defringe(rgba, W, H, { erode: 0, feather: 0, bleed: 0 }), rgba,
    "zero cleanup sliders still drop components on the legacy path");
});

test("defringe feather softens a hard edge", () => {
  const W = 20, H = 10;
  const buf = rgbaFrame(W, H, (b) => {
    for (let y = 0; y < H; y += 1) for (let x = 10; x < W; x += 1) {
      const o = (y * W + x) * 4;
      b[o] = b[o + 1] = b[o + 2] = 200; b[o + 3] = 255;
    }
  });
  const out = defringe(buf, W, H, { erode: 0, feather: 1, bleed: 0 });
  const edge = out[(5 * W + 10) * 4 + 3];
  assert.ok(edge > 0 && edge < 255, `edge feathered (${edge})`);
  assert.equal(out[(5 * W + 0) * 4 + 3], 0, "far field stays clear");
});

test("defringe bleeds interior colour without touching alpha", () => {  const W = 12, H = 12;
  const buf = rgbaFrame(W, H, (b) => {
    for (let y = 4; y < 8; y += 1) for (let x = 4; x < 8; x += 1) {
      const o = (y * W + x) * 4;
      b[o] = 180; b[o + 1] = 60; b[o + 2] = 20; b[o + 3] = 255;
    }
  });
  const out = defringe(buf, W, H, { erode: 0, feather: 0, bleed: 2 });
  const o = (4 * W + 2) * 4; // two px left of the block, reached by bleed 2
  assert.equal(out[o + 3], 0, "alpha untouched");
  assert.ok(out[o] > 100 && out[o + 1] < 100, "interior colour bled into the clear margin");
});

test("defringe despeckles a detached droplet", () => {  const W = 24, H = 12;
  const buf = rgbaFrame(W, H, (b) => {
    for (let y = 2; y < 10; y += 1) for (let x = 2; x < 12; x += 1) {
      const o = (y * W + x) * 4;
      b[o] = b[o + 1] = b[o + 2] = 200; b[o + 3] = 255;
    }
    // detached 2x2 droplet far from the body
    for (let y = 2; y < 4; y += 1) for (let x = 20; x < 22; x += 1) {
      const o = (y * W + x) * 4;
      b[o] = b[o + 1] = b[o + 2] = 200; b[o + 3] = 255;
    }
  });
  const out = defringe(buf, W, H, { erode: 0, feather: 0, bleed: 0 });
  assert.equal(out[(3 * W + 20) * 4 + 3], 0, "droplet alpha removed");
  assert.ok(out[(6 * W + 6) * 4 + 3] > 200, "body survives");
});

test("premultiply/unpremultiply round-trips edge pixels", () => {
  // Semi edge pixel: straight (200,100,50,128) -> premul (100,50,25,128).
  const buf = Buffer.from([200, 100, 50, 128, 0, 0, 0, 0, 255, 255, 255, 255, 10, 20, 30, 0]);
  const pre = premultiplyAlpha(buf, 2, 2);
  assert.deepEqual([pre[0], pre[1], pre[2], pre[3]], [100, 50, 25, 128]);
  assert.deepEqual([pre[4], pre[5], pre[6], pre[7]], [0, 0, 0, 0]);
  assert.deepEqual([pre[8], pre[9], pre[10], pre[11]], [255, 255, 255, 255]);
  const back = unpremultiplyAlpha(pre, 2, 2);
  // Round-trip is exact up to ±1 (integer premultiplication is lossy).
  for (const [got, want] of [[back[0], 200], [back[1], 100], [back[2], 50]]) {
    assert.ok(Math.abs(got - want) <= 1, `roundtrip ${got} ~= ${want}`);
  }
  assert.equal(back[3], 128);
  // Transparent RGB is destroyed by premultiplication (zeros) — this is
  // why the pack path bleeds interior colour BEFORE premultiplying.
  assert.deepEqual([back[12], back[13], back[14], back[15]], [0, 0, 0, 0]);
});

test("packChronoAtlas selects, spaces and anchors poses plus a live tail", async () => {
  // Travelling white block, 24 frames over 4.8 s: selection must thin it
  // with time gaps; the tail becomes live cells.
  const frames = [];
  for (let i = 0; i < 24; i += 1) {
    frames.push(slice(await solidPng(120, 60, { x: 5 + i * 4, y: 15, w: 22, h: 30 }), i));
    frames[i].timestamp = i * 0.2;
  }
  const packed = await packChronoAtlas(frames, { cell: 32, maxPoses: 8, liveCount: 4 });
  assert.ok(packed.kept.length <= 8, `poses ${packed.kept.length}`);
  assert.ok(packed.kept.length >= 3, "row still stands");
  const ts = packed.kept.map((k) => k.timestamp);
  for (let k = 1; k < ts.length; k += 1) assert.ok(ts[k] - ts[k - 1] >= 0.19, `gap ${ts}`);
  assert.equal(packed.live.start, packed.kept.length);
  assert.ok(packed.live.count >= 1 && packed.live.count <= 4, `live ${packed.live.count}`);
  assert.equal(packed.anchors.length, packed.kept.length);
  for (const a of packed.anchors) {
    assert.ok(a.top >= 0 && a.top <= 1 && a.bottom >= a.top && a.bottom <= 1, `anchor ${JSON.stringify(a)}`);
  }
  assert.ok(packed.cols * packed.cellW <= 4096, "atlas width budget");
  assert.ok(packed.bytes < 2000000, `file budget (${packed.bytes})`);
  assert.deepEqual(packed.poses, packed.kept.map((k) => k.sourceFrameIndex));
});

test("dark subjects flag, never bake: median measured, pixels untouched", () => {
  const W = 16, H = 16;
  const dark = rgbaFrame(W, H, (b) => {
    for (let y = 2; y < 14; y += 1) for (let x = 2; x < 14; x += 1) {
      const o = (y * W + x) * 4;
      b[o] = 25; b[o + 1] = 20; b[o + 2] = 18; b[o + 3] = 255;
    }
  });
  // Dropped gamma lifts turned this fur mauve; now the pack only measures.
  assert.ok(medianLuma(dark, W, H) < 0.22, `dark median ${medianLuma(dark, W, H)}`);
  const bright = rgbaFrame(W, H, (b) => {
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      b[o] = b[o + 1] = b[o + 2] = 230; b[o + 3] = 255;
    }
  });
  assert.ok(medianLuma(bright, W, H) >= 0.22, "bright median");
});

async function platePng(w, h) {
  // Gradient room + bright subject rect (the occluder to be filled).
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const o = (y * w + x) * 3;
    buf[o] = Math.round((x / w) * 120 + 20);
    buf[o + 1] = Math.round((y / h) * 100 + 30);
    buf[o + 2] = 90;
  }
  for (let y = 30; y < 60; y += 1) for (let x = 60; x < 100; x += 1) {
    const o = (y * w + x) * 3;
    buf[o] = buf[o + 1] = buf[o + 2] = 250;
  }
  return sharp(Buffer.from(buf), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test("buildBackdrop fills the subject, darkens and desaturates", async () => {
  const plate = await platePng(160, 90);
  const t0 = Date.now();
  const out = await buildBackdrop(plate, { x: 60 / 160, y: 30 / 90, w: 40 / 160, h: 30 / 90 });
  const ms = Date.now() - t0;
  assert.equal(out.width, 384, "~384px wide");
  assert.ok(out.buffer.length > 300 && out.buffer.length < 200000, `bytes ${out.buffer.length}`);
  const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let p = 0, o = 0; p < info.width * info.height; p += 1, o += info.channels) {
    sum += (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  }
  const mean = sum / (info.width * info.height);
  assert.ok(mean >= 0.15 && mean <= 0.35, `backdrop luma ${mean.toFixed(3)} in the 25-30% band`);
  // Subject region no longer white: heavily blurred background instead.
  const cx = Math.floor(info.width * 80 / 160), cyy = Math.floor(info.height * 45 / 90);
  const co = (cyy * info.width + cx) * info.channels;
  const cl = (0.299 * data[co] + 0.587 * data[co + 1] + 0.114 * data[co + 2]) / 255;
  assert.ok(cl < 0.5, `filled subject luma ${cl.toFixed(3)} (was ~1.0)`);
  assert.ok(ms < 30000, `build took ${ms}ms`);
}, { timeout: 60000 });

test("packChronoAtlas records exposure and optional backdrop", async () => {
  const frames = [];
  for (let i = 0; i < 24; i += 1) {
    // Dark travelling block: exposure must kick in.
    const buf = Buffer.alloc(120 * 60 * 4, 0);
    for (let y = 15; y < 45; y += 1) for (let x = 5 + i * 4; x < 27 + i * 4; x += 1) {
      if (x < 0 || x >= 120) continue;
      const o = (y * 120 + x) * 4;
      buf[o] = 30; buf[o + 1] = 25; buf[o + 2] = 22; buf[o + 3] = 255;
    }
    const png = await sharp(buf, { raw: { width: 120, height: 60, channels: 4 } }).png().toBuffer();
    frames.push({ buffer: png, timestamp: i * 0.2, sourceFrameIndex: i, concept: "cat" });
  }
  const plate = await platePng(160, 90);
  const packed = await packChronoAtlas(frames, { cell: 32, maxPoses: 8, liveCount: 4, plate });
  assert.equal(packed.exposure.length, packed.kept.length);
  // No gamma bake (dropped: it pushed dark fur mauve); dark flag set.
  assert.ok(packed.exposure.every((e) => e.gamma === 1), "gamma always 1");
  assert.equal(packed.dark, true, "dark subjects flagged");
  assert.ok(packed.backdrop && packed.backdrop.width === 384, "backdrop built");
  assert.ok(packed.backdrop.buffer.length > 300, "backdrop bytes");
  // No plate -> no backdrop field, same poses contract.
  const bare = await packChronoAtlas(frames, { cell: 32, maxPoses: 8, liveCount: 4 });
  assert.equal(bare.backdrop, null);
  assert.equal(bare.exposure.length, bare.kept.length);
  assert.deepEqual(bare.poses, packed.poses);
});

test("buildSharpBackdrop rejects a static-footprint subject (80% same pixels)", async () => {
  // The cougar defect in miniature: the subject sits on the same pixels
  // in 8 of 10 frames, so the median cannot reject it — the unknown share
  // (8 clean < 3) exceeds ~4% and the whole stage falls back to blur.
  const W = 160, H = 90;
  const bg = async () => {
    const buf = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i += 1) { buf[i * 3] = 180; buf[i * 3 + 1] = 170; buf[i * 3 + 2] = 160; }
    return sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  };
  const withSubject = async () => {
    const buf = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 3;
      const inSub = x >= 60 && x < 108 && y >= 27 && y < 63;
      buf[o] = inSub ? 40 : 180; buf[o + 1] = inSub ? 25 : 170; buf[o + 2] = inSub ? 20 : 160;
    }
    return sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  };
  // Mask = opaque rect over the subject, transparent elsewhere.
  const maskFor = async (has) => {
    const buf = Buffer.alloc(W * H * 4, 0);
    if (has) {
      for (let y = 27; y < 63; y += 1) for (let x = 60; x < 108; x += 1) buf[(y * W + x) * 4 + 3] = 255;
    }
    return sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  };
  const frames = [];
  const masks = [];
  for (let i = 0; i < 10; i += 1) {
    const bad = i < 8;
    frames.push(bad ? await withSubject() : await bg());
    masks.push(bad ? [await maskFor(true)] : null);
  }
  const out = await buildSharpBackdrop(frames, masks, { width: 160 });
  assert.equal(out.fallback, true, `static footprint falls back (share=${out.unknownShare?.toFixed(3)})`);
  assert.ok(out.unknownShare > 0.04, `unknown share ${out.unknownShare?.toFixed(3)} over ~4%`);
  assert.ok(out.blur && out.blur.width === 384 && out.blur.buffer.length > 0, "fallback blur card shipped");
});

test("buildSharpBackdrop keeps a crossing subject (masks move, plate stays)", async () => {
  // The subject crosses the frame: every background pixel votes in ~9 of
  // 10 frames, so the unknown share stays ~0 and the median is clean.
  const W = 160, H = 90;
  const frameAt = async (sx) => {
    const buf = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 3;
      const inSub = x >= sx && x < sx + 20 && y >= 35 && y < 55;
      buf[o] = inSub ? 40 : 180; buf[o + 1] = inSub ? 25 : 170; buf[o + 2] = inSub ? 20 : 160;
    }
    return sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  };
  const maskAt = async (sx) => {
    const buf = Buffer.alloc(W * H * 4, 0);
    for (let y = 35; y < 55; y += 1) for (let x = sx; x < sx + 20; x += 1) {
      if (x >= 0 && x < W) buf[(y * W + x) * 4 + 3] = 255;
    }
    return sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  };
  const frames = [];
  const masks = [];
  for (let i = 0; i < 10; i += 1) {
    const sx = Math.round((i * (W - 20)) / 9);
    frames.push(await frameAt(sx));
    masks.push([await maskAt(sx)]);
  }
  const out = await buildSharpBackdrop(frames, masks, { width: 160 });
  assert.ok(!out.fallback, `crossing subject keeps the plate (share=${out.unknownShare?.toFixed(4)}, ghost=${out.ghost?.toFixed(4)})`);
  assert.equal(out.kind, "sharp");
  // The crossed band reads as background, not subject: sample its middle.
  const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  const o = ((H >> 1) * info.width + (W >> 1)) * 3;
  assert.ok(data[o] > 120 && data[o + 1] > 110, `plate centre is background rgb(${data[o]},${data[o + 1]},${data[o + 2]})`);
});

test("buildSharpBackdrop falls back on a ghost the median keeps (mask miss)", async () => {
  // Masks miss the subject in 2 of 10 frames: those 2 contaminated votes
  // are the only 'clean' samples (< 3), so the pixels are unknown AND the
  // kept colour differs from the blurred fill — ghost metric fires.
  const W = 160, H = 90;
  const frameAt = async (miss) => {
    const buf = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 3;
      const inSub = !miss && x >= 60 && x < 108 && y >= 27 && y < 63;
      buf[o] = inSub ? 40 : 180; buf[o + 1] = inSub ? 25 : 170; buf[o + 2] = inSub ? 20 : 160;
    }
    return sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  };
  const maskFor = async (has) => {
    const buf = Buffer.alloc(W * H * 4, 0);
    if (has) {
      for (let y = 27; y < 63; y += 1) for (let x = 60; x < 108; x += 1) buf[(y * W + x) * 4 + 3] = 255;
    }
    return sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  };
  const frames = [];
  const masks = [];
  for (let i = 0; i < 10; i += 1) {
    const miss = i >= 8; // frames 8-9: mask empty though the subject sits there
    frames.push(await frameAt(false));
    masks.push(miss ? null : [await maskFor(true)]);
  }
  const out = await buildSharpBackdrop(frames, masks, { width: 160 });
  assert.equal(out.fallback, true, `mask-miss ghost falls back (ghost=${out.ghost?.toFixed(3)})`);
  assert.ok(out.ghost > 0.08, `ghost metric fires: ${out.ghost?.toFixed(3)}`);
});

test("buildSharpBackdrop keeps a small fully-masked patch (unknown filled)", async () => {
  // A small region masked in every frame (1.3% unknown): filled from the
  // blurred reference, plate colour matches, both QA gates pass.
  const W = 160, H = 90;
  const bg = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i += 1) { bg[i * 3] = 180; bg[i * 3 + 1] = 170; bg[i * 3 + 2] = 160; }
  const bgPng = await sharp(Buffer.from(bg), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const maskBuf = Buffer.alloc(W * H * 4, 0);
  for (let y = 40; y < 52; y += 1) for (let x = 70; x < 86; x += 1) maskBuf[(y * W + x) * 4 + 3] = 255;
  const maskPng = await sharp(Buffer.from(maskBuf), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const frames = Array.from({ length: 10 }, () => bgPng);
  const masks = Array.from({ length: 10 }, () => [maskPng]);
  const out = await buildSharpBackdrop(frames, masks, { width: 160 });
  assert.ok(!out.fallback, `small unknown keeps the plate (share=${out.unknownShare?.toFixed(4)}, ghost=${out.ghost?.toFixed(4)})`);
  assert.ok(out.unknownShare > 0 && out.unknownShare <= 0.04, `unknown small but nonzero: ${out.unknownShare}`);
});

test("buildSharpBackdrop medians static background, keeps it bright", async () => {
  // Fixed-camera clip: same room 10x with a walker-shaped occluder in two
  // frames at different spots. Every background pixel keeps 8+ votes, the
  // median rejects the occluders and the plate keeps ~70% luma.
  const mk = async (ox) => {
    const buf = Buffer.alloc(160 * 90 * 3);
    for (let y = 0; y < 90; y += 1) for (let x = 0; x < 160; x += 1) {
      const o = (y * 160 + x) * 3;
      buf[o] = 180; buf[o + 1] = 170; buf[o + 2] = 160;
    }
    if (ox >= 0) {
      for (let y = 20; y < 70; y += 1) for (let x = ox; x < ox + 20; x += 1) {
        const o = (y * 160 + x) * 3;
        buf[o] = 20; buf[o + 1] = 15; buf[o + 2] = 12;
      }
    }
    return sharp(Buffer.from(buf), { raw: { width: 160, height: 90, channels: 3 } }).png().toBuffer();
  };
  const maskAt = async (ox) => {
    const buf = Buffer.alloc(160 * 90 * 4, 0);
    for (let y = 20; y < 70; y += 1) for (let x = ox; x < ox + 20; x += 1) buf[(y * 160 + x) * 4 + 3] = 255;
    return sharp(Buffer.from(buf), { raw: { width: 160, height: 90, channels: 4 } }).png().toBuffer();
  };
  const frames = [await mk(-1), await mk(-1), await mk(-1), await mk(40), await mk(-1), await mk(-1), await mk(100), await mk(-1), await mk(-1), await mk(-1)];
  const masks = [null, null, null, [await maskAt(40)], null, null, [await maskAt(100)], null, null, null];
  const out = await buildSharpBackdrop(frames, masks);
  assert.ok(!out.fallback, "single-frame occluder rejected, plate kept");
  assert.equal(out.width, 640, "640px wide for ~1.35x mapping");
  const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let p = 0, o = 0; p < info.width * info.height; p += 1, o += info.channels) {
    sum += (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  }
  const mean = sum / (info.width * info.height);
  assert.ok(mean >= 0.6 && mean <= 0.8, `sharp plate luma ${mean.toFixed(3)} (~70%)`);
});

test("evenSubsample keeps endpoints and order", () => {
  assert.deepEqual(evenSubsample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 7), [0, 2, 4, 6, 7, 9, 11]);
  assert.deepEqual(evenSubsample([3, 4, 5], 6), [3, 4, 5]);
  assert.deepEqual(evenSubsample([0, 5, 9], 3), [0, 5, 9]);
});

test("sizeCapCount caps by rendered size: muntjac thins, walker stands", () => {
  const ts12 = Array.from({ length: 12 }, (_, i) => i * 0.2);
  const idx12 = Array.from({ length: 12 }, (_, i) => i);
  // Muntjac-like (wide thin subjects, coverage 0.39): must thin to 7-8.
  const munt = sizeCapCount(idx12, ts12, { poseW: 3.4 * (336 / 343), coverage: 0.389 });
  assert.ok(munt.length >= 7 && munt.length <= 8, `muntjac count ${munt.length}`);
  assert.equal(munt[0], 0); assert.equal(munt[munt.length - 1], 11);
  // Walker-like (6 tall solid subjects): untouched.
  const walk = sizeCapCount([0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5], { poseW: 1.7, coverage: 0.6 });
  assert.deepEqual(walk, [0, 1, 2, 3, 4, 5]);
  // Cougar-like (5): untouched.
  const coug = sizeCapCount([0, 1, 2, 3, 4], [0, 1, 2, 3, 4], { poseW: 2.1, coverage: 0.5 });
  assert.deepEqual(coug, [0, 1, 2, 3, 4]);
});

// Loop-1 pack helpers (lite tier): edge resampling, one-pass slice scan,
// usable live tail and the zero-vote backdrop fill.
const { bleedOpaque, cellResize, scanSlice, liveTail, UPSCALE_SMOOTH_T } = await import("../../backend/app/atlas.js");

function rgbaRect(w, h, rect, rgb = [255, 255, 255]) {
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const o = (y * w + x) * 4;
      buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 255;
    }
  }
  return buf;
}

test("bleedOpaque spreads solid colour outward and returns an opaque copy", () => {
  const src = rgbaRect(5, 1, { x: 2, y: 0, w: 1, h: 1 }, [200, 10, 10]);
  const out = bleedOpaque(src, 5, 1, 1);
  for (const x of [1, 2, 3]) assert.deepEqual([...out.subarray(x * 4, x * 4 + 3)], [200, 10, 10], `px ${x}`);
  assert.deepEqual([...out.subarray(0, 3)], [0, 0, 0], "k=1 stops after one ring");
  for (let p = 0; p < 5; p += 1) assert.equal(out[p * 4 + 3], 255);
  assert.equal(src[0 * 4 + 3], 0, "input untouched");
});

test("cellResize upscale: anti-aliased edge, no dark fringe, empty padding", async () => {
  // A 6x6 white block in a 12x6 slice, upscaled 5x into a 60x60 cell.
  const src = rgbaRect(12, 6, { x: 3, y: 0, w: 6, h: 6 });
  assert.ok(60 / 12 > UPSCALE_SMOOTH_T);
  const { data, info } = await cellResize(src, 12, 6, 60, 60);
  assert.equal(info.width, 60); assert.equal(info.height, 60);
  let partial = 0, opaque = 0;
  for (let p = 0; p < 60 * 60; p += 1) {
    const a = data[p * 4 + 3];
    const y = Math.floor(p / 60);
    if (y < 14 || y > 45) assert.equal(a, 0, `contain padding row ${y} stays transparent`);
    if (a > 0) assert.ok(data[p * 4] > 200 && data[p * 4 + 1] > 200 && data[p * 4 + 2] > 200, `no dark fringe at ${p}`);
    if (a > 0 && a < 255) partial += 1;
    if (a === 255) opaque += 1;
  }
  assert.ok(partial > 0, "edge is anti-aliased, not a hard step");
  assert.ok(opaque > 600, `solid interior kept (${opaque})`);
});

test("cellResize downscale keeps the premultiplied path", async () => {
  const src = rgbaRect(80, 80, { x: 20, y: 20, w: 40, h: 40 }, [30, 60, 90]);
  const { data, info } = await cellResize(src, 80, 80, 40, 40);
  assert.equal(info.width, 40);
  const centre = (20 * 40 + 20) * 4;
  assert.deepEqual([...data.subarray(centre, centre + 4)], [30, 60, 90, 255]);
  assert.equal(data[3], 0, "corner stays empty");
});

test("scanSlice measures coverage, box, solid area and frame-edge touch", () => {
  const inside = scanSlice(rgbaRect(20, 10, { x: 5, y: 2, w: 6, h: 5 }), 20, 10);
  assert.equal(inside.coverage, 30);
  assert.deepEqual(inside.box, { x0: 5, y0: 2, x1: 10, y1: 6 });
  assert.equal(inside.solid, 30); assert.equal(inside.fill, 1); assert.equal(inside.touch, 0);
  const cut = scanSlice(rgbaRect(20, 10, { x: 0, y: 2, w: 6, h: 5 }), 20, 10);
  assert.ok(cut.touch > 0.2, `left-edge subject touches (${cut.touch})`);
  const empty = scanSlice(Buffer.alloc(20 * 10 * 4), 20, 10);
  assert.equal(empty.box, null); assert.equal(empty.coverage, 0);
});

test("scanSlice measures the share of each side the frame cuts (data-bar row = bottom edge)", () => {
  assert.deepEqual(scanSlice(rgbaRect(20, 10, { x: 5, y: 2, w: 6, h: 5 }), 20, 10).cut, [0, 0, 0, 0]);
  assert.deepEqual(scanSlice(rgbaRect(20, 10, { x: 0, y: 2, w: 6, h: 5 }), 20, 10).cut, [1, 0, 0, 0]);
  // a bust: cut by the bottom across its width, by the right along its height
  assert.deepEqual(scanSlice(rgbaRect(20, 10, { x: 12, y: 4, w: 8, h: 6 }), 20, 10).cut, [0, 1, 0, 1]);
  // a mask that stops at a cut data bar (rows 8+) is cut at the bar line
  assert.deepEqual(scanSlice(rgbaRect(20, 10, { x: 5, y: 3, w: 6, h: 5 }), 20, 10, { bottom: 8 }).cut, [0, 0, 0, 1]);
});

test("packChronoAtlas records frame-cut sides and the cut-out rect per cell; uncut clips record none", async () => {
  const inside = [], cutOff = [];
  for (let i = 0; i < 12; i += 1) {
    inside.push(slice(await solidPng(160, 60, { x: 10 + i * 8, y: 10, w: 30, h: 30 }), i));
    // the frame's bottom cuts the body all along (a bust, legs below the shot)
    cutOff.push(slice(await solidPng(160, 60, { x: 10 + i * 8, y: 25, w: 30, h: 35 }), i));
    inside[i].timestamp = cutOff[i].timestamp = i * 0.2;
  }
  assert.equal((await packChronoAtlas(inside, { cell: 32 })).cuts, null);
  const packed = await packChronoAtlas(cutOff, { cell: 32 });
  const cells = new Set(Array.from({ length: packed.kept.length + packed.live.count }, (_, i) => i));
  for (const c of packed.trail?.cells || []) cells.add(c);
  assert.equal(packed.cuts.length, cells.size, "one record per atlas cell (poses, live tail, trail frames)");
  for (const c of packed.cuts) {
    assert.deepEqual(c.sides, [0, 0, 0, 1]);
    assert.equal(c.rect.length, 4);
    assert.ok(c.rect[0] < c.rect[2] && c.rect[1] < c.rect[3] && c.rect[2] <= 1 && c.rect[3] <= 1);
  }
});

test("liveTail ends on the head pose and skips truncated or tiny frames", () => {
  const s = (touch = 0, solid = 100) => ({ touch, solid });
  const scans = [s(), s(), s(), s(0.5), s(), s(0, 10), s(), s()];
  assert.deepEqual(liveTail(scans, [0, 7], 10), [0, 1, 2, 4, 6, 7]);
  assert.deepEqual(liveTail(scans, [0, 7], 3), [4, 6, 7]);
  // Fewer than 3 usable lead-in frames: no live tail at all.
  assert.deepEqual(liveTail([s(), s(0.5), s(0, 1), s()], [3], 10), []);
  // Close-up clip (>= 80% of frames touch the edge): touch is ignored.
  const close = [s(0.4), s(0.4), s(0.4), s(0.4), s(0.4)];
  assert.deepEqual(liveTail(close, [4], 10), [0, 1, 2, 3, 4]);
});

test("liveTail stops at the first lead-in frame whose box differs from the head's by more than LIVE_SIZE_T", () => {
  const b = (w, h, touch = 0) => ({ touch, solid: 100, box: { x0: 10, y0: 10, x1: 10 + w - 1, y1: 10 + h - 1 } });
  // A subject approaching the camera: each cell is fitted on its own, so
  // looping these would jump the now-pose's scale. Only the last frames
  // match the head (546 wide): too few for a loop, the head holds still.
  const approach = [b(212, 231), b(245, 219), b(285, 218), b(359, 259), b(420, 266), b(487, 241), b(546, 247)];
  assert.deepEqual(liveTail(approach, [0, 6], 10), []);
  // A subject keeping its size loops as before (a deer standing, a walk in place).
  const steady = [b(127, 174), b(124, 173), b(123, 175), b(122, 176), b(121, 174), b(119, 177)];
  assert.deepEqual(liveTail(steady, [0, 5], 10), [0, 1, 2, 3, 4, 5]);
  // The first frame out of range ends the tail; an unusable frame is still skipped.
  const mixed = [b(100, 100), b(140, 100), b(100, 100), b(100, 100, 0.5), b(105, 98), b(100, 100)];
  assert.deepEqual(liveTail(mixed, [5], 10), [2, 4, 5]);
});

test("buildSharpBackdrop fills zero-vote pixels from the scene, never black", async () => {
  const W = 160, H = 90;
  const bg = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i += 1) { bg[i * 3] = 180; bg[i * 3 + 1] = 170; bg[i * 3 + 2] = 160; }
  const bgPng = await sharp(Buffer.from(bg), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const maskBuf = Buffer.alloc(W * H * 4, 0);
  for (let y = 40; y < 52; y += 1) for (let x = 70; x < 86; x += 1) maskBuf[(y * W + x) * 4 + 3] = 255;
  const maskPng = await sharp(Buffer.from(maskBuf), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const out = await buildSharpBackdrop(Array.from({ length: 10 }, () => bgPng), Array.from({ length: 10 }, () => [maskPng]), { width: 160 });
  assert.ok(!out.fallback);
  const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  const o = (46 * info.width + 78) * info.channels;
  const luma = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  assert.ok(luma > 0.5, `always-masked patch shows the scene, not a black silhouette (luma ${luma.toFixed(2)})`);
});

const { dropFarPoses, stillLoop, FAR_POSE_ABS } = await import("../../backend/app/atlas.js");

test("dropFarPoses drops tiny far poses that would be blown up, keeps the now-pose and similar rows", () => {
  const box = (h, w = h / 2) => ({ x0: 0, y0: 0, x1: w - 1, y1: h - 1 });
  // An approaching cyclist: 50 px tall at first, 170 px at the end (slovenska, cell 336).
  const near = [50, 60, 90, 100, 110, 140, 170].map((h) => box(h));
  assert.deepEqual(dropFarPoses([0, 1, 2, 3, 4, 5, 6], near, 336), [2, 3, 4, 5, 6]);
  // Similar-sized poses (nothing enlarged past FAR_POSE_ABS): unchanged.
  const even = [300, 280, 310, 290, 305].map((h) => box(h));
  assert.deepEqual(dropFarPoses([0, 1, 2, 3, 4], even, 336), [0, 1, 2, 3, 4]);
  // A bear growing as it comes closer (enlargement 1.3-1.6x, last pose 0.6x): unchanged.
  const bear = [260, 220, 210, 200, 215, 245, 540].map((h) => box(h, h * 1.05));
  assert.deepEqual(dropFarPoses([0, 1, 2, 3, 4, 5, 6], bear, 336), [0, 1, 2, 3, 4, 5, 6]);
  // Never below 3 poses; the now-pose always stays even when it is the far one.
  const shrink = [200, 40, 30, 20].map((h) => box(h));
  const kept = dropFarPoses([0, 1, 2, 3], shrink, 336);
  assert.equal(kept.length, 3);
  assert.ok(kept.includes(3) && kept.includes(0), JSON.stringify(kept));
  assert.ok(FAR_POSE_ABS >= 2);
});

test("stillLoop spreads usable frames over the whole clip and ends on the pose", () => {
  const s = (touch = 0, solid = 100) => ({ touch, solid });
  const scans = Array.from({ length: 40 }, () => s());
  scans[5] = s(0.5); // cut by the frame edge
  const loop = stillLoop(scans, 39, 15);
  assert.equal(loop.length, 15);
  assert.equal(loop[0], 0);
  assert.equal(loop[loop.length - 1], 39);
  assert.ok(!loop.includes(5));
  for (let k = 1; k < loop.length; k += 1) assert.ok(loop[k] > loop[k - 1]);
  assert.deepEqual(stillLoop([s(), s()], 1, 15), []); // too short: no loop
});

test("a static subject packs as a living still (one pose + a loop) only when asked", async () => {
  const frames = [];
  for (let i = 0; i < 24; i += 1) {
    frames.push(slice(await solidPng(120, 60, { x: 40, y: 15, w: 30, h: 30 }), i));
    frames[i].timestamp = i * 0.25;
  }
  const plain = await packChronoAtlas(frames, { cell: 32 });
  assert.equal(plain.motion.static, true);
  assert.equal(plain.still, false);
  const still = await packChronoAtlas(frames, { cell: 32, staticStill: true });
  assert.equal(still.still, true);
  assert.equal(still.kept.length, 1);
  assert.equal(still.live.start, 1);
  assert.ok(still.live.count >= 10, `loop ${still.live.count}`);
  assert.ok(still.liveFrames[0] < 3, `loop starts at the clip start ${still.liveFrames}`);
  assert.equal(still.anchors.length, 1);
  // A moving subject is never turned into a still.
  const moving = [];
  for (let i = 0; i < 24; i += 1) {
    moving.push(slice(await solidPng(120, 60, { x: 5 + i * 4, y: 15, w: 22, h: 30 }), i));
    moving[i].timestamp = i * 0.2;
  }
  const row = await packChronoAtlas(moving, { cell: 32, staticStill: true });
  assert.equal(row.still, false);
  assert.ok(row.kept.length >= 3);
});

// Group objects (loop 10): a herd or pack picked as one object.
const { memberGrid, isGroupClip, strayMembers, clearMembers } = await import("../../backend/app/atlas.js");
function rgbaRects(w, h, rects) {
  const buf = Buffer.alloc(w * h * 4, 0);
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y += 1) for (let x = r.x; x < r.x + r.w; x += 1) {
    const o = (y * w + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = 200; buf[o + 3] = 255;
  }
  return buf;
}

test("memberGrid finds the separate bodies of a mask, largest first", () => {
  const s = scanSlice(rgbaRects(64, 32, [{ x: 30, y: 10, w: 30, h: 20 }, { x: 2, y: 2, w: 6, h: 6 }]), 64, 32);
  assert.equal(s.members.comps.length, 2);
  assert.ok(s.members.comps[0].area > s.members.comps[1].area);
  assert.ok(s.members.labels, "labels kept when there is more than one body");
  const one = scanSlice(rgbaRects(64, 32, [{ x: 30, y: 10, w: 30, h: 20 }]), 64, 32);
  assert.equal(one.members.comps.length, 1);
  assert.equal(one.members.labels, null);
  const grid = new Uint8Array([1, 0, 0, 1, 0, 1, 0, 0, 0]);
  assert.equal(memberGrid(grid, 3, 3, 1).comps.length, 2, "8-connected");
});

test("a group clip drops members that float above the group or stand far off; single subjects are never groups", () => {
  // main body on the floor line, a small member hanging above its mid-height, a big neighbour on the same floor
  const s = scanSlice(rgbaRects(120, 60, [{ x: 40, y: 20, w: 40, h: 38 }, { x: 4, y: 4, w: 8, h: 10 }, { x: 84, y: 30, w: 30, h: 28 }]), 120, 60);
  const drop = strayMembers(s.members);
  assert.equal(drop.length, 1);
  const floating = s.members.comps.find((c) => c.id === drop[0]);
  assert.ok(floating.y1 < 20 && floating.x1 < 20, "the small one above is dropped, the big neighbour stays");
  const data = rgbaRects(120, 60, [{ x: 40, y: 20, w: 40, h: 38 }, { x: 4, y: 4, w: 8, h: 10 }, { x: 84, y: 30, w: 30, h: 28 }]);
  clearMembers(data, 120, 60, s.members, drop);
  const after = scanSlice(data, 120, 60);
  assert.deepEqual(after.box, { x0: 40, y0: 20, x1: 113, y1: 57 });
  const single = Array.from({ length: 8 }, () => scanSlice(rgbaRects(120, 60, [{ x: 40, y: 20, w: 40, h: 38 }]), 120, 60));
  assert.equal(isGroupClip(single), false);
  assert.equal(isGroupClip(Array.from({ length: 8 }, () => s)), true);
  assert.equal(isGroupClip([]), false);
});

test("packChronoAtlas leaves a group's floating member out of every pose; a single subject packs as before", async () => {
  const herd = [], single = [];
  for (let i = 0; i < 12; i += 1) {
    const main = { x: 20 + i * 6, y: 30, w: 50, h: 28 };
    herd.push(slice(await sharp(rgbaRects(200, 60, [main, { x: 4, y: 2, w: 10, h: 10 }, { x: 140, y: 34, w: 40, h: 24 }]), { raw: { width: 200, height: 60, channels: 4 } }).png().toBuffer(), i));
    single.push(slice(await sharp(rgbaRects(200, 60, [main]), { raw: { width: 200, height: 60, channels: 4 } }).png().toBuffer(), i));
    herd[i].timestamp = single[i].timestamp = i * 0.2;
  }
  const g = await packChronoAtlas(herd, { cell: 32 });
  assert.equal(g.group, true);
  assert.ok(g.crop.y >= 28, `no pose reaches up to the floating member (crop ${JSON.stringify(g.crop)})`);
  const s = await packChronoAtlas(single, { cell: 32 });
  assert.equal(s.group, false);
});

test("medianLuma (histogram + one-bin sort) returns exactly the full-sort median", () => {
  const fullSort = (rgba, w, h, alphaMin = 128) => {
    const vals = [];
    for (let p = 0, o = 0; p < w * h; p += 1, o += 4) if (rgba[o + 3] >= alphaMin) vals.push(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] / 255;
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 300; t += 1) {
    const w = 1 + Math.floor(rnd() * 30), h = 1 + Math.floor(rnd() * 30);
    const b = Buffer.alloc(w * h * 4);
    for (let i = 0; i < b.length; i += 1) b[i] = t % 2 ? Math.floor(rnd() * 256) : Math.floor(rnd() * 6) * 51;
    assert.equal(medianLuma(b, w, h), fullSort(b, w, h), `case ${t}`);
  }
  assert.equal(medianLuma(Buffer.alloc(16), 2, 2), 0);
});

test("decontaminateEdge: the edge ring takes the colour just inside; thin parts and alpha are kept", () => {
  // 40x30 cell: a dark body (luma 40) whose outer 2 px carry the light
  // background (200), a soft alpha-96 halo pixel row above it, and a 2-px
  // light leg far from any core (it keeps its own colour).
  const w = 40, h = 30, buf = Buffer.alloc(w * h * 4);
  const set = (x, y, v, a) => { const o = (y * w + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = v; buf[o + 3] = a; };
  for (let y = 5; y < 25; y += 1) for (let x = 5; x < 25; x += 1) {
    const ring = Math.min(x - 5, 24 - x, y - 5, 24 - y) < 2;
    set(x, y, ring ? 200 : 40, 255);
  }
  for (let x = 5; x < 25; x += 1) set(x, 4, 220, 96);
  for (let y = 5; y < 25; y += 1) for (let x = 34; x < 36; x += 1) set(x, y, 180, 255);
  const before = Buffer.from(buf);
  const out = decontaminateEdge(buf, w, h);
  assert.equal(EDGE_RING, 2);
  const at = (x, y) => out[(y * w + x) * 4];
  for (const [x, y] of [[5, 5], [6, 12], [24, 20], [15, 23], [15, 4]]) assert.equal(at(x, y), 40, `edge (${x},${y}) takes the inside colour`);
  assert.equal(at(15, 15), 40, "the core is unchanged");
  assert.equal(at(34, 10), 180, "a thin part with no core in reach keeps its colour");
  for (let p = 0; p < w * h; p += 1) assert.equal(out[p * 4 + 3], before[p * 4 + 3], "alpha untouched");
  assert.deepEqual(buf, before, "the input buffer is not modified");
  assert.deepEqual(decontaminateEdge(buf, w, h, { ring: 0 }), before, "ring 0 is a copy");
});
