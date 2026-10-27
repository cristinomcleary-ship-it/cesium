import test from 'node:test';
import assert from 'node:assert/strict';
import type { ManagementRecord } from './managementTypes.ts';
import { MachineryDocumentSession, selectMachineryDocuments, machineryDocumentUrl, type MachineryDocumentContext } from './machineryDocuments.ts';
const context = (resourceId = 'crane', values: Partial<MachineryDocumentContext> = {}): MachineryDocumentContext => ({ projectId: 'project', actorId: 'owner', resourceId, resourceName: resourceId, canView: true, canEdit: true, active: true, ...values });
const record = (id: string, resourceId = 'crane', values: Partial<ManagementRecord> = {}): ManagementRecord => ({ id, projectId: 'project', revision: 1, name: id + '.pdf', status: 'ready', createdAt: '2026-10-27', updatedAt: '2026-10-27', createdBy: 'owner', machineryDocumentCategory: 'certificate', objectRefs: [{ kind: 'resources', id: resourceId }], mime: 'application/pdf', ...values });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('mechanical files use exact project, equipment and category associations', () => {
  const accepted = record('accepted');
  const rows = [accepted, record('different', 'other'), record('foreign', 'crane', { projectId: 'other' }), record('deleted', 'crane', { status: 'deleted' }), record('deleting', 'crane', { status: 'deleting' }), record('unclassified', 'crane', { machineryDocumentCategory: undefined }), record('shared', 'crane', { objectRefs: [{ kind: 'resources', id: 'crane' }, { kind: 'resources', id: 'other' }] })];
  assert.deepEqual(selectMachineryDocuments(rows, 'project', 'crane'), [accepted]);
  assert.match(machineryDocumentUrl(record('file/1', 'crane', { url: 'https://untrusted.test' }), 'project ?'), /\/files\/file%2F1\/original\?projectId=project\+%3F$/);
});

test('a delayed previous machine response cannot populate the current archive even if fetch ignores abort', async () => {
  const pending = deferred<Response>();
  const client = new MachineryDocumentSession(() => {}, (async input => String(input).includes('/crane/') ? pending.promise : response({ records: [record('pile-certificate', 'pile')] })) as typeof fetch);
  client.setContext(context());
  client.setContext(context('pile'));
  await settle();
  pending.resolve(response({ records: [record('old')] }));
  await settle();
  assert.deepEqual(client.records.map(row => row.id), ['pile-certificate']);
  assert.equal(client.loading, false);
  client.dispose();
});

test('permission revocation clears files and prevents uploads or deletes', async () => {
  let requests = 0;
  const client = new MachineryDocumentSession(() => {}, (async () => { requests++; return response({ records: [record('one')] }); }) as typeof fetch);
  client.setContext(context()); await settle();
  client.setContext(context('crane', { canView: false, canEdit: false }));
  await client.upload([new File(['data'], 'one.pdf')], 'certificate');
  await client.remove('one');
  assert.deepEqual(client.records, []); assert.equal(requests, 1); client.dispose();
});

test('upload is explicitly bound to selected project and machine, reloads after success, and survives a fresh session', async () => {
  const stored: ManagementRecord[] = []; let uploadUrl = '';
  const fetcher = (async (input, init) => {
    if (init?.method === 'POST') { uploadUrl = String(input); const created = record('uploaded'); stored.push(created); return response(created, 201); }
    return response({ records: stored });
  }) as typeof fetch;
  const client = new MachineryDocumentSession(() => {}, fetcher); client.setContext(context()); await settle();
  await client.upload([new File(['data'], 'certificate.pdf', { type: 'application/pdf' })], 'certificate');
  const query = new URL(uploadUrl, 'http://localhost').searchParams;
  assert.equal(query.get('projectId'), 'project'); assert.equal(query.get('machineryDocumentCategory'), 'certificate');
  assert.deepEqual(JSON.parse(query.get('objectRefs')!), [{ kind: 'resources', id: 'crane' }]);
  assert.equal(client.records.length, 1); assert.equal(client.busy, false); client.dispose();
  const reopened = new MachineryDocumentSession(() => {}, fetcher); reopened.setContext(context()); await settle();
  assert.equal(reopened.records[0].id, 'uploaded'); reopened.dispose();
});

test('a failed delete remains visible after refresh; successful delete uses revision and stays gone on reopen', async () => {
  let stored = [record('certificate', 'crane', { revision: 4 })], fail = true, deleteBody = '';
  const fetcher = (async (_input, init) => {
    if (init?.method === 'DELETE') { deleteBody = String(init.body); if (fail) return response({ error: '其他业务正在引用此资料' }, 409); stored = []; return response({ ok: true }); }
    return response({ records: stored });
  }) as typeof fetch;
  const client = new MachineryDocumentSession(() => {}, fetcher); client.setContext(context()); await settle();
  await client.remove('certificate');
  assert.equal(client.records.length, 1); assert.equal(client.error, true); assert.match(client.message, /引用/);
  fail = false; await client.remove('certificate'); assert.deepEqual(JSON.parse(deleteBody), { expectedRevision: 4 }); assert.deepEqual(client.records, []); client.dispose();
  const reopened = new MachineryDocumentSession(() => {}, fetcher); reopened.setContext(context()); await settle(); assert.deepEqual(reopened.records, []); reopened.dispose();
});

test('switching project stops a batch after its in-flight upload and ignores its completion', async () => {
  const pending = deferred<Response>(); let uploads = 0;
  const client = new MachineryDocumentSession(() => {}, (async (_input, init) => { if (init?.method === 'POST') { uploads++; return pending.promise; } return response({ records: [] }); }) as typeof fetch);
  client.setContext(context()); await settle();
  const uploading = client.upload([new File(['a'], 'a.pdf'), new File(['b'], 'b.pdf')], 'inspection');
  client.setContext(context('crane', { projectId: 'different' })); await settle();
  pending.resolve(response(record('stale'), 201)); await uploading;
  assert.equal(uploads, 1); assert.deepEqual(client.records, []); assert.equal(client.busy, false); assert.equal(client.message, ''); client.dispose();
});

test('physical cleanup failure keeps a retry action without resurrecting a removed file', async () => {
  let stored = [record('locked')], fail = true;
  const client = new MachineryDocumentSession(() => {}, (async (_input, init) => {
    if (init?.method === 'DELETE') { stored = []; if (fail) return response({ error: '本地文件清理未完成', code: 'FILE_DELETE_PENDING' }, 503); return response({ ok: true }); }
    return response({ records: stored });
  }) as typeof fetch);
  client.setContext(context()); await settle(); await client.remove('locked');
  assert.deepEqual(client.records, []); assert.equal(client.pendingDeletions[0].id, 'locked'); assert.equal(client.error, true);
  fail = false; await client.remove('locked'); assert.deepEqual(client.pendingDeletions, []); assert.equal(client.error, false); client.dispose();
});

test('pending cleanup records reload after reopening and never enter the downloadable archive', async () => {
  const pending = record('locked', 'crane', { status: 'deleting', deletedAt: '2026-10-27', revision: 2 });
  const fetcher = (async () => response({ records: [], pendingDeletions: [pending, record('foreign', 'other', { status: 'deleting' })] })) as typeof fetch;
  const client = new MachineryDocumentSession(() => {}, fetcher); client.setContext(context()); await settle();
  assert.deepEqual(client.records, []); assert.deepEqual(client.pendingDeletions.map(row => row.id), ['locked']);
  client.setContext(context('crane', { active: false })); assert.equal(client.pendingDeletions.length, 0);
  client.setContext(context()); await settle(); assert.deepEqual(client.pendingDeletions.map(row => row.id), ['locked']); client.dispose();
});
