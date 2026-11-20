import assert from 'node:assert/strict';
import test from 'node:test';
import { engineeringOcclusionFrameRole, validateEngineeringOcclusion } from './engineeringOcclusion.ts';

test('missing scheme rules retain the renderer behavior for selected and hidden models', () => {
  const rules = validateEngineeringOcclusion(undefined);
  assert.equal(engineeringOcclusionFrameRole(true, rules.model), 'normal');
  assert.equal(engineeringOcclusionFrameRole(false, rules.model), 'hidden');
});

test('an explicit model rule changes only its independent render role', () => {
  const rules = validateEngineeringOcclusion({ 'pier-a001': true, 'pile-a002': false });
  assert.equal(engineeringOcclusionFrameRole(false, rules['pier-a001']), 'depth');
  assert.equal(engineeringOcclusionFrameRole(true, rules['pier-a001']), 'normal');
  assert.equal(engineeringOcclusionFrameRole(true, rules['pile-a002']), 'color');
  assert.equal(engineeringOcclusionFrameRole(false, rules['pile-a002']), 'hidden');
});

test('rules require stable IDs and booleans without inherited properties', () => {
  const rules = validateEngineeringOcclusion(JSON.parse('{"constructor":false,"__proto__":true}'));
  assert.equal(Object.getPrototypeOf(rules), null);
  assert.equal(rules['__proto__'], true);
  assert.equal(rules['constructor'], false);
  for (const value of [null, [], { 'example/a': false }, { example: 'false' }]) {
    assert.throws(() => validateEngineeringOcclusion(value), /工程模型遮挡设置/);
  }
});
