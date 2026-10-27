/** Real Chromium DOM exercise of the production panels. Scene geometry and file HTTP transport are isolated fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
const result = await build({ entryPoints: [new URL('../src/railSafetyPanel.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'RailPanel', write: false, outdir: 'fixture', plugins: [{ name: 'isolated-scene', setup(plugin) {
  plugin.onResolve({ filter: /^\.\/railSafetyScene$/ }, () => ({ path: 'scene', namespace: 'fixture' }));
  plugin.onResolve({ filter: /^\.\/machineryScene$/ }, () => ({ path: 'machinery', namespace: 'fixture' }));
  plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'machinery' ? 'export const readMachineryState = () => undefined;' : `export class RailSafetyScene { constructor(viewer, options) { window.fixtureSceneOptions = options; return new Proxy(this, { get(target, key) { if (key === 'getSnapshot') return () => ({pending: 0}); if (key === 'getDisplayObjects') return () => []; return target[key] || (() => undefined); } }); } }`, loader: 'js' }));
} }] });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let sequence = 0, files = [], pendingFiles = [], deletes = 0, partialDelete = false, uploadHold, releaseUpload;
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:43123/**', async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="host"></div>' });
    if (url.pathname.endsWith('/documents')) { const resource = decodeURIComponent(url.pathname.split('/')[3]); return json({ records: files.filter(row => row.projectId === url.searchParams.get('projectId') && row.objectRefs[0].id === resource), pendingDeletions: pendingFiles.filter(row => row.projectId === url.searchParams.get('projectId') && row.objectRefs[0].id === resource) }); }
    if (url.pathname.endsWith('/upload')) {
      if (uploadHold) await uploadHold;
      const row = { id: `file-${++sequence}`, projectId: url.searchParams.get('projectId'), revision: 1, name: url.searchParams.get('name'), status: 'ready', createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', createdBy: 'owner', mime: route.request().headers()['content-type'], size: 12, objectRefs: JSON.parse(url.searchParams.get('objectRefs')), machineryDocumentCategory: url.searchParams.get('machineryDocumentCategory') }; files.push(row); return json(row, 201);
    }
    if (method === 'DELETE') {
      deletes++; const id = decodeURIComponent(url.pathname.split('/').at(-1)), original = [...files, ...pendingFiles].find(row => row.id === id); assert.deepEqual(JSON.parse(route.request().postData()), { expectedRevision: original.revision }); files = files.filter(row => row.id !== id);
      if (partialDelete) { pendingFiles.push({ ...original, status: 'deleting', deletedAt: '2026-10-27', revision: original.revision + 1 }); partialDelete = false; return json({ error: '本地文件清理未完成', code: 'FILE_DELETE_PENDING', details: { deleted: true } }, 503); }
      pendingFiles = pendingFiles.filter(row => row.id !== id); return json({ ok: true });
    }
    return json({ error: 'Unknown fixture request: ' + url.pathname }, 404);
  });
  await page.goto('http://127.0.0.1:43123');
  await page.addStyleTag({ content: await fs.readFile(new URL('../src/railSafetyPanel.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: result.outputFiles.find(file => file.path.endsWith('.js')).text });
  await page.evaluate(() => {
    const row = (id, name) => ({ id, name, projectId: 'project', kind: 'equipment', status: 'active', revision: 1, createdAt: '2026-10-27', updatedAt: '2026-10-27', createdBy: 'owner' });
    window.fixtureContext = { projectId: 'project', actorId: 'owner', records: [], resources: [row('equipment:crane', '吊机 01'), row('equipment:pile', '桩机 02')], tasks: [], canView: true, canEdit: true, canViewDocuments: true, canEditDocuments: true, active: true };
    window.panel = new RailPanel.RailSafetyPanel({ viewer: {}, host: document.getElementById('host'), save: async () => {}, remove: async () => {}, editMachinery: () => {}, onSelectObject: (_kind, id) => window.panel.openMachineDocuments(id) });
    window.panel.setContext(window.fixtureContext); window.panel.open();
    window.fixtureSceneOptions.onSelect('machine', 'equipment:crane');
  });
  const panel = page.locator('.rail-safety-panel'), archive = panel.locator('.rs-documents');
  await archive.getByText('吊机 01', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await panel.locator('[data-section-content]:visible').count(), 1);
  const categories = ['performance', 'certificate', 'inspection', 'submission'];
  for (const category of categories) {
    await archive.locator(`[data-category="${category}"]`).click();
    await archive.locator('input[type=file]').setInputFiles({ name: `${category}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-fixture') });
    await archive.locator('.rs-document-card').filter({ hasText: `${category}.pdf` }).waitFor({ timeout: 5000 }).catch(async error => { console.error(JSON.stringify({ files, text: await archive.innerText(), errors })); throw error; });
    await page.waitForFunction(() => !window.panel.isBusy);
  }
  assert.equal(files.length, 4); assert.equal(await archive.locator('[data-document-action=category]').count(), 4);
  assert.equal(await archive.getByText('预览', { exact: true }).getAttribute('target'), '_blank');
  assert.equal(await archive.getByText('下载', { exact: true }).getAttribute('download'), 'submission.pdf');
  await panel.locator('[data-action=close]').click();
  assert.equal(await panel.isVisible(), false);
  await page.evaluate(() => window.fixtureSceneOptions.onSelect('machine', 'equipment:crane'));
  await archive.locator('[data-category=certificate]').click();
  await archive.getByText('certificate.pdf', { exact: true }).waitFor();
  await panel.locator('[data-role=selection]').selectOption('equipment:pile');
  await panel.locator('[data-action=section-documents]').click();
  await archive.getByText('桩机 02', { exact: true }).waitFor();
  assert.equal(await archive.locator('.rs-document-card').count(), 0);
  await page.evaluate(() => window.panel.openMachineDocuments('equipment:crane'));
  await archive.locator('[data-category=certificate]').click();
  await archive.getByText('certificate.pdf', { exact: true }).waitFor();
  partialDelete = true;
  await archive.locator('[data-document-action=delete]').click();
  await archive.locator('[data-document-action=confirm-delete]').click();
  await archive.locator('[data-document-action=retry-delete]').waitFor();
  assert.equal(await archive.locator('.rs-document-card').count(), 0);
  await panel.locator('[data-action=close]').click(); await page.evaluate(() => window.panel.openMachineDocuments('equipment:crane'));
  await archive.locator('[data-document-action=retry-delete]').waitFor();
  assert.equal(await archive.locator('.rs-document-confirm a').count(), 0);
  await archive.locator('[data-document-action=retry-delete]').click();
  await page.waitForFunction(() => !window.panel.isBusy);
  assert.equal(await archive.locator('[data-document-action=retry-delete]').count(), 0);
  assert.equal(deletes, 2);
  await panel.locator('[data-action=close]').click(); await page.evaluate(() => window.panel.openMachineDocuments('equipment:crane'));
  await archive.locator('[data-category=certificate]').click();
  await archive.getByText('尚未上传合格证。', { exact: true }).waitFor();
  // Tabs preserve actual input nodes and the user's unsaved configuration.
  await panel.locator('[data-action=section-configuration]').click();
  await panel.locator('[data-field=name]').fill('吊机配置草稿');
  await page.evaluate(() => { window.retainedNameInput = document.querySelector('.rail-safety-panel [data-field=name]'); });
  for (const section of ['analysis', 'risk', 'display', 'documents', 'configuration']) {
    await panel.locator(`[data-action=section-${section}]`).click();
    assert.equal(await panel.locator('[data-section-content]:visible').count(), 1);
  }
  assert.equal(await panel.locator('[data-field=name]').inputValue(), '吊机配置草稿');
  assert.equal(await page.evaluate(() => window.retainedNameInput === document.querySelector('.rail-safety-panel [data-field=name]') && window.panel.hasDraft), true);
  await panel.locator('[data-action=cancel]').click(); await panel.locator('[data-action=confirm]').click();
  await panel.locator('[data-action=section-documents]').click();
  uploadHold = new Promise(resolve => { releaseUpload = resolve; });
  await archive.locator('input[type=file]').setInputFiles({ name: 'busy.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  await page.waitForFunction(() => window.panel.isBusy);
  assert.equal(await panel.locator('[data-role=selection]').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.panel.close()), false);
  releaseUpload(); uploadHold = undefined; await page.waitForFunction(() => !window.panel.isBusy);
  await page.evaluate(() => { window.fixtureContext.canEditDocuments = false; window.panel.setContext(window.fixtureContext); window.panel.openMachineDocuments('equipment:crane'); });
  await archive.getByText('当前账号可查看资料，无上传与删除权限。', { exact: true }).waitFor();
  assert.equal(await archive.locator('input[type=file]').isDisabled(), true);
  assert.equal(await archive.locator('[data-document-action=delete]').count(), 0);
  await page.evaluate(() => { window.fixtureContext.canViewDocuments = false; window.panel.setContext(window.fixtureContext); window.panel.openMachineDocuments('equipment:crane'); });
  await archive.getByText('当前账号没有机械资料查看权限。', { exact: true }).waitFor();
  assert.equal(await archive.locator('.rs-document-card').count(), 0);
  await page.evaluate(() => window.panel.dispose());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, scope: 'Real Chromium production panel DOM; mocked scene geometry and file HTTP API', checks: ['scene selection opens archive', 'four categories upload and links', 'close and reopen persisted files', 'machine isolation', 'delete and cleanup retry after close/reopen', 'deleted file absent after reopen', 'category visibility and retained drafts', 'busy navigation protection', 'read-only and revoked file permission'], pageErrors: errors }, null, 2));
} finally { await browser.close(); }
