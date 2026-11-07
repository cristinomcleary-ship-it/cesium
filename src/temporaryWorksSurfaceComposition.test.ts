import test from 'node:test';
import assert from 'node:assert/strict';
import { TemporaryWorksSurfaceComposition, type SurfaceCompositionEntry, type SurfaceCompositionCoverage } from './temporaryWorksSurfaceComposition.ts';

type Data = { name: string; shrink?: boolean; clip?: boolean };
type Result = { id: string; data: Data; blockers: string[] };
const box = (x = 0) => ({ minX: x, minY: 0, maxX: x + 10, maxY: 10 });
const entry = (id: string, kind: 'road' | 'facility' | 'hardening' = 'hardening', priority = 0, x = 0): SurfaceCompositionEntry<Data> =>
  ({ id, kind, priority, bounds: box(x), visible: true, ready: kind !== 'hardening', data: { name: id } });
function fixture() {
  const builds: Array<{ id: string; blockers: string[]; bounds: number[] }> = [], suspended: string[] = [], errors: string[] = [];
  const shown = new Map<string, Result>(), fail = new Set<string>();
  const coordinator = new TemporaryWorksSurfaceComposition<Data, Result>({
    async build(e, blockers) {
      builds.push({ id: e.id, blockers: blockers.map(b => b.data.name), bounds: blockers.map(b => b.bounds.maxX) });
      if (fail.has(e.id)) throw new Error('synthetic local geometry failure');
      return { id: e.id, data: { name: `actual:${e.data.name}` }, blockers: blockers.map(b => b.id) };
    },
    commit(e, result): SurfaceCompositionCoverage<Data> {
      shown.set(e.id, result);
      return { bounds: e.data.shrink ? { ...e.bounds, maxX: e.bounds.minX + 4 } : e.bounds, data: result.data };
    },
    suspend(id) { suspended.push(id); shown.delete(id); },
    onError(id) { errors.push(id); },
  });
  return { coordinator, builds, suspended, errors, shown, fail };
}

test('stable priority, not insertion order, composes actual ready coverage before lower hardening', async () => {
  const f = fixture(), a = entry('a', 'hardening', 1), b = entry('b', 'hardening', 2);
  a.data.shrink = true;
  f.coordinator.upsert(b); f.coordinator.upsert(a);
  await f.coordinator.whenIdle();
  assert.deepEqual(f.builds.map(b => b.id), ['a', 'b']);
  assert.deepEqual(f.builds[1].blockers, ['actual:a']);
  assert.deepEqual(f.builds[1].bounds, [4], 'source maxX=10 must not replace ready maxX=4');
  assert.equal(a.data.name, 'a', 'composition never rewrites the source');
  f.coordinator.destroy();
});

test('loading/hidden facilities do not occupy hardening; a drawable facility does', async () => {
  const f = fixture(), ground = entry('ground'), model = entry('camp', 'facility');
  model.ready = false;
  f.coordinator.upsert(ground); f.coordinator.upsert(model); await f.coordinator.whenIdle();
  assert.deepEqual(f.shown.get('ground')?.blockers, []);
  f.coordinator.upsert({ ...model, ready: true }); await f.coordinator.whenIdle();
  assert.deepEqual(f.shown.get('ground')?.blockers, ['camp']);
  f.coordinator.upsert({ ...model, ready: true, visible: false }); await f.coordinator.whenIdle();
  assert.deepEqual(f.shown.get('ground')?.blockers, []);
  f.coordinator.destroy();
});

test('moving a road invalidates both old and new neighbourhoods but leaves a distant field untouched', async () => {
  const f = fixture();
  for (const e of [entry('left', 'hardening', 1, 0), entry('right', 'hardening', 2, 100), entry('far', 'hardening', 3, 1000), entry('road', 'road', 0, 0)]) f.coordinator.upsert(e);
  await f.coordinator.whenIdle(); f.builds.length = 0; f.suspended.length = 0;
  f.coordinator.upsert(entry('road', 'road', 0, 100)); await f.coordinator.whenIdle();
  assert.deepEqual(f.builds.map(b => b.id), ['left', 'right']);
  assert.deepEqual(f.shown.get('left')?.blockers, []); assert.deepEqual(f.shown.get('right')?.blockers, ['road']);
  assert.equal(f.suspended.includes('far'), false);
  f.coordinator.destroy();
});

test('deleting an upper field restores lower coverage without deleting either lower source or a road', async () => {
  const f = fixture();
  f.coordinator.upsert(entry('upper', 'hardening', 1)); f.coordinator.upsert(entry('lower', 'hardening', 2)); f.coordinator.upsert(entry('road', 'road'));
  await f.coordinator.whenIdle(); assert.deepEqual(f.shown.get('lower')?.blockers, ['road', 'upper']);
  f.coordinator.remove('upper'); await f.coordinator.whenIdle();
  assert.deepEqual(f.shown.get('lower')?.blockers, ['road']); assert.equal(f.shown.has('upper'), false);
  f.coordinator.destroy();
});

test('a dependent rebuild failure suspends only affected hardening and never blocks the initiating road operation', async () => {
  const f = fixture();
  f.coordinator.upsert(entry('ground')); f.coordinator.upsert(entry('far', 'hardening', 1, 1000)); await f.coordinator.whenIdle();
  f.fail.add('ground');
  assert.doesNotThrow(() => f.coordinator.upsert(entry('road', 'road')));
  assert.equal(f.shown.has('ground'), false, 'display and clip are suspended by the callback before rebuilding');
  assert.equal(f.shown.has('far'), true);
  await f.coordinator.whenIdle(); assert.equal(f.coordinator.getState('ground'), 'error');
  assert.deepEqual(f.errors, ['ground']); assert.equal(f.coordinator.getCoverage('ground'), undefined);
  f.coordinator.destroy();
});

test('an explicit edit can retain the old committed hardening if its replacement fails', async () => {
  const f = fixture(), a = entry('ground');
  f.coordinator.upsert(a); await f.coordinator.whenIdle();
  const old = f.shown.get('ground'), coverage = f.coordinator.getCoverage('ground');
  f.fail.add('ground');
  f.coordinator.upsert({ ...a, data: { name: 'edited' } }, { preserveCurrent: true }); await f.coordinator.whenIdle();
  assert.equal(f.shown.get('ground'), old); assert.equal(f.coordinator.getCoverage('ground'), coverage);
  f.coordinator.destroy();
});

test('a late cancelled calculation is discarded while the newer operation completes without waiting for it', async () => {
  let finishOld!: (r: Result) => void, started!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  const committed: string[] = [], discarded: string[] = [];
  const coordinator = new TemporaryWorksSurfaceComposition<Data, Result>({
    build: async (e) => {
      if (e.data.name === 'old') { started(); return new Promise(r => { finishOld = r; }); }
      return { id: e.id, data: e.data, blockers: [] };
    },
    commit: (e, r) => { committed.push(r.data.name); return { bounds: e.bounds, data: r.data }; },
    suspend() {}, discard: r => { discarded.push(r.data.name); },
  });
  const a = entry('field');
  coordinator.upsert({ ...a, data: { name: 'old' } }); await entered;
  coordinator.upsert({ ...a, data: { name: 'new' } }); await coordinator.whenIdle();
  assert.deepEqual(committed, ['new']);
  finishOld({ id: 'field', data: { name: 'old' }, blockers: [] });
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(discarded, ['old']); assert.deepEqual(committed, ['new']);
  coordinator.destroy();
});

test('identical association refreshes do not schedule geometry work', async () => {
  const f = fixture(), a = entry('ground');
  f.coordinator.upsert(a); await f.coordinator.whenIdle();
  const count = f.builds.length;
  for (let i = 0; i < 20; i++) f.coordinator.upsert({ ...a, bounds: { ...a.bounds } });
  await f.coordinator.whenIdle(); assert.equal(f.builds.length, count);
  f.coordinator.destroy();
});

test('a failed higher hardening does not mask the lower source, and retry restores stable ordering', async () => {
  const f = fixture(); f.fail.add('a');
  f.coordinator.upsert(entry('b', 'hardening', 2)); f.coordinator.upsert(entry('a', 'hardening', 1)); await f.coordinator.whenIdle();
  assert.deepEqual(f.shown.get('b')?.blockers, []);
  f.fail.delete('a'); f.coordinator.refresh('a'); await f.coordinator.whenIdle();
  assert.deepEqual(f.shown.get('b')?.blockers, ['a']);
  f.coordinator.destroy();
});

test('clear cancels work and cannot resurrect objects through a late completion', async () => {
  let complete!: (r: Result) => void, began!: () => void;
  const begun = new Promise<void>(r => { began = r; });
  let commits = 0, discards = 0;
  const coordinator = new TemporaryWorksSurfaceComposition<Data, Result>({
    build: async () => { began(); return new Promise(r => { complete = r; }); },
    commit: () => { commits++; return undefined; }, suspend() {}, discard() { discards++; },
  });
  coordinator.upsert(entry('field')); await begun; coordinator.clear(); await coordinator.whenIdle();
  complete({ id: 'field', data: { name: 'late' }, blockers: [] }); await new Promise(r => setTimeout(r, 0));
  assert.equal(commits, 0); assert.equal(discards, 1); assert.equal(coordinator.getState('field'), undefined);
  coordinator.destroy();
});

test('prepared preview keeps source priority, skips its own build and never rebuilds higher neighbours', async () => {
  const f = fixture(), high = entry('a', 'hardening', 1), low = entry('z', 'hardening', 1);
  f.coordinator.upsert(high); f.coordinator.upsert(low); await f.coordinator.whenIdle();
  f.builds.length = 0; f.suspended.length = 0;
  const preview = { ...entry('preview:transient', 'hardening', 1), orderKey: 'm' };
  f.coordinator.upsertReady(preview, { bounds: preview.bounds, data: { name: 'actual:preview' } });
  await f.coordinator.whenIdle();
  assert.deepEqual(f.builds.map(b => b.id), ['z']);
  assert.equal(f.suspended.includes('a'), false); assert.equal(f.suspended.includes(preview.id), false);
  assert.deepEqual(f.builds[0].blockers, ['actual:a', 'actual:preview']);
  assert.equal(f.coordinator.getState(preview.id), 'ready');
  f.coordinator.destroy();
});

test('removing a prepared preview restores only lower-priority occupancy', async () => {
  const f = fixture(), preview = { ...entry('preview:m', 'hardening', 1), orderKey: 'm' };
  f.coordinator.upsert(entry('a', 'hardening', 1)); f.coordinator.upsert(entry('z', 'hardening', 1));
  await f.coordinator.whenIdle();
  f.coordinator.upsertReady(preview, { bounds: preview.bounds, data: { name: 'actual:preview' } });
  await f.coordinator.whenIdle(); f.builds.length = 0;
  f.coordinator.remove(preview.id); await f.coordinator.whenIdle();
  assert.deepEqual(f.builds.map(b => b.id), ['z']); assert.deepEqual(f.builds[0].blockers, ['actual:a']);
  assert.equal(f.coordinator.getCoverage(preview.id), undefined);
  f.coordinator.destroy();
});

test('a fully covered prepared preview owns no surface despite retaining its source selection', async () => {
  const f = fixture(), preview = { ...entry('preview:a', 'hardening', 0), orderKey: 'a' };
  f.coordinator.upsert(entry('lower', 'hardening', 2)); await f.coordinator.whenIdle(); f.builds.length = 0;
  f.coordinator.upsertReady(preview, undefined); await f.coordinator.whenIdle();
  assert.equal(f.coordinator.getState(preview.id), 'covered');
  assert.equal(f.coordinator.getCoverage(preview.id), undefined);
  assert.deepEqual(f.builds[0].blockers, []);
  assert.equal(f.builds.some(b => b.id === preview.id), false);
  f.coordinator.destroy();
});

test('prepared save handoff aborts an older build and discards its late candidate', async () => {
  let finish!: (r: Result) => void, start!: () => void;
  const started = new Promise<void>(r => { start = r; }), discarded: string[] = [];
  const c = new TemporaryWorksSurfaceComposition<Data, Result>({
    build: async () => { start(); return new Promise(r => { finish = r; }); },
    commit() { assert.fail('an older asynchronous candidate cannot replace a prepared save'); },
    suspend() {}, discard: r => { discarded.push(r.data.name); },
  });
  const a = entry('a'); c.upsert(a); await started;
  c.upsertReady(a, { bounds: box(), data: { name: 'prepared' } }); await c.whenIdle();
  finish({ id: 'a', data: { name: 'old' }, blockers: [] }); await new Promise(r => setTimeout(r, 0));
  assert.equal(c.getCoverage('a')?.data.name, 'prepared'); assert.deepEqual(discarded, ['old']);
  c.destroy();
});

test('display metadata updates retain current derived coverage and never rebuild owners or neighbours', async () => {
  const f = fixture(), source = entry('a', 'hardening', 1);
  f.coordinator.upsert(source); f.coordinator.upsert(entry('b', 'hardening', 2)); await f.coordinator.whenIdle();
  f.builds.length = 0; f.suspended.length = 0;
  const bounds = f.coordinator.getCoverage('a')!.bounds;
  assert.equal(f.coordinator.updateMetadata('a', data => ({ ...data, clip: false })), true);
  await f.coordinator.whenIdle();
  const actual = f.coordinator.getCoverage('a')!;
  assert.equal(actual.data.name, 'actual:a', 'stored source must not replace the actual derived surface');
  assert.equal(actual.data.clip, false); assert.equal(actual.bounds, bounds);
  assert.deepEqual(f.builds, []); assert.deepEqual(f.suspended, []);
  assert.equal(f.coordinator.updateMetadata('absent', data => data), false);
  f.coordinator.destroy();
});

test('a pending geometry job commits with the latest metadata without restarting geometry', async () => {
  let complete!: (r: Result) => void, start!: () => void, builds = 0;
  const begun = new Promise<void>(r => { start = r; });
  const currentClipping: Array<boolean | undefined> = [];
  const c = new TemporaryWorksSurfaceComposition<Data, Result>({
    build: async () => { builds++; start(); return new Promise(r => { complete = r; }); },
    commit(e, r) { currentClipping.push(e.data.clip); return { bounds: e.bounds, data: { ...r.data, clip: e.data.clip } }; },
    suspend() {},
  });
  c.upsert({ ...entry('a'), data: { name: 'a', clip: true } }); await begun;
  c.updateMetadata('a', data => ({ ...data, clip: false }));
  complete({ id: 'a', data: { name: 'actual:a', clip: true }, blockers: [] }); await c.whenIdle();
  assert.equal(builds, 1); assert.deepEqual(currentClipping, [false]); assert.equal(c.getCoverage('a')?.data.clip, false);
  c.destroy();
});
