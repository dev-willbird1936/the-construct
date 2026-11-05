process.env.META_API_KEY='DUMMY';process.env.META_BASE_URL='http://127.0.0.1:1/v1';process.env.META_MODEL_RETRIES='0';
const {test,assert,startApp,uploadClip}=await import('./support.js');
const {probeVideo}=await import('../../backend/lib/ffmpeg.js');
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

// A phone clip stored sideways with a display rotation (Lite loop 9,
// wolves-rot): the upload must store it upright at its own size, or the coded
// width/height disagree with every decoded frame and Build fails as a
// "selection expired". Untagged clips keep the old path.
async function sidewaysClip(){
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'construct-rot-'));
  const coded=path.join(dir,'coded.mp4'),tagged=path.join(dir,'tagged.mp4');
  // upright 96x128 portrait, stored transposed (128x96) + tagged 90 deg
  await run('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc=size=96x128:rate=10:duration=2','-vf','transpose=1','-pix_fmt','yuv420p',coded]);
  await run('ffmpeg',['-y','-v','error','-display_rotation','90','-i',coded,'-c','copy',tagged]);
  return tagged;
}

test('probeVideo reports the display rotation; untagged clips report 0',async()=>{
  const tagged=await sidewaysClip();
  const info=await probeVideo(tagged);
  assert.equal(info.width,128);assert.equal(info.height,96);assert.equal(info.rotation,90);
  const {fixtureClip}=await import('./support.js');
  assert.equal((await probeVideo(await fixtureClip())).rotation,0);
});

test('a rotation-tagged upload is stored upright at its own size; an untagged one is untouched',async t=>{
  const handle=await startApp(t);
  const tagged=await sidewaysClip();
  const {status,json}=await uploadClip(handle.base,{clip:tagged});
  assert.equal(status,200);
  assert.equal(json.width,96);assert.equal(json.height,128);
  const stored=await probeVideo(path.join(handle.dataDir,'uploads',json.uploadId,'source.mp4'));
  assert.deepEqual([stored.width,stored.height,stored.rotation],[96,128,0]);
  const plain=await uploadClip(handle.base);
  assert.equal(plain.status,200);
  assert.deepEqual([plain.json.width,plain.json.height],[128,96]);
});
