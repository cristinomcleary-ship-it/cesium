import type { CcCameraKeyframe, CcQuaternion, CcVector3 } from './ccCameraTrack';

export type CcCameraSmoothing = 'none' | 'cubic';
export type CcInterpolatedPose = Readonly<{ position: CcVector3; orientation: CcQuaternion }>;

export function validateCcCameraSmoothing(value: unknown = 'none'): CcCameraSmoothing {
  if (value !== 'none' && value !== 'cubic') throw new Error('相机轨迹插值方式无效');
  return value;
}

const add = (a: CcVector3, b: CcVector3): CcVector3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (v: CcVector3, s: number): CcVector3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });
const subtract = (a: CcVector3, b: CcVector3) => add(a, scale(b, -1));
const dot = (a: CcQuaternion, b: CcQuaternion) => a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
const negate = (q: CcQuaternion): CcQuaternion => ({ x: -q.x, y: -q.y, z: -q.z, w: -q.w });
const inverse = (q: CcQuaternion): CcQuaternion => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
function normalize(q: CcQuaternion): CcQuaternion {
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('相机四元数无效');
  return { x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm };
}
function multiply(a: CcQuaternion, b: CcQuaternion): CcQuaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
function sinc(angle: number): number {
  if (Math.abs(angle) > 1e-4) return Math.sin(angle) / angle;
  const a2 = angle * angle;
  return 1 - a2 / 6 + a2 * a2 / 120;
}
function log(q: CcQuaternion): CcVector3 {
  const norm = Math.hypot(q.x, q.y, q.z);
  if (norm < 1e-15) return { x: q.x, y: q.y, z: q.z };
  return scale(q, Math.atan2(norm, q.w) / norm);
}
function exp(v: CcVector3): CcQuaternion {
  const angle = Math.hypot(v.x, v.y, v.z), s = sinc(angle);
  return { x: s * v.x, y: s * v.y, z: s * v.z, w: Math.cos(angle) };
}

/** Exact spherical arc on the already chosen continuous quaternion lift.
 * Do not flip individual Bezier control points: doing so changes endpoint
 * derivatives. The controls below share an open hemisphere, avoiding antipodes.
 */
function arc(a: CcQuaternion, b: CcQuaternion, t: number): CcQuaternion {
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  const denominator = sinc(angle);
  const left = (1 - t) * sinc((1 - t) * angle) / denominator;
  const right = t * sinc(t * angle) / denominator;
  return normalize({ x: left * a.x + right * b.x, y: left * a.y + right * b.y,
    z: left * a.z + right * b.z, w: left * a.w + right * b.w });
}
function derivative(before: CcVector3, after: CcVector3, previousDuration: number, nextDuration: number): CcVector3 {
  // Derivative of the non-uniform three-point interpolating quadratic.
  return scale(add(scale(before, nextDuration), scale(after, previousDuration)), 1 / (previousDuration + nextDuration));
}

/** Optional interpolation, not a temporal filter or an estimate of new poses.
 * Every solved pose and timestamp is retained. ECEF Hermite position and a
 * spherical cubic Bezier attitude share derivatives at each keyframe, in
 * seconds, including non-uniform frame times. Evaluation is stateless, so seek,
 * reverse playback and offline export produce the same pose as forward playback.
 */
export function createCcSmoothInterpolator(keyframes: readonly CcCameraKeyframe[]):
  (segment: number, fraction: number) => CcInterpolatedPose {
  if (!keyframes.length) throw new Error('没有可插值的相机关键帧');
  const frames = keyframes.map((frame, index) => {
    if (!Number.isFinite(frame.time) || frame.time < 0 || index > 0 && frame.time <= keyframes[index - 1].time) {
      throw new Error('相机关键帧时间必须有限且严格递增');
    }
    if (![frame.position.x, frame.position.y, frame.position.z].every(Number.isFinite)) throw new Error('相机关键帧位置无效');
    return { time: frame.time, position: { ...frame.position }, orientation: normalize(frame.orientation) };
  });
  for (let i = 1; i < frames.length; i++) {
    if (dot(frames[i - 1].orientation, frames[i].orientation) < 0) frames[i].orientation = negate(frames[i].orientation);
    // At 180 degrees the direction of the interpolated rotation is ambiguous.
    // Preserve the existing SLERP option instead of inventing smooth motion.
    if (Math.abs(dot(frames[i - 1].orientation, frames[i].orientation)) < 1e-8) {
      throw new Error('相邻相机姿态相差 180°，无法确定连续旋转方向；请关闭连续轨迹插值');
    }
  }
  const positions: CcVector3[] = [], angular: CcVector3[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i], previous = frames[Math.max(0, i - 1)], next = frames[Math.min(frames.length - 1, i + 1)];
    const h0 = frame.time - previous.time, h1 = next.time - frame.time;
    const before = h0 ? scale(subtract(frame.position, previous.position), 1 / h0) : undefined;
    const after = h1 ? scale(subtract(next.position, frame.position), 1 / h1) : undefined;
    const qBefore = h0 ? scale(log(multiply(inverse(frame.orientation), previous.orientation)), -1 / h0) : undefined;
    const qAfter = h1 ? scale(log(multiply(inverse(frame.orientation), next.orientation)), 1 / h1) : undefined;
    const zero = { x: 0, y: 0, z: 0 };
    let positionVelocity = before && after ? derivative(before, after, h0, h1) : before ?? after ?? zero;
    // A short fast segment followed by a long missing-photo gap must not launch
    // the cubic thousands of metres past its solved endpoints. Limit one shared
    // derivative so each positional Bezier control stays within one segment's
    // displacement from its endpoint. Constant velocity remains unchanged.
    const positionNorm = Math.hypot(positionVelocity.x, positionVelocity.y, positionVelocity.z);
    const positionMaximum = 3 * Math.min(...[before, after].filter((v): v is CcVector3 => !!v)
      .map(v => Math.hypot(v.x, v.y, v.z)));
    if (positionNorm > positionMaximum) positionVelocity = scale(positionVelocity, positionMaximum / positionNorm);
    positions.push(positionVelocity);
    let velocity = qBefore && qAfter ? derivative(qBefore, qAfter, h0, h1) : qBefore ?? qAfter ?? zero;
    // Limit one shared node derivative, never each segment independently: C1 is
    // retained. Each quaternion control is at most pi/6 from its endpoint; all
    // four controls then lie in one open hemisphere even across a large time gap.
    const norm = Math.hypot(velocity.x, velocity.y, velocity.z);
    const maximum = Math.PI / (2 * Math.max(h0, h1));
    if (norm > maximum) velocity = scale(velocity, maximum / norm);
    angular.push(velocity);
  }
  const controls = frames.slice(0, -1).map((left, i) => {
    const right = frames[i + 1], h = right.time - left.time;
    return [normalize(multiply(left.orientation, exp(scale(angular[i], h / 3)))),
      normalize(multiply(right.orientation, exp(scale(angular[i + 1], -h / 3))))] as const;
  });
  return (segment, fraction) => {
    if (!Number.isInteger(segment) || segment < 0 || segment >= Math.max(1, frames.length - 1)
      || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('相机曲线插值区间或比例无效');
    const left = frames[segment], right = frames[Math.min(segment + 1, frames.length - 1)];
    if (fraction === 0 || left === right) return { position: { ...left.position }, orientation: { ...left.orientation } };
    if (fraction === 1) return { position: { ...right.position }, orientation: { ...right.orientation } };
    const h = right.time - left.time, t = fraction, t2 = t * t, t3 = t2 * t;
    // Difference form avoids multiplying ECEF million-metre coordinates by
    // nearly cancelling Hermite weights.
    const position = add(left.position, add(scale(subtract(right.position, left.position), 3 * t2 - 2 * t3),
      add(scale(positions[segment], h * (t3 - 2 * t2 + t)), scale(positions[segment + 1], h * (t3 - t2)))));
    const [a, b] = controls[segment];
    const ab = arc(left.orientation, a, t), bc = arc(a, b, t), cd = arc(b, right.orientation, t);
    return { position, orientation: arc(arc(ab, bc, t), arc(bc, cd, t), t) };
  };
}
