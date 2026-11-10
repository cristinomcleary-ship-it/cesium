import { Cartesian3, Matrix3, Matrix4 } from 'cesium';
import type { CcCameraSample } from './ccCameraTrack.ts';
import type { CameraIntrinsics, LensDistortion } from './videoArCamera.ts';
import { projectSpatialWorldPoint, type SpatialCameraBasis, type SpatialVideoProjection } from './videoOverlaySpatialBinding.ts';
import type { SpatialPoint } from './videoOverlaySpatialAnnotations.ts';

/** Frozen after AR adjustments, including the model's scale; serializable in cache metadata. */
export type CachedSpatialFrames = Readonly<Record<string, readonly number[]>>;
export type CachedSpatialCamera = Pick<CcCameraSample, 'position' | 'direction' | 'up'>;
export type CachedSpatialProjectorOptions = {
  frames: CachedSpatialFrames;
  camera: CachedSpatialCamera | null | undefined;
  intrinsics: CameraIntrinsics;
  lens?: LensDistortion;
  /** Caller applies current target selection and the baked timeline visibility. */
  targetVisible?: (targetId: string) => boolean;
};

const finite = (point: SpatialPoint) => [point.x, point.y, point.z].every(Number.isFinite);
const vector = (point: SpatialPoint) => new Cartesian3(point.x, point.y, point.z);

/** Match the orthonormal camera basis used by Cesium setView, without reading or moving its camera. */
function cameraBasis(camera: CachedSpatialCamera | null | undefined): SpatialCameraBasis | undefined {
  if (!camera || !finite(camera.position) || !finite(camera.direction) || !finite(camera.up)) return;
  const direction = vector(camera.direction), up = vector(camera.up);
  if (Cartesian3.magnitudeSquared(direction) < 1e-20 || Cartesian3.magnitudeSquared(up) < 1e-20) return;
  Cartesian3.normalize(direction, direction); Cartesian3.normalize(up, up);
  const right = Cartesian3.cross(direction, up, new Cartesian3());
  if (Cartesian3.magnitudeSquared(right) < 1e-20) return;
  Cartesian3.normalize(right, right);
  Cartesian3.cross(right, direction, up);
  return { position: { ...camera.position }, direction, right, up };
}

/**
 * Decode-free, render-free projection for the annotation layer over the cached movie.
 * Construct once per presented video frame, then project all anchors with the same
 * immutable camera and object frames. There are no model, depth or viewer queries.
 */
export function createCachedSpatialProjector(options: CachedSpatialProjectorOptions): {
  project: (targetId: string, local: SpatialPoint) => SpatialVideoProjection | undefined;
  targetVisible: (targetId: string) => boolean;
} {
  const basis = cameraBasis(options.camera), frames = new Map<string, Matrix4>();
  for (const [id, values] of Object.entries(options.frames)) {
    // spatialFrame is an affine transform. Reject corrupt cache metadata rather
    // than silently projecting its anchors at the world origin.
    if (!Array.isArray(values) || values.length !== 16 || !values.every(Number.isFinite)
      || Math.abs(values[3]) > 1e-10 || Math.abs(values[7]) > 1e-10 || Math.abs(values[11]) > 1e-10 || Math.abs(values[15] - 1) > 1e-10) continue;
    const matrix = Matrix4.fromArray(values);
    if (Math.abs(Matrix3.determinant(Matrix4.getMatrix3(matrix, new Matrix3()))) < 1e-20) continue;
    frames.set(id, matrix);
  }
  const targetVisible = (id: string) => !!basis && frames.has(id) && (options.targetVisible?.(id) ?? true);
  return {
    targetVisible,
    project: (id, local) => {
      if (!targetVisible(id) || !finite(local)) return;
      const world = Matrix4.multiplyByPoint(frames.get(id)!, vector(local), new Cartesian3());
      return projectSpatialWorldPoint(world, basis!, options.intrinsics, options.lens);
    },
  };
}
