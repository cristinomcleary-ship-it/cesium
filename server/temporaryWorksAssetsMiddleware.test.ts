import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer, preview } from 'vite';
import { createTemporaryWorksAssetsMiddleware, temporaryWorksAssetsPlugin } from './temporaryWorksAssetsMiddleware.ts';
import { createFileSymlinkFixture } from '../tests/helpers/fileSymlinkFixture.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cesium-temporary-assets-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'original-bundle'), app = join(root, 'candidate');
  await mkdir(bundle); await mkdir(join(app, 'public'), { recursive: true }); await mkdir(join(app, 'dist'));
  const html = '<!doctype html><html><body>synthetic candidate</body></html>';
  await writeFile(join(app, 'index.html'), html); await writeFile(join(app, 'dist/index.html'), html);
  const manifest = { schemaVersion: 1, assets: ['camp', 'steel', 'wall'].map(id => ({ id, url: `models/temporary-works/${id}-original.glb` })),
    logo: { url: 'models/temporary-works/cr24-logo.png' } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(bundle, 'manifest.json'), manifestBytes);
  for (const { id } of manifest.assets) await writeFile(join(bundle, `${id}-original.glb`), Buffer.from(`synthetic original ${id}`));
  await writeFile(join(bundle, 'cr24-logo.png'), 'synthetic original logo');
  await writeFile(join(bundle, 'private.json'), 'unlisted private data');
  await writeFile(join(root, 'outside.glb'), 'outside private data');
  return { root, app, bundle, manifest, manifestBytes };
}

async function serve(t: TestContext, directory: string | undefined, staticDirectory: string) {
  const middleware = createTemporaryWorksAssetsMiddleware({ directory, staticDirectory });
  const server = createServer((req, res) => void middleware(req, res, () => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html>fallback'); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return (name: string, method = 'GET', headers?: Record<string, string>) => fetch(`${base}/models/temporary-works/${name}`, { method, headers });
}

test('read-only bundle mount serves original manifest, arbitrary referenced filenames and GLB hash queries without copying', async t => {
  const f = await fixture(t), call = await serve(t, f.bundle, join(f.app, 'public/models/temporary-works'));
  const initialFiles = await readdir(f.bundle);
  const manifest = await call('manifest.json');
  assert.equal(manifest.status, 200); assert.match(manifest.headers.get('content-type')!, /application\/json/);
  assert.deepEqual(Buffer.from(await manifest.arrayBuffer()), f.manifestBytes);
  for (const { id } of f.manifest.assets) {
    const r = await call(`${id}-original.glb?v=${'a'.repeat(64)}`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(await r.text(), `synthetic original ${id}`);
  }
  const head = await call('camp-original.glb', 'HEAD');
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), '23');
  const logo = await call('cr24-logo.png'); assert.equal(logo.status, 200); assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.match(logo.headers.get('cache-control')!, /private, max-age=0/);
  const cached = await call('cr24-logo.png', 'GET', { 'if-none-match': logo.headers.get('etag')! });
  assert.equal(cached.status, 304); assert.equal(await cached.text(), ''); assert.equal(cached.headers.get('content-length'), null);
  assert.equal((await call('cr24-logo.png', 'HEAD', { 'if-none-match': logo.headers.get('etag')! })).status, 304);
  await writeFile(join(f.bundle, 'cr24-logo.png'), 'updated synthetic logo');
  const changed = await call('cr24-logo.png', 'GET', { 'if-none-match': logo.headers.get('etag')! });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), logo.headers.get('etag'));
  assert.deepEqual(await readdir(f.bundle), initialFiles); assert.deepEqual(await readdir(join(f.app, 'public')), []);
  assert.deepEqual(await readFile(join(f.bundle, 'manifest.json')), f.manifestBytes);
});

test('aborted GLB streaming releases the file and finishes the middleware before another request', async t => {
  const f = await fixture(t);
  await writeFile(join(f.bundle, 'camp-original.glb'), Buffer.alloc(8 * 1024 * 1024, 42));
  const middleware = createTemporaryWorksAssetsMiddleware({ directory: f.bundle, staticDirectory: join(f.app, 'public/models/temporary-works') });
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer((req, res) => { void middleware(req, res, () => res.end()).finally(finish); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/models/temporary-works/camp-original.glb`;
  await new Promise<void>((resolve, reject) => {
    const req = request(url, res => { res.once('data', () => { res.destroy(); req.destroy(); resolve(); }); });
    req.on('error', reject); req.end();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('aborted stream retained its file')), 3000); })]); }
  finally { clearTimeout(timer); }
  await rename(join(f.bundle, 'camp-original.glb'), join(f.bundle, 'closed-original.glb'));
  await rename(join(f.bundle, 'closed-original.glb'), join(f.bundle, 'camp-original.glb'));
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(8 * 1024 * 1024));
});

test('missing bundles/files, unlisted private data and bad methods never reach the SPA fallback', async t => {
  const f = await fixture(t), call = await serve(t, f.bundle, join(f.app, 'public/models/temporary-works'));
  for (const name of ['missing.glb', 'private.json', '%2e%2e%2foutside.glb', '%2e%2e%5coutside.glb', '%00', 'C%3Aoutside.glb']) {
    const r = await call(name); assert.equal(r.status, 404, name); assert.match(r.headers.get('content-type')!, /application\/json/);
    assert.doesNotMatch(await r.text(), /<!doctype|unlisted private|outside private/);
  }
  assert.equal((await call('%zz')).status, 400);
  assert.equal((await call('manifest.json', 'POST')).status, 405);
  await rm(join(f.bundle, 'steel-original.glb'));
  assert.equal((await call('steel-original.glb')).status, 404);
  const missing = await serve(t, join(f.root, 'missing'), join(f.app, 'public/models/temporary-works'));
  assert.equal((await missing('manifest.json')).status, 404);
  const relative = await serve(t, 'ambiguous-relative-bundle', join(f.app, 'public/models/temporary-works'));
  assert.equal((await relative('manifest.json')).status, 422);
});

test('manifest changes refresh the allowlist, corrupted manifest can recover, and JPEG branding remains supported', async t => {
  const f = await fixture(t), call = await serve(t, f.bundle, join(f.app, 'public/models/temporary-works'));
  assert.equal((await call('camp-original.glb')).status, 200);
  await writeFile(join(f.bundle, 'manifest.json'), '<!doctype html>broken');
  const broken = await call('manifest.json'); assert.equal(broken.status, 422); assert.equal((await broken.json()).ok, false);
  f.manifest.assets[0].url = 'models/temporary-works/replacement.glb';
  f.manifest.logo.url = 'models/temporary-works/cr24-logo.jpg';
  await writeFile(join(f.bundle, 'replacement.glb'), 'synthetic updated model');
  await writeFile(join(f.bundle, 'cr24-logo.jpg'), 'synthetic jpeg logo');
  await writeFile(join(f.bundle, 'manifest.json'), JSON.stringify(f.manifest));
  assert.equal((await call('manifest.json')).status, 200); assert.equal((await call('camp-original.glb')).status, 404);
  assert.equal(await (await call('replacement.glb')).text(), 'synthetic updated model');
  const logo = await call('cr24-logo.jpg'); assert.equal(logo.status, 200); assert.equal(logo.headers.get('content-type'), 'image/jpeg');
});

test('explicit mounts reject referenced file links escaping their root', async t => {
  const f = await fixture(t), call = await serve(t, f.bundle, join(f.app, 'public/models/temporary-works'));
  await rm(join(f.bundle, 'camp-original.glb'));
  if (!await createFileSymlinkFixture(t, join(f.root, 'outside.glb'), join(f.bundle, 'camp-original.glb'))) return;
  const r = await call('camp-original.glb'); assert.equal(r.status, 404); assert.doesNotMatch(await r.text(), /outside private/);
});

test('explicit mounts reject a replaced root including Windows junction replacement', async t => {
  const f = await fixture(t), call = await serve(t, f.bundle, join(f.app, 'public/models/temporary-works'));
  assert.equal((await call('manifest.json')).status, 200);
  await rename(f.bundle, join(f.root, 'moved-synthetic-bundle'));
  await symlink(f.root, f.bundle, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('manifest.json')).status, 404);
});

for (const mode of ['dev', 'preview'] as const) {
  for (const base of ['/', '/cesium/']) {
    test(`actual Vite ${mode} ${base} supports original static bundle and read-only mount, rejects missing JSON as JSON`, async t => {
      const f = await fixture(t);
      const staticRoot = join(f.app, mode === 'dev' ? 'public' : 'dist', 'models/temporary-works');
      const originalEnv = process.env.CESIUM_TEMPORARY_WORKS_ASSETS_DIR;
      try {
        for (const state of ['missing', 'static', 'mounted']) {
          const mounted = state === 'mounted';
          if (state === 'static') {
            // Existing deployments install their public/dist package before the
            // Vite process starts. Do not race dev's public-file watcher here.
            await mkdir(staticRoot, { recursive: true });
            await writeFile(join(staticRoot, 'manifest.json'), '{"legacy":"original bytes"}');
            await writeFile(join(staticRoot, 'camp.glb'), 'original static model');
          }
          if (mounted) process.env.CESIUM_TEMPORARY_WORKS_ASSETS_DIR = f.bundle;
          else delete process.env.CESIUM_TEMPORARY_WORKS_ASSETS_DIR;
          const config = { configFile: false as const, root: f.app, base, logLevel: 'silent' as const,
            plugins: [temporaryWorksAssetsPlugin()], server: { host: '127.0.0.1', port: 0 }, preview: { host: '127.0.0.1', port: 0 } };
          const server = mode === 'dev' ? await createViteServer(config) : await preview(config);
          if ('listen' in server) await server.listen();
          try {
            const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
            const get = (name: string) => fetch(`${origin}${base}models/temporary-works/${name}`);
            const absent = await get('absent.json'); assert.equal(absent.status, 404); assert.match(absent.headers.get('content-type')!, /application\/json/);
            if (state === 'missing') {
              const missing = await get('manifest.json'); assert.equal(missing.status, 404); assert.doesNotMatch(await missing.text(), /<!doctype/);
            } else if (state === 'static') {
              // Legacy static installs need not adopt new metadata or copy tools.
              assert.equal(await (await get('manifest.json')).text(), '{"legacy":"original bytes"}');
              assert.equal(await (await get('camp.glb?v=original')).text(), 'original static model');
              const ranged = await fetch(`${origin}${base}models/temporary-works/camp.glb`, { headers: { Range: 'bytes=0-7' } });
              assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'original');
            } else {
              assert.deepEqual(await (await get('manifest.json')).json(), f.manifest);
              assert.equal(await (await get('steel-original.glb?v=hash')).text(), 'synthetic original steel');
              assert.equal((await get('private.json')).status, 404);
              // Configured mounts are authoritative; never mix with stale dist.
              assert.equal((await get('camp.glb')).status, 404);
            }
            assert.match(await (await fetch(`${origin}${base}`)).text(), /synthetic candidate/);
          } finally {
            if ('close' in server) await server.close();
            else { server.httpServer.closeAllConnections(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
          }
        }
      } finally {
        if (originalEnv === undefined) delete process.env.CESIUM_TEMPORARY_WORKS_ASSETS_DIR;
        else process.env.CESIUM_TEMPORARY_WORKS_ASSETS_DIR = originalEnv;
      }
    });
  }
}
