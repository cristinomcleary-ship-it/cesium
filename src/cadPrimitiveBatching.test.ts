import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import * as Cesium from 'cesium';
import { BoundingSphere, Color, GeometryInstance, GroundPrimitive, GroundPolylinePrimitive, Primitive,
  LabelCollection, type Scene } from 'cesium';
import type { CadImportEntity, CadImportPackage } from './cadImport.ts';
import { loadCadPrimitiveCollection } from './cadPrimitiveLoader.ts';
import type { CadCoordinateOptions } from './types.ts';

// GroundPolylinePrimitive validates the context's line-width range during
// construction. Supply that capability only; these tests do not rasterize.
const limits = (Cesium as unknown as { ContextLimits: { _maximumAliasedLineWidth: number } }).ContextLimits;
const previousLineWidth = limits._maximumAliasedLineWidth;
before(() => { limits._maximumAliasedLineWidth = 1; });
after(() => { limits._maximumAliasedLineWidth = previousLineWidth; });

const coordinates: CadCoordinateOptions = { mode: 'local', longitude: 120, latitude: 30, altitude: 20,
  referenceX: 0, referenceY: 0, rotation: 0, scale: 1 };
const drawing = (entities: CadImportEntity[]): CadImportPackage => ({
  format: 'cesium-cad-import', version: 2, source: { name: 'synthetic.dwg', format: 'DWG', generatedAt: '' },
  statistics: { sourceEntities: entities.length, displayEntities: entities.length, skippedEntities: 0, unknownEntities: 0, layers: ['0'] },
  entities, warnings: [],
});
const instances = (primitive: Primitive | GroundPrimitive | GroundPolylinePrimitive): GeometryInstance[] => {
  const value = primitive.geometryInstances;
  return Array.isArray(value) ? value : [value];
};

for (const displayMode of ['absolute', 'terrain'] as const) test(`${displayMode} lines keep vertices, IDs, colors and widths in local batches`, async () => {
  const entities: CadImportEntity[] = Array.from({ length: 120 }, (_, index) => {
    const x = index % 2 ? 50_000 : 0;
    return { type: 'POLYLINE', sourceType: 'LWPOLYLINE', layer: '0', closed: true,
      color: index % 3 ? '#00FF00' : '#FF0000', lineweightMm: .8,
      vertices: [{ x, y: 1 }, { x: x + 5, y: 1 }, { x: x + 5, y: 6 }] };
  });
  // This long entity spans many cells and must stay one complete feature.
  entities.push({ type: 'POLYLINE', sourceType: 'LINE', layer: '0', color: '#0000FF',
    vertices: [{ x: -1000, y: 0 }, { x: 1000, y: 0 }] });
  const source = drawing(entities), before = JSON.stringify(source);
  const result = await loadCadPrimitiveCollection(source, coordinates, { displayMode, scene: {} as Scene,
    primitiveBatchSize: 50, batchSize: 1000 });
  try {
    const ids: number[] = [];
    assert.ok(result.collection.length <= 7, 'near/far cells batch short lines together');
    for (let i = 0; i < result.collection.length; i++) {
      const primitive = result.collection.get(i) as Primitive | GroundPolylinePrimitive;
      assert.ok(displayMode === 'absolute' ? primitive instanceof Primitive : primitive instanceof GroundPolylinePrimitive);
      const group = instances(primitive);
      assert.ok(group.length <= 50);
      const sites = new Set<number>();
      for (const instance of group) {
        const index = instance.id.entityIndex as number, entity = entities[index]; ids.push(index);
        const positions = (instance.geometry as unknown as { _positions: typeof result.cadPolylineFeatures[number]['positions'] })._positions;
        assert.deepEqual(positions, result.cadPolylineFeatures[index].positions);
        assert.equal(instance.id, result.cadPolylineFeatures[index].entity);
        assert.deepEqual(Array.from(instance.attributes.color.value), Color.fromCssColorString(entity.color!)!.toBytes());
        const geometry = instance.geometry as unknown as { _width?: number; width?: number };
        assert.equal(geometry._width ?? geometry.width, index === 120 ? 1.5 : 4);
        if (index < 120) sites.add(index % 2);
      }
      assert.ok(sites.size <= 1, 'distant entities must not inflate a local batch');
      if (!group.some(instance => instance.id.entityIndex === 120)) {
        const points = group.flatMap(instance => result.cadPolylineFeatures[instance.id.entityIndex].positions);
        assert.ok(BoundingSphere.fromPoints(points).radius < 10);
      }
    }
    assert.deepEqual(ids.sort((a, b) => a - b), entities.map((_, index) => index));
    assert.equal(result.cadPolylineFeatures[120].positions.length, 2);
    assert.equal(JSON.stringify(source), before);
  } finally { result.collection.destroy(); }
});

test('ground face batches respect both local cells and uniform classification color', async () => {
  const entities: CadImportEntity[] = Array.from({ length: 120 }, (_, index) => {
    const x = index % 2 ? 50_000 : 0;
    return { type: '3DFACE', sourceType: 'SOLID', layer: '0', color: index % 3 ? '#00FF00' : '#FF0000',
      vertices: [{ x, y: 1 }, { x: x + 5, y: 1 }, { x: x + 5, y: 6 }, { x, y: 6 }] };
  });
  const result = await loadCadPrimitiveCollection(drawing(entities), coordinates, { displayMode: 'terrain',
    scene: {} as Scene, primitiveBatchSize: 50, batchSize: 1000 });
  try {
    const ids: number[] = [];
    assert.equal(result.collection.length, 4);
    for (let i = 0; i < result.collection.length; i++) {
      const primitive = result.collection.get(i) as GroundPrimitive;
      assert.ok(primitive instanceof GroundPrimitive);
      const group = instances(primitive);
      assert.ok(group.length <= 50);
      assert.equal(new Set(group.map(instance => Array.from(instance.attributes.color.value).join(','))).size, 1);
      assert.equal(new Set(group.map(instance => instance.id.entityIndex % 2)).size, 1);
      ids.push(...group.map(instance => instance.id.entityIndex));
    }
    assert.deepEqual(ids.sort((a, b) => a - b), entities.map((_, index) => index));
    assert.equal(result.collection.cadFacePositions.length, entities.length);
  } finally { result.collection.destroy(); }
});

test('text-only drawings retain one label collection across many world cells', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (key: string) => ({
      'font-family': 'sans-serif', 'font-size': '13px', 'font-style': 'normal', 'font-weight': 'normal', 'line-height': 'normal',
    }[key] ?? '') }) },
  } });
  try {
    const entities: CadImportEntity[] = Array.from({ length: 1000 }, (_, index) => ({ type: 'TEXT', sourceType: 'TEXT',
      layer: '0', text: `station ${index}`, vertices: [{ x: (index - 500) * 1000, y: 0 }] }));
    const result = await loadCadPrimitiveCollection(drawing(entities), coordinates, { batchSize: 2000 });
    try {
      assert.equal(result.collection.length, 1);
      const labels = result.collection.get(0) as LabelCollection;
      assert.ok(labels instanceof LabelCollection);
      assert.equal(labels.length, entities.length);
      for (let index = 0; index < entities.length; index++) {
        assert.equal(labels.get(index).id.entityIndex, index);
        assert.equal(labels.get(index).text, entities[index].text);
      }
    } finally { result.collection.destroy(); }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
