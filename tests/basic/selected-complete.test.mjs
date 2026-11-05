// Full production main orchestration, with explicit FAKE model/Python boundaries.
// Actual source bytes, ffprobe/FFmpeg, native-label scaling, atlases and JSON run.
// These fixtures are NOT real SAM/depth/plate QA or generated-quality evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import * as keys from '../../backend/pipeline/basic/lib/keyframes.mjs';
import * as atlas from '../../backend/pipeline/basic/lib/atlas.mjs';
import * as grade from '../../backend/pipeline/basic/lib/grade.mjs';
import { writeBasicSelection, readBasicSelection, probeBasicClock, BASIC_HANDOFF_TEXT, BASIC_CLOCK_TEXT, BASIC_MASK_TEXT } from '../../backend/pipeline/basic/lib/selected-source.mjs';
const require=createRequire(new URL('../../backend/package.json',import.meta.url));
const sharp=require('sharp'),exec=promisify(execFile);
const BIN='local-models/tools/kdenlive/26.04.3/kdenlive-26.04.3_standalone/bin/';
const source=(await fsp.readFile(new URL('../../backend/pipeline/basic/run-basic.mjs',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const parser=source.slice(source.indexOf('function parseArgs('),source.indexOf('\nasync function proxyUsage'));
const maskStats=source.slice(source.indexOf('export async function maskStatsUnion('),source.indexOf('\nexport function erodeAlpha')).replace('export ','');
const gates=source.slice(source.indexOf('export const IMAGE_BUDGET'),source.indexOf('// One booked repair of')).replaceAll('export ','');
const mainSource=source.slice(source.indexOf('async function main() {'),source.indexOf('// Importable for unit tests'));
const forbid=()=>{throw Error('unexpected model/network/legacy/refinement boundary');};

function npy(w,h) {
  const text=`{'descr': '<f4', 'fortran_order': False, 'shape': (${h}, ${w}), }`;
  const header=text+' '.repeat((16-(10+text.length+1)%16)%16)+'\n';
  const out=Buffer.alloc(10+header.length+w*h*4);
  Buffer.from([0x93,0x4e,0x55,0x4d,0x50,0x59,1,0]).copy(out);
  out.writeUInt16LE(header.length,8);out.write(header,10,'latin1');
  for(let p=0;p<w*h;p++)out.writeFloatLE(1+(p%w)/w,10+header.length+p*4);
  return out;
}

test('selected main completes native-clock assets and preserves downstream refusals (FAKE models)',async(t)=>{
  const dir=await fsp.mkdtemp('/tmp/the-construct/main/basic-native-complete-SYNTHETIC-');
  await fsp.writeFile(path.join(dir,'TEST_STUB_EVIDENCE.json'),JSON.stringify({kind:'SYNTHETIC orchestration test ONLY',fake:['SAM tracking','Python plate QA','depth inference/fit','Muse edit','behind'],real:['source video','ffprobe clock','FFmpeg native RGB','sharp atlas','production main JSON'],notQualityProof:true}));
  const framesDir=path.join(dir,'input');await fsp.mkdir(framesDir);
  for(let n=0;n<50;n++)await sharp({create:{width:16,height:12,channels:3,background:{r:20+n,g:50,b:80}}}).png().toFile(path.join(framesDir,`f${String(n).padStart(3,'0')}.png`));
  const video=path.join(dir,'synthetic.mp4');
  await exec(BIN+'ffmpeg.exe',['-v','error','-framerate','25','-i',path.join(framesDir,'f%03d.png'),'-c:v','libx264rgb','-crf','0','-pix_fmt','rgb24',video],{timeout:20000});
  const old=process.env.FFPROBE_PATH;process.env.FFPROBE_PATH=BIN+'ffprobe.exe';
  t.after(()=>{if(old===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=old;});
  const {probeVideo}=await import('../../backend/lib/ffmpeg.js?selected-complete-real-probe');
  const model=path.join(dir,'inert.onnx'),python=path.join(dir,'inert-python');
  await fsp.writeFile(model,'NOT A MODEL');await fsp.writeFile(python,'NOT EXECUTABLE');
  const chosenMask=new Uint8Array(192);for(let y=2;y<5;y++)for(let x=2;x<6;x++)chosenMask[y*16+x]=1;

  async function scenario(name,{badGate=false,overGate=false,badDepth=false,badPlateDepth=false}={}) {
    const outDir=path.join(dir,name);await fsp.mkdir(outDir);
    await writeBasicSelection({outDir,videoPath:video,width:16,height:12,fps:25,frames:50,seedFrameIndex:37,promptBox:{left:1,top:1,right:8,bottom:7},chosenBox:{left:2,top:2,right:6,bottom:5},chosenMask});
    const work=path.join(outDir,'.work'),calls=[];
    const context={...keys,...atlas,...grade,BASIC_HANDOFF_TEXT,BASIC_CLOCK_TEXT,BASIC_MASK_TEXT,fs,fsp,path,crypto,sharp,Buffer,Uint8Array,Float32Array,Set,Map,Number,Math,JSON,SAMPLE_FPS:15,TRACK_CONCEPT_MAX:60,
      MODEL:model,VENV_PY:python,MODELS_DIR:dir,META:{nodeEnv:'test',baseUrl:'http://127.0.0.1:1',apiKey:'DUMMY'},FFMPEG:BIN+'ffmpeg.exe',here:dir,timings:{},
      process:{argv:['node','test-only',video,outDir,'--concept','selected object','--selected-source','--max-keyframes','6'],env:{}},
      resolveSelectedWorkDir:()=>work,resolveWorkDir:forbid,stage:()=>{},warn:()=>{},fail:m=>{throw Error(m);},timed:async(_,fn)=>fn(),probeVideo,readBasicSelection,probeBasicClock,
      proxyUsage:forbid,trackInstances:forbid,fetch:forbid,erodeAlpha:forbid,boxBlurAlpha:forbid,bleedFill:forbid,
      museEditPlate:async()=>{calls.push(['FAKE-muse']);return{ok:false};},
      attemptPlateRepair:async()=>{calls.push(['FAKE-repair']);return{ok:false,detail:'synthetic refusal'};},
      cleanPath:async target=>{assert.notEqual(path.basename(target),'selected-track','native paid evidence must survive downstream work');await fsp.rm(target,{recursive:true,force:true});},
      trackSelectedInstance:async input=>{
        calls.push(['FAKE-track',input.seedFrameIndex]);assert.equal(input.videoPath,video);assert.equal(input.outDir,path.join(work,'selected-track'));
        await fsp.mkdir(input.outDir);await fsp.mkdir(path.join(input.outDir,'labels'));
        for(let n=37;n<50;n++)await sharp(Buffer.from(chosenMask),{raw:{width:16,height:12,channels:1}}).png().toFile(path.join(input.outDir,'labels',`l${String(n).padStart(5,'0')}.png`));
        return{fps:25,indexDomain:'source-frame',processedRange:{first:37,last:49},unprocessedFrames:Array.from({length:37},(_,i)=>i),unverifiedFrames:[],tracks:[{id:1,first:37,last:49,frames:13}]};
      },
      run:async(bin,args)=>{
        if(bin===BIN+'ffmpeg.exe'){calls.push(['FFmpeg']);return exec(bin,args,{timeout:20000});}
        assert.equal(bin,python,'no other executable/model may run');
        const script=path.basename(args[0]),cmd=args[1],get=flag=>args[args.indexOf(flag)+1];calls.push([script,cmd]);
        let result;
        if(script==='plate.py'&&cmd==='classify')result={camera:'fixed',kind:'synthetic',pan:0,scale:1};
        else if(script==='plate.py'&&cmd==='median') {
          await sharp({create:{width:960,height:720,channels:3,background:{r:30,g:50,b:80}}}).jpeg().toFile(get('--out'));
          await sharp({create:{width:960,height:720,channels:3,background:{r:0,g:0,b:0}}}).extractChannel(0).png().toFile(get('--holes'));
          result={synthetic:true};
        } else if(script==='plate.py'&&cmd==='validate')result={pass:true,mean:0.1,p95:0.2};
        else if(script==='plate.py'&&cmd==='validate-holes')result={pass:true,holeShare:0.01};
        else if(script==='plate.py'&&cmd==='refine-alpha') {
          // Fake refine: keyframe RGB + alpha 255 on the union label (straight RGBA, 0 where transparent).
          const ids=get('--ids').split(',').map(Number),out=get('--out'),files=[];await fsp.mkdir(out,{recursive:true});
          for(const name of (await fsp.readdir(get('--frames'))).filter(x=>x.endsWith('.jpg')).sort()) {
            const rgb=await sharp(path.join(get('--frames'),name)).removeAlpha().raw().toBuffer({resolveWithObject:true});
            const lab=await sharp(path.join(get('--labels'),name.replace('.jpg','.png'))).extractChannel(0).raw().toBuffer();
            const {width,height}=rgb.info,px=Buffer.alloc(width*height*4);
            for(let p=0;p<width*height;p++)if(ids.includes(lab[p])){px[p*4]=rgb.data[p*3];px[p*4+1]=rgb.data[p*3+1];px[p*4+2]=rgb.data[p*3+2];px[p*4+3]=255;}
            await sharp(px,{raw:{width,height,channels:4}}).png().toFile(path.join(out,'rgba_'+name.replace('.jpg','.png')));files.push(name);
          }
          result={frames:files.length,guide:'synthetic',files,empty:[]};
        }
        else if(script==='plate.py'&&cmd==='soften'){await sharp({create:{width:960,height:720,channels:3,background:{r:40,g:40,b:40}}}).jpeg().toFile(get('--out'));result={method:'soft',softShare:0.2,unsureShare:0.15,holeShare:0.01};}
        else if(script==='plate.py'&&cmd==='soften-depth'){assert.match(get('--depth'),/depth_plate.npy$/);result={softDepthShare:0.2,fitted:true};}
        else if(script==='plate.py'&&cmd==='ghost-map')result={medianGhostBlobs:1,medianGhostShare:badGate?null:overGate?0.45:0.01,medianResidueBlobs:1,medianResidueShare:0.01,medianResidue:{synthetic:true}};
        else if(script==='depth.py'&&cmd==='infer') {
          // Keyframes infer in the background during the plate ladder; the
          // plate infers alone once it ships (tier-improve 2026-11-04).
          const names=(await fsp.readdir(get('--frames'))).filter(x=>x.endsWith('.jpg')).sort();
          if(names.includes('plate.jpg'))assert.deepEqual(names,['plate.jpg']);
          else{assert.ok(names.includes('kf_00037.jpg'));assert.ok(names.includes('kf_00049.jpg'));assert.equal(names.length,6);}
          await fsp.mkdir(get('--out'),{recursive:true});result={synthetic:true};
        } else if(script==='depth.py'&&cmd==='fit') {
          assert.equal(get('--ref'),'kf_00037');assert.equal(get('--track'),'1');
          const names=(await fsp.readdir(get('--labels'))).filter(x=>x.endsWith('.jpg')).sort();
          const fitDir=get('--out');await fsp.mkdir(fitDir,{recursive:true});
          await fsp.writeFile(path.join(fitDir,'fitted_plate.npy'),npy(960,badPlateDepth?718:720));
          for(const name of names)await fsp.writeFile(path.join(fitDir,'fitted_'+name.replace('.jpg','.npy')),npy(960,badDepth?718:720));
          await fsp.writeFile(path.join(fitDir,'fit.json'),JSON.stringify({frames:names.map(name=>({name,scale:1,shift:0}))}));result={synthetic:true};
        } else if(script==='behind.py')throw Error('explicit fake behind unavailable; must not claim layer files');
        else throw Error('unexpected Python boundary '+script+' '+cmd);
        return{stdout:JSON.stringify(result),stderr:''};
      },
    };
    vm.createContext(context);vm.runInContext(parser+'\n'+maskStats+'\n'+gates,context);
    const main=vm.runInContext('('+mainSource.trim()+')',context);
    let error;try{await main();}catch(e){error=e;}
    assert.equal(calls.filter(c=>c[0]==='FAKE-track').length,1);
    assert.ok(await fsp.stat(path.join(work,'selected-track/labels/l00037.png')),'retain native labels even on failure');
    assert.ok(!calls.some(c=>c[1]==='refine-mask'));
    return{outDir,work,calls,error};
  }

  await t.test('full atlas/JSON consumer contract keeps original indices/times and absent behind remains absent',async()=>{
    const r=await scenario('success');assert.ifError(r.error);
    assert.equal(r.calls.filter(c=>c[0]==='depth.py'&&c[1]==='infer').length,2,'keyframes (background) + plate');
    const specimen=JSON.parse(await fsp.readFile(path.join(r.outDir,'specimen.json'),'utf8'));
    const meta=JSON.parse(await fsp.readFile(path.join(r.outDir,'meta.json'),'utf8'));
    assert.equal(specimen.version,1);assert.equal(specimen.tier,'basic');assert.equal(specimen.subject,'selected object');
    assert.equal(specimen.track.clock.kind,'cfr');assert.equal(specimen.track.requestedSeedFrame,37);assert.equal(specimen.track.seedSample,37);
    assert.equal(specimen.track.sourceSha256,crypto.createHash('sha256').update(await fsp.readFile(video)).digest('hex'));
    assert.deepEqual(specimen.track.processedRange,{first:37,last:49});assert.equal(specimen.track.unprocessedFrames.length,37);assert.deepEqual(specimen.track.unverifiedFrames,[]);
    assert.equal(specimen.keyframes.length,6);
    assert.deepEqual(specimen.keyframes.map(f=>[f.sample,f.src,f.t]),specimen.track.samples.map(s=>[s,s,s/25]));
    assert.equal(specimen.keyframes.at(-1).src,49);assert.equal(meta.durationSec,(49-37)/25);assert.equal(specimen.depth.ref,'kf_00037');
    assert.deepEqual(specimen.keyframes.map(f=>f.cell),[0,1,2,3,4,5]);
    assert.equal(specimen.files.behind,undefined);assert.equal(specimen.files.plateAlpha,undefined);
    for(const file of Object.values(specimen.files))assert.ok((await fsp.stat(path.join(r.outDir,file))).size>0);
    const sm=await sharp(path.join(r.outDir,specimen.files.subject)).metadata(),dm=await sharp(path.join(r.outDir,specimen.files.depth)).metadata();
    assert.equal(sm.width,specimen.layout.cols*specimen.layout.cellW);assert.equal(sm.height,specimen.layout.rows*specimen.layout.cellH);
    assert.equal(dm.width,sm.width);assert.equal(dm.height,specimen.layout.dRows*specimen.layout.cellH);assert.ok(sm.hasAlpha);
    for(const i of [0,5]) {
      const rect=atlas.cellRect(i,specimen.layout.cols,specimen.layout.cellW,specimen.layout.cellH);
      const pixel=await sharp(path.join(r.outDir,specimen.files.subject)).extract({left:rect.x+Math.floor(rect.w/2),top:rect.y+Math.floor(rect.h/2),width:1,height:1}).ensureAlpha().raw().toBuffer();
      assert.ok(Math.abs(pixel[0]-(20+specimen.keyframes[i].src))<=5,'atlas RGB retains the actual native source frame');assert.equal(pixel[3],255);
    }
    assert.ok(!fs.existsSync(path.join(r.work,'kf')),'only consumed derived RGB/masks removed, not selected evidence');
  });
  // Loop 6 (tier-improve 2026-11-04): a plate that fails QA ships the soft
  // fallback, recorded as plate.fallback, instead of refusing; the measured
  // QA still decides, never a null/zero reading passed as clean.
  const softShipped=async r=>{
    assert.ifError(r.error);assert.equal(r.calls.filter(c=>c[0]==='plate.py'&&c[1]==='soften').length,1,'exactly one soft fallback build');
    const specimen=JSON.parse(await fsp.readFile(path.join(r.outDir,'specimen.json'),'utf8'));
    assert.equal(specimen.plate.method,'soft');assert.equal(specimen.plate.fallback.kind,'soft');assert.equal(specimen.plate.fallback.reason,'ghost-qa');
    assert.ok(specimen.provenance.includes('plate-soft'));assert.equal(r.calls.filter(c=>c[0]==='plate.py'&&c[1]==='soften-depth').length,1,'soft zone depth surfaced once');return specimen;
  };
  await t.test('unmeasured plate ghost never passes as clean: soft fallback, no repair spend',async()=>{
    const r=await scenario('bad-plate',{badGate:true});await softShipped(r);
    assert.ok(!r.calls.some(c=>c[0]==='FAKE-repair'),'an unmeasured gate must not buy a model repair');
  });
  await t.test('measured over-limit plate retains its single repair path before the soft fallback',async()=>{
    const r=await scenario('measured-over-limit',{overGate:true});const sp=await softShipped(r);
    assert.equal(r.calls.filter(c=>c[0]==='FAKE-repair').length,1,'valid measured defects retain repair eligibility');
    assert.match(sp.plate.fallback.detail,/ghost 0.45/);
  });
  await t.test('plate fitted-depth raster mismatch also refuses rather than silently becoming zero pixels',async()=>{
    const r=await scenario('bad-plate-depth',{badPlateDepth:true});assert.match(r.error?.message||'',/depth\/frame size mismatch at plate/);
    assert.ok(!fs.existsSync(path.join(r.outDir,'specimen.json')));
  });
  await t.test('native fitted-depth raster mismatch refuses before publishing specimen',async()=>{
    const r=await scenario('bad-depth',{badDepth:true});assert.match(r.error?.message||'',/depth\/frame size mismatch at 00037/);
    assert.ok(!fs.existsSync(path.join(r.outDir,'specimen.json')));assert.ok(!r.calls.some(c=>c[0]==='behind.py'));
  });
});
