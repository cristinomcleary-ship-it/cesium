import type { ManagementCollection, ManagementRecord } from "../../src/managementTypes.ts";
import type { FieldObjectReference, GuardPersonnel, RailwayPlanSource, RailwayWorkflowCategory } from "../../src/railwayWorkflowTypes.ts";
import { allow, date, ensure, id, ids, ManagementError, str, type Actor, type DomainContext } from "./domain.ts";

export type FieldReferenceContext = { actor: Actor; projectId: string; now: string; get: (kind: ManagementCollection, id: string) => ManagementRecord };

/** References always resolve through the caller's authorized project store, never supplied snapshots. */
export function fieldObjectReferences(c: FieldReferenceContext, value: unknown) {
  ensure(value === undefined || Array.isArray(value), "INVALID_OBJECT_REFS", "对象关联须为列表");
  const input = (value ?? []) as unknown[];
  ensure(input.length <= 100, "TOO_MANY_OBJECT_REFS", "一次最多关联100个现场对象");
  if (input.length) allow(c.actor, "models");
  const refs: FieldObjectReference[] = [], snapshots: { ref: FieldObjectReference; revision: number; capturedAt: string; data: ManagementRecord }[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    ensure(raw && typeof raw === "object" && !Array.isArray(raw), "INVALID_OBJECT_REF", "现场对象关联无效");
    const item = raw as Record<string, unknown>;
    ensure(Object.keys(item).every(key => ["kind", "id"].includes(key)) && ["resources", "railSafety", "anchors"].includes(String(item.kind)), "INVALID_OBJECT_REF", "现场对象类型无效");
    const ref: FieldObjectReference = { kind: item.kind as FieldObjectReference["kind"], id: id(item.id) };
    const record = c.get(ref.kind, ref.id);
    ensure(record.projectId === c.projectId && !record.deletedAt && !["deleted", "removed", "archived", "inactive"].includes(record.status), "OBJECT_UNAVAILABLE", "现场对象不存在、已停用或不属于当前项目");
    if (ref.kind === "railSafety") ensure(record.status === "active", "OBJECT_UNAVAILABLE", "管控对象已停用");
    if (ref.kind === "resources") ensure(record.kind === "equipment", "OBJECT_KIND_INVALID", "机械关联只能选择设备资源");
    const key = `${ref.kind}:${ref.id}`;
    if (!seen.has(key)) { seen.add(key); refs.push(ref); snapshots.push({ ref, revision: record.revision, capturedAt: c.now, data: structuredClone(record) }); }
  }
  return { objectRefs: refs, objectSnapshots: snapshots };
}

export function fieldObjectReference(c: FieldReferenceContext, value: unknown, taskId: unknown) {
  if (value === undefined) return {};
  ensure(typeof taskId === "string" && taskId.length, "OBJECT_TASK_REQUIRED", "现场检查和问题须明确关联今日作业");
  c.get("tasks", id(taskId));
  const result = fieldObjectReferences(c, [value]), snapshot = result.objectSnapshots[0];
  ensure(!snapshot.data.taskId || snapshot.data.taskId === taskId, "OBJECT_TASK_MISMATCH", "现场对象与所选作业不一致");
  return { objectRef: result.objectRefs[0], objectSnapshot: snapshot };
}

export function workflowCategory(value: unknown): RailwayWorkflowCategory | undefined {
  if (value === undefined) return;
  ensure(["agreement", "construction-plan", "supervision-plan", "other", "personnel-certificate"].includes(String(value)), "WORKFLOW_CATEGORY_INVALID", "铁路资料分类无效");
  return value as RailwayWorkflowCategory;
}

/** Only opt-in railway workflow uploads use these type restrictions; legacy attachments remain supported. */
export function validateWorkflowFile(category: RailwayWorkflowCategory | undefined, file: { name: unknown; mime?: unknown }) {
  if (!category) return;
  const suffix = String(file.name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const allowed = category === "agreement" ? ["pdf"] : category === "construction-plan" || category === "supervision-plan" ? ["xls", "xlsx"] : category === "personnel-certificate" ? ["pdf", "png", "jpg", "jpeg", "webp"] : ["pdf", "doc", "docx"];
  ensure(!!suffix && allowed.includes(suffix), "WORKFLOW_FILE_TYPE", category === "agreement" ? "安全协议请上传PDF" : category.endsWith("-plan") ? "施工或安全监督计划请上传Excel（xls/xlsx）" : category === "personnel-certificate" ? "培训证书请上传PDF或图片" : "其他资料请上传PDF或Word");
  const mime = String(file.mime || "application/octet-stream").toLowerCase();
  const compatible: Record<string, string[]> = { pdf: ["application/pdf"], xls: ["application/vnd.ms-excel", "application/x-ole-storage"], xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip"], doc: ["application/msword", "application/x-ole-storage"], docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip"], png: ["image/png"], jpg: ["image/jpeg"], jpeg: ["image/jpeg"], webp: ["image/webp"] };
  ensure(mime === "application/octet-stream" || compatible[suffix!].includes(mime), "WORKFLOW_FILE_TYPE", "文件类型与文件扩展名不一致，请核对原件");
}

export function importedRailwayPlan(c: DomainContext, value: unknown, task: ManagementRecord) {
  if (value === undefined) return;
  ensure(value && typeof value === "object" && !Array.isArray(value), "RAILWAY_PLAN_INVALID", "计划来源格式无效");
  const input = value as Record<string, unknown>;
  ensure(Object.keys(input).every(key => ["kind", "number", "sourceEvidenceId", "sheetName", "rowNumber", "verificationStatus", "resourceText", "unmatchedResources"].includes(key)), "RAILWAY_PLAN_INVALID", "计划来源不能包含未经核验的状态或快照");
  ensure(["construction", "supervision"].includes(String(input.kind)) && input.verificationStatus === "pending", "RAILWAY_PLAN_INVALID", "导入计划只能登记为待核验");
  ensure(Number.isSafeInteger(input.rowNumber) && Number(input.rowNumber) >= 1 && Number(input.rowNumber) <= 1_048_576, "RAILWAY_PLAN_ROW", "Excel行号无效");
  const source: RailwayPlanSource = { kind: input.kind as RailwayPlanSource["kind"], number: str(input.number, "正式计划号", 200), sourceEvidenceId: id(input.sourceEvidenceId), sheetName: str(input.sheetName, "工作表", 200), rowNumber: Number(input.rowNumber), verificationStatus: "pending" };
  if (input.resourceText !== undefined && input.resourceText !== "") source.resourceText = str(input.resourceText, "原表机械文本", 4000);
  if (input.unmatchedResources !== undefined) {
    ensure(Array.isArray(input.unmatchedResources) && input.unmatchedResources.length <= 100, "RAILWAY_PLAN_RESOURCE_TEXT", "待匹配机械须为文本列表");
    source.unmatchedResources = [...new Set(input.unmatchedResources.map(value => str(value, "待匹配机械", 200)))];
  }
  c.evidence(source.sourceEvidenceId);
  const file = c.get("evidence", source.sourceEvidenceId);
  ensure(file.storageName && file.status === "ready", "RAILWAY_PLAN_SOURCE", "计划须引用已受控上传的Excel原件");
  validateWorkflowFile(source.kind === "construction" ? "construction-plan" : "supervision-plan", file);
  const businessDate = date(task.planStart, "计划日期"); date(task.planEnd, "计划结束日期");
  if (c.list("tasks").some(other => { const existing = other.railwayPlan as Record<string, unknown> | undefined; return other.id !== task.id && existing?.kind === source.kind && existing.number === source.number && existing.businessDate === businessDate; })) throw new ManagementError(409, "RAILWAY_PLAN_DUPLICATE", "同类计划的相同计划号及日期已导入，请查看现有作业和原表");
  return { ...source, businessDate, importedAt: c.now, importedBy: c.actor.id, sourceSnapshot: { id: file.id, revision: file.revision, name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, uploadedAt: file.createdAt } };
}

export function guardPersonnel(c: DomainContext, value: unknown) {
  ensure(value && typeof value === "object" && !Array.isArray(value), "PERSONNEL_INVALID", "人员信息格式无效");
  const input = value as Record<string, unknown>;
  const textFields = ["unit", "phone", "role", "certificateNumber", "trainingOrganization"] as const;
  ensure(Object.keys(input).every(key => ["name", ...textFields, "trainingDate", "validUntil", "certificateEvidenceIds"].includes(key)), "PERSONNEL_INVALID", "人员档案只允许基本信息和培训证书，不能写入到岗或核验结论");
  const personnel: GuardPersonnel = { name: str(input.name, "人员姓名", 100), certificateEvidenceIds: ids(input.certificateEvidenceIds) };
  ensure(personnel.certificateEvidenceIds.length <= 20, "PERSONNEL_CERTIFICATES_LIMIT", "每人最多关联20份证书附件");
  for (const key of textFields) if (input[key] !== undefined && input[key] !== "") personnel[key] = str(input[key], key, key === "phone" ? 50 : 200);
  if (input.trainingDate) personnel.trainingDate = date(input.trainingDate, "培训合格日期");
  if (input.validUntil) personnel.validUntil = date(input.validUntil, "证书有效期");
  ensure(!personnel.trainingDate || !personnel.validUntil || personnel.trainingDate <= personnel.validUntil, "PERSONNEL_CERTIFICATE_DATE", "证书到期日期不能早于培训合格日期");
  const certificateSnapshots = personnel.certificateEvidenceIds.map(key => { c.evidence(key); const file = c.get("evidence", key); validateWorkflowFile("personnel-certificate", file); return { id: file.id, revision: file.revision, name: file.name, mime: file.mime, sha256: file.sha256, size: file.size }; });
  return { ...personnel, verificationStatus: "pending", certificateSnapshots, updatedAt: c.now, updatedBy: c.actor.id };
}
