import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cartesian3, ClippingPolygon, Intersect, Matrix4 } from 'cesium';
import { buildContactGeometry } from './geometry.ts';
import { OWNED_FRAGMENT_CLIPPING, PRECISE_FRAGMENT_CLIPPING } from '../ownedClippingPolygons.ts';

// Replace allocation only. Cesium's real ownership/collection classes, matrix
// math, legacy ring projection and new contact geometry remain under test.
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../..');
const output = join(root, 'output/model-contact-cpu'); mkdirSync(output, { recursive: true });
const compiled = join(mkdtempSync(join(output, 'contact-textures-')), 'collection.mjs');
const boundary = `
export * from ${JSON.stringify(pathToFileURL(resolve(require.resolve('cesium/package.json'), '../Source/Cesium.js')).href)};
export const ContextLimits={maximumTextureSize:4096},PixelDatatype={FLOAT:5126},Sampler={NEAREST:{nearest:true}};
export const allocations=[],control={attempts:0,failAt:0};
export function reset(){allocations.length=0;control.attempts=0;control.failAt=0;ContextLimits.maximumTextureSize=4096;}
export class Texture {
 constructor(options){control.attempts++;if(control.attempts===control.failAt)throw new Error('injected-texture-allocation');this.options=options;this.width=options.width;this.destroyCount=0;allocations.push(this);}
 isDestroyed(){return this.destroyCount>0;}
 destroy(){this.destroyCount++;}
}
`;
const bundled = await build({ stdin: { contents: `export * from './src/modelContactOcclusion/clipping.ts';export * from 'texture-test-boundary';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24', packages: 'external', plugins: [{ name: 'contact-texture-boundary', setup(builder) {
    builder.onResolve({ filter: /^cesium$|^texture-test-boundary$/ }, () => ({ path: 'texture-boundary', namespace: 'texture-boundary' }));
    builder.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
    builder.onLoad({ filter: /.*/, namespace: 'texture-boundary' }, () => ({ contents: boundary, loader: 'js' }));
  } }] });
writeFileSync(compiled, bundled.outputFiles[0].text);
const code = await import(pathToFileURL(compiled).href);
const geometry = () => buildContactGeometry({ primitives: [{ groupId: 'surface', nodeIndex: 0, positions: Float64Array.from([-1, -1, 4, 1, -1, 4, 0, 1, 4]), indices: Uint32Array.from([0, 1, 2]) }], worldFromLocal: Matrix4.toArray(Matrix4.IDENTITY) });
const volume = () => ({ geometry: geometry(), worldFromLocal: Matrix4.toArray(Matrix4.fromTranslation(Cartesian3.fromDegrees(121, 31, 100))) });
const polygon = () => new ClippingPolygon({ positions: Cartesian3.fromDegreesArray([121, 31, 121.001, 31, 121.001, 31.001, 121, 31.001]) });
const frame = () => ({ context: { uniformState: { inverseView3D: Matrix4.IDENTITY, model: Matrix4.fromTranslation(Cartesian3.fromDegrees(121, 31, 100)) } }, camera: { inverseViewMatrix: Matrix4.fromTranslation(Cartesian3.fromDegrees(121, 31, 100)) } });
function resources(collection: object, state = frame(), model: object = {}) {
  const calls: unknown[][] = [], shaderBuilder = Object.fromEntries(['addDefine', 'addUniform', 'addVertexLines', 'addFragmentLines'].map(name => [name, (...args: unknown[]) => calls.push([name, ...args])]));
  const result = { shaderBuilder, uniformMap: { existing: () => 42 } as Record<string, () => unknown> };
  (collection as Record<string, { process: Function }>)[PRECISE_FRAGMENT_CLIPPING].process(result, model, state, { BOTH: 3, FRAGMENT: 2 });
  return { result, calls };
}

test('volume-only collection activates the pinned stage without adding any 2D proxy polygon', () => {
  code.reset(); const collection = new code.ContactClippingPolygonCollection([], [volume()]);
  try {
    assert.equal(collection.length, 1); assert.equal(collection.get(0), undefined);
    assert.equal(collection.inverse, false); assert.equal(Object.hasOwn(collection, OWNED_FRAGMENT_CLIPPING), false);
    const marker = Object.getOwnPropertyDescriptor(collection, PRECISE_FRAGMENT_CLIPPING)!;
    assert.equal(marker.writable, false); assert.equal(marker.configurable, false); assert.equal(Object.isFrozen(marker.value), true);
    assert.equal(collection.computeIntersectionWithBoundingVolume({ rectangle: { west: 0, east: 1, north: 1, south: 0 } }), Intersect.INTERSECTING);
    assert.equal(collection.computeIntersectionWithBoundingVolume({ boundingSphere: { center: new Cartesian3(), radius: 1e9 } }), Intersect.INTERSECTING);
    assert.equal(resources(collection).result.uniformMap.existing(), 42);
  } finally { collection.destroy(); }
});

test('shared legacy polygons remain unchanged and receive their own predicate, separate from volume geometry', () => {
  code.reset(); const legacy = polygon(), collection = new code.ContactClippingPolygonCollection([legacy], [volume()]);
  const original = legacy.positions.map(p => Cartesian3.clone(p));
  try {
    assert.equal(collection.get(0), legacy);
    const r = resources(collection), fragment = r.calls.filter(x => x[0] === 'addFragmentLines').map(x => String(x[1])).join('\n');
    assert.equal((fragment.match(/void modelClippingPolygonsStage\(/g) ?? []).length, 1);
    assert.match(fragment, /void contactLegacyClip\(\)/); assert.match(fragment, /contactLegacyClip\(\);/);
    assert.match(fragment, /contactModelContains\(/); assert.equal(r.result.uniformMap.engineeringClipFromEye instanceof Function, true);
    collection.prepare({}); assert.equal(code.allocations.length, 5);
    assert.deepEqual(legacy.positions, original);
  } finally { collection.destroy(); }
  assert.deepEqual(code.allocations.map((t: { destroyCount: number }) => t.destroyCount), [1, 1, 1, 1, 1]);
});

test('multiple models share three geometry textures while retaining distinct poses and complete triangle arrays', () => {
  code.reset(); const first = volume(), second = volume(); second.worldFromLocal[12] += 20;
  const before = first.geometry.triangles.slice(), collection = new code.ContactClippingPolygonCollection([], [first, second]);
  try {
    const r = resources(collection); collection.prepare({});
    assert.equal(code.allocations.length, 3); assert.deepEqual(first.geometry.triangles, before);
    assert.notDeepEqual(Matrix4.toArray(r.result.uniformMap.contactFromModel0() as Matrix4), Matrix4.toArray(r.result.uniformMap.contactFromModel1() as Matrix4));
    assert.equal(code.allocations[1].options.source.arrayBufferView.length, first.geometry.triangles.length + second.geometry.triangles.length);
    const a = Matrix4.clone(r.result.uniformMap.contactFromModel0() as Matrix4);
    first.worldFromLocal[12] += 999; assert.equal(Matrix4.equals(a, r.result.uniformMap.contactFromModel0() as Matrix4), true, 'published contribution snapshots the pose');
    for (let i = 0; i < 20; i++) { collection.update(frame()); collection.queueCommands(); }
    assert.equal(code.allocations.length, 3);
  } finally { collection.destroy(); }
  assert.deepEqual(code.allocations.map((t: { destroyCount: number }) => t.destroyCount), [1, 1, 1]);
});

test('draw transform maps photography model coordinates directly to engineering local space without any camera cancellation', () => {
  code.reset(); const v = volume(), collection = new code.ContactClippingPolygonCollection([], [v]);
  const state = frame(); state.context.uniformState.model = Matrix4.fromArray(v.worldFromLocal);
  try {
    const r = resources(collection, state), map = r.result.uniformMap;
    const transformed = Matrix4.multiplyByPoint(map.contactFromModel0() as Matrix4, new Cartesian3(0, 0, 4), new Cartesian3());
    assert(Cartesian3.magnitude(transformed) < 1e-8);
    const before = Matrix4.clone(map.contactFromModel0() as Matrix4); state.camera.inverseViewMatrix = Matrix4.IDENTITY;
    state.context.uniformState.inverseView3D = Matrix4.fromTranslation(new Cartesian3(1e8, -1e8, 1e8));
    assert.equal(Matrix4.equals(before, map.contactFromModel0() as Matrix4), true, 'near, far, or oblique camera cannot change geometric classification');
    const fragment = r.calls.filter(call => call[0] === 'addFragmentLines').map(call => String(call[1])).join('\n');
    assert.match(fragment, /contactFromModel0 \* vec4\(v_positionMC,1.0\)/); assert.doesNotMatch(fragment, /v_positionEC/);
    state.context.uniformState.model = Matrix4.multiplyByTranslation(state.context.uniformState.model, new Cartesian3(1, 2, 3), new Matrix4());
    assert.equal(Matrix4.equals(before, map.contactFromModel0() as Matrix4), false, 'moving the photograph updates its actual geometry');
  } finally { collection.destroy(); }
});

test('legacy i3dm uses its modified root because instance axis and node transforms are already present in positionMC', () => {
  code.reset(); const v = volume(), collection = new code.ContactClippingPolygonCollection([], [v]);
  const model = { modelMatrix: Matrix4.fromArray(v.worldFromLocal), sceneGraph: { components: { transform: Matrix4.fromTranslation(new Cartesian3(2, 3, 4)) } } };
  try {
    const state = frame(), map = resources(collection, state, model).result.uniformMap;
    const expected = Matrix4.multiplyByPoint(map.contactFromLegacyModel0() as Matrix4, new Cartesian3(1, 1, 1), new Cartesian3());
    assert(Cartesian3.distance(expected, new Cartesian3(3, 4, 1)) < 1e-8);
    state.context.uniformState.model = Matrix4.fromTranslation(new Cartesian3(100, 200, 300));
    assert(Cartesian3.distance(expected, Matrix4.multiplyByPoint(map.contactFromLegacyModel0() as Matrix4, new Cartesian3(1, 1, 1), new Cartesian3())) < 1e-8);
  } finally { collection.destroy(); }
});

test('failure at each geometry or legacy allocation releases all partial textures and allows a complete retry', () => {
  for (let failAt = 1; failAt <= 5; failAt++) {
    code.reset(); code.control.failAt = failAt;
    const collection = new code.ContactClippingPolygonCollection([polygon()], [volume()]);
    try {
      assert.throws(() => collection.prepare({}), /injected-texture-allocation/);
      assert(code.allocations.every((t: { destroyCount: number }) => t.destroyCount === 1));
      const r = resources(collection); assert.equal(r.result.uniformMap.contactNodes(), undefined);
      code.control.failAt = 0; collection.prepare({}); assert(r.result.uniformMap.contactNodes());
    } finally { collection.destroy(); }
    assert(code.allocations.every((t: { destroyCount: number }) => t.destroyCount === 1));
  }
});

test('GPU capacity and incomplete/singular inputs fail without publishing approximations', () => {
  code.reset(); code.ContextLimits.maximumTextureSize = 1;
  const collection = new code.ContactClippingPolygonCollection([], [volume()]);
  try { assert.throws(() => collection.prepare({}), /GPU 容量/); assert.equal(code.allocations.length, 0); }
  finally { collection.destroy(); }
  assert.throws(() => new code.ContactClippingPolygonCollection([], []), /1–32/);
  const bad = volume(); bad.geometry.stats.sourceTriangles++;
  assert.throws(() => new code.ContactClippingPolygonCollection([], [bad]), /不完整/);
  const singular = volume(); singular.worldFromLocal[0] = singular.worldFromLocal[5] = singular.worldFromLocal[10] = 0;
  assert.throws(() => new code.ContactClippingPolygonCollection([], [singular]), /不可逆/);
});
