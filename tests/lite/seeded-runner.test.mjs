import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const lib=name=>new URL('../../backend/lib/'+name,import.meta.url).href;
const source=await fs.readFile(new URL('../../backend/app/runner-lite.js',import.meta.url),'utf8');

async function fixture({frames=200,width=16,height=12,selected=true,staleRaster=false,collapseTargets=false,detectFrameIndex=37,detectWidth=width,visual=false,visualCold=false,visualEmpty=false,stride=1,segment=null}={}) {
  const dir=await fs.mkdtemp('/tmp/the-construct/main/lite-runner-test-');
  const deps=`
export {requireWholeSeedSource,VIDEO_SEED_UNSUPPORTED} from ${JSON.stringify(lib('sam-video-seed.mjs'))};
export {requireLiteSeedSource,LITE_WHOLE_SOURCE_FRAMES,cropRows} from ${JSON.stringify(lib('lite-decode.js'))};
export const detectOsdBar=async()=>({share:1,cutY:null});
export {cancelledError,isCancelError,throwIfCancelled} from ${JSON.stringify(lib('cancel.js'))};
export const counts={detect:0,upload:0,stream:0,spend:0};
export const uploaded=[];
export const client={files:{async create({file}){counts.upload++;uploaded.push(file.path);file.destroy();if(${segment==='ok'})return {id:'segment-file'};throw Error('unexpected upload');}}};
export const segCalls=[];
export const liteStride=()=>${stride};
export const buildSamSegment=async(video,options)=>{segCalls.push({video,...options});return ${segment==='ok'}?{ok:true,path:video,...options}:{ok:false,reason:'synthetic misalignment'};};
export const runDetect=async()=>{counts.detect++;if (${collapseTargets}) return {cached:true,frameIndex:${detectFrameIndex},result:{frameWidth:${detectWidth},frameHeight:${height},objects:[{id:1,label:'deer',box:{left:0.1,top:0.1,right:0.9,bottom:0.9}}],_internal:{accepted:[{concept:'deer',box:{left:2,top:2,right:6,bottom:5},mask:new Uint8Array(192)}]}}};throw Error('synthetic detect boundary');};
export const boxCalls=[],streams=[];
export const runBoxDetect=async(options)=>{counts.detect++;boxCalls.push(options.box);if(${visualCold})options.onRequest?.();return {cached:${!visualCold},frameIndex:${detectFrameIndex},result:{frameWidth:${detectWidth},frameHeight:${height},objects:${visualEmpty?'[]':"[{id:1,label:'selected object',box:{left:0.1,top:0.1,right:0.9,bottom:0.9}}]"},_internal:{accepted:${visualEmpty?'[]':`[{concept:'selected object',box:{left:2,top:2,right:6,bottom:5},mask:new Uint8Array(${width*height}).fill(1)}]`}}}};};
export const frameIndexFor=(u,t)=>Math.max(0,Math.min(Math.round(t*u.fps),u.frames-1));
export const parseSelectionSnapshot=JSON.parse,cachedDetect=()=>null,MAX_TRACK_FRAMES=320,CANDIDATE_CONCEPTS=[];
export const SELECTION_STALE_TEXT='Your selection expired. Run detect again and re-pick the object to build.';
export const recordUsage=()=>{counts.spend++;},recordSpend=()=>{counts.spend++;};
export const generateVolume=async(args)=>{counts.stream++;streams.push(args);throw Error('unexpected stream');};
export const cutSegment=()=>{},extractFrame=()=>{},extractFrames=()=>{},measureCamera=()=>{},packChronoAtlas=()=>{},makeThumb=()=>{},buildChronoBackdrop=()=>{},finishPlate=()=>{},classifyUpload=()=>{};
`;
  await fs.writeFile(path.join(dir,'deps.mjs'),deps,{flag:'wx'});
  await fs.writeFile(path.join(dir,'runner.mjs'),source.replace(/from "(?!node:)[^"]+"/g,'from "./deps.mjs"'),{flag:'wx'});
  await fs.writeFile(path.join(dir,'source.bin'),'synthetic source bytes',{flag:'wx'});
  const module=await import(pathToFileURL(path.join(dir,'runner.mjs')));
  const dependencies=await import(pathToFileURL(path.join(dir,'deps.mjs')));
  const snapshot={version:1,uploadId:'synthetic-upload',frameIndex:37,seedTime:1.48,frameWidth:staleRaster?32:width,frameHeight:height,objects:[{id:22,label:'deer',box:{left:0.1,top:0.1,right:0.9,bottom:0.9}}]};
  if(visual){snapshot.version=2;snapshot.objects[0].id=1;snapshot.promptBox={left:1,top:1,right:10,bottom:10};delete snapshot.objects[0].label;}
  if(collapseTargets) snapshot.objects.push({...snapshot.objects[0],id:23,box:{left:0.105,top:0.1,right:0.905,bottom:0.9}});
  return {module,dependencies,input:{db:{prepare:()=>({run(){}})},dataDir:dir,fileIdCache:new Map(),job:{id:'synthetic-job',object_ids:JSON.stringify(selected?[visual?1:22]:[]),seed_time:1.48,selection_snapshot:JSON.stringify(snapshot)},upload:{id:'synthetic-upload',width,height,frames,fps:25,path:path.join(dir,'source.bin')}}};
}
for(const [label,options] of [['scaled',{width:1282}],['odd',{height:13}],['stale raster',{staleRaster:true}],['long scaled',{frames:351,width:1282}],['long odd',{frames:351,height:13}]]) {
  test(`selected ${label} source refuses before detect, upload, stream or spend`,async()=>{
    const {module,dependencies:dep,input}=await fixture(options);
    await assert.rejects(module.runLiteJob(input),/re-pick/i);
    assert.deepEqual(dep.counts,{detect:0,upload:0,stream:0,spend:0});
  });
}
test('automatic legacy long source still reaches the existing detect path',async()=>{
  const {module,dependencies:dep,input}=await fixture({frames:351,selected:false});
  await assert.rejects(module.runLiteJob(input),/synthetic detect boundary/);
  assert.deepEqual(dep.counts,{detect:1,upload:0,stream:0,spend:0});
});
test('refreshed frame and raster must still match the exact persisted selection',async()=>{
  for(const options of [{detectFrameIndex:38},{detectWidth:32}]) {
    const {module,dependencies:dep,input}=await fixture({collapseTargets:true,...options});
    await assert.rejects(module.runLiteJob(input),/selection expired/i);
    assert.deepEqual(dep.counts,{detect:1,upload:0,stream:0,spend:0});
  }
});
test('two persisted selections cannot collapse to one fresh target and spend twice',async()=>{
  const {module,dependencies:dep,input}=await fixture({collapseTargets:true});
  await assert.rejects(module.runLiteJob(input),/ambiguously/i);
  assert.deepEqual(dep.counts,{detect:1,upload:0,stream:0,spend:0});
});
test('visual snapshot replays only its stored image box then passes fresh model mask and box to seeded video',async()=>{
  const {module,dependencies:dep,input}=await fixture({visual:true});
  input.fileIdCache.set(input.upload.id,'synthetic-owned');
  await assert.rejects(module.runLiteJob(input),/unexpected stream/);
  assert.deepEqual(dep.boxCalls,[{left:1,top:1,right:10,bottom:10}]);
  assert.deepEqual(dep.counts,{detect:1,upload:0,stream:1,spend:0});
  assert.equal(dep.streams[0].selectedSeed,true);assert.equal(dep.streams[0].seedFrameIndex,37);
  assert.deepEqual(dep.streams[0].chosenBox,{left:2,top:2,right:6,bottom:5});
  assert.equal(dep.streams[0].chosenMask.length,16*12);
});
test('cold visual replay books its one attempted image and empty replay refuses before video',async()=>{
  for(const empty of [false,true]){
    const {module,dependencies:dep,input}=await fixture({visual:true,visualCold:true,visualEmpty:empty});
    input.config={};input.fileIdCache.set(input.upload.id,'synthetic-owned');
    await assert.rejects(module.runLiteJob(input),empty?/Could not match/:/unexpected stream/);
    assert.deepEqual(dep.counts,{detect:1,upload:0,stream:empty?0:1,spend:2});
    assert.equal(dep.boxCalls.length,1);
  }
});
test('actual whole-source upload cache is reused across source-frame choices',async()=>{
  const start=source.indexOf('async function samSource('),end=source.indexOf('\nexport function estimateSamFrames',start);
  assert.ok(start>=0&&end>start);
  let uploads=0;
  const client={files:{async create({file}){uploads++;for await(const chunk of file)assert.ok(chunk.length);return {id:'synthetic-owned'};}}};
  const {cancelledError,throwIfCancelled}=await import(lib('cancel.js'));
  const sampler=new Function('client','fs','throwIfCancelled','cancelledError','cutSegment','SAM_MAX_WIDTH','MAX_TRACK_FRAMES',source.slice(start,end)+'\nreturn samSource;')
    (client,nodeFs,throwIfCancelled,cancelledError,()=>{throw Error('unexpected cut');},1280,320);
  const dir=await fs.mkdtemp('/tmp/the-construct/main/lite-cache-test-'),file=path.join(dir,'original.bin');
  await fs.writeFile(file,'synthetic original bytes',{flag:'wx'});
  const upload={id:'immutable-upload',frames:200,width:16,height:12,fps:25,path:file},cache=new Map();
  const first=await sampler(upload,0,cache),second=await sampler(upload,37,cache);
  assert.equal(uploads,1);assert.deepEqual(first,second);assert.equal(second.samOffset,0);
});

test('30 fps explicit seed tracks a proven strided cut from the seed frame (about 60 SAM frames, never under 8 fps)',async()=>{
  const {module,dependencies:dep,input}=await fixture({visual:true,stride:2,segment:'ok'});
  await assert.rejects(module.runLiteJob(input),/unexpected stream/);
  assert.equal(dep.segCalls.length,1);
  // 163-frame window at 25 fps: 15 fps would be 82 frames; the 60-frame target thins it to stride 3 (8.3 fps)
  assert.deepEqual({start:dep.segCalls[0].start,stride:dep.segCalls[0].stride,count:dep.segCalls[0].count},{start:37,stride:3,count:Math.ceil((200-37)/3)});
  assert.deepEqual(dep.counts,{detect:1,upload:1,stream:1,spend:0});
  assert.equal(dep.streams[0].fileId,'segment-file');
  assert.deepEqual(dep.streams[0].samSegment,{start:37,stride:3,count:55});
  assert.equal(dep.streams[0].samOffset,0);assert.equal(dep.streams[0].seedFrameIndex,37);
});
test('SAM cut plan: about 60 frames, never under 8 fps, never over 120 frames',async()=>{
  // liteStride is the fixture's (2 = a 25-30 fps clip, 1 = a 15 fps clip)
  const fast=(await fixture({stride:2})).module, slow=(await fixture({stride:1})).module;
  const plan=(m,frames,fps,seed)=>{const p=m.samCutPlan({frames,fps},seed);return [p.stride,p.count,p.cut];};
  assert.deepEqual(plan(fast,210,30,30),[3,60,true]);   // grizzly: 90 -> 60 frames
  assert.deepEqual(plan(fast,200,25,25),[3,59,true]);   // muntjac: 88 -> 59 (8.3 fps)
  assert.deepEqual(plan(fast,144,24,24),[2,60,true]);   // blackcat: already 60
  assert.deepEqual(plan(fast,406,29.97,30),[3,107,true]); // walker: the 120-frame cap rules, 10 fps
  assert.deepEqual(plan(slow,120,15.075,15),[1,105,false]); // roedeer: 15 fps is never thinned below 8 fps
  assert.deepEqual(plan(fast,200,undefined,37),[2,82,true]); // unknown fps: the old 15 fps plan
});
test('a segment that fails its alignment proof falls back to the whole cached clip',async()=>{
  const {module,dependencies:dep,input}=await fixture({visual:true,stride:2,segment:'bad'});
  input.fileIdCache.set(input.upload.id,'synthetic-owned');
  await assert.rejects(module.runLiteJob(input),/unexpected stream/);
  assert.equal(dep.segCalls.length,1);
  assert.deepEqual(dep.counts,{detect:1,upload:0,stream:1,spend:0});
  assert.equal(dep.streams[0].fileId,'synthetic-owned');assert.equal(dep.streams[0].samSegment,undefined);
});
test('a long selected clip (over 350 frames) tracks a proven cut from the seed instead of refusing (<= 120 SAM frames)',async()=>{
  const {module,dependencies:dep,input}=await fixture({visual:true,frames:600,stride:1,segment:'ok'});
  await assert.rejects(module.runLiteJob(input),/unexpected stream/);
  assert.equal(dep.segCalls.length,1);
  assert.deepEqual({start:dep.segCalls[0].start,stride:dep.segCalls[0].stride,count:dep.segCalls[0].count},{start:37,stride:3,count:107});
  assert.deepEqual(dep.counts,{detect:1,upload:1,stream:1,spend:0});
  assert.deepEqual(dep.streams[0].samSegment,{start:37,stride:3,count:107});
  assert.equal(dep.streams[0].samOffset,0);
});
test('a long clip whose cut fails its proof is refused before any SAM stream (no whole-clip fallback)',async()=>{
  const {module,dependencies:dep,input}=await fixture({visual:true,frames:600,stride:2,segment:'bad'});
  await assert.rejects(module.runLiteJob(input),/re-pick/i);
  assert.deepEqual(dep.counts,{detect:1,upload:0,stream:0,spend:0});
});
test('lite seed contract: long clips pass on size rules, short clips keep the whole-source rule',async()=>{
  const {requireLiteSeedSource}=await import(lib('lite-decode.js'));
  assert.doesNotThrow(()=>requireLiteSeedSource({frames:406,width:1280,height:720},30));
  assert.doesNotThrow(()=>requireLiteSeedSource({frames:200,width:1280,height:720},199));
  for(const [u,seed] of [[{frames:406,width:1282,height:720},30],[{frames:406,width:1280,height:721},30],[{frames:406,width:1280,height:720},406],[{frames:406,width:1280,height:720},-1],[{frames:200,width:1280,height:720},200],[{frames:0,width:1280,height:720},0]]){
    assert.throws(()=>requireLiteSeedSource(u,seed),/short original clip/,JSON.stringify([u,seed]));
  }
});
test('a generic animal label takes the creature name Spark gave; specific labels stay',async()=>{
  const {module}=await fixture();
  const {sparkSubjectName}=module;
  assert.equal(sparkSubjectName('animal',['deer','trees','forest floor']),'deer');
  assert.equal(sparkSubjectName('animal',['dry grass','small deer']),'small deer');
  assert.equal(sparkSubjectName('animal',['woman','brick pathway']),null);
  assert.equal(sparkSubjectName('bear',['grizzly bears']),null,'a specific label is never renamed');
  assert.equal(sparkSubjectName('animal',['grizzly bears']),'grizzly bears');
  assert.equal(sparkSubjectName('animal',null),null);
});
test('an early (prewarmed) Lite cut is reused by the job: no second cut, no second upload',async()=>{
  const {module,dependencies:dep,input}=await fixture({visual:true,stride:2,segment:'ok'});
  const warm=await module.prewarmLiteSource({upload:input.upload,frameIndex:37,files:async()=>({id:'warm-file'})});
  assert.deepEqual(warm.samSegment,{start:37,stride:3,count:55});
  assert.equal(dep.segCalls.length,1);
  await assert.rejects(module.runLiteJob(input),/unexpected stream/);
  assert.equal(dep.segCalls.length,1,'the job did not cut again');
  assert.equal(dep.counts.upload,0,'the job did not upload again');
  assert.equal(dep.streams[0].fileId,'warm-file');assert.deepEqual(dep.streams[0].samSegment,{start:37,stride:3,count:55});
  // Same upload + frame: deduplicated.
  assert.equal(module.prewarmLiteSource({upload:input.upload,frameIndex:37,files:async()=>({id:'other'})}),module.prewarmLiteSource({upload:input.upload,frameIndex:37}));
});
test('a failed early upload never fails the job: it cuts and uploads its own',async()=>{
  const {module,dependencies:dep,input}=await fixture({visual:true,stride:2,segment:'ok'});
  await assert.rejects(module.prewarmLiteSource({upload:input.upload,frameIndex:37,files:async()=>{throw Error('meta down');}}),/meta down/);
  await assert.rejects(module.runLiteJob(input),/unexpected stream/);
  assert.equal(dep.counts.upload,1);assert.equal(dep.streams[0].fileId,'segment-file');
});
