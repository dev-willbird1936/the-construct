import assert from 'node:assert/strict';
import {test} from 'node:test';
import {liteResult} from '../../backend/lib/live.js';

const point=(sample,track=1)=>({sample,track,box:[.2,.2,.5,.8],url:`/cut-${track}-${sample}.webp`,x:.35,y:.5,width:.3});
const run={url:p=>`/run/${p}`};

test('saved Lite result keeps in-place poses and the original playback clock',()=>{
  const poses=Array.from({length:24},(_,sample)=>point(sample));
  const result=liteResult(run,{litePoints:new Map([[1,poses]]),maskW:1280,maskH:720,previewW:720,previewH:406,samples:24,fps:12,tracked:{samples:24,fps:12}});
  assert.deepEqual(result.ghosts,poses);
  assert.equal(result.samples,24);
  assert.equal(result.fps,12);
  assert.equal(result.width,720);
  assert.equal(result.height,406);
  assert.deepEqual(result.heading[0].from,result.heading[0].to);
});

test('saved Lite result preserves sparse sample indices, gaps and every selected track',()=>{
  const result=liteResult(run,{litePoints:new Map([[2,[point(0,2),point(5,2)]],[1,[point(0),point(5),point(10)]]]),maskW:64,maskH:40,samples:12,fps:6});
  assert.deepEqual(result.ghosts.map(p=>[p.sample,p.track]),[[0,1],[0,2],[5,1],[5,2],[10,1]]);
  assert.equal(result.samples,12);
  assert.equal(result.fps,6);
  assert.equal(result.ghosts.length,5);
});
