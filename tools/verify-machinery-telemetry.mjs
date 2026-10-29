/** Real original-workbench telemetry acceptance with isolated data and actual HTTP traffic.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/absolute/path/to/launch-options.mjs \
 * node tools/verify-machinery-telemetry.mjs
 * No user projects or credentials are read. Screenshots/report remain in output/.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.MACHINERY_TELEMETRY_VERIFY_OUT || 'output/machinery-telemetry');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/machinery-telemetry-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { classification: 'actual-original-workbench-telemetry-with-isolated-data',
  startedAt: new Date().toISOString(), dataDir, checks: [], screenshots: [], requests: [], pageErrors: [], consoleErrors: [] };
let server, browser, context, page, origin, activeCheck;
let craneId, pileId;
const panel = () => page.locator('.machinery-panel');
const action = name => panel().locator(`[data-action="${name}"]`);
const field = key => panel().locator(`[data-parameter="${key}"]`);
const coord = key => panel().locator(`[data-placement="${key}"]`);
const snapshot = () => page.evaluate(() => window.__managementWorkspace.ui.getSnapshot());
async function check(id, run) {
  activeCheck = { id, status: 'running', startedAt: new Date().toISOString() };
  report.checks.push(activeCheck); console.log('RUN', id);
  activeCheck.evidence = await run(); activeCheck.status = 'passed'; activeCheck.finishedAt = new Date().toISOString(); console.log('PASS', id);
}
async function ready() { await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId, undefined, { timeout: 60000 }); }
async function editorReady(id) {
  await page.waitForFunction(id => {
    const p = window.__managementWorkspace?.machinery;
    return p?.asset && !p.loading && !p.busy && (!id || p.selectedResourceId === id);
  }, id, { timeout: 45000 });
}
async function settled(id) {
  await page.waitForFunction(id => {
    const w = window.__managementWorkspace, p = w?.machinery;
    return p && !p.loading && !p.busy && p.previewTimer === undefined && !p.scene.tasks.has(id)
      && p.scene.rendered.has(id) && !p.scene.getError(id) && w.railSafety.scene.getSnapshot().pending === 0;
  }, id, { timeout: 60000 });
}
async function save() {
  const response = page.waitForResponse(r => {
    try { return r.url().endsWith('/__management/commands') && r.request().postDataJSON()?.type === 'machinery.save'; } catch { return false; }
  });
  await action('save').click(); const r = await response; assert.equal(r.status(), 200, await r.text());
  await page.waitForFunction(() => !window.__managementWorkspace.machinery.hasDraft && !window.__managementWorkspace.machinery.busy);
}
async function createMachine(assetId, index) {
  const name = `传感器验收-${assetId}-${Date.now()}`;
  await panel().locator('[data-role="create-name"]').fill(name); await action('create').click();
  await page.waitForFunction(name => window.__managementWorkspace.ui.getSnapshot().collections.resources.some(r => r.name === name)
    && !window.__managementWorkspace.machinery.busy && !window.__managementWorkspace.machinery.loading, name);
  const id = (await snapshot()).collections.resources.find(r => r.name === name).id;
  await panel().locator('[data-role="asset"]').selectOption(assetId); await editorReady(id);
  console.log('CREATE', assetId, id);
  await field('overall_scale').fill(assetId === 'excavator' ? '1' : '4');
  for (const [key, value] of Object.entries({ longitude: 116.391 + index * .0002, latitude: 39.907, height: 0, heading: 0 })) {
    await coord(key).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    assert.equal(await coord(key).isEnabled(), true);
    await coord(key).fill(String(value));
  }
  await save(); await settled(id); return id;
}
async function selectMachine(id) {
  if (!(await panel().isVisible())) await page.locator('.tab[data-tab="machinery"]').click();
  await panel().locator('[data-role="resource"]').selectOption(id); await editorReady(id);
}
async function saved(id) { return (await snapshot()).collections.resources.find(r => r.id === id).machinery; }
async function renderedState(id) {
  return page.evaluate(async id => {
    const w = window.__managementWorkspace, rendered = w.machinery.scene.rendered.get(id);
    if (!rendered) return null;
    const bytes = await (await fetch(rendered.url)).arrayBuffer(), view = new DataView(bytes);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, view.getUint32(12, true))));
    const t = w.viewer.clock.currentTime, p = rendered.entity.position.getValue(t), q = rendered.entity.orientation.getValue(t);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    const rail = w.railSafety.scene;
    const runtime = w.machinery.scene.getRenderState?.(id);
    return { parameters: runtime?.targetState.parameters ?? json.extras.parameters, runtime, hash, position: [p.x, p.y, p.z], orientation: [q.x, q.y, q.z, q.w],
      live: w.machinery.scene.liveStates.get(id), railLive: rail.liveStates.get(id),
      result: rail.getSnapshot().results.find(r => r.resourceId === id), envelopeKey: rail.envelopes.get(id)?.key,
      fallDemo: rail.getSnapshot().fallDemo };
  }, id);
}
async function command(type, payload, extra = {}) {
  const response = await context.request.post(origin + '/__management/commands', {
    headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' },
    data: { projectId: 'safety:project', type, payload, idempotencyKey: crypto.randomUUID(), ...extra },
  });
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
async function postFrame(id, values, sourceId = 'browser-sim') {
  const response = await context.request.post(origin + '/__management/machinery-telemetry', {
    headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' },
    data: { schemaVersion: 1, projectId: 'safety:project', resourceId: id, sourceId,
      timestamp: new Date().toISOString(), mode: 'simulated', values },
  });
  const body = await response.json(); assert.equal(response.status(), 202, JSON.stringify(body)); return body;
}
async function screenshot(name) {
  const file = resolve(output, name + '.png'); await page.screenshot({ path: file, timeout: 30000 }); report.screenshots.push(file);
}
const telemetryValue = key => panel().locator(`[data-telemetry-value="${key}"]`);
async function openTelemetry() {
  await panel().locator('details[data-role="telemetry"]').evaluate(el => { el.open = true; });
}
async function bindFields(keys) {
  for (const key of keys) {
    const row = panel().locator(`[data-telemetry-target="${key}"]`);
    await row.locator('[data-telemetry-input="enabled"]').check();
    await row.locator('[data-telemetry-input="sourceId"]').fill('browser-sim');
    await row.locator('[data-telemetry-input="sourceField"]').fill(key);
  }
  await action('telemetry-enable').click();
  await page.waitForFunction(() => document.querySelector('.machinery-panel [data-action="telemetry-disable"]')?.disabled === false);
}
async function waitParameter(id, key, value) {
  await page.waitForFunction(({ id, key, value }) => {
    const p = window.__managementWorkspace.machinery, m = p.scene.rendered.get(id);
    return m && !p.scene.tasks.has(id) && JSON.parse(m.geometryKey)[3].some(([k, v]) => k === key && Math.abs(v - value) < 1e-8);
  }, { id, key, value }, { timeout: 60000 });
  await settled(id);
}
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const launchOptions = process.env.BROWSER_LAUNCH_OPTIONS
    ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] };
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(launchOptions); report.browserVersion = browser.version(); context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', e => report.pageErrors.push({ check: activeCheck?.id, message: e.message }));
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({ check: activeCheck?.id, message: m.text().slice(0, 300) }); });
  page.on('request', r => { if (r.url().includes('/__management/machinery-telemetry')) report.requests.push({ method: r.method(), at: Date.now() }); });
  await check('disabled-by-default-and-original-edit-flow', async () => {
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await ready();
    await page.locator('#basemap').selectOption('none');
    await page.locator('.tab[data-tab="machinery"]').click(); await panel().waitFor({ state: 'visible' });
    craneId = await createMachine('crane', 0); pileId = await createMachine('pile', 1);
    await selectMachine(craneId); const before = await renderedState(craneId);
    await coord('heading').fill('90'); await page.waitForTimeout(400); await settled(craneId);
    const turned = await renderedState(craneId); assert.notDeepEqual(turned.orientation, before.orientation);
    await action('cancel').click(); await editorReady(craneId); await settled(craneId);
    assert.deepEqual((await renderedState(craneId)).orientation, before.orientation);
    assert.equal((await saved(craneId)).placement.heading, 0);
    assert.equal(report.requests.length, 0, 'Feature disabled must send no telemetry request');
    await page.locator('#basemap').selectOption('none');
    await command('railSafety.save', { name: '传感器包络验收', definition: { schemaVersion: 1, kind: 'machine', resourceId: craneId, selectedLimitIds: [] } }, { id: 'telemetry-crane-safety', expectedRevision: 0 });
    await page.evaluate(() => window.__managementWorkspace.ui.refresh()); await editorReady(craneId); await settled(craneId);
    await action('locate').click();
    return { craneId, pileId, telemetryRequests: report.requests.length, originalEditAndCancel: true };
  });
  await check('new-initial-angle-controls-preserve-old-model-storage', async () => {
    await openTelemetry();
    await panel().locator('details.mp-telemetry-initial').evaluate(el => { el.open = true; });
    const initial = await saved(craneId), expected = await page.evaluate(async () => {
      const module = await import('/src/machineryTelemetry.ts');
      return module.canonicalBoomToSource(window.__managementWorkspace.machinery.asset, 0);
    });
    await panel().locator('[data-role="telemetry-initial-heading"]').fill('0');
    await panel().locator('[data-role="telemetry-initial-boom"]').fill('0');
    await action('telemetry-initial').click(); await waitParameter(craneId, 'boom_rotation_deg', expected);
    assert.equal((await saved(craneId)).parameters.boom_rotation_deg, initial.parameters.boom_rotation_deg, 'Applying initial controls is only a draft');
    await action('cancel').click(); await editorReady(craneId); await settled(craneId);
    assert.equal((await renderedState(craneId)).parameters.boom_rotation_deg, initial.parameters.boom_rotation_deg, 'Cancelling preserves old stored angle');
    await openTelemetry();
    await panel().locator('[data-role="telemetry-initial-heading"]').fill('0');
    await panel().locator('[data-role="telemetry-initial-boom"]').fill('0');
    await action('telemetry-initial').click(); await waitParameter(craneId, 'boom_rotation_deg', expected); await save();
    return { userBoomZero: 0, storedSourceAngle: expected, initialControlsAreDraftUntilSaved: true, oldAngleRestoredOnCancel: true };
  });
  await check('only-boom-length-keeps-manual-dimensions-when-saving-heading', async () => {
    await openTelemetry(); await bindFields(['boom_length_m']);
    const original = await saved(craneId), length = original.parameters.boom_length_m * 1.1;
    await postFrame(craneId, { boom_length_m: length }); await waitParameter(craneId, 'boom_length_m', length);
    const live = await renderedState(craneId);
    assert(Math.abs(Number(await field('overall_height_m').inputValue()) - live.parameters.overall_height_m) < 1e-8);
    await coord('heading').fill('90'); await page.waitForTimeout(450); await settled(craneId); await save();
    const persisted = await saved(craneId);
    assert.equal(persisted.placement.heading, 90);
    assert.equal(persisted.parameters.overall_scale, original.parameters.overall_scale);
    assert.equal(persisted.parameters.body_height_m, original.parameters.body_height_m);
    assert.equal(persisted.parameters.boom_length_m, length);
    await coord('heading').fill('0'); await page.waitForTimeout(450); await save();
    return { onlyBinding: 'boom_length_m', manualHeadingSaved: 90, scalePreserved: persisted.parameters.overall_scale,
      bodyHeightPreserved: persisted.parameters.body_height_m, displayedDerivedHeightCorrect: true };
  });
  await check('bind-selected-fields-through-http-and-calibrated-zero', async () => {
    await openTelemetry();
    await bindFields(['boom_length_m', 'boom_rotation_deg']);
    const initial = await saved(craneId), expectedSourceZero = await page.evaluate(async () => {
      const module = await import('/src/machineryTelemetry.ts');
      return module.canonicalBoomToSource(window.__managementWorkspace.machinery.asset, 0);
    });
    const baseline = await renderedState(craneId), length = initial.parameters.boom_length_m * 1.2;
    await postFrame(craneId, { boom_length_m: length, boom_rotation_deg: 0, heading: 123, longitude: 117, latitude: 40 });
    await waitParameter(craneId, 'boom_length_m', length);
    await waitParameter(craneId, 'boom_rotation_deg', expectedSourceZero);
    const updated = await renderedState(craneId);
    assert.equal(updated.parameters.overall_scale, initial.parameters.overall_scale);
    assert.deepEqual(updated.live.placement, initial.placement, 'Unbound coordinates and heading stay manual');
    assert.deepEqual(updated.live, updated.railLive, 'Model and envelope share one resolved live pose');
    assert.notEqual(updated.envelopeKey, baseline.envelopeKey, 'Envelope is recomputed for live geometry');
    if (updated.runtime?.runtime) assert.equal(updated.hash, baseline.hash, 'Sensor updates reuse one GPU model');
    else assert.notEqual(updated.hash, baseline.hash);
    assert.deepEqual(await saved(craneId), initial, 'Telemetry never writes the equipment ledger');
    assert.match(await telemetryValue('boom_rotation_deg').innerText(), /模拟/);
    await coord('heading').focus();
    await postFrame(craneId, { boom_length_m: length * 1.05 });
    await waitParameter(craneId, 'boom_length_m', length * 1.05);
    assert.equal((await renderedState(craneId)).parameters.boom_rotation_deg, expectedSourceZero, 'Missing angle holds last value');
    assert.equal(await coord('heading').evaluate(el => document.activeElement === el), true, 'Sensor update preserves manual input focus');
    const beforeManual = await renderedState(craneId);
    await coord('heading').fill('90'); await page.waitForTimeout(450); await settled(craneId);
    const manual = await renderedState(craneId);
    assert.equal(manual.live.placement.heading, 90, 'Unbound heading stays manually editable while telemetry runs');
    assert.equal(manual.parameters.overall_scale, initial.parameters.overall_scale);
    assert.equal(manual.parameters.body_height_m, initial.parameters.body_height_m);
    assert.equal(manual.parameters.boom_length_m, beforeManual.parameters.boom_length_m);
    assert(Math.abs(Number(await field('overall_height_m').inputValue()) - manual.parameters.overall_height_m) < 1e-8, 'Derived total height follows new geometry');
    await action('cancel').click(); await editorReady(craneId); await settled(craneId);
    assert.equal((await renderedState(craneId)).live.placement.heading, 0);
    assert.equal((await renderedState(craneId)).parameters.boom_length_m, beforeManual.parameters.boom_length_m);
    await screenshot('01-selected-bindings-and-live-pose');
    return { sourceAngleForUserZero: expectedSourceZero, bound: ['boom_length_m', 'boom_rotation_deg'], unboundPlacementPreserved: true,
      partialFramePreservedAngle: true, ledgerUnchanged: true, modelAndEnvelopeSameState: true, inputFocusPreserved: true };
  });
  await check('page-single-frame-simulator-and-stale-state', async () => {
    await panel().locator('details.mp-telemetry-test').evaluate(el => { el.open = true; });
    await action('telemetry-sample').click();
    const frame = JSON.parse(await panel().locator('[data-role="telemetry-json"]').inputValue());
    frame.timestamp = new Date().toISOString(); frame.values.boom_length_m *= 1.03;
    await panel().locator('[data-role="telemetry-json"]').fill(JSON.stringify(frame, null, 2));
    const post = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/__management/machinery-telemetry'));
    await action('telemetry-send').click(); const response = await post; assert.equal(response.status(), 202, await response.text());
    await waitParameter(craneId, 'boom_length_m', frame.values.boom_length_m);
    const countBefore = report.requests.filter(r => r.method === 'POST').length;
    await action('telemetry-sim-start').click();
    await page.waitForFunction(() => document.querySelector('.machinery-panel [data-action="telemetry-sim-stop"]')?.disabled === false);
    await page.waitForTimeout(2600); await action('telemetry-sim-stop').click();
    assert(report.requests.filter(r => r.method === 'POST').length >= countBefore + 2, 'Page simulator uses actual HTTP');
    await page.waitForTimeout(1500); await settled(craneId);
    const held = await renderedState(craneId);
    await page.waitForFunction(() => document.querySelector('[data-telemetry-value="boom_length_m"]')?.dataset.freshness === 'stale', undefined, { timeout: 12000 });
    const stale = await renderedState(craneId); assert.deepEqual(stale.live, held.live);
    assert.match(await telemetryValue('boom_length_m').innerText(), /过期|超时/);
    await screenshot('02-stale-state-holds-last-pose');
    return { pageSingleFrameStatus: 202, simulatorPosts: report.requests.filter(r => r.method === 'POST').length - countBefore,
      staleLabel: await telemetryValue('boom_length_m').innerText(), heldStateUnchanged: true };
  });
  await check('closed-editor-and-animation-follow-latest-pose', async () => {
    const length = (await renderedState(craneId)).parameters.boom_length_m * 1.02;
    await action('close').click(); await panel().waitFor({ state: 'hidden' });
    await postFrame(craneId, { boom_length_m: length }); await waitParameter(craneId, 'boom_length_m', length);
    await page.locator('.tab[data-tab="rail-safety"]').click();
    const railPanel = page.locator('.rail-safety-panel');
    await railPanel.waitFor({ state: 'visible' });
    await railPanel.locator('[data-action="tab-machine"]').click();
    await railPanel.locator('[data-role="selection"]').selectOption(craneId); await settled(craneId);
    await railPanel.locator('[data-action="fall-start"]').click();
    await page.waitForFunction(() => { const s = window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo; return s.active && !s.loading && s.modelCreated && !s.error; }, undefined, { timeout: 60000 });
    const demoBefore = await renderedState(craneId); assert(demoBefore.fallDemo.active);
    await postFrame(craneId, { boom_length_m: length * 1.03 }); await waitParameter(craneId, 'boom_length_m', length * 1.03);
    assert.equal((await renderedState(craneId)).fallDemo.active, false, 'A new live pose cancels obsolete demonstration');
    await railPanel.locator('[data-action="fall-start"]').click();
    await page.waitForFunction(() => { const s = window.__managementWorkspace.railSafety.scene.getSnapshot().fallDemo; return s.active && !s.loading && s.modelCreated; }, undefined, { timeout: 60000 });
    await railPanel.locator('[data-action="fall-stop"]').click(); await settled(craneId);
    await selectMachine(craneId); await openTelemetry();
    return { closedEditorStillUpdates: true, obsoleteAnimationStopped: true, restartFromLatestPose: true };
  });
  await check('pile-height-and-multiple-machine-isolation', async () => {
    const craneBefore = await renderedState(craneId), pileBefore = await saved(pileId);
    await selectMachine(pileId); await openTelemetry(); await bindFields(['total_height_m']);
    const height = pileBefore.parameters.total_height_m * 1.35;
    await postFrame(pileId, { total_height_m: height, longitude: 118, heading: 90 });
    await waitParameter(pileId, 'total_height_m', height);
    const pile = await renderedState(pileId), crane = await renderedState(craneId);
    assert.deepEqual(crane.live, craneBefore.live, 'Pile packets cannot change the crane');
    assert.deepEqual(pile.live.placement, pileBefore.placement); assert.equal(pile.parameters.overall_scale, pileBefore.parameters.overall_scale);
    assert.deepEqual(pile.live, pile.railLive); assert.deepEqual(await saved(pileId), pileBefore);
    await screenshot('03-pile-independent-height');
    return { height, preservedScale: pile.parameters.overall_scale, craneUnchanged: true, pileUnboundPlacementPreserved: true };
  });
  await check('disable-and-single-viewer-with-no-background-traffic', async () => {
    const finalPile = await renderedState(pileId);
    await action('telemetry-disable').click(); await page.waitForFunction(() => window.__managementWorkspace.machinery.hasDraft);
    await save(); await settled(pileId);
    assert.equal((await saved(pileId)).parameters.total_height_m, finalPile.parameters.total_height_m);
    await selectMachine(craneId); await openTelemetry();
    const finalCrane = await renderedState(craneId);
    await action('telemetry-disable').click(); await page.waitForFunction(() => window.__managementWorkspace.machinery.hasDraft);
    await save(); await settled(craneId);
    assert.equal((await saved(craneId)).parameters.boom_length_m, finalCrane.parameters.boom_length_m);
    await page.waitForTimeout(300); const requests = report.requests.length; await page.waitForTimeout(1400);
    assert.equal(report.requests.length, requests, 'Disabling all bindings stops polling and simulation');
    const identity = await page.evaluate(() => { const w = window.__managementWorkspace; return {
      sameViewer: window.__safetyWorkspace.getManagementViewer() === w.viewer,
      machinerySources: w.viewer.dataSources._dataSources.filter(s => s.name === '施工机械').length,
      machineryCount: w.machinery.scene.rendered.size, modelTasks: w.machinery.scene.tasks.size,
      liveCount: w.machinery.scene.liveStates.size, railLiveCount: w.railSafety.scene.liveStates.size,
      renderLoop: w.viewer.useDefaultRenderLoop,
    }; });
    assert.deepEqual(identity, { sameViewer: true, machinerySources: 1, machineryCount: 2, modelTasks: 0, liveCount: 0, railLiveCount: 0, renderLoop: true });
    assert.equal(await page.locator('#cesiumContainer canvas').count(), 1); assert.deepEqual(report.pageErrors, []);
    return { preservedFinalValuesAfterManualSave: true, trafficStopped: true, identity };
  });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1;
  if (activeCheck?.status === 'running') { activeCheck.status = 'failed'; activeCheck.error = report.failure; }
  console.error(error);
  if (page) { report.failureInputStates = await panel().locator('[data-placement]').evaluateAll(inputs => inputs.map(el => ({ key: el.dataset.placement, value: el.value, disabled: el.disabled, rect: el.getBoundingClientRect().toJSON() }))).catch(() => []); await screenshot('failure').catch(() => {}); report.failureVisibleText = (await panel().innerText().catch(() => '')).slice(-7000); }
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  await context?.close(); await browser?.close(); await server?.close();
}
