const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../site.js'),'utf8');
function load(name,context){
 const code=source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
 assert.ok(code,`${name} source exists`);
 vm.runInNewContext(code[0]+`;globalThis.fn=${name};`,context);return context.fn;
}
test('software fallback recognizes common rasterizers, not normal GPUs',()=>{
 const f=load('softwareRendererName',{});
 for(const name of ['ANGLE SwiftShader Device','llvmpipe LLVM','softpipe','Software Rasterizer'])assert.equal(f(name),true);
 for(const name of ['NVIDIA RTX3080','Apple M2','AMD Radeon',null])assert.equal(f(name),false);
 assert.match(source,/bloom\.enabled = !softwareGraphics/);
 assert.match(source,/if \(softwareGraphics\) state\.entry = 1/);
 assert.match(source,/softwareGraphics \? 1 : 1\.75/);
});
test('covered gallery skips drawing for studio, viewer or hidden tab',()=>{
 for(const hidden of [false,true])for(const studio of [false,true])for(const viewerHidden of [false,true]){
  const context={document:{hidden,body:{classList:{contains:()=>studio}}},$:()=>({classList:{contains:()=>viewerHidden}})};
  assert.equal(load('galleryIsCovered',context)(),hidden||studio||!viewerHidden);
 }
 const context={document:{hidden:false,body:{classList:{contains:()=>false}}},$:()=>null};
 assert.equal(load('galleryIsCovered',context)(),false);
});
test('software frame acknowledgement leaves a real UI idle gap',()=>{
 const context={softwareFramePending:true,softwareIdleUntil:0,softwareGraphics:true,galleryIsCovered:()=>false,performance:{now:()=>100}};
 const f=load('galleryMayDraw',context);
 assert.equal(f(100),false);
 assert.equal(context.softwareFramePending,false);
 assert.equal(context.softwareIdleUntil,350);
 assert.equal(f(349),false);
 assert.equal(f(350),true);
});
test('hardware gallery retains its normal draw cadence',()=>{
 const f=load('galleryMayDraw',{softwareFramePending:false,softwareIdleUntil:9999,softwareGraphics:false,galleryIsCovered:()=>false});
 assert.equal(f(100),true);
 assert.equal(f(116),true);
});
test('draw gating does not stop animation scheduling or navigation updates',()=>{
 assert.match(source,/requestAnimationFrame\(frame\)/);
 assert.match(source,/if \(galleryMayDraw\(now\)\) \{\s*composer\.render\(\)/);
 assert.ok(source.indexOf('state.cut +=')<source.indexOf('if (galleryMayDraw(now))'));
});
