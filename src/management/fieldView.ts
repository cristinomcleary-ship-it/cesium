import type { ManagementRecord } from '../managementTypes';
import type { ManagementModule } from './forms';
import { isOpenIssue, uniqueMachinery } from './coordinationView';

export type FieldSection = 'scene' | 'inspection' | 'documents' | 'more';
export const fieldNavigation = [
  { id: 'scene', label: '现场工作台', icon: 'box' },
  { id: 'inspection', label: '检查与整改', icon: 'inspection' },
  { id: 'documents', label: '方案与资料', icon: 'documents' },
] as const;
export function fieldSection(module: ManagementModule, tab: string, view: 'management' | 'scene'): FieldSection {
  if (view === 'scene') return 'scene';
  if (module === 'inspection' || module === 'field' && ['issues', 'checks'].includes(tab)) return 'inspection';
  if (module === 'documents') return 'documents';
  return 'more';
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
export function issueMachineryId(issue: ManagementRecord): string | undefined {
  const snapshot = issue.railSafetyRisk as { resourceId?: unknown } | undefined;
  const reference = issue.objectRef as {kind?:unknown;id?:unknown} | undefined;
  const references = Array.isArray(issue.objectRefs) ? issue.objectRefs as Array<{kind?:string;id?:string}> : [];
  return typeof snapshot?.resourceId === 'string' ? snapshot.resourceId : typeof issue.resourceId === 'string' ? issue.resourceId : reference?.kind === 'resources' && typeof reference.id === 'string' ? reference.id : references.find(item=>item.kind==='resources' && typeof item.id==='string')?.id;
}
/** Relationships use visible records only; matching names do not establish a relation. */
export function machineryTasks(machine: ManagementRecord, tasks: ManagementRecord[], related: ManagementRecord[] = []): ManagementRecord[] {
  const ids = new Set([...strings(machine.taskIds), ...(typeof machine.taskId === 'string' ? [machine.taskId] : [])]);
  for (const record of related) if (record.resourceId === machine.id && record.status !== 'cancelled' && !record.deletedAt) {
    if (typeof record.taskId === 'string') ids.add(record.taskId);
    for (const id of strings(record.taskIds)) ids.add(id);
  }
  return tasks.filter(task => !task.deletedAt && task.status !== 'deleted' && (ids.has(task.id) || strings(task.resourceIds).includes(machine.id)));
}
export function fieldIssues(issues: ManagementRecord[], machineId?: string): ManagementRecord[] {
  return issues.filter(issue => !issue.deletedAt && isOpenIssue(issue) && (!machineId || issueMachineryId(issue) === machineId));
}
export function fieldDirectory(resources: ManagementRecord[], query = ''): ManagementRecord[] {
  const term = query.trim().toLocaleLowerCase();
  return uniqueMachinery(resources).filter(resource => resource.status !== 'deleted').filter(resource => !term || [resource.name, resource.id, resource.specification].some(value => String(value || '').toLocaleLowerCase().includes(term)));
}

/** Scene task choices are independent of the previously visited business list. */
export function fieldTaskChoices(tasks: ManagementRecord[], workpointId?: string, selectedTaskId?: string): ManagementRecord[] {
  return tasks.filter(task => !task.deletedAt && task.status !== 'deleted' && (task.id === selectedTaskId || task.status !== 'cancelled' && (!workpointId || strings(task.areaIds).includes(workpointId) || task.spatialObjectId === workpointId)));
}

/** Explicit plan selection survives object clicks; missing/revoked plans never fall back to another plan. */
export function currentFieldTask(tasks: ManagementRecord[], selectedTaskId?: string): ManagementRecord | undefined {
  return tasks.find(task => task.id === selectedTaskId && !task.deletedAt && task.status !== 'deleted');
}
