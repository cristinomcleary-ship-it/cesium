import assert from 'node:assert/strict';
import test from 'node:test';
import { Event, Primitive, PrimitiveCollection, type Scene } from 'cesium';
import { createCadGeometryScheduler, getCadGeometrySchedulerStats } from './cadGeometryScheduler.ts';

class Geometry {
  ready = false; show = true; _state = 0; _error?: unknown;
  _primitive?: Geometry; _createGeometryResults?: unknown;
  destroyed = false; calls = 0; starts = 0; drawn = 0;
  update() {
    this.calls++;
    if (this._error) throw this._error;
    if (this._state === 0) { this._state = 1; this.starts++; }
    if (this.ready && this.show) this.drawn++;
  }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  complete() { this.ready = true; this._state = 5; }
  cesium() { return this as unknown as Primitive; }
}

function fixture() {
  const primitives = new PrimitiveCollection();
  const postRender = new Event();
  let requests = 0;
  const scene = { primitives, postRender, requestRender() { requests++; } } as unknown as Scene;
  const render = () => { (primitives as unknown as { update(frame: unknown): void }).update({}); postRender.raiseEvent(scene); };
  return { scene, primitives, postRender, render, requests: () => requests,
    collection() { return primitives.add(new PrimitiveCollection()); } };
}
async function drain(f: ReturnType<typeof fixture>, geometries: Geometry[]) {
  for (let i = 0; i < geometries.length + 2; i++) {
    f.render();
    for (const geometry of geometries) if (geometry.starts && !geometry.destroyed) geometry.complete();
    f.postRender.raiseEvent(f.scene);
    await Promise.resolve();
  }
}

test('disabled or unavailable scenes never wait on unattached geometry; success is not disposed', async () => {
  for (const scene of [undefined, {} as Scene]) {
    const collection = new PrimitiveCollection();
    const session = createCadGeometryScheduler({ scene, collection, enabled: true });
    const geometry = new Geometry();
    assert.equal(session.enabled, false);
    session.add(geometry.cesium());
    await session.waitForCapacity(); await session.finish(); session.dispose();
    assert.equal(geometry.calls, 0); assert.equal(collection.isDestroyed(), false);
    collection.destroy();
  }
});

test('construction before beforePopulate attachment is supported and the original Primitive identity is retained', async () => {
  const f = fixture(), collection = new PrimitiveCollection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  f.primitives.add(collection);
  const primitive = new Primitive();
  // Exercise a genuine Cesium instance without requiring a GPU in this unit test.
  Object.defineProperty(primitive, 'ready', { configurable: true, value: true });
  assert.equal(session.add(primitive), primitive); assert.ok(collection.get(0) instanceof Primitive);
  await session.finish();
  assert.equal(collection.get(0), primitive); assert.equal(collection.isDestroyed(), false);
  f.primitives.destroy();
});

test('two import sessions share at most two active compilations and release all permits on ready', async () => {
  const f = fixture(), a = f.collection(), b = f.collection();
  const first = createCadGeometryScheduler({ scene: f.scene, collection: a, enabled: true });
  const second = createCadGeometryScheduler({ scene: f.scene, collection: b, enabled: true });
  const geometries = Array.from({ length: 7 }, () => new Geometry());
  geometries.forEach((g, i) => (i < 4 ? first : second).add(g.cesium()));
  f.render();
  assert.equal(geometries.filter(g => g.starts).length, 2);
  assert.deepEqual(getCadGeometrySchedulerStats(f.scene), { active: 2, queued: 5, pending: 7, maxActive: 2 });
  const finished = Promise.all([first.finish(), second.finish()]);
  await drain(f, geometries); await finished;
  assert.equal(geometries.every(g => g.ready && g.starts === 1), true);
  assert.deepEqual(getCadGeometrySchedulerStats(f.scene), { active: 0, queued: 0, pending: 0, maxActive: 2 });
  assert.equal(first.pendingCount + second.pendingCount, 0);
  assert.equal(f.postRender.numberOfListeners, 0);
  assert.equal(Object.hasOwn(a, 'update'), false);
  f.primitives.destroy();
});

test('capacity backpressure waits for a batch to complete and finish waits for every batch', async () => {
  const f = fixture(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  const geometries = Array.from({ length: 4 }, () => new Geometry());
  geometries.forEach(g => session.add(g.cesium()));
  let capacity = false, finished = false;
  const capacityPromise = session.waitForCapacity().then(() => { capacity = true; });
  const finishedPromise = session.finish().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(capacity, false); assert.equal(finished, false);
  f.render(); geometries[0].complete(); f.postRender.raiseEvent(f.scene);
  await capacityPromise; assert.equal(capacity, true); assert.equal(finished, false);
  await drain(f, geometries); await finishedPromise;
  assert.equal(finished, true); f.primitives.destroy();
});

test('hidden AR geometry and labels compile without drawing or changing saved visibility', async () => {
  const f = fixture(), collection = f.collection(); collection.show = false;
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true, showWhileLoading: false });
  const geometry = new Geometry(), label = new Geometry(); label.complete();
  collection.add(label); session.add(geometry.cesium());
  const finished = session.finish();
  f.render(); assert.equal(geometry.starts, 1); assert.equal(collection.show, false);
  geometry.complete(); f.render(); await finished;
  assert.equal(label.drawn, 0); assert.equal(geometry.drawn, 0);
  assert.equal(collection.show, false); assert.equal(label.show, true); assert.equal(geometry.show, true);
  collection.show = true; f.render(); assert.equal(geometry.drawn, 1); assert.equal(label.drawn, 1);
  f.primitives.destroy();
});

test('worker failures whose ready flag is true reject the import and never start its remaining queued geometry', async () => {
  const f = fixture(), existing = f.collection(), healthy = new Geometry(); healthy.complete(); existing.add(healthy);
  const collection = f.collection(), session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  const geometries = Array.from({ length: 4 }, () => new Geometry());
  geometries.forEach(g => session.add(g.cesium()));
  const rejected = assert.rejects(session.finish(), /Array buffer allocation failed/);
  f.render();
  // This is how pinned Cesium completes a rejected worker result.
  geometries[0]._error = { name: 'RangeError', message: 'Array buffer allocation failed', stack: 'PrimitivePipeline.packCreateGeometryResults' };
  geometries[0]._state = 6; geometries[0].ready = true;
  assert.doesNotThrow(() => f.render()); await rejected; await Promise.resolve();
  assert.equal(collection.isDestroyed(), true); assert.equal(existing.isDestroyed(), false);
  assert.equal(healthy.destroyed, false); assert.equal(geometries[2].starts + geometries[3].starts, 0);
  geometries[1]._state = 2; f.postRender.raiseEvent(f.scene);
  assert.equal(getCadGeometrySchedulerStats(f.scene).pending, 0);
  f.primitives.destroy();
});

test('Cesium empty geometry FAILED without an error remains a completed skipped geometry', async () => {
  const f = fixture(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  const geometry = new Geometry(); session.add(geometry.cesium());
  const done = session.finish(); f.render(); geometry._state = 6; geometry.ready = true;
  f.postRender.raiseEvent(f.scene); await done;
  assert.equal(collection.isDestroyed(), false); assert.equal(session.pendingCount, 0);
  f.primitives.destroy();
});

test('nested GroundPrimitive errors are checked before its public ready flag', async () => {
  const f = fixture(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  const ground = new Geometry(); ground._primitive = new Geometry(); ground._primitive._primitive = new Geometry();
  session.add(ground.cesium()); const rejected = assert.rejects(session.finish(), /inner memory failure/);
  f.render(); ground._state = 5;
  ground._primitive._primitive._error = new RangeError('inner memory failure');
  ground._primitive._primitive._state = 6; ground.ready = true;
  f.postRender.raiseEvent(f.scene); await rejected; await Promise.resolve();
  assert.equal(collection.isDestroyed(), true); assert.equal(getCadGeometrySchedulerStats(f.scene).active, 0);
  f.primitives.destroy();
});

test('abort cancels queued jobs but retains worker permits until already submitted tasks settle', async () => {
  const f = fixture(), controller = new AbortController(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true, signal: controller.signal });
  const old = Array.from({ length: 4 }, () => new Geometry()); old.forEach(g => session.add(g.cesium()));
  const rejected = assert.rejects(session.finish(), { name: 'AbortError' });
  f.render(); controller.abort(); await rejected; await Promise.resolve();
  assert.equal(collection.isDestroyed(), true); assert.equal(getCadGeometrySchedulerStats(f.scene).active, 2);
  const freshCollection = f.collection(), fresh = createCadGeometryScheduler({ scene: f.scene, collection: freshCollection, enabled: true });
  const next = new Geometry(); fresh.add(next.cesium()); f.render(); assert.equal(next.starts, 0);
  old[0]._state = 2; old[0]._createGeometryResults = new Float64Array(20); f.postRender.raiseEvent(f.scene);
  f.render(); assert.equal(next.starts, 1); assert.equal(old[0]._createGeometryResults, undefined);
  assert.equal(old[2].starts + old[3].starts, 0);
  old[1]._state = 4; next.complete(); f.postRender.raiseEvent(f.scene); await fresh.finish();
  assert.equal(getCadGeometrySchedulerStats(f.scene).pending, 0); f.primitives.destroy();
});

test('removal without destruction and a paused scene reject waiters without affecting previous resources', async () => {
  const f = fixture(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  const geometry = new Geometry(); session.add(geometry.cesium());
  const rejected = assert.rejects(session.finish(), /移除/);
  f.primitives.destroyPrimitives = false; f.primitives.remove(collection); f.postRender.raiseEvent(f.scene);
  await rejected; await Promise.resolve(); assert.equal(collection.isDestroyed(), true);
  f.primitives.destroyPrimitives = true;
  const paused = f.collection(), timed = createCadGeometryScheduler({ scene: f.scene, collection: paused, enabled: true, timeoutMs: 1 });
  timed.add(new Geometry().cesium()); await assert.rejects(timed.finish(), /超时/);
  await Promise.resolve(); assert.equal(paused.isDestroyed(), true);
  assert.equal(getCadGeometrySchedulerStats(f.scene).active, 0); f.primitives.destroy();
});

test('queue registration failure after collection.add rejects and destroys only the new collection', async () => {
  const f = fixture(), existing = f.collection(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  f.scene.requestRender = () => { throw new Error('scene request failed'); };
  const geometry = new Geometry();
  assert.throws(() => session.add(geometry.cesium()), /scene request failed/);
  await assert.rejects(session.finish(), /scene request failed/);
  await Promise.resolve(); f.postRender.raiseEvent(f.scene);
  assert.equal(collection.isDestroyed(), true); assert.equal(existing.isDestroyed(), false);
  assert.equal(geometry.starts, 0); assert.equal(getCadGeometrySchedulerStats(f.scene).pending, 0);
  f.primitives.destroy();
});

test('cancelled nested combine workers retain permits even after GroundPrimitive clears its child reference', async () => {
  const f = fixture(), collection = f.collection(), controller = new AbortController();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true, signal: controller.signal });
  const ground = new Geometry(), inner = new Geometry();
  ground._primitive = inner;
  ground.destroy = () => { ground.destroyed = true; inner.destroy(); ground._primitive = undefined; };
  session.add(ground.cesium()); f.render(); ground._state = 5; inner._state = 3;
  const rejected = assert.rejects(session.finish(), { name: 'AbortError' }); controller.abort();
  await rejected; await Promise.resolve();
  assert.equal(ground._primitive, undefined); assert.equal(getCadGeometrySchedulerStats(f.scene).active, 1);
  inner._state = 4; f.postRender.raiseEvent(f.scene);
  assert.equal(getCadGeometrySchedulerStats(f.scene).active, 0); f.primitives.destroy();
});

test('destroying a scene rejects pending preparation and releases queued permits', async () => {
  const f = fixture(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  session.add(new Geometry().cesium());
  const rejected = assert.rejects(session.finish(), /移除/);
  f.primitives.destroy(); f.postRender.raiseEvent(f.scene); await rejected; await Promise.resolve();
  assert.equal(getCadGeometrySchedulerStats(f.scene).pending, 0);
});

test('an indivisible large face waits for prior jobs and exclusively owns compilation before later normal batches', async () => {
  const f = fixture(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  const first = new Geometry(), face = new Geometry(), later = new Geometry();
  session.add(first.cesium()); session.add(face.cesium(), { exclusive: true }); session.add(later.cesium());
  f.render(); assert.equal(first.starts, 1); assert.equal(face.starts + later.starts, 0);
  first.complete(); f.postRender.raiseEvent(f.scene); f.render();
  assert.equal(face.starts, 1); assert.equal(later.starts, 0); assert.equal(session.activeCount, 1);
  face.complete(); f.postRender.raiseEvent(f.scene); f.render(); assert.equal(later.starts, 1);
  later.complete(); f.postRender.raiseEvent(f.scene); await session.finish();
  assert.equal(getCadGeometrySchedulerStats(f.scene).pending, 0); f.primitives.destroy();
});

test('cancelling an exclusive face keeps its reservation until its submitted worker settles', async () => {
  const f = fixture(), collection = f.collection(), controller = new AbortController();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true, signal: controller.signal });
  const face = new Geometry(); session.add(face.cesium(), { exclusive: true }); f.render();
  const rejected = assert.rejects(session.finish(), { name: 'AbortError' }); controller.abort(); await rejected;
  const otherCollection = f.collection(), other = createCadGeometryScheduler({ scene: f.scene, collection: otherCollection, enabled: true });
  const next = new Geometry(); other.add(next.cesium()); f.render(); assert.equal(next.starts, 0);
  face._state = 2; f.postRender.raiseEvent(f.scene); f.render(); assert.equal(next.starts, 1);
  next.complete(); f.postRender.raiseEvent(f.scene); await other.finish();
  assert.equal(getCadGeometrySchedulerStats(f.scene).pending, 0); f.primitives.destroy();
});

test('a scene request error during queue polling rejects its importer without escaping postRender', async () => {
  const f = fixture(), collection = f.collection();
  const session = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  const geometry = new Geometry(); session.add(geometry.cesium());
  const rejected = assert.rejects(session.finish(), /late scene failure/);
  f.scene.requestRender = () => { throw new Error('late scene failure'); };
  assert.doesNotThrow(() => f.postRender.raiseEvent(f.scene)); await rejected; await Promise.resolve();
  assert.equal(collection.isDestroyed(), true); assert.equal(getCadGeometrySchedulerStats(f.scene).pending, 0);
  f.primitives.destroy();
});

test('capacity is shared across imports and another owner completing a batch wakes an owner with no jobs', async () => {
  const f = fixture(), collection = f.collection(), emptyCollection = f.collection();
  const first = createCadGeometryScheduler({ scene: f.scene, collection, enabled: true });
  const second = createCadGeometryScheduler({ scene: f.scene, collection: emptyCollection, enabled: true });
  const geometries = Array.from({ length: 4 }, () => new Geometry()); geometries.forEach(g => first.add(g.cesium()));
  let available = false;
  const waiting = second.waitForCapacity().then(() => { available = true; });
  await Promise.resolve(); assert.equal(available, false); assert.equal(second.pendingCount, 0);
  f.render(); geometries[0].complete(); f.postRender.raiseEvent(f.scene); await waiting;
  assert.equal(available, true);
  await second.finish(); await drain(f, geometries); await first.finish(); f.primitives.destroy();
});

test('cancellation removes shared capacity waiters and wakes other owners after queued work is cancelled', async () => {
  const f = fixture(), controller = new AbortController();
  const first = createCadGeometryScheduler({ scene: f.scene, collection: f.collection(), enabled: true });
  const cancelled = createCadGeometryScheduler({ scene: f.scene, collection: f.collection(), enabled: true, signal: controller.signal });
  const third = createCadGeometryScheduler({ scene: f.scene, collection: f.collection(), enabled: true });
  const geometries = Array.from({ length: 4 }, () => new Geometry()); geometries.forEach(g => first.add(g.cesium()));
  const cancelledWait = assert.rejects(cancelled.waitForCapacity(), { name: 'AbortError' });
  const otherWait = third.waitForCapacity();
  controller.abort(); await cancelledWait;
  first.dispose(); await otherWait; await third.finish(); await Promise.resolve();
  assert.equal(getCadGeometrySchedulerStats(f.scene).pending, 0);
  f.postRender.raiseEvent(f.scene); assert.equal(f.postRender.numberOfListeners, 0); f.primitives.destroy();
});
