import assert from 'node:assert/strict';
import test, { before, after, afterEach } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Exercise the real frontend delete transaction against the real HTTP middleware.
// Every byte written by this test belongs to its own isolated output directory.
const workspace = resolve(process.cwd());
const originals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const kinds = ['Model', '3D Tiles', 'CAD', 'GIS', 'Imagery', 'Drone Video'];
const evidence = [];
const owners = [];
let directory, createProjectLibrary, SceneLibrary;

before(async () => {
  const parent = join(workspace, 'output/resource-removal-20261110');
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(join(parent, 'library-persistence-'));
  await build({ stdin: { contents: 'export { createProjectLibrary } from "./server/projectLibrary.ts"; export { SceneLibrary } from "./src/sceneLibrary.ts";',
    resolveDir: workspace, loader: 'ts' }, outfile: join(directory, 'fixture.mjs'), bundle: true,
    platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  ({ createProjectLibrary, SceneLibrary } = await import(pathToFileURL(join(directory, 'fixture.mjs')).href));
});

afterEach(() => {
  for (const owner of owners.splice(0)) {
    if (owner.cameraTimer) clearTimeout(owner.cameraTimer);
    if (owner.updateTimer) clearTimeout(owner.updateTimer);
  }
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key); else globalThis[key] = value;
  }
});

after(async () => {
  if (directory) await writeFile(join(directory, 'results.json'), JSON.stringify({ isolatedRoot: directory, results: evidence }, null, 2));
});

function event() { return { addEventListener() { return () => {}; } }; }

async function fixture(label) {
  const root = join(directory, label);
  let library = createProjectLibrary(root);
  let failDelete = false;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (failDelete && req.method === 'DELETE') {
      res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'fixture storage unavailable' })); return;
    }
    void library.middleware(req, res, () => { res.statusCode = 404; res.end(); });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, init) => originals.fetch(new URL(String(url), origin), init);
  globalThis.window = { addEventListener() {}, setTimeout, clearTimeout, confirm: () => true };
  globalThis.document = { querySelector: () => null };
  const call = async (path, method = 'GET', data) => {
    const response = await originals.fetch(origin + '/__library' + path, {
      method, headers: { 'X-Cesium-Library': '1', ...(Buffer.isBuffer(data) ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : Buffer.isBuffer(data) ? data : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  return { root, origin, requests, call,
    restart() { library = createProjectLibrary(root); },
    failDeletion(value) { failDelete = value; },
    async close() { server.closeAllConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); },
  };
}

async function createRecord(fixture, id, kind) {
  const bytes = Buffer.from(`original ${kind} ${id}\n\0\u00ff`, 'utf8');
  await mkdir(join(fixture.root, 'originals'), { recursive: true });
  const originalPath = join(fixture.root, 'originals', id + '.bin');
  await writeFile(originalPath, bytes);
  const upload = await fixture.call(`/records/${id}/files/source?name=${id}.bin`, 'POST', bytes);
  assert.equal(upload.status, 200);
  const saved = await fixture.call(`/records/${id}`, 'PUT', {
    version: 1, id, name: `${kind} ${id}`, kind, visible: true, settings: {}, files: { source: upload.body },
  });
  assert.equal(saved.status, 200);
  return { record: saved.body, bytes, originalPath };
}

function scene(records) {
  const imports = records.filter(record => !['Imagery', 'Drone Video'].includes(record.kind)).map(record => ({ id: record.id, name: record.name, kind: record.kind, visible: record.visible }));
  const detached = [], videoCaches = [], notifications = [];
  let imageryCleared = 0, videoCleared = 0, basemap = 'local';
  const camera = { moveStart: event(), moveEnd: event(), positionWC: { x: 1, y: 2, z: 3 }, directionWC: { x: 1, y: 0, z: 0 }, upWC: { x: 0, y: 0, z: 1 } };
  const owner = new SceneLibrary({
    viewer: { camera, scene: { requestRender() {} } }, getImports: () => imports,
    removeImport(item) { detached.push(item.id); imports.splice(imports.indexOf(item), 1); },
    clearVideo() { videoCleared++; }, clearImagery() { imageryCleared++; },
    removeVideoCache: async id => { videoCaches.push(id); },
    getBasemap: () => basemap, setBasemap(value) { basemap = value; }, layersChanged() {},
    notify(message, error) { notifications.push({ message, error }); },
  });
  owner.render = () => {};
  owner.starting = false;
  for (const record of records) owner.records.set(record.id, structuredClone(record));
  if (records[0].kind === 'Imagery') owner.activeImageryId = records[0].id;
  if (records[0].kind === 'Drone Video') owner.activeVideoId = records[0].id;
  owners.push(owner);
  return { owner, imports, detached, videoCaches, notifications,
    get imageryCleared() { return imageryCleared; }, get videoCleared() { return videoCleared; } };
}

for (const kind of kinds) {
  test(`${kind}: delete commits over real HTTP and survives fresh service while originals and sibling remain byte-for-byte intact`, async () => {
    const f = await fixture(kind.replaceAll(' ', '-'));
    try {
      const target = await createRecord(f, 'target', kind), survivor = await createRecord(f, 'survivor', kind);
      const survivorPath = join(f.root, 'project-data/records/survivor/record.json');
      const survivorMetadata = await readFile(survivorPath);
      const s = scene([target.record, survivor.record]);
      s.owner.queueUpdate('target', { visible: false, settings: { scale: 2 } });
      assert.equal(await s.owner.delete('target'), true);
      assert.equal(s.owner.records.has('target'), false);
      assert.equal(s.owner.records.has('survivor'), true);
      assert.equal(s.owner.updates.has('target'), false, 'pending transform cannot recreate a deleted record');
      assert.equal(s.imports.some(item => item.id === 'target'), false);
      if (kind === 'Imagery') { assert.equal(s.imageryCleared, 1); assert.equal(s.owner.activeImageryRecordId, ''); }
      else if (kind === 'Drone Video') { assert.equal(s.videoCleared, 1); assert.deepEqual(s.videoCaches, ['target']); assert.equal(s.owner.activeVideoRecordId, ''); }
      else assert.deepEqual(s.detached, ['target']);

      f.restart();
      const listing = await f.call('/records');
      assert.equal(listing.status, 200); assert.deepEqual(listing.body.records.map(record => record.id), ['survivor']);
      assert.deepEqual(listing.body.problems, []);
      assert.deepEqual(listing.body.deletedVideoIds, kind === 'Drone Video' ? ['target'] : []);
      const marker = JSON.parse(await readFile(join(f.root, 'project-data/deleted/target.json'), 'utf8'));
      assert.equal(marker.kind, kind); assert.ok(marker.cleanedAt);
      await assert.rejects(stat(join(f.root, 'project-data/records/target')), { code: 'ENOENT' });
      assert.equal((await f.call('/records/target')).status, 410);
      assert.equal((await f.call('/records/target', 'PATCH', { visible: true })).status, 410);
      assert.equal((await f.call('/records/target', 'PUT', target.record)).status, 410);
      assert.equal((await f.call('/records/target/files/source?name=old.bin', 'POST', target.bytes)).status, 410);
      assert.deepEqual(await readFile(target.originalPath), target.bytes);
      assert.deepEqual(await readFile(survivor.originalPath), survivor.bytes);
      assert.deepEqual(await readFile(survivorPath), survivorMetadata);
      const survivorFile = await originals.fetch(f.origin + survivor.record.files.source.url);
      assert.equal(survivorFile.status, 200); assert.deepEqual(Buffer.from(await survivorFile.arrayBuffer()), survivor.bytes);
      evidence.push({ kind, result: 'passed', persistence: 'absent after fresh middleware instance', staleWrites: 'GET/PUT/PATCH/upload rejected with HTTP 410', originalAndSiblingBytes: 'unchanged' });
    } finally { await f.close(); }
  });
}

test('cancel and failed HTTP deletion retain displayed and stored resources; retry deletes only the intended record', async () => {
  const f = await fixture('cancel-and-failure');
  try {
    const target = await createRecord(f, 'target', 'Model'), survivor = await createRecord(f, 'survivor', 'Model');
    const s = scene([target.record, survivor.record]);
    globalThis.window.confirm = () => false;
    const callsBefore = f.requests.length;
    assert.equal(await s.owner.delete('target'), false);
    assert.equal(f.requests.length, callsBefore); assert.equal(s.owner.records.has('target'), true); assert.deepEqual(s.detached, []);
    globalThis.window.confirm = () => true;
    f.failDeletion(true);
    assert.equal(await s.owner.delete('target'), false);
    assert.equal(s.owner.records.has('target'), true); assert.deepEqual(s.detached, []);
    assert.equal(s.notifications.at(-1).error, true);
    f.restart(); assert.deepEqual((await f.call('/records')).body.records.map(record => record.id), ['target', 'survivor']);
    f.failDeletion(false);
    assert.equal(await s.owner.delete('target'), true);
    f.restart(); assert.deepEqual((await f.call('/records')).body.records.map(record => record.id), ['survivor']);
    evidence.push({ scenario: 'cancel, HTTP failure, retry', result: 'passed' });
  } finally { await f.close(); }
});
