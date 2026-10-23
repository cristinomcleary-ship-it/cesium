/**
 * Real Chromium/WebGL acceptance for range colours and posed triangle projections.
 * Uses a new SQLite directory, UI-authored safety records and an explicitly
 * synthetic raised/sloped 3D Tiles fixture. No production data is opened.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/path/to/launch_options.mjs \
 * node tools/verify-range-projection.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { Cartesian3, Transforms } from 'cesium';

const output = resolve(process.env.RANGE_PROJECTION_VERIFY_OUT || 'output/range-projection');
const remainingOnly = process.env.RANGE_PROJECTION_VERIFY_REMAINING_ONLY === '1';
const geometryOnly = remainingOnly || process.env.RANGE_PROJECTION_VERIFY_GEOMETRY_ONLY === '1';
const port = Number(process.env.RANGE_PROJECTION_VERIFY_PORT || 5196);
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'RANGE_PROJECTION_VERIFY_PORT must be a valid nonzero TCP port');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/range-projection-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { classification: 'actual-workbench-range-colors-and-posed-mesh-projection-webgl',
  startedAt: new Date().toISOString(), dataDir, productionDataReadOrModified: false,
  fixture: { location: { longitude: 116.391, latitude: 39.907 }, width: 100, depth: 100,
    heightFormula: '12 + 0.12 * east + 0.06 * north (metres)',
    limitations: ['Synthetic 3D Tiles geometry; not a surveyed site or accuracy certification', 'Software WebGL renderer when supplied launch options use SwiftShader'] },
  mode: remainingOnly ? 'mask-and-lifecycle-follow-up' : geometryOnly ? 'geometry-follow-up' : 'full', checks: [], screenshots: [], pageErrors: [], consoleErrors: [], expectedAuthErrors: [], requests: [] };
let server, browser, context, page, origin, activeCheck;
const site = { longitude: 116.391, latitude: 39.907, height: 0 };
const resourceId = 'projection-crane-01';
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
async function check(id, run) { if(remainingOnly&&id==='continuous-17-and-23-degree-poses-and-mobile-scroll')return; if(geometryOnly&&['six-colors-update-real-materials-and-legend','colors-persist-on-refresh-in-actor-project-scope'].includes(id))return; activeCheck={id,status:'running'};report.checks.push(activeCheck);console.log('RUN',id);activeCheck.evidence=await run();activeCheck.status='passed';console.log('PASS',id);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)); }
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
  await openPanel();await action('tab-guard').click();await action('new').click();await field('name').fill('范围配色验收防护员');
  for(const[k,v]of Object.entries(station))await field('station.'+k).fill(String(v));await addPolygon(polygon(-33,-18,1,20));
  await field('work-area-enabled').check();await addPolygon(polygon(-26,-10,-10,10),'workArea');await field('workArea.deviceId').fill('range-projection-device');await field('workArea.staleAfterSeconds').fill('3600');await rp().locator(`[data-reference="resource"][value="${resourceId}"]`).check();await save();
  guardId=(await snapshot()).collections.railSafety.find(r=>r.definition.kind==='guard').id;
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
    const pixels=d.footprint.polygon.material.image.getValue(t).getContext('2d').getImageData(0,0,r.width,r.height).data;let textureOccupied=0,maxFillChannelError=0,fillToleranceMax=0,colorViolations=0;const textureColors=new Set(),opaqueColors=new Set(),rgb=[1,3,5].map(i=>parseInt(d.display.color.slice(i,i+2),16));for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]){textureOccupied++;const hex='#'+[pixels[i],pixels[i+1],pixels[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('');textureColors.add(hex);const alpha=pixels[i+3],tolerance=alpha===255?0:Math.ceil(255/(2*alpha));if(alpha===255)opaqueColors.add(hex);else fillToleranceMax=Math.max(fillToleranceMax,tolerance);for(let c=0;c<3;c++){const error=Math.abs(pixels[i+c]-rgb[c]);if(alpha!==255)maxFillChannelError=Math.max(maxFillChannelError,error);if(error>tolerance)colorViolations++;}}
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
async function runCases() {
  await authorScene();if(geometryOnly)await applyCustomColors();if(remainingOnly){await page.setViewportSize({width:1366,height:768});await selectMachine();await action('fall-start').click();await waitDemoReady();await setPose(23,30);}
  await check('six-colors-update-real-materials-and-legend',async()=>{
    await applyCustomColors();
    const observed=await materials(),display=(await sceneSnapshot()).display,expectedAlpha={responsibility:display.guards.opacity,workArea:Math.min(.25,display.guards.opacity),limit:.16,envelope:display.envelopes.opacity,support:Math.min(.12,display.envelopes.opacity/2),risk:Math.max(.48,display.envelopes.opacity)};for(const key of Object.keys(colors)){assert.equal(observed[key].fill,colors[key]);assert(Math.abs(observed[key].alpha-expectedAlpha[key])<1e-10);}
    const legend=await rp().locator('[data-range-color]').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.dataset.rangeColor,n.style.backgroundColor])));
    const normalized=await page.evaluate(colors=>Object.fromEntries(Object.entries(colors).map(([key,value])=>{const e=document.createElement('i');e.style.color=value;return[key,e.style.color];})),colors);assert.deepEqual(legend,normalized);await unchanged();
    return{colors,materials:observed,legend,recordsAndRiskUnchanged:true};
  });
  await check('colors-persist-on-refresh-in-actor-project-scope',async()=>{
    const owner=(await snapshot()).session.userId,projectId=(await snapshot()).projectId;
    const stored=await page.evaluate(({owner,projectId})=>({key:`rail-safety-display:v1:${JSON.stringify([projectId,owner])}`,value:JSON.parse(localStorage.getItem(`rail-safety-display:v1:${JSON.stringify([projectId,owner])}`))}),{owner,projectId});assert.deepEqual(stored.value.colors,colors);
    await page.reload({waitUntil:'domcontentloaded'});await ready();await selectMachine();assert.deepEqual((await sceneSnapshot()).display.colors,colors);
    // Reload creates a new original GLB URL; the original actual matrix must still match.
    const reloadedPose=await machinePose();assert.deepEqual(reloadedPose.matrix,baseline.pose.matrix);baseline.pose=reloadedPose;await unchanged();return{owner,projectId,storageKey:stored.key,restoredColors:colors};
  });
  await check('continuous-17-and-23-degree-poses-and-mobile-scroll',async()=>{
    await page.setViewportSize({width:1366,height:768});await selectMachine();await action('fall-start').click();await waitDemoReady();
    const scroll=rp().locator('.rs-scroll');await scroll.waitFor({state:'visible'});const box=await scroll.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-10000);await page.waitForFunction(()=>document.querySelector('.rail-safety-panel .rs-scroll').scrollTop===0);
    let hits;for(let i=0;i<25;i++){hits=await rp().locator('[data-fall]').evaluateAll(nodes=>nodes.map(el=>{const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,target=document.elementFromPoint(x,y);return{parameter:el.dataset.fall,x,y,hit:target===el||el.contains(target)};}));if(hits.length===2&&hits.every(h=>h.hit))break;const top=await scroll.evaluate(el=>el.scrollTop);await page.mouse.wheel(0,120);await page.waitForFunction(top=>{const el=document.querySelector('.rail-safety-panel .rs-scroll');return el.scrollTop>top||el.scrollTop>=el.scrollHeight-el.clientHeight;},top);}
    assert(hits.length===2&&hits.every(h=>h.hit),JSON.stringify(hits));
    await setPose(17,30);const a=await projectionObservation();await setPose(23,30);const b=await projectionObservation();assert.equal(a.state.actualDirection,17);assert.equal(b.state.actualDirection,23);assert(Math.abs(a.measuredPose.direction-17)<1e-4);assert(Math.abs(b.measuredPose.direction-23)<1e-4);assert.notDeepEqual(a.model.matrix,b.model.matrix);assert.notEqual(a.mask.hash,b.mask.hash);await unchanged();
    return{viewport:{width:1366,height:768},parameterHits:hits,at17:a,at23:b};
  });
  await check('angle-masks-and-real-model-stay-synchronized',async()=>{
    await frameDemo();const states=[];
    for(const angle of [0,30,60,90]){await setPose(23,angle);const value=await projectionObservation();assert.equal(value.state.projectionAngle,angle);assert(value.mask.occupied>0);assert(value.mask.emptyInsideConvexHull>0,'Mesh holes or concavity must remain; this must not be a circle/convex envelope');assert(value.mask.cellSizeMeters>0);assert(Math.abs(value.mask.areaMeters2-value.mask.occupied*value.mask.cellSizeMeters**2)<1e-6);assert(value.primitives.some(p=>p.ready&&p.id.endsWith(':model')));assert(value.footprintPrimitives.some(p=>p.ready),JSON.stringify({footprint:value.footprint,primitives:value.footprintPrimitives}));assert(Math.abs(value.measuredPose.angle-angle)<1e-4);if(angle>0)assert(Math.abs(value.measuredPose.direction-23)<1e-4);states.push(value);if(angle===30||angle===90)await screenshot(`0${angle===30?1:2}-projection-${angle}-degrees`);}
    assert.equal(new Set(states.map(s=>s.mask.hash)).size,4);for(let i=1;i<states.length;i++)assert.notDeepEqual(states[i].model.matrix,states[i-1].model.matrix);
    await action('fall-play').click();await page.waitForFunction(()=>{const s=window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo;return s.playing&&s.projectionAngle>.5&&s.projectionAngle<89;},undefined,{timeout:30000});await action('fall-play').click();await page.waitForFunction(()=>{const s=window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo;return !s.playing&&!s.projectionBusy&&s.projectionReady&&Math.abs(s.projectionAngle-s.angle)<1e-8;},undefined,{timeout:30000});await settled();const playback=await projectionObservation();assert(playback.state.projectionAngle>.5&&playback.state.projectionAngle<89);assert(Math.abs(playback.measuredPose.angle-playback.state.projectionAngle)<1e-4);
    const status=await rp().locator('[data-role="fall-status"]').innerText();assert.match(status,/显示网格/);await unchanged();return{states,playback,status,conservativeCellBoundaryError:'At most sqrt(2) times the reported cell size, plus floating-point tolerance; not an exact intersection polygon'};
  });
  await check('representation-and-right-group-control-projection',async()=>{
    const modes=[];for(const mode of ['pose','overview','both']){await representation(mode);const o=await projectionObservation();const overview=await page.evaluate(id=>!!window.__managementWorkspace.railSafety.scene.source.entities.getById(`rail-safety:machine:${id}:envelope`),resourceId);assert.equal(overview,mode!=='pose');assert.equal(o.footprint.show,mode!=='overview');modes.push({mode,overview,footprint:o.footprint});}
    await createGroup();await sp().locator(`section[data-group-id="${groupId}"] [data-action="group-hide"]`).click();await settled();const hidden=await projectionObservation();assert.equal(hidden.footprint.show,false);assert.equal(await page.evaluate(id=>window.__managementWorkspace.machinery.scene.source.entities.getById('machinery:'+id).show,resourceId),false);
    await sp().locator(`section[data-group-id="${groupId}"] [data-action="group-show"]`).click();await settled();const shown=await projectionObservation();assert(shown.footprint.show);await unchanged();return{modes,hidden:hidden.footprint,shown:shown.footprint};
  });
  await check('exit-cleans-projection-and-preserves-business-and-original',async()=>{
    await dock('editor');await action('fall-stop').click();await settled();const o=await demoObservation();assert.equal(o.state.active,false);assert.equal(o.model,null);assert.equal(o.primitives.length,0);
    const remains=await page.evaluate(()=>{const v=window.__managementWorkspace.viewer,entities=Array.from({length:v.dataSources.length},(_,i)=>v.dataSources.get(i)).flatMap(s=>s.entities.values.filter(e=>e.id.startsWith('rail-safety:fall-demo:')).map(e=>e.id)),groundIds=[],seen=new Set();function visit(p){if(!p||seen.has(p)||p.isDestroyed?.())return;seen.add(p);for(const id of [p.id,...(p._instanceIds||[])]){const name=typeof id==='string'?id:id?.id;if(name?.startsWith('rail-safety:fall-demo:'))groundIds.push(name);}for(const a of [p._primitives,p._collectionsArray])if(Array.isArray(a))a.forEach(visit);visit(p._primitive);}visit(v.scene.groundPrimitives);return{entities,groundIds};});assert.deepEqual(remains,{entities:[],groundIds:[]});await unchanged();assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);return{remainingDemoEntities:remains,displayBusinessCommands:0,originalMatrixUnchanged:true,riskResultsUnchanged:true,pageErrors:[],consoleErrors:[]};
  });
}

try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const options=process.env.BROWSER_LAUNCH_OPTIONS?(await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default:{headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined};
 server=await createServer({server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:null},plugins:[{name:'isolated-display-fixture',configResolved(config){config.server.watch=null;},resolveId(id){if(id==='/__display-fixture/cesium.ts')return '\0display-fixture-cesium';},load(id){if(id==='\0display-fixture-cesium')return 'export * from "cesium";';},configureServer(s){s.middlewares.use((req,res,next)=>{let value;if(req.url==='/__display-fixture/tileset.json')value=fixtureTiles;else if(req.url==='/__display-fixture/slope.gltf')value=fixtureGltf;else return next();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});}}]});await server.listen();const address=server.httpServer.address();origin=`http://127.0.0.1:${address.port}`;report.origin=origin;console.log('Isolated range-projection acceptance server:',origin,'data:',dataDir);
 browser=await chromium.launch(options);report.browserVersion=browser.version();context=await browser.newContext({viewport:{width:1920,height:1080}});await context.route('**/__basemap/**',r=>r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==','base64')}));page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.pageErrors.push({check:activeCheck?.id,message:e.message}));page.on('console',e=>{if(e.type()!=='error')return;const value={check:activeCheck?.id,message:e.text().slice(0,700),url:e.location().url};if(activeCheck?.id==='management-access-revocation-cannot-be-overridden'&&value.url.startsWith(origin+'/__management/')&&/status of 401/.test(value.message))report.expectedAuthErrors.push(value);else report.consoleErrors.push(value);});page.on('response',async r=>{if(r.status()>=400)console.log('HTTP_ERROR',r.status(),r.url(),(await r.text().catch(()=>'' )).slice(0,800));});page.on('requestfailed',r=>console.log('REQUEST_FAILED',r.url(),r.failure()));page.on('request',r=>{if(r.url().endsWith('/__management/commands')){try{report.requests.push({type:r.postDataJSON().type});}catch{}}});
 await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:60000});await ready();await fixtures();await page.reload({waitUntil:'domcontentloaded'});await ready();await page.locator('#basemap').selectOption('none');await runCases();report.result='passed';
}catch(error){report.result='failed';report.failure=String(error.stack||error);if(activeCheck?.status==='running'){activeCheck.status='failed';activeCheck.error=report.failure;}process.exitCode=1;console.error(error);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));if(page){await screenshot('failure',{failure:true}).catch(e=>{report.failureScreenshotError=String(e);});report.failureVisibleText=(await bounded(page.locator('body').innerText({timeout:5000}),6000,'Failure page text').catch(()=>'' )).slice(-10000);}}
finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await context?.close();await browser?.close();await server?.close();}
