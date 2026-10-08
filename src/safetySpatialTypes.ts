import type { SafetyPosition, SafetySeverity } from "./safetyTypes.ts";

export type SpatialRiskLevel = "unassessed" | SafetySeverity;
export type ModelVersion = { assetId: string; assetVersion: string; coordinateTransformVersion: string };
export type ModelSurfaceAnchor = {
  position: { space: "ecef-meters"; x: number; y: number; z: number };
  model: ModelVersion;
  provenance: "verified-project-photogrammetry-surface";
  pickedAt: string;
};
export type ModelRegistryEntry = ModelVersion & {
  projectId: string; name: string; url: string;
  kind: "photogrammetry";
  matrix: number[];
  coordinateOffsets: { longitude: number; latitude: number; height: number };
  capabilitySource: "project-verified" | "test-registry";
};
export const SPATIAL_MODELS_API_PATH = "/__safety/models";

export type SpatialKind = "construction-area" | "railway" | "risk-point";
export type SpatialGeometry =
  | { type: "Polygon"; positions: SafetyPosition[] }
  | { type: "Corridor"; positions: SafetyPosition[]; widthMeters: number }
  | { type: "Point"; position: SafetyPosition };
export type SpatialObject = {
  id: string;
  /** Server-owned object revision; absent on preserved historical records until their next mutation. */
  revision?: number;
  kind: SpatialKind;
  name: string;
  creationSource?: "user_drawn_model_surface";
  level?: SpatialRiskLevel;
  description?: string;
  responsiblePerson?: string;
  lineName?: string;
  riskType?: string;
  createdBy?: string;
  updatedBy?: string;
  deletedAt?: string;
  deletedBy?: string;
  geometry: SpatialGeometry;
  visible: boolean;
  projectId: string;
  linkedNodeIds: string[];
  linkedMediaIds: string[];
  areaId?: string;
  railwayId?: string;
  source: {
    kind: "user-drawn";
    sceneCrs: "EPSG:4979";
    heightDatum: "unknown";
    vertices: Array<{
      pickKind: "model-depth" | "terrain" | "ellipsoid" | "manual";
      sourceHeight: number;
      sourceRecordId?: string;
      sourceEntityIndex?: number;
      anchor?: ModelSurfaceAnchor;
    }>;
  };
  confirmation: {
    status: "user-confirmed";
    confirmedAt: string;
    scope: "geometry-and-description";
  };
  risk?: {
    severity: SafetySeverity;
    status: "open" | "rectifying" | "closed";
    description: string;
    observedAt: number;
    observationSource: "replay-review" | "field-entry";
    videoId?: string;
    mediaSeconds?: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type SpatialSnapshot = { version: 1; revision: number; updatedAt: string; objects: SpatialObject[] };
export type SpatialMutation = { expectedRevision: number; mutationId: string } &
  ({ operation: "upsert"; object: SpatialObject } | { operation: "delete" | "restore"; id: string });
export const SPATIAL_API_PATH = "/__safety/spatial";
export const EMPTY_SPATIAL_SNAPSHOT: SpatialSnapshot = { version: 1, revision: 0, updatedAt: "1970-01-01T00:00:00.000Z", objects: [] };
