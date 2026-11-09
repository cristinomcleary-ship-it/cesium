import assert from 'node:assert/strict';
import test from 'node:test';
import { FUNCTION_CENTERS, centerForTab, matchesFunctionEntry } from './functionCenters.ts';

test('all existing professional entries have one home and no duplicate command', () => {
  const tabs = FUNCTION_CENTERS.flatMap(center => center.entries.flatMap(entry => entry.tab ? [entry.tab] : []));
  assert.deepEqual([...tabs].sort(), ['overview', 'sandtable', 'cad', 'models', 'temporary-works', 'machinery', 'rail-safety', 'tiles', 'gis', 'videoar', 'markup', 'monitoring', 'report'].sort());
  const commands = FUNCTION_CENTERS.flatMap(center => center.entries.map(entry => entry.tab ?? entry.action));
  assert.equal(commands.length, new Set(commands).size);
  assert.equal(centerForTab('temporary-works'), 'construction');
  assert.equal(centerForTab('monitoring'), 'safety');
  assert.equal(centerForTab('unknown'), undefined);
});

test('search understands business terms, center names, mixed case and multiple terms', () => {
  const results = (query: string) => FUNCTION_CENTERS.flatMap(center => center.entries.filter(entry => matchesFunctionEntry(center, entry, query)).map(entry => entry.tab ?? entry.action));
  assert.deepEqual(results('便道'), ['temporary-works']);
  assert.deepEqual(results('安全监测中心 机械'), ['machinery']);
  assert.deepEqual(results('  glb 模型  '), ['models']);
  assert.deepEqual(results('巡检融合中心'), ['videoar', 'inspection']);
  assert.deepEqual(results('未开发的空洞修复'), []);
  assert.equal(results('').length, FUNCTION_CENTERS.reduce((total, center) => total + center.entries.length, 0));
});
