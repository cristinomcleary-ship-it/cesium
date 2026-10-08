import type { ManagementCollection, ManagementRecord } from "../../src/managementTypes.ts";
import type { SafetyEventRecord } from "../../src/safetyEventTypes.ts";
import { allow, ensure, id, ids, num, ManagementError, type Actor } from "./domain.ts";

export type IssueDiscoveryContext = {
  actor: Actor; projectId: string; recordId?: string;
  get: (kind: ManagementCollection, id: string) => ManagementRecord;
  evidence: (id: string) => void;
  spatial: (id: string) => Record<string, unknown>;
  legacy: (id: string) => SafetyEventRecord | undefined;
};

/** Run inside the command transaction. All referenced records are obtained through the same authorization gate. */
export function validateIssueDiscovery(payload: Record<string, unknown>, c: IssueDiscoveryContext): Record<string, unknown> | undefined {
  if (payload.discovery === undefined && payload.checkId === undefined) return;
  const raw = payload.discovery ?? { kind: "check", checkId: payload.checkId };
  ensure(raw && typeof raw === "object" && !Array.isArray(raw), "DISCOVERY_INVALID", "问题发现来源无效");
  const input = raw as Record<string, unknown>;
  ensure(["manual", "model", "video", "check", "legacy-event"].includes(String(input.kind)), "DISCOVERY_KIND", "请明确模型、录像、检查或人工发现来源");
  const taskIds = new Set([...(payload.taskId ? [id(payload.taskId)] : []), ...ids(payload.taskIds)]);
  const sameTask = (record: ManagementRecord) => {
    const linked = [...(record.taskId ? [record.taskId] : []), ...(record.taskIds || [])];
    ensure(!linked.length || linked.every(task => taskIds.has(task)), "DISCOVERY_TASK_MISMATCH", "发现证据或检查记录与问题任务关联不一致");
  };
  const out: Record<string, unknown> = { kind: input.kind };
  if (input.severity !== undefined) { ensure(["low", "medium", "high"].includes(String(input.severity)), "DISCOVERY_SEVERITY", "事件等级无效"); out.severity = input.severity; }
  if (input.occurredAt !== undefined) { out.occurredAt = num(input.occurredAt, "发生时间"); ensure(Number(out.occurredAt) <= 7_258_118_400_000, "DISCOVERY_TIME", "事件时间超出支持范围"); }
  if (input.description !== undefined) { ensure(typeof input.description === "string" && input.description.length <= 4000, "DISCOVERY_DESCRIPTION", "发现说明过长"); out.description = input.description; }
  if (input.kind === "legacy-event") {
    allow(c.actor, "review");
    if (c.actor.taskIds !== undefined) throw new ManagementError(403, "LEGACY_EVENT_SCOPE_REQUIRED", "旧事件须由全项目复核人员明确接入，不能推断其任务授权");
    const legacyId = id(input.legacyEventId), original = c.legacy(legacyId);
    ensure(original && original.projectId === c.projectId, "LEGACY_EVENT_NOT_FOUND", "旧事件不存在或不属于此项目");
    ensure(c.recordId === legacyId, "LEGACY_ID_MISMATCH", "接入旧事件必须保留原编号");
    // This is historical provenance, not a fabricated management review or a newly accepted attachment.
    return { kind: "legacy-event", legacyEventId: legacyId, legacySnapshot: structuredClone(original),
      occurredAt: original.occurredAt, severity: original.severity, description: original.description,
      ...(original.position ? { position: structuredClone(original.position) } : {}),
      ...(original.spatialObjectId ? { spatialObjectId: original.spatialObjectId } : {}), historicalState: original.status };
  }
  if (input.kind === "model" || input.spatialObjectId !== undefined) {
    // A spatial snapshot exposes project model geometry; a known ID cannot grant this resource permission.
    allow(c.actor, "models");
    const key = id(input.spatialObjectId || payload.riskPointId, "模型位置");
    const spatial = c.spatial(key);
    ensure(spatial && spatial.projectId === c.projectId && !spatial.deletedAt, "DISCOVERY_SPATIAL_INVALID", "问题位置须引用已核验的用户模型空间对象");
    const source = spatial.source as Record<string, unknown> | undefined;
    const vertices = source?.vertices as Record<string, unknown>[] | undefined;
    ensure(source?.kind === "user-drawn" && vertices?.length && vertices.every(v => v.pickKind === "model-depth" && (v.anchor as Record<string, unknown> | undefined)?.provenance === "verified-project-photogrammetry-surface"), "DISCOVERY_SURFACE_UNVERIFIED", "发现位置未通过真实模型表面来源核验");
    const geometry = spatial.geometry as { type?: string; position?: unknown };
    Object.assign(out, { spatialObjectId: key, spatialRevision: spatial.revision ?? null, spatialReference: structuredClone(spatial.reference), spatialSnapshot: structuredClone(spatial) });
    if (geometry.type === "Point") out.position = structuredClone(geometry.position);
  }
  if (input.kind === "video" || input.mediaEvidenceId !== undefined) {
    const key = id(input.mediaEvidenceId, "录像证据");
    c.evidence(key); const evidence = c.get("evidence", key); sameTask(evidence);
    const sourceId = evidence.sourceRecordId || evidence.recordId;
    ensure(typeof sourceId === "string" && typeof evidence.mediaSeconds === "number", "VIDEO_EVIDENCE_REQUIRED", "须选择带已保存录像来源和媒体时间的取证记录");
    if (input.mediaSeconds !== undefined) ensure(input.mediaSeconds === evidence.mediaSeconds, "MEDIA_TIME_MISMATCH", "问题媒体时间必须与保存的证据一致");
    Object.assign(out, { mediaEvidenceId: key, evidenceRevision: evidence.revision, sourceRecordId: sourceId,
      mediaId: `video:${sourceId}`, mediaSeconds: evidence.mediaSeconds, evidenceSha256: evidence.sha256 ?? null });
  }
  if (input.kind === "check" || input.checkId !== undefined) {
    const key = id(input.checkId || payload.checkId, "检查记录"), check = c.get("checks", key); sameTask(check);
    ensure(payload.checkId === undefined || payload.checkId === key, "CHECK_DISCOVERY_MISMATCH", "问题与发现来源须关联同一检查记录");
    Object.assign(out, { checkId: key, checkRevision: check.revision, templateVersion: check.templateVersion ?? null, checkSnapshot: structuredClone(check) });
  }
  ensure(input.position === undefined, "UNVERIFIED_POSITION", "不接受客户端坐标作为已核验问题位置，请选择正式空间对象");
  return out;
}

export function discoverySpatialId(payload: Record<string, unknown>): string | undefined {
  const discovery = payload.discovery as Record<string, unknown> | undefined;
  return discovery && (discovery.kind === "model" || discovery.spatialObjectId !== undefined) ? id(discovery.spatialObjectId || payload.riskPointId) : undefined;
}
