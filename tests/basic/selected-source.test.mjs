import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readBasicSelection, writeBasicSelection, validateBasicClock, probeBasicClock, BASIC_HANDOFF_TEXT } from '../../backend/pipeline/basic/lib/selected-source.mjs';
const require=createRequire(new URL('../../backend/package.json',import.meta.url));
const sharp=require('sharp');
async function fixture(){
  const dir=await fs.mkdtemp('/tmp/the-construct/main/basic-handoff-test-'),videoPath=path.join(dir,'synthetic.mp4');
  await fs.writeFile(videoPath,'synthetic original bytes, no model');
  const mask=new Uint8Array(192);for(let y=2;y<5;y++)for(let x=2;x<6;x++)mask[y*16+x]=1;
  const input={outDir:dir,videoPath,width:16,height:12,fps:25,frames:50,seedFrameIndex:37,promptBox:{left:1,top:1,right:8,bottom:7},chosenBox:{left:2,top:2,right:6,bottom:5},chosenMask:mask};
  const info={width:16,height:12,fps:25,frameCount:50};
  await writeBasicSelection(input);
  return{dir,input,info,json:path.join(dir,'.selection/seed.json'),mask:path.join(dir,'.selection/mask.png')};
}
test('fixed private handoff roundtrips exact original bytes/frame/raster and binary mask',async()=>{
  const f=await fixture(),got=await readBasicSelection(f.dir,f.input.videoPath,f.info);
  assert.equal(got.seedFrameIndex,37);assert.equal(got.fps,25);assert.deepEqual(got.chosenMask,f.input.chosenMask);
  assert.deepEqual(got.promptBox,f.input.promptBox);assert.deepEqual(got.chosenBox,f.input.chosenBox);
  await assert.rejects(writeBasicSelection(f.input));
  assert.deepEqual((await readBasicSelection(f.dir,f.input.videoPath,f.info)).chosenMask,got.chosenMask);
});
for(const [name,patch]of [['source SHA',{sourceSha256:'0'.repeat(64)}],['mask SHA',{maskSha256:'0'.repeat(64)}],['native frame',{seedFrameIndex:50}],['native dimensions',{width:18}],['native FPS',{fps:15}],['source frame count',{frames:51}],['prompt geometry',{promptBox:{left:-1,top:0,right:4,bottom:4}}],['version',{version:2}],['unexpected source path',{videoPath:'not-an-owned-path'}],['unexpected output path',{outDir:'not-an-owned-directory'}]])test(`${name} drift refuses handoff`,async()=>{
  const f=await fixture(),data=JSON.parse(await fs.readFile(f.json));await fs.writeFile(f.json,JSON.stringify({...data,...patch}));
  await assert.rejects(readBasicSelection(f.dir,f.input.videoPath,f.info),e=>e.message===BASIC_HANDOFF_TEXT);
});
test('changed original bytes and damaged mask refuse without any provider',async()=>{
  const f=await fixture();await fs.appendFile(f.input.videoPath,'changed');
  await assert.rejects(readBasicSelection(f.dir,f.input.videoPath,f.info));
  const g=await fixture();await fs.writeFile(g.mask,'not a PNG');await assert.rejects(readBasicSelection(g.dir,g.input.videoPath,g.info));
});
test('transparent/greyscale interpolation is not silently certified binary',async()=>{
  const f=await fixture();
  const invalid=await sharp({create:{width:16,height:12,channels:4,background:{r:255,g:255,b:255,alpha:.5}}}).png().toBuffer();
  const {createHash}=await import('node:crypto');await fs.writeFile(f.mask,invalid);
  const data=JSON.parse(await fs.readFile(f.json));data.maskSha256=createHash('sha256').update(invalid).digest('hex');await fs.writeFile(f.json,JSON.stringify(data));
  await assert.rejects(readBasicSelection(f.dir,f.input.videoPath,f.info));
});
test('constant-rate clock counts all decoded timestamps and normalizes frame-zero origin',()=>{
  const times=Array.from({length:50},(_,i)=>(2+i/25).toFixed(6));
  assert.deepEqual(validateBasicClock(times,25,50),{kind:'cfr',fps:25,frames:50,indexDomain:'source-frame',timeOrigin:'decode-frame-zero'});
  const drift=[...times];drift[37]='3.490000';assert.throws(()=>validateBasicClock(drift,25,50));
  for(const bad of [times.slice(1),times.concat('4.000000'),times.map((v,i)=>i===37?'N/A':v)])assert.throws(()=>validateBasicClock(bad,25,50));
});
