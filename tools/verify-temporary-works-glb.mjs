// Full-platform production acceptance using the three delivered GLBs and an isolated synthetic survey.
// Run after npm run build. No production project, account data, or service is used.
// PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE / TW_RELEASE_DIST / TW_GLB_OUT are optional.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import { ShapeUtils, Vector2 } from 'three';
import { preview } from 'vite';
import { dxf, lon, lat, transform } from './fixtures/temporary-works-survey.mjs';

const temporaryData = await mkdtemp(join(tmpdir(), 'cesium-glb-acceptance-'));
const output = resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb');
const dist = resolve(process.env.TW_RELEASE_DIST || 'dist');
await mkdir(output, { recursive: true });
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = temporaryData;
const report = {
  startedAt: new Date().toISOString(), passed: false,
  scope: '完整平台生产构建；指定真实 GLB；独立合成摄影验收面。不是用户工地摄影或用户正式工程。',
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

let server, browser, page, manifest;
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
function footprintPoint(asset, plan) {
  let best;
  for (const footprint of asset.footprints) {
    const rings = [footprint.outer, ...(footprint.holes ?? [])], points = rings.flat();
    const triangles = ShapeUtils.triangulateShape(rings[0].map(p => new Vector2(...p)), rings.slice(1).map(r => r.map(p => new Vector2(...p))));
    for (const [ia, ib, ic] of triangles) {
      const [a, b, c] = [ia, ib, ic].map(i => points[i]);
      const area = Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]));
      if (!best || area > best.area) best = { area, x: (a[0]+b[0]+c[0])/3, z: (a[1]+b[1]+c[1])/3 };
    }
  }
  assert(best, '资源无可验证底面内部点');
  const p = plan.glb.placement, size = p.dimensions;
  const east = (best.x - asset.anchor[0]) * size.length / asset.dimensions.length;
  const north = (asset.upAxis === 'Y' ? -(best.z - asset.anchor[2]) : best.z - asset.anchor[1]) * size.width / asset.dimensions.width;
  const angle = p.headingDeg * Math.PI / 180;
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(p.longitude, p.latitude, p.height));
  const world = Matrix4.multiplyByPoint(frame, new Cartesian3(east*Math.cos(angle)-north*Math.sin(angle), east*Math.sin(angle)+north*Math.cos(angle), 0), new Cartesian3());
  const geo = Cartographic.fromCartesian(world);
  return { longitude: CesiumMath.toDegrees(geo.longitude), latitude: CesiumMath.toDegrees(geo.latitude), height: geo.height };
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
      const arrays=new Set(instances.map(i=>i.geometry?.attributes?.position?.values).filter(Boolean));
      if(arrays.size)state.items.push({primitive,positions:[...arrays].map(a=>Array.from(a))});
    });
    window.__roadGeometryProbe=state;
  });
}
async function checkRoadGeometry(vertices) {
  const selected=vertices.filter((_,i)=>i%Math.max(1,Math.floor(vertices.length/12))===0).slice(0,12);
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

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  server = await preview({ build: { outDir: dist }, plugins: [{ name: 'temporary-works-isolated-survey', configurePreviewServer(vite) {
    vite.middlewares.use('/__glb_survey/', (req,res,next) => {
      if (!['/tileset.json','/surface.glb'].includes(req.url)) return next();
      const json=req.url==='/tileset.json';res.setHeader('Content-Type',json?'application/json':'model/gltf-binary');res.end(json?JSON.stringify(fixture.tileset):fixture.glb);
    });
  } }], preview: { host: '127.0.0.1', port: 0 } });
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  const html = await (await fetch(origin)).text(); report.entry = html.match(/src="(\/assets\/main-[^"]+\.js)"/)?.[1];
  assert(report.entry, '不是生产构建入口');
  report.entrySha256 = createHash('sha256').update(await readFile(join(dist, report.entry.slice(1)))).digest('hex');
  manifest = await (await fetch(origin+'/models/temporary-works/manifest.json')).json();
  assert.deepEqual(manifest.assets.map(a=>a.id).sort(),['camp','steel','wall']);
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'Asia/Shanghai' });
  page = await context.newPage(); page.setDefaultTimeout(60000);
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (/INVALID_(OPERATION|FRAMEBUFFER_OPERATION)|object does not belong to this context|WebGL.*(?:error|lost)/i.test(message.text())) report.rendererErrors.push(message.text()); });
  page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.url().includes('/models/temporary-works/')) report.modelTransfers.push({ url: new URL(response.url()).pathname, status: response.status() }); });
  const start = performance.now(); await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await input('run').waitFor({ state: 'attached' }); report.pageLoadMs = performance.now()-start;
  await page.locator('#basemap').selectOption('none');
  await page.locator('[data-tab="tiles"]').click(); await page.locator('#tilesUrl').fill(origin+'/__glb_survey/tileset.json'); await page.locator('#loadTiles').click();
  await page.waitForFunction(() => document.querySelectorAll('#tw-model option').length>=2, undefined, { timeout: 90000 });
  await page.locator('[data-tab="temporary-works"]').click();
  const targetOption = input('model').locator('option:not([value=""])').first(); await input('model').selectOption(await targetOption.getAttribute('value'));

  await check('生产入口、摄影样本与真实资源清单', async () => {
    const samples=await samplePhotography([geographic(-140,0),geographic(100,0),geographic(67,-120)]);
    assert(samples[0]!==null && samples[1]!==null && samples[2]===null,'摄影面/空洞初始采样不符合 fixture');
    return {entry:report.entry,assets:manifest.assets.map(a=>({id:a.id,url:a.url,dimensions:a.dimensions})),samples};
  });

  const saved = {};
  for (const [id,east,north,length,heading] of [['camp',-140,0,70,18],['steel',100,0,60,-12],['wall',0,-60,12,0]]) {
    await check(`${id} 真实GLB生成、独立保存与主场景加载`, async () => {
      await input('kind').selectOption(id==='steel'?'steel':'camp'); await input('glb-resource').selectOption(id);
      const place=geographic(east,north); await fields({name:`验收-${id}`,'glb-lon':place.longitude,'glb-lat':place.latitude,'glb-heading':heading});
      await input('glb-elevation').fill('');await input('glb-sample-height').click();
      await page.waitForFunction(() => !document.querySelector('#tw-run')?.disabled && (document.querySelector('#tw-status')?.textContent.includes('已读取底面摄影高程') || document.querySelector('#tw-status')?.hasAttribute('data-error')),undefined,{timeout:120000});
      assert(!await input('status').evaluate(e=>e.hasAttribute('data-error')),await input('status').innerText());
      await input('glb-scale-mode').selectOption('uniform'); await fields({'glb-length':length});
      if(id==='wall'){await input('glb-brand-visible').check();await fields({'glb-brand-text':'东方雄师 铁建劲旅 / 编制经纬 筑梦城市'});}
      const generateMs=await generate('place-facility'); saved[id]=await save(`验收-${id}`); await waitModels([saved[id].id]);
      assert.equal(saved[id].glb.resourceId,id);near(saved[id].glb.placement.dimensions.length,length,0.00001);
      const asset=manifest.assets.find(a=>a.id===id);near(saved[id].glb.placement.dimensions.width/asset.dimensions.width,length/asset.dimensions.length,0.00001);
      assert.equal(saved[id].inputs.facilityMode,'glb');
      await row(saved[id].id).locator('[data-tw-action="locate"]').click();await page.waitForTimeout(1800);
      await screenshot(`${id}-on-survey.png`, `${id} 原临建界面布置真实GLB，底面定位与等比例尺寸`);
      return {id:saved[id].id,generateMs,placement:saved[id].glb.placement,scene:await sceneState()};
    });
  }

  const probes = ['camp','steel'].map(id=>({name:id,...footprintPoint(manifest.assets.find(a=>a.id===id),saved[id])}));
  probes.push({name:'unrelated-survey',...geographic(0,110,8.44)});
  let clippedPixels;
  await check('多临建摄影裁剪的真实像素与深度取样',async()=>{
    const samples=await samplePhotography(probes); clippedPixels=await diagnosticPixels(probes,'clipping-multiple-active.png');
    assert(samples[2]!==null,'未覆盖摄影表面被误裁剪');
    const target=(await sceneState()).tiles.find(t=>t.url.includes('/__glb_survey/'));assert(target.polygons>=2 && !target.inverse);
    return {samples,pixels:clippedPixels,polygons:target.polygons};
  });
  await check('隐藏一个临建仅恢复其摄影，其他临建保持遮挡',async()=>{
    await row(saved.camp.id).locator('[data-tw-action="hide"]').click();await waitModels([saved.camp.id],false);await waitModels([saved.steel.id]);
    const samples=await samplePhotography(probes);const pixels=await diagnosticPixels(probes,'clipping-camp-hidden.png');
    assert(samples[0]!==null,'隐藏驻地后摄影未恢复');
    assert(pixelDistance(pixels[0],clippedPixels[0])>25,'驻地下实际摄影像素没有恢复变化');
    assert(pixelDistance(pixels[1],clippedPixels[1])<8,'隐藏驻地改变了钢筋棚下的裁剪');
    assert(pixelDistance(pixels[2],clippedPixels[2])<8,'隐藏驻地改变了无关摄影表面');
    await row(saved.camp.id).locator('[data-tw-action="hide"]').click();await waitModels([saved.camp.id]);
    return {samples,pixels};
  });
  await check('刷新恢复真实模型、姿态、独立宣传内容及裁剪',async()=>{
    const before=(await stored()).map(p=>({id:p.id,glb:p.glb}));await page.reload({waitUntil:'domcontentloaded'});await input('run').waitFor({state:'attached'});
    await page.locator('[data-tab="temporary-works"]').click();await waitModels(Object.values(saved).map(p=>p.id));
    assert.deepEqual((await stored()).map(p=>({id:p.id,glb:p.glb})),before);
    const pixels=await diagnosticPixels(probes,'clipping-restored.png');for(let i=0;i<pixels.length;i++)assert(pixelDistance(pixels[i],clippedPixels[i])<8,'刷新后实际裁剪像素不一致');
    return {count:before.length,pixels,scene:await sceneState()};
  });
  await check('新增功能总开关恢复与重建摄影表面',async()=>{
    await input('upgrade-enabled').uncheck();await waitModels(Object.values(saved).map(p=>p.id),false);
    const off=await diagnosticPixels(probes,'all-upgrades-disabled.png');
    assert(pixelDistance(off[0],clippedPixels[0])>25 && pixelDistance(off[1],clippedPixels[1])>25,'关闭新增功能后摄影未恢复');
    await input('upgrade-enabled').check();await waitModels(Object.values(saved).map(p=>p.id));
    const on=await diagnosticPixels(probes);for(let i=0;i<on.length;i++)assert(pixelDistance(on[i],clippedPixels[i])<8);
    return {off,on};
  });
  await check('编辑宣传墙XYZ尺寸与旋转，保存到同一记录',async()=>{
    await row(saved.wall.id).locator('[data-tw-action="edit"]').click();await input('glb-scale-mode').selectOption('xyz');
    await fields({'glb-length':14,'glb-width':0.6,'glb-height':3.5,'glb-heading':32,'glb-brand-text':'东方雄师 铁建劲旅 / 编制经纬 筑梦城市（验收替换）'});
    await generate();const updated=await save('验收-wall');assert.equal(updated.id,saved.wall.id);assert.equal((await stored()).length,3);
    assert.deepEqual(updated.glb.placement.dimensions,{length:14,width:0.6,height:3.5});assert.equal(updated.glb.placement.headingDeg,32);saved.wall=updated;
    return {id:updated.id,placement:updated.glb.placement,branding:updated.glb.branding};
  });
  await check('删除驻地仅清除自身实体和摄影遮挡',async()=>{
    await row(saved.camp.id).locator('[data-tw-action="delete"]').click();await row(saved.camp.id).waitFor({state:'detached'});assert.equal(await stored('验收-camp'),undefined);
    const pixels=await diagnosticPixels(probes,'clipping-camp-deleted.png');assert(pixelDistance(pixels[0],clippedPixels[0])>25);assert(pixelDistance(pixels[1],clippedPixels[1])<8);
    await waitModels([saved.steel.id,saved.wall.id]);return {pixels,scene:await sceneState()};
  });

  for(const [layer,title] of [['ROAD_BEND','转弯贴地便道'],['ROAD_HOLE','缺测摄影孔洞'],['ROAD_CLIFF','陡坎高程突变']]) await check(title,async()=>{
    await input('kind').selectOption('road');await selectCad(layer);await fields({name:`验收-${layer}`,width:4,thickness:0.25,treatment:0.5,grid:2});await input('confirmed').check();
    await beginRoadGeometryProbe();const generateMs=await generate();const plan=await save(`验收-${layer}`);assert.equal(plan.inputs.road.surfaceMode,'draped');assert(plan.mesh.vertices.length>0 && plan.mesh.triangles.length>0);
    const renderedLayers=await checkRoadGeometry(plan.mesh.vertices);
    for(const vertex of plan.mesh.vertices){near(vertex.formationHeight,vertex.groundHeight,1e-7,'处理底面');near(vertex.baseHeight-vertex.groundHeight,0.5,1e-7,'处理厚度');near(vertex.surfaceHeight-vertex.baseHeight,0.25,1e-7,'硬化厚度');}
    const selected=plan.mesh.vertices.filter((_,i)=>i%Math.max(1,Math.floor(plan.mesh.vertices.length/12))===0).slice(0,12);
    const actual=await samplePhotography(selected);actual.forEach((height,i)=>near(height,selected[i].groundHeight,0.04,'实际摄影采样复核'));
    if(layer==='ROAD_HOLE')assert(plan.mesh.triangles.every(face=>{const p=face.map(i=>local(plan.mesh.vertices[i]));return !p.some(v=>v.x>60.1&&v.x<74.9&&v.y>-129.9&&v.y<-110.1);}), '道路跨越已知摄影孔洞');
    if(layer==='ROAD_CLIFF')assert(plan.mesh.triangles.every(face=>{const p=face.map(i=>local(plan.mesh.vertices[i]));return !(Math.min(...p.map(v=>v.x))<200 && Math.max(...p.map(v=>v.x))>201);}), '道路跨过未处理陡坎');
    await row(plan.id).locator('[data-tw-action="locate"]').click();await page.waitForTimeout(1800);await screenshot(`${layer.toLowerCase()}.png`,title+'；底面逐点摄影取高，结构向上叠加');
    return {id:plan.id,generateMs,vertices:plan.mesh.vertices.length,triangles:plan.mesh.triangles.length,audit:plan.inputs.road,groundSamples:actual,renderedLayers};
  });
  assert.equal(report.pageErrors.length,0,JSON.stringify(report.pageErrors));assert.equal(report.rendererErrors.length,0,JSON.stringify(report.rendererErrors));
  assert(manifest.assets.every(a=>report.modelTransfers.some(r=>r.url.endsWith(a.url.split('/').at(-1))&&r.status===200)),'并非三份真实GLB均从生产资源成功加载');
  report.passed=true;
} catch(error) {
  report.error=String(error?.stack||error);console.error(report.error);
  if(page)await screenshot('failure.png','验收中止，详细失败原因见报告').catch(()=>{});
  process.exitCode=1;
} finally {
  report.finishedAt=new Date().toISOString();
  await writeFile(join(output,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve));
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,output}));
}
