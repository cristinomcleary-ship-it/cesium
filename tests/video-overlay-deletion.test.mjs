import assert from 'node:assert/strict';
import test, { before, after, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
let directory, VideoModelOverlay, VideoOverlayCacheStore, VideoOverlayLifecycle, originalOpen;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
before(async () => {
  directory = await mkdtemp(`${process.cwd()}/.video-delete-test-`);
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts"; export { VideoOverlayCacheStore } from "./src/videoOverlayCacheStore.ts"; export { VideoOverlayLifecycle } from "./src/videoOverlayLifecycle.ts";', resolveDir: process.cwd(), loader: 'ts' }, outfile: `${directory}/test.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  ({ VideoModelOverlay, VideoOverlayCacheStore, VideoOverlayLifecycle } = await import(pathToFileURL(`${directory}/test.mjs`).href));
  originalOpen = VideoOverlayCacheStore.open;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory() {} } } });
});
afterEach(() => { VideoOverlayCacheStore.open = originalOpen; });
after(async () => { await rm(directory, { recursive: true, force: true }); if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator; });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function owner(id) { return Object.assign(Object.create(VideoModelOverlay.prototype), { savedId: id, cacheSchemeLifecycles: new Map(), clear() { this.savedId = undefined; } }); }

test('deleting old scheme waits for its publishing writer after another scheme became current', async () => {
  const o = owner('B'), old = new VideoOverlayLifecycle(), writer = deferred(), calls = [];
  o.cacheSchemeLifecycles.set('A', new Set([old]));
  const task = old.run('publishing A', async () => { await writer.promise; calls.push('A published'); });
  await Promise.resolve();
  VideoOverlayCacheStore.open = async () => ({ async removeScheme(id) { calls.push('remove '+id); } });
  const removal = o.removeSavedCache('A'); await Promise.resolve();
  assert.equal(old.signal.aborted, true); assert.deepEqual(calls, []); assert.equal(o.savedId, 'B');
  writer.resolve(); await task; await removal;
  assert.deepEqual(calls, ['A published', 'remove A']);
});

test('deleting old scheme does not abort an unrelated unsaved cache task', async () => {
  const o = owner(undefined), unrelated = new VideoOverlayLifecycle(), calls = [];
  o.cacheLifecycle = unrelated;
  VideoOverlayCacheStore.open = async () => ({ async removeScheme(id) { calls.push(id); } });
  await o.removeSavedCache('A');
  assert.equal(unrelated.signal.aborted, false); assert.deepEqual(calls, ['A']);
});

test('restart reconciliation only removes existing cache of confirmed deleted schemes and reports retryable failures', async () => {
  const o = owner('B'), calls = [];
  VideoOverlayCacheStore.open = async () => ({ async getSchemeIds() { return ['A', 'B', 'C']; }, async removeScheme(id) { calls.push(id); if (id === 'C') throw new Error('file occupied'); } });
  const result = await o.reconcileDeletedCaches(['A', 'C', 'missing']);
  assert.deepEqual(calls, ['A', 'C']); assert.deepEqual(result, [{ id: 'C', error: 'file occupied' }]); assert.equal(o.savedId, 'B');
});
