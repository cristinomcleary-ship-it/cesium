import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundingSphere, Cartesian3, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection,
  ClippingPolygon, ClippingPolygonCollection, Event, Globe, Matrix4, Primitive, type Viewer,
} from 'cesium';
import { getTemporaryWorksClippingManager } from './temporaryWorksGlbScene.ts';
import { buildSurfaceEditGeometry } from './surfaceEditGeometry.ts';
import {
  SurfaceEditScene, isSurfaceEditGlobeClipping, surfaceEditMeshGeometry,
  updateOwnedSurfaceGlobePolygons, type SurfaceEditPreparedMesh,
} from './surfaceEditScene.ts';
import type { SurfaceEditPlan } from './surfaceEditTypes.ts';

const geometry = buildSurfaceEditGeometry({ mode: 'excavation', targetElevation: 0, outer: [
  { x: 0, y: 0, z: 5 }, { x: 20, y: 0, z: 5 }, { x: 20, y: 20, z: 5 }, { x: 0, y: 20, z: 5 },
] });
function plan(id = 'a', longitude = 121, clipTerrain = true): SurfaceEditPlan {
  return { version: 1, id, name: id, kind: 'excavation', targetId: 'tiles', targetTransform: Matrix4.toArray(Matrix4.IDENTITY),
    targetHeight: 10, boundary: [{ longitude, latitude: 31, height: 15 }, { longitude: longitude + 0.001, latitude: 31, height: 15 },
      { longitude: longitude + 0.001, latitude: 31.001, height: 15 }, { longitude, latitude: 31.001, height: 15 }],
    holes: [], clipTerrain, bottomVisible: true, texture: { ground: 'soil', wall: 'soil', scaleMeters: 2 },
    enabled: true, createdAt: '2026-11-12', updatedAt: '2026-11-12' };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mockMesh() {
  let visible = false, bottomVisible = true, destroyed = 0, updates = 0;
  const primitive = new Primitive();
  const mesh: SurfaceEditPreparedMesh = { primitives: [primitive], bounds: new BoundingSphere(),
    setVisible(v, b) { visible = v; bottomVisible = b; updates++; },
    destroy() { destroyed++; if (!primitive.isDestroyed()) primitive.destroy(); } };
  return { mesh, get visible() { return visible; }, get bottomVisible() { return bottomVisible; },
    get destroyed() { return destroyed; }, get updates() { return updates; } };
}
function fixture(prepare?: () => Promise<SurfaceEditPreparedMesh>) {
  const globe = new Globe(), tileset = new Cesium3DTileset({}), postUpdate = new Event();
  let renders = 0;
  const viewer = { scene: { globe, postUpdate, context: { webgl2: true }, requestRender() { renders++; } },
    camera: { flyToBoundingSphere() {} }, isDestroyed: () => false } as unknown as Viewer;
  const meshes: ReturnType<typeof mockMesh>[] = [];
  const renderer = new SurfaceEditScene(viewer, { prepareMesh: prepare ?? (async () => { const mesh = mockMesh(); meshes.push(mesh); return mesh.mesh; }) });
  const preparePlan = (p = plan(), signal?: AbortSignal) => renderer.prepare(p, geometry, Matrix4.IDENTITY, tileset, signal);
  return { globe, tileset, viewer, renderer, meshes, postUpdate, preparePlan, get renders() { return renders; }, close() {
    renderer.destroy(); getTemporaryWorksClippingManager(viewer).dispose();
    if (!tileset.isDestroyed()) tileset.destroy(); if (!globe.isDestroyed()) globe.destroy();
  } };
}

test('unused surface editing does not rescan legacy clipping on render frames', async () => {
  const f = fixture(), manager = getTemporaryWorksClippingManager(f.viewer);
  const synchronize = manager.synchronize;
  let calls = 0;
  manager.synchronize = () => { calls++; synchronize.call(manager); };
  try {
    f.postUpdate.raiseEvent();
    const handle = await f.preparePlan();
    f.postUpdate.raiseEvent();
    assert.equal(calls, 0);
    handle.setEnabled(true); handle.setEnabled(false);
    const afterDisable = calls;
    f.postUpdate.raiseEvent();
    assert.equal(calls, afterDisable);
  } finally { manager.synchronize = synchronize; f.close(); }
});

test('prepared surfaces never clip until enabled; toggles pair photography, terrain and faces', async () => {
  const f = fixture();
  try {
    const handle = await f.preparePlan();
    assert.equal(handle.enabled, false); assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.globe.clippingPolygons, undefined);
    assert.equal(handle.setEnabled(true).state, 'ready');
    const terrain = f.globe.clippingPolygons as unknown as ClippingPolygonCollection;
    assert.equal(terrain.length, 1); assert.equal(isSurfaceEditGlobeClipping(terrain), true);
    assert.equal((f.tileset.clippingPolygons as unknown as ClippingPolygonCollection).length, 1); assert.equal(f.meshes[0].visible, true);
    handle.setBottomVisible(false); assert.equal(f.meshes[0].visible, true); assert.equal(f.meshes[0].bottomVisible, false);
    handle.setEnabled(false);
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.globe.clippingPolygons, terrain);
    assert.equal(terrain.enabled, false); assert.equal(terrain.length, 1); assert.equal(terrain.isDestroyed(), false);
    assert.equal(f.meshes[0].visible, false);
    handle.setEnabled(true); assert.equal(f.globe.clippingPolygons, terrain); assert.equal(terrain.enabled, true);
    f.renderer.destroy(); assert.equal(terrain.enabled, false); assert.equal(terrain.isDestroyed(), false);
    assert.equal(f.meshes[0].destroyed, 1); assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('multiple surfaces and legacy temporary works remain independent through suspension and deletion', async () => {
  const f = fixture();
  try {
    const manager = getTemporaryWorksClippingManager(f.viewer);
    manager.upsert({ id: 'building', tileset: f.tileset, footprints: [{ outer: plan('b', 121.01).boundary }] });
    const a = await f.preparePlan(), b = await f.preparePlan(plan('b', 121.002));
    a.setEnabled(true); b.setEnabled(true);
    assert.equal(f.tileset.clippingPolygons.length, 3); assert.equal(f.globe.clippingPolygons.length, 2);
    const legacySize = () => f.tileset.clippingPolygons?.length;
    f.renderer.setSuspended(true); assert.equal(legacySize(), 1); assert.equal(f.globe.clippingPolygons.enabled, false);
    assert.equal(a.status.state, 'suspended'); assert.equal(f.meshes[0].visible, false);
    f.renderer.setSuspended(false); assert.equal(legacySize(), 3); assert.equal(f.globe.clippingPolygons.enabled, true);
    a.destroy(); assert.equal(legacySize(), 2); assert.equal(f.globe.clippingPolygons.length, 1);
    manager.clear(); assert.equal(legacySize(), 1); assert.equal(b.status.state, 'ready');
    b.destroy(); assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.globe.clippingPolygons.enabled, false);
  } finally { f.close(); }
});

test('global AR suspension retains enable and disable changes even while AR hides the source', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  try {
    const manager = getTemporaryWorksClippingManager(f.viewer), a = await f.preparePlan(), b = await f.preparePlan(plan('b', 121.002));
    a.setEnabled(true); b.setEnabled(true);
    release = manager.suspend({}); f.renderer.setSuspended(true); f.tileset.show = false;
    a.setEnabled(false);
    assert.equal(a.setEnabled(true).state, 'suspended');
    b.setEnabled(false);
    assert.equal(a.enabled, true); assert.equal(b.enabled, false);
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.globe.clippingPolygons.enabled, false);
    assert.ok(f.meshes.every(mesh => !mesh.visible));
    // Match the composite lease order: surfaces resume before the manager and
    // the next map traversal observes the final current state.
    f.renderer.setSuspended(false); f.tileset.show = true; release(); release = undefined; f.postUpdate.raiseEvent();
    assert.equal(a.status.state, 'ready'); assert.equal(b.status.state, 'hidden');
    assert.equal((f.tileset.clippingPolygons as unknown as ClippingPolygonCollection).length, 1); assert.equal(f.globe.clippingPolygons.length, 1);
    assert.equal(f.meshes[0].visible, true); assert.equal(f.meshes[1].visible, false);
    assert.equal(f.meshes.length, 2, 'restoration must reuse the prepared meshes');
  } finally { release?.(); f.close(); }
});

test('suspended replacement can roll back or commit without discarding the last valid handle', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  try {
    const old = await f.preparePlan(); old.setEnabled(true);
    const terrain = f.globe.clippingPolygons, original = terrain.get(0).positions[0];
    const manager = getTemporaryWorksClippingManager(f.viewer);
    release = manager.suspend({}); f.renderer.setSuspended(true);
    const cancelled = await f.preparePlan(plan('a', 121.01));
    assert.equal(cancelled.setEnabled(true).state, 'suspended');
    assert.equal(f.meshes[0].destroyed, 0); assert.equal(f.tileset.clippingPolygons, undefined);
    cancelled.destroy();
    f.renderer.setSuspended(false); release(); release = undefined; f.postUpdate.raiseEvent();
    assert.equal(old.status.state, 'ready'); assert.deepEqual(terrain.get(0).positions[0], original);

    release = manager.suspend({}); f.renderer.setSuspended(true);
    const committed = await f.preparePlan(plan('a', 121.02));
    assert.equal(committed.setEnabled(true).state, 'suspended'); old.destroy();
    assert.equal(f.meshes[0].destroyed, 1); assert.equal(f.meshes[2].destroyed, 0);
    f.renderer.setSuspended(false); release(); release = undefined; f.postUpdate.raiseEvent();
    assert.equal(committed.status.state, 'ready'); assert.notDeepEqual(terrain.get(0).positions[0], original);
    assert.equal((f.tileset.clippingPolygons as unknown as ClippingPolygonCollection).length, 1); assert.equal(f.meshes[2].visible, true);
  } finally { release?.(); f.close(); }
});

test('pending suspended enable is checked against foreign clipping when it resumes', async () => {
  const f = fixture(), plane = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 0)] });
  let release: (() => void) | undefined;
  try {
    const handle = await f.preparePlan();
    release = getTemporaryWorksClippingManager(f.viewer).suspend({}); f.renderer.setSuspended(true);
    f.tileset.clippingPlanes = plane;
    assert.equal(handle.setEnabled(true).state, 'suspended'); assert.equal(handle.enabled, true);
    f.renderer.setSuspended(false); release(); release = undefined; f.postUpdate.raiseEvent();
    assert.equal(handle.status.state, 'blocked'); assert.equal(f.tileset.clippingPlanes, plane);
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.meshes[0].visible, false);
    plane.enabled = false; f.postUpdate.raiseEvent(); assert.equal(handle.status.state, 'ready');
  } finally { release?.(); f.close(); }
});

test('candidate replacement is reversible until the original handle is discarded', async () => {
  const f = fixture();
  try {
    const old = await f.preparePlan(); old.setEnabled(true);
    const terrain = f.globe.clippingPolygons, original = terrain.get(0).positions[0];
    const candidate = await f.preparePlan(plan('a', 121.01)); candidate.setEnabled(true);
    assert.equal(f.globe.clippingPolygons, terrain); assert.equal(terrain.length, 1);
    assert.notDeepEqual(terrain.get(0).positions[0], original);
    assert.equal((terrain as unknown as { _totalPositions: number })._totalPositions, -1, 'same-size edits must invalidate 1.144 position-count cache');
    assert.equal(f.meshes[0].visible, false); assert.equal(f.meshes[1].visible, true);
    candidate.destroy(); assert.deepEqual(terrain.get(0).positions[0], original);
    assert.equal(old.status.state, 'ready'); assert.equal(f.meshes[0].visible, true);
    const committed = await f.preparePlan(plan('a', 121.02)); committed.setEnabled(true);
    old.destroy(); assert.equal(committed.status.state, 'ready'); assert.equal(f.tileset.clippingPolygons.length, 1);
    committed.destroy(); assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(terrain.enabled, false);
  } finally { f.close(); }
});

test('foreign tile or terrain clipping blocks candidates and stays owned by its original module', async () => {
  const f = fixture();
  const plane = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 0)] });
  const polygon = new ClippingPolygonCollection({ polygons: [new ClippingPolygon({ positions: plan().boundary.map(p => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height)) })] });
  try {
    const handle = await f.preparePlan(); f.tileset.clippingPlanes = plane;
    assert.equal(handle.setEnabled(true).state, 'blocked'); assert.equal(f.globe.clippingPolygons, undefined);
    assert.equal(f.meshes[0].visible, false); assert.equal(f.tileset.clippingPlanes, plane);
    plane.enabled = false; f.globe.clippingPolygons = polygon;
    assert.equal(handle.setEnabled(true).state, 'blocked'); assert.equal(f.globe.clippingPolygons, polygon);
    f.renderer.destroy(); assert.equal(polygon.isDestroyed(), false); assert.equal(polygon.enabled, true);
    assert.equal(plane.isDestroyed(), false);
    assert.throws(() => updateOwnedSurfaceGlobePolygons(polygon, []), /所有权/);
  } finally { f.close(); }
});

test('active effects pause when the source disappears or an external section is enabled and recover without sampling', async () => {
  const f = fixture();
  const plane = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 0)], enabled: false });
  try {
    const handle = await f.preparePlan(); handle.setEnabled(true);
    const terrain = f.globe.clippingPolygons;
    f.tileset.show = false; f.postUpdate.raiseEvent();
    assert.equal(handle.status.state, 'blocked'); assert.equal(terrain.enabled, false); assert.equal(f.meshes[0].visible, false);
    f.tileset.show = true; f.postUpdate.raiseEvent(); assert.equal(handle.status.state, 'ready');
    f.globe.clippingPlanes = plane; plane.enabled = true; f.postUpdate.raiseEvent();
    assert.equal(handle.status.state, 'blocked'); assert.equal(terrain.enabled, false); assert.equal(f.tileset.clippingPolygons, undefined);
    plane.enabled = false; f.postUpdate.raiseEvent(); assert.equal(handle.status.state, 'ready');
    assert.equal(f.meshes.length, 1, 'visibility recovery reuses geometry');
    const renders = f.renders, updates = f.meshes[0].updates;
    for (let i = 0; i < 10; i++) f.postUpdate.raiseEvent();
    assert.equal(f.renders, renders); assert.equal(f.meshes[0].updates, updates, 'unchanged frames cannot schedule new work');
  } finally { f.close(); }
});

test('late completion after cancellation or disposal releases the candidate and never changes existing clipping', async () => {
  const wait = deferred<SurfaceEditPreparedMesh>(), mesh = mockMesh(), f = fixture(() => wait.promise);
  try {
    const controller = new AbortController(), pending = f.preparePlan(plan(), controller.signal);
    controller.abort(); wait.resolve(mesh.mesh);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(mesh.destroyed, 1); assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.globe.clippingPolygons, undefined);
  } finally { f.close(); }
  const otherWait = deferred<SurfaceEditPreparedMesh>(), otherMesh = mockMesh(), other = fixture(() => otherWait.promise);
  try {
    const pending = other.preparePlan(); other.renderer.destroy(); otherWait.resolve(otherMesh.mesh);
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(otherMesh.destroyed, 1); assert.equal(other.postUpdate.numberOfListeners, 0);
  } finally { other.close(); }
});

test('source transform changes stop this effect immediately and require regeneration even if the matrix is restored', async () => {
  const f = fixture();
  try {
    const handle = await f.preparePlan(); handle.setEnabled(true);
    f.tileset.modelMatrix = Matrix4.fromTranslation(new Cartesian3(10, 0, 0)); f.postUpdate.raiseEvent();
    assert.equal(handle.status.state, 'blocked'); assert.match(handle.status.message, /摄影位置已变化/);
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.globe.clippingPolygons.enabled, false); assert.equal(f.meshes[0].visible, false);
    f.tileset.modelMatrix = Matrix4.clone(Matrix4.IDENTITY); f.postUpdate.raiseEvent();
    assert.equal(handle.status.state, 'blocked'); assert.equal(f.tileset.clippingPolygons, undefined);
  } finally { f.close(); }
});

test('a failed mesh preparation does not change the last valid scene', async () => {
  const f = fixture();
  try {
    const old = await f.preparePlan(); old.setEnabled(true);
    const oversized = plan('b'); oversized.boundary = Array.from({ length: 513 }, (_, i) => ({ longitude: 121 + i / 10000, latitude: 31, height: 15 }));
    await assert.rejects(f.preparePlan(oversized), /预算/);
    assert.equal(f.tileset.clippingPolygons.length, 1); assert.equal(old.status.state, 'ready'); assert.equal(f.meshes.length, 1);
  } finally { f.close(); }
});

test('scene destruction releases terrain and every mesh even when clipping notification fails', async () => {
  const f = fixture(), requestRender = f.viewer.scene.requestRender;
  try {
    const a = await f.preparePlan(), b = await f.preparePlan(plan('b', 121.002));
    a.setEnabled(true); b.setEnabled(true);
    const terrain = f.globe.clippingPolygons;
    f.viewer.scene.requestRender = () => { throw new Error('injected render failure'); };
    assert.throws(() => f.renderer.destroy(), AggregateError);
    assert.equal(terrain.enabled, false); assert.equal(f.tileset.clippingPolygons, undefined);
    assert.deepEqual(f.meshes.map(mesh => mesh.destroyed), [1, 1]);
    assert.doesNotThrow(() => f.renderer.destroy());
    assert.deepEqual(f.meshes.map(mesh => mesh.destroyed), [1, 1]);
  } finally { f.viewer.scene.requestRender = requestRender; f.close(); }
});

test('a failing mesh disposer cannot prevent destruction of other prepared surfaces', async () => {
  const f = fixture();
  try {
    (await f.preparePlan()).setEnabled(true); (await f.preparePlan(plan('b', 121.002))).setEnabled(true);
    const destroyFirst = f.meshes[0].mesh.destroy;
    f.meshes[0].mesh.destroy = () => { destroyFirst(); throw new Error('first mesh release failed'); };
    assert.throws(() => f.renderer.destroy(), AggregateError);
    assert.deepEqual(f.meshes.map(mesh => mesh.destroyed), [1, 1]);
    assert.equal(f.globe.clippingPolygons.enabled, false); assert.equal(f.tileset.clippingPolygons, undefined);
  } finally { f.close(); }
});

test('individual handle deletion releases its mesh and terrain even when a clipping callback fails', async () => {
  const f = fixture(), requestRender = f.viewer.scene.requestRender;
  try {
    const handle = await f.preparePlan(); handle.setEnabled(true);
    f.viewer.scene.requestRender = () => { throw new Error('injected render failure'); };
    assert.throws(() => handle.destroy(), AggregateError);
    assert.equal(f.meshes[0].destroyed, 1); assert.equal(f.globe.clippingPolygons.enabled, false);
    assert.doesNotThrow(() => handle.destroy()); assert.equal(f.meshes[0].destroyed, 1);
  } finally { f.viewer.scene.requestRender = requestRender; f.close(); }
});

test('mesh adapter retains metric UVs and rejects malformed or excessive buffers before GPU allocation', () => {
  const converted = surfaceEditMeshGeometry(geometry.surface)!;
  assert.equal(converted.attributes.position!.values, geometry.surface.positions);
  assert.equal(converted.attributes.st!.values, geometry.surface.uvs);
  assert.equal(converted.indices, geometry.surface.indices);
  assert.throws(() => surfaceEditMeshGeometry({ ...geometry.surface, normals: new Float32Array(1) }), /属性长度/);
  const invalid = { ...geometry.surface, positions: new Float64Array(geometry.surface.positions) }; invalid.positions[0] = NaN;
  assert.throws(() => surfaceEditMeshGeometry(invalid), /无效坐标/);
  assert.throws(() => surfaceEditMeshGeometry({ ...geometry.surface, indices: new Uint32Array([0, 1, 999]) }), /越界/);
});
