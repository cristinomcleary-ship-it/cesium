/**
 * Real Chromium UI acceptance of the original Cesium workbench's rail-safety
 * module. The app runs on a new isolated SQLite directory. Equipment and account
 * fixtures may be created through the product API; all rail-safety authoring uses
 * real product controls. Camera framing and read-only observations use the DEV
 * runtime. The fixture has no surveyed site terrain or control points.
 *
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/absolute/path/to/launch_options.mjs \
 * RAIL_SAFETY_RECORD_VIDEO=1 node tools/verify-rail-safety.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.RAIL_SAFETY_VERIFY_OUT || 'output/rail-safety');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/rail-safety-browser-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;

const definitions = [
  ['root-entry', 'Original workbench opens the rail-safety module using the existing Viewer'],
  ['guard-authoring', 'User creates a named guard, independent station, responsibility polygon and machine assignment'],
  ['limit-authoring', 'User creates railway safety polygons with product authoring controls'],
  ['machine-association', 'User selects multiple limits for an existing machine and saves the configuration'],
  ['potential-intrusion', 'The actual scene renders a collapse envelope and red geometric intersections'],
  ['boundary-contact', 'A user-entered limit tangent to the current envelope produces the contact state'],
  ['hidden-layer', 'Hiding a limit changes rendering without clearing its risk evaluation'],
  ['pose-preview-cancel', 'Actual machinery controls update collapse results before save and cancellation restores the saved result'],
  ['draft-navigation', 'An unfinished protection draft blocks navigation until the user cancels it'],
  ['save-reload', 'User-authored guard, limits and machine selections survive workbench reload'],
  ['concurrent-drawing', 'A real concurrent limit update cannot silently overwrite an in-progress user polygon'],
  ['read-only', 'A real viewer account can read the module while server and controls reject mutations'],
  ['single-runtime', 'One original Viewer and one rail-safety source remain without uncaught browser errors'],
];
const report = {
  classification: 'actual-original-workbench-rail-safety-ui-with-isolated-data',
  renderer: 'Real Chromium WebGL2, with SwiftShader when selected by supplied launch options',
  startedAt: new Date().toISOString(), dataDir, productionDataReadOrModified: false,
  fixtureClassification: {
    api: 'Equipment resources, model poses, authorization accounts and an explicitly simulated concurrent editor update',
    ui: 'Rail-safety guards, independent stations, responsibility areas, limits and machine associations',
    limitations: ['Synthetic WGS84 test worksite; no production data', 'No surveyed terrain or independent engineering control points', 'Geometric functionality only; field accuracy and tipping probability are not certified'],
  },
  checks: definitions.map(([id, title]) => ({ id, title, status: 'pending' })),
  screenshots: [], videos: [], pageErrors: [], consoleErrors: [], workerUrls: [],
};
let server, browser, context, page, video, origin, activeCheck;
const resourceIds = { crane: 'rail-browser-crane', pile: 'rail-browser-pile', excavator: 'rail-browser-excavator' };
const site = { longitude: 116.391, latitude: 39.907, height: 0 };
const rp = () => page.locator('.rail-safety-panel');
const action = name => rp().locator(`[data-action="${name}"]`);

async function check(id, run) {
  activeCheck = report.checks.find(value => value.id === id); activeCheck.status = 'running';
  activeCheck.startedAt = new Date().toISOString(); console.log('RUN', id);
  activeCheck.evidence = await run(); activeCheck.status = 'passed';
  activeCheck.finishedAt = new Date().toISOString(); console.log('PASS', id);
}
async function ready() {
  await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId,
    undefined, { timeout: 60000 });
}
async function snapshot() { return page.evaluate(() => window.__managementWorkspace.ui.getSnapshot()); }
async function sceneSnapshot() { return page.evaluate(() => window.__managementWorkspace.railSafety.scene.getSnapshot()); }
async function settled() {
  await page.waitForFunction(() => {
    const panel = window.__managementWorkspace.railSafety;
    const state = panel.scene.getSnapshot();
    return !panel.isBusy && state.pending === 0;
  }, undefined, { timeout: 60000 });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}
async function screenshot(name) {
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, timeout: 20000 }); report.screenshots.push(path);
}
async function frame() {
  await page.evaluate(async point => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), viewer = window.__managementWorkspace.viewer;
    viewer.camera.lookAt(C.Cartesian3.fromDegrees(point.longitude + .0001, point.latitude, point.height),
      new C.HeadingPitchRange(-.5, -.75, 110));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY); viewer.camera.moveRight(15); viewer.scene.requestRender();
  }, site);
}
async function command(type, payload, extra = {}) {
  const response = await context.request.post(origin + '/__management/commands', {
    headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' },
    data: { projectId: 'safety:project', type, payload, idempotencyKey: crypto.randomUUID(), ...extra },
  });
  return { status: response.status(), body: await response.json() };
}
async function fixtures() {
  for (const [index, assetId] of Object.keys(resourceIds).entries()) {
    const id = resourceIds[assetId];
    const resource = await command('resource.create', { name: { crane: '吊机 01', pile: '桩机 02', excavator: '挖机 03' }[assetId], kind: 'equipment', quantity: 1, unit: '台' }, { id });
    assert.equal(resource.status, 200, JSON.stringify(resource.body));
    const manifest = JSON.parse(await readFile(resolve('public/machinery', assetId, 'manifest.json'), 'utf8'));
    const scale = assetId === 'excavator' ? 1 : 4;
    const parameters = Object.fromEntries(manifest.config.parameters.map(value => [value.key, value.unit === '°' ? value.original : value.original * scale]));
    const state = { schemaVersion: 1, assetId, assetVersion: manifest.version, proportional: true, parameters,
      placement: { ...site, longitude: site.longitude + index * .00024, heading: 0 }, visible: true };
    const model = await command('machinery.save', { machinery: state }, { id, expectedRevision: 1 });
    assert.equal(model.status, 200, JSON.stringify(model.body));
  }
}

// The product-specific UI cases are below. Tests do not create guard or limit
// records by calling APIs or by writing into runtime state.
async function runCases() {
  let guardId, nearLimitId, farLimitId, savedRecords;
  const field = name => rp().locator(`[data-field="${name}"]`);
  const machineResult = async () => (await sceneSnapshot()).results.find(result => result.resourceId === resourceIds.crane);
  const rect = (west, south, east, north) => [
    { longitude: site.longitude + west, latitude: site.latitude + south, height: 0 },
    { longitude: site.longitude + east, latitude: site.latitude + south, height: 0 },
    { longitude: site.longitude + east, latitude: site.latitude + north, height: 0 },
    { longitude: site.longitude + west, latitude: site.latitude + north, height: 0 },
  ];
  async function writePolygon(points) {
    for (const [index, point] of points.entries()) {
      await action('add-vertex').click();
      for (const [key, value] of Object.entries(point)) await rp().locator(`[data-vertex-index="${index}"][data-coordinate="${key}"]`).fill(String(value));
    }
  }
  async function saveSafety() {
    const responsePromise = page.waitForResponse(response => {
      if (!response.url().endsWith('/__management/commands')) return false;
      try { return response.request().postDataJSON()?.type === 'railSafety.save'; } catch { return false; }
    });
    await action('save').click(); const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    await page.waitForFunction(() => !window.__managementWorkspace.railSafety.isBusy && !window.__managementWorkspace.railSafety.hasDraft);
    await settled();
  }
  async function choose(tab, id) {
    await action(`tab-${tab}`).click();
    if (id) await rp().locator('[data-role="selection"]').selectOption(id);
    await settled();
  }
  async function clickWorld(point) {
    const pixel = await page.evaluate(async point => {
      const C = await import('/node_modules/.vite/deps/cesium.js');
      const viewer = window.__managementWorkspace.viewer;
      const pixel = C.SceneTransforms.worldToWindowCoordinates(viewer.scene, C.Cartesian3.fromDegrees(point.longitude, point.latitude, point.height));
      const rect = viewer.canvas.getBoundingClientRect();
      if (!pixel) throw new Error('Test camera cannot see the requested fixture coordinate');
      return { x: rect.left + pixel.x, y: rect.top + pixel.y };
    }, point);
    const obstruction = await page.evaluate(pixel => document.elementFromPoint(pixel.x, pixel.y)?.closest('.rail-safety-panel,.machinery-panel')?.className, pixel);
    assert(!obstruction, `Evidence camera puts a requested pick behind ${obstruction}`);
    await page.mouse.click(pixel.x, pixel.y); await page.waitForTimeout(90);
  }
  await check('root-entry', async () => {
    await page.locator('.tab[data-tab="rail-safety"]').click(); await rp().waitFor({ state: 'visible' }); await settled();
    await page.evaluate(() => { window.__railSafetyOriginalViewer = window.__managementWorkspace.viewer; });
    assert.equal(await page.locator('.management-studio:visible').count(), 0);
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.locator('#cesiumContainer canvas').count(), 1);
    const state = await sceneSnapshot(); assert.equal((await snapshot()).collections.resources.length, 3); assert.equal(state.results.length, 1);
    const workerActive = await page.evaluate(() => !!window.__managementWorkspace.railSafety.scene.computation.worker);
    assert.equal(workerActive, true, 'Browser must use the actual dedicated geometry Worker');
    assert(state.results.every(result => result.status === 'unknown' && result.message.includes('限界')));
    return { path: '/', singleCanvas: true, workerActive, machineCount: state.results.length, noSelectedLimitStatus: state.results.map(result => result.status) };
  });
  await check('guard-authoring', async () => {
    await choose('guard'); await action('new').click(); await field('name').fill('张师傅 · 东侧防护');
    await action('pick-station').click();
    await clickWorld({ longitude: site.longitude - .00012, latitude: site.latitude + .00003, height: 0 });
    await page.waitForFunction(() => !window.__managementWorkspace.railSafety.isPicking);
    const picked = {};
    for (const key of ['longitude', 'latitude', 'height']) picked[key] = Number(await field('station.' + key).inputValue());
    assert(Object.values(picked).every(Number.isFinite));
    const station = { longitude: site.longitude - .00015, latitude: site.latitude, height: 0 };
    for (const [key, value] of Object.entries(station)) await field('station.' + key).fill(String(value));
    await writePolygon(rect(-.00025, -.00018, .00029, .0002));
    await rp().locator(`[data-reference="resource"][value="${resourceIds.crane}"]`).check();
    await rp().locator(`[data-reference="resource"][value="${resourceIds.pile}"]`).check();
    await saveSafety();
    const guard = (await snapshot()).collections.railSafety.find(record => record.name === '张师傅 · 东侧防护'); guardId = guard.id;
    assert.equal(guard.definition.polygon.length, 4); assert.deepEqual(guard.definition.station, station);
    assert.deepEqual([...guard.definition.resourceIds].sort(), [resourceIds.crane, resourceIds.pile].sort());
    const state = await sceneSnapshot(); assert(state.entityIds.includes(`rail-safety:guard:${guardId}:station`));
    assert(state.entityIds.includes(`rail-safety:guard:${guardId}:area`));
    await rp().locator('.rs-scroll').evaluate(element => { element.scrollTop = 0; }); await screenshot('02-guard-station-and-responsibility');
    return { id: guardId, actualScenePickedStation: picked, userEnteredStation: station, vertexCount: 4, resourceIds: guard.definition.resourceIds };
  });
  await check('limit-authoring', async () => {
    await choose('limit'); await action('new').click(); await field('name').fill('铁路设备安全限界 · 近侧');
    await action('draw-polygon').click();
    for (const point of rect(.00006, -.00025, .00016, .00025)) await clickWorld(point);
    await action('finish-polygon').click();
    await page.waitForFunction(() => !window.__managementWorkspace.railSafety.isPicking);
    assert.equal(await rp().locator('[data-vertex]').count(), 4);
    await saveSafety();
    const near = (await snapshot()).collections.railSafety.find(record => record.name === '铁路设备安全限界 · 近侧'); nearLimitId = near.id;
    await action('new').click(); await field('name').fill('信号设备保护范围 · 远侧');
    await writePolygon(rect(.00066, -.00015, .00073, .00015)); await saveSafety();
    const far = (await snapshot()).collections.railSafety.find(record => record.name === '信号设备保护范围 · 远侧'); farLimitId = far.id;
    await rp().locator('[data-role="selection"]').selectOption(nearLimitId);
    await rp().locator('.rs-scroll').evaluate(element => { element.scrollTop = 0; }); await screenshot('03-user-defined-railway-limit');
    return { sceneDrawnLimit: near, coordinateEnteredLimit: far };
  });
  await check('machine-association', async () => {
    await choose('machine', resourceIds.crane);
    await rp().locator(`[data-reference="limit"][value="${nearLimitId}"]`).check();
    await rp().locator(`[data-reference="limit"][value="${farLimitId}"]`).check();
    await field('inspectionStatus').selectOption('unreported'); await saveSafety();
    const configuration = (await snapshot()).collections.railSafety.find(record => record.definition.kind === 'machine' && record.definition.resourceId === resourceIds.crane);
    assert.deepEqual([...configuration.definition.selectedLimitIds].sort(), [nearLimitId, farLimitId].sort());
    assert.equal(configuration.definition.inspectionStatus, 'unreported');
    assert((await machineResult()).guards.some(guard => guard.id === guardId && guard.containsStation));
    return configuration;
  });
  await check('potential-intrusion', async () => {
    const result = await machineResult();
    assert.equal(result.status, 'overlap', JSON.stringify(result));
    assert.equal(result.limits.find(limit => limit.id === nearLimitId)?.status, 'overlap');
    assert.equal(result.limits.find(limit => limit.id === farLimitId)?.status, 'clear');
    assert(result.maxDistanceMeters > 0);
    const scene = await sceneSnapshot();
    assert(scene.entityIds.includes(`rail-safety:machine:${resourceIds.crane}:envelope`));
    assert(scene.entityIds.includes(`rail-safety:machine:${resourceIds.crane}:farthest`));
    const intersections = scene.entityIds.filter(id => id.startsWith(`rail-safety:machine:${resourceIds.crane}:intersection:${nearLimitId}:`));
    assert(intersections.length > 0);
    const colors = await page.evaluate(ids => {
      const source = window.__managementWorkspace.railSafety.scene.source;
      return ids.map(id => { const color = source.entities.getById(id).polygon.material.getValue().color; return [color.red, color.green, color.blue, color.alpha]; });
    }, intersections);
    assert(colors.every(color => color[0] > .9 && color[1] < .4 && color[2] < .5));
    await rp().locator('[data-role="results"]').scrollIntoViewIfNeeded(); await screenshot('01-overview-potential-intrusion');
    return { result, redIntersectionEntities: intersections, actualEntityColors: colors };
  });
  await check('boundary-contact', async () => {
    // Derive a test-only tangent fixture from the already-rendered envelope.
    // This verifies UI-to-result integration, not independent numerical accuracy.
    const tangent = await page.evaluate(async id => {
      const geometry = await import('/src/railSafetyGeometry.ts');
      const envelope = window.__managementWorkspace.railSafety.scene.visuals.find(value => value.resourceId === id).envelope;
      const point = envelope.polygon.reduce((best, value) => value.x > best.x ? value : best);
      return [ { x: point.x, y: point.y - 1 }, { x: point.x + 2, y: point.y - 1 },
        { x: point.x + 2, y: point.y + 1 }, { x: point.x, y: point.y + 1 } ].map(value => geometry.unprojectLocalToWgs84(value, envelope.origin));
    }, resourceIds.crane);
    await choose('limit'); await action('new').click(); await field('name').fill('边界接触验收区域'); await writePolygon(tangent); await saveSafety();
    const limit = (await snapshot()).collections.railSafety.find(record => record.name === '边界接触验收区域');
    await choose('machine', resourceIds.crane);
    await rp().locator(`[data-reference="limit"][value="${nearLimitId}"]`).uncheck();
    await rp().locator(`[data-reference="limit"][value="${farLimitId}"]`).uncheck();
    await rp().locator(`[data-reference="limit"][value="${limit.id}"]`).check(); await saveSafety();
    const result = await machineResult(); assert.equal(result.status, 'touching', JSON.stringify(result));
    assert.equal(result.limits[0].distanceMeters, 0);
    assert((await sceneSnapshot()).entityIds.includes(`rail-safety:machine:${resourceIds.crane}:contact:${limit.id}`), 'Contact has a red scene outline');
    await rp().locator('[data-role="results"]').scrollIntoViewIfNeeded(); await screenshot('06-boundary-contact');
    await rp().locator(`[data-reference="limit"][value="${limit.id}"]`).uncheck();
    await rp().locator(`[data-reference="limit"][value="${nearLimitId}"]`).check();
    await rp().locator(`[data-reference="limit"][value="${farLimitId}"]`).check(); await saveSafety();
    assert.equal((await machineResult()).status, 'overlap');
    return { tangentFixtureSource: 'Current rendered envelope, entered through coordinate fields', result, originalSelectedLimitsRestored: true };
  });
  await check('hidden-layer', async () => {
    const before = await machineResult();
    await rp().locator('[data-layer="limits"]').uncheck(); await settled();
    const hidden = await sceneSnapshot();
    assert.equal(hidden.layers.limits, false); assert(!hidden.entityIds.includes(`rail-safety:limit:${nearLimitId}:area`));
    assert.deepEqual(await machineResult(), before);
    await rp().locator('[data-layer="limits"]').check(); await settled();
    return { hiddenLimitNotRendered: true, resultUnchanged: true, selectedLimits: before.limits.map(limit => limit.id) };
  });
  await check('pose-preview-cancel', async () => {
    const baseline = await machineResult();
    const saved = (await snapshot()).collections.resources.find(record => record.id === resourceIds.crane).machinery;
    await action('edit-machinery').click();
    const machinery = page.locator('.machinery-panel'); await machinery.waitFor({ state: 'visible' });
    await page.waitForFunction(() => { const p = window.__managementWorkspace.machinery; return p.asset?.id === 'crane' && !p.loading && !p.busy; });
    await page.evaluate(() => {
      const probe = window.__railSafetyFrameProbe = { active: true, frames: 0, pendingFrames: 0 };
      const tick = () => { if (!probe.active) return; probe.frames++; if (window.__managementWorkspace.railSafety.scene.getSnapshot().pending > 0) probe.pendingFrames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    });
    await machinery.locator('[data-role="proportional"]').uncheck();
    const boom = machinery.locator('[data-parameter="boom_length_m"]'); await boom.fill(String(Number(await boom.inputValue()) + 5));
    await machinery.locator('[data-parameter="boom_elevation_deg"]').fill('35');
    await machinery.locator('[data-placement="heading"]').fill('65');
    await page.waitForFunction(() => window.__managementWorkspace.machinery.previewTimer === undefined);
    await settled(); const preview = await machineResult();
    const animationFramesDuringPreview = await page.evaluate(() => { window.__railSafetyFrameProbe.active = false; return window.__railSafetyFrameProbe; });
    assert(animationFramesDuringPreview.pendingFrames > 0, 'Animation frames should progress while geometry calculation is pending');
    assert.equal(preview.draft, true); assert.notEqual(preview.maxDistanceMeters, baseline.maxDistanceMeters);
    assert.notEqual(preview.signature, baseline.signature);
    assert.deepEqual((await snapshot()).collections.resources.find(record => record.id === resourceIds.crane).machinery, saved);
    await screenshot('04-machine-pose-live-preview');
    await machinery.locator('[data-action="cancel"]').click();
    await page.waitForFunction(() => { const p = window.__managementWorkspace.machinery; return !p.loading && !p.busy && p.previewTimer === undefined; });
    await settled(); const restored = await machineResult();
    assert.equal(restored.draft, false); assert.equal(restored.maxDistanceMeters, baseline.maxDistanceMeters);
    assert.deepEqual(restored.limits, baseline.limits);
    assert.deepEqual((await snapshot()).collections.resources.find(record => record.id === resourceIds.crane).machinery, saved);
    await machinery.locator('[data-action="close"]').click();
    await page.locator('.tab[data-tab="rail-safety"]').click(); await rp().waitFor({ state: 'visible' });
    return { before: baseline, preview, restored, resourceNotSaved: true, animationFramesDuringPreview };
  });
  await check('draft-navigation', async () => {
    await choose('guard', guardId); await field('name').fill('未保存的人员姓名');
    await page.locator('.tab[data-tab="cad"]').click();
    assert.equal(await rp().isVisible(), true); assert.equal(await field('name').inputValue(), '未保存的人员姓名');
    assert.equal((await snapshot()).collections.railSafety.find(record => record.id === guardId).name, '张师傅 · 东侧防护');
    await action('cancel').click(); await action('confirm').click(); await settled();
    assert.equal(await field('name').inputValue(), '张师傅 · 东侧防护');
    savedRecords = (await snapshot()).collections.railSafety;
    return { navigationBlockedWithDraft: true, storedNameUnchanged: true, cancellationRestoresOriginalName: true };
  });
  await check('save-reload', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await page.locator('#basemap').selectOption('none'); await frame();
    await page.locator('.tab[data-tab="rail-safety"]').click(); await rp().waitFor({ state: 'visible' }); await settled();
    assert.deepEqual((await snapshot()).collections.railSafety, savedRecords);
    await choose('machine', resourceIds.crane); assert.equal((await machineResult()).status, 'overlap');
    await page.evaluate(() => { window.__railSafetyOriginalViewer = window.__managementWorkspace.viewer; });
    await rp().locator('[data-role="results"]').scrollIntoViewIfNeeded(); await screenshot('05-persisted-configuration');
    return { retainedRecordIds: savedRecords.map(record => record.id), result: await machineResult() };
  });
  await check('concurrent-drawing', async () => {
    await choose('limit', nearLimitId);
    const original = (await snapshot()).collections.railSafety.find(record => record.id === nearLimitId);
    await action('draw-polygon').click();
    const concurrent = await command('railSafety.save', { name: original.name + ' · 外部修订', definition: original.definition }, { id: original.id, expectedRevision: original.revision });
    assert.equal(concurrent.status, 200, JSON.stringify(concurrent.body));
    // The platform's normal 10-second synchronization observes the other editor.
    await page.waitForFunction(({ id, revision }) => window.__managementWorkspace.ui.getSnapshot().collections.railSafety.find(record => record.id === id)?.revision > revision,
      { id: original.id, revision: original.revision }, { timeout: 20000 });
    assert.equal(await page.evaluate(() => window.__managementWorkspace.railSafety.draft.revision), original.revision);
    for (const point of rect(.00005, -.00023, .00017, .00023)) await clickWorld(point);
    await action('finish-polygon').click();
    const responsePromise = page.waitForResponse(response => {
      if (!response.url().endsWith('/__management/commands')) return false;
      try { return response.request().postDataJSON()?.type === 'railSafety.save'; } catch { return false; }
    });
    await action('save').click(); const response = await responsePromise;
    assert.equal(response.status(), 409, await response.text());
    await page.waitForFunction(() => !window.__managementWorkspace.railSafety.isBusy);
    assert.equal(await page.evaluate(() => window.__managementWorkspace.railSafety.hasDraft), true);
    assert.equal(await page.evaluate(() => window.__managementWorkspace.railSafety.draft.revision), original.revision);
    const latest = (await snapshot()).collections.railSafety.find(record => record.id === nearLimitId);
    assert.equal(latest.revision, original.revision + 1); assert.equal(latest.name, original.name + ' · 外部修订');
    await action('cancel').click(); await action('confirm').click(); await settled();
    assert.equal(await field('name').inputValue(), latest.name);
    savedRecords = (await snapshot()).collections.railSafety;
    return { startingRevision: original.revision, concurrentRevision: latest.revision, uiSaveStatus: response.status(), originalDraftRetainedOnConflict: true, explicitCancellationLoadsCurrentRecord: true };
  });
  await check('read-only', async () => {
    const password = 'Isolated-Rail-Safety-' + crypto.randomUUID();
    assert.equal((await command('member.save', { username: 'rail-owner', displayName: '隔离验收管理员', password, roles: ['owner'] })).status, 200);
    assert.equal((await command('member.save', { username: 'rail-reader', displayName: '隔离验收只读人员', password, roles: ['viewer'], resourceAccess: { models: true, files: false, media: false } })).status, 200);
    const logout = await context.request.delete(origin + '/__management/session', { headers: { 'X-Cesium-Library': '1' } }); assert.equal(logout.status(), 200);
    const login = await context.request.post(origin + '/__management/session', { headers: { 'X-Cesium-Library': '1' }, data: { username: 'rail-reader', password } }); assert.equal(login.status(), 200);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await page.locator('.tab[data-tab="rail-safety"]').click(); await rp().waitFor({ state: 'visible' }); await settled();
    await choose('guard', guardId);
    assert.equal(await field('name').isDisabled(), true); assert.equal(await action('new').isDisabled(), true);
    assert.equal(await action('save').isDisabled(), true); assert.equal(await action('remove').isDisabled(), true);
    const record = (await snapshot()).collections.railSafety.find(record => record.id === guardId);
    const rejected = await command('railSafety.save', { name: '不得写入', definition: record.definition }, { id: record.id, expectedRevision: record.revision });
    assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
    assert.deepEqual((await snapshot()).collections.railSafety, savedRecords);
    await page.evaluate(() => { window.__railSafetyOriginalViewer = window.__managementWorkspace.viewer; });
    return { role: 'viewer with models read access', serverMutationStatus: rejected.status, writeControlsDisabled: true };
  });
  await check('single-runtime', async () => {
    const state = await page.evaluate(() => { const r = window.__managementWorkspace; return {
      sameViewer: r.viewer === window.__railSafetyOriginalViewer,
      safetySameViewer: window.__safetyWorkspace.getManagementViewer() === r.viewer,
      railSources: r.viewer.dataSources._dataSources.filter(source => source.name === '铁路旁施工管控').length,
      machineSources: r.viewer.dataSources._dataSources.filter(source => source.name === '施工机械').length,
      renderLoop: r.viewer.useDefaultRenderLoop,
    }; });
    assert.deepEqual(state, { sameViewer: true, safetySameViewer: true, railSources: 1, machineSources: 1, renderLoop: true });
    assert.equal(await page.locator('#cesiumContainer canvas').count(), 1);
    assert.equal(await rp().count(), 1);
    assert.deepEqual(report.pageErrors, []);
    report.expectedConsoleErrors = report.consoleErrors.filter(error => error.check === 'concurrent-drawing' && error.message.includes('409'));
    assert.deepEqual(report.consoleErrors.filter(error => !report.expectedConsoleErrors.includes(error)), []);
    return state;
  });
}

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const options = process.env.BROWSER_LAUNCH_OPTIONS
    ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined };
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen();
  const address = server.httpServer.address(); assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`; report.origin = origin;
  browser = await chromium.launch(options);
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 },
    ...(process.env.RAIL_SAFETY_RECORD_VIDEO === '1' ? { recordVideo: { dir: output, size: { width: 1600, height: 1000 } } } : {}) });
  page = await context.newPage(); video = page.video(); page.setDefaultTimeout(30000);
  page.on('worker', worker => report.workerUrls.push(worker.url()));
  page.on('pageerror', error => report.pageErrors.push({ check: activeCheck?.id, message: error.message }));
  page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push({ check: activeCheck?.id, message: event.text().slice(0, 600) }); });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await ready();
  await fixtures(); await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await page.locator('#basemap').selectOption('none'); await frame();
  await runCases(); report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1;
  if (activeCheck?.status === 'running') { activeCheck.status = 'failed'; activeCheck.error = report.failure; }
  for (const item of report.checks) if (item.status === 'pending') { item.status = 'skipped'; item.reason = 'Earlier failure; no pass claim'; }
  console.error(error);
  if (page) { await screenshot('failure').catch(() => {}); report.failureVisibleText = (await page.locator('body').innerText().catch(() => '')).slice(-6000); }
} finally {
  await context?.close();
  if (video) { const path = resolve(output, 'rail-safety-actual-operation.webm'); await video.saveAs(path); report.videos.push(path); }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server?.close();
}
