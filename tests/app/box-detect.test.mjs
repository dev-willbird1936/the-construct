import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
process.env.META_API_KEY='DUMMY';process.env.META_BASE_URL='http://127.0.0.1:1/v1';process.env.META_MODEL_RETRIES='1';
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),sharp=require('sharp');
const {client}=await import('../../backend/lib/meta.js');
const {detectBox}=await import('../../backend/lib/detect.js');
const {runBoxDetect,runDetect,snapshotFromCache,parseSelectionSnapshot,__resetDetectCache}=await import('../../backend/app/detect-cache.js');
const line=(id='1',w=16)=>`<0f>${id}<|box;x1=2;y1=2;x2=5;y2=4;w=${w};h=12|><|mask;x=0;y=0;data=3,4,!!!!!'y7K#I-=|>\n`;
const box={left:1,top:1,right:12,bottom:10};
const png=await sharp({create:{width:16,height:12,channels:3,background:'#406030'}}).png().toBuffer();
async function fakeSdk(text,fn,status=200,message='synthetic failure'){
 const previous=client.fetch,calls=[];
 client.fetch=async(url,init)=>{
  calls.push({url,body:JSON.parse(init.body),redirect:init.redirect});
  assert.equal(new URL(url).origin,'http://127.0.0.1:1');
  if(status!==200)return new Response(JSON.stringify({error:{message}}),{status,headers:{'content-type':'application/json'}});
  const events=[{type:'response.output_text.done',item_id:'synthetic-image',output_index:0,content_index:0,text},{type:'response.completed'}];
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 };
 try{return await fn(calls);}finally{client.fetch=previous;}
}

test('actual box image path uses box-only frame0, string identity and real full-raster index map',async()=>fakeSdk(line(),async calls=>{
 let reservations=0;
 const out=await detectBox(png,16,12,box,{onRequest:()=>reservations++});
 assert.equal(calls.length,1);assert.equal(reservations,1);
 assert.equal(calls[0].body.input[0].content[0].text,'<0f>1<|box;x1=1;y1=1;x2=11;y2=9;w=16;h=12|>');
 assert.equal(calls[0].body.input[0].content[1].image_url,'data:image/png;base64,'+png.toString('base64'));
 assert.equal(out.objects.length,1);assert.deepEqual(out.objects[0].box,{left:2/16,top:2/12,right:6/16,bottom:5/12});
 assert.equal(out._internal.accepted[0].mask.length,16*12);assert.equal(out._internal.accepted[0].mask.reduce((a,b)=>a+b,0),12);
 const raw=await sharp(Buffer.from(out.indexMapPngBase64,'base64')).extractChannel(0).raw().toBuffer();
 assert.equal(raw[2*16+2],1);assert.equal(raw[0],0);
}));
test('actual SDK/model layers do not retry a failed visual request',async()=>fakeSdk('',async calls=>{
 let reservations=0;await assert.rejects(detectBox(png,16,12,box,{onRequest:()=>reservations++}));
 assert.equal(calls.length,1);assert.equal(reservations,1);
},500));
test('per-call zero also defeats the extra model-404 retry layer with nonzero global retry setting',async()=>fakeSdk('',async calls=>{
 await assert.rejects(detectBox(png,16,12,box));assert.equal(calls.length,1);
},404,'model was not found'));

test('an actual completed all-zero mask is not a selectable object',async()=>{
 const {encodeSegmentationMask}=await import('../../backend/node_modules/@meta-sam/parser/dist/mask-codec.js');
 // Installed parser's intrinsic conformance encoder; synthetic data only.
 const encoded=encodeSegmentationMask(new Uint8Array(12),4,3);
 const zero=line().replace("!!!!!'y7K#I-=",encoded.payload);
 await fakeSdk(zero,async calls=>{
  const out=await detectBox(png,16,12,box);assert.equal(calls.length,1);assert.deepEqual(out.objects,[]);assert.deepEqual(out._internal.accepted,[]);
 });
});

test('completed empty stays empty without a fabricated rectangle or retry',async()=>fakeSdk('',async calls=>{
 const out=await detectBox(png,16,12,box);assert.equal(calls.length,1);assert.deepEqual(out.objects,[]);assert.deepEqual(out._internal.accepted,[]);
}));
for(const [label,text] of [['wrong identity',line('7')],['two identities',line()+line('2')],['wrong raster',line('1',17)]])test('visual '+label+' refuses rather than selecting a different object',async()=>fakeSdk(text,async calls=>{
 await assert.rejects(detectBox(png,16,12,box));assert.equal(calls.length,1);
}));
test('invalid box, rotated/mismatched still raster and cancellation all refuse before reservation/transport',async()=>fakeSdk(line(),async calls=>{
 let reservations=0;const options={onRequest:()=>reservations++};
 await assert.rejects(detectBox(png,16,12,{...box,left:-1},options));
 await assert.rejects(detectBox(png,12,16,{left:1,top:1,right:10,bottom:10},options));
 const stop=new AbortController();stop.abort();await assert.rejects(detectBox(png,16,12,box,{...options,signal:stop.signal}));
 assert.equal(calls.length,0);assert.equal(reservations,0);
}));

test('real cache receipts bind a canonical box; snapshot stores returned geometry and replays no noun',async t=>{
 __resetDetectCache();const dir=await fs.mkdtemp(path.join(os.tmpdir(),'construct-box-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const upload={id:'synthetic-box',width:16,height:12,fps:25,frames:200};
 const stillDir=path.join(dir,'uploads',upload.id);await fs.mkdir(stillDir,{recursive:true});await fs.writeFile(path.join(stillDir,'frame_37.png'),png);
 await fakeSdk(line(),async calls=>{
  const args={dataDir:dir,upload,time:1.48,box};
  const first=await runBoxDetect(args),second=await runBoxDetect(args);
  assert.equal(calls.length,1);assert.equal(second.cached,true);assert.equal(first.result.selectionToken,second.result.selectionToken);
  assert.equal(snapshotFromCache(upload,1.48,[1]),null);
  const snapshot=snapshotFromCache(upload,1.48,[1],first.result.selectionToken);
  assert.equal(snapshot.version,2);assert.deepEqual(snapshot.promptBox,box);assert.equal(snapshot.objects[0].label,undefined);
  assert.deepEqual(snapshot.objects[0].box,{left:2/16,top:2/12,right:6/16,bottom:5/12});assert.deepEqual(parseSelectionSnapshot(JSON.stringify(snapshot)),snapshot);
  const changed=await runBoxDetect({...args,box:{...box,left:0}});assert.equal(calls.length,2);
  assert.notEqual(changed.result.selectionToken,first.result.selectionToken);assert.equal(snapshotFromCache(upload,1.48,[1],first.result.selectionToken),null);
  const result=await detectBox(png,16,12,box);
  await runDetect({dataDir:dir,upload,time:1.48,baseConcepts:['synthetic'],_detectObjects:async()=>result});
  assert.equal(snapshotFromCache(upload,1.48,[1],changed.result.selectionToken).version,2,'a noun sweep must not evict a paid visual receipt');
  assert.equal(snapshotFromCache(upload,1.48,[1]).version,1);
  await runBoxDetect({...args,signal:new AbortController().signal});
  assert.equal(snapshotFromCache(upload,1.48,[1],changed.result.selectionToken).version,2,'job replay must not replace a newer client receipt');
 });
 __resetDetectCache();
});

test('different request actors never share a booking callback while the same actor coalesces',async t=>{
 __resetDetectCache();const dir=await fs.mkdtemp(path.join(os.tmpdir(),'construct-box-actors-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const upload={id:'actor-fixture',width:16,height:12,fps:25,frames:200};
 const stillDir=path.join(dir,'uploads',upload.id);await fs.mkdir(stillDir,{recursive:true});await fs.writeFile(path.join(stillDir,'frame_37.png'),png);
 await fakeSdk(line(),async()=>{
  const result=await detectBox(png,16,12,box);let attempts=0,release;
  const held=new Promise(resolve=>{release=resolve;}),bookings=[];
  const args={dataDir:dir,upload,time:1.48,box,_detectBox:async(p,w,h,b,options)=>{options.onRequest?.();attempts++;await held;return structuredClone(result);}};
  const a=runBoxDetect({...args,actorId:'owner',onRequest:()=>bookings.push('owner')});
  const b=runBoxDetect({...args,actorId:'admin',onRequest:()=>bookings.push('admin')});
  release();await Promise.all([a,b]);assert.equal(attempts,2);assert.deepEqual(bookings.sort(),['admin','owner']);
 });
 __resetDetectCache();
});

test('owned 65s deadline aborts a stalled body after HTTP headers, with no second call',async t=>{
 const previous=client.fetch;let dispatched,aborts=0,calls=0;
 const started=new Promise(resolve=>{dispatched=resolve;});
 client.fetch=async(url,init)=>{
  calls++;
  const stream=new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>{aborts++;controller.error(Error('synthetic stream abort'));},{once:true});}});
  dispatched();return new Response(stream,{headers:{'content-type':'text/event-stream'}});
 };
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  const pending=detectBox(png,16,12,box);
  await started;t.mock.timers.tick(65_000);
  await assert.rejects(pending,error=>error.retryable===true);
  assert.equal(calls,1);assert.equal(aborts,1);
 }finally{t.mock.timers.reset();client.fetch=previous;}
});
