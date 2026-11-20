import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Cartesian3, Cesium3DTileset, Matrix3, Matrix4, Resource, Transforms } from 'cesium';
import { tilesetClippingFrame } from './tilesetClippingFrame.ts';

type EngineTileset = Cesium3DTileset & {
  _initialClippingPlanesOriginMatrix: Matrix4;
  _clippingPlanesOriginMatrixDirty: boolean;
  clippingPlanesOriginMatrix: Matrix4;
};
const center = Cartesian3.fromDegrees(121, 31, 20);
const worldFrame = Transforms.eastNorthUpToFixedFrame(center);
function near(actual: Matrix4, expected: Matrix4) {
  assert.ok(Matrix4.equalsEpsilon(actual, expected, 1e-8), 'world-space clipping frame must remain fixed');
}
async function load(t: TestContext, sphereCenter: Cartesian3, root = Matrix4.IDENTITY, model = Matrix4.IDENTITY) {
  // Exercise the real fromUrl origin initialization without files, GPU or a
  // network request. Top-level tests in this file run sequentially.
  t.mock.method(Resource.prototype, 'fetchJson', async () => ({
    asset: { version: '1.1' }, geometricError: 10,
    root: { transform: Matrix4.toArray(root), boundingVolume: { sphere: [sphereCenter.x, sphereCenter.y, sphereCenter.z, 100] },
      geometricError: 0, refine: 'ADD' },
  }));
  const tileset = await Cesium3DTileset.fromUrl('https://synthetic.invalid/tileset.json', { modelMatrix: model }) as EngineTileset;
  t.after(() => tileset.destroy());
  return tileset;
}
function rotate(degrees: number) {
  return Matrix4.multiply(Matrix4.multiply(worldFrame,
    Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(degrees * Math.PI / 180)), new Matrix4()),
  Matrix4.inverseTransformation(worldFrame, new Matrix4()), new Matrix4());
}
function engineFrame(tileset: EngineTileset) {
  // boundingSphere updates computedTransform synchronously. The actual
  // prePassesUpdate invalidates the clipping cache before the traversal uses it.
  void tileset.boundingSphere;
  tileset._clippingPlanesOriginMatrixDirty = true;
  return Matrix4.clone(tileset.clippingPlanesOriginMatrix);
}
function assertWorldCut(tileset: EngineTileset, frame = worldFrame) {
  const origin = tilesetClippingFrame(tileset);
  const collectionMatrix = Matrix4.multiply(Matrix4.inverse(origin, new Matrix4()), frame, new Matrix4());
  const actualOrigin = engineFrame(tileset);
  near(origin, actualOrigin);
  near(Matrix4.multiply(actualOrigin, collectionMatrix, new Matrix4()), frame);
}

test('pinned Cesium identity-root photography preserves an unedited cut and a 90-degree edited cut', async t => {
  assert.equal(createRequire(import.meta.url)('cesium/package.json').version, '1.144.0',
    'review the read-only clipping-origin adapter before a Cesium upgrade');
  const tileset = await load(t, center);
  near(tilesetClippingFrame(tileset), worldFrame); assertWorldCut(tileset);
  tileset.modelMatrix = rotate(90);
  assertWorldCut(tileset);
  const legacyOrigin = Transforms.eastNorthUpToFixedFrame(tileset.boundingSphere.center);
  const legacyCollection = Matrix4.multiply(Matrix4.inverse(legacyOrigin, new Matrix4()), worldFrame, new Matrix4());
  const legacyWorld = Matrix4.multiply(engineFrame(tileset), legacyCollection, new Matrix4());
  const legacyNormal = Matrix4.multiplyByPointAsVector(legacyWorld, Cartesian3.UNIT_X, new Cartesian3());
  const correctNormal = Matrix4.multiplyByPointAsVector(worldFrame, Cartesian3.UNIT_X, new Cartesian3());
  assert.ok(Math.abs(Cartesian3.dot(legacyNormal, correctNormal)) < 1e-8, 'fixture must expose the old 90-degree error');
});

test('preUpdate reads the new transform even while Cesium retains the preceding clipping cache', async t => {
  const tileset = await load(t, center);
  const cached = engineFrame(tileset), computed = Matrix4.clone(tileset.root.computedTransform);
  tileset.modelMatrix = rotate(37);
  const modelBefore = Matrix4.clone(tileset.modelMatrix), initialBefore = Matrix4.clone(tileset._initialClippingPlanesOriginMatrix);
  const frame = tilesetClippingFrame(tileset);
  assert.equal(tileset._clippingPlanesOriginMatrixDirty, false);
  assert.ok(Matrix4.equals(tileset.clippingPlanesOriginMatrix, cached));
  assert.ok(Matrix4.equals(tileset.root.computedTransform, computed), 'adapter does not mutate Cesium computed transforms');
  assert.ok(Matrix4.equals(tileset.modelMatrix, modelBefore));
  assert.ok(Matrix4.equals(tileset._initialClippingPlanesOriginMatrix, initialBefore));
  near(frame, engineFrame(tileset)); assertWorldCut(tileset);
});

test('local-coordinate nonidentity roots keep old placement and combine an existing offset with new rotation', async t => {
  const offset = Matrix4.fromTranslation(new Cartesian3(12, -8, 4));
  const tileset = await load(t, Cartesian3.ZERO, worldFrame, offset);
  assert.ok(Matrix4.equals(tileset._initialClippingPlanesOriginMatrix, Matrix4.IDENTITY));
  near(tilesetClippingFrame(tileset), Matrix4.multiply(offset, worldFrame, new Matrix4()));
  assertWorldCut(tileset);
  tileset.modelMatrix = Matrix4.multiply(rotate(29), offset, new Matrix4());
  assertWorldCut(tileset);
});

test('nonidentity root and geocentric source bounds retain both the root and initial ENU origin', async t => {
  const root = Matrix4.fromTranslation(new Cartesian3(7, 3, -2));
  const offset = Matrix4.fromTranslation(new Cartesian3(-11, 9, 6));
  const tileset = await load(t, center, root, offset);
  near(tileset._initialClippingPlanesOriginMatrix, worldFrame);
  assertWorldCut(tileset);
  tileset.modelMatrix = Matrix4.multiply(rotate(-48), offset, new Matrix4());
  assertWorldCut(tileset);
});

test('an adapter without the pinned internal origin retains both legacy fallback branches', () => {
  const offset = Matrix4.fromTranslation(new Cartesian3(8, -6, 2));
  const plain = { modelMatrix: offset, root: { transform: Matrix4.IDENTITY }, boundingSphere: { center } } as unknown as Cesium3DTileset;
  near(tilesetClippingFrame(plain), worldFrame);
  plain.root.transform = Matrix4.clone(worldFrame);
  near(tilesetClippingFrame(plain), Matrix4.multiply(offset, worldFrame, new Matrix4()));
});
