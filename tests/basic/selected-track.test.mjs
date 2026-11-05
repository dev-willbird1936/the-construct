import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const root = name => new URL('../../backend/lib/' + name, import.meta.url).href;
const line = (n, id = '1') => `<${n}f>${id}<|box;x1=2;y1=2;x2=5;y2=4;w=16;h=12|><|mask;x=0;y=0;data=3,4,!!!!!'y7K#I-=|>\n`;

async function fixture(text = Array.from({ length: 6 }, (_, i) => line(37 + i)).join(''), mode = '') {
  const dir = await fs.mkdtemp('/tmp/the-construct/main/basic-selected-source-test-');
  const videoPath = path.join(dir, 'owned-original.mp4');
  await fs.writeFile(videoPath, 'synthetic source bytes, not a real video');
  const bytes = await fs.readFile(videoPath);
  const deps = `
export {default} from ${JSON.stringify(pathToFileURL(require.resolve('sharp')).href)};
export {parseTrackedVideo} from ${JSON.stringify(root('sam-image-result.mjs'))};
export {makeVideoSeed,VIDEO_SEED_NO_MATCH} from ${JSON.stringify(root('sam-video-seed.mjs'))};
export {requireSelectedMask,selectedVideoCandidates} from ${JSON.stringify(root('selected-video-result.mjs'))};
export {upscaleMask} from ${JSON.stringify(root('compose.js'))};
export {throwIfCancelled,cancelledError} from ${JSON.stringify(root('cancel.js'))};
export const calls=[];
export const client={files:{async create(body,options){calls.push({kind:'upload',options,bytes:Buffer.from(await body.file.arrayBuffer())});if(${JSON.stringify(mode)}==='uploadfail')throw Error('synthetic upload failure');return ${JSON.stringify(mode)}==='upload-no-id'?{}:{id:'owned'};},async del(id,options){calls.push({kind:'delete',id,options});if(${JSON.stringify(mode)}==='deletefail')throw Error('synthetic delete failure');return{deleted:${JSON.stringify(mode)}!=='delete-unconfirmed'};}},responses:{async create(body,options){calls.push({kind:'video',body,options});if(${JSON.stringify(mode)}==='videofail')throw Error('synthetic video failure');return(async function*(){yield{type:'response.output_text.done',item_id:'synthetic',output_index:0,content_index:0,text:${JSON.stringify(text)}};yield{type:'response.completed'};})();}}};
`;
  await fs.writeFile(path.join(dir, 'deps.mjs'), deps);
  const source = (await fs.readFile(new URL('../../backend/lib/track-selected.js', import.meta.url), 'utf8')).replace(/from ['"](?!node:)[^'"]+['"]/g, 'from "./deps.mjs"');
  await fs.writeFile(path.join(dir, 'track.mjs'), source);
  const module = await import(pathToFileURL(path.join(dir, 'track.mjs')));
  const dep = await import(pathToFileURL(path.join(dir, 'deps.mjs')));
  const chosenMask = new Uint8Array(16 * 12);
  for (let y=2;y<5;y++)for(let x=2;x<6;x++)chosenMask[y*16+x]=1;
  return { module, dep, input: { videoPath, sourceSha256: createHash('sha256').update(bytes).digest('hex'), outDir: path.join(dir, 'track'), width:16,height:12,fps:25,frames:200,seedFrameIndex:37,chosenBox:{left:2,top:2,right:6,bottom:5},chosenMask }, bytes };
}

test('actual selected tracker source uses original bytes/native indices, real parser and PNG labels', async () => {
  const {module,dep,input,bytes}=await fixture();
  const result=await module.trackSelectedInstance(input);
  assert.deepEqual(dep.calls.map(c=>c.kind),['upload','video','delete']);
  assert.deepEqual(dep.calls[0].bytes,bytes);
  assert.ok(dep.calls.every(c=>c.options.maxRetries===0));
  assert.equal(dep.calls[1].body.input[0].content[0].text,'<37f>1<|box;x1=2;y1=2;x2=5;y2=4;w=16;h=12|>');
  assert.deepEqual(dep.calls[1].body.metadata,{propagation_direction:'forward'});
  assert.equal(result.fps,25);assert.equal(result.indexDomain,'source-frame');
  assert.deepEqual(result.observedFrames,[37,38,39,40,41,42]);
  assert.deepEqual(result.processedRange,{first:37,last:199});
  assert.deepEqual(result.unprocessedFrames,Array.from({length:37},(_,i)=>i));
  assert.equal(result.unverifiedFrames.length,157);
  assert.deepEqual(result.tracks,[{id:1,first:37,last:42,frames:6}]);
  const sharp=require('sharp');
  const {data,info}=await sharp(path.join(input.outDir,'labels/l00037.png')).extractChannel(0).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,16);assert.equal(info.height,12);assert.equal(data.reduce((a,b)=>a+b,0),12);
  await assert.rejects(fs.stat(path.join(input.outDir,'labels/l00036.png')));
  const stats=JSON.parse(await fs.readFile(path.join(input.outDir,'attempt.json')));assert.equal(stats.cleanup,'confirmed');
  assert.ok((await fs.readFile(path.join(input.outDir,'segmentation-result.json'),'utf8')).includes('<37f>'));
});
for(const [name,text] of [['wrong id',line(37,'9')],['preseed',line(36)+line(37)],['missing seed',line(38)],['raster mismatch',line(37).replace('w=16','w=8')],['invalid stream','unexpected text']]) {
  test(`selected ${name} preserves paid evidence and cleans once before refusing labels`,async()=>{
    const {module,dep,input}=await fixture(text);
    await assert.rejects(module.trackSelectedInstance(input));
    assert.deepEqual(dep.calls.map(c=>c.kind),['upload','video','delete']);
    assert.equal((await fs.readdir(path.join(input.outDir,'labels'))).length,0);
    assert.ok((await fs.readFile(path.join(input.outDir,'segmentation-events.jsonl'),'utf8')).includes('output_text'));
    assert.equal(JSON.parse(await fs.readFile(path.join(input.outDir,'attempt.json'))).cleanup,'confirmed');
  });
}
for(const mode of ['uploadfail','upload-no-id','videofail','deletefail','delete-unconfirmed'])test(`${mode} dispatches no retry and keeps attempt receipt`,async()=>{
  const {module,dep,input}=await fixture(undefined,mode);
  await assert.rejects(module.trackSelectedInstance(input));
  assert.deepEqual(dep.calls.map(c=>c.kind),mode.startsWith('upload')?['upload']:['upload','video','delete']);
  assert.equal((await fs.readdir(path.join(input.outDir,'labels'))).length,0);
  const stats=JSON.parse(await fs.readFile(path.join(input.outDir,'attempt.json')));
  assert.equal(stats.cleanup,mode.startsWith('upload')?'ownership-unknown':mode==='deletefail'?'failed':mode==='delete-unconfirmed'?'unconfirmed':'confirmed');
});
test('source mismatch, empty mask, unsupported geometry and cancellation refuse before upload',async()=>{
  const {module,dep,input}=await fixture();const control=new AbortController();control.abort();
  for(const patch of [{sourceSha256:'0'.repeat(64)},{chosenMask:new Uint8Array(192)},{frames:351},{signal:control.signal}])await assert.rejects(module.trackSelectedInstance({...input,...patch}));
  assert.equal(dep.calls.length,0);await assert.rejects(fs.stat(input.outDir));
});
test('occupied output directory refuses without overwriting prior evidence or paying',async()=>{
  const {module,dep,input}=await fixture();await fs.mkdir(input.outDir);await fs.writeFile(path.join(input.outDir,'prior'),'retained');
  await assert.rejects(module.trackSelectedInstance(input));assert.equal(dep.calls.length,0);
  assert.equal(await fs.readFile(path.join(input.outDir,'prior'),'utf8'),'retained');
});
