// Actual application entry, original read-only GLBs, synthetic catalogue and account context.
// No production catalogue/database is copied. Set CESIUM_ENGINEERING_ASSETS_DIR.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer, loadConfigFromFile } from 'vite';
import { Cartesian3, Matrix4, Transforms } from 'cesium';

const out = resolve(process.env.ENGINEERING_WORKBENCH_OUT || 'output/engineering-workbench');
await mkdir(out, { recursive: true });
const data = await mkdtemp(join(out, 'synthetic-data-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = data;
process.env.CESIUM_VITE_CACHE_DIR = resolve('.vite/engineering-workbench');
if (!process.env.CESIUM_ENGINEERING_ASSETS_DIR) throw new Error('Original package path is required');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const report = { startedAt: new Date().toISOString(), passed: false, checks: [], errors: [], data, productionDataUsed: false };
const sourceFiles = ['src/main.ts', 'src/engineeringComponents/controller.ts', 'src/engineeringComponents/panel.ts', 'src/engineeringComponents/renderAdapter.ts', 'src/engineeringComponents/occlusion.ts'];
const sourceHashes = async () => Promise.all(sourceFiles.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
report.sourceHashes = await sourceHashes();
let server, browser, page;
const records = ['A001', 'TN021'].map((unit, index) => ({ version: 1, id: 'synthetic-' + unit, name: unit + ' original sample', kind: 'Model', visible: true,
  createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
  files: { source: { name: unit + '.glb', url: `/__engineering-components/structure-library/${index ? 'tunnel' : 'bridge'}/${unit}/model.glb` } },
  settings: { matrix: Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 100))), scale: 1 } }));
async function check(name, fn) { console.log('RUN', name); const item = { name }; report.checks.push(item); item.evidence = await fn(); item.passed = true; console.log('PASS', name); }
async function state() { return page.evaluate(() => {
  const c = window.__engineeringComponents, v = window.__managementWorkspace.viewer;
  return { id: c.activeInstanceId, selected: c.snapshot?.selectedId, picking: c.isPicking, scope: c.reviewScope,
    physical: c.catalog?.components.length, nodes: c.ids.size, primitiveCount: v.scene.primitives.length,
    matrix: c.instance ? Array.from(c.instance.model.modelMatrix) : null, render: c.renderStats,
    flags: c.state ? c.members().map(id => [id, c.state.get(id)]) : [], status: document.querySelector('[data-ec="status"]')?.textContent };
}); }
try {
  const dependencyPrefix = '/@fs/' + (await realpath('node_modules')).replaceAll('\\', '/') + '/';
  const localPrefix = '/@fs/' + resolve('node_modules').replaceAll('\\', '/') + '/';
  const dependencyAlias = { name: 'isolated-test-dependency-junction', enforce: 'pre', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] === dependencyPrefix + 'vite/dist/client/env.mjs') {
        void server.transformRequest(request.url).then(result => { response.setHeader('Content-Type', 'text/javascript'); response.end(result.code); }, next); return;
      }
      if (request.url?.startsWith(dependencyPrefix)) request.url = localPrefix + request.url.slice(dependencyPrefix.length);
      next();
    });
  } };
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('vite.config.ts'), undefined, undefined, undefined, 'runner');
  server = await createServer({ ...loaded.config, configFile: false, plugins: [dependencyAlias, ...loaded.config.plugins], server: { host: '127.0.0.1', port: 5297, strictPort: true, hmr: false, watch: null } }); await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-webgl', '--ignore-gpu-blocklist'] });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(45000);
  page.on('pageerror', error => report.errors.push(String(error)));
  report.consoleErrors = []; report.failedRequests = [];
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() }); });
  await page.route('**/__library/records', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { records, problems: [], deletedVideoIds: [] } }) : route.continue());
  await page.goto('http://127.0.0.1:5297/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__managementWorkspace?.getWorkbenchMachineryState().canView && window.__engineeringComponents);
  await page.waitForFunction(() => {
    const v = window.__managementWorkspace.viewer; let ready = 0;
    for (let i = 0; i < v.scene.primitives.length; i++) { const m = v.scene.primitives.get(i); if (m.id?.engineeringModelId?.startsWith('synthetic-') && m.ready) ready++; }
    return ready === 2;
  }, undefined, { timeout: 120000 });
  report.gpu = await page.evaluate(() => { const gl = window.__managementWorkspace.viewer.scene.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); });
  assert.doesNotMatch(report.gpu, /swiftshader|software|llvmpipe/i);
  await check('original workbench entry binds restored positioned A001 without another model', async () => {
    const before = await state(); await page.locator('#openEngineeringComponents').click();
    await page.locator('[data-ec="instance"]').selectOption('synthetic-A001'); await page.locator('[data-ec-action="connect"]').click();
    await page.waitForFunction(() => window.__engineeringComponents.activeInstanceId === 'synthetic-A001');
    const after = await state(); assert.equal(after.nodes, 6); assert.equal(after.primitiveCount, before.primitiveCount + 1); // dedicated renderer driver only
    assert.equal(await page.locator('[data-ec="scope"]').inputValue(), 'A001'); return after;
  });
  const matrix = (await state()).matrix;
  await check('workbench component visibility, independent occlusion and Esc release', async () => {
    await page.locator('[data-ec="all-visible"]').uncheck(); await page.locator('[data-ec="all-occlusion"]').check();
    let current = await state(); assert.equal(current.flags.length, 6); assert.ok(current.flags.every(([, f]) => !f.visible && f.occlusionEnabled));
    await page.locator('[data-ec="all-visible"]').check(); await page.locator('[data-ec="pick"]').check(); assert.equal((await state()).picking, true);
    await page.keyboard.press('Escape'); assert.equal((await state()).picking, false); assert.equal(await page.locator('#engineeringComponentsPanel').isVisible(), false);
    assert.deepEqual((await state()).matrix, matrix); return { flags: current.flags, matrixUnchanged: true, escapeReleased: true };
  });
  await check('restoration uses current original instance and saved component flags', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__engineeringComponents?.activeInstanceId === 'synthetic-A001', undefined, { timeout: 120000 });
    const current = await state(); assert.ok(current.flags.every(([, f]) => f.visible && f.occlusionEnabled)); assert.deepEqual(current.matrix, matrix);
    await page.locator('#openEngineeringComponents').click(); assert.equal(await page.locator('[data-ec="instance"]').inputValue(), 'synthetic-A001'); return current;
  });
  await check('switch to TN021, independent all state and old tool exit', async () => {
    await page.locator('[data-ec-action="disconnect"]').click(); await page.locator('[data-ec="instance"]').selectOption('synthetic-TN021');
    await page.locator('[data-ec-action="connect"]').click(); await page.waitForFunction(() => window.__engineeringComponents.activeInstanceId === 'synthetic-TN021');
    let current = await state(); assert.equal(current.nodes, 199); assert.ok(current.flags.every(([, f]) => f.visible && !f.occlusionEnabled));
    await page.locator('[data-ec="all-occlusion"]').check(); await page.locator('[data-ec="all-visible"]').uncheck();
    current = await state(); assert.ok(current.flags.every(([, f]) => !f.visible && f.occlusionEnabled));
    await page.locator('[data-ec="all-visible"]').check(); await page.locator('[data-ec="pick"]').check();
    await page.locator('#openSubsurfacePanel').click(); assert.equal((await state()).picking, false); assert.equal(await page.locator('#engineeringComponentsPanel').isVisible(), false);
    await page.locator('#openEngineeringComponents').click(); await page.screenshot({ path: join(out, 'main-workbench-TN021.png') }); return current;
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(await sourceHashes(), report.sourceHashes); report.passed = true;
} catch (error) { report.error = String(error?.stack || error); console.error(report.error); if (page && !page.isClosed()) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1; }
finally { await browser?.close(); await server?.close(); report.finishedAt = new Date().toISOString(); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); }
