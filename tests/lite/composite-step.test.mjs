import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

// Lite 2D composite step (runner-lite.js runLiteComposite): one batch
// composite_lite.py call, extra artefact only, run beside the atlas pack.
// A failure must skip the composite and never fail the job.
const source=(await fs.readFile(new URL('../../backend/app/runner-lite.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const start=source.indexOf('// <lite-composite>'),end=source.indexOf('// </lite-composite>');
assert.ok(start>0&&end>start,'composite block slice');
const block=source.slice(start,end).replaceAll('import.meta.url','META_URL').replace('export async function','async function');

async function runStep({meta,execError,aborted=false,packAborted=false,osdCut=null}={}){
  const writes=new Map(),calls=[],errors=[],reads=[];
  const fsp={mkdir:async()=>{},writeFile:async(p,b)=>{writes.set(p,String(b));},readFile:async(p)=>{reads.push(p);if(meta===undefined)throw Error('ENOENT '+p);return JSON.stringify(meta);}};
  const cancelledError=()=>Object.assign(Error('cancelled'),{cancel:true});
  const ctx={fsp,path,JSON,Number,Error,URL,process:{env:{BASIC_PYTHON:'py-test'}},config:{},console:{error:m=>errors.push(m)},
    fileURLToPath:u=>String(u),META_URL:'file:///app/runner-lite.js',signal:{aborted},job:{id:'job-1'},specDir:'/spec',
    upload:{fps:25,width:64,height:48,path:'/up/source.mp4'},
    allSlices:[{file:'m0.png',sourceFrameIndex:0,timestamp:0,concept:'deer'},{file:'m1.png',sourceFrameIndex:5,timestamp:0.2,concept:'deer'}],
    throwIfCancelled:s=>{if(s?.aborted)throw cancelledError();},isCancelError:e=>!!e?.cancel,cancelledError,
    execFileAsync:async(bin,args,opts)=>{calls.push({bin,args,opts});if(execError)throw execError;}};
  vm.createContext(ctx);
  const info=await vm.runInContext(`(async()=>{${block}\nreturn runLiteComposite({specDir,upload,allSlices,config,job,signal,compositeSignal:{aborted:${packAborted}},osdCut:${osdCut}});})()`,ctx,{timeout:5000});
  return {info,writes,calls,errors,reads};
}

test('valid composite.json yields atlas composite info from one batch -I call',async()=>{
  const {info,writes,calls,errors}=await runStep({meta:{route:'filmstrip',subjectHeightFraction:0.45,keptFrames:[0,5]}});
  assert.equal(JSON.stringify(info),JSON.stringify({file:'composite.png',route:'filmstrip',subjectHeightFraction:0.45,kept:[0,5]}));
  assert.equal(calls.length,1);assert.equal(calls[0].bin,'py-test');assert.equal(calls[0].args[0],'-I');
  assert.ok(calls[0].args.includes('--frames-json'));assert.equal(errors.length,0);
  // The still is written to work/still and only published after the pack.
  assert.equal(calls[0].args[calls[0].args.indexOf('--specimen')+1],path.join('/spec','work','still'));
  assert.ok(calls[0].opts.signal,'the composite child is abortable when the pack fails');
  const input=JSON.parse(writes.get(path.join('/spec','work','composite-input.json')));
  assert.equal(input.frames.length,2);assert.equal(input.frames[1].sourceFrameIndex,5);assert.equal(input.fps,25);
});

test('composite failure or invalid output is skipped, never thrown',async()=>{
  for(const opts of [{execError:Error('python exited 1')},{meta:undefined},{meta:{route:'other',subjectHeightFraction:0.4}},{meta:{route:'chronophotograph',subjectHeightFraction:null}}]){
    const {info,errors}=await runStep(opts);
    assert.equal(info,null);assert.equal(errors.length,1);assert.match(errors[0],/\[lite-composite\] skipped for job job-1/);
  }
});

test('a failed pack drops the still quietly (no error line, no throw)',async()=>{
  const {info,errors}=await runStep({execError:Object.assign(Error('aborted'),{name:'AbortError'}),packAborted:true});
  assert.equal(info,null);assert.equal(errors.length,0);
});

test('cancellation still propagates through the composite step',async()=>{
  await assert.rejects(runStep({aborted:true}),/cancelled/);
});

test('atlas.json lists composite only when the step produced it',()=>{
  assert.ok(source.includes('...(compositeInfo ? { composite: compositeInfo } : {}),'));
});

test('a burnt-in data bar is passed to the still as --crop-bottom (and only then)',async()=>{
  const meta={route:'filmstrip',subjectHeightFraction:0.4,keptFrames:[0]};
  const cut=await runStep({meta,osdCut:654});
  assert.equal(cut.calls[0].args[cut.calls[0].args.indexOf('--crop-bottom')+1],'654');
  const none=await runStep({meta});
  assert.equal(none.calls[0].args.includes('--crop-bottom'),false);
});
