const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../site.js'), 'utf8');
const start = source.indexOf('function fitChronoCell(');
const end = source.indexOf('// Licensed default', start);
assert.ok(start >= 0 && end > start, 'gallery layout source anchors');
const ctx = { OPEN: 9.5, YAW: -0.42, camera: { fov: 56 }, THREE: { MathUtils: { degToRad: x => x * Math.PI / 180 } } };
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.layout={fitChronoCell,focusZForChrono};', ctx);
const { fitChronoCell, focusZForChrono } = ctx.layout;

test('gallery row fits full transparent tiles as well as tight alpha bounds', () => {
 for (const count of [1, 5, 7, 14]) for (const aspect of [.7, 1, 1.4]) for (const fill of [.2, .9, 1]) {
  const fit = fitChronoCell({count, aspect, anchors:[{left:0,right:fill}]});
  assert.ok(Number.isFinite(fit.height) && fit.height > 0 && fit.height <= 6.2);
  assert.ok(fit.height * aspect * (.85 * (count-1) + 1) <= 9.5*.95 + 1e-9);
 }
});
test('focus projection stays bounded for wide and phone viewports, including one pose', () => {
 for (const count of [1, 5, 7, 14]) for (const aspect of [.7, 1, 1.4]) for (const viewport of [390/844,1280/720]) {
  const fit = fitChronoCell({count,aspect});
  const group = {userData:{chrono:true,rowLen:fit.height*aspect*.85*(count-1),poseW:fit.height*aspect,depth:fit.depth}};
  const z = focusZForChrono(group, viewport);
  assert.ok(Number.isFinite(z) && z >= 0 && z <= 13);
 }
});
test('non-chrono or malformed geometry is not advanced', () => {
 for (const userData of [{},{chrono:true,rowLen:NaN,poseW:1,depth:4},{chrono:true,rowLen:1,poseW:Infinity,depth:4},{chrono:true,rowLen:1,poseW:1,depth:-1}]) {
  assert.equal(focusZForChrono({userData},1280/720),0);
 }
 for(const fov of [NaN,0,180]) {
  ctx.camera.fov=fov;
  assert.equal(focusZForChrono({userData:{chrono:true,rowLen:5,poseW:1,depth:4.6}},1280/720),0);
 }
 ctx.camera.fov=56;
});
test('cell approach is continuous at the visibility boundary, not focus-ID gated', () => {
 assert.match(source, /focusWeight = group\.userData\.chrono \|\| plateRoom \? Math\.max\(0, 1 - distanceToCell/);
 assert.doesNotMatch(source, /isFocus && group\.userData\.chrono\) \? focusZ/);
});
test('mobile view controls remain accessible through native disclosure', () => {
 assert.match(source,/document\.createElement\("details"\)/);
 assert.match(source,/document\.createElement\("summary"\)/);
 // The disclosure now starts closed at every width (the room comes first).
 assert.match(source,/panel\.open = false/);
 assert.match(source,/body\.in-instrument \.toggles/);
});
