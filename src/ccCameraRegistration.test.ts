import test from 'node:test';
import assert from 'node:assert/strict';
import type { CcCameraSample, CcQuaternion, CcVector3 } from './ccCameraTrack.ts';
import { transformCcCameraSample, validateCcSceneTransform } from './ccSceneRegistration.ts';
import { createCcCameraRegistrationMatrix, defaultCcCameraRegistration, validateCcCameraRegistration,
  type CcCameraRegistration, type CcCameraRegistrationAnchor } from './ccCameraRegistration.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const radius = 6378237;
// At longitude=latitude=0: east=ECEF Y, north=ECEF Z, up=ECEF X.
// Looking north, optical right=Y, down=-X, forward=Z: a +90deg Z rotation.
const anchor: CcCameraRegistrationAnchor = {
  position: { x: radius, y: 0, z: 0 },
  orientation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
};
function settings(patch: Partial<CcCameraRegistration> = {}): CcCameraRegistration {
  return { ...defaultCcCameraRegistration(), enabled: true, ...patch };
}
function sample(patch: Partial<CcCameraSample> = {}): CcCameraSample {
  return { time: 7, position: { ...anchor.position }, orientation: { ...anchor.orientation },
    direction: { x: 0, y: 0, z: 1 }, up: { x: 1, y: 0, z: 0 },
    intrinsics: { width: 1920, height: 1080, fx: 1000, fy: 1000, cx: 960, cy: 540, skew: 0 },
    distortion: { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 }, fromPhotoId: '0', toPhotoId: '1', interpolation: .5, ...patch };
}
function close(actual: number, expected: number, tolerance = 2e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}
function vectorClose(actual: CcVector3, expected: CcVector3) {
  for (const key of ['x', 'y', 'z'] as const) close(actual[key], expected[key]);
}
function quaternionClose(actual: CcQuaternion, expected: CcQuaternion) {
  const sign = actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w < 0 ? -1 : 1;
  for (const key of ['x', 'y', 'z', 'w'] as const) close(sign * actual[key], expected[key]);
}
function apply(registration: CcCameraRegistration, input = sample()) {
  return transformCcCameraSample(input, createCcCameraRegistrationMatrix(anchor, registration));
}
// Independent Cartesian rotations for a noncommuting compound-rotation oracle.
function rotateX(v: CcVector3, radians: number): CcVector3 {
  const c = Math.cos(radians), s = Math.sin(radians);
  return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z };
}
function rotateZ(v: CcVector3, radians: number): CcVector3 {
  const c = Math.cos(radians), s = Math.sin(radians);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
}
const localToWorld = (v: CcVector3): CcVector3 => ({ x: -v.y, y: v.x, z: v.z });

test('defaults and validation own fresh normalized state; zero and disabled corrections are identity', () => {
  const first = defaultCcCameraRegistration(), second = defaultCcCameraRegistration();
  assert.deepEqual(first, second); assert.notEqual(first, second);
  const input = settings({ east: -0 }), normalized = validateCcCameraRegistration(input);
  assert.notEqual(normalized, input); assert.equal(Object.is(normalized.east, -0), false);
  assert.deepEqual(validateCcCameraRegistration(), first);
  const enabled = createCcCameraRegistrationMatrix(anchor, settings());
  const disabled = createCcCameraRegistrationMatrix(anchor, settings({ enabled: false, east: 50, heading: 30 }));
  assert.deepEqual(enabled, identity); assert.deepEqual(disabled, identity); assert.ok(Object.isFrozen(enabled));
  assert.notEqual(disabled, createCcCameraRegistrationMatrix(anchor, first));
});

test('ENU metre offsets move position in geographical axes and leave orientation and lens unchanged', () => {
  const original = sample(), result = apply(settings({ east: 12, north: -7, up: 29 }), original);
  vectorClose(result.position, { x: radius + 29, y: 12, z: -7 });
  vectorClose(result.direction, original.direction); vectorClose(result.up, original.up);
  quaternionClose(result.orientation, original.orientation);
  assert.equal(result.intrinsics, original.intrinsics); assert.equal(result.distortion, original.distortion);
  assert.equal(result.time, original.time); assert.equal(result.interpolation, original.interpolation);
});

test('positive heading turns north toward east and rotates the trajectory around the fixed first position', () => {
  const matrix = createCcCameraRegistrationMatrix(anchor, settings({ heading: 90 }));
  const first = transformCcCameraSample(sample(), matrix);
  const later = transformCcCameraSample(sample({ position: { x: radius, y: 0, z: 1000 } }), matrix);
  vectorClose(first.position, anchor.position); vectorClose(first.direction, { x: 0, y: 1, z: 0 });
  vectorClose(first.up, { x: 1, y: 0, z: 0 });
  vectorClose(later.position, { x: radius, y: 1000, z: 0 });
});

test('positive pitch looks up and positive optical roll tilts the right side down', () => {
  const pitch = apply(settings({ pitch: 90 }));
  vectorClose(pitch.position, anchor.position); vectorClose(pitch.direction, { x: 1, y: 0, z: 0 });
  vectorClose(pitch.up, { x: 0, y: 0, z: -1 });
  const roll = apply(settings({ roll: 90 }));
  vectorClose(roll.position, anchor.position); vectorClose(roll.direction, { x: 0, y: 0, z: 1 });
  vectorClose(roll.up, { x: 0, y: 1, z: 0 });
  // right = forward x up, so the rolled right vector is -ECEF X = geographical down.
  const right = { x: roll.direction.y * roll.up.z - roll.direction.z * roll.up.y,
    y: roll.direction.z * roll.up.x - roll.direction.x * roll.up.z,
    z: roll.direction.x * roll.up.y - roll.direction.y * roll.up.x };
  vectorClose(right, { x: -1, y: 0, z: 0 });
});

test('compound rotations use optical right multiplication, with world heading applied last', () => {
  const h = 17 * Math.PI / 180, p = -23 * Math.PI / 180, r = 31 * Math.PI / 180;
  const result = apply(settings({ heading: 17, pitch: -23, roll: 31 }));
  // Anchor ENU up is world X. Apply roll Z, pitch X, anchor basis, then heading -X.
  const expected = (axis: CcVector3) => rotateX(localToWorld(rotateX(rotateZ(axis, r), p)), -h);
  vectorClose(result.direction, expected({ x: 0, y: 0, z: 1 }));
  vectorClose(result.up, expected({ x: 0, y: -1, z: 0 }));
  vectorClose(result.position, anchor.position);
  validateCcSceneTransform(createCcCameraRegistrationMatrix(anchor, settings({ heading: 17, pitch: -23, roll: 31 })));
});

test('translation stays in anchor ENU when combined with rotation', () => {
  const result = apply(settings({ heading: 90, east: 10, north: 20, up: 30 }));
  vectorClose(result.position, { x: radius + 30, y: 10, z: 20 });
  vectorClose(result.direction, { x: 0, y: 1, z: 0 });
});

test('post-scene correction uses the registered anchor and order Tcal times Tscene', () => {
  // A 90deg ECEF Z scene rotation moves the anchor from lon=0 to lon=90.
  const scene = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const registeredFirst = transformCcCameraSample(sample(), scene);
  const matrix = createCcCameraRegistrationMatrix(registeredFirst, settings({ heading: 90, east: 10 }));
  const later = sample({ position: { x: radius, y: 0, z: 100 } });
  const result = transformCcCameraSample(transformCcCameraSample(later, scene), matrix);
  // At lon=90, east=-ECEF X. North displacement turns east; translation is east too.
  vectorClose(result.position, { x: -110, y: radius, z: 0 });
  vectorClose(result.direction, { x: -1, y: 0, z: 0 });
  vectorClose(result.up, { x: 0, y: 1, z: 0 });
  const wrongOrder = transformCcCameraSample(transformCcCameraSample(later, matrix), scene);
  assert.ok(Math.hypot(wrongOrder.position.x - result.position.x, wrongOrder.position.y - result.position.y, wrongOrder.position.z - result.position.z) > 1000);
});

test('one fixed rigid transform preserves trajectory distances and inter-camera angles without cumulative drift', () => {
  const original = sample({ position: { x: radius + 35, y: -83, z: 700 },
    orientation: { x: .5, y: -.5, z: .5, w: .5 }, direction: { x: 0, y: -1, z: 0 } });
  const originalBefore = structuredClone(original), anchorBefore = structuredClone(anchor);
  const registration = settings({ east: 7, north: -4, up: 13, heading: 11, pitch: -6, roll: 3 });
  const registrationBefore = structuredClone(registration);
  const matrix = createCcCameraRegistrationMatrix(anchor, registration), matrixBefore = [...matrix];
  const first = transformCcCameraSample(sample(), matrix), later = transformCcCameraSample(original, matrix);
  close(Math.hypot(later.position.x - first.position.x, later.position.y - first.position.y, later.position.z - first.position.z), Math.hypot(35, -83, 700));
  close(first.direction.x * later.direction.x + first.direction.y * later.direction.y + first.direction.z * later.direction.z, 0);
  const orientationDot = (a: CcQuaternion, b: CcQuaternion) => a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  close(Math.abs(orientationDot(first.orientation, later.orientation)), Math.abs(orientationDot(anchor.orientation, original.orientation)));
  for (let index = 0; index < 100; index++) assert.deepEqual(transformCcCameraSample(original, matrix), later);
  assert.deepEqual(original, originalBefore); assert.deepEqual(anchor, anchorBefore);
  assert.deepEqual(registration, registrationBefore); assert.deepEqual(matrix, matrixBefore);
});

test('scaled or sign-reversed anchor quaternions yield the same rigid correction', () => {
  const registration = settings({ heading: 15, pitch: 7, roll: -9 });
  const expected = createCcCameraRegistrationMatrix(anchor, registration);
  for (const scale of [5, -1]) {
    const q = anchor.orientation;
    const actual = createCcCameraRegistrationMatrix({ position: anchor.position,
      orientation: { x: q.x * scale, y: q.y * scale, z: q.z * scale, w: q.w * scale } }, registration);
    actual.forEach((number, index) => close(number, expected[index]));
  }
});

test('invalid corrections and anchors are rejected even while disabled', () => {
  for (const enabled of [true, false]) {
    for (const key of ['east', 'north', 'up', 'heading', 'pitch', 'roll'] as const) {
      for (const number of [NaN, Infinity, -Infinity, undefined, '1']) {
        assert.throws(() => createCcCameraRegistrationMatrix(anchor, { ...settings({ enabled }), [key]: number } as CcCameraRegistration), /有限数值/);
      }
      const limit = ['east', 'north', 'up'].includes(key) ? 100000 : 180;
      for (const number of [-limit - 1, limit + 1]) assert.throws(() => validateCcCameraRegistration({ ...settings({ enabled }), [key]: number }), /有限数值/);
      validateCcCameraRegistration({ ...settings({ enabled }), [key]: limit });
      validateCcCameraRegistration({ ...settings({ enabled }), [key]: -limit });
    }
    for (const position of [{ x: NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]) {
      assert.throws(() => createCcCameraRegistrationMatrix({ ...anchor, position }, settings({ enabled })), /ECEF/);
    }
    for (const orientation of [{ x: 0, y: 0, z: 0, w: 0 }, { x: 0, y: NaN, z: 0, w: 1 }]) {
      assert.throws(() => createCcCameraRegistrationMatrix({ ...anchor, orientation }, settings({ enabled })), /四元数/);
    }
  }
  assert.throws(() => validateCcCameraRegistration({ ...settings(), enabled: 1 } as unknown as CcCameraRegistration), /布尔/);
  assert.throws(() => validateCcCameraRegistration(null as unknown as CcCameraRegistration), /布尔/);
});
