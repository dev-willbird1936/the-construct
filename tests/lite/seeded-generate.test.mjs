import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require=createRequire(new URL('../../backend/package.json',import.meta.url));
const rootModule=name=>new URL('../../backend/lib/'+name,import.meta.url).href;
const line=(frame,id='1')=>`<${frame}f>${id}<|box;x1=2;y1=2;x2=5;y2=4;w=16;h=12|><|mask;x=0;y=0;data=3,4,!!!!!'y7K#I-=|>\n`;

async function fixture(text=line(37)+line(38),failure=false) {
  const dir=await fs.mkdtemp('/tmp/the-construct/main/lite-source-test-');
  const deps=`
import fs from 'node:fs/promises';import path from 'node:path';
export {recordsOfKind,parseVideoStream} from ${JSON.stringify(pathToFileURL(require.resolve('@meta-sam/parser')).href)};
export {parseTrackedVideo} from ${JSON.stringify(rootModule('sam-image-result.mjs'))};
export {makeVideoSeed,VIDEO_SEED_NO_MATCH,VIDEO_SEED_AMBIGUOUS} from ${JSON.stringify(rootModule('sam-video-seed.mjs'))};
export {requireSelectedMask,selectedVideoCandidates} from ${JSON.stringify(rootModule('selected-video-result.mjs'))};
export {cancelledError,sleepAbortable,throwIfCancelled} from ${JSON.stringify(rootModule('cancel.js'))};
export {upscaleMask,maskIoU} from ${JSON.stringify(rootModule('compose.js'))};
export const calls=[],composites=[];
export const client={responses:{async create(body,options){calls.push({body,options});if(${failure})throw Error('synthetic provider failure');return(async function*(){yield {type:'response.output_text.done',item_id:'synthetic',output_index:0,content_index:0,text:${JSON.stringify(text)}};yield {type:'response.completed'};})();}}};
export const decoded=[];
export async function* decodeFramesRgb(video,indices,opts){decoded.push([...indices]);for(const i of indices)yield {index:i,rgb:Buffer.from('source-'+i)};}
export async function cutoutPng(rgb,mask,w,h){composites.push({source:rgb.toString(),area:mask.reduce((s,x)=>s+x,0),w,h});return Buffer.from('synthetic cutout');}
export async function emptyPng(){return Buffer.from('synthetic empty');}
`;
  await fs.writeFile(path.join(dir,'deps.mjs'),deps,{flag:'wx'});
  const source=(await fs.readFile(new URL('../../backend/lib/generate.js',import.meta.url),'utf8'))
    .replace(/from "(?!node:)[^"]+"/g,'from "./deps.mjs"');
  await fs.writeFile(path.join(dir,'generate.mjs'),source,{flag:'wx'});
  const module=await import(pathToFileURL(path.join(dir,'generate.mjs')));
  const dependencies=await import(pathToFileURL(path.join(dir,'deps.mjs')));
  const chosenMask=new Uint8Array(16*12);for(let y=2;y<5;y++)for(let x=2;x<6;x++)chosenMask[y*16+x]=1;
  return {module,dependencies,input:{videoPath:'unread-original.mp4',fileId:'synthetic-owned',concept:'deer',frameWidth:16,frameHeight:12,fps:25,seedFrameIndex:37,chosenMask,chosenBox:{left:2,top:2,right:6,bottom:5},jobDir:dir,selectedSeed:true,sourceFrames:200}};
}

test('real generator source sends nonzero box-only request and keeps exact source timestamps',async()=>{
  const {module,dependencies:dep,input}=await fixture();
  const result=await module.generateVolume(input);
  assert.equal(dep.calls.length,1);
  assert.equal(dep.calls[0].body.input[0].content[0].text,'<37f>1<|box;x1=2;y1=2;x2=5;y2=4;w=16;h=12|>');
  assert.deepEqual(dep.calls[0].body.metadata,{propagation_direction:'forward'});
  assert.equal(dep.calls[0].options.maxRetries,0);
  assert.equal(result.seedPrompt.objectId,'1');
  assert.equal(result.seedPrompt.samOffset,0);
  assert.deepEqual(result.frames.map(f=>[f.sourceFrameIndex,f.timestamp,f.present]),[[37,1.48,true],[38,1.52,true]]);
  assert.deepEqual(dep.composites.map(f=>[f.source,f.area]),[['source-37',12],['source-38',12]]);
});
for(const [label,text] of [['wrong id',line(37,'7')],['two ids',line(37)+line(38,'2')],['missing exact seed',line(38)],['out of frame range',line(37)+line(200)],['unexpected backward frames',line(36)+line(37)],['reported raster mismatch',line(37).replace('w=16;h=12','w=8;h=6')],['unusable text','unexpected completed text\n']]) {
  test(`seeded ${label} refuses in one attempt before extraction`,async()=>{
    const {module,dependencies:dep,input}=await fixture(text);
    await assert.rejects(module.generateVolume(input));
    assert.equal(dep.calls.length,1);assert.equal(dep.composites.length,0);
  });
}
test('a later valid mask revision for the same frame replaces the earlier revision',async()=>{
  const revised=line(37).replace('x1=2;y1=2;x2=5;y2=4','x1=1;y1=1;x2=4;y2=3');
  const {module,dependencies:dep,input}=await fixture(line(37)+revised);
  const result=await module.generateVolume(input);
  assert.equal(result.frames.length,1);assert.equal(dep.composites.length,1);
  assert.ok(result.matchScore>=0.25&&result.matchScore<1,'latest geometry, not the earlier perfect overlap');
});
test('seeded provider failure consumes one attempt, not the legacy outer retries',async()=>{
  const {module,dependencies:dep,input}=await fixture('',true);
  await assert.rejects(module.generateVolume(input));assert.equal(dep.calls.length,1);
});
test('unproven SAM offset refuses before any client call',async()=>{
  const {module,dependencies:dep,input}=await fixture();
  await assert.rejects(module.generateVolume({...input,samOffset:37}));assert.equal(dep.calls.length,0);
});
test('seeded low-overlap geometry refuses even when the prompt identity echoes',async()=>{
  const {module,dependencies:dep,input}=await fixture();
  await assert.rejects(module.generateVolume({...input,chosenBox:{left:8,top:6,right:12,bottom:9}}));
  assert.equal(dep.calls.length,1);assert.equal(dep.composites.length,0);
});
test('a matching echoed box cannot override an incompatible selected mask',async()=>{
  const {module,dependencies:dep,input}=await fixture();
  const incompatible=new Uint8Array(16*12);incompatible[2*16+2]=1;
  await assert.rejects(module.generateVolume({...input,chosenMask:incompatible}));
  assert.equal(dep.calls.length,1);assert.equal(dep.composites.length,0);
});
test('invalid or empty selected masks refuse before a client call',async()=>{
  const {module,dependencies:dep,input}=await fixture();
  for(const chosenMask of [undefined,new Uint8Array(4),new Uint8Array(16*12)]) {
    await assert.rejects(module.generateVolume({...input,chosenMask}));
  }
  assert.equal(dep.calls.length,0);
});
test('already-cancelled seeded work dispatches nothing',async()=>{
  const {module,dependencies:dep,input}=await fixture();const controller=new AbortController();controller.abort();
  await assert.rejects(module.generateVolume({...input,signal:controller.signal}));assert.equal(dep.calls.length,0);
});
test('automatic legacy request retains noun phrase and has no seeded metadata or manifest fields',async()=>{
  const {module,dependencies:dep,input}=await fixture();
  const result=await module.generateVolume({...input,selectedSeed:false});
  assert.equal(dep.calls.length,1);assert.equal(dep.calls[0].body.input[0].content[0].text,'deer');
  assert.equal('metadata' in dep.calls[0].body,false);assert.equal(dep.calls[0].options,undefined);
  assert.equal('seedPrompt' in result,false);assert.equal(result.concept,'deer');
});

test('a proven strided segment is prompted at its frame 0 and mapped back to source frames',async()=>{
  const {module,dependencies:dep,input}=await fixture(line(0)+line(1)+line(2));
  const result=await module.generateVolume({...input,samSegment:{start:37,stride:2,count:3}});
  assert.equal(dep.calls[0].body.input[0].content[0].text,'<0f>1<|box;x1=2;y1=2;x2=5;y2=4;w=16;h=12|>');
  assert.deepEqual(result.frames.map(f=>[f.sourceFrameIndex,f.timestamp,f.present]),[[37,1.48,true],[39,1.56,true],[41,1.64,true]]);
  assert.deepEqual(dep.decoded,[[37,39,41]],'one decode of exactly the slice frames');
  assert.deepEqual(result.seedPrompt.segment,{start:37,stride:2,count:3});
  assert.ok(result.frames.every(f=>Buffer.isBuffer(f.buffer)),'cut-out bytes handed back (no disk re-read)');
});
test('a segment that does not start at the seed frame refuses before any client call',async()=>{
  const {module,dependencies:dep,input}=await fixture();
  await assert.rejects(module.generateVolume({...input,samSegment:{start:36,stride:2,count:3}}));
  assert.equal(dep.calls.length,0);
});
