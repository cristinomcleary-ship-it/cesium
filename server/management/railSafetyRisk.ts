import type { ManagementCollection, ManagementRecord } from "../../src/managementTypes.ts";
import type { RailSafetyLimit, RailSafetyMachine } from "../../src/railSafetyTypes.ts";
import { RAIL_SAFETY_RISK_CLOSED_STATUSES, RAIL_SAFETY_RISK_METHOD, type RailSafetyRiskSnapshot } from "../../src/railSafetyRiskTypes.ts";
import { allow, ensure, id, instant, ManagementError, num, str, type DomainContext } from "./domain.ts";

const fail = (test: unknown, message: string) => ensure(test, "INVALID_RAIL_SAFETY_RISK", message);
const strictObject = (value: unknown, keys: string[], label: string): Record<string, unknown> => {
  fail(value && typeof value === "object" && !Array.isArray(value), `${label}格式无效`);
  const object = value as Record<string, unknown>;
  fail(Object.keys(object).every(key => keys.includes(key)), `${label}包含不支持的字段`);
  return object;
};
const finiteDistance = (value: unknown, label: string) => {
  const result = num(value, label); fail(result <= 1_000_000, `${label}超出支持范围`); return result;
};

/** Explicit issue creation only. Runs inside the existing SQLite command transaction. */
export function railSafetyRiskIssueFields(c: DomainContext): Record<string, unknown> {
  allow(c.actor, "field"); allow(c.actor, "models");
  const p = strictObject(c.command.payload, ["resourceId", "resourceRevision", "machineConfigId", "machineConfigRevision", "limitId", "limitRevision", "taskId", "taskRevision", "name", "description", "screening"], "风险登记");
  const source = (kind: ManagementCollection, key: unknown, revision: unknown) => {
    const record = c.get(kind, id(key));
    fail(Number.isSafeInteger(revision) && Number(revision) > 0, "来源修订号须为正整数");
    if (record.revision !== revision) throw new ManagementError(409, "RAIL_SAFETY_SOURCE_CHANGED", "计算来源已经变化，请刷新并重新筛查后登记", { collection: kind, id: record.id, expectedRevision: revision, actualRevision: record.revision });
    fail(record.projectId === c.projectId, "来源不属于当前项目");
    return record;
  };
  const resource = source("resources", p.resourceId, p.resourceRevision);
  const config = source("railSafety", p.machineConfigId, p.machineConfigRevision);
  const limit = source("railSafety", p.limitId, p.limitRevision);
  fail(resource.status === "active" && resource.kind === "equipment" && resource.machinery, "机械资源必须具有已保存的有效三维模型");
  const machineDefinition = config.definition as RailSafetyMachine | undefined;
  const limitDefinition = limit.definition as RailSafetyLimit | undefined;
  fail(config.status === "active" && machineDefinition?.kind === "machine" && machineDefinition.resourceId === resource.id, "须引用此机械已保存的有效管控配置");
  fail(limit.status === "active" && limitDefinition?.kind === "limit" && machineDefinition!.selectedLimitIds.includes(limit.id), "限界未纳入该机械当前筛查配置或已停用");
  fail(config.taskId === p.taskId && (!limit.taskId || limit.taskId === config.taskId), "登记任务必须与机械配置及所选限界一致");
  fail(!resource.taskId || resource.taskId === config.taskId, "机械资源任务与管控配置不一致");
  fail(!resource.taskIds?.length || resource.taskIds.every(taskId => taskId === config.taskId), "机械资源关联了其他任务");
  if (c.actor.taskIds !== undefined && !config.taskId) throw new ManagementError(403, "TASK_SCOPE_REQUIRED", "受限账号不能登记未关联任务的几何风险");
  let task: ManagementRecord | undefined;
  if (config.taskId) {
    task = source("tasks", config.taskId, p.taskRevision);
    if (c.actor.taskIds !== undefined && !c.actor.taskIds.includes(task.id)) throw new ManagementError(403, "TASK_FORBIDDEN", "关联任务不在授权范围");
    fail(!["cancelled", "deleted"].includes(task.status), "任务已取消或移除，不能登记新的处置单");
  } else fail(p.taskRevision === undefined, "无关联任务时不能提供任务修订号");
  const screening = strictObject(p.screening, ["schemaVersion", "source", "method", "capturedAt", "status", "distanceMeters", "maxDistanceMeters", "warnings"], "几何筛查快照");
  fail(screening.schemaVersion === 1 && screening.source === "browser-geometric-screening" && screening.method === RAIL_SAFETY_RISK_METHOD, "仅接受当前全方向几何筛查结果");
  fail(screening.status === "overlap" || screening.status === "touching", "仅潜在侵限或边界接触结果可登记处置");
  const capturedAt = instant(screening.capturedAt, "结果捕获时间");
  fail(Date.parse(capturedAt) <= Date.parse(c.now) + 60_000 && Date.parse(capturedAt) >= Date.parse(c.now) - 30 * 60_000, "捕获时间已过期或超前，请重新登记当前结果");
  const distanceMeters = finiteDistance(screening.distanceMeters, "筛查间距"), maxDistanceMeters = finiteDistance(screening.maxDistanceMeters, "最远投影距离");
  fail(distanceMeters <= 1e-6, "潜在相交或边界接触结果的间距必须接近零");
  fail(Array.isArray(screening.warnings) && screening.warnings.length <= 50, "筛查说明须为有限列表");
  const warnings = (screening.warnings as unknown[]).map(value => str(value, "筛查说明", 2000));
  const description = p.description === undefined ? undefined : str(p.description, "登记说明", 4000);
  const name = str(p.name, "问题描述", 1000);
  const existing = c.list("issues").find(issue => {
    const risk = issue.railSafetyRisk as RailSafetyRiskSnapshot | undefined;
    return risk?.source === "browser-geometric-screening" && risk.resourceId === resource.id && risk.limitId === limit.id && risk.taskId === config.taskId && !RAIL_SAFETY_RISK_CLOSED_STATUSES.some(status => status === issue.status);
  });
  if (existing) {
    c.get("issues", existing.id); // Check live scope before disclosing a duplicate identifier.
    throw new ManagementError(409, "RAIL_SAFETY_RISK_EXISTS", "此机械与限界已有未关闭处置单，请继续办理原单", { issueId: existing.id });
  }
  const railSafetyRisk: RailSafetyRiskSnapshot = {
    schemaVersion: 1, source: "browser-geometric-screening", method: RAIL_SAFETY_RISK_METHOD,
    capturedAt, registeredAt: c.now, serverRecomputed: false, physicalPrediction: false,
    status: screening.status as "overlap" | "touching", distanceMeters, maxDistanceMeters, warnings,
    ...(description ? { description } : {}),
    resourceId: resource.id, resourceRevision: resource.revision,
    machineConfigId: config.id, machineConfigRevision: config.revision,
    limitId: limit.id, limitRevision: limit.revision,
    ...(task ? { taskId: task.id, taskRevision: task.revision, taskSnapshot: { name: task.name, status: task.status } } : {}),
    resourceSnapshot: { name: resource.name, machinery: structuredClone(resource.machinery!) },
    machineConfigSnapshot: { name: config.name, definition: structuredClone(machineDefinition!) },
    limitSnapshot: { name: limit.name, definition: structuredClone(limitDefinition!) },
  };
  return { name, kind: "safety", ...(task ? { taskId: task.id } : {}), blocksCompletion: false,
    discovery: { kind: "manual", description: "人工登记浏览器几何筛查结果，待现场核实；非服务器复算或事故预测" },
    railSafetyRisk, evidenceIds: [], rounds: [], originalDueDate: null };
}
