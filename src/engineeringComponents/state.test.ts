import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEngineeringCatalog, type EngineeringScope } from './catalog.ts';
import { EngineeringComponentState, type EngineeringStateChange } from './state.ts';

function fixture(count = 3, reverse = false) {
  const components = Array.from({ length: count }, (_, index) => ({ id: `C${index}`, name: `C${index}`, parentId: index === 1 ? 'TRACK' : 'ROOT', unitId: index < 2 ? 'T' : null,
    type: 'wall', typeName: '墙', visible: true, occlusion: false, geometryRef: { file: 'full.glb', node: `C${index}`, mesh: `C${index}` } }));
  if (reverse) components.reverse();
  return parseEngineeringCatalog({ schema: 'jiashan/component-library/2.0', modelRevision: 'test', units: 'm', geometryFile: 'full.glb',
    groups: [{ id: 'ROOT', name: '根', parentId: null }, { id: 'TRACK', name: '轨道', parentId: 'ROOT' }, { id: 'REF', name: '参考', parentId: null }], components,
    referenceGeometry: [{ id: 'ref', name: '参考', parentId: 'REF', mode: 'line', visible: false, occlusion: false }] }, { assetFingerprint: 'a'.repeat(64) });
}
const context = { projectId: 'project', actorId: 'actor', instanceId: 'model' };
const all = { kind: 'all' } as const, unit = { kind: 'unit', id: 'T' } as const;
const component = (id: string): EngineeringScope => ({ kind: 'component', id });

test('single, group/unit and all switches independently update visible and occlusion', () => {
  const state = new EngineeringComponentState(fixture(), context);
  assert.deepEqual(state.summary(all), { count: 3, visible: true, occlusionEnabled: false });
  state.apply(component('C0'), { visible: false, occlusionEnabled: true });
  assert.deepEqual(state.get('C0'), { visible: false, occlusionEnabled: true });
  assert.deepEqual(state.summary(unit), { count: 2, visible: 'mixed', occlusionEnabled: 'mixed' });
  state.apply(unit, { visible: false });
  assert.equal(state.get('C0').occlusionEnabled, true); assert.equal(state.get('C1').occlusionEnabled, false);
  assert.equal(state.get('C2').visible, true);
  state.apply({ kind: 'group', id: 'TRACK' }, { occlusionEnabled: true });
  assert.equal(state.summary(unit).occlusionEnabled, true);
  state.apply(all, { occlusionEnabled: false }); assert.equal(state.summary(all).occlusionEnabled, false);
  assert.equal(state.get('C0').visible, false); assert.equal(state.get('C2').visible, true);
  state.apply(all, { visible: true }); assert.equal(state.summary(all).visible, true);
  assert.deepEqual(state.get('ref'), { visible: false, occlusionEnabled: false });
});

test('view intersection uses one atomic update and does not touch other unit/classification members', () => {
  const catalog = fixture(), state = new EngineeringComponentState(catalog, context), changes: EngineeringStateChange[] = [];
  state.subscribe(change => changes.push(change));
  const view = new Set(catalog.getMembers(unit));
  state.applyIds(catalog.getMembers({ kind: 'group', id: 'ROOT' }).filter(id => view.has(id)), { visible: false });
  assert.equal(changes.length, 1); assert.deepEqual([...changes[0].componentIds].sort(), ['C0', 'C1']);
  assert.equal(state.get('C2').visible, true); assert.equal(state.summaryIds(['C0', 'C0', 'C1']).count, 2);
  state.applyIds(['C0', 'C0'], { visible: false }); assert.equal(changes.length, 1);
});

test('tree selection may select hidden items and never changes either flag', () => {
  const state = new EngineeringComponentState(fixture(), context), changes: EngineeringStateChange[] = [];
  const release = state.subscribe(change => changes.push(change));
  state.apply(component('C0'), { visible: false }); const flags = state.get('C0');
  assert.equal(state.select('C0'), true); assert.equal(state.selectedId, 'C0'); assert.deepEqual(state.get('C0'), flags);
  assert.equal(changes.at(-1)?.selectionChanged, true); assert.deepEqual(changes.at(-1)?.componentIds, []);
  assert.equal(state.select('C0'), false); assert.throws(() => state.select('absent'), /未知构件/);
  release(); state.select(null); assert.equal(changes.length, 2);
});

test('invalid batch patches are rejected before any leaf changes', () => {
  const state = new EngineeringComponentState(fixture(), context), before = state.serialize();
  assert.throws(() => state.applyIds(['C0', 'absent'], { visible: false }), /未知构件/);
  assert.throws(() => state.applyIds(['C0', 'ref'], { visible: false, occlusionEnabled: true }), /参考/);
  assert.throws(() => state.apply(all, { visible: 1 } as never), /布尔值/);
  assert.throws(() => state.apply(all, {}), /布尔值/);
  assert.throws(() => state.apply(all, { visibility: false } as never), /布尔值/);
  assert.deepEqual(state.serialize(), before); assert.equal(state.revision, 0);
});

test('compact state round trip preserves every physical item and reference with one notification', () => {
  const catalog = fixture(), state = new EngineeringComponentState(catalog, context);
  state.apply(component('C0'), { visible: false, occlusionEnabled: true }); state.apply(component('C2'), { occlusionEnabled: true });
  state.apply(component('ref'), { visible: true }); state.select('C0');
  const saved = state.serialize(), restored = new EngineeringComponentState(catalog, context), changes: EngineeringStateChange[] = [];
  restored.subscribe(change => changes.push(change)); restored.restore(JSON.stringify(saved));
  assert.deepEqual(restored.serialize(), saved); assert.equal(changes.length, 1); assert.equal(changes[0].selectionChanged, true);
  restored.restore(saved); assert.equal(changes.length, 1);
});

test('state fingerprint, identity, count, order, IDs, encoding and reference rules are checked atomically', () => {
  const state = new EngineeringComponentState(fixture(), context), saved = state.serialize();
  const corruptions = [ { assetFingerprint: 'b'.repeat(64) }, { projectId: 'other' }, { actorId: null }, { instanceId: 'other' },
    { schema: 'unknown' }, { orderFingerprint: 'other' }, { count: 5000 }, { flags: '' }, { flags: 'zz' }, { selectedId: 'absent' },
    { flags: 'd5' }, { extra: true } ];
  for (const patch of corruptions) {
    assert.throws(() => state.restore({ ...saved, ...patch })); assert.deepEqual(state.serialize(), saved); assert.equal(state.revision, 0);
  }
  const reordered = new EngineeringComponentState(fixture(3, true), context); assert.throws(() => reordered.restore(saved), /编号顺序/);
  const partial = new EngineeringComponentState(fixture(4), context), serialized = partial.serialize();
  assert.throws(() => partial.restore({ ...serialized, flags: `${serialized.flags.slice(0, -2)}fc` }), /填充位/);
  assert.notEqual(state.storageKey, new EngineeringComponentState(fixture(), { ...context, actorId: 'other' }).storageKey);
});

test('25,258 physical items have no 5,000-item truncation and compact serialization is bounded', () => {
  const catalog = fixture(25_258), state = new EngineeringComponentState(catalog, context);
  assert.equal(state.apply(all, { visible: false, occlusionEnabled: true }).length, 25_258);
  assert.deepEqual(state.get('C25257'), { visible: false, occlusionEnabled: true });
  assert.deepEqual(state.summary(all), { count: 25_258, visible: false, occlusionEnabled: true });
  assert.equal(state.serialize().flags.length, Math.ceil(25_259 / 4) * 2);
  assert.ok(JSON.stringify(state.serialize()).length < 13_100);
  const restored = new EngineeringComponentState(catalog, context); restored.restore(state.serialize());
  assert.deepEqual(restored.get('C25257'), state.get('C25257')); assert.deepEqual(restored.get('ref'), { visible: false, occlusionEnabled: false });
});
