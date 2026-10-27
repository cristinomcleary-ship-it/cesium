import type { FormField } from './forms';

export type FormCategory = { id: string; title: string; fields: FormField[] };
const categories = [
  ['basic', '基本信息'], ['location', '线路与位置'], ['schedule', '时间与计划'],
  ['relations', '关联对象'], ['evidence', '文件与依据'],
] as const;

/** Every field is retained exactly once; validation and submission still use the original FormSpec. */
export function groupFormFields(fields: readonly FormField[]): FormCategory[] {
  const groups = new Map<string, FormField[]>(categories.map(([id]) => [id, []]));
  for (const field of fields) {
    const key = field.type === 'file' || /evidence|reason|basis|revisionNote|description|criterion|coordinationNote|explanation|impacts/i.test(field.name) ? 'evidence'
      : /railway|location|areaIds|riskPointId|anchorId/.test(field.name) ? 'location'
      : field.type === 'date' || field.type === 'datetime-local' || /^(targetQuantity|weight|predecessorIds|milestone)$/.test(field.name) ? 'schedule'
      : field.source && field.source !== 'members' ? 'relations' : 'basic';
    groups.get(key)!.push(field);
  }
  return categories.map(([id, title]) => ({ id, title, fields: groups.get(id)! })).filter(group => group.fields.length);
}
