import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageBoxPixels, makeImageBoxSeed, requireImageBox} from '../../backend/lib/sam-image-seed.mjs';

test('image box uses frame zero, request-local string ID and inclusive wire maxima',()=>{
  const box=imageBoxPixels({left:495/1280,top:240/720,right:810/1280,bottom:535/720},1280,720);
  assert.deepEqual(box,{left:495,top:240,right:810,bottom:535});
  assert.deepEqual(makeImageBoxSeed({box,width:1280,height:720}),{objectId:'1',text:'<0f>1<|box;x1=495;y1=240;x2=809;y2=534;w=1280;h=720|>'});
});
test('full and fractional preview extents cover source pixels without sending a noun',()=>{
  const box=imageBoxPixels({left:0,top:0,right:1,bottom:1},401,301);
  assert.equal(makeImageBoxSeed({box,width:401,height:301}).text,'<0f>1<|box;x1=0;y1=0;x2=400;y2=300;w=401;h=301|>');
  assert.deepEqual(imageBoxPixels({left:.105,top:.105,right:.205,bottom:.205},100,100),{left:10,top:10,right:21,bottom:21});
});
for(const value of [null,{}, {left:'0',top:0,right:1,bottom:1},{left:0,top:0,right:true,bottom:1},{left:NaN,top:0,right:1,bottom:1}, {left:-.01,top:0,right:1,bottom:1},{left:0,top:0,right:1.1,bottom:1},{left:.5,top:0,right:.5,bottom:1}])test('invalid normalized box refuses '+JSON.stringify(value),()=>assert.throws(()=>imageBoxPixels(value,100,100)));
test('bad raster and noninteger pixel boxes refuse before a request can be built',()=>{
  for(const [w,h] of [[0,100],[100,Infinity],[100.5,100],[Number.MAX_SAFE_INTEGER,100]])assert.throws(()=>imageBoxPixels({left:0,top:0,right:1,bottom:1},w,h));
  for(const box of [{left:.1,top:0,right:10,bottom:10},{left:0,top:0,right:101,bottom:10},{left:0,top:3,right:10,bottom:3}])assert.throws(()=>requireImageBox(box,100,100));
});
