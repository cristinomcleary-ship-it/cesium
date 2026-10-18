import { Cartesian3, Matrix3, Matrix4, Quaternion, Transforms } from 'cesium';
import type { CcQuaternion, CcVector3 } from './ccCameraTrack';

/** Metres in the fixed anchor ENU frame; rotation corrections are degrees. */
export type CcCameraRegistration = {
  enabled: boolean;
  east: number; north: number; up: number;
  heading: number; pitch: number; roll: number;
};

/** The first CC camera after scene registration, before this correction. */
export type CcCameraRegistrationAnchor = {
  position: CcVector3;
  /** Optical right/down/forward axes into ECEF. */
  orientation: CcQuaternion;
};

export function defaultCcCameraRegistration(): CcCameraRegistration {
  return { enabled: false, east: 0, north: 0, up: 0, heading: 0, pitch: 0, roll: 0 };
}

/** Validate even disabled corrections; never silently clamp or reuse input state. */
export function validateCcCameraRegistration(value?: CcCameraRegistration): CcCameraRegistration {
  if (value === undefined) return defaultCcCameraRegistration();
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') {
    throw new Error('相机配准启用状态必须为布尔值');
  }
  const result = defaultCcCameraRegistration();
  result.enabled = value.enabled;
  for (const key of ['east', 'north', 'up', 'heading', 'pitch', 'roll'] as const) {
    const number = value[key], limit = key === 'east' || key === 'north' || key === 'up' ? 100000 : 180;
    if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > limit) {
      throw new Error(`相机配准 ${key} 必须是绝对值不超过 ${limit} 的有限数值`);
    }
    result[key] = number === 0 ? 0 : number;
  }
  return result;
}

function validatedAnchor(anchor: CcCameraRegistrationAnchor): { position: Cartesian3; orientation: Quaternion } {
  if (!anchor || typeof anchor !== 'object' || !anchor.position || !anchor.orientation) {
    throw new Error('相机配准缺少固定首帧锚点');
  }
  const p = anchor.position, q = anchor.orientation;
  const positionLength = Math.hypot(p.x, p.y, p.z);
  if (![p.x, p.y, p.z].every(value => typeof value === 'number' && Number.isFinite(value))
    || !Number.isFinite(positionLength) || !(positionLength > 1e-12)) {
    throw new Error('相机配准锚点必须是有效的 ECEF 位置');
  }
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (![q.x, q.y, q.z, q.w].every(value => typeof value === 'number' && Number.isFinite(value))
    || !Number.isFinite(length) || !(length > 1e-12)) {
    throw new Error('相机配准锚点姿态四元数无效');
  }
  return { position: new Cartesian3(p.x, p.y, p.z),
    orientation: new Quaternion(q.x / length, q.y / length, q.z / length, q.w / length) };
}

/**
 * A fixed, column-major ECEF rigid transform of the complete camera trajectory.
 * Apply AFTER the existing CC scene-reference transform, to each original sample.
 * Never move the anchor with playback or feed an already corrected sample back in.
 *
 * Heading is clockwise about anchor ENU up. Pitch is positive about optical X
 * (look up); roll is positive about optical Z (right side down). The exact order is
 * qAdjusted = qYawWorld * qAnchor * qPitchX * qRollZ,
 * qDelta = qAdjusted * inverse(qAnchor).
 * This order is part of the saved calibration convention, not Euler extraction.
 *
 * p' = a + Rdelta * (p-a) + ENU(a) * [east,north,up].
 * The translation is NOT rotated by Rdelta. A rotation also moves later camera
 * positions around the fixed first position: this is whole-trajectory registration,
 * not an orientation-only gimbal/boresight correction. Model coordinates stay put.
 */
export function createCcCameraRegistrationMatrix(
  anchor: CcCameraRegistrationAnchor,
  registration: CcCameraRegistration,
): readonly number[] {
  const settings = validateCcCameraRegistration(registration);
  const { position, orientation } = validatedAnchor(anchor);
  if (!settings.enabled) return Object.freeze(Matrix4.toArray(Matrix4.IDENTITY));

  const enu = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position), new Matrix3());
  let delta = Quaternion.clone(Quaternion.IDENTITY);
  if (settings.heading !== 0 || settings.pitch !== 0 || settings.roll !== 0) {
    const radians = Math.PI / 180;
    const up = Matrix3.getColumn(enu, 2, new Cartesian3());
    const yaw = Quaternion.fromAxisAngle(up, -settings.heading * radians, new Quaternion());
    const pitch = Quaternion.fromAxisAngle(Cartesian3.UNIT_X, settings.pitch * radians, new Quaternion());
    const roll = Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, settings.roll * radians, new Quaternion());
    const adjusted = Quaternion.multiply(yaw, orientation, new Quaternion());
    Quaternion.multiply(adjusted, pitch, adjusted);
    Quaternion.multiply(adjusted, roll, adjusted);
    delta = Quaternion.multiply(adjusted, Quaternion.conjugate(orientation, new Quaternion()), new Quaternion());
    Quaternion.normalize(delta, delta);
  }
  const rotation = Matrix3.fromQuaternion(delta, new Matrix3());
  const offset = Matrix3.multiplyByVector(enu, new Cartesian3(settings.east, settings.north, settings.up), new Cartesian3());
  const rotatedAnchor = Matrix3.multiplyByVector(rotation, position, new Cartesian3());
  const translation = Cartesian3.subtract(position, rotatedAnchor, new Cartesian3());
  Cartesian3.add(translation, offset, translation);
  return Object.freeze(Matrix4.toArray(Matrix4.fromRotationTranslation(rotation, translation, new Matrix4())));
}
