process.env.META_API_KEY='DUMMY';process.env.META_BASE_URL='http://127.0.0.1:1/v1';process.env.META_MODEL_RETRIES='0';
const {test,assert,startApp,api,uploadClip}=await import('./support.js');

// POST /api/lite/prewarm: Lite early upload of the SAM cut. Owner-only,
// validated, kill-switch gated, fire-and-forget (202); nothing is booked.
test('lite prewarm accepts the owner\'s frame and refuses bad frames, strangers and the kill switch',async t=>{
  const handle=await startApp(t);
  const {json:{uploadId}}=await uploadClip(handle.base);
  assert.equal((await api(handle.base,'POST','/api/lite/prewarm',{body:{uploadId,time:0.5}})).status,202);
  for(const time of [-1,99,'0.5',null]) assert.equal((await api(handle.base,'POST','/api/lite/prewarm',{body:{uploadId,time}})).status,400,String(time));
  assert.equal((await api(handle.base,'POST','/api/lite/prewarm',{user:'mallory',body:{uploadId,time:0.5}})).status,404);
  await api(handle.base,'POST','/api/admin/kill',{role:'owner',body:{enabled:true}});
  assert.equal((await api(handle.base,'POST','/api/lite/prewarm',{body:{uploadId,time:0.5}})).status,503);
});
