import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cartesian3, Matrix4, Transforms, type Model } from 'cesium';
import { findStructureBinding, parseStructureCatalog, parseStructureConfig, pickedEngineeringModelNodeNames,
  structureAssetUrl, structureProjectionFrame, structureProjectionMatrix, validateStructureGlb, type EngineeringModelPick } from './structureHologramConfig';

const base = { modelId: 'saved-model-id', category: 'bridge', structureId: 'A001' };

test('structure binding uses the exact saved model and node with explicit whole-model fallback', () => {
  const exact = { ...base, nodeName: 'A001# 墩', structureId: 'A001-detail' };
  const bindings = parseStructureCatalog({ version: 1, bindings: [base, exact] });
  assert.deepEqual(findStructureBinding(bindings, base.modelId, ['mesh', exact.nodeName]), exact);
  assert.equal(findStructureBinding(bindings, base.modelId, ['A002# 墩'])?.structureId, 'A001');
  assert.equal(findStructureBinding([exact], base.modelId, ['A001#墩']), undefined);
  assert.equal(findStructureBinding(bindings, 'different-saved-model', [exact.nodeName]), undefined);
  assert.equal(structureAssetUrl(exact, 'preview'), '/__structure_library/bridge/A001-detail/preview');
  assert.throws(() => parseStructureCatalog({ version: 1, bindings: [exact, { ...exact, structureId: 'other' }] }), /重复/);
  assert.throws(() => parseStructureCatalog({ version: 1, bindings: [{ ...base, category: '../bridge' }] }), /无效/);
  assert.throws(() => structureAssetUrl({ ...base, structureId: '%2Fpreview' }, 'preview'), /无效/);
});

test('pinned standalone model picks refuse foreign, ambiguous and unresolved runtime nodes', () => {
  const model = { ready: true, getNode: (name: string) => ({ name, id: name === 'assembly' ? 1 : 2 }) } as unknown as Model;
  const node = { node: { name: 'pier', index: 2 }, sceneGraph: { _runtimeNodes: [] as unknown[] } };
  node.sceneGraph._runtimeNodes[1] = { node: { name: 'assembly', index: 1 }, children: [2] };
  node.sceneGraph._runtimeNodes[2] = node;
  const pick = { primitive: model, detail: { model, node } } as EngineeringModelPick;
  assert.deepEqual(pickedEngineeringModelNodeNames(pick, model), ['pier', 'assembly']);
  assert.deepEqual(pickedEngineeringModelNodeNames({ ...pick, primitive: {} }, model), []);
  assert.deepEqual(pickedEngineeringModelNodeNames({ ...pick, detail: { ...pick.detail, model: {} } }, model), []);
  assert.deepEqual(pickedEngineeringModelNodeNames({ primitive: model }, model), []);
  node.sceneGraph._runtimeNodes[3] = { node: { name: 'pier', index: 3 } };
  assert.deepEqual(pickedEngineeringModelNodeNames(pick, model), ['assembly']);
});

test('projection pose preserves source matrix and applies model scale only to a local anchor', () => {
  const origin = Cartesian3.fromDegrees(120, 30, 25);
  const modelMatrix = Transforms.eastNorthUpToFixedFrame(origin);
  const source = { modelMatrix: structureProjectionMatrix(modelMatrix, 73), scale: 2 };
  const original = Matrix4.clone(source.modelMatrix);
  const expected = Matrix4.multiplyByPoint(source.modelMatrix, new Cartesian3(2, 6, 8), new Cartesian3());
  const frame = structureProjectionFrame({ kind: 'model-local', position: [1, 3, 4] }, source);
  const pose = structureProjectionMatrix(frame, 90);
  assert.deepEqual(Matrix4.getTranslation(pose, new Cartesian3()), expected);
  assert.ok(Cartesian3.equalsEpsilon(Matrix4.multiplyByPointAsVector(pose, Cartesian3.UNIT_X, new Cartesian3()),
    Matrix4.multiplyByPointAsVector(frame, Cartesian3.UNIT_Y, new Cartesian3()), 1e-11));
  assert.deepEqual(source.modelMatrix, original);
  assert.deepEqual(Matrix4.getTranslation(structureProjectionFrame({ kind: 'wgs84', longitude: 120, latitude: 30, height: 25 }, source),
    new Cartesian3()), origin);
  assert.throws(() => parseStructureConfig({ version: 1, title: 'A001', anchor: { kind: 'wgs84', longitude: 181, latitude: 30, height: 10 } }), /锚点/);
  assert.throws(() => parseStructureConfig({ version: 1, title: 'A001', anchor: { kind: 'model-local', position: [1, Infinity, 0] } }), /锚点/);
});

function glb(gltf: Record<string, unknown>): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...gltf }));
  const size = Math.ceil(json.byteLength / 4) * 4;
  const buffer = new ArrayBuffer(20 + size);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, size, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).fill(0x20);
  new Uint8Array(buffer, 20).set(json);
  return buffer;
}

test('hologram only accepts valid GLB 2 data with embedded asset dependencies', () => {
  assert.doesNotThrow(() => validateStructureGlb(glb({ images: [{ bufferView: 0 }] })));
  assert.throws(() => validateStructureGlb(new ArrayBuffer(15)), /GLB/);
  assert.throws(() => validateStructureGlb(glb({ images: [{ uri: '/__unrelated/image.png' }] })), /嵌入/);
  assert.throws(() => validateStructureGlb(glb({ buffers: [{ uri: 'mesh.bin' }] })), /嵌入/);
  assert.throws(() => validateStructureGlb(glb({ extensions: { EXT_structural_metadata: { schemaUri: 'schema.json' } } })), /嵌入/);
});
