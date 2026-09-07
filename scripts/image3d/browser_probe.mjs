// Isolated Chrome profile; tests only the dedicated loopback artifact viewer.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const job=path.resolve(process.argv[2]);
const port=Number(process.argv[3]||8876);
if (!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid viewer port');
const origin=`http://127.0.0.1:${port}`;
const hash=value=>createHash('sha256').update(value).digest('hex');
const expectedGlb=hash(await fs.readFile(path.join(job,'textured.glb')));
const response=await fetch(origin+'/scene.glb',{redirect:'error'});
if(!response.ok||hash(Buffer.from(await response.arrayBuffer()))!==expectedGlb)
  throw new Error('Viewer is serving a different GLB than the selected job');
const browser=await chromium.launch({
  executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,
});
const failures=[];
try {
  const context=await browser.newContext({viewport:{width:1400,height:1000}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin
    ? route.continue():route.abort());
  const page=await context.newPage();
  page.on('pageerror',error=>failures.push(error.message));
  await page.goto(origin,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.image3dEvidence?.loaded,{},{timeout:30000});
  const loaded=await page.evaluate(()=>window.image3dEvidence);
  if (loaded.errors.length||!loaded.textures||loaded.triangles>150000)
    throw new Error(`GLB load contract failed: ${JSON.stringify(loaded)}`);
  const canvas=page.locator('#canvas canvas');
  const before=await canvas.screenshot();
  await page.screenshot({path:path.join(job,'browser-front.png'),fullPage:true});
  const box=await canvas.boundingBox();
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*.8,box.y+box.height*.5,{steps:20});
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after=await canvas.screenshot();
  await page.screenshot({path:path.join(job,'browser-rotated.png'),fullPage:true});
  if (hash(before)===hash(after)) throw new Error('Rotating the model did not change the canvas');
  if(failures.length) throw new Error(failures.join('\n'));
  await fs.writeFile(path.join(job,'browser-report.json'),JSON.stringify({
    ...loaded,glbSha256:expectedGlb,browser:await browser.version(),rotationThisRun:true,
    beforeCanvasSha256:hash(before),afterCanvasSha256:hash(after),
    pageErrors:failures,completeVisualAcceptance:false,
    note:'Real browser load and drag; does not establish photo reconstruction quality.'
  },null,2));
  await context.close();
  console.log('BROWSER_PROBE_OK');
} finally {
  await browser.close();
}
