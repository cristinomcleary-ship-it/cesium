import type { ManagementRecord } from "./managementTypes.ts";

/** User-entered WGS84 longitude/latitude (degrees), ellipsoid height (metres). */
export type RailSafetyPosition = { longitude: number; latitude: number; height: number };
/** Open ring: do not repeat the first point. 3–128 vertices, local worksite extent. */
export type RailSafetyPolygon = RailSafetyPosition[];
/** Ground support rectangle in machine-local metres: source model X/Z horizontal axes. */
export type RailSafetySupport = { length: number; width: number; centerX: number; centerZ: number };
/** Independent personnel work area; the existing guard.polygon remains the responsibility area. */
export type RailSafetyWorkArea = { polygon: RailSafetyPolygon; deviceId?: string; staleAfterSeconds?: number };
export type RailSafetyGuard = { schemaVersion: 1; kind: "guard"; station: RailSafetyPosition; polygon: RailSafetyPolygon; resourceIds: string[]; workArea?: RailSafetyWorkArea };
/** The adapter must supply WGS84 explicitly. GCJ-02/BD-09 coordinates must be converted upstream. */
export type RailSafetyPositionSample = {
  projectId: string; deviceId: string; coordinateSystem: "WGS84"; position: RailSafetyPosition;
  /** ISO 8601 instant with an explicit timezone, measured at the source. */
  timestamp: string;
  /** Horizontal uncertainty radius in metres; never inferred when missing. */
  accuracyMeters: number;
  /** A source label, not proof that a device has been authenticated or connected. */
  source: "measured" | "simulated";
};
export type RailSafetyPositioningState = "inside" | "outside" | "uncertain" | "stale" | "unconfigured" | "no-fix";
export type RailSafetyPositioningResult = {
  state: RailSafetyPositioningState; reason: string; isAlarm: boolean;
  source?: RailSafetyPositionSample["source"]; sample?: RailSafetyPositionSample; boundaryDistanceMeters?: number;
};
export type RailSafetyConstructionClass = "window" | "A" | "B" | "C";
export const RAIL_SAFETY_CONSTRUCTION_LABELS: Record<RailSafetyConstructionClass, string> = { window: "天窗点施工", A: "A类施工", B: "B类施工", C: "C类施工" };
/** A machine may be declared for B-class work together with a window; site zones remain single classes. */
export type RailSafetyDeclaredConstructionClass = RailSafetyConstructionClass | "B+window";
export const RAIL_SAFETY_DECLARED_CONSTRUCTION_LABELS: Record<RailSafetyDeclaredConstructionClass, string> = { ...RAIL_SAFETY_CONSTRUCTION_LABELS, "B+window": "B类施工＋天窗点施工" };
/** User-authored machine-relative ring, moved from its saved anchor with the current pose. */
export type RailSafetyAttachedRange = { polygon: RailSafetyPolygon; anchor: RailSafetyPosition & { heading: number } };
/** Fixed site polygons never move with a machine. */
export type RailSafetyConstructionZone = { id: string; name: string; classification: RailSafetyConstructionClass; polygon: RailSafetyPolygon };
/** Legacy limits retain their equipment meaning without rewriting saved records. */
export type RailSafetyLimit = { schemaVersion: 1; kind: "limit"; polygon: RailSafetyPolygon; limitType?: "equipment" | "line" };
export type RailSafetyMachine = {
  schemaVersion: 1; kind: "machine"; resourceId: string; selectedLimitIds: string[];
  inspectionStatus?: "unknown" | "reported" | "unreported"; support?: RailSafetySupport;
  /** Omission selects the automatic model range for the current pose. */
  workRange?: RailSafetyAttachedRange; fallRange?: RailSafetyAttachedRange;
  activityPolygon?: RailSafetyPolygon; constructionZones?: RailSafetyConstructionZone[];
};
export type RailSafetyDefinition = RailSafetyGuard | RailSafetyLimit | RailSafetyMachine;
/** Existing management name/taskId/revision/audit fields remain authoritative. */
export type RailSafetyRecord = ManagementRecord & { definition: RailSafetyDefinition; status: "active" | "deleted"; deletedAt?: string; deletedBy?: string };
export const RAIL_SAFETY_SCHEMA_VERSION = 1 as const;
export const RAIL_SAFETY_MAX_VERTICES = 128;
export const RAIL_SAFETY_MAX_REFERENCES = 128;
export const RAIL_SAFETY_DEFAULT_STALE_SECONDS = 30;
/** This is a local geometry screen, not an authority-confirmed safety approval. */
export const RAIL_SAFETY_MAX_EXTENT_METRES = 20_000;
