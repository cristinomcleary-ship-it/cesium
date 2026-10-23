/**
 * Real Chromium/WebGL acceptance for range effects and directional fall outlines.
 * Uses a new SQLite directory, a fixed-ID guard gateway fixture, UI-authored
 * safety boundaries, and an explicitly
 * synthetic raised/sloped 3D Tiles fixture. No production data is opened.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/path/to/launch_options.mjs \
 * PNG_MODULE=/path/to/pngjs/lib/png.js \
 * node tools/verify-range-effects.mjs
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { Cartesian3, Transforms } from 'cesium';

const pngModule = await import(process.env.PNG_MODULE || 'pngjs');
const PNG = pngModule.PNG || pngModule.default.PNG;
const remainingOnly=process.env.RANGE_EFFECTS_VERIFY_REMAINING_ONLY==='1';
const deviceOnly=process.env.RANGE_EFFECTS_VERIFY_DEVICE_ONLY==='1';
const output = resolve(process.env.RANGE_EFFECTS_VERIFY_OUT || 'output/range-effects');
const port = Number(process.env.RANGE_EFFECTS_VERIFY_PORT || 5197);
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'RANGE_EFFECTS_VERIFY_PORT must be a valid nonzero TCP port');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/range-effects-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { classification: 'actual-workbench-range-effects-and-directional-outline-webgl',
  startedAt: new Date().toISOString(), dataDir, productionDataReadOrModified: false,
  fixture: { location: { longitude: 116.391, latitude: 39.907 }, width: 100, depth: 100,
    heightFormula: '12 + 0.12 * east + 0.06 * north (metres)',
    limitations: ['Synthetic 3D Tiles geometry; not a surveyed site or accuracy certification', 'Software WebGL renderer when supplied launch options use SwiftShader'] },
  mode: deviceOnly?'device-baseline-follow-up':remainingOnly?'remaining-animation-and-device':'targeted-effects-and-outline', checks: [], screenshots: [], pageErrors: [], consoleErrors: [], expectedAuthErrors: [], requests: [] };
let server, browser, context, page, origin, activeCheck;
const site = { longitude: 116.391, latitude: 39.907, height: 0 };
const resourceId = 'projection-crane-01';
const fixedGuardId = 'range-effects-guard';
const locatorToken = randomBytes(32).toString('base64url');
const locatorConfigDir = await mkdtemp(resolve(tmpdir(), 'range-effects-private-'));
const locatorConfigPath = resolve(locatorConfigDir, 'positioning.json');
process.env.CESIUM_POSITIONING_CONFIG_FILE = locatorConfigPath;
await writeFile(locatorConfigPath, JSON.stringify({version:1,devices:[{projectId:'safety:project',guardId:fixedGuardId,deviceId:'range-projection-device',tokenSha256:createHash('sha256').update(locatorToken).digest('hex'),enabled:true}]}), {mode:0o600});
let guardId, limitId, groupId, fixtureLayerId, baseline;
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
async function check(id, run) { if(deviceOnly&&id!=='device-http-ingest-reaches-panel-and-expiry-without-simulation')return;if(remainingOnly&&['six-range-effects-animate-real-materials-and-keep-color-alpha','directional-outline-is-not-center-circle-and-matches-screening','hidden-effects-stop-refresh-and-restore'].includes(id))return;activeCheck={id,status:'running'};report.checks.push(activeCheck);console.log('RUN',id);activeCheck.evidence=await run();activeCheck.status='passed';console.log('PASS',id);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)); }
async function ready(){await page.waitForFunction(()=>window.__managementWorkspace?.ui?.getSnapshot()?.projectId,undefined,{timeout:60000});}
async function snapshot(){return page.evaluate(()=>window.__managementWorkspace.ui.getSnapshot());}
async function sceneSnapshot(){return page.evaluate(()=>window.__managementWorkspace.railSafety.scene.getSnapshot());}
async function bounded(promise, timeout, label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${timeout}ms`)),timeout);})]);}finally{clearTimeout(timer);}}
async function rendered(){await bounded(page.evaluate(()=>new Promise((done,reject)=>{const scene=window.__managementWorkspace?.viewer?.scene;if(!scene){reject(new Error('Cesium scene is not ready'));return;}const timer=setTimeout(()=>{remove();reject(new Error('Cesium postRender timed out after 15000ms'));},15000);const remove=scene.postRender.addEventListener(()=>{clearTimeout(timer);remove();done();});scene.requestRender();})),20000,'Cesium render acknowledgement');}
async function settled(){await page.waitForFunction(()=>{const p=window.__managementWorkspace?.railSafety;return p && !p.isBusy && p.scene.getSnapshot().pending===0;},undefined,{timeout:60000});await rendered();await page.waitForFunction(()=>window.__managementWorkspace?.viewer?.dataSourceDisplay.ready,undefined,{timeout:60000});await rendered();}
async function screenshot(name,{failure=false}={}){if(!failure){await settled();await bounded(page.evaluate(()=>document.fonts.ready),15000,'Document fonts');}const path=resolve(output,name+'.png');const timeout=60000;await bounded(page.screenshot({path,timeout}),timeout+1000,'Page screenshot');report.screenshots.push(path);return path;}
async function command(type,payload,extra={}) {const response=await context.request.post(origin+'/__management/commands',{headers:{'Content-Type':'application/json','X-Cesium-Library':'1'},data:{projectId:'safety:project',type,payload,idempotencyKey:crypto.randomUUID(),...extra}});assert.equal(response.status(),200,await response.text());return response.json();}
const machines = [{id:resourceId,name:'连续方位投影验收吊机',assetId:'crane',east:7,north:0,scale:3}];
const accountPassword = 'Isolated-Range-Projection-' + crypto.randomUUID();
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
  await command('member.save', { username: 'projection-owner', displayName: '隔离显示验收管理员', password: accountPassword, roles: ['owner'] });
  await login('projection-owner');
  await command('railSafety.save', { name:'定位网关隔离验收人员', definition:{schemaVersion:1,kind:'guard',station,polygon:polygon(-33,-18,1,20),resourceIds:[resourceId],workArea:{polygon:polygon(-26,-10,-10,10),deviceId:'range-projection-device',staleAfterSeconds:5}} }, {id:fixedGuardId,expectedRevision:0});
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
  await page.waitForFunction(() => { const s = window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo; return s?.active && !s.loading && s.modelCreated && !s.error && s.projectionReady && !s.projectionBusy && !s.projectionError; }, undefined, { timeout: 60000 });
  await settled();
  for (let i = 0; i < 30; i++) { const value = await demoObservation(); if (value.primitives.some(p => p.ready)) return value; await rendered(); }
  throw new Error('The demonstration Entity exists but no matching ready Cesium Model primitive was observed');
}
async function frameDemo() {
  await page.evaluate(async point => {
    const C = await import('/__display-fixture/cesium.ts'), v = window.__managementWorkspace.viewer;
    v.camera.lookAt(C.Cartesian3.fromDegrees(point.longitude, point.latitude, point.height), new C.HeadingPitchRange(-0.75, -0.72, 32));
    v.camera.lookAtTransform(C.Matrix4.IDENTITY); v.camera.moveRight(0); v.scene.requestRender();
  }, local(7, 0, 12.84)); await settled();
}
const colors = { responsibility:'#167dff', workArea:'#12d887', limit:'#a45bff', envelope:'#ff7900', risk:'#ff1456', support:'#b9d5ec' };
const sp = () => page.locator('.scene-display-panel');
const sa = name => sp().locator(`[data-action="${name}"]`);
async function dock(mode) { await page.locator(`[data-dock="${mode}"]`).click();await page.locator(mode==='display'?'#workbenchDisplayHost':'#workbenchEditorHost').waitFor({state:'visible'});await settled(); }
async function selectMachine() { await openPanel();await action('tab-machine').click();await rp().locator('[data-role="selection"]').selectOption(resourceId);await settled(); }
async function displayTab(tab) { await dock('editor');await rp().locator(`[data-display-tab="${tab}"]`).click(); }
async function representation(value) { await displayTab('envelopes');await rp().locator('[data-display="envelopes.representation"]').selectOption(value);await settled(); }
async function createGroup() {
  await dock('display');await sa('view-categories').click();
  for(const id of ['machine:'+resourceId,'rail:envelope:'+resourceId])await sp().locator(`[data-select-item="${id}"]`).check();
  await sa('create-group').click();await sp().locator('[data-role="group-name"]').fill('机械与当前投影');await sa('save-group').click();
  groupId=await sp().locator('section[data-group-id]').first().getAttribute('data-group-id');
}
async function authorScene() {
  await openPanel();await action('tab-guard').click();await rp().locator('[data-role="selection"]').selectOption(fixedGuardId);await field('name').fill('范围效果与定位验收防护员');await save();guardId=fixedGuardId;
  await action('tab-limit').click();await action('new').click();await field('name').fill('投影验收限界');await addPolygon([[13,-25],[17,-25],[17,25],[13,25]].map(([e,n])=>local(e,n,12+.12*e+.06*n)));await save();
  limitId=(await snapshot()).collections.railSafety.find(r=>r.definition.kind==='limit').id;
  await selectMachine();await rp().locator(`[data-reference="limit"][value="${limitId}"]`).check();await save();await addTiles();await frameDemo();
  await page.waitForFunction(()=>window.__displayAcceptanceTiles._statistics.numberOfTilesWithContentReady>0&&window.__displayAcceptanceTiles._selectedTiles.length>0);
  await selectMachine();await settled();const state=await sceneSnapshot();assert.equal(state.results.find(r=>r.resourceId===resourceId).status,'overlap');
  baseline={records:JSON.stringify((await snapshot()).collections),results:state.results,guardPositions:state.guardPositions,commands:report.requests.length,pose:await machinePose()};
}
async function unchanged() {
  const state=await sceneSnapshot();assert.deepEqual(state.results,baseline.results);assert.deepEqual(state.guardPositions,baseline.guardPositions);
  assert.equal(JSON.stringify((await snapshot()).collections),baseline.records);assert.equal(report.requests.length,baseline.commands);assert.deepEqual(await machinePose(),baseline.pose);
}
async function materials() {
  return page.evaluate(({guardId,limitId,resourceId})=>{
    const w=window.__managementWorkspace,t=w.viewer.clock.currentTime,values=w.railSafety.scene.source.entities.values;
    const ids={responsibility:`rail-safety:guard:${guardId}:area`,workArea:`rail-safety:guard:${guardId}:work-area`,limit:`rail-safety:limit:${limitId}:area`,envelope:`rail-safety:machine:${resourceId}:envelope`,support:`rail-safety:machine:${resourceId}:support`};
    const rows=Object.fromEntries(Object.entries(ids).map(([key,id])=>[key,values.find(e=>e.id===id)]));rows.risk=values.find(e=>e.id.startsWith(`rail-safety:machine:${resourceId}:intersection:`));
    return Object.fromEntries(Object.entries(rows).map(([key,e])=>[key,{id:e?.id,fill:e?.polygon?.material?.getValue(t)?.color?.toCssHexString()?.slice(0,7),alpha:e?.polygon?.material?.getValue(t)?.color?.alpha,line:e?.polyline?.material?.getValue(t)?.color?.toCssHexString()?.slice(0,7)}]));
  },{guardId,limitId,resourceId});
}
async function waitProjection(direction,angle) {
  await page.waitForFunction(({direction,angle})=>{const s=window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo;return s.active&&!s.loading&&s.projectionReady&&!s.projectionBusy&&!s.projectionError&&Math.abs(s.projectionAngle-angle)<1e-8&&Math.abs(s.actualDirection-direction)<1e-8&&Math.abs(s.projectionDirection-direction)<1e-8;},{direction,angle},{timeout:90000});await settled();
}
async function setPose(direction,angle) {
  await range(rp().locator('[data-fall="direction"]'),direction);await range(rp().locator('[data-fall="angle"]'),angle);await waitProjection(direction,angle);
}
/** Observe rendered entities and uploaded texture; no pose or mask is injected. */
async function projectionObservation(){
  const base=await demoObservation();
  const extra=await page.evaluate(async resourceId=>{
    const C=await import('/__display-fixture/cesium.ts'),w=window.__managementWorkspace,d=w.railSafety.scene.fallDemo,r=d.projectionResult,t=w.viewer.clock.currentTime;
    if(!r||!d.footprint||!d.model)throw new Error('Current projection, footprint or model is absent');
    const mask=r.mask;let occupied=0,hash=2166136261;const edgePoints=[];
    for(let y=0;y<r.height;y++){let first=-1,last=-1;for(let x=0;x<r.width;x++){const v=mask[y*r.width+x];hash=Math.imul(hash^v,16777619)>>>0;if(v){occupied++;if(first<0)first=x;last=x;}}if(first>=0){edgePoints.push({x:first,y});if(last!==first)edgePoints.push({x:last,y});}}
    const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),sorted=edgePoints.sort((a,b)=>a.x-b.x||a.y-b.y),lower=[],upper=[];
    for(const p of sorted){while(lower.length>1&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p);}for(const p of [...sorted].reverse()){while(upper.length>1&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p);}const hull=lower.slice(0,-1).concat(upper.slice(0,-1));
    let emptyInsideConvexHull=0;for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++)if(!mask[y*r.width+x]&&hull.length>=3&&hull.every((p,i)=>cross(p,hull[(i+1)%hull.length],{x,y})>=0))emptyInsideConvexHull++;
    const pixels=d.footprint.polygon.material.getValue(t).image.getContext('2d').getImageData(0,0,r.width,r.height).data;let textureOccupied=0,maxFillChannelError=0,fillToleranceMax=0,colorViolations=0;const textureColors=new Set(),opaqueColors=new Set(),rgb=[1,3,5].map(i=>parseInt(d.display.color.slice(i,i+2),16));for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]){textureOccupied++;const hex='#'+[pixels[i],pixels[i+1],pixels[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('');textureColors.add(hex);const alpha=pixels[i+3],tolerance=alpha===255?0:Math.ceil(255/(2*alpha));if(alpha===255)opaqueColors.add(hex);else fillToleranceMax=Math.max(fillToleranceMax,tolerance);for(let c=0;c<3;c++){const error=Math.abs(pixels[i+c]-rgb[c]);if(alpha!==255)maxFillChannelError=Math.max(maxFillChannelError,error);if(error>tolerance)colorViolations++;}}
    const original=w.machinery.scene.source.entities.getById('machinery:'+resourceId),initial=original.orientation.getValue(t),current=d.model.orientation.getValue(t);
    const delta=C.Quaternion.multiply(current,C.Quaternion.conjugate(initial,new C.Quaternion()),new C.Quaternion());if(delta.w<0){delta.x*=-1;delta.y*=-1;delta.z*=-1;delta.w*=-1;}const measuredAngle=2*Math.acos(Math.max(-1,Math.min(1,delta.w)))*180/Math.PI;
    const inv=C.Matrix4.inverseTransformation(C.Transforms.eastNorthUpToFixedFrame(original.position.getValue(t)),new C.Matrix4()),axis=C.Matrix4.multiplyByPointAsVector(inv,new C.Cartesian3(delta.x,delta.y,delta.z),new C.Cartesian3());
    const measuredDirection=measuredAngle>1e-5?((Math.atan2(axis.y,-axis.x)*180/Math.PI)%360+360)%360:null;
    const primitives=[],seen=new Set();function visit(p){if(!p||seen.has(p)||p.isDestroyed?.())return;seen.add(p);for(const id of [p.id,...(p._instanceIds||[])]){const name=typeof id==='string'?id:id?.id;if(name===d.footprint.id)primitives.push({id:name,type:p.constructor?.name,ready:!!p.ready,show:p.show!==false});}if(Array.isArray(p._primitives))p._primitives.forEach(visit);if(Array.isArray(p._collectionsArray))p._collectionsArray.forEach(visit);visit(p._primitive);visit(p._groundPrimitives);}visit(w.viewer.scene.primitives);visit(w.viewer.scene.groundPrimitives);
    return{mask:{width:r.width,height:r.height,hash:hash.toString(16),occupied,emptyInsideConvexHull,bounds:r.bounds,cellSizeMeters:r.cellSizeMeters,areaMeters2:r.areaMeters2,direction:r.direction,angle:r.angle},texture:{occupied:textureOccupied,colors:[...textureColors],opaqueColors:[...opaqueColors],maxFillChannelError,fillToleranceMax,colorViolations},footprint:{id:d.footprint.id,show:d.footprint.show,classification:d.footprint.polygon.classificationType.getValue(t)},measuredPose:{angle:measuredAngle,direction:measuredDirection},footprintPrimitives:primitives};
  },resourceId);
  assert.equal(extra.texture.occupied,extra.mask.occupied);assert.deepEqual(extra.texture.opaqueColors,[colors.envelope]);assert.equal(extra.texture.colorViolations,0);
  return{...base,...extra};
}
async function applyCustomColors(){
  for(const [tab,keys]of [['guards',['responsibility','workArea']],['limits',['limit']],['envelopes',['envelope','risk','support']]]){
    await displayTab(tab);for(const key of keys){await rp().locator(`[data-display="colors.${key}"]`).fill(colors[key]);await settled();}
  }
}

const effectTabs = [['guards',['responsibility','workArea']],['limits',['limit']],['envelopes',['envelope','risk','support']]];
async function applyEffects(mode) {
  for (const [tab, keys] of effectTabs) {
    await displayTab(tab);
    const details=rp().locator('details.rs-range-effects');if((await details.getAttribute('open'))===null)await details.locator('summary').click();
    for (const key of keys) await rp().locator(`[data-display="effects.${key}.mode"]`).selectOption(mode);
  }
  await settled();
}
async function loopObservation() {
  return page.evaluate(() => {
    const scene=window.__managementWorkspace.railSafety.scene;
    return Object.fromEntries([['scene',scene],['demo',scene.fallDemo]].map(([key,owner])=>{const loop=owner.effectRenderLoop;return[key,loop?{active:loop.active,running:loop.running,pendingFrame:loop.pendingFrame}:null];}));
  });
}
async function effectObservation() {
  return page.evaluate(({guardId,limitId,resourceId})=>{
    const w=window.__managementWorkspace,t=w.viewer.clock.currentTime,values=w.railSafety.scene.source.entities.values;
    const ids={responsibility:`rail-safety:guard:${guardId}:area`,workArea:`rail-safety:guard:${guardId}:work-area`,limit:`rail-safety:limit:${limitId}:area`,wall:`rail-safety:limit:${limitId}:wall`,envelope:`rail-safety:machine:${resourceId}:envelope`,support:`rail-safety:machine:${resourceId}:support`};
    const rows=Object.fromEntries(Object.entries(ids).map(([key,id])=>[key,values.find(e=>e.id===id)]));rows.risk=values.find(e=>e.id.startsWith(`rail-safety:machine:${resourceId}:intersection:`));
    const material=(p)=>{if(!p)return null;const v=p.getValue(t);return{type:p.getType(t),constant:p.isConstant,animated:!!p.animated,color:v.color?.toCssHexString()?.slice(0,7),alpha:v.color?.alpha,speed:v.speed,mode:v.mode,intensity:v.intensity};};
    const entities=Object.fromEntries(Object.entries(rows).map(([key,e])=>[key,{id:e?.id,fill:material(e?.polygon?.material??e?.wall?.material),line:material(e?.polyline?.material)}]));
    const gpu=[],seen=new Set(),seenMaterials=new Set(),primitiveIds=window.__effectPrimitiveIds??=new WeakMap();window.__effectPrimitiveSequence??=0;function visit(p){if(!p||seen.has(p)||p.isDestroyed?.())return;seen.add(p);for(const m of [p.appearance?.material,p._appearance?.material,p._material])if(m&&!seenMaterials.has(m)&&m.type?.startsWith('RailSafetyRangeEffect')){seenMaterials.add(m);if(!primitiveIds.has(p))primitiveIds.set(p,++window.__effectPrimitiveSequence);gpu.push({primitiveId:primitiveIds.get(p),primitiveType:p.constructor?.name,entityIds:[p.id,...(p._instanceIds||[])].map(id=>typeof id==='string'?id:id?.id).filter(Boolean),type:m.type,mode:m.uniforms?.mode,speed:m.uniforms?.speed,intensity:m.uniforms?.intensity,frameClock:/czm_frameNumber/.test(m.shaderSource??''),ready:p.ready});}for(const a of [p._primitives,p._collectionsArray])if(Array.isArray(a))a.forEach(visit);visit(p._primitive);visit(p._groundPrimitives);}visit(w.viewer.scene.primitives);visit(w.viewer.scene.groundPrimitives);
    return{entities,gpu};
  },{guardId,limitId,resourceId});
}
/** Capture browser-composited scene pixels without a synchronous WebGL readback hook. */
async function canvasFrame(name) {
  await rendered();const path=resolve(output,name+'.png');
  const buffer=await bounded(page.screenshot({path,clip:{x:10,y:120,width:800,height:570},timeout:60000}),61000,'Rendered range screenshot');
  const png=PNG.sync.read(buffer),state=await page.evaluate(()=>{const s=window.__managementWorkspace.viewer.scene;return{frame:s.frameState.frameNumber,contextLost:s.context._gl.isContextLost()};});
  report.screenshots.push(path);assert.equal(state.contextLost,false);return{...state,path,width:png.width,height:png.height,pixels:png.data};
}
function compareFrames(first,second) {
  assert.equal(second.width,first.width);assert.equal(second.height,first.height);let changedPixels=0,maxDelta=0,totalDelta=0;
  for(let i=0;i<first.pixels.length;i+=4){let d=0;for(let c=0;c<3;c++)d+=Math.abs(first.pixels[i+c]-second.pixels[i+c]);if(d>3)changedPixels++;maxDelta=Math.max(maxDelta,d);totalDelta+=d;}
  return{width:first.width,height:first.height,firstFrame:first.frame,secondFrame:second.frame,firstPath:first.path,secondPath:second.path,changedPixels,maxDelta,totalDelta,contextLost:false};
}
async function envelopeObservation() {
  return page.evaluate(async ({resourceId,limitId})=>{
    const C=await import('/__display-fixture/cesium.ts'),G=await import('/src/railSafetyGeometry.ts'),w=window.__managementWorkspace,s=w.railSafety.scene;
    const visual=s.visuals.find(v=>v.resourceId===resourceId),envelope=visual.envelope;
    const limit=w.ui.getSnapshot().collections.railSafety.find(r=>r.id===limitId),input=limit.definition.polygon.map(p=>G.projectWgs84ToLocal(p,envelope.origin)),computed=G.intersectPolygons(envelope.polygon,input),result=s.getSnapshot().results.find(r=>r.resourceId===resourceId);
    const entity=s.source.entities.getById(`rail-safety:machine:${resourceId}:envelope`),world=entity.polygon.hierarchy.getValue(w.viewer.clock.currentTime).positions;
    const shown=world.map(p=>{const c=C.Cartographic.fromCartesian(p);return G.projectWgs84ToLocal({longitude:C.Math.toDegrees(c.longitude),latitude:C.Math.toDegrees(c.latitude),height:c.height},envelope.origin);});
    const extents=ring=>({xmin:Math.min(...ring.map(p=>p.x)),xmax:Math.max(...ring.map(p=>p.x)),ymin:Math.min(...ring.map(p=>p.y)),ymax:Math.max(...ring.map(p=>p.y))});
    const radii=envelope.polygon.map(p=>Math.hypot(p.x,p.y));return{method:envelope.method,vertices:envelope.polygon.length,renderedVertices:shown.length,minRadius:Math.min(...radii),maxRadius:Math.max(...radii),samplingMarginMeters:envelope.samplingMarginMeters,stripMarginMeters:envelope.stripMarginMeters,computedExtents:extents(envelope.polygon),renderedExtents:extents(shown),relation:computed.relation,reportedRelation:result.limits.find(l=>l.id===limitId).status,intersectionCount:computed.intersectionPolygons.length,visibleIntersectionCount:visual.intersections.find(i=>i.limitId===limitId)?.polygons.length??0,resultStatus:result.status};
  },{resourceId,limitId});
}
async function runCases() {
  await authorScene();await applyCustomColors();
  await displayTab('limits');await rp().locator('[data-display="limits.representation"]').selectOption('both');await settled();
  await check('six-range-effects-animate-real-materials-and-keep-color-alpha',async()=>{
    await applyEffects('static');const reference=await effectObservation();
    for(const key of [...Object.keys(colors),'wall']){const row=reference.entities[key];assert(row.fill,key+' fill');assert(row.fill.constant,key+' static constant');assert.equal(row.fill.color,colors[key==='wall'?'limit':key]);}
    assert.equal((await loopObservation()).scene.active,false);
    const modes=[];activeCheck.evidence={reference,modes};
    for(const mode of ['breathe','flow']){
      await applyEffects(mode);const firstFrame=await canvasFrame(mode+'-frame-1'),first=await effectObservation();await page.waitForFunction(frame=>window.__managementWorkspace.viewer.scene.frameState.frameNumber>=frame+12,firstFrame.frame,{timeout:30000});const secondFrame=await canvasFrame(mode+'-frame-2'),pixelComparison=compareFrames(firstFrame,secondFrame),second=await effectObservation();
      const evidence={mode,first,second,pixelComparison};modes.push(evidence);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
      for(const key of [...Object.keys(colors),'wall']){
        const a=first.entities[key],b=second.entities[key];for(const part of ['fill','line']){assert(a[part]&&b[part],key+' '+part);assert.equal(b[part].mode,mode==='breathe'?1:2);assert.equal(b[part].constant,true);assert.equal(b[part].animated,true);assert.equal(b[part].color,reference.entities[key][part].color);assert.equal(b[part].alpha,reference.entities[key][part].alpha);assert.equal(b[part].speed,1);assert.equal(b[part].intensity,.55);}
      }
      assert(second.gpu.length>0,'No actual Cesium primitive material observed');assert(second.gpu.every(m=>m.mode===(mode==='breathe'?1:2)&&m.frameClock));assert.deepEqual(first.gpu.map(m=>m.primitiveId).sort(),second.gpu.map(m=>m.primitiveId).sort(),'Animated ground primitives must be reused');assert(pixelComparison.changedPixels>20,'Real scene framebuffer did not change with animated range materials');assert((await loopObservation()).scene.active);
    }
    await unchanged();await screenshot('01-flow-directional-envelope');
    const owner=(await snapshot()).session.userId,projectId=(await snapshot()).projectId;
    const stored=await page.evaluate(({owner,projectId})=>JSON.parse(localStorage.getItem(`rail-safety-display:v1:${JSON.stringify([projectId,owner])}`)),{owner,projectId});
    assert.deepEqual(stored.effects,(await sceneSnapshot()).display.effects);assert.deepEqual(stored.colors,colors);
    return{reference,modes,persistenceKeyIncludesActorAndProject:true,recordsAndRiskUnchanged:true};
  });
  await check('directional-outline-is-not-center-circle-and-matches-screening',async()=>{
    const value=await envelopeObservation();assert(value.vertices>=3);assert(value.maxRadius-value.minRadius>.05,'Default envelope still has one constant radius');
    for(const key of Object.keys(value.computedExtents))assert(Math.abs(value.computedExtents[key]-value.renderedExtents[key])<.05,key+' rendered extent');
    assert.equal(value.relation,value.reportedRelation);assert.equal(value.visibleIntersectionCount,value.intersectionCount);assert.equal(value.resultStatus,'overlap');await unchanged();return value;
  });
  await check('hidden-effects-stop-refresh-and-restore',async()=>{
    await dock('display');await sa('hide-all').click();await settled();
    await page.waitForFunction(()=>!window.__managementWorkspace.railSafety.scene.effectRenderLoop.active);const hidden=await loopObservation();assert.equal(hidden.scene.pendingFrame,false);assert.equal(hidden.demo.active,false);
    await sa('show-all').click();await settled();assert((await loopObservation()).scene.active);await unchanged();
    await dock('editor');await applyEffects('static');const stopped=await loopObservation();assert.equal(stopped.scene.active,false);assert.equal(stopped.scene.pendingFrame,false);return{hidden,restored:true,static:stopped};
  });
  await check('animated-pose-group-and-exit-preserve-original-and-business',async()=>{
    await selectMachine();await displayTab('envelopes');const details=rp().locator('details.rs-range-effects');if((await details.getAttribute('open'))===null)await details.locator('summary').click();await rp().locator('[data-display="effects.envelope.mode"]').selectOption('flow');await action('fall-start').click();await waitDemoReady();await setPose(23,30);const initial=await projectionObservation();assert(initial.mask.emptyInsideConvexHull>0);assert((await loopObservation()).demo.active);
    await screenshot('02-flow-angle-projection');const modes=[];activeCheck.evidence={initial,modes};
    for(const mode of ['pose','overview','both']){await representation(mode);const o=await projectionObservation();const overview=await page.evaluate(id=>!!window.__managementWorkspace.railSafety.scene.source.entities.getById(`rail-safety:machine:${id}:envelope`),resourceId);assert.equal(overview,mode!=='pose');assert.equal(o.footprint.show,mode!=='overview');modes.push({mode,overview,footprint:o.footprint});}
    await createGroup();await sp().locator(`section[data-group-id="${groupId}"] [data-action="group-hide"]`).click();await settled();const hidden=await projectionObservation();assert.equal(hidden.footprint.show,false);assert.equal((await loopObservation()).demo.active,false);assert.equal((await loopObservation()).scene.active,false);
    await sp().locator(`section[data-group-id="${groupId}"] [data-action="group-show"]`).click();await settled();assert((await loopObservation()).demo.active);await unchanged();
    await dock('editor');await action('fall-stop').click();await settled();const o=await demoObservation();assert.equal(o.state.active,false);assert.equal(o.model,null);assert.equal(o.primitives.length,0);assert.equal((await loopObservation()).demo.active,false);
    const remains=await page.evaluate(()=>{const v=window.__managementWorkspace.viewer,d=window.__managementWorkspace.railSafety.scene.fallDemo,entities=Array.from({length:v.dataSources.length},(_,i)=>v.dataSources.get(i)).flatMap(s=>s.entities.values.filter(e=>e.id.startsWith('rail-safety:fall-demo:')).map(e=>e.id)),groundIds=[],seen=new Set();function visit(p){if(!p||seen.has(p)||p.isDestroyed?.())return;seen.add(p);for(const id of [p.id,...(p._instanceIds||[])]){const name=typeof id==='string'?id:id?.id;if(name?.startsWith('rail-safety:fall-demo:'))groundIds.push(name);}for(const a of [p._primitives,p._collectionsArray])if(Array.isArray(a))a.forEach(visit);visit(p._primitive);}visit(v.scene.groundPrimitives);return{entities,groundIds,projectionClientPresent:!!d.projectionClient,canvasPresent:!!d.canvas,objectUrlPresent:!!d.objectUrl};});assert.deepEqual(remains,{entities:[],groundIds:[],projectionClientPresent:false,canvasPresent:false,objectUrlPresent:false});
    await applyEffects('static');const loops=await loopObservation();assert.equal(loops.scene.active,false);assert.equal(loops.demo.active,false);assert.equal(loops.scene.pendingFrame,false);assert.equal(loops.demo.pendingFrame,false);await unchanged();assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);
    return{initial,modes,hidden:hidden.footprint,loops,remains,remainingDemoModel:null,displayBusinessCommands:0,originalMatrixUnchanged:true,riskResultsUnchanged:true,pageErrors:[],consoleErrors:[]};
  });
  await check('device-http-ingest-reaches-panel-and-expiry-without-simulation',async()=>{
    await openPanel();await action('tab-guard').click();await rp().locator('[data-role="selection"]').selectOption(guardId);await settled();
    const positioningBaseline={results:(await sceneSnapshot()).results,geometry:await envelopeObservation()};
    const samples=[];activeCheck.evidence={positioningBaseline,samples};
    for(const [expected,point] of [['inside',local(-18,0,12)],['outside',local(0,0,12)]]){
      const sample={projectId:'safety:project',deviceId:'range-projection-device',coordinateSystem:'WGS84',position:point,timestamp:new Date().toISOString(),accuracyMeters:.5,source:'measured'};
      const response=await context.request.post(origin+'/__management/positioning/ingest',{headers:{'Content-Type':'application/json',Authorization:'Bearer '+locatorToken},data:sample});assert.equal(response.status(),202,await response.text());
      await page.waitForFunction(({guardId,expected})=>window.__managementWorkspace.railSafety.scene.getSnapshot().guardPositions.find(p=>p.guardId===guardId)?.result.state===expected,{guardId,expected},{timeout:15000});
      const state=(await sceneSnapshot()).guardPositions.find(p=>p.guardId===guardId).result;assert.equal(state.source,'measured');assert.equal(state.isAlarm,expected==='outside');assert(await action('simulate-position').isDisabled());samples.push({expected,state});
    }
    await page.waitForFunction(guardId=>window.__managementWorkspace.railSafety.scene.getSnapshot().guardPositions.find(p=>p.guardId===guardId)?.result.state==='stale',guardId,{timeout:15000});
    const expired=(await sceneSnapshot()).guardPositions.find(p=>p.guardId===guardId).result;activeCheck.evidence.expired=expired;assert.equal(expired.isAlarm,false);assert.equal(expired.source,'measured');
    assert.equal(JSON.stringify((await snapshot()).collections),baseline.records);assert.deepEqual((await sceneSnapshot()).results,positioningBaseline.results);assert.deepEqual(await envelopeObservation(),positioningBaseline.geometry);assert.equal(report.requests.length,baseline.commands);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);
    return{transport:'POST measured HTTP sample, authenticated GET polling, actual work-area state UI',positioningBaseline,samples,expired,recordsAndRiskAndIntersectionGeometryUnchanged:true,simulatedOverrideDisabled:true,productionDataReadOrModified:false};
  });

}

try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const options=process.env.BROWSER_LAUNCH_OPTIONS?(await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default:{headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined};
 server=await createServer({server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:null},plugins:[{name:'isolated-display-fixture',configResolved(config){config.server.watch=null;},resolveId(id){if(id==='/__display-fixture/cesium.ts')return '\0display-fixture-cesium';},load(id){if(id==='\0display-fixture-cesium')return 'export * from "cesium";';},configureServer(s){s.middlewares.use((req,res,next)=>{let value;if(req.url==='/__display-fixture/tileset.json')value=fixtureTiles;else if(req.url==='/__display-fixture/slope.gltf')value=fixtureGltf;else return next();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});}}]});await server.listen();const address=server.httpServer.address();origin=`http://127.0.0.1:${address.port}`;report.origin=origin;console.log('Isolated range-effects acceptance server:',origin,'data:',dataDir);
 browser=await chromium.launch(options);report.browserVersion=browser.version();context=await browser.newContext({viewport:{width:1366,height:768}});await context.route('**/__basemap/**',r=>r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==','base64')}));page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.pageErrors.push({check:activeCheck?.id,message:e.message}));page.on('console',e=>{if(e.type()!=='error')return;const value={check:activeCheck?.id,message:e.text().slice(0,700),url:e.location().url};if(activeCheck?.id==='management-access-revocation-cannot-be-overridden'&&value.url.startsWith(origin+'/__management/')&&/status of 401/.test(value.message))report.expectedAuthErrors.push(value);else report.consoleErrors.push(value);});page.on('response',async r=>{if(r.status()>=400)console.log('HTTP_ERROR',r.status(),r.url(),(await r.text().catch(()=>'' )).slice(0,800));});page.on('requestfailed',r=>console.log('REQUEST_FAILED',r.url(),r.failure()));page.on('request',r=>{if(r.url().endsWith('/__management/commands')){try{report.requests.push({type:r.postDataJSON().type});}catch{}}});
 await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:60000});await ready();await fixtures();await page.reload({waitUntil:'domcontentloaded'});await ready();await page.locator('#basemap').selectOption('none');await runCases();report.result='passed';
}catch(error){report.result='failed';report.failure=String(error.stack||error);if(activeCheck?.status==='running'){activeCheck.status='failed';activeCheck.error=report.failure;}process.exitCode=1;console.error(error);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));if(page){await screenshot('failure',{failure:true}).catch(e=>{report.failureScreenshotError=String(e);});report.failureVisibleText=(await bounded(page.locator('body').innerText({timeout:5000}),6000,'Failure page text').catch(()=>'' )).slice(-10000);}}
finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await context?.close();await browser?.close();await server?.close();await rm(locatorConfigDir,{recursive:true,force:true});}
