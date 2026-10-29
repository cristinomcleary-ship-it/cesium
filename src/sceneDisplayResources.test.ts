import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneMachineryResources } from './sceneDisplayResources.ts';
import { SceneDisplayStore } from './sceneDisplayStore.ts';
import type { ManagementRecord } from './managementTypes.ts';
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from './machineryTypes.ts';
import { MACHINERY_PARAMETER_DEFAULTS } from './machineryValidation.ts';

function resource(overrides: Partial<ManagementRecord> = {}): ManagementRecord {
  return { id: 'equipment:crane', projectId: 'project-a', revision: 1, name: '吊机一', status: 'active', kind: 'equipment',
    createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', createdBy: 'operator', ...overrides };
}
function machine(): MachineryMetadata {
  return { schemaVersion: 1, assetId: 'crane', assetVersion: MACHINERY_ASSET_VERSION, proportional: true,
    parameters: { ...MACHINERY_PARAMETER_DEFAULTS.crane }, placement: { longitude: 121, latitude: 31, height: 0, heading: 0 }, visible: true };
}
test('the resource directory follows create, configure, rename, detach and delete without replacing resource IDs', () => {
  let record = resource();
  const read = () => sceneMachineryResources('project-a', [record], true);
  assert.equal(read()[0].record.id, record.id);
  assert.equal(read()[0].machinery, undefined, 'new equipment remains available for configuration');
  record = { ...record, revision: 2, machinery: machine() };
  assert.equal(read()[0].machinery?.assetId, 'crane');
  record = { ...record, revision: 3, name: '改名吊机', machinery: { ...machine(), visible: false } };
  assert.equal(read()[0].record.name, '改名吊机');
  assert.equal(read()[0].machinery?.visible, false);
  record = { ...record, revision: 4 }; delete record.machinery;
  assert.equal(read().length, 1); assert.equal(read()[0].machinery, undefined);
  record = { ...record, revision: 5, status: 'deleted' };
  assert.deepEqual(read(), []);
});

test('directory uses only the current authorized project, excludes deleted objects and deduplicates resources', () => {
  const records = [resource(), resource(), resource({ id: 'other-project', projectId: 'project-b' }),
    resource({ id: 'deleted', status: 'deleted' }), resource({ id: 'deleted-at', deletedAt: '2026-10-29T01:00:00.000Z' }),
    resource({ id: 'material', kind: 'material' }), resource({ id: 'legacy', kind: undefined, category: 'equipment' })];
  assert.deepEqual(sceneMachineryResources('project-a', records, true).map(item => item.record.id), ['equipment:crane', 'legacy']);
  assert.deepEqual(sceneMachineryResources('project-b', records, true).map(item => item.record.id), ['other-project']);
  assert.deepEqual(sceneMachineryResources('project-a', records, false), []);
  assert.deepEqual(sceneMachineryResources(undefined, records, true), []);
});

test('invalid geometry keeps the authorized equipment available for repair without becoming a visible model', () => {
  const record = resource({ machinery: { ...machine(), placement: { ...machine().placement, longitude: NaN } } });
  const [entry] = sceneMachineryResources('project-a', [record], true);
  assert.equal(entry.record, record); assert.equal(entry.machinery, undefined);
  assert(Number.isNaN(record.machinery!.placement.longitude), 'directory validation does not rewrite business records');
});

test('saved display and groups survive model detach/reconfigure, permission loss and project switches', () => {
  const values = new Map<string, string>();
  const store = new SceneDisplayStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
  const id = 'machine:equipment:crane';
  store.setContext('project-a', 'actor-a');
  store.setItems([{ id, visible: true }]);
  store.setVisibility([id], false); const group = store.createGroup('吊装', [id]);
  store.setItems([{ id, visible: true, visibilityAvailable: false }]);
  assert.equal(store.isVisible(id), false); assert.equal(store.groupState(group.id), 'empty');
  store.setGroupVisibility(group.id, true);
  assert.equal(store.getOverrides()[id], false, 'a pending placement cannot override a saved visibility choice');
  store.setItems([{ id, visible: true }]);
  assert.equal(store.isVisible(id), false); assert.deepEqual(store.getGroups()[0].members, [id]);
  store.setItems([]); store.setItems([{ id, visible: true }]);
  assert.equal(store.isVisible(id), false, 'temporary authorization/loading absence preserves personal preferences');
  store.setContext('project-b', 'actor-a'); store.setItems([{ id, visible: true }]);
  assert.equal(store.isVisible(id), true); assert.deepEqual(store.getGroups(), []);
  store.setContext('project-a', 'actor-b'); store.setItems([{ id, visible: true }]);
  assert.equal(store.isVisible(id), true); assert.deepEqual(store.getGroups(), []);
  store.setContext('project-a', 'actor-a'); store.setItems([{ id, visible: true }]);
  assert.equal(store.isVisible(id), false); assert.deepEqual(store.getGroups()[0].members, [id]);
});

test('an unplaced resource cannot appear visible through an existing true override', () => {
  const store = new SceneDisplayStore({ getItem: () => null, setItem: () => undefined });
  const id = 'machine:equipment:crane';
  store.setContext('project-a', 'actor-a'); store.setItems([{ id, visible: true }]); store.setVisibility([id], true);
  store.setItems([{ id, visible: true, visibilityAvailable: false }]);
  assert.equal(store.isVisible(id), false); assert.equal(store.getOverrides()[id], true);
  store.setItems([{ id, visible: false }]); assert.equal(store.isVisible(id), true, 'reconfiguration restores the personal display setting');
});
