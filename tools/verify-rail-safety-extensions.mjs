/**
 * Real Chromium/WebGL acceptance for rail-safety extensions.
 * Uses a new SQLite directory, UI-authored safety records and an explicitly
 * synthetic raised/sloped 3D Tiles fixture. No production data is opened.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/path/to/launch_options.mjs \
 * node tools/verify-rail-safety-extensions.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { Cartesian3, Transforms } from 'cesium';

const output = resolve(process.env.RAIL_SAFETY_EXTENSIONS_VERIFY_OUT || 'output/rail-safety-extensions');
const port = Number(process.env.RAIL_SAFETY_EXTENSIONS_VERIFY_PORT || 5194);
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'RAIL_SAFETY_EXTENSIONS_VERIFY_PORT must be a valid nonzero TCP port');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/rail-safety-extensions-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { classification: 'actual-original-workbench-extensions-ui-webgl-with-isolated-data',
  startedAt: new Date().toISOString(), dataDir, productionDataReadOrModified: false,
  fixture: { location: { longitude: 116.391, latitude: 39.907 }, width: 100, depth: 100,
    heightFormula: '12 + 0.12 * east + 0.06 * north (metres)',
    limitations: ['Synthetic 3D Tiles geometry; not a surveyed site or accuracy certification', 'Software WebGL renderer when supplied launch options use SwiftShader'] },
  checks: [], screenshots: [], pageErrors: [], consoleErrors: [], requests: [] };
let server, browser, context, page, origin, activeCheck;
const site = { longitude: 116.391, latitude: 39.907, height: 0 };
const resourceId = 'extensions-acceptance-crane';
let guardId, limitId, taskId;
const rp = () => page.locator('.rail-safety-panel');
const action = name => rp().locator(`[data-action="${name}"]`);
const field = name => rp().locator(`[data-field="${name}"]`);
const station = local(-18, -2);
station.height = 12 + .12 * -18 + .06 * -2;
function local(east, north, height = 0) { return { longitude: site.longitude + east / (111319.49079327358 * Math.cos(site.latitude * Math.PI / 180)), latitude: site.latitude + north / 111319.49079327358, height }; }
function polygon(x0, y0, x1, y1, height = 0) { return [local(x0,y0,height),local(x1,y0,height),local(x1,y1,height),local(x0,y1,height)]; }
function gltfFixture() {
  const corners = [[-50,-50],[50,-50],[50,50],[-50,50]];
  // glTF Y-up -> 3D Tiles local Z-up: east=x, north=-z, height=y.
  const points = [...corners.map(([e,n]) => [e,12+.12*e+.06*n,-n]), ...corners.map(([e,n]) => [e,0,-n])];
  const positions = new Float32Array(points.flat());
  const indices = new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]);
  const bytes = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  return { asset: { version:'2.0', generator:'Synthetic rail-safety display acceptance fixture' }, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],
    materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.55,.58,.62,1],metallicFactor:0,roughnessFactor:1},extensions:{KHR_materials_unlit:{}}}], extensionsUsed:['KHR_materials_unlit'],
    accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[-50,0,-50],max:[50,21,50]},{bufferView:1,componentType:5123,count:36,type:'SCALAR',min:[0],max:[7]}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength,target:34962},{buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength,target:34963}],
    buffers:[{byteLength:bytes.length,uri:'data:application/octet-stream;base64,'+bytes.toString('base64')}] };
}
const fixtureGltf = gltfFixture();
const fixtureTiles = {asset:{version:'1.1'},geometricError:100,root:{transform:Array.from(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(site.longitude,site.latitude,0))),boundingVolume:{box:[0,0,10.5,50,0,0,0,50,0,0,0,10.5]},geometricError:0,refine:'ADD',content:{uri:'slope.gltf'}}};
async function check(id, run) { activeCheck={id,status:'running'}; report.checks.push(activeCheck); console.log('RUN',id); activeCheck.evidence=await run(); activeCheck.status='passed'; console.log('PASS',id); }
async function ready(){await page.waitForFunction(()=>window.__managementWorkspace?.ui?.getSnapshot()?.projectId,undefined,{timeout:60000});}
async function snapshot(){return page.evaluate(()=>window.__managementWorkspace.ui.getSnapshot());}
async function sceneSnapshot(){return page.evaluate(()=>window.__managementWorkspace.railSafety.scene.getSnapshot());}
async function bounded(promise, timeout, label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${timeout}ms`)),timeout);})]);}finally{clearTimeout(timer);}}
async function rendered(){await bounded(page.evaluate(()=>new Promise((done,reject)=>{const scene=window.__managementWorkspace?.viewer?.scene;if(!scene){reject(new Error('Cesium scene is not ready'));return;}const timer=setTimeout(()=>{remove();reject(new Error('Cesium postRender timed out after 15000ms'));},15000);const remove=scene.postRender.addEventListener(()=>{clearTimeout(timer);remove();done();});scene.requestRender();})),20000,'Cesium render acknowledgement');}
async function settled(){await page.waitForFunction(()=>{const p=window.__managementWorkspace?.railSafety;return p && !p.isBusy && p.scene.getSnapshot().pending===0;},undefined,{timeout:60000});await rendered();await page.waitForFunction(()=>window.__managementWorkspace?.viewer?.dataSourceDisplay.ready,undefined,{timeout:60000});await rendered();}
async function screenshot(name,{failure=false}={}){if(!failure){await settled();await bounded(page.evaluate(()=>document.fonts.ready),15000,'Document fonts');}const path=resolve(output,name+'.png');const timeout=failure?10000:60000;await bounded(page.screenshot({path,timeout}),timeout+1000,'Page screenshot');report.screenshots.push(path);return path;}
async function command(type,payload,extra={}) {const response=await context.request.post(origin+'/__management/commands',{headers:{'Content-Type':'application/json','X-Cesium-Library':'1'},data:{projectId:'safety:project',type,payload,idempotencyKey:crypto.randomUUID(),...extra}});assert.equal(response.status(),200,await response.text());return response.json();}
async function fixtures(){await command('resource.create',{name:'吊机 · 扩展验收',kind:'equipment',quantity:1,unit:'台'},{id:resourceId});const manifest=JSON.parse(await readFile('public/machinery/crane/manifest.json','utf8'));await command('machinery.save',{machinery:{schemaVersion:1,assetId:'crane',assetVersion:manifest.version,proportional:true,parameters:Object.fromEntries(manifest.config.parameters.map(p=>[p.key,p.unit==='°'?p.original:p.original*3])),placement:{...local(7,0,12.84),heading:0},visible:true}},{id:resourceId,expectedRevision:1});}
async function addTiles(){return page.evaluate(async site=>{const C=await import('/__display-fixture/cesium.ts');const viewer=window.__managementWorkspace.viewer;const tiles=await C.Cesium3DTileset.fromUrl('/__display-fixture/tileset.json',{enableCollision:true});viewer.scene.primitives.add(tiles);window.__displayAcceptanceTiles=tiles;window.__displayTileFailures=[];tiles.tileFailed.addEventListener(e=>window.__displayTileFailures.push(e));viewer.scene.globe.depthTestAgainstTerrain=true;viewer.scene.requestRender();return {groundPolylines:C.GroundPolylinePrimitive.isSupported(viewer.scene),groundPolygons:C.GroundPrimitive.isSupported(viewer.scene)};},site);}
async function frame(close=false){await page.evaluate(async ({site,close})=>{const C=await import('/__display-fixture/cesium.ts');const v=window.__managementWorkspace.viewer;v.camera.lookAt(C.Cartesian3.fromDegrees(site.longitude,site.latitude,close?site.height+1.8:12),new C.HeadingPitchRange(-.15,close?-.4:-.9,close?38:145));v.camera.lookAtTransform(C.Matrix4.IDENTITY);v.camera.moveRight(close?0:22);v.scene.requestRender();},{site:close?station:site,close});await page.waitForTimeout(900);}
async function save(){const responsePromise=page.waitForResponse(r=>{if(!r.url().endsWith('/__management/commands'))return false;try{return r.request().postDataJSON()?.type==='railSafety.save';}catch{return false;}});await action('save').click();const response=await responsePromise;assert.equal(response.status(),200,await response.text());await page.waitForFunction(()=>!window.__managementWorkspace.railSafety.hasDraft);await settled();}
async function addPolygon(points,target="responsibility"){for(const [index,point] of points.entries()){await action(target==='workArea'?'add-work-vertex':'add-vertex').click();for(const[key,value]of Object.entries(point))await rp().locator(`[data-polygon="${target}"][data-vertex-index="${index}"][data-coordinate="${key}"]`).fill(String(value));}}
async function openPanel() {
  await page.locator('.tab[data-tab="rail-safety"]').click();
  await rp().waitFor({ state: 'visible' }); await settled();
}
async function range(control, value) {
  const min = Number(await control.getAttribute('min')), max = Number(await control.getAttribute('max'));
  const step = Number(await control.getAttribute('step')), box = await control.boundingBox();
  await control.click({ position: { x: 8 + (box.width - 16) * (value - min) / (max - min), y: box.height / 2 } });
  const delta = Math.round((value - Number(await control.inputValue())) / step);
  for (let i = 0; i < Math.abs(delta); i++) await control.press(delta > 0 ? 'ArrowRight' : 'ArrowLeft');
  assert.equal(Number(await control.inputValue()), value); await settled();
}
async function stats() {
  return { risk: Number(await rp().locator('[data-stat="risk"] strong').innerText()), unknown: Number(await rp().locator('[data-stat="unknown"] strong').innerText()) };
}
async function monitor() {
  const status = rp().locator('[data-role="position-status"]');
  return { state: await status.getAttribute('data-state'), text: await status.innerText(), role: await status.getAttribute('role'), summary: await rp().locator('[data-role="position-summary"]').innerText() };
}
async function expectPosition(state) {
  await page.waitForFunction(state => document.querySelector('[data-role="position-status"]')?.getAttribute('data-state') === state, state, { timeout: 15000 });
  return monitor();
}
async function simulate(east, north) {
  await action('simulate-position').click();
  // The fixture is not imported project data. Pick the explicitly positioned
  // ellipsoid point through the real canvas UI; no samples are injected.
  const screen = await page.evaluate(async point => {
    const C = await import('/__display-fixture/cesium.ts'), v = window.__managementWorkspace.viewer;
    const p = C.SceneTransforms.worldToWindowCoordinates(v.scene, C.Cartesian3.fromDegrees(point.longitude, point.latitude, 0));
    const box = v.canvas.getBoundingClientRect(); return { x: box.left + p.x, y: box.top + p.y };
  }, local(east, north));
  assert(screen.x > 365 && screen.x < 1170 && screen.y > 85 && screen.y < 950, `Simulation click must fall on the visible canvas: ${JSON.stringify(screen)}`);
  await page.mouse.click(screen.x, screen.y); await settled();
}
async function machinePose() {
  return page.evaluate(id => {
    const w = window.__managementWorkspace, entity = w.machinery.scene.source.entities.getById('machinery:' + id), time = w.viewer.clock.currentTime;
    return entity ? { position: entity.position.getValue(time), orientation: entity.orientation.getValue(time), uri: entity.model.uri.getValue(time), matrix: Array.from(entity.computeModelMatrix(time)) } : null;
  }, resourceId);
}
async function demoObservation() {
  return page.evaluate(() => {
    const w = window.__managementWorkspace, state = w.railSafety.scene.getSnapshot().fallDemo;
    const source = Array.from({ length: w.viewer.dataSources.length }, (_, i) => w.viewer.dataSources.get(i)).find(s => s.name === '机械倾覆运动演示（只读副本）');
    const model = source?.entities.values.find(e => e.model), time = w.viewer.clock.currentTime;
    const primitives = [], seen = new Set();
    function visit(item) {
      if (!item || seen.has(item)) return; seen.add(item);
      const id = typeof item.id === 'string' ? item.id : item.id?.id;
      if (id?.includes('rail-safety:fall-demo:') && item.ready !== undefined) primitives.push({ id, ready: item.ready, show: item.show, type: item.constructor?.name });
      if (Array.isArray(item._primitives)) item._primitives.forEach(visit);
    }
    visit(w.viewer.scene.primitives);
    return { state, model: model ? { id: model.id, matrix: Array.from(model.computeModelMatrix(time)), uri: model.model.uri.getValue(time) } : null, primitives };
  });
}
async function waitDemoReady() {
  await page.waitForFunction(() => { const s = window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo; return s?.active && !s.loading && s.modelCreated && !s.error; }, undefined, { timeout: 60000 });
  await settled();
  for (let i = 0; i < 30; i++) { const value = await demoObservation(); if (value.primitives.some(p => p.ready)) return value; await rendered(); }
  throw new Error('The demonstration Entity exists but no matching ready Cesium Model primitive was observed');
}
async function frameDemo() {
  await page.evaluate(async point => {
    const C = await import('/__display-fixture/cesium.ts'), v = window.__managementWorkspace.viewer;
    v.camera.lookAt(C.Cartesian3.fromDegrees(point.longitude, point.latitude, point.height), new C.HeadingPitchRange(-0.75, -0.6, 55));
    v.camera.lookAtTransform(C.Matrix4.IDENTITY); v.camera.moveRight(8); v.scene.requestRender();
  }, local(7, 0, 12.84)); await settled();
}
async function runCases() {
  await check('unknown-summary-and-task-entry', async () => {
    await openPanel(); await action('tab-machine').click(); await rp().locator('[data-role="selection"]').selectOption(resourceId); await settled();
    const before = await stats(); assert.equal(before.risk, 0); assert.equal(before.unknown, 1);
    assert.equal((await sceneSnapshot()).results[0].status, 'unknown');
    await action('tab-guard').click(); await action('new').click();
    const explanation = await rp().locator('[data-role="task-section"]').innerText();
    assert(explanation.includes('不会自动选限界')); assert(explanation.includes('暂无可见施工任务'));
    await action('open-tasks').click(); if (await action('confirm').isVisible()) await action('confirm').click();
    const create = page.locator('[data-mg-command="task.create"]:visible').first(); await create.waitFor(); await create.click();
    await page.locator('[data-mg-field="name"]:visible').fill('邻线扩展验收任务');
    const response = page.waitForResponse(r => r.url().endsWith('/__management/commands') && r.request().postDataJSON()?.type === 'task.create');
    await page.locator('[data-mg-action="form-save"]:visible').click(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => window.__managementWorkspace.ui.getSnapshot().collections.tasks.some(t => t.name === '邻线扩展验收任务'));
    taskId = (await snapshot()).collections.tasks.find(t => t.name === '邻线扩展验收任务').id;
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' }); await ready(); await page.locator('#basemap').selectOption('none'); await openPanel();
    return { before, explanation, createdTaskId: taskId };
  });
  await check('independent-work-area-and-device-binding', async () => {
    await action('tab-guard').click(); await action('new').click(); await field('name').fill('防护员 · 工作区验收');
    await field('taskId').selectOption(taskId); for (const [key, value] of Object.entries(station)) await field('station.' + key).fill(String(value));
    const responsibility = polygon(-33, -18, 1, 20), workArea = polygon(-26, -10, -10, 10);
    await addPolygon(responsibility); await field('work-area-enabled').check(); await addPolygon(workArea, 'workArea');
    await field('workArea.deviceId').fill('extension-device-01'); await field('workArea.staleAfterSeconds').fill('12');
    await rp().locator(`[data-reference="resource"][value="${resourceId}"]`).check(); await save();
    const record = (await snapshot()).collections.railSafety.find(r => r.definition.kind === 'guard'); guardId = record.id;
    assert.deepEqual(record.definition.polygon, responsibility); assert.deepEqual(record.definition.workArea.polygon, workArea);
    assert.notDeepEqual(record.definition.polygon, record.definition.workArea.polygon); assert.equal(record.definition.workArea.deviceId, 'extension-device-01');
    const status = await expectPosition('no-fix'); assert(!status.text.includes('正常'));
    await addTiles(); await frame(); await page.waitForFunction(() => window.__displayAcceptanceTiles._statistics.numberOfTilesWithContentReady > 0 && window.__displayAcceptanceTiles._selectedTiles.length > 0);
    return { guardId, responsibilityVertices: responsibility.length, workAreaVertices: workArea.length, deviceId: record.definition.workArea.deviceId, taskId: record.taskId, status };
  });
  const savedBeforeSimulation = JSON.stringify((await snapshot()).collections.railSafety);
  const assessmentBeforeSimulation = JSON.stringify((await sceneSnapshot()).results);
  const sampleCommandsBefore = report.requests.length;
  await check('explicit-simulation-inside-and-outside', async () => {
    await simulate(-18, 0); const inside = await expectPosition('inside');
    await simulate(-5, 0); const outside = await expectPosition('outside');
    assert.equal(outside.role, 'alert'); assert(outside.summary.includes('模拟越界 1')); assert(outside.summary.includes('实测越界 0'));
    assert((await rp().locator('[data-role="monitor"]').innerText()).includes('模拟样本'));
    await rp().locator('[data-role="monitor"]').scrollIntoViewIfNeeded(); await screenshot('01-explicit-simulated-outside');
    await action('add-work-vertex').click(); await settled();
    const invalidDraft = await sceneSnapshot();
    assert(invalidDraft.entityIds.some(id => [`rail-safety:guard:${guardId}:work-area`, `rail-safety:guard:${guardId}:work-area:saved`].includes(id)), 'An incomplete work-area draft must retain the saved monitoring boundary');
    const retainedVertices = await page.evaluate(id => {
      const w = window.__managementWorkspace, entities = w.railSafety.scene.source.entities;
      const area = entities.getById(`rail-safety:guard:${id}:work-area:saved`) || entities.getById(`rail-safety:guard:${id}:work-area`);
      return area?.polygon?.hierarchy?.getValue(w.viewer.clock.currentTime).positions.length;
    }, guardId); assert.equal(retainedVertices, 4, 'The saved four-vertex boundary must remain, not the incomplete five-vertex draft');
    assert(invalidDraft.entityIds.includes(`rail-safety:guard:${guardId}:position`), 'An incomplete work-area draft must retain the tracked position');
    assert.equal((await monitor()).state, 'outside');
    await action('cancel').click(); if (await action('confirm').isVisible()) await action('confirm').click(); await settled();
    return { inside, outside, incompleteDraftKeepsSavedBoundaryAndPosition: true };
  });
  await check('uncertain-stale-and-cleared-are-not-normal', async () => {
    await simulate(-26, 0); const uncertain = await expectPosition('uncertain'); assert(!uncertain.text.includes('正常'));
    const stale = await expectPosition('stale'); assert(!stale.text.includes('正常')); assert.equal(stale.role, 'status');
    await action('clear-simulation').click(); const cleared = await expectPosition('no-fix');
    assert.equal(JSON.stringify((await snapshot()).collections.railSafety), savedBeforeSimulation);
    assert.equal(JSON.stringify((await sceneSnapshot()).results), assessmentBeforeSimulation); assert.equal(report.requests.length, sampleCommandsBefore);
    return { uncertain, stale, cleared, unchangedSavedRecords: true, unchangedAssessment: true, generatedCommands: 0 };
  });
  await check('manual-limit-association-counts-real-overlap', async () => {
    await action('tab-limit').click(); await action('new').click(); await field('name').fill('相交验收限界'); await addPolygon(polygon(13, -25, 17, 25, 13)); await save();
    limitId = (await snapshot()).collections.railSafety.find(r => r.definition.kind === 'limit').id;
    await action('tab-machine').click(); await rp().locator('[data-role="selection"]').selectOption(resourceId); await settled();
    const before = await stats(); assert.equal(before.risk, 0); assert.equal(before.unknown, 1);
    await rp().locator(`[data-reference="limit"][value="${limitId}"]`).check(); await save();
    const after = await stats(), result = (await sceneSnapshot()).results.find(r => r.resourceId === resourceId);
    assert.equal(result.status, 'overlap'); assert.equal(after.risk, 1); assert.equal(after.unknown, 0);
    return { before, after, limitId, result };
  });
  const savedBeforeDemo = JSON.stringify((await snapshot()).collections), assessmentBeforeDemo = JSON.stringify((await sceneSnapshot()).results);
  const poseBefore = await machinePose(), demoCommandsBefore = report.requests.length; assert(poseBefore);
  await check('real-model-demo-direction-and-angle', async () => {
    await action('fall-start').click(); const start = await waitDemoReady();
    assert(start.state.sourcePartCount > 0); assert(start.state.sourceTriangleCount > 0); assert(start.model.uri.startsWith('blob:'));
    await range(rp().locator('[data-fall="angle"]'), 45); const angled = await demoObservation();
    assert.notDeepEqual(angled.model.matrix, start.model.matrix);
    await range(rp().locator('[data-fall="direction"]'), 180);
    const changed = await demoObservation(); assert.equal(changed.state.direction, 180); assert.equal(changed.state.angle, 45);
    assert.notEqual(changed.state.actualDirection, angled.state.actualDirection); assert.notDeepEqual(changed.model.matrix, angled.model.matrix); assert.deepEqual(await machinePose(), poseBefore);
    await frameDemo(); await screenshot('02-real-machine-fall-demo'); return { start, angled, changed, originalModelUnchanged: true };
  });
  await check('demo-play-pause-reset-exit-preserve-business', async () => {
    const angle = (await demoObservation()).state.angle; await action('fall-play').click();
    await page.waitForFunction(angle => window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo.angle > angle + 2, angle);
    await action('fall-play').click(); const paused = await demoObservation(); assert.equal(paused.state.playing, false);
    await action('fall-reset').click(); const reset = await demoObservation(); assert.equal(reset.state.angle, 0); assert.equal(reset.state.playing, false);
    await action('fall-stop').click(); await settled(); const stopped = await demoObservation(); assert.equal(stopped.state.active, false); assert.equal(stopped.model, null); assert.equal(stopped.primitives.length, 0);
    assert.deepEqual(await machinePose(), poseBefore); assert.equal(JSON.stringify((await snapshot()).collections), savedBeforeDemo);
    assert.equal(JSON.stringify((await sceneSnapshot()).results), assessmentBeforeDemo); assert.equal(report.requests.length, demoCommandsBefore);
    return { paused: paused.state, reset: reset.state, stopped: stopped.state, originalPoseUnchanged: true, recordsUnchanged: true, assessmentUnchanged: true, generatedCommands: 0 };
  });
  await check('reload-preserves-configuration-clears-simulation', async () => {
    await action('tab-guard').click(); await rp().locator('[data-role="selection"]').selectOption(guardId); await frame(); await simulate(-18, 0); await expectPosition('inside');
    const records = JSON.stringify((await snapshot()).collections.railSafety); await page.reload({ waitUntil: 'domcontentloaded' }); await ready(); await page.locator('#basemap').selectOption('none'); await openPanel();
    await action('tab-guard').click(); await rp().locator('[data-role="selection"]').selectOption(guardId); await settled();
    assert.equal(JSON.stringify((await snapshot()).collections.railSafety), records); const state = await expectPosition('no-fix'); assert.equal((await sceneSnapshot()).fallDemo.active, false);
    return { recordsPreserved: true, state, demoActive: false };
  });
  await check('runtime-clean', async () => {
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.equal(await page.locator('#cesiumContainer canvas').count(), 1);
    return { canvasCount: 1, pageErrors: [], consoleErrors: [] };
  });
}

try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const options=process.env.BROWSER_LAUNCH_OPTIONS?(await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default:{headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined};
 server=await createServer({server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:null},plugins:[{name:'isolated-display-fixture',configResolved(config){config.server.watch=null;},resolveId(id){if(id==='/__display-fixture/cesium.ts')return '\0display-fixture-cesium';},load(id){if(id==='\0display-fixture-cesium')return 'export * from "cesium";';},configureServer(s){s.middlewares.use((req,res,next)=>{let value;if(req.url==='/__display-fixture/tileset.json')value=fixtureTiles;else if(req.url==='/__display-fixture/slope.gltf')value=fixtureGltf;else return next();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});}}]});await server.listen();const address=server.httpServer.address();origin=`http://127.0.0.1:${address.port}`;report.origin=origin;console.log('Isolated extensions acceptance server:',origin,'data:',dataDir);
 browser=await chromium.launch(options);report.browserVersion=browser.version();context=await browser.newContext({viewport:{width:1600,height:1000}});await context.route('**/__basemap/**',r=>r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==','base64')}));page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.pageErrors.push({check:activeCheck?.id,message:e.message}));page.on('console',e=>{if(e.type()==='error')report.consoleErrors.push({check:activeCheck?.id,message:e.text().slice(0,700)});});page.on('response',async r=>{if(r.status()>=400)console.log('HTTP_ERROR',r.status(),r.url(),(await r.text().catch(()=>'' )).slice(0,800));});page.on('requestfailed',r=>console.log('REQUEST_FAILED',r.url(),r.failure()));page.on('request',r=>{if(r.url().endsWith('/__management/commands')){try{report.requests.push({type:r.postDataJSON().type});}catch{}}});
 await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:60000});await ready();await fixtures();await page.reload({waitUntil:'domcontentloaded'});await ready();await page.locator('#basemap').selectOption('none');await runCases();report.result='passed';
}catch(error){report.result='failed';report.failure=String(error.stack||error);if(activeCheck?.status==='running'){activeCheck.status='failed';activeCheck.error=report.failure;}process.exitCode=1;console.error(error);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));if(page){await screenshot('failure',{failure:true}).catch(e=>{report.failureScreenshotError=String(e);});report.failureVisibleText=(await bounded(page.locator('body').innerText({timeout:5000}),6000,'Failure page text').catch(()=>'' )).slice(-10000);}}
finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await context?.close();await browser?.close();await server?.close();}
