import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createLocalTilesMiddleware } from './localTilesMiddleware.ts';
import { setManagementActor } from './management/actorContext.ts';
import { createFileSymlinkFixture } from '../tests/helpers/fileSymlinkFixture.ts';

async function fixture(aggregate = false) {
  const work = await mkdtemp(join(tmpdir(), 'cesium-local-tiles-test-')), root = join(work, 'tiles');
  await mkdir(root); await writeFile(join(root, 'tileset.json'), '{"asset":{"version":"1.1"}}');
  await writeFile(join(root, 'tile.b3dm'), 'synthetic tile'); await writeFile(join(work, 'private.txt'), 'private outside data');
  const middleware = createLocalTilesMiddleware(() => ({ root, entry: join(root, aggregate ? '__aggregate__.json' : 'tileset.json'),
    ...(aggregate ? { aggregate: { asset: { version: '1.1' }, root: {} } } : {}), candidateCount: 1, topLevelCount: 1 }));
  const server = createServer((req, res) => {
    if (req.headers['x-test-actor'] !== 'missing') setManagementActor(req, { id: 'test', displayName: 'Owner', authMode: 'local-account', roles: ['owner'],
      permissions: req.headers['x-test-actor'] === 'reader' ? ['read'] : ['read', 'admin', 'models'] });
    void middleware(req, res, () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, method = 'GET', body?: unknown, extra = {}) => fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const mounted = await call('/__local_tiles/mount', 'POST', { path: root }); assert.equal(mounted.status, 200);
  const data = await mounted.json(), prefix = data.url.slice(0, data.url.lastIndexOf('/') + 1);
  return { work, root, call, prefix, url: data.url, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(work, { recursive: true, force: true }); } };
}

test('local tiles retain normal mount/GET and add private HEAD and explicit method handling', async () => {
  const f = await fixture();
  try {
    const response = await f.call(f.prefix + 'tile.b3dm'); assert.equal(response.status, 200); assert.equal(await response.text(), 'synthetic tile');
    assert.match(response.headers.get('cache-control')!, /private.*no-store/); assert.equal(response.headers.get('vary'), 'Cookie');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const head = await f.call(f.prefix + 'tile.b3dm', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), '14');
    assert.equal((await f.call(f.url, 'POST', {})).status, 405);
    assert.equal((await f.call('/__local_tiles/mount')).status, 405);
    assert.equal((await f.call(f.url, 'GET', undefined, { 'x-test-actor': 'reader' })).status, 403);
    assert.equal((await f.call(f.url, 'GET', undefined, { 'x-test-actor': 'missing' })).status, 401);
    assert.equal((await f.call(f.url, 'GET', undefined, { origin: 'https://foreign.test' })).status, 403);
  } finally { await f.close(); }
});

test('local tile paths reject malformed URI and parent escapes without requiring symlink privileges', async () => {
  const f = await fixture();
  try {
    for (const suffix of ['%2e%2e%2fprivate.txt', '%2e%2e%5cprivate.txt', '%00', 'C%3Aprivate.txt', 'missing.b3dm'])
      assert.equal((await f.call(f.prefix + suffix)).status, 404, suffix);
    assert.equal((await f.call(f.prefix + '%zz')).status, 400);
  } finally { await f.close(); }
});

test('local tiles reject escaping directory links and replaced mounts, including Windows junctions', async () => {
  const f = await fixture();
  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(f.work, join(f.root, 'escape-directory'), type);
    assert.equal((await f.call(f.prefix + 'escape-directory/private.txt')).status, 404);
    await rename(f.root, join(f.work, 'renamed-synthetic-root')); await symlink(f.work, f.root, type);
    assert.equal((await f.call(f.url)).status, 404);
  } finally { await f.close(); }
});

test('local tiles reject escaping file symlinks and preserve contained file symlinks', async t => {
  const f = await fixture();
  try {
    if (!await createFileSymlinkFixture(t, join(f.work, 'private.txt'), join(f.root, 'escape.b3dm'))) return;
    // The same directory has demonstrated file-link capability; a subsequent
    // creation failure is unexpected and must fail rather than skip the test.
    await symlink(join(f.root, 'tile.b3dm'), join(f.root, 'inside.b3dm'), 'file');
    assert.equal((await f.call(f.prefix + 'inside.b3dm')).status, 200, 'contained links preserve valid imports');
    assert.equal((await f.call(f.prefix + 'escape.b3dm')).status, 404);
  } finally { await f.close(); }
});

test('local tile mount rejects malformed/oversized JSON and aggregate retains GET and HEAD', async () => {
  const f = await fixture(true);
  try {
    assert.equal((await f.call('/__local_tiles/mount', 'POST', { path: 22 })).status, 400);
    assert.equal((await f.call('/__local_tiles/mount', 'POST', { path: 'x', extra: 'x' })).status, 400);
    assert.equal((await f.call('/__local_tiles/mount', 'POST', { path: 'x'.repeat(20_000) })).status, 413);
    assert.equal((await f.call(f.url)).status, 200); assert.equal((await (await f.call(f.url)).json()).asset.version, '1.1');
    assert.equal((await f.call(f.url, 'HEAD')).status, 200); assert.equal(await (await f.call(f.url, 'HEAD')).text(), '');
  } finally { await f.close(); }
});

test('local tile midstream failure closes the response/descriptor and leaves later requests usable', async t => {
  const f = await fixture();
  try {
    const handle = await open(join(f.root, 'tile.b3dm'), 'r'), prototype = Object.getPrototypeOf(handle); await handle.close();
    const mocked = t.mock.method(prototype, 'createReadStream', () => Readable.from((async function* () {
      yield Buffer.from('partial'); await new Promise(resolve => setImmediate(resolve)); throw new Error('synthetic disk read failure');
    })()));
    await assert.rejects(async () => { const response = await f.call(f.prefix + 'tile.b3dm'); await response.text(); });
    mocked.mock.restore();
    assert.equal(await (await f.call(f.prefix + 'tile.b3dm')).text(), 'synthetic tile');
  } finally { await f.close(); }
});
