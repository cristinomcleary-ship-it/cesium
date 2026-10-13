/**
 * Focused acceptance of crane slewing in the original Cesium workbench.
 * Uses an isolated database, the shipped crane mesh and actual product controls.
 * Start Vite and Chromium together (some hosts isolate network per exec session).
 *
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/absolute/path/to/launch_options.mjs \
 * node tools/verify-crane-rotation.mjs
 * Set CRANE_ROTATION_RECORD_VIDEO=1 when Playwright's ffmpeg is installed.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.CRANE_ROTATION_VERIFY_OUT || 'output/crane-rotation');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/crane-rotation-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const definitions = [
  ['root-crane', 'Create a crane through the original workbench machinery module'],
  ['rotation-preview', '0° to 90° changes actual model vertices while chassis, outriggers and placement stay fixed'],
  ['save-reload', 'Saved angle and exact model geometry survive reloading the original root route'],
  ['cancel', 'Cancelling an angle draft restores saved geometry'],
  ['dimensions', 'Independent boom length and linked whole-machine scale preserve angle'],
  ['rapid-slider', 'Rapid actual slider keyboard input renders the final angle and handles 360° wrap'],
  ['reset', 'Angle reset preserves dimensions; original-dimension reset preserves angle'],
  ['single-runtime', 'One original Cesium Viewer renders without uncaught errors'],
];
const report = {
  classification: 'actual-original-workbench-crane-rotation-with-isolated-test-data',
  renderer: 'Real Chromium WebGL2; software renderer when supplied launch options select SwiftShader',
  startedAt: new Date().toISOString(), dataDir,
  checks: definitions.map(([id, title]) => ({ id, title, status: 'pending' })),
  screenshots: [], videos: [], pageErrors: [], consoleErrors: [],
};
let server, browser, context, page, activeCheck, recordId, video;
const panel = () => page.locator('.machinery-panel');
const action = name => panel().locator(`[data-action="${name}"]`);
const field = key => panel().locator(`[data-parameter="${key}"]`);
const angle = () => field('boom_rotation_deg');
const slider = () => panel().locator('[data-role="boom-rotation-slider"]');
const coordinate = key => panel().locator(`[data-placement="${key}"]`);
async function check(id, run) {
  activeCheck = report.checks.find(item => item.id === id); activeCheck.status = 'running';
  activeCheck.startedAt = new Date().toISOString(); console.log('RUN', id);
  activeCheck.evidence = await run(); activeCheck.status = 'passed';
  activeCheck.finishedAt = new Date().toISOString(); console.log('PASS', id);
}
async function ready() {
  await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId,
    undefined, { timeout: 60000 });
}
async function panelReady() {
  await panel().waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const panel = window.__managementWorkspace.machinery;
    return panel.asset?.id === 'crane' && !panel.loading && !panel.busy;
  }, undefined, { timeout: 30000 });
}
async function settled(expectedAngle) {
  await page.waitForFunction(({ id, expectedAngle }) => {
    const panel = window.__managementWorkspace.machinery, scene = panel.scene;
    const model = scene.rendered.get(id);
    return !panel.loading && !panel.busy && panel.previewTimer === undefined
      && !scene.tasks.has(id) && model && !scene.getError(id)
      && (expectedAngle === undefined || JSON.parse(model.geometryKey)[3].some(([key, value]) => key === 'boom_rotation_deg' && value === expectedAngle));
  }, { id: recordId, expectedAngle }, { timeout: 30000 });
  // Await the actual Cesium model upload before taking visual evidence.
  await page.waitForFunction(id => {
    const panel = window.__managementWorkspace.machinery, viewer = window.__managementWorkspace.viewer;
    const entity = panel.scene.rendered.get(id)?.entity;
    for (const visualizer of viewer.dataSourceDisplay._visualizers || []) {
      if (visualizer._modelHash?.[entity?.id]?.modelPrimitive?.ready) return true;
    }
    for (const source of viewer.dataSources._dataSources) for (const visualizer of source._visualizers || []) {
      if (visualizer._modelHash?.[entity?.id]?.modelPrimitive?.ready) return true;
    }
    return false;
  }, recordId, { timeout: 30000 });
}
async function snapshot() { return page.evaluate(() => window.__managementWorkspace.ui.getSnapshot()); }
async function savedState() { return (await snapshot()).collections.resources.find(item => item.id === recordId).machinery; }
async function save() {
  const response = page.waitForResponse(response => {
    if (!response.url().endsWith('/__management/commands')) return false;
    try { return response.request().postDataJSON()?.type === 'machinery.save'; } catch { return false; }
  });
  await action('save').click(); const result = await response;
  assert.equal(result.status(), 200, await result.text());
  await page.waitForFunction(() => !window.__managementWorkspace.machinery.busy && !window.__managementWorkspace.machinery.hasDraft);
}
async function screenshot(name) {
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(output, name + '.png'); await page.screenshot({ path, timeout: 20000 }); report.screenshots.push(path);
}
async function geometry(label, compareLabel) {
  // Decode the very blob URL referenced by the Cesium entity. Observations do not
  // modify the product's parameters, scene object, persisted record or mesh.
  return page.evaluate(async ({ id, label, compareLabel }) => {
    const runtime = window.__managementWorkspace, panel = runtime.machinery, scene = panel.scene;
    const current = scene.rendered.get(id);
    const buffer = await (await fetch(current.url)).arrayBuffer(), view = new DataView(buffer);
    const jsonLength = view.getUint32(12, true), json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
    const accessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    const sourceView = json.bufferViews[accessor.bufferView], binary = 20 + jsonLength + 8;
    const positions = new Float32Array(buffer, binary + (sourceView.byteOffset || 0) + (accessor.byteOffset || 0), accessor.count * 3);
    const digest = async array => [...new Uint8Array(await crypto.subtle.digest('SHA-256', array))].map(value => value.toString(16).padStart(2, '0')).join('');
    const entityPosition = current.entity.position.getValue(runtime.viewer.clock.currentTime), orientation = current.entity.orientation.getValue(runtime.viewer.clock.currentTime);
    const asset = panel.asset, engine = await import('/src/machinery/index.ts');
    const expected = new Float32Array(engine.computeMachineryGeometry(asset, json.extras.parameters).positions);
    const actualByIndex = new Map(); let cursor = 0, maxExportError = 0;
    for (let face = 0; face < asset.indices.length / 3; face++) {
      const index = [asset.indices[face * 3], asset.indices[face * 3 + 1], asset.indices[face * 3 + 2]];
      const [a, b, c] = index.map(i => i * 3);
      const ab = [expected[b] - expected[a], expected[b + 1] - expected[a + 1], expected[b + 2] - expected[a + 2]];
      const ac = [expected[c] - expected[a], expected[c + 1] - expected[a + 1], expected[c + 2] - expected[a + 2]];
      if (Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) === 0) continue;
      for (const vertex of index) {
        const actual = Array.from(positions.subarray(cursor, cursor + 3));
        for (let axis = 0; axis < 3; axis++) maxExportError = Math.max(maxExportError, Math.abs(actual[axis] - expected[vertex * 3 + axis]));
        actualByIndex.set(vertex, actual); cursor += 3;
      }
    }
    const value = {
      positionsHash: await digest(positions), positionValues: positions.length, parameters: json.extras.parameters,
      placement: [entityPosition.x, entityPosition.y, entityPosition.z], orientation: [orientation.x, orientation.y, orientation.z, orientation.w],
      maxExportError, mappedPositionValues: cursor, exportedVertices: actualByIndex.size,
    };
    window.__craneRotationEvidence ||= {};
    const baseline = window.__craneRotationEvidence[compareLabel];
    if (baseline) {
      let fixedCompared = 0, movingCompared = 0, fixedMaxDelta = 0, movingMaxDelta = 0;
      // The rotation manifest identifies upper cab, base boom and hydraulics
      // separately from the extension part IDs used by the existing mesh.
      const moving = new Set();
      for (const [start, count] of asset.config.rotation.vertex_ranges) for (let index = start; index < start + count; index++) moving.add(index);
      for (const [index, actual] of actualByIndex) {
        const before = baseline.actualByIndex.get(index); if (!before) continue;
        const delta = Math.hypot(...actual.map((value, axis) => value - before[axis]));
        const fixed = !moving.has(index);
        if (fixed) { fixedCompared++; fixedMaxDelta = Math.max(fixedMaxDelta, delta); }
        else { movingCompared++; movingMaxDelta = Math.max(movingMaxDelta, delta); }
      }
      value.comparison = { fixedCompared, movingCompared, fixedMaxDelta, movingMaxDelta };
    }
    window.__craneRotationEvidence[label] = { actualByIndex, ...value };
    return value;
  }, { id: recordId, label, compareLabel });
}
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const launchOptions = process.env.BROWSER_LAUNCH_OPTIONS
    ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined };
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen();
  const address = server.httpServer.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`; report.origin = origin;
  browser = await chromium.launch(launchOptions);
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 },
    ...(process.env.CRANE_ROTATION_RECORD_VIDEO === '1' ? { recordVideo: { dir: output, size: { width: 1600, height: 1000 } } } : {}) });
  page = await context.newPage(); video = page.video(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push({ check: activeCheck?.id, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ check: activeCheck?.id, message: message.text().slice(0, 600) }); });
  let baseline, rotated;
  await check('root-crane', async () => {
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await ready();
    await page.locator('.tab[data-tab="machinery"]').click(); await panel().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.management-studio:visible').count(), 0);
    const name = '吊臂回转验收-' + Date.now();
    await panel().locator('[data-role="create-name"]').fill(name); await action('create').click();
    await page.waitForFunction(name => window.__managementWorkspace.ui.getSnapshot().collections.resources.some(item => item.name === name)
      && !window.__managementWorkspace.machinery.busy && !window.__managementWorkspace.machinery.loading, name);
    recordId = (await snapshot()).collections.resources.find(item => item.name === name).id; report.resourceId = recordId;
    await panel().locator('[data-role="asset"]').selectOption('crane'); await panelReady();
    await field('overall_scale').fill('5');
    for (const [key, value] of Object.entries({ longitude: 116.391, latitude: 39.907, height: 0, heading: 35 })) await coordinate(key).fill(String(value));
    await save(); await settled(0);
    await page.locator('#basemap').selectOption('none');
    await page.evaluate(async id => {
      const C = await import('/node_modules/.vite/deps/cesium.js'), runtime = window.__managementWorkspace;
      const state = runtime.ui.getSnapshot().collections.resources.find(item => item.id === id).machinery;
      runtime.viewer.camera.lookAt(C.Cartesian3.fromDegrees(state.placement.longitude, state.placement.latitude, 6), new C.HeadingPitchRange(-.7, -.38, 40));
      runtime.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY); runtime.viewer.scene.requestRender();
      window.__craneRotationViewer = runtime.viewer;
    }, recordId);
    baseline = await geometry('zero'); assert.equal(baseline.maxExportError, 0); assert.equal(baseline.mappedPositionValues, baseline.positionValues);
    await panel().locator('.mp-content').evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(500); await screenshot('01-crane-rotation-0');
    return { url: page.url(), recordId, geometry: baseline };
  });
  await check('rotation-preview', async () => {
    await angle().fill('90'); await settled(90);
    rotated = await geometry('ninety', 'zero'); assert.equal(rotated.maxExportError, 0);
    assert.equal(rotated.mappedPositionValues, rotated.positionValues);
    assert.notEqual(rotated.positionsHash, baseline.positionsHash);
    assert.deepEqual(rotated.placement, baseline.placement); assert.deepEqual(rotated.orientation, baseline.orientation);
    assert(rotated.comparison.fixedCompared > 1000); assert.equal(rotated.comparison.fixedMaxDelta, 0);
    assert(rotated.comparison.movingCompared > 1000); assert(rotated.comparison.movingMaxDelta > 1);
    assert.equal((await savedState()).parameters.boom_rotation_deg, 0, 'Preview must not silently save');
    await panel().locator('.mp-content').evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(500); await screenshot('02-crane-rotation-90');
    return rotated;
  });
  await check('save-reload', async () => {
    await save(); const before = await savedState(); assert.equal(before.parameters.boom_rotation_deg, 90);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await page.locator(`[data-machinery-record="${recordId}"] [data-machinery-action="edit"]`).click(); await panelReady(); await settled(90);
    assert.deepEqual(await savedState(), before); assert.equal(Number(await angle().inputValue()), 90);
    const after = await geometry('savedNinety'); assert.equal(after.positionsHash, rotated.positionsHash);
    // A fresh page gets a fresh Viewer; the identity check below compares the
    // module against this page's original Viewer, not the previous document.
    await page.evaluate(() => { window.__craneRotationViewer = window.__managementWorkspace.viewer; });
    await action('locate').click(); await page.waitForTimeout(1200);
    return { persistedState: before, geometryHashAfterReload: after.positionsHash };
  });
  await check('cancel', async () => {
    await angle().fill('180'); await settled(180); const draft = await geometry('cancelDraft');
    assert.notEqual(draft.positionsHash, rotated.positionsHash);
    await action('cancel').click(); await panelReady(); await settled(90);
    assert.equal(Number(await angle().inputValue()), 90);
    const restored = await geometry('cancelRestored'); assert.equal(restored.positionsHash, rotated.positionsHash);
    // A second edit is cancelled in the same browser task, before the 220 ms
    // preview debounce can run. Dispatch the real input/cancel controls; never
    // call controller methods or manipulate its draft directly.
    await page.evaluate(() => {
      const input = document.querySelector('.machinery-panel [data-parameter="boom_rotation_deg"]');
      input.value = '270'; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.machinery-panel [data-action="cancel"]').click();
    });
    await panelReady(); await page.waitForTimeout(350); await settled(90);
    const immediate = await geometry('immediateCancelRestored'); assert.equal(immediate.positionsHash, rotated.positionsHash);
    assert.equal(Number(await angle().inputValue()), 90);
    return { rejectedAngle: 180, restoredAngle: 90, restoredHash: restored.positionsHash,
      immediateCancelDraftAngle: 270, immediateCancelRestoredHash: immediate.positionsHash };
  });
  await check('dimensions', async () => {
    await panel().locator('[data-role="proportional"]').uncheck();
    const oldLength = Number(await field('boom_length_m').inputValue());
    await field('boom_length_m').fill(String(oldLength * 1.2)); await settled(90);
    assert.equal(Number(await angle().inputValue()), 90); assert.equal(Number(await field('overall_scale').inputValue()), 5);
    await field('overall_scale').fill('6'); await settled(90);
    assert.equal(Number(await angle().inputValue()), 90);
    const enlargedLength = Number(await field('boom_length_m').inputValue()); assert(Math.abs(enlargedLength - oldLength * 1.44) < 1e-8);
    await save(); const enlarged = await geometry('enlargedNinety');
    await angle().fill('180'); await settled(180); const changed = await geometry('enlarged180', 'enlargedNinety');
    assert.equal(changed.comparison.fixedMaxDelta, 0); assert(changed.comparison.movingMaxDelta > 1);
    assert.deepEqual(changed.placement, enlarged.placement); assert.deepEqual(changed.orientation, enlarged.orientation);
    await action('cancel').click(); await panelReady(); await settled(90);
    return { originalLength: oldLength, editedLength: enlargedLength, scale: 6, angle: 90, rotationAtChangedDimensions: changed.comparison };
  });
  await check('rapid-slider', async () => {
    await slider().focus(); await slider().press('Home');
    for (let i = 0; i < 18; i++) await slider().press('ArrowRight', { delay: 0 });
    const finalAngle = Number(await slider().inputValue()); await settled(finalAngle);
    assert.equal(Number(await angle().inputValue()), finalAngle);
    const last = await geometry('rapidFinal'); assert.equal(last.parameters.boom_rotation_deg, finalAngle);
    await angle().fill('360'); await settled(0); assert.equal(Number(await angle().inputValue()), 0); assert.equal(Number(await slider().inputValue()), 0);
    await save(); assert.equal((await savedState()).parameters.boom_rotation_deg, 0);
    return { keyboardEvents: 19, finalSliderAngle: finalAngle, actualGeometryAngle: last.parameters.boom_rotation_deg, wrappedAngle: 0 };
  });
  await check('reset', async () => {
    const dimensionsBefore = (await savedState()).parameters;
    await angle().fill('75'); await settled(75); await action('reset-boom-rotation').click(); await settled(0);
    const zero = await geometry('angleReset');
    for (const [key, value] of Object.entries(dimensionsBefore)) if (key !== 'boom_rotation_deg') assert.equal(zero.parameters[key], value);
    await angle().fill('75'); await settled(75); await action('reset').click(); await settled(75);
    assert.equal(Number(await angle().inputValue()), 75); assert.equal(Number(await field('overall_scale').inputValue()), 1);
    await action('cancel').click(); await panelReady(); await settled(0);
    return { angleResetPreservesDimensions: true, originalDimensionResetPreservesAngle: 75, cancelledDraftRestoresSavedScale: Number(await field('overall_scale').inputValue()) };
  });
  await check('single-runtime', async () => {
    const identity = await page.evaluate(() => {
      const runtime = window.__managementWorkspace;
      return { sameViewer: runtime.viewer === window.__craneRotationViewer,
        safetySameViewer: window.__safetyWorkspace.getManagementViewer() === runtime.viewer,
        sourceCount: runtime.viewer.dataSources._dataSources.filter(source => source.name === '施工机械').length,
        renderLoop: runtime.viewer.useDefaultRenderLoop, recordCount: runtime.machinery.scene.rendered.size };
    });
    assert.deepEqual(identity, { sameViewer: true, safetySameViewer: true, sourceCount: 1, renderLoop: true, recordCount: 1 });
    assert.equal(await page.locator('#cesiumContainer canvas').count(), 1); assert.equal(await page.locator('.machinery-panel').count(), 1);
    assert.deepEqual(report.pageErrors, []); return identity;
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
  if (video) { const path = resolve(output, 'crane-rotation-actual-operation.webm'); await video.saveAs(path); report.videos.push(path); }
  report.finishedAt = new Date().toISOString(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server?.close();
}
