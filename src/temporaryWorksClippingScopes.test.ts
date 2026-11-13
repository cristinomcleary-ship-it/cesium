import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Cartesian3, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection,
  ClippingPolygonCollection, Event, type Viewer,
} from 'cesium';
import {
  TemporaryWorksClippingManager, buildTemporaryWorksClipPolygons,
  type TemporaryWorksClippingScope, type TemporaryWorksFootprint,
} from './temporaryWorksClipping.ts';

const rect = (x = 121, y = 31, size = .001) => [
  { longitude: x, latitude: y }, { longitude: x + size, latitude: y },
  { longitude: x + size, latitude: y + size }, { longitude: x, latitude: y + size },
];
const footprints = (x = 121): TemporaryWorksFootprint[] => [{ outer: rect(x) }];
function fixture() {
  const postUpdate = new Event(); let renders = 0;
  const viewer = { scene: { context: { webgl2: true }, postUpdate, requestRender() { renders++; } }, isDestroyed: () => false } as unknown as Viewer;
  const manager = new TemporaryWorksClippingManager(viewer), tileset = new Cesium3DTileset({});
  const scopes: TemporaryWorksClippingScope[] = [];
  const scope = (name = 'surface-edit', limits = {}) => {
    const result = manager.createScope(name, { limits }); scopes.push(result); return result;
  };
  return { manager, tileset, scope, postUpdate, count: () => tileset.clippingPolygons?.length, renders: () => renders, close() {
    scopes.forEach(item => item.dispose()); manager.dispose();
    if (!tileset.isDestroyed()) tileset.destroy();
  } };
}

test('scoped and legacy contributions share one union without colliding IDs or switches', () => {
  const f = fixture(), scope = f.scope();
  try {
    f.manager.upsert({ id: 'same', tileset: f.tileset, footprints: footprints() });
    scope.upsert({ id: 'same', tileset: f.tileset, footprints: footprints(121.002) });
    assert.equal(f.tileset.clippingPolygons.length, 2); assert.equal(f.tileset.clippingPolygons.inverse, false);
    const legacy = f.tileset.clippingPolygons.get(0), edited = f.tileset.clippingPolygons.get(1);
    f.manager.setEnabled(false);
    assert.equal(f.manager.getStatus('same')?.state, 'disabled');
    assert.equal(scope.getStatus('same')?.state, 'active');
    assert.equal(f.tileset.clippingPolygons.length, 1); assert.equal(f.tileset.clippingPolygons.get(0), edited);
    f.manager.setEnabled(true); scope.setEnabled(false);
    assert.equal(f.manager.getStatus('same')?.state, 'active');
    assert.equal(scope.getStatus('same')?.state, 'disabled');
    assert.equal(f.tileset.clippingPolygons.length, 1); assert.equal(f.tileset.clippingPolygons.get(0), legacy);
    scope.setEnabled(true); scope.setVisible('same', false);
    assert.equal(f.tileset.clippingPolygons.get(0), legacy); assert.equal(scope.getStatus('same')?.state, 'hidden');
    scope.setVisible('same', true); f.manager.setPlanEnabled('same', false);
    assert.equal(f.tileset.clippingPolygons.get(0), edited);
    scope.setPlanEnabled('same', false); assert.equal(f.tileset.clippingPolygons, undefined);
    scope.setPlanEnabled('same', true); assert.equal(f.count(), 1);
  } finally { f.close(); }
});

test('legacy clear and dispose retain live scopes and their postUpdate watcher', () => {
  const f = fixture(), scope = f.scope();
  try {
    f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprints() });
    scope.upsert({ id: 'pit', tileset: f.tileset, footprints: footprints(121.002) });
    f.manager.clear();
    assert.equal(f.manager.getStatus('camp'), undefined); assert.equal(scope.getStatus('pit')?.state, 'active');
    assert.equal(f.tileset.clippingPolygons.length, 1); assert.equal(f.postUpdate.numberOfListeners, 1);
    f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprints() });
    f.manager.dispose(); f.manager.dispose();
    assert.equal(scope.getStatus('pit')?.state, 'active'); assert.equal(f.tileset.clippingPolygons.length, 1);
    assert.equal(f.postUpdate.numberOfListeners, 1);
    assert.throws(() => f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprints() }), /已关闭/);
    scope.upsert({ id: 'flat', tileset: f.tileset, footprints: footprints(121.004) });
    assert.equal(f.count(), 2);
    scope.dispose(); assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('scope clear and disposal preserve temporary works and other scopes', () => {
  const f = fixture(), scope = f.scope(), second = f.scope('other');
  try {
    f.manager.upsert({ id: 'A', tileset: f.tileset, footprints: footprints() });
    scope.upsert({ id: 'A', tileset: f.tileset, footprints: footprints(121.002) });
    second.upsert({ id: 'A', tileset: f.tileset, footprints: footprints(121.004) });
    scope.clear(); assert.equal(f.tileset.clippingPolygons.length, 2);
    scope.upsert({ id: 'B', tileset: f.tileset, footprints: footprints(121.006) });
    scope.dispose(); assert.equal(f.tileset.clippingPolygons.length, 2);
    assert.equal(f.manager.getStatus('A')?.state, 'active'); assert.equal(second.getStatus('A')?.state, 'active');
    assert.equal(f.postUpdate.numberOfListeners, 1);
    second.dispose(); assert.equal(f.tileset.clippingPolygons.length, 1);
    f.manager.clear(); assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('scope names have a single owner and disposed handles cannot alter a replacement owner', () => {
  const f = fixture(), old = f.scope();
  try {
    assert.throws(() => f.scope(), /已由其他对象持有/);
    old.upsert({ id: 'same', tileset: f.tileset, footprints: footprints() }); old.dispose();
    const replacement = f.scope();
    replacement.upsert({ id: 'same', tileset: f.tileset, footprints: footprints(121.002) });
    const owned = f.tileset.clippingPolygons;
    old.remove('same'); old.clear(); old.dispose(); old.setEnabled(false); old.setVisible('same', false); old.setPlanEnabled('same', false);
    assert.throws(() => old.upsert({ id: 'same', tileset: f.tileset, footprints: footprints() }), /已关闭/);
    assert.equal(f.tileset.clippingPolygons, owned); assert.equal(replacement.getStatus('same')?.state, 'active');
    assert.equal(f.postUpdate.numberOfListeners, 1);
  } finally { f.close(); }
});

test('both contributors stay blocked by foreign planes and recover without modifying them', () => {
  const f = fixture(), scope = f.scope();
  const planes = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 19)], edgeWidth: 3 });
  try {
    f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprints() });
    scope.upsert({ id: 'pit', tileset: f.tileset, footprints: footprints(121.002) });
    const owned = f.tileset.clippingPolygons;
    f.tileset.clippingPlanes = planes; f.postUpdate.raiseEvent();
    assert.equal(owned.isDestroyed(), true); assert.equal(f.tileset.clippingPolygons, undefined);
    assert.equal(f.manager.getStatus('camp')?.state, 'blocked'); assert.equal(scope.getStatus('pit')?.state, 'blocked');
    assert.equal(planes.enabled, true); assert.equal(planes.edgeWidth, 3); assert.equal(planes.get(0).distance, 19);
    planes.enabled = false; f.postUpdate.raiseEvent();
    assert.equal(f.count(), 2);
    assert.equal(f.manager.getStatus('camp')?.state, 'active'); assert.equal(scope.getStatus('pit')?.state, 'active');
    scope.dispose(); f.manager.dispose(); assert.equal(planes.isDestroyed(), false); assert.equal(f.tileset.clippingPlanes, planes);
  } finally { f.close(); }
});

test('foreign polygon replacement is preserved through all contributor disposal', () => {
  const f = fixture(), scope = f.scope();
  const foreign = new ClippingPolygonCollection({ polygons: buildTemporaryWorksClipPolygons(footprints(122)), inverse: true, enabled: false });
  try {
    f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprints() });
    scope.upsert({ id: 'pit', tileset: f.tileset, footprints: footprints(121.002) });
    const owned = f.tileset.clippingPolygons; f.tileset.clippingPolygons = foreign; f.postUpdate.raiseEvent();
    assert.equal(owned.isDestroyed(), true); assert.equal(f.manager.getStatus('camp')?.state, 'blocked');
    assert.equal(scope.getStatus('pit')?.state, 'blocked');
    f.manager.dispose(); scope.dispose();
    assert.equal(f.tileset.clippingPolygons, foreign); assert.equal(foreign.isDestroyed(), false);
    assert.equal(foreign.inverse, true); assert.equal(foreign.enabled, false); assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('total scoped budget includes hidden contributors and rejects changes atomically', () => {
  const f = fixture(), scope = f.scope('surface-edit', { contributors: 2, boundaryPoints: 8, polygons: 2, topologyChecks: 32 });
  try {
    scope.upsert({ id: 'A', tileset: f.tileset, footprints: footprints() });
    scope.upsert({ id: 'B', tileset: f.tileset, footprints: footprints(121.002), visible: false });
    assert.deepEqual(scope.getUsage(), { contributors: 2, boundaryPoints: 8, polygons: 2, topologyChecks: 32 });
    const before = f.tileset.clippingPolygons;
    assert.throws(() => scope.upsert({ id: 'C', tileset: f.tileset, footprints: footprints(121.004) }), /方案数量/);
    assert.throws(() => scope.upsert({ id: 'A', tileset: f.tileset, footprints: [...footprints(), ...footprints(121.004)] }), /边界点数/);
    assert.equal(f.tileset.clippingPolygons, before); assert.equal(before.isDestroyed(), false);
    assert.equal(scope.getStatus('C'), undefined); assert.equal(scope.getStatus('A')?.state, 'active');
    assert.deepEqual(scope.getUsage(), { contributors: 2, boundaryPoints: 8, polygons: 2, topologyChecks: 32 });
    scope.setVisible('B', true); assert.equal(f.tileset.clippingPolygons.length, 2);
    scope.remove('B');
    scope.upsert({ id: 'A', tileset: f.tileset, footprints: [...footprints(), ...footprints(121.004)] });
    assert.deepEqual(scope.getUsage(), { contributors: 1, boundaryPoints: 8, polygons: 2, topologyChecks: 32 });
    // Legacy valid contributors do not consume or inherit the new scope's budget.
    f.manager.upsert({ id: 'legacy', tileset: f.tileset, footprints: [...footprints(122), ...footprints(122.002), ...footprints(122.004)] });
    assert.equal(f.tileset.clippingPolygons.length, 5);
  } finally { f.close(); }
});

test('preflight budget rejection happens before accessing vertices or expensive geometry validation', () => {
  const f = fixture(), scope = f.scope('surface-edit', { boundaryPoints: 4 });
  try {
    scope.upsert({ id: 'A', tileset: f.tileset, footprints: footprints() }); const before = f.tileset.clippingPolygons;
    const oversized = new Proxy(new Array(5), { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) throw new Error('Vertices must not be read after budget exhaustion');
      return Reflect.get(target, key, receiver);
    } });
    assert.throws(() => scope.upsert({ id: 'A', tileset: f.tileset, footprints: [{ outer: oversized }] }), /边界点数/);
    assert.equal(f.tileset.clippingPolygons, before);
    assert.throws(() => scope.upsert({ id: 'A', tileset: f.tileset, footprints: [{ outer: [rect()[0], rect()[2], rect()[1], rect()[3]] }] }), /退化|自相交/);
    assert.equal(f.tileset.clippingPolygons, before); assert.equal(scope.getStatus('A')?.state, 'active');
  } finally { f.close(); }
});

test('hole decomposition, topology work and invalid limit configurations are budgeted', () => {
  const f = fixture();
  try {
    for (const limits of [{ contributors: 0 }, { polygons: Infinity }, { boundaryPoints: 1.5 }, { topologyChecks: -1 }])
      assert.throws(() => f.scope('bad', limits), /正整数/);
    assert.throws(() => f.scope(''), /缺少编号/);
    const hole = [{ outer: rect(), holes: [rect(121.0002, 31.0002, .0002)] }];
    const polygonLimited = f.scope('polygon-limited', { polygons: 7 });
    assert.throws(() => polygonLimited.upsert({ id: 'A', tileset: f.tileset, footprints: hole }), /裁剪多边形数/);
    assert.equal(f.tileset.clippingPolygons, undefined);
    const topologyLimited = f.scope('topology-limited', { topologyChecks: 15 });
    assert.throws(() => topologyLimited.upsert({ id: 'A', tileset: f.tileset, footprints: footprints() }), /拓扑校验工作量/);
    const exact = f.scope('exact', { polygons: 8, boundaryPoints: 8, topologyChecks: 64 });
    exact.upsert({ id: 'A', tileset: f.tileset, footprints: hole });
    assert.equal(f.count(), 8); assert.equal(exact.getUsage().polygons, 8);
  } finally { f.close(); }
});

test('scope target migration retains unrelated contributions and unchanged frames do no work', () => {
  const f = fixture(), scope = f.scope(), other = new Cesium3DTileset({});
  try {
    f.manager.upsert({ id: 'camp', tileset: f.tileset, footprints: footprints() });
    scope.upsert({ id: 'pit', tileset: f.tileset, footprints: footprints(121.002) });
    scope.upsert({ id: 'pit', tileset: other, footprints: footprints(122) });
    assert.equal(f.tileset.clippingPolygons.length, 1); assert.equal(other.clippingPolygons.length, 1);
    const legacy = f.tileset.clippingPolygons, edit = other.clippingPolygons, renders = f.renders();
    for (let i = 0; i < 20; i++) f.postUpdate.raiseEvent();
    assert.equal(f.tileset.clippingPolygons, legacy); assert.equal(other.clippingPolygons, edit); assert.equal(f.renders(), renders);
    other.destroy(); f.postUpdate.raiseEvent(); assert.equal(scope.getStatus('pit')?.state, 'blocked');
    scope.dispose(); assert.equal(f.tileset.clippingPolygons, legacy); assert.equal(f.manager.getStatus('camp')?.state, 'active');
  } finally { f.close(); if (!other.isDestroyed()) other.destroy(); }
});
