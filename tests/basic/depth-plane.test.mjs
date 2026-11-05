import test from 'node:test';
import assert from 'node:assert/strict';
import { requireDepthPlane } from '../../backend/pipeline/basic/lib/atlas.mjs';

test('finite relative and constant depth planes retain the original data and range',()=>{
  for(const values of [[-2,-1,0,1],[3,3,3,3]]) {
    const plane={shape:[2,2],data:Float32Array.from(values)};
    assert.equal(requireDepthPlane(plane,2,2,'plate'),plane);
    assert.deepEqual([...plane.data],values);
  }
});
test('both plate and keyframe depth must be exactly the working two-dimensional raster',()=>{
  for(const label of ['plate','00037'])for(const plane of [null,{shape:[2,3],data:new Float32Array(6)},{shape:[3,2],data:new Float32Array(6)},{shape:[2,2,1],data:new Float32Array(4)},{shape:[2,2],data:new Float32Array(3)}]) {
    assert.throws(()=>requireDepthPlane(plane,2,2,label),e=>e.message==='depth/frame size mismatch at '+label);
  }
});
test('nonfinite model depth refuses before quantization rather than becoming a zero pixel',()=>{
  for(const label of ['plate','00037'])for(const value of [NaN,Infinity,-Infinity]) {
    assert.throws(()=>requireDepthPlane({shape:[2,2],data:Float32Array.of(1,value,2,3)},2,2,label),e=>e.message==='nonfinite depth at '+label);
  }
});
