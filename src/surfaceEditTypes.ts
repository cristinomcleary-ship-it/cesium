/** Persist only parameters and confirmed boundary heights, never Cesium/GPU objects. */
export type SurfaceEditPoint = { longitude: number; latitude: number; height: number };
export type SurfaceEditKind = 'excavation' | 'flatten';
export type SurfaceEditTexture = {
  ground: 'soil' | 'sand' | 'gravel';
  wall: 'soil' | 'sand';
  scaleMeters: number;
  groundImage?: string;
  wallImage?: string;
};
export type SurfaceEditPlan = {
  version: 1;
  id: string;
  name: string;
  kind: SurfaceEditKind;
  targetId: string;
  /** Fingerprint of the selected photogrammetry transform when confirmed. */
  targetTransform: number[];
  boundary: SurfaceEditPoint[];
  holes: SurfaceEditPoint[][];
  /** Ellipsoidal height at the local design-plane origin; uses the scene's height datum. */
  targetHeight: number;
  clipTerrain: boolean;
  bottomVisible: boolean;
  texture: SurfaceEditTexture;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
export type SurfaceEditDraft = Pick<SurfaceEditPlan, 'name' | 'kind' | 'targetId' | 'targetHeight' | 'clipTerrain' | 'bottomVisible' | 'texture'> & {
  boundarySource: 'sampled' | 'picked' | 'manual';
  boundaryHeight: number;
};
export type SurfaceEditListItem = Pick<SurfaceEditPlan, 'id' | 'name' | 'kind' | 'enabled'> & { status: string };

/** Conservative development budgets. Real project/GPU acceptance is still required. */
export const SURFACE_EDIT_LIMITS = Object.freeze({
  plans: 32,
  boundaryPoints: 512,
  totalBoundaryPoints: 4096,
  holes: 16,
  imageBytes: 2 * 1024 * 1024,
  imageDimension: 2048,
  documentBytes: 16 * 1024 * 1024,
  workerTimeoutMs: 15_000,
  taskTimeoutMs: 30_000,
  drawPoints: 256,
});
