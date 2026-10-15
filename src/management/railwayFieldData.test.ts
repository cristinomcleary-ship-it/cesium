import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGEMENT_COLLECTIONS, type ManagementRecord, type ManagementSnapshot } from '../managementTypes.ts';
import { fieldObjectChecks, fieldObjectDocuments, fieldObjectEvidence, fieldObjectIssues, fieldObjectRecord, fieldRecordHtml } from './railwayFieldData.ts';

const machine = { kind: 'resources', id: 'machine' } as const;
const guard = { kind: 'railSafety', id: 'guard' } as const;
const row = (id: string, values: Partial<ManagementRecord> = {}): ManagementRecord => ({ id, projectId: 'p', revision: 1, name: id, status: 'active', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', createdBy: 'u', ...values });
function snapshot(values: Partial<ManagementSnapshot['collections']> = {}): ManagementSnapshot {
  return {
    schemaVersion: 1, projectId: 'p', revision: 1, projects: [], members: [], audit: [], updatedAt: '2026-10-15T00:00:00Z',
    session: { userId: 'u', displayName: '现场人员', roles: ['owner'], authMode: 'local-owner', permissions: ['read', 'models', 'files'] },
    collections: {
      ...Object.fromEntries(MANAGEMENT_COLLECTIONS.map(kind => [kind, [] as ManagementRecord[]])) as ManagementSnapshot['collections'],
      tasks: [row('A', { railwayPlan: { number: 'P-15', kind: 'construction', sourceEvidenceId: 'source', sheetName: '施工计划', rowNumber: 2, verificationStatus: 'pending' } }), row('B')],
      resources: [row('machine', { kind: 'equipment', revision: 3 })],
      railSafety: [row('guard', { definition: { kind: 'guard' } })],
      ...values,
    },
  };
}
const ids = (records: ManagementRecord[]) => records.map(record => record.id);

test('object identities resolve only visible same-project records and never matching names', () => {
  const state = snapshot({ resources: [row('machine'), row('deleted', { deletedAt: '2026-10-15' }), row('foreign', { projectId: 'other' }), row('removed', { status: 'removed' })] });
  assert.equal(fieldObjectRecord(state, machine)?.id, 'machine');
  for (const id of ['deleted', 'foreign', 'removed', 'missing']) assert.equal(fieldObjectRecord(state, { kind: 'resources', id }), undefined);
  assert.equal(fieldObjectRecord(state, { kind: 'anchors', id: 'machine' }), undefined);
});

test('documents use explicit object references and active links; daily scope does not infer shared work from names', () => {
  const state = snapshot({
    documents: [
      row('direct', { objectRefs: [machine], taskIds: ['A'] }),
      row('previous-day', { objectRefs: [machine], taskIds: ['B'], workflowCategory: 'other' }),
      row('agreement', { objectRefs: [machine], taskIds: ['B'], workflowCategory: 'agreement' }),
      row('scheme', { objectRefs: [machine], category: 'scheme' }),
      row('linked'), row('version-linked'), row('name-only', { name: 'machine', taskIds: ['A'] }), row('stale-link'), row('cross-day-link', { taskIds: ['B'] }),
    ],
    documentVersions: [row('v1', { documentId: 'version-linked' })],
    links: [row('l1', { sourceKind: 'resources', sourceId: 'machine', targetKind: 'documents', targetId: 'linked', taskId: 'A' }), row('l2', { sourceKind: 'resources', sourceId: 'machine', targetKind: 'documentVersions', targetId: 'v1', taskId: 'A' }), row('l3', { sourceKind: 'resources', sourceId: 'machine', targetKind: 'documents', targetId: 'stale-link', taskId: 'A', status: 'removed' }), row('l4', { sourceKind: 'resources', sourceId: 'machine', targetKind: 'documents', targetId: 'cross-day-link', taskId: 'A' })],
  });
  assert.deepEqual(ids(fieldObjectDocuments(state, machine)), ['direct', 'previous-day', 'agreement', 'scheme', 'linked', 'version-linked', 'cross-day-link']);
  assert.deepEqual(ids(fieldObjectDocuments(state, machine, 'A')), ['direct', 'agreement', 'scheme', 'linked', 'version-linked']);
  assert.deepEqual(fieldObjectDocuments(state, machine, 'hidden-plan'), []);
  assert.deepEqual(fieldObjectDocuments(snapshot({ ...state.collections, resources: [] }), machine), []);
});

test('checks and issues remain in the selected plan and support frozen legacy machine associations', () => {
  const state = snapshot({
    checks: [row('check-a', { taskId: 'A', objectRef: machine }), row('check-b', { taskId: 'B', objectRef: machine }), row('legacy', { taskId: 'A', inspectionObjectId: 'machine' }), row('not-object', { taskId: 'A', name: 'machine' })],
    issues: [row('manual', { taskId: 'A', objectRef: machine }), row('legacy-risk', { railSafetyRisk: { resourceId: 'machine', taskId: 'A' }, status: 'closed' }), row('legacy-resource', { taskId: 'A', resourceId: 'machine' }), row('different-day', { taskId: 'B', objectRef: machine }), row('unassigned', { resourceId: 'machine' }), row('same-name', { name: 'machine', taskId: 'A' })],
  });
  assert.deepEqual(ids(fieldObjectChecks(state, machine, 'A')), ['check-a', 'legacy']);
  assert.deepEqual(ids(fieldObjectIssues(state, machine, 'A')), ['manual', 'legacy-risk', 'legacy-resource']);
  assert.deepEqual(ids(fieldObjectIssues(state, machine)), ['manual', 'legacy-risk', 'legacy-resource', 'different-day', 'unassigned']);
  assert.deepEqual(fieldObjectChecks(state, machine, 'hidden-plan'), []);
});

test('an explicit version association exposes its parent document only with relevant object and daily versions', () => {
  const state = snapshot({
    documents: [row('shared-document', { name: '现场布置资料', objectRefs: [machine], taskIds: ['A'], workflowCategory: 'other', effectiveVersionId: 'machine-published' })],
    documentVersions: [
      row('machine-published', { documentId: 'shared-document', version: 1, status: 'published', publicationBasis: '机械版本批准依据', objectRefs: [machine], taskIds: ['A'], evidenceId: 'machine-file' }),
      row('guard-version', { documentId: 'shared-document', version: 2, status: 'draft', objectRefs: [guard], taskIds: ['B'], evidenceId: 'guard-file' }),
      row('same-day-other-object', { documentId: 'shared-document', version: 3, status: 'draft', objectRefs: [machine], taskIds: ['B'], evidenceId: 'other-object-file' }),
      row('other-day-same-object', { documentId: 'shared-document', version: 4, status: 'draft', objectRefs: [guard], taskIds: ['A'], evidenceId: 'other-day-file' }),
      row('foreign-version', { projectId: 'other-project', documentId: 'shared-document', version: 5, objectRefs: [guard], taskIds: ['B'], evidenceId: 'foreign-file' }),
    ],
    evidence: [row('machine-file', { name: '机械原件.pdf', taskId: 'A' }), row('guard-file', { name: '防护岗位当日原件.pdf', taskId: 'B' }), row('other-object-file', { name: '同日其他对象.pdf', taskId: 'B' }), row('other-day-file', { name: '前日岗位原件.pdf', taskId: 'A' }), row('foreign-file')],
  });
  const before = JSON.stringify(state);
  assert.deepEqual(ids(fieldObjectDocuments(state, guard, 'B')), ['shared-document']);
  assert.deepEqual(ids(fieldObjectEvidence(state, guard, 'B')), ['guard-file']);
  assert.deepEqual(ids(fieldObjectEvidence(state, guard, 'A')), ['other-day-file']);
  assert.deepEqual(ids(fieldObjectEvidence(state, guard)), ['guard-file', 'other-day-file']);
  assert.deepEqual(ids(fieldObjectEvidence(state, machine, 'A')), ['machine-file']);
  const html = fieldRecordHtml(state, 'B', guard);
  assert.match(html, /现场布置资料/);
  assert.match(html, /版本 2：草稿/);
  assert.match(html, /防护岗位当日原件.pdf/);
  assert.doesNotMatch(html, /平台已发布版本|机械版本批准依据|机械原件.pdf|同日其他对象.pdf|前日岗位原件.pdf|foreign-file/);
  const wholePlanHtml = fieldRecordHtml(state, 'B');
  assert.match(wholePlanHtml, /现场布置资料/);
  assert.match(wholePlanHtml, /防护岗位当日原件.pdf/);
  assert.doesNotMatch(wholePlanHtml, /平台已发布版本|机械版本批准依据|前日岗位原件.pdf/);
  assert.equal(JSON.stringify(state), before);
  const withoutRelevantVersions = snapshot({ ...state.collections, documentVersions: state.collections.documentVersions.filter(version => !(version.objectRefs as { id: string }[] | undefined)?.some(ref => ref.id === guard.id)) });
  assert.deepEqual(fieldObjectDocuments(withoutRelevantVersions, guard, 'B'), []);
});

test('the same machine cannot carry daily evidence across dates, while original Excel survives unmapped objects', () => {
  const state = snapshot({
    checks: [row('check-a', { taskId: 'A', objectRef: machine, items: [{ id: 'check', evidenceIds: ['check-proof', 'wrong-proof'] }] }), row('check-b', { taskId: 'B', objectRef: machine, evidenceIds: ['old-proof'] })],
    issues: [row('issue-a', { taskId: 'A', objectRef: machine, rounds: [{ evidenceIds: ['rectification'], reviewEvidenceIds: ['review'] }] })],
    evidence: [
      row('source', { name: '正式计划.xlsx', workflowCategory: 'construction-plan' }),
      row('photo-a', { taskId: 'A', objectRefs: [machine] }), row('photo-b', { taskId: 'B', objectRefs: [machine] }),
      row('unassigned-photo', { objectRefs: [machine] }), row('check-proof'), row('wrong-proof', { taskId: 'B' }), row('old-proof'), row('rectification'), row('review'),
      row('name-only', { name: 'machine', taskId: 'A' }),
    ],
  });
  const before = JSON.stringify(state);
  assert.deepEqual(ids(fieldObjectEvidence(state, machine, 'A')), ['source', 'photo-a', 'check-proof', 'rectification', 'review']);
  assert.deepEqual(ids(fieldObjectEvidence(state, guard, 'A')), ['source']);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(fieldObjectEvidence(state, machine, 'hidden'), []);
});

test('explicit permanent certificates and reusable agreement versions may serve multiple plans', () => {
  const state = snapshot({
    railSafety: [row('guard', { personnel: { certificateEvidenceIds: ['certificate', 'not-visible'] } })],
    documents: [row('agreement', { workflowCategory: 'agreement', objectRefs: [guard], taskIds: ['B'] }), row('daily', { workflowCategory: 'other', objectRefs: [guard], taskIds: ['B'] })],
    documentVersions: [row('agreement-v1', { documentId: 'agreement', taskIds: ['B'], evidenceId: 'agreement-pdf' }), row('daily-v1', { documentId: 'daily', taskIds: ['B'], evidenceId: 'daily-pdf' })],
    evidence: [row('certificate', { name: '合格证.pdf', taskId: 'B', workflowCategory: 'personnel-certificate' }), row('agreement-pdf', { taskId: 'B' }), row('daily-pdf', { taskId: 'B' })],
  });
  assert.deepEqual(ids(fieldObjectEvidence(state, guard, 'A')), ['certificate', 'agreement-pdf']);
  assert.deepEqual(ids(fieldObjectEvidence(state, machine, 'A')), []);
});

test('record preview safely escapes user text and never infers all checks passed or uploaded documents published', () => {
  const dangerous = '<img src=x onerror="alert(1)">';
  const state = snapshot({
    checks: [row('check', { name: dangerous, taskId: 'A', objectRef: machine, status: 'draft', items: [{ name: '检查项', result: 'pending', basis: dangerous }] })],
    issues: [row('issue', { name: dangerous, taskId: 'A', objectRef: machine, status: 'pending-verification', rounds: [{ description: dangerous }] })],
    documents: [row('agreement', { name: dangerous, workflowCategory: 'agreement', objectRefs: [machine], effectiveVersionId: 'draft-version' })],
    documentVersions: [row('draft-version', { documentId: 'agreement', status: 'draft', version: 1 })],
    evidence: [row('source', { name: '计划.xlsx' })],
  });
  const html = fieldRecordHtml(state, 'A', machine);
  assert.match(html, /class="rf-paper"/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<script|<!DOCTYPE|<html|全部合格|平台已发布版本/);
  assert.match(html, /待检查/);
  assert.match(html, /无可用的已发布版本/);
  assert.match(html, /待核验/);
  assert.match(html, /计划.xlsx/);
  assert.doesNotMatch(html, /undefined|\[object Object\]/);
});

test('saved snapshots and risk source revisions remain historical when current geometry changes', () => {
  const state = snapshot({
    checks: [row('confirmed-check', { taskId: 'A', objectRef: machine, status: 'confirmed', confirmedAt: '2026-10-14T08:00:00Z', items: [{ name: '现场确认项', result: 'pass' }], objectSnapshot: { ref: machine, revision: 1, capturedAt: '2026-10-14T07:00:00Z', data: row('machine', { name: '旧站位吊机', machinery: { placement: { longitude: 121, latitude: 31, height: 12 } } as ManagementRecord['machinery'] }) } })],
    issues: [row('risk', { taskId: 'A', railSafetyRisk: { resourceId: 'machine', resourceRevision: 1, resourceSnapshot: { name: '旧站位吊机' }, status: 'overlap', capturedAt: '2026-10-14T07:00:00Z' } })],
  });
  const before = JSON.stringify(state);
  const html = fieldRecordHtml(state, 'A', machine);
  assert.match(html, /旧站位吊机/);
  assert.match(html, /当前对象修订 3，已发生变化/);
  assert.match(html, /原筛查结果不代表当前状态/);
  assert.match(html, /经度 121，纬度 31，椭球高 12 m/);
  assert.match(html, /无问题/);
  assert.equal(JSON.stringify(state), before);
});

test('record preview limits data to visible selected task; unknown sources and missing checks stay unknown', () => {
  const state = snapshot({
    issues: [row('secret', { name: '另一计划专属内容', taskId: 'B', objectRef: machine })],
    evidence: [row('secret-evidence', { name: '另一计划照片', taskId: 'B', objectRefs: [machine] })],
  });
  const html = fieldRecordHtml(state, 'A', machine);
  assert.doesNotMatch(html, /另一计划/);
  assert.match(html, /原件未提供或无权查看/);
  assert.match(html, /尚无已保存的检查记录/);
  assert.match(html, /不代表现场不存在风险/);
  assert.doesNotMatch(fieldRecordHtml(state, 'invisible', machine), /另一计划|P-15/);
  assert.match(fieldRecordHtml(state, 'A', { kind: 'resources', id: 'missing' }), /所选现场对象未提供或无权查看/);
});
