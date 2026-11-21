import test from 'node:test';
import assert from 'node:assert/strict';
import { Cesium3DTileset, Event, type Viewer } from 'cesium';
import { TemporaryWorksClippingManager, buildTemporaryWorksClipPolygons, type TemporaryWorksFootprint } from './temporaryWorksClipping.ts';

const triangle = (size = 1e-8): TemporaryWorksFootprint[] => [{ outer: [
  { longitude: 121, latitude: 31 }, { longitude: 121 + size, latitude: 31 }, { longitude: 121, latitude: 31 + size },
] }];
function fixture() {
  const viewer = { scene: { context: { webgl2: true }, postUpdate: new Event(), requestRender() {} }, isDestroyed: () => false } as unknown as Viewer;
  const manager = new TemporaryWorksClippingManager(viewer), tileset = new Cesium3DTileset({});
  const legacyScope = manager.createScope('existing-surface');
  const engineering = manager.createScope('engineering', { minimumAreaSquareMeters: 0 });
  return { manager, tileset, legacyScope, engineering, close() { engineering.dispose(); legacyScope.dispose(); manager.dispose(); tileset.destroy(); } };
}

test('legacy inputs and existing scopes retain their historical area rejection while engineering keeps nonzero thin source faces', () => {
  const f = fixture();
  try {
    f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: triangle(.001) });
    const existing = f.tileset.clippingPolygons;
    assert.throws(() => buildTemporaryWorksClipPolygons(triangle()), /面积过小/);
    assert.throws(() => f.manager.upsert({ id: 'thin-legacy', tileset: f.tileset, footprints: triangle() }), /面积过小/);
    assert.throws(() => f.legacyScope.upsert({ id: 'thin-surface', tileset: f.tileset, footprints: triangle() }), /面积过小/);
    assert.equal(f.tileset.clippingPolygons, existing); assert.equal(existing.isDestroyed(), false);
    f.engineering.upsert({ id: 'thin-engineering', tileset: f.tileset, footprints: triangle() });
    assert.equal(f.tileset.clippingPolygons.length, 2); assert.equal(f.engineering.getStatus('thin-engineering')?.state, 'active');
    f.engineering.dispose(); assert.equal(f.tileset.clippingPolygons.length, 1); assert.equal(f.manager.getStatus('camp')?.state, 'active');
  } finally { f.close(); }
});

test('zero area, crossing boundaries, invalid coordinates and duplicate vertices remain rejected at zero minimum', () => {
  const f = fixture(), good = triangle();
  try {
    f.engineering.upsert({ id: 'thin', tileset: f.tileset, footprints: good }); const collection = f.tileset.clippingPolygons;
    const invalid: TemporaryWorksFootprint[][] = [
      [{ outer: [{ longitude: 121, latitude: 31 }, { longitude: 121.001, latitude: 31 }, { longitude: 121.002, latitude: 31 }] }],
      [{ outer: [[0, 0], [3, 3], [0, 2], [2, 0]].map(([x, y]) => ({ longitude: 121 + x * .001, latitude: 31 + y * .001 })) }],
      [{ outer: good[0].outer.map((p, i) => i === 0 ? { ...p, longitude: NaN } : p) }],
      [{ outer: good[0].outer.map((p, i) => i === 0 ? { ...p, latitude: 91 } : p) }],
      [{ outer: [good[0].outer[0], good[0].outer[1], good[0].outer[0], good[0].outer[2]] }],
    ];
    for (const footprints of invalid) {
      assert.throws(() => f.engineering.upsert({ id: 'thin', tileset: f.tileset, footprints }), /退化|自相交|无效|重复/);
      assert.equal(f.tileset.clippingPolygons, collection); assert.equal(f.engineering.getStatus('thin')?.state, 'active');
    }
  } finally { f.close(); }
});

test('scope area policy is validated and immutable without changing later default callers', () => {
  const f = fixture();
  try {
    for (const minimumAreaSquareMeters of [-1, NaN, Infinity]) {
      assert.throws(() => f.manager.createScope('invalid', { minimumAreaSquareMeters }), /有限的非负数/);
      assert.throws(() => buildTemporaryWorksClipPolygons(triangle(.001), undefined, { minimumAreaSquareMeters }), /有限的非负数/);
    }
    const options = { minimumAreaSquareMeters: 0 }, scope = f.manager.createScope('immutable', options);
    try {
      options.minimumAreaSquareMeters = 10;
      scope.upsert({ id: 'thin', tileset: f.tileset, footprints: triangle() });
      assert.equal(scope.getStatus('thin')?.state, 'active');
      assert.throws(() => buildTemporaryWorksClipPolygons(triangle()), /面积过小/);
    } finally { scope.dispose(); }
  } finally { f.close(); }
});

test('nonzero small engineering holes retain their void instead of being discarded by a minimum-area shortcut', () => {
  const footprint: TemporaryWorksFootprint[] = [{ outer: [
    { longitude: 121, latitude: 31 }, { longitude: 121.001, latitude: 31 },
    { longitude: 121.001, latitude: 31.001 }, { longitude: 121, latitude: 31.001 },
  ], holes: [[
    { longitude: 121.0005, latitude: 31.0005 }, { longitude: 121.00050001, latitude: 31.0005 }, { longitude: 121.0005, latitude: 31.00050001 },
  ]] }];
  assert.throws(() => buildTemporaryWorksClipPolygons(footprint), /面积过小/);
  const polygons = buildTemporaryWorksClipPolygons(footprint, undefined, { minimumAreaSquareMeters: 0 });
  assert.equal(polygons.length, 7);
  assert.ok(polygons.every(polygon => polygon.length === 3));
});
