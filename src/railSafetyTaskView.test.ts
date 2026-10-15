import test from 'node:test';
import assert from 'node:assert/strict';
import type { ManagementRecord } from './managementTypes.ts';
import { buildRailSafetyTaskView, exportRailSafetyTaskCsv, selectRailSafetyTaskScope } from './railSafetyTaskView.ts';

const row = (id: string, values: Partial<ManagementRecord> = {}): ManagementRecord => ({
  id, projectId: 'project', revision: 1, name: id, status: 'active',
  createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', createdBy: 'actor', ...values,
});
const equipment = (id: string, values: Partial<ManagementRecord> = {}) => row(id, { kind: 'equipment', ...values });
const machine = (id: string, resourceId: string, taskId?: string) => row(id, {
  taskId, definition: { schemaVersion: 1, kind: 'machine', resourceId, selectedLimitIds: [] },
});
const limit = (id: string, taskId?: string) => row(id, { taskId, definition: { schemaVersion: 1, kind: 'limit', polygon: [] } });
const guard = (id: string, resourceIds: string[], taskId?: string) => row(id, { taskId, definition: { schemaVersion: 1, kind: 'guard', resourceIds } });
const issue = (id: string, taskId?: string, status = 'pending-verification') => row(id, { taskId, status, railSafetyRisk: { schemaVersion: 1 } });

test('task overview includes unconfigured equipment and distinct existing task associations without changing saved inputs', () => {
  const input = {
    projectId: 'project', tasks: [row('A', { status: 'in-progress', planStart: '2026-10-14', planEnd: '2026-10-15' }), row('B', { status: 'completed' })],
    resources: [equipment('a'), equipment('b'), equipment('c'), equipment('d'), equipment('global'), equipment('free'), row('crew', { kind: 'crew' })],
    records: [machine('machine-a', 'a', 'A'), machine('machine-d', 'd', 'B'), machine('machine-global', 'global'),
      guard('guard-a', ['a', 'd', 'not-authorized'], 'A'), guard('guard-b', ['b'], 'B'), limit('limit-a', 'A'), limit('limit-b', 'B'), limit('shared')],
    allocations: [row('allocation', { taskId: 'A', resourceId: 'c' }), row('cancelled', { taskId: 'A', resourceId: 'free', status: 'cancelled' })],
  };
  const before = JSON.stringify(input), view = buildRailSafetyTaskView(input), a = view.tasks[0], b = view.tasks[1];
  assert.deepEqual(view.all.resourceIds, ['a', 'b', 'c', 'd', 'global', 'free']);
  assert.deepEqual(view.all.missingConfigurationResourceIds, ['b', 'c', 'free']);
  assert.deepEqual(a.resourceIds, ['a', 'c', 'd']);
  assert.deepEqual(a.configuredResourceIds, ['a']);
  assert.deepEqual(a.configurationGaps.map(gap => [gap.resourceId, gap.reason]), [['c', 'no-saved-config'], ['d', 'config-in-other-task']]);
  assert.deepEqual(b.resourceIds, ['b', 'd']);
  assert.equal(b.statusLabel, '已完成', 'completed task remains visible rather than suppressing its saved machine');
  assert.equal(a.planStart, '2026-10-14');
  assert.deepEqual(view.unassigned.resourceIds, ['global', 'free']);
  assert.deepEqual(a.ownLimitIds, ['limit-a']);
  assert.deepEqual(a.sharedLimitIds, ['shared']);
  assert.deepEqual(a.recordIds, ['machine-a', 'guard-a', 'limit-a', 'shared']);
  assert.equal(a.resourceIds.includes('not-authorized'), false, 'references never synthesize absent authorized resources');
  assert.equal(JSON.stringify(input), before, 'the overview never relinks records or selects candidate limits');
});

test('unavailable task selections fail closed while foreign and deleted records never enter a scope', () => {
  const view = buildRailSafetyTaskView({
    projectId: 'project', tasks: [row('A'), row('deleted', { status: 'deleted' }), row('foreign-task', { projectId: 'other' })],
    resources: [equipment('lost'), equipment('foreign', { projectId: 'other' }), equipment('deleted', { status: 'deleted' }), equipment('direct', { taskIds: ['A', 'A'] })],
    records: [machine('orphan', 'lost', 'hidden-task'), machine('foreign-config', 'direct', 'A')].map(r => r.id === 'foreign-config' ? { ...r, projectId: 'other' } : r),
    allocations: [row('foreign-allocation', { projectId: 'other', taskId: 'A', resourceId: 'lost' })],
  });
  assert.deepEqual(view.tasks.map(task => task.taskId), ['A']);
  assert.deepEqual(view.all.resourceIds, ['lost', 'direct']);
  assert.deepEqual(view.tasks[0].resourceIds, ['direct']);
  assert.deepEqual(view.tasks[0].missingConfigurationResourceIds, ['direct']);
  assert.equal(view.unassigned.name, '未关联可见任务');
  assert.deepEqual(view.unassigned.resourceIds, ['lost']);
  assert.deepEqual(view.unassigned.recordIds, ['orphan']);
  assert.equal(selectRailSafetyTaskScope(view, { kind: 'task', taskId: 'hidden-task' }), undefined);
  assert.equal(selectRailSafetyTaskScope(view, { kind: 'task', taskId: 'deleted' }), undefined);
  assert.equal(selectRailSafetyTaskScope(view, { kind: 'all' }), view.all);
  assert.equal(selectRailSafetyTaskScope(view, { kind: 'unassigned' }), view.unassigned);
});

test('only typed rail-safety risk issues count, with verification and terminal dispositions distinguished', () => {
  const view = buildRailSafetyTaskView({
    projectId: 'project', tasks: [row('A'), row('B')], resources: [], records: [],
    issues: [issue('pending', 'A'), issue('active', 'A', 'rectifying'), issue('closed', 'A', 'closed'),
      issue('dismissed', 'A', 'false-positive'), issue('duplicate', 'A', 'duplicate'), issue('deleted', 'A', 'deleted'),
      issue('unassigned'), issue('hidden-task', 'hidden'), issue('b', 'B', 'pending-review'),
      row('general', { taskId: 'A', kind: 'safety' }), row('v2', { taskId: 'A', railSafetyRisk: { schemaVersion: 2 } }),
      { ...issue('foreign', 'A'), projectId: 'other' }],
  });
  assert.deepEqual(view.tasks[0].issueIds, ['pending', 'active', 'closed', 'dismissed', 'duplicate']);
  assert.deepEqual(view.tasks[0].openIssueIds, ['pending', 'active']);
  assert.deepEqual(view.tasks[0].pendingVerificationIssueIds, ['pending']);
  assert.deepEqual(view.unassigned.openIssueIds, ['unassigned', 'hidden-task']);
  assert.deepEqual(view.all.openIssueIds, ['pending', 'active', 'unassigned', 'hidden-task', 'b']);
});

test('a task association is not inferred from generic railSafety.taskIds and shared limits are never treated as a selection', () => {
  const saved: ManagementRecord = { ...machine('saved', 'resource'), taskIds: ['A'] };
  const view = buildRailSafetyTaskView({ projectId: 'project', tasks: [row('A')], resources: [equipment('resource')], records: [saved, limit('shared')] });
  assert.deepEqual(view.tasks[0].resourceIds, []);
  assert.deepEqual(view.tasks[0].configuredResourceIds, []);
  assert.deepEqual(view.tasks[0].ownLimitIds, []);
  assert.deepEqual(view.tasks[0].sharedLimitIds, ['shared']);
  assert.deepEqual(view.unassigned.configuredResourceIds, ['resource']);
  assert.deepEqual((saved.definition as { selectedLimitIds: string[] }).selectedLimitIds, []);
});

test('task-card equipment links include unplaced machines while saved configuration scopes and authorized resources remain authoritative', () => {
  const input = {
    projectId: 'project', tasks: [row('A', { status: 'paused', resourceIds: ['unplaced', 'elsewhere', 'global', 'configured', 'hidden', 'foreign', 'deleted', 'crew', 'unplaced'] }), row('B')],
    resources: [equipment('unplaced'), equipment('elsewhere'), equipment('global'), equipment('configured'), equipment('free'), equipment('foreign', { projectId: 'other' }), equipment('deleted', { status: 'deleted' }), row('crew', { kind: 'crew' })],
    records: [machine('other-config', 'elsewhere', 'B'), machine('global-config', 'global'), machine('own-config', 'configured', 'A'), limit('shared')],
  };
  const before = JSON.stringify(input), view = buildRailSafetyTaskView(input), task = view.tasks[0];
  assert.deepEqual(task.resourceIds, ['unplaced', 'elsewhere', 'global', 'configured']);
  assert.deepEqual(task.configuredResourceIds, ['configured']);
  assert.deepEqual(task.configurationGaps.map(gap => [gap.resourceId, gap.reason]), [['unplaced', 'no-saved-config'], ['elsewhere', 'config-in-other-task'], ['global', 'config-in-other-task']]);
  assert.deepEqual(task.recordIds, ['own-config', 'shared']);
  assert.equal(task.statusLabel, '已暂停');
  assert.deepEqual(view.unassigned.resourceIds, ['global', 'free'], 'a global configuration remains global until explicitly rebound');
  assert.equal(JSON.stringify(input), before, 'task-card links never mutate saved definitions or select limits');
});

test('CSV states visible-data and saved-binding semantics and neutralizes malicious spreadsheet cells', () => {
  const projectId = '=external()', view = buildRailSafetyTaskView({
    projectId, tasks: [row('A', { projectId, name: ' \t=HYPERLINK("url")\nsecond,line', status: '+untrusted', planStart: '2026-10-14' })],
    resources: [], records: [],
  });
  const csv = exportRailSafetyTaskCsv(view, { exportedAt: '2026-10-14T15:00:00+08:00' });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('2026-10-14T07:00:00.000Z'));
  assert.ok(csv.includes('"\'=external()"'));
  assert.ok(csv.includes('"\' \t=HYPERLINK(""url"")\nsecond,line"'));
  assert.ok(csv.includes('"\'+untrusted"'));
  assert.ok(csv.includes('共用可选限界（项，非自动选用）'));
  assert.ok(csv.includes('当前账号可见已保存数据'));
  assert.ok(csv.includes('各行不可相加'));
  assert.ok(csv.endsWith('\r\n'));
  assert.throws(() => exportRailSafetyTaskCsv(view, { exportedAt: '2026-10-14T15:00:00' }), /时区/);
  assert.throws(() => exportRailSafetyTaskCsv(view, { exportedAt: 'invalidZ' }), /时区/);
});
