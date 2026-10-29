import type { ManagementRecord } from './managementTypes';
import { validateMachineryMetadata } from './machineryValidation';
import type { MachineryMetadata } from './machineryTypes';

export type SceneMachineryResource = { record: ManagementRecord; machinery?: MachineryMetadata };

/** The directory and the editor share the authorized resource catalog, including
 * equipment which has not yet been placed. Geometry is an optional attachment. */
export function sceneMachineryResources(projectId: string | undefined, records: readonly ManagementRecord[], canView: boolean): SceneMachineryResource[] {
  if (!projectId || !canView) return [];
  const seen = new Set<string>();
  return records.flatMap(record => {
    if (record.projectId !== projectId || record.status === 'deleted' || record.deletedAt || seen.has(record.id)
      || !(record.kind === 'equipment' || record.category === 'equipment')) return [];
    seen.add(record.id);
    let machinery: MachineryMetadata | undefined;
    try { if (record.machinery) machinery = validateMachineryMetadata(record.machinery); } catch { /* Retain the resource so its configuration can be repaired. */ }
    return [{ record, machinery }];
  });
}
