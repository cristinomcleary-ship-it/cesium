/**
 * Real Chromium / Cesium / project-library acceptance checks.
 * By default, starts Vite with new temporary project/data directories:
 *   node tools/verify-model-placement.mjs
 * Or run against a server with an EMPTY, DISPOSABLE CESIUM_DATA_DIR:
 *   CESIUM_DATA_DIR=/tmp/cesium-test-library npm run dev -- --port 4178
 *   TEST_BASE_URL=http://127.0.0.1:4178 node tools/verify-model-placement.mjs
 *
 * By default SKP conversion is substituted with a generated GLB. Set
 * TEST_REAL_SKP_FILE to an existing SKP to exercise the actual Windows SDK instead.
 * Default mode does not verify the Windows SDK. Placement, WebGL rendering,
 * movement, rotation, persistence and deletion use the real application/backend.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Cartesian3, Cartographic, Transforms, Math as CesiumMath } from 'cesium';

const require = createRequire(import.meta.url);
const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || `${runtimeModules}/playwright`);
const { PNG } = require(`${runtimeModules}/pngjs`);
const realSkpPath = process.env.TEST_REAL_SKP_FILE;
const realSkp = realSkpPath ? await readFile(realSkpPath) : undefined;
const modelTimeout = Number(process.env.TEST_MODEL_TIMEOUT_MS || (realSkp ? 180_000 : 30_000));
const scope = realSkp ? 'Real browser, Cesium WebGL, library persistence and Windows SketchUp SDK conversion' : 'Real browser, real Cesium WebGL, real library persistence; SKP conversion mocked explicitly';
const conversionResponses = [];
let baseURL = process.env.TEST_BASE_URL;
const output = resolve(process.env.TEST_OUTPUT || 'output/model-placement-acceptance');
await mkdir(output, { recursive: true });
// A self-hosted disposable server also keeps browser/server in the same sandbox
// network namespace. Supplying TEST_BASE_URL opts into an existing test server.
let server;
if (!baseURL) {
  const dataRoot = await mkdtemp(resolve(tmpdir(),'cesium-placement-'));
  process.env.CESIUM_DATA_DIR = resolve(dataRoot,'library');
  process.env.CESIUM_SAFETY_DATA_DIR = resolve(dataRoot,'safety');
  process.env.CESIUM_MANAGEMENT_DATA_DIR = resolve(dataRoot,'management');
  const { createServer } = await import('vite');
  server = await createServer({ server:{host:'127.0.0.1',port:0,hmr:false} });
  await server.listen();
  baseURL = `http://127.0.0.1:${server.httpServer.address().port}`;
}

function cubeGlb() {
  const positions = new Float32Array([-15,0,-10,15,0,-10,15,20,-10,-15,20,-10,-15,0,10,15,0,10,15,20,10,-15,20,10]);
  const indices = new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const gltf = { asset:{version:'2.0',generator:'Cesium placement acceptance fixture'}, extensionsUsed:['KHR_materials_unlit'], scene:0, scenes:[{nodes:[0]}],
    // Deliberately displaced source origin: placement must recenter the geometry.
    nodes:[{mesh:0,translation:[100000,50,-75000]}], meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[1,0.02,0.04,1],metallicFactor:0,roughnessFactor:1},extensions:{KHR_materials_unlit:{}},doubleSided:true}],
    buffers:[{byteLength:bin.length}], bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength,target:34962},{buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength,target:34963}],
    accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[-15,0,-10],max:[15,20,10]},{bufferView:1,componentType:5123,count:36,type:'SCALAR'}] };
  const encoded = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.concat([encoded, Buffer.alloc((4-encoded.length%4)%4, 0x20)]);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2,4); header.writeUInt32LE(28+json.length+bin.length,8); header.writeUInt32LE(json.length,12); header.writeUInt32LE(0x4e4f534a,16);
  const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(bin.length); binaryHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,json,binaryHeader,bin]);
}
const fixture = cubeGlb();
await writeFile(resolve(output,'offset-cube.glb'),fixture);
async function api(path, method='GET', data, contentType='application/json') {
  const response = await fetch(baseURL+path,{method,headers:{'X-Cesium-Library':'1',...(data === undefined?{}:{'Content-Type':contentType})},body:data===undefined?undefined:contentType==='application/json'?JSON.stringify(data):data});
  const json = await response.json();
  assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  if (path.startsWith('/__models/import')) conversionResponses.push({source:'verifier-api',path,...json});
  return json;
}
const listing = () => api('/__library/records');
assert.equal((await listing()).records.length,0,'Use an empty disposable CESIUM_DATA_DIR; verifier never clears existing records.');
const location = Cartesian3.fromDegrees(121,31,500);
const frame = Transforms.eastNorthUpToFixedFrame(location);
const view = { position:[location.x,location.y,location.z], direction:[-frame[8],-frame[9],-frame[10]], up:[frame[4],frame[5],frame[6]],basemap:'none' };
await api('/__library/view','PUT',view);
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/workspace/scratch/4fcac4ebafbd/tooling/browser-runtime/chromium-wrapper',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context = await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const errors = [];
page.on('pageerror',error => errors.push(error.stack || error.message));
let skpConversions = 0;
await context.route('**/*',async route => {
  const url = new URL(route.request().url());
  if (url.origin !== new URL(baseURL).origin && !['blob:','data:'].includes(url.protocol)) return route.abort();
  return route.continue();
});
if (!realSkp) await page.route('**/__models/status',async route => {
  const response = await route.fetch(); const status = await response.json();
  status.converters.skp = true;
  status.converterStatus ??= {};
  status.converterStatus.skp = {available:true,reason:'Browser test substitution: Windows conversion is not under test'};
  await route.fulfill({response,json:status});
});
if (!realSkp) await page.route('**/__models/import?**',async route => {
  if (new URL(route.request().url()).searchParams.get('extension')!=='skp') return route.continue();
  skpConversions++;
  const native = await api('/__models/import?extension=glb&name=browser-conversion-fixture.glb','POST',fixture,'application/octet-stream');
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...native,converted:true})});
});
await page.exposeFunction('__recordModelAcceptanceConversion', result => {
  conversionResponses.push({source:'browser-fetch',...result});
  if (realSkp && new URL(result.path,baseURL).searchParams.get('extension')==='skp' && result.ok) skpConversions++;
});
await page.addInitScript(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const started=Date.now(), response=await nativeFetch(...args);
    const input=args[0], url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
    if (url.pathname==='/__models/import') {
      const result=await response.clone().json();
      await window.__recordModelAcceptanceConversion({path:url.pathname+url.search,status:response.status,durationMs:Date.now()-started,...result});
    }
    return response;
  };
});
const checks = [];
function passed(name,detail={}) { checks.push({name,...detail}); console.log('PASS',name); }
async function until(condition,message,timeout=30_000) {
  const start = Date.now(); let last;
  while(Date.now()-start<timeout) { try { const result = await condition(); if(result)return result; } catch(error){last=error;} await new Promise(resolve=>setTimeout(resolve,100)); }
  throw new Error(message+(last?`: ${last.message}`:''));
}
async function openModels() { await page.locator('.tab[data-tab="models"]').click(); }
async function choose(name) { await page.locator('#modelFile').setInputFiles({name,mimeType:'application/octet-stream',buffer:name.endsWith('.skp')?(realSkp || Buffer.from('mock SKP input; conversion substituted explicitly')):fixture}); }
async function waitPending() { await until(async()=>await page.locator('#cesiumContainer canvas').first().evaluate(c=>c.style.cursor==='crosshair'),'Map placement did not become active',modelTimeout); }
async function pointPlace(x=.38,y=.49) { const box=await page.locator('#cesiumContainer canvas').first().boundingBox(); assert.ok(box); await page.mouse.click(box.x+box.width*x,box.y+box.height*y); }
async function countRedPixels() {
  const png=PNG.sync.read(await page.screenshot()); const box=await page.locator('#cesiumContainer canvas').first().boundingBox(); let count=0;
  // Only central map pixels, excluding toolbars and the right settings panel.
  for(let y=Math.max(100,Math.ceil(box.y));y<Math.min(png.height-200,box.y+box.height);y++)for(let x=Math.max(0,Math.ceil(box.x));x<Math.min(1000,box.x+box.width);x++) {const i=(y*png.width+x)*4;if(png.data[i]>150&&png.data[i+1]<80&&png.data[i+2]<100)count++;}
  return count;
}
async function visibleModelDifference(id) {
  const canvas = page.locator('#cesiumContainer canvas').first();
  await page.locator('[data-dock="display"]').click();
  await page.locator('.scene-display-panel [data-action="view-categories"]').click();
  const toggle = page.locator('.sdp-item[data-display-id="layer:'+id+'"] [data-action="item-visibility"]');
  await page.waitForTimeout(2200); // Finish the application's post-placement camera flight.
  const visible = PNG.sync.read(await canvas.screenshot({path:resolve(output,'real-skp-visible.png')}));
  await toggle.click();
  await page.waitForTimeout(500);
  const hidden = PNG.sync.read(await canvas.screenshot({path:resolve(output,'real-skp-hidden.png')}));
  await toggle.click();
  await page.waitForTimeout(500);
  let changedPixels = 0;
  assert.equal(visible.width,hidden.width); assert.equal(visible.height,hidden.height);
  for (let i=0;i<visible.data.length;i+=4) if (Math.max(Math.abs(visible.data[i]-hidden.data[i]),Math.abs(visible.data[i+1]-hidden.data[i+1]),Math.abs(visible.data[i+2]-hidden.data[i+2]))>25) changedPixels++;
  assert.ok(changedPixels>100,'Real SKP produced only '+changedPixels+' visible model pixels');
  await page.locator('.sdp-item[data-display-id="layer:'+id+'"] [data-action="item-edit"]').click();
  return changedPixels;
}
try {
  await page.goto(baseURL+'/?interface=legacy',{waitUntil:'domcontentloaded'});
  await until(async()=>await page.locator('#libraryStatus').textContent()!=='正在读取资料…','Library startup did not finish',60_000);
  await openModels();
  await choose('acceptance-offset-model.skp');
  assert.equal(await page.locator('#modelPlacement').inputValue(),'mapPick');
  await page.locator('#loadModel').click(); await waitPending();
  assert.equal((await listing()).records.length,0,'No persistent record exists before map placement');
  await page.screenshot({path:resolve(output,'01-awaiting-map-pick.png')});
  await pointPlace();
  const first = await until(async()=>{const records=(await listing()).records;return records.length===1&&records[0].settings.editor?records[0]:false;},'Placed model and editor origin were not saved');
  await until(async()=>await page.locator('#editingModelName').textContent()==='acceptance-offset-model.skp','Placed model not selected for editing');
  const renderedPixels = realSkp ? await visibleModelDifference(first.id) : await until(async()=>{const count=await countRedPixels();return count>50?count:false;},'Offset GLB was not visibly rendered in map');
  const framePosition=Cartesian3.fromArray(first.settings.editor?.center || first.settings.matrix.slice(12,15));
  const cartographic=Cartographic.fromCartesian(framePosition);
  assert.ok(Math.abs(CesiumMath.toDegrees(cartographic.longitude)-121)<.03,'Placed geometry is near picked longitude');
  assert.ok(Math.abs(CesiumMath.toDegrees(cartographic.latitude)-31)<.03,'Placed geometry is near picked latitude');
  passed(realSkp ? 'Actual SKP → Windows SDK conversion → map pick → visibly rendered and saved' : 'SKP UI → map pick → real offset GLB visible and saved',{renderedPixels,renderEvidence:realSkp?'Model visible/hidden canvas difference':'Red fixture pixels',recordId:first.id});
  await page.screenshot({path:resolve(output,'02-placed-model.png')});

  for (const [id,value] of [['modelEditEast','12.5'],['modelEditNorth','-7'],['modelEditUp','3'],['modelEditHeading','35']]) await page.locator('#'+id).fill(value);
  await page.locator('#applyModelTransform').click();
  const moved=await until(async()=>{const record=(await listing()).records.find(r=>r.id===first.id);return record?.settings.editor?.east===12.5&&record.settings.editor.north===-7?record:false;},'Transform was not saved');
  assert.equal(moved.settings.editor.up,3); assert.ok(Math.abs(moved.settings.editor.heading-35*Math.PI/180)<1e-8); assert.notDeepEqual(moved.settings.matrix,first.settings.matrix);
  await page.reload({waitUntil:'domcontentloaded'}); await openModels();
  await until(async()=>Number(await page.locator('#modelEditEast').inputValue())===12.5,'Saved transform did not restore',60_000);
  assert.equal(Number(await page.locator('#modelEditNorth').inputValue()),-7); assert.equal(Number(await page.locator('#modelEditUp').inputValue()),3); assert.equal(Number(await page.locator('#modelEditHeading').inputValue()),35);
  passed('Translation and rotation persist across real page reload');

  await page.locator('#relocateModel').click(); await waitPending(); await page.keyboard.press('Escape');
  await until(async()=>!(await page.locator('#cesiumContainer canvas').first().evaluate(c=>c.style.cursor==='crosshair')),'Relocation cancellation did not restore cursor');
  assert.deepEqual((await listing()).records.find(r=>r.id===first.id).settings.matrix,moved.settings.matrix,'Cancel relocation must leave saved transform unchanged');
  passed('Escape cancels relocation without moving saved model');

  await page.locator('#relocateModel').click(); await waitPending(); await pointPlace(.59,.42);
  await until(async()=>{const record=(await listing()).records.find(r=>r.id===first.id);return record.settings.editor?.east===0&&record.settings.editor?.north===0&&JSON.stringify(record.settings.matrix)!==JSON.stringify(moved.settings.matrix);},'Relocation did not persist a new adjustment origin');
  passed('Existing model can be re-placed with a new map click');

  await choose('cancel-before-placement.skp'); await page.locator('#loadModel').click(); await waitPending(); await page.locator('#cancelModelLoad').click();
  await until(async()=>await page.locator('#loadModel').isEnabled(),'Cancel did not release import UI');
  assert.equal((await listing()).records.length,1);
  assert.equal(await page.locator('.layer-row').filter({hasText:'cancel-before-placement.skp'}).count(),0);
  passed('Cancel before map pick creates no persistent record');

  await choose('acceptance-retained-model.glb'); await page.locator('#loadModel').click(); await waitPending(); await pointPlace(.46,.56);
  const both=await until(async()=>{const records=(await listing()).records;return records.length===2?records:false;},'Second native GLB was not placed');
  const retained=both.find(r=>r.id!==first.id); assert.ok(retained);
  await page.locator('[data-dock="display"]').click();
  const display=page.locator('.scene-display-panel');
  await display.locator('[data-action="view-categories"]').click();
  const firstRow=display.locator('.sdp-item').filter({hasText:first.name}); const retainedRow=display.locator('.sdp-item').filter({hasText:retained.name});
  await firstRow.locator('input[data-select-item]').check(); await retainedRow.locator('input[data-select-item]').check();
  const deletedDisplayId=await firstRow.getAttribute('data-display-id'); const retainedDisplayId=await retainedRow.getAttribute('data-display-id');
  await display.locator('[data-action="create-group"]').click(); await display.locator('[data-role="group-name"]').fill('Browser acceptance group'); await display.locator('[data-action="save-group"]').click();
  const group=display.locator('.sdp-group').filter({hasText:'Browser acceptance group'}); assert.equal(await group.locator('.sdp-item').count(),2);
  let failDelete = true;
  await page.route(`**/__library/records/${first.id}`,async route=> {
    if (failDelete && route.request().method()==='DELETE') {failDelete=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Intentional acceptance-test delete failure'})});}
    return route.continue();
  });
  await group.locator('.sdp-item').filter({hasText:first.name}).locator('[data-action="item-remove"]').click();
  await until(async()=>await display.locator('[data-role="status"]').textContent().then(text=>text.includes('失败')),'Failed delete was not reported');
  assert.equal((await listing()).records.length,2); assert.equal(await group.locator('.sdp-item').count(),2);
  passed('Failed backend delete retains both resources and group memberships');
  await group.locator('.sdp-item').filter({hasText:first.name}).locator('[data-action="item-remove"]').click();
  await until(async()=>{const records=(await listing()).records;return records.length===1&&records[0].id===retained.id;},'Deletion did not persist precisely one target');
  await until(async()=>await group.locator('.sdp-item').count()===1,'Deleted model remained in display group');
  const prefs=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('scene-display:v1:')).map(([,value])=>JSON.parse(value)));
  assert.ok(prefs.some(p=>p.groups.some(g=>g.name==='Browser acceptance group'&&g.members.includes(retainedDisplayId)&&!g.members.includes(deletedDisplayId))));
  await page.reload({waitUntil:'domcontentloaded'}); await page.locator('[data-dock="display"]').click();
  await until(async()=>await page.locator('.sdp-item').filter({hasText:retained.name}).count()===1,'Remaining resource did not restore',60_000);
  assert.equal(await page.locator('.sdp-item').filter({hasText:first.name}).count(),0);
  assert.equal((await listing()).records.length,1);
  passed('Display delete removes only selected saved resource and its group reference, including reload');
  await page.screenshot({path:resolve(output,'03-deleted-resource-retained-group.png')});
  assert.equal(errors.length,0,JSON.stringify(errors,null,2));
  await writeFile(resolve(output,'result.json'),JSON.stringify({ok:true,scope,baseURL,realSkpPath,skpConversions,conversionResponses,checks,errors},null,2));
  console.log(JSON.stringify({ok:true,output,checks:checks.length},null,2));
} catch(error) {
  await page.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});
  await writeFile(resolve(output,'result.json'),JSON.stringify({ok:false,scope,baseURL,realSkpPath,error:error.stack,checks,errors,body:await page.locator('body').innerText().catch(()=>''),skpConversions,conversionResponses},null,2));
  throw error;
} finally { await browser.close(); await server?.close(); }
