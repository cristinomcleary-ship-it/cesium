import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer, preview } from 'vite';
import type { Plugin } from 'vite';
import { createEngineeringComponentsAssetsMiddleware, engineeringComponentsAssetsPlugin } from './engineeringComponentsAssets.ts';
import type { EngineeringAssetsOptions } from './engineeringComponentsAssets.ts';
import { setManagementActor } from './management/actorContext.ts';
import type { IncomingMessage } from 'node:http';
import { createFileSymlinkFixture } from '../tests/helpers/fileSymlinkFixture.ts';

const prefix = '/__engineering-components/';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function attachActor(req: IncomingMessage) {
  // Test host only. Production code never accepts actor identity in a header.
  const kind = req.headers['x-test-actor'];
  if (kind === 'missing') return;
  setManagementActor(req, { id: 'synthetic-user', displayName: 'Synthetic owner', roles: ['owner'], authMode: 'local-account',
    permissions: kind === 'reader' ? ['read'] : ['read', 'models'], ...(kind === 'scoped' ? { taskIds: ['task-one'] } : {}) });
}
async function fixture(t: TestContext) {
  const created = await mkdtemp(join(tmpdir(), 'cesium-engineering-assets-test-'));
  const root = await realpath(created), bundle = join(root, 'bundle'), app = join(root, 'app');
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['models', 'structure-library/bridge/A001', 'structure-library/tunnel/TN021']) await mkdir(join(bundle, dir), { recursive: true });
  await mkdir(join(app, 'dist'), { recursive: true });
  await writeFile(join(app, 'index.html'), '<!doctype html><body>synthetic app</body>');
  await writeFile(join(app, 'dist/index.html'), '<!doctype html><body>synthetic app</body>');
  const full = Buffer.from('glTF-synthetic-whole-model-0123456789'), unit = Buffer.from('glTF-synthetic-unit');
  const catalog = JSON.stringify({ schema: 'jiashan/component-library/2.0', modelRevision: 'JS-test',
    components: [{ id: 'A001_cap_01' }, { id: 'TN021_tunnel_roof_01' }], groups: [{ id: 'BRIDGE' }], referenceGeometry: [] });
  const index = JSON.stringify({ A001: { path: 'structure-library/bridge/A001', count: 1, sha256: hash(unit) },
    TN021: { path: 'structure-library/tunnel/TN021', count: 1, sha256: hash(unit) } });
  await writeFile(join(bundle, 'components.json'), catalog); await writeFile(join(bundle, 'structure-library/index.json'), index);
  await writeFile(join(bundle, 'models/Jiashan.glb'), full); await writeFile(join(bundle, 'models/Jiashan.skp'), 'private original SKP');
  await writeFile(join(bundle, 'index.html'), 'private source web'); await writeFile(join(root, 'outside.glb'), 'outside confidential');
  for (const [id, family, member] of [['A001', 'bridge', 'A001_cap_01'], ['TN021', 'tunnel', 'TN021_tunnel_roof_01']]) {
    await writeFile(join(bundle, `structure-library/${family}/${id}/model.glb`), unit);
    await writeFile(join(bundle, `structure-library/${family}/${id}/structure.json`), JSON.stringify({ unitId: id, model: 'model.glb', componentIds: [member] }));
  }
  const options: EngineeringAssetsOptions = { directory: bundle, expectedHashes: { catalog: hash(catalog), index: hash(index), fullModel: hash(full) } };
  return { root, bundle, app, full, unit, catalog, index, options };
}
async function serve(t: TestContext, options: EngineeringAssetsOptions) {
  const middleware = createEngineeringComponentsAssetsMiddleware(options);
  const server = createServer((req, res) => {
    attachActor(req); void middleware(req, res, () => { res.statusCode = 404; res.end('unrelated fallback'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return (name: string, method = 'GET', headers?: Record<string, string>) => fetch(origin + prefix + name, { method, headers });
}

test('verified source manifest and original bytes are served without copying, exposing local paths, or publishing SKP', async t => {
  const f = await fixture(t), call = await serve(t, f.options), initial = await readdir(f.bundle, { recursive: true });
  const r = await call('manifest'), m = await r.json();
  assert.equal(r.status, 200); assert.equal(m.available, true); assert.equal(m.modelRevision, 'JS-test');
  assert.equal(m.componentCount, 2); assert.equal(m.units.length, 2);
  assert.equal(m.fingerprint, hash([hash(f.catalog), hash(f.full), hash(f.index)].join('\n')));
  assert.equal(m.catalog.sha256, hash(f.catalog)); assert.equal(m.fullModel.bytes, f.full.length);
  assert.equal(m.units[1].modelUrl, prefix + 'structure-library/tunnel/TN021/model.glb');
  assert.doesNotMatch(JSON.stringify(m), /[A-Za-z]:\\|confidential|private original|bundle/);
  assert.match(r.headers.get('cache-control')!, /private.*no-store/); assert.equal(r.headers.get('vary'), 'Cookie');
  assert.deepEqual(Buffer.from(await (await call('models/Jiashan.glb')).arrayBuffer()), f.full);
  assert.equal(await (await call('components.json')).text(), f.catalog);
  assert.equal(await (await call('structure-library/index.json')).text(), f.index);
  assert.deepEqual(Buffer.from(await (await call('structure-library/bridge/A001/model.glb')).arrayBuffer()), f.unit);
  assert.equal((await (await call('structure-library/tunnel/TN021/structure.json')).json()).unitId, 'TN021');
  const head = await call('models/Jiashan.glb', 'HEAD'); assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(f.full.length)); assert.equal(await head.text(), '');
  for (const name of ['models/Jiashan.skp', 'index.html', 'originals/secret.glb', 'models/source_geometry.json.gz', 'structure-library/bridge/A001/private.json'])
    assert.equal((await call(name)).status, 404, name);
  assert.deepEqual(await readdir(f.bundle, { recursive: true }), initial);
  assert.deepEqual(await readFile(join(f.bundle, 'models/Jiashan.glb')), f.full);
  assert.deepEqual(await readdir(f.app), ['dist', 'index.html']);
});

test('trusted model permissions, whole-project scope and same-origin checks are required even for manifest discovery', async t => {
  const f = await fixture(t), call = await serve(t, f.options);
  for (const name of ['manifest', 'components.json', 'models/Jiashan.glb']) {
    assert.equal((await call(name, 'GET', { 'x-test-actor': 'missing', authorization: 'pretend-owner' })).status, 401);
    assert.equal((await call(name, 'GET', { 'x-test-actor': 'reader' })).status, 403);
    assert.equal((await call(name, 'GET', { 'x-test-actor': 'scoped' })).status, 403);
    assert.equal((await call(name, 'GET', { origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await call(name, 'GET', { 'sec-fetch-site': 'cross-site' })).status, 403);
  }
  const changed = await call('manifest', 'POST'); assert.equal(changed.status, 405); assert.equal(changed.headers.get('allow'), 'GET, HEAD');
});

test('single byte ranges, suffix ranges, HEAD, conditional cache and If-Range preserve exact source bytes', async t => {
  const f = await fixture(t), call = await serve(t, f.options);
  const path = 'models/Jiashan.glb', normal = await call(path), etag = normal.headers.get('etag')!;
  await normal.arrayBuffer();
  for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=4-', 4, f.full.length - 1], ['bytes=-5', f.full.length - 5, f.full.length - 1]] as const) {
    const r = await call(path, 'GET', { range }); assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${f.full.length}`);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), f.full.subarray(start, end + 1));
  }
  const head = await call(path, 'HEAD', { range: 'bytes=0-3' }); assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '4'); assert.equal(await head.text(), '');
  const cached = await call(path, 'GET', { 'if-none-match': etag }); assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
  const mismatched = await call(path, 'GET', { range: 'bytes=0-3', 'if-range': '"older"' }); assert.equal(mismatched.status, 200);
  assert.deepEqual(Buffer.from(await mismatched.arrayBuffer()), f.full);
  for (const range of ['bytes=99999-', 'bytes=4-2', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-0', 'bytes=-', 'bytes=0-9007199254740992', 'bytes=' + '1'.repeat(200) + '-']) {
    const r = await call(path, 'GET', { range }); assert.equal(r.status, 416, range);
    assert.equal(r.headers.get('content-range'), `bytes */${f.full.length}`);
  }
});

test('missing configuration is discoverable without breaking startup; invalid configuration and traversal never expose filesystem details', async t => {
  const f = await fixture(t), unconfigured = await serve(t, {});
  const missing = await unconfigured('manifest.json'); assert.equal(missing.status, 200); assert.equal((await missing.json()).available, false);
  assert.equal((await unconfigured('models/Jiashan.glb')).status, 404);
  const call = await serve(t, f.options);
  for (const suffix of ['%2e%2e%2foutside.glb', 'models/%2e%2e%5coutside.glb', '%252e%252e%252foutside.glb', '%00', 'C%3Aprivate.glb', 'models//Jiashan.glb']) {
    const r = await call(suffix); assert.equal(r.status, 404, suffix); assert.doesNotMatch(await r.text(), /confidential|[A-Za-z]:\\|unrelated fallback/);
  }
  assert.equal((await call('%zz')).status, 400);
  const relative = await serve(t, { ...f.options, directory: 'relative-private' }); assert.equal((await relative('manifest')).status, 422);
  const absent = await serve(t, { ...f.options, directory: join(f.root, 'missing') });
  const notFound = await absent('manifest'); assert.equal(notFound.status, 404); assert.doesNotMatch(await notFound.text(), /ENOENT|cesium-engineering-assets-test/);
});

test('catalog/full-model/index changes fail the identity gate and corrected original bytes can recover', async t => {
  const f = await fixture(t), call = await serve(t, f.options);
  assert.equal((await call('manifest')).status, 200);
  for (const [path, bytes] of [['components.json', f.catalog], ['models/Jiashan.glb', f.full], ['structure-library/index.json', f.index]] as const) {
    await writeFile(join(f.bundle, path), 'tampered');
    const r = await call('manifest'); assert.equal(r.status, 422, path); assert.equal((await r.json()).available, false);
    await writeFile(join(f.bundle, path), bytes); assert.equal((await call('manifest')).status, 200);
  }
  const unitPath = 'structure-library/bridge/A001/model.glb';
  await writeFile(join(f.bundle, unitPath), 'wrong unit'); assert.equal((await call(unitPath)).status, 422);
  await writeFile(join(f.bundle, unitPath), f.unit); assert.equal((await call(unitPath)).status, 200);
  const structurePath = 'structure-library/bridge/A001/structure.json';
  await writeFile(join(f.bundle, structurePath), JSON.stringify({ unitId: 'TN021', model: 'model.glb', componentIds: ['A001_cap_01'] }));
  assert.equal((await call(structurePath)).status, 422);
});

test('same-length edits invalidate metadata/hash caches before conditional requests can return stale success', async t => {
  const f = await fixture(t), call = await serve(t, f.options);
  for (const [path, original] of [['components.json', Buffer.from(f.catalog)], ['models/Jiashan.glb', f.full],
    ['structure-library/index.json', Buffer.from(f.index)], ['structure-library/bridge/A001/model.glb', f.unit]] as const) {
    const normal = await call(path), etag = normal.headers.get('etag')!;
    assert.equal(normal.status, 200); await normal.arrayBuffer();
    const location = join(f.bundle, path), before = await stat(location), altered = Buffer.from(original);
    altered[altered.length - 1] ^= 1;
    await writeFile(location, altered);
    await utimes(location, before.atime, new Date(before.mtimeMs + 2000));
    assert.equal((await stat(location)).size, before.size, 'fixture changes content and mtime while preserving size');
    const stale = await call(path, 'GET', { 'if-none-match': etag }); assert.equal(stale.status, 422, path);
    assert.equal(stale.headers.get('etag'), null); assert.equal((await stale.json()).available, false);
    await writeFile(location, original);
    assert.equal((await call(path)).status, 200, 'restoring the original bytes recovers without restart');
  }
});

test('directory link escapes and replaced roots are rejected even when the requested filename is allowed', async t => {
  const f = await fixture(t), call = await serve(t, f.options);
  assert.equal((await call('manifest')).status, 200);
  await rename(join(f.bundle, 'structure-library/bridge/A001'), join(f.root, 'moved-unit'));
  await symlink(join(f.root, 'moved-unit'), join(f.bundle, 'structure-library/bridge/A001'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('structure-library/bridge/A001/model.glb')).status, 404);
  await rename(f.bundle, join(f.root, 'moved-bundle'));
  await symlink(join(f.root, 'moved-bundle'), f.bundle, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('manifest')).status, 404);
});

test('file symlink escapes fail before any source bytes are streamed', async t => {
  const f = await fixture(t), call = await serve(t, f.options), target = join(f.bundle, 'structure-library/tunnel/TN021/model.glb');
  assert.equal((await call('manifest')).status, 200); await rm(target);
  if (!await createFileSymlinkFixture(t, join(f.root, 'outside.glb'), target)) return;
  const response = await call('structure-library/tunnel/TN021/model.glb'); assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /confidential/);
});

for (const mode of ['dev', 'preview'] as const) {
  test(`actual Vite ${mode} mounts the protected source route under its configured base without serving private paths`, async t => {
    const f = await fixture(t);
    const actorPlugin: Plugin = { name: 'synthetic-trusted-actor', enforce: 'pre',
      configureServer(server) { server.middlewares.use((req, _res, next) => { attachActor(req); next(); }); },
      configurePreviewServer(server) { server.middlewares.use((req, _res, next) => { attachActor(req); next(); }); } };
    const config = { configFile: false as const, root: f.app, base: '/cesium/', logLevel: 'silent' as const,
      plugins: [actorPlugin, engineeringComponentsAssetsPlugin(f.options)],
      server: { host: '127.0.0.1', port: 0, watch: null }, preview: { host: '127.0.0.1', port: 0 } };
    const server = mode === 'dev' ? await createViteServer(config) : await preview(config);
    if ('listen' in server) await server.listen();
    try {
      const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
      const r = await fetch(origin + '/cesium' + prefix + 'manifest'), manifest = await r.json();
      assert.equal(r.status, 200); assert.equal(manifest.catalog.url, '/cesium' + prefix + 'components.json');
      const bytes = await fetch(origin + manifest.fullModel.url, { headers: { range: 'bytes=0-3' } });
      assert.equal(bytes.status, 206); assert.equal(await bytes.text(), 'glTF');
      assert.equal((await fetch(origin + manifest.catalog.url, { headers: { 'x-test-actor': 'missing' } })).status, 401);
      assert.equal((await fetch(origin + '/cesium' + prefix + 'models/Jiashan.skp')).status, 404);
      assert.match(await (await fetch(origin + '/cesium/')).text(), /synthetic app/);
    } finally {
      await server.close();
    }
  });
}
