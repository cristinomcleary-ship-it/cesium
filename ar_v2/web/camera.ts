import { Matrix4, PerspectiveCamera } from 'three';

export function checkedMatrix(values: number[]): Matrix4 {
  if (values.length !== 16 || !values.every(Number.isFinite)) throw new Error('相机矩阵须为16个有限数值，行主序');
  if (values.slice(12).some((v, i) => Math.abs(v - (i === 3 ? 1 : 0)) > 1e-8)) throw new Error('外参末行必须为 0,0,0,1');
  const m = new Matrix4().set(...values as Parameters<Matrix4['set']>);
  const e = m.elements;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let dot = 0; for (let k = 0; k < 3; k++) dot += e[i * 4 + k] * e[j * 4 + k];
    if (Math.abs(dot - Number(i === j)) > 1e-5) throw new Error('外参旋转不是正交矩阵');
  }
  if (Math.abs(m.determinant() - 1) > 1e-5) throw new Error('外参旋转方向无效');
  return m;
}

export function opticalCamera(K: number[], width: number, height: number, T: number[], near = .1, far = 3000) {
  if (K.length !== 9 || !K.every(Number.isFinite) || K[0] <= 0 || K[4] <= 0 || K[1] !== 0 || K[3] !== 0 || K[6] !== 0 || K[7] !== 0 || K[8] !== 1 || !(near > 0 && far > near)
    || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('无效的 K / 图像尺寸');
  const camera = new PerspectiveCamera();
  const view = checkedMatrix(T).premultiply(new Matrix4().makeScale(1, -1, -1));
  camera.matrixAutoUpdate = false; camera.matrixWorldAutoUpdate = false;
  camera.matrixWorldInverse.copy(view); camera.matrixWorld.copy(view).invert(); camera.matrix.copy(camera.matrixWorld);
  camera.projectionMatrix.makePerspective(near * (-.5 - K[2]) / K[0], near * (width - .5 - K[2]) / K[0],
    near * (K[5] + .5) / K[4], -near * (height - .5 - K[5]) / K[4], near, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.near = near; camera.far = far;
  return camera;
}
