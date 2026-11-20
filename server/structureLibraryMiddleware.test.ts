import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setManagementActor } from './management/actorContext.ts';
import type { Actor } from './management/domain.ts';
import { setStructurePreviewAuthorizer } from './management/structurePreviewContext.ts';
import { createManagementStore } from './managementStore.ts';
import { createStructureLibraryMiddleware } from './structureLibraryMiddleware.ts';

const library = '/__structure_library';
const a001 = `${library}/bridge/A001`;
const actor: Actor = { id: 'test-user', displayName: '测试用户', authMode: 'local-account', roles: ['owner'], permissions: ['read', 'models'] };
const originalHtml = '<!doctype html><meta charset="utf-8"><script type="module" src="./assets/组件.mjs"></script>';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cesium-structure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'structure-library');
  const structure = join(directory, 'bridge', 'A001');
  const preview = join(structure, 'preview');
  await mkdir(join(preview, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'catalog.json'), JSON.stringify({ version: 1, bindings: [{ modelId: 'model-a', category: 'bridge', structureId: 'A001' }] })),
    writeFile(join(structure, 'structure.json'), JSON.stringify({ version: 1, title: 'A001#墩', anchor: { kind: 'model-local', position: [1, 2, 3] } })),
    writeFile(join(structure, 'hologram.glb'), Buffer.from([0, 1, 2, 3, 4, 5])),
    writeFile(join(preview, 'index.html'), originalHtml),
    writeFile(join(preview, 'assets', '组件.mjs'), 'export default 1;'),
    writeFile(join(preview, 'assets', 'style.css'), 'body { color: blue; }'),
    writeFile(join(preview, 'assets', 'shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    writeFile(join(root, 'private.txt'), 'private data'),
    writeFile(join(preview, '.env'), 'secret'),
  ]);
  return { root, directory, structure, preview };
}

async function listen(t: TestContext, options: Parameters<typeof createStructureLibraryMiddleware>[0], initialActor: Actor | null = actor) {
  let currentActor = initialActor;
  const middleware = createStructureLibraryMiddleware(options);
  const server = createServer((req, res) => {
    if (req.url?.startsWith(library)) {
      if (currentActor) setManagementActor(req, currentActor);
      setStructurePreviewAuthorizer(req, () => {
        if (!currentActor) throw new Error('Logged out');
        return currentActor;
      });
    }
    void middleware(req, res, () => { res.end('other middleware'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const rawStatus = (path: string) => new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  return {
    base, rawStatus, get: (path: string, init?: RequestInit) => fetch(base + path, init),
    updateActor: (update: Actor | null) => { currentActor = update; },
  };
}

test('structure library is opt-in, authenticated, read only, and preserves later routes', async t => {
  const { directory } = await fixture(t);
  const disabled = await listen(t, {});
  const missing = await disabled.get(`${library}/catalog.json`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).ok, false);
  const service = await listen(t, { directory }, null);
  assert.equal((await service.get(`${library}/catalog.json`)).status, 401);
  service.updateActor({ ...actor, taskIds: [] });
  assert.equal((await service.get(`${library}/catalog.json`)).status, 403);
  service.updateActor({ ...actor, permissions: ['read'] });
  assert.equal((await service.get(`${library}/catalog.json`)).status, 403);
  service.updateActor(actor);
  assert.equal((await service.get(`${library}/catalog.json`, { headers: { Origin: 'https://elsewhere.invalid' } })).status, 403);
  const write = await service.get(`${library}/catalog.json`, { method: 'POST' });
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('allow'), 'GET, HEAD');
  assert.equal((await (await service.get(`${library}/catalog.json`)).json()).bindings[0].structureId, 'A001');
  assert.equal(await (await service.get('/current-app')).text(), 'other middleware');
});

test('authorized file paths stream correct types and single byte ranges', async t => {
  const { directory } = await fixture(t);
  const service = await listen(t, { directory });
  const config = await service.get(`${a001}/structure.json`);
  assert.match(config.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal((await config.json()).title, 'A001#墩');
  const path = `${a001}/hologram.glb`;
  const head = await service.get(path, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '6');
  assert.equal(head.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(await head.text(), '');
  const tail = await service.get(path, { headers: { Range: 'bytes=-2' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), 'bytes 4-5/6');
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), Uint8Array.of(4, 5));
  const invalid = await service.get(path, { headers: { Range: 'bytes=6-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */6');
  assert.equal((await service.get(`${a001}/other.json`)).status, 404);
});

test('original preview and relative dependencies are isolated within the issued scope', async t => {
  const { directory, preview } = await fixture(t);
  await mkdir(join(directory, 'bridge', 'A002', 'preview'), { recursive: true });
  await writeFile(join(directory, 'bridge', 'A002', 'preview', 'index.html'), 'private B');
  const service = await listen(t, { directory });
  const entry = await service.get(`${a001}/preview`, { redirect: 'manual' });
  assert.equal(entry.status, 302);
  const url = entry.headers.get('location') ?? '';
  assert.match(url, /^\/__structure_preview\/[a-f0-9]{48}\/index\.html$/);
  const page = await service.get(url);
  assert.equal(await page.text(), originalHtml);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /sandbox allow-scripts allow-downloads/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.ok(csp.includes(url.slice(0, -'index.html'.length)));
  const assetUrl = new URL('./assets/%E7%BB%84%E4%BB%B6.mjs', service.base + url);
  const asset = await service.get(assetUrl.pathname, { headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(asset.headers.get('access-control-allow-origin'), 'null');
  assert.equal(asset.headers.get('access-control-allow-credentials'), null);
  assert.equal(await asset.text(), 'export default 1;');
  assert.equal((await service.get(assetUrl.pathname, { headers: { Origin: 'https://elsewhere.invalid' } })).status, 403);
  const style = await service.get(new URL('./assets/style.css', service.base + url).pathname, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(await style.text(), 'body { color: blue; }');
  assert.match(style.headers.get('content-type') ?? '', /^text\/css/);
  const svg = await service.get(new URL('./assets/shape.svg', service.base + url).pathname);
  assert.match(svg.headers.get('content-security-policy') ?? '', /sandbox/);
  const prefix = url.slice(0, -'index.html'.length);
  assert.equal(await service.rawStatus(prefix + '..%2FA002%2Fpreview%2Findex.html'), 404);
  assert.equal(await service.rawStatus(prefix + '%252e%252e/A002/preview/index.html'), 404);
  assert.equal((await service.get(prefix + '.env')).status, 404);
  await symlink(join(preview, 'assets'), join(preview, 'linked-assets'), 'junction');
  assert.equal((await service.get(prefix + 'linked-assets/shape.svg')).status, 404);
});

test('preview capability expires and is revoked on missing session or feature permission', async t => {
  const { directory } = await fixture(t);
  let now = 1000;
  const expiry = 1100;
  const signedIn = { ...actor, expiresAt: new Date(expiry).toISOString() };
  const service = await listen(t, { directory, now: () => now }, signedIn);
  const openPreview = async () => (await service.get(`${a001}/preview`, { redirect: 'manual' })).headers.get('location')!;
  const first = await openPreview();
  assert.equal((await service.get(first)).status, 200);
  now = expiry;
  assert.equal((await service.get(first)).status, 404);
  service.updateActor(actor);
  const second = await openPreview();
  service.updateActor({ ...actor, permissions: ['read'] });
  assert.equal((await service.get(second)).status, 403);
  service.updateActor(actor);
  assert.equal((await service.get(second)).status, 404);
  const third = await openPreview();
  service.updateActor(null);
  assert.equal((await service.get(third)).status, 403);
});

test('a managed account can open original preview and logging out revokes its granted asset URLs', async t => {
  const { directory, root } = await fixture(t);
  const store = createManagementStore({ dataDir: join(root, 'management'), libraryDataDir: join(root, 'library') });
  const middleware = createStructureLibraryMiddleware({ directory });
  const server = createServer((req, res) => {
    void store.accessMiddleware(req, res, () => {
      void store.middleware(req, res, () => {
        void middleware(req, res, () => { res.statusCode = 404; res.end(); });
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const bootstrap = await fetch(base + '/__management/commands', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' },
      body: JSON.stringify({ projectId: 'safety:project', type: 'member.save', idempotencyKey: 'structure-preview-owner',
        payload: { username: 'owner', displayName: 'Owner', password: 'Synthetic-Test-123', roles: ['owner'] } }),
    });
    assert.equal(bootstrap.status, 200, await bootstrap.text());
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(cookie);
    assert.equal((await fetch(base + `${a001}/preview`, { redirect: 'manual' })).status, 401);
    const entry = await fetch(base + `${a001}/preview`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(entry.status, 302);
    const url = base + (entry.headers.get('location') ?? '');
    assert.equal(await (await fetch(url)).text(), originalHtml);
    assert.equal((await fetch(base + '/__management/session', { method: 'DELETE', headers: { cookie, 'X-Cesium-Library': '1' } })).status, 200);
    assert.equal((await fetch(url, { headers: { Origin: 'null' } })).status, 403);
    assert.equal((await fetch(url)).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('refuses both public directory mounts and links escaping the private structure tree', async t => {
  const { root, directory } = await fixture(t);
  const viteRoot = join(root, 'app');
  const publicDir = join(viteRoot, 'public');
  await mkdir(publicDir, { recursive: true });
  await symlink(directory, join(publicDir, 'structure-library'), 'junction');
  const publicMount = await listen(t, { directory: join(publicDir, 'structure-library'), viteRoot, servedDirectories: [publicDir] });
  assert.equal((await publicMount.get(`${library}/catalog.json`)).status, 422);
  await symlink(join(directory, 'bridge', 'A001'), join(directory, 'bridge', 'A002'), 'junction');
  const service = await listen(t, { directory, viteRoot, servedDirectories: [publicDir] });
  assert.equal((await service.get(`${library}/bridge/A002/structure.json`)).status, 404);
  assert.equal((await service.get(`${library}/bridge/A002/preview`)).status, 404);
});
