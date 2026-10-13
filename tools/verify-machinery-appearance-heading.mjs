/**
 * Actual Chromium acceptance in the original `/` Cesium workbench.
 * All resources and accounts use a new isolated database. Only product controls
 * edit models; observations decode the GLB actually loaded by Cesium and its
 * actual scene-graph model matrix. Camera-only framing captures the evidence.
 *
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/absolute/path/to/launch_options.mjs \
 * MACHINERY_APPEARANCE_RECORD_VIDEO=1 node tools/verify-machinery-appearance-heading.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const detailOnly = process.env.MACHINERY_APPEARANCE_DETAIL_ONLY === '1';
const output = resolve(process.env.MACHINERY_APPEARANCE_VERIFY_OUT || (detailOnly ? 'output/machinery-appearance-heading/body-detail-isolated' : 'output/machinery-appearance-heading'));
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/machinery-appearance-heading-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const definitions = [
  ['crane-appearance-heading', 'Crane uses differentiated vivid colors and rotates its full actual model at the fixed station'],
  ['pile-appearance-heading', 'Piling rig uses differentiated vivid colors and rotates its full actual model at the fixed station'],
  ['excavator-appearance-heading', 'Excavator uses differentiated vivid colors and rotates its full actual model at the fixed station'],
  ['three-model-overview', 'All three colored models remain together in the same original Viewer'],
  ['asset-switch-heading', 'Switching model type preserves pending whole-machine heading at the same station'],
  ['combined-crane-pose', 'Whole-machine rotation preserves independent boom slew, elevation, extension and geometry'],
  ['rotation-controls', 'Numeric entry, slider, ±15° wrap and reset update the actual rendered heading'],
  ['save-reload', 'Saved heading and exact local geometry survive original-workbench reload'],
  ['cancel', 'Normal and immediate cancellation restore saved heading without modifying the resource'],
  ['dimension-reset', 'Dimension reset preserves pending whole-machine heading and both boom angles'],
  ['read-only', 'A real viewer account can see machines but cannot change heading or save resources'],
  ['single-runtime', 'Original workbench retains one Viewer, panel and machinery source without browser errors'],
];
const report = { classification: 'actual-original-workbench-machinery-appearance-and-heading-with-isolated-data',
  renderer: 'Real Chromium WebGL2; software renderer when configured launch options select SwiftShader',
  startedAt: new Date().toISOString(), dataDir, productionDataReadOrModified: false,
  checks: definitions.filter(([id]) => !detailOnly || ['crane-appearance-heading', 'combined-crane-pose'].includes(id)).map(([id, title]) => ({ id, title, status: 'pending' })),
  screenshots: [], videos: [], pageErrors: [], consoleErrors: [] };
let server, browser, context, page, activeCheck, recordId, video, origin;
const resources = {}, savedById = {};
const panel = () => page.locator('.machinery-panel');
const action = name => panel().locator(`[data-action="${name}"]`);
const parameter = key => panel().locator(`[data-parameter="${key}"]`);
const coordinate = key => panel().locator(`[data-placement="${key}"]`);
const heading = () => coordinate('heading');
const slider = () => panel().locator('[data-role="machine-rotation-slider"]');
async function check(id, run) {
  activeCheck = report.checks.find(item => item.id === id); if (!activeCheck) return; activeCheck.status = 'running';
  activeCheck.startedAt = new Date().toISOString(); console.log('RUN', id);
  activeCheck.evidence = await run(); activeCheck.status = 'passed';
  activeCheck.finishedAt = new Date().toISOString(); console.log('PASS', id);
}
async function ready() {
  await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId, undefined, { timeout: 60000 });
}
async function panelReady(assetId) {
  await panel().waitFor({ state: 'visible' });
  await page.waitForFunction(assetId => { const p = window.__managementWorkspace.machinery;
    return p.asset && !p.loading && !p.busy && (!assetId || p.asset.id === assetId); }, assetId);
}
async function settled() {
  await page.waitForFunction(id => {
    const runtime = window.__managementWorkspace, p = runtime.machinery, rendered = p.scene.rendered.get(id);
    if (p.loading || p.busy || p.previewTimer !== undefined || p.scene.tasks.has(id) || !rendered || p.scene.getError(id)) return false;
    for (const source of runtime.viewer.dataSources._dataSources) for (const visualizer of source._visualizers || []) {
      const entry = visualizer._modelHash?.[rendered.entity.id];
      if (entry?.url === rendered.url && entry.modelPrimitive?.ready) return true;
    }
    return false;
  }, recordId, { timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function snapshot() { return page.evaluate(() => window.__managementWorkspace.ui.getSnapshot()); }
async function savedState() { return (await snapshot()).collections.resources.find(item => item.id === recordId).machinery; }
async function save() {
  const promise = page.waitForResponse(response => {
    if (!response.url().endsWith('/__management/commands')) return false;
    try { return response.request().postDataJSON()?.type === 'machinery.save'; } catch { return false; }
  });
  await action('save').click(); const response = await promise;
  assert.equal(response.status(), 200, await response.text());
  await page.waitForFunction(() => !window.__managementWorkspace.machinery.busy && !window.__managementWorkspace.machinery.hasDraft);
  await settled();
}
async function select(assetId) {
  recordId = resources[assetId];
  await page.locator(`[data-machinery-record="${recordId}"] [data-machinery-action="edit"]`).click();
  await panelReady(assetId); await settled();
}
async function screenshot(name) {
  await page.evaluate(() => document.fonts.ready); await panel().locator('.mp-content').evaluate(e => { e.scrollTop = 0; });
  await page.waitForTimeout(250);
  const path = resolve(output, name + '.png'); await page.screenshot({ path, timeout: 20000 }); report.screenshots.push(path);
}
async function frame(assetId, overview = false) {
  await page.evaluate(async ({ id, overview }) => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), r = window.__managementWorkspace;
    const state = r.ui.getSnapshot().collections.resources.find(item => item.id === id).machinery;
    const rendered = r.machinery.scene.rendered.get(id); let model;
    for (const source of r.viewer.dataSources._dataSources) for (const visualizer of source._visualizers || []) {
      const entry = visualizer._modelHash?.[rendered.entity.id];
      if (entry?.url === rendered.url && entry.modelPrimitive?.ready) model = entry.modelPrimitive;
    }
    if (!model) throw new Error('Model bounds unavailable for evidence camera framing');
    const target = overview ? C.Cartesian3.fromDegrees(116.39135, state.placement.latitude, 4) : model.boundingSphere.center;
    const range = overview ? 74 : Math.max(14, model.boundingSphere.radius * 3.1);
    r.viewer.camera.lookAt(target, new C.HeadingPitchRange(overview ? 0 : -.65, overview ? -.43 : -.32, range));
    r.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    // Use the unobscured part of the existing canvas while the product panel is
    // open. This changes the evidence camera only, never the equipment station.
    if (!overview) r.viewer.camera.moveRight(range * .23);
    r.viewer.scene.requestRender();
  }, { id: resources[assetId], overview });
}
async function bodyDetail() {
  await page.evaluate(async id => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), r = window.__managementWorkspace;
    const state = r.ui.getSnapshot().collections.resources.find(item => item.id === id).machinery;
    r.viewer.camera.lookAt(C.Cartesian3.fromDegrees(state.placement.longitude, state.placement.latitude, state.placement.height + 1.8),
      new C.HeadingPitchRange(-.65, -.28, 10));
    r.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY); r.viewer.camera.moveRight(2.3); r.viewer.scene.requestRender();
  }, resources.crane);
  await screenshot('09-crane-body-detail');
}
async function evidence() {
  return page.evaluate(async id => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), runtime = window.__managementWorkspace;
    const p = runtime.machinery, current = p.scene.rendered.get(id), clock = runtime.viewer.clock.currentTime;
    const buffer = await (await fetch(current.url)).arrayBuffer(), view = new DataView(buffer);
    const jsonLength = view.getUint32(12, true), gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
    const primitive = gltf.meshes[0].primitives[0], binary = 20 + jsonLength + 8;
    const attribute = name => { const a = gltf.accessors[primitive.attributes[name]], v = gltf.bufferViews[a.bufferView];
      return new Float32Array(buffer, binary + (v.byteOffset || 0) + (a.byteOffset || 0), a.count * 3); };
    const positions = attribute('POSITION'), colors = attribute('COLOR_0');
    const hash = async array => [...new Uint8Array(await crypto.subtle.digest('SHA-256', array))].map(n => n.toString(16).padStart(2, '0')).join('');
    let model;
    for (const source of runtime.viewer.dataSources._dataSources) for (const visualizer of source._visualizers || []) {
      const entry = visualizer._modelHash?.[current.entity.id];
      if (entry?.url === current.url && entry.modelPrimitive?.ready) model = entry.modelPrimitive;
    }
    if (!model) throw new Error('The current GLB has not been uploaded to the actual Cesium renderer');
    const position = current.entity.position.getValue(clock), q = current.entity.orientation.getValue(clock);
    const inverseEnu = C.Matrix4.inverseTransformation(C.Transforms.eastNorthUpToFixedFrame(position), new C.Matrix4());
    // This is the real renderer matrix including glTF's Y-up axis correction,
    // not a quaternion reconstructed from the input heading.
    const local = C.Matrix4.multiply(inverseEnu, model._sceneGraph.computedModelMatrix, new C.Matrix4());
    const forward = C.Matrix4.multiplyByPointAsVector(local, C.Cartesian3.UNIT_X, new C.Cartesian3());
    const up = C.Matrix4.multiplyByPointAsVector(local, C.Cartesian3.UNIT_Y, new C.Cartesian3());
    const measuredHeadingDeg = ((Math.atan2(forward.x, forward.y) * 180 / Math.PI) % 360 + 360) % 360;
    const colorCounts = new Map(); let vividVertices = 0, darkVertices = 0, paleVertices = 0;
    for (let i = 0; i < colors.length; i += 3) {
      const rgb = Array.from(colors.subarray(i, i + 3)), max = Math.max(...rgb), min = Math.min(...rgb);
      if (max > .45 && max - min > .35) vividVertices++;
      if (max < .15) darkVertices++;
      if (min > .3 && max - min < .25) paleVertices++;
      const key = rgb.map(n => +n.toFixed(5)).join(','); colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    }
    const source = p.asset;
    return { modelId: gltf.extras.modelId, url: current.url, geometryKey: current.geometryKey,
      positionHash: await hash(positions), colorHash: await hash(colors), vertexCount: positions.length / 3,
      sourcePositionHash: await hash(source.sourcePositions), parameters: gltf.extras.parameters,
      placement: [position.x, position.y, position.z], orientation: [q.x, q.y, q.z, q.w],
      measuredHeadingDeg, modelUpEnu: [up.x, up.y, up.z], modelForwardEnu: [forward.x, forward.y, forward.z],
      material: gltf.materials[primitive.material], appearance: gltf.extras.appearance,
      colors: { vividVertices, darkVertices, paleVertices, distinct: colorCounts.size,
        histogram: [...colorCounts].sort((a, b) => b[1] - a[1]).map(([rgb, vertices]) => ({ rgb: rgb.split(',').map(Number), vertices })) },
      camera: ['positionWC', 'directionWC', 'upWC'].map(key => { const v = runtime.viewer.camera[key]; return [v.x, v.y, v.z]; }) };
  }, recordId);
}
function assertHeading(value, expected) {
  const error = Math.abs(((value.measuredHeadingDeg - expected + 540) % 360) - 180);
  assert(error < .0001, `Actual renderer heading ${value.measuredHeadingDeg} differs from ${expected} by ${error}`);
  assert(Math.hypot(value.modelUpEnu[0], value.modelUpEnu[1], value.modelUpEnu[2] - 1) < 1e-7, 'Whole-machine yaw changed model up');
}
function unchangedLocal(actual, before) {
  assert.equal(actual.positionHash, before.positionHash); assert.equal(actual.colorHash, before.colorHash);
  assert.equal(actual.sourcePositionHash, before.sourcePositionHash); assert.equal(actual.url, before.url);
  assert.deepEqual(actual.parameters, before.parameters); assert.deepEqual(actual.placement, before.placement);
}
const sameCamera = (a, b) => a.every((v, i) => v.every((n, k) => Math.abs(n - b[i][k]) < 1e-8));
async function command(type, payload, extra = {}) {
  const response = await context.request.post(origin + '/__management/commands', {
    headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' },
    data: { projectId: 'safety:project', type, payload, idempotencyKey: crypto.randomUUID(), ...extra } });
  return { status: response.status(), body: await response.json() };
}

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const options = process.env.BROWSER_LAUNCH_OPTIONS
    ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined };
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen();
  const address = server.httpServer.address(); assert(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  report.origin = origin; browser = await chromium.launch(options);
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 },
    ...(process.env.MACHINERY_APPEARANCE_RECORD_VIDEO === '1' ? { recordVideo: { dir: output, size: { width: 1600, height: 1000 } } } : {}) });
  page = await context.newPage(); video = page.video(); page.setDefaultTimeout(30000);
  page.on('pageerror', e => report.pageErrors.push({ check: activeCheck?.id, message: e.message }));
  page.on('console', e => { if (e.type() === 'error') report.consoleErrors.push({ check: activeCheck?.id, message: e.text().slice(0, 600) }); });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await ready();
  await page.locator('.tab[data-tab="machinery"]').click(); await panel().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.management-studio:visible').count(), 0);
  await page.locator('#basemap').selectOption('none');
  await page.evaluate(() => { window.__appearanceHeadingViewer = window.__managementWorkspace.viewer; });
  for (const [index, assetId] of ['crane', 'pile', 'excavator'].entries()) await check(assetId + '-appearance-heading', async () => {
    const name = { crane: '红黑吊机 · 整机旋转验收', pile: '红青桩机 · 整机旋转验收', excavator: '明黄挖机 · 整机旋转验收' }[assetId];
    await panel().locator('[data-role="create-name"]').fill(name); await action('create').click();
    await page.waitForFunction(name => window.__managementWorkspace.ui.getSnapshot().collections.resources.some(item => item.name === name)
      && !window.__managementWorkspace.machinery.loading && !window.__managementWorkspace.machinery.busy, name);
    recordId = (await snapshot()).collections.resources.find(item => item.name === name).id; resources[assetId] = recordId;
    await panel().locator('[data-role="asset"]').selectOption(assetId); await panelReady(assetId);
    assert.equal(await panel().locator('[data-role="machine-rotation"]').count(), 1); assert.equal(await heading().count(), 1);
    if (assetId === 'crane') {
      await page.evaluate(() => {
        const input = document.querySelector('.machinery-panel [data-placement="heading"]');
        input.value = '27'; input.dispatchEvent(new Event('input', { bubbles: true }));
        const select = document.querySelector('.machinery-panel [data-role="asset"]');
        select.value = 'pile'; select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await panelReady('pile'); assert.equal(Number(await heading().inputValue()), 27);
      assert.equal(await coordinate('longitude').inputValue(), '', 'Model switch must not create an arbitrary station');
      await panel().locator('[data-role="asset"]').selectOption('crane'); await panelReady('crane');
      assert.equal(Number(await heading().inputValue()), 27, 'Unplaced heading must survive model changes');
    }
    const scale = assetId === 'excavator' ? 1.5 : 4;
    await parameter('overall_scale').fill(String(scale));
    for (const [key, value] of Object.entries({ longitude: 116.391 + index * .00035, latitude: 39.907, height: 0, heading: 0 })) await coordinate(key).fill(String(value));
    await save(); await frame(assetId); const initial = await evidence(); assertHeading(initial, 0);
    assert.equal(initial.appearance.profile, 'construction-vivid/v1');
    assert.equal(initial.appearance.matchedSourceColors, initial.appearance.sourcePaletteSize);
    assert.equal(initial.appearance.sourceArraysModified, false);
    assert(initial.colors.vividVertices > initial.vertexCount * .1, 'Expected substantial vivid machinery paint in the actual GLB');
    assert(initial.colors.darkVertices > 100, 'Dark functional parts should remain distinct from paint');
    assert(initial.colors.distinct >= 3, 'A single uniform tint must not erase mechanical part differentiation');
    await screenshot(`0${index * 2 + 1}-${assetId}-heading-0`);
    await heading().fill('90'); await settled(); const rotated = await evidence(); assertHeading(rotated, 90); unchangedLocal(rotated, initial);
    assert(sameCamera(rotated.camera, initial.camera), 'Rotation must not relocate the scene camera');
    assert.equal((await savedState()).placement.heading, 0, 'Preview must not silently save');
    await screenshot(`0${index * 2 + 2}-${assetId}-heading-90`); await save(); savedById[recordId] = await savedState();
    return { recordId, before: initial, after: rotated, persistedHeading: 90, sameCamera: true };
  });
  await check('three-model-overview', async () => {
    await action('close').click(); await frame('pile', true); await screenshot('07-three-machines-overview');
    const state = await page.evaluate(() => { const r = window.__managementWorkspace; return { models: [...r.machinery.scene.rendered.keys()],
      sources: r.viewer.dataSources._dataSources.filter(s => s.name === '施工机械').length }; });
    assert.deepEqual(state.models.sort(), Object.values(resources).sort()); assert.equal(state.sources, 1); return state;
  });
  await check('asset-switch-heading', async () => {
    await select('crane'); const before = await evidence();
    await page.evaluate(() => {
      const input = document.querySelector('.machinery-panel [data-placement="heading"]');
      input.value = '47'; input.dispatchEvent(new Event('input', { bubbles: true }));
      const select = document.querySelector('.machinery-panel [data-role="asset"]');
      select.value = 'pile'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await panelReady('pile'); await settled(); const changed = await evidence();
    assert.equal(changed.modelId, 'pile'); assertHeading(changed, 47);
    assert.deepEqual(changed.placement, before.placement); assert.equal(Number(await heading().inputValue()), 47);
    await action('cancel').click(); await panelReady('crane'); await settled(); const restored = await evidence();
    assert.equal(restored.modelId, 'crane'); assertHeading(restored, 90);
    assert.equal(restored.positionHash, before.positionHash); assert.equal((await savedState()).assetId, 'crane');
    return { unsavedHeadingRetained: 47, stationUnchanged: true, cancelledAssetType: 'pile', restoredAssetType: 'crane', restoredHeading: 90 };
  });
  await check('combined-crane-pose', async () => {
    await select('crane'); await panel().locator('[data-role="proportional"]').uncheck();
    const length = Number(await parameter('boom_length_m').inputValue());
    await parameter('boom_length_m').fill(String(length * 1.2)); await settled();
    await parameter('boom_rotation_deg').fill('75'); await settled();
    await parameter('boom_elevation_deg').fill('30'); await settled();
    const before = await evidence();
    await heading().fill('210'); await settled(); const after = await evidence(); assertHeading(after, 210); unchangedLocal(after, before);
    assert.equal(after.parameters.boom_rotation_deg, 75); assert.equal(after.parameters.boom_elevation_deg, 30);
    assert(Math.abs(after.parameters.boom_length_m - length * 1.2) < 1e-8);
    await save(); await frame('crane'); await screenshot('08-crane-combined-pose'); await bodyDetail();
    return { before, after };
  });
  await check('rotation-controls', async () => {
    const steps = [];
    async function expect(expected, name) { await settled(); const current = await evidence(); assertHeading(current, expected);
      assert.equal(Number(await heading().inputValue()), expected); assert(Math.abs(Number(await slider().inputValue()) - expected) <= .5, 'Slider should track the numerical angle within its declared 1° step');
      steps.push({ name, expected, measured: current.measuredHeadingDeg }); }
    await heading().fill('350'); await settled(); await action('rotate-machine-right').click(); await expect(5, '350 + 15 wraps to 5');
    await action('rotate-machine-left').click(); await expect(350, '5 - 15 wraps to 350');
    await heading().fill('360'); await expect(0, '360 normalizes to 0');
    await slider().focus(); await slider().press('Home'); for (let i = 0; i < 27; i++) await slider().press('ArrowRight', { delay: 0 });
    await expect(27, 'rapid real slider keyboard input');
    await slider().press('End'); await expect(0, 'slider endpoint normalizes 360 to 0');
    await action('rotate-machine-left').click(); await expect(345, 'zero counterclockwise wraps to 345');
    await action('reset-machine-rotation').click(); await expect(0, 'reset model reference direction');
    await heading().fill('123.5'); await expect(123.5, 'fractional numeric heading'); await save();
    return { steps, storedHeading: (await savedState()).placement.heading };
  });
  let persisted, persistedGeometry;
  await check('save-reload', async () => {
    persisted = await savedState(); persistedGeometry = await evidence();
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(); await select('crane');
    const after = await evidence(); assertHeading(after, 123.5);
    assert.deepEqual(await savedState(), persisted); assert.equal(after.positionHash, persistedGeometry.positionHash); assert.equal(after.colorHash, persistedGeometry.colorHash);
    assert.deepEqual(after.parameters, persistedGeometry.parameters); assert.deepEqual(after.placement, persistedGeometry.placement);
    for (const id of [resources.pile, resources.excavator]) assert.deepEqual((await snapshot()).collections.resources.find(item => item.id === id).machinery, savedById[id]);
    await page.evaluate(() => { window.__appearanceHeadingViewer = window.__managementWorkspace.viewer; });
    await page.locator('#basemap').selectOption('none'); await frame('crane');
    return { savedState: persisted, positionHash: after.positionHash, colorHash: after.colorHash, otherMachinesUnchanged: true };
  });
  await check('cancel', async () => {
    await heading().fill('280'); await settled(); assertHeading(await evidence(), 280);
    await action('cancel').click(); await panelReady('crane'); await settled(); assertHeading(await evidence(), 123.5);
    await page.evaluate(() => { const input = document.querySelector('.machinery-panel [data-placement="heading"]');
      input.value = '42'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.machinery-panel [data-action="cancel"]').click(); });
    await panelReady('crane'); await page.waitForTimeout(300); await settled(); const restored = await evidence(); assertHeading(restored, 123.5);
    assert.equal(restored.positionHash, persistedGeometry.positionHash); assert.deepEqual(await savedState(), persisted);
    return { previewCancelled: 280, immediateDraftCancelled: 42, restoredMeasuredHeading: restored.measuredHeadingDeg, sourceStateUnchanged: true };
  });
  await check('dimension-reset', async () => {
    await page.evaluate(() => { const input = document.querySelector('.machinery-panel [data-placement="heading"]');
      input.value = '215'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.machinery-panel [data-action="reset"]').click(); });
    await settled(); const value = await evidence(); assertHeading(value, 215);
    assert.equal(value.parameters.overall_scale, 1); assert.equal(value.parameters.boom_rotation_deg, 75); assert.equal(value.parameters.boom_elevation_deg, 30);
    assert.deepEqual(value.placement, persistedGeometry.placement);
    await action('cancel').click(); await panelReady('crane'); await settled(); assertHeading(await evidence(), 123.5);
    return { pendingHeadingRetained: 215, parametersAfterDimensionReset: value.parameters, storedStateUnchanged: true };
  });
  await check('read-only', async () => {
    const password = 'Isolated-Heading-' + crypto.randomUUID();
    const owner = await command('member.save', { username: 'heading-owner', displayName: '机械旋转验收管理员', password, roles: ['owner'] });
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    const member = await command('member.save', { username: 'heading-reader', displayName: '机械旋转只读验收', password, roles: ['viewer'],
      resourceAccess: { models: true, files: false, media: false } });
    assert.equal(member.status, 200, JSON.stringify(member.body));
    const logout = await context.request.delete(origin + '/__management/session', { headers: { 'X-Cesium-Library': '1' } }); assert.equal(logout.status(), 200);
    const login = await context.request.post(origin + '/__management/session', { headers: { 'X-Cesium-Library': '1' }, data: { username: 'heading-reader', password } });
    assert.equal(login.status(), 200, await login.text());
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(); await select('crane');
    assert.equal(await heading().isDisabled(), true); assert.equal(await slider().isDisabled(), true);
    for (const name of ['rotate-machine-left', 'rotate-machine-right', 'reset-machine-rotation', 'save']) assert.equal(await action(name).isDisabled(), true);
    const before = await savedState(), record = (await snapshot()).collections.resources.find(item => item.id === recordId);
    const rejected = await command('machinery.save', { machinery: { ...before, placement: { ...before.placement, heading: 12 } } }, { id: recordId, expectedRevision: record.revision });
    assert.equal(rejected.status, 403, JSON.stringify(rejected.body)); assert.deepEqual(await savedState(), before);
    assertHeading(await evidence(), 123.5);
    await page.evaluate(() => { window.__appearanceHeadingViewer = window.__managementWorkspace.viewer; });
    return { accountRole: 'viewer with model read permission', disabledControls: ['numeric', 'slider', 'left', 'right', 'reset', 'save'], rejectedSaveStatus: rejected.status, heading: before.placement.heading };
  });
  await check('single-runtime', async () => {
    const identity = await page.evaluate(() => { const r = window.__managementWorkspace; return { sameViewer: r.viewer === window.__appearanceHeadingViewer,
      safetySameViewer: window.__safetyWorkspace.getManagementViewer() === r.viewer,
      sources: r.viewer.dataSources._dataSources.filter(s => s.name === '施工机械').length,
      renderLoop: r.viewer.useDefaultRenderLoop, models: r.machinery.scene.rendered.size }; });
    assert.deepEqual(identity, { sameViewer: true, safetySameViewer: true, sources: 1, renderLoop: true, models: 3 });
    assert.equal(await page.locator('#cesiumContainer canvas').count(), 1); assert.equal(await page.locator('.machinery-panel').count(), 1);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); return identity;
  });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1;
  if (activeCheck?.status === 'running') { activeCheck.status = 'failed'; activeCheck.error = report.failure; }
  for (const item of report.checks) if (item.status === 'pending') { item.status = 'skipped'; item.reason = 'Earlier failure; no pass claim'; }
  console.error(error);
  if (page) { await screenshot('failure').catch(() => {}); report.failureVisibleText = (await page.locator('body').innerText().catch(() => '')).slice(-4000); }
} finally {
  await context?.close();
  if (video) { const path = resolve(output, 'machinery-appearance-heading-actual-operation.webm'); await video.saveAs(path); report.videos.push(path); }
  report.finishedAt = new Date().toISOString(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server?.close();
}
