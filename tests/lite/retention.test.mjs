import assert from 'node:assert/strict';
import {test} from 'node:test';
import {retainGhosts, parseFrameStrides} from '../../lite-retention.js';

test('demo defaults to 1-versus-5 while explicit comparisons remain supported',()=>{
  assert.deepEqual(parseFrameStrides(null),[1,5]);
  assert.deepEqual(parseFrameStrides(undefined),[1,5]);
  assert.deepEqual(parseFrameStrides('1,5'),[1,5]);
  assert.deepEqual(parseFrameStrides('1,2,3'),[1,2,3]);
  assert.deepEqual(parseFrameStrides('10'),[10]);
  for(const value of ['', '1,1', '0,5', '1,11', '1,2,3,4', '1,2.5', '1, 5', '1e0,5']) assert.throws(()=>parseFrameStrides(value),/distinct strides/);
});

test('one in five keeps original samples 0,5,10 without inventing missing poses',()=>{
  const poses=Array.from({length:14},(_,sample)=>({sample,track:1,url:`cut-${sample}`,box:[0,0,1,1]}));
  const kept=retainGhosts(poses,5);
  assert.deepEqual(kept.map(p=>p.sample),[0,5,10]);
  assert.equal(kept[1],poses[5]);
  assert.equal(poses.length,14);
});
test('retention uses sample numbers rather than array positions when masks are missing',()=>{
  const poses=[0,1,4,5,6,9,10,12].map(sample=>({sample}));
  assert.deepEqual(retainGhosts(poses,5).map(p=>p.sample),[0,5,10]);
});
test('all tracks share the same retained source-sample grid',()=>{
  const poses=[{sample:0,track:1},{sample:0,track:2},{sample:1,track:1},{sample:5,track:2}];
  assert.deepEqual(retainGhosts(poses,5),[poses[0],poses[1],poses[3]]);
});
test('all ten rates are exact subsets, with no forced extra last pose',()=>{
  const poses=Array.from({length:583},(_,sample)=>({sample}));
  for(let n=1;n<=10;n++){
    const kept=retainGhosts(poses,n);
    assert.equal(kept.length,Math.ceil(poses.length/n));
    assert.ok(kept.every(p=>p.sample%n===0));
  }
  for(const n of [0,11,2.5,'5']) assert.throws(()=>retainGhosts(poses,n),/retention step/);
  assert.throws(()=>retainGhosts([{sample:-1}],5),/sample index/);
});
