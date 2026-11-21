import assert from 'node:assert/strict';
import test from 'node:test';
import { ContactWorkQueue } from './workQueue.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('a single lease serializes reader and worker stages in FIFO order without overlapping them', async () => {
  const queue = new ContactWorkQueue(), first = await queue.acquire(), order: number[] = [];
  let concurrent = 1, maximum = 1;
  const run = (index: number) => queue.acquire().then(async release => {
    concurrent++; maximum = Math.max(maximum, concurrent); order.push(index);
    try { await tick(); await tick(); } finally { concurrent--; release(); }
  });
  const a = run(1), b = run(2), c = run(3);
  await tick(); assert.deepEqual(order, []); assert.deepEqual(queue.status, { active: 1, pending: 3 });
  concurrent--; first(); await Promise.all([a, b, c]);
  assert.deepEqual(order, [1, 2, 3]); assert.equal(maximum, 1); assert.deepEqual(queue.status, { active: 0, pending: 0 });
});

test('queued cancellation removes the request and releases its slot without reading geometry', async () => {
  const queue = new ContactWorkQueue(1), release = await queue.acquire(), cancelled = new AbortController();
  let read = false;
  const waiting = queue.acquire(cancelled.signal).then(releaseNext => { read = true; releaseNext(); });
  const rejected = assert.rejects(waiting, error => (error as Error).name === 'AbortError');
  cancelled.abort(); await rejected;
  assert.equal(read, false); assert.deepEqual(queue.status, { active: 1, pending: 0 });
  const replacement = queue.acquire(); release(); (await replacement)();
  assert.deepEqual(queue.status, { active: 0, pending: 0 });
});

test('aborting active work keeps the lease until the reader or Worker has actually stopped', async () => {
  const queue = new ContactWorkQueue(), active = new AbortController(), release = await queue.acquire(active.signal);
  let granted = false;
  const waiting = queue.acquire().then(next => { granted = true; return next; });
  active.abort(); await tick(); assert.equal(granted, false); assert.equal(queue.status.active, 1);
  release(); const next = await waiting; assert.equal(granted, true); next();
});

test('capacity rejects before the caller can create input arrays and a failure finally grants the next task', async () => {
  const queue = new ContactWorkQueue(1), release = await queue.acquire();
  const waiting = queue.acquire(); let read = false;
  await assert.rejects(queue.acquire().then(() => { read = true; }), /等待任务预算/);
  assert.equal(read, false); assert.deepEqual(queue.status, { active: 1, pending: 1 });
  try { throw new Error('reader failed'); } catch { /* report elsewhere */ } finally { release(); }
  const next = await waiting; next(); assert.deepEqual(queue.status, { active: 0, pending: 0 });
});

test('repeated release cannot revoke the next holder and already-aborted requests consume no capacity', async () => {
  const queue = new ContactWorkQueue(), aborted = new AbortController(); aborted.abort();
  await assert.rejects(queue.acquire(aborted.signal), error => (error as Error).name === 'AbortError');
  const first = await queue.acquire(), next = queue.acquire(); first(); const second = await next;
  first(); first(); assert.deepEqual(queue.status, { active: 1, pending: 0 });
  second(); assert.deepEqual(queue.status, { active: 0, pending: 0 });
  assert.throws(() => new ContactWorkQueue(-1), /预算无效/);
});
