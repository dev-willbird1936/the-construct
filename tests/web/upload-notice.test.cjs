const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../site.js'),'utf8').replace(/\r\n/g,'\n');
const toastSource=source.match(/let toastVersion = 0;[\s\S]*?\n}\n/)[0];
const start=source.indexOf('  let info;',source.indexOf('async function loadFile('));
const end=source.indexOf('  ST.tierManual = false;',start)+'  ST.tierManual = false;'.length;
assert.ok(start>0&&end>start);
function fixture(fetch){
 const visible=new Set(),timers=[],notice={textContent:'',classList:{add:x=>visible.add(x),remove:x=>visible.delete(x)}};
 const video={},ST={video,upload:null,tierManual:true};
 const context=vm.createContext({ST,video,form:{synthetic:true},apiUrl:p=>p,fetch,$:()=>notice,window:{setTimeout:fn=>timers.push(fn)}});
 vm.runInContext(toastSource,context);
 const commit=vm.runInContext('(async()=>{'+source.slice(start,end)+';return ST.upload;})',context);
 return{context,ST,video,notice,visible,timers,commit,toast:(msg,ms)=>context.toast(msg,ms)};
}
test('successful upload clears only its own persistent progress toast',async()=>{
 const f=fixture(async()=>({ok:true,json:async()=>({uploadId:'new-owned-upload'})}));f.toast('Uploading…');
 assert.equal((await f.commit()).uploadId,'new-owned-upload');assert.equal(f.visible.size,0);assert.equal(f.ST.tierManual,false);
});
test('an older timed notice cannot hide newer upload progress',()=>{
 const f=fixture();f.toast('old error',50);f.toast('Uploading…');f.timers[0]();assert.ok(f.visible.has('is-visible'));assert.equal(f.notice.textContent,'Uploading…');
});
test('an older completed upload cannot overwrite a newer video or dismiss its notice',async()=>{
 let release;const response=new Promise(resolve=>{release=resolve;});
 const f=fixture(()=>response);f.toast('Uploading…');const pending=f.commit();
 f.ST.video={newer:true};f.ST.upload={uploadId:'newer-upload'};release({ok:true,json:async()=>({uploadId:'stale-upload'})});
 await pending;assert.equal(f.ST.upload.uploadId,'newer-upload');assert.ok(f.visible.has('is-visible'));
});
test('an older failed upload cannot replace the current upload notice',async()=>{
 let reject;const response=new Promise((_,fail)=>{reject=fail;});
 const f=fixture(()=>response);f.toast('Uploading…');const pending=f.commit();
 f.ST.video={newer:true};reject(Error('stale failure'));await pending;
 assert.equal(f.notice.textContent,'Uploading…');assert.ok(f.visible.has('is-visible'));
});
test('upload failure retains its actual failure message, not a success dismissal',async()=>{
 const f=fixture(async()=>({ok:false,json:async()=>({error:'synthetic failure'})}));f.toast('Uploading…');
 await f.commit();assert.equal(f.notice.textContent,'Upload failed: synthetic failure');assert.ok(f.visible.has('is-visible'));assert.equal(f.ST.upload,null);
});
test('startup caption names loading, not an unsupported horse output claim',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');
 assert.match(html,/<b id="cellTitle">LOADING THE CONSTRUCT<\/b>/);
 assert.doesNotMatch(html,/every hoof-fall kept|id="cellTitle">GALLOP/);
});
