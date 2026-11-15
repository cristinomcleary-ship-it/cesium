import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Cartesian3, Matrix4 } from 'cesium';
import { SceneLibrary } from '../src/sceneLibrary.ts';
import { createPhotogrammetryTransform, photogrammetryMatrix } from '../src/photogrammetryTransform.ts';
import { createProjectLibrary } from '../server/projectLibrary.ts';

const originals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const owners = [];
afterEach(() => {
  for (const owner of owners.splice(0)) { clearTimeout(owner.cameraTimer); clearTimeout(owner.updateTimer); }
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key); else globalThis[key] = value;
  }
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transform() {
  const editor = createPhotogrammetryTransform(Matrix4.IDENTITY, Cartesian3.fromDegrees(113, 23, 18));
  Object.assign(editor, { east: 12.5, north: -8, up: 4, heading: 26 });
  return { editor, matrix: Matrix4.toArray(photogrammetryMatrix(editor)) };
}
function fixture() {
  const state = { context: 'project/actor', photoContext: 'project/actor/edit-1', readable: true, editable: true,
    imports: [], requests: [], server: new Map(), events: new Map(), respond: undefined };
  globalThis.window = { addEventListener: (name, fn) => state.events.set(name, fn), setTimeout, clearTimeout, confirm: () => true };
  globalThis.document = { querySelector: () => null };
  const camera = { positionWC: new Cartesian3(1, 2, 3), directionWC: new Cartesian3(1, 0, 0), upWC: new Cartesian3(0, 0, 1),
    moveStart: { addEventListener() {} }, moveEnd: { addEventListener() {} } };
  const library = new SceneLibrary({ viewer: { camera, scene: { requestRender() {} } },
    cadLoads: { get() {}, values: () => [] }, getImports: () => state.imports,
    getContextKey: () => state.context, getPhotogrammetryContextKey: () => state.photoContext,
    canReadRecord: () => state.readable, canEditPhotogrammetry: () => state.editable,
    removeImport: item => state.imports.splice(state.imports.indexOf(item), 1),
    layersChanged() {}, notify() {}, getBasemap: () => 'street', clearVideo() {},
  });
  library.starting = false; library.render = () => {}; owners.push(library);
  const add = (id, kind = '3D Tiles') => {
    const record = { version: 1, id, kind, name: id, visible: true, files: {},
      createdAt: '2026-11-15', updatedAt: '2026-11-15', settings: { matrix: Matrix4.toArray(Matrix4.IDENTITY), quality: 'original' } };
    const resource = { modelMatrix: Matrix4.clone(Matrix4.IDENTITY), destroyed: false, isDestroyed() { return this.destroyed; } };
    state.imports.push({ id, name: id, kind, resource });
    library.records.set(id, record); state.server.set(id, structuredClone(record));
    return { record, resource };
  };
  state.apply = (id, patch) => {
    const old = state.server.get(id);
    const saved = { ...old, ...patch, settings: { ...old.settings, ...patch.settings }, updatedAt: '2026-11-15T12:00:00Z' };
    state.server.set(id, saved); return saved;
  };
  globalThis.fetch = async (url, init = {}) => {
    const request = { path: String(url), method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
    state.requests.push(request);
    const intercepted = await state.respond?.(request);
    if (intercepted !== undefined) return intercepted;
    const id = decodeURIComponent(request.path.slice('/__library/records/'.length));
    if (request.method === 'DELETE') { state.server.delete(id); return Response.json({ ok: true }); }
    if (request.method === 'PATCH') return Response.json(state.apply(id, request.body));
    const record = state.server.get(id);
    return record ? Response.json(record) : Response.json({ error: 'missing' }, { status: 404 });
  };
  return { state, library, add, ...add('photo') };
}

test('photography save is awaited, atomic, input-isolated and does not lock other records', async () => {
  const { state, library, record, add } = fixture();
  const next = transform(), expected = structuredClone(next), gate = deferred(), started = deferred();
  add('other', 'Model');
  state.respond = async request => {
    if (request.method === 'PATCH') { started.resolve(); await gate.promise; }
  };
  let done = false;
  const saving = library.commitPhotogrammetryTransform('photo', next.matrix, next.editor).then(() => { done = true; });
  await started.promise;
  assert.equal(done, false); assert.equal(library.records.get('photo'), record);
  assert.equal(await library.unload('photo'), false);
  assert.equal(await library.delete('photo', false), false);
  await assert.rejects(library.commitPhotogrammetryTransform('photo', expected.matrix, expected.editor), /正在保存/);
  assert.equal(await library.delete('other', false), true, 'unrelated record operations remain available');
  const beforeUnload = { prevented: false, preventDefault() { this.prevented = true; } };
  state.events.get('beforeunload')(beforeUnload); assert.equal(beforeUnload.prevented, true);
  next.matrix[12] = 999; next.editor.originalMatrix[0] = 999; next.editor.east = 999;
  gate.resolve(); await saving;
  const saved = library.records.get('photo');
  assert.deepEqual(saved.settings.matrix, expected.matrix);
  assert.deepEqual(saved.settings.photogrammetryEditor, expected.editor);
  assert.equal(saved.settings.quality, 'original');
  assert.equal(library.photogrammetryCommits.size, 0);
  assert.equal(state.requests.filter(request => request.method === 'PATCH').length, 1);
  assert.ok(state.requests[0].signal instanceof AbortSignal);
});

test('earlier queue writes settle before transform and later visibility cannot overwrite it', async () => {
  const { state, library } = fixture(); const next = transform(), gate = deferred(), started = deferred();
  library.updates.set('photo', { settings: { quality: 'high' } });
  state.respond = async request => {
    if (request.body?.settings?.photogrammetryEditor) { started.resolve(); await gate.promise; }
  };
  const saving = library.commitPhotogrammetryTransform('photo', next.matrix, next.editor);
  await started.promise;
  assert.equal(state.requests.length, 2); assert.deepEqual(state.requests[0].body, { settings: { quality: 'high' } });
  library.queueUpdate('photo', { visible: false });
  const later = library.flush();
  gate.resolve(); await saving; await later;
  assert.equal(state.requests.length, 3);
  assert.equal(library.records.get('photo').visible, false);
  assert.equal(library.records.get('photo').settings.quality, 'high');
  assert.deepEqual(library.records.get('photo').settings.matrix, next.matrix);
  assert.deepEqual(library.records.get('photo').settings.photogrammetryEditor, next.editor);
});

test('failed target queue prevents explicit save; an unrelated failed queue does not', async () => {
  for (const failedId of ['photo', 'other']) {
    const { state, library, add } = fixture(); add('other'); const next = transform();
    library.updates.set(failedId, { visible: false });
    state.respond = request => request.path.endsWith('/' + failedId) && request.body?.visible === false
      ? Response.json({ error: 'old update failed' }, { status: 503 }) : undefined;
    const saving = library.commitPhotogrammetryTransform('photo', next.matrix, next.editor);
    if (failedId === 'photo') {
      await assert.rejects(saving, /old update failed/);
      assert.equal(state.requests.length, 1);
      assert.equal(library.records.get('photo').settings.photogrammetryEditor, undefined);
    } else {
      await saving;
      assert.deepEqual(library.records.get('photo').settings.matrix, next.matrix);
    }
    assert.deepEqual(library.updates.get(failedId), { visible: false, settings: {} });
  }
});

test('failed explicit save never enters background retry; explicit retry can succeed', async () => {
  const { state, library, record } = fixture(); const next = transform();
  state.respond = request => request.method === 'PATCH' ? Response.json({ error: 'storage offline' }, { status: 503 }) : undefined;
  await assert.rejects(library.commitPhotogrammetryTransform('photo', next.matrix, next.editor), /保存未确认/);
  assert.equal(library.records.get('photo'), record); assert.equal(library.updates.size, 0);
  assert.deepEqual(state.requests.map(request => request.method), ['PATCH', 'GET']);
  await library.flush(); assert.equal(state.requests.length, 2, 'cancel/flush cannot silently replay the failed transform');
  state.respond = undefined;
  await library.commitPhotogrammetryTransform('photo', next.matrix, next.editor);
  assert.deepEqual(library.records.get('photo').settings.matrix, next.matrix);
  assert.equal(library.failures.has('photo'), false);
});

test('a lost response is confirmed by one readback, with no duplicate PATCH', async () => {
  const { state, library } = fixture(); const next = transform();
  state.respond = request => {
    if (request.method === 'PATCH') { state.apply('photo', request.body); throw new TypeError('connection lost after commit'); }
  };
  await library.commitPhotogrammetryTransform('photo', next.matrix, next.editor);
  assert.deepEqual(state.requests.map(request => request.method), ['PATCH', 'GET']);
  assert.deepEqual(library.records.get('photo').settings.photogrammetryEditor, next.editor);
  assert.ok(state.requests.every(request => request.signal instanceof AbortSignal));
});

test('a stalled PATCH times out, verifies once and releases the per-record save lock', async t => {
  const { state, library, record } = fixture(); const next = transform();
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 15_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 5);
    return controller.signal;
  });
  state.respond = request => request.method === 'PATCH' ? new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }) : undefined;
  await assert.rejects(library.commitPhotogrammetryTransform('photo', next.matrix, next.editor), /保存未确认/);
  assert.deepEqual(state.requests.map(request => request.method), ['PATCH', 'GET']);
  assert.equal(library.records.get('photo'), record);
  assert.equal(library.photogrammetryCommits.size, 0);
  assert.equal(library.updates.size, 0);
});

test('readback must match editor metadata as well as matrix; unauthorized PATCH is final', async () => {
  for (const status of [403, 503]) {
    const { state, library, record } = fixture(); const next = transform();
    state.respond = request => {
      if (request.method !== 'PATCH') return;
      if (status === 503) {
        const saved = state.apply('photo', request.body);
        saved.settings.photogrammetryEditor = createPhotogrammetryTransform(Matrix4.fromArray(next.matrix), Cartesian3.fromDegrees(113, 23));
      }
      return Response.json({ error: 'rejected' }, { status });
    };
    await assert.rejects(library.commitPhotogrammetryTransform('photo', next.matrix, next.editor), status === 403 ? /rejected/ : /保存未确认/);
    assert.equal(library.records.get('photo'), record); assert.equal(library.updates.size, 0);
    assert.deepEqual(state.requests.map(request => request.method), status === 403 ? ['PATCH'] : ['PATCH', 'GET']);
  }
});

test('invalid transforms, absent edit grants and non-tiles records never dispatch a write', async () => {
  for (const reason of ['matrix', 'metadata', 'missing grant', 'denied read', 'wrong kind']) {
    const { state, library, record } = fixture(); const next = transform();
    if (reason === 'matrix') next.matrix[0] = NaN;
    if (reason === 'metadata') next.editor.east++;
    if (reason === 'missing grant') library.hooks.canEditPhotogrammetry = undefined;
    if (reason === 'denied read') state.readable = false;
    if (reason === 'wrong kind') record.kind = 'Model';
    await assert.rejects(library.commitPhotogrammetryTransform('photo', next.matrix, next.editor));
    assert.equal(state.requests.length, 0, reason);
    assert.equal(library.photogrammetryCommits.size, 0);
  }
});

test('edit grant generation changes while waiting prevent write without affecting restore context', async () => {
  const { state, library } = fixture(); const next = transform(), gate = deferred();
  library.flushTail = gate.promise;
  const saving = library.commitPhotogrammetryTransform('photo', next.matrix, next.editor);
  const rejected = assert.rejects(saving, /编辑权限已变化/);
  state.editable = false; state.photoContext = 'project/actor/edit-2';
  state.editable = true; state.photoContext = 'project/actor/edit-3';
  gate.resolve(); await rejected;
  assert.equal(state.context, 'project/actor'); assert.equal(state.requests.length, 0);
});

test('late responses cannot repopulate changed contexts, revoked access, replaced or removed resources', async () => {
  for (const reason of ['context', 'access', 'replacement', 'destroyed', 'deleted', 'unloading']) {
    const { state, library, record, resource } = fixture(); const next = transform(), gate = deferred(), started = deferred();
    state.respond = async request => { if (request.method === 'PATCH') { started.resolve(); await gate.promise; } };
    const saving = library.commitPhotogrammetryTransform('photo', next.matrix, next.editor);
    const rejected = assert.rejects(saving);
    await started.promise;
    if (reason === 'context') state.photoContext = 'other-project/actor';
    if (reason === 'access') state.editable = false;
    if (reason === 'replacement') state.imports[0].resource = { isDestroyed: () => false };
    if (reason === 'destroyed') resource.destroyed = true;
    if (reason === 'deleted') { library.deleted.add('photo'); library.records.delete('photo'); }
    if (reason === 'unloading') library.unloading.add('photo');
    gate.resolve(); await rejected;
    assert.equal(library.records.get('photo'), reason === 'deleted' ? undefined : record, reason);
    assert.equal(library.failures.has('photo'), false, 'stale errors must not attach to another context');
    assert.equal(library.photogrammetryCommits.size, 0);
    assert.deepEqual(state.requests.map(request => request.method), ['PATCH']);
  }
});

test('real HTTP persistence survives service restart and preserves imported bytes and unrelated settings', async () => {
  const { library } = fixture(); const next = transform();
  const parent = join(process.cwd(), 'tmp/photogrammetry-persistence'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  let service = createProjectLibrary(directory);
  const server = createServer((req, res) => { void service.middleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, init) => originals.fetch(new URL(String(url), origin), init);
  const call = async (path, method = 'GET', value) => {
    const response = await originals.fetch(origin + '/__library' + path, { method, headers: { 'X-Cesium-Library': '1',
      'Content-Type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json' },
      body: value === undefined ? undefined : Buffer.isBuffer(value) ? value : JSON.stringify(value) });
    assert.equal(response.ok, true); return response.json();
  };
  try {
    const bytes = Buffer.from('fixture model bytes, not user project data\n');
    const file = await call('/records/photo/files/data?name=tileset.json', 'POST', bytes);
    const record = await call('/records/photo', 'PUT', { ...library.records.get('photo'), files: { data: file },
      settings: { quality: 'original', tiles: { longitudeOffset: 0.01, latitudeOffset: -0.01, heightOffset: 6 },
        matrix: Matrix4.toArray(Matrix4.IDENTITY) } });
    library.records.set('photo', record);
    await library.commitPhotogrammetryTransform('photo', next.matrix, next.editor);
    service = createProjectLibrary(directory);
    const reloaded = await call('/records/photo');
    assert.deepEqual(reloaded.settings.matrix, next.matrix);
    assert.deepEqual(reloaded.settings.photogrammetryEditor, next.editor);
    assert.deepEqual(reloaded.settings.tiles, record.settings.tiles);
    assert.deepEqual(reloaded.files, record.files);
    assert.equal(reloaded.visible, record.visible);
    const response = await originals.fetch(origin + file.url);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const disk = JSON.parse(await readFile(join(directory, 'project-data/records/photo/record.json'), 'utf8'));
    assert.deepEqual(disk.settings.photogrammetryEditor, next.editor);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
