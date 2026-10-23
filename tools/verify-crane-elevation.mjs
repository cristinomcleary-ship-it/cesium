/**
 * Focused acceptance of crane boom elevation in the original Cesium workbench.
 * Uses an isolated database, the shipped crane mesh and actual product controls.
 * Start Vite and Chromium together (some hosts isolate network per exec session).
 *
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/absolute/path/to/launch_options.mjs \
 * node tools/verify-crane-elevation.mjs
 * Set CRANE_ELEVATION_RECORD_VIDEO=1 when Playwright's ffmpeg is installed.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.CRANE_ELEVATION_VERIFY_OUT || 'output/crane-elevation');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/crane-elevation-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const definitions = [
  ['source-default', 'Original crane shape and source elevation remain unchanged by default'],
  ['elevation-30', 'Actual boom geometry reaches 30° while cab, chassis and station remain fixed'],
  ['elevation-60', 'Actual boom geometry reaches 60° with vertical hook and updated actual height'],
  ['save-reload', 'Saved elevation and exact mesh survive root reload'],
  ['cancel', 'Cancelling after preview and before debounce restores exact saved mesh'],
  ['combined-pose', 'Boom length, elevation, slewing and overall scale combine without losing angles'],
  ['height-reset', 'Height editing is accurate and restoring dimensions retains both angles'],
  ['slider-bounds', 'Actual slider stays within 0°..90° and final rapid input is rendered'],
  ['single-runtime', 'Original Viewer stays unique and produces no uncaught browser errors'],
];
const report = {
  classification: 'actual-original-workbench-crane-elevation-with-isolated-test-data',
  renderer: 'Real Chromium WebGL2; software renderer when supplied launch options select SwiftShader',
  startedAt: new Date().toISOString(), dataDir,
  checks: definitions.map(([id, title]) => ({ id, title, status: 'pending' })),
  screenshots: [], videos: [], pageErrors: [], consoleErrors: [],
};
let server, browser, context, page, activeCheck, recordId, video;
const panel = () => page.locator('.machinery-panel');
const action = name => panel().locator(`[data-action="${name}"]`);
const field = key => panel().locator(`[data-parameter="${key}"]`);
const angle = () => field('boom_elevation_deg');
const slider = () => panel().locator('[data-role="boom-elevation-slider"]');
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
      && (expectedAngle === undefined || JSON.parse(model.geometryKey)[3].some(([key, value]) => key === 'boom_elevation_deg' && value === expectedAngle));
  }, { id: recordId, expectedAngle }, { timeout: 30000 });
  // Await the actual Cesium model upload before taking visual evidence.
  await page.waitForFunction(id => {
    const panel = window.__managementWorkspace.machinery, viewer = window.__managementWorkspace.viewer;
    const rendered = panel.scene.rendered.get(id), entity = rendered?.entity;
    const ready = visualizer => { const data = visualizer._modelHash?.[entity?.id]; return data?.url === rendered?.url && data?.modelPrimitive?.ready; };
    for (const visualizer of viewer.dataSourceDisplay._visualizers || []) {
      if (ready(visualizer)) return true;
    }
    for (const source of viewer.dataSources._dataSources) for (const visualizer of source._visualizers || []) {
      if (ready(visualizer)) return true;
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
    const sourcePoint = index => Array.from(asset.sourcePositions.subarray(index * 3, index * 3 + 3));
    const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
    const delta = (a, b) => a.map((value, axis) => value - b[axis]);
    // Two source telescopic-edge vertices have been measured parallel to the
    // crane's centreline. Source vertex order is immutable in the shipped asset.
    // The actual angle below comes directly from the currently rendered GLB.
    const indices = [37347, 40508], sourceDirection = delta(sourcePoint(indices[1]), sourcePoint(indices[0]));
    const projection = dot(sourceDirection, asset.config.boom.axis);
    const sourceParallelError = Math.hypot(...sourceDirection.map((number, axis) => number - projection * asset.config.boom.axis[axis])) / Math.abs(projection);
    if (sourceParallelError > .000001) throw new Error('Source boom measurement vertices no longer identify the original parallel edge');
    const axisPair = { indices, sourceParallelError };
    const direction = delta(actualByIndex.get(indices[1]), actualByIndex.get(indices[0]));
    value.measuredElevationDeg = Math.atan2(direction[1], Math.hypot(direction[0], direction[2])) * 180 / Math.PI;
    const originalElevation = asset.config.parameters.find(item => item.key === 'boom_elevation_deg').original;
    const reference = engine.computeMachineryGeometry(asset, { ...value.parameters, boom_elevation_deg: originalElevation, boom_rotation_deg: 0 }).positions;
    const slew = value.parameters.boom_rotation_deg * Math.PI / 180;
    value.angleMeasurement = axisPair;
    const config = asset.config.elevation, anchor = asset.config.reference_dimensions.anchor_m, scale = value.parameters.overall_scale;
    const slewPivot = asset.config.rotation.pivot_m.map((number, axis) => (number - anchor[axis]) * scale);
    const slewPoint = point => {
      const x = point[0] - slewPivot[0], z = point[2] - slewPivot[2];
      return [slewPivot[0] + x * Math.cos(slew) - z * Math.sin(slew), point[1], slewPivot[2] + x * Math.sin(slew) + z * Math.cos(slew)];
    };
    let firstHangingDelta, hangingVertices = 0, hangingRigidTranslationErrorM = 0;
    for (const [start, count] of config.hanging_vertex_ranges) for (let index = start; index < start + count; index++) {
      const actual = actualByIndex.get(index); if (!actual) continue;
      const before = slewPoint(Array.from(reference.subarray(index * 3, index * 3 + 3)));
      const moved = delta(actual, before); firstHangingDelta ||= moved;
      hangingRigidTranslationErrorM = Math.max(hangingRigidTranslationErrorM, Math.hypot(...delta(moved, firstHangingDelta))); hangingVertices++;
    }
    value.hanging = { verticesCompared: hangingVertices, rigidTranslationErrorM: hangingRigidTranslationErrorM,
      meaning: 'Hanging hook/block preserves its original upright orientation after pitch; yaw and scale are accounted for' };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const pitchPoint = point => {
      const vector = delta(point, config.hinge_m), radians = (value.parameters.boom_elevation_deg - originalElevation) * Math.PI / 180;
      const perpendicular = cross(config.axis, vector), projection = dot(config.axis, vector);
      return vector.map((v, axis) => config.hinge_m[axis] + v * Math.cos(radians) + perpendicular[axis] * Math.sin(radians) + config.axis[axis] * projection * (1 - Math.cos(radians)));
    };
    const scenePoint = point => slewPoint(point.map((number, axis) => (number - anchor[axis]) * scale));
    value.hydraulics = config.hydraulics.map(cylinder => {
      const base = scenePoint(cylinder.base_m), top = scenePoint(pitchPoint(cylinder.attachment_m));
      let barrelCompared = 0, rodCompared = 0, barrelRigidityErrorM = 0, rodRigidityErrorM = 0;
      for (const [ranges, originalAnchor, actualAnchor, isBarrel] of [
        [cylinder.barrel_vertex_ranges, cylinder.base_m, base, true],
        [cylinder.rod_vertex_ranges, cylinder.attachment_m, top, false],
      ]) for (const [start, count] of ranges) for (let index = start; index < start + count; index++) {
        const actual = actualByIndex.get(index); if (!actual) continue;
        const expectedRadius = Math.hypot(...delta(sourcePoint(index), originalAnchor)) * scale;
        const error = Math.abs(Math.hypot(...delta(actual, actualAnchor)) - expectedRadius);
        if (isBarrel) { barrelCompared++; barrelRigidityErrorM = Math.max(barrelRigidityErrorM, error); }
        else { rodCompared++; rodRigidityErrorM = Math.max(rodRigidityErrorM, error); }
      }
      return { fixedBase: base, movingUpperPin: top, pinDistanceM: Math.hypot(...delta(top, base)), barrelCompared, rodCompared, barrelRigidityErrorM, rodRigidityErrorM };
    });
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < positions.length; i += 3) { minY = Math.min(minY, positions[i]); maxY = Math.max(maxY, positions[i]); }
    value.actualHeightM = maxY - minY;
    value.lowestModelYM = minY;
    value.heightErrorM = Math.abs(value.actualHeightM - value.parameters.overall_height_m);
    value.camera = ['positionWC', 'directionWC', 'upWC'].map(key => { const vector = runtime.viewer.camera[key]; return [vector.x, vector.y, vector.z]; });
    let sourceDefaultMaxError = 0;
    for (const [index, actual] of actualByIndex) for (let axis = 0; axis < 3; axis++) {
      const anchorValue = asset.config.reference_dimensions.anchor_m[axis];
      const original = Math.fround(anchorValue + (asset.sourcePositions[index * 3 + axis] - anchorValue) * value.parameters.overall_scale - anchorValue);
      sourceDefaultMaxError = Math.max(sourceDefaultMaxError, Math.abs(actual[axis] - original));
    }
    value.sourceDefaultMaxError = sourceDefaultMaxError;
    window.__craneElevationEvidence ||= {};
    const baseline = window.__craneElevationEvidence[compareLabel];
    if (baseline) {
      let fixedCompared = 0, movingCompared = 0, fixedMaxDelta = 0, movingMaxDelta = 0;
      // Upper cab and slew counterweight remain fixed during elevation. Only
      // articulated boom, hanging assembly, rigging and hydraulic parts move.
      const moving = new Set();
      const ranges = [...config.boom_vertex_ranges, ...config.hanging_vertex_ranges, ...config.rigging_vertex_ranges,
        ...config.hydraulics.flatMap(cylinder => [...cylinder.barrel_vertex_ranges, ...cylinder.rod_vertex_ranges])];
      for (const [start, count] of ranges) for (let index = start; index < start + count; index++) moving.add(index);
      for (const index of [...config.rope_upper_vertex_indices, ...config.rope_lower_vertex_indices]) moving.add(index);
      for (const index of config.rigging_fixed_vertex_indices) moving.delete(index);
      for (const [index, actual] of actualByIndex) {
        const before = baseline.actualByIndex.get(index); if (!before) continue;
        const delta = Math.hypot(...actual.map((value, axis) => value - before[axis]));
        const fixed = !moving.has(index);
        if (fixed) { fixedCompared++; fixedMaxDelta = Math.max(fixedMaxDelta, delta); }
        else { movingCompared++; movingMaxDelta = Math.max(movingMaxDelta, delta); }
      }
      value.comparison = { fixedCompared, movingCompared, fixedMaxDelta, movingMaxDelta };
    }
    window.__craneElevationEvidence[label] = { actualByIndex, ...value };
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
    ...(process.env.CRANE_ELEVATION_RECORD_VIDEO === '1' ? { recordVideo: { dir: output, size: { width: 1600, height: 1000 } } } : {}) });
  page = await context.newPage(); video = page.video(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push({ check: activeCheck?.id, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ check: activeCheck?.id, message: message.text().slice(0, 600) }); });
  let baseline, thirty, sixty, originalElevation;
  const sameCamera = (actual, expected) => actual.every((vector, index) => vector.every((number, axis) => Math.abs(number - expected[index][axis]) < 1e-8));
  function assertMesh(value, expectedAngle) {
    assert.equal(value.maxExportError, 0); assert.equal(value.mappedPositionValues, value.positionValues);
    assert(Math.abs(value.measuredElevationDeg - expectedAngle) < .001, `Measured boom elevation ${value.measuredElevationDeg} does not match ${expectedAngle}`);
    assert(value.heightErrorM < .0001, `Saved height differs from actual mesh by ${value.heightErrorM} m`);
    assert(value.hanging.verticesCompared > 1000); assert(value.hanging.rigidTranslationErrorM < .0001, 'Hanging block tilted with the boom');
    assert.equal(value.hydraulics.length, 2);
    for (const cylinder of value.hydraulics) {
      assert(cylinder.barrelCompared > 200 && cylinder.rodCompared > 100);
      assert(cylinder.barrelRigidityErrorM < .0001, 'Hydraulic barrel no longer pivots rigidly at its fixed pin');
      assert(cylinder.rodRigidityErrorM < .0001, 'Hydraulic rod disconnected from the moving upper pin');
    }
  }
  await check('source-default', async () => {
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await ready();
    await page.locator('.tab[data-tab="machinery"]').click(); await panel().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.management-studio:visible').count(), 0);
    const name = '吊臂仰角验收-' + Date.now();
    await panel().locator('[data-role="create-name"]').fill(name); await action('create').click();
    await page.waitForFunction(name => window.__managementWorkspace.ui.getSnapshot().collections.resources.some(item => item.name === name)
      && !window.__managementWorkspace.machinery.busy && !window.__managementWorkspace.machinery.loading, name);
    recordId = (await snapshot()).collections.resources.find(item => item.name === name).id; report.resourceId = recordId;
    await panel().locator('[data-role="asset"]').selectOption('crane'); await panelReady();
    originalElevation = Number(await angle().inputValue()); assert(originalElevation > 69 && originalElevation < 71);
    await field('overall_scale').fill('5');
    for (const [key, value] of Object.entries({ longitude: 116.391, latitude: 39.907, height: 0, heading: 35 })) await coordinate(key).fill(String(value));
    await save(); await settled(originalElevation);
    await page.locator('#basemap').selectOption('none');
    await page.evaluate(async id => {
      const C = await import('/node_modules/.vite/deps/cesium.js'), runtime = window.__managementWorkspace;
      const state = runtime.ui.getSnapshot().collections.resources.find(item => item.id === id).machinery;
      runtime.viewer.camera.lookAt(C.Cartesian3.fromDegrees(state.placement.longitude, state.placement.latitude, 6), new C.HeadingPitchRange(-.7, -.3, 45));
      runtime.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY); runtime.viewer.scene.requestRender();
      window.__craneElevationViewer = runtime.viewer;
    }, recordId);
    baseline = await geometry('original'); assertMesh(baseline, originalElevation); assert.equal(baseline.sourceDefaultMaxError, 0);
    await panel().locator('.mp-content').evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(350); await screenshot('01-crane-source-elevation');
    return { url: page.url(), recordId, originalElevation, geometry: baseline };
  });
  await check('elevation-30', async () => {
    await angle().fill('30'); await settled(30);
    thirty = await geometry('thirty', 'original'); assertMesh(thirty, 30);
    assert.notEqual(thirty.positionsHash, baseline.positionsHash);
    assert.deepEqual(thirty.placement, baseline.placement); assert.deepEqual(thirty.orientation, baseline.orientation);
    assert(sameCamera(thirty.camera, baseline.camera), 'Preview unexpectedly changed the scene camera');
    assert(thirty.comparison.fixedCompared > 1000); assert.equal(thirty.comparison.fixedMaxDelta, 0);
    assert(thirty.comparison.movingCompared > 1000); assert(thirty.comparison.movingMaxDelta > 1);
    assert.equal((await savedState()).parameters.boom_elevation_deg, originalElevation, 'Preview must not silently save');
    await panel().locator('.mp-content').evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(350); await screenshot('02-crane-elevation-30'); return thirty;
  });
  await check('elevation-60', async () => {
    await angle().fill('60'); await settled(60);
    sixty = await geometry('sixty', 'original'); assertMesh(sixty, 60);
    assert.equal(sixty.comparison.fixedMaxDelta, 0); assert(sameCamera(sixty.camera, baseline.camera), 'Preview unexpectedly changed the scene camera');
    assert.notEqual(sixty.actualHeightM, thirty.actualHeightM);
    await panel().locator('.mp-content').evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(350); await screenshot('03-crane-elevation-60'); return sixty;
  });
  await check('save-reload', async () => {
    await save(); const before = await savedState(); assert.equal(before.parameters.boom_elevation_deg, 60);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await page.locator(`[data-machinery-record="${recordId}"] [data-machinery-action="edit"]`).click(); await panelReady(); await settled(60);
    assert.deepEqual(await savedState(), before); assert.equal(Number(await angle().inputValue()), 60);
    const after = await geometry('savedSixty'); assert.equal(after.positionsHash, sixty.positionsHash);
    await page.evaluate(() => { window.__craneElevationViewer = window.__managementWorkspace.viewer; });
    await action('locate').click(); await page.waitForTimeout(1000);
    return { persistedState: before, geometryHashAfterReload: after.positionsHash };
  });
  await check('cancel', async () => {
    await angle().fill('20'); await settled(20); const draft = await geometry('cancelDraft'); assertMesh(draft, 20);
    assert.notEqual(draft.positionsHash, sixty.positionsHash);
    await action('cancel').click(); await panelReady(); await settled(60);
    const restored = await geometry('cancelRestored'); assert.equal(restored.positionsHash, sixty.positionsHash);
    await page.evaluate(() => {
      const input = document.querySelector('.machinery-panel [data-parameter="boom_elevation_deg"]');
      input.value = '45'; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.machinery-panel [data-action="cancel"]').click();
    });
    await panelReady(); await page.waitForTimeout(350); await settled(60);
    const immediate = await geometry('immediateCancelRestored'); assert.equal(immediate.positionsHash, sixty.positionsHash);
    assert.equal(Number(await angle().inputValue()), 60);
    return { rejectedAngle: 20, restoredAngle: 60, restoredHash: restored.positionsHash,
      immediateCancelDraftAngle: 45, immediateCancelRestoredHash: immediate.positionsHash };
  });
  await check('combined-pose', async () => {
    await panel().locator('[data-role="proportional"]').uncheck();
    const oldLength = Number(await field('boom_length_m').inputValue());
    await field('boom_length_m').fill(String(oldLength * 1.2)); await settled(60);
    await field('boom_rotation_deg').fill('75'); await settled(60);
    await field('overall_scale').fill('6'); await settled(60);
    assert.equal(Number(await field('boom_rotation_deg').inputValue()), 75); assert.equal(Number(await angle().inputValue()), 60);
    assert(Math.abs(Number(await field('boom_length_m').inputValue()) - oldLength * 1.44) < 1e-8);
    const before = await geometry('combinedSixty'); assertMesh(before, 60);
    await angle().fill('30'); await settled(30); const after = await geometry('combinedThirty', 'combinedSixty'); assertMesh(after, 30);
    assert.equal(after.comparison.fixedMaxDelta, 0);
    assert.deepEqual(after.placement, before.placement); assert.deepEqual(after.orientation, before.orientation);
    await save(); const stored = await savedState(); assert.equal(stored.parameters.boom_rotation_deg, 75); assert.equal(stored.parameters.boom_elevation_deg, 30);
    return { state: stored, geometry: after };
  });
  await check('height-reset', async () => {
    await panel().locator('[data-role="proportional"]').check();
    await field('overall_height_m').fill('12'); await settled(30);
    const edited = await geometry('heightTwelve'); assertMesh(edited, 30); assert(Math.abs(edited.actualHeightM - 12) < .0001);
    assert.equal(edited.parameters.boom_rotation_deg, 75);
    await action('reset').click(); await settled(30);
    const reset = await geometry('dimensionsReset'); assertMesh(reset, 30);
    assert.equal(reset.parameters.overall_scale, 1); assert.equal(reset.parameters.boom_elevation_deg, 30); assert.equal(reset.parameters.boom_rotation_deg, 75);
    const dimensions = Object.fromEntries(Object.entries(reset.parameters).filter(([key]) => !['boom_elevation_deg', 'overall_height_m'].includes(key)));
    await action('reset-boom-elevation').click(); await settled(originalElevation);
    const originalAngle = await geometry('elevationReset'); assertMesh(originalAngle, originalElevation);
    for (const [key, value] of Object.entries(dimensions)) assert.equal(originalAngle.parameters[key], value);
    await action('cancel').click(); await panelReady(); await settled(30);
    return { requestedHeightM: 12, actualHeightM: edited.actualHeightM, originalDimensionReset: reset.parameters,
      elevationResetPreservesOtherParameters: true, elevationResetAngle: originalAngle.parameters.boom_elevation_deg };
  });
  await check('slider-bounds', async () => {
    await slider().focus(); await slider().press('Home'); await settled(0);
    const horizontal = await geometry('horizontal'); assertMesh(horizontal, 0);
    const warningVisible = await panel().locator('[data-role="boom-clearance-warning"]').isVisible();
    assert.equal(warningVisible, horizontal.lowestModelYM < -.005);
    await action('locate').click(); await page.waitForTimeout(1200);
    const locate = await page.evaluate(async id => {
      const C = await import('/node_modules/.vite/deps/cesium.js'), runtime = window.__managementWorkspace;
      const rendered = runtime.machinery.scene.rendered.get(id);
      for (const source of runtime.viewer.dataSources._dataSources) for (const visualizer of source._visualizers || []) {
        const model = visualizer._modelHash?.[rendered.entity.id]?.modelPrimitive;
        if (model?.ready) return { cameraRangeM: C.Cartesian3.distance(runtime.viewer.camera.positionWC, model.boundingSphere.center), sphereRadiusM: model.boundingSphere.radius };
      }
      throw new Error('Rendered model bounds unavailable after locate');
    }, recordId);
    assert(locate.cameraRangeM >= horizontal.parameters.boom_length_m * 3.5, 'Locating the horizontal boom used height alone and cropped its full length');
    await slider().press('End'); await settled(90); const vertical = await geometry('vertical'); assertMesh(vertical, 90);
    await slider().press('Home'); for (let i = 0; i < 25; i++) await slider().press('ArrowRight', { delay: 0 });
    const finalAngle = Number(await slider().inputValue()); await settled(finalAngle);
    const final = await geometry('sliderFinal'); assertMesh(final, finalAngle); assert.equal(Number(await angle().inputValue()), finalAngle);
    await action('cancel').click(); await panelReady(); await settled(30);
    return { minimum: horizontal.parameters.boom_elevation_deg, maximum: vertical.parameters.boom_elevation_deg,
      horizontalHookLowestYM: horizontal.lowestModelYM, groundAnchorWarningVisible: warningVisible, horizontalLocate: locate,
      finalAngle, finalMeasuredAngle: final.measuredElevationDeg };
  });
  await check('single-runtime', async () => {
    const identity = await page.evaluate(() => {
      const runtime = window.__managementWorkspace;
      return { sameViewer: runtime.viewer === window.__craneElevationViewer,
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
  if (video) { const path = resolve(output, 'crane-elevation-actual-operation.webm'); await video.saveAs(path); report.videos.push(path); }
  report.finishedAt = new Date().toISOString(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server?.close();
}
