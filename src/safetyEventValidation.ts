import type { SafetyEventMutation, SafetyEventRecord, SafetyEventSnapshot } from "./safetyEventTypes.ts";
import { SpatialValidationError, validateSpatialId } from "./safetySpatialValidation.ts";

function fail(message: string): never { throw new SpatialValidationError(message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("事件信息无效");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 240, empty = false): string {
  if (typeof value !== "string" || !empty && !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail("事件说明或名称无效");
  return value.trim();
}
function date(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(result) || !Number.isFinite(Date.parse(result))) fail("事件时间必须包含有效时区");
  return new Date(result).toISOString();
}
function finite(value: unknown, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) fail("事件数值超出范围");
  return value;
}
function revision(value: unknown): number {
  const result = finite(value, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(result)) fail("事件版本号无效");
  return result;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) fail("事件关联资料无效");
  const result = value.map(item => text(item));
  if (new Set(result).size !== result.length) fail("事件关联资料重复");
  return result;
}
export function validateSafetyEvent(value: unknown): SafetyEventRecord {
  const item = record(value), source = record(item.source);
  if (!["manual-record", "imported-event"].includes(String(source.kind))) fail("事件必须保留明确的人工记录或导入来源");
  if (!["low", "medium", "high"].includes(String(item.severity)) || !["pending", "processing", "completed"].includes(String(item.status))) fail("事件等级或处理状态无效");
  const result: SafetyEventRecord = { id: validateSpatialId(item.id), projectId: text(item.projectId), title: text(item.title, 160),
    severity: item.severity as SafetyEventRecord["severity"], status: item.status as SafetyEventRecord["status"], occurredAt: finite(item.occurredAt, 0, 7_258_118_400_000),
    mediaIds: ids(item.mediaIds), source: { kind: source.kind as SafetyEventRecord["source"]["kind"], ...(source.sourceRecordId === undefined ? {} : { sourceRecordId: text(source.sourceRecordId) }) },
    createdAt: date(item.createdAt), updatedAt: date(item.updatedAt) };
  if (result.source.kind === "imported-event" && !result.source.sourceRecordId) fail("导入事件需要真实来源编号");
  for (const key of ["description", "nodeId", "createdBy"] as const) if (item[key] !== undefined) result[key] = text(item[key], key === "description" ? 4000 : 240, true);
  if (item.spatialObjectId !== undefined) result.spatialObjectId = validateSpatialId(item.spatialObjectId);
  if (item.position !== undefined) {
    const point = record(item.position);
    result.position = { longitude: finite(point.longitude, -180, 180), latitude: finite(point.latitude, -90, 90), height: finite(point.height, -100_000, 1_000_000) };
  }
  if (item.handling !== undefined) {
    const handling = record(item.handling);
    result.handling = { description: text(handling.description, 4000), handledAt: date(handling.handledAt), attachmentIds: ids(handling.attachmentIds),
      ...(handling.handledBy === undefined ? {} : { handledBy: text(handling.handledBy) }) };
  }
  if (result.status === "completed" && !result.handling) fail("已完成事件必须保留处理结果");
  return result;
}
export function validateSafetyEventSnapshot(value: unknown): SafetyEventSnapshot {
  const item = record(value);
  if (item.version !== 1 || !Array.isArray(item.events) || item.events.length > 2000 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 8_388_608) fail("事件快照版本或容量无效");
  const events = item.events.map(validateSafetyEvent);
  if (new Set(events.map(event => event.id)).size !== events.length) fail("事件编号重复");
  return { version: 1, revision: revision(item.revision), updatedAt: date(item.updatedAt), events };
}
export function validateSafetyEventMutation(value: unknown): SafetyEventMutation {
  const item = record(value), expectedRevision = revision(item.expectedRevision), mutationId = validateSpatialId(item.mutationId);
  if (item.operation === "create") return { operation: "create", expectedRevision, mutationId, event: validateSafetyEvent(item.event) };
  if (item.operation === "complete") {
    const result = record(item.result);
    return { operation: "complete", expectedRevision, mutationId, id: validateSpatialId(item.id), result: { description: text(result.description, 4000),
      attachmentIds: result.attachmentIds === undefined ? [] : ids(result.attachmentIds), ...(result.handledBy === undefined ? {} : { handledBy: text(result.handledBy) }) } };
  }
  return fail("事件操作无效");
}
