import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const atlasUrl=new URL('../../backend/app/atlas.js',import.meta.url);
const requireBackend=createRequire(atlasUrl);
const sharp=requireBackend('sharp');
// Real production module and real Sharp pixels. Only delay completion of
// explicitly tagged input crops; no fake SDK, selector, encoder or model.
let source=await fs.readFile(atlasUrl,'utf8');
source=source.replace('import sharp from "sharp";',`import realSharp from ${JSON.stringify(pathToFileURL(requireBackend.resolve('sharp')).href)};
export const cropCompletions=[];
const sharp=(input,options)=>{
 const p=realSharp(input,options);
 if(!Number.isInteger(input?.testSlot))return p;
 let cropped=false;
 const extract=p.extract.bind(p),toBuffer=p.toBuffer.bind(p);
 p.extract=(...args)=>{cropped=true;return extract(...args)};
 p.toBuffer=async(...args)=>{
  const result=await toBuffer(...args);
  if(cropped){await new Promise(resolve=>setTimeout(resolve,(4-input.testSlot)*60));cropCompletions.push(input.testSlot)}
  return result;
 };
 return p;
};`);
for(const name of ['lite-pose.js','lite-frame.js'])source=source.replace(`from "./${name}"`,`from ${JSON.stringify(new URL(name,atlasUrl).href)}`);
const delayed=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const shapes=[{x:2,y:5,w:30,h:24,luma:45},{x:47,y:22,w:16,h:50,luma:95},{x:100,y:30,w:38,h:32,luma:160},{x:175,y:65,w:22,h:54,luma:220}];
async function frames(){
 const out=[];
 for(let i=0;i<shapes.length;i++){
  const b=shapes[i],data=Buffer.alloc(240*128*4);
  for(let y=b.y;y<b.y+b.h;y++)for(let x=b.x;x<b.x+b.w;x++){
   const o=(y*240+x)*4;data[o]=data[o+1]=data[o+2]=b.luma;data[o+3]=255;
  }
  const buffer=await sharp(data,{raw:{width:240,height:128,channels:4}}).png().toBuffer();
  buffer.testSlot=i;
  out.push({buffer,timestamp:i,sourceFrameIndex:i,concept:'software order fixture'});
 }
 return out;
}
for(const preserveAlpha of [false,true])test(`per-pose metadata follows cells, not async completion (preserveAlpha=${preserveAlpha})`,async()=>{
 delayed.cropCompletions.length=0;
 const packed=await delayed.packChronoAtlas(await frames(),{cell:32,maxPoses:4,liveCount:2,preserveAlpha});
 assert.ok(packed.poses.length>=3,'exercise several selected cells and possible live tail');
 assert.notDeepEqual(delayed.cropCompletions,[...delayed.cropCompletions].sort((a,b)=>a-b),'crop completions deliberately out of source order');
 assert.equal(packed.anchors.length,packed.poses.length);
 assert.equal(packed.exposure.length,packed.poses.length,'live cells must not append per-pose metadata');
 for(const [n,i] of packed.poses.entries()){
  const b=shapes[i],left=Math.max(0,b.x-2),top=Math.max(0,b.y-2);
  const w=Math.min(240-left,b.w+4),h=Math.min(128-top,b.h+4),s=Math.min(packed.cellW/w,packed.cellH/h);
  const dw=Math.max(1,Math.round(w*s)),dh=Math.max(1,Math.round(h*s));
  const ox=Math.round((packed.cellW-dw)/2),oy=Math.round((packed.cellH-dh)/2);
  assert.deepEqual(packed.anchors[n],{top:oy/packed.cellH,bottom:Math.min(1,(oy+dh)/packed.cellH),left:ox/packed.cellW,right:Math.min(1,(ox+dw)/packed.cellW)},`anchor for source ${i}`);
  assert.deepEqual(packed.exposure[n],{gamma:1,median:Math.round(b.luma/255*1000)/1000},`exposure for source ${i}`);
  assert.equal(packed.kept[n].timestamp,i);
  assert.equal(packed.kept[n].sourceFrameIndex,i);
 }
});
