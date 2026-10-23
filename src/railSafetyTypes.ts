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
export type RailSafetyLimit = { schemaVersion: 1; kind: "limit"; polygon: RailSafetyPolygon };
export type RailSafetyMachine = { schemaVersion: 1; kind: "machine"; resourceId: string; selectedLimitIds: string[]; inspectionStatus?: "unknown" | "reported" | "unreported"; support?: RailSafetySupport };
export type RailSafetyDefinition = RailSafetyGuard | RailSafetyLimit | RailSafetyMachine;
/** Existing management name/taskId/revision/audit fields remain authoritative. */
export type RailSafetyRecord = ManagementRecord & { definition: RailSafetyDefinition; status: "active" | "deleted"; deletedAt?: string; deletedBy?: string };
export const RAIL_SAFETY_SCHEMA_VERSION = 1 as const;
export const RAIL_SAFETY_MAX_VERTICES = 128;
export const RAIL_SAFETY_MAX_REFERENCES = 128;
export const RAIL_SAFETY_DEFAULT_STALE_SECONDS = 30;
/** This is a local geometry screen, not an authority-confirmed safety approval. */
export const RAIL_SAFETY_MAX_EXTENT_METRES = 20_000;
