/** Native main.ts acceptance: real import/list buttons, persisted personal
 * switches, and real photography pixels. All records and GLBs are generated in
 * a fresh isolated database. The SKP-named record exercises only the existing
 * converted-data restoration path; this script never claims converter coverage.
 * Run alone on hardware WebGL; PLAYWRIGHT_MODULE selects the installed package. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createServer, loadConfigFromFile, preview } from 'vite';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { boxTriangles, makeGlb } from './model-contact-fixtures.mjs';
import { classifyContactPoint } from '../src/modelContactOcclusion/geometry.ts';

const output = resolve(process.env.CONTACT_WORKBENCH_OUT || 'output/model-contact-workbench-browser');
const productionBuild = process.env.CONTACT_WORKBENCH_PRODUCTION === '1';
await mkdir(output, { recursive: true });
const isolatedData = await mkdtemp(join(output, 'isolated-data-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = isolatedData;
const cache = resolve('.vite/model-contact-workbench'); process.env.CESIUM_VITE_CACHE_DIR = cache;
const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const anchor = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 100)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePrefix = '/__contact_workbench_photo/';
const toYUp = mesh => ({ ...mesh, positions: mesh.positions.flatMap((v, i, values) => i % 3 ? [] : [v, values[i + 2], -values[i + 1]]) });
const sourceModel = makeGlb([boxTriangles([-4, -8, 0], [4, 8, 4]), boxTriangles([-4, -8, 12], [4, 8, 16])].map(toYUp));
const convertedModel = makeGlb([toYUp(boxTriangles([-4, -3, 0], [4, 3, 4]))]);
const photo = makeGlb([{ positions: [0, 0, 32, 0, 24, 32, 0, 24, -32, 0, 0, -32], indices: [0, 1, 2, 0, 2, 3] }], [.04, .8, .08, 1]);
// A separate real target occupies only the north end and is two metres closer
// to the camera. Its pixels can be attributed to it without hiding either tile.
const secondPhoto = makeGlb([{ positions: [2, 0, -20, 2, 24, -20, 2, 24, -32, 2, 0, -32], indices: [0, 1, 2, 0, 2, 3] }], [.04, .8, .08, 1]);
const tileset = { asset: { version: '1.1', gltfUpAxis: 'Y' }, geometricError: 500, root: {
  transform: anchor, boundingVolume: { box: [0, 0, 12, 1, 0, 0, 0, 32, 0, 0, 0, 12] },
  geometricError: 0, refine: 'REPLACE', content: { uri: 'surface.glb' },
} };
const secondTileset = { ...tileset, root: { ...tileset.root,
  boundingVolume: { box: [2, 26, 12, .01, 0, 0, 0, 6, 0, 0, 0, 12] } } };
const name = 'Synthetic-vertical-contact.glb', convertedId = 'synthetic-converted-path', convertedName = 'Synthetic-converted-path.skp';
const report = { startedAt: new Date().toISOString(), passed: false, classification: 'native-main-ui-hardware-contact',
  productionDataReadOrModified: false, isolatedData, converterExercised: false, productionBuild,
  fixtureIsolation: ['Synthetic basemap', 'Empty temporary-works manifest; legacy assets are tested separately', 'Synthetic uploaded GLB and photography'],
  fixtureHashes: { model: digest(sourceModel), convertedData: digest(convertedModel), photography: digest(photo), secondPhotography: digest(secondPhoto) },
  checks: [], pageErrors: [], renderErrors: [], consoleErrors: [], consoleWarnings: [], sourceHttpErrors: [], failedRequests: [], workerUrls: [], screenshots: [] };
const sourcePaths = [...(await readdir('src/modelContactOcclusion')).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts')).map(n => 'src/modelContactOcclusion/' + n),
  'src/main.ts', 'src/sceneDisplayPanel.ts', 'src/temporaryWorksClipping.ts', 'server/cesiumOwnedClippingShader.ts', 'tests/model-contact-workbench-browser.mjs'];
const hashes = () => Promise.all(sourcePaths.map(async path => ({ path, sha256: digest(await readFile(path)) })));
let server, browser, context, page, origin, modelId, photoId;
const row = id => page.locator(`.sdp-item[data-display-id="layer:${id}"]`);
const switchButton = id => row(id).locator('[data-action="item-occlusion"]');
const green = sample => sample.pixel[1] > 150 && sample.pixel[1] > sample.pixel[0] * 1.8 && sample.pixel[1] > sample.pixel[2] * 1.8;
const present = (sample, label) => { assert.equal(sample.photography, true, `${label}: ${JSON.stringify(sample)}`); assert.equal(green(sample), true, label + ' photograph color'); };
const absent = (sample, label) => { assert.equal(sample.photography, false, `${label}: ${JSON.stringify(sample)}`); assert.equal(green(sample), false, label + ' photograph color'); };
async function check(name, action) {
  console.log('RUN', name); const item = { name, status: 'running' }; report.checks.push(item);
  try {
    item.evidence = await action();
    item.glError = await page.evaluate(() => window.__contactWorkbenchTest.viewer.scene.context._gl.getError());
    assert.equal(item.glError, 0, 'Native workbench WebGL draw error');
    item.status = 'passed'; console.log('PASS', name);
  } catch (error) { item.status = 'failed'; item.error = String(error.stack || error); throw error; }
}
async function screenshot(name) { const path = join(output, name + '.png'); await page.screenshot({ path }); report.screenshots.push(path); }
async function attachProductionObserver() {
  // Production has no debug API. CDP finds its already-running controller;
  // this test-only observer changes neither the built bundle nor scene state.
  await page.locator('#openEngineeringComponents').waitFor({ timeout: 90000 });
  const cdp = await context.newCDPSession(page), group = 'model-contact-native-acceptance';
  try {
    const { result: fn } = await cdp.send('Runtime.evaluate', { expression: 'Function.prototype', objectGroup: group });
    const { objects: functions } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: fn.objectId, objectGroup: group });
    const { result: prototype } = await cdp.send('Runtime.callFunctionOn', { objectId: functions.objectId, objectGroup: group,
      functionDeclaration: `function(){for(const fn of this){const p=Object.getOwnPropertyDescriptor(fn,'prototype')?.value;if(p&&['getState','bindComponentSelection','suspendExternalSceneEffects','setTarget','prepareDeletion'].every(k=>typeof p[k]==='function'))return p;}}` });
    assert.ok(prototype.objectId, 'Live production contact-controller prototype missing');
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId, objectGroup: group });
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, returnByValue: true,
      functionDeclaration: `function(){const controller=this.find(c=>!c.disposed&&c.options?.viewer?.container===document.getElementById('cesiumContainer'));if(!controller)throw Error('Live production contact controller missing');window.__contactWorkbenchTest={controller,viewer:controller.options.viewer};return true;}` });
    assert.ok(!exceptionDetails, exceptionDetails?.exception?.description); assert.equal(result.value, true);
  } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {}); await cdp.detach(); }
}
async function ready() {
  if (productionBuild) await attachProductionObserver();
  else {
    await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId && window.__modelContactOcclusion, undefined, { timeout: 90000 });
    await page.evaluate(() => { window.__contactWorkbenchTest = { controller: window.__modelContactOcclusion, viewer: window.__managementWorkspace.viewer }; });
  }
  await page.waitForFunction(() => window.__contactWorkbenchTest?.controller.options.getContext()?.projectId, undefined, { timeout: 90000 });
  await page.evaluate(() => {
    window.__contactWorkbenchRenderErrors = [];
    window.__contactWorkbenchTest.viewer.scene.renderError.addEventListener((_scene, error) => window.__contactWorkbenchRenderErrors.push(String(error.stack || error)));
  });
}
async function records() { const r = await context.request.get(origin + '/__library/records'); assert.equal(r.status(), 200, await r.text()); return (await r.json()).records; }
async function expandContaining(selector) {
  const details = page.locator('details').filter({ has: page.locator(selector) });
  for (let i = 0; i < await details.count(); i++) {
    const detail = details.nth(i); if (await detail.getAttribute('open') === null) await detail.locator(':scope > summary').click();
  }
}
async function openTab(tab) {
  await page.locator('[data-dock="editor"]').click();
  const toggle = page.locator('.function-centers-toggle'); if (await toggle.isVisible()) await toggle.click();
  const button = page.locator(`.tab[data-tab="${tab}"]`);
  if (!await button.isVisible()) await page.locator('.function-center').filter({ has: button }).locator('summary').click();
  await button.click();
}
async function openDirectory(id) {
  await page.locator('[data-dock="display"]').click();
  if (!await row(id).isVisible()) await page.locator('.sdp-category').filter({ has: page.locator(`[data-display-id="layer:${id}"]`) }).locator(':scope > summary').click();
  await row(id).waitFor({ state: 'visible' });
}
async function action(id, action) { await openDirectory(id); await row(id).locator(`[data-action="${action}"]`).click(); }
async function waitModel(id) {
  await page.waitForFunction(id => {
    const viewer = window.__contactWorkbenchTest?.viewer;
    if (!viewer) return false;
    for (let i = 0; i < viewer.scene.primitives.length; i++) { const p = viewer.scene.primitives.get(i); if (p.id?.engineeringModelId === id && p.ready) return true; }
    viewer.scene.requestRender(); return false;
  }, id, { timeout: 90000 });
}
async function state(id) { return page.evaluate(id => window.__contactWorkbenchTest.controller.getState(id), id); }
async function visible(id) { return page.evaluate(id => { const v = window.__contactWorkbenchTest.viewer;
  for (let i = 0; i < v.scene.primitives.length; i++) { const p = v.scene.primitives.get(i); if (p.id?.engineeringModelId === id) return p.show; }
  throw Error('Model visibility observer could not find the imported model');
}, id); }
async function active(id) {
  await page.waitForFunction(id => {
    const state = window.__contactWorkbenchTest.controller?.getState(id);
    if (state?.error) throw Error(state.message);
    window.__contactWorkbenchTest.viewer.scene.requestRender(); return state?.state === 'active' && !state.busy;
  }, id, { timeout: 180000 });
  return state(id);
}
async function setVisible(id, show) {
  await openDirectory(id);
  const button = row(id).locator('[data-action="item-visibility"]');
  if ((await button.getAttribute('aria-pressed') === 'true') !== show) await button.click();
  await page.waitForFunction(({ id, show }) => {
    const viewer = window.__contactWorkbenchTest.viewer;
    for (let i = 0; i < viewer.scene.primitives.length; i++) { const p = viewer.scene.primitives.get(i); if (p.id?.engineeringModelId === id) return p.show === show; }
    return false;
  }, { id, show });
}
async function focus() {
  await page.evaluate(anchor => {
    const v = window.__contactWorkbenchTest.viewer, model = [...Array(v.scene.primitives.length)].map((_, i) => v.scene.primitives.get(i)).find(p => p.id?.engineeringModelId);
    if (!model) throw Error('Native imported model missing');
    const M = model.modelMatrix.constructor, C = model.boundingSphere.center.constructor, frame = M.fromArray(anchor);
    v.camera.cancelFlight(); v.scene.globe.show = false; v.scene.skyAtmosphere.show = false; v.scene.skyBox.show = false;
    v.camera.setView({ destination: M.multiplyByPoint(frame, new C(90, 0, 12), new C()), orientation: {
      direction: C.normalize(M.multiplyByPointAsVector(frame, new C(-1, 0, 0), new C()), new C()),
      up: C.normalize(M.multiplyByPointAsVector(frame, new C(0, 0, 1), new C()), new C()),
    } }); v.camera.frustum.near = .1; v.scene.requestRender();
  }, anchor);
  await page.waitForFunction(() => {
    const v = window.__contactWorkbenchTest.viewer;
    for (let i = 0; i < v.scene.primitives.length; i++) { const p = v.scene.primitives.get(i); if (p.root?.contentReady) return true; }
    v.scene.requestRender(); return false;
  }, undefined, { timeout: 90000 });
}
async function sample(y, z, targetId = photoId, x = 0) {
  return page.evaluate(async ({ anchor, y, z, targetId, x }) => {
    const v = window.__contactWorkbenchTest.viewer;
    const primitives = [...Array(v.scene.primitives.length)].map((_, i) => v.scene.primitives.get(i));
    const model = primitives.find(p => p.id?.engineeringModelId), tiles = window.__contactWorkbenchTest.controller.getTargets().find(target => target.id === targetId)?.tileset;
    if (!tiles?.root.contentReady) throw Error('Requested actual photography target not ready: ' + targetId);
    const M = model.modelMatrix.constructor, C = model.boundingSphere.center.constructor;
    for (let i = 0; i < 5; i++) await new Promise(resolve => { const stop = v.scene.postRender.addEventListener(() => { stop(); resolve(); }); v.scene.requestRender(); });
    const world = M.multiplyByPoint(M.fromArray(anchor), new C(x, y, z), new C()), screen = v.scene.cartesianToCanvasCoordinates(world);
    if (!screen || screen.x < 2 || screen.y < 2 || screen.x > v.canvas.clientWidth - 2 || screen.y > v.canvas.clientHeight - 2) throw Error('Fixture sample outside camera');
    const hit = v.scene.pick(screen, 1, 1);
    const pixel = v.scene.context.readPixels({ x: Math.floor(screen.x * v.scene.drawingBufferWidth / v.canvas.clientWidth),
      y: Math.floor((v.canvas.clientHeight - screen.y) * v.scene.drawingBufferHeight / v.canvas.clientHeight), width: 1, height: 1 });
    const errors = [...window.__contactWorkbenchRenderErrors]; if (errors.length) throw Error(JSON.stringify(errors));
    return { photography: hit?.primitive === tiles || hit?.tileset === tiles || hit?.content?.tileset === tiles, pixel: [...pixel], targetId, x, y, z };
  }, { anchor, y, z, targetId, x });
}
async function saveConvertedFixture() {
  const headers = { 'x-cesium-library': '1' };
  const data = await context.request.post(origin + `/__library/records/${convertedId}/files/data?name=converted.glb`, { headers, data: convertedModel });
  assert.equal(data.status(), 200, await data.text());
  const source = await context.request.post(origin + `/__library/records/${convertedId}/files/source?name=${convertedName}`, {
    headers, data: Buffer.from('Synthetic converted-path fixture only; the SKP converter is not exercised by this test.'),
  }); assert.equal(source.status(), 200, await source.text());
  const matrix = Matrix4.multiplyByTranslation(Matrix4.fromArray(anchor), new Cartesian3(0, -20, 0), new Matrix4());
  const result = await context.request.put(origin + '/__library/records/' + convertedId, { headers, data: {
    version: 1, id: convertedId, name: convertedName, kind: 'Model', visible: true,
    files: { source: await source.json(), data: await data.json() }, settings: { matrix: Matrix4.toArray(matrix), scale: 1 },
  } }); assert.equal(result.status(), 200, await result.text());
  return { name: convertedName, sourceSlot: 'synthetic metadata placeholder', dataSlot: 'actual synthetic converted.glb', converterExercised: false };
}
async function captureErrors() { report.renderErrors.push(...await page.evaluate(() => window.__contactWorkbenchRenderErrors ?? []).catch(() => [])); }
async function reload() { await captureErrors(); await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }); await ready(); await waitModel(modelId); await focus(); }

try {
  report.sourceHashes = await hashes();
  const viteEnv = '/@fs/' + (await realpath(join(dirname(require.resolve('vite/package.json')), 'dist/client/env.mjs'))).replaceAll('\\', '/');
  const realDependencies = '/@fs/' + dirname(dirname(require.resolve('cesium/package.json'))).replaceAll('\\', '/') + '/';
  const localDependencies = '/@fs/' + resolve('node_modules').replaceAll('\\', '/') + '/';
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('vite.config.ts'), undefined, undefined, undefined, 'runner');
  assert.ok(loaded, 'Actual product Vite configuration missing');
  const fixture = { name: 'contact-workbench-fixtures', enforce: 'pre', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (req.url?.split('?')[0] === viteEnv) { res.setHeader('Content-Type', 'text/javascript'); res.end((await server.transformRequest(req.url)).code); return; }
          if (req.url?.startsWith(realDependencies)) req.url = localDependencies + req.url.slice(realDependencies.length);
          const path = req.url?.split('?')[0];
          if (path === '/models/temporary-works/manifest.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ schemaVersion: 1, assets: [] })); return; }
          if (path === sourcePrefix + 'tileset.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(tileset)); return; }
          if (path === sourcePrefix + 'surface.glb') { res.setHeader('Content-Type', 'model/gltf-binary'); res.end(photo); return; }
          if (path === sourcePrefix + 'second/tileset.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(secondTileset)); return; }
          if (path === sourcePrefix + 'second/surface.glb') { res.setHeader('Content-Type', 'model/gltf-binary'); res.end(secondPhoto); return; }
          next();
        } catch (error) { next(error); }
      });
    } };
  fixture.configurePreviewServer = fixture.configureServer;
  if (productionBuild) {
    report.productionIndexSha256 = digest(await readFile('dist/index.html'));
    server = await preview({ ...loaded.config, configFile: false, plugins: [fixture, ...(loaded.config.plugins || [])], preview: { host: '127.0.0.1', port: 5305, strictPort: true } });
  } else {
    server = await createServer({ ...loaded.config, configFile: false, cacheDir: cache, server: { ...loaded.config.server, host: '127.0.0.1', port: 5305, strictPort: true, hmr: false, watch: null }, plugins: [fixture, ...(loaded.config.plugins || [])] });
    await server.listen();
  }
  origin = `http://127.0.0.1:${server.httpServer.address().port}`; report.origin = origin;
  assert.ok(![5173, 5297].includes(server.httpServer.address().port), 'Reserved deployment port must not be used');
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=d3d11'] });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 }); page = await context.newPage(); page.setDefaultTimeout(45000);
  page.on('pageerror', error => report.pageErrors.push(String(error)));
  page.on('worker', worker => report.workerUrls.push(worker.url()));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ text: message.text(), location: message.location() }); if (message.type() === 'warning') report.consoleWarnings.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) { const failed = { url: response.url(), status: response.status() }; report.failedRequests.push(failed); if (response.url().includes(sourcePrefix)) report.sourceHttpErrors.push(failed); } });
  await page.route('**/__basemap/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }));
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90000 }); await ready();
  report.browser = browser.version(); report.gpu = await page.evaluate(() => { const gl = window.__contactWorkbenchTest.viewer.scene.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: gl instanceof WebGL2RenderingContext, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) }; });
  assert.equal(report.gpu.webgl2, true); assert.doesNotMatch(report.gpu.renderer, /swiftshader|software|llvmpipe/i); assert.match(report.gpu.renderer, /NVIDIA|AMD|Radeon|Intel|Apple|Adreno|Mali/i);

  await check('native GLB and photography import persist in an isolated project', async () => {
    await openTab('models'); await page.locator('#modelFile').setInputFiles({ name, mimeType: 'model/gltf-binary', buffer: sourceModel });
    await expandContaining('#modelPlacement'); await page.locator('#modelPlacement').selectOption('customGeo');
    for (const [selector, value] of [['#modelLon', '121'], ['#modelLat', '31'], ['#modelHeight', '100']]) await page.locator(selector).fill(value);
    await page.locator('#loadModel').click();
    await page.waitForFunction(() => document.querySelector('#modelLoadStatus')?.textContent?.includes('已放置并保存'), undefined, { timeout: 90000 });
    modelId = (await records()).find(record => record.name === name)?.id; assert.ok(modelId); await waitModel(modelId);
    await openTab('tiles'); await expandContaining('#tilesUrl'); await page.locator('#tilesUrl').fill(origin + sourcePrefix + 'tileset.json');
    await expandContaining('#tilesHeight'); await page.locator('#tilesHeight').fill('0'); await page.locator('#loadTiles').click();
    await page.waitForFunction(() => document.querySelector('#loadTiles')?.disabled === false && document.querySelector('#tilesQualityStatus')?.textContent?.includes('tileset.json'), undefined, { timeout: 90000 });
    for (let n = 0; n < 60 && !photoId; n++) { photoId = (await records()).find(record => record.kind === '3D Tiles' && record.settings.url?.includes(sourcePrefix))?.id; if (!photoId) await page.waitForTimeout(100); }
    assert.ok(photoId); await focus(); return { modelId, photoId, actualImportControls: true };
  });
  await check('model-list occlusion button immediately follows appearance and starts disabled', async () => {
    await openDirectory(modelId);
    const actions = await row(modelId).locator('.sdp-item-tools button').evaluateAll(buttons => buttons.map(button => button.dataset.action));
    assert.equal(actions.indexOf('item-occlusion'), actions.indexOf('item-appearance') + 1);
    assert.equal(await switchButton(modelId).getAttribute('aria-pressed'), 'false'); assert.equal((await state(modelId)).enabled, false);
    await setVisible(modelId, false); await focus();
    const probes = [await sample(0, 2), await sample(0, 8), await sample(0, 14), await sample(0, 20)]; probes.forEach(p => present(p, 'disabled baseline'));
    return { actions, probes };
  });
  await check('native switch clips only true three-dimensional overlap and preserves the vertical gap', async () => {
    await action(modelId, 'item-occlusion'); const status = await active(modelId); assert.equal(status.mode, 'solid');
    const lower = await sample(0, 2), gap = await sample(0, 8), upper = await sample(0, 14), above = await sample(0, 20);
    absent(lower, 'inside lower solid'); present(gap, 'same projection gap between solids'); absent(upper, 'inside upper solid'); present(above, 'same projection above both');
    await screenshot('native-contact-vertical-gap'); return { status, lower, gap, upper, above };
  });
  await check('display visibility remains independent of the active model-list switch', async () => {
    await setVisible(modelId, true); assert.equal((await state(modelId)).enabled, true);
    await setVisible(modelId, false); await active(modelId); const retained = await sample(0, 2); absent(retained, 'hidden model still clips');
    return { enabled: (await state(modelId)).enabled, retained };
  });
  await check('real 2D and Columbus morphs pause contact and reuse the original geometry on return to 3D', async () => {
    await openDirectory(modelId); await active(modelId);
    const workerCount = report.workerUrls.length;
    await page.evaluate(id => {
      const { controller, viewer } = window.__contactWorkbenchTest;
      window.__contactWorkbenchModeGeometry = controller.entries.get(id).geometry;
      window.__contactWorkbenchModeFrames = [];
      window.__contactWorkbenchModeStop = viewer.scene.postRender.addEventListener(() => {
        if (viewer.scene.mode !== 3) window.__contactWorkbenchModeFrames.push({ mode: viewer.scene.mode,
          morphTime: viewer.scene.morphTime, state: controller.getState(id).state, enabled: controller.getState(id).enabled });
      });
    }, modelId);
    const results = [];
    for (const [method, mode] of [['morphTo2D', 2], ['morphToColumbusView', 1]]) {
      await page.evaluate(method => { const scene = window.__contactWorkbenchTest.viewer.scene; scene[method](.4); scene.requestRender(); }, method);
      await page.waitForFunction(({ mode, id }) => {
        const { viewer, controller } = window.__contactWorkbenchTest; viewer.scene.requestRender();
        return viewer.scene.mode === mode && controller.getState(id).state === 'paused';
      }, { mode, id: modelId });
      const paused = await page.evaluate(id => {
        const { controller, viewer } = window.__contactWorkbenchTest, entry = controller.entries.get(id);
        const tiles = [...Array(viewer.scene.primitives.length)].map((_, i) => viewer.scene.primitives.get(i)).find(p => p.root);
        return { state: controller.getState(id), mode: viewer.scene.mode, owners: entry.appliedTargets.size,
          scopePresent: !!entry.scope, clippingPresent: !!tiles.clippingPolygons,
          geometryReused: entry.geometry === window.__contactWorkbenchModeGeometry };
      }, modelId);
      assert.equal(paused.state.enabled, true); assert.equal(paused.state.busy, false); assert.equal(paused.state.error, false);
      assert.equal(paused.owners, 0); assert.equal(paused.scopePresent, false); assert.equal(paused.clippingPresent, false); assert.equal(paused.geometryReused, true);
      assert.equal(await switchButton(modelId).getAttribute('data-state'), 'paused');
      assert.equal(await switchButton(modelId).getAttribute('aria-pressed'), 'true');
      assert.match(await switchButton(modelId).getAttribute('title'), /稳定三维/);
      await page.evaluate(() => { const scene = window.__contactWorkbenchTest.viewer.scene; scene.morphTo3D(.4); scene.requestRender(); });
      await page.waitForFunction(() => { const scene = window.__contactWorkbenchTest.viewer.scene; scene.requestRender(); return scene.mode === 3 && scene.morphTime === 1; });
      await active(modelId); await focus();
      const restored = await sample(0, 2), gap = await sample(0, 8); absent(restored, method + ' return solid'); present(gap, method + ' return vertical gap');
      const reused = await page.evaluate(id => window.__contactWorkbenchTest.controller.entries.get(id).geometry === window.__contactWorkbenchModeGeometry, modelId);
      assert.equal(reused, true, 'Scene morph must reuse the original completed geometry');
      assert.equal(await switchButton(modelId).getAttribute('data-state'), 'active');
      results.push({ method, paused, restored, gap, geometryReused: reused });
    }
    const frames = await page.evaluate(() => { window.__contactWorkbenchModeStop(); delete window.__contactWorkbenchModeStop; return window.__contactWorkbenchModeFrames; });
    assert.ok(frames.some(frame => frame.mode === 0 && frame.state === 'paused'), 'Actual morphing frames must pause the contact owner');
    assert.equal(report.workerUrls.length, workerCount, 'Scene morph must not rebuild unchanged geometry in another Worker');
    return { results, frames, workerCount };
  });
  await check('native location editor moves the contact volume and restores the old location', async () => {
    await setVisible(modelId, true); await action(modelId, 'item-edit'); await page.locator('#modelTools').waitFor({ state: 'visible' });
    await page.locator('#modelEditNorth').fill('18'); await page.locator('#applyModelTransform').click(); await page.locator('#finishModelEditing').click();
    for (let n = 0; n < 50; n++) { const record = (await records()).find(record => record.id === modelId); if (record.settings.editor?.north === 18) break; if (n === 49) throw Error('Native model movement did not persist'); await page.waitForTimeout(100); }
    await setVisible(modelId, false); await active(modelId); await focus();
    const old = await sample(0, 2), moved = await sample(18, 2), gap = await sample(18, 8);
    present(old, 'previous location restored'); absent(moved, 'new solid location'); present(gap, 'new vertical gap'); return { old, moved, gap };
  });
  await check('converted SKP-named data path restores as a separate runtime model', async () => {
    const evidence = await saveConvertedFixture(); await reload(); await waitModel(convertedId); await active(modelId);
    await setVisible(modelId, false); await setVisible(convertedId, false); await focus();
    assert.equal((await state(convertedId)).enabled, false); present(await sample(-20, 2), 'converted model initially disabled');
    await action(convertedId, 'item-occlusion'); const status = await active(convertedId); absent(await sample(-20, 2), 'converted data actual contact'); absent(await sample(18, 2), 'first model retained');
    return { ...evidence, status };
  });
  await check('disabling one model restores only its photography and leaves the other active', async () => {
    await action(modelId, 'item-occlusion'); assert.equal((await state(modelId)).enabled, false);
    const first = await sample(18, 2), second = await sample(-20, 2); present(first, 'first disabled'); absent(second, 'second stays active');
    return { first, second, firstStatus: await state(modelId), secondStatus: await state(convertedId) };
  });
  await check('refresh restores independent saved switches and hidden-model contact', async () => {
    await reload(); await waitModel(convertedId); await active(convertedId); await focus();
    assert.equal(await visible(modelId), false, 'First model visibility must restore without a test repair');
    assert.equal(await visible(convertedId), false, 'Second model visibility must restore without a test repair');
    assert.equal((await state(modelId)).enabled, false); assert.equal((await state(convertedId)).enabled, true);
    const first = await sample(18, 2), second = await sample(-20, 2); present(first, 'disabled model after refresh'); absent(second, 'enabled model after refresh');
    await screenshot('independent-switches-after-refresh'); return { first, second };
  });
  await check('closing the remaining native switch restores all original photography', async () => {
    await action(convertedId, 'item-occlusion'); const first = await sample(18, 2), second = await sample(-20, 2), gap = await sample(18, 8);
    present(first, 'first original photography'); present(second, 'second original photography'); present(gap, 'original gap'); return { first, second, gap };
  });
  await check('one hidden model clips two real photographic targets and releases a removed target independently', async () => {
    const secondUrl = origin + sourcePrefix + 'second/tileset.json';
    await openTab('tiles'); await expandContaining('#tilesUrl'); await page.locator('#tilesUrl').fill(secondUrl);
    await expandContaining('#tilesHeight'); await page.locator('#tilesHeight').fill('0'); await page.locator('#loadTiles').click();
    await page.waitForFunction(() => document.querySelector('#loadTiles')?.disabled === false, undefined, { timeout: 90000 });
    const secondId = (await records()).find(record => record.kind === '3D Tiles' && record.settings.url === secondUrl)?.id;
    assert.ok(secondId, 'Second target must be imported and persisted through the real load control'); assert.notEqual(secondId, photoId);
    await focus();
    await page.waitForFunction(id => { const { controller, viewer } = window.__contactWorkbenchTest; viewer.scene.requestRender(); return controller.getTargets().find(target => target.id === id)?.tileset.root.contentReady; }, secondId);
    const baseline = [await sample(18, 2), await sample(0, 2), await sample(21, 2, secondId, 2), await sample(30, 2, secondId, 2), await sample(21, 8, secondId, 2)];
    baseline.forEach(probe => present(probe, 'both real targets initially uncut'));
    await action(modelId, 'item-occlusion'); await active(modelId);
    const ownership = await page.evaluate(({ id, firstId, secondId }) => {
      const c = window.__contactWorkbenchTest.controller, entry = c.entries.get(id), targets = c.getTargets();
      const first = targets.find(target => target.id === firstId).tileset, second = targets.find(target => target.id === secondId).tileset;
      window.__contactWorkbenchSecondTarget = second;
      return { targetIds: [...entry.appliedTargets.keys()], distinctTilesets: first !== second,
        bothVisible: first.show && second.show, bothClipping: !!first.clippingPolygons && !!second.clippingPolygons,
        modelVisible: entry.instance.model.show, state: c.getState(id) };
    }, { id: modelId, firstId: photoId, secondId });
    assert.deepEqual(ownership.targetIds.sort(), [photoId, secondId].sort()); assert.equal(ownership.distinctTilesets, true);
    assert.equal(ownership.bothVisible, true); assert.equal(ownership.bothClipping, true); assert.equal(ownership.modelVisible, false);
    const original = await page.evaluate(id => {
      const entry = window.__contactWorkbenchTest.controller.entries.get(id), g = entry.geometry;
      return { worldFromLocal: entry.appliedWorld, geometry: { ...g, nodes: [...g.nodes], triangles: [...g.triangles], entities: [...g.entities], trianglePositions: [...g.trianglePositions] } };
    }, modelId);
    const geometry = { ...original.geometry, nodes: new Float32Array(original.geometry.nodes), triangles: new Float32Array(original.geometry.triangles),
      entities: new Float32Array(original.geometry.entities), trianglePositions: new Float64Array(original.geometry.trianglePositions) };
    const inverse = Matrix4.inverse(Matrix4.fromArray(original.worldFromLocal), new Matrix4());
    const cpuProbes = [[0, 18, 2, true], [0, 0, 2, false], [2, 21, 2, true], [2, 30, 2, false], [2, 21, 8, false]].map(([x, y, z, expected]) => {
      const world = Matrix4.multiplyByPoint(Matrix4.fromArray(anchor), new Cartesian3(x, y, z), new Cartesian3());
      const local = Matrix4.multiplyByPoint(inverse, world, new Cartesian3()), point = [local.x, local.y, local.z];
      const classification = classifyContactPoint(geometry, point); assert.equal(classification.clipped, expected, `Actual runtime geometry classification ${x},${y},${z}`);
      return { worldEnu: [x, y, z], local: point, classification };
    });
    const clipped = { firstInside: await sample(18, 2), firstOutside: await sample(0, 2),
      secondInside: await sample(21, 2, secondId, 2), secondOutside: await sample(30, 2, secondId, 2), secondGap: await sample(21, 8, secondId, 2) };
    report.dualTargetDiagnostic = { ownership, baseline, clipped, cpuProbes, records: await records(), runtime: await page.evaluate(({ id, anchor }) => {
      const c = window.__contactWorkbenchTest.controller, v = window.__contactWorkbenchTest.viewer, entry = c.entries.get(id);
      const M = entry.instance.model.modelMatrix.constructor, C = entry.instance.model.boundingSphere.center.constructor;
      const world = M.multiplyByPoint(M.fromArray(anchor), new C(2, 21, 2), new C());
      return { modelMatrix: M.toArray(entry.instance.model.modelMatrix), appliedWorld: entry.appliedWorld, bounds: entry.geometry.bounds, origin: entry.geometry.origin,
        targets: c.getTargets().map(target => {
          const t = target.tileset, collection = t.clippingPolygons, targetModel = t.root.content._model;
          const local = collection && M.multiplyByPoint(collection.worldToLocal[0], world, new C());
          return { id: target.id, tilesetMatrix: M.toArray(t.modelMatrix), rootTransform: M.toArray(t.root.computedTransform),
            targetModelMatrix: targetModel?.modelMatrix && M.toArray(targetModel.modelMatrix), axis: targetModel?._sceneGraph?.axisCorrectionMatrix && M.toArray(targetModel._sceneGraph.axisCorrectionMatrix),
            local: local && [local.x, local.y, local.z], geometrySame: collection?.volumes[0].geometry === entry.geometry, layouts: collection?.layouts };
        }), glError: v.scene.context._gl.getError() };
    }, { id: modelId, anchor }) };
    absent(clipped.firstInside, 'first target solid'); present(clipped.firstOutside, 'first target outside');
    absent(clipped.secondInside, 'second target solid'); present(clipped.secondOutside, 'second target outside'); present(clipped.secondGap, 'second target vertical gap');
    await action(modelId, 'item-occlusion');
    const restored = [await sample(18, 2), await sample(0, 2), await sample(21, 2, secondId, 2), await sample(30, 2, secondId, 2), await sample(21, 8, secondId, 2)];
    restored.forEach(probe => present(probe, 'one total off restores both targets'));
    await action(modelId, 'item-occlusion'); await active(modelId);
    page.once('dialog', dialog => dialog.accept()); await action(secondId, 'item-remove');
    await page.waitForFunction(({ id, secondId }) => {
      const c = window.__contactWorkbenchTest.controller; return !c.getTargets().some(target => target.id === secondId)
        && c.entries.get(id)?.appliedTargets.size === 1 && c.getState(id).state === 'active';
    }, { id: modelId, secondId });
    assert.equal((await records()).some(record => record.id === secondId), false, 'Only the isolated second target record must be removed');
    assert.equal(await page.evaluate(() => window.__contactWorkbenchSecondTarget.isDestroyed()), true, 'Removed target GPU resources must be destroyed');
    await focus(); const retained = await sample(18, 2), retainedOutside = await sample(0, 2);
    absent(retained, 'first target survives independent second-target deletion'); present(retainedOutside, 'first target outside still retained');
    await action(modelId, 'item-occlusion'); const finalRestored = await sample(18, 2); present(finalRestored, 'remaining target restored after total off');
    return { secondId, baseline, ownership, cpuProbes, clipped, restored, retained, retainedOutside, finalRestored };
  });
  await captureErrors(); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.renderErrors, []);
  assert.deepEqual(report.consoleWarnings.filter(v => /GL_INVALID|Error compiling|CONTEXT_LOST/i.test(v)), []);
  assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.sourceHttpErrors, []);
  assert.ok(report.workerUrls.some(url => url.includes('geometry.worker')), 'No actual contact geometry Worker was started');
  if (productionBuild) assert.ok(report.workerUrls.some(url => /\/assets\/geometry\.worker-[^/]+\.js$/.test(url)), 'Production must execute the built geometry Worker');
  report.sourceHashesAfter = await hashes(); assert.deepEqual(report.sourceHashesAfter, report.sourceHashes); report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
  if (page) { await screenshot('failure').catch(() => {}); report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(-8000); }
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  if (server?.close) await server.close(); else if (server?.httpServer) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.map(({ name, status }) => ({ name, status })), report: join(output, 'report.json') }));
}
