/**
 * End-to-end acceptance from the ORIGINAL workbench at `/`.
 * Starts Vite and Chromium in the same process/network namespace, using a fresh
 * isolated project database and the shipped machinery assets. No production
 * project data is read or changed. Run from the repository root.
 *
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/absolute/path/to/launch_options.mjs \
 * node tools/verify-machinery-workbench.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.MACHINERY_VERIFY_OUT || 'output/machinery-workbench');
await mkdir(output, { recursive: true });
await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/machinery-workbench-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;

const definitions = [
  ['root-entry', 'Open the original workbench at / without a fullscreen management redirect'],
  ['create-crane', 'Create, place and save a crane from the original machinery menu'],
  ['create-pile', 'Create, place and save a piling rig from the original machinery menu'],
  ['create-excavator', 'Create, place and save an excavator from the original machinery menu'],
  ['background-isolation', 'Hidden management refresh and machinery saves preserve the original scene camera and render loop'],
  ['cross-tabs', 'Saved machinery remains visible when switching to CAD and photogrammetry'],
  ['object-visibility', 'The original object list changes visibility of the same persisted instance'],
  ['object-locate', 'The original object list locates the same existing instance'],
  ['object-edit', 'The original object list edits its existing resource without duplication'],
  ['draft-navigation', 'A machinery draft blocks a workbench tab change until discarded'],
  ['management-roundtrip', 'Management scene edits are reflected in the original workbench'],
  ['single-runtime', 'The workbench and management share one Viewer, panel and machinery scene'],
  ['markup-draft-navigation', 'A one-point markup draft survives a rejected switch to machinery'],
  ['root-reload', 'Reloading / restores exact saved dimensions, placements and visibility'],
  ['invalid-session', 'A revoked authenticated session clears instances, picking and drafts'],
];
const report = {
  classification: 'actual-original-workbench-ui-with-isolated-data',
  startedAt: new Date().toISOString(),
  dataDir,
  checks: definitions.map(([id, title]) => ({ id, title, status: 'pending' })),
  screenshots: [], screenshotErrors: [], pageErrors: [], consoleErrors: [],
};
let server, browser, page, activeCheck;
const resources = [];

// Keep the workbench-specific selectors in one place; these are product controls,
// not controls injected by the test. Only state observation uses the DEV bridge.
const selectors = {
  machineryTab: '.tab[data-tab="machinery"]',
  cadTab: '.tab[data-tab="cad"]',
  tilesTab: '.tab[data-tab="tiles"]',
  objectRow: id => `[data-machinery-record="${id}"]`,
  rowAction: (id, action) => `[data-machinery-record="${id}"] [data-machinery-action="${action}"]`,
};
const panel = () => page.locator('.machinery-panel');
const panelAction = action => panel().locator(`[data-action="${action}"]`);
const parameter = key => panel().locator(`[data-parameter="${key}"]`);
const coordinate = key => panel().locator(`[data-placement="${key}"]`);

async function check(id, run, continueOnFailure = false) {
  activeCheck = report.checks.find(item => item.id === id);
  activeCheck.status = 'running'; activeCheck.startedAt = new Date().toISOString();
  console.log('RUN', id);
  let evidence;
  try { evidence = await run(); }
  catch (error) {
    if (!continueOnFailure) throw error;
    activeCheck.status = 'failed'; activeCheck.error = String(error.stack || error);
    report.failure ||= activeCheck.error; process.exitCode = 1;
    console.error('FAIL', id, error); return;
  }
  activeCheck.status = 'passed'; activeCheck.finishedAt = new Date().toISOString();
  if (evidence !== undefined) activeCheck.evidence = evidence;
  console.log('PASS', id);
}
async function screenshot(name) {
  const path = resolve(output, name + '.png');
  try {
    await page.screenshot({ path, fullPage: false, timeout: 20000 }); report.screenshots.push(path);
  } catch (error) {
    report.screenshotErrors.push({ name, check: activeCheck?.id, message: String(error.message || error) });
    console.warn('SCREENSHOT_UNAVAILABLE', name, error.message || error);
  }
}

// The integration DEV bridge is deliberately read rather than used to perform
// resource creation, editing or navigation. Those operations click actual UI.
async function runtimeState() {
  return page.evaluate(() => {
    const runtime = window.__managementWorkspace, scene = runtime.machinery.scene;
    return {
      renderedIds: [...scene.rendered.keys()],
      visibleIds: [...scene.rendered.entries()].filter(([, item]) => item.entity.show).map(([id]) => id),
      sceneVisible: scene.source.show,
      workbench: runtime.getWorkbenchMachineryState(),
      useDefaultRenderLoop: runtime.viewer.useDefaultRenderLoop,
    };
  });
}
async function snapshot() {
  return page.evaluate(() => window.__managementWorkspace.ui.getSnapshot());
}
async function ready() {
  await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId,
    undefined, { timeout: 60000 });
}
async function panelReady(assetId) {
  await panel().waitFor({ state: 'visible' });
  await page.waitForFunction(id => {
    const p = window.__managementWorkspace.machinery;
    return p?.asset && !p.loading && !p.busy && (!id || p.asset.id === id);
  }, assetId, { timeout: 30000 });
}
async function settled() {
  await page.waitForFunction(() => {
    const p = window.__managementWorkspace.machinery;
    return !p.busy && !p.loading && p.previewTimer === undefined;
  }, undefined, { timeout: 30000 });
}
async function save() {
  const responsePromise = page.waitForResponse(response => {
    if (!response.url().endsWith('/__management/commands')) return false;
    try { return response.request().postDataJSON()?.type === 'machinery.save'; } catch { return false; }
  });
  await panelAction('save').click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  await page.waitForFunction(() => !window.__managementWorkspace.machinery.busy && !window.__managementWorkspace.machinery.hasDraft);
}
async function modelsReady(ids) {
  await page.waitForFunction(expected => {
    const rendered = window.__managementWorkspace.machinery.scene.rendered;
    return expected.every(id => rendered.has(id));
  }, ids, { timeout: 30000 });
}
async function recordsById() {
  return (await snapshot()).collections.resources.filter(record => resources.includes(record.id))
    .map(record => ({ id: record.id, revision: record.revision, machinery: record.machinery }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
async function post(path, body, method = 'POST') {
  return page.evaluate(async ({ path, body, method }) => {
    const response = await fetch(path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }, { path, body, method });
}

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const launchOptions = process.env.BROWSER_LAUNCH_OPTIONS
    ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined };
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string', 'Vite did not expose its local listening port');
  const origin = `http://127.0.0.1:${address.port}`;
  report.origin = origin;
  browser = await chromium.launch(launchOptions);
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push({ check: activeCheck?.id, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ check: activeCheck?.id, message: message.text().slice(0, 500) }); });

  await check('root-entry', async () => {
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await ready();
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).searchParams.get('screen'), null);
    assert.equal(await page.locator('.management-studio:visible').count(), 0);
    assert.equal(await page.evaluate(() => window.__managementWorkspace.viewer.useDefaultRenderLoop), true,
      'Constructing the hidden management workspace disabled the original Viewer render loop');
    await page.evaluate(async () => {
      const C = await import('/node_modules/.vite/deps/cesium.js');
      const v = window.__managementWorkspace.viewer;
      // A real Cesium data source used only as a synthetic project-content probe.
      // It is not a production model and is never persisted in a project library.
      const source = new C.CustomDataSource('验收哨兵 · 模拟工程内容');
      source.entities.add({ id: 'workbench-acceptance-project-entity', position: C.Cartesian3.fromDegrees(116.3908, 39.907, .125), box: { dimensions: new C.Cartesian3(.25, .25, .25), material: C.Color.CYAN, outline: false } });
      await v.dataSources.add(source); window.__machineryProjectSentinel = source;
    });
    await page.evaluate(() => {
      const v = window.__managementWorkspace.viewer;
      const xyz = p => [p.x, p.y, p.z];
      window.__machineryOriginalScene = {
        camera: { position: xyz(v.camera.positionWC), direction: xyz(v.camera.directionWC), up: xyz(v.camera.upWC) },
        renderLoop: v.useDefaultRenderLoop,
        primitives: Array.from({ length: v.scene.primitives.length }, (_, i) => {
          const value = v.scene.primitives.get(i); return { value, show: value.show };
        }),
        sources: v.dataSources._dataSources.filter(source => source.name !== '施工机械').map(value => ({ value, show: value.show })),
        imagery: Array.from({ length: v.imageryLayers.length }, (_, i) => {
          const value = v.imageryLayers.get(i); return { value, show: value.show };
        }),
      };
    });
    await page.locator(selectors.machineryTab).click();
    await panel().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.management-studio:visible').count(), 0);
    const editorActivation = await page.evaluate(() => {
      const v = window.__managementWorkspace.viewer, baseline = window.__machineryOriginalScene;
      const changes = baseline.sources.filter(item => !v.dataSources.contains(item.value) || item.value.show !== item.show)
        .map(item => ({ name: item.value.name, before: item.show, after: item.value.show, stillPresent: v.dataSources.contains(item.value), entityCount: item.value.entities?.values.length }));
      // Opening the editor intentionally suspends other authoring tools. Record
      // those changes separately; save/refresh isolation starts after this UI action.
      baseline.sources = v.dataSources._dataSources.filter(source => source.name !== '施工机械').map(value => ({ value, show: value.show }));
      return { sourceChanges: changes, syntheticProjectSourcePreserved: v.dataSources.contains(window.__machineryProjectSentinel)
        && window.__machineryProjectSentinel.show && window.__machineryProjectSentinel.entities.values.length === 1 };
    });
    assert.equal(editorActivation.syntheticProjectSourcePreserved, true);
    await page.evaluate(() => { window.__machineryAcceptanceViewer = window.__managementWorkspace.viewer; window.__machineryAcceptancePanel = window.__managementWorkspace.machinery; });

    return { url: page.url(), canvasCount: await page.locator('#cesiumContainer canvas').count(), editorActivation,
      fixtureNote: 'The project-content sentinel is a synthetic real Cesium CustomDataSource; no production imports or videos are used.' };
  });

  for (const [index, assetId] of ['crane', 'pile', 'excavator'].entries()) {
    await check('create-' + assetId, async () => {
      const name = `工作台验收-${assetId}-${Date.now()}`;
      await panel().locator('[data-role="create-name"]').fill(name); await panelAction('create').click();
      await page.waitForFunction(name => {
        const runtime = window.__managementWorkspace;
        return runtime.ui.getSnapshot()?.collections.resources.some(record => record.name === name) && !runtime.machinery.busy && !runtime.machinery.loading;
      }, name, { timeout: 30000 });
      const record = (await snapshot()).collections.resources.find(item => item.name === name);
      assert(record, 'The UI-created equipment resource is absent from the server snapshot'); resources.push(record.id);
      await panel().locator('[data-role="asset"]').selectOption(assetId); await panelReady(assetId);
      assert.equal(await coordinate('longitude').inputValue(), '', 'An unplaced resource must not silently default to longitude zero');
      const scale = assetId === 'excavator' ? 1 : 4;
      await parameter('overall_scale').fill(String(scale));
      for (const [key, value] of Object.entries({ longitude: 116.391 + index * .00015, latitude: 39.907, height: 0, heading: index * 90 })) await coordinate(key).fill(String(value));
      await save(); await modelsReady(resources);
      const stored = (await snapshot()).collections.resources.find(item => item.id === record.id);
      assert.equal(stored.machinery.assetId, assetId); assert.equal(stored.machinery.parameters.overall_scale, scale);
      assert.equal(stored.machinery.placement.heading, index * 90); assert.equal(stored.machinery.visible, true);
      assert.equal(await page.locator(selectors.objectRow(record.id)).count(), 1, 'Each saved equipment instance must appear exactly once in the original object list');
      return { recordId: record.id, machinery: stored.machinery };
    });
  }

  await check('background-isolation', async () => {
    await page.evaluate(() => window.__managementWorkspace.refreshMachineryContext()); await ready();
    const evidence = await page.evaluate(() => {
      const v = window.__managementWorkspace.viewer, original = window.__machineryOriginalScene;
      const xyz = p => [p.x, p.y, p.z];
      const close = (a, b) => a.every((value, index) => Math.abs(value - b[index]) < 1e-7);
      return {
        renderLoopUnchanged: v.useDefaultRenderLoop === original.renderLoop && v.useDefaultRenderLoop,
        cameraUnchanged: close(original.camera.position, xyz(v.camera.positionWC))
          && close(original.camera.direction, xyz(v.camera.directionWC)) && close(original.camera.up, xyz(v.camera.upWC)),
        primitivesUnchanged: original.primitives.every(item => v.scene.primitives.contains(item.value) && item.value.show === item.show),
        sourcesUnchanged: original.sources.every(item => v.dataSources.contains(item.value) && item.value.show === item.show),
        imageryUnchanged: original.imagery.every(item => v.imageryLayers.contains(item.value) && item.value.show === item.show),
        originalCounts: { primitives: original.primitives.length, sources: original.sources.length, imagery: original.imagery.length },
        sourceDetails: original.sources.map(item => ({ name: item.value.name, stillPresent: v.dataSources.contains(item.value), before: item.show, after: item.value.show, entityCount: item.value.entities?.values.length })),
        syntheticProjectSourcePreserved: v.dataSources.contains(window.__machineryProjectSentinel)
          && window.__machineryProjectSentinel.show && window.__machineryProjectSentinel.entities.values.length === 1,
        cameraBefore: original.camera,
        cameraAfter: { position: xyz(v.camera.positionWC), direction: xyz(v.camera.directionWC), up: xyz(v.camera.upWC) },
      };
    });
    activeCheck.evidence = evidence;
    assert.equal(evidence.renderLoopUnchanged, true); assert.equal(evidence.cameraUnchanged, true);
    assert.equal(evidence.primitivesUnchanged, true); assert.equal(evidence.sourcesUnchanged, true); assert.equal(evidence.imageryUnchanged, true);
    assert.equal(evidence.syntheticProjectSourcePreserved, true);
    return evidence;
  }, true);

  await check('cross-tabs', async () => {
    await panelAction('close').click();
    const initial = await runtimeState();
    for (const [name, selector] of [['CAD', selectors.cadTab], ['photogrammetry', selectors.tilesTab]]) {
      await page.locator(selector).click(); await modelsReady(resources);
      const current = await runtimeState();
      assert.equal(current.sceneVisible, true, `${name} hid the saved machinery data source`);
      assert.deepEqual(current.renderedIds.slice().sort(), initial.renderedIds.slice().sort());
      assert(resources.every(id => current.visibleIds.includes(id)), `${name} hid a saved visible instance`);
    }

    return await runtimeState();
  });

  await check('object-visibility', async () => {
    const id = resources[0];
    await page.locator(selectors.rowAction(id, 'visibility')).click();
    await page.waitForFunction(id => window.__managementWorkspace.ui.getSnapshot().collections.resources.find(record => record.id === id)?.machinery?.visible === false, id);
    assert(!(await runtimeState()).visibleIds.includes(id));
    await page.locator(selectors.rowAction(id, 'visibility')).click();
    await page.waitForFunction(id => window.__managementWorkspace.ui.getSnapshot().collections.resources.find(record => record.id === id)?.machinery?.visible === true, id);
    await modelsReady(resources); assert((await runtimeState()).visibleIds.includes(id));
    assert.equal(await page.locator(selectors.objectRow(id)).count(), 1);
    return { recordId: id, visible: true };
  });

  await check('object-locate', async () => {
    const before = await page.evaluate(() => { const p = window.__managementWorkspace.viewer.camera.positionWC; return [p.x, p.y, p.z]; });
    await page.locator(selectors.rowAction(resources[0], 'locate')).click();
    await page.waitForTimeout(1400);
    const after = await page.evaluate(() => { const p = window.__managementWorkspace.viewer.camera.positionWC; return [p.x, p.y, p.z]; });
    assert(after.every(Number.isFinite)); assert.notDeepEqual(after, before);
    assert.equal((await runtimeState()).renderedIds.length, 3);
    return { cameraPosition: after };
  });

  await check('object-edit', async () => {
    const id = resources[0], beforeCount = (await snapshot()).collections.resources.length;
    await page.locator(selectors.rowAction(id, 'edit')).click(); await panelReady('crane');
    assert.equal(await panel().locator('[data-role="resource"]').inputValue(), id);
    await parameter('overall_scale').fill('5'); await save();
    assert.equal((await snapshot()).collections.resources.length, beforeCount);
    assert.equal((await snapshot()).collections.resources.find(record => record.id === id).machinery.parameters.overall_scale, 5);
    await panelAction('locate').click(); await page.waitForTimeout(1400);
    await page.locator('#basemap').selectOption('none');
    await page.evaluate(() => document.fonts.ready);
    // Compose an evidence view of the isolated test coordinate. This is camera
    // positioning only; the UI-created model and its dimensions are unchanged.
    await page.evaluate(async id => {
      const C = await import('/node_modules/.vite/deps/cesium.js');
      const runtime = window.__managementWorkspace, v = runtime.viewer;
      const machinery = runtime.ui.getSnapshot().collections.resources.find(record => record.id === id).machinery;
      const height = machinery.parameters.overall_height_m ?? machinery.parameters.total_height_m;
      v.camera.lookAt(C.Cartesian3.fromDegrees(machinery.placement.longitude, machinery.placement.latitude, machinery.placement.height + height * .45),
        new C.HeadingPitchRange(-.7, -.3, Math.max(45, height * 2.6)));
      v.camera.lookAtTransform(C.Matrix4.IDENTITY); v.scene.requestRender();
    }, id);
    await panel().locator('.mp-content').evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(500); await screenshot('04-root-crane-edit-located-isolated-scene');
    return { recordId: id, resourceCount: beforeCount, overallScale: 5 };
  });

  await check('draft-navigation', async () => {
    await parameter('overall_scale').fill('6'); await settled();
    assert.equal(await page.evaluate(() => window.__managementWorkspace.machinery.hasDraft), true);
    await page.locator(selectors.cadTab).click();
    assert.equal(await page.locator(selectors.cadTab).evaluate(element => element.classList.contains('active')), false, 'CAD became active despite an unsaved machinery draft');
    assert.equal(await panel().isVisible(), true);
    assert.equal(await parameter('overall_scale').inputValue(), '6');
    const selected = await panel().locator('[data-role="resource"]').inputValue();
    const markupBefore = await page.evaluate(() => ({
      cancelDisabled: document.querySelector('#markupCancelDrawing').disabled,
      drafts: window.__managementWorkspace.viewer.entities.values.filter(entity => entity.id.startsWith('markup-draft')).map(entity => entity.id),
    }));
    await page.locator('.tab[data-tab="markup"]').click();
    assert.equal(await page.locator('.tab[data-tab="markup"]').evaluate(element => element.classList.contains('active')), false);
    assert.equal(await panel().locator('[data-role="resource"]').inputValue(), selected);
    assert.equal(await parameter('overall_scale').inputValue(), '6');
    assert.deepEqual(await page.evaluate(() => ({
      cancelDisabled: document.querySelector('#markupCancelDrawing').disabled,
      drafts: window.__managementWorkspace.viewer.entities.values.filter(entity => entity.id.startsWith('markup-draft')).map(entity => entity.id),
    })), markupBefore, 'The rejected tab click changed the markup interaction before navigation was blocked');
    assert.equal((await snapshot()).collections.resources.find(record => record.id === resources[0]).machinery.parameters.overall_scale, 5);
    await panelAction('cancel').click(); await panelReady('crane');
    assert.equal(await parameter('overall_scale').inputValue(), '5');
    await page.locator(selectors.cadTab).click();
    assert.equal(await page.locator(selectors.cadTab).evaluate(element => element.classList.contains('active')), true);
    return { savedScale: 5, rejectedDraftScale: 6, rejectedTabs: ['cad', 'markup'], selectedResourcePreserved: selected };
  });

  await check('management-roundtrip', async () => {
    await page.locator('#openSafetyWorkspace').click();
    await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot() && !window.__managementWorkspace.ui.loading, undefined, { timeout: 60000 });
    await page.locator('[data-mg-action="mode-scene"]:visible').first().click();
    await page.locator('[data-mg-action="machinery"]:visible').click();
    await panel().locator('[data-role="resource"]').selectOption(resources[0]); await panelReady('crane');
    assert.equal(Number(await parameter('overall_scale').inputValue()), 5);
    await parameter('overall_scale').fill('7'); await save();

    await panelAction('close').click();
    // The original-workbench exit is in the management navigation, which is
    // hidden in scene mode. Use both real controls instead of a hidden click.
    await page.locator('[data-mg-action="mode-management"]:visible').first().click();
    await page.locator('[data-mg-action="exit"]:visible').first().click();
    await page.locator('.management-studio').waitFor({ state: 'hidden' });
    await page.locator(selectors.rowAction(resources[0], 'edit')).click(); await panelReady('crane');
    assert.equal(Number(await parameter('overall_scale').inputValue()), 7);
    assert.equal((await snapshot()).collections.resources.find(record => record.id === resources[0]).machinery.parameters.overall_scale, 7);
    return { recordId: resources[0], overallScale: 7 };
  });

  await check('single-runtime', async () => {
    const identity = await page.evaluate(() => ({
      sameViewer: window.__machineryAcceptanceViewer === window.__managementWorkspace.viewer,
      samePanel: window.__machineryAcceptancePanel === window.__managementWorkspace.machinery,
      safetySameViewer: window.__safetyWorkspace.getManagementViewer() === window.__managementWorkspace.viewer,
      sourceCount: window.__managementWorkspace.viewer.dataSources._dataSources.filter(source => source.name === '施工机械').length,
    }));
    assert.deepEqual(identity, { sameViewer: true, samePanel: true, safetySameViewer: true, sourceCount: 1 });
    assert.equal(await page.locator('.machinery-panel').count(), 1); assert.equal(await page.locator('#cesiumContainer canvas').count(), 1);
    const current = await runtimeState(); assert.equal(new Set(current.renderedIds).size, 3); assert.equal(current.renderedIds.length, 3);
    return identity;
  });

  await check('markup-draft-navigation', async () => {
    await page.locator('.tab[data-tab="markup"]').click();
    await page.locator('[data-markup-draw="polyline"]').click();
    const canvas = page.locator('#cesiumContainer canvas'), rect = await canvas.boundingBox();
    assert(rect, 'The existing Cesium canvas has no bounds');
    await page.mouse.click(rect.x + rect.width * .45, rect.y + rect.height * .65);
    await page.waitForFunction(() => window.__managementWorkspace.viewer.entities.values.some(entity => entity.id.startsWith('markup-draft-vertex-')));
    const before = await page.evaluate(() => ({
      ids: window.__managementWorkspace.viewer.entities.values.filter(entity => entity.id.startsWith('markup-draft')).map(entity => entity.id),
      state: document.querySelector('#markupDrawState').textContent,
      cancelDisabled: document.querySelector('#markupCancelDrawing').disabled,
    }));
    assert.equal(before.ids.filter(id => id.startsWith('markup-draft-vertex-')).length, 1);
    await page.locator(selectors.machineryTab).click();
    assert.equal(await page.locator('.tab[data-tab="markup"]').evaluate(element => element.classList.contains('active')), true);
    assert.equal(await page.evaluate(() => window.__managementWorkspace.machinery.isOpen), false);
    assert.deepEqual(await page.evaluate(() => ({
      ids: window.__managementWorkspace.viewer.entities.values.filter(entity => entity.id.startsWith('markup-draft')).map(entity => entity.id),
      state: document.querySelector('#markupDrawState').textContent,
      cancelDisabled: document.querySelector('#markupCancelDrawing').disabled,
    })), before);

    await page.locator('#markupCancelDrawing').click();
    await page.locator(selectors.machineryTab).click(); await panelReady();
    await panelAction('close').click();
    const evidence = { preservedDraftEntityIds: before.ids, pointCount: 1, renderLoopActive: null };
    evidence.renderLoopActive = await page.evaluate(() => window.__managementWorkspace.viewer.useDefaultRenderLoop);
    activeCheck.evidence = evidence;
    assert.equal(evidence.renderLoopActive, true, 'The real markup vertex stopped the browser renderer; inspect consoleErrors for software GPU limitations.');
    return evidence;
  }, true);

  await check('root-reload', async () => {
    const before = await recordsById();
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await ready(); await modelsReady(resources);
    assert.equal(await page.locator('.management-studio:visible').count(), 0);
    assert.deepEqual(await recordsById(), before);
    for (const id of resources) assert.equal(await page.locator(selectors.objectRow(id)).count(), 1);
    assert.equal(await page.locator('.machinery-panel').count(), 1); assert.equal(await page.locator('#cesiumContainer canvas').count(), 1);
    return before;
  });

  await check('invalid-session', async () => {
    // Bootstrap a test-only authenticated owner; unlike local-owner mode, its
    // session can be revoked and then presented as a genuinely invalid token.
    const username = 'workbench-acceptance-owner', password = 'Workbench-Test-' + crypto.randomUUID();
    const boot = await post('/__management/commands', { projectId: 'safety:project', type: 'member.save', idempotencyKey: crypto.randomUUID(), payload: { username, displayName: '验收专用账号', password, roles: ['owner'] } });
    assert.equal(boot.status, 200, JSON.stringify(boot.body));
    await page.evaluate(() => window.__managementWorkspace.refreshMachineryContext()); await ready();
    assert.equal((await snapshot()).session.authMode, 'local-account');
    await page.locator(selectors.rowAction(resources[0], 'edit')).click(); await panelReady('crane');
    await parameter('overall_scale').fill('8'); await settled(); await panelAction('pick').click();
    assert.equal(await page.evaluate(() => window.__managementWorkspace.machinery.isPicking), true);
    const cookies = await page.context().cookies(origin); assert(cookies.length, 'Authenticated session cookie was not set');
    const revoked = await post('/__management/session', undefined, 'DELETE'); assert.equal(revoked.status, 200);
    await page.context().addCookies(cookies);
    const rejected = await page.evaluate(async () => { const r = await fetch('/__management/session'); return r.status; });
    assert.equal(rejected, 401, 'The test must revoke an actual authenticated session');
    await page.evaluate(() => window.__managementWorkspace.refreshMachineryContext());
    await page.waitForFunction(() => {
      const runtime = window.__managementWorkspace, panel = runtime.machinery;
      return !runtime.ui.getSnapshot() && panel.scene.rendered.size === 0 && !panel.hasDraft && !panel.isPicking;
    });
    assert.equal(await page.locator('[data-machinery-record]').count(), 0);

    return { sessionHttpStatus: rejected, state: await runtimeState() };
  });

  assert.deepEqual(report.pageErrors, [], 'Unexpected uncaught browser errors occurred');
  report.result = report.checks.every(item => item.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error);
  if (activeCheck?.status === 'running') { activeCheck.status = 'failed'; activeCheck.error = report.failure; }
  for (const item of report.checks) if (item.status === 'pending') { item.status = 'skipped'; item.reason = 'Execution stopped before this check; no pass claim.'; }
  console.error(error);
  if (page) {
    await screenshot('failure').catch(() => {});
    report.failureVisibleText = (await page.locator('body').innerText().catch(() => '')).slice(-5000);
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser?.close(); await server?.close();
}
