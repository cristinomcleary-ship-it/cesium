import type { ManagementRecord } from "./managementTypes.ts";

/** User-entered WGS84 longitude/latitude (degrees), ellipsoid height (metres). */
export type RailSafetyPosition = { longitude: number; latitude: number; height: number };
/** Open ring: do not repeat the first point. 3–128 vertices, local worksite extent. */
export type RailSafetyPolygon = RailSafetyPosition[];
/** Ground support rectangle in machine-local metres: source model X/Z horizontal axes. */
export type RailSafetySupport = { length: number; width: number; centerX: number; centerZ: number };
export type RailSafetyGuard = { schemaVersion: 1; kind: "guard"; station: RailSafetyPosition; polygon: RailSafetyPolygon; resourceIds: string[] };
export type RailSafetyLimit = { schemaVersion: 1; kind: "limit"; polygon: RailSafetyPolygon };
export type RailSafetyMachine = { schemaVersion: 1; kind: "machine"; resourceId: string; selectedLimitIds: string[]; inspectionStatus?: "unknown" | "reported" | "unreported"; support?: RailSafetySupport };
export type RailSafetyDefinition = RailSafetyGuard | RailSafetyLimit | RailSafetyMachine;
/** Existing management name/taskId/revision/audit fields remain authoritative. */
export type RailSafetyRecord = ManagementRecord & { definition: RailSafetyDefinition; status: "active" | "deleted"; deletedAt?: string; deletedBy?: string };
export const RAIL_SAFETY_SCHEMA_VERSION = 1 as const;
export const RAIL_SAFETY_MAX_VERTICES = 128;
export const RAIL_SAFETY_MAX_REFERENCES = 128;
/** This is a local geometry screen, not an authority-confirmed safety approval. */
export const RAIL_SAFETY_MAX_EXTENT_METRES = 20_000;
