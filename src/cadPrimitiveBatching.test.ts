import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as Cesium from 'cesium';
import { BoundingSphere, Color, GeometryInstance, GroundPrimitive, GroundPolylinePrimitive, Primitive,
  GroundPolylineGeometry, PolylineGeometry, PrimitiveCollection, LabelCollection, type Scene } from 'cesium';
import type { CadImportEntity, CadImportPackage } from './cadImport.ts';
import { CAD_PRIMITIVE_VERTEX_BUDGET, loadCadPrimitiveCollection } from './cadPrimitiveLoader.ts';
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

for (const displayMode of ['absolute', 'terrain'] as const) test(`${displayMode} long lines preserve every source segment and keep real Cesium worker packs below 4 MiB`, async () => {
  const budget = displayMode === 'absolute' ? CAD_PRIMITIVE_VERTEX_BUDGET.absolute : CAD_PRIMITIVE_VERTEX_BUDGET.ground;
  const long: CadImportEntity = { type: 'POLYLINE', sourceType: 'LWPOLYLINE', layer: 'dense', closed: true,
    color: '#52AACC', lineweightMm: .6,
    vertices: Array.from({ length: budget * 2 + 37 }, (_, index) => ({ x: index * .01, y: (index % 3) * .01, z: 3 })),
  };
  const small = Array.from({ length: 25 }, (_, index): CadImportEntity => ({ type: 'POLYLINE', sourceType: 'LINE', layer: 'dense',
    color: '#52AACC', vertices: [{ x: index, y: 5 }, { x: index + .1, y: 5 }] }));
  const source = drawing([long, ...small]), unchanged = JSON.stringify(source);
  const result = await loadCadPrimitiveCollection(source, coordinates, { displayMode, scene: {} as Scene, primitiveBatchSize: 1000 });
  const terrain = (Cesium as unknown as { ApproximateTerrainHeights: { _terrainHeights: Record<string, number[]> | undefined } }).ApproximateTerrainHeights;
  const previousTerrain = terrain._terrainHeights;
  terrain._terrainHeights ??= {}; // Deterministic fallback heights; no external terrain request.
  try {
    const requireFromCesium = createRequire(import.meta.resolve('cesium'));
    const engine = pathToFileURL(requireFromCesium.resolve('@cesium/engine'));
    const { default: pipeline } = await import(new URL('./Source/Scene/PrimitivePipeline.js', engine).href);
    const full = result.cadPolylineFeatures[0].positions;
    assert.equal(full.length, long.vertices.length + 1);
    assert.equal(result.featureCount, source.entities.length); assert.equal(result.skippedCount, 0);
    assert.equal(result.cadPolylineFeatures[0].entity.id, 'cad-0');
    const pointIndex = new Map(full.map((position, index) => [position, index]));
    const coveredSegments = new Set<number>(), renderIds = new Set<string>();
    const fragments: Array<{ part: number; positions: typeof full }> = [];
    for (let index = 0; index < result.collection.length; index++) {
      const group = instances(result.collection.get(index));
      const description = (instance: GeometryInstance) => (instance.geometry as unknown as { _positions: typeof full })._positions;
      assert.ok(group.reduce((total, instance) => total + description(instance).length, 0) <= budget);
      for (const instance of group) {
        assert.ok(!renderIds.has(instance.id.id), 'Cesium render IDs are unique even when one feature is split');
        renderIds.add(instance.id.id);
        if (instance.id.entityIndex !== 0) continue;
        assert.equal(instance.id.featureId, 'cad-0');
        assert.deepEqual(Array.from(instance.attributes.color.value), Color.fromCssColorString(long.color!)!.toBytes());
        const positions = description(instance), geometry = instance.geometry as unknown as { _width?: number; width?: number };
        assert.equal(geometry._width ?? geometry.width, 3);
        fragments.push({ part: instance.id.renderPart, positions });
        for (let point = 1; point < positions.length; point++) {
          const a = pointIndex.get(positions[point - 1])!, b = pointIndex.get(positions[point])!;
          assert.equal(b, a + 1, 'rendering never invents a shortcut or changes the source path');
          coveredSegments.add(a);
        }
      }
      const geometries = group.map(instance => displayMode === 'absolute'
        ? PolylineGeometry.createGeometry(instance.geometry as unknown as PolylineGeometry)
        : (GroundPolylineGeometry as unknown as { createGeometry(value: GroundPolylineGeometry): Cesium.Geometry | undefined }).createGeometry(instance.geometry as unknown as GroundPolylineGeometry));
      const packed = pipeline.packCreateGeometryResults(geometries, []);
      assert.ok(packed.packedData.byteLength < 4 * 1024 * 1024, `actual createGeometry worker result is ${packed.packedData.byteLength} bytes`);
    }
    assert.ok(fragments.length >= 3);
    fragments.sort((a, b) => a.part - b.part);
    for (let index = 1; index < fragments.length; index++) assert.deepEqual(fragments[index].positions.slice(0, 3), fragments[index - 1].positions.slice(-3), 'adjacent rendering pieces retain both neighbours at the shared join');
    assert.equal(coveredSegments.size, full.length - 1, 'all original segments, including the closing edge, remain present');
    assert.equal(JSON.stringify(source), unchanged);
  } finally { terrain._terrainHeights = previousTerrain; result.collection.destroy(); }
});

test('surface sampling groups by total point count and keeps an oversized single line separate', async () => {
  const counts = [3000, 3000, 3000, 9000, 3000];
  const entities: CadImportEntity[] = [{ type: 'POINT', sourceType: 'POINT', layer: '0', vertices: [{ x: 0, y: 0 }] },
    ...counts.map((count, line): CadImportEntity => ({ type: 'POLYLINE', sourceType: 'LWPOLYLINE', layer: `line-${line}`,
      vertices: Array.from({ length: count }, (_, index) => ({ x: index * .01, y: line * 10, z: line })) })),
  ];
  const source = drawing(entities), unchanged = JSON.stringify(source), calls: number[] = [];
  const baseline = await loadCadPrimitiveCollection(source, coordinates);
  const sampled = await loadCadPrimitiveCollection(source, coordinates, { batchSize: 2000,
    transformPositions: async positions => { calls.push(positions.length); return positions.map(point => new Cesium.Cartesian3(point.x, point.y, point.z + 123)); },
  });
  try {
    assert.deepEqual(calls, [6000, 3000, 9000, 3000]);
    assert.equal(sampled.cadPolylineFeatures.length, counts.length);
    for (let line = 0; line < counts.length; line++) {
      const feature = sampled.cadPolylineFeatures[line];
      assert.equal(feature.entity.entityIndex, line + 1); assert.equal(feature.positions.length, counts[line]);
      for (let point = 0; point < counts[line]; point++) {
        const before = baseline.cadPolylineFeatures[line].positions[point], after = feature.positions[point];
        assert.equal(after.x, before.x); assert.equal(after.y, before.y); assert.equal(after.z, before.z + 123);
      }
    }
    assert.equal(JSON.stringify(source), unchanged);
  } finally { baseline.collection.destroy(); sampled.collection.destroy(); }
});

for (const displayMode of ['absolute', 'terrain'] as const) test(`${displayMode} oversized faces remain complete and isolated from neighboring faces`, async () => {
  const budget = displayMode === 'absolute' ? CAD_PRIMITIVE_VERTEX_BUDGET.absolute : CAD_PRIMITIVE_VERTEX_BUDGET.ground;
  const face: CadImportEntity = { type: '3DFACE', sourceType: 'SOLID', layer: '0', color: '#10A0CC',
    vertices: Array.from({ length: budget + 1 }, (_, index) => ({ x: Math.cos(index / (budget + 1) * Math.PI * 2), y: Math.sin(index / (budget + 1) * Math.PI * 2) })) };
  const small: CadImportEntity = { ...face, vertices: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }] };
  const source = drawing([small, face, small]), unchanged = JSON.stringify(source);
  const result = await loadCadPrimitiveCollection(source, coordinates, { displayMode, scene: {} as Scene });
  try {
    const ids: number[] = [];
    for (let index = 0; index < result.collection.length; index++) {
      const group = instances(result.collection.get(index));
      if (group.some(instance => instance.id.entityIndex === 1)) assert.equal(group.length, 1, 'the large polygon gets its own primitive');
      for (const instance of group) {
        ids.push(instance.id.entityIndex);
        const positions = (instance.geometry as unknown as { _polygonHierarchy: { positions: Cesium.Cartesian3[] } })._polygonHierarchy.positions;
        assert.equal(positions, result.collection.cadFacePositions[instance.id.entityIndex]);
        assert.equal(positions.length, source.entities[instance.id.entityIndex].vertices.length);
        assert.deepEqual(Array.from(instance.attributes.color.value), Color.fromCssColorString(face.color!)!.withAlpha(.18).toBytes());
      }
    }
    assert.deepEqual(ids.sort((a, b) => a - b), [0, 1, 2]);
    assert.equal(result.featureCount, 3); assert.equal(result.skippedCount, 0);
    assert.equal(JSON.stringify(source), unchanged);
  } finally { result.collection.destroy(); }
});

test('surface sampling preserves an oversized densified face boundary and its outline', async () => {
  const source = drawing([{ type: '3DFACE', sourceType: '3DFACE', layer: '0',
    vertices: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 0, y: 3000 }] }]);
  const unchanged = JSON.stringify(source);
  let sampled: Cesium.Cartesian3[] = [];
  const result = await loadCadPrimitiveCollection(source, coordinates, { surfaceSampleSpacing: 1,
    transformPositions: async positions => { sampled = positions.map(point => new Cesium.Cartesian3(point.x, point.y, point.z + 42)); return sampled; } });
  try {
    const full = result.collection.cadFacePositions[0];
    assert.ok(full.length > CAD_PRIMITIVE_VERTEX_BUDGET.absolute);
    assert.deepEqual(full, sampled); assert.equal(result.featureCount, 1);
    const covered = new Set<Cesium.Cartesian3>(); let faces = 0;
    for (let index = 0; index < result.collection.length; index++) for (const instance of instances(result.collection.get(index))) {
      const geometry = instance.geometry as unknown as { _polygonHierarchy?: { positions: Cesium.Cartesian3[] }; _positions?: Cesium.Cartesian3[] };
      assert.equal(instance.id.entityIndex, 0);
      if (geometry._polygonHierarchy) { assert.equal(geometry._polygonHierarchy.positions, full); faces++; }
      else geometry._positions!.forEach(point => covered.add(point));
    }
    assert.equal(faces, 1); assert.ok(full.every(point => covered.has(point)));
    assert.equal(JSON.stringify(source), unchanged);
  } finally { result.collection.destroy(); }
});

test('cancellation and incomplete surface samples detach collections and retain other scene resources', async () => {
  for (const mode of ['cancel', 'sample'] as const) {
    const root = new PrimitiveCollection(), existing = root.add(new PrimitiveCollection());
    const controller = new AbortController(); let incomplete: PrimitiveCollection | undefined;
    const source = drawing(mode === 'cancel' ? Array.from({ length: 101 }, (): CadImportEntity => ({ type: 'POINT', sourceType: 'POINT', layer: '0', vertices: [{ x: 0, y: 0 }] }))
      : [{ type: '3DFACE', sourceType: '3DFACE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }] }]);
    try {
      await assert.rejects(loadCadPrimitiveCollection(source, coordinates, { scene: { primitives: root } as Scene,
        signal: controller.signal, batchSize: 100,
        beforePopulate: collection => { incomplete = collection; root.add(collection); },
        ...(mode === 'cancel' ? { onProgress: () => controller.abort() }
          : { surfaceSampleSpacing: 1, transformPositions: async (positions: Cesium.Cartesian3[]) => positions.slice(1) }),
      }), mode === 'cancel' ? /取消/ : /采样不完整/);
      assert.equal(incomplete?.isDestroyed(), true); assert.equal(root.length, 1);
      assert.equal(root.get(0), existing); assert.equal(existing.isDestroyed(), false);
    } finally { root.destroy(); }
  }
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
