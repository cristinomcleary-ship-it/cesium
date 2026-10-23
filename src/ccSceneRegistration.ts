import type { CcCameraSample, CcQuaternion, CcVector3 } from './ccCameraTrack';

/**
 * A column-major Cesium tileset.modelMatrix, mapping the CC result's original
 * ECEF coordinates into the application's scene coordinates. The camera already
 * has an ECEF position: never pass a tileset root.transform/computedTransform.
 * Validation cannot establish that a tileset and XML came from the same survey;
 * the caller must bind an explicitly selected, matching CC production.
 */
export function validateCcSceneTransform(matrix: readonly number[]): readonly number[] {
  if (!Array.isArray(matrix) || matrix.length !== 16
    || Array.from(matrix).some(value => !Number.isFinite(value))) {
    throw new Error('空三场景关联矩阵必须包含 16 个有限数值');
  }
  const affineTolerance = 1e-12;
  if (Math.abs(matrix[3]) > affineTolerance || Math.abs(matrix[7]) > affineTolerance
    || Math.abs(matrix[11]) > affineTolerance || Math.abs(matrix[15] - 1) > affineTolerance) {
    throw new Error('空三场景关联只支持仿射刚体变换，不支持投影矩阵');
  }
  const tolerance = 1e-6;
  for (let column = 0; column < 3; column++) {
    for (let other = column; other < 3; other++) {
      let dot = 0;
      for (let row = 0; row < 3; row++) dot += matrix[column * 4 + row] * matrix[other * 4 + row];
      if (Math.abs(dot - (column === other ? 1 : 0)) > tolerance) {
        throw new Error('空三场景关联只支持平移和旋转，不支持缩放或剪切');
      }
    }
  }
  const m = matrix;
  const determinant = m[0] * (m[5] * m[10] - m[9] * m[6])
    - m[4] * (m[1] * m[10] - m[9] * m[2])
    + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (Math.abs(determinant - 1) > tolerance) throw new Error('空三场景关联不支持镜像或无效旋转');
  // A saved association owns a stable snapshot, independent of subsequent live
  // modelMatrix changes or AR object adjustments.
  return Object.freeze([...matrix]);
}

function finiteVector(value: CcVector3, label: string): CcVector3 {
  if (![value.x, value.y, value.z].every(Number.isFinite)) throw new Error(`${label}包含非有限数值`);
  return value;
}

function unitVector(value: CcVector3, label: string): CcVector3 {
  finiteVector(value, label);
  const length = Math.hypot(value.x, value.y, value.z);
  if (!(length > 1e-12) || !Number.isFinite(length)) throw new Error(`${label}不是有效方向`);
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function unitQuaternion(value: CcQuaternion): CcQuaternion {
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (!(length > 1e-12) || !Number.isFinite(length)) throw new Error('空三相机姿态四元数无效');
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
}

function rotationQuaternion(m: readonly number[]): CcQuaternion {
  const trace = m[0] + m[5] + m[10];
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s; w = s / 4;
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[5] - m[10]);
    x = s / 4; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s; w = (m[6] - m[9]) / s;
  } else if (m[5] > m[10]) {
    const s = 2 * Math.sqrt(1 + m[5] - m[0] - m[10]);
    x = (m[4] + m[1]) / s; y = s / 4; z = (m[9] + m[6]) / s; w = (m[8] - m[2]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[10] - m[0] - m[5]);
    x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = s / 4; w = (m[1] - m[4]) / s;
  }
  return unitQuaternion({ x, y, z, w });
}

function rotateVector(m: readonly number[], v: CcVector3): CcVector3 {
  return { x: m[0] * v.x + m[4] * v.y + m[8] * v.z,
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z,
    z: m[2] * v.x + m[6] * v.y + m[10] * v.z };
}

/**
 * Transform one original CC sample, without editing the track or engineering
 * geometry. Call with track.sample(time) each frame, not the previous output.
 * Camera orientation maps optical axes into ECEF, hence q_scene = q_matrix * q_cc.
 * XML vertical-datum conversion belongs in createCcCameraTrack, before this step.
 */
export function transformCcCameraSample(sample: CcCameraSample, matrix: readonly number[]): CcCameraSample {
  const m = validateCcSceneTransform(matrix);
  const rotatedPosition = rotateVector(m, finiteVector(sample.position, '空三相机位置'));
  const position = finiteVector({ x: rotatedPosition.x + m[12], y: rotatedPosition.y + m[13], z: rotatedPosition.z + m[14] }, '关联后相机位置');
  const a = rotationQuaternion(m), b = unitQuaternion(sample.orientation);
  const orientation = unitQuaternion({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  });
  return { ...sample, position, orientation,
    direction: unitVector(rotateVector(m, sample.direction), '关联后相机朝向'),
    up: unitVector(rotateVector(m, sample.up), '关联后相机上方向') };
}
