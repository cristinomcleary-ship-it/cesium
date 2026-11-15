/** Real Cesium lifecycle acceptance using generated Tiles/GLB only.
 * Default launch uses software WebGL and reports that limitation explicitly.
 * PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE / BROWSER_LAUNCH_OPTIONS can select a
 * local hardware launcher; ROUND1_REQUIRE_HARDWARE=1 rejects software results.
 * Restricted launch/WebGL is blocked (exit 2), never passed. No production data.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.ROUND1_BROWSER_OUT || 'output/round1-scene-lifecycle-browser');
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(join(output, 'synthetic-data-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const require = createRequire(import.meta.url);
const report = { classification: 'real-cesium-synthetic-tiles-model-lifecycle', startedAt: new Date().toISOString(),
  execution: 'not-started', passed: false, productionDataReadOrModified: false, checks: [], pageErrors: [], consoleErrors: [], screenshots: [] };
let server, browser, page, initialized = false;
const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.__round1SceneLifecycle[method](...args), { method, args });
const capture = async name => { const path = join(output, name + '.png'); await page.screenshot({ path }); report.screenshots.push(path); };
const check = async (name, operation) => {
  console.log('RUN', name); const item = { name, status: 'running' }; report.checks.push(item);
  try { item.evidence = await operation(); item.status = 'passed'; console.log('PASS', name); }
  catch (error) { item.status = 'failed'; item.error = String(error); throw error; }
};
const unclipped = state => {
  for (const key of ['tiles', 'engineering', 'globe']) {
    assert.equal(state[key].planes?.enabled && state[key].planes.length > 0 || false, false, `${key} planes remained active`);
    assert.equal(state[key].polygons?.enabled && state[key].polygons.length > 0 || false, false, `${key} polygons remained active`);
  }
  assert.equal(state.surfacePrimitives.some(primitive => primitive.show), false, 'new surface meshes remained visible');
};
const restoredContributions = state => {
  assert.equal(state.surface.photographyClips, 2, 'temporary and surface contributors must both return');
  assert.equal(state.surface.states['round1-surface'].state, 'ready');
  assert.equal(state.surface.terrainEnabled, true);
  assert.equal(state.engineering.planes, null); assert.equal(state.engineering.polygons, null);
};
try {
  const modulePath = process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
    ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
  const { chromium } = require(modulePath);
  const customLauncher = process.env.BROWSER_LAUNCH_OPTIONS;
  const options = customLauncher ? (await import(pathToFileURL(resolve(customLauncher)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
  report.launchMode = customLauncher ? 'custom launcher; renderer checked below' : 'software WebGL requested';
  browser = await chromium.launch(options);
  server = await createServer({ optimizeDeps: { entries: ['tools/fixtures/round1-scene-lifecycle.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen();
  report.origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(60000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(report.origin + '/tools/fixtures/round1-scene-lifecycle.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__round1SceneLifecycle?.ready || window.__round1SceneLifecycle?.failure);
  const failure = await page.evaluate(() => window.__round1SceneLifecycle.failure);
  if (failure) throw new Error(failure);
  report.gpu = await invoke('gpu');
  report.gpuClassification = /swiftshader|llvmpipe|software/i.test(report.gpu.renderer) ? 'software WebGL'
    : /NVIDIA|AMD|Radeon|Intel|Apple|Adreno|Mali/i.test(report.gpu.renderer) ? 'reported hardware WebGL (not independently certified)' : 'unidentified WebGL renderer';
  if (process.env.ROUND1_REQUIRE_HARDWARE === '1' && !report.gpuClassification.startsWith('reported hardware'))
    throw new Error('BLOCKED: hardware acceptance requested but renderer is software or unidentified');
  initialized = true; report.execution = 'running';
  const baseline = await invoke('state'); await capture('synthetic-original');
  await check('new-surface-and-temporary-contributions-share-real-tiles', async () => {
    const state = await invoke('setupContributions'); restoredContributions(state);
    assert.deepEqual(state.renderErrors, []); await capture('managed-contributions');
    return { photographyPolygons: state.surface.photographyClips, primitiveCount: state.primitiveCount };
  });
  for (const mode of ['section', 'pit']) {
    await check(`legacy-${mode}-nested-ar-depth-handoff-and-current-state-restore`, async () => {
      await invoke('groundMode', true); const before = await invoke('legacy', mode);
      for (const key of ['tiles', 'engineering']) assert.equal(before[key][mode === 'section' ? 'planes' : 'polygons']?.length, 1);
      if (mode === 'section') assert.equal(before.globe.planes?.length, 1);
      assert.equal(before.surface.states['round1-surface'].state, 'blocked');
      await capture(`${mode}-before-ar`);
      const suspended = await invoke('acquire', 'panel'); unclipped(suspended);
      assert.equal(suspended.leases, 1); assert.deepEqual(suspended.controls, before.controls);
      assert.ok(suspended.releasedCollections.length >= 2); assert.ok(suspended.releasedCollections.every(item => item.destroyed));
      assert.deepEqual(suspended.ground, baseline.ground, 'map-only ground settings must be released during AR');
      const nested = await invoke('acquire', 'pending-render'); assert.equal(nested.leases, 2); unclipped(nested);
      const depth = await invoke('beginOcclusion'); assert.equal(depth.occluder.ready, true); assert.equal(depth.shaderPresent, true);
      assert.equal(depth.occluder.error, undefined); await capture(`${mode}-ar-depth-owner`);
      const partial = await invoke('release', 'panel'); assert.equal(partial.leases, 1); unclipped(partial);
      assert.equal(partial.occluder.error, undefined);
      await invoke('endOcclusion');
      const restored = await invoke('release', 'pending-render'); assert.equal(restored.leases, 0);
      assert.deepEqual(restored.controls, before.controls); assert.deepEqual(restored.ground, before.ground);
      for (const key of ['tiles', 'engineering', 'globe']) assert.deepEqual(restored[key], before[key], `${key} parameters changed after ${mode} handoff`);
      assert.equal(restored.shaderPresent, false); assert.deepEqual(restored.renderErrors, []);
      const cuts = await invoke('legacy', 'none'); restoredContributions(cuts);
      await invoke('groundMode', false); await capture(`${mode}-restored-managed-cuts`);
      return { oldOwnerDetachedAndDestroyed: true, realOccluderReady: depth.occluder.ready, nestedOwners: 2,
        originalParametersRestored: true, managedContributionsRestored: cuts.surface.photographyClips };
    });
  }
  await check('release-uses-controls-edited-during-suspension', async () => {
    await invoke('legacy', 'section'); await invoke('acquire', 'edit');
    const edited = await invoke('editWhileSuspended'); unclipped(edited);
    const restored = await invoke('release', 'edit');
    assert.equal(restored.tiles.planes.distance, -19); assert.deepEqual(restored.tiles.planes.normal, [0, 1, 0]);
    assert.equal(restored.controls.sectionOffset, '19'); assert.equal(restored.controls.sectionInvert, false);
    restoredContributions(await invoke('legacy', 'none')); return { currentOffset: 19, staleSnapshotNotRestored: true };
  });
  await check('repeated-legacy-ar-cycles-keep-gpu-owners-and-contributions-stable', async () => {
    const start = await invoke('state');
    for (let iteration = 0; iteration < 4; iteration++) {
      await invoke('legacy', iteration % 2 ? 'pit' : 'section');
      await invoke('acquire', 'cycle'); assert.equal((await invoke('beginOcclusion')).occluder.ready, true);
      await invoke('endOcclusion'); await invoke('release', 'cycle'); restoredContributions(await invoke('legacy', 'none'));
    }
    const end = await invoke('state'); assert.equal(end.primitiveCount, start.primitiveCount);
    assert.equal(end.dataSources, start.dataSources); assert.deepEqual(end.renderErrors, []);
    return { cycles: 4, primitiveCount: end.primitiveCount, dataSources: end.dataSources };
  });
  await check('delete-contributions-and-model-during-ar-does-not-resurrect-them', async () => {
    await invoke('legacy', 'pit'); await invoke('acquire', 'delete'); await invoke('beginOcclusion');
    await invoke('removeContributions'); const deleted = await invoke('deleteImport', 'synthetic-engineering');
    assert.equal(deleted.engineering.destroyed, true);
    await invoke('endOcclusion'); const released = await invoke('release', 'delete');
    assert.equal(released.engineering.destroyed, true); assert.equal(released.surfacePrimitives.length, 0);
    const cleared = await invoke('legacy', 'none'); assert.equal(cleared.tiles.polygons, null);
    assert.deepEqual(cleared.renderErrors, []); return { deletedModelRemainsDestroyed: true, removedSurfaceMeshCount: 0 };
  });
  await check('tileset-removal-and-owner-disposal-under-active-lease-are-idempotent', async () => {
    await invoke('legacy', 'section'); await invoke('acquire', 'teardown'); await invoke('beginOcclusion');
    const deleted = await invoke('deleteImport', 'synthetic-photography'); assert.equal(deleted.tiles.destroyed, true);
    const disposed = await invoke('disposeOwners'); assert.equal(disposed.leases, 0); assert.equal(disposed.disposed, true);
    assert.equal(disposed.globe.planes, null); assert.equal(disposed.globe.polygons, null);
    assert.equal(disposed.surfacePrimitives.length, 0); assert.deepEqual(disposed.ground, baseline.ground);
    assert.deepEqual(disposed.renderErrors, []);
    const final = await invoke('destroyViewer'); assert.equal(final.destroyed, true); assert.deepEqual(final.errors, []);
    return { deletedTilesetRemainsDestroyed: true, lateReleasesSafe: true, viewerDestroyed: final.destroyed };
  });
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  report.passed = true; report.execution = 'completed';
} catch (error) {
  report.error = error.stack || String(error);
  const blocked = !browser || !initialized && /BLOCKED:|WebGL|GPU process|browser.*closed|sandbox|Permission denied|Operation not permitted/i.test(report.error);
  report.execution = blocked ? 'blocked' : 'failed'; process.exitCode = blocked ? 2 : 1;
  if (page) await capture('failure').catch(() => {});
  console.error(`${report.execution.toUpperCase()}: ${String(error.message || error).slice(0, 600)}\nFull evidence: ${join(output, 'report.json')}`);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await server?.close();
  console.log(JSON.stringify({ passed: report.passed, execution: report.execution, renderer: report.gpu?.renderer,
    passedChecks: report.checks.filter(item => item.status === 'passed').length, checks: report.checks.length, report: join(output, 'report.json') }));
}
