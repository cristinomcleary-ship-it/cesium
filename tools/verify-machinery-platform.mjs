// Actual platform route, isolated SQLite/data, shipped model assets and one Viewer.
// Requires Playwright with an installed WebGL2-capable Chromium; no real project files are read.
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const launchOptions = process.env.BROWSER_LAUNCH_OPTIONS
  ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
  : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined };
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
const out='output/machinery-integration';await mkdir(out,{recursive:true});
await mkdir('tmp',{recursive:true});
const dataDir=await mkdtemp(resolve('tmp/machinery-platform-'));
for (const key of ['CESIUM_DATA_DIR','CESIUM_MANAGEMENT_DATA_DIR','CESIUM_SAFETY_DATA_DIR']) process.env[key]=dataDir;
const server=await createServer({server:{host:'127.0.0.1',port:5208,strictPort:true,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch(launchOptions);const page=await browser.newPage({viewport:{width:1600,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const report={classification:'actual-platform-ui-with-isolated-test-data-and-original-machinery-assets',renderer:'Chromium SwiftShader WebGL2',checks:[],errors};
const panel=page.locator('.machinery-panel');const action=name=>panel.locator(`[data-action="${name}"]`);const field=key=>panel.locator(`[data-parameter="${key}"]`);const coord=key=>panel.locator(`[data-placement="${key}"]`);const state=()=>page.evaluate(()=>__managementWorkspace.ui.getSnapshot());
async function ready(){await page.waitForFunction(()=>window.__managementWorkspace?.ui?.getSnapshot()&&!__managementWorkspace.ui.loading&&!__managementWorkspace.ui.refreshing,{},{timeout:60000});}
async function open(){await page.locator('[data-mg-action="mode-scene"]:visible').first().click();await page.locator('[data-mg-action="machinery"]:visible').click();await panel.waitFor({state:'visible'});}
async function saved(){const r=page.waitForResponse(r=>r.url().endsWith('/__management/commands')&&r.request().postDataJSON().type==='machinery.save');await action('save').click();const response=await r;assert.equal(response.status(),200,await response.text());await page.waitForFunction(()=>!__managementWorkspace.machinery.busy);}
try{
await page.goto('http://127.0.0.1:5208/?screen=management',{waitUntil:'domcontentloaded',timeout:60000});await ready();await open();
const resources=[];
for(const [index,assetId]of ['crane','pile','excavator'].entries()){
 const name='平台接入验收-'+assetId+'-'+Date.now();await panel.locator('[data-role="create-name"]').fill(name);await action('create').click();
 await page.waitForFunction(name=>__managementWorkspace.ui.getSnapshot().collections.resources.some(r=>r.name===name)&&!__managementWorkspace.machinery.busy&&!__managementWorkspace.machinery.loading,name,{timeout:30000});
 const resource=(await state()).collections.resources.find(r=>r.name===name);resources.push(resource.id);
 await panel.locator('[data-role="asset"]').selectOption(assetId);await page.waitForFunction(()=>!__managementWorkspace.machinery.loading);
 await field('overall_scale').fill(assetId==='excavator'?'1':'4');await coord('longitude').fill(String(116.391+index*.00013));await coord('latitude').fill('39.907');await coord('height').fill('0');await coord('heading').fill(String(index*90));await saved();
 const current=(await state()).collections.resources.find(r=>r.id===resource.id);assert.equal(current.machinery.assetId,assetId);assert.equal(current.machinery.parameters.overall_scale,assetId==='excavator'?1:4);assert.equal(current.machinery.placement.height,0);
 report.checks.push('UI create/place/scale/save '+assetId);console.log('PASS',report.checks.at(-1));
}
await page.evaluate(async()=>{const C=await import('/node_modules/.vite/deps/cesium.js');const v=__safetyWorkspace.options.viewer;v.imageryLayers.removeAll();v.scene.globe.baseColor=C.Color.fromCssColorString('#344553');v.scene.globe.enableLighting=false;v.camera.lookAt(C.Cartesian3.fromDegrees(116.39113,39.907,0),new C.HeadingPitchRange(-.7,-.43,100));v.camera.lookAtTransform(C.Matrix4.IDENTITY);v.scene.requestRender();});
await page.waitForTimeout(1500);await action('close').click();await page.screenshot({path:out+'/three-machines.png'});
await page.locator('[data-mg-action="machinery"]:visible').click();await panel.locator('[data-role="resource"]').selectOption(resources[0]);await page.waitForFunction(()=>!__managementWorkspace.machinery.loading);
const original=Number(await field('boom_length_m').inputValue());await field('boom_length_m').fill(String(original*1.5));await page.waitForTimeout(350);assert.ok(Math.abs(Number(await field('overall_scale').inputValue())-6)<1e-8);await action('cancel').click();await page.waitForFunction(()=>!__managementWorkspace.machinery.loading);assert.equal(Number(await field('overall_scale').inputValue()),4);report.checks.push('cancel linked draft restores saved dimensions');
await panel.locator('[data-role="proportional"]').uncheck();await field('boom_length_m').fill(String(original*1.25));await page.waitForTimeout(350);assert.equal(Number(await field('overall_scale').inputValue()),4);await saved();report.checks.push('crane independent boom edit persists body scale');
await action('locate').click();await page.waitForTimeout(1600);
await page.screenshot({path:out+'/crane-controls.png'});
const before=(await state()).collections.resources.filter(r=>resources.includes(r.id)).map(r=>({id:r.id,machinery:r.machinery}));await page.reload({waitUntil:'domcontentloaded'});await ready();await open();
const after=(await state()).collections.resources.filter(r=>resources.includes(r.id)).map(r=>({id:r.id,machinery:r.machinery}));assert.deepEqual(after,before);report.checks.push('browser reload restores all exact model parameters/placements');
await panel.locator('[data-role="resource"]').selectOption(resources[2]);await page.waitForFunction(()=>!__managementWorkspace.machinery.loading);await field('body_height_m').fill('18');await page.waitForTimeout(350);assert.ok(Math.abs(Number(await field('overall_scale').inputValue())-18/3.04186663301146)<1e-8);await saved();report.checks.push('excavator body-height drives whole-machine scale');
await action('remove').click();await action('confirm-discard').click();await page.waitForFunction(id=>!__managementWorkspace.ui.getSnapshot().collections.resources.find(r=>r.id===id)?.machinery,resources[2]);assert.ok((await state()).collections.resources.some(r=>r.id===resources[2]));report.checks.push('remove keeps equipment ledger');
assert.equal(await page.locator('#cesiumContainer canvas').count(),1);report.checks.push('one existing Cesium Viewer canvas');assert.deepEqual(errors,[]);report.result='passed';console.log(JSON.stringify(report));
}catch(e){report.result='failed';report.failure=String(e.stack||e);console.error(e);await page.screenshot({path:out+'/failure.png'}).catch(()=>{});console.log((await panel.innerText().catch(()=>'' )).slice(-1600));process.exitCode=1;}finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close();await server.close();}
