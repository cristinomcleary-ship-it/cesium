import type { ManagementFilters, ManagementMetrics } from '../managementTypes';

export type MetricsContext = {
  projectId: string;
  businessAsOf: string;
  confirmedAsOf: string;
  filters: ManagementFilters;
};

export type MetricsState = {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  context?: MetricsContext;
  key?: string;
  error?: string;
};

export function metricsContextKey(context: MetricsContext): string {
  const filters = context.filters;
  return JSON.stringify([
    context.projectId, context.businessAsOf, context.confirmedAsOf,
    [...(filters.taskIds || [])].sort(), [...(filters.areaIds || [])].sort(),
    filters.ownerId || '', filters.status || '', filters.query || '',
    filters.periodStart || '', filters.periodEnd || '',
  ]);
}

export function metricsMatchesContext(result: ManagementMetrics, context: MetricsContext): boolean {
  return result.businessAsOf === context.businessAsOf
    && Date.parse(result.confirmedAsOf) === Date.parse(context.confirmedAsOf);
}

export const DOCUMENT_CATEGORIES = [
  ['', '全部资料'], ['drawing', '施工图纸'], ['plan', '技术方案'],
  ['quality', '质量资料'], ['safety', '安全资料'], ['test', '试验报告'], ['meeting', '会议纪要'],
] as const;

export function categoryMatches(record: Record<string, unknown>, category?: string): boolean {
  return !category || record.category === category;
}
