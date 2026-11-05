import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=(await fs.readFile(new URL('../../view-lite.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const begin=source.indexOf('  const poseCount = atlas?.count || 0;');
const end=source.indexOf('  slider.addEventListener("input"',begin);
assert.ok(begin>=0&&end>begin,'execute the actual viewer closure, not a rewritten mapper');
function setup(timestamps,{count=4,headOrders=[],durSec=8}={}) {
  const view={auto:true,headOrders},slider={},out={},secOut={},poseOut={};
  const fn=vm.runInNewContext(source.slice(begin,end)+'\nsetCutUi;', {atlas:{count,timestamps},view,slider,out,secOut,poseOut,durSec,Number,Math,Array});
  return{set:fn,view,slider,out,secOut,poseOut};
}

test('irregular native poses retain absolute source time, distinct from continuous progress',()=>{
  const s=setup([1.48,3.8,5.04,7.96]);
  for(const [cut,text]of [[.02,'now: pose 1/4 · 1.5s'],[.3749,'now: pose 1/4 · 1.5s'],[.375,'now: pose 2/4 · 3.8s'],[.625,'now: pose 3/4 · 5.0s'],[1,'now: pose 4/4 · 8.0s'],[.02,'now: pose 1/4 · 1.5s']]) {
    s.set(cut,false);assert.equal(s.poseOut.textContent,text);
  }
  s.set(.5,false);assert.equal(s.secOut.textContent,'4.0s of 8.0s');assert.equal(s.poseOut.textContent,'now: pose 2/4 · 3.8s');assert.equal(s.view.auto,true);
  s.set(.5);assert.equal(s.view.auto,false);assert.equal(s.slider.value,'500');assert.equal(s.out.textContent,'50%');
});
test('portrait head indices use the displayed subset without retiming the source',()=>{
  const s=setup(Array.from({length:20},(_,i)=>i/2),{count:20,headOrders:[0,5,12,19]});
  s.set(.375);assert.equal(s.poseOut.textContent,'now: pose 6/20 · 2.5s');
  s.set(1);assert.equal(s.poseOut.textContent,'now: pose 20/20 · 9.5s');
});
test('finite numeric and legacy numeric-string timestamps preserve formatting, including measured zero',()=>{
  for(const value of [0,'0',1.48,'1.48',' 1.48 ',-1]) {
    const s=setup([value,2,3,4]);s.set(.02);
    assert.equal(s.poseOut.textContent,`now: pose 1/4 · ${Number(value).toFixed(1)}s`);
  }
});
test('missing or incomplete legacy timestamp table preserves the absent suffix',()=>{
  for(const timestamps of [undefined,null,[],[1,2]]) {
    const s=setup(timestamps);s.set(.02);assert.equal(s.poseOut.textContent,'now: pose 1/4');
  }
});
test('missing/malformed entries in a supplied timestamp table are unknown, never coerced to zero or NaN',()=>{
  for(const value of [null,undefined,'','  ',false,true,NaN,Infinity,-Infinity,'not-time',[],{},Symbol('bad')]) {
    const s=setup([value,2,3,4]);s.set(.02);
    assert.equal(s.poseOut.textContent,'now: pose 1/4 · time unknown',String(value));
  }
  const s=setup(Array(4));s.set(1);assert.equal(s.poseOut.textContent,'now: pose 4/4 · time unknown');
});
