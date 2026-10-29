/** Original-workbench acceptance using isolated data and a generated 3D Tiles surface.
 * No user projects or site imagery are read. Set PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE
 * to use an existing Playwright/Chromium installation. Downloads remain in output/.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { createServer } from 'vite';

const output = resolve(process.env.MACHINERY_LIVE_VERIFY_OUT || 'output/machinery-live-export');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/machinery-live-export-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { classification: 'original-workbench-with-generated-3d-tiles-and-isolated-ledger', startedAt: new Date().toISOString(), checks: [], pageErrors: [], consoleErrors: [], downloads: [], screenshots: [] };
let server, browser, context, page, origin, activeCheck, craneId;
const panel = () => page.locator('.machinery-panel');
const action = key => panel().locator(`[data-action="${key}"]`);
const field = key => panel().locator(`[data-parameter="${key}"]`);
const coord = key => panel().locator(`[data-placement="${key}"]`);
const snapshot = () => page.evaluate(() => window.__managementWorkspace.ui.getSnapshot());
const saved = async id => (await snapshot()).collections.resources.find(r => r.id === id).machinery;
async function check(id, run) {
  activeCheck = { id, status: 'running', startedAt: new Date().toISOString() }; report.checks.push(activeCheck); console.log('RUN', id);
  activeCheck.evidence = await run(); activeCheck.status = 'passed'; activeCheck.finishedAt = new Date().toISOString(); console.log('PASS', id);
}
async function editorReady(id) {
  await page.waitForFunction(id => { const p = window.__managementWorkspace?.machinery; return p?.asset && !p.loading && !p.busy && (!id || p.selectedResourceId === id); }, id, { timeout: 60000 });
}
async function settled(id) {
  await page.waitForFunction(id => { const p = window.__managementWorkspace?.machinery; return p && !p.loading && !p.busy && p.previewTimer === undefined && p.scene.rendered.has(id) && !p.scene.tasks.has(id) && !p.scene.getError(id); }, id, { timeout: 60000 });
}
async function save() {
  const response = page.waitForResponse(r => { try { return r.url().endsWith('/__management/commands') && r.request().postDataJSON()?.type === 'machinery.save'; } catch { return false; } });
  await action('save').click(); const r = await response; assert.equal(r.status(), 200, await r.text());
  await page.waitForFunction(() => !window.__managementWorkspace.machinery.hasDraft && !window.__managementWorkspace.machinery.busy);
}
async function fill(locator, value) { await locator.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); await locator.fill(String(value)); }
async function openEditor() { await page.locator('.tab[data-tab="machinery"]').click(); await panel().waitFor({ state: 'visible' }); await editorReady(craneId); }
async function capture(name) { const path = resolve(output, name + '.png'); await page.screenshot({ path, timeout: 30000 }); report.screenshots.push(path); }
async function post(values) {
  const response = await context.request.post(origin + '/__management/machinery-telemetry', { headers: { 'X-Cesium-Library': '1' }, data: {
    schemaVersion: 1, projectId: 'safety:project', resourceId: craneId, sourceId: 'browser-sim', timestamp: new Date().toISOString(), mode: 'simulated', values,
  } }); assert.equal(response.status(), 202, await response.text());
}
async function waitLive(key, value) { await page.waitForFunction(({ id, key, value }) => Math.abs((window.__managementWorkspace.machinery.telemetry.getState(id)?.parameters[key] ?? NaN) - value) < 1e-7, { id: craneId, key, value }, { timeout: 60000 }); await settled(craneId); }
async function download(trigger) {
  const pending = page.waitForEvent('download', { timeout: 60000 }); await trigger(); const item = await pending;
  const path = resolve(output, item.suggestedFilename()); await item.saveAs(path); assert.equal(await item.failure(), null);
  const bytes = await readFile(path); assert(bytes.length > 0); report.downloads.push({ name: item.suggestedFilename(), bytes: bytes.length }); return { path, bytes };
}

// A green slab whose top is 58 metres above the ellipsoid. It uses the actual
// 3D Tiles loader/depth path, without substituting the picking implementation.
function slabGlb() {
  const positions = new Float32Array([-150,0,-150,150,0,-150,150,8,-150,-150,8,-150,-150,0,150,150,0,150,150,8,150,-150,8,150]);
  const indices = new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const gltf = { asset: { version: '2.0', generator: 'Machinery placement test slab' }, extensionsUsed: ['KHR_materials_unlit'], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.16,.38,.22,1], metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} }, doubleSided: true }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-150,0,-150], max: [150,8,150] }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }] };
  const encoded = Buffer.from(JSON.stringify(gltf)), json = Buffer.concat([encoded, Buffer.alloc((4 - encoded.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + bin.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binary = Buffer.alloc(8); binary.writeUInt32LE(bin.length); binary.writeUInt32LE(0x004e4942, 4); return Buffer.concat([header, json, binary, bin]);
}
const slab = slabGlb();
const tileset = { asset: { version: '1.1', gltfUpAxis: 'Y' }, geometricError: 500, root: { transform: Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(116.391, 39.907, 50))), boundingVolume: { box: [0,0,4,150,0,0,0,150,0,0,0,4] }, geometricError: 500, refine: 'ADD', content: { uri: 'slab.glb' } } };
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const launchOptions = process.env.BROWSER_LAUNCH_OPTIONS ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] };
  server = await createServer({ plugins: [{ name: 'machinery-acceptance-fixture', configureServer(s) { s.middlewares.use('/__machinery_test_tiles/', (req, res, next) => {
    if (req.url === '/tileset.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(tileset)); }
    else if (req.url === '/slab.glb') { res.setHeader('Content-Type', 'model/gltf-binary'); res.end(slab); } else next();
  }); } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(launchOptions); context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true, timezoneId: 'Asia/Shanghai' }); page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', e => report.pageErrors.push({ check: activeCheck?.id, message: e.message }));
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({ check: activeCheck?.id, message: m.text().slice(0, 400) }); });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__managementWorkspace?.ui.getSnapshot()?.projectId, undefined, { timeout: 60000 });
  await page.locator('#basemap').selectOption('none');
  await check('load-real-3d-tiles-surface', async () => {
    await page.locator('.tab[data-tab="tiles"]').click(); await fill(page.locator('#tilesUrl'), origin + '/__machinery_test_tiles/tileset.json'); await page.locator('#loadTiles').click();
    await page.waitForFunction(() => !document.querySelector('#loadTiles').disabled, undefined, { timeout: 60000 });
    await page.evaluate(async () => { const { Cartesian3 } = await import('/node_modules/.vite/deps/cesium.js'); const v = window.__managementWorkspace.viewer; v.camera.setView({ destination: Cartesian3.fromDegrees(116.391,39.907,500), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } }); v.scene.requestRender(); });
    await page.waitForFunction(() => { const v = window.__managementWorkspace.viewer; for (let i = 0; i < v.scene.primitives.length; i++) { const p = v.scene.primitives.get(i); if (p?.root?.content && p.tilesLoaded) return true; } return false; }, undefined, { timeout: 90000 });
    return { type: 'generated 3D Tiles 1.1 surface', topEllipsoidHeight: 58 };
  });
  await check('new-resource-shown-before-placement', async () => {
    await page.locator('.tab[data-tab="machinery"]').click(); const name = '机械联动导出验收-' + Date.now(); await fill(panel().locator('[data-role="create-name"]'), name); await action('create').click();
    await page.waitForFunction(name => window.__managementWorkspace.ui.getSnapshot().collections.resources.some(r => r.name === name) && !window.__managementWorkspace.machinery.busy, name);
    craneId = (await snapshot()).collections.resources.find(r => r.name === name).id; await editorReady(craneId);
    await page.locator('[data-dock="display"]').click(); const row = page.locator(`[data-display-id="machine:${craneId}"]`); await row.waitFor();
    assert.match(await row.innerText(), /尚未布置|待布置/); assert.equal(await row.locator('[data-action="item-visibility"]').isDisabled(), true);
    await capture('01-unplaced-resource-directory'); await openEditor(); return { id: craneId, presentBeforeModelPlacement: true };
  });
  await check('pick-photogrammetry-surface-and-normal-editor-zero', async () => {
    await panel().locator('[data-role="asset"]').selectOption('crane'); await editorReady(craneId); await fill(field('overall_scale'), 4);
    await page.evaluate(async () => { const { Cartesian3 } = await import('/node_modules/.vite/deps/cesium.js'); const v = window.__managementWorkspace.viewer; v.camera.setView({ destination: Cartesian3.fromDegrees(116.391,39.907,500), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } }); v.scene.requestRender(); });
    await page.waitForTimeout(500); await action('pick').click();
    const box = await page.locator('#cesiumContainer canvas').boundingBox(); await page.mouse.click(box.x + box.width * .44, box.y + box.height * .49);
    await page.waitForFunction(() => !window.__managementWorkspace.machinery.picking);
    const height = Number(await coord('height').inputValue()); assert(Math.abs(height - 58) < .7, `Picked height ${height} must use surface, not ellipsoid`);
    assert.match(await panel().locator('[data-role="position-source"]').innerText(), /摄影|模型|表面/);
    await fill(field('boom_rotation_deg'), 0); await fill(field('boom_elevation_deg'), 45); await fill(coord('heading'), 0); await save(); await settled(craneId);
    const state = await saved(craneId); const expected = await page.evaluate(async () => { const m = await import('/src/machineryTelemetry.ts'); return m.canonicalBoomToSource(window.__managementWorkspace.machinery.asset, 0); });
    assert(Math.abs(state.parameters.boom_rotation_deg - expected) < 1e-8); assert.equal(Number(await field('boom_rotation_deg').inputValue()), 0);
    await page.locator('[data-dock="display"]').click(); const row = page.locator(`[data-display-id="machine:${craneId}"]`); assert.equal(await row.locator('[data-action="item-visibility"]').isDisabled(), false);
    await openEditor(); await action('locate').click(); await page.waitForTimeout(1200); await capture('02-photogrammetry-placement-and-zero');
    return { pickedHeight: height, userBoomAngle: 0, storedAngle: state.parameters.boom_rotation_deg, sameDirectoryResource: true };
  });
  await check('smooth-live-pose-reuses-model-and-records-real-samples', async () => {
    await panel().locator('details[data-role="telemetry"]').evaluate(el => { el.open = true; });
    for (const key of ['boom_length_m', 'boom_elevation_deg', 'boom_rotation_deg']) {
      const row = panel().locator(`[data-telemetry-target="${key}"]`); await row.locator('[data-telemetry-input="enabled"]').check();
      await fill(row.locator('[data-telemetry-input="sourceId"]'), 'browser-sim'); await fill(row.locator('[data-telemetry-input="sourceField"]'), key);
    }
    await action('telemetry-enable').click(); await page.waitForFunction(() => window.__managementWorkspace.machinery.telemetry.enabledCount === 1);
    await panel().locator('[data-role="machinery-capture"]').evaluate(el => { el.open = true; });
    await panel().locator('[data-role="pose-history"]').evaluate(el => { el.open = true; });
    await panel().locator('[data-pose-action="start"]').click();
    await page.evaluate(id => {
      const s = window.__managementWorkspace.machinery.scene, v = window.__managementWorkspace.viewer, initial = s.rendered.get(id);
      const capture = { samples: [], initialValue: s.getRenderState(id).displayedState.parameters.boom_length_m, initialUrl: initial.url, sameEntity: true, sameGraphics: true, sameShader: true };
      const shader = initial.shader, graphics = initial.entity.model;
      const remove = v.scene.postRender.addEventListener(() => { const r = s.rendered.get(id), state = s.getRenderState(id);
        capture.sameEntity &&= r?.entity === initial.entity; capture.sameGraphics &&= r?.entity.model === graphics; capture.sameShader &&= r?.shader === shader;
        if (capture.samples.length < 500 && state) capture.samples.push({ value: state.displayedState.parameters.boom_length_m, target: state.targetState.parameters.boom_length_m, interpolating: state.interpolating, url: r.url, shown: r.entity.show });
      }); window.__poseMotionProbe = { capture, remove };
    }, craneId);
    await post({ boom_length_m: 38, boom_elevation_deg: 55, boom_rotation_deg: 0 }); await waitLive('boom_length_m', 38);
    await page.waitForFunction(id => !window.__managementWorkspace.machinery.scene.getRenderState(id)?.interpolating, craneId, { timeout: 10000 });
    await page.waitForFunction(() => Math.abs((window.__poseMotionProbe.capture.samples.at(-1)?.value ?? 0) - 38) < 1e-6, undefined, { timeout: 10000 });
    const evidence = await page.evaluate(() => { const p = window.__poseMotionProbe; p.remove(); delete window.__poseMotionProbe; return p.capture; });
    report.motionEvidence = evidence;
    assert(evidence.sameEntity && evidence.sameGraphics && evidence.sameShader, 'No model, graphics or shader replacement during telemetry');
    assert.equal(new Set(evidence.samples.map(s => s.url)).size, 1); assert(evidence.samples.every(s => s.shown), 'Model stays shown on every observed render');
    const initial = evidence.initialValue; assert(evidence.samples.some(s => s.value > initial && s.value < 38 && s.interpolating), 'Actual rendered frames include intermediate extension');
    assert(Math.abs(evidence.samples.at(-1).value - 38) < 1e-6);
    const beforeClose = await page.evaluate(() => window.__managementWorkspace.machinery.capture.session.recorder.count);
    await action('close').click(); await post({ boom_length_m: 40 }); await waitLive('boom_length_m', 40); await openEditor();
    assert((await page.evaluate(() => window.__managementWorkspace.machinery.capture.session.recorder.count)) > beforeClose, 'Closing editor keeps explicit pose recording running');
    await panel().locator('[data-role="machinery-capture"]').evaluate(el => { el.open = true; }); await panel().locator('[data-role="pose-history"]').evaluate(el => { el.open = true; });
    await panel().locator('[data-pose-action="stop"]').click();
    const json = await download(() => panel().locator('[data-pose-action="json"]').click()); const archive = JSON.parse(json.bytes.toString('utf8'));
    const change = archive.entries.flatMap(e => e.changes).find(c => c.field === 'boom_length_m' && c.value === 38);
    assert(change && change.source === 'simulated' && change.samples[0].sampleTimestamp); assert.match(change.description, /伸长至38/);
    assert.equal(archive.entries.flatMap(e => e.changes).find(c => c.field === 'boom_rotation_deg')?.value, 0);
    const csv = await download(() => panel().locator('[data-pose-action="csv"]').click()); assert.equal(csv.bytes.subarray(0,3).toString('hex'), 'efbbbf'); assert.match(csv.bytes.toString('utf8'), /模拟/);
    await capture('03-live-records-and-smooth-model');
    return { entityStable: evidence.sameEntity, graphicsStable: evidence.sameGraphics, shaderStable: evidence.sameShader, observedFrames: evidence.samples.length,
      intermediateFrames: evidence.samples.filter(s => s.interpolating).length, entries: archive.entries.length, sampleTime: change.samples[0].sampleTimestamp, description: change.description };
  });
  await check('scene-video-download-with-live-pose', async () => {
    await action('locate').click(); await page.waitForTimeout(1100); const video = panel().locator('.scene-video-export');
    await fill(video.locator('[data-scene-video-role="duration"]'), 6); await video.locator('[data-scene-video-role="format"]').selectOption('webm');
    await page.evaluate(() => {
      const w = window.__managementWorkspace, recorder = w.machinery.capture.video.recorder;
      window.__videoDiagnostic = [];
      const sample = () => { window.__videoDiagnostic.push({ at: performance.now(), ...recorder.snapshot,
        capturedFrames: recorder.capturedFrames, sceneFrame: w.viewer.scene.frameState.frameNumber,
        encoder: recorder.encoder?.state, track: recorder.stream?.getVideoTracks().map(t => ({ readyState: t.readyState, muted: t.muted })),
        renderLoop: w.viewer.cesiumWidget._renderLoopRunning, canvas: [w.viewer.canvas.width, w.viewer.canvas.height] }); };
      const timer = setInterval(() => { sample(); if (['complete','error','cancelled'].includes(recorder.snapshot.state)) clearInterval(timer); }, 200);
      setTimeout(() => clearInterval(timer), 25000); sample();
    });
    await video.locator('[data-scene-video-action="start"]').click();
    await page.waitForFunction(() => document.querySelector('.machinery-panel .scene-video-export')?.dataset.state === 'recording');
    await post({ boom_length_m: 42, boom_elevation_deg: 35, boom_rotation_deg: 45 }); await waitLive('boom_length_m', 42);
    await page.waitForTimeout(900);
    // Slow software-rendered runners can hit the configured automatic limit
    // before the next UI action. Both completion paths must yield a real file.
    if (await video.locator('[data-scene-video-action="stop"]').isEnabled()) await video.locator('[data-scene-video-action="stop"]').click();
    await page.waitForFunction(() => ['complete','error','cancelled'].includes(document.querySelector('.machinery-panel .scene-video-export')?.dataset.state), undefined, { timeout: 30000 });
    report.videoDiagnostic = await page.evaluate(() => window.__videoDiagnostic);
    assert.equal(await video.getAttribute('data-state'), 'complete', JSON.stringify(report.videoDiagnostic.slice(-5)));
    await video.locator('[data-scene-video-action="download"]').waitFor({ state: 'visible', timeout: 30000 });
    const result = await download(() => video.locator('[data-scene-video-action="download"]').click());
    assert.equal(result.bytes.subarray(0,4).toString('hex'), '1a45dfa3'); assert(result.bytes.length > 2000);
    const decoded = await page.evaluate(async () => {
      const result = window.__managementWorkspace.machinery.capture.video.recorder.result;
      const player = document.createElement('video'), url = URL.createObjectURL(result.blob);
      const wait = event => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Video decode timeout: ' + event)), 10000);
        player.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
        player.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Video decode error')); }, { once: true });
      });
      try {
        player.muted = true; player.preload = 'auto'; const metadata = wait('loadedmetadata'); player.src = url; await metadata;
        const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96; const context = canvas.getContext('2d');
        const samples = [];
        for (const time of [.1, Math.max(.1, player.duration - .2)]) {
          const seeked = wait('seeked'); player.currentTime = time; await seeked; context.drawImage(player, 0, 0, 96, 96);
          const pixels = context.getImageData(0, 0, 96, 96).data; let visible = 0, hash = 0; const colors = new Set();
          for (let i = 0; i < pixels.length; i += 4) { const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
            if (r+g+b > 30) visible++; colors.add((r>>3)*1024+(g>>3)*32+(b>>3)); hash=(Math.imul(hash,31)+r+g*3+b*7)|0; }
          samples.push({ time, visible, colors: colors.size, hash });
        }
        return { duration: player.duration, width: player.videoWidth, height: player.videoHeight, samples };
      } finally { player.src = ''; URL.revokeObjectURL(url); }
    });
    assert(decoded.samples.every(s => s.visible > 500 && s.colors > 8), JSON.stringify(decoded));
    await action('telemetry-disable').click(); await save(); await settled(craneId);
    return { file: result.path, bytes: result.bytes.length, container: 'WebM', sensorChangedDuringCapture: true, decoded };
  });
  await check('fall-video-viewpoint-and-replay-project', async () => {
    await page.locator('.tab[data-tab="rail-safety"]').click(); const rail = page.locator('.rail-safety-panel'); await rail.waitFor({ state: 'visible' });
    await rail.locator('[data-action="tab-machine"]').click(); await rail.locator('[data-role="selection"]').selectOption(craneId);
    await rail.locator('[data-action="fall-start"]').click();
    await page.waitForFunction(() => { const d = window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo; return d.active && !d.loading && d.modelCreated; }, undefined, { timeout: 60000 });
    const select = rail.locator('[data-role="fall-export-view"]'); const choices = await select.locator('option').evaluateAll(options => options.map(o => ({ value: o.value, text: o.textContent })));
    const oblique = choices.find(o => /斜/.test(o.text)); assert(oblique); await select.selectOption(oblique.value);
    await rail.locator('[data-action="fall-export-video"]').click();
    await rail.locator('[data-action="fall-download-video"]').waitFor({ state: 'visible', timeout: 90000 });
    const video = await download(() => rail.locator('[data-action="fall-download-video"]').click()); assert.equal(video.bytes.subarray(0,4).toString('hex'), '1a45dfa3');
    const project = await download(() => rail.locator('[data-action="fall-download-project"]').click()); const data = JSON.parse(project.bytes.toString('utf8'));
    assert.equal(data.kind, 'cesium-machinery-fall-project'); assert.equal(data.resourceId, craneId); assert(data.scene.resources.some(r => r.kind === '3D Tiles'));
    assert.equal(data.scene.mode, 'references-only'); assert(!/token|https?:\/\//i.test(JSON.stringify(data.scene.resources)));
    const before = await saved(craneId); await rail.locator('[data-action="fall-stop"]').click();
    await rail.locator('[data-role="fall-import-file"]').setInputFiles(project.path);
    await page.waitForFunction(() => { const p = window.__managementWorkspace.railSafety; return p.scene.getSnapshot().fallDemo.playing; }, undefined, { timeout: 60000 });
    assert.deepEqual(await saved(craneId), before, 'Replay must not overwrite equipment ledger');
    await rail.locator('[data-action="fall-stop"]').click(); await capture('04-fall-export-and-project-replay');
    return { video: video.path, project: project.path, choices, sceneReferences: data.scene.resources.length, ledgerUnchanged: true };
  });
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1;
  if (activeCheck?.status === 'running') { activeCheck.status = 'failed'; activeCheck.error = report.failure; }
  console.error(error); if (page) { await capture('failure').catch(() => {}); report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(-12000); report.runtime = await page.evaluate(() => { const v = window.__managementWorkspace?.viewer; if (!v) return {}; return { useDefaultRenderLoop: v.useDefaultRenderLoop, sceneMode: v.scene.mode, camera: v.camera.positionCartographic, primitives: Array.from({ length: v.scene.primitives.length }, (_, i) => { const p = v.scene.primitives.get(i); return { type: p?.constructor?.name, show: p.show, tilesLoaded: p.tilesLoaded, root: !!p.root, contentReady: p.root?.contentReady }; }) }; }).catch(() => ({})); }
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  await context?.close(); await browser?.close(); await server?.close();
}
