import type { ManagementRecord } from './managementTypes.ts';

export type RailSafetyTaskScopeSelection = { kind: 'all' | 'unassigned' | 'task'; taskId?: string };
export type RailSafetyTaskConfigurationGap = {
  resourceId: string;
  reason: 'no-saved-config' | 'config-in-other-task';
  message: string;
};
/** A read-only projection of the currently authorized snapshot, never a computation input. */
export type RailSafetyTaskScope = {
  kind: RailSafetyTaskScopeSelection['kind']; taskId?: string; name: string;
  resourceIds: string[]; recordIds: string[]; guardIds: string[];
  /** Scoped limits and global candidate limits are separate; neither means selected by a machine. */
  ownLimitIds: string[]; sharedLimitIds: string[];
  configuredResourceIds: string[]; missingConfigurationResourceIds: string[];
  configurationGaps: RailSafetyTaskConfigurationGap[];
  issueIds: string[]; openIssueIds: string[]; pendingVerificationIssueIds: string[];
};
export type RailSafetyTaskSummary = RailSafetyTaskScope & {
  kind: 'task'; taskId: string; status: string; statusLabel: string;
  planStart?: string; planEnd?: string; forecastEnd?: string;
};
export type RailSafetyTaskView = {
  projectId: string; all: RailSafetyTaskScope; unassigned: RailSafetyTaskScope; tasks: RailSafetyTaskSummary[];
};
export type RailSafetyTaskViewInput = {
  projectId: string; tasks: readonly ManagementRecord[]; resources: readonly ManagementRecord[];
  records: readonly ManagementRecord[]; issues?: readonly ManagementRecord[]; allocations?: readonly ManagementRecord[];
};

type SafetyEntry = { record: ManagementRecord; kind: 'machine' | 'guard' | 'limit'; resourceIds: string[] };
const TASK_STATUS: Record<string, string> = {
  draft: '草稿', published: '已发布', 'in-progress': '进行中', paused: '已暂停',
  'pending-completion': '待完工确认', completed: '已完成', cancelled: '已取消',
};
const CLOSED_ISSUES = new Set(['closed', 'false-positive', 'duplicate', 'cancelled', 'deleted']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && !!id) : [];
const unique = (values: readonly string[]): string[] => [...new Set(values)];
const taskIds = (record: ManagementRecord): string[] => unique([...(typeof record.taskId === 'string' && record.taskId ? [record.taskId] : []), ...strings(record.taskIds)]);
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
function entries(records: readonly ManagementRecord[]): SafetyEntry[] {
  return records.flatMap<SafetyEntry>(record => {
    const definition = record.definition;
    if (!object(definition)) return [];
    if (definition.kind === 'machine') return [{ record, kind: 'machine' as const, resourceIds: typeof definition.resourceId === 'string' ? [definition.resourceId] : [] }];
    if (definition.kind === 'guard') return [{ record, kind: 'guard' as const, resourceIds: strings(definition.resourceIds) }];
    return definition.kind === 'limit' ? [{ record, kind: 'limit' as const, resourceIds: [] }] : [];
  });
}

/**
 * Filter lists only. Callers must keep all authorized saved records in the scene evaluator:
 * a task selection, a completed task, or a hidden layer must not suppress known risk checks.
 * Counts describe saved bindings, not configuration validity, task admission, or safety approval.
 */
export function buildRailSafetyTaskView(input: RailSafetyTaskViewInput): RailSafetyTaskView {
  const visible = (rows: readonly ManagementRecord[]) => rows.filter(row => row.projectId === input.projectId && row.status !== 'deleted');
  const tasks = visible(input.tasks), knownTasks = new Set(tasks.map(task => task.id));
  const resources = visible(input.resources).filter(row => row.kind === 'equipment' || row.category === 'equipment');
  const safety = entries(visible(input.records));
  const machines = safety.filter(entry => entry.kind === 'machine');
  const sharedLimits = safety.filter(entry => entry.kind === 'limit' && !entry.record.taskId);
  const unassignedEntries = safety.filter(entry => !entry.record.taskId || !knownTasks.has(entry.record.taskId));
  const associations = new Map(resources.map(row => [row.id, new Set(taskIds(row).filter(id => knownTasks.has(id)))]));
  const associate = (resourceId: string, ids: readonly string[]) => {
    const related = associations.get(resourceId);
    if (related) for (const id of ids) if (knownTasks.has(id)) related.add(id);
  };
  // A task card links visible equipment, but never supplies or rebinds its safety configuration.
  for (const task of tasks) for (const id of strings(task.resourceIds)) associate(id, [task.id]);
  // railSafety has one authoritative taskId; taskIds from unrelated generic records are not used.
  for (const entry of safety) for (const id of entry.resourceIds) associate(id, entry.record.taskId ? [entry.record.taskId] : []);
  for (const allocation of visible(input.allocations ?? [])) {
    if (allocation.status !== 'cancelled' && typeof allocation.resourceId === 'string') associate(allocation.resourceId, taskIds(allocation));
  }
  const looseResourceIds = new Set(unassignedEntries.flatMap(entry => entry.resourceIds));
  const issues = visible(input.issues ?? []).filter(issue => object(issue.railSafetyRisk) && issue.railSafetyRisk.schemaVersion === 1);
  const scope = (kind: RailSafetyTaskScope['kind'], name: string, taskId?: string): RailSafetyTaskScope => {
    const ownEntries = kind === 'all' ? safety : kind === 'unassigned' ? unassignedEntries : safety.filter(entry => entry.record.taskId === taskId);
    const scopedResources = resources.filter(resource => kind === 'all' || (kind === 'task'
      ? associations.get(resource.id)?.has(taskId!)
      : !associations.get(resource.id)?.size || looseResourceIds.has(resource.id)));
    const configured = new Set(ownEntries.filter(entry => entry.kind === 'machine').flatMap(entry => entry.resourceIds));
    const gaps = scopedResources.filter(resource => !configured.has(resource.id)).map(resource => {
      const elsewhere = machines.some(entry => entry.resourceIds.includes(resource.id));
      return { resourceId: resource.id, reason: elsewhere ? 'config-in-other-task' as const : 'no-saved-config' as const,
        message: elsewhere ? '已有其他任务范围的机械配置，当前范围尚未绑定' : '尚未保存机械管控配置' };
    });
    const scopedIssues = issues.filter(issue => kind === 'all' || (kind === 'task'
      ? taskIds(issue).includes(taskId!) : !taskIds(issue).some(id => knownTasks.has(id))));
    const open = scopedIssues.filter(issue => !CLOSED_ISSUES.has(issue.status));
    return {
      kind, ...(taskId ? { taskId } : {}), name,
      resourceIds: unique(scopedResources.map(resource => resource.id)),
      recordIds: unique([...ownEntries.map(entry => entry.record.id), ...sharedLimits.map(entry => entry.record.id)]),
      guardIds: unique(ownEntries.filter(entry => entry.kind === 'guard').map(entry => entry.record.id)),
      ownLimitIds: unique(ownEntries.filter(entry => entry.kind === 'limit' && !!entry.record.taskId).map(entry => entry.record.id)),
      sharedLimitIds: unique(sharedLimits.map(entry => entry.record.id)),
      configuredResourceIds: unique(scopedResources.filter(resource => configured.has(resource.id)).map(resource => resource.id)),
      missingConfigurationResourceIds: gaps.map(gap => gap.resourceId), configurationGaps: gaps,
      issueIds: scopedIssues.map(issue => issue.id), openIssueIds: open.map(issue => issue.id),
      pendingVerificationIssueIds: open.filter(issue => issue.status === 'pending-verification').map(issue => issue.id),
    };
  };
  return {
    projectId: input.projectId, all: scope('all', '全部可见数据'), unassigned: scope('unassigned', '未关联可见任务'),
    tasks: tasks.map(task => ({
      ...scope('task', task.name || '未命名任务', task.id), kind: 'task', taskId: task.id,
      status: task.status, statusLabel: TASK_STATUS[task.status] ?? task.status,
      planStart: text(task.planStart), planEnd: text(task.planEnd), forecastEnd: text(task.forecastEnd),
    })),
  };
}

/** An unavailable task returns undefined; never silently widen a stale selection to all tasks. */
export function selectRailSafetyTaskScope(view: RailSafetyTaskView, selection: RailSafetyTaskScopeSelection): RailSafetyTaskScope | undefined {
  if (selection.kind === 'all') return view.all;
  if (selection.kind === 'unassigned') return view.unassigned;
  return view.tasks.find(task => task.taskId === selection.taskId);
}

function csvCell(value: string | number): string {
  let content = String(value);
  // Spreadsheet programs may execute text beginning with a formula after whitespace trimming.
  if (/^[\s\uFEFF]*[=+@-]/u.test(content) || /^[\t\r\n]/u.test(content)) content = `'${content}`;
  return `"${content.replaceAll('"', '""')}"`;
}

/** UTF-8 BOM plus RFC-4180-style quoting; formulas are exported as inert text. */
export function exportRailSafetyTaskCsv(view: RailSafetyTaskView, options: { exportedAt: string }): string {
  const instant = new Date(options.exportedAt);
  if (!Number.isFinite(instant.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(options.exportedAt)) throw new Error('导出时间必须包含有效时区');
  const exportedAt = instant.toISOString();
  const header = ['数据口径', '导出时间（UTC）', '项目编号', '查看范围', '任务编号', '任务状态', '计划开始', '计划完成', '预测完成', '涉及机械（台）', '已有本范围机械配置（台）', '待绑定机械配置（台）', '防护人员配置（项）', '本范围专属限界（项）', '共用可选限界（项，非自动选用）', '未闭环机械风险处置单（件）', '其中待核实（件）'];
  const rows = [view.all, ...view.tasks, view.unassigned].map(scope => {
    const task = scope.kind === 'task' ? view.tasks.find(row => row.taskId === scope.taskId) : undefined;
    return ['当前账号可见已保存数据；涉及机械可跨任务；配置绑定不代表安全通过；各行不可相加', exportedAt, view.projectId, scope.name,
      scope.taskId ?? '', task?.statusLabel ?? '', task?.planStart ?? '', task?.planEnd ?? '', task?.forecastEnd ?? '',
      scope.resourceIds.length, scope.configuredResourceIds.length, scope.missingConfigurationResourceIds.length,
      scope.guardIds.length, scope.ownLimitIds.length, scope.sharedLimitIds.length, scope.openIssueIds.length, scope.pendingVerificationIssueIds.length];
  });
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
