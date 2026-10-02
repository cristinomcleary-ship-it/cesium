import { projectControlPoint, type ControlPointCamera, type ControlPointMatch, type PoseRefinementResult } from "./videoArControlPoints.ts";
import type { CameraAttitude, CameraIntrinsics, CameraVector3, LensDistortion } from "./videoArCamera.ts";

export type RecordedControlPoint = ControlPointMatch & { worldEcef: CameraVector3; role: "fit" | "check" };
export type SessionFrame = {
  originEcef: CameraVector3; frameTime: number; sourceKey?: string | number;
  context?: Record<string, unknown>; intrinsics: CameraIntrinsics;
  distortion?: LensDistortion; attitude: CameraAttitude;
};
export type PointEvaluation = { valid: boolean; predictedPixelX?: number; predictedPixelY?: number;
  errorX?: number; errorY?: number; errorPx?: number; reason?: string };
export type ResidualSummary = { count: number; validCount: number; invalidCount: number;
  rmsePx: number | null; p95Px: number | null; maxErrorPx: number | null };
export type ControlPointSession = {
  schema: "video-ar-control-points/v1"; id: string; recordedAt: string;
  status: "recorded-not-solved" | "solved-not-accepted";
  acceptance: "not-validated";
  applicationStatus: "not-confirmed" | "applied";
  applicationScope: "global-offsets-derived-from-one-frame";
  appliedAt?: string;
  coordinateReference: { worldEcef: "EPSG:4978"; local: "ENU metres at frame.originEcef"; pixels: "original source pixels, origin top-left" };
  frame: SessionFrame;
  points: Array<RecordedControlPoint & { index: number; before: PointEvaluation; after: PointEvaluation | null }>;
  summary: { before: { fit: ResidualSummary; check: ResidualSummary };
    after: { fit: ResidualSummary; check: ResidualSummary } | null };
  solution: PoseRefinementResult | null;
  notes: string[];
};

export function evaluateControlPoint(camera: ControlPointCamera, point: ControlPointMatch): PointEvaluation {
  try {
    if (![point.pixelX, point.pixelY].every(Number.isFinite)) throw new Error("Observed pixels are not finite");
    const projected = projectControlPoint(camera, point.world);
    const errorX = projected.pixelX - point.pixelX, errorY = projected.pixelY - point.pixelY;
    return { valid: true, predictedPixelX: projected.pixelX, predictedPixelY: projected.pixelY,
      errorX, errorY, errorPx: Math.hypot(errorX, errorY) };
  } catch (error) { return { valid: false, reason: error instanceof Error ? error.message : String(error) }; }
}

export function summarizeResiduals(values: readonly PointEvaluation[]): ResidualSummary {
  const errors = values.filter(value => value.valid && Number.isFinite(value.errorPx)).map(value => value.errorPx!).sort((a, b) => a - b);
  const invalidCount = values.length - errors.length;
  // An invalid check cannot disappear into a deceptively good aggregate.
  const complete = errors.length > 0 && invalidCount === 0;
  return { count: values.length, validCount: errors.length, invalidCount,
    rmsePx: complete ? Math.sqrt(errors.reduce((sum, n) => sum + n * n, 0) / errors.length) : null,
    p95Px: complete ? errors[Math.ceil(errors.length * 0.95) - 1] : null,
    maxErrorPx: complete ? errors.at(-1)! : null };
}

export function makeControlPointSession(input: {
  id?: string; frame: SessionFrame; points: readonly RecordedControlPoint[]; solution?: PoseRefinementResult;
}): ControlPointSession {
  if (!Number.isFinite(input.frame.frameTime) || !Object.values(input.frame.originEcef).every(Number.isFinite)) {
    throw new Error("The frozen frame time and ECEF origin must be finite");
  }
  for (const point of input.points) {
    if (point.role !== "fit" && point.role !== "check") throw new Error("Control-point role must be fit or check");
    if (![point.pixelX, point.pixelY, point.world.x, point.world.y, point.world.z,
      point.worldEcef.x, point.worldEcef.y, point.worldEcef.z].every(Number.isFinite)) throw new Error("Control-point coordinates must be finite");
  }
  const before: ControlPointCamera = { position: { x: 0, y: 0, z: 0 }, attitude: input.frame.attitude,
    intrinsics: input.frame.intrinsics, distortion: input.frame.distortion };
  const after: ControlPointCamera | undefined = input.solution ? { ...before,
    position: input.solution.position, attitude: input.solution.attitude } : undefined;
  const points = input.points.map((point, index) => ({ ...structuredClone(point), index: index + 1,
    before: evaluateControlPoint(before, point), after: after ? evaluateControlPoint(after, point) : null }));
  const group = (phase: "before" | "after", role: "fit" | "check") => summarizeResiduals(
    points.filter(point => point.role === role).map(point => point[phase] ?? { valid: false, reason: "Not solved" }));
  return {
    schema: "video-ar-control-points/v1", id: input.id ?? crypto.randomUUID(), recordedAt: new Date().toISOString(),
    status: after ? "solved-not-accepted" : "recorded-not-solved", acceptance: "not-validated",
    applicationStatus: "not-confirmed", applicationScope: "global-offsets-derived-from-one-frame",
    coordinateReference: { worldEcef: "EPSG:4978", local: "ENU metres at frame.originEcef", pixels: "original source pixels, origin top-left" },
    frame: structuredClone(input.frame), points,
    summary: { before: { fit: group("before", "fit"), check: group("before", "check") },
      after: after ? { fit: group("after", "fit"), check: group("after", "check") } : null },
    solution: input.solution ? structuredClone(input.solution) : null,
    notes: ["Checkpoints are excluded from optimization; if used to tune parameters they are no longer independent.",
      "Statistics are Euclidean original-video pixel errors; P95 uses the nearest-rank method.",
      "A single-frame pose fit does not validate the full flight or absolute geodetic accuracy.",
      "After residuals evaluate the solved camera before Cesium rendering; global-offset application may differ and requires separate checks."],
  };
}
