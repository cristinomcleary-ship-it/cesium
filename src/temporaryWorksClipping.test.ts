import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Cartesian3, Cartographic, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection,
  ClippingPolygonCollection, Event, Matrix4, type Viewer,
} from 'cesium';
import { TemporaryWorksClippingManager, buildTemporaryWorksClipPolygons, type TemporaryWorksFootprint } from './temporaryWorksClipping.ts';

const rect = (x = 121, y = 31, w = 0.001, h = 0.001) => [
  { longitude: x, latitude: y }, { longitude: x + w, latitude: y },
  { longitude: x + w, latitude: y + h }, { longitude: x, latitude: y + h },
];
const footprint = (x = 121): TemporaryWorksFootprint[] => [{ outer: rect(x) }];
function fixture(webgl2 = true) {
  const postUpdate = new Event();
  let renders = 0;
  const viewer = { scene: { context: { webgl2 }, postUpdate, requestRender() { renders++; } }, isDestroyed: () => false } as unknown as Viewer;
  const tileset = new Cesium3DTileset({}); // Actual Cesium ownership/destroy setters; only Viewer/WebGL is mocked.
  const manager = new TemporaryWorksClippingManager(viewer);
  return { tileset, manager, postUpdate, polygonCount: () => tileset.clippingPolygons?.length,
    renders: () => renders, close: () => { manager.dispose(); if (!tileset.isDestroyed()) tileset.destroy(); } };
}
function geographicArea(polygons: ReturnType<typeof buildTemporaryWorksClipPolygons>): number {
  return polygons.reduce((sum, polygon) => {
    const points = polygon.positions.map(p => Cartographic.fromCartesian(p));
    return sum + Math.abs(points.reduce((area, p, i) => {
      const q = points[(i + 1) % points.length];
      return area + (p.longitude - points[0].longitude) * (q.latitude - points[0].latitude)
        - (q.longitude - points[0].longitude) * (p.latitude - points[0].latitude);
    }, 0)) / 2;
  }, 0);
}

test('overlapping buildings use a union collection; removing one keeps all other building polygons', () => {
  const f = fixture();
  try {
    assert.equal(f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprint() }).state, 'active');
    const first = f.tileset.clippingPolygons;
    f.manager.upsert({ id: 'steel', tileset: f.tileset, footprints: footprint(121.0005) });
    assert.equal(first.isDestroyed(), true);
    assert.equal(f.tileset.clippingPolygons.length, 2);
    assert.equal(f.tileset.clippingPolygons.inverse, false);
    const steel = f.tileset.clippingPolygons.get(1);
    f.manager.remove('camp');
    assert.equal(f.tileset.clippingPolygons.length, 1);
    assert.equal(f.tileset.clippingPolygons.get(0), steel);
    assert.equal(f.manager.getStatus('camp'), undefined);
    assert.equal(f.manager.getStatus('steel')!.state, 'active');
    f.manager.remove('steel');
    assert.equal(f.tileset.clippingPolygons, undefined);
    assert.equal(f.postUpdate.numberOfListeners, 0);
    f.manager.upsert({ id: 'new', tileset: f.tileset, footprints: footprint() });
    assert.equal(f.postUpdate.numberOfListeners, 1);
    assert.equal(f.polygonCount(), 1);
  } finally { f.close(); }
});

test('hide/show and global disable restore only their own photography regions', () => {
  const f = fixture();
  try {
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() });
    f.manager.upsert({ id: 'B', tileset: f.tileset, footprints: footprint(121.002) });
    assert.equal(f.manager.setVisible('A', false)!.state, 'hidden');
    assert.equal(f.tileset.clippingPolygons.length, 1);
    f.manager.setVisible('B', false);
    assert.equal(f.tileset.clippingPolygons, undefined);
    f.manager.setVisible('A', true);
    assert.equal(f.polygonCount(), 1);
    f.manager.setEnabled(false);
    assert.equal(f.tileset.clippingPolygons, undefined);
    assert.equal(f.manager.getStatus('A')!.state, 'disabled');
    f.manager.setEnabled(true);
    assert.equal(f.polygonCount(), 1);
    f.manager.setVisible('B', true);
    assert.equal(f.polygonCount(), 2);
    f.manager.setPlanEnabled('A', false);
    assert.equal(f.polygonCount(), 1);
  } finally { f.close(); }
});

test('foreign polygon clipping is never overwritten, disabled, or destroyed; available target can recover', () => {
  const f = fixture();
  const foreign = new ClippingPolygonCollection({ polygons: buildTemporaryWorksClipPolygons(footprint()), inverse: true });
  try {
    f.tileset.clippingPolygons = foreign;
    assert.equal(f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }).state, 'blocked');
    f.manager.setVisible('A', false); f.manager.setVisible('A', true);
    assert.equal(f.tileset.clippingPolygons, foreign);
    assert.equal(foreign.enabled, true); assert.equal(foreign.inverse, true); assert.equal(foreign.isDestroyed(), false);
    (f.tileset as unknown as { clippingPolygons: unknown }).clippingPolygons = undefined;
    f.postUpdate.raiseEvent();
    assert.equal(f.manager.getStatus('A')!.state, 'active');
    assert.notEqual(f.tileset.clippingPolygons, foreign);
  } finally { f.close(); }
});

test('foreign clipping planes are preserved, including when added after temporary clipping', () => {
  const f = fixture();
  const planes = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 0)] });
  try {
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() });
    const owned = f.tileset.clippingPolygons;
    f.tileset.clippingPlanes = planes;
    f.postUpdate.raiseEvent();
    assert.equal(f.manager.getStatus('A')!.state, 'blocked');
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(owned.isDestroyed(), true);
    f.manager.clear(); assert.equal(f.tileset.clippingPlanes, planes); assert.equal(planes.isDestroyed(), false);
  } finally { f.close(); }
});

test('foreign replacement destroys old owned collection through Cesium and remains intact on disposal', () => {
  const f = fixture();
  const foreign = new ClippingPolygonCollection({ polygons: buildTemporaryWorksClipPolygons(footprint(122)) });
  try {
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() });
    const owned = f.tileset.clippingPolygons;
    f.tileset.clippingPolygons = foreign;
    assert.equal(owned.isDestroyed(), true);
    f.postUpdate.raiseEvent();
    assert.equal(f.manager.getStatus('A')!.state, 'blocked');
    f.manager.dispose(); f.manager.dispose();
    assert.equal(f.tileset.clippingPolygons, foreign); assert.equal(foreign.isDestroyed(), false);
    assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('changing a plan target leaves other plans on original tileset; unrelated transforms/styles remain unchanged', () => {
  const f = fixture(), other = new Cesium3DTileset({});
  try {
    const matrix = Matrix4.fromTranslation(new Cartesian3(100, 200, 300)); f.tileset.modelMatrix = matrix;
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() });
    f.manager.upsert({ id: 'B', tileset: f.tileset, footprints: footprint(121.002) });
    f.manager.upsert({ id: 'A', tileset: other, footprints: footprint(122) });
    assert.equal(f.tileset.clippingPolygons.length, 1); assert.equal(other.clippingPolygons.length, 1);
    assert.ok(Matrix4.equals(f.tileset.modelMatrix, matrix)); assert.equal(f.tileset.show, true);
    assert.equal(f.tileset.customShader, undefined); assert.equal(f.tileset.style, undefined);
    f.manager.clear(); assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(other.clippingPolygons, undefined);
  } finally { f.close(); other.destroy(); }
});

test('world positions are ECEF geography, independent of translated tileset local coordinates and height', () => {
  const f = fixture();
  try {
    f.tileset.modelMatrix = Matrix4.fromTranslation(new Cartesian3(1000000, 500000, 20000));
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() });
    const position = f.tileset.clippingPolygons.get(0).positions[0];
    assert.ok(Cartesian3.equalsEpsilon(position, Cartesian3.fromDegrees(121, 31, 0), 1e-14));
  } finally { f.close(); }
});

test('polygon holes are preserved by union of triangles, with area equal to outer minus courtyard', () => {
  const outer = rect(), hole = rect(121.00025, 31.00025, 0.0005, 0.0005);
  const polygons = buildTemporaryWorksClipPolygons([{ outer, holes: [hole] }]);
  assert.equal(polygons.length, 8);
  const expected = geographicArea(buildTemporaryWorksClipPolygons([{ outer }])) - geographicArea(buildTemporaryWorksClipPolygons([{ outer: hole }]));
  assert.ok(Math.abs(geographicArea(polygons) - expected) < 1e-18);
  const reversed = buildTemporaryWorksClipPolygons([{ outer: [...outer].reverse(), holes: [[...hole].reverse()] }]);
  assert.ok(Math.abs(geographicArea(reversed) - expected) < 1e-18);
});

test('concave outline and two holes preserve measured area without clipping the courtyard', () => {
  const outer = rect(), holes = [rect(121.0001, 31.0001, 0.0002, 0.0002), rect(121.0006, 31.0006, 0.0002, 0.0002)];
  const pieces = buildTemporaryWorksClipPolygons([{ outer, holes }]);
  const expected = geographicArea(buildTemporaryWorksClipPolygons([{ outer }])) - holes.reduce((sum, h) => sum + geographicArea(buildTemporaryWorksClipPolygons([{ outer: h }])), 0);
  assert.ok(Math.abs(geographicArea(pieces) - expected) < 1e-18);
  const concave = rect(); concave.splice(2, 0, { longitude: 121.0004, latitude: 31.0004 });
  assert.equal(buildTemporaryWorksClipPolygons([{ outer: concave }]).length, 1);
});

test('invalid topology, missing footprints, outside/intersecting holes and non-finite coordinates fail closed', () => {
  for (const bad of [
    [], [{ outer: rect().slice(0, 2) }], [{ outer: rect().map((p, i) => ({ ...p, latitude: i ? p.latitude : NaN })) }],
    [{ outer: [rect()[0], rect()[2], rect()[1], rect()[3]] }],
    [{ outer: rect(), holes: [rect(122)] }],
    [{ outer: rect(), holes: [rect(121.0008)] }],
    [{ outer: rect(), holes: [rect(121.0001, 31.0001, 0.0005, 0.0005), rect(121.0002, 31.0002, 0.0002, 0.0002)] }],
  ]) assert.throws(() => buildTemporaryWorksClipPolygons(bad));
  const f = fixture();
  try {
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }); const before = f.tileset.clippingPolygons;
    assert.throws(() => f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: [] }));
    assert.equal(f.tileset.clippingPolygons, before); assert.equal(before.isDestroyed(), false);
  } finally { f.close(); }
});

test('WebGL1 is unsupported with no collection installed; hidden records do not allocate clipping', () => {
  const f = fixture(false);
  try {
    assert.equal(f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }).state, 'unsupported');
    assert.equal(f.tileset.clippingPolygons, undefined);
    assert.equal(f.manager.setVisible('A', false)!.state, 'hidden');
  } finally { f.close(); }
});

test('saved footprint JSON can rebuild after refresh with original visibility and independent viewer ownership', () => {
  const saved = JSON.parse(JSON.stringify([{ id: 'camp', footprints: footprint(), visible: true }, { id: 'steel', footprints: footprint(121.002), visible: false }]));
  const first = fixture(), second = fixture();
  try {
    for (const plan of saved) first.manager.upsert({ ...plan, tileset: first.tileset });
    const old = first.tileset.clippingPolygons; first.manager.dispose(); assert.equal(old.isDestroyed(), true);
    for (const plan of saved) second.manager.upsert({ ...plan, tileset: second.tileset });
    assert.equal(second.tileset.clippingPolygons.length, 1);
    assert.equal(second.manager.getStatus('steel')!.state, 'hidden');
    second.manager.setVisible('steel', true); assert.equal(second.tileset.clippingPolygons.length, 2);
  } finally { first.close(); second.close(); }
});

test('unchanged postUpdate frames do not replace GPU collection or continuously request renders', () => {
  const f = fixture();
  try {
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }); const old = f.tileset.clippingPolygons, renders = f.renders();
    for (let i = 0; i < 20; i++) f.postUpdate.raiseEvent();
    assert.equal(f.tileset.clippingPolygons, old); assert.equal(old.isDestroyed(), false); assert.equal(f.renders(), renders);
  } finally { f.close(); }
});

test('tileset unloading and disposal release listener and collection without touching stale Cesium setters', () => {
  const f = fixture();
  f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }); const owned = f.tileset.clippingPolygons;
  f.tileset.destroy(); f.postUpdate.raiseEvent();
  assert.equal(owned.isDestroyed(), true); assert.equal(f.manager.getStatus('A')!.state, 'blocked');
  f.manager.dispose(); assert.equal(f.postUpdate.numberOfListeners, 0);
  assert.throws(() => f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }), /已关闭/);
});
