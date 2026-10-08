import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ManagementCommand, ManagementSnapshot } from "../../src/managementTypes.ts";
import { EMPTY_EVENT_SNAPSHOT, type SafetyEventSnapshot } from "../../src/safetyEventTypes.ts";
import { validateSafetyEvent, validateSafetyEventSnapshot } from "../../src/safetyEventValidation.ts";
import { projectManagementEvents } from "../../src/managementEventProjection.ts";
import { ManagementError, allow, ensure, id, ids, type Actor } from "./domain.ts";

/** Legacy JSON is immutable input. New lifecycle and receipts are committed only in management SQLite. */
export function readLegacyEvents(path: string): SafetyEventSnapshot {
  try { return validateSafetyEventSnapshot(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_EVENT_SNAPSHOT);
    throw new ManagementError(500, "LEGACY_EVENT_STORAGE_INVALID", "旧事件文件不可读或格式损坏，已保留原文件");
  }
}

export function createManagementEventBridge(options: {
  projectId: string;
  legacy: () => SafetyEventSnapshot;
  snapshot: (actor: Actor) => ManagementSnapshot;
  fresh?: (actor: Actor) => Actor;
  command: (command: ManagementCommand, actor: Actor) => Promise<ManagementSnapshot>;
}) {
  function snapshot(actor: Actor, current = options.snapshot(actor)): SafetyEventSnapshot {
    actor = options.fresh?.(actor) || actor;
    allow(actor, "read");
    // Historical JSON has no dependable task ownership, so scoped users see only authorized issue records.
    const legacy = actor.taskIds === undefined ? options.legacy().events.filter(event => event.projectId === options.projectId) : [];
    return { version: 1, revision: current.revision, updatedAt: current.updatedAt, events: projectManagementEvents(current.collections.issues, legacy) };
  }
  async function mutate(raw: unknown, actor: Actor): Promise<SafetyEventSnapshot> {
    ensure(raw && typeof raw === "object" && !Array.isArray(raw), "EVENT_COMMAND_INVALID", "事件请求格式无效");
    const input = raw as Record<string, unknown>, operation = String(input.operation);
    if (operation === "complete") throw new ManagementError(409, "MANAGEMENT_REVIEW_REQUIRED", "地图事件已统一为管理问题：请先指派整改、提交证据，再由有权人员复核；旧历史事件可只读或明确接入新流程");
    const key = id(input.mutationId, "请求编号"), payload = (input.payload || {}) as Record<string, unknown>;
    ensure(payload && typeof payload === "object" && !Array.isArray(payload), "EVENT_COMMAND_INVALID", "事件请求参数无效");
    let command: ManagementCommand;
    if (operation === "create") {
      const event = validateSafetyEvent(input.event);
      ensure(event.projectId === options.projectId && event.source.kind === "manual-record" && event.status === "pending" && !event.handling, "EVENT_INITIAL_STATE", "新事件必须从人工待核实问题开始");
      ensure(!event.position || event.spatialObjectId, "UNVERIFIED_POSITION", "模型位置须选择已保存的用户空间对象");
      ensure(event.mediaIds.length === 0 || payload.mediaEvidenceId, "VIDEO_EVIDENCE_REQUIRED", "录像来源须先登记为已保存证据");
      const discovery = { kind: payload.mediaEvidenceId ? "video" : event.spatialObjectId ? "model" : "manual", severity: event.severity, occurredAt: event.occurredAt,
        ...(event.description ? { description: event.description } : {}), ...(event.spatialObjectId ? { spatialObjectId: event.spatialObjectId } : {}),
        ...(payload.mediaEvidenceId ? { mediaEvidenceId: payload.mediaEvidenceId, mediaSeconds: event.mediaSeconds } : {}) };
      command = { projectId: options.projectId, type: "issue.create", id: event.id, idempotencyKey: `map:${key}`, payload: {
        name: event.title, kind: payload.kind || "safety", ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.taskIds ? { taskIds: event.taskIds } : {}),
        evidenceIds: ids(event.evidenceIds), discovery } };
    } else if (operation === "adopt-legacy") {
      allow(actor, "review");
      if (actor.taskIds !== undefined) throw new ManagementError(403, "LEGACY_EVENT_SCOPE_REQUIRED", "旧事件未核验任务归属，须由全项目复核人员明确接入后再授权查看");
      const eventId = id(input.id), legacy = options.legacy().events.find(event => event.id === eventId);
      ensure(legacy, "LEGACY_EVENT_NOT_FOUND", "旧事件不存在");
      command = { projectId: options.projectId, type: "issue.create", id: eventId, idempotencyKey: `map:${key}`, payload: {
        name: legacy.title, kind: payload.kind || "safety", ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(payload.taskIds ? { taskIds: payload.taskIds } : {}),
        evidenceIds: ids(payload.evidenceIds), discovery: { kind: "legacy-event", legacyEventId: eventId } } };
    } else {
      ensure(["assign", "start", "submit", "review", "dismiss", "reschedule"].includes(operation), "EVENT_OPERATION_INVALID", "事件操作不受支持");
      ensure(Number.isSafeInteger(input.expectedIssueRevision) && Number(input.expectedIssueRevision) > 0, "ISSUE_REVISION_REQUIRED", "请提供当前管理问题的修订号");
      command = { projectId: options.projectId, type: `issue.${operation}` as ManagementCommand["type"], id: id(input.id), expectedRevision: Number(input.expectedIssueRevision), idempotencyKey: `map:${key}`, payload };
    }
    return snapshot(actor, await options.command(command, actor));
  }
  async function middleware(req: IncomingMessage, res: ServerResponse, actor: Actor): Promise<void> {
    const output = (value: unknown) => { res.statusCode = 200; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(value)); };
    if (req.method === "GET") { output(snapshot(actor)); return; }
    if (req.method !== "POST") throw new ManagementError(405, "METHOD_NOT_ALLOWED", "事件接口仅支持读取和管理问题命令");
    ensure(req.headers["x-cesium-library"] === "1", "MISSING_REQUEST_MARKER", "缺少同源业务请求标识");
    ensure(req.headers["content-type"]?.startsWith("application/json"), "CONTENT_TYPE", "事件请求必须为JSON");
    const chunks: Buffer[] = []; let length = 0;
    for await (const raw of req) { const chunk = Buffer.from(raw); length += chunk.length; if (length > 1_048_576) throw new ManagementError(413, "BODY_TOO_LARGE", "事件请求过大"); chunks.push(chunk); }
    let input: unknown; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ManagementError(400, "INVALID_JSON", "事件请求格式无效"); }
    output(await mutate(input, actor));
  }
  return { snapshot, mutate, middleware };
}
