import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Matrix4 } from 'cesium';
import { createCachedSpatialProjector, type CachedSpatialCamera } from './videoOverlayCachedAnnotations.ts';
import { projectSpatialWorldPoint } from './videoOverlaySpatialBinding.ts';

const intrinsics = { width: 1920, height: 1080, fx: 1500, fy: 1480, cx: 959.5, cy: 539.5 };
const camera: CachedSpatialCamera = { position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, up: { x: 0, y: -1, z: 0 } };
const frames = { bridge: Matrix4.toArray(Matrix4.fromTranslation(new Cartesian3(0, 0, 100))) };
const close = (a: number, b: number, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test('cached local origin projects at the optical centre and follows camera translation', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const first = createCachedSpatialProjector({ frames, camera, intrinsics }).project('bridge', origin)!;
  assert.deepEqual(first, { x: .5, y: .5, depth: 100 });
  const moved = createCachedSpatialProjector({ frames, camera: { ...camera, position: { x: 10, y: 0, z: 0 } }, intrinsics }).project('bridge', origin)!;
  close(moved.x, .5 - 150 / 1920); close(moved.y, .5); close(moved.depth, 100);
});

test('cached projection matches live projection including model scale and Brown distortion', () => {
  const matrix = Matrix4.multiplyByUniformScale(Matrix4.fromTranslation(new Cartesian3(10, -2, 80)), 2, new Matrix4());
  const local = new Cartesian3(3, 4, 5), lens = { k1: -.15, k2: .05, p1: .001, p2: -.002 };
  const projector = createCachedSpatialProjector({ frames: { bridge: Matrix4.toArray(matrix) }, camera, intrinsics, lens });
  const expected = projectSpatialWorldPoint(Matrix4.multiplyByPoint(matrix, local, new Cartesian3()), { ...camera, right: { x: 1, y: 0, z: 0 } }, intrinsics, lens)!;
  const actual = projector.project('bridge', local)!;
  close(actual.x, expected.x); close(actual.y, expected.y); close(actual.depth, expected.depth);
  assert.notEqual(actual.x, createCachedSpatialProjector({ frames: { bridge: Matrix4.toArray(matrix) }, camera, intrinsics }).project('bridge', local)!.x);
});

test('cached camera normalizes direction and orthogonalizes an imperfect up vector', () => {
  const imperfect = { ...camera, direction: { x: 0, y: 0, z: 2 }, up: { x: 0, y: -3, z: .2 } };
  const point = { x: 2, y: 3, z: 4 };
  assert.deepEqual(createCachedSpatialProjector({ frames, camera: imperfect, intrinsics }).project('bridge', point),
    createCachedSpatialProjector({ frames, camera, intrinsics }).project('bridge', point));
});

test('rotated cameras retain the right-handed image axes', () => {
  const projector = createCachedSpatialProjector({ frames: { bridge: Matrix4.toArray(Matrix4.IDENTITY) }, intrinsics,
    camera: { position: { x: 100, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } } });
  const point = projector.project('bridge', { x: 0, y: 10, z: 5 })!;
  close(point.x, .5 + 150 / 1920); close(point.y, .5 - 74 / 1080); close(point.depth, 100);
});

test('missing, hidden, invalid and behind-camera targets do not draw stale anchors', () => {
  const projector = createCachedSpatialProjector({ frames: { ...frames, corrupt: [1], singular: Array(16).fill(0), behind: Matrix4.toArray(Matrix4.fromTranslation(new Cartesian3(0, 0, -50))) }, camera, intrinsics, targetVisible: id => id !== 'bridge' });
  for (const id of ['missing', 'corrupt', 'singular', 'bridge']) {
    assert.equal(projector.targetVisible(id), false); assert.equal(projector.project(id, { x: 0, y: 0, z: 0 }), undefined);
  }
  assert.equal(projector.project('behind', { x: 0, y: 0, z: 0 }), undefined);
  const absent = createCachedSpatialProjector({ frames, camera: null, intrinsics });
  assert.equal(absent.targetVisible('bridge'), false);
  assert.equal(absent.project('bridge', { x: 0, y: 0, z: 0 }), undefined);
  const degenerate = createCachedSpatialProjector({ frames, camera: { ...camera, up: camera.direction }, intrinsics });
  assert.equal(degenerate.project('bridge', { x: 0, y: 0, z: 0 }), undefined);
});

test('projection snapshot is isolated from later mutable map transforms and camera positions', () => {
  const mutableFrames = structuredClone(frames), mutableCamera = { ...camera, position: { ...camera.position } };
  const projector = createCachedSpatialProjector({ frames: mutableFrames, camera: mutableCamera, intrinsics });
  mutableFrames.bridge[12] = 1000; mutableCamera.position.x = 1000;
  assert.deepEqual(projector.project('bridge', { x: 0, y: 0, z: 0 }), { x: .5, y: .5, depth: 100 });
});
