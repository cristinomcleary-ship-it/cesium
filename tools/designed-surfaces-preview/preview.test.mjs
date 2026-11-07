import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOptions, assetNameForRequest, resolveAssetFile, requestPolicy } from './server.mjs';
import { syntheticRoadDxf, syntheticGround, syntheticMaterials, syntheticTileset } from './fixtures.mjs';

test('configuration stays on loopback and cannot reuse the production port', () => {
  assert.equal(parseOptions([]).host, '127.0.0.1');
  assert.equal(parseOptions([]).port, 5288);
  assert.equal(parseOptions(['--port', '5299']).port, 5299);
  for (const port of ['5173', '0', '-1', '90000', 'NaN', '5288.1']) assert.throws(() => parseOptions(['--port', port]));
  assert.throws(() => parseOptions(['--host', '0.0.0.0']));
  assert.throws(() => parseOptions(['--assets']));
});

test('help does not read private resources or start a listener', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--help', '--assets', '/not-an-existing-private-directory'], { encoding: 'utf8', timeout: 10000 });
  assert.match(output, /Usage:/); assert.match(output, /127\.0\.0\.1/);
});

test('only exact runtime file names survive URL parsing', () => {
  assert.equal(assetNameForRequest('/models/temporary-works/camp.glb?v=abc'), 'camp.glb');
  for (const url of ['/models/temporary-works/../secret', '/models/temporary-works/%2e%2e/secret',
    '/models/temporary-works/%2fcamp.glb', '/models/temporary-works/folder/camp.glb',
    '/models/temporary-works/branding-mapping.json', '/models/temporary-works/%invalid', '/secret'])
    assert.equal(assetNameForRequest(url), undefined, url);
});

test('asset reads reject links outside the supplied resource directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-preview-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets'); await fs.mkdir(assets);
  await fs.writeFile(path.join(assets, 'camp.glb'), 'synthetic placeholder');
  const entry = await resolveAssetFile(assets, 'camp.glb');
  assert.equal(entry.size, 21);
  await assert.rejects(resolveAssetFile(assets, '../secret'));
  await fs.mkdir(path.join(assets, 'wall.glb'));
  await assert.rejects(resolveAssetFile(assets, 'wall.glb'), /普通文件/);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  // A directory junction requires no Windows symlink privilege. The asset name is
  // intentionally a directory to prove realpath escape is checked before stat.
  await fs.symlink(outside, path.join(assets, 'steel.glb'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveAssetFile(assets, 'steel.glb'), /目录之外/);
});

test('all mutation verbs and production API paths are rejected', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(requestPolicy(method, '/anything'), 405);
  assert.equal(requestPolicy('GET', '/api/projects'), 404);
  assert.equal(requestPolicy('HEAD', '/api?x=1'), 404);
  for (const prefix of ['__management', '__library', '__safety']) assert.equal(requestPolicy('GET', `/${prefix}/items`), 404);
  assert.equal(requestPolicy('GET', '/fixtures/ground.gltf'), 0);
});

test('the generated CAD uses real line breaks and a complete open polyline', () => {
  const dxf = syntheticRoadDxf();
  assert.ok(!dxf.includes('\\n'));
  const lines = dxf.trim().split('\n'); assert.equal(lines.length % 2, 0);
  assert.deepEqual(lines.slice(0, 4), ['0', 'SECTION', '2', 'ENTITIES']);
  assert.deepEqual(lines.slice(-4), ['0', 'ENDSEC', '0', 'EOF']);
  assert.equal(lines.filter((line, i) => i % 2 === 0 && line === '10').length, 4);
  assert.ok(dxf.includes('70\n0\n'));
});

test('synthetic geometry buffers and primitive counts are internally valid', () => {
  for (const gltf of [syntheticGround(), syntheticMaterials()]) {
    const bytes = Buffer.from(gltf.buffers[0].uri.split(',')[1], 'base64');
    assert.equal(bytes.length, gltf.buffers[0].byteLength);
    for (const view of gltf.bufferViews) assert.ok(view.byteOffset + view.byteLength <= bytes.length);
    for (const primitive of gltf.meshes[0].primitives) {
      const positions = gltf.accessors[primitive.attributes.POSITION];
      assert.equal(positions.count % 3, 0);
      assert.ok(positions.min.every(Number.isFinite) && positions.max.every(Number.isFinite));
    }
  }
  const samples = syntheticMaterials();
  assert.equal(samples.meshes[0].primitives.length, 5);
  assert.equal(samples.materials[3].alphaMode, 'BLEND');
  assert.ok(samples.materials[2].extensions.KHR_materials_pbrSpecularGlossiness);
  assert.equal(samples.meshes[0].primitives[4].attributes.NORMAL, undefined);
});

test('synthetic tileset references only its generated local ground', () => {
  const fixture = syntheticTileset({ Cartesian3: { fromDegrees: (...values) => values },
    Transforms: { eastNorthUpToFixedFrame: () => Array.from({ length: 16 }, (_, i) => i % 5 === 0 ? 1 : 0) },
    Matrix4: { toArray: value => value } });
  assert.equal(fixture.root.content.uri, 'ground.gltf');
  assert.equal(fixture.root.transform.length, 16);
});

test('synthetic ground passes Cesium root traversal SSE while remaining a zero-error leaf', async () => {
  const C = await import('cesium');
  const fixture = syntheticTileset(C);
  const tile = Object.assign(Object.create(C.Cesium3DTile.prototype), {
    _tileset: { _scaledGeometricError: fixture.geometricError, dynamicScreenSpaceError: false },
    geometricError: fixture.root.geometricError,
  });
  const frame = {
    mode: C.SceneMode.SCENE3D, pixelRatio: 1,
    camera: { frustum: { sseDenominator: 2 } },
    context: { drawingBufferWidth: 1280, drawingBufferHeight: 720 },
  };
  // BaseTraversal rejects the whole tileset when this parent-error SSE is <= 2,
  // the preview's maximumScreenSpaceError. Exercise the installed engine method.
  for (const distance of [320, 410, 2000]) {
    tile._distanceToCamera = distance;
    assert.ok(tile.getScreenSpaceError(frame, true) > 2, `ground must be requested at ${distance} m`);
    assert.equal(tile.getScreenSpaceError(frame, false), 0, 'the full-resolution ground remains a leaf');
  }
  tile._tileset._scaledGeometricError = 0;
  assert.equal(tile.getScreenSpaceError(frame, true), 0, 'the old fixture was rejected before loading ground.gltf');
});
