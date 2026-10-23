import type { MachineryMetadata } from "./machineryTypes.ts";
import type { RailSafetyLimit, RailSafetyMachine } from "./railSafetyTypes.ts";

export const RAIL_SAFETY_RISK_METHOD = "support-line-rigid-0-90-sweep-convex-envelope/v2" as const;
export const RAIL_SAFETY_RISK_CLOSED_STATUSES = ["closed", "false-positive", "duplicate"] as const;

/** A user captures a browser geometry screen. The server validates source revisions,
 * but does not recompute the geometry or certify that an accident will occur. */
export type RailSafetyRiskScreening = {
  schemaVersion: 1;
  source: "browser-geometric-screening";
  method: typeof RAIL_SAFETY_RISK_METHOD;
  capturedAt: string;
  status: "overlap" | "touching";
  distanceMeters: number;
  maxDistanceMeters: number;
  warnings: string[];
};
export type RailSafetyRiskReferences = {
  resourceId: string; resourceRevision: number;
  machineConfigId: string; machineConfigRevision: number;
  limitId: string; limitRevision: number;
  taskId?: string; taskRevision?: number;
};
export type RailSafetyRiskReportPayload = RailSafetyRiskReferences & {
  name: string;
  description?: string;
  screening: RailSafetyRiskScreening;
};
export type RailSafetyRiskSnapshot = RailSafetyRiskReferences & RailSafetyRiskScreening & {
  registeredAt: string;
  serverRecomputed: false;
  physicalPrediction: false;
  description?: string;
  resourceSnapshot: { name: string; machinery: MachineryMetadata };
  machineConfigSnapshot: { name: string; definition: RailSafetyMachine };
  limitSnapshot: { name: string; definition: RailSafetyLimit };
  taskSnapshot?: { name: string; status: string };
};
