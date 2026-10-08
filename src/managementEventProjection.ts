import type { ManagementRecord } from "./managementTypes.ts";
import type { SafetyEventRecord } from "./safetyEventTypes.ts";
import type { SafetyPosition } from "./safetyTypes.ts";

/** A read model only: issue status and revision always remain owned by the management record. */
export function projectManagementIssue(issue: ManagementRecord): SafetyEventRecord {
  const discovery = issue.discovery as Record<string, unknown> | undefined;
  const spatial = issue.positionSnapshot as { geometry?: { type?: string; position?: SafetyPosition } } | undefined;
  const rounds = Array.isArray(issue.rounds) ? issue.rounds as Record<string, unknown>[] : [];
  const last = rounds.at(-1);
  const resolved = ["closed", "false-positive", "duplicate"].includes(issue.status);
  const event: SafetyEventRecord = {
    id: issue.id, projectId: issue.projectId, title: issue.name,
    severity: ["low", "medium", "high"].includes(String(discovery?.severity)) ? discovery!.severity as SafetyEventRecord["severity"] : "medium",
    status: resolved ? "completed" : issue.status === "pending-verification" ? "pending" : "processing",
    occurredAt: typeof discovery?.occurredAt === "number" ? discovery.occurredAt : Date.parse(issue.createdAt),
    source: { kind: "management-issue", sourceRecordId: issue.id },
    lifecycle: "management-issue", issueStatus: issue.status, issueRevision: issue.revision,
    mediaIds: typeof discovery?.mediaId === "string" ? [discovery.mediaId] : [],
    evidenceIds: [...(issue.evidenceIds || [])],
    createdAt: issue.createdAt, updatedAt: issue.updatedAt, createdBy: issue.createdBy,
    ...(issue.taskId ? { taskId: issue.taskId } : {}), ...(issue.taskIds ? { taskIds: [...issue.taskIds] } : {}),
  };
  const position = discovery?.position || (spatial?.geometry?.type === "Point" ? spatial.geometry.position : undefined);
  if (position) event.position = structuredClone(position) as SafetyPosition;
  const spatialId = discovery?.spatialObjectId || issue.riskPointId;
  if (typeof spatialId === "string") event.spatialObjectId = spatialId;
  if (typeof discovery?.description === "string") event.description = discovery.description;
  if (typeof discovery?.mediaSeconds === "number") event.mediaSeconds = discovery.mediaSeconds;
  if (typeof discovery?.legacyEventId === "string") event.legacyEventId = discovery.legacyEventId;
  if (resolved) {
    event.handling = issue.status === "closed" && last ? {
      description: String(last.description || ""), handledAt: String(last.reviewedAt || issue.updatedAt),
      ...(typeof last.reviewedBy === "string" ? { handledBy: last.reviewedBy } : {}),
      attachmentIds: Array.isArray(last.evidenceIds) ? [...last.evidenceIds] as string[] : [],
    } : { description: String(issue.dispositionReason || "问题已归档"), handledAt: issue.updatedAt, attachmentIds: [] };
  }
  return event;
}

export function projectManagementEvents(issues: ManagementRecord[], legacy: SafetyEventRecord[] = []): SafetyEventRecord[] {
  const projected = issues.map(projectManagementIssue);
  const adopted = new Set(issues.flatMap(issue => [issue.id, (issue.discovery as Record<string, unknown> | undefined)?.legacyEventId].filter((v): v is string => typeof v === "string")));
  return [...legacy.filter(event => !adopted.has(event.id)).map(event => ({ ...structuredClone(event), lifecycle: "legacy-readonly" as const })), ...projected];
}
