import assert from 'node:assert/strict';
import test from 'node:test';
import { VideoOverlayLifecycle } from './videoOverlayLifecycle.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('exit aborts work immediately but waits for task finally before releasing resources', async () => {
  const session = new VideoOverlayLifecycle(), entered = deferred(), finish = deferred(), events: string[] = [];
  session.addCleanup('scene', () => { events.push('restore scene'); });
  session.addCleanup('GPU', () => { events.push('release GPU'); });
  const task = session.run('generation', async signal => {
    entered.resolve();
    try {
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } finally {
      events.push('task cancelled');
      await finish.promise;
      events.push('task finished');
    }
  });
  const rejected = assert.rejects(task, { name: 'AbortError' });
  await entered.promise;
  const closing = session.close();
  assert.equal(closing, session.close());
  assert.equal(session.signal.aborted, true);
  await Promise.resolve();
  assert.deepEqual(events, ['task cancelled']);
  assert.equal(session.pendingCount, 1);
  finish.resolve();
  const report = await closing;
  await rejected;
  assert.equal(session.pendingCount, 0);
  assert.deepEqual(events, ['task cancelled', 'task finished', 'release GPU', 'restore scene']);
  assert.equal(report.ok, true);
  assert.equal(report.tasks[0].status, 'aborted');
  assert.deepEqual(report.cleanups.map(result => result.label), ['GPU', 'scene']);
  assert.equal(await session.close(), report);
});

test('cancellation before dispatch prevents stale work and rejects new work', async () => {
  const session = new VideoOverlayLifecycle();
  let executions = 0;
  const task = session.run('queued', () => { executions++; });
  session.abort();
  await assert.rejects(task, { name: 'AbortError' });
  await assert.rejects(session.run('late', () => { executions++; }), { name: 'AbortError' });
  assert.throws(() => session.addCleanup('late allocation', () => {}), /after session cancellation/);
  const results = await session.settled();
  assert.equal(executions, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'aborted');
});

test('failed and skipped cleanup is reported while independent releases still finish', async () => {
  const session = new VideoOverlayLifecycle();
  let released = false;
  session.addCleanup('video', () => { released = true; });
  session.addCleanup('framebuffer', () => ({ skipped: true, issues: [{ reason: 'owner-changed' }] }));
  session.addCleanup('broken owner', () => { throw new Error('release failed'); });
  await assert.rejects(session.run('import', () => { throw new Error('decode failed'); }), /decode failed/);
  const report = await session.close();
  assert.equal(released, true);
  assert.equal(report.ok, false);
  assert.deepEqual(report.tasks, [{ label: 'import', status: 'rejected', error: 'decode failed' }]);
  assert.deepEqual(report.cleanups.map(result => result.status), ['failed', 'incomplete', 'completed']);
  assert.equal(report.cleanups[0].error, 'release failed');
});

test('reentrant abort listeners share the same close and execute cleanup once', async () => {
  const session = new VideoOverlayLifecycle();
  let inside: Promise<unknown> | undefined, releases = 0;
  session.addCleanup('resource', () => { releases++; });
  session.signal.addEventListener('abort', () => { inside = session.close(); });
  const closing = session.close();
  assert.equal(inside, closing);
  await closing;
  assert.equal(releases, 1);
});

test('a completed task is retained in the report without retaining its result', async () => {
  const session = new VideoOverlayLifecycle();
  const value = { frame: new Uint8Array(16) };
  assert.equal(await session.run('frame', () => value), value);
  const report = await session.close();
  assert.deepEqual(report.tasks, [{ label: 'frame', status: 'fulfilled' }]);
  assert.equal(report.ok, true);
});
