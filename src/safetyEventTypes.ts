import type { SafetyPosition, SafetySeverity } from "./safetyTypes.ts";

export type SafetyEventRecord = {
  id: string;
  projectId: string;
  title: string;
  severity: SafetySeverity;
  status: "pending" | "processing" | "completed";
  occurredAt: number;
  description?: string;
  position?: SafetyPosition;
  nodeId?: string;
  spatialObjectId?: string;
  mediaIds: string[];
  source: { kind: "manual-record" | "imported-event" | "management-issue"; sourceRecordId?: string };
  /** The three-state map badge is a projection; issueStatus is the authoritative lifecycle. */
  lifecycle?: "management-issue" | "legacy-readonly";
  issueStatus?: string;
  issueRevision?: number;
  legacyEventId?: string;
  taskId?: string;
  taskIds?: string[];
  evidenceIds?: string[];
  mediaSeconds?: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  handling?: { description: string; handledAt: string; handledBy?: string; attachmentIds: string[] };
};
export type SafetyEventSnapshot = { version: 1; revision: number; updatedAt: string; events: SafetyEventRecord[] };
export type SafetyEventResult = { description: string; attachmentIds?: string[]; handledBy?: string };
export type SafetyEventMutation = { mutationId: string; expectedRevision: number } &
  ({ operation: "create"; event: SafetyEventRecord } | { operation: "complete"; id: string; result: SafetyEventResult });
export const SAFETY_EVENTS_API_PATH = "/__safety/events";
export const EMPTY_EVENT_SNAPSHOT: SafetyEventSnapshot = { version: 1, revision: 0, updatedAt: "1970-01-01T00:00:00.000Z", events: [] };
