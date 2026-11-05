// Actual production extract block, synthetic file markers and explicitly fake
// FFmpeg/Sharp boundaries. Proves file/index identity only, not decoded imagery.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { selectKeyframes } from '../../backend/pipeline/basic/lib/keyframes.mjs';
const source=fs.readFileSync(new URL('../../backend/pipeline/basic/run-basic.mjs',import.meta.url),'utf8');
const block=source.slice(source.indexOf('  await timed("extract", async () => {'),source.indexOf('  // track/ labels are now downscaled copies'));
for(const [name,samples] of [
  ['default40 native forward samples beginning37',selectKeyframes(Array.from({length:163},(_,i)=>i+37),40)],
  ['dense low indices',Array.from({length:40},(_,i)=>i)],
  ['sparse samples beginning0',selectKeyframes(Array.from({length:120},(_,i)=>i),40)],
  ['non-overlapping six frames',selectKeyframes(Array.from({length:163},(_,i)=>i+37),6)],
]) test('full-resolution extraction preserves every original identity: '+name,async()=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'construct-full-identity-'));
  const kfDir=path.join(dir,'kf'),trackDir=path.join(dir,'track');
  const fakeSharp=()=>{const chain={extractChannel:()=>chain,resize:()=>chain,png:()=>chain,toFile:async p=>fsp.writeFile(p,'FAKE-MASK')};return chain;};
  const run=async(bin,args)=>{
    assert.equal(bin,'FAKE-FFMPEG');
    const outputs=args.filter(a=>a.endsWith('kf_%05d.jpg'));
    assert.equal(outputs.length,2);
    for(const out of outputs)for(let i=0;i<samples.length;i++)await fsp.writeFile(out.replace('%05d',String(i+1).padStart(5,'0')),JSON.stringify({source:samples[i]}));
  };
  try{
    const context={fsp,path,kfDir,trackDir,samples,sourceIndex:s=>s,video:'FAKE-VIDEO',W:960,H:540,FFMPEG:'FAKE-FFMPEG',selection:true,sharp:fakeSharp,run,timed:async(_,fn)=>fn(),kfDepth:null,startKfDepth:list=>{assert.deepEqual(list,samples,'keyframe depth starts on every extracted keyframe');return {done:Promise.resolve()};}};
    await vm.runInNewContext('(async()=>{'+block+'})()',context);
    const files=(await fsp.readdir(path.join(kfDir,'full'))).sort();
    assert.deepEqual(files,samples.map(s=>'kf_'+String(s).padStart(5,'0')+'.jpg').sort(),'native full-resolution files may not disappear through same-directory renaming');
    for(const s of samples){const nm='kf_'+String(s).padStart(5,'0')+'.jpg';assert.equal(JSON.parse(await fsp.readFile(path.join(kfDir,'full',nm),'utf8')).source,s,'full RGB guide must have the source identity encoded by its filename');assert.equal(JSON.parse(await fsp.readFile(path.join(kfDir,nm),'utf8')).source,s);}
  }finally{await fsp.rm(dir,{recursive:true,force:true});}
});
