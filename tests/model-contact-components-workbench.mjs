// Actual workbench, original read-only engineering models and isolated synthetic
// photography. All component/master changes go through the real DOM controls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { createServer, loadConfigFromFile, preview } from 'vite';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { photographyGlb } from './model-contact-fixtures.mjs';

const out = resolve(process.env.CONTACT_COMPONENTS_OUT || 'output/model-contact-components-workbench');
const productionBuild = process.env.CONTACT_COMPONENTS_PRODUCTION === '1';
const fullLine = process.env.CONTACT_COMPONENTS_FULL_LINE === '1';
await mkdir(out, { recursive: true });
const data = await mkdtemp(join(out, 'synthetic-data-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = data;
process.env.CESIUM_VITE_CACHE_DIR = resolve('.vite/model-contact-components-workbench');
if (!process.env.CESIUM_ENGINEERING_ASSETS_DIR) throw Error('Original engineering package directory required');
const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const port = Number(process.env.CONTACT_COMPONENTS_PORT || 5306), origin = `http://127.0.0.1:${port}`;
const frame = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 100)));
const records = ['A001', 'TN021'].map((unit, i) => ({ version: 1, id: `synthetic-${unit}`, name: unit, kind: 'Model', visible: false,
  createdAt: '2026-11-21T00:00:00Z', updatedAt: '2026-11-21T00:00:00Z',
  files: { source: { name: unit + '.glb', url: `/__engineering-components/structure-library/${i ? 'tunnel' : 'bridge'}/${unit}/model.glb` } }, settings: { matrix: frame, scale: 1 } }));
records.push({ version: 1, id: 'synthetic-photo', name: '隔离三维接触验收摄影', kind: '3D Tiles', visible: true,
  createdAt: '2026-11-21T00:00:00Z', updatedAt: '2026-11-21T00:00:00Z', files: {}, settings: { url: origin + '/__synthetic_contact/tileset.json' } });
if (fullLine) records.push({ ...records[0], id: 'synthetic-full', name: '全线原件', visible: false, files: { source: { name: 'Jiashan.glb', url: '/__engineering-components/models/Jiashan.glb' } } });
const photo = photographyGlb();
const tileset = { asset: { version: '1.1', gltfUpAxis: 'Y' }, geometricError: 500,
  root: { transform: frame, boundingVolume: { box: [0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0, .01] }, geometricError: 0, refine: 'ADD', content: { uri: 'surface.glb' } } };
const sourceFiles = ['src/main.ts', 'src/engineeringComponents/controller.ts', 'src/engineeringComponents/panel.ts', 'src/engineeringComponents/panel.css',
  'src/temporaryWorksClipping.ts', 'src/ownedClippingPolygons.ts', 'server/cesiumOwnedClippingShader.ts',
  ...(await readdir('src/modelContactOcclusion')).filter(path => path.endsWith('.ts')).map(path => 'src/modelContactOcclusion/' + path),
  'tests/model-contact-components-workbench.mjs', 'tests/model-contact-fixtures.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Promise.all(sourceFiles.map(async path => ({ path, sha256: digest(await readFile(path)) })));
const report = { startedAt: new Date().toISOString(), passed: false, productionBuild, fullLine, productionDataUsed: false,
  temporaryWorksFixture: 'Empty isolated manifest; original temporary-works compatibility is verified by its dedicated regressions',
  checks: [], pointerChecks: [], errors: [], failedRequests: [], consoleErrors: [], consoleWarnings: [] };
let server, browser, page;
const A = 'synthetic-A001', T = 'synthetic-TN021', F = 'synthetic-full';
const cap = [0, .615, 0], pile = [-.734632854, -30.285, 1.607891343];
const tunnel = [
  ['roof', [803.740794852, -.2313765, -265.270682344], false],
  ['bottom', [803.740794852, -8.1813765, -265.270682344], false],
  ['left wall', [801.073865859, -4.1813765, -271.381066219], false],
  ['right wall', [806.018821076, -4.1813765, -258.117018109], false],
  ['partition', [803.54522931, -4.1813765, -264.75203158], false],
  ['left chamber', [802.3095475845, -4.1813765, -268.0665488995], true],
  ['right chamber', [804.782025193, -4.1813765, -261.4345248445], true],
  ['above tunnel', [803.740794852, 3, -265.270682344], true],
  ['below tunnel', [803.740794852, -12, -265.270682344], true],
];

async function attachProbe() {
  await page.locator('#openEngineeringComponents').waitFor();
  if (productionBuild) {
    const cdp = await page.context().newCDPSession(page), group = 'model-contact-components-read-probe';
    try {
      const { result: fn } = await cdp.send('Runtime.evaluate', { expression: 'Function.prototype', objectGroup: group });
      const { objects: constructors } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: fn.objectId, objectGroup: group });
      const { result: prototype } = await cdp.send('Runtime.callFunctionOn', { objectId: constructors.objectId, objectGroup: group,
        functionDeclaration: `function(){for(const fn of this){const p=Object.getOwnPropertyDescriptor(fn,'prototype')?.value;if(p&&['activeInstanceId','photographyStats','isPicking'].every(k=>Object.getOwnPropertyDescriptor(p,k)?.get)&&typeof p.detachInstance==='function')return p;}}` });
      assert(prototype.objectId, 'Actual production component controller missing');
      const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId, objectGroup: group });
      const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, returnByValue: true,
        functionDeclaration: `function(){const c=this.find(c=>!c.disposed&&c.options?.viewer?.container===document.getElementById('cesiumContainer'));if(!c||!c.options.modelContact)throw Error('Actual model-contact host missing');window.__engineeringComponents=c;window.__managementWorkspace={viewer:c.options.viewer};window.__modelContactOcclusion=c.options.modelContact;return true;}` });
      assert(!exceptionDetails, exceptionDetails?.exception?.description); assert.equal(result.value, true);
    } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {}); await cdp.detach(); }
  }
  await page.waitForFunction(() => window.__engineeringComponents?.options.getContext() && window.__modelContactOcclusion);
  await page.evaluate(() => {
    if (window.__contactComponentsInputEvents) return;
    window.__contactComponentsInputEvents = [];
    let trackingPointer = false, trackedInput;
    const snapshot = (event, phase) => {
      const input = event.target;
      const isInput = input instanceof HTMLInputElement && input.dataset.ec === 'all-occlusion';
      if (phase === 'capture' && event.type === 'pointerdown') { trackingPointer = isInput; trackedInput = isInput ? input : undefined; }
      if (!isInput && !trackingPointer) return;
      const c = window.__engineeringComponents;
      window.__contactComponentsInputEvents.push({ type: event.type, phase, trusted: event.isTrusted,
        checked: input.checked, indeterminate: input.indeterminate, target: input.outerHTML?.slice(0, 400),
        connected: trackedInput?.isConnected, sameInput: trackedInput === document.querySelector('[data-ec="all-occlusion"]'),
        coordinate: [event.clientX, event.clientY], rect: document.querySelector('[data-ec="all-occlusion"]')?.getBoundingClientRect().toJSON(),
        activeId: c.activeInstanceId,
        revision: c.state?.revision, summary: c.state && c.summary(c.members()),
        canMutate: c.canMutate(), scope: c.reviewScope, status: c.photographyStats });
    };
    for (const type of ['pointerdown', 'pointerup', 'click', 'input', 'change']) {
      document.addEventListener(type, event => snapshot(event, 'capture'), true);
      document.addEventListener(type, event => snapshot(event, 'bubble'));
    }
  });
  await page.waitForFunction(count => {
    const c = window.__engineeringComponents, v = c.options.viewer;
    return c.options.getInstances().filter(instance => instance.id.startsWith('synthetic-') && instance.model.ready).length === count
      && Array.from({ length: v.scene.primitives.length }, (_, i) => v.scene.primitives.get(i)).some(p => p.root);
  }, fullLine ? 3 : 2, { timeout: 180000 });
  // Hiding real models prevents their ordinary depth/color from satisfying a
  // photograph-removed assertion. It never changes the selected O state.
  await page.evaluate(() => {
    const c = window.__engineeringComponents, v = c.options.viewer;
    for (const instance of c.options.getInstances()) instance.model.show = false;
    v.scene.globe.show = false; v.scene.skyAtmosphere.show = false; v.scene.skyBox.show = false;
    v.scene.sun.show = false; v.scene.moon.show = false; v.scene.postProcessStages.fxaa.enabled = false;
    v.scene.requestRender();
  });
}
async function ready(id) {
  await page.waitForFunction(id => {
    const state = window.__modelContactOcclusion.getState(id);
    return !state.busy && ['active', 'empty', 'disabled', 'error', 'unsupported'].includes(state.state);
  }, id, { timeout: 240000 });
  const state = await page.evaluate(id => window.__modelContactOcclusion.getState(id), id);
  assert.equal(state.error, false, JSON.stringify(state)); return state;
}
async function probe(id, point) {
  await ready(id);
  return page.evaluate(async ({ id, point, frame }) => {
    const c = window.__engineeringComponents, v = c.options.viewer, model = c.options.getInstances().find(item => item.id === id).model;
    const M = model.modelMatrix.constructor, C = model.boundingSphere.center.constructor, graph = model._sceneGraph;
    let world = M.multiply(model.modelMatrix, graph.components.transform, new M());
    world = M.multiply(world, graph.axisCorrectionMatrix, world); M.multiplyByUniformScale(world, Math.min(model.scale, model.maximumScale ?? Infinity), world);
    // Original root-local Y is vertical. This frame puts a synthetic horizontal
    // photographic surface at precisely the source-model test point.
    const local = M.fromArray([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, ...point, 1]);
    const plane = M.multiply(world, local, new M()), inverseFrame = M.inverse(M.fromArray(frame), new M());
    const photography = Array.from({ length: v.scene.primitives.length }, (_, i) => v.scene.primitives.get(i)).find(item => item.root);
    if (!photography) throw Error('Actual Cesium photographic tileset missing');
    photography.modelMatrix = M.multiply(plane, inverseFrame, new M());
    const center = M.getTranslation(plane, new C()), direction = C.normalize(M.multiplyByPointAsVector(plane, new C(0, 0, -1), new C()), new C());
    v.camera.setView({ destination: C.subtract(center, C.multiplyByScalar(direction, 3, new C()), new C()),
      orientation: { direction, up: C.normalize(M.multiplyByPointAsVector(plane, new C(0, 1, 0), new C()), new C()) } });
    v.camera.frustum.near = .01;
    for (let i = 0; i < 8; i++) await new Promise(resolve => { const stop = v.scene.postRender.addEventListener(() => { stop(); resolve(); }); v.scene.requestRender(); });
    if (!photography.root.contentReady) throw Error('Photographic content did not load at the test point');
    const position = v.scene.cartesianToCanvasCoordinates(center), context = v.scene.context;
    if (!position) throw Error('Test point outside canvas');
    const pixel = context.readPixels({ x: Math.floor(position.x * v.scene.drawingBufferWidth / v.canvas.clientWidth),
      y: Math.floor((v.canvas.clientHeight - position.y) * v.scene.drawingBufferHeight / v.canvas.clientHeight), width: 1, height: 1 });
    const pick = v.scene.pick(position, 1, 1);
    return { point, photo: pick?.primitive === photography, pixel: [...pixel], visible: model.show,
      state: window.__modelContactOcclusion.getState(id), componentStatus: c.activeInstanceId === id ? c.photographyStats : null };
  }, { id, point, frame });
}
function expect(result, present, label = '') {
  assert.equal(result.photo, present, label + ' photograph pick ' + JSON.stringify(result));
  const green = result.pixel[1] > 150 && result.pixel[1] > result.pixel[0] * 1.8 && result.pixel[1] > result.pixel[2] * 1.8;
  assert.equal(green, present, label + ' photographic pixel ' + JSON.stringify(result));
  assert.equal(result.visible, false, 'Ordinary visible engineering depth must not satisfy this test');
}
async function check(name, action) {
  console.log('RUN', name); const row = { name }; report.checks.push(row); const start = performance.now();
  try {
    row.evidence = await action();
    const events = await page.evaluate(() => { const events = window.__contactComponentsInputEvents; window.__contactComponentsInputEvents = []; return events; });
    for (let index = 0; index < events.length; index++) {
      const down = events[index]; if (down.type !== 'pointerdown' || down.phase !== 'capture') continue;
      const up = events.slice(index + 1).find(event => event.type === 'pointerup' && event.phase === 'capture');
      assert.ok(up, 'Bulk checkbox must receive a complete real pointer gesture');
      assert.equal(up.sameInput && up.connected, true, 'Bulk checkbox must remain connected through the gesture');
      assert.match(up.target, /data-ec="all-occlusion"/, 'Pointer release must still land on the bulk checkbox');
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(down.rect[key] - up.rect[key]) < .1, `Bulk checkbox ${key} changed during pointer focus`);
      report.pointerChecks.push({ check: name, down, up });
    }
    row.glError = await page.evaluate(() => window.__engineeringComponents.options.viewer.scene.context._gl.getError()); assert.equal(row.glError, 0); row.passed = true; console.log('PASS', name);
  }
  catch (error) { row.passed = false; throw error; } finally { row.milliseconds = performance.now() - start; }
}
async function bind(id) {
  await page.locator('#openEngineeringComponents').click();
  const active = await page.evaluate(() => window.__engineeringComponents.activeInstanceId);
  if (active) await page.locator('[data-ec-action="disconnect"]').click();
  await page.locator('[data-ec="instance"]').selectOption(id); await page.locator('[data-ec-action="connect"]').click();
  await page.waitForFunction(id => window.__engineeringComponents.activeInstanceId === id, id, { timeout: 180000 });
}
async function panelMaster(enabled) { await page.locator('[data-ec="photography-enabled"]').setChecked(enabled); }
async function directoryMaster(id, enabled) {
  // The component inspector floats above the dock. Leave it through its real
  // close control before navigating to the model directory underneath.
  if (await page.locator('#engineeringComponentsPanel').isVisible()) await page.locator('[data-ec-action="close"]').click();
  await page.locator('[data-dock="display"]').click();
  await page.locator('.scene-display-panel [data-role="search"]').fill(id === A ? 'A001' : id === T ? 'TN021' : '全线原件');
  const button = page.locator(`[data-action="item-occlusion"][data-item-id="layer:${id}"]`);
  await button.waitFor(); const current = await button.getAttribute('aria-pressed');
  if ((current === 'true') !== enabled) await button.click();
  await ready(id); assert.equal(await button.getAttribute('aria-pressed'), String(enabled));
}

try {
  report.sourceHashes = await hashes();
  const viteEnv = '/@fs/' + (await realpath(resolve(dirname(require.resolve('vite/package.json')), 'dist/client/env.mjs'))).replaceAll('\\', '/');
  const dependencyPrefix = '/@fs/' + dirname(dirname(require.resolve('cesium/package.json'))).replaceAll('\\', '/') + '/';
  const localPrefix = '/@fs/' + resolve('node_modules').replaceAll('\\', '/') + '/';
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('vite.config.ts'), undefined, undefined, undefined, 'runner');
  const fixture = { name: 'model-contact-components-isolation', enforce: 'pre', configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] === viteEnv) { res.setHeader('Content-Type', 'text/javascript'); res.end((await server.transformRequest(req.url)).code); return; }
    if (req.url?.startsWith(dependencyPrefix)) req.url = localPrefix + req.url.slice(dependencyPrefix.length);
    if (req.url?.split('?')[0] === '/models/temporary-works/manifest.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ schemaVersion: 1, assets: [] })); return; }
    if (req.url === '/__synthetic_contact/tileset.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(tileset)); return; }
    if (req.url === '/__synthetic_contact/surface.glb') { res.setHeader('Content-Type', 'model/gltf-binary'); res.end(photo); return; }
    next();
  }); } }; fixture.configurePreviewServer = fixture.configureServer;
  if (productionBuild) { report.buildIndexSha256 = digest(await readFile('dist/index.html')); server = await preview({ ...loaded.config, configFile: false, plugins: [fixture, ...loaded.config.plugins], preview: { host: '127.0.0.1', port, strictPort: true } }); }
  else { server = await createServer({ ...loaded.config, configFile: false, plugins: [fixture, ...loaded.config.plugins], server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } }); await server.listen(); }
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-webgl', '--ignore-gpu-blocklist'] });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(45000);
  page.on('pageerror', error => report.errors.push(String(error))); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); if (message.type() === 'warning') report.consoleWarnings.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() }); });
  await page.route('**/__library/records', route => route.request().method() === 'GET' ? route.fulfill({ json: { records, problems: [], deletedVideoIds: [] } }) : route.continue());
  await page.goto(origin, { waitUntil: 'domcontentloaded' }); await attachProbe(); await bind(A);
  report.gpu = await page.evaluate(() => { const gl = window.__engineeringComponents.options.viewer.scene.context._gl, extension = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(extension.UNMASKED_RENDERER_WEBGL); });
  assert.doesNotMatch(report.gpu, /swiftshader|software|llvmpipe/i);
  await check('single actual component O clips only its finite volume through the main workbench', async () => {
    expect(await probe(A, cap), true, 'master initially off');
    await page.locator('[data-ec="photography-target"]').selectOption('synthetic-photo'); await panelMaster(true);
    await page.locator('[data-ec="search"]').fill('A001_cap_01');
    await page.locator('[data-component-id="A001_cap_01"] [data-ec-state="occlusionEnabled"]').check();
    const inside = await probe(A, cap); expect(inside, false, 'cap interior'); assert.equal(inside.state.componentCount, 1); assert.equal(inside.state.triangles, 12);
    const below = await probe(A, [0, -3, 0]), above = await probe(A, [0, 20, 0]); expect(below, true, 'same projection below'); expect(above, true, 'same projection above'); return { inside, below, above };
  });
  await check('component V off and closed panel preserve the independent photographic O contribution', async () => {
    await page.locator('[data-component-id="A001_cap_01"] [data-ec-state="visible"]').uncheck(); expect(await probe(A, cap), false);
    await page.locator('[data-ec-action="close"]').click(); const result = await probe(A, cap); expect(result, false);
    await page.locator('#openEngineeringComponents').click(); return result;
  });
  await check('single O and panel master each restore actual photographic pixels', async () => {
    await panelMaster(false); expect(await probe(A, cap), true); await panelMaster(true); expect(await probe(A, cap), false);
    await page.locator('[data-component-id="A001_cap_01"] [data-ec-state="occlusionEnabled"]').uncheck(); const result = await probe(A, cap); expect(result, true); return result;
  });
  await check('group and all controls select complete geometry while preserving space between the piles', async () => {
    await page.locator('[data-ec="search"]').fill('');
    for (const group of ['BR-LOW', 'A001']) { const row = page.locator(`[data-component-id="${group}"]`); if (await row.getAttribute('aria-expanded') === 'false') await row.locator('[data-ec-action="expand"]').click(); }
    await page.locator('[data-component-id="A001.cap"] [data-ec-state="occlusionEnabled"]').check(); expect(await probe(A, cap), false);
    await page.locator('[data-ec="all-occlusion"]').check(); const result = await probe(A, pile); expect(result, false);
    assert.equal(result.state.componentCount, 6); assert.equal(result.state.triangles, 1016); const between = await probe(A, [0, -30.285, 0]); expect(between, true, 'gap between piles'); return { result, between };
  });
  await check('switching and disconnecting the component tree retain both independent model owners', async () => {
    await bind(T); expect(await probe(A, cap), false, 'A001 still owns clipping after tree switch');
    await page.locator('[data-ec="photography-target"]').selectOption('synthetic-photo'); await panelMaster(true); await page.locator('[data-ec="all-occlusion"]').check();
    const wall = await probe(T, tunnel[2][1]); expect(wall, false); assert.equal(wall.state.componentCount, 199); assert.equal(wall.state.triangles, 7388);
    await page.locator('[data-ec-action="disconnect"]').click(); expect(await probe(T, tunnel[2][1]), false); expect(await probe(A, cap), false); return wall;
  });
  await check('TN021 actual walls remove photography while both chambers and exterior remain', async () => {
    const results = []; for (const [label, point, present] of tunnel) { const result = await probe(T, point); expect(result, present, label); results.push({ label, result }); } return results;
  });
  await check('model directory total switch works after tree disconnection and keeps other model owners', async () => {
    await directoryMaster(T, false); expect(await probe(T, tunnel[2][1]), true, 'TN021 disabled'); expect(await probe(A, cap), false, 'A001 retained');
    await directoryMaster(T, true); const result = await probe(T, tunnel[2][1]); expect(result, false); return result;
  });
  await check('refresh restores both model owners and component selection even with no connected tree', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' }); await attachProbe();
    const a = await probe(A, cap), t = await probe(T, tunnel[2][1]); expect(a, false); expect(t, false);
    assert.equal(a.state.componentCount, 6); assert.equal(t.state.componentCount, 199); assert.equal(a.state.targetId, 'synthetic-photo'); assert.equal(t.state.targetId, 'synthetic-photo'); return { a, t };
  });
  await check('closing both model total gates restores photographic surfaces through all former solids', async () => {
    await directoryMaster(A, false); await directoryMaster(T, false); expect(await probe(A, cap), true); expect(await probe(A, pile), true);
    const results = []; for (const [label, point] of tunnel) { const result = await probe(T, point); expect(result, true, label); results.push({ label, result }); } return results;
  });
  if (fullLine) {
    await check('complete hidden full-line model retains all 805322 triangles through the same real controls', async () => {
      await bind(F); await page.locator('[data-ec="photography-target"]').selectOption('synthetic-photo'); await panelMaster(true); await page.locator('[data-ec="all-occlusion"]').check();
      const a = await probe(F, cap), t = await probe(F, tunnel[2][1]); expect(a, false); expect(t, false); assert.equal(a.state.componentCount, 25258); assert.equal(a.state.triangles, 805322);
      const left = await probe(F, tunnel[5][1]), right = await probe(F, tunnel[6][1]); expect(left, true); expect(right, true); return { a, t, left, right };
    });
    await check('full-line model total off restores real photography and ends its contribution', async () => {
      await panelMaster(false); const a = await probe(F, cap), t = await probe(F, tunnel[2][1]); expect(a, true); expect(t, true); return { a, t };
    });
  }
  await page.screenshot({ path: join(out, 'final-workbench.png') });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.failedRequests, []);
  assert.deepEqual(report.consoleWarnings.filter(value => /GL_INVALID|Error compiling|CONTEXT_LOST/i.test(value)), []);
  report.sourceHashesAfter = await hashes(); assert.deepEqual(report.sourceHashesAfter, report.sourceHashes); report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); process.exitCode = 1; console.error(report.error);
  report.inputDiagnostics = await page?.evaluate(() => {
    const input = document.querySelector('[data-ec="all-occlusion"]'), rect = input?.getBoundingClientRect();
    const c = window.__engineeringComponents;
    return { events: window.__contactComponentsInputEvents, activeId: c?.activeInstanceId,
      summary: c?.state && c.summary(c.members()), scope: c?.reviewScope, status: c?.photographyStats,
      input: input && { checked: input.checked, indeterminate: input.indeterminate, disabled: input.disabled,
        rect: rect.toJSON(), atCenter: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML } };
  }).catch(error => ({ error: String(error) }));
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
}
finally {
  report.finishedAt = new Date().toISOString(); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await browser?.close();
  if (server?.close) await server.close(); else if (server?.httpServer) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, out }));
}
