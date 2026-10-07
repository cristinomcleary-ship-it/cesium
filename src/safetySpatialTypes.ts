import type { SafetyPosition, SafetySeverity } from "./safetyTypes.ts";

export type SpatialKind = "construction-area" | "railway" | "risk-point";
export type SpatialGeometry =
  | { type: "Polygon"; positions: SafetyPosition[] }
  | { type: "Corridor"; positions: SafetyPosition[]; widthMeters: number }
  | { type: "Point"; position: SafetyPosition };
export type SpatialObject = {
  id: string;
  kind: SpatialKind;
  name: string;
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
  ({ operation: "upsert"; object: SpatialObject } | { operation: "delete"; id: string });
export const SPATIAL_API_PATH = "/__safety/spatial";
export const EMPTY_SPATIAL_SNAPSHOT: SpatialSnapshot = { version: 1, revision: 0, updatedAt: "1970-01-01T00:00:00.000Z", objects: [] };
