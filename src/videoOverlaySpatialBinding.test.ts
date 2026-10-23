import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundingSphere, Cartesian3, CustomDataSource, Event, JulianDate, Matrix4, PrimitiveCollection, Transforms, type Viewer } from 'cesium';
import { VideoOverlayResources } from './videoOverlayResources.ts';
import { closestSpatialSegmentPoint, projectSpatialWorldPoint, spatialVideoToScenePoint, VideoOverlaySpatialBinding } from './videoOverlaySpatialBinding.ts';
import { overlayLensBounds } from './videoOverlayLens.ts';
import type { ImportRecord } from './types.ts';

const k = { width: 1920, height: 1080, fx: 1500, fy: 1480, cx: 959.5, cy: 539.5 };
const lens = { k1: -.15, k2: .05, p1: .001, p2: -.002 };
const basis = { position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: -1, z: 0 } };
const close = (a: number, b: number, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test('space projection and distorted video picking share optical rays including half-pixel centres', () => {
  for (const point of [{ x: 0, y: 0, z: 100 }, { x: 20, y: -12, z: 70 }, { x: -22, y: 13, z: 90 }]) {
    const projected = projectSpatialWorldPoint(point, basis, k, lens)!;
    const picked = spatialVideoToScenePoint(projected.x, projected.y, k, lens, 960, 540);
    const bounds = overlayLensBounds(k, lens);
    close(picked.x / 960 * (bounds.right - bounds.left) + bounds.left, point.x / point.z);
    close(picked.y / 540 * (bounds.bottom - bounds.top) + bounds.top, point.y / point.z);
  }
  assert.equal(projectSpatialWorldPoint({ x: 0, y: 0, z: -.5 }, basis, k), undefined);
  assert.equal(projectSpatialWorldPoint({ x: NaN, y: 0, z: 20 }, basis, k), undefined);
  assert.throws(() => spatialVideoToScenePoint(-.1, .5, k, lens, 960, 540), /画幅/);
});

test('CAD snap intersects the actual non-horizontal segment instead of a guessed plane', () => {
  const start = { x: -10, y: 0, z: 50 }, end = { x: 20, y: 0, z: 80 };
  const point = closestSpatialSegmentPoint(basis.position, basis.direction, start, end)!;
  close(point.x, 0); close(point.y, 0); close(point.z, 60);
  assert.equal(closestSpatialSegmentPoint(basis.position, basis.direction, { x: -10, y: 0, z: -50 }, { x: 20, y: 0, z: -80 }), undefined);
});

const center = Cartesian3.fromDegrees(120, 30, 10);
const base = Transforms.eastNorthUpToFixedFrame(center);
function view(): Viewer {
  return { clock: { currentTime: JulianDate.now() }, scene: { primitives: new PrimitiveCollection(), postRender: new Event(), requestRender() {} } } as unknown as Viewer;
}

test('native model anchors follow AR translation/rotation and reopen with identical coordinates', async () => {
  const model = { show: true, modelMatrix: Matrix4.clone(base), scale: 2, boundingSphere: new BoundingSphere(center, 20), isDestroyed: () => false };
  const imports: ImportRecord[] = [{ id: 'bridge', name: 'bridge', kind: 'Model', resource: model, visible: true }];
  const options = { viewer: view(), imports: () => imports, getRecord: () => undefined };
  const session = await VideoOverlayResources.create(options);
  session.setSelection(['bridge']);
  const anchor = new Cartesian3(8, 3, 2), original = Matrix4.multiplyByPoint(session.spatialFrame('bridge')!, anchor, new Cartesian3());
  const expected = Matrix4.multiplyByPoint(base, new Cartesian3(16, 6, 4), new Cartesian3());
  assert.ok(Cartesian3.distance(original, expected) < 1e-7, 'native model scale participates in anchor binding');
  session.applyAdjustments({ bridge: { east: 10, north: 4, up: 3, heading: 90 } });
  const adjusted = Matrix4.multiplyByPoint(session.spatialFrame('bridge')!, anchor, new Cartesian3());
  assert.ok(Cartesian3.distance(original, adjusted) > 5);
  const recovered = Matrix4.multiplyByPoint(Matrix4.inverse(session.spatialFrame('bridge')!, new Matrix4()), adjusted, new Cartesian3());
  close(recovered.x, 8); close(recovered.y, 3); close(recovered.z, 2);
  assert.equal(session.spatialOwnsPick('bridge', { primitive: model }), true);
  assert.equal(session.spatialOwnsPick('bridge', { primitive: {} }), false);
  const saved = session.getAdjustments(); session.restore();
  const reopened = await VideoOverlayResources.create(options);
  reopened.setSelection(['bridge']); reopened.applyAdjustments(saved);
  assert.ok(Cartesian3.distance(adjusted, Matrix4.multiplyByPoint(reopened.spatialFrame('bridge')!, anchor, new Cartesian3())) < 1e-7);
  reopened.setSelection([]); assert.equal(reopened.spatialVisible('bridge'), false);
  imports.length = 0; assert.equal(reopened.spatialFrame('bridge'), undefined);
  reopened.restore();
});

test('entity CAD anchors keep sampled heights and line ownership after AR adjustments', async () => {
  const at = (x: number, y: number, z: number) => Matrix4.multiplyByPoint(base, new Cartesian3(x, y, z), new Cartesian3());
  const data = new CustomDataSource('CAD');
  const entity = data.entities.add({ polyline: { positions: [at(0, 0, 8), at(20, 0, 14)], clampToGround: false } });
  const record: ImportRecord = { id: 'cad', name: 'CAD', kind: 'CAD', resource: data, visible: true };
  const session = await VideoOverlayResources.create({ viewer: view(), imports: () => [record], getRecord: () => undefined });
  session.setSelection(['cad']);
  const hit = { id: entity, primitive: {} }, initial = session.spatialPickedLines('cad', hit)[0];
  const local = Matrix4.multiplyByPoint(Matrix4.inverse(session.spatialFrame('cad')!, new Matrix4()), initial[1], new Cartesian3());
  session.applyAdjustments({ cad: { up: 4, heading: 25 } });
  const changed = session.spatialPickedLines('cad', hit)[0];
  assert.ok(Cartesian3.distance(Matrix4.multiplyByPoint(session.spatialFrame('cad')!, local, new Cartesian3()), changed[1]) < 1e-6);
  assert.deepEqual(session.spatialPickedLines('cad', { id: { id: entity.id } }), []);
  session.restore();
});

test('surface authoring rejects unrelated/empty picks and restores translucent-depth flag', () => {
  const model = {}, point = new Cartesian3(2, 1, 50);
  let picked: unknown = { primitive: model }, depthCalls = 0;
  const resources = {
    spatialVisible: () => true, spatialFrame: () => Matrix4.IDENTITY, get: () => ({ kind: 'Model' }),
    spatialOwnsPick: (_id: string, hit: unknown) => !!hit && (hit as { primitive: unknown }).primitive === model,
    spatialPickedLines: () => [],
  } as unknown as VideoOverlayResources;
  const scene = { pick: () => picked, pickPositionSupported: true, pickTranslucentDepth: false,
    pickPosition: () => { depthCalls++; assert.equal(scene.pickTranslucentDepth, true); return point; } };
  const viewer = { scene, canvas: { clientWidth: 960, clientHeight: 540 }, camera: { positionWC: basis.position, directionWC: basis.direction, rightWC: basis.right, upWC: basis.up } } as unknown as Viewer;
  const binding = new VideoOverlaySpatialBinding({ viewer, resources: () => resources, intrinsics: () => k, lens: () => lens });
  assert.deepEqual(binding.pick('bridge', .5, .5), { x: 2, y: 1, z: 50 });
  assert.equal(scene.pickTranslucentDepth, false);
  picked = { primitive: {} }; assert.throws(() => binding.pick('bridge', .5, .5), /未捕捉/);
  picked = undefined; assert.throws(() => binding.pick('bridge', .5, .5), /未捕捉/);
  assert.equal(depthCalls, 1);
  binding.project('bridge', { x: 1, y: 1, z: 80 }); assert.equal(depthCalls, 1, 'projection must not query scene depth');
});
