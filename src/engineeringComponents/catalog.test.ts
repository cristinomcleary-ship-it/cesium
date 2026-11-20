import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineeringModelBindings, parseEngineeringCatalog, parseEngineeringStructure, readGlbJson } from './catalog.ts';

const hash = 'a'.repeat(64);
function item(id: string, parentId: string, unitId: string | null = 'T') {
  return { id, name: id, parentId, unitId, type: 'wall', typeName: '墙', visible: true, occlusion: false,
    bounds_m: [[0, 0, 0], [1, 1, 1]], geometryRef: { file: 'models/full.glb', node: id, mesh: id } };
}
function source() {
  return { schema: 'jiashan/component-library/2.0', modelRevision: 'test', units: 'm', geometryFile: 'models/full.glb',
    groups: [{ id: 'ROOT', name: '根', parentId: null as string | null }, { id: 'T', name: '隧道', parentId: 'ROOT' },
      { id: 'TRACK', name: '轨道', parentId: 'ROOT' }, { id: 'REF', name: '参考', parentId: null }],
    components: [item('wall', 'T'), item('rail', 'TRACK'), item('span', 'ROOT', null)],
    referenceGeometry: [{ id: 'ref', name: '参考线', parentId: 'REF', mode: 'line', visible: false, occlusion: false }] };
}
function gltf(ids = ['wall', 'rail', 'span', 'ref']) {
  const nodes: Array<{ name: string; mesh?: number; extras?: { componentId: string }; children?: number[] }> = ids.map((id, mesh) => ({ name: id, mesh, extras: { componentId: id } }));
  nodes.push({ name: 'source-root', children: ids.map((_, index) => index) });
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [ids.length] }],
    nodes,
    meshes: ids.map(id => ({ name: id, primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 1 } }] })) };
}
const parse = (value: unknown = source()) => parseEngineeringCatalog(value, { assetFingerprint: hash });

test('classification descendants and unit membership are distinct; a unit includes its track', () => {
  const raw = source(), before = JSON.stringify(raw), catalog = parse(raw);
  assert.deepEqual(catalog.getMembers({ kind: 'group', id: 'T' }), ['wall']);
  assert.deepEqual(catalog.getMembers({ kind: 'unit', id: 'T' }), ['wall', 'rail']);
  assert.deepEqual(catalog.getMembers({ kind: 'all' }), ['wall', 'rail', 'span']);
  assert.deepEqual(catalog.getMembers({ kind: 'group', id: 'REF' }), ['ref']);
  assert.deepEqual(catalog.getAncestors('rail'), ['ROOT', 'TRACK']);
  assert.equal(catalog.references[0].defaultVisible, false);
  assert.equal(JSON.stringify(raw), before);
  assert.ok(Object.isFrozen(catalog.components[0]));
});

test('rejects duplicate IDs, unknown parents, cycles and invalid structure metadata', () => {
  const duplicate = source(); duplicate.components.push(duplicate.components[0]); assert.throws(() => parse(duplicate), /重复/);
  const collision = source(); collision.components[0].id = 'ROOT'; assert.throws(() => parse(collision), /重复/);
  const parent = source(); parent.components[0].parentId = 'absent'; assert.throws(() => parse(parent), /父组不存在/);
  const cycle = source(); cycle.groups[0].parentId = 'T'; assert.throws(() => parse(cycle), /循环/);
  const self = source(); self.groups[1].parentId = 'T'; assert.throws(() => parse(self), /循环/);
  const wrongSchema = source(); wrongSchema.schema = 'unknown'; assert.throws(() => parse(wrongSchema), /schema/);
  const wrongPath = source(); wrongPath.geometryFile = '../full.glb'; assert.throws(() => parse(wrongPath), /相对路径/);
  const bounds = source(); bounds.components[0].bounds_m[0][0] = Infinity; assert.throws(() => parse(bounds), /无效坐标/);
  assert.throws(() => parseEngineeringCatalog(source(), { assetFingerprint: 'unverified' }), /SHA256/);
  assert.throws(() => parse().getMembers({ kind: 'component', id: 'unknown' }), /未知构件/);
  assert.throws(() => parse().getAncestors('unknown'), /未知对象/);
});

test('structure index validates every declared unit and count without requiring non-unit upper structures', () => {
  const index = { T: { path: 'structure-library/tunnel/T', count: 2, sha256: hash } };
  const catalog = parseEngineeringCatalog(source(), { assetFingerprint: hash, structureIndex: index });
  assert.equal(catalog.components.length, 3); assert.equal(catalog.unitAssets.get('T')?.count, 2);
  assert.throws(() => parseEngineeringCatalog(source(), { assetFingerprint: hash, structureIndex: {} }), /缺少单元/);
  assert.throws(() => parseEngineeringCatalog(source(), { assetFingerprint: hash, structureIndex: { T: { ...index.T, count: 3 } } }), /数量不一致/);
  assert.throws(() => parseEngineeringCatalog(source(), { assetFingerprint: hash, structureIndex: { ...index, unknown: index.T } }), /未知单元/);
});

test('unit structure keeps linked support separate from actual model members', () => {
  const catalog = parse(), data = { unitId: 'T', model: 'model.glb', componentIds: ['rail', 'wall'], linkedSupportIds: ['span'], sourceLocalCoordinates: true, coordinateFrame: 'source Z_UP' };
  const parsed = parseEngineeringStructure(data, catalog, 'T');
  assert.deepEqual(parsed.componentIds, ['rail', 'wall']); assert.deepEqual(parsed.linkedSupportIds, ['span']);
  assert.throws(() => parseEngineeringStructure({ ...data, componentIds: ['wall'] }, catalog), /成员/);
  assert.throws(() => parseEngineeringStructure({ ...data, componentIds: ['wall', 'wall'] }, catalog), /重复/);
  assert.throws(() => parseEngineeringStructure({ ...data, linkedSupportIds: ['absent'] }, catalog), /未知关联/);
  assert.throws(() => parseEngineeringStructure(data, catalog, 'OTHER'), /不一致/);
  assert.throws(() => parseEngineeringStructure({ ...data, sourceLocalCoordinates: false }, catalog), /原局部坐标/);
});

test('full and unit GLB map node index, not primitive ordinal, to component IDs', () => {
  const catalog = parse(), full = createEngineeringModelBindings(catalog, gltf());
  assert.equal(full.bindings.length, 4); assert.deepEqual(full.componentToNodes.get('rail'), [1]);
  assert.equal(full.nodeToComponent.get(0), 'wall'); assert.equal(full.nodeToComponent.get(4), undefined);
  const unit = createEngineeringModelBindings(catalog, gltf(['rail', 'wall']), { unitId: 'T' });
  assert.equal(unit.nodeToComponent.get(0), 'rail'); assert.deepEqual(unit.componentToNodes.get('wall'), [1]);
  assert.equal(unit.unitId, 'T'); assert.equal(unit.bindings.length, 2);
  assert.throws(() => createEngineeringModelBindings(catalog, gltf(['wall']), { unitId: 'T' }), /缺少构件/);
  assert.throws(() => createEngineeringModelBindings(catalog, gltf(), { unitId: 'T' }), /超出当前范围/);
});

test('GLB validation rejects unknown, duplicate, mismatched and unreachable node mappings', () => {
  const catalog = parse();
  assert.throws(() => createEngineeringModelBindings(catalog, gltf(['wall', 'rail', 'unknown', 'ref'])), /未知/);
  assert.throws(() => createEngineeringModelBindings(catalog, gltf(['wall', 'wall', 'span', 'ref'])), /重复/);
  const wrongMesh = gltf(); wrongMesh.meshes[0].name = 'rail'; assert.throws(() => createEngineeringModelBindings(catalog, wrongMesh), /名称/);
  const extras = gltf(); extras.nodes[0].extras!.componentId = 'rail'; assert.throws(() => createEngineeringModelBindings(catalog, extras), /名称/);
  const child = gltf(); child.nodes[4].children!.push(0); assert.throws(() => createEngineeringModelBindings(catalog, child), /重复父级/);
  const unreachable = gltf(); unreachable.nodes[4].children = [0, 1, 2]; assert.throws(() => createEngineeringModelBindings(catalog, unreachable), /不可达/);
});

test('reads the original GLB JSON without altering bytes and rejects malformed headers', () => {
  const json = JSON.stringify(gltf()), length = Math.ceil(json.length / 4) * 4;
  const buffer = new ArrayBuffer(length + 20), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(buffer); bytes.fill(32, 20); bytes.set(new TextEncoder().encode(json), 20);
  const before = bytes.slice(); assert.deepEqual(readGlbJson(buffer), gltf()); assert.deepEqual(bytes, before);
  view.setUint32(8, buffer.byteLength + 1, true); assert.throws(() => readGlbJson(buffer), /长度/);
  assert.throws(() => readGlbJson(new ArrayBuffer(12)), /文件头/);
});
