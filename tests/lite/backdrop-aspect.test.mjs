import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../../vendor/three/build/three.module.js';
const source=(await fs.readFile(new URL('../../volume.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const start=source.indexOf('  let backdrop = null;',source.indexOf('export function buildChronoVolume'));
const end=source.indexOf('  group.children.sort',start);
assert.ok(start>=0&&end>start,'exercise actual production backdrop construction block');
const context={THREE,chronoBackdropMaterial:()=>new THREE.MeshBasicMaterial()};
// Actual production geometry block + real Three.js classes. Material boundary
// is stubbed: this tests geometry contracts, not shader pixels or calibration.
const make=vm.runInNewContext(`(function(options,staging=true){
 const group=new THREE.Group(),rowLen=4.335,poseW=1.7,height=3.4,groundY=-1.7,depth=.8;
 ${source.slice(start,end)}
 return backdrop;
})`,context);
const fitStart=source.indexOf('export function fitBackdropToFrame(');
const fitEnd=source.indexOf('export function setChronoLayout',fitStart);
assert.ok(fitStart>=0&&fitEnd>fitStart);
const fit=vm.runInNewContext('const _bdV={v:null,d:null};'+source.slice(fitStart,fitEnd).replace('export function','function')+'\nfitBackdropToFrame;',context);
for(const [width,height] of [[640,360],[360,640],[256,256]])test(`backdrop preserves loaded image aspect ${width}x${height}`,()=>{
 const m=make({backdrop:{image:{width,height}}});
 assert.ok(Math.abs(m.userData.baseW/m.userData.baseH-width/height)<1e-9);
 assert.equal(m.userData.baseH,34,'preserve existing vertical geometry datum');
});
test('unknown/invalid loaded dimensions preserve exact legacy geometry',()=>{
 for(const image of [undefined,null,{}, {width:0,height:360},{width:640,height:0},{width:NaN,height:360},{width:640,height:Infinity},{width:-1,height:360},{width:'640',height:360},{width:1e308,height:1e-308}]){
  const m=make({backdrop:{image}});
  assert.equal(m.userData.baseW,4.335*2.5+1.7*12);
  assert.equal(m.userData.baseH,34);
 }
});
test('existing frame fit scales uniformly without corrupting image aspect',()=>{
 const m=make({backdrop:{image:{width:640,height:360}}});
 const camera=new THREE.PerspectiveCamera(38,978/496,.01,1000);
 camera.position.set(1.4,.9,8.606927727395572);camera.lookAt(0,-.2,0);
 fit(m,camera,1.35);
 assert.equal(m.scale.x,m.scale.y);
 assert.ok(Math.abs(m.geometry.parameters.width*m.scale.x/(m.geometry.parameters.height*m.scale.y)-640/360)<1e-9);
});
test('no-backdrop and bare construction paths remain absent',()=>{
 assert.equal(make({}),null);
 assert.equal(make({backdrop:{image:{width:640,height:360}}},false),null);
});
