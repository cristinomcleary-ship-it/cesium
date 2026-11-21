/**
 * Isolated real Chromium/WebGL acceptance for construction classes and ranges.
 * Run from the repository root. Supply PLAYWRIGHT_MODULE (path or package name)
 * and BROWSER_EXECUTABLE when Playwright's default browser is unavailable.
 * All product records are authored through UI controls. A synthetic 3D Tiles
 * surface and explicitly simulated live states exercise picking and telemetry;
 * neither represents a surveyed site or a production sensor connection.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, loadConfigFromFile } from 'vite';
import { Cartesian3, Transforms } from 'cesium';

const require = createRequire(import.meta.url);
const output = resolve(process.env.CONSTRUCTION_RANGES_VERIFY_OUT || 'output/machinery-construction-ranges');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/construction-ranges-browser-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { classification: 'real-original-workbench-construction-ranges-ui-v2-grouped-alarms', startedAt: new Date().toISOString(),
  dataDir, productionDataReadOrModified: false, checks: [], pageErrors: [], consoleErrors: [], screenshots: [],
  limitations: ['Synthetic 3D Tiles worksite and simulated live poses; no field-accuracy certification',
    'CAD/model/personnel checks cover existing entry and shared-renderer regression, not every unrelated feature'] };
let server, browser, context, page, origin, activeCheck, machineId, equipmentId, lineId, guardId;
const site = { longitude: 116.391, latitude: 39.907, height: 10 };
const rp = () => page.locator('.rail-safety-panel');
const mp = () => page.locator('.machinery-panel');
const action = name => rp().locator(`[data-action="${name}"]`);
const field = name => rp().locator(`[data-field="${name}"]`);
const mAction = name => mp().locator(`[data-action="${name}"]`);
const local = (east, north) => ({ longitude: site.longitude + east / (111319.49079327358 * Math.cos(site.latitude * Math.PI / 180)), latitude: site.latitude + north / 111319.49079327358, height: site.height });
const rectangle = (x0, y0, x1, y1) => [local(x0,y0), local(x1,y0), local(x1,y1), local(x0,y1)];
const moduleUrl = value => isAbsolute(value) ? pathToFileURL(value).href : value;

// Flat, raised 3D Tiles geometry is used solely to verify actual surface picking.
const positions = new Float32Array([-100,10,100, 100,10,100, 100,10,-100, -100,10,-100]);
const indices = new Uint16Array([0,2,1,0,3,2]);
const bytes = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
const surfaceGltf = { asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
  meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],
  materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.48,.54,.59,1],metallicFactor:0,roughnessFactor:1},extensions:{KHR_materials_unlit:{}}}], extensionsUsed:['KHR_materials_unlit'],
  accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-100,10,-100],max:[100,10,100]}, {bufferView:1,componentType:5123,count:6,type:'SCALAR',min:[0],max:[3]}],
  bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength,target:34962},{buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength,target:34963}],
  buffers:[{byteLength:bytes.length,uri:'data:application/octet-stream;base64,'+bytes.toString('base64')}] };
const surfaceTiles = {asset:{version:'1.1'},geometricError:100,root:{transform:Array.from(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(site.longitude,site.latitude,0))),
  boundingVolume:{box:[0,0,10,100,0,0,0,100,0,0,0,.1]},geometricError:0,refine:'ADD',content:{uri:'surface.gltf'}}};

async function check(id, run) {
  activeCheck = { id, status:'running', startedAt:new Date().toISOString() }; report.checks.push(activeCheck); console.log('RUN',id);
  activeCheck.evidence = await run(); activeCheck.status='passed'; activeCheck.finishedAt=new Date().toISOString(); console.log('PASS',id);
}
async function ready() { await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId, undefined, {timeout:60000}); }
async function snapshot() { return page.evaluate(() => window.__managementWorkspace.ui.getSnapshot()); }
async function sceneSnapshot() { return page.evaluate(() => window.__managementWorkspace.railSafety.scene.getSnapshot()); }
async function settled() { await page.waitForFunction(() => { const p=window.__managementWorkspace.railSafety; return p && !p.isBusy && p.scene.getSnapshot().pending===0; }, undefined, {timeout:60000}); }
async function modelReady() { await page.waitForFunction(() => { const p=window.__managementWorkspace.machinery; return p?.asset && !p.loading && !p.busy && p.previewTimer===undefined; }, undefined, {timeout:30000}); }
async function screenshot(name) { const path=resolve(output,name+'.png'); await page.screenshot({path,timeout:30000}); report.screenshots.push(path); }
async function save(commandType, button) {
  const responsePromise=page.waitForResponse(response => {
    if(!response.url().endsWith('/__management/commands')) return false;
    try{return response.request().postDataJSON()?.type===commandType;}catch{return false;}
  });
  await button.click(); const response=await responsePromise; assert.equal(response.status(),200,await response.text());
  await page.waitForFunction(kind => { const p=window.__managementWorkspace[kind]; return !p.hasDraft && !(p.isBusy ?? p.busy); },commandType==='railSafety.save'?'railSafety':'machinery');
  if(commandType==='railSafety.save') await settled(); else await modelReady();
}
async function saveSafety(){await save('railSafety.save',action('save'));}
async function saveMachine(){await save(machineId?'machinery.save':'machinery.create',mAction('save'));if(!machineId)machineId=(await snapshot()).collections.resources.find(r=>r.equipmentCode==='RANGE-UI-001').id;}
async function navigate(tab) {
  const button=page.locator(`.tab[data-tab="${tab}"]`),center=await button.getAttribute('data-function-center');
  const toggle=page.locator('.function-centers-toggle');
  if(await toggle.isVisible() && await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
  if(center){const group=page.locator(`.function-center[data-center="${center}"]`);if(await group.getAttribute('open')===null)await group.locator('summary').click();}
  await button.click();
}
async function openRail(tab='machine', id) {
  await navigate('rail-safety'); await rp().waitFor({state:'visible'});
  await action(`tab-${tab}`).click(); if(id) await rp().locator('[data-role="selection"]').selectOption(id);
  await action('section-configuration').click(); await settled();
}
async function openMachine(){await navigate('machinery'); await mp().waitFor({state:'visible'}); if(machineId)await mp().locator('[data-role="resource"]').selectOption(machineId); await modelReady();}
async function records(){return (await snapshot()).collections.railSafety;}
async function machineRecord(){return (await snapshot()).collections.resources.find(record=>record.id===machineId);}
async function configuration(){return (await records()).find(record=>record.definition.kind==='machine'&&record.definition.resourceId===machineId);}
async function machineResult(){return (await sceneSnapshot()).results.find(result=>result.resourceId===machineId);}
async function visibleGeometry(){return page.evaluate(id=>{
  const scene=window.__managementWorkspace.railSafety.scene,time=window.__managementWorkspace.viewer.clock.currentTime;
  const points=suffix=>scene.source.entities.getById(`rail-safety:machine:${id}:${suffix}`)?.polygon?.hierarchy.getValue(time).positions.map(p=>[p.x,p.y,p.z]);
  const alarm=scene.source.entities.getById(`rail-safety:machine:${id}:alarm`);
  return{work:points('work-range'),fall:points('envelope'),activity:points('activity-range'),alarm:alarm?{text:alarm.label.text.getValue(time),size:alarm.point.pixelSize.getValue(time),color:alarm.point.color.getValue(time),position:alarm.position.getValue(time)}:null};
},machineId);}
async function frameCurrentMachine(){await page.evaluate(async id=>{const C=await import('/__construction-fixture/cesium.ts'),rt=window.__managementWorkspace,v=rt.viewer,state=rt.railSafety.scene.getMachineState(id);v.camera.lookAt(C.Cartesian3.fromDegrees(state.placement.longitude,state.placement.latitude,state.placement.height+5),new C.HeadingPitchRange(-.3,-1.2,100));v.camera.lookAtTransform(C.Matrix4.IDENTITY);v.scene.requestRender();},machineId);await page.waitForTimeout(200);}
async function constructionAlarmCards(){return rp().locator('[data-role="construction-status"] [data-alarm-class]').evaluateAll(nodes=>nodes.map(node=>({classification:node.dataset.alarmClass,heading:node.querySelector('h4')?.textContent??'',text:node.textContent})));}
async function polygon(points){for(const[index,point]of points.entries()){await action('add-vertex').click();for(const[key,value]of Object.entries(point))await rp().locator(`[data-vertex-index="${index}"][data-coordinate="${key}"]`).fill(String(value));}}
async function machinePolygon(range,points,zoneId) {
  const scope=rp().locator(`[data-machine-range="${range}"]${zoneId?`[data-zone-id="${zoneId}"]`:''}`);
  for(const[index,point]of points.entries()){
    await scope.locator('[data-action="add-machine-vertex"]').click();
    for(const[key,value]of Object.entries(point))await scope.locator(`[data-machine-coordinate="${key}"][data-vertex-index="${index}"]`).fill(String(value));
  }
}
async function addSurfaceAndFrame(){
  const hasSurface=await page.evaluate(()=>window.__managementWorkspace.safety.options.getImports().some(item=>item.name==='tileset.json'));
  if(!hasSurface){
    await navigate('tiles');await page.locator('[aria-controls="operation-tiles-network"]').click();
    await page.locator('#tilesUrl').fill(origin+'/__construction-fixture/tileset.json');await page.locator('#loadTiles').click();
    await page.waitForFunction(()=>window.__managementWorkspace.safety.options.getImports().some(item=>item.name==='tileset.json'),undefined,{timeout:30000});
  }
  await page.evaluate(async site=>{
    const C=await import('/__construction-fixture/cesium.ts'),v=window.__managementWorkspace.viewer;
    window.__constructionSurface=window.__managementWorkspace.safety.options.getImports().find(item=>item.name==='tileset.json').resource;
    v.camera.lookAt(C.Cartesian3.fromDegrees(site.longitude,site.latitude,site.height),new C.HeadingPitchRange(0,-1.4,130));
    v.camera.lookAtTransform(C.Matrix4.IDENTITY); v.scene.requestRender();
  },site);
  await page.waitForFunction(()=>window.__constructionSurface?.tilesLoaded,undefined,{timeout:30000});
}
async function clickWorld(point){
  const pixel=await page.evaluate(async point=>{const C=await import('/__construction-fixture/cesium.ts'),v=window.__managementWorkspace.viewer;
    const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,C.Cartesian3.fromDegrees(point.longitude,point.latitude,point.height));
    assertPoint(p);function assertPoint(p){if(!p)throw new Error('Fixture point is outside camera');}
    const r=v.canvas.getBoundingClientRect();return{x:r.left+p.x,y:r.top+p.y};},point);
  assert(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.tagName==='CANVAS',pixel),'Fixture pick must hit the visible Cesium canvas');
  await page.mouse.click(pixel.x,pixel.y); await page.waitForTimeout(100);
}
async function simulate(east,north=0,heading=0){
  await page.evaluate(({id,position,heading})=>{
    const rt=window.__managementWorkspace,state=structuredClone(rt.ui.getSnapshot().collections.resources.find(r=>r.id===id).machinery);
    state.placement={...state.placement,...position,heading};const states=new Map([[id,state]]);
    rt.machinery.scene.setLiveStates(states);rt.railSafety.scene.setLiveStates(states);
  },{id:machineId,position:local(east,north),heading}); await settled();
}
async function setDeclaredClass(value){await clearSimulation();await openMachine();await mp().locator('[data-role="construction-class"]').selectOption(value);await saveMachine();assert.equal((await machineRecord()).machinery.constructionClass,value);await openRail('machine',machineId);}
function alarmClasses(result){return [...new Set(result.alarms.filter(alarm=>alarm.kind!=='activity').map(alarm=>alarm.classification))].sort();}
async function clearSimulation(){await page.evaluate(()=>{const rt=window.__managementWorkspace;rt.machinery.scene.setLiveStates(new Map());rt.railSafety.scene.setLiveStates(new Map());});await settled();}

async function run(){
  await check('machinery-entry-five-classes',async()=>{
    await navigate('machinery');await mp().waitFor({state:'visible'});
    await mAction('create').click();await modelReady();
    await mp().locator('[data-role="equipment-code"]').fill('RANGE-UI-001');await mp().locator('[data-role="equipment-name"]').fill('施工范围浏览器验收吊机');
    await mp().locator('[data-role="asset"]').selectOption('crane');await modelReady();
    await mp().locator('[data-parameter="overall_scale"]').fill('3');
    for(const[key,value]of Object.entries({...site,heading:0}))await mp().locator(`[data-placement="${key}"]`).fill(String(value));
    const selector=mp().locator('[data-role="construction-class"]');
    const options=await selector.locator('option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,text:n.textContent})));
    assert.deepEqual(options.filter(o=>o.value).map(o=>o.value).sort(),['A','B','B+window','C','window']);
    for(const value of ['window','A','B','B+window','C']){await selector.selectOption(value);await saveMachine();assert.equal((await machineRecord()).machinery.constructionClass,value);}
    await page.evaluate(()=>{window.__constructionOriginalViewer=window.__managementWorkspace.viewer;});
    return{machineId,options,savedClasses:['window','A','B','B+window','C']};
  });
  await check('two-limit-types',async()=>{
    const created=[];
    for(const[type,name,points]of [['equipment','验收设备限界',rectangle(29,-20,35,20)],['line','验收线路限界',rectangle(59,-20,65,20)]]){
      await openRail('limit');await action('new').click();await field('name').fill(name);await field('limitType').selectOption(type);await polygon(points);await saveSafety();
      const record=(await records()).find(r=>r.name===name);assert.equal(record.definition.limitType,type);created.push(record);if(type==='equipment')equipmentId=record.id;else lineId=record.id;
    }return created;
  });
  await check('authored-ranges-and-class-zones',async()=>{
    await openRail('machine',machineId);
    for(const id of[equipmentId,lineId])await rp().locator(`[data-reference="limit"][value="${id}"]`).check();
    await machinePolygon('workRange',rectangle(-4,-3,4,3));await machinePolygon('fallRange',rectangle(-12,-8,12,8));
    const activity=rp().locator('[data-machine-range="activityPolygon"]');await activity.locator('[data-action="draw-machine-range"]').click();
    for(const point of rectangle(-15,-15,15,15))await clickWorld(point);await action('finish-polygon').click();
    await page.waitForFunction(()=>!window.__managementWorkspace.railSafety.isPicking);
    for(const[classification,points]of [['C',rectangle(-14,-14,14,14)],['B',rectangle(18,-20,24,20)],['A',rectangle(28,-20,36,20)],['window',rectangle(58,-20,66,20)]]){
      await action('add-construction-zone').click();const zone=rp().locator('[data-machine-range="zone"]').last();const id=await zone.getAttribute('data-zone-id');
      await zone.locator('[data-zone-name]').fill('验收'+classification+'类区域');await zone.locator('[data-zone-class]').selectOption(classification);await machinePolygon('zone',points,id);
    }
    await saveSafety();const record=await configuration(),d=record.definition;
    assert.equal(d.workRange.polygon.length,4);assert.equal(d.fallRange.polygon.length,4);assert.equal(d.activityPolygon.length,4);assert.equal(d.constructionZones.length,4);
    assert(d.activityPolygon.every(p=>Math.abs(p.height-site.height)<.8),'Actual canvas drawing must pick the raised fixture model: '+JSON.stringify(d.activityPolygon));
    assert.deepEqual(d.workRange.anchor,{...site,heading:0});assert.deepEqual(d.fallRange.anchor,{...site,heading:0});
    await screenshot('01-authored-ranges');return record;
  });
  await check('saved-reload',async()=>{
    const before=await records(),resource=await machineRecord();await page.reload({waitUntil:'domcontentloaded'});await ready();await page.locator('#basemap').selectOption('none');await addSurfaceAndFrame();await openRail('machine',machineId);
    assert.deepEqual(await records(),before);assert.deepEqual(await machineRecord(),resource);assert.equal(await rp().locator('[data-machine-range="zone"]').count(),4);
    await page.evaluate(()=>{window.__constructionOriginalViewer=window.__managementWorkspace.viewer;});
    return{savedRecordCount:before.length,machineId,rangeCount:3,classificationZoneCount:4};
  });
  await check('declared-class-order-and-grouped-alarms',async()=>{
    const matrix=[];
    for(const declared of ['C','B','A','window','B+window']){
      await setDeclaredClass(declared);
      const saved=await configuration(),resource=await machineRecord();
      await simulate(50);const windowOnly=await machineResult();
      assert.equal(windowOnly.classification,'window',JSON.stringify(windowOnly));
      assert.deepEqual(alarmClasses(windowOnly),['C','B'].includes(declared)?['window']:[],JSON.stringify(windowOnly));
      assert.equal(windowOnly.activityStatus,'outside');assert(windowOnly.alarms.some(alarm=>alarm.kind==='activity'));
      await simulate(60);const simultaneous=await machineResult();
      assert.equal(simultaneous.classification,'A',JSON.stringify(simultaneous));
      assert(simultaneous.classifications?.includes('A')&&simultaneous.classifications?.includes('window'),JSON.stringify(simultaneous));
      const expected=['C','B'].includes(declared)?['A','window']:declared==='A'?[]:['A'];
      assert.deepEqual(alarmClasses(simultaneous),expected,JSON.stringify(simultaneous));
      const statusHost=rp().locator('[data-role="construction-status"]');
      assert.equal(await statusHost.getAttribute('data-declared-class'),declared);
      const actualClasses=(await statusHost.getAttribute('data-classifications')).split(',');
      assert(actualClasses.includes('A')&&actualClasses.includes('window'),JSON.stringify(actualClasses));
      await statusHost.scrollIntoViewIfNeeded();await frameCurrentMachine();
      const cards=await constructionAlarmCards();
      assert.deepEqual(cards.filter(card=>card.classification!=='activity').map(card=>card.classification).sort(),expected,JSON.stringify({declared,expected,cards}));
      assert(cards.some(card=>card.classification==='activity'),JSON.stringify(cards));
      for(const category of expected)assert(cards.some(card=>card.classification===category&&card.heading.includes(category==='window'?'天窗点施工报警':'A类施工报警')),JSON.stringify({declared,expected,cards}));
      if(declared==='C')await screenshot('03-separated-A-window-activity-alarm-cards');
      if(declared==='A')await screenshot('04-A-permits-window-and-A');
      if(declared==='B+window')await screenshot('05-B-window-combined-A-only-alarm');
      assert.deepEqual(await configuration(),saved);assert.deepEqual(await machineRecord(),resource);
      matrix.push({declared,windowOnly,simultaneous,cards});
    }
    await setDeclaredClass('C');return{matrix,source:'explicitly simulated live pose',classificationPriority:'A > window > B > C'};
  });
  await check('combined-declaration-ui-save-and-reload',async()=>{
    await setDeclaredClass('B+window');const resource=await machineRecord(),before=await records();
    await page.reload({waitUntil:'domcontentloaded'});await ready();await page.locator('#basemap').selectOption('none');await addSurfaceAndFrame();
    assert.deepEqual(await machineRecord(),resource);assert.deepEqual(await records(),before);
    await openMachine();assert.equal(await mp().locator('[data-role="construction-class"]').inputValue(),'B+window');
    await screenshot('06-combined-declaration-reloaded');await openRail('machine',machineId);
    await simulate(50);const windowOnly=await machineResult();assert.deepEqual(alarmClasses(windowOnly),[],JSON.stringify(windowOnly));
    await simulate(60);const simultaneous=await machineResult();assert.deepEqual(alarmClasses(simultaneous),['A'],JSON.stringify(simultaneous));
    await setDeclaredClass('C');await page.evaluate(()=>{window.__constructionOriginalViewer=window.__managementWorkspace.viewer;});
    return{storedDeclaration:resource.machinery.constructionClass,windowOnly,simultaneous,unchangedConfigurationCount:before.length};
  });
  await check('live-ranges-classification-and-alarms',async()=>{
    const saved=await configuration(),savedMachine=await machineRecord();const samples=[];const initial=await visibleGeometry();assert(initial.work?.length>=3);assert(initial.fall?.length>=3);assert(initial.activity?.length>=3);
    for(const[east,expected]of [[0,'C'],[20,'B'],[30,'A'],[50,'window'],[60,'A']]){
      await simulate(east);const result=await machineResult();samples.push({east,result});
      assert.equal(result.classification,expected,JSON.stringify(result));assert.equal(result.classificationComplete,true,JSON.stringify(result));
      if(east===60){assert(result.classifications?.includes('A'),JSON.stringify(result));assert(result.classifications?.includes('window'),JSON.stringify(result));}
      assert.equal(result.alarms.length>0,east!==0,JSON.stringify(result));
      if(east!==0){assert.equal(result.activityStatus,'outside');const geometry=await visibleGeometry();assert(geometry.alarm?.text.includes('警报'));assert.notDeepEqual(geometry.work,initial.work);assert.notDeepEqual(geometry.fall,initial.fall);assert.deepEqual(geometry.activity,initial.activity);}
    }
    const blink=[];for(let i=0;i<8;i++){blink.push((await visibleGeometry()).alarm.size);await page.waitForTimeout(120);}assert(new Set(blink).size>1,'The alarm point must actually change size over time');
    assert.deepEqual(await configuration(),saved);assert.deepEqual(await machineRecord(),savedMachine);
    await page.evaluate(async id=>{const C=await import('/__construction-fixture/cesium.ts'),rt=window.__managementWorkspace,v=rt.viewer,state=rt.railSafety.scene.getMachineState(id);
      v.camera.lookAt(C.Cartesian3.fromDegrees(state.placement.longitude,state.placement.latitude,state.placement.height+5),new C.HeadingPitchRange(-.3,-1.2,100));v.camera.lookAtTransform(C.Matrix4.IDENTITY);v.scene.requestRender();
    },machineId);await page.waitForTimeout(300);await screenshot('02-live-A-window-and-activity-alarms');await simulate(0,0,90);const rotated=await visibleGeometry();assert.notDeepEqual(rotated.work,initial.work);assert.notDeepEqual(rotated.fall,initial.fall);await clearSimulation();return{source:'explicitly simulated live pose',samples,blink,rotationUpdatesBothRanges:true};
  });
  await check('unfinished-range-draft-retains-saved-monitoring',async()=>{
    await openRail('machine',machineId);await simulate(60);const before=await machineResult(),saved=await configuration();assert(before.alarms.length>0);
    const work=rp().locator('[data-machine-range="workRange"]');await work.locator('[data-action="reset-machine-range"]').click();await work.locator('[data-action="add-machine-vertex"]').click();await settled();
    const during=await machineResult();assert.equal(during.classification,'A');assert(during.classifications?.includes('window'),JSON.stringify(during));assert(during.alarms.length>0,'An incomplete draft must preserve monitoring against the saved configuration');assert.deepEqual(alarmClasses(during),['A','window']);assert.deepEqual(await configuration(),saved);
    await action('cancel').click();if(await action('confirm').isVisible())await action('confirm').click();await page.waitForFunction(()=>!window.__managementWorkspace.railSafety.hasDraft);await settled();await clearSimulation();
    return{before,during,savedConfigurationUnchanged:true};
  });
  await check('hidden-ranges-continue-monitoring',async()=>{
    await page.locator('[data-dock="display"]').click();const sp=page.locator('.scene-display-panel');await sp.locator('[data-action="view-categories"]').click();
    const keys=[`rail:envelope:${machineId}`,`rail:machineWorkRange:${machineId}`];
    for(const key of keys){const button=sp.locator(`[data-display-id="${key}"] [data-action="item-visibility"]`);assert.equal(await button.getAttribute('aria-pressed'),'true');await button.click();}
    await sp.locator('[data-role="labels-visible"]').uncheck();await simulate(60);const result=await machineResult();assert(result.alarms.length>0,JSON.stringify(result));
    const hidden=await visibleGeometry();assert.equal(hidden.work,undefined);assert.equal(hidden.fall,undefined);assert(hidden.alarm?.text.includes('警报'),'Hiding ranges and ordinary labels must not hide alarm text');
    for(const key of keys)await sp.locator(`[data-display-id="${key}"] [data-action="item-visibility"]`).click();await sp.locator('[data-role="labels-visible"]').check();const shown=await visibleGeometry();assert(shown.work?.length>=3);assert(shown.fall?.length>=3);
    await page.locator('[data-dock="editor"]').click();await clearSimulation();return{hiddenKeys:keys,result,alarmVisibleWhileLabelsHidden:true};
  });
  await check('existing-personnel-and-workbench-entry',async()=>{
    await openRail('guard');await action('new').click();await field('name').fill('原防护人员功能验收');
    for(const[key,value]of Object.entries(local(-8,0)))await field('station.'+key).fill(String(value));await polygon(rectangle(-20,-20,20,20));
    await rp().locator(`[data-reference="resource"][value="${machineId}"]`).check();await saveSafety();guardId=(await records()).find(r=>r.name==='原防护人员功能验收').id;
    const tabs=[];let temporaryWorksEntry;for(const tab of ['cad','tiles','models','temporary-works','rail-safety']){
      const button=page.locator(`.tab[data-tab="${tab}"]`);await navigate(tab);await page.waitForFunction(tab=>document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.contains('active'),tab,{timeout:15000});assert(await button.evaluate(node=>node.classList.contains('active')),`Existing ${tab} entry did not activate`);tabs.push(tab);
      if(tab==='temporary-works'){
        await page.locator('#tw-kind').waitFor({state:'visible'});
        temporaryWorksEntry=await page.locator('#tw-kind option').evaluateAll(nodes=>nodes.map(node=>({value:node.value,text:node.textContent})));
        assert(temporaryWorksEntry.length>0,'Existing temporary-works category controls must remain available');
      }
    }
    await openRail('guard',guardId);assert.equal(await field('name').inputValue(),'原防护人员功能验收');
    const runtime=await page.evaluate(()=>({sameViewer:window.__constructionOriginalViewer===window.__managementWorkspace.viewer,renderLoop:window.__managementWorkspace.viewer.useDefaultRenderLoop,
      railSourceCount:window.__managementWorkspace.viewer.dataSources._dataSources.filter(s=>s.name==='铁路旁施工管控').length}));
    assert.equal(runtime.sameViewer,true);assert.equal(runtime.railSourceCount,1);assert.equal(runtime.renderLoop,true);assert.equal(await page.locator('#cesiumContainer canvas').count(),1);assert.deepEqual(report.pageErrors,[]);
    return{guardId,tabs,runtime,canvasCount:1,temporaryWorksEntry};
  });
}

try{
  const {chromium}=await import(moduleUrl(process.env.PLAYWRIGHT_MODULE||'playwright'));
  const launchOptions=process.env.BROWSER_LAUNCH_OPTIONS?(await import(moduleUrl(resolve(process.env.BROWSER_LAUNCH_OPTIONS)))).default:{headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,
    args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']};
  // The migration candidate reuses dependencies through a junction. Match the
  // existing projection acceptance fixture's external dependency URL handling.
  const viteEnv='/@fs/'+(await realpath(join(dirname(require.resolve('vite/package.json')),'dist/client/env.mjs'))).replaceAll('\\','/');
  const realDependencies='/@fs/'+dirname(dirname(require.resolve('cesium/package.json'))).replaceAll('\\','/')+'/';
  const localDependencies='/@fs/'+resolve('node_modules').replaceAll('\\','/')+'/';
  const loaded=await loadConfigFromFile({command:'serve',mode:'development'},resolve('vite.config.ts'),undefined,undefined,undefined,'runner');
  assert(loaded,'Actual product Vite configuration missing');
  server=await createServer({...loaded.config,configFile:false,cacheDir:'.vite/construction-ranges-acceptance',server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[process.cwd(),dirname(dirname(require.resolve('cesium/package.json'))),dirname(dirname(require.resolve('vite/package.json')))]}},plugins:[{
    name:'isolated-construction-ranges-fixture',enforce:'pre',configResolved(config){config.server.watch=null;},resolveId(id){if(id==='/__construction-fixture/cesium.ts')return'\0construction-fixture-cesium';},load(id){if(id==='\0construction-fixture-cesium')return'export * from "cesium";';},
    configureServer(s){s.middlewares.use(async(req,res,next)=>{
      if(req.url?.split('?')[0]===viteEnv){try{res.setHeader('Content-Type','text/javascript');res.end((await s.transformRequest(req.url)).code);}catch(error){next(error);}return;}
      if(req.url?.startsWith(realDependencies))req.url=localDependencies+req.url.slice(realDependencies.length);
      let value;if(req.url==='/__construction-fixture/tileset.json')value=surfaceTiles;else if(req.url==='/__construction-fixture/surface.gltf')value=surfaceGltf;else return next();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});}
  },...(loaded.config.plugins||[])]});await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;report.origin=origin;assert(![5173,5289].includes(server.httpServer.address().port),'Acceptance must not use either existing preview port');console.log('Isolated acceptance',origin,dataDir);
  browser=await chromium.launch(launchOptions);report.browserVersion=browser.version();context=await browser.newContext({viewport:{width:1600,height:1100},timezoneId:'Asia/Shanghai'});
  await context.route('**/__basemap/**',route=>route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==','base64')}));
  page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',error=>report.pageErrors.push({check:activeCheck?.id,message:error.message}));
  page.on('console',event=>{if(event.type()==='error')report.consoleErrors.push({check:activeCheck?.id,message:event.text().slice(0,1000),location:event.location()});});
  await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:60000});await ready();await page.locator('#basemap').selectOption('none');await addSurfaceAndFrame();await run();report.result='passed';
}catch(error){report.result='failed';report.failure=String(error.stack||error);if(activeCheck?.status==='running'){activeCheck.status='failed';activeCheck.error=report.failure;}console.error(error);process.exitCode=1;
  if(page){await screenshot('failure').catch(()=>{});report.failureVisibleText=(await page.locator('body').innerText().catch(()=>'' )).slice(-7000);}
}finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,checks:report.checks.map(c=>({id:c.id,status:c.status})),pageErrors:report.pageErrors,consoleErrors:report.consoleErrors,report:resolve(output,'report.json')},null,2));await context?.close();await browser?.close();await server?.close();}
