/** Full Vite application smoke; every database/file path is isolated. Uses synthetic machinery and PDF fixtures only. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || pathToFileURL(`${runtimeModules}/playwright/index.mjs`).href);
await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/five-scope-smoke-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { dataDir, fixture: 'Synthetic crane at Beijing; tiny PDF fixtures. No original project media.', checks: [], pageErrors: [], consoleErrors: [] };
let browser, server, page, origin, machineId;
const mp = () => page.locator('.machinery-panel');
const rail = () => page.locator('.rail-safety-panel');
async function step(name, run) { console.log('RUN', name); try { const evidence = await run(); report.checks.push({ name, status: 'passed', evidence }); console.log('PASS', name); } catch (error) { report.checks.push({ name, status: 'failed', error: String(error.stack || error) }); throw error; } }
async function reveal(locator) {
  const ids = await locator.evaluate(control => { const ids=[]; for(let p=control.parentElement;p;p=p.parentElement) if(p.tagName==='DETAILS'&&!p.open&&p.id) ids.unshift(p.id); return ids; });
  for (const id of ids) { const button=page.locator(`button[aria-controls="${id}"]`); if(await button.count()) await button.click(); else await page.locator(`[id="${id}"] > summary`).click(); }
}
async function fill(selector, value) { const locator=mp().locator(selector); await reveal(locator); await locator.fill(String(value)); }
async function ready() { await page.waitForFunction(() => window.__managementWorkspace?.ui.getSnapshot()?.projectId, undefined, { timeout: 60000 }); }
async function save() {
  const response=page.waitForResponse(r=>r.url().endsWith('/__management/commands')&&r.request().postDataJSON()?.type==='machinery.save');
  await mp().locator('[data-action=save]').click(); const result=await response; assert.equal(result.status(),200,await result.text());
  await page.waitForFunction(()=>!window.__managementWorkspace.machinery.isBusy&&!window.__managementWorkspace.machinery.hasDraft);
}
async function modelReady() { await page.waitForFunction(id=>window.__managementWorkspace?.machinery.scene.rendered.has(id), machineId, { timeout: 30000 }); }
async function clickMachine() {
  const point=await page.evaluate(async id=>{
    const C=await import('/node_modules/.vite/deps/cesium.js'),w=window.__managementWorkspace,v=w.viewer;
    const entity=w.machinery.scene.rendered.get(id).entity;
    const sphere=new C.BoundingSphere(); v.dataSourceDisplay.getBoundingSphere(entity,false,sphere);
    const center=C.SceneTransforms.worldToWindowCoordinates(v.scene,sphere.center);
    const canvas=v.canvas,rect=canvas.getBoundingClientRect();
    for(let radius=0;radius<=120;radius+=8) for(let n=0;n<(radius?24:1);n++) {
      const angle=n*Math.PI/12,x=center.x+radius*Math.cos(angle),y=center.y+radius*Math.sin(angle);
      if(x<0||y<0||x>rect.width||y>rect.height)continue;
      if(v.scene.pick(new C.Cartesian2(x,y))?.id===entity)return {x:rect.x+x,y:rect.y+y,id:entity.id};
    }
    throw new Error('No real rendered machinery pixel found; center='+JSON.stringify(center));
  },machineId);
  await page.mouse.click(point.x,point.y);
  await rail().locator('.rs-documents').waitFor({state:'visible'});
  await page.waitForFunction(()=>!window.__managementWorkspace.railSafety.documents.session.loading);
  assert.equal(await rail().locator('[data-object-section=documents]').getAttribute('aria-pressed'),'true');
  return point;
}
try {
  server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false,watch:null}}); await server.listen(); origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1600,height:1000}}); page.setDefaultTimeout(20000);
  page.on('pageerror',e=>report.pageErrors.push(e.message)); page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text().slice(0,500));});
  await step('home-and-cad-categories',async()=>{
    await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000}); await ready();
    assert.equal(await page.locator('#cesiumContainer canvas').count(),1); assert.equal(await page.locator('.management-studio:visible').count(),0);
    await page.locator('.tab[data-tab=cad]').click(); const categories=page.locator('[data-panel=cad] .operation-categories button');
    assert.ok(await categories.count()>=3,'CAD has categorized controls');
    for(let i=0;i<await categories.count();i++) { await categories.nth(i).click(); assert.equal(await page.locator('[data-panel=cad] details.operation-category[open]').count(),1); }
    return {categories:await categories.allTextContents(),defaultRenderLoop:await page.evaluate(()=>window.__managementWorkspace.viewer.useDefaultRenderLoop)};
  });
  await step('create-place-save-crane-through-ui',async()=>{
    await page.locator('.tab[data-tab=machinery]').click(); await mp().waitFor({state:'visible'});
    await fill('[data-role=create-name]','五项改进验收吊机'); await mp().locator('[data-action=create]').click();
    await page.waitForFunction(()=>window.__managementWorkspace.machinery.asset&&!window.__managementWorkspace.machinery.loading&&!window.__managementWorkspace.machinery.busy);
    machineId=await page.evaluate(()=>window.__managementWorkspace.ui.getSnapshot().collections.resources.find(r=>r.name==='五项改进验收吊机').id);
    await fill('[data-parameter=overall_scale]',4); for(const [k,v] of Object.entries({longitude:116.391,latitude:39.907,height:5,heading:0})) await fill(`[data-placement=${k}]`,v);
    await save(); await modelReady();
    const locate=mp().locator('[data-action=locate]'); await reveal(locate); await locate.click();
    await page.waitForTimeout(1200); await mp().locator('[data-action=close]').click();
    return {machineId};
  });
  await step('real-scene-model-click-opens-four-document-categories',async()=>{
    const pixel=await clickMachine(); const labels=await rail().locator('[data-document-action=category]').allTextContents();
    assert.equal(labels.length,4); assert.ok(labels.some(t=>t.includes('机械性能'))); assert.ok(labels.some(t=>t.includes('合格证'))); assert.ok(labels.some(t=>t.includes('检测报告'))); assert.ok(labels.some(t=>t.includes('报验单')));
    return {pixel,labels};
  });
  await step('four-document-uploads-and-reopen',async()=>{
    for(const category of ['performance','certificate','inspection','submission']) {
      await rail().locator(`[data-document-action=category][data-category=${category}]`).click();
      const uploaded=page.waitForResponse(r=>r.url().includes('/__management/upload?')&&r.request().method()==='POST');
      await rail().locator('.rs-documents input[type=file]').setInputFiles({name:`smoke-${category}.pdf`,mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\n% synthetic smoke fixture\n%%EOF\n')});
      const result=await uploaded; assert.equal(result.status(),201,await result.text());
      await page.waitForFunction(()=>!window.__managementWorkspace.railSafety.isBusy&&!window.__managementWorkspace.railSafety.documents.session.loading);
      assert.equal(await rail().locator('.rs-document-card').count(),1);
    }
    await rail().locator('[data-action=close]').click(); await clickMachine();
    assert.equal(await rail().locator('[data-document-action=category]').count(),4);
    const records=await page.evaluate(()=>window.__managementWorkspace.railSafety.documents.session.records); assert.equal(records.length,4);
    return {uploaded:records.map(r=>({id:r.id,name:r.name,category:r.machineryDocumentCategory}))};
  });
  await step('original-fall-demo-and-parameter-edit',async()=>{
    await rail().locator('[data-action=section-analysis]').click(); const start=rail().locator('[data-action=fall-start]'); assert.equal(await start.isEnabled(),true); await start.click();
    await page.waitForFunction(()=>window.__managementWorkspace.railSafety.fallDemo?.active,undefined,{timeout:30000});
    await rail().locator('[data-action=fall-play]').click(); await page.waitForFunction(()=>window.__managementWorkspace.railSafety.fallDemo?.playing); await rail().locator('[data-action=fall-stop]').click();
    await rail().locator('[data-action=close]').click(); await page.locator('.tab[data-tab=machinery]').click(); await mp().waitFor({state:'visible'});
    await page.waitForFunction(()=>!window.__managementWorkspace.machinery.loading); await fill('[data-parameter=overall_scale]',3.5); await save();
    const value=await page.evaluate(id=>window.__managementWorkspace.ui.getSnapshot().collections.resources.find(r=>r.id===id).machinery.parameters.overall_scale,machineId); assert.equal(value,3.5);
    await mp().locator('[data-action=close]').click(); return {savedScale:value};
  });
  await step('delete-document-and-reload-restoration',async()=>{
    await clickMachine(); const record=await page.evaluate(()=>window.__managementWorkspace.railSafety.documents.session.records.find(r=>r.machineryDocumentCategory==='performance'));
    const originalUrl=await rail().locator('.rs-document-card a[download]').getAttribute('href');
    assert.equal((await page.request.get(origin+originalUrl)).status(),200);
    await rail().locator('[data-document-action=delete]').click(); const deletion=page.waitForResponse(r=>r.url().includes('/__management/files/')&&r.request().method()==='DELETE'); await rail().locator('[data-document-action=confirm-delete]').click(); assert.equal((await deletion).status(),200);
    await page.waitForFunction(()=>!window.__managementWorkspace.railSafety.isBusy&&!window.__managementWorkspace.railSafety.documents.session.loading);
    assert.equal(await rail().locator('.rs-document-card').count(),0); assert.equal((await page.request.get(origin+originalUrl)).ok(),false,'Deleted document is no longer readable');
    await page.reload({waitUntil:'domcontentloaded'}); await ready(); await modelReady();
    await page.locator('.tab[data-tab=machinery]').click(); await mp().waitFor({state:'visible'}); await page.waitForFunction(()=>!window.__managementWorkspace.machinery.loading);
    const locate=mp().locator('[data-action=locate]'); await reveal(locate); await locate.click(); await page.waitForTimeout(1200); await mp().locator('[data-action=close]').click(); await clickMachine();
    const records=await page.evaluate(()=>window.__managementWorkspace.railSafety.documents.session.records); assert.equal(records.length,3); assert.equal(records.some(r=>r.id===record.id),false);
    const files=await readdir(resolve(dataDir,'management-files')); assert.equal(files.length,3,'Only three physical uploaded files remain'); return {remainingRecords:records.length,remainingFiles:files.length};
  });
  await step('browser-runtime-clean',async()=>{assert.deepEqual(report.pageErrors,[]); assert.equal(await page.evaluate(()=>window.__managementWorkspace.viewer.useDefaultRenderLoop),true); return {consoleErrors:report.consoleErrors};});
  report.result='passed';
} catch(error) { report.result='failed'; report.failure=String(error.stack||error); console.error(error); if(page) { report.visibleText=(await page.locator('body').innerText().catch(()=>'' )).slice(-7000); await page.screenshot({path:resolve(dataDir,'failure.png')}).catch(()=>{}); } process.exitCode=1; }
finally { await writeFile(resolve(dataDir,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); await browser?.close(); await server?.close(); }
