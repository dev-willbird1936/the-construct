import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireWholeSeedSource, makeVideoSeed } from '../../backend/lib/sam-video-seed.mjs';
import { parseTrackedVideo } from '../../backend/lib/sam-image-result.mjs';

const input = {box:{left:495,top:240,right:810,bottom:535},frameIndex:37,frames:200,width:1280,height:720,samWidth:1280,samHeight:720,samOffset:0};
test('nonzero seed uses the exact proven SAM token grammar and inclusive endpoints', () => {
  const seed=makeVideoSeed(input);
  assert.equal(seed.text,'<37f>1<|box;x1=495;y1=240;x2=809;y2=534;w=1280;h=720|>');
  assert.equal(seed.objectId,'1');
  assert.equal(seed.propagation,'forward');
  assert.deepEqual(seed.box,input.box);
});
test('actual parser returns string identity and the original half-open box', async () => {
  const seed=makeVideoSeed(input);
  const text=seed.text+"<|mask;x=0;y=0;data=3,4,!!!!!'y7K#I-=|>\n";
  async function* events(){yield {type:'response.output_text.done',item_id:'synthetic',output_index:0,content_index:0,text};yield {type:'response.completed'};}
  const result=await parseTrackedVideo(events());
  const box=result.records.find(r=>r.kind==='box');
  assert.equal(box.objectId,'1');
  assert.equal(box.frame.frameIndex,37);
  assert.deepEqual({left:box.left,top:box.top,right:box.right,bottom:box.bottom},input.box);
});
for(const [label,patch] of [['window',{samOffset:37}],['scaled',{samWidth:640,samHeight:360}],['long',{frames:351}],['odd',{height:719,samHeight:719}],['outside seed',{frameIndex:200}],['fractional seed',{frameIndex:1.5}],['wide',{width:1282,samWidth:1282}],['invalid box',{box:{left:0,top:0,right:1281,bottom:1}}]]) {
  test(`seeded ${label} input refuses before a request can be formed`,()=>assert.throws(()=>makeVideoSeed({...input,...patch})));
}
test('whole-source eligibility does not accept missing frame counts or boolean dimensions',()=>{
  assert.throws(()=>requireWholeSeedSource({frames:undefined,width:1280,height:720},0));
  assert.throws(()=>requireWholeSeedSource({frames:200,width:true,height:720},0));
});
