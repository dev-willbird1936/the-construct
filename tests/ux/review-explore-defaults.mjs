// Read-only product experiment: use existing View switches, never change source defaults.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startReviewApp, restoreFetch, chromium, executablePath, identity, ROOT } from './local-review-app.mjs';
const dir=path.join(ROOT,'.planning/ux-hackathon/phase-04/explore-candidates',Date.now()+'-'+crypto.randomBytes(3).toString('hex'));
await fs.mkdir(dir,{recursive:true});const report={provenance:'Actual current app and existing View controls only; no source changes, models, publishing or production auth.',cases:[],errors:[],outside:[]};
let app,browser;
try{
 app=await startReviewApp();browser=await chromium.launch({headless:true,executablePath});
 for(const width of [1440,390])for(const variant of ['current','surroundings-off','quiet']){
  const context=await browser.newContext({viewport:{width,height:width===390?844:900},extraHTTPHeaders:identity,serviceWorkers:'block'});await app.browserGuard(context,report.outside);
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto(app.origin);await page.waitForTimeout(4200);
  if(variant!=='current'){
   const panel=page.locator('.toggles');if(!await panel.evaluate(e=>e.open))await panel.locator('summary').click();
   for(const key of variant==='quiet'?['construct','scene','edge','structure','worldlabs']:['worldlabs']){
    const control=page.locator(`[data-toggle=${key}]`);if(await control.getAttribute('aria-checked')==='true')await control.click();
   }
   await panel.locator('summary').click();await page.mouse.move(width*.5,(width===390?844:900)*.5);await page.waitForTimeout(1800);
  }
  const screenshot=path.join(dir,`${width}-${variant}.png`);await page.screenshot({path:screenshot});
  report.cases.push({width,variant,screenshot,cell:await page.locator('#cellCoord').innerText(),viewOpen:await page.locator('.toggles').evaluate(e=>e.open),settings:await page.locator('[data-toggle]').evaluateAll(es=>Object.fromEntries(es.map(e=>[e.dataset.toggle,e.getAttribute('aria-checked')]))),horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
  await context.close();
 }
 app.net.assertClean();report.spendRows=app.db.prepare('SELECT COUNT(*) AS n FROM spend').get().n;
}finally{if(browser)await browser.close();if(app)await app.stop();restoreFetch();await fs.writeFile(path.join(dir,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({dir,cases:report.cases.length,errors:report.errors,outside:report.outside},null,2));}
