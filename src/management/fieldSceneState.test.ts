import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldMachineRisk } from './fieldSceneState.ts';
import type { RailSafetyMachineResult } from '../railSafetyScene.ts';
const result = (patch: Partial<RailSafetyMachineResult> = {}): RailSafetyMachineResult => ({
  resourceId: 'm1', resourceName: '吊机', status: 'clear', label: '未发现交叉', message: '当前已选限界筛查', draft: false,
  warnings: [], limits: [{ id: 'l1', name: '限界', status: 'clear', distanceMeters: 1 }], guards: [], signature: 'current', ...patch,
});
test('missing model and missing result retain unknown without a numeric zero', () => {
  for (const value of [fieldMachineRisk(undefined, false, false), fieldMachineRisk(undefined, false, true)]) {
    assert.equal(value.risk, 'unknown'); assert.equal(value.intersectionCount, undefined);
  }
});
test('pending recalculation suppresses a previous clear headline', () => {
  const value = fieldMachineRisk(result(), true, true); assert.equal(value.risk, 'unknown'); assert.equal(value.riskLabel, '计算中'); assert.equal(value.intersectionCount, undefined);
});
test('unsaved mechanical preview does not qualify as a committed result', () => {
  const value = fieldMachineRisk(result({ draft: true }), false, true); assert.equal(value.risk, 'unknown'); assert.equal(value.intersectionCount, undefined);
});
test('invalid or unconfigured references override a stale clear result', () => {
  const value = fieldMachineRisk({ ...result(), preparationReason: '尚未选用安全限界' }, false, true); assert.equal(value.risk, 'unknown'); assert.equal(value.intersectionCount, undefined);
});
test('clear requires at least one evaluated limit and all clear relations', () => {
  const empty = fieldMachineRisk(result({ limits: [] }), false, true);
  const mixed = fieldMachineRisk(result({ limits: [...result().limits, { id: 'l2', name: '未知限界', status: 'unknown' }] }), false, true);
  assert.equal(empty.risk, 'unknown'); assert.equal(mixed.risk, 'unknown'); assert.equal(mixed.intersectionCount, undefined);
  assert.deepEqual(fieldMachineRisk(result(), false, true), { draft: false, risk: 'clear', riskLabel: '未发现交叉', riskMessage: '当前已选限界筛查', intersectionCount: 0 });
});
test('known crossing remains visible when another selected limit is unresolved', () => {
  const value = fieldMachineRisk(result({ status: 'overlap', label: '潜在侵限', limits: [{ id: 'l1', name: '已知相交', status: 'overlap' }, { id: 'l2', name: '待核实', status: 'unknown' }] }), false, true);
  assert.equal(value.risk, 'crossing'); assert.equal(value.intersectionCount, 1);
});
test('unknown engine status never displays an intersection count of zero', () => {
  const value = fieldMachineRisk(result({ status: 'unknown' }), false, true); assert.equal(value.risk, 'unknown'); assert.equal(value.intersectionCount, undefined);
});
