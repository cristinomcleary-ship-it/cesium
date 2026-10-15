import test from 'node:test';
import assert from 'node:assert/strict';
import type { ManagementRecord, TaskConditionResult, TaskConditionsResponse } from '../managementTypes.ts';
import {
  coordinationNavigation, coordinationSection, coordinationSummary, coordinationTaskCsv, isOpenIssue,
  railwayTaskLocation, railwayTaskWindow, taskConditionState, taskOccursOnDay, uniqueMachinery,
} from './coordinationView.ts';

const row = (id: string, values: Partial<ManagementRecord> = {}): ManagementRecord => ({
  id, name: id, projectId: 'p', revision: 3, status: 'published',
  createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', createdBy: 'u', ...values,
});
const required = (values: Partial<TaskConditionResult> = {}): TaskConditionResult => ({
  id: 'documents', kind: 'documents', stage: 'start', mode: 'required', satisfied: true,
  status: 'satisfied', reason: '有效资料', references: [], ...values,
});
const conditions = (task: ManagementRecord, start = [required()]): TaskConditionsResponse => ({
  taskId: task.id, taskRevision: task.revision, dataVersion: 12, evaluatedAt: '2026-10-14T10:00:00Z',
  policy: { version: 1, taskType: 'non-quantity', rules: [], configuredAt: '2026-10-14T00:00:00Z', configuredBy: 'u', reason: '测试规则' },
  stages: { start, completion: [] },
});
const ids = (records: ManagementRecord[]) => records.map(record => record.id);

test('six railway entrances keep old plan, inspections, evidence and resource routes reachable', () => {
  assert.equal(coordinationNavigation.length, 6);
  assert.equal(new Set(coordinationNavigation.map(entry => entry.id)).size, 6);
  for (const entry of coordinationNavigation) {
    if (entry.id === 'scene') continue;
    assert.equal(coordinationSection(entry.module!, entry.tab!), entry.id);
  }
  assert.equal(coordinationSection('field', 'spatial'), 'plan');
  for (const tab of ['checks', 'issues']) assert.equal(coordinationSection('field', tab), 'checks');
  for (const tab of ['tasks', 'media', 'monitoring', 'results']) assert.equal(coordinationSection('inspection', tab), 'checks');
  assert.equal(coordinationSection('documents', 'files'), 'resources');
  assert.equal(coordinationSection('documents', 'reports'), 'resources');
  assert.equal(coordinationSection('field', 'coordination'), 'tasks');
  assert.equal(coordinationSection('documents', 'files', 'scene'), 'scene');
});

test('cross-midnight work windows override broad plan dates and do not depend on host timezone', () => {
  const task = row('night', { planStart: '2026-10-01', planEnd: '2026-10-30', workWindowStart: '2026-10-14T23:30', workWindowEnd: '2026-10-15T01:20' });
  const originalTimezone = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
      process.env.TZ = timezone;
      assert.equal(taskOccursOnDay(task, '2026-10-14'), true);
      assert.equal(taskOccursOnDay(task, '2026-10-15'), true);
      assert.equal(taskOccursOnDay(task, '2026-10-13'), false);
      assert.equal(taskOccursOnDay(task, '2026-10-16'), false);
      assert.equal(railwayTaskWindow(task), '2026-10-14 23:30 — 2026-10-15 01:20');
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
  assert.equal(taskOccursOnDay({ ...task, status: 'cancelled' }, '2026-10-14'), false);
});

test('missing dates and railway metadata remain unknown while legacy date-only tasks still appear', () => {
  const unknown = row('unknown');
  assert.equal(taskOccursOnDay(unknown, '2026-10-14'), false);
  assert.equal(railwayTaskWindow(unknown), '待安排');
  assert.equal(railwayTaskLocation(unknown), '');
  assert.equal(taskOccursOnDay(row('same-day', { planStart: '2026-10-14' }), '2026-10-14'), true);
  const legacy = row('legacy', { planStart: '2026-10-14', planEnd: '2026-10-16', railwayLine: '测试线', railwayMileage: 'K1+200' });
  assert.equal(taskOccursOnDay(legacy, '2026-10-15'), true);
  assert.equal(railwayTaskWindow(legacy), '2026-10-14 — 2026-10-16');
  assert.equal(railwayTaskLocation(legacy), '测试线 · K1+200');
});

test('a window ending at midnight is excluded from the next day while plan end dates remain inclusive', () => {
  const window = row('midnight', { workWindowStart: '2026-10-14T23:00', workWindowEnd: '2026-10-15T00:00' });
  assert.equal(taskOccursOnDay(window, '2026-10-14'), true);
  assert.equal(taskOccursOnDay(window, '2026-10-15'), false);
  const startsAtMidnight = row('early', { workWindowStart: '2026-10-15T00:00', workWindowEnd: '2026-10-15T01:00' });
  assert.equal(taskOccursOnDay(startsAtMidnight, '2026-10-14'), false);
  assert.equal(taskOccursOnDay(startsAtMidnight, '2026-10-15'), true);
  assert.equal(taskOccursOnDay(row('plan', { planStart: '2026-10-14', planEnd: '2026-10-15' }), '2026-10-15'), true);
});

test('missing, foreign and stale condition responses cannot turn a task green', () => {
  const task = row('task'), current = conditions(task);
  assert.equal(taskConditionState(task), 'unknown');
  assert.equal(taskConditionState(task, { ...current, policy: null }), 'unknown');
  assert.equal(taskConditionState(task, { ...current, taskId: 'other' }), 'unknown');
  assert.equal(taskConditionState(task, { ...current, taskRevision: 2 }), 'unknown');
  assert.equal(taskConditionState(task, conditions(task, [])), 'unknown');
  assert.equal(taskConditionState(task, conditions(task, [required({ satisfied: null, status: 'configuration-required' })])), 'unknown');
  assert.equal(taskConditionState(task, conditions(task, [required({ satisfied: false, status: 'blocked' })])), 'blocked');
  assert.equal(taskConditionState(task, current), 'ready');
  assert.equal(taskConditionState(task, conditions(task, [required(), required({ id: 'tip', mode: 'advisory', satisfied: false, status: 'advisory' })])), 'ready');
  assert.equal(taskConditionState(task, conditions(task, [required({ mode: 'not-applicable', satisfied: null, status: 'not-applicable', reason: '已明确不适用' })])), 'ready');
});

test('project equipment counts distinct IDs including unconfigured and disabled equipment without counting crews', () => {
  const resources = [
    row('crane', { kind: 'equipment', taskIds: ['a', 'b'] }),
    row('unconfigured', { kind: 'equipment' }),
    row('disabled', { kind: 'equipment', availability: 'disabled' }),
    row('crane', { kind: 'equipment', taskId: 'b' }),
    row('crew', { kind: 'crew' }), row('material', { kind: 'material' }),
    row('deleted', { kind: 'equipment', deletedAt: '2026-10-14T01:00:00Z' }),
  ];
  const before = JSON.stringify(resources);
  assert.deepEqual(ids(uniqueMachinery(resources)), ['crane', 'unconfigured', 'disabled']);
  assert.equal(JSON.stringify(resources), before);
});

test('a submitted or rejected rectification stays open until a terminal disposition', () => {
  for (const status of ['pending-verification', 'pending-rectification', 'rectifying', 'pending-review', 'unknown-status']) {
    assert.equal(isOpenIssue(row(status, { status })), true, status);
  }
  for (const status of ['closed', 'false-positive', 'duplicate', 'invalid', 'archived']) {
    assert.equal(isOpenIssue(row(status, { status })), false, status);
  }
});

test('paused work stays visible with unmet conditions and summaries never mutate or manufacture source records', () => {
  const tasks = [
    row('unknown', { status: 'draft' }),
    row('paused', { status: 'paused', planStart: '2026-10-14', planEnd: '2026-10-15' }),
    row('ready'), row('running', { status: 'in-progress', planStart: '2026-10-13', planEnd: '2026-10-15' }),
    row('closing', { status: 'pending-completion' }), row('done', { status: 'completed' }), row('cancelled', { status: 'cancelled' }),
  ];
  const issues = [row('pending', { status: 'pending-review' }), row('closed', { status: 'closed' })];
  const resources = [row('machine', { kind: 'equipment' })];
  const responses = new Map([
    ['paused', conditions(tasks[1], [required({ satisfied: false, status: 'blocked' })])],
    ['ready', conditions(tasks[2])],
  ]);
  const before = JSON.stringify({ tasks, issues, resources });
  const summary = coordinationSummary(tasks, issues, resources, '2026-10-14', responses);
  assert.deepEqual(ids(summary.today), ['paused', 'running']);
  assert.deepEqual(ids(summary.preparation), ['paused', 'unknown']);
  assert.deepEqual(ids(summary.unknown), ['unknown']);
  assert.deepEqual(ids(summary.blocked), ['paused']);
  assert.deepEqual(ids(summary.paused), ['paused']);
  assert.deepEqual(ids(summary.working), ['running']);
  assert.deepEqual(ids(summary.closing), ['closing']);
  assert.deepEqual(ids(summary.issues), ['pending']);
  assert.deepEqual(ids(summary.machines), ['machine']);
  assert.equal(summary.unscheduled.some(task => ['done', 'cancelled'].includes(task.id)), false);
  assert.equal(JSON.stringify({ tasks, issues, resources }), before);
  assert.deepEqual(coordinationSummary([], [], [], '2026-10-14', new Map()).today, []);
});

test('task CSV preserves railway fields and quoted multiline text using only the supplied visible tasks', () => {
  const tasks = [row('visible', {
    name: '吊装,"夜间"\n第二段', batchLabel: '夜间第一批', railwayLine: '测试线', railwaySection: '甲站—乙站',
    railwayMileage: 'K1+200', railwayTrack: '上行', railwayWorkType: '吊装', status: 'paused', ownerId: 'u',
    planStart: '2026-10-14', planEnd: '2026-10-15', workWindowStart: '2026-10-14T23:30',
    workWindowEnd: '2026-10-15T01:20', permitReference: '记录编号',
  })];
  const issues = [
    row('single', { taskId: 'visible', status: 'pending-verification' }),
    row('many', { taskIds: ['visible', 'hidden'], status: 'pending-review' }),
    row('both', { taskId: 'visible', taskIds: ['visible'], status: 'rectifying' }),
    row('done', { taskId: 'visible', status: 'closed' }),
    row('other', { taskId: 'hidden', name: 'HIDDEN ISSUE TITLE' }),
  ];
  const before = JSON.stringify({ tasks, issues });
  const csv = coordinationTaskCsv(tasks, issues, id => id === 'u' ? '负责人' : '未登记', status => status === 'paused' ? '已暂停' : status);
  assert.equal(csv.startsWith('\uFEFF'), true);
  const cells = [...csv.slice(1).matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replace(/""/g, '"'));
  assert.equal(cells.length, 32, 'header and one authorized task each contain sixteen cells');
  assert.deepEqual(cells.slice(16), [
    'visible', tasks[0].name, '夜间第一批', '测试线', '甲站—乙站', 'K1+200', '上行', '吊装', '已暂停', '负责人',
    '2026-10-14', '2026-10-15', '2026-10-14T23:30', '2026-10-15T01:20', '记录编号', '3',
  ]);
  assert.equal(csv.includes('HIDDEN ISSUE TITLE'), false);
  assert.equal(JSON.stringify({ tasks, issues }), before);
  const emptyCsv = coordinationTaskCsv([], issues, () => 'unused', value => value);
  assert.equal(emptyCsv.includes('\r\n'), false, 'empty visible task list contains the header only');
});

test('CSV neutralizes spreadsheet formulas in user-entered and label fields without manufacturing missing values', () => {
  for (const dangerous of ['=1+1', '+SUM(1,2)', '-1+2', '@command', '  =1', '\tplain', '\rplain', '\nplain']) {
    const csv = coordinationTaskCsv([row('task', { name: dangerous })], [], () => dangerous, () => dangerous);
    const cells = [...csv.slice(1).matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replace(/""/g, '"'));
    const data = cells.slice(16);
    assert.equal(data[1], "'" + dangerous);
    assert.equal(data[8], "'" + dangerous);
    assert.equal(data[9], "'" + dangerous);
    assert.equal(data[2], '');
    assert.equal(data[12], '');
    assert.equal(data[13], '');
    assert.equal(data[14], '');
    assert.equal(data[15], '0');
  }
});
