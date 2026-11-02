// Production acceptance. Set TW_RELEASE_DIST, PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE when needed.
// TW_FIELD_CASE optionally names a private JSON fixture (file, layer, feature, anchor, length).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import proj4 from 'proj4';
import { preview } from 'vite';
import { dxf, surface, lon, lat, transform } from './fixtures/temporary-works-survey.mjs';

const directory = await mkdtemp(join(tmpdir(), 'cesium-placement-'));
const output = resolve(process.env.TW_PLACEMENT_OUT || 'output/temporary-works-placement');
const privateCase = process.env.TW_FIELD_CASE ? JSON.parse(await readFile(process.env.TW_FIELD_CASE,'utf8')) : null;
await mkdir(output, {recursive:true});
for (const k of ['CESIUM_DATA_DIR','CESIUM_MANAGEMENT_DATA_DIR','CESIUM_SAFETY_DATA_DIR']) process.env[k]=directory;
const facilitiesOnly = process.argv.includes('--facilities-only');
const tile = facilitiesOnly ? surface(65,8,-65,50,.025) : surface(35,8,-16,25,.075);
const x=514000,y=3402000, angle=25*Math.PI/180;
const road = dxf('工程坐标验收.dxf', [
  {layer:'ROAD', points:[[x,y],[x+10,y],[x+24,y]]},
  {layer:'FULL_MISS', points:[[x+80,y],[x+120,y+10],[x+135,y]]},
  {layer:'EXTERNAL_START', points:[[x+65,y],[x+10,y]]},
  {layer:'SITE',closed:true,points:[[x-2,y-4],[x+50,y-4],[x+50,y+4],[x-2,y+4]]},
  {layer:'BUILDING',closed:true,points:[[x+4,y-2],[x+11,y-2],[x+11,y+2],[x+4,y+2]]},
]);
const bLoc = Cartographic.fromCartesian(Matrix4.multiplyByPoint(transform,new Cartesian3(24*Math.cos(angle),24*Math.sin(angle),0),new Cartesian3()));
const second = [CesiumMath.toDegrees(bLoc.longitude),CesiumMath.toDegrees(bLoc.latitude)];
// A survey model placed using an explicit TEST meridian. This makes no assumptions about a field project's meridian.
const gkAnchor = privateCase?.anchor ?? {x,y};
const testGk = '+proj=tmerc +lat_0=0 +lon_0=120 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const [gkLon,gkLat] = proj4(testGk,'EPSG:4326',[gkAnchor.x,gkAnchor.y]);
const projectedTile = surface(35,8,-16,25,.075);
projectedTile.tileset.root.transform = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(gkLon,gkLat,50)));
const report = {checks:[],pageErrors:[],rendererErrors:[]};
let server,browser,page;
const input=k=>page.locator('#tw-'+k);
const row=id=>page.locator('[data-plan-id="'+id+'"]');
const near=(v,w,tol)=>assert.ok(Number.isFinite(v) && Math.abs(v-w)<=tol,`${v} expected ${w} ±${tol}`);
async function check(label,fn) {
  console.log('CHECK',label);
  const evidence=await fn();
  report.checks.push({label,evidence});
  console.log('PASS',label,JSON.stringify(evidence));
}
async function fields(data) {
  for (const [key,value] of Object.entries(data)) await input(key).fill(String(value));
}
async function stored(name) {
  return page.evaluate(async n=>{
    const db=await new Promise((ok,fail)=>{
      const r=indexedDB.open('cesium-temporary-works-v1');r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);
    });
    try {
      return await new Promise((ok,fail)=>{
        const r=db.transaction('plans').objectStore('plans').getAll();
        r.onsuccess=()=>ok(r.result.find(x=>x.plan.name===n)?.plan); r.onerror=()=>fail(r.error);
      });
    } finally { db.close(); }
  },name);
}
async function selectCad(layer,file=road,feature) {
  await input('cad').setInputFiles(file);
  const opt=input('layer').locator('option').filter({hasText:layer}).first();
  await opt.waitFor({state:'attached'}); await input('layer').selectOption(await opt.getAttribute('value'));
  const target=input('feature').locator('option:not([value=""])').first();
  await target.waitFor({state:'attached'});await input('feature').selectOption(feature||await target.getAttribute('value'));
}
async function register(anchor={x,y}) {
  await input('coord').selectOption('local');await input('unit').selectOption('m');
  await fields({'anchor-x':anchor.x,'anchor-y':anchor.y,'anchor-lon':lon,'anchor-lat':lat,rotation:0});
}
async function overlay(expectCoverage=true) {
  await input('place-preview').click();
  await page.waitForFunction(()=>document.querySelector('#tw-overlay-status')?.dataset.state==='ready' ||
    document.querySelector('#tw-overlay-status')?.dataset.state==='error',undefined,{timeout:180000});
  const status=await input('overlay-status').evaluate(e=>({message:e.textContent,state:e.dataset.state,covered:Number(e.dataset.covered),samples:Number(e.dataset.samples)}));
  assert.equal(status.state,'ready',status.message);assert(status.samples>0 && (expectCoverage ? status.covered>0 : status.covered===0),status.message);
  return status;
}
async function withViewer(inspect, argument) {
  // Discover the live Viewer by its public prototype through the isolated test session.
  // Production intentionally leaves the viewer out of window and may minify its constructor name.
  const cdp=await page.context().newCDPSession(page), group='planning-acceptance-viewer';
  try {
    const {result:fnPrototype}=await cdp.send('Runtime.evaluate',{expression:'Function.prototype',objectGroup:group});
    const {objects:constructors}=await cdp.send('Runtime.queryObjects',{prototypeObjectId:fnPrototype.objectId,objectGroup:group});
    const {result:viewerPrototype}=await cdp.send('Runtime.callFunctionOn',{objectId:constructors.objectId,objectGroup:group,
      functionDeclaration:`function(){for(const fn of this){
        const p=Object.getOwnPropertyDescriptor(fn,'prototype')?.value;
        if(p && ['cesiumWidget','camera','entities','container'].every(k=>Object.getOwnPropertyDescriptor(p,k)?.get))return p;
      }}`});
    assert(viewerPrototype.objectId,'验收浏览器未发现 Cesium Viewer 原型');
    const {objects:viewers}=await cdp.send('Runtime.queryObjects',{prototypeObjectId:viewerPrototype.objectId,objectGroup:group});
    const {result,exceptionDetails}=await cdp.send('Runtime.callFunctionOn',{objectId:viewers.objectId,returnByValue:true,
      arguments:[{value:argument}], functionDeclaration:`function(arg){
        const v=this.find(v=>!v.isDestroyed() && v.container===document.getElementById('cesiumContainer'));
        if(!v)throw Error('验收浏览器未找到当前场景 Viewer');
        return (${inspect.toString()})(v,arg);
      }`});
    assert(!exceptionDetails,exceptionDetails?.exception?.description || exceptionDetails?.text);
    return result.value;
  } finally {
    try {await cdp.send('Runtime.releaseObjectGroup',{objectGroup:group});} finally {await cdp.detach();}
  }
}

// Check the polylines the production viewer draws and the sphere used by its locate button.
async function checkWholeCadOverlay({allMissing=false, expectedEnds, expectedLabels} = {}) {
  const display=await withViewer(viewer=>{
    const time=viewer.clock.currentTime;
    const entities=viewer.entities.values.filter(e=>e.isShowing), prefix='临建定位预览 · ';
    const axis=entities.filter(e=>e.name===prefix+'中心线（已测高）' || e.name===prefix+'中心线（未测高，仅线位）');
    const solid=axis.filter(e=>e.name===prefix+'中心线（已测高）'), dashed=axis.filter(e=>e.name===prefix+'中心线（未测高，仅线位）');
    const ends=['起点','终点'].map(name=>entities.find(e=>e.name===prefix+name));
    if(ends.some(e=>!e?.label || !e?.position))throw Error('图纸预览缺少原起点或原终点标记');
    const positions=axis.flatMap(e=>e.polyline.positions.getValue(time));
    if(!positions.length)throw Error('图纸预览没有绘制中心线');
    const endPositions=ends.map(e=>e.position.getValue(time));
    const dist=(p,q)=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z);
    const endGaps=endPositions.map(end=>positions.reduce((min,p)=>Math.min(min,dist(end,p)),Infinity));
    const camera=viewer.camera, fly=camera.flyToBoundingSphere;
    let sphere;
    camera.flyToBoundingSphere=function(s,...args){sphere=s;return fly.call(this,s,...args);};
    try {document.querySelector('#tw-place-zoom').click();} finally {camera.flyToBoundingSphere=fly;}
    if(!sphere || !Number.isFinite(sphere.radius))throw Error('定位到图纸未采用有效的包围球');
    const farthest=positions.reduce((max,p)=>Math.max(max,dist(p,sphere.center)),0);
    const counters=document.querySelector('#tw-overlay-status').dataset;
    return {solid:solid.length,dashed:dashed.length,solidTypes:solid.map(e=>e.polyline.material.getType(time)),
      dashedTypes:dashed.map(e=>e.polyline.material.getType(time)),reportedSolid:Number(counters.coveredAxisLines),
      reportedDashed:Number(counters.missingAxisLines),labels:ends.map(e=>e.label.text.getValue(time)),
      ends:endPositions.map(v=>[v.x,v.y,v.z]),endGaps,radius:sphere.radius,farthest};
  });
  assert.equal(display.solid,display.reportedSolid);assert.equal(display.dashed,display.reportedDashed);
  assert(display.dashed>0 && (allMissing ? display.solid===0 : display.solid>0),'覆盖内外线段没有按取样状态区分');
  assert(display.solidTypes.every(t=>t==='Color') && display.dashedTypes.every(t=>t==='PolylineDash'),'中心线实线或虚线材质不符');
  assert(display.endGaps.every(d=>d<1.5),'图纸中心线未延伸到原始两端');
  assert(display.farthest<=display.radius+.1,'定位到图纸的取景范围遗漏了部分线位');
  if(expectedLabels)assert.deepEqual(display.labels,expectedLabels);
  if(expectedEnds){
    const inv=Matrix4.inverseTransformation(transform,new Matrix4());
    display.ends.forEach((v,i)=>{
      const position=Matrix4.multiplyByPoint(inv,Cartesian3.fromArray(v),new Cartesian3());
      near(position.x,expectedEnds[i][0],.15);near(position.y,expectedEnds[i][1],.15);
    });
  }
  return {coveredLines:display.solid,missingLines:display.dashed,endpointLabels:display.labels,fitRadiusM:display.radius};
}
async function compute(expectedError=false) {
  await input('confirmed').check();await input('run').click();
  await page.waitForFunction(()=>!document.querySelector('#tw-save').disabled ||
    document.querySelector('#tw-status')?.hasAttribute('data-error'),undefined,{timeout:240000});
  const message=await input('status').innerText();
  assert.equal(await input('save').isDisabled(),expectedError,message);
  return message;
}
async function save(name) {
  await input('save').click();await page.waitForFunction(n=>document.querySelector('#tw-plans')?.textContent.includes(n),name);
  const rec=await stored(name);assert(rec);return rec;
}

try {
  const { chromium }=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  server=await preview({build:{outDir:resolve(process.env.TW_RELEASE_DIST||'dist')},plugins:[
    {name:'planning-graded-survey',configurePreviewServer(vite) {
      for (const [path,source] of [['/__placement_survey/',tile],['/__test_gk_survey/',projectedTile]]) vite.middlewares.use(path,(req,res,next)=>{
        if (req.url!=='/tileset.json' && req.url!=='/surface.glb') return next();
        const json=req.url==='/tileset.json';res.setHeader('Content-Type',json?'application/json':'model/gltf-binary');
        res.end(json?JSON.stringify(source.tileset):source.glb);
      });
    }}],preview:{host:'127.0.0.1',port:0}});
  const origin='http://127.0.0.1:'+server.httpServer.address().port;
  report.entry=(await (await fetch(origin+'/')).text()).match(/src="(\/assets\/main-[^"]+\.js)"/)?.[1];
  assert(report.entry,'expected a production bundle');
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,args:[
    '--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const context=await browser.newContext({viewport:{width:1500,height:1000},deviceScaleFactor:1.3});
  page=await context.newPage();page.setDefaultTimeout(60000);
  page.on('pageerror',e=>report.pageErrors.push(e.message));
  page.on('console',m=>{if(/INVALID_(?:OPERATION|FRAMEBUFFER_OPERATION)|object does not belong to this context/i.test(m.text()))report.rendererErrors.push(m.text());});
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:90000});await input('run').waitFor({state:'attached'});
  await page.locator('#basemap').selectOption('none');
  await page.locator('[data-tab="temporary-works"]').click();
  if (!facilitiesOnly && !process.argv.includes('--workflow-only')) for (const [kind,title] of [['camp','项目驻地'],['steel','钢筋']]) {
    await check(title+'实体参考模型预览', async()=>{
      await input('preview-'+kind).click();
      const dialog=page.locator('#tw-reference-dialog'),stage=dialog.locator('[data-tw-facility-preview]');
      await dialog.waitFor({state:'visible'});await dialog.locator('[data-tw-facility-preview] canvas, canvas[data-tw-facility-preview]').first().waitFor({state:'visible'});
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
      const box=await stage.boundingBox();assert(box.width>=400 && box.height>=240);
      await dialog.screenshot({path:join(output,kind+'-reference.png')});
      const caption=await dialog.innerText();assert.match(caption,new RegExp(title));
      await dialog.locator('[data-tw-reference-close]').click();await dialog.waitFor({state:'hidden'});
      return {caption,stageSize:[box.width,box.height],image:kind+'-reference.png'};
    });
  }
  if (facilitiesOnly) {
    const {verifyStandardFacilities}=await import('./fixtures/verify-standard-facilities.mjs');
    await verifyStandardFacilities({page,origin,input,selectCad,register,fields,save,stored,row,check,withViewer,output,x,y});
  } else if (!process.argv.includes('--references-only')) {
    await page.locator('[data-tab="tiles"]').click();
    await page.locator('#tilesUrl').fill(origin+'/__placement_survey/tileset.json');await page.locator('#loadTiles').click();
    await page.waitForFunction(()=>document.querySelectorAll('#tw-model option').length>=2,undefined,{timeout:90000});
    await page.locator('[data-tab="temporary-works"]').click();await input('kind').selectOption('road');
    if (privateCase) await check('原始 DWG 上模预览',async()=>{
      await selectCad(privateCase.layer,resolve(privateCase.file),privateCase.feature);await register(privateCase.anchor);
      await fields({width:6});const info=await overlay();
      near(Number((await input('road-length').innerText()).replace(/[^0-9.]/g,'')),privateCase.length,.001);
      assert(info.covered<info.samples,'现场图仅局部位于测试瓦片内');
      assert(await input('save').isDisabled());
      const preview=await checkWholeCadOverlay();
      await input('remove-cad').click();return {length:privateCase.length,...info,...preview};
    });
    await check('两控点配准、摄影模型上道路设计线预览', async()=>{
      await selectCad('ROAD'); await register();
      await input('b-x').locator('xpath=ancestor::details[1]').locator('summary').first().click();
      await fields({width:6,'b-x':x+24,'b-y':y,'b-lon':second[0],'b-lat':second[1]});
      await input('control-fit').click();near(Number(await input('rotation').inputValue()),25,.01);
      const info=await overlay();assert(await input('save').isDisabled());
      await input('place-zoom').click();await input('place-hide').click();
      return {fittedDegrees:Number(await input('rotation').inputValue()),...info};
    });
    const name='起点校准路面';
    let plan;
    await check('反向起点实景为零与两段纵坡',async()=>{
      await input('name').fill(name);await fields({finished:.3,thickness:.2,treatment:.3,'slope-height':1,'slope-width':1,grid:3});
      await input('add-grade').click();
      const grades=input('grades').locator('[data-grade-row]');
      for (const [i,[from,to,pct]] of [[0,[0,10,2]],[1,[10,24,-1]]])
        for (const [key,val] of [['start',from],['end',to],['gradePct',pct]]) await grades.nth(i).locator('[data-grade-field="'+key+'"]').fill(String(val));
      await input('reverse').click();assert.equal(await input('finished').inputValue(),'');
      await fields({finished:.45});await compute();
      await input('draft-visibility').click();assert.equal(await input('draft-visibility').getAttribute('aria-pressed'),'false');
      await input('draft-visibility').click();
      plan=await save(name);const meta=plan.inputs;
      near(meta.reference.height,58+.075*24*Math.cos(angle),.08);
      near(meta.road.referenceStation,0,1e-7);assert(meta.road.reversed);near(meta.road.length,24,.001);
      near(meta.reference.longitude,second[0],2e-7);near(meta.reference.latitude,second[1],2e-7);
      near(meta.road.grades[0].gradePct,1,1e-9);near(meta.road.grades[1].gradePct,-2,1e-9);
      const pavement=plan.mesh.vertices.filter(v=>v.roadPart==='core');
      for (const s of [0,14,24]) {
        const v=pavement.find(v=>Math.abs(v.roadStation-s)<1e-5 && Math.abs(v.roadOffset)<1e-5);
        assert(v,'missing calibrated pavement at '+s);
        near(v.surfaceHeight-meta.reference.height,.45+.01*Math.min(s,14)-.02*Math.max(s-14,0),.002);
      }
      return {length:meta.road.length,referenceHeight:meta.reference.height,referenceStation:meta.road.referenceStation,
        firstTop:meta.reference.height+.45,lastTop:meta.reference.height+.39,grades:meta.road.grades};
    });
    await check('临建显隐跨刷新与场景目录删除', async()=>{
      await row(plan.id).locator('[data-tw-action="hide"]').click();
      await page.reload({waitUntil:'domcontentloaded'});await page.locator('[data-tab="temporary-works"]').click();
      assert.match(await row(plan.id).locator('[data-tw-action="hide"]').innerText(),/显示/);
      await row(plan.id).locator('[data-tw-action="hide"]').click();
      await page.locator('[data-dock="display"]').click();
      const directoryRow=page.locator('[data-display-id="temporary-works:'+plan.id+'"]');
      const cat=page.locator('.scene-display-panel').locator('details').filter({hasText:name}).first();
      if (await cat.count() && !await directoryRow.isVisible()) await cat.locator('summary').first().click();
      assert(await directoryRow.isVisible());page.once('dialog',d=>d.accept());
      await directoryRow.locator('[data-action="item-remove"]').click();await directoryRow.waitFor({state:'detached'});
      assert.equal(await stored(name),undefined);await row(plan.id).waitFor({state:'detached'});
      return {hiddenRestored:true,removedFromDirectory:true,removedFromStore:true};
    });
    await check('图纸起点在摄影范围外时保留原桩号并仅算覆盖段',async()=>{
      await page.locator('[data-tab="temporary-works"]').click();
      await selectCad('EXTERNAL_START');await register();
      const title='起点在摄影瓦片外的便道';
      await input('name').fill(title);
      await fields({finished:.45,width:6,thickness:.2,treatment:.3,'slope-height':1,'slope-width':1,grid:3});
      const gradeRow=input('grades').locator('[data-grade-row]');
      assert.equal(await gradeRow.count(),1);
      await gradeRow.locator('[data-grade-field="gradePct"]').fill('2');
      const preview=await overlay();
      assert(preview.covered<preview.samples);
      const visuals=await checkWholeCadOverlay({expectedEnds:[[65,0],[10,0]],expectedLabels:['起点（未测高）','终点']});
      await compute();
      await input('draft-drawing').click();
      await page.waitForFunction(()=>document.querySelector('#tw-overlay-status')?.dataset.state==='ready',undefined,{timeout:180000});
      assert.equal(await input('save').isDisabled(),false,'查看完整 CAD 中心线不应丢失计算草稿');
      await checkWholeCadOverlay({expectedEnds:[[65,0],[10,0]],expectedLabels:['起点（未测高）','终点']});
      const cropped=await save(title), audit=cropped.inputs.road;
      assert.equal(audit.referenceSource,'entry');
      near(audit.length,55,.001);
      // The CAD runs from east 65 m to east 10 m; the supplied tile ends at east 35 m.
      near(audit.referenceStation,30,1);
      const metrics=cropped.metrics;
      assert(metrics.coveredArea>0 && metrics.excludedArea>0);
      near(metrics.coveredArea+metrics.excludedArea,metrics.planArea,.01);
      for (const v of cropped.mesh.vertices.filter(v=>v.roadPart==='core')) {
        assert(v.roadStation>=29.9 && v.roadStation<=55.001);
        near(v.surfaceHeight,cropped.inputs.reference.height+.45+.02*(v.roadStation-audit.referenceStation),.002);
      }
      return {origLengthM:audit.length,entryStationM:audit.referenceStation,validAreaM2:metrics.coveredArea,
        excludedAreaM2:metrics.excludedArea,...preview,...visuals};
    });
    await check('全线在模型外时仍显示完整虚线且计算无有效路面',async()=>{
      await selectCad('FULL_MISS');await register();
      await fields({finished:.45,width:6,thickness:.2,treatment:.3,'slope-height':1,'slope-width':1,grid:3});
      const preview=await overlay(false);
      const visuals=await checkWholeCadOverlay({allMissing:true,expectedEnds:[[80,0],[135,0]],
        expectedLabels:['起点（未测高）','终点（未测高）']});
      assert(/有效|覆盖/.test(await compute(true)));
      return {...preview,...visuals};
    });
    await check('钢筋场CAD场坪及所选建筑边界超出覆盖范围',async()=>{
      await input('kind').selectOption('steel');await selectCad('SITE');await register();
      await input('facility-mode').selectOption('cad');
      const opt=input('building').locator('option').filter({hasText:'BUILDING'}).first();
      await input('building').selectOption(await opt.getAttribute('value'));await fields({'building-height':6});
      const info=await overlay();assert(info.covered<info.samples);
      const title='实景钢筋加工场';
      await input('name').fill(title);await input('ref-mode').selectOption('cad');
      await fields({'ref-x':x,'ref-y':y,finished:0,thickness:.2,treatment:.3,grid:2});
      await compute();const built=await save(title);
      near(built.metrics.planArea,52*8,.05);
      assert(built.metrics.coveredArea>250 && built.metrics.excludedArea>80);
      assert(built.inputs.structures.some(s=>s.included));assert.equal(built.building.height,6);
      return {...info,designArea:built.metrics.planArea,validArea:built.metrics.coveredArea,
        buildingHeight:built.building.height,cut:built.metrics.cutVolume};
    });
    await check('驻地院内国旗台和停车区随方案保存且不改变方量', async()=>{
      const boundary=dxf('驻地院落.dxf',[
        {layer:'CAMPLOT',closed:true,points:[[x-12,y-18],[x+29,y-18],[x+29,y+18],[x-12,y+18]]},
        {layer:'OFFICE',closed:true,points:[[x-10,y+8],[x+14,y+8],[x+14,y+15],[x-10,y+15]]},
      ]);
      await input('kind').selectOption('camp');await selectCad('CAMPLOT',boundary);await register();
      await input('facility-mode').selectOption('cad');
      const office=input('building').locator('option').filter({hasText:'OFFICE'}).first();
      await input('building').selectOption(await office.getAttribute('value'));
      await input('ref-mode').selectOption('cad');
      await fields({'ref-x':x,'ref-y':y,finished:1.5,thickness:.2,treatment:.3,grid:6,'building-height':6});
      await input('camp-yard').check();
      const name='带国旗台和停车区的驻地';
      await input('name').fill(name);await compute();const first=await save(name);
      assert.equal(first.inputs.campYard,true);assert.equal(first.inputs.campLayout.flag,true);
      assert(first.inputs.campLayout.spaces>0);
      assert(first.inputs.structures.some(b=>b.included));
      await input('camp-yard').uncheck();
      const bare='对照场坪';await input('name').fill(bare);await compute();const second=await save(bare);
      assert.equal(second.inputs.campYard,false);assert.equal(second.inputs.campLayout,undefined);
      for(const k of ['planArea','coveredArea','cutVolume','fillVolume']) near(first.metrics[k],second.metrics[k],.01);
      await page.reload({waitUntil:'domcontentloaded'});await page.locator('[data-tab="temporary-works"]').click();
      await row(first.id).locator('[data-tw-action="inspect"]').click();
      assert.match(await input('metrics').innerText(),new RegExp(first.inputs.campLayout.spaces+' 个车位'));
      return {flag:first.inputs.campLayout.flag,spaces:first.inputs.campLayout.spaces,planArea:first.metrics.planArea,
        coveredArea:first.metrics.coveredArea,cut:first.metrics.cutVolume,fill:first.metrics.fillVolume};
    });
    await check('CGCS2000 高斯中央子午线与分带号的同址实景核对', async()=>{
      const oldIds = await input('model').locator('option').evaluateAll(opts=>opts.map(o=>o.value));
      await page.locator('[data-tab="tiles"]').click();
      await page.locator('#tilesUrl').fill(origin+'/__test_gk_survey/tileset.json');await page.locator('#loadTiles').click();
      await page.waitForFunction(ids=>Array.from(document.querySelectorAll('#tw-model option')).some(o=>!ids.includes(o.value)),oldIds);
      await page.locator('[data-tab="temporary-works"]').click();await input('kind').selectOption('road');
      const id=await input('model').locator('option').evaluateAll((opts,ids)=>opts.find(o=>!ids.includes(o.value)).value,oldIds);
      await input('model').selectOption(id);
      await selectCad(privateCase?.layer??'ROAD',privateCase?resolve(privateCase.file):road,privateCase?.feature);
      await input('coord').selectOption('gaussKruger');await input('unit').selectOption('m');await input('axis').selectOption('eastNorth');
      await input('projection-source').selectOption('meridian');await input('prefix').uncheck();await fields({width:6,meridian:'120°00′00″'});
      const first=await overlay();
      await input('projection-source').selectOption('zone');await input('band-width').selectOption('3');await fields({zone:40});
      const second=await overlay();
      assert.equal(first.covered,second.covered);assert.equal(first.samples,second.samples);
      const length=privateCase?.length??24;
      near(Number((await input('road-length').innerText()).replace(/[^0-9.]/g,'')),length,.001);
      const original=await input('projection-readout').innerText(), readout=msg=>msg.match(/经度\s*([\d.-]+)°、纬度\s*([\d.-]+)°/).slice(1).map(Number);
      near(readout(original)[0],gkLon,2e-8);near(readout(original)[1],gkLat,2e-8);
      const observed=proj4(testGk,'EPSG:4326',[gkAnchor.x+2,gkAnchor.y-1]);
      const control=input('gk-x').locator('xpath=ancestor::details[1]');
      if (!await input('gk-x').isVisible()) await control.locator('summary').first().click();
      await fields({'gk-x':gkAnchor.x,'gk-y':gkAnchor.y,'gk-lon':observed[0],'gk-lat':observed[1]});
      await input('gk-check').click();
      const residual=await input('gk-status').innerText();
      const en=residual.match(/东\s*([\d.-]+)\s*m，北\s*([\d.-]+)\s*m/).slice(1).map(Number);
      near(en[0],2,.003);near(en[1],-1,.003);
      assert.equal(await input('projection-readout').innerText(),original,'checking the point must leave the design in place');
      await input('gk-apply').click();
      const adjusted=readout(await input('projection-readout').innerText());
      near(adjusted[0],observed[0],2e-8); near(adjusted[1],observed[1],2e-8);
      near(Number((await input('road-length').innerText()).replace(/[^0-9.]/g,'')),length,.001);
      await input('gk-reset').click();assert.equal(await input('projection-readout').innerText(),original);
      return {length,testMeridian:120,bandWidth:3,zone:40,axisOrder:'eastNorth',covered:second.covered,samples:second.samples,
        checkedDelta:en,restored:true,source:privateCase?'external DWG':'synthetic DXF'};
    });
  }
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.rendererErrors,[]);
  assert.equal(await page.locator('.cesium-widget-errorPanel').count(),0);
  report.result='passed';
} catch(e) {
  process.exitCode=1;report.result='failed';report.error=String(e.stack||e);
  if(page) {
    report.status=await input('status').textContent({timeout:1500}).catch(()=>null);
    report.overlay=await input('overlay-status').textContent({timeout:1500}).catch(()=>null);
  }
  console.error(report.error,report.status,report.overlay);
} finally {
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();await server?.close();await rm(directory,{recursive:true,force:true});
}
