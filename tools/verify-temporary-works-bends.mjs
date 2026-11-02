// Run from the project root after npm run build. Set PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE if needed.
// BEND_PREVIEW_DIST may point at an installer build. --baseline expects an error in the prior release.
// --dense-budget exercises the compact S-turn file. BEND_FIELD_CASE can point at external DWG settings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { preview } from 'vite';
import { dxf, surface, lon, lat } from './fixtures/temporary-works-survey.mjs';

const baseline = process.argv.includes('--baseline');
const denseBudget = process.argv.includes('--dense-budget');
// A private field file is supplied externally. Do not put field coordinates or a DWG in the test bundle.
const fieldCase = process.env.BEND_FIELD_CASE ? JSON.parse(await readFile(process.env.BEND_FIELD_CASE,'utf8')) : null;
const output = resolve(process.env.BEND_VERIFY_OUT || 'output/temporary-works-bends');
const directory = await mkdtemp(join(tmpdir(), 'cesium-road-bends-'));
await mkdir(output, { recursive: true });
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = directory;

// The field case surveys a small real model near its first straight and must discard the rest of the road.
const tile = fieldCase ? surface(20, 8, -4, 12) : surface(60, 8);
const fixture = resolve('public/examples/temporary-road-'+(denseBudget?'dense-bends':'bends')+'.dxf');
const report = { baseline, denseBudget, fieldCase:Boolean(fieldCase), checks: [], pageErrors: [], rendererErrors: [] };
const near = (a,b,delta) => assert(Math.abs(a-b)<=delta, `${a} expected ${b} ± ${delta}`);
let server, browser, page;
const field = key => page.locator('#tw-'+key);

async function check(label, fn) {
  console.log('CHECK', label);
  const evidence = await fn();
  report.checks.push({label,evidence});
  console.log('PASS',label,JSON.stringify(evidence));
}
async function configure(name, layer, file = fixture, options = {}) {
  await field('name').fill(name);
  await field('cad').setInputFiles(file);
  const layerOption = field('layer').locator('option').filter({hasText:layer}).first();
  await layerOption.waitFor({state:'attached'});
  await field('layer').selectOption(await layerOption.getAttribute('value'));
  const opt = field('feature').locator('option:not([value=""])').first();
  await opt.waitFor({state:'attached'});
  await field('feature').selectOption(options.feature ?? await opt.getAttribute('value'));
  await field('unit').selectOption('m');
  await field('coord').selectOption('local');
  const values = { 'anchor-x':0,'anchor-y':0,'anchor-lon':lon,'anchor-lat':lat,rotation:0,
    finished:0,width:4,thickness:0.5,treatment:0.5,'slope-height':1,'slope-width':1,grid:denseBudget?5:3, ...options.values };
  // Old releases expose a manually selected reference. Current roads anchor the first directed position.
  if (await field('ref-mode').isVisible()) {
    await field('ref-mode').selectOption('cad');
    await field('ref-x').fill(String(options.reference?.x ?? 0));
    await field('ref-y').fill(String(options.reference?.y ?? 0));
  }
  for (const [key,value] of Object.entries(values)) await field(key).fill(String(value));
}
async function compute() {
  await field('confirmed').check(); await field('run').click();
  const watch=setInterval(()=>field('status').textContent().then(status=>console.log('PROGRESS',status)).catch(()=>{}),30000);
  try {
    await page.waitForFunction(()=>!document.getElementById('tw-save').disabled || document.getElementById('tw-status').hasAttribute('data-error'),undefined,{timeout:fieldCase?1800000:480000});
  } finally { clearInterval(watch); }
  return {ok:!(await field('save').isDisabled()), message:await field('status').innerText()};
}
async function save(name) {
  await field('save').click();
  await page.waitForFunction(n=>document.getElementById('tw-plans').textContent.includes(n),name);
  return page.evaluate(async n=>{
    const db = await new Promise((ok,fail)=>{
      const r=indexedDB.open('cesium-temporary-works-v1');
      r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);
    });
    try {
      return await new Promise((ok,fail)=>{
        const r=db.transaction('plans').objectStore('plans').getAll();
        r.onsuccess=()=>ok(r.result.find(row=>row.plan.name===n)?.plan);r.onerror=()=>fail(r.error);
      });
    } finally { db.close(); }
  },name);
}

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  server = await preview({build:{outDir:resolve(process.env.BEND_PREVIEW_DIST || 'dist')},plugins:[
    {name:'bend-survey-fixture',configurePreviewServer(vite) {
      vite.middlewares.use('/__bend_test/',(req,res,next)=>{
        if(req.url!=='/tileset.json' && req.url!=='/surface.glb') return next();
        const json=req.url==='/tileset.json';
        res.setHeader('Content-Type', json?'application/json':'model/gltf-binary');
        res.end(json?JSON.stringify(tile.tileset):tile.glb);
      });
    }}],preview:{host:'127.0.0.1',port:0}});
  const origin = 'http://127.0.0.1:'+server.httpServer.address().port;
  report.entry = (await (await fetch(origin+'/')).text()).match(/src="(\/assets\/main-[^"]+\.js)"/)?.[1];
  assert(report.entry,'Expected a production build');
  browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,
    args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  page=await context.newPage();page.setDefaultTimeout(60000);
  const workers = new Set();
  page.on('worker', worker => {
    const path = new URL(worker.url()).pathname;
    if (/\/assets\/temporaryWorksRoad\.worker-[^/]+\.js$/.test(path)) workers.add(path);
  });
  page.on('pageerror',e=>report.pageErrors.push(e.message));
  page.on('console',m=>{if(/INVALID_(?:OPERATION|FRAMEBUFFER_OPERATION)|object does not belong to this context/i.test(m.text()))report.rendererErrors.push(m.text());});
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:90000});
  await page.locator('#tw-run').waitFor({state:'attached',timeout:90000});
  await page.locator('#basemap').selectOption('none');
  await page.locator('[data-tab="tiles"]').click();
  await page.locator('#tilesUrl').fill(origin+'/__bend_test/tileset.json');await page.locator('#loadTiles').click();
  await page.waitForFunction(()=>document.querySelectorAll('#tw-model option').length>=2,undefined,{timeout:90000});
  await page.locator('[data-tab="temporary-works"]').click();
  await field('kind').selectOption('road');

  if(denseBudget && !baseline && !fieldCase) await check('便道分批实景采样时可以取消并重算',async()=>{
    await configure('待取消路线','ROAD_BUDGET_S');
    await field('confirmed').check();await field('run').click();
    await page.waitForFunction(()=>document.getElementById('tw-status').textContent.includes('读取路基表面'),undefined,{timeout:90000});
    const progress=await field('status').innerText();await field('cancel').click();
    await page.waitForFunction(()=>document.getElementById('tw-status').textContent.includes('已取消') &&
      !document.querySelector('iframe[title="临建摄影取样"]'),undefined,{timeout:15000});
    assert(await field('save').isDisabled());assert.equal(await page.locator('[data-plan-id]').count(),0);
    return {progress,message:await field('status').innerText()};
  });
  if(fieldCase) for(const spacing of fieldCase.spacings) {
    await check('原始 DWG '+spacing+' m',async()=>{
      const name='现场便道验收 '+spacing+' m', {anchor,section}=fieldCase;
      await configure(name,fieldCase.layer,resolve(fieldCase.file),{feature:fieldCase.feature,reference:anchor,values:{
        'anchor-x':anchor.x,'anchor-y':anchor.y,
        width:section.width,thickness:section.pavement,treatment:section.treatment,grid:spacing,
      }});
      const route=await field('road-length').innerText();
      near(Number(route.replace(/[^0-9.,]/g,'').replaceAll(',','')),fieldCase.length,.001);
      const started=Date.now();
      const result=await compute(), seconds=(Date.now()-started)/1000;
      if(baseline) {
        assert.equal(result.ok,false);
        assert.match(result.message,/采样预算|采样上限|采样点过多|超过.*(?:采样|上限)/);
        return {route,width:section.width,spacing,seconds,error:result.message};
      }
      assert(result.ok,result.message);
      const p=await save(name), {planArea,coveredArea,excludedArea,cutVolume,fillVolume}=p.metrics;
      near(p.inputs.road.length,fieldCase.length,.001);near(p.inputs.reference.height,58,.08);
      assert(coveredArea>100 && excludedArea>100 && coveredArea < planArea);
      if(fieldCase.formationArea) near(planArea,fieldCase.formationArea,.5);
      if(fieldCase.pavementArea) near(p.inputs.road.pavementArea,fieldCase.pavementArea,.5);
      if (fieldCase.expectedCoveredArea) {
        // At mixed model edges two refinement levels leave a residual strip up to one mesh edge.
        near(coveredArea,fieldCase.expectedCoveredArea,spacing*(section.width+2)+1);
      }
      near(coveredArea+excludedArea,planArea,.01);
      near(cutVolume,coveredArea*(section.pavement+section.treatment),coveredArea*.002);
      near(fillVolume,0,.01);assert(p.inputs.road.samplingBatches>1);assert(p.mesh.triangles.length>0);
      assert(p.mesh.vertices.every(v=>Number.isFinite(v.groundHeight)&&Number.isFinite(v.formationHeight)));
      return {route,spacing,width:section.width,seconds,samples:p.inputs.sampleCount,batches:p.inputs.road.samplingBatches,triangles:p.mesh.triangles.length,
        planArea,coveredArea,excludedArea,cutVolume,fillVolume};
    });
  }
  else for(const layer of denseBudget?['ROAD_BUDGET_S']:['SHORT_LEGS','ARC_R1']) {
    await check(layer,async()=>{
      const name='转弯验收 '+layer;
      await configure(name, layer);
      if(layer==='SHORT_LEGS') {
        await field('add-grade').click();
        const rows=field('grades').locator('[data-grade-row]');
        for(const [i,range] of [[0,[0,20.25,2]],[1,[20.25,40.25,-1]]])
          for(const [j,k] of ['start','end','gradePct'].entries()) await rows.nth(i).locator('[data-grade-field="'+k+'"]').fill(String(range[j]));
      }
      const result=await compute();
      if(baseline) {
        assert.equal(result.ok,false);assert.match(result.message,denseBudget?/弯道网格超过采样预算/:/自交或重叠/);
        return {error:result.message};
      }
      assert(result.ok,result.message);
      const p=await save(name);assert(p);
      const curved=layer==='ARC_R1' || denseBudget;
      // Ideal compact quarter-bend with butt caps. The two tangent rectangles overlap over (r-R)²,
      // and the exposed exterior is a quarter disk. CAD arcs are internally tessellated for rendering.
      const area=denseBudget ? 44*6+6*(4*Math.PI-4) : curved ? (39*6-4+Math.PI*4) : 40.25*6;
      near(p.inputs.road.length, denseBudget?44+3*Math.PI:curved?39+Math.PI/2:40.25,0.001);
      near(p.metrics.planArea,area,curved?0.13:0.002);
      near(p.metrics.coveredArea,p.metrics.planArea,0.001);near(p.metrics.excludedArea,0,0.001);
      assert(p.mesh.triangles.length>0);assert(p.mesh.vertices.every(v=>Number.isFinite(v.surfaceHeight) && Number.isFinite(v.formationHeight)));
      near(p.metrics.fillVolume,0,0.01);
      if(curved) near(p.metrics.cutVolume,area,0.2);
      else {
        const crest=p.mesh.vertices.filter(v=>Math.abs(v.roadOffset)<1e-6 && Math.abs(v.roadStation-20.25)<1e-6);
        assert(crest.length>0,'缺少弯心变坡断面');
        for(const v of crest) near(v.surfaceHeight-p.inputs.reference.height,0.405,0.01);
        assert(p.metrics.cutVolume>0 && p.metrics.cutVolume<p.metrics.coveredArea);
      }
      if(denseBudget) { near(p.inputs.road.pavementArea,44*4+6*(9*Math.PI/4-1),.14);assert(p.inputs.road.samplingBatches>1); }
      return {samples:p.inputs.sampleCount,batches:p.inputs.road.samplingBatches,length:p.inputs.road.length,expectedArea:area,area:p.metrics.coveredArea,cut:p.metrics.cutVolume,
        fill:p.metrics.fillVolume,triangles:p.mesh.triangles.length,grades:p.inputs.road.grades};
    });
  }
  if(!baseline && fieldCase) await check('原始 DWG 方案刷新复核', async()=>{
    await page.reload({waitUntil:'domcontentloaded',timeout:90000});await page.locator('[data-tab="temporary-works"]').click();
    for(const spacing of fieldCase.spacings) {
      const name='现场便道验收 '+spacing+' m';
      await page.locator('[data-plan-id]').filter({hasText:name}).locator('[data-tw-action="inspect"]').click();
      assert.match(await field('metrics').innerText(),/处理底设计占地/);
    }
    return {readback:fieldCase.spacings};
  });
  if(!baseline && denseBudget && !fieldCase) await check('连续弯道分段纵坡且超出模型区域自动舍弃', async()=>{
    const name='连续弯道部分覆盖与变坡';
    // Shift the test drawing 36 m east, so the fixed model ends at CAD x=24 m.
    await configure(name,'ROAD_BUDGET_S',fixture,{values:{'anchor-x':-36}});
    await field('add-grade').click();
    const rows=field('grades').locator('[data-grade-row]'), length=44+3*Math.PI;
    for (const [i,range] of [[0,[0,8,2]],[1,[8,length.toFixed(6),-1]]])
      for(const [j,k] of ['start','end','gradePct'].entries()) await rows.nth(i).locator('[data-grade-field="'+k+'"]').fill(String(range[j]));
    const result=await compute();assert(result.ok,result.message);
    const p=await save(name),m=p.metrics;
    near(p.inputs.road.length,length,.001);near(p.inputs.road.grades[1].start,8,.001);
    assert(m.coveredArea>130 && m.excludedArea>60);near(m.planArea,m.coveredArea+m.excludedArea,.001);
    near(m.fillVolume,0,.001);assert(m.cutVolume>0);
    assert(p.inputs.refinementLevels>0);
    const core=p.mesh.vertices.filter(v=>v.roadPart==='core');
    assert(core.some(v=>v.roadStation<8));assert(core.some(v=>v.roadStation>8));
    for(const v of core) {
      const h=.02*Math.min(v.roadStation,8)-.01*Math.max(v.roadStation-8,0);
      near(v.surfaceHeight-p.inputs.reference.height,h,.002);
    }
    return {covered:m.coveredArea,excluded:m.excludedArea,cut:m.cutVolume,samples:p.inputs.sampleCount,batches:p.inputs.road.samplingBatches,levels:p.inputs.refinementLevels,grades:p.inputs.road.grades};
  });
  if(!baseline && !fieldCase) await check('异高交叉路线指出冲突区段', async()=>{
    const file=dxf('crossing.dxf',[{layer:'CROSS',points:[[0,0],[16,16],[0,16],[16,0]]}]);
    await configure('不应保存的交叉路线','CROSS',file);
    await field('grades').locator('[data-grade-field="gradePct"]').fill('5');
    const r=await compute();assert.equal(r.ok,false);
    assert.match(r.message,/交叉|重叠|冲突/);
    const markers=page.locator('[data-road-conflict-segment]'),details=page.locator('[data-road-conflict-details]');
    assert.equal(await markers.count(),2);
    const caption=await details.innerText();
    assert.match(caption,/K0\+011\.31/);assert.match(caption,/K0\+049\.94/);
    await field('remove-cad').click();
    assert.equal(await markers.count(),0);assert.equal(await details.count(),0);
    return {message:r.message,caption};
  });
  if(!baseline && !fieldCase) await check('保存的转弯路基在刷新后可复核',async()=>{
    await page.reload({waitUntil:'domcontentloaded',timeout:90000});
    await page.locator('[data-tab="temporary-works"]').click();
    const row=page.locator('[data-plan-id]').filter({hasText:denseBudget?'转弯验收 ROAD_BUDGET_S':'转弯验收 ARC_R1'});
    await row.locator('[data-tw-action="inspect"]').click();
    const text=await field('metrics').innerText();
    assert.match(text,/处理底设计占地/);
    assert.match(text,denseBudget?/315/:/242/);
    return {storedArcReadback:true};
  });
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.rendererErrors,[]);
  assert.equal(await page.locator('.cesium-widget-errorPanel').count(),0);
  if (!baseline && (fieldCase || denseBudget)) {
    assert.equal(workers.size,1,'Expected the production road worker to run');
    report.worker = [...workers][0];
    const res = await fetch(origin+report.worker);
    assert.equal(res.status,200);
    report.workerSha256 = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
  }
  report.result='passed';
} catch(error) {
  report.result='failed'; report.error=String(error?.stack || error);console.error(report.error);
  if(page) report.status=await field('status').textContent({timeout:1000}).catch(()=>null);
  process.exitCode=1;
} finally {
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();await server?.close();await rm(directory,{recursive:true,force:true});
}
