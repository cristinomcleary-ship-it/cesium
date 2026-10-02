import type { ControlPointCamera } from "./videoArControlPoints.ts";
import type { CameraVector3 } from "./videoArCamera.ts";
import type { ControlPointSession } from "./videoArControlPointSession.ts";

type Matrix3 = [[number, number, number], [number, number, number], [number, number, number]];

function multiply(left: Matrix3, right: Matrix3): Matrix3 {
  return left.map(row => [0, 1, 2].map(column =>
    row.reduce((sum, entry, index) => sum + entry * right[index][column], 0))) as Matrix3;
}

/** Independent CPU forward projection; no production ray/projection/GLSL helpers. */
export function projectControlPointCpu(camera: ControlPointCamera, world: CameraVector3) {
  const k = camera.intrinsics;
  if (!k || ![k.width, k.height, k.fx, k.fy, k.cx, k.cy].every(Number.isFinite)
    || !Number.isInteger(k.width) || !Number.isInteger(k.height)
    || k.width <= 0 || k.height <= 0 || k.fx <= 0 || k.fy <= 0) {
    throw new Error("CPU camera intrinsics must be finite with positive dimensions/focal lengths");
  }
  if (!world || !camera.position || !camera.attitude || ![
    world.x, world.y, world.z, camera.position.x, camera.position.y, camera.position.z,
    camera.attitude.yaw, camera.attitude.pitch, camera.attitude.roll,
  ].every(Number.isFinite)) throw new Error("CPU camera, attitude and world coordinates must be finite");
  const radians = Math.PI / 180;
  const yaw = (camera.attitude.yaw % 360) * radians;
  const pitch = (camera.attitude.pitch % 360) * radians;
  const roll = (camera.attitude.roll % 360) * radians;
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const rz: Matrix3 = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]];
  const ry: Matrix3 = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]];
  const rx: Matrix3 = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]];
  const rotation = multiply(multiply(rz, ry), rx); // Camera FRD -> geographic NED.
  const ned = [world.y - camera.position.y, world.x - camera.position.x, camera.position.z - world.z];
  // R is orthonormal: its transpose maps geographic NED back into camera FRD.
  const frd = [0, 1, 2].map(column => ned.reduce((sum, entry, row) => sum + rotation[row][column] * entry, 0));
  const depth = frd[0];
  if (!Number.isFinite(depth) || depth <= 1e-4) throw new Error("CPU point is behind or too close to the camera");
  const x = frd[1] / depth, y = frd[2] / depth; // Optical right/down/forward = FRD y/z/x.
  const { k1 = 0, k2 = 0, k3 = 0, p1 = 0, p2 = 0 } = camera.distortion ?? {};
  if (![k1, k2, k3, p1, p2].every(Number.isFinite)) throw new Error("CPU lens coefficients must be finite");
  const r2 = x * x + y * y;
  const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  const xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
  const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
  const pixelX = k.cx + k.fx * xd, pixelY = k.cy + k.fy * yd;
  if (![pixelX, pixelY].every(Number.isFinite)) throw new Error("CPU projected pixels must be finite");
  return { pixelX, pixelY, depth };
}

export type CpuPointEvaluation = {
  valid: boolean; predictedPixelX?: number; predictedPixelY?: number; depth?: number;
  errorX?: number; errorY?: number; errorPx?: number; errorPx1080?: number; reason?: string;
};
export type CpuResidualSummary = {
  count: number; validCount: number; invalidCount: number;
  rmsePx: number | null; p95Px: number | null; maxErrorPx: number | null;
};
export type CpuReprojectionPoint = {
  index: number; role: "fit" | "check"; fitInputIndex: number | null;
  fitMembership: "inlier" | "outlier" | "unclassified" | "not-fit";
  observed: { pixelX: number; pixelY: number };
  observed1080: { pixelX: number; pixelY: number };
  before: CpuPointEvaluation; after: CpuPointEvaluation | null;
};

function evaluateCpu(camera: ControlPointCamera, point: ControlPointSession["points"][number], scale: number): CpuPointEvaluation {
  try {
    if (![point.pixelX, point.pixelY].every(Number.isFinite)) throw new Error("Observed pixels must be finite");
    const projected = projectControlPointCpu(camera, point.world);
    const errorX = projected.pixelX - point.pixelX, errorY = projected.pixelY - point.pixelY;
    const errorPx = Math.hypot(errorX, errorY);
    if (!Number.isFinite(errorPx)) throw new Error("CPU residual must be finite");
    return { valid: true, predictedPixelX: projected.pixelX, predictedPixelY: projected.pixelY,
      depth: projected.depth, errorX, errorY, errorPx, errorPx1080: errorPx * scale };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function statistics(values: readonly CpuPointEvaluation[], scale: number): CpuResidualSummary {
  const errors = values.filter(value => value.valid && Number.isFinite(value.errorPx))
    .map(value => value.errorPx! * scale).sort((a, b) => a - b);
  const invalidCount = values.length - errors.length;
  const complete = errors.length > 0 && invalidCount === 0;
  return { count: values.length, validCount: errors.length, invalidCount,
    rmsePx: complete ? Math.hypot(...errors) / Math.sqrt(errors.length) : null,
    p95Px: complete ? errors[Math.ceil(errors.length * 0.95) - 1] : null,
    maxErrorPx: complete ? errors[errors.length - 1] : null };
}

/** Recompute every correspondence from stored cameras/world points; never reuse saved residuals. */
export function reprojectControlPointSessionCpu(session: ControlPointSession) {
  const width = session.frame.intrinsics.width, height = session.frame.intrinsics.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("CPU report requires positive finite original image dimensions");
  }
  const scale = 1920 / width;
  const before: ControlPointCamera = { position: { x: 0, y: 0, z: 0 }, attitude: session.frame.attitude,
    intrinsics: session.frame.intrinsics, distortion: session.frame.distortion };
  const after: ControlPointCamera | null = session.solution ? { ...before,
    position: session.solution.position, attitude: session.solution.attitude } : null;
  const fitCount = session.points.filter(point => point.role === "fit").length;
  const validFitIndex = (index: number) => Number.isInteger(index) && index >= 0 && index < fitCount;
  const inlierIndices = new Set((session.solution?.inlierIndices ?? []).filter(validFitIndex));
  const outlierIndices = new Set((session.solution?.outlierIndices ?? []).filter(validFitIndex));
  let fitInputIndex = -1;
  const points: CpuReprojectionPoint[] = session.points.map(point => {
    if (point.role === "fit") fitInputIndex += 1;
    const fitMembership = point.role === "check" ? "not-fit" : inlierIndices.has(fitInputIndex) && !outlierIndices.has(fitInputIndex)
      ? "inlier" : outlierIndices.has(fitInputIndex) && !inlierIndices.has(fitInputIndex) ? "outlier" : "unclassified";
    return { index: point.index, role: point.role, fitInputIndex: point.role === "fit" ? fitInputIndex : null,
      fitMembership, observed: { pixelX: point.pixelX, pixelY: point.pixelY },
      observed1080: { pixelX: point.pixelX * scale, pixelY: point.pixelY * scale },
      before: evaluateCpu(before, point, scale), after: after ? evaluateCpu(after, point, scale) : null };
  });
  const group = (phase: "before" | "after", pixelScale: number) => {
    const summarize = (filtered: CpuReprojectionPoint[]) => statistics(filtered.map(point => point[phase]
      ?? { valid: false, reason: "Camera not solved" }), pixelScale);
    return { fitAll: summarize(points.filter(point => point.role === "fit")),
      fitInliers: summarize(points.filter(point => point.role === "fit" && point.fitMembership === "inlier")),
      checks: summarize(points.filter(point => point.role === "check")) };
  };
  const phaseSummary = (phase: "before" | "after") => ({ original: group(phase, 1), normalized1080: group(phase, scale) });
  return {
    schema: "video-ar-independent-cpu-reprojection/v1" as const,
    acceptance: "not-validated" as const,
    sessionId: session.id, frameTime: session.frame.frameTime,
    image: { width, height, normalizedWidth: 1920, normalizedHeight: height * scale, scale },
    cameras: structuredClone({ before, after }), points,
    summary: { before: phaseSummary("before"), after: after ? phaseSummary("after") : null },
    notes: [
      "Independent CPU Rz(yaw)*Ry(pitch)*Rx(roll) NED matrices and forward Brown-Conrady model; no solver projection or shader helpers.",
      "All fit points and all checkpoints are retained. Consensus indices refer only to the ordered fit subset, never the full mixed list.",
      "Fit-inlier membership is taken from the final solution for both before/after statistics; missing or conflicting membership stays unclassified.",
      "Invalid projections remain counted and make that group's aggregate null; no checkpoint is discarded as an outlier.",
      "Normalized-1080 errors use isotropic scale 1920/originalWidth; normalized height equals 1080 only for 16:9 sources.",
      "P95 is nearest-rank. Independent code is not independent field evidence: point identity, surveyed accuracy, and withheld status require review.",
      "After residuals use the solved camera; they do not certify Cesium applied global offsets, rendered pixels or the rest of the flight.",
    ],
  };
}
