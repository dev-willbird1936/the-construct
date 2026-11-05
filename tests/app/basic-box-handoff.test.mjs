import fs from 'node:fs/promises';
import path from 'node:path';
import { test, assert, fixtureClip } from './support.js';
import { openDb } from '../../backend/app/db.js';
import { runBasicJob, BASIC_SELECTION_STALE_TEXT, BASIC_SEED_BOX_NO_MATCH_TEXT, BASIC_UPSTREAM_BUSY_TEXT, BASIC_SAFE_ERRORS, basicFailureText, BASIC_SELECTED_FAIL_TEXT, BASIC_SEED_BOX_AMBIGUOUS_TEXT } from '../../backend/app/runner-basic.js';
import { readBasicSelection, BASIC_CLOCK_TEXT, BASIC_HANDOFF_TEXT, BASIC_MASK_TEXT } from '../../backend/pipeline/basic/lib/selected-source.mjs';
import { SELECTED_TRACK_TIMEOUT } from '../../backend/lib/track-selected.js';
import { VIDEO_SEED_NO_MATCH, VIDEO_SEED_AMBIGUOUS } from '../../backend/lib/sam-video-seed.mjs';
import { BOX_SELECTION_NO_MATCH } from '../../backend/lib/sam-image-result.mjs';

async function setup(t){
 const dataDir=await fs.mkdtemp('/tmp/the-construct/main/basic-box-job-test-');
 const db=openDb(dataDir);t.after(()=>db.close());
 const upload={id:'owned-upload',path:await fixtureClip(),duration:2,fps:10,frames:20,width:128,height:96};
 const box={left:20/128,top:20/96,right:40/128,bottom:40/96};
 const snap={version:2,uploadId:upload.id,frameIndex:7,seedTime:.7,frameWidth:128,frameHeight:96,promptBox:{left:10,top:10,right:50,bottom:50},objects:[{id:1,box}]};
 const job={id:'owned-job',user_id:'alice',seed_time:.7,object_ids:'[1]',selection_snapshot:JSON.stringify(snap),prompt:'must-not-become-a-noun',title:''};
 const mask=new Uint8Array(128*96);for(let y=20;y<40;y++)for(let x=21;x<41;x++)mask[y*128+x]=1;
 const result={frameWidth:128,frameHeight:96,objects:[{id:1,label:'selected object',box:{left:21/128,top:20/96,right:41/128,bottom:40/96}}],_internal:{accepted:[{mask,box:{left:21,top:20,right:41,bottom:40}}]}};
 const calls={detect:0,clock:0,spawn:0};
 let spawned;const atSpawn=new Promise(resolve=>{spawned=resolve;});
 const options={db,config:{basicRunner:'inert-runner.mjs',priceSamImageCents:1},dataDir,job,upload,
  _measureCamera:async()=>({confident:true,moving:false}),
  _probeBasicClock:async()=>{calls.clock++;return{kind:'cfr',fps:10,frames:20};},
  _runBoxDetect:async input=>{calls.detect++;assert.deepEqual(input.box,snap.promptBox);input.onRequest();return{result,frameIndex:7,cached:false};},
  spawnFn:(cmd,args,opts,cb)=>{calls.spawn++;const child={killed:false,exitCode:null,kill(){},stdout:{on(){}},stderr:{on(_,fn){this.write=fn;}}};spawned({cmd,args,opts,cb,stderr:child.stderr});return child;},
 };
 return{dataDir,db,upload,job,snap,result,mask,calls,options,atSpawn};
}

test('Basic runner replays recipe once and writes fresh server-owned mask handoff before explicit native CLI spawn',async(t)=>{
 const f=await setup(t),pending=runBasicJob(f.options);
 const child=await Promise.race([f.atSpawn,pending.then(()=>{throw Error('unexpected finish');},e=>{throw e;})]);
 const failed=assert.rejects(pending,e=>e.message===BASIC_SELECTED_FAIL_TEXT);
 try{
  assert.ok(child.args.includes('--selected-source'));assert.equal(child.args.includes('--seed-box'),false);assert.equal(child.args.includes('--object'),false);
  assert.equal(child.args[child.args.indexOf('--concept')+1],'selected object');
  const handoff=await readBasicSelection(path.join(f.dataDir,'specimens',f.job.id),f.upload.path,{width:128,height:96,fps:10,frameCount:20});
  assert.equal(handoff.seedFrameIndex,7);assert.deepEqual(handoff.chosenMask,f.mask);assert.deepEqual(handoff.chosenBox,f.result._internal.accepted[0].box);
  assert.deepEqual(f.calls,{clock:1,detect:1,spawn:1});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM spend').get().n,1);
 }finally{child.stderr.write('synthetic connection error 503');child.cb({code:3});await failed;}
 // The owned failed handoff stays intact; requeue must not buy another image.
 await assert.rejects(runBasicJob(f.options),e=>e.message===BASIC_HANDOFF_TEXT);
 assert.equal(f.calls.detect,1);assert.equal(f.calls.spawn,1);
});

// Loop 8 (tier-improve 2026-11-04): a long or variable-rate source is no longer
// a refusal; it runs on a proven constant-rate cut from the clicked frame.
for(const kind of ['long','variable-rate'])test(`Basic box selection on a ${kind} clip runs on a constant-rate cut from the clicked frame`,async(t)=>{
 const f=await setup(t);
 if(kind==='long')f.options.upload={...f.upload,frames:360};
 else f.options._probeBasicClock=async()=>{f.calls.clock++;throw Error(BASIC_CLOCK_TEXT);};
 const pending=runBasicJob(f.options);
 const child=await Promise.race([f.atSpawn,pending.then(()=>{throw Error('unexpected finish');},e=>{throw e;})]);
 const failed=assert.rejects(pending);
 const cut=child.args[1];
 try{
  assert.notEqual(cut,f.upload.path);assert.match(path.basename(cut),/^basic-cut-owned-job.mp4$/);
  const handoff=await readBasicSelection(path.join(f.dataDir,'specimens',f.job.id),cut,{width:128,height:96,fps:10,frameCount:13});
  assert.equal(handoff.seedFrameIndex,0,'the clicked frame is cut frame 0');assert.equal(handoff.frames,13,'source frames 7..19 at stride 1');
  assert.deepEqual(handoff.chosenMask,f.mask);assert.deepEqual(handoff.chosenBox,f.result._internal.accepted[0].box);
  assert.equal(f.calls.detect,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM spend').get().n,1,'no extra spend for the cut');
 }finally{child.cb({code:3});await failed;}
 await new Promise(r=>setTimeout(r,50));
 await assert.rejects(fs.stat(cut),'the cut is removed once the child is done');
});

for(const kind of ['stale','no-match','upstream','wrong-subject','raster','cancel'])test(`Basic visual ${kind} refuses without a child or silent fallback`,async(t)=>{
 const f=await setup(t);let expected;
 if(kind==='stale'){f.options.job={...f.job,selection_snapshot:JSON.stringify({...f.snap,frameIndex:6})};expected=BASIC_SELECTION_STALE_TEXT;}
 if(kind==='no-match'||kind==='upstream'){
  f.options._runBoxDetect=async input=>{f.calls.detect++;input.onRequest();throw Error(kind==='no-match'?BOX_SELECTION_NO_MATCH:'private synthetic provider details');};
  expected=kind==='no-match'?BASIC_SEED_BOX_NO_MATCH_TEXT:BASIC_UPSTREAM_BUSY_TEXT;
 }
 if(kind==='wrong-subject'){f.result.objects[0].box={left:.7,top:.7,right:.8,bottom:.8};expected=BASIC_SEED_BOX_NO_MATCH_TEXT;}
 if(kind==='raster'){f.result.frameWidth=64;expected=BASIC_SELECTION_STALE_TEXT;}
 if(kind==='cancel'){const c=new AbortController();c.abort();f.options.signal=c.signal;}
 await assert.rejects(runBasicJob(f.options),e=>kind==='cancel'?e.code==='APP_SHUTDOWN':e.message===expected);
 assert.equal(f.calls.spawn,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM spend').get().n,['no-match','upstream','wrong-subject','raster'].includes(kind)?1:0);
});

test('selected CLI crafted errors stay safe and never become outage retries because a stack contains 502',()=>{
 assert.equal(basicFailureText({code:3},VIDEO_SEED_NO_MATCH+' at synthetic:503:1'),BASIC_SEED_BOX_NO_MATCH_TEXT);
 assert.equal(basicFailureText({code:3},VIDEO_SEED_AMBIGUOUS+' at synthetic:503:1'),BASIC_SEED_BOX_AMBIGUOUS_TEXT);
 for(const text of [BASIC_HANDOFF_TEXT,BASIC_CLOCK_TEXT,BASIC_MASK_TEXT,SELECTED_TRACK_TIMEOUT]){
  assert.ok(BASIC_SAFE_ERRORS.includes(text));assert.equal(basicFailureText({code:3},`error: Error: ${text}\n at synthetic:502:1`),text);
 }
});
