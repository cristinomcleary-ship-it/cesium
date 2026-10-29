import type { ManagementRecord, TaskConditionsResponse } from '../managementTypes';
import type { ManagementModule } from './forms';

/** Railway-facing navigation keeps the stored module/tab contracts unchanged. */
export type CoordinationSection = 'today' | 'plan' | 'tasks' | 'scene' | 'checks' | 'resources';
export const coordinationNavigation: Array<{ id: CoordinationSection; label: string; icon: string; module?: ManagementModule; tab?: string }> = [
  { id: 'today', label: '今日管控', icon: 'grid', module: 'overview', tab: 'project' },
  { id: 'plan', label: '工点与计划', icon: 'plan', module: 'plan', tab: 'tasks' },
  { id: 'tasks', label: '施工任务', icon: 'field', module: 'field', tab: 'today' },
  { id: 'scene', label: '现场三维', icon: 'box' },
  { id: 'checks', label: '检查与处置', icon: 'inspection', module: 'field', tab: 'issues' },
  { id: 'resources', label: '资源与档案', icon: 'resources', module: 'resources', tab: 'equipment' },
];
export function coordinationSection(module: ManagementModule, tab: string, view: 'management' | 'scene' = 'management'): CoordinationSection {
  if (view === 'scene') return 'scene';
  if (module === 'overview') return 'today';
  if (module === 'plan' || module === 'field' && tab === 'spatial') return 'plan';
  if (module === 'inspection' || module === 'field' && ['checks', 'issues'].includes(tab)) return 'checks';
  if (module === 'resources' || module === 'documents') return 'resources';
  return 'tasks';
}
export function taskOccursOnDay(task: ManagementRecord, day: string): boolean {
  if (task.status === 'cancelled') return false;
  // Work windows are Beijing civil time, never parsed in the browser's timezone.
  if (task.workWindowStart && task.workWindowEnd) {
    return String(task.workWindowStart) < `${day}T24:00` && String(task.workWindowEnd) > `${day}T00:00`;
  }
  const start = String(task.workWindowStart || task.planStart || '').slice(0, 10);
  const end = String(task.workWindowEnd || task.planEnd || task.planStart || '').slice(0, 10);
  return Boolean(start && end && start <= day && day <= end);
}
export function taskConditionState(task: ManagementRecord, result?: TaskConditionsResponse): 'ready' | 'blocked' | 'unknown' {
  if (!result || result.taskId !== task.id || result.taskRevision !== task.revision || !result.policy) return 'unknown';
  const required = result.stages.start.filter(rule => rule.mode === 'required');
  if (!result.stages.start.length || required.some(rule => rule.satisfied === null || rule.status === 'configuration-required')) return 'unknown';
  return required.some(rule => rule.satisfied !== true) ? 'blocked' : 'ready';
}
export function isOpenIssue(issue: ManagementRecord): boolean {
  return !['closed', 'false-positive', 'duplicate', 'invalid', 'archived'].includes(issue.status);
}
export function uniqueMachinery(resources: ManagementRecord[]): ManagementRecord[] {
  return [...new Map(resources.filter(resource => !resource.deletedAt && resource.status !== 'deleted' && (resource.kind === 'equipment' || resource.category === 'equipment' || resource.machinery)).map(resource => [resource.id, resource])).values()];
}
export function coordinationSummary(tasks: ManagementRecord[], issues: ManagementRecord[], resources: ManagementRecord[], day: string, conditions: Map<string, TaskConditionsResponse>) {
  const active = tasks.filter(task => !['completed', 'cancelled'].includes(task.status));
  const candidates = active.filter(task => ['draft', 'published', 'paused'].includes(task.status));
  const unknown = candidates.filter(task => taskConditionState(task, conditions.get(task.id)) === 'unknown');
  const blocked = candidates.filter(task => taskConditionState(task, conditions.get(task.id)) === 'blocked');
  return {
    today: tasks.filter(task => taskOccursOnDay(task, day)),
    preparation: [...blocked, ...unknown], unknown, blocked,
    working: active.filter(task => task.status === 'in-progress'),
    paused: active.filter(task => task.status === 'paused'),
    closing: active.filter(task => task.status === 'pending-completion'),
    issues: issues.filter(isOpenIssue),
    unscheduled: active.filter(task => !task.workWindowStart && !task.planStart),
    machines: uniqueMachinery(resources),
  };
}
export function railwayTaskLocation(task: ManagementRecord): string {
  return [task.railwayLine, task.railwaySection, task.railwayMileage, task.railwayTrack].filter(Boolean).join(' · ');
}
export function railwayTaskWindow(task: ManagementRecord): string {
  if (task.workWindowStart && task.workWindowEnd) return `${String(task.workWindowStart).replace('T', ' ')} — ${String(task.workWindowEnd).replace('T', ' ')}`;
  return [task.planStart, task.planEnd].filter(Boolean).join(' — ') || '待安排';
}
/** CSV is a current authorized task list, not a frozen approval/report record. */
export function coordinationTaskCsv(tasks: ManagementRecord[], issues: ManagementRecord[], owner: (id: unknown) => string, status: (value: string) => string): string {
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^\s*[=+\-@]|^[\t\r\n]/u.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows: unknown[][] = [['任务编号', '施工任务', '作业批次', '线路', '区间', '里程', '股道 / 侧别', '施工类型', '状态', '负责人', '计划开始', '计划完成', '窗口开始（北京时间）', '窗口结束（北京时间）', '许可依据编号', '未闭问题数']];
  for (const task of tasks) rows.push([task.id, task.name, task.batchLabel, task.railwayLine, task.railwaySection, task.railwayMileage, task.railwayTrack, task.railwayWorkType, status(task.status), owner(task.ownerId), task.planStart, task.planEnd, task.workWindowStart, task.workWindowEnd, task.permitReference, issues.filter(issue => isOpenIssue(issue) && (issue.taskId === task.id || issue.taskIds?.includes(task.id))).length]);
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
