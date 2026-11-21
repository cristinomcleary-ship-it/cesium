import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cartesian3, Cesium3DTileset, ClippingPolygon, ClippingPolygonCollection, Event, Matrix4, type Viewer } from 'cesium';
import { OWNED_FRAGMENT_CLIPPING, PRECISE_FRAGMENT_CLIPPING } from '../ownedClippingPolygons.ts';
import { TemporaryWorksClippingManager, type TemporaryWorksFootprint } from '../temporaryWorksClipping.ts';
import { PreciseClippingPolygonCollection as ActualPreciseCollection } from './preciseClipping.ts';

// Keep Cesium's real collection and all projection/BVH mathematics. Replace only
// its GPU texture allocation boundary so allocation failure is reproducible.
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../..');
const output = join(root, 'output/engineering-photography-cpu'); mkdirSync(output, { recursive: true });
const compiled = join(mkdtempSync(join(output, 'precise-textures-')), 'collection.mjs');
const boundary = `
export {ClippingPolygonCollection,Matrix4,PixelFormat} from ${JSON.stringify(pathToFileURL(resolve(require.resolve('cesium/package.json'), '../Source/Cesium.js')).href)};
export const ContextLimits={maximumTextureSize:4096},PixelDatatype={FLOAT:5126},Sampler={NEAREST:{nearest:true}};
export const allocations=[],control={attempts:0,failAt:0};
export function reset(){allocations.length=0;control.attempts=0;control.failAt=0;ContextLimits.maximumTextureSize=4096;}
export class Texture {
 constructor(options){control.attempts++;if(control.attempts===control.failAt)throw new Error('injected-texture-allocation');this.options=options;this.width=options.width;this.destroyCount=0;allocations.push(this);}
 isDestroyed(){return this.destroyCount>0;}
 destroy(){this.destroyCount++;}
}
`;
const bundled = await build({ stdin: { contents: `export * from './src/engineeringComponents/preciseClipping.ts';export * from 'texture-test-boundary';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24', packages: 'external', plugins: [{ name: 'precise-texture-boundary', setup(builder) {
    builder.onResolve({ filter: /^cesium$|^texture-test-boundary$/ }, () => ({ path: 'texture-boundary', namespace: 'texture-boundary' }));
    builder.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
    builder.onLoad({ filter: /.*/, namespace: 'texture-boundary' }, () => ({ contents: boundary, loader: 'js' }));
  } }] });
writeFileSync(compiled, bundled.outputFiles[0].text);
const code = await import(pathToFileURL(compiled).href);
const polygon = () => new ClippingPolygon({ positions: Cartesian3.fromDegreesArray([121, 31, 121.001, 31, 121.001, 31.001, 121, 31.001]) });
const frame = () => ({ context: {}, camera: { inverseViewMatrix: Matrix4.fromTranslation(Cartesian3.fromDegrees(121, 31, 100)) } });
function resources(collection: object, state = frame()) {
  const calls: unknown[][] = [], shaderBuilder = Object.fromEntries(['addDefine', 'addUniform', 'addVertexLines', 'addFragmentLines']
    .map(name => [name, (...args: unknown[]) => calls.push([name, ...args])]));
  const result = { shaderBuilder, uniformMap: { existing: () => 42 } as Record<string, () => unknown> };
  (collection as Record<string, { process: Function }>)[PRECISE_FRAGMENT_CLIPPING].process(result, {}, state, { BOTH: 3, FRAGMENT: 2 });
  return { result, calls, state };
}

test('precise collection has an immutable explicit opt-in, preserves world rings and evaluates the current camera', () => {
  code.reset(); const source = polygon(), collection = new code.PreciseClippingPolygonCollection([source]);
  try {
    assert.equal(collection.get(0), source); assert.equal(collection.inverse, false);
    assert.equal(Object.hasOwn(collection, OWNED_FRAGMENT_CLIPPING), false, 'construction alone cannot opt an unowned collection into the pipeline');
    const marker = Object.getOwnPropertyDescriptor(collection, PRECISE_FRAGMENT_CLIPPING)!;
    assert.equal(marker.enumerable, false); assert.equal(marker.writable, false); assert.equal(marker.configurable, false);
    assert.equal(Object.isFrozen(marker.value), true);
    const r = resources(collection), map = r.result.uniformMap;
    assert.equal(map.existing(), 42); assert.equal(code.allocations.length, 0);
    const before = Matrix4.clone(map.engineeringClipFromEye() as Matrix4);
    r.state.camera.inverseViewMatrix = Matrix4.fromTranslation(Cartesian3.fromDegrees(121.002, 31, 100));
    assert.equal(Matrix4.equals(before, map.engineeringClipFromEye() as Matrix4), false);
    assert.equal(collection.get(0), source, 'camera movement cannot rewrite source clipping geometry');
  } finally { collection.destroy(); }
});

test('texture allocation is reused across frames and disposal releases each texture exactly once', () => {
  code.reset(); const collection = new code.PreciseClippingPolygonCollection([polygon()]), state = frame();
  const r = resources(collection, state);
  collection.update(state); const initial = [...code.allocations];
  for (let i = 0; i < 12; i++) { collection.update(state); collection.queueCommands(); }
  assert.equal(code.allocations.length, 2); assert.equal(r.result.uniformMap.engineeringClipNodes(), initial[0]);
  assert.equal(r.result.uniformMap.engineeringClipVertices(), initial[1]);
  assert.equal(r.result.uniformMap.engineeringClipNodeWidth(), initial[0].options.width);
  assert.equal(r.result.uniformMap.engineeringClipVertexWidth(), initial[1].options.width);
  for (const texture of initial) {
    assert.equal(texture.options.context, state.context); assert.equal(texture.options.flipY, false);
    assert.equal(texture.options.sampler, code.Sampler.NEAREST);
    assert.equal(texture.options.source.arrayBufferView.every(Number.isFinite), true);
  }
  collection.destroy(); assert.equal(collection.isDestroyed(), true);
  assert.deepEqual(initial.map(texture => texture.destroyCount), [1, 1]);
});

test('uniform uses the current draw inverseView3D ahead of the captured camera and follows later mode/pass updates', () => {
  code.reset(); const collection = new code.PreciseClippingPolygonCollection([polygon()]);
  const state = { ...frame(), context: { uniformState: { inverseView3D: Matrix4.fromTranslation(Cartesian3.fromDegrees(121.003, 31, 120)) } } };
  try {
    const actual = resources(collection, state).result.uniformMap.engineeringClipFromEye;
    const reference = resources(collection, { ...frame(), camera: { inverseViewMatrix: state.context.uniformState.inverseView3D } }).result.uniformMap.engineeringClipFromEye;
    assert.deepEqual(Matrix4.toArray(actual() as Matrix4), Matrix4.toArray(reference() as Matrix4));
    const before = Matrix4.clone(actual() as Matrix4);
    state.camera.inverseViewMatrix = Matrix4.IDENTITY;
    assert.equal(Matrix4.equals(before, actual() as Matrix4), true, 'unrelated frame camera cannot replace the draw camera');
    state.context.uniformState.inverseView3D = Matrix4.fromTranslation(Cartesian3.fromDegrees(121.004, 31.001, 140));
    assert.equal(Matrix4.equals(before, actual() as Matrix4), false, 'the uniform reads the current draw state on every upload');
  } finally { collection.destroy(); }
});

test('failure allocating the second texture releases the first and a retry has no stale resource', () => {
  code.reset(); code.control.failAt = 2;
  const collection = new code.PreciseClippingPolygonCollection([polygon()]), state = frame(), r = resources(collection, state);
  try {
    assert.throws(() => collection.update(state), /injected-texture-allocation/);
    assert.equal(code.allocations.length, 1); assert.equal(code.allocations[0].destroyCount, 1);
    assert.equal(r.result.uniformMap.engineeringClipNodes(), undefined); assert.equal(r.result.uniformMap.engineeringClipVertices(), undefined);
    code.control.failAt = 0; collection.update(state);
    assert.equal(code.allocations.length, 3); assert.equal(r.result.uniformMap.engineeringClipNodes(), code.allocations[1]);
    assert.equal(r.result.uniformMap.engineeringClipVertices(), code.allocations[2]);
  } finally { collection.destroy(); }
  assert.deepEqual(code.allocations.map((texture: { destroyCount: number }) => texture.destroyCount), [1, 1, 1]);
});

test('first allocation or GPU capacity failure creates no live texture and does not prevent explicit retry', () => {
  for (const failure of ['first-allocation', 'capacity']) {
    code.reset(); const collection = new code.PreciseClippingPolygonCollection([polygon()]), state = frame();
    try {
      if (failure === 'capacity') code.ContextLimits.maximumTextureSize = 1; else code.control.failAt = 1;
      assert.throws(() => collection.update(state), /injected-texture-allocation|GPU 容量/);
      assert.equal(code.allocations.length, 0);
      code.control.failAt = 0; code.ContextLimits.maximumTextureSize = 4096; collection.update(state);
      assert.equal(code.allocations.length, 2);
    } finally { collection.destroy(); }
    assert.deepEqual(code.allocations.map((texture: { destroyCount: number }) => texture.destroyCount), [1, 1]);
  }
});

const footprints = (x: number): TemporaryWorksFootprint[] => [{ outer: [
  { longitude: x, latitude: 31 }, { longitude: x + .001, latitude: 31 },
  { longitude: x + .001, latitude: 31.001 }, { longitude: x, latitude: 31.001 },
] }];
function managerFixture() {
  const postUpdate = new Event(), viewer = { scene: { context: { webgl2: true }, postUpdate, requestRender() {} }, isDestroyed: () => false } as unknown as Viewer;
  return { manager: new TemporaryWorksClippingManager(viewer), tileset: new Cesium3DTileset({}), postUpdate };
}
test('only active explicit precise scopes opt in; disabling and disposing engineering restores ordinary legacy clipping', () => {
  const f = managerFixture(), surface = f.manager.createScope('ordinary-surface'), engineering = f.manager.createScope('engineering', { precise: true });
  try {
    f.manager.upsert({ id: 'legacy', tileset: f.tileset, footprints: footprints(121) });
    surface.upsert({ id: 'surface', tileset: f.tileset, footprints: footprints(121.002) });
    const normal = f.tileset.clippingPolygons, originals = [normal.get(0), normal.get(1)];
    assert.equal(Object.hasOwn(normal, PRECISE_FRAGMENT_CLIPPING), false);
    engineering.upsert({ id: 'engineering', tileset: f.tileset, footprints: footprints(121.004) });
    const precise = f.tileset.clippingPolygons;
    assert(precise instanceof ActualPreciseCollection); assert.equal(normal.isDestroyed(), true);
    assert.equal(Object.hasOwn(precise, OWNED_FRAGMENT_CLIPPING), true); assert.equal(precise.length, 3);
    originals.forEach((value, index) => assert.equal(precise.get(index), value));
    engineering.setEnabled(false);
    assert.equal(precise.isDestroyed(), true); assert.equal(Object.hasOwn(f.tileset.clippingPolygons, PRECISE_FRAGMENT_CLIPPING), false);
    originals.forEach((value, index) => assert.equal(f.tileset.clippingPolygons.get(index), value));
    engineering.setEnabled(true); assert(f.tileset.clippingPolygons instanceof ActualPreciseCollection);
    const resumed = f.tileset.clippingPolygons; engineering.dispose();
    assert.equal(resumed.isDestroyed(), true); assert.equal(Object.hasOwn(f.tileset.clippingPolygons, PRECISE_FRAGMENT_CLIPPING), false);
    assert.equal(f.tileset.clippingPolygons.inverse, false); assert.equal(f.tileset.clippingPolygons.length, 2);
    assert.equal(f.manager.getStatus('legacy')?.state, 'active'); assert.equal(surface.getStatus('surface')?.state, 'active');
    surface.dispose(); f.manager.clear(); assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { engineering.dispose(); surface.dispose(); f.manager.dispose(); f.tileset.destroy(); }
});

test('precise scope respects a foreign inverse owner and refuses externally inverted owned clipping', () => {
  const f = managerFixture(), engineering = f.manager.createScope('engineering', { precise: true });
  const foreign = new ClippingPolygonCollection({ polygons: [polygon()], inverse: true });
  try {
    f.tileset.clippingPolygons = foreign;
    engineering.upsert({ id: 'engineering', tileset: f.tileset, footprints: footprints(121) });
    assert.equal(f.tileset.clippingPolygons, foreign); assert.equal(foreign.inverse, true);
    assert.equal(engineering.getStatus('engineering')?.state, 'blocked');
    (f.tileset as unknown as { clippingPolygons: ClippingPolygonCollection | undefined }).clippingPolygons = undefined;
    f.manager.synchronize(); const own = f.tileset.clippingPolygons;
    assert(own instanceof ActualPreciseCollection); own.inverse = true; f.manager.synchronize();
    assert.equal(own.isDestroyed(), true); assert.equal(f.tileset.clippingPolygons, undefined);
    assert.equal(engineering.getStatus('engineering')?.state, 'blocked');
    f.manager.synchronize(); assert.equal(f.tileset.clippingPolygons, undefined, 'external inversion is never silently re-enabled');
  } finally { engineering.dispose(); f.manager.dispose(); f.tileset.destroy(); }
});
