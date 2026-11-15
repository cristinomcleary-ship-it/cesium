import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRenderDiagnosticsMiddleware, redactRenderErrorDetails } from './renderDiagnostics.ts';
import { setManagementActor } from './management/actorContext.ts';
import type { Actor } from './management/domain.ts';

const report = () => ({ occurredAt: '2026-11-15T12:00:00.000Z', details: 'RuntimeError: object was destroyed\n at render (https://site.test/main.js?token=private-token:12)',
  cesiumVersion: '1.144.0', activeModule: 'model', canvas: { width: 800, height: 600, clientWidth: 800, clientHeight: 600 },
  camera: { longitude: 116.123456, latitude: 31.123456, height: 123.456 },
  layers: [{ id: 'private-project-id', name: 'Private Structure', kind: 'Model', visible: true, destroyed: false }],
  sectionEnabled: false, excavationClippingEnabled: true });
const actors: Record<string, Actor> = {
  owner: { id: 'owner', displayName: 'Owner', roles: ['owner'], permissions: ['read', 'admin'], authMode: 'local-account' },
  reader: { id: 'reader', displayName: 'Reader', roles: ['viewer'], permissions: ['read'], authMode: 'local-account', taskIds: ['one'] },
  second: { id: 'second', displayName: 'Second', roles: ['viewer'], permissions: ['read'], authMode: 'local-account' },
};
async function fixture(limits = {}, clock?: () => number) {
  const root = await mkdtemp(join(tmpdir(), 'cesium-diagnostic-test-'));
  const middleware = createRenderDiagnosticsMiddleware({ root, limits, now: clock });
  const server = createServer((req, res) => {
    const actor = actors[String(req.headers['x-test-actor'])]; if (actor) setManagementActor(req, actor);
    void middleware(req, res, () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, method = 'GET', value?: unknown, actor = 'owner', extra: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { 'x-test-actor': actor, 'content-type': 'application/json', ...extra }, body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { root, base, call, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
const post = '/__diagnostics/render-error', latest = post + '/latest';

test('current render-error client payload succeeds; only server identity may write/read and responses remain private', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(post, 'POST', report(), '')).status, 401);
    assert.equal((await f.call(post, 'POST', { ...report(), role: 'owner' }, '')).status, 401);
    assert.equal((await f.call(post, 'POST', report(), 'reader', { origin: f.base })).status, 200, 'task reader can report own rendering failures with the unchanged browser payload');
    assert.equal((await f.call(latest, 'GET', undefined, 'reader')).status, 403);
    const response = await f.call(latest);
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /private.*no-store/);
    assert.equal(response.headers.get('vary'), 'Cookie'); assert.equal(response.headers.get('access-control-allow-origin'), null);
    const body = await response.json(); assert.match(body.details, /object was destroyed/); assert.equal(body.layers[0].visible, true);
    for (const secret of ['private-token', 'private-project-id', 'Private Structure', '116.123456', '31.123456', '123.456']) {
      assert.ok(!JSON.stringify(body).includes(secret), secret);
      assert.ok(!(await readFile(join(f.root, 'latest.json'), 'utf8')).includes(secret), secret);
    }
    assert.equal((await f.call(latest, 'HEAD')).status, 200);
    assert.equal(await (await f.call(latest, 'HEAD')).text(), '');
  } finally { await f.close(); }
});

test('diagnostics reject foreign source, wrong methods, invalid JSON schema, malformed types and unknown fields', async () => {
  const f = await fixture();
  try {
    for (const headers of [{ origin: 'https://evil.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])
      assert.equal((await f.call(post, 'POST', report(), 'owner', headers)).status, 403);
    assert.equal((await f.call(post)).status, 405);
    assert.equal((await f.call(latest, 'DELETE')).status, 405);
    assert.equal((await f.call(post, 'POST', report(), 'owner', { 'content-type': 'text/plain' })).status, 415);
    for (const value of [{}, { ...report(), token: 'secret' }, { ...report(), camera: { longitude: '1', latitude: 2, height: 3 } }, { ...report(), layers: [null] }])
      assert.equal((await f.call(post, 'POST', value)).status, 400);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('diagnostics byte limit rejects valid JSON prefix plus oversized trailing chunk without replacing latest', async () => {
  const f = await fixture({ bodyBytes: 2048 });
  try {
    assert.equal((await f.call(post, 'POST', report())).status, 200);
    const before = await readFile(join(f.root, 'latest.json'), 'utf8');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(f.base + post, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-actor': 'owner' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      }); req.on('error', reject); req.write(JSON.stringify(report())); req.end(' '.repeat(3000));
    });
    assert.equal(status, 413);
    assert.equal(await readFile(join(f.root, 'latest.json'), 'utf8'), before);
  } finally { await f.close(); }
});

test('diagnostic rate budgets apply per actor and globally and expire without accumulating actor entries', async () => {
  let time = Date.now(); const f = await fixture({ actorPerMinute: 2, totalPerMinute: 3 }, () => time);
  try {
    assert.equal((await f.call(post, 'POST', report())).status, 200);
    assert.equal((await f.call(post, 'POST', report())).status, 200);
    const denied = await f.call(post, 'POST', report()); assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '60');
    assert.equal((await f.call(post, 'POST', report(), 'reader')).status, 200);
    assert.equal((await f.call(post, 'POST', report(), 'second')).status, 429);
    time += 60_001;
    assert.equal((await f.call(post, 'POST', report())).status, 200);
  } finally { await f.close(); }
});

test('diagnostic retention bounds total files and bytes and removes only owned expired history', async () => {
  let time = Date.now(); const f = await fixture({ records: 4, retainedBytes: 5000 }, () => time);
  try {
    await writeFile(join(f.root, `${time - 8 * 86400_000}.json`), 'expired');
    await writeFile(join(f.root, 'operator-note.txt'), 'preserve this file');
    for (let i = 0; i < 8; i++) {
      time += 60_001; assert.equal((await f.call(post, 'POST', report())).status, 200);
      const files = await readdir(f.root); assert.ok(files.length <= 4);
      const sizes = await Promise.all(files.map(file => stat(join(f.root, file)).then(v => v.size)));
      assert.ok(sizes.reduce((a, b) => a + b, 0) <= 5000);
    }
    assert.equal(await readFile(join(f.root, 'operator-note.txt'), 'utf8'), 'preserve this file');
  } finally { await f.close(); }
});

test('legacy latest is sanitized on read without rewriting it; storage symlinks are not followed', async () => {
  const f = await fixture();
  try {
    const old = JSON.stringify(report()); await writeFile(join(f.root, 'latest.json'), old);
    assert.ok(!(await (await f.call(latest)).text()).includes('private-token'));
    assert.equal(await readFile(join(f.root, 'latest.json'), 'utf8'), old);
    await rm(join(f.root, 'latest.json'));
    const outside = join(f.root, 'private.txt'); await writeFile(outside, old);
    await symlink(outside, join(f.root, 'latest.json'));
    assert.equal((await f.call(latest)).status, 503);
    assert.equal((await f.call(post, 'POST', report())).status, 503);
    assert.equal(await readFile(outside, 'utf8'), old);
  } finally { await f.close(); }
});

test('diagnostic redaction strips URL credentials/query, local paths, bearer/cookie and email', () => {
  const value = redactRenderErrorDetails('Error https://user:password@host/private?a=token\n C:\\private folder\\model.glb\n /home/user/model.glb\n Authorization=Bearer sensitive-token\n cookie=session-secret; second=private-cookie\n {"token":"private-json-token"}\n user@example.test');
  for (const secret of ['password', 'private', 'sensitive-token', 'session-secret', 'example.test']) assert.ok(!value.includes(secret), value);
});

test('diagnostic disconnect during JSON and after byte rejection never stores a partial report or crashes subsequent requests', async () => {
  const f = await fixture({ bodyBytes: 2048 });
  try {
    const destroyBody = (oversized: boolean) => new Promise<void>((resolve, reject) => {
      const req = request(f.base + post, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-actor': 'owner' } }, response => {
        if (!oversized) return reject(new Error('partial request unexpectedly completed'));
        assert.equal(response.statusCode, 413); response.resume(); req.destroy(); resolve();
      });
      req.on('error', error => { if (!req.destroyed) reject(error); });
      req.write(oversized ? JSON.stringify(report()) + ' '.repeat(3000) : '{"details":"unfinished');
      if (!oversized) setTimeout(() => { req.destroy(); resolve(); }, 10);
    });
    await destroyBody(false); await destroyBody(true);
    assert.deepEqual(await readdir(f.root), []);
    const imagery = report(); imagery.layers[0].kind = 'Imagery';
    assert.equal((await f.call(post, 'POST', imagery)).status, 200);
    assert.equal((await f.call(latest)).status, 200);
  } finally { await f.close(); }
});
