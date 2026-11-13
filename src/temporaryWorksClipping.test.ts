import { OWNED_FRAGMENT_CLIPPING } from './ownedClippingPolygons.ts';
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
    assert.equal((first as unknown as Record<string, unknown>)[OWNED_FRAGMENT_CLIPPING], true);
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

test('foreign planes active-disabled-active-disabled cycle restores owned polygons without changing the planes', () => {
  const f = fixture();
  const currentPolygons = () => f.tileset.clippingPolygons;
  const plane = new ClippingPlane(Cartesian3.UNIT_Y, -23.5);
  const planes = new ClippingPlaneCollection({
    planes: [plane], enabled: true, unionClippingRegions: true, edgeWidth: 2.75,
    modelMatrix: Matrix4.fromTranslation(new Cartesian3(7, -13, 29)),
  });
  const matrix = planes.modelMatrix, originalMatrix = Matrix4.clone(matrix);
  const originalColor = planes.edgeColor.clone();
  const preserved = (enabled: boolean) => {
    assert.equal(f.tileset.clippingPlanes, planes); assert.equal(planes.isDestroyed(), false);
    assert.equal(planes.enabled, enabled); assert.equal(planes.length, 1); assert.equal(planes.get(0), plane);
    assert.ok(Cartesian3.equals(plane.normal, Cartesian3.UNIT_Y)); assert.equal(plane.distance, -23.5);
    assert.equal(planes.modelMatrix, matrix); assert.ok(Matrix4.equals(matrix, originalMatrix));
    assert.equal(planes.unionClippingRegions, true); assert.equal(planes.edgeWidth, 2.75);
    assert.ok(planes.edgeColor.equals(originalColor));
  };
  try {
    f.tileset.clippingPlanes = planes;
    assert.equal(f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }).state, 'blocked');
    assert.equal(f.tileset.clippingPolygons, undefined); preserved(true);

    planes.enabled = false; f.postUpdate.raiseEvent();
    assert.equal(f.manager.getStatus('A')!.state, 'active');
    const firstOwned = currentPolygons();
    assert.ok(firstOwned); assert.equal(firstOwned.length, 1); assert.equal(firstOwned.isDestroyed(), false);
    preserved(false);
    f.postUpdate.raiseEvent(); assert.equal(f.tileset.clippingPolygons, firstOwned);

    planes.enabled = true; f.postUpdate.raiseEvent();
    assert.equal(f.manager.getStatus('A')!.state, 'blocked');
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(firstOwned.isDestroyed(), true);
    preserved(true);

    planes.enabled = false; f.postUpdate.raiseEvent();
    assert.equal(f.manager.getStatus('A')!.state, 'active');
    const secondOwned = currentPolygons();
    assert.ok(secondOwned); assert.notEqual(secondOwned, firstOwned);
    assert.equal(secondOwned.length, 1); assert.equal(secondOwned.isDestroyed(), false);
    preserved(false);
    f.manager.dispose(); assert.equal(secondOwned.isDestroyed(), true);
    assert.equal(f.tileset.clippingPolygons, undefined); preserved(false);
  } finally { f.close(); }
});

test('initially disabled foreign planes survive hide-show, global switches, clear and disposal', () => {
  const f = fixture();
  const currentPolygons = () => f.tileset.clippingPolygons;
  const plane = new ClippingPlane(Cartesian3.UNIT_Z, 17);
  const planes = new ClippingPlaneCollection({
    planes: [plane], enabled: false, edgeWidth: 3,
    modelMatrix: Matrix4.fromTranslation(new Cartesian3(-8, 12, 4)),
  });
  const matrix = planes.modelMatrix, originalMatrix = Matrix4.clone(matrix);
  const preserved = () => {
    assert.equal(f.tileset.clippingPlanes, planes); assert.equal(planes.isDestroyed(), false);
    assert.equal(planes.enabled, false); assert.equal(planes.length, 1); assert.equal(planes.get(0), plane);
    assert.ok(Cartesian3.equals(plane.normal, Cartesian3.UNIT_Z)); assert.equal(plane.distance, 17);
    assert.equal(planes.modelMatrix, matrix); assert.ok(Matrix4.equals(matrix, originalMatrix));
    assert.equal(planes.edgeWidth, 3);
  };
  try {
    f.tileset.clippingPlanes = planes;
    assert.equal(f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }).state, 'active');
    const initial = currentPolygons(); assert.ok(initial); preserved();
    assert.equal(f.manager.setVisible('A', false)!.state, 'hidden');
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(initial.isDestroyed(), true); preserved();
    assert.equal(f.manager.setVisible('A', true)!.state, 'active');
    const shown = currentPolygons(); assert.ok(shown); assert.notEqual(shown, initial); preserved();
    f.manager.setEnabled(false);
    assert.equal(f.manager.getStatus('A')!.state, 'disabled');
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(shown.isDestroyed(), true); preserved();
    f.manager.setEnabled(true);
    assert.equal(f.manager.getStatus('A')!.state, 'active');
    const reenabled = currentPolygons(); assert.ok(reenabled); assert.notEqual(reenabled, shown); preserved();
    f.manager.clear();
    assert.equal(f.manager.getStatus('A'), undefined); assert.equal(f.tileset.clippingPolygons, undefined);
    assert.equal(reenabled.isDestroyed(), true); assert.equal(f.postUpdate.numberOfListeners, 0); preserved();
    assert.equal(f.manager.upsert({ id: 'B', tileset: f.tileset, footprints: footprint(121.002) }).state, 'active');
    const lastOwned = currentPolygons(); assert.ok(lastOwned); preserved();
    f.manager.dispose();
    assert.equal(lastOwned.isDestroyed(), true); assert.equal(f.tileset.clippingPolygons, undefined);
    assert.equal(f.postUpdate.numberOfListeners, 0); preserved();
  } finally { f.close(); }
});

test('disabled foreign polygons remain blocked and untouched through visibility, clear and disposal', () => {
  const f = fixture();
  const foreign = new ClippingPolygonCollection({
    polygons: buildTemporaryWorksClipPolygons(footprint(122)), enabled: false, inverse: true,
  });
  const originalPolygon = foreign.get(0), originalPositions = originalPolygon.positions.map(p => Cartesian3.clone(p));
  const preserved = () => {
    assert.equal(f.tileset.clippingPolygons, foreign); assert.equal(foreign.isDestroyed(), false);
    assert.equal(foreign.enabled, false); assert.equal(foreign.inverse, true); assert.equal(foreign.length, 1);
    assert.equal(foreign.get(0), originalPolygon);
    assert.equal(originalPolygon.positions.length, originalPositions.length);
    originalPositions.forEach((position, index) => assert.ok(Cartesian3.equals(position, originalPolygon.positions[index])));
  };
  try {
    f.tileset.clippingPolygons = foreign;
    assert.equal(f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }).state, 'blocked'); preserved();
    assert.equal(f.manager.setVisible('A', false)!.state, 'hidden'); preserved();
    assert.equal(f.manager.setVisible('A', true)!.state, 'blocked'); preserved();
    f.manager.setEnabled(false); preserved();
    f.manager.setEnabled(true); assert.equal(f.manager.getStatus('A')!.state, 'blocked'); preserved();
    f.postUpdate.raiseEvent(); assert.equal(f.manager.getStatus('A')!.state, 'blocked'); preserved();
    f.manager.clear(); assert.equal(f.manager.getStatus('A'), undefined); preserved();
    f.manager.dispose(); assert.equal(f.postUpdate.numberOfListeners, 0); preserved();
  } finally { f.close(); }
});

test('foreign planes with an undefined enabled value remain conservatively blocked', () => {
  const f = fixture();
  const plane = new ClippingPlane(Cartesian3.UNIT_X, 9);
  const planes = new ClippingPlaneCollection({ planes: [plane] });
  // The collection and Cesium ownership setter remain real; only an external
  // unknown state is supplied. Only explicit false may release the conflict.
  (planes as unknown as { enabled: boolean | undefined }).enabled = undefined;
  try {
    f.tileset.clippingPlanes = planes;
    assert.equal(f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprint() }).state, 'blocked');
    f.postUpdate.raiseEvent();
    assert.equal(f.manager.getStatus('A')!.state, 'blocked'); assert.equal(f.tileset.clippingPolygons, undefined);
    f.manager.dispose();
    assert.equal(f.tileset.clippingPlanes, planes); assert.equal(planes.enabled, undefined);
    assert.equal(planes.isDestroyed(), false); assert.equal(planes.get(0), plane); assert.equal(plane.distance, 9);
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

test('world positions preserve building ellipsoid heights and are independent of translated tileset local coordinates', () => {
  const f = fixture();
  try {
    f.tileset.modelMatrix = Matrix4.fromTranslation(new Cartesian3(1000000, 500000, 20000));
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: [{outer: rect().map((p, i) => ({...p, height: 1000 + i}))}] });
    const position = f.tileset.clippingPolygons.get(0).positions[0];
    assert.ok(Cartesian3.equalsEpsilon(position, Cartesian3.fromDegrees(121, 31, 1000), 1e-14));
    assert.ok(!Cartesian3.equalsEpsilon(position, Cartesian3.fromDegrees(121, 31, 0), 1e-6));
    assert.ok(Cartesian3.equalsEpsilon(f.tileset.clippingPolygons.get(0).positions[1], Cartesian3.fromDegrees(121.001, 31, 1001), 1e-14));
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


test('external detach or destroyed owned collection releases content borrowers before reattachment', () => {
  for (const mode of ['setter', 'destroy'] as const) {
    const f = fixture();
    try {
      f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprint() });
      const previous = f.tileset.clippingPolygons;
      const model = { _clippingPolygons: previous as ClippingPolygonCollection | undefined, _clippingPolygonsState: 1, resets: 0, resetDrawCommands() { this.resets++; } };
      const root = { content: { _model: model }, children: [], _clippingPolygonsState: 1, clippingPolygonsDirty: false };
      (f.tileset as unknown as { _root: unknown })._root = root;
      if (mode === 'setter') (f.tileset as unknown as { clippingPolygons: unknown }).clippingPolygons = undefined;
      else previous.destroy();
      const rendersBeforeCleanup = f.renders();
      f.manager.synchronize();
      assert.ok(f.renders() > rendersBeforeCleanup, 'released command aliases must request a frame even without a replacement');
      assert.equal(model._clippingPolygons, undefined); assert.equal(model.resets, 1);
      assert.equal(root.clippingPolygonsDirty, true); assert.equal(root._clippingPolygonsState, 0);
      if (mode === 'setter') assert.notEqual(f.tileset.clippingPolygons, previous);
    } finally {
      (f.tileset as unknown as { _root: unknown })._root = undefined;
      // A directly destroyed foreign-set collection cannot be destroyed twice by Cesium's setter.
      if (f.tileset.clippingPolygons?.isDestroyed()) (f.tileset as unknown as { _clippingPolygons: unknown })._clippingPolygons = undefined;
      f.close();
    }
  }
});


test('foreign collection without an owned borrower is not reset or rendered by cleanup', () => {
  const f = fixture();
  const foreign = new ClippingPolygonCollection({ polygons: buildTemporaryWorksClipPolygons(footprint(122)) });
  try {
    f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprint() });
    f.tileset.clippingPolygons = foreign;
    const model = { _clippingPolygons: foreign, resets: 0, resetDrawCommands() { this.resets++; } };
    const root = { content: { _model: model }, children: [], _clippingPolygonsState: 1, clippingPolygonsDirty: false };
    (f.tileset as unknown as { _root: unknown })._root = root;
    const before = f.renders();
    f.manager.synchronize();
    assert.equal(f.renders(), before); assert.equal(model.resets, 0);
    assert.equal(model._clippingPolygons, foreign); assert.equal(f.tileset.clippingPolygons, foreign);
    assert.equal(root.clippingPolygonsDirty, false); assert.equal(foreign.isDestroyed(), false);
  } finally {
    (f.tileset as unknown as { _root: unknown })._root = undefined;
    f.close();
  }
});
