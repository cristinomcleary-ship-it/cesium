import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundingSphere, Cartesian3, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection, Event, type Viewer } from 'cesium';
import { attachTemporaryWorksSurfaceClipping, buildHardeningSurfaceBatch, checkDesignedSurfaceClippingBudget, type TemporaryWorksSurfaceOptions } from './temporaryWorksSurfaceScene.ts';

const vertices = [
  { longitude: 121, latitude: 31, surfaceHeight: 10, baseHeight: 9.8 },
  { longitude: 121.001, latitude: 31, surfaceHeight: 10, baseHeight: 9.8 },
  { longitude: 121.001, latitude: 31.001, surfaceHeight: 10, baseHeight: 9.8 },
  { longitude: 121, latitude: 31.001, surfaceHeight: 10, baseHeight: 9.8 },
];
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const postUpdate = new Event();
  let viewerDestroyed = false;
  const viewer = { scene: { context: { webgl2: true }, postUpdate, requestRender() {} }, isDestroyed: () => viewerDestroyed } as unknown as Viewer;
  const tileset = new Cesium3DTileset({}), other = new Cesium3DTileset({});
  const handles: ReturnType<typeof attachTemporaryWorksSurfaceClipping>[] = [];
  function render(ready = Promise.resolve(), id = 'saved') {
    let destroyCalls = 0;
    const mesh = { ready, show: true, xray: false, bounds: new BoundingSphere(), yard: { flag: false, spaces: 0 },
      standardPlacement: undefined, hasStructure: false, builtStructureCount: 0, structureBuilt: [], zoom() {},
      destroy() { destroyCalls++; }, get destroyCalls() { return destroyCalls; } };
    const options: TemporaryWorksSurfaceOptions = { id, kind: 'hardening', vertices, triangles: [[0, 1, 2], [0, 2, 3]],
      footprints: [{ outer: vertices }], tileset, clippingEnabled: true };
    const handle = attachTemporaryWorksSurfaceClipping(viewer, mesh, options);
    handles.push(handle); return { handle, mesh };
  }
  return { viewer, tileset, other, postUpdate, render, destroyViewer: () => { viewerDestroyed = true; }, close() {
    handles.forEach(h => h.destroy());
    if (!tileset.isDestroyed()) tileset.destroy(); if (!other.isDestroyed()) other.destroy();
  } };
}

test('design clipping waits for prepared geometry and honours visibility changes during preparation', async () => {
  const f = fixture(), d = deferred();
  try {
    const { handle, mesh } = f.render(d.promise);
    assert.equal(f.tileset.clippingPolygons, undefined);
    handle.show = false; d.resolve(); await handle.ready;
    assert.equal(mesh.show, false); assert.equal(handle.status.state, 'hidden');
    assert.equal(f.tileset.clippingPolygons, undefined);
    handle.show = true;
    assert.equal(mesh.show, true); assert.equal(handle.status.state, 'ready');
    assert.equal((f.tileset.clippingPolygons as import('cesium').ClippingPolygonCollection | undefined)?.length, 1);
  } finally { f.close(); }
});

test('turning off clipping leaves the surface visible and leaves another owner intact', async () => {
  const f = fixture();
  try {
    const a = f.render(), b = f.render(); await Promise.all([a.handle.ready, b.handle.ready]);
    assert.equal(f.tileset.clippingPolygons.length, 2);
    a.handle.setClippingEnabled(false);
    assert.equal(a.mesh.show, true); assert.equal(a.handle.status.state, 'disabled');
    assert.equal(f.tileset.clippingPolygons.length, 1);
    a.handle.destroy(); assert.equal(f.tileset.clippingPolygons.length, 1);
    b.handle.destroy(); assert.equal(f.tileset.clippingPolygons, undefined);
    assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('cancelled or failed candidates cannot leave photography holes or supersede a saved owner', async () => {
  const f = fixture(), pending = deferred(), failed = deferred();
  try {
    const old = f.render(); await old.handle.ready;
    const a = f.render(pending.promise); a.handle.destroy(); pending.resolve(); await a.handle.ready;
    assert.equal(a.mesh.destroyCalls, 1); assert.equal(f.tileset.clippingPolygons.length, 1);
    const b = f.render(failed.promise); failed.reject(new Error('upload failed'));
    await assert.rejects(b.handle.ready, /upload failed/);
    assert.equal(b.handle.status.state, 'error'); assert.equal(b.mesh.destroyCalls, 1);
    assert.equal(f.tileset.clippingPolygons.length, 1);
  } finally { f.close(); }
});

test('the final tileset association wins during loading and foreign clipping is never replaced', async () => {
  const f = fixture(), d = deferred();
  const foreign = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 0)] });
  try {
    const a = f.render(d.promise); a.handle.setTileset(f.other); d.resolve(); await a.handle.ready;
    assert.equal(f.tileset.clippingPolygons, undefined); assert.equal(f.other.clippingPolygons.length, 1);
    f.other.clippingPlanes = foreign; f.postUpdate.raiseEvent();
    assert.equal(a.handle.status.state, 'blocked'); assert.equal(f.other.clippingPlanes, foreign);
    a.handle.destroy(); assert.equal(f.other.clippingPlanes, foreign); assert.equal(foreign.isDestroyed(), false);
    assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('fully covered hardening contributes no redundant clipping even with a source footprint', async () => {
  const f = fixture();
  const mesh = { ready: Promise.resolve(), show: true, xray: false, bounds: new BoundingSphere(), yard: { flag: false, spaces: 0 },
    standardPlacement: undefined, hasStructure: false, builtStructureCount: 0, structureBuilt: [], zoom() {}, destroy() {} };
  try {
    const handle = attachTemporaryWorksSurfaceClipping(f.viewer, mesh, { id: 'covered', kind: 'hardening', vertices: [], triangles: [], footprints: [{ outer: vertices }], tileset: f.tileset });
    await handle.ready; assert.equal(handle.status.state, 'covered'); assert.equal(f.tileset.clippingPolygons, undefined);
    handle.destroy();
  } finally { f.close(); }
});

test('explicit side intervals produce only their requested wall, with no automatic shared boundary duplication', () => {
  const top = buildHardeningSurfaceBatch(vertices, [[0, 1, 2], [0, 2, 3]], []);
  assert.equal(top.instances.length, 2);
  const wall = buildHardeningSurfaceBatch([], [], [{ a: { ...vertices[0], surfaceHeight: 9.9, baseHeight: 9.8 }, b: { ...vertices[1], surfaceHeight: 9.9, baseHeight: 9.8 } }]);
  assert.equal(wall.instances.length, 1);
  const geometry = wall.instances[0].geometry as import('cesium').Geometry;
  assert.equal(geometry.indices!.length, 6);
  assert.equal(geometry.attributes.position!.values.length, 12);
});

test('concrete UV remains continuous between batches when given one stable texture origin', () => {
  const a = buildHardeningSurfaceBatch(vertices.slice(0, 3), [[0, 1, 2]], [], vertices[0]);
  const b = buildHardeningSurfaceBatch([vertices[2], vertices[3], vertices[0]], [[0, 1, 2]], [], vertices[0]);
  const uv = (batch: typeof a) => ((batch.instances[0].geometry as import('cesium').Geometry).attributes as unknown as { twSurface: { values: Float32Array } }).twSurface.values;
  assert.equal(uv(a)[6], uv(b)[0]); assert.equal(uv(a)[7], uv(b)[1]);
});

test('viewer teardown during preparation settles and destroys the design mesh without activating clipping', async () => {
  const f = fixture(), d = deferred();
  try {
    const a = f.render(d.promise); f.destroyViewer(); d.resolve(); await a.handle.ready;
    assert.equal(a.mesh.destroyCalls, 1); assert.equal(f.tileset.clippingPolygons, undefined);
  } finally { f.close(); }
});

test('normal long-route outlines pass a separate clipping-work budget without adding sample points', () => {
  const outer = Array.from({ length: 400 }, (_, i) => ({ longitude: 121 + Math.cos(i * Math.PI / 200) * .001, latitude: 31 + Math.sin(i * Math.PI / 200) * .001 }));
  const report = checkDesignedSurfaceClippingBudget([{ outer }]);
  assert.equal(report.boundaryPoints, 400); assert.equal(report.polygons, 1);
  assert.equal(report.topologyChecks, 79400);
});

test('very dense rings and many hole triangles are rejected before synchronous topology work', () => {
  const outer = Array.from({ length: 50000 }, () => vertices[0]);
  assert.throws(() => checkDesignedSurfaceClippingBudget([{ outer }]), /轮廓过于复杂/);
  const holes = Array.from({ length: 500 }, () => vertices);
  assert.throws(() => checkDesignedSurfaceClippingBudget([{ outer: vertices, holes }]), /轮廓过于复杂/);
});

test('a clipping budget rejection preserves photography and every other owner while leaving a diagnostic surface', async () => {
  const f = fixture();
  const mesh = { ready: Promise.resolve(), show: true, xray: false, bounds: new BoundingSphere(), yard: { flag: false, spaces: 0 },
    standardPlacement: undefined, hasStructure: false, builtStructureCount: 0, structureBuilt: [], zoom() {}, destroy() {} };
  try {
    const existing = f.render(); await existing.handle.ready;
    const rejected = attachTemporaryWorksSurfaceClipping(f.viewer, mesh, { id: 'complex', kind: 'hardening', vertices, triangles: [[0, 1, 2]],
      footprints: [{ outer: Array.from({ length: 50000 }, () => vertices[0]) }], tileset: f.tileset });
    await rejected.ready;
    assert.equal(rejected.status.state, 'blocked'); assert.equal(mesh.show, true);
    assert.equal(f.tileset.clippingPolygons.length, 1, 'oversized new owner cannot replace or duplicate existing clipping');
    rejected.destroy(); assert.equal(f.tileset.clippingPolygons.length, 1);
  } finally { f.close(); }
});
