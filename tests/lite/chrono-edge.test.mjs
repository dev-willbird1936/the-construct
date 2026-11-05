import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../../vendor/three/build/three.module.js';

// Loop 13: the Lite viewer's pose edges, card turn, eased read head and
// live loop, run from the production volume.js source. Every new behaviour
// is opt-in (a premultiplied texture, group.userData.ease / liveMode), so
// the other chrono viewers keep their exact output.
const source = (await fs.readFile(new URL('../../volume.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const slice = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} .. ${to}`);
  return source.slice(a, b).replace(/^export /gm, '');
};
const material = vm.runInNewContext(`${slice('const PREMUL_MAP', '// Faint pool of floor')}\n({ chronoMaterial, setCutFade });`, { THREE, Number, Math, Array });
const chrono = vm.runInNewContext(`${slice('const CUT_FADE', 'function setCutFade(')}\n${slice('export function setChronoCut(', 'export async function buildShellVolume(')}\n({ setChronoCut, tickChrono });`, { Number, Math, Array, Set });
const framing = vm.runInNewContext(`${slice('const degToRad', 'function ribbonStrip(')}\n({ frameChronoView, chronoPanAt, chronoCardYaw });`, {});

function compiled(map) {
  const m = material.chronoMaterial(map);
  const shader = { uniforms: {}, vertexShader: '#include <uv_vertex>', fragmentShader: '#include <map_fragment>\n#include <alphatest_fragment>' };
  m.onBeforeCompile(shader);
  return { m, shader };
}

test('a premultiplied atlas unpremultiplies, decodes sRGB itself and anti-aliases its edge with no rim; a straight one is unchanged', () => {
  const straight = compiled(new THREE.Texture());
  assert.equal(straight.m.alphaToCoverage, false);
  assert.equal(straight.m.customProgramCacheKey(), 'chrono-cut');
  assert.ok(straight.shader.fragmentShader.includes('#include <map_fragment>'));
  assert.ok(!straight.shader.fragmentShader.includes('chronoS'));
  assert.ok(!straight.shader.fragmentShader.includes('diffuseColor.a *= uAppear'));
  const tex = new THREE.Texture(); tex.premultiplyAlpha = true;
  const premul = compiled(tex);
  assert.equal(premul.m.alphaToCoverage, true);
  assert.equal(premul.m.alphaTest, 0.5);
  // Its own program: the two shaders must never share a cache entry.
  assert.equal(premul.m.customProgramCacheKey(), 'chrono-cut-premul');
  assert.ok(!premul.shader.fragmentShader.includes('#include <map_fragment>'));
  assert.ok(/sampledDiffuseColor\.rgb \/ sampledDiffuseColor\.a/.test(premul.shader.fragmentShader));
  assert.ok(premul.shader.fragmentShader.includes('diffuseColor.a *= uAppear'));
  // No edge rim on the coverage edge (it drew a light dotted outline); the straight path keeps it.
  assert.ok(premul.shader.fragmentShader.includes('float erim = 0.0;'));
  assert.ok(straight.shader.fragmentShader.includes('float erim = clamp(length(ag) * 60.0, 0.0, 1.0) * uRim * cutA;'));
  assert.equal(premul.shader.uniforms.uAppear.value, 1);
  // A blending (frame-cut) pose gets its anti-aliasing from blending, not coverage.
  const mesh = { material: premul.m };
  material.setCutFade(mesh);
  assert.equal(premul.m.alphaToCoverage, false);
  assert.equal(premul.m.transparent, true);
});

// Mock row: meshes with the fields setChronoCut/tickChrono touch.
function row(n, { ease = false, liveMode, live = null } = {}) {
  const uv = () => ({ array: new Float32Array(8), needsUpdate: false });
  const children = Array.from({ length: n }, (_, i) => {
    const attr = uv();
    return {
      visible: true, userData: { order: i, baseUV: new Float32Array(8) },
      scale: { v: 1, setScalar(x) { this.v = x; } },
      geometry: { getAttribute: () => attr },
      material: { opacity: 1, color: { v: 1, setScalar(x) { this.v = x; } }, userData: { uSat: { value: 1 }, uRim: { value: 0 }, uAppear: { value: 1 }, uCut: null } },
    };
  });
  const userData = { chrono: true, count: n, shadows: [], ribbon: null, activeOrders: null, meta: {}, live, liveMesh: null, cellUV: (i) => Array(8).fill(i) };
  if (ease) userData.ease = true;
  if (liveMode) userData.liveMode = liveMode;
  return { children, userData };
}

test('default read head sets every pose at once (other viewers unchanged)', () => {
  const g = row(4);
  chrono.setChronoCut(g, 1);
  chrono.setChronoCut(g, 0.5);
  assert.deepEqual(g.children.map((m) => m.visible), [true, true, false, false]);
  assert.equal(g.children[1].scale.v, 1.06);
  assert.equal(g.children[1].material.userData.uRim.value, 0.28);
  assert.equal(g.children[0].material.color.v, 0.78);
  assert.equal(g.children[1].material.userData.uAppear.value, 1);
});

test('eased read head: the old head settles over ~0.15 s and a newly reached pose fades in', () => {
  const g = row(4, { ease: true });
  chrono.tickChrono(g, 0.5, 10);
  assert.equal(g.children[1].scale.v, 1.06, 'first tick: shown poses start at their targets');
  chrono.tickChrono(g, 0.75, 10.016);
  const head = g.children[2], old = g.children[1];
  assert.ok(head.visible);
  assert.ok(head.material.userData.uAppear.value < 0.3, `new pose starts faded (${head.material.userData.uAppear.value})`);
  assert.ok(old.scale.v > 1.04 && old.scale.v < 1.06, `old head shrinks gradually (${old.scale.v})`);
  for (let k = 1; k <= 30; k += 1) chrono.tickChrono(g, 0.75, 10.016 + k * 0.016);
  assert.equal(head.material.userData.uAppear.value, 1);
  assert.ok(Math.abs(old.scale.v - 1) < 1e-3 && Math.abs(head.scale.v - 1.06) < 1e-3);
  // A pose hidden by scrubbing back fades in again when it is reached again.
  chrono.tickChrono(g, 0.5, 11);
  chrono.tickChrono(g, 0.75, 11.016);
  assert.ok(head.material.userData.uAppear.value < 0.3);
});

test('live loop: wraps by default; "pingpong" plays forward then back with no jump', () => {
  const seq = (mode) => {
    const g = row(3, { liveMode: mode, live: { start: 3, count: 4 } });
    const out = [];
    for (let k = 0; k < 8; k += 1) { chrono.tickChrono(g, 1, k / 8 + 0.01); out.push(g.children[2].geometry.getAttribute('uv').array[0]); }
    return out;
  };
  assert.deepEqual(seq(undefined), [3, 4, 5, 6, 3, 4, 5, 6]);
  assert.deepEqual(seq('pingpong'), [3, 4, 5, 6, 5, 4, 3, 4]);
});

test('card turn: zero at rest, back toward the camera by its share of the drag', () => {
  assert.ok(Math.abs(framing.chronoCardYaw(-0.3, -0.3, 0.6)) < 1e-12);
  assert.ok(Math.abs(framing.chronoCardYaw(-0.82, -0.3, 0.6) - 0.312) < 1e-9);
  assert.ok(Math.abs(framing.chronoCardYaw(0.22, -0.3, 0.6) + 0.312) < 1e-9);
});

// three.js projection of a row whose cards turn inside the turning group.
function worst(rects, f, aspect, turn) {
  let w = 0;
  for (let i = 0; i <= 20; i += 1) for (let j = 0; j <= 6; j += 1) {
    const yaw = -0.82 + (1.04 * i) / 20, pitch = -0.28 + (0.56 * j) / 6;
    const cam = new THREE.PerspectiveCamera(38, aspect, 0.1, 500);
    const p = framing.chronoPanAt(f, yaw, pitch);
    cam.position.set(f.camX + p.x, f.camY + p.y, f.dist); cam.lookAt(p.x, f.aimY + p.y, 0);
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const g = new THREE.Object3D(); g.rotation.set(pitch, yaw, 0); g.updateMatrixWorld();
    for (const r of rects) {
      const card = new THREE.Object3D(); card.position.set(r.x, r.y, r.z); card.rotation.y = framing.chronoCardYaw(yaw, -0.3, turn); card.scale.setScalar(r.s);
      g.add(card); card.updateMatrixWorld();
      for (const [lx, ly] of [[r.l, r.t], [r.r, r.t], [r.l, r.b], [r.r, r.b]]) {
        const v = new THREE.Vector3(lx, ly, 0).applyMatrix4(card.matrixWorld).project(cam);
        w = Math.max(w, Math.abs(v.x), Math.abs(v.y));
      }
    }
  }
  return w;
}
const rowRects = (n, W = 3.5, H = 3.4) => Array.from({ length: n }, (_, i) => ({ x: (i - (n - 1) / 2) * 1.2 * W, y: 0, z: (i / Math.max(1, n - 1) - 0.5) * 2, s: i === n - 1 ? 1.06 : 1, l: -W / 2, r: W / 2, t: H / 2, b: -H / 2 }));

test('framing solved with the card turn keeps every turned card inside the frame', () => {
  const rects = rowRects(5), aspect = 978 / 496;
  const f = framing.frameChronoView(rects, { aspect, aimY: -0.2, yawBound: 0.52, cardTurn: 0.6 });
  assert.ok(worst(rects, f, aspect, 0.6) <= 1.001, 'turned cards contained');
  const rest = framing.frameChronoView(rects, { aspect, aimY: -0.2, yawBound: 0.52 });
  assert.ok(Math.abs(f.rest.x - rest.rest.x) < 0.05, 'the rest view barely moves');
});

test('minDist holds a few-pose view back when it still contains them, never closer', () => {
  const rects = rowRects(1), aspect = 978 / 496;
  const near = framing.frameChronoView(rects, { aspect, aimY: -0.2, yawBound: 0.52, fill: [0.94, 0.6] });
  const held = framing.frameChronoView(rects, { aspect, aimY: -0.2, yawBound: 0.52, fill: [0.94, 0.6], minDist: near.dist * 1.5 });
  assert.ok(Math.abs(held.dist - near.dist * 1.5) < 1e-9);
  assert.ok(worst(rects, held, aspect, 0) <= 1.001);
  const free = framing.frameChronoView(rects, { aspect, aimY: -0.2, yawBound: 0.52, fill: [0.94, 0.6], minDist: near.dist * 0.5 });
  assert.equal(free.dist, near.dist);
});
