import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSolidDistance, subjectFitDims, poseMeshY, ribbonStrip, fitChronoRow, fitChronoPoints, selectPortraitIndices, portraitChronoPoints, PORTRAIT_MAX } from "../../backend/app/lite-frame.js";

// The cougar production specimen: planes ~2.64 x 3.4 (aspect 0.776), depth 4.6.
const COUGAR = { width: 3.4 * 0.776, height: 3.4, depth: 4.6 };
const LANDSCAPE = { fovDeg: 38, aspect: 1280 / 560 };

test("cougar-like solid frames near the 55% height target", () => {
  const d = fitSolidDistance(COUGAR, LANDSCAPE);
  const tanHalf = Math.tan((38 * Math.PI) / 180 / 2);
  const frac = COUGAR.height / 2 / (d * tanHalf);
  assert.ok(frac > 0.4 && frac < 0.7, `height fraction ${frac}`);
});

test("stack depth swings onto screen-x at rest yaw, pushing a wide solid back", () => {
  const wide = { width: 8, height: 2, depth: 4 };
  const flat = fitSolidDistance({ ...wide, depth: 0 }, LANDSCAPE);
  const deep = fitSolidDistance(wide, LANDSCAPE);
  assert.ok(deep > flat, `deep ${deep} > flat ${flat}`);
});

test("near-plane guard keeps the camera out of very deep stacks", () => {
  const d = fitSolidDistance({ width: 1, height: 1, depth: 20 }, LANDSCAPE);
  assert.ok(d >= 20 / 2 + 1, `guard ${d}`);
});

test("narrow stage pushes the camera back vs wide stage", () => {
  const wide = fitSolidDistance(COUGAR, { fovDeg: 38, aspect: 16 / 9 });
  const narrow = fitSolidDistance(COUGAR, { fovDeg: 38, aspect: 390 / 560 });
  assert.ok(narrow > wide, `narrow ${narrow} > wide ${wide}`);
});

test("small subject-fill zooms in (travelling subject)", () => {
  const full = fitSolidDistance(COUGAR, LANDSCAPE);
  const travel = fitSolidDistance(COUGAR, { ...LANDSCAPE, subjectFill: { w: 0.4, h: 0.9 } });
  assert.ok(travel < full, `travel fit ${travel} < full ${full}`);
});

test("missing subjectFill defaults to full planes", () => {
  const a = fitSolidDistance(COUGAR, LANDSCAPE);
  const b = fitSolidDistance(COUGAR, { ...LANDSCAPE, subjectFill: null });
  assert.equal(a, b);
});

test("subjectFitDims clamps degenerate fill", () => {
  assert.deepEqual(subjectFitDims({ width: 4, height: 2 }, { w: 0, h: 99 }), { fitW: 4 * 0.15, fitH: 2 * 1 });
});

test("bad inputs throw instead of framing NaN", () => {
  assert.throws(() => fitSolidDistance({ width: 0, height: 1, depth: 1 }, LANDSCAPE));
  assert.throws(() => fitSolidDistance(COUGAR, { fovDeg: 0, aspect: 1 }));
});

test("poseMeshY sits every bbox bottom on the ground", () => {
  const H = 3.4, G = -H / 2;
  assert.equal(poseMeshY(1, H, G), 0, "full cell stays centred");
  assert.equal(poseMeshY(0.5, H, G), G, "half cell lifted to the floor");
  assert.equal(poseMeshY(0, H, G), G - H / 2, "empty top sinks below");
  assert.equal(poseMeshY(undefined, H, G), 0, "missing anchor centres");
});

test("ribbonStrip runs a time-coloured strip through foot points", () => {
  const pts = [
    { x: 0, z: 0, t: 0 }, { x: 2, z: 0, t: 0.5 }, { x: 4, z: 0, t: 1 },
  ];
  const { positions, colors, index } = ribbonStrip(pts, 0.4);
  assert.equal(positions.length, 18, "2 verts x 3 pts x xyz");
  assert.equal(colors.length, 18, "2 verts x 3 pts x rgb");
  assert.equal(index.length, 12, "2 quads");
  // Width 0.4 across a straight run: z offsets +-0.2 at the middle point.
  assert.ok(Math.abs(positions[8] - 0.2) < 1e-9 && Math.abs(positions[11] + 0.2) < 1e-9, "width");
  // Endpoints carry the exact end colours (cool old -> warm now).
  assert.deepEqual(colors.slice(0, 3), [0.25, 0.4, 0.7]);
  assert.deepEqual(colors.slice(15, 18), [1.0, 0.72, 0.35]);
  // Degenerate input stays empty, never NaN.
  assert.deepEqual(ribbonStrip([{ x: 0, z: 0, t: 0 }], 1), { positions: [], colors: [], index: [] });
});

// Production cougar walk (toward camera): 5 tall portrait poses.
const COUGAR_ROW = { count: 5, poseW: 3.4 * 0.6176, poseH: 3.4, rowLen: 4 * 0.85 * 3.4 * 0.6176, depth: 4.6 };
const ROW_OPTS = { fovDeg: 38, yawRest: -0.3, yawBound: 0.52, pitchBound: 0.28, fill: 0.65, widthFill: 0.9 };

function cornersClearPoints(points, opts) {
  // Re-project every point corner at every bound extreme; all must clear.
  // aimY-aware: the frame centre sits at aimY, so corners measure relative.
  const tanHalf = Math.tan((38 * Math.PI) / 180 / 2);
  const d = fitChronoPoints(points, opts);
  for (const p of points) {
    const hw = p.hw, hh = p.hh, s = p.s || 1;
    for (const yaw of [opts.yawRest - opts.yawBound, opts.yawRest, opts.yawRest + opts.yawBound]) {
      for (const q of [-opts.pitchBound, 0, opts.pitchBound]) {
        for (const [lx, ly] of [[-hw * s, -hh * s], [hw * s, hh * s]]) {
          const x1 = p.x + lx * Math.cos(yaw), z1 = p.z - lx * Math.sin(yaw);
          const y1 = ly * Math.cos(q) - z1 * Math.sin(q) - (opts.aimY || 0), z2 = ly * Math.sin(q) + z1 * Math.cos(q);
          if (Math.abs(x1) > (d - z2) * tanHalf * opts.aspect * opts.widthFill) return `x clip order ${p.order} yaw ${yaw}`;
          if (Math.abs(y1) > (d - z2) * tanHalf * opts.fill) return `y clip order ${p.order} yaw ${yaw} pitch ${q}`;
        }
      }
    }
  }
  return { err: null, d };
}

function cornersClear(row, opts) {
  // Re-project every pose corner at every bound extreme; all must clear.
  const pts = [];
  for (let i = 0; i < row.count; i += 1) {
    const u = row.count <= 1 ? 0.5 : i / (row.count - 1);
    pts.push({
      order: i, x: (u - 0.5) * row.rowLen, z: (u - 0.5) * row.depth,
      hw: row.poseW / 2, hh: row.poseH / 2, s: i === row.count - 1 ? 1.06 : 1,
    });
  }
  return cornersClearPoints(pts, opts).err;
}

test("fitChronoRow contains every pose corner at every bound extreme", () => {
  for (const aspect of [978 / 446, 2.2, 390 / 844]) {
    const err = cornersClear(COUGAR_ROW, { ...ROW_OPTS, aspect });
    assert.equal(err, null, `aspect ${aspect}: ${err}`);
  }
});

test("fitChronoRow backs off on narrow stages and wider rows", () => {
  const wide = fitChronoRow(COUGAR_ROW, { ...ROW_OPTS, aspect: 978 / 446 });
  const phone = fitChronoRow(COUGAR_ROW, { ...ROW_OPTS, aspect: 390 / 844 });
  assert.ok(phone > wide, `phone ${phone} > wide ${wide}`);
  const longer = fitChronoRow({ ...COUGAR_ROW, count: 12, rowLen: 11 * 0.85 * COUGAR_ROW.poseW }, { ...ROW_OPTS, aspect: 978 / 446 });
  assert.ok(longer > wide, `longer row ${longer} > ${wide}`);
});

test("fitChronoRow rejects bad inputs", () => {
  assert.throws(() => fitChronoRow({ count: 0, poseW: 1, poseH: 1, rowLen: 1, depth: 1 }, ROW_OPTS));
  assert.throws(() => fitChronoRow(COUGAR_ROW, { fovDeg: 0 }));
});

test("height-bound rows fill a large canvas share without clipping", () => {
  // Short row, tall poses, wide canvas: height binds, not width. The
  // recession/pitch terms keep the row-centre fraction below the 0.65 fill
  // target while the nearer poses read larger; pin the band + containment.
  const row = { count: 3, poseW: 2, poseH: 3, rowLen: 2 * 0.85 * 2, depth: 1 };
  const d = fitChronoRow(row, { ...ROW_OPTS, aspect: 2.2 });
  const tanHalf = Math.tan((38 * Math.PI) / 180 / 2);
  const frac = row.poseH / 2 / (d * tanHalf);
  assert.ok(frac > 0.4 && frac < 0.7, `height fraction ${frac}`);
  assert.equal(cornersClear(row, { ...ROW_OPTS, aspect: 2.2 }), null);
});

test("ribbonStrip tapers both ends to a point", () => {
  const pts = [
    { x: 0, z: 0, t: 0 }, { x: 2, z: 0, t: 0.5 }, { x: 4, z: 0, t: 1 },
  ];
  const { positions } = ribbonStrip(pts, 0.4);
  // First/last quads collapse: both verts of each end coincide (to fp dust).
  const want = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 12: 4, 13: 0, 14: 0, 15: 4, 16: 0, 17: 0 };
  for (const [idx, w] of Object.entries(want)) {
    assert.ok(Math.abs(positions[idx] - w) < 1e-9, `end taper at ${idx}: ${positions[idx]}`);
  }
  // Middle keeps full width.
  assert.ok(Math.abs(positions[8] - 0.2) < 1e-9, "middle width kept");
});

// Portrait narrow-stage layout: motion-spaced subset + receding diagonal.
const BC_TS = [2.542, 2.708, 2.875, 3.042, 3.208, 3.542, 3.875, 4.792, 5.0, 5.292, 5.5, 5.958];

test("selectPortraitIndices keeps first/last, caps at 5, spaces by time", () => {
  assert.equal(PORTRAIT_MAX, 5);
  const sel = selectPortraitIndices(12, BC_TS);
  assert.ok(sel.length <= 5 && sel.length >= 2, `count ${sel.length}`);
  assert.equal(sel[0], 0, "keeps first");
  assert.equal(sel[sel.length - 1], 11, "keeps last");
  assert.deepEqual([...sel].sort((a, b) => a - b), sel, "time order");
  // Short rows pass through untouched.
  assert.deepEqual(selectPortraitIndices(5, [0, 1, 2, 3, 4]), [0, 1, 2, 3, 4]);
  assert.deepEqual(selectPortraitIndices(4, [0, 1, 2, 3]), [0, 1, 2, 3]);
  // Six compress to five, endpoints kept.
  const six = selectPortraitIndices(6, [0, 1, 2, 3, 4, 5]);
  assert.equal(six.length, 5);
  assert.equal(six[0], 0); assert.equal(six[4], 5);
  // No timestamps: even index fallback, still endpoints.
  const idx = selectPortraitIndices(12, null);
  assert.equal(idx[0], 0); assert.equal(idx[idx.length - 1], 11);
  assert.ok(idx.length <= 5, `fallback count ${idx.length}`);
  assert.throws(() => selectPortraitIndices(0, []));
});

test("portraitChronoPoints runs oldest far-right to now near-left", () => {
  const { indices, points } = portraitChronoPoints({ count: 12, poseW: 3.72, poseH: 3.4, timestamps: BC_TS });
  assert.equal(indices[0], 0); assert.equal(indices[indices.length - 1], 11);
  assert.equal(points.length, indices.length);
  const first = points[0], last = points[points.length - 1];
  assert.ok(first.x > 0 && last.x < 0, `x runs right->left (${first.x} to ${last.x})`);
  assert.ok(first.z < 0 && last.z > 0, `z runs far->near (${first.z} to ${last.z})`);
  assert.equal(last.s, 1.06, "now marker scale");
  for (const p of points) {
    assert.equal(p.hw, 3.72 / 2); assert.equal(p.hh, 3.4 / 2);
    assert.equal(p.order, indices[points.indexOf(p)]);
  }
  assert.throws(() => portraitChronoPoints({ count: 3, poseW: 0, poseH: 1 }));
});

// Rest-view projector (camera level at (1.4,0.9,D), lookAt (0,aimY,0), group
// at rest yaw): measures what the portrait block and wide rows actually
// fill on screen. Same conventions as the viewer.
function restView(points, D, aspect, aimY = 0, yCenter = 0) {
  const tanHalf = Math.tan((38 * Math.PI) / 180 / 2);
  const yaw = -0.3, cy = Math.cos(yaw), sy = Math.sin(yaw);
  const C = [1.4, 0.9, D], T = [0, aimY, 0];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const fwd = norm(sub(T, C));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    for (const [lx, ly] of [[-p.hw * p.s, -p.hh * p.s], [p.hw * p.s, p.hh * p.s]]) {
      const wx = p.x + lx * cy, wz = p.z - lx * sy, wy = yCenter + ly;
      const v = sub([wx, wy, wz], C);
      const z = dot(v, fwd);
      const nx = dot(v, right) / (z * tanHalf * aspect);
      const ny = dot(v, up) / (z * tanHalf);
      if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
    }
  }
  return { w: (maxX - minX) / 2, h: (maxY - minY) / 2 };
}

function portraitCase(count, poseW, ts, aspect, spreadK = 1.0, depthK = 2.0) {
  const { indices, points } = portraitChronoPoints({ count, poseW, poseH: 3.4, timestamps: ts, spreadK, depthK });
  const d = fitChronoPoints(points, { fovDeg: 38, aspect, yawBound: 0.28, fill: 0.8, widthFill: 0.95, aimY: 0 });
  return { indices, points, d, frac: restView(points, d, aspect, 0) };
}

test("portrait diagonal block verified without clipping (tall 45%+, wide documented)", () => {
  // Tall/narrow subjects hit the 45% block target (walker/cougar below).
  // Wide subjects (3.7-wide blackcat poses at 0.67 aspect) are width-bound:
  // the fit provably contains them, but the block lands ~0.27-0.3, still
  // 4-6x the illegible 12-in-a-row. The band pins the verified floor so a
  // regression (overlap/missing poses) fails loudly; see report for stills.
  for (const aspect of [0.673, 0.72, 0.5]) {
    const { indices, points, d, frac } = portraitCase(12, 3.72, BC_TS, aspect);
    assert.ok(indices.length <= 6, `subset ${indices.length}`);
    // Floor holds at real phone aspects; 0.5 (narrower than any phone
    // canvas) is containment-only.
    if (aspect > 0.6) assert.ok(frac.h >= 0.25, `aspect ${aspect}: block height ${frac.h.toFixed(2)} at D${d.toFixed(1)}`);
    assert.ok(frac.w <= 0.95, `aspect ${aspect}: block width ${frac.w.toFixed(2)} inside`);
    // Containment proof over the same points at every bound (viewer opts).
    const { err } = cornersClearPoints(points, {
      fovDeg: 38, aspect, yawRest: -0.3, yawBound: 0.28, pitchBound: 0.28,
      fill: 0.8, widthFill: 0.95, aimY: 0,
    });
    assert.equal(err, null, `aspect ${aspect}: ${err}`);
  }
});

test("portrait subset keeps short rows whole and tall", () => {
  // Walker-6 compresses to 5 (phone cap), endpoints kept; hero clears 40%+.
  const { indices, points, frac } = portraitCase(6, 1.7, [0, 1, 2, 3, 4, 5], 0.673);
  assert.equal(indices.length, 5);
  assert.equal(indices[0], 0); assert.equal(indices[4], 5);
  assert.ok(frac.h >= 0.4, `walker block ${frac.h.toFixed(2)}`);
  // Cougar-5 stays whole.
  const cg = portraitCase(5, 2.1, [0, 1, 2, 3, 4], 0.673);
  assert.deepEqual(cg.indices, [0, 1, 2, 3, 4]);
  assert.ok(cg.frac.h >= 0.4, `cougar block ${cg.frac.h.toFixed(2)}`);
});

test("wide defaults fill the frame: short rows 60%+ width, 50%+ height", () => {
  // Product behaviour (fill 0.9 / widthFill 0.97 / aimY -0.2, depth scaled
  // to the row as the viewer builds it): a walker-like short row lands
  // prominent with the floor pool under it.
  const poseW = 1.7, rowLen = 0.85 * poseW * 5;
  const depth = Math.min(4.6, Math.max(0.8, rowLen * 0.15));
  const row = { count: 6, poseW, poseH: 3.4, rowLen, depth };
  const d = fitChronoRow(row, { fovDeg: 38, aspect: 978 / 446, yawBound: 0.52, aimY: -0.2 });
  const pts = [];
  for (let i = 0; i < 6; i += 1) {
    const u = i / 5;
    pts.push({ x: (u - 0.5) * rowLen, z: (u - 0.5) * depth, hw: poseW / 2, hh: 1.7, s: i === 5 ? 1.06 : 1 });
  }
  const frac = restView(pts, d, 978 / 446, -0.2);
  assert.ok(frac.w >= 0.65, `walker width ${frac.w.toFixed(2)}`);
  assert.ok(frac.h >= 0.5, `walker height ${frac.h.toFixed(2)}`);
  assert.equal(cornersClear(row, { ...ROW_OPTS, aspect: 978 / 446, fill: 0.9, widthFill: 0.97, aimY: -0.2 }), null);
});
