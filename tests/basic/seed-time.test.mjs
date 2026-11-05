import test from 'node:test';
import assert from 'node:assert/strict';
import {matchSeedBox} from '../../backend/pipeline/basic/lib/keyframes.mjs';
const seedBox={left:.1,top:.1,right:.3,bottom:.3};
const far={left:.65,top:.1,right:.85,bottom:.3};
const tracks=[{id:8},{id:9}];
test('a later crossing cannot steal a unique exact-time selected instance',()=>{
 const t=matchSeedBox(tracks,{seedBox,seedSample:15,getBox:(id,s)=>id===8?{...seedBox,right:.29}:s===18?seedBox:far});
 assert.equal(t.id,8);
});
test('equally near past/future candidates remain ambiguous',()=>{
 assert.throws(()=>matchSeedBox(tracks,{seedBox,seedSample:15,getBox:(id,s)=>id===8&&s===14||id===9&&s===16?seedBox:null}),/seed-box ambiguous/);
});
