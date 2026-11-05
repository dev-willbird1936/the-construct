import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=(await fs.readFile(new URL('../../view-lite.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const start=source.indexOf('  const chipsFor = (m = {}) => {');
const end=source.indexOf('  if (meta) {',start);
assert.ok(start>=0&&end>start,'exercise actual viewer provenance closure');
const chips=vm.runInNewContext(source.slice(start,end)+'\nchipsFor;');
const labels=m=>Array.from(chips(m));
test('initial HTML does not assert a producer before provenance resolves',async()=>{
 const html=await fs.readFile(new URL('../../view-lite.html',import.meta.url),'utf8');
 assert.match(html, /id="vChips" aria-label="Provenance"><li>Loading provenance…<\/li>/);
 assert.doesNotMatch(html,/SAM 3\.1 tracking|Muse Spark routing/);
});
test('real SAM and Spark source labels remain unchanged',()=>{
 assert.deepEqual(labels({provenance:['sam3-native','muse-spark-route'],camera:'fixed',category:'wildlife'}),['SAM 3.1 tracking','Muse Spark: wildlife · fixed camera']);
});
test('real plate provenance remains distinct from tracking/routing',()=>{
 assert.deepEqual(labels({provenance:['sam3','muse-image-plate','muse-spark'],camera:'unknown',category:'other'}),['SAM 3.1 tracking','Muse Image plate','Muse Spark: clip check']);
});
test('explicit synthetic oracle never claims model inference, even with mixed stale model tags',()=>{
 for(const provenance of [['synthetic-gt-body-rgba','cg-0-oracle-packer'],['sam3','synthetic-gt-body-rgba','muse-spark']]) assert.deepEqual(labels({provenance}),['Synthetic ground truth','Consumer QA · no model inference']);
});
test('missing legacy provenance keeps existing presentation',()=>{
 assert.deepEqual(labels(),['SAM 3.1 tracking','Muse Spark routing']);
 assert.deepEqual(labels({provenance:[]}),['SAM 3.1 tracking','Muse Spark routing']);
});
