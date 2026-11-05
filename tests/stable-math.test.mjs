import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { frameAt, poseKeys, regularisePositions, validateMeta, timeLabel, surroundOf } from '../stable-math.mjs';

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
test('timestamps map to frames, including irregular gaps and endpoints', () => {
  const times=[2,2.1,2.4,3];
  assert.equal(frameAt(times,-1),0);
  assert.ok(Math.abs(frameAt(times,0.25)-1.5)<1e-10);
  assert.equal(frameAt(times,1),3);
  assert.equal(frameAt(times,5),3);
});
test('stationary subjects produce no duplicate history poses', () => {
  assert.deepEqual(poseKeys(Array.from({length:100},()=>[1,2,3]),0.2),[0]);
});
test('spatial poses stay anchored and capped along long curved paths', () => {
  const p=Array.from({length:500},(_,i)=>[Math.sin(i/10),0,i/50]);
  const keys=poseKeys(p,0.1);
  assert.ok(keys.length<=12);
  assert.equal(keys[0],0);
  assert.ok(keys.every((k,i)=>!i||k>keys[i-1]));
});
test('dense flow uses substantially more actual observations without losing its cap', () => {
  const p=Array.from({length:100},(_,i)=>[i/100,0,0]);
  const spaced=poseKeys(p,0.2),flow=poseKeys(p,0.2,32,0.16);
  assert.ok(flow.length>=spaced.length*3);
  assert.ok(flow.length<=32);
  assert.equal(flow[0],0);
  assert.ok(flow.every((k,i)=>Number.isInteger(k)&&k>=0&&k<p.length&&(!i||k>flow[i-1])));
  assert.deepEqual(poseKeys(Array.from({length:100},()=>[1,2,3]),0.2,32,0.16),[0]);
});
test('time labels carry rounded seconds into minutes', () => {
  assert.equal(timeLabel(0),'00:00.00');
  assert.equal(timeLabel(61.25),'01:01.25');
  assert.equal(timeLabel(59.999),'01:00.00');
});
test('regularised relief preserves every source-camera projection', () => {
  const pos=new Float32Array(Array.from({length:30},(_,i)=>[(i%5-2)*0.1,(Math.floor(i/5)-2.5)*0.1,-1.5-i*0.08]).flat());
  const original=pos.slice();
  const r=regularisePositions(pos,Uint32Array.from({length:30},(_,i)=>i),identity,[0,0,-2.7]);
  assert.ok(r<1&&r>=0.05);
  for(let i=0;i<pos.length;i+=3){
    assert.ok(Math.abs(pos[i]/pos[i+2]-original[i]/original[i+2])<1e-6);
    assert.ok(Math.abs(pos[i+1]/pos[i+2]-original[i+1]/original[i+2])<1e-6);
    assert.ok(pos[i+2]<0&&Number.isFinite(pos[i+2]));
  }
});
test('regularisation handles translated and rotated source cameras', () => {
  const matrix=[0,0,-1,0, 0,1,0,0, 1,0,0,0, 2,3,4,1];
  const local=Array.from({length:30},(_,i)=>[(i%5-2)*0.1,(Math.floor(i/5)-2.5)*0.1,-1-i*0.08]);
  const world=new Float32Array(local.flatMap(p=>[2+p[2],3+p[1],4-p[0]]));
  regularisePositions(world,Uint32Array.from({length:30},(_,i)=>i),matrix,[-0.2,3,4]);
  for(let i=0;i<local.length;i++){
    const p=[4-world[i*3+2],world[i*3+1]-3,world[i*3]-2];
    assert.ok(Math.abs(p[0]/p[2]-local[i][0]/local[i][2])<1e-6);
    assert.ok(Math.abs(p[1]/p[2]-local[i][1]/local[i][2])<1e-6);
  }
});
test('planar and tiny geometry remain finite', () => {
  const p=new Float32Array([0,0,-2,1,0,-2,0,1,-2,1,1,-2]);
  const old=p.slice();regularisePositions(p,new Uint32Array([0,1,2,3]),identity,[0.5,0.5,-2]);
  assert.deepEqual(p,old);
  assert.equal(regularisePositions(new Float32Array([0,0,-1]),new Uint32Array([0]),identity,[0,0,-1]),1);
});
test('every supported baked clip has valid metadata', () => {
  for(const clip of ['walker','horse','cat','grizzly','cougar','blackbear']) validateMeta(JSON.parse(fs.readFileSync(new URL('../assets/stable/'+clip+'/stable.json',import.meta.url))));
});
test('source projections remain invariant on every supported actual bake', () => {
  for (const clip of ['walker','horse','cat','grizzly','cougar','blackbear']) {
    const root=new URL('../assets/stable/'+clip+'/',import.meta.url);
    const meta=JSON.parse(fs.readFileSync(new URL('stable.json',root)));
    const pb=fs.readFileSync(new URL('pos.f32',root)), ib=fs.readFileSync(new URL('idx.u32',root));
    const positions=new Float32Array(pb.buffer,pb.byteOffset,pb.byteLength/4);
    const indices=new Uint32Array(ib.buffer,ib.byteOffset,ib.byteLength/4);
    for(let frame=0;frame<meta.sub.length;frame++) {
      const rec=meta.sub[frame];if(!rec)continue;
      const original=positions.subarray(rec.vertOffset*3,(rec.vertOffset+rec.vertCount)*3), changed=original.slice();
      const used=indices.subarray(rec.idxOffset,rec.idxOffset+rec.idxCount), m=meta.cameras[frame];
      regularisePositions(changed,used,m,rec.centroid);
      const project=(p,v)=>{
        const x=p[v*3]-m[12],y=p[v*3+1]-m[13],z=p[v*3+2]-m[14];
        const depth=x*m[8]+y*m[9]+z*m[10];
        return [(x*m[0]+y*m[1]+z*m[2])/depth,(x*m[4]+y*m[5]+z*m[6])/depth];
      };
      for(let i=0;i<used.length;i+=97) {
        const a=project(original,used[i]),b=project(changed,used[i]);
        assert.ok(Math.abs(a[0]-b[0])<1e-5&&Math.abs(a[1]-b[1])<1e-5,clip+' frame '+frame);
      }
    }
  }
});
test('invalid timestamps, matrices and empty tracking fail clearly', () => {
  const meta=JSON.parse(fs.readFileSync(new URL('../assets/stable/grizzly/stable.json',import.meta.url)));
  assert.throws(()=>validateMeta({...meta,times:[0,0]}),/invalid or incomplete/);
  assert.throws(()=>validateMeta({...meta,sub:meta.sub.map(()=>null)}),/invalid or incomplete/);
  assert.throws(()=>validateMeta({...meta,cameras:meta.cameras.map(()=>[NaN])}),/invalid or incomplete/);
});
test('a surround is taken only when it names an env image and two shares of the frame', () => {
  const ok={fill:{surround:{tex:'env/surround.jpg',pad:[0.25,0.249]}}};
  assert.deepEqual(surroundOf(ok),{tex:'env/surround.jpg',pad:[0.25,0.249]});
  for(const bad of [{},{fill:{}},{fill:{surround:{tex:'../x.jpg',pad:[0.25,0.25]}}},{fill:{surround:{tex:'env/s.jpg',pad:[0.25]}}},
    {fill:{surround:{tex:'env/s.jpg',pad:[0,0.25]}}},{fill:{surround:{tex:'env/s.jpg',pad:[0.25,'0.25']}}},{fill:{surround:{tex:'env/s.gif',pad:[0.25,0.25]}}}])
    assert.equal(surroundOf(bad),null,JSON.stringify(bad));
});
