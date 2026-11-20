import assert from 'node:assert/strict';
import test from 'node:test';
import { engineeringGroupModelIds, ModelOcclusionPreferences } from './modelOcclusionPreferences';

test('personal occlusion rules keep explicit off distinct from the legacy default', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const preferences = new ModelOcclusionPreferences(storage);
  assert.equal(preferences.read('project-a', 'alice').get('pier'), undefined);
  preferences.update('project-a', 'alice', ['pier', 'cap'], 'on');
  preferences.update('project-a', 'alice', ['cap'], 'off');
  assert.deepEqual([...preferences.read('project-a', 'alice')], [['pier', true], ['cap', false]]);
  assert.equal(preferences.read('project-a', 'bob').size, 0);
  assert.equal(preferences.read('project-b', 'alice').size, 0);

  const secondTab = new ModelOcclusionPreferences(storage);
  secondTab.update('project-a', 'alice', ['abutment'], 'on');
  preferences.update('project-a', 'alice', ['pier'], 'default');
  assert.deepEqual([...preferences.read('project-a', 'alice')], [['cap', false], ['abutment', true]]);
});

test('a display group only applies occlusion to its engineering model records', () => {
  const group = { id: 'a', name: '桥梁', members: ['layer:pier', 'layer:photo', 'layer:pier', 'machine:crane', 'layer:missing'] };
  assert.deepEqual(engineeringGroupModelIds(group, new Set(['pier', 'crane'])), ['pier']);
});
