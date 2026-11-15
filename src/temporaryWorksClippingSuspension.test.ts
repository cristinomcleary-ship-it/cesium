import assert from 'node:assert/strict';
import test from 'node:test';
import { Cesium3DTileset, ClippingPolygonCollection, Event, type Viewer } from 'cesium';
import { TemporaryWorksClippingManager, buildTemporaryWorksClipPolygons, type TemporaryWorksFootprint } from './temporaryWorksClipping.ts';

const footprints = (x = 120): TemporaryWorksFootprint[] => [{ outer: [
  { longitude: x, latitude: 30 }, { longitude: x + .001, latitude: 30 }, { longitude: x, latitude: 30.001 },
] }];
const count = (target: Cesium3DTileset) => target.clippingPolygons?.length;
function fixture() {
  const postUpdate = new Event(); let renders = 0, failRender = false;
  const viewer = { scene: { context: { webgl2: true }, postUpdate, requestRender() {
    if (failRender) throw new Error('render-request-injection'); renders++;
  } }, isDestroyed: () => false } as unknown as Viewer;
  const manager = new TemporaryWorksClippingManager(viewer), scope = manager.createScope('surface-edit');
  const a = new Cesium3DTileset({}), b = new Cesium3DTileset({});
  manager.upsert({ id: 'camp', tileset: a, footprints: footprints() });
  scope.upsert({ id: 'surface', tileset: b, footprints: footprints(121) });
  return { manager, scope, a, b, postUpdate, renders: () => renders, failRender: (value: boolean) => { failRender = value; },
    close() { failRender = false; scope.dispose(); manager.dispose(); for (const target of [a, b]) if (!target.isDestroyed()) target.destroy(); } };
}

test('global owner leases nest and restore latest contributors without changing desired switches', () => {
  const f = fixture();
  try {
    const owner = {}, a = f.manager.suspend(owner), a2 = f.manager.suspend(owner), b = f.manager.suspend({});
    assert.equal(f.a.clippingPolygons, undefined); assert.equal(f.b.clippingPolygons, undefined);
    f.scope.setPlanEnabled('surface', false);
    f.manager.upsert({ id: 'camp', tileset: f.b, footprints: footprints(121.1) });
    a(); a(); b(); assert.equal(f.b.clippingPolygons, undefined);
    a2(); assert.equal(f.a.clippingPolygons, undefined); assert.equal(count(f.b), 1);
    assert.equal(f.scope.getStatus('surface')?.state, 'disabled'); assert.equal(f.manager.getStatus('camp')?.state, 'active');
    f.scope.setPlanEnabled('surface', true); assert.equal(count(f.b), 2);
  } finally { f.close(); }
});

test('section and excavation target owners nest independently from global AR suspension', () => {
  const f = fixture();
  try {
    const section = {}, first = f.manager.suspendTarget(f.a, section), duplicate = f.manager.suspendTarget(f.a, section);
    const excavation = f.manager.suspendTarget(f.a, {}), ar = f.manager.suspend({});
    assert.equal(f.a.clippingPolygons, undefined); assert.equal(f.b.clippingPolygons, undefined);
    first(); duplicate(); ar(); assert.equal(f.a.clippingPolygons, undefined); assert.equal(count(f.b), 1);
    excavation(); assert.equal(count(f.a), 1);
    assert.equal(f.manager.getStatus('camp')?.state, 'active');
  } finally { f.close(); }
});

test('unknown foreign owners are unchanged through lease entry, release and disposal', () => {
  const f = fixture();
  const foreign = new ClippingPolygonCollection({ polygons: buildTemporaryWorksClipPolygons(footprints(122)), enabled: false, inverse: true });
  try {
    const ar = f.manager.suspend({}); f.a.clippingPolygons = foreign;
    const target = f.manager.suspendTarget(f.a, {}); ar(); target();
    assert.equal(f.manager.getStatus('camp')?.state, 'blocked'); assert.equal(f.a.clippingPolygons, foreign);
    f.manager.dispose(); assert.equal(f.a.clippingPolygons, foreign); assert.equal(foreign.isDestroyed(), false);
    assert.equal(foreign.enabled, false); assert.equal(foreign.inverse, true);
  } finally { f.close(); }
});

test('manager disposal invalidates old leases without disposing independent scopes or reviving removed entries', () => {
  const f = fixture();
  try {
    const target = f.manager.suspendTarget(f.b, {}), ar = f.manager.suspend({});
    f.manager.dispose(); assert.equal(f.a.clippingPolygons, undefined); assert.equal(f.b.clippingPolygons.length, 1);
    assert.equal(f.scope.getStatus('surface')?.state, 'active');
    assert.throws(() => f.manager.suspend({}), /已关闭/); assert.throws(() => f.manager.suspendTarget(f.b, {}), /已关闭/);
    f.scope.setEnabled(false); const renders = f.renders(); target(); ar(); target();
    assert.equal(f.b.clippingPolygons, undefined); assert.equal(f.scope.getStatus('surface')?.state, 'disabled'); assert.equal(f.renders(), renders);
    f.scope.setEnabled(true); assert.equal(count(f.b), 1); assert.equal(f.manager.getStatus('camp'), undefined);
  } finally { f.close(); }
});

test('failed suspension reports rollback failures and leaves no hidden suspension counter', () => {
  for (const targeted of [false, true]) {
    const f = fixture();
    try {
      f.failRender(true);
      assert.throws(() => targeted ? f.manager.suspendTarget(f.a, {}) : f.manager.suspend({}),
        error => error instanceof AggregateError && error.errors.length === 2);
      f.failRender(false); f.manager.synchronize();
      assert.equal(f.manager.getStatus('camp')?.state, 'active'); assert.equal(f.a.clippingPolygons.length, 1);
      assert.equal(f.scope.getStatus('surface')?.state, 'active');
    } finally { f.close(); }
  }
});

test('unloaded target release is harmless and does not reattach destroyed resources', () => {
  const f = fixture();
  try {
    const release = f.manager.suspendTarget(f.a, {}); f.a.destroy();
    assert.doesNotThrow(release); assert.equal(f.manager.getStatus('camp')?.state, 'blocked');
    assert.equal(f.b.clippingPolygons.length, 1); release();
  } finally { f.close(); }
});

test('scope clear and dispose release idle listeners and names even when redraw scheduling fails', () => {
  for (const operation of ['clear', 'dispose'] as const) {
    const f = fixture();
    try {
      f.manager.clear(); f.failRender(true);
      assert.throws(() => f.scope[operation](), /render-request-injection/);
      assert.equal(f.b.clippingPolygons, undefined); assert.equal(f.postUpdate.numberOfListeners, 0);
      f.failRender(false);
      if (operation === 'dispose') {
        const replacement = f.manager.createScope('surface-edit');
        replacement.upsert({ id: 'new', tileset: f.b, footprints: footprints() });
        f.scope.dispose(); assert.equal(replacement.getStatus('new')?.state, 'active'); replacement.dispose();
      } else {
        f.scope.upsert({ id: 'new', tileset: f.b, footprints: footprints() }); assert.equal(f.scope.getStatus('new')?.state, 'active');
      }
    } finally { f.close(); }
  }
});

test('manager dispose commits lifecycle cleanup before propagating redraw failure', () => {
  const f = fixture();
  try {
    f.scope.dispose(); f.failRender(true);
    assert.throws(() => f.manager.dispose(), /render-request-injection/);
    assert.equal(f.a.clippingPolygons, undefined); assert.equal(f.postUpdate.numberOfListeners, 0);
    assert.throws(() => f.manager.suspend({}), /已关闭/); assert.doesNotThrow(() => f.manager.dispose());
  } finally { f.close(); }
});
