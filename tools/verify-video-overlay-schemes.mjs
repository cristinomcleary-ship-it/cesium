#!/usr/bin/env node
/**
 * Real-browser SceneLibrary persistence regression with real XHR/fetch over an
 * isolated, in-memory HTTP adapter. No project-data or management files are used.
 * This checks client permission handling; actual server authorization is covered
 * separately by server/management/libraryPermissions.test.ts.
 *
 * node tools/verify-video-overlay-schemes.mjs
 * Optional: PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE, CHROMIUM_MODULE, OUTPUT_DIR.
 * The script always starts its own Vite server on an ephemeral loopback port.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../', import.meta.url));
const playwrightPath = process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
const { chromium } = require(playwrightPath);
const work = await mkdtemp(path.join(os.tmpdir(), 'cc-schemes-')), output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const records = new Map(), bytes = new Map(), denied = new Set(), requests = [];
for (const [id, kind] of [['model', 'Model'], ['cad', 'CAD'], ['tiles', '3D Tiles']]) {
  records.set(id, { version: 1, id, kind, name: id, visible: true, createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z', settings: {}, files: {} });
}
async function libraryHttp(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/__library/')) return next();
  requests.push([req.method, url.pathname]);
  const respond = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/__library/records') return respond({ records: [...records.values()].filter(record => !denied.has(record.id)), problems: [] });
  const parts = url.pathname.split('/'), id = parts[3], slot = parts[5];
  if (denied.has(id)) return respond({ error: 'Forbidden' }, 403);
  if (parts[2] === 'files') {
    const body = bytes.get(url.pathname);
    if (!body) return respond({ error: 'Not found' }, 404);
    res.setHeader('Content-Type', 'application/octet-stream'); res.end(body); return;
  }
  if (req.method === 'GET') return records.has(id) ? respond(records.get(id)) : respond({ error: 'Not found' }, 404);
  const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
  if (req.method === 'POST' && slot) {
    const name = url.searchParams.get('name'), fileUrl = `/__library/files/${id}/${slot}/${encodeURIComponent(name)}`;
    bytes.set(fileUrl, body); return respond({ name, url: fileUrl });
  }
  const data = JSON.parse(body.toString()), old = records.get(id);
  if (req.method === 'PUT') records.set(id, { ...data, createdAt: '2026-10-19T00:00:00Z', updatedAt: new Date().toISOString() });
  else if (req.method === 'PATCH' && old) records.set(id, { ...old, ...data, settings: { ...old.settings, ...data.settings }, updatedAt: new Date().toISOString() });
  else return respond({ error: 'Unsupported' }, 400);
  respond(records.get(id));
}
const server = await createServer({
  root, configFile: false, cacheDir: path.join(work, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [{ name: 'isolated-scheme-http', configureServer(vite) {
    vite.middlewares.use((req, res, next) => { void libraryHttp(req, res, next).catch(next); });
  } }],
});
let browser, report;
const errors = [], checks = [];
const record = name => { checks.push({ name, pass: true }); console.log(`PASS ${name}`); };
try {
  await server.listen();
  const address = server.httpServer.address(), baseUrl = `http://127.0.0.1:${address.port}`;
  let executablePath = process.env.BROWSER_EXECUTABLE, args = ['--no-sandbox', '--disable-dev-shm-usage'];
  if (process.env.CHROMIUM_MODULE) {
    let modulePath = process.env.CHROMIUM_MODULE;
    if (path.isAbsolute(modulePath) && !/\.[mc]?js$/.test(modulePath)) {
      const manifest = JSON.parse(await readFile(path.join(modulePath, 'package.json'), 'utf8'));
      modulePath = path.resolve(modulePath, manifest.main || manifest.exports?.['.']?.default || 'build/index.js');
    }
    const imported = path.isAbsolute(modulePath) ? await import(pathToFileURL(modulePath).href) : require(modulePath);
    const packaged = imported.default || imported;
    executablePath ||= await packaged.executablePath(); args = [...packaged.args, '--enable-unsafe-swiftshader'];
  }
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args });
  const page = await browser.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(String(error.stack || error)));
  await page.goto(`${baseUrl}/tools/fixtures/video-overlay-schemes.html`);
  await page.waitForFunction(() => !!window.__videoSchemes);
  await page.evaluate(() => window.__videoSchemes.save());
  let result = await page.evaluate(() => { const h = window.__videoSchemes; return { progress: h.progress, list: h.library.listVideoOverlaySchemes(), expected: h.fileMetadata }; });
  assert.ok(result.progress.some(value => value.phase === 'uploading' && value.loaded > 0));
  assert.equal(result.progress.at(-1).phase, 'committing'); assert.equal(result.progress.at(-1).loaded, 1048576 + 13 + 18);
  assert.equal(result.list[0].name, 'Synthetic named scheme'); assert.equal(bytes.size, 3);
  record('real XHR uploads video/XML/manifest with byte progress before committing the named scheme');

  await page.evaluate(() => window.__videoSchemes.library.openVideoOverlayScheme('scheme'));
  result = await page.evaluate(() => { const h = window.__videoSchemes; return { call: h.calls.at(-1), expected: h.fileMetadata }; });
  assert.equal(result.call.recordId, 'scheme');
  for (const file of result.call.files) { const { slot, text, ...actual } = file; assert.deepEqual(actual, result.expected[slot]); }
  assert.deepEqual(result.call.settings.selectedIds, ['model', 'cad']); assert.equal(result.call.settings.adjustments.cad.up, 29);
  assert.equal(result.call.settings.sceneReference.recordId, 'tiles'); assert.equal(result.call.settings.occlusion.sourceId, 'tiles');
  record('reopening preserves all File metadata, dependencies and the 29 m CAD adjustment');

  await page.evaluate(() => window.__videoSchemes.library.openVideoOverlayScheme('scheme', { asCopy: true, name: 'Synthetic named copy' }));
  result = await page.evaluate(() => window.__videoSchemes.calls.at(-1));
  assert.equal(result.recordId, undefined); assert.equal(result.settings.schemeName, 'Synthetic named copy');
  assert.equal(records.size, 4); assert.equal(records.get('scheme').settings.video.schemeName, 'Synthetic named scheme');
  record('copy creates a separate unsaved draft without overwriting or duplicating the original record');

  const uploadsBeforeRename = requests.filter(([method]) => method === 'POST').length;
  await page.evaluate(() => { const h = window.__videoSchemes; return h.library.updateVideoOverlaySettings('scheme', { ...h.settings, schemeName: 'Renamed scheme' }); });
  result = await page.evaluate(() => window.__videoSchemes.library.listVideoOverlaySchemes());
  assert.equal(result[0].name, 'Renamed scheme'); assert.equal(bytes.size, 3);
  assert.equal(requests.filter(([method]) => method === 'POST').length, uploadsBeforeRename);
  record('renaming persists settings and updates the list without uploading the video again');

  const before = JSON.stringify(records.get('scheme')); denied.add('cad');
  result = await page.evaluate(async () => {
    const h = window.__videoSchemes, count = h.calls.length;
    try { await h.library.openVideoOverlayScheme('scheme'); return { failed: false }; }
    catch (error) { return { failed: true, message: error.message, unchanged: count === h.calls.length }; }
  });
  assert.equal(result.failed, true); assert.equal(result.unchanged, true); assert.match(result.message, /权限|无权/);
  assert.equal(JSON.stringify(records.get('scheme')), before);
  record('server-denied CAD dependency prevents opening and leaves saved selections unchanged');

  denied.delete('cad');
  result = await page.evaluate(async () => {
    const h = window.__videoSchemes; h.setMediaAllowed(false); const hidden = h.library.listVideoOverlaySchemes();
    try { await h.library.openVideoOverlayScheme('scheme'); return { hidden, failed: false }; }
    catch { return { hidden, failed: true }; }
  });
  assert.deepEqual(result.hidden, []); assert.equal(result.failed, true);
  record('current media permission hides a cached scheme and blocks direct opening');

  await page.evaluate(async () => { const h = window.__videoSchemes; h.setMediaAllowed(true); await h.library.refreshVideoOverlaySchemes(); });
  records.delete('scheme');
  result = await page.evaluate(() => window.__videoSchemes.library.refreshVideoOverlaySchemes()); assert.deepEqual(result, []);
  record('explicit refresh removes an externally deleted scheme');
  assert.deepEqual(errors, []);
  report = { pass: true, checks, errors, requestCount: requests.length };
} catch (error) {
  report = { pass: false, checks, errors, requestCount: requests.length, error: String(error.stack || error) };
  process.exitCode = 1; console.error(report.error);
} finally {
  await writeFile(path.join(output, 'video-overlay-schemes-report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await server.close(); console.log(`Report: ${path.join(output, 'video-overlay-schemes-report.json')}`);
}
