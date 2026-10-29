/** Real Cesium UI acceptance with an isolated project ledger and browser history.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
 * BROWSER_EXECUTABLE=/absolute/path/to/chromium node tools/verify-machinery-config-history.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.MACHINERY_CONFIG_VERIFY_OUT || 'output/machinery-config-history');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/machinery-config-history-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const report = { classification: 'real-platform-browser-isolated-ledger', startedAt: new Date().toISOString(), checks: [], pageErrors: [], consoleErrors: [], downloads: [], screenshots: [] };
let server, browser, context, page, origin, activeCheck;
const machines = [];
const panel = () => page.locator('.machinery-panel');
const action = key => panel().locator(`[data-action="${key}"]`);
const role = key => panel().locator(`[data-role="${key}"]`);
const poseAction = key => panel().locator(`[data-pose-action="${key}"]`);
const field = key => panel().locator(`[data-parameter="${key}"]`);
const coord = key => panel().locator(`[data-placement="${key}"]`);
const snapshot = () => page.evaluate(() => window.__managementWorkspace.ui.getSnapshot());
const activeResources = async () => (await snapshot()).collections.resources.filter(r => r.status !== 'deleted' && !r.deletedAt);
const record = async id => (await snapshot()).collections.resources.find(r => r.id === id);
async function check(id, run) {
  activeCheck = { id, status: 'running', startedAt: new Date().toISOString() }; report.checks.push(activeCheck); console.log('RUN', id);
  activeCheck.evidence = await run(); activeCheck.status = 'passed'; activeCheck.finishedAt = new Date().toISOString(); console.log('PASS', id);
}
async function ready(id) {
  await page.waitForFunction(id => { const p = window.__managementWorkspace?.machinery; return p && !p.loading && !p.busy && (!id || p.selectedResourceId === id); }, id, { timeout: 60000 });
}
async function fill(locator, value) { await locator.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); await locator.fill(String(value)); }
async function capture(name) { const path = resolve(output, name + '.png'); await page.screenshot({ path, timeout: 30000 }); report.screenshots.push(path); }
async function openEditor(id) {
  await page.locator('.tab[data-tab="machinery"]').click(); await panel().waitFor({ state: 'visible' }); await ready();
  if (id) { await role('resource').selectOption(id); await ready(id); }
}
async function createDraft(code, kind, index = 0) {
  await action('create').click(); await ready();
  assert.equal(await role('manage-sensors').inputValue(), 'no');
  await fill(role('equipment-code'), code); await fill(role('equipment-name'), `${code} 验收机械`);
  await role('asset').selectOption(kind); await page.waitForFunction(kind => { const p=window.__managementWorkspace.machinery; return !p.loading && p.asset?.id === kind; }, kind);
  await fill(coord('longitude'), 116.391 + index * .0003); await fill(coord('latitude'), 39.907); await fill(coord('height'), 50); await fill(coord('heading'), index * 30);
  return page.evaluate(() => window.__managementWorkspace.machinery.selectedId);
}
async function save(type = 'machinery.save') {
  const pending = page.waitForResponse(r => { try { return r.url().endsWith('/__management/commands') && r.request().postDataJSON()?.type === type; } catch { return false; } });
  await action('save').click(); const response = await pending; assert.equal(response.status(), 200, await response.text());
  await page.waitForFunction(() => { const p = window.__managementWorkspace.machinery; return !p.hasDraft && !p.busy && !p.loading; });
}
async function command(type, id, payload, expectedRevision) {
  const response = await context.request.post(origin + '/__management/commands', { headers: { 'X-Cesium-Library': '1' }, data: { type, id, payload, expectedRevision, projectId: 'safety:project', idempotencyKey: crypto.randomUUID() } });
  return { response, data: await response.json() };
}
async function download(trigger) {
  const pending = page.waitForEvent('download', { timeout: 60000 }); await trigger(); const item = await pending;
  const path = resolve(output, item.suggestedFilename()); await item.saveAs(path); assert.equal(await item.failure(), null);
  const bytes = await readFile(path); assert(bytes.length); report.downloads.push({ name: item.suggestedFilename(), bytes: bytes.length }); return { path, bytes };
}
async function displayed(id) {
  await page.waitForFunction(id => { const s=window.__managementWorkspace.machinery.scene;return s.rendered.has(id) && !s.tasks.has(id) && !s.getError(id); }, id, { timeout: 60000 });
}
async function postPose(id, values) {
  const response = await context.request.post(origin + '/__management/machinery-telemetry', { headers: { 'X-Cesium-Library': '1' }, data: { schemaVersion: 1, projectId: 'safety:project', resourceId: id, sourceId: 'browser-sim', timestamp: new Date().toISOString(), mode: 'simulated', values } });
  assert.equal(response.status(), 202, await response.text());
  await page.waitForFunction(({ id, values }) => Object.entries(values).every(([key, value]) => Math.abs((window.__managementWorkspace.machinery.telemetry.getState(id)?.parameters[key] ?? NaN) - value) < 1e-7), { id, values });
}
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const launchOptions = process.env.BROWSER_LAUNCH_OPTIONS ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] };
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(launchOptions); context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true, timezoneId: 'Asia/Shanghai' }); page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('response', response => { if(response.status()>=400) console.log('HTTP', response.status(), response.url()); });
  page.on('pageerror', e => report.pageErrors.push({ check: activeCheck?.id, message: e.message }));
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({ check: activeCheck?.id, message: m.text().slice(0, 500) }); });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__managementWorkspace?.ui.getSnapshot()?.projectId, undefined, { timeout: 60000 }); await page.locator('#basemap').selectOption('none');
  await check('cancel-new-draft-keeps-ledger-empty', async () => {
    await openEditor(); const count = (await activeResources()).length; await action('create').click(); await ready();
    assert.equal(await role('asset').isDisabled(), true); assert.equal(await role('manage-sensors').inputValue(), 'no');
    await fill(role('equipment-code'), 'CANCEL-ME'); await fill(role('equipment-name'), '取消草稿不得落库'); await action('cancel').click(); await ready();
    assert.equal((await activeResources()).length, count); return { recordsBefore: count, recordsAfter: (await activeResources()).length };
  });
  await check('three-kinds-atomic-create-and-required-identity', async () => {
    for (const [index, kind] of ['crane', 'pile', 'excavator'].entries()) {
      const count = (await activeResources()).length, code = 'TEST-' + kind.toUpperCase(); const id = await createDraft(code, kind, index);
      assert.equal((await activeResources()).length, count, 'Draft has no resource until save'); await save('machinery.create'); await displayed(id);
      const saved = await record(id); assert.equal(saved.equipmentCode, code); assert.equal(saved.machinery.assetId, kind); assert.equal(saved.manageSensors, false); assert.equal(saved.revision, 1);
      assert.equal((await activeResources()).length, count + 1); machines.push({ id, code, kind });
    }
    await action('locate').click(); await page.waitForTimeout(1200); await capture('01-three-machine-kinds'); return { machines, records: (await activeResources()).length };
  });
  await check('duplicate-identity-is-rejected-atomically', async () => {
    const original = await record(machines[0].id), count = (await activeResources()).length;
    const duplicate = await command('machinery.create', 'equipment:duplicate-browser-fixture', { equipmentCode: original.equipmentCode, name: '不得创建', manageSensors: false, machinery: original.machinery });
    assert.equal(duplicate.response.status(), 400); await page.evaluate(() => window.__managementWorkspace.refreshMachineryContext());
    assert.equal((await activeResources()).length, count); assert.equal(await record('equipment:duplicate-browser-fixture'), undefined);
    return { status: duplicate.response.status(), code: duplicate.data.code, recordsUnchanged: true };
  });
  await check('manual-pose-recording-and-identity-edit-preserve-internal-id', async () => {
    const crane = machines[0]; await openEditor(crane.id); await action('pose-history').click(); assert.equal(await poseAction('process-csv').isDisabled(), true);
    await poseAction('start').click(); await fill(coord('heading'), 75); await fill(role('equipment-name'), '吊机姿态过程验收'); await save();
    assert.equal((await record(crane.id)).name, '吊机姿态过程验收'); assert.equal((await record(crane.id)).machinery.placement.heading, 75);
    assert.equal((await record(crane.id)).id, crane.id); assert((await page.evaluate(() => window.__managementWorkspace.machinery.capture.session.recorder.count)) >= 2);
    return { id: crane.id, stableInternalId: true, heading: 75, recordingStartedFromActualPose: true };
  });
  await check('sensor-choice-live-recording-and-process-csv', async () => {
    const crane = machines[0]; await role('manage-sensors').selectOption('yes'); await save(); assert.equal((await record(crane.id)).manageSensors, true);
    const row=panel().locator('[data-telemetry-target="boom_length_m"]'); await row.locator('[data-telemetry-input="enabled"]').check();
    await fill(row.locator('[data-telemetry-input="sourceId"]'), 'browser-sim'); await fill(row.locator('[data-telemetry-input="sourceField"]'), 'boom_length_m'); await action('telemetry-enable').click();
    await page.waitForFunction(() => window.__managementWorkspace.machinery.telemetry.enabledCount === 1);
    await postPose(crane.id, { boom_length_m: 38 }); const beforeClose = await page.evaluate(() => window.__managementWorkspace.machinery.capture.session.recorder.count);
    await action('close').click(); await postPose(crane.id, { boom_length_m: 40 }); await openEditor(crane.id);
    assert((await page.evaluate(() => window.__managementWorkspace.machinery.capture.session.recorder.count)) > beforeClose); await poseAction('stop').click();
    const csv=await download(() => poseAction('process-csv').click()); assert.equal(csv.bytes.subarray(0,3).toString('hex'), 'efbbbf'); const text=csv.bytes.toString('utf8');
    for (const pattern of [/机械识别号/, /TEST-CRANE/, /吊机/, /初始/, /模拟/, /38/, /40/, /北京时间/, /变化前|原值/, /变化后|新值/]) assert.match(text,pattern);
    const json=await download(() => poseAction('json').click()), archive=JSON.parse(json.bytes.toString('utf8'));
    const change=archive.entries.flatMap(e=>e.changes).find(c=>c.field==='boom_length_m' && c.value===40); assert(change?.samples[0]?.sampleTimestamp); assert.equal(change.source,'simulated');
    assert(archive.entries.every(e=>e.equipmentCode==='TEST-CRANE')); await capture('02-process-table-live-and-manual');
    return { entries: archive.entries.length, csvBytes: csv.bytes.length, sampleTimestamp: change.samples[0].sampleTimestamp, persistsWhilePanelClosed: true };
  });
  await check('process-table-current-all-time-range-and-empty-state', async () => {
    await openEditor(machines[1].id); assert.equal(await poseAction('process-csv').isDisabled(), true);
    await role('pose-export-scope').selectOption('all'); assert.equal(await poseAction('process-csv').isEnabled(), true);
    await fill(role('pose-export-from'), '2099-01-01T00:00'); await role('pose-export-from').press('Tab'); assert.equal(await poseAction('process-csv').isDisabled(), true);
    assert.match(await role('pose-export-count').innerText(), /0/); await poseAction('reset-range').click(); assert.equal(await poseAction('process-csv').isEnabled(), true);
    await role('pose-export-scope').selectOption('current'); await openEditor(machines[0].id); assert.equal(await poseAction('process-csv').isEnabled(), true);
    return { unrecordedMechanicalScopeDisabled: true, projectScopeIncludesRecordedMachine: true, futureRangeEmpty: true };
  });
  await check('server-disabled-sensors-do-not-revive-from-browser-settings', async () => {
    const crane=machines[0], current=await record(crane.id);
    const disabled=await command('machinery.save',crane.id,{machinery:current.machinery,manageSensors:false},current.revision); assert.equal(disabled.response.status(),200);
    await page.evaluate(()=>window.__managementWorkspace.refreshMachineryContext()); await page.waitForFunction(()=>window.__managementWorkspace.machinery.telemetry.enabledCount===0);
    await page.reload({waitUntil:'domcontentloaded'}); await page.waitForFunction(()=>window.__managementWorkspace?.ui.getSnapshot()?.projectId); await openEditor(crane.id);
    assert.equal(await role('manage-sensors').inputValue(),'no'); assert.equal(await page.evaluate(()=>window.__managementWorkspace.machinery.telemetry.enabledCount),0);
    await role('manage-sensors').selectOption('yes'); await save(); await action('telemetry-enable').click(); await page.waitForFunction(()=>window.__managementWorkspace.machinery.telemetry.enabledCount===1);
    return { remoteDisableApplied:true, browserReloadRemainsDisabled:true, explicitReenableWorks:true };
  });
  await check('delete-configured-machine-clears-scene-live-state-and-directory', async () => {
    const crane=machines[0]; await action('remove').click(); await action('confirm-discard').click();
    await page.waitForFunction(id=>!window.__managementWorkspace.getWorkbenchMachineryState().resources.some(x=>x.record.id===id),crane.id);
    await page.waitForFunction(id=>!window.__managementWorkspace.machinery.scene.rendered.has(id) && !window.__managementWorkspace.machinery.telemetry.isEnabled(id),crane.id);
    await action('close').click(); await page.locator('[data-dock="display"]').click(); assert.equal(await page.locator(`[data-display-id="machine:${crane.id}"]`).count(),0);
    const item=await record(crane.id); assert(!item || item.status==='deleted' || item.deletedAt);
    await page.reload({waitUntil:'domcontentloaded'}); await page.waitForFunction(()=>window.__managementWorkspace?.ui.getSnapshot()?.projectId);
    assert(!(await activeResources()).some(r=>r.id===crane.id)); return { deletedId: crane.id, survivesReload: true, sceneAndSensorStateCleared: true };
  });
  await check('legacy-unplaced-machine-can-be-deleted-from-scene-directory', async () => {
    const id='equipment:legacy-unplaced-fixture'; const response=await command('resource.create',id,{name:'待布置旧机械',kind:'equipment'}); assert.equal(response.response.status(),200);
    await page.evaluate(()=>window.__managementWorkspace.refreshMachineryContext()); await page.locator('[data-dock="display"]').click();
    const row=page.locator(`[data-display-id="machine:${id}"]`); await row.waitFor(); assert.match(await row.innerText(),/待布置|尚未布置/); assert.equal(await row.locator('[data-action="item-remove"]').count(),1);
    page.once('dialog', dialog=>dialog.accept()); await row.locator('[data-action="item-remove"]').click(); await row.waitFor({state:'detached'});
    await page.evaluate(()=>window.__managementWorkspace.refreshMachineryContext()); assert(!(await activeResources()).some(r=>r.id===id));
    await capture('03-deleted-machinery-directory'); return { unplacedDeletionAvailable: true, removedFromActiveLedger: true };
  });
  await check('management-resource-entry-uses-same-editor-and-deleted-rows-stay-absent', async () => {
    await page.locator('#openSafetyWorkspace').click(); await page.waitForFunction(()=>window.__managementWorkspace.isOpen);
    await page.evaluate(()=>window.__managementWorkspace.ui.changeModule('resources','equipment',true));
    const workspace=page.locator('#mg-workspace'); await workspace.waitFor({state:'visible'});
    assert(!(await workspace.innerText()).includes('吊机姿态过程验收')); assert(!(await workspace.innerText()).includes('待布置旧机械'));
    const count=(await activeResources()).length; await workspace.locator('[data-mg-command="resource.create"]').first().click(); await panel().waitFor({state:'visible'}); await ready();
    assert.equal(await role('equipment-code').inputValue(),''); assert.equal(await page.locator('.machinery-panel').count(),1);
    await fill(role('equipment-code'),'MANAGEMENT-CANCEL'); await action('cancel').click(); await ready(); assert.equal((await activeResources()).length,count);
    await action('close').click(); await page.evaluate(id=>{ const ui=window.__managementWorkspace.ui;ui.changeModule('resources','equipment',true);ui.showRecord('resources',id); },machines[1].id);
    await page.locator('[data-mg-drawer] [data-mg-action="field-edit-machine"]').click(); await panel().waitFor({state:'visible'}); await ready(machines[1].id);
    assert.equal(await page.locator('[data-mg-drawer]').innerText(),''); assert.equal(await role('equipment-code').inputValue(),machines[1].code);
    await capture('04-unified-resource-editor'); return { oneSharedEditor:true, managementCreateDoesNotCreateEmptyLedger:true, detailsDrawerCleared:true, deletedResourcesNotListed:true };
  });
  assert.deepEqual(report.pageErrors,[]); assert.deepEqual(report.consoleErrors,[]); report.result='passed';
} catch(error) {
  report.result='failed'; report.failure=String(error.stack||error); process.exitCode=1;
  if(activeCheck?.status==='running'){activeCheck.status='failed';activeCheck.error=report.failure;}
  console.error(error); if(page){await capture('failure').catch(()=>{});report.visibleText=(await page.locator('body').innerText().catch(()=>'' )).slice(-14000);}
} finally {
  report.finishedAt=new Date().toISOString(); await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({result:report.result,checks:report.checks,pageErrors:report.pageErrors,consoleErrors:report.consoleErrors,failure:report.failure},null,2));
  await context?.close();await browser?.close();await server?.close();
}
