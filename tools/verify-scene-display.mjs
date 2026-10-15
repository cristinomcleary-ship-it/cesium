/**
 * Real Chromium/WebGL acceptance for unified scene display.
 * Uses a new SQLite directory, UI-authored safety records and an explicitly
 * synthetic raised/sloped 3D Tiles fixture. No production data is opened.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/path/to/launch_options.mjs \
 * node tools/verify-scene-display.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { Cartesian3, Transforms } from 'cesium';

const output = resolve(process.env.SCENE_DISPLAY_VERIFY_OUT || 'output/scene-display');
const accessOnly = process.env.SCENE_DISPLAY_VERIFY_ACCESS_ONLY === '1';
const port = Number(process.env.SCENE_DISPLAY_VERIFY_PORT || 5195);
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'SCENE_DISPLAY_VERIFY_PORT must be a valid nonzero TCP port');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/scene-display-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { classification: 'actual-original-workbench-scene-display-ui-webgl-with-isolated-data',
  startedAt: new Date().toISOString(), dataDir, productionDataReadOrModified: false,
  fixture: { location: { longitude: 116.391, latitude: 39.907 }, width: 100, depth: 100,
    heightFormula: '12 + 0.12 * east + 0.06 * north (metres)',
    limitations: ['Synthetic 3D Tiles geometry; not a surveyed site or accuracy certification', 'Software WebGL renderer when supplied launch options use SwiftShader'] },
  mode: accessOnly ? 'access-and-persistence-follow-up' : 'full', checks: [], screenshots: [], pageErrors: [], consoleErrors: [], expectedAuthErrors: [], requests: [] };
let server, browser, context, page, origin, activeCheck;
const site = { longitude: 116.391, latitude: 39.907, height: 0 };
const resourceId = 'display-crane-01';
let guardId, limitId, labelId, textId, crossGroupId, fixtureLayerId;
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
async function check(id, run) { if(accessOnly && !['author-three-machines-and-independent-fixtures','management-access-revocation-cannot-be-overridden','refresh-and-real-account-isolate-personal-preferences'].includes(id))return; activeCheck={id,status:'running'}; report.checks.push(activeCheck); console.log('RUN',id); activeCheck.evidence=await run(); activeCheck.status='passed'; console.log('PASS',id); await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)); }
async function ready(){await page.waitForFunction(()=>window.__managementWorkspace?.ui?.getSnapshot()?.projectId,undefined,{timeout:60000});}
async function snapshot(){return page.evaluate(()=>window.__managementWorkspace.ui.getSnapshot());}
async function sceneSnapshot(){return page.evaluate(()=>window.__managementWorkspace.railSafety.scene.getSnapshot());}
async function bounded(promise, timeout, label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${timeout}ms`)),timeout);})]);}finally{clearTimeout(timer);}}
async function rendered(){await bounded(page.evaluate(()=>new Promise((done,reject)=>{const scene=window.__managementWorkspace?.viewer?.scene;if(!scene){reject(new Error('Cesium scene is not ready'));return;}const timer=setTimeout(()=>{remove();reject(new Error('Cesium postRender timed out after 15000ms'));},15000);const remove=scene.postRender.addEventListener(()=>{clearTimeout(timer);remove();done();});scene.requestRender();})),20000,'Cesium render acknowledgement');}
async function settled(){await page.waitForFunction(()=>{const p=window.__managementWorkspace?.railSafety;return p && !p.isBusy && p.scene.getSnapshot().pending===0;},undefined,{timeout:60000});await rendered();await page.waitForFunction(()=>window.__managementWorkspace?.viewer?.dataSourceDisplay.ready,undefined,{timeout:60000});await rendered();}
async function screenshot(name,{failure=false}={}){if(!failure){await settled();await bounded(page.evaluate(()=>document.fonts.ready),15000,'Document fonts');}const path=resolve(output,name+'.png');const timeout=60000;await bounded(page.screenshot({path,timeout}),timeout+1000,'Page screenshot');report.screenshots.push(path);return path;}
async function command(type,payload,extra={}) {const response=await context.request.post(origin+'/__management/commands',{headers:{'Content-Type':'application/json','X-Cesium-Library':'1'},data:{projectId:'safety:project',type,payload,idempotencyKey:crypto.randomUUID(),...extra}});assert.equal(response.status(),200,await response.text());return response.json();}
const machines = [
  { id: resourceId, name: '吊机 01 · 同型第一台', assetId: 'crane', east: 7, north: 0, scale: 3 },
  { id: 'display-crane-02', name: '吊机 02 · 同型第二台', assetId: 'crane', east: 25, north: 6, scale: 3 },
  { id: 'display-pile-03', name: '桩机 03 · 列表末项', assetId: 'pile', east: 25, north: -14, scale: 3 },
];
const accountPassword = 'Isolated-Scene-Display-' + crypto.randomUUID();
async function login(username) {
  assert.equal((await context.request.delete(origin + '/__management/session', { headers: { 'X-Cesium-Library': '1' } })).status(), 200);
  const result = await context.request.post(origin + '/__management/session', { headers: { 'X-Cesium-Library': '1' }, data: { username, password: accountPassword } });
  assert.equal(result.status(), 200, await result.text());
}
async function fixtures() {
  for (const machine of machines) {
    await command('resource.create', { name: machine.name, kind: 'equipment', quantity: 1, unit: '台' }, { id: machine.id });
    const manifest = JSON.parse(await readFile('public/machinery/' + machine.assetId + '/manifest.json', 'utf8'));
    await command('machinery.save', { machinery: { schemaVersion: 1, assetId: machine.assetId, assetVersion: manifest.version, proportional: true,
      parameters: Object.fromEntries(manifest.config.parameters.map(p => [p.key, p.unit === '°' ? p.original : p.original * machine.scale])),
      placement: { ...local(machine.east, machine.north, 12 + .12 * machine.east + .06 * machine.north), heading: 0 }, visible: true } }, { id: machine.id, expectedRevision: 1 });
  }
  await command('member.save', { username: 'display-owner', displayName: '隔离显示验收管理员', password: accountPassword, roles: ['owner'] });
  await command('member.save', { username: 'display-reader', displayName: '隔离显示验收查看者', password: accountPassword, roles: ['viewer'], resourceAccess: { models: true, files: true, media: false } });
  await command('member.save', { username: 'display-no-models', displayName: '隔离无模型权限查看者', password: accountPassword, roles: ['viewer'], resourceAccess: { models: false, files: false, media: false } });
  await login('display-owner');
}
async function addTiles(){
  await page.locator('.tab[data-tab="tiles"]').click();await page.locator('#tilesUrl').fill(origin+'/__display-fixture/tileset.json');await page.locator('#loadTiles').click();
  await page.waitForFunction(()=>window.__managementWorkspace.safety.options.getImports().some(m=>m.name==='tileset.json'));
  const result=await page.evaluate(async()=>{const w=window.__managementWorkspace,C=await import('/__display-fixture/cesium.ts');const item=w.safety.options.getImports().find(i=>i.name==='tileset.json');window.__displayAcceptanceTiles=item.resource;window.__displayTileFailures=[];item.resource.tileFailed.addEventListener(e=>window.__displayTileFailures.push(e));w.viewer.scene.globe.depthTestAgainstTerrain=true;return{id:item.id,groundPolylines:C.GroundPolylinePrimitive.isSupported(w.viewer.scene),groundPolygons:C.GroundPrimitive.isSupported(w.viewer.scene)};});fixtureLayerId='layer:'+result.id;return result;
}
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
  // Pick the imported sloped model through the real canvas UI; no samples are injected.
  const screen = await page.evaluate(async point => {
    const C = await import('/__display-fixture/cesium.ts'), v = window.__managementWorkspace.viewer;
    const p = C.SceneTransforms.worldToWindowCoordinates(v.scene, C.Cartesian3.fromDegrees(point.longitude, point.latitude, point.height));
    const box = v.canvas.getBoundingClientRect(); return { x: box.left + p.x, y: box.top + p.y };
  }, local(east, north,12+.12*east+.06*north));
  const box = await page.locator('#cesiumContainer canvas').boundingBox(); assert(screen.x > box.x && screen.x < box.x + box.width && screen.y > box.y && screen.y < box.y + box.height, `Simulation click must fall on visible canvas: ${JSON.stringify(screen)}`);
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
const sp = () => page.locator('.scene-display-panel');
const sa = name => sp().locator(`[data-action="${name}"]`);
const row = id => sp().locator(`[data-display-id="${id}"]`);
const group = id => sp().locator(`section[data-group-id="${id}"]`);
async function dock(mode) { await page.locator(`[data-dock="${mode}"]`).click(); await page.locator(mode === 'display' ? '#workbenchDisplayHost' : '#workbenchEditorHost').waitFor({ state: 'visible' }); await settled(); }
async function prefs() { return page.evaluate(() => { const s=window.__managementWorkspace.ui.getSnapshot(); return JSON.parse(localStorage.getItem(`scene-display:v1:${JSON.stringify([s.projectId,s.session.userId??null])}`)||'null'); }); }
async function createGroup(name, ids) {
  await dock('display'); await sa('view-categories').click(); if(await sa('clear-selection').isEnabled())await sa('clear-selection').click();
  for (const id of ids) await sp().locator(`[data-select-item="${id}"]`).check();
  await sa('create-group').click(); await sp().locator('[data-role="group-name"]').fill(name); await sa('save-group').click();
  return (await prefs()).groups.find(g => g.name === name).id;
}
async function chooseSafety(kind,id) { await openPanel(); await action('tab-'+kind).click(); await rp().locator('[data-role="selection"]').selectOption(id); await settled(); }
async function railDisplay(name,value) {
  await dock('editor'); await rp().locator('[data-display-tab="limits"]').click();
  const control=rp().locator(`[data-display="limits.${name}"]`);
  if(name==='representation') { await control.selectOption(value); await settled(); } else await range(control,value);
}
async function observations() {
  return page.evaluate(({machineIds,guardId,limitId}) => {
    const w=window.__managementWorkspace, time=w.viewer.clock.currentTime, source=w.railSafety.scene.source;
    const wall=source.entities.getById(`rail-safety:limit:${limitId}:wall`);
    const markings=Array.from({length:w.viewer.dataSources.length},(_,i)=>w.viewer.dataSources.get(i)).find(s=>s.name==='全局标绘');
    return {
      machines:machineIds.map(id=>{const e=w.machinery.scene.source.entities.getById('machinery:'+id);return{id,show:!!e&&e.show&&w.machinery.scene.source.show};}),
      railIds:source.entities.values.map(e=>e.id),railLabels:source.entities.values.filter(e=>e.label&&e.label.show?.getValue(time)!==false).map(e=>e.id),
      wall:wall?{minimumHeights:wall.wall.minimumHeights.getValue(time),maximumHeights:wall.wall.maximumHeights.getValue(time),alpha:wall.wall.material.getValue(time).color.alpha}:null,
      markups:markings?.entities.values.map(e=>({id:e.id,name:e.name,show:e.show,label:!!e.label&&e.label.show?.getValue(time)!==false}))||[],
    };
  },{machineIds:machines.map(m=>m.id),guardId,limitId});
}
async function primitivesFor(ids) {
  return page.evaluate(ids=>{
    const found=[],seen=new Set(),wanted=new Set(ids),name=id=>typeof id==='string'?id:id?.id;
    function visit(p){if(!p||seen.has(p)||p.isDestroyed?.())return;seen.add(p);const candidates=[p.id,...(p._instanceIds||[])];
      for(const id of candidates){if(!wanted.has(name(id)))continue;let instanceShow;try{instanceShow=p.ready&&p.getGeometryInstanceAttributes?p.getGeometryInstanceAttributes(id)?.show?.[0]:undefined;}catch{}
        found.push({id:name(id),type:p.constructor?.name,ready:!!p.ready,show:p.show!==false,instanceShow});}
      if(Array.isArray(p._primitives))p._primitives.forEach(visit);
    }visit(window.__managementWorkspace.viewer.scene.primitives);return found;
  },ids);
}
async function purplePixels() {
  const buffer=await page.locator('#cesiumContainer canvas').screenshot();
  return page.evaluate(async data=>{const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;let count=0;for(let y=90;y<c.height-70;y++)for(let x=30;x<c.width-30;x++){const i=(y*c.width+x)*4,r=p[i],g=p[i+1],b=p[i+2];if(b>g+25&&r>g+15&&b>r+10)count++;}return{count,width:c.width,height:c.height};},buffer.toString('base64'));
}
async function unchanged(baseline) {
  const s=await sceneSnapshot();assert.deepEqual(s.results,baseline.results);assert.deepEqual(s.guardPositions,baseline.guardPositions);
  assert.equal(JSON.stringify((await snapshot()).collections),baseline.records);assert.equal(report.requests.length,baseline.commands);
}
async function runCases() {
  await check('author-three-machines-and-independent-fixtures',async()=>{
    await page.locator('.tab[data-tab="markup"]').click();
    const markupFixture={type:'FeatureCollection',features:[['label','验收标绘标签',local(-5,14,13)],['text','验收文字正文',local(-2,18,13)]].map(([kind,name,p])=>({type:'Feature',properties:{name,markupKind:kind,heightMode:'picked'},geometry:{type:'Point',coordinates:[p.longitude,p.latitude,p.height]}}))};
    await page.locator('#markupImportFile').setInputFiles({name:'scene-display-fixture.geojson',mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify(markupFixture))});
    await page.waitForFunction(()=>Array.from({length:window.__managementWorkspace.viewer.dataSources.length},(_,i)=>window.__managementWorkspace.viewer.dataSources.get(i)).find(s=>s.name==='全局标绘')?.entities.values.length===2);
    const markups=(await observations()).markups;labelId=markups.find(m=>m.name==='验收标绘标签').id;textId=markups.find(m=>m.name==='验收文字正文').id;
    await openPanel();await action('tab-guard').click();await action('new').click();await field('name').fill('右侧显示验收防护员');
    for(const[k,v]of Object.entries(station))await field('station.'+k).fill(String(v));await addPolygon(polygon(-33,-18,1,20));
    await field('work-area-enabled').check();await addPolygon(polygon(-26,-10,-10,10),'workArea');await field('workArea.deviceId').fill('display-device-01');await field('workArea.staleAfterSeconds').fill('3600');await rp().locator(`[data-reference="resource"][value="${resourceId}"]`).check();await save();
    guardId=(await snapshot()).collections.railSafety.find(r=>r.definition.kind==='guard').id;
    await action('tab-limit').click();await action('new').click();await field('name').fill('斜底安全限界');const ring=[[13,-25],[17,-25],[17,25],[13,25]].map(([e,n])=>local(e,n,12+.12*e+.06*n));await addPolygon(ring);await save();limitId=(await snapshot()).collections.railSafety.find(r=>r.definition.kind==='limit').id;
    await action('tab-machine').click();await rp().locator('[data-role="selection"]').selectOption(resourceId);await rp().locator(`[data-reference="limit"][value="${limitId}"]`).check();await save();
    await addTiles();await frame();await page.waitForFunction(()=>window.__displayAcceptanceTiles._statistics.numberOfTilesWithContentReady>0&&window.__displayAcceptanceTiles._selectedTiles.length>0);
    await chooseSafety('guard',guardId);await simulate(-5,0);const monitored=await expectPosition('outside');
    assert.equal((await sceneSnapshot()).results.find(r=>r.resourceId===resourceId).status,'overlap');
    return{machines:machines.map(({id,name,assetId})=>({id,name,assetId})),guardId,limitId,slopedBaseHeights:ring.map(p=>p.height),markups,monitored};
  });
  await check('right-dock-full-list-wheel-and-hit-testing',async()=>{
    await dock('display');await sa('view-categories').click();const sizes=[];
    for(const size of [{width:1920,height:1080},{width:1366,height:768}]){
      await page.setViewportSize(size);await settled();
      const geometry=await page.evaluate(()=>{const side=document.querySelector('.shell>.sidebar').getBoundingClientRect(),canvas=document.querySelector('#cesiumContainer canvas').getBoundingClientRect();return{side:{x:side.x,right:side.right,width:side.width},canvas:{x:canvas.x,right:canvas.right},oldMachineListVisible:!!document.querySelector('#workbenchMachineryObjects')?.getClientRects().length};});
      assert(geometry.side.x>size.width/2);assert(geometry.canvas.right<=geometry.side.x+1);assert.equal(geometry.oldMachineListVisible,false);
      const ids=await sp().locator('[data-category="施工机械"] [data-display-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.displayId));assert.deepEqual(ids,machines.map(m=>'machine:'+m.id));
      const list=sp().locator('[data-role="list"]'),box=await list.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-10000);await page.waitForTimeout(150);
      const third=row('machine:'+machines[2].id).locator('[data-action="item-edit"]');let thirdHit;
      for(let i=0;i<8;i++){thirdHit=await third.evaluate(el=>{const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:el===document.elementFromPoint(x,y)||el.contains(document.elementFromPoint(x,y))};});if(thirdHit.hit)break;await page.mouse.wheel(0,150);await page.waitForTimeout(100);}assert(thirdHit.hit);
      await page.mouse.wheel(0,10000);await page.waitForFunction(()=>{const e=document.querySelector('.scene-display-panel [data-role=list]');return e.scrollTop>=e.scrollHeight-e.clientHeight-2;},undefined,{timeout:10000});const button=sp().locator('[data-display-id]').last().locator('[data-action="item-edit"]');
      const hit=await button.evaluate(el=>{const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const target=document.elementFromPoint(x,y);return{x,y,rect:{top:r.top,bottom:r.bottom},target:target?.outerHTML.slice(0,500),hit:el===target||el.contains(target)};});assert(hit.hit,JSON.stringify({size,hit,scroll:await list.evaluate(el=>({top:el.scrollTop,height:el.scrollHeight,client:el.clientHeight,rect:el.getBoundingClientRect().toJSON()}))}));assert(hit.y<size.height);
      sizes.push({viewport:size,geometry,fullMachineIds:ids,thirdMachineButtonHit:thirdHit,lastButtonHit:hit,scroll:await list.evaluate(el=>({scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}))});
    }
    await screenshot('01-right-dock-1366');await page.setViewportSize({width:1920,height:1080});await settled();return sizes;
  });
  const state=await sceneSnapshot(),baseline={results:state.results,guardPositions:state.guardPositions,records:JSON.stringify((await snapshot()).collections),commands:report.requests.length};
  await check('sloped-limit-wall-height-modes-and-opacity',async()=>{
    await chooseSafety('limit',limitId);await railDisplay('representation','plane');assert.equal((await observations()).wall,null);
    await railDisplay('representation','wall');await railDisplay('wallHeight',8);let o=await observations();assert(!o.railIds.includes(`rail-safety:limit:${limitId}:area`));assert(o.wall);
    assert(new Set(o.wall.minimumHeights).size>1);for(let i=0;i<o.wall.minimumHeights.length;i++)assert(Math.abs(o.wall.maximumHeights[i]-o.wall.minimumHeights[i]-8)<1e-9);
    await railDisplay('representation','both');o=await observations();assert(o.railIds.includes(`rail-safety:limit:${limitId}:area`));
    await frameDemo();await railDisplay('wallOpacity',1);assert.equal((await observations()).wall.alpha,0);const transparent=await purplePixels();
    await railDisplay('wallOpacity',0);assert.equal((await observations()).wall.alpha,1);const opaque=await purplePixels();assert(opaque.count>transparent.count+100,JSON.stringify({transparent,opaque}));
    const primitives=await primitivesFor([`rail-safety:limit:${limitId}:wall`]);assert(primitives.some(p=>p.ready));await railDisplay('wallOpacity',.65);await screenshot('02-sloped-transparent-limit-wall');await unchanged(baseline);
    return{wall:o.wall,transparent,opaque,primitives,resultsUnchanged:true,displayGeneratedCommands:0};
  });
  await check('cross-category-group-controls-real-rendering',async()=>{
    const members=['machine:'+resourceId,`rail:workArea:${guardId}`,`rail:limit:${limitId}`];crossGroupId=await createGroup('吊机与防护边界',members);
    await group(crossGroupId).locator('[data-action="group-hide"]').click();await settled();const hidden=await observations();assert.equal(hidden.machines[0].show,false);assert(!hidden.railIds.some(id=>id.startsWith(`rail-safety:limit:${limitId}:`)));assert(!hidden.railIds.some(id=>id.includes(`guard:${guardId}:work-area`)));
    const hiddenPrimitives=await primitivesFor(['machinery:'+resourceId,`rail-safety:limit:${limitId}:wall`]);assert(hiddenPrimitives.every(p=>!p.show||p.instanceShow===0));await unchanged(baseline);
    await group(crossGroupId).locator('[data-action="group-show"]').click();await settled();const shown=await observations();assert(shown.machines[0].show);assert(shown.railIds.includes(`rail-safety:limit:${limitId}:wall`));assert(shown.railIds.includes(`rail-safety:guard:${guardId}:work-area`));await unchanged(baseline);
    return{members,hidden,hiddenPrimitives,shown,resultsAndMonitoringUnchanged:true,displayGeneratedCommands:0};
  });
  await check('overlap-group-partial-rename-members-dissolve',async()=>{
    const second=await createGroup('重叠组选项',['machine:'+resourceId,'machine:'+machines[1].id]);
    await group(crossGroupId).locator('[data-action="group-hide"]').click();await settled();assert.equal(await group(second).locator('[data-toggle-group]').evaluate(el=>el.indeterminate),true);
    await group(second).locator('[data-action="group-show"]').click();await settled();assert.equal(await group(crossGroupId).locator('[data-toggle-group]').evaluate(el=>el.indeterminate),true);
    await group(crossGroupId).locator('[data-action="rename-group"]').click();await sp().locator('[data-role="group-name"]').fill('已重命名施工组合');await sa('save-group').click();
    await group(crossGroupId).locator('[data-action="edit-members"]').click();await sp().locator(`[data-select-item="rail:workArea:${guardId}"]`).uncheck();await sp().locator(`[data-select-item="machine:${machines[2].id}"]`).check();await sa('save-group').click();
    const updated=(await prefs()).groups.find(g=>g.id===crossGroupId);assert.equal(updated.name,'已重命名施工组合');assert(!updated.members.includes(`rail:workArea:${guardId}`));assert(updated.members.includes('machine:'+machines[2].id));
    const before=await observations();await group(second).locator('[data-action="dissolve-group"]').click();await settled();assert.deepEqual(await observations(),before);assert(!(await prefs()).groups.some(g=>g.id===second));
    await sa('show-all').click();await settled();await unchanged(baseline);return{updated,partialStatesObserved:true,dissolveDeletedNoObjects:true};
  });
  await check('global-labels-control-safety-and-markups',async()=>{
    await sp().locator('[data-role="labels-visible"]').uncheck();await settled();const hidden=await observations();assert.equal(hidden.railLabels.length,0);assert.equal(hidden.markups.find(m=>m.id===labelId).label,false);assert.equal(hidden.markups.find(m=>m.id===textId).label,true);
    await sp().locator('[data-role="labels-visible"]').check();await settled();const shown=await observations();assert(shown.railLabels.length>0);assert(shown.markups.find(m=>m.id===labelId).label);await unchanged(baseline);return{hidden,shown,textMarkupBodyRetained:true};
  });
  await check('display-editor-switch-preserves-unsaved-drafts',async()=>{
    await chooseSafety('guard',guardId);const oldName=await field('name').inputValue();await field('name').fill(oldName+' 未保存');await dock('display');await dock('editor');assert.equal(await field('name').inputValue(),oldName+' 未保存');assert(await page.evaluate(()=>window.__managementWorkspace.railSafety.hasDraft));
    await action('cancel').click();if(await action('confirm').isVisible())await action('confirm').click();await settled();assert.equal(await field('name').inputValue(),oldName);
    await dock('display');await sa('view-categories').click();await row('machine:'+resourceId).locator('[data-action="item-edit"]').click();const mp=page.locator('.machinery-panel');await mp.waitFor({state:'visible'});const height=mp.locator('[data-placement="height"]'),before=await height.inputValue();await height.fill(String(Number(before)+1));await dock('display');await dock('editor');assert.equal(await height.inputValue(),String(Number(before)+1));assert(await page.evaluate(()=>window.__managementWorkspace.machinery.hasDraft));await mp.locator('[data-action="cancel"]').click();await page.waitForFunction(()=>!window.__managementWorkspace.machinery.hasDraft);await settled();
    assert.equal(report.requests.length,baseline.commands);return{railDraftPreserved:true,machineDraftPreserved:true,businessWrites:0};
  });
  await check('existing-work-area-and-fall-demo-remain-operable',async()=>{
    await chooseSafety('guard',guardId);await frame();await simulate(-18,0);const inside=await expectPosition('inside');await simulate(-5,0);await expectPosition('outside');
    await chooseSafety('machine',resourceId);const pose=await machinePose();await action('fall-start').click();const demo=await waitDemoReady();await range(rp().locator('[data-fall="angle"]'),30);assert.equal((await demoObservation()).state.angle,30);await action('fall-stop').click();await settled();assert.deepEqual(await machinePose(),pose);assert.equal(report.requests.length,baseline.commands);return{inside,demoReady:demo.primitives.some(p=>p.ready),sourcePartCount:demo.state.sourcePartCount,originalPoseUnchanged:true};
  });
  if(accessOnly){await chooseSafety('limit',limitId);await railDisplay('representation','both');await railDisplay('wallHeight',8);crossGroupId=await createGroup('隔离权限复验组合',['machine:'+resourceId,`rail:limit:${limitId}`,'machine:'+machines[2].id]);}
  await check('management-access-revocation-cannot-be-overridden',async()=>{
    await dock('display');await sa('view-categories').click();assert.equal(await row(fixtureLayerId).count(),1);
    await page.locator('#openSafetyWorkspace').click();await page.locator('[data-mg-action="account"]').filter({visible:true}).first().click();await page.locator('[data-mg-action="logout"]').click();
    await page.waitForFunction(()=>!window.__managementWorkspace.session);assert.equal(await page.evaluate(()=>window.__displayAcceptanceTiles.show),false);
    await login('display-no-models');await page.evaluate(()=>window.__managementWorkspace.refreshMachineryContext());
    await page.waitForFunction(()=>window.__managementWorkspace.session?.displayName==='隔离无模型权限查看者');
    assert.equal(await row(fixtureLayerId).count(),0);await sa('show-all').evaluate(el=>el.click());assert.equal(await page.evaluate(()=>window.__displayAcceptanceTiles.show),false);
    await login('display-owner');await page.evaluate(()=>window.__managementWorkspace.refreshMachineryContext());await page.waitForFunction(()=>window.__managementWorkspace.session?.displayName==='隔离显示验收管理员');await page.locator('[data-mg-action="exit"]').filter({visible:true}).first().click();await dock('display');await sa('view-categories').click();assert.equal(await row(fixtureLayerId).count(),1);assert.equal(await page.evaluate(()=>window.__displayAcceptanceTiles.show),true);
    return{sameLoadedTileset:true,logoutHides:true,noModelsAccountCatalogAbsent:true,showAllCannotRevive:true,showAllDispatchedWhileWorkbenchInaccessible:true,ownerRestored:true};
  });
  await check('refresh-and-real-account-isolate-personal-preferences',async()=>{
    await dock('display');await sa('view-groups').click();await group(crossGroupId).locator('[data-action="group-hide"]').click();await sp().locator('[data-role="labels-visible"]').uncheck();await settled();const before=await prefs(),ownerId=(await snapshot()).session.userId;
    await page.reload({waitUntil:'domcontentloaded'});await ready();await openPanel();await dock('display');assert.deepEqual(await prefs(),before);const ownerWall=(await sceneSnapshot()).display.limits;assert.equal(ownerWall.representation,'both');assert.equal(ownerWall.wallHeight,8);assert.equal((await observations()).machines[0].show,false);
    await login('display-reader');await page.reload({waitUntil:'domcontentloaded'});await ready();await openPanel();await dock('display');const readerId=(await snapshot()).session.userId;assert.notEqual(readerId,ownerId);const reader=await prefs();assert(!reader||reader.groups.length===0);assert.equal(await sp().locator('[data-role="labels-visible"]').isChecked(),true);assert((await observations()).machines[0].show);assert.equal((await sceneSnapshot()).display.limits.representation,'plane');
    await login('display-owner');await page.reload({waitUntil:'domcontentloaded'});await ready();await openPanel();await dock('display');assert.deepEqual(await prefs(),before);assert.equal((await sceneSnapshot()).display.limits.representation,'both');assert.equal((await observations()).machines[0].show,false);
    assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.equal(await page.locator('#cesiumContainer canvas').count(),1);return{ownerId,readerId,ownerPreferences:before,readerPreferences:reader,ownerWall,restored:true,pageErrors:[],consoleErrors:[]};
  });
}


try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const options=process.env.BROWSER_LAUNCH_OPTIONS?(await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default:{headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined};
 server=await createServer({server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:null},plugins:[{name:'isolated-display-fixture',configResolved(config){config.server.watch=null;},resolveId(id){if(id==='/__display-fixture/cesium.ts')return '\0display-fixture-cesium';},load(id){if(id==='\0display-fixture-cesium')return 'export * from "cesium";';},configureServer(s){s.middlewares.use((req,res,next)=>{let value;if(req.url==='/__display-fixture/tileset.json')value=fixtureTiles;else if(req.url==='/__display-fixture/slope.gltf')value=fixtureGltf;else return next();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});}}]});await server.listen();const address=server.httpServer.address();origin=`http://127.0.0.1:${address.port}`;report.origin=origin;console.log('Isolated scene-display acceptance server:',origin,'data:',dataDir);
 browser=await chromium.launch(options);report.browserVersion=browser.version();context=await browser.newContext({viewport:{width:1920,height:1080}});await context.route('**/__basemap/**',r=>r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==','base64')}));page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.pageErrors.push({check:activeCheck?.id,message:e.message}));page.on('console',e=>{if(e.type()!=='error')return;const value={check:activeCheck?.id,message:e.text().slice(0,700),url:e.location().url};if(activeCheck?.id==='management-access-revocation-cannot-be-overridden'&&value.url.startsWith(origin+'/__management/')&&/status of 401/.test(value.message))report.expectedAuthErrors.push(value);else report.consoleErrors.push(value);});page.on('response',async r=>{if(r.status()>=400)console.log('HTTP_ERROR',r.status(),r.url(),(await r.text().catch(()=>'' )).slice(0,800));});page.on('requestfailed',r=>console.log('REQUEST_FAILED',r.url(),r.failure()));page.on('request',r=>{if(r.url().endsWith('/__management/commands')){try{report.requests.push({type:r.postDataJSON().type});}catch{}}});
 await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:60000});await ready();await fixtures();await page.reload({waitUntil:'domcontentloaded'});await ready();await page.locator('#basemap').selectOption('none');await runCases();report.result='passed';
}catch(error){report.result='failed';report.failure=String(error.stack||error);if(activeCheck?.status==='running'){activeCheck.status='failed';activeCheck.error=report.failure;}process.exitCode=1;console.error(error);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));if(page){await screenshot('failure',{failure:true}).catch(e=>{report.failureScreenshotError=String(e);});report.failureVisibleText=(await bounded(page.locator('body').innerText({timeout:5000}),6000,'Failure page text').catch(()=>'' )).slice(-10000);}}
finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await context?.close();await browser?.close();await server?.close();}
