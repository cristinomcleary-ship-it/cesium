import { Cartesian3, Matrix3, Matrix4, Transforms } from 'cesium';

/** Optional metadata only. settings.matrix remains the authoritative saved pose. */
export type PhotogrammetryTransform = {
  version: 1;
  originalMatrix: number[];
  /** Fixed ECEF reference for the east/north/up axes of this edit baseline. */
  origin: number[];
  /** ECEF rotation centre before the current east/north/up translation. */
  pivot: number[];
  east: number;
  north: number;
  up: number;
  /** Degrees, positive from east towards north about the fixed local up axis. */
  heading: number;
};

const poseTolerance = 1e-7;
const invalidState = () => new Error('摄影位置参数无效，请重新打开位置调整。');
const finiteTuple = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(entry => typeof entry === 'number' && Number.isFinite(entry));

function validMatrix(value: unknown): value is number[] {
  if (!finiteTuple(value, 16) || Math.abs(value[3]) > 1e-12 || Math.abs(value[7]) > 1e-12
    || Math.abs(value[11]) > 1e-12 || Math.abs(value[15] - 1) > 1e-12) return false;
  // Preserve pre-existing scale/reflection/shear. Only the additional editor
  // transform is rigid; rejecting a scaled source would alter an old import.
  const determinant = Matrix3.determinant(Matrix4.getMatrix3(Matrix4.fromArray(value), new Matrix3()));
  return Number.isFinite(determinant) && determinant !== 0;
}

function matrixValues(matrix: Matrix4): number[] {
  const values = Matrix4.toArray(matrix);
  if (!validMatrix(values)) throw new Error('摄影当前坐标矩阵无效，原模型位置未修改。');
  return values;
}

function vectorValues(vector: Cartesian3): number[] {
  const values = [vector.x, vector.y, vector.z];
  if (!finiteTuple(values, 3)) throw invalidState();
  return values;
}

function referenceFrame(state: PhotogrammetryTransform): Matrix4 {
  return Transforms.eastNorthUpToFixedFrame(Cartesian3.fromArray(state.origin));
}

function worldTranslation(state: PhotogrammetryTransform): Cartesian3 {
  return Matrix4.multiplyByPointAsVector(referenceFrame(state), new Cartesian3(state.east, state.north, state.up), new Cartesian3());
}

/** Computes from the unchanged baseline, never by multiplying the last preview. */
function compose(state: PhotogrammetryTransform): Matrix4 {
  const original = Matrix4.fromArray(state.originalMatrix);
  const angle = state.heading % 360;
  if (state.east === 0 && state.north === 0 && state.up === 0 && angle === 0) return original;
  const translation = worldTranslation(state);
  if (angle === 0) return Matrix4.multiplyTransformation(Matrix4.fromTranslation(translation), original, new Matrix4());

  const basis = Matrix4.getMatrix3(referenceFrame(state), new Matrix3());
  const localRotation = Matrix3.fromRotationZ(angle * Math.PI / 180);
  const rotation = Matrix3.multiply(Matrix3.multiply(basis, localRotation, new Matrix3()), Matrix3.transpose(basis, new Matrix3()), new Matrix3());
  const pivot = Cartesian3.fromArray(state.pivot);
  const rotatedPivot = Matrix3.multiplyByVector(rotation, pivot, new Cartesian3());
  // T(delta) * T(pivot) * R * T(-pivot). This also keeps an arbitrary
  // non-identity source matrix intact, including its existing scale.
  const offset = Cartesian3.add(translation, Cartesian3.subtract(pivot, rotatedPivot, new Cartesian3()), new Cartesian3());
  return Matrix4.multiplyTransformation(Matrix4.fromRotationTranslation(rotation, offset), original, new Matrix4());
}

/** Strict save validation. Loading legacy metadata uses create's safe fallback. */
export function validatePhotogrammetryTransform(value: unknown, currentMatrix?: Matrix4): PhotogrammetryTransform {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidState();
  const input = value as Partial<PhotogrammetryTransform>;
  if (input.version !== 1 || !validMatrix(input.originalMatrix) || !finiteTuple(input.origin, 3) || !finiteTuple(input.pivot, 3)
    || !['east', 'north', 'up', 'heading'].every(key => typeof input[key as keyof PhotogrammetryTransform] === 'number'
      && Number.isFinite(input[key as keyof PhotogrammetryTransform]))) throw invalidState();
  const magnitude = Math.hypot(...input.origin);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw invalidState();
  const state: PhotogrammetryTransform = { version: 1, originalMatrix: [...input.originalMatrix], origin: [...input.origin], pivot: [...input.pivot],
    east: input.east!, north: input.north!, up: input.up!, heading: input.heading! };
  // Even a zero adjustment must not accept finite-but-unusable ECEF coordinates
  // whose ENU normalization overflows. They would poison the first map pick.
  try { if (!validMatrix(Matrix4.toArray(referenceFrame(state)))) throw invalidState(); }
  catch { throw invalidState(); }
  const composed = Matrix4.toArray(compose(state));
  if (!validMatrix(composed)) throw invalidState();
  if (currentMatrix) {
    const current = matrixValues(currentMatrix);
    if (composed.some((entry, index) => Math.abs(entry - current[index]) > poseTolerance))
      throw new Error('摄影位置参数与最终矩阵不一致，原保存记录未修改。');
  }
  return state;
}

/** Opening an old or externally changed record never moves the live model. */
export function createPhotogrammetryTransform(matrix: Matrix4, center: Cartesian3, saved?: unknown): PhotogrammetryTransform {
  const originalMatrix = matrixValues(matrix);
  if (saved !== undefined) {
    try { return validatePhotogrammetryTransform(saved, matrix); }
    catch { /* Older/malformed/stale metadata cannot replace the authoritative matrix. */ }
  }
  const origin = vectorValues(center);
  return validatePhotogrammetryTransform({ version: 1, originalMatrix, origin, pivot: [...origin], east: 0, north: 0, up: 0, heading: 0 });
}

export function photogrammetryMatrix(state: PhotogrammetryTransform): Matrix4 {
  return compose(validatePhotogrammetryTransform(state));
}

/** World-space pivot displayed after applying the current translation. */
export function getPhotogrammetryPivot(state: PhotogrammetryTransform): Cartesian3 {
  const valid = validatePhotogrammetryTransform(state);
  return Cartesian3.add(Cartesian3.fromArray(valid.pivot), worldTranslation(valid), new Cartesian3());
}

export function setPhotogrammetryPivot(state: PhotogrammetryTransform, world: Cartesian3): PhotogrammetryTransform {
  const valid = validatePhotogrammetryTransform(state);
  vectorValues(world);
  const pivot = Cartesian3.subtract(world, worldTranslation(valid), new Cartesian3());
  return validatePhotogrammetryTransform({ ...valid, pivot: vectorValues(pivot) });
}

/** Two picks add planar ENU displacement only; picked heights do not alter up. */
export function movePhotogrammetryByPoints(state: PhotogrammetryTransform, start: Cartesian3, end: Cartesian3): PhotogrammetryTransform {
  const valid = validatePhotogrammetryTransform(state);
  vectorValues(start); vectorValues(end);
  const difference = Cartesian3.subtract(end, start, new Cartesian3());
  const local = Matrix4.multiplyByPointAsVector(Matrix4.inverseTransformation(referenceFrame(valid), new Matrix4()), difference, new Cartesian3());
  return validatePhotogrammetryTransform({ ...valid, east: valid.east + local.x, north: valid.north + local.y });
}

export function resetPhotogrammetryTransform(state: PhotogrammetryTransform): PhotogrammetryTransform {
  const valid = validatePhotogrammetryTransform(state);
  return { ...valid, pivot: [...valid.origin], east: 0, north: 0, up: 0, heading: 0 };
}
