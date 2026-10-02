import { Cartesian3, Cartographic, Matrix4, Transforms, Math as CesiumMath } from "cesium";
import { cameraDirectionToEnu, undistortPixel, validateCameraIntrinsics, type CameraAttitude, type CameraIntrinsics, type CameraVector3, type LensDistortion } from "./videoArCamera.ts";
import type { ResolvedDjiHeight } from "./videoArHeight.ts";

type ReadonlyDeep<T> = T extends object ? { readonly [P in keyof T]: ReadonlyDeep<T[P]> } : T;
export type CameraFrameInput = {
  sourceIdentity: { session: string | number; video: { name: string; sizeBytes: number; lastModified: number } | null; trajectory: { name: string; sizeBytes: number; lastModified: number } | null };
  videoTimeMs: number; poseTimeMs?: number; videoSampleIndex?: number;
  longitude: number; latitude: number; rawAbsAltitude: number; rawRelativeAltitude?: number;
  /** Non-DJI path supplies its existing height mapping here. DJI supplies explicit resolvedHeight. */
  mappedHeightMeters: number; resolvedHeight?: ResolvedDjiHeight;
  attitude: CameraAttitude; aircraft?: CameraAttitude;
  referenceWidth: number; referenceHeight: number;
  djiIntrinsics?: Pick<CameraIntrinsics, "fx" | "fy" | "cx" | "cy">;
  fallbackHorizontalTangent: number; fallbackVerticalTangent: number;
  calibrationEnabled: boolean;
  manual: Partial<Pick<CameraIntrinsics, "fx" | "fy" | "cx" | "cy">>;
  distortion: LensDistortion;
  corrections: { east: number; north: number; height: number; yaw: number; pitch: number; roll: number; footprintScale: number };
  allowProjection: boolean; projectionMethod: string;
};

function immutable<T>(value: T): ReadonlyDeep<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value as ReadonlyDeep<T>;
}
const plain = (p: Cartesian3): CameraVector3 => ({ x: p.x, y: p.y, z: p.z });
const cartesian = (p: CameraVector3) => new Cartesian3(p.x, p.y, p.z);
/** Deterministic config identifier, not a media-content checksum. */
function configId(value: unknown) {
  const text = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return "config-fnv1a32-" + (hash >>> 0).toString(16).padStart(8, "0");
}

/** Pure: no viewer, DOM, terrain sampling, clock reads or mutable caller-owned state. */
export function resolveCameraFrame(input: CameraFrameInput) {
  if (!Number.isFinite(input.videoTimeMs) || input.videoTimeMs < 0) throw new Error("Decoded camera PTS must be finite and non-negative");
  if (input.poseTimeMs !== undefined && !Number.isFinite(input.poseTimeMs)) throw new Error("Pose media time must be finite");
  if (![input.longitude, input.latitude, input.rawAbsAltitude, input.mappedHeightMeters].every(Number.isFinite)) throw new Error("Camera position must be finite");
  const correction = input.calibrationEnabled ? { ...input.corrections } : { east: 0, north: 0, height: 0, yaw: 0, pitch: 0, roll: 0, footprintScale: 1 };
  if (!Object.values(correction).every(Number.isFinite) || correction.footprintScale <= 0) throw new Error("Camera corrections must be finite");
  const height = input.resolvedHeight ? structuredClone(input.resolvedHeight) : undefined;
  const h = height?.ellipsoidHeight ?? input.mappedHeightMeters;
  const telemetryOrigin = Cartesian3.fromDegrees(input.longitude, input.latitude, h);
  const translation = Matrix4.multiplyByPointAsVector(Transforms.eastNorthUpToFixedFrame(telemetryOrigin), new Cartesian3(correction.east, correction.north, 0), new Cartesian3());
  const origin = Cartesian3.add(telemetryOrigin, translation, new Cartesian3());
  const llh = Cartographic.fromCartesian(origin);
  const attitude = { yaw: input.attitude.yaw + correction.yaw, pitch: input.attitude.pitch + correction.pitch, roll: input.attitude.roll + correction.roll };
  const width = input.referenceWidth, heightPixels = input.referenceHeight;
  const fallback = { fx: width / (2 * input.fallbackHorizontalTangent), fy: heightPixels / (2 * input.fallbackVerticalTangent), cx: width / 2, cy: heightPixels / 2 };
  const provenance: Record<string, string> = {};
  const value = (key: "fx" | "fy" | "cx" | "cy") => {
    const manual = input.calibrationEnabled ? input.manual[key] : undefined;
    provenance[key] = manual !== undefined ? "manual-unverified" : input.djiIntrinsics ? "DJI-estimated" : "FOV-image-center";
    return manual ?? input.djiIntrinsics?.[key] ?? fallback[key];
  };
  const intrinsics = validateCameraIntrinsics({ width, height: heightPixels, fx: value("fx") / correction.footprintScale, fy: value("fy") / correction.footprintScale, cx: value("cx"), cy: value("cy") });
  provenance.footprintScale = String(correction.footprintScale);
  const distortion: LensDistortion = input.calibrationEnabled ? { ...input.distortion } : { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
  if (!Object.values(distortion).every(Number.isFinite)) throw new Error("Lens coefficients must be finite");
  // Validate inverse model at the corners too; folded calibration cannot enter either ray path.
  for (const [x,y] of [[0,0],[width,0],[0,heightPixels],[width,heightPixels]]) undistortPixel(intrinsics,x,y,distortion);
  const transform = Transforms.eastNorthUpToFixedFrame(origin);
  const rotate = (p: CameraVector3) => Cartesian3.normalize(Matrix4.multiplyByPointAsVector(transform, cartesian(p), new Cartesian3()), new Cartesian3());
  const forward = rotate(cameraDirectionToEnu({ x: 0, y: 0 }, attitude, input.aircraft));
  const top = rotate(cameraDirectionToEnu({ x: 0, y: -1 }, attitude, input.aircraft));
  const right = Cartesian3.normalize(Cartesian3.cross(forward, top, new Cartesian3()), new Cartesian3());
  const up = Cartesian3.normalize(Cartesian3.cross(right, forward, new Cartesian3()), new Cartesian3());
  const datumConfiguration = height ? { mode: height.mode, datumHeight: height.mode === "source" ? undefined : height.datumHeight, sourceToEllipsoidOffset: height.sourceToEllipsoidOffset } : undefined;
  const configuration = { datumConfiguration, corrections: correction, intrinsics, distortion, aircraft: input.aircraft };
  const positionEcef = plain(origin);
  return immutable({
    schema: "resolved-video-camera/v1" as const, parameterStage: "resolved-camera" as const,
    sourceIdentity: { ...structuredClone(input.sourceIdentity), calibration: configId(configuration), identityStrength: "file-metadata-and-load-session; media-content-hash-not-computed" },
    videoTimeMs: input.videoTimeMs, poseTimeMs: input.poseTimeMs,
    frameTime: input.videoTimeMs / 1000, poseVideoTimeMs: input.poseTimeMs, videoSampleIndex: input.videoSampleIndex,
    referenceWidth: width, referenceHeight: heightPixels, intrinsics, distortion,
    rawAbsAltitude: input.rawAbsAltitude, rawRelativeAltitude: input.rawRelativeAltitude, sourceAltitude: input.rawAbsAltitude,
    altitudeMode: height?.mode === "source" ? "verified_absolute" : height?.mode === "relative" ? "relative_takeoff" : "estimated",
    datumSource: height?.explanation ?? "legacy non-DJI mapping; not independently verified", height,
    effectiveHeightMeters: llh.height, ellipsoidHeight: llh.height,
    longitude: CesiumMath.toDegrees(llh.longitude), latitude: CesiumMath.toDegrees(llh.latitude),
    originEcef: positionEcef, positionEcef, directionEcef: plain(forward), upEcef: plain(up), rightEcef: plain(right),
    attitude, aircraft: input.aircraft ? { ...input.aircraft } : undefined,
    corrections: correction, intrinsicsSource: provenance,
    provenance: { intrinsics: provenance, datum: height?.estimated ? "estimated" : height ? "user-declared; geodetic evidence not independently checked" : "legacy mapping", distortion: input.calibrationEnabled ? "manual-unverified" : "zero-assumption" },
    quality: { acceptance: "not-validated" as const, height: height?.estimated ? "estimated" : height?.valid ? "user-declared" : height ? "missing" : "unverified", cameraCalibration: "unverified", timing: input.poseTimeMs === undefined ? "pose media time unavailable" : "media-PTS association; sensor latency unverified" },
    horizontalFovDegrees: CesiumMath.toDegrees(Math.atan(intrinsics.cx / intrinsics.fx) + Math.atan((width - intrinsics.cx) / intrinsics.fx)),
    verticalFovDegrees: CesiumMath.toDegrees(Math.atan(intrinsics.cy / intrinsics.fy) + Math.atan((heightPixels - intrinsics.cy) / intrinsics.fy)),
    calibrationEnabled: input.calibrationEnabled, allowProjection: input.allowProjection && (!height || height.valid), projectionMethod: input.projectionMethod,
  });
}
export type ResolvedCameraFrame = ReturnType<typeof resolveCameraFrame>;
/** A texture can only be committed with the camera resolved for that decoded PTS. */
export function cameraMatchesTexture(frame: ResolvedCameraFrame | undefined, textureTimeMs: number) {
  return Boolean(frame?.allowProjection && Number.isFinite(textureTimeMs) && Math.abs(frame.videoTimeMs - textureTimeMs) < 0.1);
}
export function cameraFrameRay(frame: ResolvedCameraFrame, u: number, v: number): CameraVector3 {
  const ideal = undistortPixel(frame.intrinsics, u * frame.referenceWidth, v * frame.referenceHeight, frame.distortion);
  const direction = new Cartesian3(
    frame.directionEcef.x + ideal.x * frame.rightEcef.x - ideal.y * frame.upEcef.x,
    frame.directionEcef.y + ideal.x * frame.rightEcef.y - ideal.y * frame.upEcef.y,
    frame.directionEcef.z + ideal.x * frame.rightEcef.z - ideal.y * frame.upEcef.z);
  return plain(Cartesian3.normalize(direction, direction));
}
