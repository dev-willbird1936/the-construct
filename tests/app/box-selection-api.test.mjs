process.env.META_API_KEY='DUMMY';process.env.META_BASE_URL='http://127.0.0.1:1/v1';process.env.META_MODEL_RETRIES='0';
const {test,assert,startApp,api,uploadClip,fakeDetect,waitFor}=await import('./support.js');
const {installGate}=await import('../../backend/app/test-support/fake-gate.js');
const {runBoxDetect,__resetDetectCache}=await import('../../backend/app/detect-cache.js');
const {spendTodayCents}=await import('../../backend/app/db.js');
const {BASIC_CLOCK_TEXT,BASIC_SPAN_TEXT}=await import('../../backend/pipeline/basic/lib/selected-source.mjs');
const previewBox={left:.05,top:.05,right:.75,bottom:.75};
function detector(calls,{failure=false,empty=false}={}){
 return args=>runBoxDetect({...args,_detectBox:async(buffer,w,h,box,options)=>{
  options.onRequest?.();calls.push({w,h,box});
  if(failure)throw Error('synthetic provider failure');
  const result=fakeDetect();
  if(empty){result.objects=[];result._internal.accepted=[];}
  return result;
 }});
}

test('owned explicit box produces v2 receipt; empty/stale/cross-tier enqueue cannot spend',async t=>{
 __resetDetectCache();const calls=[];const handle=await startApp(t,{boxDetectFn:detector(calls)});
 const uploaded=await uploadClip(handle.base);assert.equal(uploaded.status,200);const uploadId=uploaded.json.uploadId;
 const request={uploadId,time:0,box:previewBox};
 const out=await api(handle.base,'POST','/api/detect-box',{body:request});assert.equal(out.status,200);assert.equal(calls.length,1);
 assert.ok(out.json.selectionToken);assert.ok(out.json.framePngBase64);assert.equal(out.json.objects.length,1);
 const spend=spendTodayCents(handle.db,'alice');
 const cached=await api(handle.base,'POST','/api/detect-box',{body:request});assert.equal(cached.status,200);assert.equal(calls.length,1);assert.equal(spendTodayCents(handle.db,'alice'),spend);
 const body={uploadId,tier:'lite',seedTime:0,objectIds:[1],selectionToken:out.json.selectionToken,selectionKind:'box'};
 for(const variant of [{...body,selectionToken:'stale'},{...body,selectionToken:undefined},{...body,objectIds:[]},{...body,tier:'advanced'}]){
  const rejected=await api(handle.base,'POST','/api/jobs',{body:variant});assert.equal(rejected.status,400);
 }
 assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);assert.equal(spendTodayCents(handle.db,'alice'),spend);
 const job=await api(handle.base,'POST','/api/jobs',{body});assert.equal(job.status,200);
 const snapshot=JSON.parse(handle.db.prepare('SELECT selection_snapshot FROM jobs WHERE id=?').get(job.json.jobId).selection_snapshot);
 assert.equal(snapshot.version,2);assert.equal(snapshot.objects[0].label,undefined);
 assert.deepEqual(snapshot.promptBox,{left:6,top:4,right:96,bottom:72});
 assert.deepEqual(snapshot.objects[0].box,{left:.1,top:.1,right:.5,bottom:.5});
 assert.equal((await waitFor(handle.base,job.json.jobId)).status,'done');
 const basic=await api(handle.base,'POST','/api/jobs',{body:{...body,tier:'basic'}});assert.equal(basic.status,200);
 const bs=JSON.parse(handle.db.prepare('SELECT selection_snapshot FROM jobs WHERE id=?').get(basic.json.jobId).selection_snapshot);
 assert.equal(bs.version,2);assert.equal(bs.objects[0].label,undefined);assert.deepEqual(bs.promptBox,snapshot.promptBox);
 assert.equal((await waitFor(handle.base,basic.json.jobId)).status,'done');assert.equal(calls.length,1,'enqueue reuses the receipt, not another image');
});
// Loop 8 (tier-improve 2026-11-04): phone video arrives long and variable-rate.
// A Basic box selection on such a clip enqueues and runs on a proven
// constant-rate cut from the clicked frame (runner-basic); a pick too close
// to the end still refuses before any booking.
test('Basic box: long or variable-rate clips enqueue; a short-forward pick refuses before enqueue booking',async t=>{
 __resetDetectCache();const calls=[];const h=await startApp(t,{boxDetectFn:detector(calls)});
 const up=await uploadClip(h.base);const id=up.json.uploadId;
 const detected=await api(h.base,'POST','/api/detect-box',{body:{uploadId:id,time:0,box:previewBox}});
 const body={uploadId:id,tier:'basic',seedTime:0,objectIds:[1],selectionKind:'box',selectionToken:detected.json.selectionToken};
 for(const [field,value]of [['frames',400],['fps',15]]){
  const before=h.db.prepare(`SELECT ${field} AS value FROM uploads WHERE id=?`).get(id).value;
  h.db.prepare(`UPDATE uploads SET ${field}=? WHERE id=?`).run(value,id);
  const res=await api(h.base,'POST','/api/jobs',{body});assert.equal(res.status,200,`${field}=${value} enqueues`);
  await waitFor(h.base,res.json.jobId);h.db.prepare(`UPDATE uploads SET ${field}=? WHERE id=?`).run(before,id);
 }
 const end=await api(h.base,'POST','/api/detect-box',{body:{uploadId:id,time:1.9,box:previewBox}});
 const beforeEnd=spendTodayCents(h.db,'alice');
 const res=await api(h.base,'POST','/api/jobs',{body:{...body,seedTime:1.9,selectionToken:end.json.selectionToken}});
 assert.equal(res.status,400);assert.equal(res.json.error,BASIC_SPAN_TEXT);assert.equal(spendTodayCents(h.db,'alice'),beforeEnd);
 assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,2);assert.equal(calls.length,2,'only the two explicit image selections');
});
test('a box can be drawn on a clip over 350 frames (size rules still apply)',async t=>{
 __resetDetectCache();const calls=[];const h=await startApp(t,{boxDetectFn:detector(calls)});
 const up=await uploadClip(h.base);const id=up.json.uploadId;
 h.db.prepare('UPDATE uploads SET frames=? WHERE id=?').run(400,id);
 const ok=await api(h.base,'POST','/api/detect-box',{body:{uploadId:id,time:0,box:previewBox}});assert.equal(ok.status,200);
 h.db.prepare('UPDATE uploads SET width=? WHERE id=?').run(1282,id);
 const wide=await api(h.base,'POST','/api/detect-box',{body:{uploadId:id,time:0,box:previewBox}});assert.equal(wide.status,400);assert.match(wide.json.error,/short original clip/);
 assert.equal(calls.length,1);
});

test('authentication, ownership and malformed requests refuse before any box-model attempt',async t=>{
 __resetDetectCache();const calls=[];const handle=await startApp(t,{boxDetectFn:detector(calls),gate:{installGate(app,opts){
  installGate(app,opts);app.use((req,res,next)=>{if(!req.headers['x-test-user'])delete req.user;next();});
 }}});
 const uploaded=await uploadClip(handle.base);const uploadId=uploaded.json.uploadId;
 const unauth=await fetch(handle.base+'/api/detect-box',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uploadId,box:previewBox})});assert.equal(unauth.status,401);
 assert.equal((await api(handle.base,'POST','/api/detect-box',{user:'bob',body:{uploadId,box:previewBox}})).status,404);
 for(const body of [{uploadId,box:{...previewBox,left:-1}},{uploadId,box:previewBox,time:true},{uploadId,box:previewBox,time:100},{uploadId,box:{...previewBox,right:'1'}}])assert.equal((await api(handle.base,'POST','/api/detect-box',{body})).status,400);
 assert.equal(calls.length,0);assert.equal(spendTodayCents(handle.db,'alice'),0);
});
test('failed model attempt reserves one estimated call, never a silent route retry',async t=>{
 __resetDetectCache();const calls=[];const handle=await startApp(t,{boxDetectFn:detector(calls,{failure:true})});
 const uploaded=await uploadClip(handle.base);const uploadId=uploaded.json.uploadId;
 const out=await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box:previewBox}});
 assert.equal(out.status,503);assert.match(out.json.error,/temporarily unavailable/);assert.equal(calls.length,1);assert.ok(spendTodayCents(handle.db,'alice')>0);
 assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
});
test('valid empty box output is HTTP200 but cannot create an automatic fallback job',async t=>{
 __resetDetectCache();const calls=[];const handle=await startApp(t,{boxDetectFn:detector(calls,{empty:true})});
 const uploaded=await uploadClip(handle.base);const uploadId=uploaded.json.uploadId;
 const out=await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box:previewBox}});assert.equal(out.status,200);assert.deepEqual(out.json.objects,[]);
 const job=await api(handle.base,'POST','/api/jobs',{body:{uploadId,tier:'lite',seedTime:0,objectIds:[],selectionToken:out.json.selectionToken}});
 assert.equal(job.status,400);assert.equal(calls.length,1);assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
});
test('ADVANCED_BOX_SELECTION on: one-box Advanced enqueues for the GPU worker with the Basic preflight and image booking',async t=>{
 __resetDetectCache();const calls=[];const h=await startApp(t,{boxDetectFn:detector(calls),configOverrides:{advancedBoxSelection:true}});
 const up=await uploadClip(h.base);const id=up.json.uploadId;
 const detected=await api(h.base,'POST','/api/detect-box',{body:{uploadId:id,time:0,box:previewBox}});assert.equal(detected.status,200);
 const body={uploadId:id,tier:'advanced',seedTime:0,objectIds:[1],selectionKind:'box',selectionToken:detected.json.selectionToken};
 const before=h.db.prepare(`SELECT fps AS value FROM uploads WHERE id=?`).get(id).value;
 h.db.prepare('UPDATE uploads SET fps=? WHERE id=?').run(15,id);
 const clock=await api(h.base,'POST','/api/jobs',{body});assert.equal(clock.status,400);assert.equal(clock.json.error,BASIC_CLOCK_TEXT);
 h.db.prepare('UPDATE uploads SET fps=? WHERE id=?').run(before,id);
 assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
 const imageSpend=()=>h.db.prepare("SELECT COUNT(*) AS n FROM spend WHERE kind='image'").get().n;
 const images=imageSpend();
 const job=await api(h.base,'POST','/api/jobs',{body});assert.equal(job.status,200);
 const row=h.db.prepare('SELECT status,selection_snapshot FROM jobs WHERE id=?').get(job.json.jobId);
 assert.equal(row.status,'queued_gpu');assert.equal(JSON.parse(row.selection_snapshot).version,2);
 assert.equal(imageSpend(),images+1,'v2 Advanced books the Basic image spend');
 assert.equal(calls.length,1,'enqueue reuses the receipt');
});
