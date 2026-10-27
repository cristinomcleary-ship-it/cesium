import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
let base = process.env.CESIUM_TEST_BASE_URL, server, dataDir;
if (!base) {
  dataDir = await mkdtemp(path.join(tmpdir(), 'cesium-file-ui-')); process.env.CESIUM_DATA_DIR = dataDir;
  const { createServer } = await import('vite');
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
}
const keys = ['wbs','tasks','baselines','commitments','progress','dailyLogs','checks','issues','inspections','resources','resourceNeeds','resourceUsage','allocations','batches','materialTransactions','tests','documents','documentVersions','documentRequirements','links','technicalQueries','changes','meetings','actions','evidence','anchors','bookmarks','monitoring','reports','railSafety'];
const at = '2026-10-27T00:00:00Z';
const record = (id, extra = {}) => ({ id, projectId: 'fixture', name: id, status: 'ready', revision: 1, createdAt: at, updatedAt: at, createdBy: 'owner', taskIds: [], ...extra });
const state = { schemaVersion: 1, projectId: 'fixture', revision: 1, updatedAt: at,
  session: { userId: 'owner', displayName: '测试用户', roles: ['owner'], permissions: ['read','files','models','field','document','inspect','resource','plan','confirm','review','publish','admin','media'], authMode: 'local-owner' },
  projects: [{ id: 'fixture', name: '隔离文件删除验证', revision: 1, timezone: 'Asia/Shanghai', calendar: { workingDays: [1,2,3,4,5] }, createdAt: at, updatedAt: at }], members: [{ id: 'owner', displayName: '测试用户' }],
  collections: Object.fromEntries(keys.map(key => [key, []])), audit: [], pendingFileDeletions: [] };
state.collections.evidence = ['good','referenced','pending','conflict','late'].map(id => record(id, { storageName: id + '.txt', mime: 'text/plain', size: 3 }));
const requests = [], errors = []; let pendingAttempts = 0, conflictAttempts = 0, releaseLate;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.route('**/__management/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'DELETE') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1));
      requests.push({ id, projectId: url.searchParams.get('projectId'), body: request.postDataJSON(), marker: request.headers()['x-cesium-library'] });
      if (id === 'referenced') return route.fulfill({ status: 409, json: { code: 'FILE_IN_USE', error: '文件仍被施工任务引用，不能删除。' } });
      if (id === 'conflict' && ++conflictAttempts === 1) {
        state.collections.evidence.find(file => file.id === id).revision = 2; state.revision++;
        return route.fulfill({ status: 409, json: { code: 'REVISION_CONFLICT', error: '附件已变化，请刷新后重试' } });
      }
      if (id === 'late') await new Promise(resolve => { releaseLate = resolve; });
      state.collections.evidence = state.collections.evidence.filter(file => file.id !== id); state.revision++;
      if (id === 'pending' && ++pendingAttempts === 1) {
        state.pendingFileDeletions = [{ id, projectId: 'fixture', name: id, revision: 2 }];
        return route.fulfill({ status: 503, json: { code: 'FILE_DELETE_PENDING', error: '附件已从项目删除，但本地文件清理未完成，请关闭占用文件后重试删除', details: { deleted: true } } });
      }
      state.pendingFileDeletions = state.pendingFileDeletions.filter(file => file.id !== id);
      return route.fulfill({ json: { ok: true, snapshot: state } });
    }
    if (url.pathname.endsWith('/metrics')) return route.fulfill({ json: { businessAsOf: url.searchParams.get('D'), confirmedAsOf: url.searchParams.get('F'), metrics: [], dashboard: [], taskProgress: [] } });
    return route.fulfill({ json: state });
  });
  await page.goto(base + '/tools/fixtures/management-studio-ui.html');
  await page.waitForFunction(() => window.ui?.getSnapshot());
  await page.evaluate(() => window.ui.changeModule('documents', 'attachments', true));
  assert.equal(await page.locator('[data-mg-tab="attachments"]').textContent(), '上传文件');
  const open = async id => { await page.evaluate(id => window.ui.showRecord('evidence', id), id); await page.locator(`[data-mg-action="file-delete"][data-id="${id}"]`).waitFor(); };
  await open('referenced'); await page.locator('[data-mg-action="file-delete"][data-id="referenced"]').click();
  await page.waitForFunction(() => document.querySelector('[data-mg-file-feedback="referenced"]')?.textContent.includes('仍被施工任务引用'));
  assert.ok(await page.evaluate(() => window.ui.getSnapshot().collections.evidence.some(file => file.id === 'referenced')));
  await page.evaluate(() => window.ui.requestCloseDrawer());
  await open('good'); await page.locator('[data-mg-action="file-delete"][data-id="good"]').click();
  await page.waitForFunction(() => !window.ui.getSnapshot().collections.evidence.some(file => file.id === 'good'));
  assert.equal(await page.locator('[data-mg-drawer] .drawer').count(), 0);
  await open('pending'); await page.locator('[data-mg-action="file-delete"][data-id="pending"]').click();
  await page.locator('[data-mg-action="file-cleanup-retry"]').waitFor();
  assert.ok((await page.locator('#mg-workspace').innerText()).includes('本地文件清理未完成'));
  await page.reload(); await page.waitForFunction(() => window.ui?.getSnapshot());
  await page.evaluate(() => window.ui.changeModule('documents', 'attachments', true));
  await page.locator('[data-mg-action="file-cleanup-retry"][data-id="pending"]').waitFor();
  assert.ok(!await page.evaluate(() => window.ui.getSnapshot().collections.evidence.some(file => file.id === 'pending')), 'Reload restores the cleanup notice without resurrecting the deleted file');
  await page.evaluate(() => {
    const current = structuredClone(window.ui.getSnapshot());
    current.pendingFileDeletions.push({ id: 'foreign', projectId: 'another', name: 'foreign-private-file', revision: 1 });
    window.ui.applySnapshot(current); window.ui.render();
  });
  assert.equal(await page.locator('[data-mg-action="file-cleanup-retry"]').count(), 1, 'Foreign-scope cleanup items must not appear');
  await page.evaluate(() => { const legacy = structuredClone(window.ui.getSnapshot()); delete legacy.pendingFileDeletions; window.ui.applySnapshot(legacy); window.ui.render(); });
  assert.equal(await page.locator('[data-mg-action="file-cleanup-retry"]').count(), 1, 'An older server omitting the field preserves the existing notice');
  await page.evaluate(() => { const readonly = structuredClone(window.ui.getSnapshot()); window.pendingPermissions = readonly.session.permissions; readonly.session.permissions = ['read']; window.ui.applySnapshot(readonly); window.ui.render(); });
  assert.equal(await page.locator('[data-mg-action="file-cleanup-retry"]').count(), 0, 'Revoked file permissions hide notices even with an older response');
  await page.evaluate(() => { const writable = structuredClone(window.ui.getSnapshot()); writable.session.permissions = window.pendingPermissions; window.ui.applySnapshot(writable); window.ui.render(); });
  await page.evaluate(() => { const cleared = structuredClone(window.ui.getSnapshot()); cleared.pendingFileDeletions = []; window.ui.applySnapshot(cleared); window.ui.render(); });
  assert.equal(await page.locator('[data-mg-action="file-cleanup-retry"]').count(), 0, 'An explicit empty authoritative list clears completed notices');
  await page.evaluate(() => window.ui.refresh());
  await page.locator('[data-mg-action="file-cleanup-retry"]').waitFor();
  await page.locator('[data-mg-action="file-cleanup-retry"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-mg-action="file-cleanup-retry"]'));
  assert.equal(pendingAttempts, 2);
  await open('conflict'); await page.locator('[data-mg-action="file-delete"][data-id="conflict"]').click();
  await page.waitForFunction(() => document.querySelector('[data-mg-file-feedback="conflict"]')?.textContent.includes('附件已变化'));
  await page.locator('[data-mg-action="file-delete"][data-id="conflict"]').click();
  await page.waitForFunction(() => !window.ui.getSnapshot().collections.evidence.some(file => file.id === 'conflict'));
  assert.deepEqual(requests.filter(request => request.id === 'conflict').map(request => request.body.expectedRevision), [1, 2]);

  await page.evaluate(() => window.ui.openForm('task.create'));
  const fieldCount = await page.locator('[data-mg-form] [data-mg-field]').count();
  assert.equal(fieldCount, await page.evaluate(() => window.forms['task.create'].fields.length));
  await page.locator('[data-mg-field="name"]').fill('保留的任务草稿');
  await page.locator('.mg-form-category > summary').filter({ hasText: '线路与位置' }).click();
  assert.equal(await page.locator('[data-mg-field="name"]').inputValue(), '保留的任务草稿');
  await page.evaluate(() => { window.ui.draft = undefined; document.querySelector('[data-mg-drawer]').innerHTML = ''; window.ui.openForm('usage.create'); });
  await page.locator('[data-mg-action="form-save"]').click();
  assert.ok(await page.locator('[data-mg-field="taskId"]').isVisible());
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-mg-field')), 'taskId');
  await page.evaluate(() => { window.ui.draft = undefined; document.querySelector('[data-mg-drawer]').innerHTML = ''; });

  await page.evaluate(() => { const current = structuredClone(window.ui.getSnapshot()); window.fullPermissions = current.session.permissions; current.session.permissions = ['read','files']; window.ui.applySnapshot(current); window.ui.showRecord('evidence','referenced'); });
  assert.equal(await page.locator('[data-mg-action="file-delete"]').count(), 0, 'Read-only users have no delete action');
  await page.evaluate(() => { const current = structuredClone(window.ui.getSnapshot()); current.session.permissions = window.fullPermissions; window.ui.applySnapshot(current); window.ui.render(); });

  await open('late'); await page.locator('[data-mg-action="file-delete"][data-id="late"]').click();
  await page.waitForTimeout(100); assert.ok(releaseLate);
  await page.evaluate(() => { const snapshot = structuredClone(window.ui.getSnapshot()); snapshot.projectId = 'another'; snapshot.collections.evidence = []; window.ui.applySnapshot(snapshot); window.ui.render(); });
  releaseLate(); await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.ui.getSnapshot().projectId), 'another', 'Late response must not switch the current project back');
  assert.ok(requests.every(request => request.marker === '1' && Number.isSafeInteger(request.body.expectedRevision) && request.projectId === 'fixture'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, referencedFilePreserved: true, deletionRefresh: true, partialCleanupRetry: true, cleanupRestoredAfterReload: true, cleanupScopeAndLegacyCompatibility: true, revisionConflictRefresh: true, readOnlyProtected: true, projectSwitchSafe: true, formValuesRetained: true, hiddenRequiredFieldRevealed: true, requests: requests.length }, null, 2));
} finally { await browser.close(); await server?.close(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); }
