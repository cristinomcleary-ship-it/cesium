import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTemporaryWorksGlbManifest, type TemporaryWorksGlbManifest } from './temporaryWorksGlb.ts';

test('private manifest failures retry the same URL and recover the original resources without a page reload', async (t) => {
  const manifest: TemporaryWorksGlbManifest = { schemaVersion: 1, assets: [{
    id: 'camp', name: '已核验临建', url: 'models/temporary-works/camp.glb', upAxis: 'Y',
    bounds: { min: [100, 7, 200], max: [120, 12, 210] }, anchor: [110, 7, 205],
    dimensions: { length: 20, width: 10, height: 5 },
    footprints: [{ outer: [[100, 200], [120, 200], [120, 210], [100, 210]] }],
    sourceSha256: '0123456789abcdef'.repeat(4),
  }] };
  const requests: { url: string; cache?: RequestCache }[] = [];
  let response = new Response('<!doctype html><html><body>Cesium application</body></html>', {
    status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    requests.push({ url: String(url), cache: options?.cache });
    return response;
  });

  await assert.rejects(loadTemporaryWorksGlbManifest(), /返回了网页.*原有临建资源包/);
  response = new Response('<!doctype html><html>fallback without MIME header</html>', { status: 200 });
  await assert.rejects(loadTemporaryWorksGlbManifest(), /返回了网页/);
  response = new Response('{"error":"missing private resource"}', {
    status: 404, headers: { 'Content-Type': 'application/json' },
  });
  await assert.rejects(loadTemporaryWorksGlbManifest(), /HTTP 404.*原有临建资源包/);
  response = new Response('{"schemaVersion":', { status: 200, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(loadTemporaryWorksGlbManifest(), /不是有效的 JSON/);
  response = new Response('null', { status: 200 });
  await assert.rejects(loadTemporaryWorksGlbManifest(), /不支持的临建资源清单版本/);

  // Reconnecting the existing private package must restore the actual dimensions,
  // footprint and hash; never manufacture replacement models on the error path.
  response = new Response(JSON.stringify(manifest), { status: 200 });
  const concurrent = [loadTemporaryWorksGlbManifest(), loadTemporaryWorksGlbManifest()];
  assert.equal(concurrent[0], concurrent[1]);
  const [restored] = await Promise.all(concurrent);
  assert.deepEqual(restored, manifest);
  assert.equal(await loadTemporaryWorksGlbManifest(), restored);
  assert.equal(requests.length, 6);
  assert.ok(requests.every(request => request.url === '/models/temporary-works/manifest.json' && request.cache === 'no-store'));
});
