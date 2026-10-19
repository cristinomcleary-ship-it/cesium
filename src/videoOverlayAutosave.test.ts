import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoOverlayAutosave, type VideoOverlaySaveRequest, type VideoOverlaySaveResult } from './videoOverlayAutosave.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const request = (session: string, revision: number, existingId?: string) =>
  ({ session, revision, existingId, snapshot: Object.freeze({ value: `${session}-${revision}` }) });

test('first upload is serialized; edits coalesce and then PATCH the returned ID with the latest immutable snapshot', async () => {
  const first = deferred<string>(), calls: VideoOverlaySaveRequest<{ value: string }>[] = [];
  const saved: VideoOverlaySaveResult[] = [];
  const queue = new VideoOverlayAutosave<{ value: string }>({ save: async job => {
    calls.push(job); return calls.length === 1 ? first.promise : job.existingId!;
  }, onSaved: result => saved.push(result) });
  const p1 = queue.submit(request('A', 1)); await turn();
  const p2 = queue.submit(request('A', 2)), p3 = queue.submit(request('A', 3));
  assert.equal(calls.length, 1); assert.equal(queue.hasPending, true);
  const flushed = queue.flush(); first.resolve('id-A'); await flushed;
  assert.deepEqual(calls.map(job => [job.revision, job.existingId, job.snapshot.value]), [[1, undefined, 'A-1'], [3, 'id-A', 'A-3']]);
  assert.equal((await p1).revision, 1); assert.equal((await p2).revision, 3); assert.equal((await p3).revision, 3);
  assert.deepEqual(saved.map(result => result.revision), [1, 3]); assert.equal(queue.hasPending, false);
});

test('different sessions never share IDs; leaving the old UI does not cancel its save or overwrite the new UI', async () => {
  const first = deferred<string>(), calls: VideoOverlaySaveRequest<{ value: string }>[] = [];
  let activeSession = 'A', uiId: string | undefined;
  const queue = new VideoOverlayAutosave<{ value: string }>({ save: async job => {
    calls.push(job); if (job.session === 'A' && !job.existingId) return first.promise;
    return job.existingId ?? `id-${job.session}`;
  }, onSaved: result => { if (result.session === activeSession) uiId = result.id; } });
  const p1 = queue.submit(request('A', 1)); await turn();
  activeSession = 'B'; const p2 = queue.submit(request('B', 1)); const p3 = queue.submit(request('A', 2));
  first.resolve('id-A'); await queue.flush(); await Promise.all([p1, p2, p3]);
  assert.deepEqual(calls.map(job => [job.session, job.existingId]), [['A', undefined], ['B', undefined], ['A', 'id-A']]);
  assert.equal(uiId, 'id-B'); assert.equal(queue.hasPending, false);
});

test('failures retain only the latest snapshot, do not spin, and retry explicitly while other sessions continue', async () => {
  const failedUpload = deferred<string>(), calls: VideoOverlaySaveRequest<{ value: string }>[] = [], errors: string[] = [];
  let fail = true;
  const queue = new VideoOverlayAutosave<{ value: string }>({ save: async job => {
    calls.push(job); return job.session === 'A' && fail ? failedUpload.promise : job.existingId ?? `id-${job.session}`;
  }, onError: (_error, job) => errors.push(job.session) });
  const p1 = queue.submit(request('A', 1)); const rejection1 = assert.rejects(p1, /offline/); await turn();
  const p2 = queue.submit(request('A', 2)); const rejection2 = assert.rejects(p2, /offline/);
  const other = queue.submit(request('B', 1)); failedUpload.reject(new Error('offline'));
  await Promise.all([rejection1, rejection2, other]); await assert.rejects(queue.flush(), /未保存/);
  await assert.rejects(queue.submit(request('A', 3)), /offline/); await turn();
  assert.equal(calls.filter(job => job.session === 'A').length, 1); assert.deepEqual(errors, ['A']); assert.equal(queue.hasPending, true);
  fail = false; await queue.retry('A');
  assert.equal(calls.at(-1)!.snapshot.value, 'A-3'); assert.equal(calls.at(-1)!.existingId, undefined);
  assert.equal(queue.hasPending, false);
});

test('failed PATCH retries reuse its successful upload ID and stale revisions never overwrite newer settings', async () => {
  const calls: VideoOverlaySaveRequest<{ value: string }>[] = []; let fail = false;
  const queue = new VideoOverlayAutosave<{ value: string }>({ save: async job => {
    calls.push(job); if (fail) throw new Error('patch failed'); return job.existingId ?? 'persisted';
  } });
  await queue.submit(request('A', 1)); fail = true;
  await assert.rejects(queue.submit(request('A', 2)), /patch failed/);
  await assert.rejects(queue.submit(request('A', 3)), /patch failed/);
  fail = false; await queue.retry('A');
  assert.deepEqual(calls.map(job => [job.revision, job.existingId]), [[1, undefined], [2, 'persisted'], [3, 'persisted']]);
  assert.equal((await queue.submit(request('A', 1))).revision, 3); assert.equal(calls.length, 3);
  await assert.rejects(queue.submit(request('A', 4, 'different')), /不能切换/);
});

test('loaded plans PATCH immediately; callback errors cannot duplicate a committed save', async () => {
  const calls: VideoOverlaySaveRequest<{ value: string }>[] = [];
  const queue = new VideoOverlayAutosave<{ value: string }>({ save: async job => { calls.push(job); return job.existingId!; },
    onSaved: () => { throw new Error('UI was closed'); } });
  assert.equal((await queue.submit(request('A', 0, 'loaded'))).id, 'loaded');
  await queue.flush(); assert.equal(queue.hasPending, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].existingId, 'loaded');
  await assert.rejects(queue.submit({ ...request('A', 1), revision: -1 }), /无效/);
  await assert.rejects(queue.submit({ ...request('A', 1), session: '' }), /无效/);
});
