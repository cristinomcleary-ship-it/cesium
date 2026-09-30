import {
  cameraDirectionToEnu,
  distortNormalizedPoint,
  undistortPixel,
  validateCameraIntrinsics,
  type CameraAttitude,
  type CameraIntrinsics,
  type CameraVector3,
  type LensDistortion,
} from "./videoArCamera.ts";

export type ControlPointMatch = Readonly<{
  pixelX: number;
  pixelY: number;
  /** Metres in the same local east/north/up frame as the camera position. */
  world: CameraVector3;
}>;

export type ControlPointCamera = Readonly<{
  position: CameraVector3;
  attitude: CameraAttitude;
  intrinsics: CameraIntrinsics;
  distortion?: LensDistortion;
}>;

export type PoseRefinementInput = Readonly<{
  initialPosition: CameraVector3;
  initialAttitude: CameraAttitude;
  intrinsics: CameraIntrinsics;
  controls: readonly ControlPointMatch[];
  distortion?: LensDistortion;
  maxRmsePx?: number;
  maxErrorPx?: number;
  maxPositionCorrectionMeters?: number;
  maxAngleCorrectionDegrees?: number;
  maxIterations?: number;
}>;

export type ControlPointResidual = Readonly<{
  predictedPixelX: number;
  predictedPixelY: number;
  errorX: number;
  errorY: number;
  errorPx: number;
}>;

export type PoseRefinementResult = Readonly<{
  position: CameraVector3;
  attitude: CameraAttitude;
  /** RMS Euclidean image distance, in original source-video pixels. */
  rmsePx: number;
  maxErrorPx: number;
  residuals: readonly ControlPointResidual[];
  iterations: number;
}>;

const PARAMETER_COUNT = 6;
const MIN_CAMERA_DEPTH_METERS = 1e-4;

function finiteVector(vector: CameraVector3) {
  return vector && [vector.x, vector.y, vector.z].every(Number.isFinite);
}

function subtract(left: CameraVector3, right: CameraVector3): CameraVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function dot(left: CameraVector3, right: CameraVector3) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function basis(attitude: CameraAttitude) {
  const forward = cameraDirectionToEnu({ x: 0, y: 0 }, attitude);
  const rightRay = cameraDirectionToEnu({ x: 1, y: 0 }, attitude);
  const downRay = cameraDirectionToEnu({ x: 0, y: 1 }, attitude);
  const root2 = Math.SQRT2;
  return {
    forward,
    right: { x: rightRay.x * root2 - forward.x, y: rightRay.y * root2 - forward.y, z: rightRay.z * root2 - forward.z },
    down: { x: downRay.x * root2 - forward.x, y: downRay.y * root2 - forward.y, z: downRay.z * root2 - forward.z },
  };
}

function projectWithBasis(
  camera: ControlPointCamera,
  frame: ReturnType<typeof basis>,
  world: CameraVector3,
) {
  if (!finiteVector(world) || !finiteVector(camera.position)) throw new Error("Control points and camera position must be finite");
  const delta = subtract(world, camera.position);
  const depth = dot(delta, frame.forward);
  if (!Number.isFinite(depth) || depth <= MIN_CAMERA_DEPTH_METERS) throw new Error("A control point is behind or too close to the camera");
  const distorted = distortNormalizedPoint({ x: dot(delta, frame.right) / depth, y: dot(delta, frame.down) / depth }, camera.distortion);
  const pixelX = camera.intrinsics.cx + camera.intrinsics.fx * distorted.x;
  const pixelY = camera.intrinsics.cy + camera.intrinsics.fy * distorted.y;
  if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) throw new Error("Control point projection is not finite");
  return { pixelX, pixelY, depth };
}

/** Project an ENU scene point through the camera and forward lens model. */
export function projectControlPoint(camera: ControlPointCamera, world: CameraVector3) {
  validateCameraIntrinsics(camera.intrinsics);
  return projectWithBasis(camera, basis(camera.attitude), world);
}

function requireSpread(points: readonly CameraVector3[], minSpan: number, label: string) {
  let maximumLength2 = 0;
  let first = points[0];
  let last = points[0];
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const edge = subtract(points[right], points[left]);
      const length2 = dot(edge, edge);
      if (length2 > maximumLength2) { maximumLength2 = length2; first = points[left]; last = points[right]; }
    }
  }
  if (!Number.isFinite(maximumLength2) || maximumLength2 < minSpan * minSpan) {
    throw new Error(label + " control points are coincident or too tightly clustered");
  }
  const edge = subtract(last, first);
  let maximumCrossLength = 0;
  for (const point of points) {
    const offset = subtract(point, first);
    const crossX = edge.y * offset.z - edge.z * offset.y;
    const crossY = edge.z * offset.x - edge.x * offset.z;
    const crossZ = edge.x * offset.y - edge.y * offset.x;
    maximumCrossLength = Math.max(maximumCrossLength, Math.hypot(crossX, crossY, crossZ));
  }
  // Reject a nearly one-dimensional layout; planar two-dimensional controls
  // are valid and are the normal case for ground registration.
  if (maximumCrossLength / maximumLength2 < 0.005) {
    throw new Error(label + " control points are nearly collinear; spread them across the image and scene");
  }
}

function positiveOption(value: number | undefined, fallback: number, name: string) {
  const effective = value ?? fallback;
  if (!Number.isFinite(effective) || effective <= 0) throw new Error(name + " must be positive and finite");
  return effective;
}

function solveLinear(matrix: number[][], right: number[]) {
  const rows = matrix.map((row, index) => [...row, right[index]]);
  for (let column = 0; column < PARAMETER_COUNT; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < PARAMETER_COUNT; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (!Number.isFinite(rows[pivot][column]) || Math.abs(rows[pivot][column]) < 1e-18) return undefined;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const value = rows[column][column];
    for (let entry = column; entry <= PARAMETER_COUNT; entry += 1) rows[column][entry] /= value;
    for (let row = 0; row < PARAMETER_COUNT; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let entry = column; entry <= PARAMETER_COUNT; entry += 1) rows[row][entry] -= factor * rows[column][entry];
    }
  }
  const solution = rows.map((row) => row[PARAMETER_COUNT]);
  return solution.every(Number.isFinite) ? solution : undefined;
}

/**
 * Refine a pose close to telemetry using paired source pixels and scene points.
 * Intrinsics remain fixed. This is a local bounded fit, not global localization:
 * use well-spread, correctly matched points on visible surfaces.
 */
export function refineCameraPose(input: PoseRefinementInput): PoseRefinementResult {
  validateCameraIntrinsics(input.intrinsics);
  if (!finiteVector(input.initialPosition)) throw new Error("Initial camera position must be finite");
  if (!input.initialAttitude || ![input.initialAttitude.yaw, input.initialAttitude.pitch, input.initialAttitude.roll].every(Number.isFinite)) {
    throw new Error("Initial camera attitude must be finite");
  }
  if (!Array.isArray(input.controls) || input.controls.length < 4 || input.controls.length > 200) {
    throw new Error("Pose refinement requires between 4 and 200 matched control points");
  }
  const maxRmse = positiveOption(input.maxRmsePx, 8, "Maximum reprojection RMSE");
  const maxError = positiveOption(input.maxErrorPx, 20, "Maximum control point error");
  const maxPosition = positiveOption(input.maxPositionCorrectionMeters, 250, "Maximum position correction");
  const maxAngle = positiveOption(input.maxAngleCorrectionDegrees, 30, "Maximum angle correction");
  const maxIterations = input.maxIterations ?? 80;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 200) throw new Error("Iteration limit must be between 1 and 200");
  if (maxAngle > 90) throw new Error("Angle correction must stay within 90 degrees of the initial pose");
  for (const control of input.controls) {
    if (!control || !finiteVector(control.world) || ![control.pixelX, control.pixelY].every(Number.isFinite)) {
      throw new Error("Matched pixels and scene control points must be finite");
    }
    if (control.pixelX < 0 || control.pixelX > input.intrinsics.width || control.pixelY < 0 || control.pixelY > input.intrinsics.height) {
      throw new Error("Control point pixels must lie inside the original source image");
    }
    // Validate the calibrated image domain once, before optimization.
    undistortPixel(input.intrinsics, control.pixelX, control.pixelY, input.distortion);
  }
  requireSpread(input.controls.map((control) => ({ x: control.pixelX, y: control.pixelY, z: 0 })), 4, "Image");
  requireSpread(input.controls.map((control) => control.world), 0.01, "Scene");

  const initial = [
    input.initialPosition.x, input.initialPosition.y, input.initialPosition.z,
    input.initialAttitude.yaw, input.initialAttitude.pitch, input.initialAttitude.roll,
  ];
  const toCamera = (parameters: readonly number[]): ControlPointCamera => ({
    position: { x: parameters[0], y: parameters[1], z: parameters[2] },
    attitude: { yaw: parameters[3], pitch: parameters[4], roll: parameters[5] },
    intrinsics: input.intrinsics,
    distortion: input.distortion,
  });
  const evaluate = (parameters: readonly number[]) => {
    const camera = toCamera(parameters);
    const frame = basis(camera.attitude);
    const residuals = input.controls.map((control) => {
      const projected = projectWithBasis(camera, frame, control.world);
      const errorX = projected.pixelX - control.pixelX;
      const errorY = projected.pixelY - control.pixelY;
      return { predictedPixelX: projected.pixelX, predictedPixelY: projected.pixelY, errorX, errorY, errorPx: Math.hypot(errorX, errorY) };
    });
    const vector = residuals.flatMap((residual) => [residual.errorX, residual.errorY]);
    const cost = vector.reduce((sum, value) => sum + value * value, 0);
    if (!Number.isFinite(cost)) throw new Error("Reprojection error is not finite");
    return { residuals, vector, cost };
  };
  const attempt = (parameters: readonly number[]) => { try { return evaluate(parameters); } catch { return undefined; } };
  const withinBounds = (parameters: readonly number[]) =>
    parameters.every(Number.isFinite)
    && Math.hypot(parameters[0] - initial[0], parameters[1] - initial[1], parameters[2] - initial[2]) <= maxPosition
    && parameters.slice(3).every((value, index) => Math.abs(value - initial[index + 3]) <= maxAngle);

  let parameters = [...initial];
  let current = evaluate(parameters);
  let damping = 1e-3;
  let iterations = 0;
  for (; iterations < maxIterations && current.cost > 1e-16; iterations += 1) {
    const derivatives: number[][] = [];
    for (let parameter = 0; parameter < PARAMETER_COUNT; parameter += 1) {
      const step = parameter < 3 ? 0.01 : 0.001;
      const plus = [...parameters]; plus[parameter] += step;
      const minus = [...parameters]; minus[parameter] -= step;
      const positive = attempt(plus);
      const negative = attempt(minus);
      if (!positive && !negative) throw new Error("Pose fit is ill-conditioned near a camera visibility boundary");
      derivatives.push(current.vector.map((value, index) => positive && negative
        ? (positive.vector[index] - negative.vector[index]) / (2 * step)
        : positive ? (positive.vector[index] - value) / step : (value - negative!.vector[index]) / step));
    }
    const normal = Array.from({ length: PARAMETER_COUNT }, () => new Array<number>(PARAMETER_COUNT).fill(0));
    const gradient = new Array<number>(PARAMETER_COUNT).fill(0);
    for (let row = 0; row < PARAMETER_COUNT; row += 1) {
      for (let sample = 0; sample < current.vector.length; sample += 1) {
        gradient[row] += derivatives[row][sample] * current.vector[sample];
      }
      for (let column = 0; column < PARAMETER_COUNT; column += 1) {
        for (let sample = 0; sample < current.vector.length; sample += 1) {
          normal[row][column] += derivatives[row][sample] * derivatives[column][sample];
        }
      }
    }
    const damped = normal.map((row, index) => row.map((value, column) =>
      value + (column === index ? damping * Math.max(normal[index][index], 1e-8) : 0)));
    const delta = solveLinear(damped, gradient.map((value) => -value));
    if (!delta) {
      damping *= 10;
      if (damping > 1e12) break;
      continue;
    }
    // Bound a single trial as well as the total correction. This keeps the
    // local solve away from flipped planar-PnP branches and horizon crossings.
    const fraction = Math.min(1, 20 / Math.max(20, Math.hypot(...delta.slice(0, 3))),
      5 / Math.max(5, ...delta.slice(3).map(Math.abs)));
    const candidate = parameters.map((value, index) => value + delta[index] * fraction);
    const trial = withinBounds(candidate) ? attempt(candidate) : undefined;
    if (trial && trial.cost < current.cost) {
      const improvement = current.cost - trial.cost;
      parameters = candidate;
      current = trial;
      damping = Math.max(1e-12, damping / 3);
      if (improvement <= Math.max(1e-14, current.cost * 1e-12)) { iterations += 1; break; }
    } else {
      damping *= 10;
      if (damping > 1e12) break;
    }
  }
  const rmsePx = Math.sqrt(current.cost / input.controls.length);
  const maxErrorPx = Math.max(...current.residuals.map((residual) => residual.errorPx));
  if (!Number.isFinite(rmsePx) || rmsePx > maxRmse || maxErrorPx > maxError) {
    throw new Error(`Control point fit failed: RMS ${rmsePx.toFixed(2)}px, maximum ${maxErrorPx.toFixed(2)}px. Check point matches, scene heights and initial pose.`);
  }
  const fitted = toCamera(parameters);
  return { position: fitted.position, attitude: fitted.attitude, rmsePx, maxErrorPx, residuals: current.residuals, iterations };
}
