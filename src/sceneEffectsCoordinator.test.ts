import assert from 'node:assert/strict';
import test from 'node:test';
import { SceneEffectsCoordinator } from './sceneEffectsCoordinator.ts';
import { VideoOverlaySceneIsolation } from './videoOverlaySceneIsolation.ts';

test('two AR owners and nested tasks pause each participant once and restore in reverse order', () => {
  const events: string[] = [], coordinator = new SceneEffectsCoordinator();
  let currentProject = 'first';
  for (const id of ['underground', 'managed-clipping', 'surface']) coordinator.register(id, () => {
    events.push(`pause:${id}`); return () => events.push(`resume:${id}:${currentProject}`);
  });
  const cc = new VideoOverlaySceneIsolation(() => coordinator.acquire());
  const projection = new VideoOverlaySceneIsolation(() => coordinator.acquire());
  const panel = cc.acquire(), task = cc.acquire(), otherAr = projection.acquire();
  assert.equal(coordinator.leaseCount, 2);
  assert.deepEqual(events, ['pause:underground', 'pause:managed-clipping', 'pause:surface']);
  currentProject = 'latest';
  panel(); otherAr(); otherAr();
  assert.equal(coordinator.leaseCount, 1); assert.equal(events.length, 3);
  task(); task();
  assert.equal(coordinator.leaseCount, 0);
  assert.deepEqual(events.slice(3), ['resume:surface:latest', 'resume:managed-clipping:latest', 'resume:underground:latest']);
});

test('a later suspension failure unwinds acquired owners and the next attempt is usable', () => {
  const events: string[] = [], coordinator = new SceneEffectsCoordinator(), failure = new Error('cannot pause surface');
  let fail = true;
  coordinator.register('old', () => { events.push('pause old'); return () => events.push('resume old'); });
  coordinator.register('new', () => { if (fail) throw failure; events.push('pause new'); return () => events.push('resume new'); });
  assert.throws(() => coordinator.acquire(), error => error === failure);
  assert.equal(coordinator.leaseCount, 0); assert.deepEqual(events, ['pause old', 'resume old']);
  fail = false; coordinator.acquire()();
  assert.deepEqual(events.slice(2), ['pause old', 'pause new', 'resume new', 'resume old']);
});

test('rollback errors remain observable without stranding the coordinator', () => {
  const coordinator = new SceneEffectsCoordinator(), initial = new Error('pause'), rollback = new Error('restore');
  let fail = true;
  coordinator.register('first', () => () => { if (fail) throw rollback; });
  coordinator.register('last', () => { if (fail) throw initial; });
  assert.throws(() => coordinator.acquire(), error => error instanceof AggregateError
    && error.cause === initial && error.errors[0] === initial && error.errors[1] === rollback);
  assert.equal(coordinator.leaseCount, 0);
  fail = false; coordinator.acquire()();
});

test('a failed final restore still releases every owner once and permits another session', () => {
  const events: string[] = [], coordinator = new SceneEffectsCoordinator(), failure = new Error('old object removed');
  let fail = true;
  for (const id of ['first', 'middle', 'last']) coordinator.register(id, () => () => {
    events.push(id); if (id === 'middle' && fail) throw failure;
  });
  const release = coordinator.acquire();
  assert.throws(release, error => error instanceof AggregateError && error.errors[0] === failure);
  assert.equal(coordinator.leaseCount, 0); assert.deepEqual(events, ['last', 'middle', 'first']);
  release(); assert.equal(events.length, 3);
  fail = false; coordinator.acquire()(); assert.deepEqual(events.slice(3), ['last', 'middle', 'first']);
});

test('late registration joins active AR before exposing its effects, and stale unregister is harmless', () => {
  const events: string[] = [], coordinator = new SceneEffectsCoordinator();
  const first = coordinator.acquire(), second = coordinator.acquire();
  const old = coordinator.register('surface', () => { events.push('pause old'); return () => events.push('resume old'); });
  old(); old();
  const next = coordinator.register('surface', () => { events.push('pause new'); return () => events.push('resume new'); });
  old(); first(); assert.deepEqual(events, ['pause old', 'resume old', 'pause new']);
  second(); next(); assert.deepEqual(events, ['pause old', 'resume old', 'pause new', 'resume new']);
});

test('failed late registration preserves existing leases and can be retried', () => {
  const coordinator = new SceneEffectsCoordinator();
  const release = coordinator.acquire();
  assert.throws(() => coordinator.register('late', () => { throw new Error('late failed'); }), /late failed/);
  assert.equal(coordinator.leaseCount, 1);
  let restored = 0;
  coordinator.register('late', () => () => { restored++; });
  release(); assert.equal(restored, 1);
});

test('disposal releases all participants despite errors and invalidates outstanding leases', () => {
  const coordinator = new SceneEffectsCoordinator(), events: string[] = [];
  coordinator.register('first', () => () => { events.push('first'); });
  coordinator.register('last', () => () => { events.push('last'); throw new Error('cleanup failed'); });
  const release = coordinator.acquire();
  assert.throws(() => coordinator.dispose(), AggregateError);
  release(); coordinator.dispose(); assert.deepEqual(events, ['last', 'first']);
  assert.equal(coordinator.leaseCount, 0);
  assert.throws(() => coordinator.acquire(), /已释放/);
  assert.throws(() => coordinator.register('new', () => {}), /已释放/);
});

test('reentrant acquisition is rejected and rolls back the partially acquired group', () => {
  const coordinator = new SceneEffectsCoordinator();
  let restores = 0;
  coordinator.register('first', () => () => { restores++; });
  const unregister = coordinator.register('recursive', () => coordinator.acquire());
  assert.throws(() => coordinator.acquire(), /不能重入/);
  assert.equal(coordinator.leaseCount, 0); assert.equal(restores, 1);
  unregister(); coordinator.acquire()(); assert.equal(restores, 2);
});
