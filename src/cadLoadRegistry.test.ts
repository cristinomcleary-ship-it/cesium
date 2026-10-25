import assert from 'node:assert/strict';
import test from 'node:test';
import { CadLoadRegistry } from './cadLoadRegistry.ts';

function resource() {
  let destroyed = false, cleanups = 0;
  return {
    show: true,
    isDestroyed: () => destroyed,
    cleanup() { cleanups++; destroyed = true; },
    cleanupCount: () => cleanups,
  };
}

test('one CAD ID has one loading owner and remains unready until its resource is published', async () => {
  const registry = new CadLoadRegistry();
  const ready = new Map<string, ReturnType<typeof resource>>();
  const load = registry.begin('cad-a', 'bridge.dwg'), geometry = resource();
  assert.throws(() => registry.begin('cad-a', 'duplicate.dwg'), /正在加载/);
  assert.equal(registry.get('cad-a'), load);
  load.attach(geometry, () => geometry.cleanup());
  load.progress('正在生成几何…');
  assert.equal(registry.values().length, 1);
  assert.equal(registry.values()[0].resource, geometry);
  assert.equal(ready.has('cad-a'), false);
  let settled = false;
  void load.settled.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  load.commit(() => {
    assert.equal(registry.get('cad-a'), load, 'ID is still reserved during publication');
    ready.set(load.id, geometry);
  });
  await load.settled;
  assert.equal(settled, true); assert.equal(registry.get('cad-a'), undefined);
  assert.equal(ready.get('cad-a'), geometry); assert.equal(geometry.isDestroyed(), false);
});

test('cancel hides attached geometry immediately but retains the ID until owner cleanup and its save finish', async () => {
  const registry = new CadLoadRegistry(), geometry = resource();
  const load = registry.begin('cad-a', 'bridge.dwg');
  load.attach(geometry, () => geometry.cleanup());
  let saved = false, finishSave!: () => void;
  const pendingSave = new Promise<void>(resolve => { finishSave = resolve; });
  const owner = (async () => { await pendingSave; saved = true; load.fail(); })();
  let settled = false;
  void load.settled.then(() => { settled = true; });
  load.cancel();
  assert.equal(load.signal.aborted, true); assert.equal(geometry.show, false);
  assert.equal(geometry.cleanupCount(), 0, 'the active loader owns destruction after its update');
  await Promise.resolve();
  assert.equal(saved, false); assert.equal(settled, false); assert.equal(registry.get(load.id), load);
  assert.throws(() => registry.begin(load.id, 'retry.dwg'), /正在加载/);
  finishSave(); await owner; await load.settled;
  assert.equal(saved, true); assert.equal(settled, true); assert.equal(geometry.cleanupCount(), 1);
  assert.equal(registry.get(load.id), undefined);
});

test('failing an import cleans only its own resource and leaves other loading and ready CAD intact', async () => {
  const registry = new CadLoadRegistry();
  const failed = registry.begin('failed', 'failed.dwg'), other = registry.begin('other', 'other.dwg');
  const broken = resource(), loading = resource(), healthy = resource();
  failed.attach(broken, () => broken.cleanup()); other.attach(loading, () => loading.cleanup());
  failed.fail(); failed.fail(); await failed.settled;
  assert.equal(broken.cleanupCount(), 1); assert.equal(registry.get('failed'), undefined);
  assert.equal(registry.get('other'), other); assert.equal(loading.cleanupCount(), 0);
  assert.equal(healthy.cleanupCount(), 0); assert.equal(healthy.show, true);
  other.commit(() => {}); await other.settled;
  assert.equal(loading.cleanupCount(), 0);
});

test('commit publishes once under the original ID without destroying completed geometry or overriding its visibility', async () => {
  const snapshots: string[][] = [];
  const registry = new CadLoadRegistry(() => snapshots.push(registry.values().map(load => load.id)));
  const load = registry.begin('cad-hidden', 'hidden.dwg', false), geometry = resource();
  load.attach(geometry, () => geometry.cleanup()); assert.equal(geometry.show, false);
  const ready = new Map<string, typeof geometry>();
  let publications = 0;
  load.commit(() => { publications++; ready.set(load.id, geometry); });
  load.fail(); load.cancel(); await load.settled;
  assert.throws(() => load.commit(() => { publications++; }), { name: 'AbortError' });
  assert.equal(publications, 1); assert.equal(ready.get('cad-hidden'), geometry);
  assert.equal(geometry.show, false); assert.equal(geometry.cleanupCount(), 0);
  assert.deepEqual(snapshots.at(-1), []);
});

test('a cancelled load cannot publish and a retry becomes available only after the cancelled owner settles', async () => {
  const registry = new CadLoadRegistry(), geometry = resource();
  const cancelled = registry.begin('cad-a', 'first.dwg');
  cancelled.attach(geometry, () => geometry.cleanup()); cancelled.cancel();
  let published = false;
  assert.throws(() => cancelled.commit(() => { published = true; }), { name: 'AbortError' });
  assert.equal(published, false); assert.equal(registry.get('cad-a'), cancelled);
  cancelled.fail(); await cancelled.settled;
  const retry = registry.begin('cad-a', 'retry.dwg'), replacement = resource();
  retry.attach(replacement, () => replacement.cleanup());
  cancelled.fail(); cancelled.cancel();
  assert.equal(registry.get('cad-a'), retry, 'late old-owner cleanup cannot release the new owner');
  retry.commit(() => { published = true; }); await retry.settled;
  assert.equal(published, true); assert.equal(geometry.cleanupCount(), 1);
  assert.equal(replacement.cleanupCount(), 0); assert.equal(registry.values().length, 0);
});

test('failed publication keeps cleanup ownership until the caller handles the failure', async () => {
  const registry = new CadLoadRegistry(), load = registry.begin('cad-a', 'bridge.dwg'), geometry = resource();
  load.attach(geometry, () => geometry.cleanup());
  assert.throws(() => load.commit(() => { throw new Error('registration failed'); }), /registration failed/);
  assert.equal(registry.get('cad-a'), load); assert.equal(geometry.cleanupCount(), 0);
  load.fail(); await load.settled;
  assert.equal(geometry.cleanupCount(), 1); assert.equal(registry.values().length, 0);
});

test('cleanup failure still releases the transaction and settles cancellation without touching another owner', async () => {
  const registry = new CadLoadRegistry(), load = registry.begin('cad-a', 'bridge.dwg');
  const other = registry.begin('cad-b', 'other.dwg');
  load.attach(resource(), () => { throw new Error('cleanup failed'); });
  load.cancel(); assert.throws(() => load.fail(), /cleanup failed/); await load.settled;
  assert.equal(registry.get('cad-a'), undefined); assert.equal(registry.get('cad-b'), other);
  other.fail(); await other.settled;
});

test('cancelAll aborts every pending CAD without disposing healthy already committed CAD', async () => {
  const registry = new CadLoadRegistry(), ready = registry.begin('ready', 'ready.dwg'), healthy = resource();
  ready.attach(healthy, () => healthy.cleanup()); ready.commit(() => {});
  const loads = ['a', 'b'].map(id => {
    const load = registry.begin(id, `${id}.dwg`), geometry = resource();
    load.attach(geometry, () => geometry.cleanup()); return { load, geometry };
  });
  registry.cancelAll();
  for (const { load, geometry } of loads) {
    assert.equal(load.signal.aborted, true); assert.equal(geometry.show, false);
    load.fail(); await load.settled; assert.equal(geometry.cleanupCount(), 1);
  }
  assert.equal(healthy.show, true); assert.equal(healthy.cleanupCount(), 0);
  assert.equal(registry.values().length, 0);
});
