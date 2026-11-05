import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../../vendor/three/build/three.module.js';

// Frame-cut dissolve (loop 9): the production chronoMaterial + cell-cut helpers
// on real three.js classes. Tests the uniform/flag contract and that the shader
// injection anchors exist in this three build, not shader pixels.
const VOLUME = process.env.LITE_VOLUME_JS || new URL('../../volume.js', import.meta.url);
const source = (await fs.readFile(VOLUME, 'utf8')).replace(/\r\n/g, '\n');
const from = source.indexOf('function chronoMaterial(');
const to = source.indexOf('// Faint pool of floor under the row', from);
assert.ok(from >= 0 && to > from, 'chronoMaterial + cut helpers block');
const api = vm.runInNewContext(`${source.slice(from, to)}\n({ chronoMaterial, cutDepth, cellCut, applyCellCut, setCutFade });`, { THREE });

const meta = {
  live: { start: 2, count: 2 },
  cuts: [null, { sides: [0, 0, 0, 1], rect: [0.1, 0.05, 0.9, 1] }, null, { sides: [0.3, 0, 0, 0], rect: [0, 0.2, 0.7, 0.9] }],
};
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

test('dissolve depth: full 22% once half a side is cut, shorter below, none for a graze', () => {
  assert.equal(api.cutDepth(1), 0.22);
  assert.equal(api.cutDepth(0.5), 0.22);
  assert.ok(Math.abs(api.cutDepth(0.3) - 0.11) < 1e-9);
  assert.equal(api.cutDepth(0.1), 0);
  assert.equal(api.cutDepth(0), 0);
  assert.equal(api.cutDepth(undefined), 0);
});

test('cellCut reads only well-formed cut records; old atlases have none', () => {
  assert.equal(api.cellCut({}, 0), null);
  assert.equal(api.cellCut(meta, 0), null);
  assert.deepEqual(api.cellCut(meta, 1).sides, [0, 0, 0, 1]);
  assert.equal(api.cellCut({ cuts: [{ sides: [1, 0], rect: [0, 0, 1, 1] }] }, 0), null);
  assert.equal(api.cellCut({ cuts: [{ sides: [1, 0, 0, 0] }] }, 0), null);
  assert.equal(api.cellCut({ cuts: [{ sides: [0.05, 0, 0, 0], rect: [0, 0, 1, 1] }] }, 0), null);
});

test('an uncut pose keeps the opaque matte exactly as before', () => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), api.chronoMaterial(null));
  api.applyCellCut(m, meta, 0);
  assert.equal(m.material.transparent, false);
  assert.equal(m.material.alphaTest, 0.5);
  assert.equal(m.material.userData.uFade.value, 0);
  assert.deepEqual(m.material.userData.uCut.value.toArray(), [0, 0, 0, 0]);
});

test('a frame-cut pose blends and carries its depths and rect; switching cells updates them', () => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), api.chronoMaterial(null));
  api.setCutFade(m);
  api.applyCellCut(m, meta, 1);
  assert.equal(m.material.transparent, true);
  assert.ok(m.material.alphaTest > 0 && m.material.alphaTest < 0.05);
  assert.equal(m.material.userData.uFade.value, 1);
  assert.ok(near(m.material.userData.uCut.value.toArray(), [0, 0, 0, 0.22]));
  assert.ok(near(m.material.userData.uCutRect.value.toArray(), [0.1, 0.05, 0.9, 1]));
  api.applyCellCut(m, meta, 3);
  assert.ok(near(m.material.userData.uCut.value.toArray(), [0.11, 0, 0, 0]));
  api.applyCellCut(m, meta, 2);
  assert.deepEqual(m.material.userData.uCut.value.toArray(), [0, 0, 0, 0]);
});

test('the shader injection anchors exist in this three build', () => {
  const material = api.chronoMaterial(null);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
  material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /vCellUv = cellUv;/);
  assert.match(shader.fragmentShader, /float cutA = /);
  assert.match(shader.fragmentShader, /if \(uFade > 0\.5\) diffuseColor\.a = step\(0\.5, diffuseColor\.a\) \* cutA;/);
  for (const k of ['uCut', 'uCutRect', 'uFade', 'uSat', 'uRim', 'uRimColor']) assert.ok(shader.uniforms[k], k);
});
