/** Actual Cesium/WebGL acceptance with synthetic photography and engineering GLB.
 * PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE / BROWSER_LAUNCH_OPTIONS select installed
 * runtimes. A launch restriction is reported as blocked, never as a passed test.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.SURFACE_EDIT_BROWSER_OUT || 'output/surface-edit-browser');
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(join(output, 'isolated-data-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const require = createRequire(import.meta.url);
const report = { classification: 'synthetic-3d-tiles-glb-real-webgl', startedAt: new Date().toISOString(),
  execution: 'not-started', passed: false, productionDataReadOrModified: false, checks: [], pageErrors: [], consoleErrors: [], screenshots: [] };
let server, browser, page;
const check = async (name, callback) => {
  console.log('RUN', name); const item = { name, status: 'running' }; report.checks.push(item);
  item.evidence = await callback(); item.status = 'passed'; console.log('PASS', name);
};
const screenshot = async name => { const path = join(output, name + '.png'); await page.screenshot({ path }); report.screenshots.push(path); };
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`; report.origin = origin;
  const modulePath = process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
  const { chromium } = require(modulePath);
  const options = process.env.BROWSER_LAUNCH_OPTIONS
    ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
  browser = await chromium.launch(options);
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(60000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  report.execution = 'running';
  await page.goto(origin + '/tools/fixtures/surface-edit.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__surfaceEditFixture?.ready || window.__surfaceEditFixture?.failure);
  assert.equal(await page.evaluate(() => window.__surfaceEditFixture.failure), '');
  report.gpu = await page.evaluate(() => window.__surfaceEditFixture.gpu());
  report.gpuClassification = /swiftshader|llvmpipe|software/i.test(report.gpu.renderer) ? 'software WebGL' : 'reported hardware WebGL';
  const baseline = await page.evaluate(() => window.__surfaceEditFixture.state());
  await screenshot('original-synthetic-photography');
  await check('excavation-reveals-independent-underground-model-with-textured-walls', async () => {
    const before = await page.evaluate(() => window.__surfaceEditFixture.pixel(0, 0, -2)); assert.equal(before.pickedEngineering, false);
    const after = await page.evaluate(() => window.__surfaceEditFixture.create('excavation', 'pit', 0));
    assert.equal(after.states.pit.state, 'ready'); assert.equal(after.terrainEnabled, true); assert.equal(after.engineeringClipped, false);
    assert.deepEqual(after.engineeringMatrix, baseline.engineeringMatrix); assert.equal(after.geometricSamples, 0); assert.ok(after.surfacePrimitiveCount >= 2);
    const revealed = await page.evaluate(() => window.__surfaceEditFixture.pixel(0, 0, -2)); assert.equal(revealed.pickedEngineering, true);
    assert.notDeepEqual(revealed.color, before.color); await screenshot('excavation-with-underground-structure');
    return { before, revealed, geometrySamples: 0, engineeringTransformUnchanged: true };
  });
  await check('disable-restores-original-photo-and-terrain', async () => {
    const after = await page.evaluate(() => window.__surfaceEditFixture.enabled('pit', false));
    assert.equal(after.photographyClips, 0); assert.equal(after.terrainEnabled, false);
    const pixel = await page.evaluate(() => window.__surfaceEditFixture.pixel(0, 0, -2)); assert.equal(pixel.pickedEngineering, false);
    await page.evaluate(() => window.__surfaceEditFixture.enabled('pit', true)); return { restored: true };
  });
  await check('flatten-removes-mound-and-can-be-restored', async () => {
    await page.evaluate(() => window.__surfaceEditFixture.camera(70));
    const before = await page.screenshot();
    const flat = await page.evaluate(() => window.__surfaceEditFixture.create('flatten', 'flat', 70));
    assert.equal(flat.states.flat.state, 'ready'); assert.equal(flat.engineeringClipped, false);
    const after = await page.screenshot(); assert.equal(before.equals(after), false, 'flatten must change rendered pixels');
    await screenshot('flattened-synthetic-mound');
    const disabled = await page.evaluate(() => window.__surfaceEditFixture.enabled('flat', false)); assert.equal(disabled.states.flat.state, 'hidden');
    const restored = await page.screenshot(); assert.equal(after.equals(restored), false, 'restored mound must change rendered pixels');
    await page.evaluate(() => window.__surfaceEditFixture.enabled('flat', true)); return { changedPixels: true, independentlySwitchable: true };
  });
  await check('legacy-clipping-and-ar-suspension-keep-separate-contributions', async () => {
    const added = await page.evaluate(() => window.__surfaceEditFixture.legacy(true)); assert.equal(added.photographyClips, 3);
    const suspended = await page.evaluate(() => window.__surfaceEditFixture.suspend(true)); assert.equal(suspended.photographyClips, 1); assert.equal(suspended.terrainEnabled, false);
    const restored = await page.evaluate(() => window.__surfaceEditFixture.suspend(false)); assert.equal(restored.photographyClips, 3);
    await page.evaluate(() => window.__surfaceEditFixture.legacy(false)); return { legacySurvivesSuspension: true };
  });
  await check('same-point-count-boundary-update-refreshes-terrain', async () => {
    await page.evaluate(() => window.__surfaceEditFixture.camera(0));
    const moved = await page.evaluate(() => window.__surfaceEditFixture.create('excavation', 'pit', 40));
    assert.equal(moved.retainedTerrainObject, true); assert.equal(moved.states.pit.state, 'ready');
    const after = await page.evaluate(() => window.__surfaceEditFixture.pixel(0, 0, -2)); assert.equal(after.pickedEngineering, false, 'old cut must be restored after equal-count move');
    await page.evaluate(() => window.__surfaceEditFixture.create('excavation', 'pit', 0));
    assert.equal((await page.evaluate(() => window.__surfaceEditFixture.pixel(0, 0, -2))).pickedEngineering, true);
    return { equalCountMoveVisible: true, collectionRetained: true };
  });
  await check('cancelled-prewarm-preserves-previous-gpu-state', async () => {
    const cancelled = await page.evaluate(() => window.__surfaceEditFixture.abort());
    assert.equal(cancelled.failure, 'AbortError'); assert.equal(cancelled.after.primitiveCount, cancelled.before.primitiveCount);
    assert.equal(cancelled.after.photographyClips, cancelled.before.photographyClips); assert.equal(cancelled.after.terrainEnabled, cancelled.before.terrainEnabled);
    return { aborted: true, temporaryPrimitivesReleased: true };
  });
  await check('repeated-toggle-zoom-lod-and-delete-do-not-destroy-borrowed-resources', async () => {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(i => window.__surfaceEditFixture.camera(0, i % 2 ? 80 : 700, -0.7), i);
      await page.evaluate(() => window.__surfaceEditFixture.enabled('pit', false));
      await page.evaluate(() => window.__surfaceEditFixture.enabled('pit', true));
    }
    await page.evaluate(() => window.__surfaceEditFixture.remove('flat')); const final = await page.evaluate(() => window.__surfaceEditFixture.remove('pit'));
    assert.equal(final.photographyClips, 0); assert.equal(final.terrainEnabled, false); assert.equal(final.primitiveCount, baseline.primitiveCount);
    assert.equal(final.engineeringClipped, false); assert.deepEqual(final.engineeringMatrix, baseline.engineeringMatrix); assert.deepEqual(final.errors, []);
    return { cycles: 8, originalPrimitiveCountRestored: true };
  });
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(await page.evaluate(() => window.__surfaceEditFixture.errors()), []);
  report.passed = true; report.execution = 'completed';
} catch (error) {
  report.error = error.stack || String(error);
  report.execution = browser ? 'failed' : 'blocked';
  if (page) await screenshot('failure').catch(() => {});
  console.error(report.error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await server?.close();
  console.log(JSON.stringify({ passed: report.passed, execution: report.execution, checks: report.checks.length, report: join(output, 'report.json') }));
}
