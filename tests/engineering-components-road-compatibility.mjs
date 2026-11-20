// Production compatibility of the existing designed-road workflow, unchanged since 4239.
// Synthetic survey, CAD and read-only GPU probes are retained from the historical runner.
// This is a distinct test: it never changes or claims to pass the old draped-road assertions.
// Run after build with the test-only navigation adapter and a fresh local data directory.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import { ShapeUtils, Vector2 } from 'three';
import { preview } from 'vite';
import { dxf, lon, lat, transform } from '../tools/fixtures/temporary-works-survey.mjs';

const temporaryData = await mkdtemp(join(tmpdir(), 'cesium-glb-acceptance-'));
const output = resolve(process.env.TW_GLB_OUT || 'output/engineering-road-compatibility');
const dist = resolve(process.env.TW_RELEASE_DIST || 'dist');
await mkdir(output, { recursive: true });
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = temporaryData;
const report = {
  startedAt: new Date().toISOString(), passed: false,
  scope: '实际4239基线已交付的 designed 便道兼容验收；相同合成摄影转弯、孔洞和陡坎输入。独立新增用例，不替代旧 draped 脚本未通过记录。',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  entry: null, checks: [], pageErrors: [], rendererErrors: [], failedRequests: [], modelTransfers: [], screenshots: [],
};
const toLocal = Matrix4.inverseTransformation(transform, new Matrix4());
const near = (value, expected, tolerance, label = '') => assert(Number.isFinite(value) && Math.abs(value - expected) <= tolerance, `${label}: ${value} expected ${expected} ±${tolerance}`);
function geographic(east, north, up = 0) {
  const point = Cartographic.fromCartesian(Matrix4.multiplyByPoint(transform, new Cartesian3(east, north, up), new Cartesian3()));
  return { longitude: CesiumMath.toDegrees(point.longitude), latitude: CesiumMath.toDegrees(point.latitude), height: point.height };
}
function local(point) {
  return Matrix4.multiplyByPoint(toLocal, Cartesian3.fromDegrees(point.longitude, point.latitude, point.groundHeight ?? point.height ?? 58), new Cartesian3());
}

// A sloped ENU survey with one known missing rectangle and a 12 m rise in a one-metre strip.
// The coordinates, hole and cliff are exact fixture inputs, never claimed as field measurements.
function survey() {
  const xs = [-350, -240, -170, -100, -40, 0, 40, 60, 75, 100, 160, 190, 200, 201, 220, 350];
  const ns = [-250, -180, -160, -140, -130, -110, -100, -80, 0, 100, 250];
  const ground = (x, n) => 8 + 0.01 * x + 0.004 * n + (x >= 201 ? 12 : 0);
  const positions = [], triangles = [];
  for (const n of ns) for (const x of xs) positions.push(x, ground(x, n), -n);
  for (let j = 0; j < ns.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
    if (xs[i] === 60 && xs[i + 1] === 75 && ns[j] === -130 && ns[j + 1] === -110) continue;
    const a = j * xs.length + i, b = a + 1, c = a + xs.length + 1, d = a + xs.length;
    triangles.push(a, b, c, a, c, d);
  }
  const coords = new Float32Array(positions), indices = new Uint16Array(triangles);
  const raw = Buffer.concat([Buffer.from(coords.buffer), Buffer.from(indices.buffer)]);
  const binary = Buffer.alloc(Math.ceil(raw.length / 4) * 4); raw.copy(binary);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.12, 0.65, 0.25, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteLength: coords.byteLength, target: 34962 }, { buffer: 0, byteOffset: coords.byteLength, byteLength: indices.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: coords.length / 3, type: 'VEC3', min: [-350, 3.5, -250], max: [350, 24.5, 250] }, { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }],
  };
  const json = Buffer.from(JSON.stringify(gltf)), size = Math.ceil(json.length / 4) * 4;
  const glb = Buffer.alloc(28 + size + binary.length, 0x20);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(size, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
  glb.writeUInt32LE(binary.length, 20 + size); glb.writeUInt32LE(0x004e4942, 24 + size); binary.copy(glb, 28 + size);
  return { glb, tileset: { asset: { version: '1.1', gltfUpAxis: 'Y' }, geometricError: 500,
    root: { transform, boundingVolume: { box: [0, 0, 14, 350, 0, 0, 0, 250, 0, 0, 0, 12] }, geometricError: 0, refine: 'ADD', content: { uri: 'surface.glb' } } } };
}
const fixture = survey();
const drawing = dxf('独立合成验收场界及便道.dxf', [
  { layer: 'SITE', closed: true, points: [[-210, -60], [-70, -60], [-70, 70], [-210, 70]] },
  { layer: 'ROAD_BEND', points: [[-40, -120], [-10, -120], [-10, -100]] },
  { layer: 'ROAD_HOLE', points: [[50, -120], [85, -120]] },
  { layer: 'ROAD_CLIFF', points: [[194, -160], [208, -160]] },
]);

let server, browser, page;
const input = key => page.locator('#tw-' + key);
const row = id => page.locator(`[data-plan-id="${id}"]`);
async function fields(values) {
  for (const [key, value] of Object.entries(values)) {
    await input(key).fill(String(value));
    await input(key).dispatchEvent('change');
  }
}
async function check(name, run) {
  console.log('CHECK', name);
  const started = performance.now();
  try {
    const evidence = await run(); report.checks.push({ name, passed: true, durationMs: performance.now() - started, evidence });
    console.log('PASS', name, JSON.stringify(evidence));
    return evidence;
  } catch (error) {
    report.checks.push({ name, passed: false, durationMs: performance.now() - started, error: String(error?.stack || error) });
    throw error;
  }
}
async function withViewer(inspect, argument) {
  const cdp = await page.context().newCDPSession(page), group = 'temporary-works-glb-acceptance';
  try {
    const { result: fn } = await cdp.send('Runtime.evaluate', { expression: 'Function.prototype', objectGroup: group });
    const { objects: constructors } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: fn.objectId, objectGroup: group });
    const { result: prototype } = await cdp.send('Runtime.callFunctionOn', { objectId: constructors.objectId, objectGroup: group,
      functionDeclaration: `function(){for(const fn of this){const p=Object.getOwnPropertyDescriptor(fn,'prototype')?.value;if(p&&['cesiumWidget','camera','entities','container'].every(k=>Object.getOwnPropertyDescriptor(p,k)?.get))return p;}}` });
    assert(prototype.objectId, '生产页面未发现 Viewer 原型');
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId, objectGroup: group });
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, returnByValue: true, awaitPromise: true,
      arguments: [{ value: argument }], functionDeclaration: `function(arg){const viewer=this.find(v=>!v.isDestroyed()&&v.container===document.getElementById('cesiumContainer'));if(!viewer)throw Error('未发现当前主场景');return (${inspect.toString()})(viewer,arg);}` });
    assert(!exceptionDetails, exceptionDetails?.exception?.description || exceptionDetails?.text);
    return result.value;
  } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {}); await cdp.detach(); }
}
async function sceneState() {
  return withViewer(v => {
    const items = Array.from({ length: v.scene.primitives.length }, (_, i) => v.scene.primitives.get(i));
    return { models: items.filter(p => typeof p.id === 'string' && p.id.startsWith('temporary-works:')).map(p => ({ id: p.id, ready: p.ready, show: p.show })),
      tiles: items.filter(p => p.root).map(p => ({ url: p.resource?.url, show: p.show, polygons: p.clippingPolygons?.length ?? 0, inverse: p.clippingPolygons?.inverse ?? false })) };
  });
}
async function waitModels(ids, shown = true) {
  for (let tries = 0; tries < 180; tries++) {
    const state = await sceneState();
    if (ids.every(id => state.models.some(p => p.id === 'temporary-works:' + id && p.ready && p.show === shown))) return state;
    await page.waitForTimeout(1000);
  }
  assert.fail('GLB 未达到预期实际场景显隐状态：' + JSON.stringify(await sceneState()));
}
async function stored(name) {
  return page.evaluate(async name => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('cesium-temporary-works-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise((resolve, reject) => { const r = db.transaction('plans').objectStore('plans').getAll(); r.onsuccess = () => resolve(name ? r.result.find(row => row.plan.name === name)?.plan : r.result.map(row => row.plan)); r.onerror = () => reject(r.error); }); }
    finally { db.close(); }
  }, name);
}
async function save(name) {
  await input('save').click();
  await page.waitForFunction(name => document.querySelector('#tw-plans')?.textContent.includes(name) && document.querySelector('#tw-save')?.disabled, name);
  const plan = await stored(name); assert(plan, '方案未进入持久化存储'); return plan;
}
async function generate(button = 'run') {
  const start = performance.now();
  await input(button).click();
  await page.waitForFunction(() => !document.querySelector('#tw-save')?.disabled || document.querySelector('#tw-status')?.hasAttribute('data-error'), undefined, { timeout: 300000 });
  assert.equal(await input('save').isDisabled(), false, await input('status').innerText());
  return performance.now() - start;
}
async function selectCad(layer) {
  await input('cad').setInputFiles(drawing);
  const option = input('layer').locator('option').filter({ hasText: layer }).first();
  await option.waitFor({ state: 'attached' }); await input('layer').selectOption(await option.getAttribute('value'));
  const feature = input('feature').locator('option:not([value=""])').first();
  await feature.waitFor({ state: 'attached' }); await input('feature').selectOption(await feature.getAttribute('value'));
  await input('coord').selectOption('local'); await input('unit').selectOption('m');
  await fields({ 'anchor-x': 0, 'anchor-y': 0, 'anchor-lon': lon, 'anchor-lat': lat, rotation: 0 });
}
async function screenshot(name, caption) {
  await page.evaluate(caption => {
    let banner = document.getElementById('__acceptance_caption');
    if (!banner) { banner = document.createElement('div'); banner.id = '__acceptance_caption'; banner.style.cssText = 'position:fixed;left:470px;right:12px;top:12px;z-index:2147483647;background:#082a3fee;color:white;padding:10px 14px;font:14px sans-serif;pointer-events:none;border:1px solid #73d5e9'; document.body.append(banner); }
    banner.textContent = '独立验收场景｜合成摄影面（非现场实测）｜' + caption;
  }, caption);
  await page.screenshot({ path: join(output, name) }); report.screenshots.push({ file: name, caption });
}
async function samplePhotography(points) {
  return withViewer(async (v, points) => {
    const primitives = Array.from({ length: v.scene.primitives.length }, (_, i) => v.scene.primitives.get(i));
    const target = primitives.find(p => p.root && p.resource?.url.includes('/__glb_survey/'));
    if (!target) throw Error('合成摄影瓦片未加载');
    const ellipsoid = v.scene.ellipsoid;
    const cartographic = points.map(p => {
      const value = ellipsoid.cartesianToCartographic(v.camera.positionWC); value.longitude = p.longitude * Math.PI / 180; value.latitude = p.latitude * Math.PI / 180; value.height = 0; return value;
    });
    let active = true;
    const pump = () => { if (active) { v.scene.requestRender(); requestAnimationFrame(pump); } }; pump();
    try { return (await v.scene.sampleHeightMostDetailed(cartographic, primitives.filter(p => p !== target), 0.02)).map(p => Number.isFinite(p.height) ? p.height : null); }
    finally { active = false; }
  }, points);
}
// Read actual rendered pixels with only the GLB primitives temporarily suppressed for diagnosis.
// The production clipping collection is never changed here; all visibility is restored in finally.
async function diagnosticPixels(points, image) {
  const camera = Cartesian3.fromDegrees(lon, lat, 640);
  await withViewer((v, camera) => { v.camera.cancelFlight(); const C = v.camera.position.constructor; v.camera.setView({ destination: new C(...camera), orientation: { heading: 0, pitch: -Math.PI/2, roll: 0 } }); }, Cartesian3.toArray(camera));
  const result = await withViewer(async (v, argument) => {
    const models = Array.from({ length: v.scene.primitives.length }, (_, i) => v.scene.primitives.get(i)).filter(p => typeof p.id === 'string' && p.id.startsWith('temporary-works:'));
    const states = models.map(p => p.show); const globe = v.scene.globe.show;
    window.__restoreAcceptanceModels = () => { models.forEach((p,i) => { if (!p.isDestroyed()) p.show = states[i]; }); v.scene.globe.show = globe; delete window.__restoreAcceptanceModels; v.scene.requestRender(); };
    models.forEach(p => p.show = false); v.scene.globe.show = false;
    for (let i=0;i<5;i++) { v.scene.requestRender(); await new Promise(resolve => requestAnimationFrame(resolve)); }
    v.render();
    const canvas=v.scene.canvas, gl=canvas.getContext('webgl2'), C=v.camera.position.constructor;
    if(!gl)throw Error('验收需要WebGL2');
    const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING); gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    try { return argument.map(a => {
      const point=v.scene.cartesianToCanvasCoordinates(new C(...a.world));
      if(!point)throw Error('诊断点不在屏幕');
      const x=Math.round(point.x*canvas.width/canvas.clientWidth), y=canvas.height-Math.round(point.y*canvas.height/canvas.clientHeight)-1;
      if(x<0||y<0||x>=canvas.width||y>=canvas.height)throw Error('诊断点超出画面');
      const rgba=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
      return {name:a.name,rgba:Array.from(rgba),pixel:[x,y]};
    }); } finally {gl.bindFramebuffer(gl.FRAMEBUFFER,previous);}
  }, points.map(p => ({ name: p.name, world: Cartesian3.toArray(Cartesian3.fromDegrees(p.longitude,p.latitude,p.height ?? 58)) })));
  try { if (image) await screenshot(image, '摄影裁剪诊断：临时隐藏建筑实体，仅显示摄影表面实际裁剪结果'); }
  finally { await page.evaluate(() => window.__restoreAcceptanceModels?.()); }
  return result;
}
const pixelDistance = (a,b) => Math.hypot(...a.rgba.slice(0,3).map((v,i)=>v-b.rgba[i]));

async function beginRoadGeometryProbe() {
  await withViewer(v => {
    window.__roadGeometryProbe?.remove();
    const state={items:[],remove:null};
    state.remove=v.scene.primitives.primitiveAdded.addEventListener(primitive=>{
      const instances=primitive.geometryInstances;
      if(!Array.isArray(instances))return;
      const arrays=instances.flatMap(i=>{
        const a=i.geometry?.attributes?.position?.values,indices=i.geometry?.indices;
        return a&&indices?[Array.from(new Set(indices)).flatMap(index=>[a[index*3],a[index*3+1],a[index*3+2]])]:[];
      });
      if(arrays.length)state.items.push({primitive,positions:arrays});
    });
    window.__roadGeometryProbe=state;
  });
}
async function checkRoadGeometry(vertices,triangles) {
  const edges=new Map();for(const face of triangles)for(let i=0;i<3;i++){const a=face[i],b=face[(i+1)%3],key=[a,b].sort((x,y)=>x-y).join(':');const edge=edges.get(key);if(edge)edge.count++;else edges.set(key,{a,b,count:1});}
  const boundary=[...new Set([...edges.values()].filter(e=>e.count===1).flatMap(e=>[e.a,e.b]))];
  const selected=boundary.filter((_,i)=>i%Math.max(1,Math.floor(boundary.length/12))===0).slice(0,12).map(i=>vertices[i]);assert(selected.length>0);
  const expected=selected.flatMap(v=>['surfaceHeight','baseHeight','formationHeight'].map(key=>Cartesian3.toArray(Cartesian3.fromDegrees(v.longitude,v.latitude,v[key]))));
  const result=await withViewer(async(v,expected)=>{
    for(let i=0;i<5;i++){v.scene.requestRender();await new Promise(r=>requestAnimationFrame(r));}
    const state=window.__roadGeometryProbe;state.remove();delete window.__roadGeometryProbe;
    const live=state.items.filter(p=>!p.primitive.isDestroyed()&&p.primitive.ready&&p.primitive.show);
    const errors=expected.map(point=>{
      let distance=Infinity;
      for(const item of live)for(const a of item.positions)for(let i=0;i<a.length;i+=3)distance=Math.min(distance,Math.hypot(a[i]-point[0],a[i+1]-point[1],a[i+2]-point[2]));
      return distance;
    });
    return {livePrimitives:live.length,checkedLayerVertices:expected.length,maxPositionError:Math.max(...errors)};
  },expected);
  assert(result.livePrimitives>0 && result.maxPositionError<0.001,'实际道路三层渲染位置与测量厚度不符：'+JSON.stringify(result));
  return result;
}

async function surveyState() {
  return withViewer(v => {
    const target = Array.from({length:v.scene.primitives.length},(_,i)=>v.scene.primitives.get(i)).find(p=>p.root&&p.resource?.url.includes('/__glb_survey/'));
    if(!target)throw Error('Synthetic photography is absent');
    return {matrix:Array.from({length:16},(_,i)=>target.modelMatrix[i]),root:Array.from({length:16},(_,i)=>target.root.transform[i]),
      polygons:target.clippingPolygons?.length??0,ready:target.tilesLoaded,show:target.show};
  });
}
async function waitClipping(count) {
  let state;
  for(let i=0;i<60;i++) { state=await surveyState();if(state.ready&&state.polygons===count)return state;await page.waitForTimeout(250); }
  assert.fail('Actual photography clipping did not reach '+count+': '+JSON.stringify(state));
}

try {
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  server=await preview({build:{outDir:dist},plugins:[{name:'engineering-designed-road-survey',configurePreviewServer(vite){
    vite.middlewares.use('/__glb_survey/',(req,res,next)=>{
      if(!['/tileset.json','/surface.glb'].includes(req.url))return next();
      const json=req.url==='/tileset.json';res.setHeader('Content-Type',json?'application/json':'model/gltf-binary');res.end(json?JSON.stringify(fixture.tileset):fixture.glb);
    });
  }}],preview:{host:'127.0.0.1',port:0}});
  const origin='http://127.0.0.1:'+server.httpServer.address().port;
  const html=await(await fetch(origin)).text();report.entry=html.match(/src="(\/assets\/main-[^"]+\.js)"/)?.[1];assert(report.entry);
  report.entrySha256=createHash('sha256').update(await readFile(join(dist,report.entry.slice(1)))).digest('hex');
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,
    args:['--no-sandbox','--disable-gpu-sandbox','--use-angle=d3d11','--enable-webgl','--ignore-gpu-blocklist']});
  const context=await browser.newContext({viewport:{width:1500,height:1000},deviceScaleFactor:1,timezoneId:'Asia/Shanghai'});
  page=await context.newPage();page.setDefaultTimeout(60000);page.on('dialog',dialog=>dialog.accept());
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  page.on('console',message=>{if(/INVALID_(OPERATION|FRAMEBUFFER_OPERATION)|object does not belong to this context|WebGL.*(?:error|lost)/i.test(message.text()))report.rendererErrors.push(message.text());});
  page.on('requestfailed',request=>report.failedRequests.push({url:request.url(),error:request.failure()?.errorText}));
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:90000});await input('run').waitFor({state:'attached'});
  await page.locator('#basemap').selectOption('none');await page.locator('[data-tab="tiles"]').click();
  await page.locator('#tilesUrl').fill(origin+'/__glb_survey/tileset.json');await page.locator('#loadTiles').click();
  await page.waitForFunction(()=>document.querySelectorAll('#tw-model option').length>=2);
  await page.locator('[data-tab="temporary-works"]').click();
  const option=input('model').locator('option:not([value=""])').first();await input('model').selectOption(await option.getAttribute('value'));
  const original=await surveyState(),plans=[],probes=[];
  for(const [layer,length,grade,east,north,probeEast,probeNorth,probeStation] of [
    ['ROAD_BEND',50,2,-40,-120,-25,-120,15],['ROAD_HOLE',35,0,50,-120,67,-120,17],['ROAD_CLIFF',14,-1,194,-160,205,-160,11],
  ]) await check(layer+' uses the existing designed profile and three GPU layers',async()=>{
    await input('kind').selectOption('road');await selectCad(layer);
    await fields({name:'compatibility-'+layer,width:4,thickness:.25,treatment:.5});
    await input('elevation-mode').selectOption('automatic');
    if(grade){await input('road-grades-enabled').check();const field=page.locator('#tw-grades [data-grade-field="gradePct"]');await field.fill(String(grade));await field.dispatchEvent('change');}
    else await input('road-grades-enabled').uncheck();
    await input('confirmed').check();
    const sampled=(await samplePhotography([geographic(east,north)]))[0];assert.notEqual(sampled,null);
    await beginRoadGeometryProbe();const generateMs=await generate();const plan=await save('compatibility-'+layer);plans.push(plan);
    assert.equal(plan.inputs.road.surfaceMode,'designed');assert.equal(plan.inputs.road.gradesEnabled,grade!==0);
    assert(plan.mesh.vertices.length>0&&plan.mesh.triangles.length>0);near(plan.inputs.road.length,length,1e-7,'完整CAD长度');
    assert(plan.initialElevation&&Number.isFinite(plan.initialElevation.height));
    assert(plan.initialElevation.sampleCount>=1&&plan.initialElevation.sampleCount<=9);
    near(plan.inputs.road.startHeight,plan.initialElevation.height-plan.initialElevation.station*grade/100,1e-7,'初始高程与桩号设计坡差');
    near(plan.inputs.road.endHeight,plan.inputs.road.startHeight+length*grade/100,1e-7,'设计终点高程');
    near(Math.min(...plan.mesh.vertices.map(v=>v.roadStation)),0,1e-7);near(Math.max(...plan.mesh.vertices.map(v=>v.roadStation)),length,1e-7);
    for(const v of plan.mesh.vertices){near(v.surfaceHeight,plan.inputs.road.startHeight+v.roadStation*grade/100,1e-7,'逐点设计纵坡');near(v.surfaceHeight-v.baseHeight,.25,1e-7,'硬化层厚度');near(v.baseHeight-v.formationHeight,.5,1e-7,'处理层厚度');}
    const geometry=await checkRoadGeometry(plan.mesh.vertices,plan.mesh.triangles);let state=await waitClipping(plans.length);
    await row(plan.id).locator('[data-tw-action="hide"]').click();await waitClipping(plans.length-1);
    const independentHeight=(await samplePhotography([plan.initialElevation]))[0];near(plan.initialElevation.height,independentHeight,.04,'初始位置独立摄影复采4cm');
    await row(plan.id).locator('[data-tw-action="hide"]').click();state=await waitClipping(plans.length);
    near(plan.metrics.coveredArea,plan.metrics.planArea,1e-7);assert.equal(plan.metrics.excludedArea,0);
    if(layer==='ROAD_HOLE')assert(plan.mesh.vertices.some(v=>{const p=local({...v,height:v.surfaceHeight});return p.x>60.1&&p.x<74.9&&p.y>-129.9&&p.y<-110.1;}),'设计便道须完整跨越摄影缺测区');
    if(layer==='ROAD_CLIFF')assert(plan.mesh.triangles.some(face=>{const x=face.map(i=>local({...plan.mesh.vertices[i],height:plan.mesh.vertices[i].surfaceHeight}).x);return Math.min(...x)<200&&Math.max(...x)>201;}),'设计便道须完整保留陡坎两侧CAD范围');
    assert.deepEqual(state.matrix,original.matrix);assert.deepEqual(state.root,original.root);
    probes.push({name:layer,...geographic(probeEast,probeNorth),height:plan.inputs.road.startHeight+probeStation*grade/100});
    await row(plan.id).locator('[data-tw-action="locate"]').click();await page.waitForTimeout(1000);await screenshot(layer+'.png','现行设计便道：初始摄影高程、完整CAD长度、设计纵坡和向下三层结构');
    return {id:plan.id,length,grade,startSurface:sampled,initialElevation:plan.initialElevation,independentHeight,road:plan.inputs.road,vertices:plan.mesh.vertices.length,triangles:plan.mesh.triangles.length,geometry,generateMs};
  });
  const visible=await diagnosticPixels(probes,'roads-visible.png');
  await check('Road visibility restores only its own real pixels and clipping',async()=>{
    await row(plans[0].id).locator('[data-tw-action="hide"]').click();await waitClipping(2);
    const hidden=await diagnosticPixels(probes,'road-hidden.png');assert(pixelDistance(hidden[0],visible[0])>25);
    for(let i=1;i<probes.length;i++)assert(pixelDistance(hidden[i],visible[i])<8);
    await row(plans[0].id).locator('[data-tw-action="hide"]').click();await waitClipping(3);
    const restored=await diagnosticPixels(probes);for(let i=0;i<probes.length;i++)assert(pixelDistance(restored[i],visible[i])<8);
    return {visible,hidden,restored};
  });
  await check('Browser reload restores exact saved road geometry and rendered pixels',async()=>{
    const before=await stored();await page.reload({waitUntil:'domcontentloaded'});await input('run').waitFor({state:'attached'});
    await page.locator('[data-tab="temporary-works"]').click();await waitClipping(3);assert.deepEqual(await stored(),before);
    const pixels=await diagnosticPixels(probes,'roads-reloaded.png');for(let i=0;i<probes.length;i++)assert(pixelDistance(pixels[i],visible[i])<8);
    return {records:before.length,pixels};
  });
  await check('Original photography matrices remain unchanged throughout creation, toggles and reload',async()=>{
    const after=await surveyState();assert.deepEqual(after.matrix,original.matrix);assert.deepEqual(after.root,original.root);assert.equal(after.show,true);
    assert.equal(report.pageErrors.length,0);assert.equal(report.rendererErrors.length,0);assert.equal(report.failedRequests.length,0);
    return {before:original,after};
  });
  report.passed=true;
}catch(error){report.error=String(error?.stack||error);console.error(report.error);if(page)await screenshot('failure.png','当前设计便道兼容检查失败').catch(()=>{});process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(join(output,'browser-report.json'),JSON.stringify(report,null,2)+'\n');if(browser)await browser.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,output}));}
