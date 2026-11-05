import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../../vendor/three/build/three.module.js';
import * as stableMath from '../../stable-math.mjs';

// Loop 17 (construct follow-up): the production volume.js, run whole on the
// vendored three.js (a stub canvas for the floor and shadow gradients), so
// buildChronoVolume and setChronoCut are tested as the construct and the
// Lite viewer call them.
//   - The construct samples the atlas premultiplied (no pale edge fringe).
//   - A barely moving subject gets fewer cards, further apart.
//   - A dark subject's ghosts get a shadow-only cool lift on a bare stage;
//     the now-pose never does.
const source = (await fs.readFile(new URL('../../volume.js', import.meta.url), 'utf8'))
  .replace(/\r\n/g, '\n').replace(/^import .*$/gm, '').replace(/^export /gm, '');
const gradient = () => ({ addColorStop() {} });
const context2d = () => new Proxy({}, {
  get: (_, key) => (key === 'createRadialGradient' || key === 'createLinearGradient' ? gradient : () => {}),
  set: () => true,
});
const document = { createElement: () => ({ width: 0, height: 0, getContext: context2d }) };
const V = vm.runInNewContext(
  `${source}\n({ buildChronoVolume, setChronoCut, chronoMaterial, STROBE_COUNT, STROBE_GAP, STROBE_ROOM_GAP, STROBE_STILL_MOTION, STROBE_STILL_COUNT, STROBE_STILL_GAP, TRAIL_GAIN, TRAIL_LIFT, TRAIL_KNEE });`,
  { THREE, document, ...stableMath, Number, Math, Array, Set, Map, Object, JSON, Float32Array, Uint8Array, Uint8ClampedArray },
);

// A synthetic trail atlas: `count` poses, `trailN` frames spread evenly between
// them, every subject 0.8 of its cell wide.
const HEIGHT = 3.4, ASPECT = 0.8, FILL = 0.8;
const POSE_W = HEIGHT * ASPECT, BODY_W = FILL * POSE_W;
function meta({ motion = 0.15, dark = false, count = 3, trailN = 12 } = {}) {
  return {
    count, cols: 4, rows: 4, aspect: ASPECT, motion, dark,
    anchors: Array.from({ length: count }, () => ({ left: 0.1, right: 0.1 + FILL, bottom: 1 })),
    trail: {
      cells: Array.from({ length: trailN }, (_, j) => count + j),
      at: Array.from({ length: trailN }, (_, j) => ((j + 1) / (trailN + 1)) * (count - 1)),
    },
  };
}
const atlas = () => { const t = new THREE.Texture(); t.colorSpace = THREE.SRGBColorSpace; return t; };
const build = (m, options = {}) => V.buildChronoVolume(atlas(), m, { height: HEIGHT, ...options });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const keys = (g) => g.children.filter((c) => c.userData.order !== undefined && c.material?.userData?.uGain)
  .sort((a, b) => a.userData.order - b.userData.order);

test('the construct samples its atlas premultiplied, as the viewer does; an opt-out or a premultiplied atlas is left alone', () => {
  const tex = atlas();
  const g = V.buildChronoVolume(tex, meta(), { height: HEIGHT, trailStep: 0.65 });
  assert.equal(tex.premultiplyAlpha, true);
  assert.equal(tex.colorSpace, THREE.NoColorSpace);
  // Every pose takes the premultiplied shader path (no straight-alpha edge, no edge rim).
  for (const k of keys(g)) assert.equal(k.material.userData.premul, true);
  const kept = atlas();
  V.buildChronoVolume(kept, meta(), { height: HEIGHT, premultiply: false });
  assert.equal(kept.premultiplyAlpha, false);
  assert.equal(kept.colorSpace, THREE.SRGBColorSpace);
  const viewer = new THREE.Texture(); viewer.premultiplyAlpha = true;
  const version = viewer.version;
  V.buildChronoVolume(viewer, meta(), { height: HEIGHT, trailRow: 'free' });
  assert.equal(viewer.version, version, 'no re-upload of an atlas already premultiplied');
});

test('a barely moving subject gets at most STROBE_STILL_COUNT cards, STROBE_STILL_GAP of a body width apart', () => {
  assert.ok(V.STROBE_STILL_COUNT < V.STROBE_COUNT && V.STROBE_STILL_GAP > V.STROBE_GAP);
  // The Lite viewer's free row: the row grows to fit its cards.
  const still = build(meta({ motion: V.STROBE_STILL_MOTION / 2 }), { trailRow: 'free' });
  assert.equal(3 + still.userData.trail.ghosts.length, V.STROBE_STILL_COUNT);
  assert.ok(near(still.userData.rowLen, (V.STROBE_STILL_COUNT - 1) * V.STROBE_STILL_GAP * BODY_W));
  const moving = build(meta({ motion: V.STROBE_STILL_MOTION * 2 }), { trailRow: 'free' });
  assert.equal(3 + moving.userData.trail.ghosts.length, 15, 'every pose and trail frame, under STROBE_COUNT');
  assert.ok(near(moving.userData.rowLen, 14 * V.STROBE_GAP * BODY_W));
  // A room row (the construct) keeps its length: a moving subject fills it at
  // STROBE_ROOM_GAP, a still one at STROBE_STILL_GAP (here only its poses fit).
  const budget = 0.65 * POSE_W * 2;
  const room = build(meta({ motion: 0.15 }), { trailStep: 0.65 });
  assert.ok(near(room.userData.rowLen, budget));
  assert.equal(3 + room.userData.trail.ghosts.length, Math.round(budget / (V.STROBE_ROOM_GAP * BODY_W)) + 1);
  const roomStill = build(meta({ motion: 0.02 }), { trailStep: 0.65 });
  assert.equal(Math.round(budget / (V.STROBE_STILL_GAP * BODY_W)) + 1, 3);
  assert.equal(roomStill.userData.trail, null, 'no trail frames fit: the plain row');
  // A longer still room row fills to STROBE_STILL_COUNT and no further.
  const longStill = build(meta({ motion: 0.02, count: 5 }), { trailStep: 0.85 });
  assert.equal(5 + longStill.userData.trail.ghosts.length, V.STROBE_STILL_COUNT);
});

const lifted = (mesh) => [mesh.material.userData.uGain.value, mesh.material.userData.uLift.value];
const LIFT = () => [V.TRAIL_GAIN, V.TRAIL_LIFT];

test('a dark subject on a bare stage: every card but the now-pose is lifted; the now-pose never is', () => {
  const g = build(meta({ dark: true }), { trailStep: 0.65 });
  V.setChronoCut(g, 1);
  const k = keys(g);
  assert.deepEqual(lifted(k[2]), [1, 0], 'now-pose untouched');
  assert.deepEqual(lifted(k[0]), LIFT());
  assert.deepEqual(lifted(k[1]), LIFT());
  assert.ok(g.userData.trail.ghosts.length > 0);
  for (const ghost of g.userData.trail.ghosts) assert.deepEqual(lifted(ghost), LIFT());
  for (const mesh of k) assert.equal(mesh.material.userData.uKnee.value, V.TRAIL_KNEE);
  // Moving the read head back: the new now-pose drops its lift.
  V.setChronoCut(g, 2 / 3);
  assert.deepEqual(lifted(k[1]), [1, 0]);
  assert.deepEqual(lifted(k[0]), LIFT());
});

test('no lift for a light subject, or for a dark one standing in its plate (the Lite viewer)', () => {
  const light = build(meta({ dark: false }), { trailStep: 0.65 });
  V.setChronoCut(light, 1);
  for (const mesh of [...keys(light), ...light.userData.trail.ghosts]) assert.deepEqual(lifted(mesh), [1, 0]);
  const plate = new THREE.Texture(); plate.image = { width: 160, height: 90 };
  const staged = build(meta({ dark: true }), { trailRow: 'free', backdrop: plate });
  V.setChronoCut(staged, 1);
  assert.ok(staged.userData.backdrop);
  for (const mesh of [...keys(staged), ...staged.userData.trail.ghosts]) assert.deepEqual(lifted(mesh), [1, 0]);
});

// The pose shader's lift, ported line for line (the test below pins the GLSL).
function shadowLift([r, g, b], gain, lift, knee, tint = [0.2, 0.22, 0.27]) {
  const lw = [0.299, 0.587, 0.114];
  const dot = (a) => a[0] * lw[0] + a[1] * lw[1] + a[2] * lw[2];
  const ll = Math.max(dot([r, g, b]), 1e-5);
  const ly = Math.min((2 * ll * gain) / knee, 30);
  const lt = Math.max(ll, knee * (1 - 2 / (Math.exp(ly) + 1)));
  const grey = tint.map((t) => (ll * t) / Math.max(dot(tint), 1e-4));
  const lk = Math.min(Math.max((lift * (1 - ll / lt) * gain) / (gain - 1), 0), lift);
  return [r, g, b].map((c, i) => (c + (grey[i] - c) * lk) * (lt / ll));
}

test('the shadow lift: TRAIL_GAIN at black, none above TRAIL_KNEE, monotonic, cool grey only as far as lifted', () => {
  const tex = new THREE.Texture(); tex.premultiplyAlpha = true;
  const m = V.chronoMaterial(tex);
  const shader = { uniforms: {}, vertexShader: '#include <uv_vertex>', fragmentShader: '#include <map_fragment>\n#include <alphatest_fragment>' };
  m.onBeforeCompile(shader);
  const frag = shader.fragmentShader;
  for (const line of [
    'float ly = min(2.0 * ll * uGain / uKnee, 30.0);',
    'float lt = max(ll, uKnee * (1.0 - 2.0 / (exp(ly) + 1.0)));',
    'float lk = clamp(uLift * (1.0 - ll / lt) * uGain / (uGain - 1.0), 0.0, uLift);',
    'diffuseColor.rgb = mix(diffuseColor.rgb, coolGrey, lk) * (lt / ll);',
  ]) assert.ok(frag.includes(line), line);
  assert.ok(frag.indexOf('if (uGain > 1.0)') > frag.indexOf('mix(vec3(luma), diffuseColor.rgb, uSat)'), 'after the saturation grade');
  assert.equal(shader.uniforms.uGain.value, 1, 'off by default: every other viewer is unchanged');
  const tint = shader.uniforms.uLiftColor.value;
  assert.ok(near(tint.r, 0.2) && near(tint.g, 0.22) && near(tint.b, 0.27), 'the port uses the shader tint');

  const G = V.TRAIL_GAIN, L = V.TRAIL_LIFT, K = V.TRAIL_KNEE;
  const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  // Purple-black fur (linear ~0.005): about TRAIL_GAIN times brighter, its cast
  // pulled toward a cool grey (the plain gain read mauve).
  const fur = [0.006, 0.004, 0.007];
  const out = shadowLift(fur, G, L, K);
  const spread = (c) => (Math.max(...c) - Math.min(...c)) / luma(c);
  assert.ok(Math.abs(luma(out) / luma(fur) - G) < 0.05);
  assert.ok(spread(out) < spread(fur) * 0.6, 'less cast');
  assert.ok(out[2] > out[0], 'cool: blue over red');
  // A face or a white patch is left as it is.
  for (const c of [[0.35, 0.2, 0.15], [0.9, 0.9, 0.88]]) {
    const o = shadowLift(c, G, L, K);
    for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(o[i] - c[i]) < 1e-3, `unchanged ${c}`);
  }
  // Monotonic in brightness, so fur detail keeps its order.
  let last = 0;
  for (let x = 0.0005; x < 0.5; x *= 1.1) {
    const y = luma(shadowLift([x, x, x], G, L, K));
    assert.ok(y >= last - 1e-9, `monotonic at ${x}`);
    last = y;
  }
});
