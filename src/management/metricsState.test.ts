import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryMatches, metricsContextKey, metricsMatchesContext, type MetricsContext } from './metricsState.ts';
import type { ManagementMetrics } from '../managementTypes.ts';

const context: MetricsContext = { projectId: 'project-a', businessAsOf: '2026-10-09', confirmedAsOf: '2026-10-09T00:00:00Z', filters: { taskIds: ['a', 'b'], areaIds: ['area-a'], query: '桥墩' } };
test('statistics identity includes project, D, F and all supported scope filters', () => {
  const original = metricsContextKey(context);
  for (const changed of [
    { ...context, projectId: 'project-b' }, { ...context, businessAsOf: '2026-10-10' },
    { ...context, confirmedAsOf: '2026-10-09T01:00:00Z' },
    ...[{ taskIds: [] }, { areaIds: ['area-b'] }, { ownerId: 'owner' }, { status: 'completed' }, { query: '盖梁' }, { periodStart: '2026-10-01' }, { periodEnd: '2026-10-31' }].map(filters => ({ ...context, filters: { ...context.filters, ...filters } })),
  ]) assert.notEqual(metricsContextKey(changed), original);
  assert.equal(metricsContextKey({ ...context, filters: { ...context.filters, taskIds: ['b', 'a'] } }), original);
});
test('late or mismatched statistics must not be relabelled with current date', () => {
  const result = { businessAsOf: context.businessAsOf, confirmedAsOf: context.confirmedAsOf } as ManagementMetrics;
  assert.equal(metricsMatchesContext(result, context), true);
  assert.equal(metricsMatchesContext({ ...result, businessAsOf: '2026-10-08' }, context), false);
  assert.equal(metricsMatchesContext({ ...result, confirmedAsOf: '2026-10-09T00:00:01Z' }, context), false);
});
test('document categories are independent of Chinese names and search text', () => {
  const drawing = { name: '十三号墩盖梁施工图', category: 'drawing' };
  assert.equal(categoryMatches(drawing, 'drawing'), true);
  assert.equal(categoryMatches(drawing, 'safety'), false);
  assert.equal(categoryMatches({ category: 'safety' }, 'drawing'), false);
  assert.equal(categoryMatches(drawing, ''), true);
});
