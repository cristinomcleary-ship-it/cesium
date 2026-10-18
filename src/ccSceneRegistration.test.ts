import test from 'node:test';
import assert from 'node:assert/strict';
import { ccGeodeticToEcef, type CcCameraSample, type CcQuaternion, type CcVector3 } from './ccCameraTrack.ts';
import { transformCcCameraSample, validateCcSceneTransform } from './ccSceneRegistration.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x: number, y: number, z: number) => [...identity.slice(0, 12), x, y, z, 1];
function sample(patch: Partial<CcCameraSample> = {}): CcCameraSample {
  return { time: 3.5, position: { x: 6378237, y: 20, z: 30 }, direction: { x: 0, y: 0, z: 1 }, up: { x: 0, y: -1, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    intrinsics: { width: 1920, height: 1080, fx: 1000, fy: 1000, cx: 959.5, cy: 539.5, skew: 0 },
    distortion: { k1: .01, k2: 0, k3: 0, p1: 0, p2: 0 }, fromPhotoId: '0', toPhotoId: '60', interpolation: .5, ...patch };
}
function close(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}
function vectorClose(actual: CcVector3, expected: CcVector3, tolerance = 1e-9) {
  close(actual.x, expected.x, tolerance); close(actual.y, expected.y, tolerance); close(actual.z, expected.z, tolerance);
}
function quaternionClose(actual: CcQuaternion, expected: CcQuaternion) {
  const sign = actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w < 0 ? -1 : 1;
  for (const key of ['x', 'y', 'z', 'w'] as const) close(sign * actual[key], expected[key]);
}
function rotate(q: CcQuaternion, v: CcVector3): CcVector3 {
  // Independent q * (v,0) * inverse(q) to check camera-axis consistency.
  const x = q.w * v.x + q.y * v.z - q.z * v.y;
  const y = q.w * v.y + q.z * v.x - q.x * v.z;
  const z = q.w * v.z + q.x * v.y - q.y * v.x;
  const w = -q.x * v.x - q.y * v.y - q.z * v.z;
  return { x: -w * q.x + x * q.w - y * q.z + z * q.y,
    y: -w * q.y + x * q.z + y * q.w - z * q.x,
    z: -w * q.z - x * q.y + y * q.x + z * q.w };
}

test('identity preserves the original camera and validation owns an immutable snapshot', () => {
  const original = sample(), matrix = [...identity], snapshot = validateCcSceneTransform(matrix);
  const result = transformCcCameraSample(original, snapshot);
  assert.deepEqual(result, original); assert.notEqual(result, original);
  assert.notEqual(snapshot, matrix); assert.ok(Object.isFrozen(snapshot));
  matrix[12] = 500; assert.equal(snapshot[12], 0);
});

test('ECEF translation changes position only and preserves timing, intrinsics and lens data', () => {
  const original = sample(), result = transformCcCameraSample(original, translation(45, -12, 8));
  vectorClose(result.position, { x: 6378282, y: 8, z: 38 });
  vectorClose(result.direction, original.direction); vectorClose(result.up, original.up);
  quaternionClose(result.orientation, original.orientation);
  assert.equal(result.intrinsics, original.intrinsics); assert.equal(result.distortion, original.distortion);
  assert.equal(result.time, 3.5); assert.equal(result.fromPhotoId, '0'); assert.equal(result.toPhotoId, '60'); assert.equal(result.interpolation, .5);
});

test('a 25 metre geodetic height correction uses ECEF radial components, not ECEF Z alone', () => {
  const longitude = 120 * Math.PI / 180, latitude = 30 * Math.PI / 180;
  const up = { x: Math.cos(latitude) * Math.cos(longitude), y: Math.cos(latitude) * Math.sin(longitude), z: Math.sin(latitude) };
  const original = sample({ position: ccGeodeticToEcef(120, 30, 100) });
  const result = transformCcCameraSample(original, translation(25 * up.x, 25 * up.y, 25 * up.z));
  vectorClose(result.position, ccGeodeticToEcef(120, 30, 125), 1e-8);
  close(result.position.z - original.position.z, 12.5, 1e-8);
  vectorClose(result.direction, original.direction);
});

test('left composition rotates position and camera axes, including a non-identity optical orientation', () => {
  const h = Math.SQRT1_2;
  const original = sample({ position: { x: 1, y: 2, z: 3 }, orientation: { x: h, y: 0, z: 0, w: h }, direction: { x: 0, y: -1, z: 0 }, up: { x: 0, y: 0, z: -1 } });
  // +90 degrees around world Z, followed by ECEF translation (10,20,30).
  const matrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
  const result = transformCcCameraSample(original, matrix);
  vectorClose(result.position, { x: 8, y: 21, z: 33 });
  vectorClose(result.direction, { x: 1, y: 0, z: 0 }); vectorClose(result.up, { x: 0, y: 0, z: -1 });
  quaternionClose(result.orientation, { x: .5, y: .5, z: .5, w: .5 });
  vectorClose(rotate(result.orientation, { x: 0, y: 0, z: 1 }), result.direction);
  vectorClose(rotate(result.orientation, { x: 0, y: -1, z: 0 }), result.up);
});

test('180 degree rotations remain finite on every quaternion extraction branch', () => {
  for (const [diagonal, expected] of [
    [[1, -1, -1], { x: 1, y: 0, z: 0, w: 0 }],
    [[-1, 1, -1], { x: 0, y: 1, z: 0, w: 0 }],
    [[-1, -1, 1], { x: 0, y: 0, z: 1, w: 0 }],
  ] as const) {
    const matrix = [...identity]; matrix[0] = diagonal[0]; matrix[5] = diagonal[1]; matrix[10] = diagonal[2];
    const result = transformCcCameraSample(sample(), matrix);
    quaternionClose(result.orientation, expected);
    vectorClose(rotate(result.orientation, { x: 0, y: 0, z: 1 }), result.direction);
    vectorClose(rotate(result.orientation, { x: 0, y: -1, z: 0 }), result.up);
  }
});

test('repeated sampling from the original track never accumulates registration or mutates inputs', () => {
  const original = sample(), before = structuredClone(original), matrix = translation(12, 9, -7), matrixBefore = [...matrix];
  const first = transformCcCameraSample(original, matrix);
  for (let i = 0; i < 100; i++) assert.deepEqual(transformCcCameraSample(original, matrix), first);
  assert.deepEqual(original, before); assert.deepEqual(matrix, matrixBefore);
});

test('rejects malformed, projective, scaled, mirrored, sheared and singular matrices', () => {
  assert.throws(() => validateCcSceneTransform(identity.slice(0, 15)), /16 个有限/);
  assert.throws(() => validateCcSceneTransform(new Array(16)), /16 个有限/);
  for (const value of [NaN, Infinity, -Infinity]) { const matrix = [...identity]; matrix[12] = value; assert.throws(() => validateCcSceneTransform(matrix), /有限/); }
  for (const index of [3, 7, 11, 15]) { const matrix = [...identity]; matrix[index] = .01; assert.throws(() => validateCcSceneTransform(matrix), /仿射/); }
  const uniformScale = [...identity]; uniformScale[0] = uniformScale[5] = uniformScale[10] = 2;
  assert.throws(() => validateCcSceneTransform(uniformScale), /缩放/);
  const nonUniformScale = [...identity]; nonUniformScale[5] = .5; assert.throws(() => validateCcSceneTransform(nonUniformScale), /缩放/);
  const shear = [...identity]; shear[4] = .2; assert.throws(() => validateCcSceneTransform(shear), /剪切/);
  const mirror = [...identity]; mirror[0] = -1; assert.throws(() => validateCcSceneTransform(mirror), /镜像/);
  const singular = [...identity]; singular[10] = 0; assert.throws(() => validateCcSceneTransform(singular), /缩放/);
});

test('invalid camera values cannot propagate into Cesium setView', () => {
  assert.throws(() => transformCcCameraSample(sample({ position: { x: NaN, y: 0, z: 0 } }), identity), /非有限/);
  assert.throws(() => transformCcCameraSample(sample({ direction: { x: 0, y: 0, z: 0 } }), identity), /有效方向/);
  assert.throws(() => transformCcCameraSample(sample({ orientation: { x: 0, y: 0, z: 0, w: 0 } }), identity), /四元数无效/);
});
