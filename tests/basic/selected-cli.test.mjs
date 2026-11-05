import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import * as keys from '../../backend/pipeline/basic/lib/keyframes.mjs';
import { writeBasicSelection, readBasicSelection, probeBasicClock, BASIC_HANDOFF_TEXT, BASIC_CLOCK_TEXT, BASIC_MASK_TEXT } from '../../backend/pipeline/basic/lib/selected-source.mjs';
const require=createRequire(new URL('../../backend/package.json',import.meta.url));
const sharp=require('sharp'),run=promisify(execFile);
const BIN='local-models/tools/kdenlive/26.04.3/kdenlive-26.04.3_standalone/bin/';
const source=(await fsp.readFile(new URL('../../backend/pipeline/basic/run-basic.mjs',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const parser=source.slice(source.indexOf('function parseArgs('),source.indexOf('\nasync function proxyUsage'));
const stats=source.slice(source.indexOf('export async function maskStatsUnion('),source.indexOf('\nexport function erodeAlpha')).replace('export ','');
function parse(argv){return vm.runInNewContext(parser+'\nparseArgs;',{...keys,Number,TRACK_CONCEPT_MAX:60,BASIC_HANDOFF_TEXT,usage:()=> 'usage',fail:m=>{throw Error(m);}})(argv);}

test('CLI opt-in is explicit; legacy args unchanged, mixed v1/multiple identity rejected',()=>{
  assert.equal(parse(['video','out','--concept','cat']).opts.seedSelection,false);
  assert.equal(parse(['video','out','--concept','selected object','--selected-source']).opts.seedSelection,true);
  for(const tail of [['--concept','cat'],['--concept','selected object','--seed-box','0,0,1,1'],['--concept','selected object','--object','1']])assert.throws(()=>parse(['video','out','--selected-source',...tail]),e=>e.message===BASIC_HANDOFF_TEXT);
});

test('--matte-dir (Advanced precomputed mattes) needs the selected path and resolves absolute',()=>{
  const p=(argv)=>vm.runInNewContext(parser+'\nparseArgs;',{...keys,Number,path,TRACK_CONCEPT_MAX:60,BASIC_HANDOFF_TEXT,usage:()=> 'usage',fail:m=>{throw Error(m);}})(argv);
  assert.equal(p(['video','out','--concept','selected object','--selected-source','--matte-dir','m']).opts.matteDir,path.resolve('m'));
  assert.throws(()=>p(['video','out','--concept','cat','--matte-dir','m']),/needs --selected-source/);
  assert.equal(p(['video','out','--concept','selected object','--selected-source']).opts.matteDir,undefined);
  // --matte birefnet: Advanced live matte, selected path only, exclusive with --matte-dir
  assert.equal(p(['video','out','--concept','selected object','--selected-source','--matte','birefnet']).opts.matte,'birefnet');
  assert.throws(()=>p(['video','out','--concept','cat','--matte','birefnet']),/needs --selected-source/);
  assert.throws(()=>p(['video','out','--concept','selected object','--selected-source','--matte','birefnet','--matte-dir','m']),/no --matte-dir/);
  assert.throws(()=>p(['video','out','--concept','selected object','--selected-source','--matte','other']),/only --matte birefnet/);
});

test('Advanced matte scripts ship with the pipeline and stay scipy-free',async()=>{
  for(const f of ['birefnet_infer.py','advanced_matte.py','combine_matte.py','refine_alpha.py']){
    const s=await fsp.readFile(new URL('../../backend/pipeline/basic/advanced/'+f,import.meta.url),'utf8');
    assert.ok(!/^\s*(import|from)\s+scipy/m.test(s),f);
  }
  assert.match(source,/birefnet_infer\.py"/);assert.match(source,/advanced_matte\.py"/);
});

test('in-place plate gate ships scipy-free and ships a Muse plate only on accept plus holes validation',async()=>{
  const s=await fsp.readFile(new URL('../../backend/pipeline/basic/inplace_gate.py',import.meta.url),'utf8');
  assert.ok(!/^\s*(import|from)\s+scipy/m.test(s));
  const rung=source.slice(source.indexOf('// In-place rung'),source.indexOf('median plate rejected (ghosted holes)'));
  assert.match(rung,/inplace_gate\.py"/);
  assert.match(rung,/gate\.verdict === "accept"/);
  assert.match(rung,/validatePlate\(\["--holes", holesPath\], grow === null \? "muse-full-inplace"/);
  assert.match(rung,/for \(const grow of \[null, 81, 61, 41\]\)/);
  assert.match(rung,/if \(g\.verdict !== "accept"\) continue;/);
  assert.match(rung,/if \(ok\) \{/);
  assert.match(rung,/keeping ladder plate/);
});

test('two native jobs isolate a shared legacy work root without changing legacy resolution',()=>{
  const original=source.slice(source.indexOf('export function resolveWorkDir('),source.indexOf('const MODELS_DIR =')).replaceAll('export ','');
  const env={path,crypto,process:{env:{BASIC_WORK_DIR:'D:/shared-test-root'}}};
  const funcs=vm.runInNewContext(original+';({resolveWorkDir,resolveSelectedWorkDir})',env);
  assert.equal(funcs.resolveWorkDir('job-a'),path.resolve('D:/shared-test-root'));
  const a=funcs.resolveSelectedWorkDir('job-a'),b=funcs.resolveSelectedWorkDir('job-b');
  assert.notEqual(a,b);assert.equal(a,funcs.resolveSelectedWorkDir('job-a'));
  assert.equal(path.dirname(a),path.resolve('D:/shared-test-root'));
});
test('all selected CLI usage probes are gated, including plate paths',()=>{
  const calls=[...source.matchAll(/await proxyUsage\(\)/g)];
  assert.equal(calls.length,5); // +1: the speculative first Muse edit (tier-improve 2026-11-04), gated like the rest
  for(const call of calls)assert.ok(source.slice(call.index-25,call.index).endsWith('selection ? null : '));
});
test('actual legacy cache-key block retains its golden bytes',async()=>{
  const block=source.slice(source.indexOf('  const TRACK_CACHE_V = 1;'),source.indexOf('  const trackCacheDir =',source.indexOf('  const TRACK_CACHE_V = 1;')));
  const key=await vm.runInNewContext('(async()=>{'+block+'return trackKey;})()', {crypto,fsp:{readFile:async()=>Buffer.from('hello')},video:'ignored',concept:'cat',opts:{concept:'cat',maxKeyframes:40},span:12}); // loop 7: the block hashes its concept argument
  assert.equal(key,'ea1887e635ec7146');
});

test('actual Basic main reaches native frame37 RGB/labels without legacy tracking, refinement or usage GET',async(t)=>{
  const dir=await fsp.mkdtemp('/tmp/the-construct/main/basic-native-cli-test-');
  const inputDir=path.join(dir,'synthetic-input');await fsp.mkdir(inputDir);
  for(let n=0;n<50;n++)await sharp({create:{width:16,height:12,channels:3,background:{r:20+n,g:50,b:80}}}).png().toFile(path.join(inputDir,`f${String(n).padStart(3,'0')}.png`));
  const video=path.join(dir,'synthetic.mp4');
  await run(BIN+'ffmpeg.exe',['-v','error','-framerate','25','-i',path.join(inputDir,'f%03d.png'),'-c:v','libx264rgb','-crf','0','-pix_fmt','rgb24',video],{timeout:20000});
  const oldProbe=process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH=BIN+'ffprobe.exe';
  t.after(()=>{if(oldProbe===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=oldProbe;});
  const chosenMask=new Uint8Array(192);for(let y=2;y<5;y++)for(let x=2;x<6;x++)chosenMask[y*16+x]=1;
  await writeBasicSelection({outDir:dir,videoPath:video,width:16,height:12,fps:25,frames:50,seedFrameIndex:37,promptBox:{left:1,top:1,right:8,bottom:7},chosenBox:{left:2,top:2,right:6,bottom:5},chosenMask});
  const model=path.join(dir,'placeholder.onnx'),python=path.join(dir,'placeholder-python');await fsp.writeFile(model,'inert');await fsp.writeFile(python,'inert');
  const {probeVideo}=await import('../../backend/lib/ffmpeg.js?selected-cli-real-probe');
  const realInfo=await probeVideo(video);
  assert.equal(realInfo.fps,25);assert.equal(realInfo.frameCount,50);
  const work=path.join(dir,'.work'),calls=[],muse=[];
  const context={...keys,BASIC_HANDOFF_TEXT,BASIC_CLOCK_TEXT,BASIC_MASK_TEXT,fs,fsp,path,crypto,sharp,Buffer,Uint8Array,Set,Map,Number,Math,JSON,SAMPLE_FPS:15,
    MODEL:model,VENV_PY:python,META:{nodeEnv:'test',baseUrl:'http://127.0.0.1:1'},FFMPEG:BIN+'ffmpeg.exe',here:dir,
    process:{argv:['node','fake-runner',video,dir,'--concept','selected object','--selected-source','--max-keyframes','6'],env:{BASIC_EARLY_MUSE:'1'}},
    parseArgs:parse,resolveWorkDir:()=>work,resolveSelectedWorkDir:()=>work,stage:()=>{},warn:()=>{},fail:m=>{throw Error(m);},timed:async(_,fn)=>fn(),
    probeVideo,readBasicSelection,probeBasicClock,
    proxyUsage:()=>{throw Error('unexpected usage GET');},trackInstances:()=>{throw Error('unexpected legacy tracker');},
    run:async(bin,args)=>{assert.equal(bin,BIN+'ffmpeg.exe','no depth/refine/Python inference');calls.push(args);return run(bin,args,{timeout:20000});},
    cleanPath:()=>{throw Error('native paid tracking evidence must be preserved');},
    // Early Muse (loop 7): the seed-frame edit starts before tracking.
    createMuseBudget:()=>({left:2,spent:0,reserve:()=>true,charge:()=>{}}),
    museEditPlate:async(seedPath,maskPath,w,h,concept,where)=>{muse.push({seedPath,maskPath,w,h,concept,where});return{ok:false};},
    timings:{},
    trackSelectedInstance:async input=>{
      assert.equal(input.seedFrameIndex,37);assert.equal(input.fps,25);assert.deepEqual(input.chosenMask,chosenMask);
      await fsp.mkdir(input.outDir);await fsp.mkdir(path.join(input.outDir,'labels'));
      for(let i=37;i<=42;i++)await sharp(Buffer.from(chosenMask),{raw:{width:16,height:12,channels:1}}).png().toFile(path.join(input.outDir,'labels',`l${String(i).padStart(5,'0')}.png`));
      return{fps:25,indexDomain:'source-frame',tracks:[{id:1,first:37,last:42,frames:6}]};
    },
  };
  vm.createContext(context);vm.runInContext(stats,context);
  vm.runInContext(source.slice(source.indexOf('export function resolveSelectedWorkDir('),source.indexOf('const MODELS_DIR =')).replace('export ',''),context);
  // Stop immediately before plate/depth work. All earlier main code, native
  // branch selection, clock proof, FFmpeg extraction, masks and stats are real.
  const begin=source.indexOf('async function main() {'),end=source.indexOf('  const pad = 6;',begin);
  const main=vm.runInContext('('+source.slice(begin,end)+'return {frames,seedSample,selectedClock,samples,trackDir,work};\n})',context);
  const result=await main();
  assert.equal(result.seedSample,37);assert.equal(result.selectedClock.kind,'cfr');assert.equal(result.selectedClock.frames,50);
  assert.deepEqual([...result.samples],[37,38,39,40,41,42]);
  assert.deepEqual(Array.from(result.frames,f=>[f.sample,f.src,f.t]),[37,38,39,40,41,42].map(i=>[i,i,i/25]));
  // keyframe extract + the early seed-frame decode, both of native frame 37
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.some(a=>a.includes('eq(n\\,37)'))));
  await new Promise(r=>setTimeout(r,300));
  assert.equal(muse.length,1,'early Muse edit started once, before tracking');
  assert.equal(muse[0].concept,'selected object');assert.match(muse[0].where,/of the frame$/);assert.equal(muse[0].w,960,'working-res seed frame');
  assert.equal(result.frames[0].pixels,12*60*60,'nearest resize keeps the binary mask area, no refine/erosion');
  const rgb=await sharp(path.join(result.work,'kf/full/kf_00037.jpg')).raw().toBuffer();
  assert.ok(Math.abs(rgb[0]-57)<=3,'source RGB is actual decode frame37, not legacy sample37 -> source62');
  assert.ok(await fsp.stat(path.join(result.trackDir,'labels/l00037.png')));
});
