import assert from 'node:assert/strict';
import test from 'node:test';
import { Cartesian3, Cartographic, Ellipsoid, EllipsoidTerrainProvider, LabelCollection, PrimitiveCollection, type Viewer } from 'cesium';
import { createCadSurfaceSampler } from './videoOverlayDrapedCad.ts';
import { loadCadPrimitiveCollection } from './cadPrimitiveLoader.ts';
import type { CadImportPackage } from './cadImport.ts';
import type { ImportRecord } from './types.ts';

function fixture(sample?: (points: Cartesian3[]) => Promise<Array<Cartesian3 | undefined>>) {
  const model = { show: true, isDestroyed: () => false };
  const cad = { show: true, isDestroyed: () => false };
  const globe = { show: true };
  const primitives = new PrimitiveCollection({ destroyPrimitives: false });
  primitives.add(model); primitives.add(cad);
  const records: ImportRecord[] = [
    { id: 'model', name: 'model', kind: 'Model', visible: true, resource: model },
    { id: 'cad', name: 'cad', kind: 'CAD', visible: true, resource: cad },
  ];
  const viewer = {
    terrainProvider: new EllipsoidTerrainProvider(),
    scene: { primitives, globe, ellipsoid: Ellipsoid.WGS84, clampToHeightSupported: true, requestRender() {},
      clampToHeightMostDetailed: sample ?? (async (points: Cartesian3[]) => {
        assert.equal(globe.show, false); assert.equal(cad.show, false); assert.equal(model.show, true);
        return points.map(point => { const value = Cartographic.fromCartesian(point); value.height = 100; return Cartographic.toCartesian(value); });
      }),
    },
  } as unknown as Viewer;
  return { viewer, records, model, cad, globe };
}
const source: CadImportPackage = {
  format: 'cesium-cad-import', version: 2,
  source: { name: 'sloping-source.dwg', format: 'DWG', generatedAt: '2026-10-22T00:00:00Z' },
  statistics: { sourceEntities: 2, displayEntities: 2, skippedEntities: 0, unknownEntities: 0, layers: ['axis'] }, warnings: [],
  entities: [
    { type: 'POLYLINE', sourceType: 'LINE', layer: 'axis', vertices: [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 20 }] },
    { type: 'POLYLINE', sourceType: 'LINE', layer: 'axis', vertices: [{ x: 0, y: 10, z: 40 }, { x: 100, y: 10, z: 10 }] },
  ],
};
const coordinates = { mode: 'local' as const, longitude: 120, latitude: 30, altitude: 0, referenceX: 0, referenceY: 0, rotation: 0, scale: 1 };

for (const mode of ['terrain', 'model'] as const) test(`${mode} draped CAD freezes sampled heights instead of restoring the sloping source Z`, async () => {
  const f = fixture(), original = JSON.stringify(source);
  const result = await loadCadPrimitiveCollection(source, coordinates, {
    displayMode: 'absolute', surfaceSampleSpacing: 5,
    transformPositions: createCadSurfaceSampler(f.viewer, mode, f.records),
  });
  try {
    for (const feature of result.cadPolylineFeatures) {
      assert.ok(feature.positions.length > 20, 'sparse source lines must sample their surface path');
      for (const point of feature.positions) assert.ok(Math.abs(Cartographic.fromCartesian(point).height - (mode === 'model' ? 100 : 0)) < 1e-6);
      for (let index = 1; index < feature.positions.length; index++) assert.ok(Cartesian3.distance(feature.positions[index - 1], feature.positions[index]) < 5.001);
    }
    assert.equal(JSON.stringify(source), original);
    assert.equal(f.cad.show, true); assert.equal(f.globe.show, true); assert.equal(f.model.show, true);
  } finally { result.collection.destroy(); }
});

test('model sampling handles every point beyond 2000 and retains original input positions', async () => {
  const sizes: number[] = [];
  const f = fixture(async points => { sizes.push(points.length); return points.map(point => Cartesian3.clone(point)); });
  const points = Array.from({ length: 2203 }, (_, index) => Cartesian3.fromDegrees(120 + index * 1e-5, 30, 20));
  const before = JSON.stringify(points);
  const result = await createCadSurfaceSampler(f.viewer, 'model', f.records)(points);
  assert.equal(result.length, 2203); assert.equal(sizes.length, 12); assert.equal(sizes.at(-1), 3);
  assert.equal(JSON.stringify(points), before); assert.notEqual(result[0], points[0]);
});

test('missing model hits fail explicitly and restore CAD, model and globe visibility', async () => {
  const f = fixture(async points => points.map((point, index) => index ? point : undefined));
  await assert.rejects(createCadSurfaceSampler(f.viewer, 'model', f.records)([
    Cartesian3.fromDegrees(120, 30, 10), Cartesian3.fromDegrees(120.01, 30, 20),
  ]), /没有可用模型表面高程/);
  assert.equal(f.cad.show, true); assert.equal(f.globe.show, true); assert.equal(f.model.show, true);
});

test('model sampling cancellation restores the map and rejects the whole copy', async () => {
  const controller = new AbortController();
  const f = fixture(async points => { controller.abort(); return points; });
  await assert.rejects(createCadSurfaceSampler(f.viewer, 'model', f.records, controller.signal)([Cartesian3.fromDegrees(120, 30)]), { name: 'AbortError' });
  assert.equal(f.cad.show, true); assert.equal(f.globe.show, true); assert.equal(f.model.show, true);
});

test('cancelling a pending GPU query releases visibility immediately and ignores its late result', async () => {
  const controller = new AbortController();
  let finish!: (positions: Cartesian3[]) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const points = [Cartesian3.fromDegrees(120, 30, 25)], before = JSON.stringify(points);
  const pending = createCadSurfaceSampler(f.viewer, 'model', f.records, controller.signal)(points);
  assert.equal(f.globe.show, false); assert.equal(f.cad.show, false);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.globe.show, true); assert.equal(f.cad.show, true);
  // The user can change the map immediately after exit; a late pick must not
  // reapply the old visibility or sampled geometry over that next operation.
  f.globe.show = false;
  finish([Cartesian3.fromDegrees(120, 30, 100)]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.globe.show, false); assert.equal(f.cad.show, true);
  assert.equal(JSON.stringify(points), before);
});

test('unsupported model sampling never falls back to CAD source elevations', async () => {
  const f = fixture();
  Object.defineProperty(f.viewer.scene, 'clampToHeightSupported', { value: false });
  await assert.rejects(createCadSurfaceSampler(f.viewer, 'model', f.records)([Cartesian3.fromDegrees(120, 30)]), /不支持/);
});

test('model-mode classification samples 3D Tiles rather than an overlapping ordinary model', async () => {
  const f = fixture(async points => {
    assert.equal(f.model.show, false);
    assert.equal(tiles.show, true);
    return points;
  });
  const tiles = { show: true, isDestroyed: () => false };
  f.viewer.scene.primitives.add(tiles);
  f.records.push({ id: 'tiles', name: 'tiles', kind: '3D Tiles', visible: true, resource: tiles });
  await createCadSurfaceSampler(f.viewer, 'model', f.records)([Cartesian3.fromDegrees(120, 30)]);
  assert.equal(f.model.show, true); assert.equal(tiles.show, true);
});

test('terrain lacking coverage cannot silently reinstate source heights', async () => {
  const f = fixture();
  Object.defineProperty(f.viewer, 'terrainProvider', { value: {} });
  await assert.rejects(createCadSurfaceSampler(f.viewer, 'terrain', f.records)([Cartesian3.fromDegrees(120, 30, 20)]), /不提供高程采样覆盖信息/);
});

test('face boundaries and text anchors use the same frozen model heights as lines', async () => {
  const f = fixture();
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (key: string) => ({ 'font-family': 'sans-serif', 'font-size': '13px', 'font-style': 'normal', 'font-weight': 'normal', 'line-height': 'normal' }[key] ?? '') }) },
  } });
  const drawing: CadImportPackage = { ...source, entities: [
    { type: '3DFACE', sourceType: '3DFACE', layer: 'axis', vertices: [{ x: 0, y: 0, z: 10 }, { x: 20, y: 0, z: 30 }, { x: 20, y: 20, z: 50 }] },
    { type: 'TEXT', sourceType: 'TEXT', layer: 'axis', text: 'station', vertices: [{ x: 10, y: 10, z: 70 }] },
  ] };
  const result = await loadCadPrimitiveCollection(drawing, coordinates, {
    surfaceSampleSpacing: 5, transformPositions: createCadSurfaceSampler(f.viewer, 'model', f.records),
  });
  try {
    for (const feature of result.cadPolylineFeatures) for (const point of feature.positions) {
      assert.ok(Math.abs(Cartographic.fromCartesian(point).height - 100) < 1e-6);
    }
    const labels = Array.from({ length: result.collection.length }, (_, index) => result.collection.get(index)).find(item => item instanceof LabelCollection) as LabelCollection;
    assert.equal(labels.length, 1);
    assert.ok(Math.abs(Cartographic.fromCartesian(labels.get(0).position).height - 100) < 1e-6);
  } finally {
    result.collection.destroy();
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('transform validation rejects dropped or nonfinite vertices before drawing', async () => {
  for (const transformPositions of [async () => [], async (positions: Cartesian3[]) => positions.map(() => new Cartesian3(Number.NaN, 0, 0))]) {
    await assert.rejects(loadCadPrimitiveCollection(source, coordinates, { transformPositions }), /采样不完整/);
  }
});

test('loader batches surface sampling across entities rather than querying every line', async () => {
  const drawing = { ...source, entities: Array.from({ length: 205 }, () => source.entities[0]) };
  const calls: number[] = [];
  const result = await loadCadPrimitiveCollection(drawing, coordinates, {
    batchSize: 100, transformPositions: async positions => { calls.push(positions.length); return positions; },
  });
  try { assert.deepEqual(calls, [200, 200, 10]); } finally { result.collection.destroy(); }
});
