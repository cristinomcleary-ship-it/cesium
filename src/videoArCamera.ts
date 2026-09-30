/**
 * Camera math independent of Cesium.
 *
 * Intrinsics use original source-image pixels, with (0, 0) at the top left.
 * Normalized optical coordinates are right/down; the optical axis is forward.
 * Attitudes use aerospace NED yaw/pitch/roll (degrees): yaw clockwise from north,
 * positive pitch upward, positive roll right wing down. Returned rays use ENU.
 */
export type CameraIntrinsics = Readonly<{
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}>;

export type LensDistortion = Readonly<{
  k1?: number;
  k2?: number;
  k3?: number;
  p1?: number;
  p2?: number;
}>;

export type CameraAttitude = Readonly<{ yaw: number; pitch: number; roll: number }>;
export type CameraPoint2 = Readonly<{ x: number; y: number }>;
export type CameraVector3 = Readonly<{ x: number; y: number; z: number }>;

const MAX_NORMALIZED_RADIUS = 10_000;
const INVERSE_ITERATIONS = 40;
const INVERSE_TOLERANCE = 1e-12;

export function validateCameraIntrinsics(intrinsics: CameraIntrinsics): CameraIntrinsics {
  if (!intrinsics || ![intrinsics.width, intrinsics.height, intrinsics.fx, intrinsics.fy,
    intrinsics.cx, intrinsics.cy].every(Number.isFinite)) {
    throw new Error("Camera intrinsics must contain finite width, height, fx, fy, cx and cy");
  }
  if (!Number.isInteger(intrinsics.width) || !Number.isInteger(intrinsics.height)
    || intrinsics.width <= 0 || intrinsics.height <= 0
    || intrinsics.fx <= 0 || intrinsics.fy <= 0) {
    throw new Error("Camera image dimensions and focal lengths must be positive");
  }
  return intrinsics;
}

function coefficients(distortion: LensDistortion) {
  const values = {
    k1: distortion.k1 ?? 0,
    k2: distortion.k2 ?? 0,
    k3: distortion.k3 ?? 0,
    p1: distortion.p1 ?? 0,
    p2: distortion.p2 ?? 0,
  };
  if (!Object.values(values).every(Number.isFinite)) {
    throw new Error("Lens distortion coefficients must be finite");
  }
  return values;
}

function checkPoint(point: CameraPoint2) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
    || Math.hypot(point.x, point.y) > MAX_NORMALIZED_RADIUS) {
    throw new Error("Camera point is outside the supported finite ray range");
  }
}

function evaluateDistortion(point: CameraPoint2, lens: Required<LensDistortion>) {
  const { x, y } = point;
  const { k1, k2, k3, p1, p2 } = lens;
  const radius2 = x * x + y * y;
  const radius4 = radius2 * radius2;
  const radial = 1 + k1 * radius2 + k2 * radius4 + k3 * radius4 * radius2;
  const slope = k1 + 2 * k2 * radius2 + 3 * k3 * radius4;
  const radialX = 2 * x * slope;
  const radialY = 2 * y * slope;
  return {
    x: x * radial + 2 * p1 * x * y + p2 * (radius2 + 2 * x * x),
    y: y * radial + p1 * (radius2 + 2 * y * y) + 2 * p2 * x * y,
    xx: radial + x * radialX + 2 * p1 * y + 6 * p2 * x,
    xy: x * radialY + 2 * p1 * x + 2 * p2 * y,
    yx: y * radialX + 2 * p1 * x + 2 * p2 * y,
    yy: radial + y * radialY + 6 * p1 * y + 2 * p2 * x,
    radial,
  };
}

/** Apply the Brown-Conrady radial/tangential model to an undistorted point. */
export function distortNormalizedPoint(
  point: CameraPoint2,
  distortion: LensDistortion = {},
): CameraPoint2 {
  checkPoint(point);
  const value = evaluateDistortion(point, coefficients(distortion));
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error("Lens distortion produced a non-finite image coordinate");
  }
  return { x: value.x, y: value.y };
}

/**
 * Convert a source-image pixel to its ideal pinhole ray coordinate.
 * The inverse is solved with damped Newton steps, not by negating coefficients.
 * Folded/non-invertible models and failure to converge are rejected explicitly.
 */
export function undistortPixel(
  intrinsics: CameraIntrinsics,
  pixelX: number,
  pixelY: number,
  distortion: LensDistortion = {},
): CameraPoint2 {
  validateCameraIntrinsics(intrinsics);
  if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) {
    throw new Error("Camera pixel coordinates must be finite");
  }
  const lens = coefficients(distortion);
  const target = {
    x: (pixelX - intrinsics.cx) / intrinsics.fx,
    y: (pixelY - intrinsics.cy) / intrinsics.fy,
  };
  checkPoint(target);
  if (Object.values(lens).every((value) => value === 0)) return target;
  let point = { ...target };
  const tolerance = INVERSE_TOLERANCE * Math.max(1, Math.hypot(target.x, target.y));
  for (let iteration = 0; iteration < INVERSE_ITERATIONS; iteration += 1) {
    const value = evaluateDistortion(point, lens);
    const determinant = value.xx * value.yy - value.xy * value.yx;
    if (![value.x, value.y, determinant].every(Number.isFinite)
      || determinant <= 1e-12 || value.xx <= 0 || value.yy <= 0 || value.radial <= 0) {
      throw new Error("Lens distortion is folded or non-invertible at this pixel");
    }
    const errorX = value.x - target.x;
    const errorY = value.y - target.y;
    const residual = Math.hypot(errorX, errorY);
    if (residual <= tolerance) {
      // An outer Newton root can be locally invertible despite a folded annulus
      // between it and the optical axis. Sample that path once at convergence;
      // never accept the disconnected branch of an obviously folded calibration.
      // This is a bounded diagnostic guard, not proof for every polynomial fit.
      for (let sample = 1; sample < 16; sample += 1) {
        const fraction = sample / 16;
        const between = evaluateDistortion({ x: point.x * fraction, y: point.y * fraction }, lens);
        const betweenDeterminant = between.xx * between.yy - between.xy * between.yx;
        if (![betweenDeterminant, between.radial].every(Number.isFinite)
          || betweenDeterminant <= 1e-12 || between.xx <= 0 || between.yy <= 0 || between.radial <= 0) {
          throw new Error("Lens distortion is folded between the optical axis and this pixel");
        }
      }
      return point;
    }
    const stepX = (value.yy * errorX - value.xy * errorY) / determinant;
    const stepY = (-value.yx * errorX + value.xx * errorY) / determinant;
    let accepted = false;
    for (let damping = 1; damping >= 1 / 4096; damping /= 2) {
      const next = { x: point.x - damping * stepX, y: point.y - damping * stepY };
      if (!Number.isFinite(next.x) || !Number.isFinite(next.y)
        || Math.hypot(next.x, next.y) > MAX_NORMALIZED_RADIUS) continue;
      const projected = evaluateDistortion(next, lens);
      if (Math.hypot(projected.x - target.x, projected.y - target.y) < residual) {
        point = next;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  throw new Error("Lens distortion inverse did not converge; check the calibration");
}

/** Apply Rz(yaw) * Ry(pitch) * Rx(roll) to a forward/right/down vector. */
function rotateNed(vector: CameraVector3, attitude: CameraAttitude): CameraVector3 {
  if (!attitude || ![attitude.yaw, attitude.pitch, attitude.roll].every(Number.isFinite)) {
    throw new Error("Camera attitude angles must be finite");
  }
  const radians = Math.PI / 180;
  // Reducing angles preserves precision for wrapped telemetry headings.
  const yaw = (attitude.yaw % 360) * radians;
  const pitch = (attitude.pitch % 360) * radians;
  const roll = (attitude.roll % 360) * radians;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const rolledY = cr * vector.y - sr * vector.z;
  const rolledZ = sr * vector.y + cr * vector.z;
  const pitchedX = cp * vector.x + sp * rolledZ;
  const pitchedZ = -sp * vector.x + cp * rolledZ;
  return {
    x: cy * pitchedX - sy * rolledY,
    y: sy * pitchedX + cy * rolledY,
    z: pitchedZ,
  };
}

/**
 * Rotate an ideal optical ray into east/north/up.
 * When aircraftAttitude is provided, cameraAttitude is relative to the aircraft:
 * R_world_from_camera = R_world_from_aircraft * R_aircraft_from_camera.
 */
export function cameraDirectionToEnu(
  point: CameraPoint2,
  cameraAttitude: CameraAttitude,
  aircraftAttitude?: CameraAttitude,
): CameraVector3 {
  checkPoint(point);
  let ned = rotateNed({ x: 1, y: point.x, z: point.y }, cameraAttitude);
  if (aircraftAttitude) ned = rotateNed(ned, aircraftAttitude);
  const magnitude = Math.hypot(ned.x, ned.y, ned.z);
  return { x: ned.y / magnitude, y: ned.x / magnitude, z: -ned.z / magnitude };
}

/** Get a normalized ENU ray for a source-image pixel and calibrated camera pose. */
export function cameraPixelToEnuDirection(
  intrinsics: CameraIntrinsics,
  pixelX: number,
  pixelY: number,
  cameraAttitude: CameraAttitude,
  distortion: LensDistortion = {},
  aircraftAttitude?: CameraAttitude,
): CameraVector3 {
  return cameraDirectionToEnu(
    undistortPixel(intrinsics, pixelX, pixelY, distortion),
    cameraAttitude,
    aircraftAttitude,
  );
}
