// Run with Node 24: --experimental-transform-types --import ./tools/test-module-loader.mjs
// CESIUM_ENGINEERING_ASSETS_DIR points to the original read-only package. No production data is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { managementPlugin } from '../server/managementStore.ts';
import { engineeringComponentsAssetsPlugin } from '../server/engineeringComponentsAssets.ts';

const root = process.cwd(), out = resolve(process.env.ENGINEERING_BROWSER_OUT || 'output/engineering-components-browser');
const assetDirectory = process.env.CESIUM_ENGINEERING_ASSETS_DIR;
if (!assetDirectory || !isAbsolute(assetDirectory)) throw new Error('Set CESIUM_ENGINEERING_ASSETS_DIR to the original package directory');
const runtime = process.env.PLAYWRIGHT_MODULE;
if (!runtime) throw new Error('Set PLAYWRIGHT_MODULE to the local Playwright package directory or module file URL');
const runtimePath = runtime.startsWith('file:') ? fileURLToPath(runtime) : runtime;
const require = createRequire(import.meta.url), runtimeRequire = createRequire(require.resolve(runtimePath));
const { chromium } = require(runtimePath), { PNG } = runtimeRequire('pngjs');
const cesiumAssets = resolve(dirname(require.resolve('cesium/package.json')), 'Build/Cesium');
const viteEnv = await realpath(resolve(dirname(require.resolve('vite/package.json')), 'dist/client/env.mjs'));
const data = await realpath(await mkdtemp(join(tmpdir(), 'cesium-engineering-browser-data-')));
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), passed: false, productionServiceTouched: false, originalAssetsReadOnly: true,
  isolatedManagementData: true, hostIntegration: 'fixture uses real controller/panel/adapter/catalog/state; main host is tested separately',
  checks: [], errors: [], consoleErrors: [], failedRequests: [], screenshots: [], sourceFiles: [] };
for (const file of ['src/engineeringComponents/controller.ts', 'src/engineeringComponents/panel.ts', 'src/engineeringComponents/renderAdapter.ts', 'src/engineeringComponents/occlusion.ts',
  'src/engineeringComponents/catalog.ts', 'src/engineeringComponents/state.ts', 'server/engineeringComponentsAssets.ts', 'tools/fixtures/engineering-components.ts'])
  report.sourceFiles.push({ file, sha256: createHash('sha256').update(await readFile(join(root, file))).digest('hex') });
let server, browser, context, page;
const origin = 'http://127.0.0.1:5296', entry = origin + '/tools/fixtures/engineering-components.html';
const check = (name, value) => { report.checks.push({ name, pass: true, ...value }); console.log('PASS', name); };
const waitBound = async id => {
  await page.waitForFunction(id => window.engineeringFixture?.controller.activeInstanceId === `fixture-${id}` || document.querySelector('[data-ec="status"]')?.classList.contains('error'), id, { timeout: 240000 });
  const stats = await page.evaluate(() => engineeringFixture.stats());
  assert.equal(stats.activeInstanceId, `fixture-${id}`, await page.locator('[data-ec="status"]').textContent()); return stats;
};
const frames = async () => page.evaluate(() => engineeringFixture.frames(4));
const row = id => page.locator(`[data-component-id="${id}"]`);
async function screenshot(name) {
  await frames(); const path = join(out, `${name}.png`), bytes = await page.locator('#viewer canvas').first().screenshot({ path });
  report.screenshots.push(`${name}.png`); return bytes;
}
function difference(a, b) {
  const aa = PNG.sync.read(a), bb = PNG.sync.read(b); assert.equal(aa.width, bb.width); assert.equal(aa.height, bb.height);
  let pixels = 0; for (let i = 0; i < aa.data.length; i += 4)
    if (Math.abs(aa.data[i] - bb.data[i]) + Math.abs(aa.data[i + 1] - bb.data[i + 1]) + Math.abs(aa.data[i + 2] - bb.data[i + 2]) > 45) pixels++;
  return pixels;
}
async function connect(unit) { await page.locator('[data-ec-action="connect"]').click(); return waitBound(unit); }
async function load(unit) {
  await page.locator(`[data-fixture-load="${unit}"]`).click();
  await page.waitForFunction(unit => engineeringFixture.stats().instanceId === `fixture-${unit}` && !engineeringFixture.stats().loading, unit, { timeout: 240000 });
}
async function preparePage(current) {
  current.on('pageerror', error => { report.errors.push(String(error.stack || error)); console.error('PAGE', String(error)); });
  current.on('console', message => { if (message.type() === 'error') { report.consoleErrors.push(message.text()); console.error('CONSOLE', message.text()); } });
  current.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) report.failedRequests.push({ url: new URL(request.url()).pathname, error: request.failure()?.errorText }); });
  current.on('response', response => { if (response.status() >= 400) console.error('HTTP', response.status(), new URL(response.url()).pathname); });
  await current.goto(entry + '?model=A001', { waitUntil: 'commit', timeout: 60000 });
  await current.waitForFunction(() => window.engineeringFixture?.ready || window.engineeringFixture?.failure, null, { timeout: 90000 });
  assert.equal(await current.evaluate(() => engineeringFixture.failure), undefined);
}

try {
  server = await createServer({ configFile: false, root, cacheDir: resolve(root, '.vite/engineering-browser'), resolve: { preserveSymlinks: true }, logLevel: 'warn',
    plugins: [{ name: 'engineering-browser-vite-env', enforce: 'pre', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      // Vite emits its own real installation path even when dependencies preserve junction paths.
      // Serve this exact public client file; keep every private filesystem route protected.
      if ((req.url || '').split('?')[0].toLowerCase() !== ('/@fs/' + viteEnv.replaceAll('\\', '/')).toLowerCase()) return next();
      res.setHeader('Content-Type', 'application/javascript'); res.end((await server.transformRequest(req.url))?.code ?? '');
    }); } }, managementPlugin({ dataDir: data, libraryDataDir: data, spatialDataDir: data }), engineeringComponentsAssetsPlugin({ directory: assetDirectory }),
      { name: 'engineering-browser-cesium-assets', configureServer(server) { server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url, origin).pathname;
        if (!pathname.startsWith('/__engineering_browser_cesium/')) return next();
        try {
          const path = resolve(cesiumAssets, decodeURIComponent(pathname.slice('/__engineering_browser_cesium/'.length)));
          const within = relative(cesiumAssets, path);
          if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('Invalid Cesium asset');
          res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.json') ? 'application/json' : 'application/octet-stream');
          res.end(await readFile(path));
        } catch { res.statusCode = 404; res.end('Cesium test asset unavailable'); }
      }); } }],
    server: { host: '127.0.0.1', port: 5296, strictPort: true, watch: null, hmr: false },
    optimizeDeps: { entries: ['tools/fixtures/engineering-components.html'] },
  });
  await server.listen();
  const bootstrap = await fetch(origin + '/__management/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' },
    body: JSON.stringify({ projectId: 'safety:project', type: 'member.save', idempotencyKey: 'browser-owner', payload: { username: 'browser-owner', displayName: 'Isolated browser verifier', password: 'Synthetic-Engineering-Browser-Only', roles: ['owner'] } }) });
  assert.equal(bootstrap.status, 200, await bootstrap.text());
  const sessionCookie = bootstrap.headers.get('set-cookie').split(';')[0], cookieSeparator = sessionCookie.indexOf('=');
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  browser.on('disconnected', () => { report.browserDisconnectedAt = new Date().toISOString(); });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
  await context.addCookies([{ name: sessionCookie.slice(0, cookieSeparator), value: sessionCookie.slice(cookieSeparator + 1), url: origin, httpOnly: true, sameSite: 'Strict' }]);
  page = await context.newPage(); page.setDefaultTimeout(30000);
  await preparePage(page);
  let stats = await connect('A001'); assert.equal(stats.physical, 6); assert.equal(stats.visiblePhysical, 6);
  report.renderer = stats.renderer; assert(!/swiftshader|llvmpipe/i.test(stats.renderer), 'Hardware GPU required for this acceptance run');
  check('A001 original GLB attached to actual controller', { stats });
  await page.locator('[data-ec="scope"]').selectOption('A001');
  await page.evaluate(() => engineeringFixture.focus('A001_cap_01'));
  await page.locator('[data-ec="search"]').fill('A001_cap_01');
  const beforeSelection = await screenshot('a001-before-selection');
  await row('A001_cap_01').locator('[data-ec-action="select"]').click();
  await page.waitForFunction(() => engineeringFixture.snapshot?.selectedId === 'A001_cap_01');
  const selected = await screenshot('a001-selected'), highlightedPixels = difference(beforeSelection, selected);
  assert(highlightedPixels > 10, `Selection must change actual canvas pixels: ${highlightedPixels}`);
  check('Tree selection produces GPU highlight', { highlightedPixels });
  await page.locator('[data-ec="scope"]').selectOption('A001'); await frames();
  await page.evaluate(() => engineeringFixture.focus('A001_cap_01'));
  await page.locator('[data-ec="pick"]').check();
  const point = await page.evaluate(() => engineeringFixture.pickPoint('A001_cap_01'));
  const canvasBox = await page.locator('#viewer canvas').first().boundingBox();
  await page.mouse.click(canvasBox.x + point.x, canvasBox.y + point.y);
  await page.waitForFunction(() => engineeringFixture.snapshot?.selectedId === 'A001_cap_01');
  assert.equal(await row('A001_cap_01').getAttribute('aria-selected'), 'true');
  check('Real scene.pick updates tree selection', { point });

  await row('A001_cap_01').locator('[data-ec-state="visible"]').uncheck();
  await row('A001_cap_01').locator('[data-ec-state="occlusionEnabled"]').check();
  assert.deepEqual(await page.evaluate(() => engineeringFixture.flags('A001_cap_01')), { visible: false, occlusionEnabled: true });
  assert.equal(await page.evaluate(() => engineeringFixture.nodeShow('A001_cap_01')), false);
  await page.locator('.ec-detection summary').click();
  await page.locator('[data-ec="offset"]').fill('10'); await page.locator('[data-ec="offset"]').press('Tab');
  await page.locator('[data-ec="detection"]').check();
  const occluded = await screenshot('a001-hidden-cap-occluding');
  await row('A001_cap_01').locator('[data-ec-state="occlusionEnabled"]').uncheck();
  const unoccluded = await screenshot('a001-hidden-cap-not-occluding'), depthPixels = difference(occluded, unoccluded);
  assert(depthPixels > 10, `Hidden component must change independent depth pixels: ${depthPixels}`);
  check('Hidden A001 component independently occludes actual detection plane', { depthPixels });
  await page.locator('[data-ec="detection"]').uncheck();
  await page.locator('[data-ec="search"]').fill('');
  await row('A001.pile').locator('[data-ec-state="visible"]').uncheck();
  assert.deepEqual(await page.evaluate(() => [1, 2, 3, 4].map(n => engineeringFixture.nodeShow(`A001_pile_0${n}`))), [false, false, false, false]);
  const visibleBeforeBulk = (await page.evaluate(() => engineeringFixture.stats())).visiblePhysical;
  await page.locator('[data-ec="all-occlusion"]').check();
  assert.equal((await page.evaluate(() => engineeringFixture.stats())).visiblePhysical, visibleBeforeBulk);
  // Mixed aggregates have checked=false: first make the scope uniformly visible, then hide it.
  await page.locator('[data-ec="all-visible"]').check();
  await page.locator('[data-ec="all-visible"]').uncheck();
  assert.equal((await page.evaluate(() => engineeringFixture.stats())).visiblePhysical, 0);
  check('Single, group and unit batch controls preserve independent switches', { group: 'A001.pile', visibleBeforeBulk });

  const savedSnapshot = await page.evaluate(() => engineeringFixture.snapshot);
  const downloaded = page.waitForEvent('download'); await page.locator('[data-ec-action="export"]').click();
  const stateFile = join(out, 'a001-exported-state.json'); await (await downloaded).saveAs(stateFile);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), savedSnapshot);
  await page.locator('[data-ec="all-visible"]').check();
  await page.locator('[data-ec="import"]').setInputFiles(stateFile);
  await page.waitForFunction(flags => engineeringFixture.snapshot?.flags === flags, savedSnapshot.flags);
  check('State download and file-input import round-trip actual browser state', { bytes: (await readFile(stateFile)).length });
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.engineeringFixture?.ready, null, { timeout: 240000 });
  stats = await waitBound('A001'); assert.equal(stats.visiblePhysical, 0);
  assert.equal((await page.evaluate(() => engineeringFixture.snapshot)).flags, savedSnapshot.flags);
  const storageState = await context.storageState(); await context.close();
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true, storageState });
  page = await context.newPage(); page.setDefaultTimeout(30000); await preparePage(page); stats = await waitBound('A001');
  assert.equal(stats.visiblePhysical, 0); assert.equal((await page.evaluate(() => engineeringFixture.snapshot)).flags, savedSnapshot.flags);
  check('Page reload and new browser context restore same localStorage binding', { instance: stats.activeInstanceId });
  await page.locator('[data-ec-action="disconnect"]').click(); await frames(); stats = await page.evaluate(() => engineeringFixture.stats());
  assert.equal(stats.activeInstanceId, undefined); assert.equal(stats.changedShows, 0); assert.equal(stats.changedTransforms, 0); assert.equal(stats.matrixUnchanged, true);
  check('Disconnect restores original runtime nodes and matrix', { stats });

  await load('TN021'); stats = await connect('TN021'); assert.equal(stats.physical, 199); assert.equal(stats.visiblePhysical, 199);
  const tracks = await page.evaluate(() => engineeringFixture.currentIds.filter(id => id.startsWith('AP181_TN_096_railway_track')));
  assert.equal(tracks.length, 194);
  await page.locator('[data-ec="scope"]').selectOption('TN021');
  await page.locator('[data-ec="search"]').fill('TN021_tunnel_roof_01');
  await row('TN021_tunnel_roof_01').locator('[data-ec-state="visible"]').uncheck();
  assert.equal((await page.evaluate(() => engineeringFixture.stats())).visiblePhysical, 198);
  assert.equal(await page.evaluate(ids => ids.filter(id => engineeringFixture.nodeShow(id)).length, tracks), 194);
  await page.locator('[data-ec="all-occlusion"]').check();
  assert.deepEqual(await page.evaluate(() => engineeringFixture.flags('TN021_tunnel_roof_01')), { visible: false, occlusionEnabled: true });
  await screenshot('tn021-roof-hidden');
  check('TN021 unit retains five structural parts plus 194 track entities', { members: 199, tracks: 194, afterRoofHidden: 198 });
  await page.locator('[data-ec-action="disconnect"]').click();

  await load('full'); stats = await connect('full');
  assert.equal(stats.physical, 25258); assert.equal(stats.references, 69); assert.equal(stats.visiblePhysical, 25258); assert.equal(stats.visibleReferences, 0);
  await page.locator('[data-ec="scope"]').selectOption('A001'); assert.equal((await page.evaluate(() => engineeringFixture.stats())).visiblePhysical, 6);
  await page.locator('[data-ec="scope"]').selectOption('TN021'); assert.equal((await page.evaluate(() => engineeringFixture.stats())).visiblePhysical, 199);
  await page.locator('[data-ec="scope"]').selectOption('all');
  await page.locator('[data-ec="all-visible"]').uncheck();
  await page.locator('[data-ec="all-occlusion"]').check();
  stats = await page.evaluate(() => engineeringFixture.stats()); assert.equal(stats.visiblePhysical, 0); assert.equal(stats.visibleReferences, 0);
  await page.locator('[data-ec="all-visible"]').check(); stats = await page.evaluate(() => engineeringFixture.stats());
  assert.equal(stats.visiblePhysical, 25258); assert.equal(stats.visibleReferences, 0); assert.equal(stats.changedTransforms, 0); assert.equal(stats.matrixUnchanged, true);
  check('Whole GLB covers all 25,258 physical objects with 69 references excluded from bulk switches', { stats });
  await screenshot('full-line-attached');

  const permittedContext = await page.evaluate(() => engineeringFixture.getContext());
  await page.evaluate(() => engineeringFixture.setContext(null)); await frames();
  stats = await page.evaluate(() => engineeringFixture.stats());
  assert.equal(stats.activeInstanceId, undefined); assert.equal(stats.changedShows, 0); assert.equal(stats.changedTransforms, 0);
  assert.equal(stats.stages, 0); assert.equal(stats.primitives, 1);
  check('Revoking current project permission releases all component effects immediately', { stats });
  await page.evaluate(context => engineeringFixture.setContext(context), permittedContext); await waitBound('full');
  await page.locator('[data-ec-action="disconnect"]').click();
  let release, seen; const held = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { seen = resolve; });
  await page.route('**/__engineering-components/manifest', async route => { seen(); await held; await route.continue().catch(() => {}); });
  await page.locator('[data-ec-action="connect"]').click(); await requested;
  const originalContext = await page.evaluate(() => engineeringFixture.getContext());
  await page.evaluate(() => engineeringFixture.setContext(null)); release();
  await page.unroute('**/__engineering-components/manifest'); await frames();
  await page.evaluate(context => engineeringFixture.setContext({ ...context, projectId: 'other-project' }), originalContext);
  await page.waitForTimeout(1000); stats = await page.evaluate(() => engineeringFixture.stats());
  assert.equal(stats.activeInstanceId, undefined); assert.equal(stats.changedShows, 0); assert.equal(stats.changedTransforms, 0);
  check('Loading cancellation and permission/project change never attach a late result', { stats });
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  assert.equal(stats.errors.length, 0, stats.errors.join('\n'));
  for (const source of report.sourceFiles) {
    source.finalSha256 = createHash('sha256').update(await readFile(join(root, source.file))).digest('hex');
    assert.equal(source.finalSha256, source.sha256, 'Source changed during browser acceptance: ' + source.file);
  }
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack || error); console.error(report.failure);
  if (page) { try { await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }); report.failureUi = await page.locator('body').innerText(); report.failureStats = await page.evaluate(() => window.engineeringFixture?.stats()); } catch {} }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await context?.close(); await browser?.close(); await server?.close();
  const relativeTemp = relative(await realpath(tmpdir()), data);
  assert(relativeTemp && relativeTemp !== '..' && !relativeTemp.startsWith('..' + sep) && !isAbsolute(relativeTemp));
  await rm(data, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, output: out }));
}
