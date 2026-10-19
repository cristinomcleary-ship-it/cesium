import test from 'node:test';
import assert from 'node:assert/strict';
import { createCcSmoothInterpolator, validateCcCameraSmoothing } from './ccCameraSmoothing.ts';
import type { CcCameraKeyframe, CcQuaternion, CcVector3 } from './ccCameraTrack.ts';

const q = (axis: CcVector3, angle: number): CcQuaternion => {
  const scale = Math.sin(angle / 2) / Math.hypot(axis.x, axis.y, axis.z);
  return { x: axis.x * scale, y: axis.y * scale, z: axis.z * scale, w: Math.cos(angle / 2) };
};
const identity: CcQuaternion = { x: 0, y: 0, z: 0, w: 1 };
const frame = (time: number, position: CcVector3, orientation = identity): CcCameraKeyframe =>
  ({ time, position, orientation, photoId: String(time), filename: `${time}.jpg` });
const subtract = (a: CcVector3, b: CcVector3, divisor = 1): CcVector3 =>
  ({ x: (a.x - b.x) / divisor, y: (a.y - b.y) / divisor, z: (a.z - b.z) / divisor });
function close(a: number, b: number, tolerance = 1e-8) { assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`); }
function vectorClose(a: CcVector3, b: CcVector3, tolerance = 1e-8) {
  close(a.x, b.x, tolerance); close(a.y, b.y, tolerance); close(a.z, b.z, tolerance);
}
function relative(a: CcQuaternion, b: CcQuaternion): CcVector3 {
  const x = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y;
  const y = a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x;
  const z = a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w;
  const w = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  const norm = Math.hypot(x, y, z), scale = norm ? 2 * Math.atan2(norm, w) / norm : 2;
  return { x: x * scale, y: y * scale, z: z * scale };
}

test('constant world velocity and constant angular velocity are retained with nonuniform timestamps', () => {
  const frames = [0, .7, 3.8, 7].map(time => frame(time, { x: 6378137 + 2 * time, y: -3 * time, z: 4 * time }, q({ x: 0, y: 0, z: 1 }, .1 * time)));
  const sample = createCcSmoothInterpolator(frames);
  for (let i = 0; i < frames.length - 1; i++) for (const fraction of [0, .1, .5, .9, 1]) {
    const time = frames[i].time + fraction * (frames[i + 1].time - frames[i].time), pose = sample(i, fraction);
    vectorClose(pose.position, { x: 6378137 + 2 * time, y: -3 * time, z: 4 * time }, 2e-8);
    vectorClose(relative(q({ x: 0, y: 0, z: 1 }, .1 * time), pose.orientation), { x: 0, y: 0, z: 0 });
  }
});

test('position and three-axis angular velocity are continuous at nonuniform keyframe joins', () => {
  const frames = [frame(0, { x: 0, y: 0, z: 0 }), frame(.8, { x: 3, y: 2, z: 1 }, q({ x: 1, y: 2, z: 1 }, .2)),
    frame(3.9, { x: 6, y: -1, z: 4 }, q({ x: -1, y: 1, z: 3 }, .5)), frame(5, { x: 7, y: 0, z: 2 }, q({ x: 2, y: 1, z: -1 }, .3))];
  const sample = createCcSmoothInterpolator(frames), dt = 1e-6;
  for (let i = 1; i < frames.length - 1; i++) {
    const before = sample(i - 1, 1 - dt / (frames[i].time - frames[i - 1].time));
    const current = sample(i, 0), after = sample(i, dt / (frames[i + 1].time - frames[i].time));
    vectorClose(subtract(current.position, before.position, dt), subtract(after.position, current.position, dt), 5e-5);
    vectorClose(subtract({ x: 0, y: 0, z: 0 }, relative(current.orientation, before.orientation), dt),
      subtract(relative(current.orientation, after.orientation), { x: 0, y: 0, z: 0 }, dt), 5e-5);
  }
});

test('shortest keyframe arc, quaternion sign changes and extreme timestamp gaps stay finite and deterministic', () => {
  const frames = [frame(0, { x: 0, y: 0, z: 0 }, q({ x: 0, y: 0, z: 1 }, 179 * Math.PI / 180)),
    frame(.01, { x: 1, y: 0, z: 0 }, q({ x: 0, y: 0, z: 1 }, -179 * Math.PI / 180)),
    frame(500, { x: 2, y: 0, z: 0 }, q({ x: 1, y: 2, z: 3 }, .7))];
  const sample = createCcSmoothInterpolator(frames), input = JSON.stringify(frames);
  const saved = sample(1, .43); sample(0, .2); sample(1, 1); assert.deepEqual(sample(1, .43), saved);
  assert.equal(JSON.stringify(frames), input);
  for (let i = 0; i < 2; i++) for (let step = 0; step <= 100; step++) {
    const pose = sample(i, step / 100);
    assert.ok(Object.values(pose.position).every(Number.isFinite));
    assert.ok(pose.position.x >= 0 && pose.position.x <= 2, 'a long missing-photo gap must not cause a distant position overshoot');
    close(Math.hypot(...Object.values(pose.orientation)), 1);
  }
  const middle = sample(0, .5).orientation;
  assert.ok(Math.abs(middle.z) > .999, 'crosses the small arc around 180°, not zero');
});

test('single keyframes work; malformed data and ambiguous 180 degree motion fail explicitly', () => {
  const first = frame(3, { x: 1, y: 2, z: 3 });
  assert.deepEqual(createCcSmoothInterpolator([first])(0, .5), { position: first.position, orientation: first.orientation });
  assert.equal(validateCcCameraSmoothing(), 'none'); assert.equal(validateCcCameraSmoothing('cubic'), 'cubic');
  assert.throws(() => validateCcCameraSmoothing(true), /无效/);
  assert.throws(() => createCcSmoothInterpolator([]), /没有/);
  assert.throws(() => createCcSmoothInterpolator([first, first]), /严格递增/);
  assert.throws(() => createCcSmoothInterpolator([first, frame(4, first.position, q({ x: 1, y: 0, z: 0 }, Math.PI))]), /180/);
  assert.throws(() => createCcSmoothInterpolator([{ ...first, position: { x: Infinity, y: 0, z: 0 } }]), /位置无效/);
  const sample = createCcSmoothInterpolator([first, frame(4, first.position)]);
  assert.throws(() => sample(1, .5), /区间/); assert.throws(() => sample(0, NaN), /比例/);
});
