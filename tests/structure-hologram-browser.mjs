/** Native workbench acceptance with generated GLBs and an isolated structure library.
 * PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE and BROWSER_LAUNCH_OPTIONS select an installed
 * runtime. STRUCTURE_HOLOGRAM_REQUIRE_HARDWARE=1 rejects software GPU evidence.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { createServer } from 'vite';
import { GlbWriter, IDENTITY } from '../tools/sketchup/glb-writer.mjs';

const output = resolve(process.env.STRUCTURE_HOLOGRAM_BROWSER_OUT || 'output/structure-hologram-browser');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'cesium-structure-hologram-'));
const work = await realpath(temp);
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR', 'CESIUM_STRUCTURE_LIBRARY_DIR', 'CESIUM_TEMPORARY_WORKS_ASSETS_DIR']) {
  process.env[key] = join(work, key.toLowerCase());
  await mkdir(process.env[key]);
}
const require = createRequire(import.meta.url);
const report = { classification: 'native-workbench-structure-hologram-synthetic-model-and-local-preview',
  productionDataReadOrModified: false, passed: false, checks: [], pageErrors: [], renderErrors: [] };
const modelId = 'fixture-bridge-source', nodeName = 'A001#墩', unboundNodeName = 'A002#墩';
const structureId = 'A001', localAnchor = [1, -2, 17], engineeringScale = 1.4, hologramScale = 1.2;
const sourceMatrix = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 10)));
const expectedAnchor = Cartesian3.pack(Matrix4.multiplyByPoint(Matrix4.fromArray(sourceMatrix),
  Cartesian3.multiplyByScalar(new Cartesian3(...localAnchor), engineeringScale, new Cartesian3()), new Cartesian3()), []);
const structureRoute = '/__structure_library/bridge/A001';
const sourceFiles = new Map();
let server, browser, context, page, origin;

const hologramPanel = () => page.locator('#structureHologramPanel');
const action = name => hologramPanel().locator(`[data-hologram-action="${name}"]`);
const field = name => hologramPanel().locator(`[data-hologram-field="${name}"]`);
const status = name => page.locator(`#structureHologramPanel[data-state="${name}"]`);
const samePosition = (actual, expected) => actual.every((value, i) => Math.abs(value - expected[i]) < 1e-6);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function boxGlb(name) {
  const writer = new GlbWriter();
  const vertices = [[-6,-4,0],[6,-4,0],[6,4,0],[-6,4,0],[-6,-4,9],[6,-4,9],[6,4,9],[-6,4,9]];
  const sides = [[[0,3,2,1],[0,0,-1]], [[4,5,6,7],[0,0,1]], [[0,1,5,4],[0,-1,0]],
    [[1,2,6,5],[1,0,0]], [[2,3,7,6],[0,1,0]], [[3,0,4,7],[-1,0,0]]];
  for (const [corners, normal] of sides) writer.addFace({
    positions: corners.flatMap(index => vertices[index].map(value => value / .0254)),
    normals: corners.flatMap(() => normal), indices: [0,1,2,0,2,3],
  }, IDENTITY, { key: 'synthetic-concrete', rgba: [.63,.68,.73,1] });
  return writer.finish(name).bytes;
}

function engineeringGlb() {
  const glb = boxGlb(nodeName), jsonEnd = 20 + glb.readUInt32LE(12);
  const document = JSON.parse(glb.subarray(20, jsonEnd));
  document.nodes.push({ name: unboundNodeName, mesh: 0, translation: [27, 0, 0] });
  document.scenes[0].nodes.push(1);
  const rawJson = Buffer.from(JSON.stringify(document));
  const json = Buffer.concat([rawJson, Buffer.alloc((4 - rawJson.length % 4) % 4, 0x20)]);
  const header = Buffer.from(glb.subarray(0, 20));
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(header.length + json.length + glb.length - jsonEnd, 8);
  return Buffer.concat([header, json, glb.subarray(jsonEnd)]);
}

async function prepareAssets() {
  const root = process.env.CESIUM_STRUCTURE_LIBRARY_DIR;
  const preview = 'bridge/A001/preview';
  await mkdir(join(root, preview, 'assets'), { recursive: true });
  sourceFiles.set('catalog.json', JSON.stringify({ version: 1, bindings: [{ modelId, nodeName, category: 'bridge', structureId }] }));
  sourceFiles.set('bridge/A001/structure.json', JSON.stringify({ version: 1, title: 'A001#墩交互结构', anchor: { kind: 'model-local',
    position: localAnchor }, headingDegrees: 20, scale: hologramScale }));
  sourceFiles.set('bridge/A001/hologram.glb', boxGlb('A001 hologram'));
  sourceFiles.set(preview + '/index.html', `<!doctype html><html lang="zh"><meta charset="utf-8"><title>A001 原交互预览</title>
  <link rel="stylesheet" href="./assets/theme.css"><h1>A001 原交互预览</h1><button id="toggle">查看桩基</button>
  <output>结构总览</output><script type="module" src="./assets/preview.js"></script></html>`);
  sourceFiles.set(preview + '/assets/theme.css', 'body { color: rgb(12, 45, 78); }');
  sourceFiles.set(preview + '/assets/parts.json', JSON.stringify({ foundation: '原网页 · 四根桩基' }));
  sourceFiles.set(preview + '/assets/preview.js', `import { component } from "./component.js";
const parts = await (await fetch(new URL("./parts.json", import.meta.url))).json();
document.querySelector("#toggle").addEventListener("click", () => { document.querySelector("output").textContent = component(parts.foundation) });
document.body.dataset.initialized = "true";`);
  sourceFiles.set(preview + '/assets/component.js', 'export const component = value => value;');
  for (const [name, data] of sourceFiles) await writeFile(join(root, name), data);
}

async function saveEngineeringModel() {
  const recordUrl = origin + '/__library/records/' + modelId, headers = { 'X-Cesium-Library': '1' };
  const file = await context.request.post(recordUrl + '/files/data?name=bridge.glb', { headers, data: engineeringGlb() });
  assert.equal(file.status(), 200, await file.text());
  const saved = await context.request.put(recordUrl, { headers, data: {
    id: modelId, name: 'Synthetic multi-component bridge', version: 1, kind: 'Model', visible: true,
    settings: { matrix: sourceMatrix, scale: engineeringScale }, files: { data: await file.json() },
  } });
  assert.equal(saved.status(), 200, await saved.text());
  return (await saved.json()).settings;
}

async function check(name, run) {
  const result = { name, status: 'running' };
  report.checks.push(result);
  console.log('RUN', name);
  try { result.evidence = await run(); result.status = 'passed'; console.log('PASS', name); }
  catch (error) { result.status = 'failed'; result.error = String(error); throw error; }
}

async function frames(count = 3) {
  await page.evaluate(async count => {
    const { renderFixtureFrames } = await import('/tools/fixtures/render-fixture-frames.ts');
    await renderFixtureFrames(window.__managementWorkspace.viewer.scene, count, () => window.__fixtureRenderErrors);
  }, count);
}

async function openTab(name) {
  await page.locator('[data-dock="editor"]').click();
  const toggle = page.locator('.function-centers-toggle');
  if (await toggle.isVisible()) await toggle.click();
  const button = page.locator(`.tab[data-tab="${name}"]`);
  if (!await button.isVisible()) await page.locator('.function-center').filter({ has: button }).locator('summary').click();
  await button.click();
}

async function openHologram() {
  await openTab('models');
  const button = page.locator('#openStructureHologram');
  const details = page.locator('details').filter({ has: button });
  for (let i = 0; i < await details.count(); i++) {
    const detail = details.nth(i);
    if (await detail.getAttribute('open') === null) await detail.locator(':scope > summary').click();
  }
  await button.click();
  await hologramPanel().waitFor({ state: 'visible' });
}

async function armPicking() {
  if (!await status('picking').isVisible() && await action('pick').isEnabled()) await action('pick').click();
  await status('picking').waitFor({ state: 'visible' });
}

async function mapPoint(name) {
  return page.evaluate(async ({ id, name, nodeName }) => {
    const C = await import('/node_modules/.vite/deps/cesium.js');
    const viewer = window.__managementWorkspace.viewer, scene = viewer.scene;
    const model = Array.from({ length: scene.primitives.length }, (_, i) => scene.primitives.get(i))
      .find(item => item.id?.engineeringModelId === id);
    const gltf = new C.Cartesian3(name === nodeName ? 0 : 27, 5, 0);
    const local = C.Matrix4.multiplyByPoint(model.sceneGraph.axisCorrectionMatrix, gltf, new C.Cartesian3());
    const world = C.Matrix4.multiplyByPoint(model.modelMatrix, C.Cartesian3.multiplyByScalar(local, model.scale, local), new C.Cartesian3());
    const point = C.SceneTransforms.worldToWindowCoordinates(scene, world), rect = scene.canvas.getBoundingClientRect();
    for (const [dx, dy] of [[0,0], [-9,3], [9,3], [-14,-7], [14,-7], [-23,0], [23,0]]) {
      const screen = new C.Cartesian2(point.x + dx, point.y + dy), hit = scene.pick(screen);
      const x = rect.left + screen.x, y = rect.top + screen.y;
      if (hit?.primitive === model && hit.detail?.node?.node?.name === name && document.elementFromPoint(x, y) === scene.canvas) return { x, y };
    }
    throw new Error(`Rendered source node ${name} was not pickable at ${JSON.stringify(point)}`);
  }, { id: modelId, name, nodeName });
}

async function clickModel(name) {
  const point = await mapPoint(name);
  await page.mouse.click(point.x, point.y);
}

async function clickProjection() {
  const point = await page.evaluate(async id => {
    const C = await import('/node_modules/.vite/deps/cesium.js');
    const scene = window.__managementWorkspace.viewer.scene;
    const projection = Array.from({ length: scene.primitives.length }, (_, i) => scene.primitives.get(i))
      .find(item => item.id?.structureHologramId === id);
    const center = C.SceneTransforms.worldToWindowCoordinates(scene, projection.boundingSphere.center);
    const rect = scene.canvas.getBoundingClientRect();
    const x = rect.left + center.x, y = rect.top + center.y;
    if (scene.pick(center, 1, 1)?.primitive !== projection || document.elementFromPoint(x, y) !== scene.canvas)
      throw new Error('Projection is not pickable in the scene');
    return { x, y };
  }, structureId);
  await page.mouse.click(point.x, point.y);
}

async function sceneState() {
  return page.evaluate(async id => {
    const viewer = window.__managementWorkspace.viewer, scene = viewer.scene;
    const C = await import('/node_modules/.vite/deps/cesium.js');
    const primitives = Array.from({ length: scene.primitives.length }, (_, i) => scene.primitives.get(i));
    function modelState(model) {
      return { matrix: C.Matrix4.toArray(model.modelMatrix), scale: model.scale, show: model.show, ready: model.ready,
        allowPicking: model.allowPicking, shadows: model.shadows, ...(model.customShader ? { shader: true } : {}) };
    }
    const source = primitives.find(item => item.id?.engineeringModelId === id);
    const projections = primitives.filter(item => item.id?.structureHologramId);
    return { source: source && modelState(source), projections: projections.map(modelState),
      primitiveCount: primitives.length, cameraInputs: scene.screenSpaceCameraController.enableInputs,
      renderErrors: [...window.__fixtureRenderErrors] };
  }, modelId);
}

try {
  await prepareAssets();
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
    ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright'));
  const options = process.env.BROWSER_LAUNCH_OPTIONS ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
  browser = await chromium.launch(options);
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const originalSettings = await saveEngineeringModel();
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.route('**/__basemap/**', route => route.fulfill({ contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }));
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(id => {
    const scene = window.__managementWorkspace?.viewer?.scene;
    return scene && Array.from({ length: scene.primitives.length }, (_, i) => scene.primitives.get(i))
      .some(item => item.id?.engineeringModelId === id && item.ready && item.show);
  }, modelId, { timeout: 60000 });
  await page.evaluate(async id => {
    const C = await import('/node_modules/.vite/deps/cesium.js');
    const viewer = window.__managementWorkspace.viewer, scene = viewer.scene;
    window.__fixtureRenderErrors = [];
    scene.renderError.addEventListener((_scene, error) => window.__fixtureRenderErrors.push(String(error.stack || error)));
    const source = Array.from({ length: scene.primitives.length }, (_, i) => scene.primitives.get(i))
      .find(item => item.id?.engineeringModelId === id);
    viewer.camera.cancelFlight();
    viewer.camera.lookAt(source.boundingSphere.center, new C.HeadingPitchRange(.4, -.65, 90));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
  }, modelId);
  await frames();
  report.browserVersion = browser.version();
  report.renderer = await page.evaluate(() => {
    const gl = window.__managementWorkspace.viewer.scene.context._gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  if (process.env.STRUCTURE_HOLOGRAM_REQUIRE_HARDWARE === '1'
    && (!/NVIDIA|AMD|Radeon|Intel|Apple|Adreno|Mali/i.test(report.renderer) || /swiftshader|llvmpipe|software/i.test(report.renderer)))
    throw new Error('BLOCKED: hardware acceptance requested; hardware renderer not established');
  const original = await sceneState();

  await check('inactive-click-leaves-existing-model-and-no-projection', async () => {
    await clickModel(nodeName);
    await frames();
    assert.equal(await hologramPanel().isVisible(), false);
    assert.deepEqual(await sceneState(), original);
    return { unchanged: true };
  });

  await check('scene-pick-uses-saved-model-id-and-exact-node-name', async () => {
    await openHologram();
    await armPicking();
    await clickModel(unboundNodeName);
    await frames();
    assert.equal((await sceneState()).projections.length, 0, 'An unbound node unexpectedly opened a related structure');
    await armPicking();
    await clickModel(nodeName);
    await status('ready').waitFor({ state: 'visible' });
    await frames();
    assert.equal(await hologramPanel().getAttribute('data-model-id'), modelId);
    assert.equal(await hologramPanel().getAttribute('data-structure-id'), structureId);
    assert.equal(await hologramPanel().getAttribute('data-node-name'), nodeName);
    const state = await sceneState();
    assert.equal(state.projections.length, 1);
    const projection = state.projections[0];
    assert.equal(projection.ready, true);
    assert.equal(projection.allowPicking, true);
    assert.equal(projection.shader, true);
    assert.equal(projection.scale, hologramScale);
    assert.ok(samePosition(projection.matrix.slice(12,15), expectedAnchor), JSON.stringify(projection.matrix.slice(12,15)));
    assert.deepEqual(state.source, original.source);
    await page.screenshot({ path: join(output, 'anchored-projection.png') });
    return { modelId, nodeName, anchor: projection.matrix.slice(12,15) };
  });

  await check('projection-controls-and-original-interactive-page', async () => {
    const prior = (await sceneState()).projections[0];
    await field('rotation').focus();
    await page.keyboard.press('ArrowRight');
    await field('scale').focus();
    await page.keyboard.press('ArrowRight');
    await frames();
    const adjusted = await sceneState(), projection = adjusted.projections[0];
    assert.notDeepEqual(projection.matrix, prior.matrix);
    assert.ok(projection.scale > prior.scale);
    assert.ok(samePosition(projection.matrix.slice(12,15), expectedAnchor));
    assert.deepEqual(adjusted.source, original.source);
    assert.equal(await field('preview').getAttribute('href'), structureRoute + '/preview');
    const popupPending = page.waitForEvent('popup');
    await clickProjection();
    const popup = await popupPending;
    try {
      await popup.locator('body[data-initialized="true"]').waitFor();
      assert.equal(await popup.title(), 'A001 原交互预览');
      assert.equal(await popup.locator('body').evaluate(element => getComputedStyle(element).color), 'rgb(12, 45, 78)');
      await popup.locator('#toggle').click();
      assert.equal(await popup.locator('output').innerText(), '原网页 · 四根桩基');
      assert.equal(await popup.evaluate(() => window.opener === null), true);
    } finally { await popup.close(); }
    assert.deepEqual((await sceneState()).source, original.source);
    return { independentTransform: true, originalModuleCssDataAndClick: true };
  });

  await check('late-request-cannot-reopen-a-closed-projection', async () => {
    await action('close').click();
    await hologramPanel().waitFor({ state: 'hidden' });
    await frames();
    assert.deepEqual(await sceneState(), original);
    const url = origin + structureRoute + '/structure.json';
    let noteStarted, unblock;
    const started = new Promise(resolve => { noteStarted = resolve; });
    const blocked = new Promise(resolve => { unblock = resolve; });
    const pause = async route => { noteStarted(); await blocked; await route.continue().catch(() => {}); };
    await page.route(url, pause);
    try {
      await openHologram();
      await armPicking();
      await clickModel(nodeName);
      await Promise.race([started, page.waitForTimeout(8000).then(() => { throw new Error('Projection manifest was not requested'); })]);
      await action('close').click();
      await hologramPanel().waitFor({ state: 'hidden' });
      unblock();
      await frames(8);
      assert.deepEqual(await sceneState(), original);
    } finally { unblock(); await page.unroute(url, pause); }
    return { lateLoadDiscarded: true, originalStateRestored: true };
  });

  await check('existing-underground-tool-exits-projection-and-model-record-stays-identical', async () => {
    await openHologram();
    await armPicking();
    await clickModel(nodeName);
    await status('ready').waitFor({ state: 'visible' });
    await page.locator('#openSubsurfacePanel').click();
    await hologramPanel().waitFor({ state: 'hidden' });
    await page.locator('#subsurfacePanel').waitFor({ state: 'visible' });
    await frames();
    const after = await sceneState();
    assert.equal(after.projections.length, 0);
    assert.equal(after.cameraInputs, true);
    assert.deepEqual(after.source, original.source);
    const saved = await context.request.get(origin + '/__library/records/' + modelId);
    assert.equal(saved.status(), 200, await saved.text());
    assert.deepEqual((await saved.json()).settings, originalSettings);
    for (const [name, bytes] of sourceFiles)
      assert.equal(hash(await readFile(join(process.env.CESIUM_STRUCTURE_LIBRARY_DIR, name))), hash(bytes), name);
    return { existingToolVisible: true, sourceRecordAndLocalAssetsUnchanged: true };
  });

  report.renderErrors = (await sceneState()).renderErrors;
  assert.deepEqual(report.renderErrors, []);
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = /^Error: BLOCKED:|browserType.launch|Failed to create WebGL|WebGL.*not supported/i.test(report.error) ? 2 : 1;
  console.error(report.error);
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(-6500);
    report.renderErrors = await page.evaluate(() => window.__fixtureRenderErrors ?? []).catch(() => []);
  }
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await server?.close();
  await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.map(({ name, status }) => ({ name, status })),
    report: join(output, 'report.json') }));
}
