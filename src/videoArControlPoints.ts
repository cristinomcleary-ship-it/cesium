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
  /** Disable only for an explicit ordinary least-squares comparison. */
  robust?: boolean;
  /** Consensus radius in original reference-image pixels, not display pixels. */
  inlierThresholdPx?: number;
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
  /** RMS/max over retained fit inliers, in original source-video pixels. */
  rmsePx: number;
  maxErrorPx: number;
  /** All input fit points in their original order, including rejected matches. */
  residuals: readonly ControlPointResidual[];
  iterations: number;
  /** Zero-based indices into input.controls. Checkpoints must never be supplied. */
  inlierIndices: readonly number[];
  outlierIndices: readonly number[];
  allPointsRmsePx: number;
  allPointsMaxErrorPx: number;
  robust: Readonly<{
    method: "none" | "deterministic-consensus";
    thresholdPx: number;
    minimumInliers: number;
    hypothesesTested: number;
  }>;
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
type LeastSquaresResult = Pick<PoseRefinementResult,
  "position" | "attitude" | "rmsePx" | "maxErrorPx" | "residuals" | "iterations">;

function refineLeastSquares(input: PoseRefinementInput, enforceAcceptance = true): LeastSquaresResult {
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
  if (!Number.isFinite(rmsePx) || (enforceAcceptance && (rmsePx > maxRmse || maxErrorPx > maxError))) {
    throw new Error(`Control point fit failed: RMS ${rmsePx.toFixed(2)}px, maximum ${maxErrorPx.toFixed(2)}px. Check point matches, scene heights and initial pose.`);
  }
  const fitted = toCamera(parameters);
  return { position: fitted.position, attitude: fitted.attitude, rmsePx, maxErrorPx, residuals: current.residuals, iterations };
}

function allResiduals(camera: ControlPointCamera, controls: readonly ControlPointMatch[]) {
  const frame = basis(camera.attitude);
  return controls.map(control => {
    const projected = projectWithBasis(camera, frame, control.world);
    const errorX = projected.pixelX - control.pixelX, errorY = projected.pixelY - control.pixelY;
    return { predictedPixelX: projected.pixelX, predictedPixelY: projected.pixelY,
      errorX, errorY, errorPx: Math.hypot(errorX, errorY) };
  });
}

/**
 * Fixed-K, bounded six-DOF fit with deterministic outlier consensus. Only fit
 * points belong here: independent check points must be held out by the caller.
 * A clean ordinary fit is returned unchanged. Rejecting matches requires at
 * least five inliers AND two thirds of all input points; four arbitrary pairs
 * are never sufficient to rescue an otherwise inconsistent control set.
 * Consensus identifies geometrically inconsistent pairs, not incorrect scene
 * datums or a coherently wrong majority. Independent checks remain mandatory.
 */
export function refineCameraPose(input: PoseRefinementInput): PoseRefinementResult {
  const maxRmse = positiveOption(input.maxRmsePx, 8, "Maximum reprojection RMSE");
  const maxError = positiveOption(input.maxErrorPx, 20, "Maximum control point error");
  const threshold = positiveOption(input.inlierThresholdPx, Math.min(maxError, 2 * maxRmse), "Inlier threshold");
  if (threshold > maxError) throw new Error("Inlier threshold must not exceed the maximum control point error");
  // This first call also performs all input/geometry/visibility validation.
  const ordinary = refineLeastSquares(input, false);
  const count = input.controls.length;
  const indices = input.controls.map((_, index) => index);
  const minimumInliers = Math.max(5, Math.ceil(count * 2 / 3));
  let hypothesesTested = 1;
  const finish = (fit: LeastSquaresResult, residuals: readonly ControlPointResidual[], inliers: readonly number[],
    method: PoseRefinementResult["robust"]["method"]): PoseRefinementResult => {
    const retained = new Set(inliers);
    const cost = inliers.reduce((sum, index) => sum + residuals[index].errorPx ** 2, 0);
    const rmsePx = Math.sqrt(cost / inliers.length);
    const maxErrorPx = Math.max(...inliers.map(index => residuals[index].errorPx));
    if (rmsePx > maxRmse || maxErrorPx > maxError) {
      throw new Error(`Control point fit failed: inlier RMS ${rmsePx.toFixed(2)}px, maximum ${maxErrorPx.toFixed(2)}px. Check matches and initial pose.`);
    }
    return { ...fit, rmsePx, maxErrorPx, residuals,
      inlierIndices: [...inliers], outlierIndices: indices.filter(index => !retained.has(index)),
      allPointsRmsePx: Math.sqrt(residuals.reduce((sum, point) => sum + point.errorPx ** 2, 0) / count),
      allPointsMaxErrorPx: Math.max(...residuals.map(point => point.errorPx)),
      robust: { method, thresholdPx: threshold, minimumInliers, hypothesesTested } };
  };
  if (input.robust === false || count < 6
    || (ordinary.rmsePx <= maxRmse && ordinary.maxErrorPx <= Math.min(maxError, threshold))) {
    return finish(ordinary, ordinary.residuals, indices, "none");
  }

  type Candidate = { fit: LeastSquaresResult; residuals: readonly ControlPointResidual[]; inliers: number[]; cost: number };
  const candidates: Candidate[] = [];
  const inspect = (fit: LeastSquaresResult) => {
    try {
      const residuals = allResiduals({ ...fit, intrinsics: input.intrinsics, distortion: input.distortion }, input.controls);
      const inliers = indices.filter(index => residuals[index].errorPx <= threshold);
      if (inliers.length < minimumInliers) return;
      requireSpread(inliers.map(index => input.controls[index].world), 0.01, "Inlier scene");
      requireSpread(inliers.map(index => ({ x: input.controls[index].pixelX, y: input.controls[index].pixelY, z: 0 })), 4, "Inlier image");
      const cost = inliers.reduce((sum, index) => sum + residuals[index].errorPx ** 2, 0);
      candidates.push({ fit, residuals, inliers, cost });
    } catch { /* A behind-camera or degenerate consensus is not a valid rescue. */ }
  };
  inspect(ordinary);
  const samples: number[][] = [];
  const seen = new Set<string>();
  const addSample = (sample: number[]) => {
    sample.sort((left, right) => left - right);
    const key = sample.join(",");
    if (!seen.has(key)) { seen.add(key); samples.push(sample); }
  };
  // Leave-one-out reliably handles the common single mistaken click without
  // depending on a random draw. Small sets also enumerate every four-point seed.
  if (count <= 12) for (const omitted of indices) addSample(indices.filter(index => index !== omitted));
  if (count <= 10) {
    for (let a = 0; a < count - 3; a += 1) for (let b = a + 1; b < count - 2; b += 1)
      for (let c = b + 1; c < count - 1; c += 1) for (let d = c + 1; d < count; d += 1) addSample([a, b, c, d]);
  } else {
    // Bounded deterministic sampling keeps large control sets responsive and
    // replayable. It is a local robust fit, not a guaranteed global PnP search.
    let seed = 0x51f15e ^ count;
    const randomIndex = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) % count;
    };
    for (let attempt = 0; samples.length < 160 && attempt < 1000; attempt += 1) {
      const sample = new Set<number>();
      while (sample.size < 4) sample.add(randomIndex());
      addSample([...sample]);
    }
  }
  for (const sample of samples) {
    hypothesesTested += 1;
    try { inspect(refineLeastSquares({ ...input, controls: sample.map(index => input.controls[index]) }, false)); }
    catch { /* Invalid samples do not invalidate the remaining consensus trials. */ }
  }
  candidates.sort((left, right) => right.inliers.length - left.inliers.length || left.cost - right.cost);
  const refined = new Set<string>();
  for (const candidate of candidates) {
    let inliers = candidate.inliers;
    const key = inliers.join(",");
    if (refined.has(key)) continue;
    refined.add(key);
    try {
      for (let pass = 0; pass < 5; pass += 1) {
        // Every solve keeps the original telemetry bounds. The prior consensus
        // is only a selection mask, never a new origin that can ratchet bounds.
        const fit = refineLeastSquares({ ...input, controls: inliers.map(index => input.controls[index]) }, false);
        const residuals = allResiduals({ ...fit, intrinsics: input.intrinsics, distortion: input.distortion }, input.controls);
        const next = indices.filter(index => residuals[index].errorPx <= threshold);
        if (next.length < minimumInliers) break;
        if (next.join(",") === inliers.join(",")) return finish(fit, residuals, next, "deterministic-consensus");
        inliers = next;
      }
    } catch { /* Try another consensus if strict final acceptance fails. */ }
  }
  throw new Error(`Control point fit failed: no stable consensus of at least ${minimumInliers}/${count} fit points within ${threshold.toFixed(2)}px. Review mismatches; independent checkpoints cannot be used to rescue this fit.`);
}
