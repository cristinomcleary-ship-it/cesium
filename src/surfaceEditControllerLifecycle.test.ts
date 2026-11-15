import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let directory: string, Controller: { prototype: object };
before(async () => {
  directory = await mkdtemp(join(process.cwd(), '.surface-controller-lifecycle-'));
  const output = join(directory, 'controller.mjs');
  await build({ entryPoints: ['src/surfaceEditController.ts'], outfile: output, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  Controller = (await import(pathToFileURL(output).href)).SurfaceEditController;
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function fixture() {
  const events: unknown[] = [];
  const owner = Object.assign(Object.create(Controller.prototype), {
    disposed: false, suspensions: 0,
    scene: { setSuspended(value: boolean) { events.push(value); } },
    cancel() { events.push('cancel'); }, refreshTargets() { events.push('refresh'); },
  });
  return { owner, events };
}

test('failed first surface suspension rolls back both its count and scene state', () => {
  const { owner, events } = fixture(), failure = new Error('scene transition failed');
  let fail = true;
  owner.scene.setSuspended = (value: boolean) => { events.push(value); if (value && fail) { fail = false; throw failure; } };
  assert.throws(() => owner.suspendExternalSceneEffects(), error => error === failure);
  assert.equal(owner.suspensions, 0); assert.deepEqual(events, ['cancel', true, false]);
  const release = owner.suspendExternalSceneEffects(); release(); release();
  assert.equal(owner.suspensions, 0); assert.deepEqual(events.slice(3), ['cancel', true, false, 'refresh']);
});

test('failed nested suspension preserves the earlier owner until its release', () => {
  const { owner, events } = fixture();
  const first = owner.suspendExternalSceneEffects();
  let fail = true;
  owner.scene.setSuspended = (value: boolean) => { events.push(value); if (fail) { fail = false; throw new Error('nested failed'); } };
  assert.throws(() => owner.suspendExternalSceneEffects(), /nested failed/);
  assert.equal(owner.suspensions, 1); assert.equal(events.at(-1), true);
  first(); assert.equal(owner.suspensions, 0); assert.deepEqual(events.slice(-2), [false, 'refresh']);
});

test('surface rollback failures are reported, and counts still allow a later acquisition', () => {
  const { owner } = fixture();
  owner.scene.setSuspended = () => { throw new Error('scene unavailable'); };
  assert.throws(() => owner.suspendExternalSceneEffects(), error => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(owner.suspensions, 0);
  owner.scene.setSuspended = () => {};
  owner.suspendExternalSceneEffects()(); assert.equal(owner.suspensions, 0);
});

test('last surface release refreshes current targets even if one scene setter fails', () => {
  const { owner, events } = fixture();
  const release = owner.suspendExternalSceneEffects();
  owner.scene.setSuspended = () => { throw new Error('restore failed'); };
  assert.throws(release, AggregateError); assert.equal(owner.suspensions, 0); assert.equal(events.at(-1), 'refresh');
  assert.doesNotThrow(release);
});

test('disposed surface owners do not cancel or touch released scene resources', () => {
  const { owner, events } = fixture();
  const release = owner.suspendExternalSceneEffects();
  owner.disposed = true; release(); owner.suspendExternalSceneEffects()();
  assert.deepEqual(events, ['cancel', true]); assert.equal(owner.suspensions, 0);
});

test('controller disposal continues through independent cancellation, handle and scene failures', () => {
  const { owner, events } = fixture();
  Object.assign(owner, {
    revision: 0,
    cancel() { events.push('cancel'); throw new Error('drawing failed'); },
    handles: new Map([
      ['first', { destroy() { events.push('first'); throw new Error('handle failed'); } }],
      ['second', { destroy() { events.push('second'); } }],
    ]),
    scene: { destroy() { events.push('scene'); throw new Error('scene failed'); } },
    panel: { destroy() { events.push('panel'); } }, drawing: {},
    options: { viewer: { isDestroyed: () => false, dataSources: { remove() { events.push('drawing'); } } } },
  });
  assert.throws(() => owner.destroy(), error => error instanceof AggregateError && error.errors.length === 3);
  assert.deepEqual(events, ['cancel', 'first', 'second', 'scene', 'panel', 'drawing']);
  assert.equal(owner.handles.size, 0); assert.equal(owner.disposed, true);
  owner.destroy(); assert.equal(events.length, 6);
});

test('drawing teardown releases handlers, keyboard, nested lease and entities independently', () => {
  const { owner, events } = fixture(), previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { removeEventListener() { events.push('keyboard'); } } });
  Object.assign(owner, {
    drawHandler: { destroy() { events.push('handler'); throw new Error('handler failed'); } },
    drawKey() {}, drawCleanup() { events.push('lease'); throw new Error('lease failed'); },
    drawing: { entities: { removeAll() { events.push('entities'); } } },
  });
  try {
    assert.throws(() => owner.endDrawing(), error => error instanceof AggregateError && error.errors.length === 2);
    assert.deepEqual(events, ['handler', 'keyboard', 'lease', 'entities']);
    owner.endDrawing(); assert.deepEqual(events, ['handler', 'keyboard', 'lease', 'entities', 'entities']);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});
