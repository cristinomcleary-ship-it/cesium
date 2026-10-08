/** Actual HTTP, isolated-data acceptance for the management redesign.
 * No GPU, browser, formal project records, fake model picking, or Git changes.
 * Run: node --experimental-transform-types --import ./tools/test-module-loader.mjs tools/verify-management-api.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const output = path.join(root, 'output/platform-management');
await mkdir(output, { recursive: true });
await mkdir(path.join(root, 'tmp'), { recursive: true });
const work = await mkdtemp(path.join(root, 'tmp/management-http-acceptance-'));
const report = { schemaVersion: 1, classification: 'actual-http-isolated-test-data', startedAt: new Date().toISOString(),
  isolatedDataDirectory: work, formalDataReadOrModified: false, browserOrGpuUsed: false,
  checks: [], requests: [], sections: [], evidence: {}, exclusions: [
    'No actual model picking, manual geometry UI, camera/Viewer, media decoding, or responsive layout is claimed.',
    'Spatial association fixtures are isolated references; they do not constitute A02/A03/A04 user-picking evidence.',
    'Asset access middleware is mounted in this HTTP harness; the actual Vite route chain needs separate production verification.',
  ] };
report.sourceHashes = {};
for (const file of ['tools/verify-management-api.mjs', 'server/managementStore.ts', 'server/management/domain.ts', 'server/management/metrics.ts', 'server/management/actorContext.ts', 'src/managementTypes.ts']) {
  report.sourceHashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}
let server, store, origin, projectId, ownerId;
const sessions = { owner: { cookie: '' }, viewer: { cookie: '' } };
const records = new Map();
const receiptIds = new Map();
const fixtureAreas = new Map([
  ['http-area-a', { id: 'http-area-a', kind: 'construction-area', name: '隔离引用A', revision: 1,
    projectId: 'http-acceptance', source: 'isolated-reference-fixture', modelVersionId: 'fixture-model', transformVersionId: 'fixture-transform',
    geometry: { type: 'Polygon', coordinates: [[[120, 30, 10], [120.0001, 30, 10], [120.0001, 30.0001, 10], [120, 30, 10]]] } }],
  ['http-area-b', { id: 'http-area-b', kind: 'construction-area', name: '隔离引用B', revision: 1,
    projectId: 'http-acceptance', source: 'isolated-reference-fixture', modelVersionId: 'fixture-model', transformVersionId: 'fixture-transform',
    geometry: { type: 'Polygon', coordinates: [[[120, 30, 20], [120.0001, 30, 20], [120.0001, 30.0001, 20], [120, 30, 20]]] } }],
  ['http-risk-a', { id: 'http-risk-a', kind: 'risk-point', name: '隔离位置引用', revision: 1,
    projectId: 'http-acceptance', source: 'isolated-reference-fixture', modelVersionId: 'fixture-model', transformVersionId: 'fixture-transform',
    geometry: { type: 'Point', coordinates: [120, 30, 10] } }],
]);
const iso = () => new Date().toISOString();
const D = new Date().toISOString().slice(0, 10);
const day = (delta = 0) => new Date(Date.parse(`${D}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
const workday = delta => { let value=day(delta); if(new Date(value+'T00:00:00Z').getUTCDay()===0)value=day(delta+1); return value; };
const pause = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const digest = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
function check(name, actual, expected = true, gates = [], extra) {
  const passed = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  report.checks.push({ name, gates, passed, actual, expected: typeof expected === 'function' ? 'predicate' : expected, ...(extra ? { evidence: extra } : {}) });
  return passed;
}
function requireCheck(name, actual, expected = true, gates = [], extra) {
  const passed = check(name, actual, expected, gates, extra);
  assert.ok(passed, name);
}
async function http(url, options = {}, session = 'owner') {
  const headers = { 'X-Cesium-Library': '1', ...(options.headers || {}) };
  if (session && sessions[session]?.cookie) headers.Cookie = sessions[session].cookie;
  const response = await fetch(`${origin}${url}`, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (session && setCookie) sessions[session].cookie = setCookie.split(';')[0];
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  let command;
  if (url === '/__management/commands' && typeof options.body === 'string') command = JSON.parse(options.body).type;
  report.requests.push({ seq: report.requests.length + 1, at: iso(), method: options.method || 'GET',
    path: url, role: session || 'unauthenticated', status: response.status,
    code: data?.code, command, recordId: data?.record?.id || data?.id, revision: data?.record?.revision || data?.revision });
  return { status: response.status, data, headers: response.headers };
}
async function post(url, payload, session = 'owner') {
  return http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, session);
}
async function cmd(type, payload = {}, record, extra = {}) {
  const request = { projectId, type, idempotencyKey: extra.key || randomUUID(), payload,
    ...(record ? { id: typeof record === 'string' ? record : record.id,
      expectedRevision: extra.expectedRevision ?? (typeof record === 'string' ? records.get(record)?.revision : record.revision) } : {}),
    ...(extra.id ? { id: extra.id } : {}) };
  const result = await post('/__management/commands', request, extra.session || 'owner');
  if (extra.expect) {
    check(extra.label || `${type} rejected`, result.status, Array.isArray(extra.expect) ? value => extra.expect.includes(value) : extra.expect, extra.gates || [], { code: result.data?.code });
    return result;
  }
  assert.ok(result.status >= 200 && result.status < 300, `${type}: ${result.status} ${JSON.stringify(result.data)}`);
  let saved = result.data.record || result.data.value || result.data;
  if (result.data.collections) {
    const savedId = receiptIds.get(request.idempotencyKey) || result.data.audit?.[0]?.recordId;
    saved = Object.values(result.data.collections).flat().find(r => r.id === savedId)
      || result.data.members?.find(r => r.id === savedId) || result.data.projects?.find(r => r.id === savedId);
    if (type === 'member.save') saved = result.data.members.find(r => r.username === payload.username);
    if (type === 'project.create') saved = result.data.projects.find(r => r.id === payload.id);
  }
  assert.ok(saved.id && Number.isInteger(saved.revision), `${type}: missing persisted ID/revision`);
  Object.assign(report.requests.at(-1), {recordId:saved.id,recordRevision:saved.revision});
  records.set(saved.id, saved);
  receiptIds.set(request.idempotencyKey, saved.id);
  return saved;
}
async function snapshot(session = 'owner') {
  const r = await http(`/__management/state?projectId=${encodeURIComponent(projectId || 'http-acceptance')}`, {}, session);
  assert.equal(r.status, 200, `state: ${JSON.stringify(r.data)}`);
  return r.data;
}
async function current(kind, id) {
  const s = await snapshot();
  const r = s.collections[kind].find(v => v.id === id);
  assert.ok(r, `${kind}/${id} absent after HTTP reload`);
  records.set(id, r);
  return r;
}
async function metrics(F, filters = {}, businessDate = D) {
  const query = new URLSearchParams({ projectId, D: businessDate, F: F || iso() });
  for (const id of filters.taskIds || []) query.append('taskId', id);
  for (const id of filters.areaIds || []) query.append('areaId', id);
  for (const key of ['ownerId','status','query','periodStart','periodEnd']) if (filters[key]) query.set(key, filters[key]);
  const r = await http(`/__management/metrics?${query}`);
  assert.equal(r.status, 200, `metrics: ${JSON.stringify(r.data)}`);
  return r.data;
}
const metric = (m, id) => { const v = m.metrics.find(x => x.id === id); assert.ok(v, `Metric ${id} missing`); return v; };
const quantity = (m, taskId) => m.taskProgress.find(x => x.taskId === taskId)?.quantity;
async function section(name, gates, action) {
  const start = report.checks.length;
  try { await action(); report.sections.push({ name, gates, status: report.checks.slice(start).some(c => !c.passed) ? 'failed' : 'passed' }); }
  catch (error) { report.sections.push({ name, gates, status: 'failed', error: String(error.stack || error) }); check(`${name}: execution reached all required assertions`, false, true, gates); }
  await flush();
}
async function upload(name, bytes = Buffer.from('Isolated HTTP acceptance evidence\n')) {
  const r = await http(`/__management/upload?${new URLSearchParams({ projectId, name })}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.ok(r.status >= 200 && r.status < 300, `upload: ${r.status} ${JSON.stringify(r.data)}`);
  const e = r.data.record || r.data.evidence || r.data;
  assert.ok(e.id, 'Uploaded evidence ID'); records.set(e.id, e); return e;
}
async function flush() {
  report.updatedAt = iso();
  report.summary = { checks: report.checks.length, passed: report.checks.filter(c => c.passed).length,
    failed: report.checks.filter(c => !c.passed).length, httpRequests: report.requests.length };
  await writeFile(path.join(output, 'api-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
}

let task, task2, taskNoWeight, wbs, baseline, evidence, progress, commitment, inspection;
try {
  const modulePath = path.join(root, 'server/managementStore.ts');
  const { createManagementStore } = await import(pathToFileURL(modulePath).href);
  const storeOptions = { dataDir: work, projectId: 'http-acceptance', projectName: '隔离HTTP验收项目',
    localCompatibility: true,
    resolveSpatialReference: async (...args) => fixtureAreas.get(args.find(a => typeof a === 'string' && fixtureAreas.has(a))) || null,
    resolveLibraryEvidence: async () => null };
  store = await createManagementStore(storeOptions);
  server = createServer((request, response) => {
    const terminal = () => { response.statusCode = 200; response.setHeader('Content-Type', 'text/plain'); response.end('ISOLATED_LEGACY_ASSET_BYTES'); };
    const managed = () => { Promise.resolve(store.middleware(request, response, terminal)).catch(error => { response.statusCode = 500; response.end(String(error)); }); };
    Promise.resolve(store.accessMiddleware(request, response, managed)).catch(error => { response.statusCode = 500; response.end(String(error)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  report.origin = origin;
  const initial = await snapshot(); projectId = initial.projectId;
  requireCheck('Brand-new isolated management project has no seeded business records',
    Object.values(initial.collections).reduce((sum, list) => sum + list.length, 0), 0, ['A02']);
  report.evidence.initialCollections = Object.fromEntries(Object.entries(initial.collections).map(([key, value]) => [key, value.length]));
  const pass = `acceptance-${randomUUID()}`;
  const firstMember = await cmd('member.save', { username: 'http-owner', displayName: '隔离测试管理员', password: pass,
    roles: ['owner'], resourceAccess: { models: true, files: true, media: true } });
  ownerId = firstMember.id;
  evidence = await upload('verified-evidence.txt');

  await section('Task identity, WBS, many-to-many association and baseline', ['A05', 'A07'], async () => {
    await cmd('task.create',{name:'不存在的空间关联',areaIds:['missing-area']},undefined,{expect:400,gates:['A05'],label:'Reject nonexistent callback spatial reference'});
    wbs = await cmd('wbs.create', { name: '隔离工作包' });
    task = await cmd('task.create', { name: '隔离主任务', ownerId, wbsId: wbs.id, areaIds: ['http-area-a', 'http-area-b'],
      planStart: workday(-3), planEnd: workday(3), targetQuantity: 100, unit: 'm3', weight: 1, milestone: true });
    const originalTaskId = task.id;
    task = await cmd('task.publish', {}, task);
    task2 = await cmd('task.create', { name: '隔离另一个任务', ownerId, planStart: workday(4), planEnd: workday(8),
      targetQuantity: 20, unit: 't', weight: 1 });
    task2 = await cmd('task.publish', {}, task2);
    check('Task without spatial location is valid and publishable', task2.areaIds, [], ['A05']);
    const parent = await cmd('wbs.create', { name: '调整后父工作包' });
    wbs = await cmd('wbs.update', { name: '移动后工作包', parentId: parent.id }, wbs);
    const geometryBefore = digest([...fixtureAreas]);
    task = await cmd('task.update', { name: task.name, areaIds: ['http-area-b'], reason: '解除一处关联' }, task);
    check('WBS movement and unlink preserve task identity', task.id, originalTaskId, ['A05']);
    check('Association operations do not rewrite fixture geometry', digest([...fixtureAreas]), geometryBefore, ['A05']);
    task = await cmd('task.update', { name: task.name, areaIds: ['http-area-a', 'http-area-b'], reason: '恢复两处关联' }, task);
    const scoped = await metrics(undefined, { areaIds: ['http-area-a', 'http-area-b'] });
    check('Two matching areas return one stable task in metric drilldown', metric(scoped, 'confirmed-progress').detailIds, [task.id], ['A05', 'A17']);
    baseline = await cmd('baseline.create', { name: '不可覆盖批准基线', taskIds: [task.id, task2.id] });
    baseline = await cmd('baseline.approve', {}, baseline);
    const frozenItems = digest(baseline.items);
    task = await cmd('task.update', { name: task.name, planStart: task.planStart, planEnd: day(5), reason: '核准后的当前计划调整' }, task);
    check('Current plan edit preserves approved baseline items', digest((await current('baselines', baseline.id)).items), frozenItems, ['A07']);
    await cmd('task.update', { name: task.name, planStart: day(10), planEnd: day(2), reason: '无效日期' }, task,
      { expect: 400, gates: ['A07'], label: 'Reject impossible task dates' });
    const cycleTask = await cmd('task.create', { name: '无日期依赖测试' });
    const cycleTask2 = await cmd('task.create', { name: '无日期依赖测试二', predecessorIds: [cycleTask.id] });
    await cmd('task.update', { name: cycleTask.name, predecessorIds: [cycleTask2.id] }, cycleTask,
      { expect: 409, gates: ['A07'], label: 'Reject dependency cycle with affected task' });
    report.evidence.taskIds = [task.id, task2.id]; report.evidence.baselineId = baseline.id;
  });

  await section('Unique progress ledger, idempotency, revision replacement and D/F snapshot', ['A08', 'A09', 'A17', 'A18'], async () => {
    assert.ok(task, 'Task prerequisite');
    const payload = { taskId: task.id, businessDate: D, shift: 'day', crew: 'A', measurementKey: 'batch-a', quantity: 20,
      unit: 'm3', evidenceIds: [evidence.id] };
    const key = randomUUID();
    progress = await cmd('progress.create', payload, undefined, { key });
    const repeated = await cmd('progress.create', payload, undefined, { key });
    check('Same idempotency key reuses same progress record and revision', [repeated.id, repeated.revision], [progress.id, progress.revision], ['A08', 'A18']);
    await cmd('progress.create', payload, undefined, { expect: 409, gates: ['A08'], label: 'Separate key cannot duplicate same date/crew/batch ledger' });
    progress = await cmd('progress.submit', {}, progress);
    check('Submitted progress excluded from confirmed quantity', quantity(await metrics(), task.id), 0, ['A08']);
    progress = await cmd('progress.confirm', {}, progress);
    await cmd('dailyLog.create', { taskId: task.id, businessDate: D, progressEntryIds: [progress.id], description: '引用同笔完成量' });
    check('Daily log reference does not add progress twice', quantity(await metrics(), task.id), 20, ['A08']);
    const firstF = iso(); await pause();
    const oldReport = await cmd('report.freeze', { name: '固定历史报告', D, F: firstF, businessAsOf: D, confirmedAsOf: firstF, template: 'project-weekly' });
    const oldReportHash = digest(oldReport);
    check('Frozen report records exact effective progress revision', oldReport.taskProgress.find(p=>p.taskId===task.id)?.entryRevisions, [{entryId:progress.id,revision:1}], ['A17']);
    progress = await cmd('progress.revise', { ...payload, quantity: 30, reason: '纠正原20为30' }, progress);
    check('Unconfirmed correction keeps previous confirmed quantity', quantity(await metrics(), task.id), 20, ['A08']);
    progress = await cmd('progress.submit', {}, progress);
    progress = await cmd('progress.return', { reason: '补充复测依据' }, progress);
    check('Returned correction keeps previous confirmed quantity', quantity(await metrics(), task.id), 20, ['A08']);
    progress = await cmd('progress.submit', {}, progress);
    progress = await cmd('progress.confirm', {}, progress);
    check('Confirmed correction replaces quantity rather than adds', quantity(await metrics(), task.id), 30, ['A08']);
    const offsetF=new Date(Date.parse(firstF)+8*3600000).toISOString().replace('Z','+08:00');
    check('Equivalent +08 confirmation cutoff selects identical historical quantity',quantity(await metrics(offsetF),task.id),20,['A17']);
    check('Historical confirmation cutoff still returns former effective revision', quantity(await metrics(firstF), task.id), 20, ['A17']);
    check('Historical report bytes unchanged after correction', digest(await current('reports', oldReport.id)), oldReportHash, ['A17']);
    const newReport = await cmd('report.freeze', { name: '更正后报告', D, F: iso(), businessAsOf: D, confirmedAsOf: iso(), template: 'project-weekly' });
    check('New report freezes corrected effective revision', newReport.taskProgress.find(p=>p.taskId===task.id)?.entryRevisions, [{entryId:progress.id,revision:2}], ['A17']);
    check('New report has independent stable snapshot ID', newReport.id !== oldReport.id, true, ['A17']);
    report.evidence.progress = { id: progress.id, confirmedRevisions: progress.confirmations, oldF: firstF,
      oldReportId: oldReport.id, newReportId: newReport.id, oldReportHash };
    taskNoWeight = await cmd('task.create', { name: '缺权重任务', ownerId, planStart: workday(-1), planEnd: workday(2), targetQuantity: 20, unit: 'kg' });
    taskNoWeight = await cmd('task.publish', {}, taskNoWeight);
    check('Mixed units plus missing effective baseline/weight cannot manufacture overall percentage', metric(await metrics(), 'confirmed-progress').value, null, ['A09']);
    commitment = await cmd('commitment.create', { taskId: task.id, name: '长任务仅承诺本周30', weekStart: day(-3),
      originalDueDate: D, dueDate: D, targetQuantity: 30, unit: 'm3', basis: 'incremental', criterion: '本周新增确认30m3' });
    commitment = await cmd('commitment.publish', {}, commitment);
    const metricBefore = metric(await metrics(), 'weekly-commitment');
    check('Partial overall task can fulfill full weekly target', [metricBefore.numerator, metricBefore.denominator], [1, 1], ['A09']);
    commitment = await cmd('commitment.change', { action: 'reschedule', dueDate: day(5), reason: '执行窗口调整' }, commitment);
    commitment = await cmd('commitment.change', { action: 'cancel', reason: '保留原周承诺分母' }, commitment);
    check('Cancelled/rescheduled weekly item remains original denominator', metric(await metrics(), 'weekly-commitment').denominator, 1, ['A09']);
    check('Weekly original target and deadline remain immutable', [commitment.targetQuantity, commitment.originalDueDate], [30, D], ['A09']);
    let previousWeek = await cmd('commitment.create',{taskId:task.id,name:'前周承诺',weekStart:day(-14),originalDueDate:day(-8),targetQuantity:1,unit:'m3',basis:'incremental',criterion:'前周新增1'});
    previousWeek = await cmd('commitment.publish',{},previousWeek);
    check('Current-week metric excludes earlier published week',metric(await metrics(),'weekly-commitment').denominator,1,['A09']);
    check('Explicit historical period returns original-week denominator',metric(await metrics(undefined,{periodStart:day(-14),periodEnd:day(-8)}),'weekly-commitment').denominator,1,['A09','A17']);
    const beforeConcurrency = await current('tasks', task.id);
    const first = { projectId, type: 'task.forecast', id: task.id, expectedRevision: beforeConcurrency.revision,
      idempotencyKey: randomUUID(), payload: { forecastEnd: day(8), reason: '并发甲' } };
    const second = { ...first, idempotencyKey: randomUUID(), payload: { forecastEnd: day(9), reason: '并发乙' } };
    const concurrent = await Promise.all([post('/__management/commands', first), post('/__management/commands', second)]);
    check('Two simultaneous writes to same revision permit only one commit', concurrent.map(r => r.status).sort(), [200, 409], ['A18']);
    const conflict = concurrent.find(r => r.status === 409);
    check('Conflict gives current revision for retained-draft comparison', Boolean(conflict?.data.current?.revision), true, ['A18']);
    task = await current('tasks', task.id);
  });

  await section('Check completion versus readiness, two rectification rounds and historic risk position', ['A10', 'A11'], async () => {
    let checkRun = await cmd('check.create', { name: '隔离首次验收', taskId: task.id, businessDate: D,
      inspectionObjectId: 'quality-object-1', purpose:'acceptance', items: [{ id: 'item-one', name: '本次结构检查', required: true }] });
    checkRun = await cmd('check.record', { items: [{ id: 'item-one', result: 'fail', evidenceIds: [evidence.id] }] }, checkRun);
    checkRun = await cmd('check.confirm', {}, checkRun);
    check('Failed check counts as checked but never satisfied', [checkRun.status, checkRun.satisfied], ['confirmed', false], ['A10']);
    const next = await cmd('check.copy', { sourceId: checkRun.id, businessDate: day(1), taskId: task.id });
    check('Next-day copied checklist has no previous result/signoff/evidence',
      [next.items.every(i => i.result === 'pending' && !i.evidenceIds?.length), Boolean(next.confirmedAt)], [true, false], ['A10']);
    let issue = await cmd('issue.create', { name: '首次检查不合格整改', kind: 'quality', taskId: task.id,
      checkId: checkRun.id, evidenceIds: [evidence.id] });
    issue = await cmd('issue.assign', { ownerId, dueDate: D }, issue);
    issue = await cmd('issue.submit', { description: '第一轮整改', evidenceIds: [evidence.id] }, issue);
    issue = await cmd('issue.review', { passed: false, reason: '仍不满足', evidenceIds: [evidence.id] }, issue);
    check('Rejected review returns to rectification with first-round history', [issue.status, issue.rounds.length], ['rectifying', 1], ['A10']);
    issue = await cmd('issue.submit', { description: '第二轮整改', evidenceIds: [evidence.id] }, issue);
    issue = await cmd('issue.review', { passed: true, reason: '复核满足', evidenceIds: [evidence.id] }, issue);
    check('Two rectification rounds retain their separate review outcomes', issue.rounds.map(r => r.passed), [false, true], ['A10']);
    check('Issue source and original deadline survive processing', [issue.checkId, issue.originalDueDate], [checkRun.id, D], ['A10']);
    let retest = await cmd('check.create', { name: '隔离复检', taskId: task.id, businessDate: D,
      inspectionObjectId: 'quality-object-1', purpose:'acceptance', items: [{ id: 'retest-one', name: '复检', required: true }] });
    retest = await cmd('check.record', { items: [{ id: 'retest-one', result: 'pass', evidenceIds: [evidence.id] }] }, retest);
    retest = await cmd('check.confirm', {}, retest);
    check('Quality acceptance is not counted as preconstruction checklist',metric(await metrics(),'precheck-completion').denominator,0,['A10','A11']);
    check('Successful retest never overwrites first failed acceptance', metric(await metrics(), 'first-quality-pass').numerator, 0, ['A11']);
    let precheck=await cmd('check.create',{name:'施工前核验',taskId:task.id,businessDate:D,purpose:'preconstruction',inspectionObjectId:'prestart-object',items:[{id:'pre-one',name:'施工条件',required:true}]});
    precheck=await cmd('check.record',{items:[{id:'pre-one',result:'fail',evidenceIds:[evidence.id]}]},precheck);
    precheck=await cmd('check.confirm',{},precheck);
    const preMetric=metric(await metrics(),'precheck-completion');
    check('Failed preconstruction check counts as checked while unsatisfied',[preMetric.numerator,preMetric.denominator,precheck.satisfied],[1,1,false],['A10']);
    check('Preconstruction failure does not alter quality-first-pass denominator',metric(await metrics(),'first-quality-pass').denominator,1,['A11']);
    const risk = fixtureAreas.get('http-risk-a');
    const e1 = await cmd('issue.create', { name: '同点事件一', kind: 'safety', taskId: task.id, riskPointId: risk.id });
    const e2 = await cmd('issue.create', { name: '同点事件二', kind: 'safety', taskId: task.id, riskPointId: risk.id });
    const savedPosition = (await current('issues', e1.id)).positionSnapshot;
    check('Events referencing one risk point have independent identities', e1.id !== e2.id, true, ['A11']);
    check('Server captures historical risk geometry/version snapshot', Boolean(savedPosition), true, ['A11']);
    const snapshotHash = digest(savedPosition ?? null);
    risk.revision++; risk.geometry.coordinates = [120.00005, 30, 20];
    check('Changing current risk reference cannot rewrite historical event', digest((await current('issues', e1.id)).positionSnapshot ?? null), snapshotHash, ['A11']);
    report.evidence.issue = { id: issue.id, rounds: issue.rounds, sourceCheckId: checkRun.id,
      firstAcceptanceId: checkRun.id, retestId: retest.id, safetyEventIds: [e1.id, e2.id], locationSnapshotHash: snapshotHash };
  });

  await section('Inspection instances and historical confirmation cutoff', ['A12', 'A17'], async () => {
    inspection = await cmd('inspection.create', { name: '本期巡检实例', taskId: task.id, ownerId, dueDate: D,
      scheduledDate: D, planId: 'recurring-plan-1' });
    check('Uploaded file alone cannot complete inspection instance', metric(await metrics(), 'inspection-completion').numerator, 0, ['A12']);
    inspection = await cmd('inspection.record', { result: '已检查并提交待确认', evidenceIds: [evidence.id] }, inspection);
    check('Recorded inspection awaiting confirmation still not complete', metric(await metrics(), 'inspection-completion').numerator, 0, ['A12']);
    const F = iso(); await pause();
    inspection = await cmd('inspection.confirm', {}, inspection);
    check('Confirmation completes exactly the selected instance', metric(await metrics(), 'inspection-completion').numerator, 1, ['A12']);
    check('Earlier F does not see a later inspection confirmation', metric(await metrics(F), 'inspection-completion').numerator, 0, ['A17']);
    report.evidence.inspection = { id: inspection.id, earlyF: F, confirmedAt: inspection.confirmedAt };
  });

  await section('Resource receipt, valid inspection and allocation conflict', ['A15'], async () => {
    const resource = await cmd('resource.create', { name: '钢筋物料', kind: 'material', unit: 't', ownerId });
    let need = await cmd('need.create', { name: '主任务钢筋需求', taskId: task.id, kind: 'material', resourceId: resource.id,
      dueDate: day(1), quantity: 10, unit: 't', required: true, ownerId });
    let batch = await cmd('batch.create', { name: '隔离批次', resourceId: resource.id, batchNumber: 'HTTP-B01', unit: 't' });
    batch = await cmd('batch.receive', { quantity: 20, businessDate: D, evidenceIds: [evidence.id] }, batch);
    check('Arrival creates receipt but no available quantity', batch.availableQuantity, 0, ['A15']);
    await cmd('need.confirm', { basis: '只到货不够', batchId: batch.id }, need,
      { expect: 400, gates: ['A15'], label: 'Arrival alone rejected as ready' });
    batch = await cmd('batch.accept', { passed: true, basis: '到货验收', evidenceIds: [evidence.id] }, batch);
    await cmd('need.confirm', { basis: '未试验仍不足', batchId: batch.id }, need,
      { expect: 400, gates: ['A15'], label: 'Accepted batch without valid test remains unready' });
    let test = await cmd('test.create', { name: '材料复验报告', batchId: batch.id, result: 'pass', businessDate: D,
      validUntil: day(10), evidenceIds: [evidence.id] });
    test = await cmd('test.confirm', { result: 'pass', evidenceIds: [evidence.id] }, test);
    need = await cmd('need.confirm', { basis: '验收合格且试验有效', batchId: batch.id, evidenceIds: [evidence.id] }, need);
    check('Readiness references actual accepted batch and confirmed test', [need.status, need.batchId, need.testId], ['confirmed', batch.id, test.id], ['A15']);
    await cmd('material.issue', { batchId: batch.id, taskId: task.id, quantity: 5, businessDate: D });
    await cmd('material.return', { batchId: batch.id, taskId: task.id, quantity: 2, businessDate: D });
    check('Auditable receipt/issue/return yields expected available quantity', (await current('batches', batch.id)).availableQuantity, 17, ['A15']);
    const remoteNeed=await cmd('need.create',{name:'远期不计近期窗口',taskId:task2.id,kind:'material',dueDate:day(30),quantity:1,unit:'t'});
    check('Future-30-day need is excluded from near-term denominator',metric(await metrics(),'resource-readiness').denominator,1,['A15']);
    const equipment = await cmd('resource.create', { name: '单台汽车吊', kind: 'equipment', ownerId, availability: 'available' });
    let allocation = await cmd('allocation.create', { taskId: task.id, resourceId: equipment.id,
      startsAt: `${D}T01:00:00Z`, endsAt: `${D}T04:00:00Z` });
    const denied = await cmd('allocation.create', { taskId: task2.id, resourceId: equipment.id,
      startsAt: `${D}T02:00:00Z`, endsAt: `${D}T05:00:00Z` }, undefined,
      { expect: 409, gates: ['A15'], label: 'Same equipment overlapping task allocation rejected' });
    check('Conflict identifies the affected existing task', Boolean(denied.data.details?.some(v => v.taskId === task.id)), true, ['A15']);
    allocation = await cmd('allocation.cancel', { reason: '人工协调撤销旧占用' }, allocation);
    const revised = await cmd('allocation.create', { taskId: task2.id, resourceId: equipment.id,
      startsAt: `${D}T02:00:00Z`, endsAt: `${D}T05:00:00Z` });
    check('Explicit coordination permits replacement allocation', revised.status, 'scheduled', ['A15']);
    report.evidence.resources = { needId: need.id, batchId: batch.id, testId: test.id, allocations: [allocation.id, revised.id] };
  });

  await section('Document publication, links, formal technical answer and unchanged plan baseline', ['A16', 'A17'], async () => {
    const doc = await cmd('document.create', { name: '本任务有效图纸', category: '图纸', taskIds: [task.id, task2.id] });
    let v1 = await cmd('document.version', { documentId: doc.id, evidenceId: evidence.id, revisionNote: '第一版' });
    check('Uploaded document version starts as draft', v1.status, 'draft', ['A16']);
    v1 = await cmd('document.publish', { basis: '隔离授权发布' }, v1);
    const fixedLink = await cmd('link.create', { taskId: task.id, targetKind: 'documentVersions', targetId: v1.id });
    let link = await cmd('link.create', { taskId: task.id, targetKind: 'documents', targetId: doc.id });
    const link2 = await cmd('link.create', { taskId: task2.id, targetKind: 'documents', targetId: doc.id });
    let v2 = await cmd('document.version', { documentId: doc.id, evidenceId: evidence.id, revisionNote: '待审第二版' });
    check('New upload does not replace effective old version', (await current('documents', doc.id)).effectiveVersionId, v1.id, ['A16']);
    let requirement = await cmd('document.requirement', { name: '本任务图纸交付', taskId: task.id, ownerId, dueDate: D });
    await cmd('document.fulfill', { versionId: v2.id }, requirement,
      { expect: 400, gates: ['A16'], label: 'Unpublished draft cannot satisfy document delivery' });
    v2 = await cmd('document.submit', { reviewerId: ownerId, dueDate: D }, v2);
    v2 = await cmd('document.publish', { basis: '正式第二版发布' }, v2);
    requirement = await cmd('document.fulfill', { versionId: v2.id }, requirement);
    check('Publication activates correct version and preserves former version',
      [(await current('documents', doc.id)).effectiveVersionId, (await current('documentVersions', v1.id)).status], [v2.id, 'superseded'], ['A16']);
    check('Historical pinned link stays on first version', (await current('links', fixedLink.id)).targetId, v1.id, ['A16']);
    link = await cmd('link.remove', {}, link);
    check('Unlink one task keeps document and other task reference',
      [(await current('documents', doc.id)).id, (await current('links', link2.id)).status], [doc.id, 'active'], ['A16']);
    const baselineBefore = digest(await current('baselines', baseline.id));
    let technical = await cmd('technical.create', { name: '图纸技术疑问', taskId: task.id, ownerId, dueDate: D, documentVersionId: v2.id });
    technical = await cmd('technical.comment', { text: '普通讨论' }, technical);
    check('Discussion does not become formal answer', technical.status, 'open', ['A16']);
    technical = await cmd('technical.answer', { answer: '待发布正式答复', evidenceIds: [evidence.id] }, technical);
    technical = await cmd('technical.publish', {}, technical);
    let change = await cmd('change.create', { name: '技术答复的变更建议', taskIds: [task.id], technicalQueryId: technical.id,
      reason: '独立处理影响', impacts: '提交计划人员核对' });
    change = await cmd('change.confirm', { basis: '仅批准变更记录，不自动重写计划' }, change);
    check('Discussion/formal answer/change approval do not silently overwrite baseline', digest(await current('baselines', baseline.id)), baselineBefore, ['A16']);
    const meeting = await cmd('meeting.create', { name: '协调会', businessDate: D, minutes: '跟踪同一任务', taskIds: [task.id] });
    let action = await cmd('action.create', { name: '落实本次变更影响', taskId: task.id, ownerId, dueDate: D, meetingId: meeting.id });
    action = await cmd('action.complete', { result: '保持任务引用完成协调', evidenceIds: [evidence.id] }, action);
    check('Meeting action keeps original task and meeting identity', [action.taskId, action.meetingId, action.status], [task.id, meeting.id, 'completed'], ['A16']);
    report.evidence.documents = { documentId: doc.id, firstVersionId: v1.id, secondVersionId: v2.id,
      fixedLinkId: fixedLink.id, remainingLinkId: link2.id, requirementId: requirement.id, technicalId: technical.id, changeId: change.id };
  });

  await section('Permission boundaries, raw asset subresources and forged uploads', ['A01', 'A18'], async () => {
    const viewerPassword = `viewer-${randomUUID()}`;
    const viewer = await cmd('member.save', { username: 'http-viewer', displayName: '仅一任务只读', password: viewerPassword,
      roles: ['viewer'], taskIds: [task.id], resourceAccess: { models: false, files: false, media: false } });
    const login = await post('/__management/session', { projectId, username: 'http-viewer', password: viewerPassword }, 'viewer');
    requireCheck('Second role can establish actual server session', login.status, 200, ['A01']);
    const visible = await snapshot('viewer');
    check('Task-restricted account cannot list another task', visible.collections.tasks.some(t => t.id === task2.id), false, ['A01']);
    check('Restricted role sees only permitted task in shared state', visible.collections.tasks.map(t => t.id), [task.id], ['A01']);
    await cmd('task.update', { name: '越权改任务', reason: '不应通过' }, task,
      { session: 'viewer', expect: 403, gates: ['A01'], label: 'Read-only role cannot mutate via raw command' });
    const permittedFile=await http(evidence.url);
    check('Authorized owner can read actual uploaded original bytes',permittedFile.data,'Isolated HTTP acceptance evidence\n',['A01']);
    const forbiddenTask=await http(`/__management/records/tasks/${task2.id}?projectId=${projectId}`,{},'viewer');
    check('Restricted task blocked by direct record URL',forbiddenTask.status,403,['A01']);
    const restrictedMetric=await http(`/__management/metrics?${new URLSearchParams({projectId,D,F:iso(),taskId:task2.id})}`,{},'viewer');
    check('Unauthorized task contributes no metric drilldown',restrictedMetric.data.taskProgress,[],['A01','A17']);
    const forgedRole=await http(`/__management/state?projectId=${projectId}`,{headers:{'X-Role':'owner','X-User':'local-owner'}},null);
    check('Client role headers cannot create authenticated owner',forgedRole.status,401,['A01']);
    const crossOrigin=await http(`/__management/state?projectId=${projectId}`,{headers:{Origin:'https://unauthorized.invalid'}});
    check('Cross-origin request rejected despite valid session cookie',crossOrigin.status,403,['A01']);
    const otherProject=await cmd('project.create',{id:'separate-http-project',name:'另一隔离项目',isTest:true});
    const projectDenied=await http('/__management/state?projectId='+otherProject.id,{},'viewer');
    check('Account cannot access another project without membership',projectDenied.status,403,['A01']);
    const anonymous = await http(`/__management/state?projectId=${projectId}`, {}, null);
    check('Anonymous request after account bootstrap is denied', [401, 403].includes(anonymous.status), true, ['A01']);
    for (const resourcePath of ['/__models/fixture/tileset.json', '/__models/fixture/Data/0/0.b3dm',
      '/__models/fixture/texture.png', '/project-data/library/fixture/original.pdf',
      '/__library/files/fixture/original/sample.pdf', '/__library/files/fixture/video/segment.ts']) {
      const response = await http(resourcePath, {}, 'viewer');
      check(`Restricted role cannot bypass through ${resourcePath}`, [401, 403].includes(response.status), true, ['A01']);
    }
    for(const bypass of [`/@fs/${work.replaceAll('\\','/')}/management.sqlite`,'/%70roject-data/management.sqlite','/__models%2ffixture%2fData%2f0.b3dm','/tmp/management.sqlite']) {
      const denied=await http(bypass,{},'viewer');
      check(`Encoded or filesystem asset bypass blocked: ${bypass}`,denied.status,403,['A01']);
    }
    const evidencePath = evidence.url || evidence.downloadUrl || `/__management/files/${evidence.id}?projectId=${projectId}`;
    const deniedFile = await http(evidencePath, {}, 'viewer');
    check('Uploaded evidence original denied to files-disabled account', [401, 403].includes(deniedFile.status), true, ['A01']);
    const forged = await cmd('progress.create', { taskId: task.id, businessDate: D, shift: 'forged', crew: 'A', measurementKey: 'fake-file',
      quantity: 1, unit: 'm3', evidenceIds: ['upload-that-never-succeeded'] }, undefined,
      { expect: [400,404], gates: ['A18'], label: 'Unsuccessful/forged upload cannot be referenced as valid evidence' });
    check('Rejected attachment does not create a progress ledger',
      (await snapshot()).collections.progress.some(p => p.revisions.some(v => v.measurementKey === 'fake-file')), false, ['A18']);
    report.evidence.roles = { ownerId, viewerId: viewer.id, taskScope: [task.id], forbiddenAssetProbeCount: 7 };
  });

  await section('Lost acknowledgement retry, failed upload and persistence restart', ['A08','A17','A18'], async () => {
    const request = {projectId,type:'dailyLog.create',idempotencyKey:randomUUID(),payload:{taskId:task.id,businessDate:D,description:'仅执行说明，不造完成量',progressEntryIds:[]}};
    const beforeQuantity = quantity(await metrics(), task.id);
    const response = await fetch(origin+'/__management/commands',{method:'POST',headers:{'Content-Type':'application/json','X-Cesium-Library':'1',Cookie:sessions.owner.cookie},body:JSON.stringify(request)});
    assert.equal(response.status,200); await response.body.cancel();
    report.requests.push({seq:report.requests.length+1,at:iso(),method:'POST',path:'/__management/commands',role:'owner',status:200,command:request.type,bodyDeliberatelyDiscarded:true});
    const retry = await post('/__management/commands',request);
    const matching=retry.data.collections.dailyLogs.filter(v=>v.description===request.payload.description);
    check('Lost response body then same-key retry creates exactly one daily log',matching.length,1,['A18']);
    check('Description-only execution log does not alter quantity ledger',quantity(await metrics(),task.id),beforeQuantity,['A08']);
    const countBefore=(await snapshot()).collections.evidence.length;
    const empty=await http('/__management/upload?'+new URLSearchParams({projectId,name:'failed-empty.txt'}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(0)});
    check('Empty upload fails without valid evidence record',empty.status,400,['A18']);
    check('Failed upload leaves evidence count unchanged',(await snapshot()).collections.evidence.length,countBefore,['A18']);
    const before=await snapshot(), beforeHash=digest(before.collections);
    store.close(); store=await createManagementStore(storeOptions);
    const after=await snapshot();
    check('Closing and reopening SQLite store preserves every business record revision',digest(after.collections),beforeHash,['A18']);
    check('Stored authenticated session survives actual store restart',after.session.userId,ownerId,['A01']);
    report.evidence.restart={beforeHash,afterHash:digest(after.collections),actualStoreReopened:true};
  });

  const finalState = await snapshot();
  report.evidence.finalCollectionCounts = Object.fromEntries(Object.entries(finalState.collections).map(([key, values]) => [key, values.length]));
  report.evidence.audit = finalState.audit;
  report.evidence.persistedSnapshotHash = digest(finalState.collections);
  report.persistence = { directory: work, note: 'Temporary directory intentionally retained for audit and restart checks; never formal data.' };
  const sourceMap = JSON.parse(await readFile(path.join(root, 'output/management-studio/feature-map.json'), 'utf8'));
  const statusMap = sourceMap.functions.map(f => ({ id: f.id, name: f.name, moduleId: f.moduleId,
    requiredActions: f.suggestedActions, httpCommandEvidence: report.requests.filter(r => r.status >= 200 && r.status < 300 && f.suggestedActions.includes(r.command)).map(r => ({seq:r.seq,command:r.command,status:r.status})),
    uiEvidence: 'not_run', completion: 'not_claimed_by_http_only' }));
  await writeFile(path.join(output, 'feature-http-evidence.json'), JSON.stringify({ classification: 'http-evidence-only-ui-still-required',
    functions: statusMap, report: 'api-acceptance.json' }, null, 2) + '\n');
  report.completedAt = iso();
  report.passed = report.checks.every(c => c.passed) && report.sections.every(s => s.status === 'passed');
} catch (error) {
  report.error = String(error.stack || error); report.passed = false;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (store?.close) await store.close();
  await flush();
  console.log(JSON.stringify({ ...report.summary, overallPassed: report.passed, error: report.error,
    report: path.join(output, 'api-acceptance.json'), isolatedDataDirectory: work }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
