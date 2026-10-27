import assert from 'node:assert/strict';
import test, { before, after, afterEach } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch,
  controls: globalThis.__sceneLibraryCadTest };
let temporary, SceneLibrary, CadLoadRegistry;
const owners = [];

before(async () => {
  const workspace = resolve(process.cwd()), parent = join(workspace, 'tmp/scene-library-cad-lifecycle');
  await mkdir(parent, { recursive: true });
  temporary = await mkdtemp(join(parent, 'case-'));
  await build({ stdin: { contents: 'export { SceneLibrary } from "./src/sceneLibrary.ts"; export { CadLoadRegistry } from "./src/cadLoadRegistry.ts";',
    resolveDir: workspace, loader: 'ts' }, outfile: join(temporary, 'fixture.mjs'), bundle: true, platform: 'node',
    format: 'esm', packages: 'external', loader: { '.css': 'empty' }, plugins: [{ name: 'controllable-cad-work', setup(builder) {
      builder.onResolve({ filter: /\/cadImportWorkerClient$/ }, () => ({ path: 'parse', namespace: 'cad-work' }));
      builder.onResolve({ filter: /\/cadPrimitiveLoader$/ }, () => ({ path: 'geometry', namespace: 'cad-work' }));
      builder.onLoad({ filter: /.*/, namespace: 'cad-work' }, ({ path }) => ({ contents: path === 'parse'
        ? 'export const readCadImportInWorker = (...args) => globalThis.__sceneLibraryCadTest.parse(...args);'
        : 'export const loadCadPrimitiveCollection = (...args) => globalThis.__sceneLibraryCadTest.load(...args);', loader: 'js' }));
    } }] });
  ({ SceneLibrary, CadLoadRegistry } = await import(pathToFileURL(join(temporary, 'fixture.mjs')).href));
});

afterEach(() => {
  for (const owner of owners.splice(0)) {
    if (owner.cameraTimer) clearTimeout(owner.cameraTimer);
    if (owner.updateTimer) clearTimeout(owner.updateTimer);
  }
  for (const [key, value] of Object.entries(original)) {
    const name = key === 'controls' ? '__sceneLibraryCadTest' : key;
    if (value === undefined) Reflect.deleteProperty(globalThis, name); else globalThis[name] = value;
  }
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() {
  const listeners = new Set();
  return { addEventListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    raiseEvent() { for (const listener of listeners) listener(); } };
}
function fixture({ deleteGate, savedView = true, visible = false } = {}) {
  const record = { version: 1, id: 'cad-a', name: 'bridge.dwg', kind: 'CAD', visible,
    createdAt: '2026-10-25', updatedAt: '2026-10-25', files: { data: { name: 'bridge.cadimport', url: '/assets/cad-a.cadimport' } },
    settings: { coordinates: { mode: 'local', longitude: 110, latitude: 30, altitude: 0, referenceX: 0, referenceY: 0, rotation: 0, scale: 1 }, displayMode: 'absolute' } };
  const view = { position: [1, 2, 3], direction: [0, 0, -1], up: [0, 1, 0], basemap: 'satellite' };
  const requests = [], imports = [], children = new Set(), attachedVisibility = [], setViews = [], notifications = [];
  const compile = deferred(), loadStarted = deferred(), deleteStarted = deferred();
  let parseCalls = 0, loadCalls = 0, basemap = 'street';
  const camera = { moveStart: event(), moveEnd: event(), positionWC: { x: 10, y: 20, z: 30 },
    directionWC: { x: 0, y: 0, z: -1 }, upWC: { x: 0, y: 1, z: 0 }, cancelFlight() {},
    setView(options) { setViews.push(options); }, flyToBoundingSphere() {} };
  const scene = { requestRender() {}, primitives: {
    add(value) { attachedVisibility.push(value.show); children.add(value); return value; },
    remove(value) { if (!children.delete(value)) return false; value.destroy(); return true; },
    contains: value => children.has(value), isDestroyed: () => false,
  } };
  globalThis.window = { addEventListener() {}, setTimeout, clearTimeout, confirm: () => true };
  globalThis.document = { querySelector: () => null };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url), method = options.method ?? 'GET'; requests.push({ path, method });
    if (path === '/__library/records') return Response.json({ records: [record], problems: [], ...(savedView ? { view } : {}) });
    if (path === '/assets/cad-a.cadimport') return new Response('saved CAD bytes');
    if (path === '/__library/records/cad-a' && method === 'DELETE') {
      deleteStarted.resolve(); if (deleteGate) await deleteGate.promise; return Response.json({ ok: true });
    }
    if (path === '/__library/view' && method === 'PUT') return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  globalThis.__sceneLibraryCadTest = {
    async parse(_file, _progress, signal) { parseCalls++; signal?.throwIfAborted(); return { source: { name: record.name }, entities: [] }; },
    async load(_value, _coordinates, options) {
      loadCalls++;
      let destroyed = false;
      const collection = { show: true, destroy() { destroyed = true; }, isDestroyed: () => destroyed };
      await options.beforePopulate(collection); loadStarted.resolve({ collection, signal: options.signal });
      await compile.promise; options.signal?.throwIfAborted();
      return { collection, featureCount: 1, skippedCount: 0 };
    },
  };
  const cadLoads = new CadLoadRegistry();
  const owner = new SceneLibrary({ viewer: { scene, camera, useDefaultRenderLoop: true }, cadLoads,
    getImports: () => imports, addImport(name, kind, resource, id, metadata) { imports.push({ id, name, kind, resource, visible: true, ...metadata }); return id; },
    removeImport(item) { scene.primitives.remove(item.resource); imports.splice(imports.indexOf(item), 1); },
    getBasemap: () => basemap, setBasemap: value => { basemap = value; }, notify: message => notifications.push(message), layersChanged() {} });
  owner.render = () => {}; owners.push(owner);
  return { owner, record, view, requests, imports, children, attachedVisibility, camera, cadLoads, compile, loadStarted, deleteStarted, setViews,
    parseCalls: () => parseCalls, loadCalls: () => loadCalls, notifications,
    prepareRestore() { owner.records.set(record.id, record); owner.starting = false; } };
}

test('catalogueReady releases callers before slow CAD restoration while ready still awaits compilation', async () => {
  const f = fixture(); let finished = false;
  const started = f.owner.start().then(() => { finished = true; });
  await f.owner.catalogueReady;
  assert.equal(f.owner.records.has(f.record.id), true); assert.equal(finished, false);
  const { collection } = await f.loadStarted.promise;
  assert.equal(f.loadCalls(), 1); assert.equal(collection.show, false, 'saved-hidden CAD stays hidden while compiling');
  assert.deepEqual(f.attachedVisibility, [false], 'hidden CAD is already hidden when attached to the scene');
  assert.equal(f.imports.length, 0); assert.equal(f.cadLoads.get(f.record.id)?.resource, collection);
  f.compile.resolve(); await started;
  assert.equal(finished, true); assert.equal(f.imports.length, 1); assert.equal(f.cadLoads.get(f.record.id), undefined);
  assert.equal(f.setViews.length, 1, 'untouched startup still restores its saved camera');
});

test('visibility changed while CAD is restoring survives both publication and the final restored record update', async () => {
  const f = fixture({ visible: true }); f.prepareRestore();
  const restoration = f.owner.restore(f.record.id); await f.loadStarted.promise;
  assert.deepEqual(f.attachedVisibility, [true]);
  const load = f.cadLoads.get(f.record.id); load.visible = false;
  f.compile.resolve(); await restoration;
  assert.equal(f.imports.length, 1); assert.equal(f.imports[0].visible, false);
  assert.equal(f.owner.records.get(f.record.id).visible, true, 'the saved default is not mistaken for the current personal display choice');
});

test('two restores of one pending CAD share its ownership without parsing or loading a second copy', async () => {
  const f = fixture(); f.prepareRestore();
  const first = f.owner.restore(f.record.id); await f.loadStarted.promise;
  let secondFinished = false;
  const second = f.owner.restore(f.record.id).then(() => { secondFinished = true; });
  await Promise.resolve(); assert.equal(secondFinished, false);
  assert.equal(f.parseCalls(), 1); assert.equal(f.loadCalls(), 1); assert.equal(f.children.size, 1);
  f.compile.resolve(); await Promise.all([first, second]);
  assert.equal(f.imports.length, 1); assert.equal(f.imports[0].id, f.record.id);
  assert.equal(f.children.size, 1); assert.equal(f.owner.records.size, 1);
});

test('delete locks the CAD ID before cancelling and blocks restore throughout owner cleanup and the DELETE request', async () => {
  const deleteGate = deferred(), f = fixture({ deleteGate }); f.prepareRestore();
  const first = f.owner.restore(f.record.id); const { signal, collection } = await f.loadStarted.promise;
  let lockedAtAbort = false;
  signal.addEventListener('abort', () => { lockedAtAbort = f.owner.deleting.has(f.record.id); });
  let deleted = false;
  const deletion = f.owner.delete(f.record.id, false).then(result => { deleted = result; });
  assert.equal(signal.aborted, true); assert.equal(lockedAtAbort, true); assert.equal(collection.show, false);
  const competing = f.owner.restore(f.record.id);
  await Promise.resolve(); assert.equal(deleted, false);
  assert.equal(f.requests.some(request => request.method === 'DELETE'), false, 'the file cannot be deleted while its owner is still working');
  f.compile.resolve(); await first; await competing; await f.deleteStarted.promise;
  assert.equal(f.cadLoads.get(f.record.id), undefined); assert.equal(f.owner.records.has(f.record.id), true);
  await f.owner.restore(f.record.id);
  assert.equal(f.loadCalls(), 1, 'a retry cannot acquire the ID while DELETE is in flight');
  deleteGate.resolve(); await deletion;
  assert.equal(deleted, true); assert.equal(f.owner.records.has(f.record.id), false);
  assert.equal(f.children.size, 0); assert.equal(f.imports.length, 0); assert.equal(f.owner.deleting.has(f.record.id), false);
});

test('cancelling restoration releases only its pending scene resources and keeps the original saved record for retry', async () => {
  const f = fixture(); f.prepareRestore();
  const restoration = f.owner.restore(f.record.id); const { collection } = await f.loadStarted.promise;
  const load = f.cadLoads.get(f.record.id); load.cancel();
  assert.equal(collection.show, false); assert.equal(f.owner.records.get(f.record.id), f.record);
  f.compile.resolve(); await restoration; await load.settled;
  assert.equal(f.children.size, 0); assert.equal(collection.isDestroyed(), true); assert.equal(f.imports.length, 0);
  assert.equal(f.owner.records.get(f.record.id), f.record);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);
  await f.owner.restore(f.record.id);
  assert.equal(f.loadCalls(), 2); assert.equal(f.imports.length, 1, 'retry publishes exactly one replacement');
});

test('discardNewCad deletes only the specified fresh CAD and leaves other saved records and non-CAD resources intact', async () => {
  const f = fixture(); f.prepareRestore();
  const fresh = { ...f.record, id: 'cad-fresh', name: 'new.dwg' }, model = { ...f.record, id: 'model-existing', kind: 'Model' };
  f.owner.records.set(fresh.id, fresh); f.owner.records.set(model.id, model);
  f.owner.drafts.set(fresh.id, { id: fresh.id }); f.owner.failures.set(fresh.id, 'unfinished'); f.owner.updates.set(fresh.id, { visible: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    if (path === '/__library/records/cad-fresh' && options.method === 'DELETE') {
      f.requests.push({ path, method: options.method }); return Response.json({ ok: true });
    }
    return originalFetch(path, options);
  };
  await f.owner.discardNewCad(fresh.id);
  await f.owner.discardNewCad(model.id);
  assert.equal(f.owner.records.has(fresh.id), false); assert.equal(f.owner.drafts.has(fresh.id), false);
  assert.equal(f.owner.failures.has(fresh.id), false); assert.equal(f.owner.updates.has(fresh.id), false);
  assert.equal(f.owner.records.get(f.record.id), f.record); assert.equal(f.owner.records.get(model.id), model);
  assert.deepEqual(f.requests.filter(request => request.method === 'DELETE'), [{ path: '/__library/records/cad-fresh', method: 'DELETE' }]);
});

test('discardNewCad keeps its saved record and retry information when deletion fails, then retries the same ID', async () => {
  const f = fixture(); f.prepareRestore();
  const fresh = { ...f.record, id: 'cad-fresh' }, draft = { id: 'cad-fresh' }, update = { visible: false };
  f.owner.records.set(fresh.id, fresh); f.owner.drafts.set(fresh.id, draft);
  f.owner.failures.set(fresh.id, 'unfinished'); f.owner.updates.set(fresh.id, update);
  let failDeletion = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    if (path === '/__library/records/cad-fresh' && options.method === 'DELETE') {
      f.requests.push({ path, method: options.method });
      return failDeletion ? Response.json({ error: 'storage unavailable' }, { status: 503 }) : Response.json({ ok: true });
    }
    return originalFetch(path, options);
  };
  await assert.rejects(f.owner.discardNewCad(fresh.id), /storage unavailable/);
  assert.equal(f.owner.records.get(fresh.id), fresh); assert.equal(f.owner.drafts.get(fresh.id), draft);
  assert.equal(f.owner.failures.get(fresh.id), 'unfinished'); assert.equal(f.owner.updates.get(fresh.id), update);
  assert.equal(f.owner.records.get(f.record.id), f.record);
  failDeletion = false; await f.owner.discardNewCad(fresh.id);
  assert.equal(f.owner.records.has(fresh.id), false); assert.equal(f.owner.records.get(f.record.id), f.record);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 2);
});

for (const interaction of ['camera.moveStart', 'markSceneInteraction']) {
  test(`${interaction} during slow startup prevents the old saved view from replacing the user's new camera`, async () => {
    const f = fixture(); const started = f.owner.start();
    await f.owner.catalogueReady; await f.loadStarted.promise;
    f.camera.positionWC = { x: 100, y: 200, z: 300 };
    if (interaction === 'camera.moveStart') f.camera.moveStart.raiseEvent(); else f.owner.markSceneInteraction();
    f.compile.resolve(); await started;
    assert.equal(f.setViews.length, 0); assert.equal(f.imports.length, 1);
    assert.deepEqual(f.owner.lastMapView.position, [100, 200, 300]);
  });
}

test('the delayed initial moveStart at the constructor camera pose does not suppress normal saved-view restoration', async () => {
  const f = fixture(); const started = f.owner.start();
  await f.owner.catalogueReady; await f.loadStarted.promise;
  // main sets its initial camera before constructing SceneLibrary. Cesium emits
  // moveStart for that setView on the next frame, without further pose changes.
  f.camera.moveStart.raiseEvent();
  f.compile.resolve(); await started;
  assert.equal(f.setViews.length, 1); assert.equal(f.imports.length, 1);
});

test('a failed-save draft remains owned and deleting it removes uploaded bytes and cannot be retried as a save', async () => {
  const f = fixture(); f.owner.starting = false;
  f.owner.drafts.set(f.record.id, { id: f.record.id, name: f.record.name, kind: 'CAD', settings: {}, files: {} });
  assert.equal(f.owner.owns(f.record.id), true);
  assert.equal(await f.owner.delete(f.record.id, false), true);
  assert.equal(f.owner.owns(f.record.id), false);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  await assert.rejects(f.owner.save(f.record.id, 'old draft', 'CAD', {}), /已删除/);
});

test('an older catalogue response cannot resurrect a video scheme deleted while the refresh was in flight', async () => {
  const f = fixture(), gate = deferred(); f.owner.starting = false;
  const video = { ...f.record, kind: 'Drone Video', settings: { video: { mode: 'cc-overlay' } } };
  f.owner.records.set(video.id, video);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/__library/records') { await gate.promise; return Response.json({ records: [video], problems: [] }); }
    return originalFetch(url, options);
  };
  const refresh = f.owner.refreshVideoOverlaySchemes();
  assert.equal(await f.owner.delete(video.id, false), true);
  gate.resolve(); await refresh;
  assert.equal(f.owner.records.has(video.id), false);
  assert.deepEqual(f.owner.listVideoOverlaySchemes(), []);
});

test('committed deletion with failed file cleanup removes the scene, blocks restore, and retains only cleanup retry', async () => {
  const f = fixture(); f.prepareRestore(); f.owner.updates.set(f.record.id, { visible: true });
  let fail = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/__library/records/cad-a' && options?.method === 'DELETE' && fail) {
      return Response.json({ error: 'file busy', code: 'FILE_DELETE_PENDING', deleted: true }, { status: 503 });
    }
    return originalFetch(url, options);
  };
  assert.equal(await f.owner.delete(f.record.id, false), false);
  assert.equal(f.owner.records.has(f.record.id), false);
  assert.equal(f.owner.updates.has(f.record.id), false);
  assert.equal(f.owner.cleanupPending.has(f.record.id), true);
  await f.owner.restore(f.record.id); assert.equal(f.loadCalls(), 0);
  assert.match(f.notifications.at(-1), /文件清理待完成/);
  fail = false;
  assert.equal(await f.owner.delete(f.record.id, false), true);
  assert.equal(f.owner.owns(f.record.id), false);
});

test('deleting the selected imagery disposes its loaded layer and switches away from the deleted source', async () => {
  const f = fixture(); f.prepareRestore();
  f.owner.records.set(f.record.id, { ...f.record, kind: 'Imagery' });
  f.owner.activeImageryId = f.record.id;
  let cleared = 0;
  f.owner.hooks.clearImagery = () => { cleared++; };
  assert.equal(await f.owner.delete(f.record.id, false), true);
  assert.equal(cleared, 1);
  assert.equal(f.owner.activeImageryRecordId, '');
  assert.equal(f.owner.hooks.getBasemap(), 'street');
});

test('pending deletion cleanup is restored as a retry item, never as a scene import', async () => {
  const f = fixture();
  globalThis.fetch = async () => Response.json({ records: [], problems: [{ id: 'old-model', name: 'bridge.skp', kind: 'Model', deleted: true, error: 'file busy' }] });
  await f.owner.start();
  assert.equal(f.owner.owns('old-model'), true);
  assert.equal(f.owner.records.has('old-model'), false);
  assert.deepEqual(f.owner.cleanupPending.get('old-model'), { name: 'bridge.skp', kind: 'Model' });
  assert.equal(f.imports.length, 0);
});

test('a late video dependency read cannot put a deleted model back into the catalogue', async () => {
  const f = fixture(), gate = deferred(); f.prepareRestore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/__library/records/cad-a' && (!options?.method || options.method === 'GET')) { await gate.promise; return Response.json(f.record); }
    return originalFetch(url, options);
  };
  const read = f.owner.readableRecord(f.record.id);
  const rejection = assert.rejects(read, /已删除/);
  assert.equal(await f.owner.delete(f.record.id, false), true);
  gate.resolve(); await rejection;
  assert.equal(f.owner.records.has(f.record.id), false);
  assert.equal(f.owner.owns(f.record.id), false);
});

test('interrupted CAD rollback with a committed tombstone offers cleanup only, without waiting for its own loader', async () => {
  const f = fixture(); f.prepareRestore();
  globalThis.fetch = async () => Response.json({ error: 'busy', code: 'FILE_DELETE_PENDING', deleted: true }, { status: 503 });
  await assert.rejects(f.owner.discardNewCad(f.record.id), /busy/);
  assert.equal(f.owner.records.has(f.record.id), false);
  assert.equal(f.owner.cleanupPending.has(f.record.id), true);
  await f.owner.restore(f.record.id); assert.equal(f.loadCalls(), 0);
});

test('startup reconciles already deleted video caches and exposes failed cleanup without restoring a video', async () => {
  const f = fixture();
  let seen;
  f.owner.hooks.reconcileDeletedVideoCaches = async ids => { seen = ids; return [{ id: 'old-video', error: 'cache occupied' }]; };
  globalThis.fetch = async () => Response.json({ records: [], problems: [], deletedVideoIds: ['old-video'] });
  await f.owner.start();
  assert.deepEqual(seen, ['old-video']);
  assert.equal(f.owner.records.size, 0);
  assert.equal(f.owner.cleanupPending.get('old-video').kind, 'Drone Video');
  assert.match(f.owner.error, /cache occupied/);
});
