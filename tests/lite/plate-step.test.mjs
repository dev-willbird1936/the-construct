import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Registered stage plate (runner-lite.js runLitePlate + lite_plate.py): one
// batch python call beside the pack; a refusal or failure keeps the JS
// fallback plates and never fails the job.
const source=(await fs.readFile(new URL('../../backend/app/runner-lite.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const start=source.indexOf('// <lite-plate>'),end=source.indexOf('// </lite-plate>');
assert.ok(start>0&&end>start,'plate block slice');
const block=source.slice(start,end).replaceAll('import.meta.url','META_URL').replace('export async function','async function');

async function runStep({stdout='',execError=null,aborted=false,plateAborted=false,osdCut=null}={}){
  const writes=new Map(),calls=[],errors=[];
  const fsp={writeFile:async(p,b)=>{writes.set(p,String(b));},readFile:async()=>Buffer.from('png-bytes')};
  const cancelledError=()=>Object.assign(Error('cancelled'),{cancel:true});
  const ctx={fsp,path,JSON,String,Error,URL,process:{env:{BASIC_PYTHON:'py-test'}},config:{},console:{error:m=>errors.push(m)},
    fileURLToPath:u=>String(u),META_URL:'file:///app/runner-lite.js',signal:{aborted},job:{id:'job-1'},specDir:'/spec',
    upload:{path:'/up/source.mp4'},
    allSlices:[{file:'m0.png',sourceFrameIndex:0},{file:'m1.png',sourceFrameIndex:5},{file:'m1b.png',sourceFrameIndex:5}],
    throwIfCancelled:s=>{if(s?.aborted)throw cancelledError();},isCancelError:e=>!!e?.cancel,cancelledError,
    execFileAsync:async(bin,args,opts)=>{calls.push({bin,args,opts});if(execError)throw execError;return {stdout};}};
  vm.createContext(ctx);
  const info=await vm.runInContext(`(async()=>{${block}\nreturn runLitePlate({specDir,upload,allSlices,config,job,signal,plateSignal:{aborted:${plateAborted}},osdCut:${osdCut}});})()`,ctx,{timeout:5000});
  return {info,writes,calls,errors};
}

test('an ok plate returns the png and registered QA from one -I call',async()=>{
  const {info,writes,calls,errors}=await runStep({stdout:'{"ok": true, "width": 640, "height": 360, "unknownShare": 0.02, "mad": 5.1, "samples": 16}\n'});
  assert.equal(String(info.png),'png-bytes');
  assert.deepEqual(JSON.parse(JSON.stringify(info.qa)),{decision:'registered',unknownShare:0.02,mad:5.1,samples:16});
  assert.equal(calls.length,1);assert.equal(calls[0].bin,'py-test');assert.equal(calls[0].args[0],'-I');
  assert.match(calls[0].args[1],/lite_plate\.py$/);
  assert.equal(calls[0].args[calls[0].args.indexOf('--video')+1],'/up/source.mp4');
  assert.ok(calls[0].opts.signal,'abortable when the pack fails');
  const input=JSON.parse(writes.get(path.join('/spec','work','plate-input.json')));
  assert.equal(input.frames.length,3);assert.equal(input.frames[2].sourceFrameIndex,5);
  assert.equal(errors.length,0);
});

test('the plate is built above a burnt-in data bar',async()=>{
  const {calls}=await runStep({stdout:'{"ok": true}',osdCut:654});
  assert.equal(calls[0].args[calls[0].args.indexOf('--crop-bottom')+1],'654');
});

test('a QA refusal or a crash falls back quietly to the JS plates',async()=>{
  const refused=Object.assign(Error('Command failed'),{code:3,stdout:'{"ok": false, "reason": "unknown share 0.210"}\n'});
  for(const opts of [{execError:refused},{execError:Error('spawn ENOENT')},{stdout:'not json'},{stdout:'{"ok": false}'}]){
    const {info,errors}=await runStep(opts);
    assert.equal(info,null);assert.equal(errors.length,1);assert.match(errors[0],/\[lite-plate\] fallback for job job-1/);
  }
  const {errors}=await runStep({execError:refused});
  assert.match(errors[0],/unknown share 0\.210/,'the refusal reason is logged');
});

test('a failed pack drops the plate silently; cancellation propagates',async()=>{
  const {info,errors}=await runStep({execError:Object.assign(Error('aborted'),{name:'AbortError'}),plateAborted:true});
  assert.equal(info,null);assert.equal(errors.length,0);
  await assert.rejects(runStep({aborted:true}),/cancelled/);
});

// lite_plate.py end to end on a synthetic pan: a textured strip seen through
// a panning 320x180 window, a red block that the camera follows (so it
// stays put in the frame while the background slides behind it).
const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')),'..','..');
const PY=process.env.BASIC_PYTHON||[path.join(ROOT,'backend/pipeline/basic/.venv/Scripts/python.exe'),path.join(ROOT,'backend/pipeline/basic/.venv/bin/python')].find((p)=>nodeFs.existsSync(p));
const GEN=`
import sys, json, os, cv2, numpy as np
out, noise = sys.argv[1], sys.argv[2] == "noise"
rng = np.random.default_rng(7)
bg = cv2.GaussianBlur(rng.integers(0, 255, (180, 900, 3), dtype=np.uint8), (0, 0), 1.2)
vw = cv2.VideoWriter(os.path.join(out, "clip.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), 12, (320, 180))
frames = []
for i in range(24):
    x = int(i * 20)
    fr = rng.integers(0, 255, (180, 320, 3), dtype=np.uint8) if noise else bg[:, x:x + 320].copy()
    fr[60:120, 130:190] = (0, 0, 230)
    vw.write(fr)
    m = np.zeros((180, 320, 4), np.uint8); m[60:120, 130:190, 3] = 255
    p = os.path.join(out, "m%02d.png" % i); cv2.imwrite(p, m)
    frames.append({"mask": p, "sourceFrameIndex": i})
vw.release()
json.dump({"frames": frames}, open(os.path.join(out, "in.json"), "w"))
`;
const run=promisify(execFile);
async function plateOn(kind){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lite-plate-'));
  await run(PY,['-I','-c',GEN,dir,kind]);
  const res=await run(PY,['-I',path.join(ROOT,'backend/app/lite_plate.py'),'--video',path.join(dir,'clip.mp4'),'--frames-json',path.join(dir,'in.json'),'--out',path.join(dir,'plate.png'),'--width','320']).catch((e)=>e);
  return {dir,code:res.code||0,out:JSON.parse(String(res.stdout).trim().split(/\r?\n/).pop())};
}

test('lite_plate.py registers a pan and medians the followed subject away',{skip:!PY&&'no basic python'},async()=>{
  const {dir,code,out}=await plateOn('pan');
  assert.equal(code,0,JSON.stringify(out));assert.equal(out.ok,true);
  assert.ok(out.width>330,`the pan widens the plate (${out.width}px)`);
  assert.ok(out.unknownShare<=0.04,`unknown ${out.unknownShare}`);assert.ok(out.mad<16,`mad ${out.mad}`);
  const check=await run(PY,['-I','-c','import cv2,sys;p=cv2.imread(sys.argv[1]).astype(int);r=((p[:,:,2]>180)&(p[:,:,1]<80)&(p[:,:,0]<80)).mean();print(r)',path.join(dir,'plate.png')]);
  assert.ok(Number(check.stdout)<0.002,`subject red left in the plate: ${check.stdout}`);
});

test('lite_plate.py refuses (exit 3, nothing written) when frames do not register',{skip:!PY&&'no basic python'},async()=>{
  const {dir,code,out}=await plateOn('noise');
  assert.equal(code,3);assert.equal(out.ok,false);assert.ok(out.reason);
  assert.equal(nodeFs.existsSync(path.join(dir,'plate.png')),false);
});

// Loop 14: the never-uncovered patch is shift-map filled with two context
// margins; the fill whose low-pass brightness stays closest to the smooth
// (Telea) fill wins, and the smooth fill itself when both stray past
// FILL_DEV (a fresh roedeer run pasted a bright floor block into the dark
// forest). Candidates are stubbed to pin the choice; then one real fill.
const FILL=`
import sys, json, numpy as np
sys.path.insert(0, sys.argv[1]); import lite_plate as lp
H, W = 200, 300
def hole():
    h = np.zeros((H, W), np.uint8); h[50:150, 100:200] = 1; return h
def pick(devs):
    real, pads = lp.fill_crop, []
    def stub(p, h, pad, budget, band):
        pads.append(pad)
        return (0, H, 0, W), p, h, np.full((H, W, 3), pad, np.float32), np.full((H, W, 3), 7, np.float32), devs[pad]
    lp.fill_crop, lp.HAS_XPHOTO = stub, True
    try:
        out = lp.fill_holes(np.full((H, W, 3), 100, np.uint8), hole())
    finally:
        lp.fill_crop = real
    return [int(out[100, 150, 0]), int(out[10, 10, 0]), pads]
res = {"closer": pick({32: 30.0, 50: 12.0}), "first": pick({32: 12.0, 50: 20.0}), "stray": pick({32: 40.0, 50: 30.0})}
lp.HAS_XPHOTO = hasattr(lp.cv2, "xphoto")
rng = np.random.default_rng(3)
img = np.clip(rng.normal(0, 12, (H, W, 3)) + np.where(np.arange(H)[:, None, None] < 90, 40, 200), 0, 255).astype(np.uint8)
img[50:150, 100:200] = (0, 0, 255)
out = lp.fill_holes(img.copy(), hole())
r = out[50:150, 100:200].astype(int)
res["red"] = float(((r[:, :, 2] > 200) & (r[:, :, 1] < 60)).mean())
res["outside"] = int(np.abs(out.astype(int) - img)[:40].max())
print(json.dumps(res))
`;

test('lite_plate.py keeps the hole fill closest to the smooth fill, and the smooth fill when every shift-map fill strays',{skip:!PY&&'no basic python'},async()=>{
  const res=JSON.parse((await run(PY,['-I','-c',FILL,path.join(ROOT,'backend/app')])).stdout.trim().split(/\r?\n/).pop());
  assert.deepEqual(res.closer,[50,100,[32,50]],'the 50 px margin is closer: it wins; outside the hole the plate is kept');
  assert.deepEqual(res.first,[32,100,[32,50]],'the 32 px margin is closer: it wins');
  assert.deepEqual(res.stray,[7,100,[32,50]],'both past FILL_DEV: the smooth fill');
  assert.equal(res.red,0,'the real fill leaves nothing of the subject');
  assert.equal(res.outside,0,'rows far from the hole are untouched');
});
