process.env.META_API_KEY='DUMMY';process.env.META_BASE_URL='http://127.0.0.1:1/v1';process.env.META_MODEL_RETRIES='0';
const {test,assert,startApp,api,uploadClip,fakeDetect,waitFor,seedSelectionCache}=await import('./support.js');
const {runBoxDetect,__resetDetectCache}=await import('../../backend/app/detect-cache.js');
const {spendTodayCents}=await import('../../backend/app/db.js');
const {BOX_SELECTION_NO_MATCH}=await import('../../backend/lib/sam-image-result.mjs');
const {IMAGE_FRAME_CHANGED}=await import('../../backend/lib/sam-image-seed.mjs');
const box={left:.1,top:.1,right:.7,bottom:.7};
function controlled(calls){return args=>runBoxDetect({...args,_detectBox:async(png,w,h,pixels,options)=>{options.onRequest?.();calls.push(pixels);return fakeDetect();}});}

test('kill switch and rate limit refuse before another visual model attempt',async t=>{
 __resetDetectCache();const calls=[];const handle=await startApp(t,{boxDetectFn:controlled(calls),configOverrides:{rateJobsPerMin:1}});
 const {json:{uploadId}}=await uploadClip(handle.base);
 await api(handle.base,'POST','/api/admin/kill',{role:'owner',body:{enabled:true}});
 assert.equal((await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box}})).status,503);assert.equal(calls.length,0);
 await api(handle.base,'POST','/api/admin/kill',{role:'owner',body:{enabled:false}});
 assert.equal((await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box}})).status,200);
 assert.equal((await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box}})).status,429);assert.equal(calls.length,1);
});
test('cached boxes are free at the exact daily cap; an uncached box refuses inside onRequest',async t=>{
 __resetDetectCache();const calls=[];const handle=await startApp(t,{boxDetectFn:controlled(calls),configOverrides:{maxUserCentsDay:1}});
 const {json:{uploadId}}=await uploadClip(handle.base);
 const first=await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box}});assert.equal(first.status,200);
 const cached=await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box}});assert.equal(cached.status,200);assert.equal(cached.json.selectionToken,first.json.selectionToken);
 const blocked=await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box:{...box,right:.8}}});
 assert.equal(blocked.status,429);assert.equal(calls.length,1);assert.equal(spendTodayCents(handle.db,'alice'),1);
});
for(const [message,status] of [[BOX_SELECTION_NO_MATCH,502],[IMAGE_FRAME_CHANGED,409]])test('HTTP box domain errors preserve only exact safe actionable message '+status,async t=>{
 const handle=await startApp(t,{boxDetectFn:async()=>{throw Error(message);}});
 const {json:{uploadId}}=await uploadClip(handle.base);
 const out=await api(handle.base,'POST','/api/detect-box',{body:{uploadId,box}});assert.equal(out.status,status);assert.equal(out.json.error,message);
});
test('unsupported explicit Lite selections refuse at enqueue before estimated job spend',async t=>{
 __resetDetectCache();const handle=await startApp(t);const {json:{uploadId}}=await uploadClip(handle.base);
 await seedSelectionCache(handle,uploadId);
 // Over 350 frames alone is no longer a refusal (Lite tracks a proven strided cut
 // from the seed); the size rules still refuse at enqueue for any length.
 for(const values of [[351,1282,96],[20,1282,96],[20,128,97],[600,128,97]]){
  handle.db.prepare('UPDATE uploads SET frames=?,width=?,height=? WHERE id=?').run(...values,uploadId);
  const out=await api(handle.base,'POST','/api/jobs',{body:{uploadId,tier:'lite',seedTime:0,objectIds:[1]}});
  assert.equal(out.status,400);assert.match(out.json.error,/short original clip/);assert.equal(spendTodayCents(handle.db,'alice'),0);
 }
 assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
 const automatic=await api(handle.base,'POST','/api/jobs',{body:{uploadId,tier:'lite',objectIds:[]}});
 assert.equal(automatic.status,200);await waitFor(handle.base,automatic.json.jobId);
});

test('two in-flight identical HTTP box picks share one reserved attempt and one receipt',async t=>{
 __resetDetectCache();let entries=0,attempts=0,beginBoth,release;
 const both=new Promise(resolve=>{beginBoth=resolve;}),held=new Promise(resolve=>{release=resolve;});
 const handle=await startApp(t,{configOverrides:{maxUserCentsDay:1},boxDetectFn:args=>{
  if(++entries===2)beginBoth();
  return runBoxDetect({...args,_detectBox:async(png,w,h,pixels,options)=>{options.onRequest?.();attempts++;await held;return fakeDetect();}});
 }});
 const {json:{uploadId}}=await uploadClip(handle.base);
 const first=api(handle.base,'POST','/api/detect-box',{body:{uploadId,box}});
 const second=api(handle.base,'POST','/api/detect-box',{body:{uploadId,box}});
 await both;release();
 const [a,b]=await Promise.all([first,second]);assert.equal(a.status,200);assert.equal(b.status,200);
 assert.equal(attempts,1);assert.equal(a.json.selectionToken,b.json.selectionToken);assert.equal(a.json.framePngBase64,b.json.framePngBase64);assert.equal(spendTodayCents(handle.db,'alice'),1);
});

for(const message of [BOX_SELECTION_NO_MATCH,IMAGE_FRAME_CHANGED])test('runner domain error stays actionable without widening safe regex: '+message,async t=>{
 const handle=await startApp(t,{runners:{lite:async()=>{throw Error(message);}}});
 const {json:{uploadId}}=await uploadClip(handle.base);
 const job=await api(handle.base,'POST','/api/jobs',{body:{uploadId,tier:'lite',objectIds:[]}});assert.equal(job.status,200);
 const result=await waitFor(handle.base,job.json.jobId);assert.equal(result.status,'failed');assert.equal(result.error,message);
});
