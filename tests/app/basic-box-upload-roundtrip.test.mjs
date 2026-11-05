import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, assert, startApp, uploadClip, api, waitFor, headers } from './support.js';
import { probeVideo } from '../../backend/lib/ffmpeg.js';
import { writeBasicSelection, readBasicSelection, probeBasicClock } from '../../backend/pipeline/basic/lib/selected-source.mjs';
const run=promisify(execFile);

test('real upload/SQLite metadata and real CLI probe agree on the 50-frame handoff; private seed stays unserved',async(t)=>{
 const h=await startApp(t);
 const directFetch=globalThis.fetch;
 t.mock.method(globalThis,'fetch',(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url);
  assert.equal(url.origin,h.base,'only this test-owned origin, never proxy/provider');
  return directFetch(input,{...init,redirect:'error'});
 });
 const dir=await fs.mkdtemp('/tmp/the-construct/main/basic-real-upload-test-');
 const file=path.join(dir,'synthetic.mp4');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=25:duration=2','-c:v','libx264','-pix_fmt','yuv420p',file],{timeout:20000});
 console.log('synthetic 50-frame clip ready');
 const up=await uploadClip(h.base,{clip:file});assert.equal(up.status,200);
 console.log('real upload handler completed');
 const row=h.db.prepare('SELECT * FROM uploads WHERE id=?').get(up.json.uploadId);
 assert.equal(row.fps,25);assert.equal(row.frames,50);
 const videoPath=path.join(h.dataDir,'uploads',row.id,'source.mp4');
 const info=await probeVideo(videoPath);
 assert.equal(info.fps,row.fps);assert.equal(info.frameCount,row.frames);
 assert.equal((await probeBasicClock(videoPath,row.fps,row.frames)).frames,50);
 console.log('real probe and counted clock agree');
 const created=await api(h.base,'POST','/api/jobs',{body:{uploadId:row.id,tier:'basic',prompt:'synthetic test subject'}});
 assert.equal(created.status,200);assert.equal((await waitFor(h.base,created.json.jobId)).status,'done');
 console.log('stub Basic job finished');
 const reserved=h.db.prepare("SELECT units FROM spend WHERE ref=? AND kind='job'").get(created.json.jobId);
 assert.equal(reserved.units,50,'existing Basic enqueue books native source frames; not provider billing proof');
 const outDir=path.join(h.dataDir,'specimens',created.json.jobId);
 const mask=new Uint8Array(row.width*row.height);for(let y=20;y<40;y++)for(let x=20;x<40;x++)mask[y*row.width+x]=1;
 await writeBasicSelection({outDir,videoPath,width:row.width,height:row.height,fps:row.fps,frames:row.frames,seedFrameIndex:37,promptBox:{left:10,top:10,right:50,bottom:50},chosenBox:{left:20,top:20,right:40,bottom:40},chosenMask:mask});
 const read=await readBasicSelection(outDir,videoPath,info);
 assert.equal(read.seedFrameIndex,37);assert.deepEqual(read.chosenMask,mask);
 console.log('handoff roundtrip completed');
 const get=p=>fetch(h.base+p,{headers:headers('alice'),redirect:'error'});
 assert.equal((await get(`/specimens/${created.json.jobId}/meta.json`)).status,200,'owner can read the ordinary result');
 for(const suffix of ['.selection/seed.json','.selection/mask.png','%2eselection/seed.json','.work/selected-track/owned-upload.json']){
  const response=await get(`/specimens/${created.json.jobId}/${suffix}`);assert.equal(response.status,404,suffix);
 }
});
