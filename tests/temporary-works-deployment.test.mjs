import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyTemporaryWorksDeployment } from '../tools/verify-temporary-works-deployment.mjs';

const sha256 = content => createHash('sha256').update(content).digest('hex');
async function fixture(t, base = '/') {
  const directory = await mkdtemp(join(tmpdir(), 'temporary-works-http-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new Map();
  const assets = ['camp', 'steel', 'wall'].map((id, i) => {
    // Synthetic test bytes only; this verifier checks deployment identity. The
    // existing installer's --check separately verifies real GLB structure.
    const content = Buffer.alloc(64 * 1024 + i, i + 1);
    files.set(`${id}.glb`, content);
    return { id, name: id, url: `models/temporary-works/${id}.glb`, upAxis: 'Y',
      bounds: { min: [0, 0, 0], max: [2, 3, 4] }, anchor: [1, 0, 2],
      dimensions: { length: 2, width: 4, height: 3 },
      footprints: [{ outer: [[0, 0], [2, 0], [2, 4], [0, 4]] }],
      bytes: content.length, sha256: sha256(content) };
  });
  const logo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  files.set('cr24-logo.png', logo);
  files.set('manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, unit: 'metre', assets,
    logo: { url: 'models/temporary-works/cr24-logo.png', bytes: logo.length, sha256: sha256(logo) } })));
  for (const [filename, bytes] of files) await writeFile(join(directory, filename), bytes);
  const state = { mode: 'valid', requests: [] };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    state.requests.push(path);
    const filename = path.startsWith(`${base}models/temporary-works/`) ? path.split('/').pop() : '';
    let bytes = files.get(filename);
    if (!bytes || state.mode === '404') { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
    if (state.mode === 'html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html>SPA</html>'); return; }
    const mime = filename.endsWith('.json') ? 'application/json' : filename.endsWith('.glb') ? 'model/gltf-binary' : 'image/png';
    response.setHeader('Content-Type', state.mode === 'wrong-mime' ? 'text/plain' : mime);
    if (filename === 'manifest.json' && state.mode === 'invalid-json') bytes = Buffer.from('<!doctype html>');
    if (filename === 'manifest.json' && state.mode === 'different-manifest') bytes = Buffer.concat([bytes, Buffer.from('\n')]);
    if (filename === 'camp.glb') {
      if (state.mode === 'different-glb') { bytes = Buffer.from(bytes); bytes[0] ^= 1; }
      if (state.mode === 'too-long') bytes = Buffer.concat([bytes, Buffer.from([0])]);
      if (state.mode === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
    }
    // Chunked response proves the verifier hashes the stream, without requiring
    // Content-Length or storing a downloaded model beside the original files.
    for (let i = 0; i < bytes.length; i += 4096) response.write(bytes.subarray(i, i + 4096));
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { directory, files, state, origin: `http://127.0.0.1:${server.address().port}${base}` };
}

test('HTTP deployment check streams the original three GLBs and logo and does not write any files', async t => {
  const f = await fixture(t);
  const before = await readdir(f.directory);
  const result = await verifyTemporaryWorksDeployment(f);
  assert.deepEqual(result, { ok: true, assets: 3, files: 5,
    bytes: [...f.files.values()].reduce((sum, bytes) => sum + bytes.length, 0), readOnly: true });
  assert.equal(f.state.requests.length, 5);
  assert.deepEqual(await readdir(f.directory), before);
  for (const [filename, bytes] of f.files) assert.deepEqual(await readFile(join(f.directory, filename)), bytes);
});

test('HTTP deployment check preserves nested service base URLs', async t => {
  const f = await fixture(t, '/cesium/');
  assert.equal((await verifyTemporaryWorksDeployment(f)).files, 5);
  assert.ok(f.state.requests.every(path => path.startsWith('/cesium/models/temporary-works/')));
});

test('missing packages, SPA HTML, invalid JSON and wrong MIME types block deployment acceptance', async t => {
  const f = await fixture(t);
  for (const [mode, message] of [['404', /HTTP 404/], ['html', /HTML/], ['invalid-json', /有效 JSON/], ['wrong-mime', /MIME/]]) {
    f.state.mode = mode;
    await assert.rejects(verifyTemporaryWorksDeployment(f), message);
  }
});

test('manifest changes, GLB hash changes, truncated bytes and oversized responses cannot pass', async t => {
  const f = await fixture(t);
  for (const [mode, message] of [['different-manifest', /清单.*不一致/], ['different-glb', /SHA-256 不一致/],
    ['truncated', /SHA-256 不一致/], ['too-long', /长度超出/]]) {
    f.state.mode = mode;
    await assert.rejects(verifyTemporaryWorksDeployment(f), message);
  }
});

test('local package corruption fails before accepting matching served bytes and does not leak its path', async t => {
  const f = await fixture(t);
  const altered = Buffer.from(f.files.get('camp.glb')); altered[0] ^= 1;
  await writeFile(join(f.directory, 'camp.glb'), altered);
  await assert.rejects(verifyTemporaryWorksDeployment(f), error => /原临建资源.*SHA-256/.test(error.message) && !error.message.includes(f.directory));
  await rm(join(f.directory, 'camp.glb'));
  await assert.rejects(verifyTemporaryWorksDeployment(f), error => /本机临建资源读取/.test(error.message) && !error.message.includes(f.directory));
});

test('CLI produces a concise success summary and a failing exit code for a missing package without private paths', async t => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('../tools/verify-temporary-works-deployment.mjs', import.meta.url));
  const args = [script, '--origin', f.origin, '--directory', f.directory];
  const good = await promisify(execFile)(process.execPath, args);
  assert.equal(JSON.parse(good.stdout).files, 5);
  assert.ok(!good.stdout.includes(f.directory));
  f.state.mode = 'html';
  await assert.rejects(promisify(execFile)(process.execPath, args), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).ok, false);
    assert.ok(!error.stderr.includes(f.directory));
    return true;
  });
});
