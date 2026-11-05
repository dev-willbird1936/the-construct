// Replay finale verification; all captures stay under backend/jobs.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require(path.join(process.env.APPDATA, 'npm/node_modules/promptfoo/node_modules/playwright-core'));
const browser = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const [out = 'backend/jobs/_compare-finale', url = 'http://127.0.0.1:8017/compare.html?upload=mock&api=http://127.0.0.1:8218'] = process.argv.slice(2);
(async () => {
 fs.mkdirSync(out, { recursive: true });
 const b = await chromium.launch({ headless: true, executablePath: browser, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
 const page = await b.newPage({ viewport: { width: 1500, height: 950 } }), errors = [], builds = [];
 page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
 page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/live/build')) builds.push(r.postDataJSON()); });
 const poll = async (fn, ms = 90000) => { const end = Date.now()+ms; while (Date.now()<end) { if (await fn()) return; await page.waitForTimeout(150); } throw Error('Timed out waiting for replay state'); };
 try {
  await page.goto(url); await poll(() => page.evaluate(() => !document.querySelector('#run').disabled)); await page.click('#run'); console.log('build started');
  await poll(() => page.evaluate(() => document.body.classList.contains('results'))); console.log('results reached');
  await poll(() => page.evaluate(() => !!document.querySelector('#lite .viewer canvas') && !!document.querySelector('#basic iframe') && !!document.querySelector('#advanced iframe')));
  const basic = page.frameLocator('#basic iframe'), advanced = page.frameLocator('#advanced iframe');
  console.log('frames present'); await poll(async () => (await basic.locator('#info').textContent({timeout: 3000})).includes('scene points')); console.log('basic loaded');
  await poll(async () => await advanced.locator('#view').getAttribute('aria-busy') === 'false'); await poll(() => page.evaluate(() => !!document.querySelector('#lite .lite-controls output')?.textContent)); console.log('advanced and Lite loaded');
  await page.evaluate(() => document.querySelector('#results').scrollIntoView({block:'start'})); await page.screenshot({ path: path.join(out,'results.png') });
  await page.click('#lite .viewer-cover'); const lite = page.locator('#lite .viewer canvas'), scrub = page.locator('#lite .lite-scrub');
  await scrub.evaluate(el => { el.value = 0; el.dispatchEvent(new Event('input')); }); const first = await lite.screenshot({ path: path.join(out,'lite-first.png') });
  await scrub.evaluate(el => { el.value = el.max; el.dispatchEvent(new Event('input')); }); const last = await lite.screenshot({ path: path.join(out,'lite-last.png') });
  if (first.equals(last)) throw Error('Lite scrub did not change image');
  await page.click('#lite .lite-play'); await page.waitForTimeout(300); const played = Number(await scrub.inputValue()); await page.click('#lite .lite-play'); if (played <= 0 || played >= Number(await scrub.getAttribute('max'))) throw Error('Lite playback did not advance'); await scrub.evaluate(el => { el.value = el.max; el.dispatchEvent(new Event('input')); });
  const box = await lite.boundingBox(); await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.wheel(0,-500); await page.waitForTimeout(200); const zoom = await lite.screenshot({ path: path.join(out,'lite-zoom.png') }); if (last.equals(zoom)) throw Error('Lite zoom did not change image');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down(); await page.mouse.move(box.x+box.width/2+70,box.y+box.height/2+30,{steps:8}); await page.mouse.up(); const pan = await lite.screenshot({path:path.join(out,'lite-pan.png')}); if (zoom.equals(pan)) throw Error('Lite pan did not change image');
  await page.keyboard.press('Escape'); if (await page.locator('#lite .viewer-cover').isHidden()) throw Error('Escape failed to release Lite');
  await page.click('#basic .viewer-cover'); const cloud = basic.locator('#view'); const before = await cloud.screenshot({path:path.join(out,'basic-before.png')}); await cloud.evaluate(el => { window._dragEvents = []; for (const type of ['pointerdown','pointermove','pointerup']) el.addEventListener(type, () => window._dragEvents.push(type)); }); const cb = await cloud.boundingBox(); console.log('cloud box', JSON.stringify(cb), 'cover hidden', await page.locator('#basic .viewer-cover').isHidden(), 'hit', await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.outerHTML.slice(0,200), {x: cb.x+cb.width/2, y: cb.y+cb.height/2})); await page.mouse.move(cb.x+cb.width/2,cb.y+cb.height/2); await page.mouse.down(); await page.mouse.move(cb.x+cb.width/2+100,cb.y+cb.height/2+30,{steps:10}); await page.mouse.up(); await page.waitForTimeout(800); const after = await cloud.screenshot({path:path.join(out,'basic-after.png')}); console.log('cloud events', await cloud.evaluate(() => window._dragEvents)); if (before.equals(after)) throw Error('Basic orbit did not change image');
  await page.keyboard.press('Escape'); if (await page.locator('#basic .viewer-cover').isHidden()) throw Error('Escape failed to release Basic');
  await page.click('#advanced .viewer-cover'); await advanced.locator('#view').screenshot({path:path.join(out,'advanced.png')});
  await page.waitForTimeout(1000); const state = await page.evaluate(() => ({ seconds: [...document.querySelectorAll('.column')].map(c => c.dataset.finished), fail: document.querySelector('#fail').textContent }));
  console.log(JSON.stringify({state,errors,builds})); if (errors.length || builds.length !== 1 || builds[0].tier !== 'advanced' || state.fail) throw Error('Replay reported errors');
 } catch (error) { console.error('Page diagnostics:', JSON.stringify({ errors, state: await page.evaluate(() => ({ fail: document.querySelector('#fail')?.textContent, setup: document.querySelector('#setupNote')?.textContent, upload: document.querySelector('#uploadNote')?.textContent })).catch(() => null) })); throw error; } finally { await page.close(); await b.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
