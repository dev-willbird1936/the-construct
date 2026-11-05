import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require=createRequire(new URL('../../backend/package.json',import.meta.url));
const OpenAI=require('openai');
const root=n=>new URL('../../backend/lib/'+n,import.meta.url).href;
const text='<37f>1<|box;x1=2;y1=2;x2=5;y2=4;w=16;h=12|><|mask;x=0;y=0;data=3,4,!!!!!\'y7K#I-=|>\n';

for(const status of [200,404,500,'stalled-body','stalled-upload','user-abort'])test(`actual SDK selected native ${status}: bounded fake transport, original File bytes and owned delete`,async(t)=>{
  const control=new AbortController();
  if(status==='stalled-body'||status==='stalled-upload') {
    const timeout=AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal,'timeout',ms=>timeout(ms===(status==='stalled-upload'?25000:120000)?25:ms));
  }
  const dir=await fs.mkdtemp('/tmp/the-construct/main/basic-native-sdk-test-');
  const videoPath=path.join(dir,'owned.mp4'),bytes=Buffer.from('SYNTHETIC_SOURCE_BYTES_NO_MEDIA');
  await fs.writeFile(videoPath,bytes);
  const deps=`export {default} from ${JSON.stringify(pathToFileURL(require.resolve('sharp')).href)};
export {parseTrackedVideo} from ${JSON.stringify(root('sam-image-result.mjs'))};
export {makeVideoSeed,VIDEO_SEED_NO_MATCH} from ${JSON.stringify(root('sam-video-seed.mjs'))};
export {requireSelectedMask,selectedVideoCandidates} from ${JSON.stringify(root('selected-video-result.mjs'))};
export {upscaleMask} from ${JSON.stringify(root('compose.js'))};
export {throwIfCancelled,cancelledError} from ${JSON.stringify(root('cancel.js'))};
export const client={files:{},responses:{}};`;
  await fs.writeFile(path.join(dir,'deps.mjs'),deps);
  await fs.writeFile(path.join(dir,'track.mjs'),(await fs.readFile(new URL('../../backend/lib/track-selected.js',import.meta.url),'utf8')).replace(/from ['"](?!node:)[^'"]+['"]/g,'from "./deps.mjs"'));
  const dep=await import(pathToFileURL(path.join(dir,'deps.mjs'))),mod=await import(pathToFileURL(path.join(dir,'track.mjs')));
  const seen=[];
  const sdk=new OpenAI({apiKey:'DUMMY',baseURL:'http://127.0.0.1:1/v1',organization:null,project:null,maxRetries:3,fetch:async(url,init)=>{
    const u=new URL(String(url));assert.equal(u.origin,'http://127.0.0.1:1');
    const key=init.method+' '+u.pathname;
    assert.ok(['POST /v1/files','POST /v1/responses','DELETE /v1/files/owned'].includes(key));
    assert.equal(seen.includes(key),false,'no duplicate dispatches');seen.push(key);
    const headers={'Content-Type':'application/json'};
    if(key==='POST /v1/files'){
      if(status==='stalled-upload')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
      const chunks=[];for await(const chunk of init.body)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      assert.ok(Buffer.concat(chunks).includes(bytes),'actual multipart contains exactly the pinned synthetic source bytes');
      return new Response(JSON.stringify({id:'owned',object:'file',purpose:'user_data'}),{status:200,headers});
    }
    if(key==='DELETE /v1/files/owned')return new Response(JSON.stringify({id:'owned',object:'file',deleted:true}),{status:200,headers});
    const body=JSON.parse(init.body);assert.equal(body.input[0].content[0].text.startsWith('<37f>1<|box;'),true);
    assert.equal(body.input[0].content[1].file_id,'owned');
    assert.deepEqual(body.metadata,{propagation_direction:'forward'});
    if(status==='stalled-body'||status==='user-abort') {
      if(status==='user-abort')setTimeout(()=>control.abort(),25);
      return new Response(new ReadableStream({start(controller){
        init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});
      }}),{status:200,headers:{'Content-Type':'text/event-stream'}});
    }
    if(status!==200)return new Response(JSON.stringify({error:{message:'synthetic provider failure',type:'server_error'}}),{status,headers});
    const events=[{type:'response.output_text.done',item_id:'synthetic',output_index:0,content_index:0,text},{type:'response.completed'}];
    return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
  }});
  dep.client.files.create=sdk.files.create.bind(sdk.files);dep.client.files.del=sdk.files.del.bind(sdk.files);dep.client.responses.create=sdk.responses.create.bind(sdk.responses);
  const chosenMask=new Uint8Array(192);for(let y=2;y<5;y++)for(let x=2;x<6;x++)chosenMask[y*16+x]=1;
  const input={videoPath,sourceSha256:createHash('sha256').update(bytes).digest('hex'),outDir:path.join(dir,'track'),width:16,height:12,fps:25,frames:200,seedFrameIndex:37,chosenBox:{left:2,top:2,right:6,bottom:5},chosenMask,signal:control.signal};
  const stalled=typeof status==='string';
  const keepAlive=stalled?setTimeout(()=>{},1500):null;
  try {
    if(status===200)assert.equal((await mod.trackSelectedInstance(input)).tracks[0].first,37);
    else await assert.rejects(mod.trackSelectedInstance(input),error=>{
      if(status==='stalled-body'||status==='stalled-upload'){assert.equal(error.code,'SELECTED_TRACK_TIMEOUT');assert.equal(error.retryable,false);}
      if(status==='user-abort')assert.equal(error.code,'APP_SHUTDOWN');
      return true;
    });
  } finally { if(keepAlive)clearTimeout(keepAlive); }
  assert.deepEqual(seen,status==='stalled-upload'?['POST /v1/files']:['POST /v1/files','POST /v1/responses','DELETE /v1/files/owned']);
  const stats=JSON.parse(await fs.readFile(path.join(input.outDir,'attempt.json')));
  assert.equal(stats.cleanup,status==='stalled-upload'?'ownership-unknown':'confirmed');
  if(status==='stalled-body'||status==='stalled-upload')assert.equal(stats.timedOut,status==='stalled-upload'?'upload':'stream');
});
