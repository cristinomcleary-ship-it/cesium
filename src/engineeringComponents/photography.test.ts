import test from 'node:test';
import assert from 'node:assert/strict';
import { Cesium3DTileset, ClippingPolygonCollection, Event, type Viewer } from 'cesium';
import { getTemporaryWorksClippingManager } from '../temporaryWorksGlbScene.ts';
import { buildTemporaryWorksClipPolygons, type TemporaryWorksFootprint } from '../temporaryWorksClipping.ts';
import { ENGINEERING_PHOTOGRAPHY_LIMITS, EngineeringPhotographyOcclusion, type EngineeringPhotographyStatus } from './photography.ts';

const rect = (x = 121, y = 31, size = .001) => [
  { longitude: x, latitude: y }, { longitude: x + size, latitude: y },
  { longitude: x + size, latitude: y + size }, { longitude: x, latitude: y + size },
];
const footprints = (x = 121): TemporaryWorksFootprint[] => [{ outer: rect(x) }];
function fixture(onStatus?: (status: EngineeringPhotographyStatus) => void) {
  const postUpdate = new Event(); let failRequests = 0, renders = 0;
  const viewer = { scene: { context: { webgl2: true }, postUpdate,
    requestRender() { if (failRequests > 0) { failRequests--; throw new Error('injected-render-failure'); } renders++; } },
  isDestroyed: () => false } as unknown as Viewer;
  const a = new Cesium3DTileset({}), b = new Cesium3DTileset({});
  const manager = getTemporaryWorksClippingManager(viewer), states: EngineeringPhotographyStatus[] = [];
  const renderer = new EngineeringPhotographyOcclusion(viewer, { onStatus: state => { states.push(state); onStatus?.(state); } });
  return { viewer, postUpdate, a, b, manager, renderer, states, renders: () => renders,
    failNextRequest() { failRequests = 1; }, target: (id = 'a', tileset = a) => ({ id, tileset }),
    close() { failRequests = 0; renderer.dispose(); manager.dispose(); for (const value of [a, b]) if (!value.isDestroyed()) value.destroy(); } };
}

test('engineering photography shares clipping with legacy and other scopes while their switches stay independent', () => {
  const f = fixture(), other = f.manager.createScope('test-surface');
  try {
    f.manager.upsert({ id: 'camp', tileset: f.a, footprints: footprints() });
    other.upsert({ id: 'excavation', tileset: f.a, footprints: footprints(121.002) });
    f.renderer.apply(f.target(), footprints(121.004));
    assert.equal(f.a.clippingPolygons.length, 3); assert.equal(f.renderer.status.state, 'active');
    f.manager.setEnabled(false); f.postUpdate.raiseEvent();
    assert.equal(f.a.clippingPolygons.length, 2); assert.equal(f.renderer.status.state, 'active');
    f.renderer.clear(); assert.equal(f.a.clippingPolygons.length, 1); assert.equal(other.getStatus('excavation')?.state, 'active');
    f.manager.setEnabled(true); assert.equal(f.a.clippingPolygons.length, 2);
    f.renderer.apply(f.target(), footprints(121.004)); f.renderer.dispose();
    assert.equal(f.a.clippingPolygons.length, 2); assert.equal(f.manager.getStatus('camp')?.state, 'active');
  } finally { other.dispose(); f.close(); }
});

test('geometry, holes and budget rejection preserve the exact previous live collection', () => {
  const f = fixture();
  try {
    f.renderer.apply(f.target(), footprints()); const before = f.a.clippingPolygons;
    assert.throws(() => f.renderer.apply(f.target(), []), /缺少/);
    const bowtie = rect(); [bowtie[1], bowtie[2]] = [bowtie[2], bowtie[1]];
    assert.throws(() => f.renderer.apply(f.target(), [{ outer: bowtie }]), /退化|自相交/);
    assert.throws(() => f.renderer.apply(f.target(), [{ outer: rect(), holes: [rect(122)] }]), /跨度|孔洞/);
    const oversized = new Proxy(new Array(ENGINEERING_PHOTOGRAPHY_LIMITS.boundaryPoints + 1), {
      get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) throw new Error('vertices-must-not-be-read'); return Reflect.get(target, key, receiver); },
    });
    assert.throws(() => f.renderer.apply(f.target(), [{ outer: oversized }]), /超过上限/);
    assert.equal(f.a.clippingPolygons, before); assert.equal(before.isDestroyed(), false);
    assert.equal(f.renderer.status.state, 'active'); assert.equal(f.renderer.getUsage().contributors, 1);
  } finally { f.close(); }
});

test('synchronous failure after target migration restores both prior contribution and unrelated legacy', () => {
  const f = fixture();
  try {
    f.manager.upsert({ id: 'camp', tileset: f.a, footprints: footprints() });
    f.renderer.apply(f.target(), footprints(121.002));
    f.failNextRequest(); assert.throws(() => f.renderer.apply(f.target('b', f.b), footprints(122)), /injected-render-failure/);
    assert.equal(f.a.clippingPolygons.length, 2); assert.equal(f.b.clippingPolygons, undefined);
    assert.equal(f.manager.getStatus('camp')?.state, 'active'); assert.equal(f.renderer.status.state, 'active');
    assert.match(f.renderer.status.message, /（a）/); assert.equal(f.renderer.getUsage().contributors, 1);
  } finally { f.close(); }
});

test('first application synchronization failure leaves no accidental clipping contribution', () => {
  const f = fixture();
  try {
    f.failNextRequest(); assert.throws(() => f.renderer.apply(f.target(), footprints()), /injected-render-failure/);
    assert.equal(f.a.clippingPolygons, undefined); assert.equal(f.renderer.status.state, 'disabled');
    assert.equal(f.renderer.getUsage().contributors, 0); assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('rollback never overwrites a foreign owner that appeared during the failed transaction', () => {
  const f = fixture();
  const foreign = new ClippingPolygonCollection({ polygons: buildTemporaryWorksClipPolygons(footprints(122)), inverse: true });
  const request = f.viewer.scene.requestRender;
  try {
    f.renderer.apply(f.target(), footprints());
    f.viewer.scene.requestRender = () => {
      f.viewer.scene.requestRender = request; f.a.clippingPolygons = foreign;
      throw new Error('foreign-during-render-failure');
    };
    assert.throws(() => f.renderer.apply(f.target('b', f.b), footprints(122)), /foreign-during-render-failure/);
    assert.equal(f.a.clippingPolygons, foreign); assert.equal(foreign.isDestroyed(), false); assert.equal(foreign.inverse, true);
    assert.equal(f.b.clippingPolygons, undefined); assert.equal(f.renderer.status.state, 'blocked');
    f.renderer.dispose(); assert.equal(f.a.clippingPolygons, foreign); assert.equal(foreign.isDestroyed(), false);
  } finally { f.viewer.scene.requestRender = request; f.close(); }
});

test('saved geometry is immutable across caller mutation and later rollback', () => {
  const f = fixture(), source = footprints();
  try {
    f.renderer.apply(f.target(), source);
    const positions = f.a.clippingPolygons.get(0).positions.map(value => ({ x: value.x, y: value.y, z: value.z }));
    source[0].outer[0].longitude = NaN;
    f.failNextRequest(); assert.throws(() => f.renderer.apply(f.target(), footprints(122)), /injected-render-failure/);
    assert.deepEqual(f.a.clippingPolygons.get(0).positions.map(value => ({ x: value.x, y: value.y, z: value.z })), positions);
  } finally { f.close(); }
});

test('independent pause, AR and section leases retain and restore the latest desired engineering geometry', () => {
  const f = fixture();
  try {
    f.renderer.apply(f.target(), footprints()); f.renderer.setSuspended(true);
    assert.equal(f.a.clippingPolygons, undefined); assert.equal(f.renderer.status.state, 'suspended');
    f.renderer.apply(f.target(), footprints(121.002)); assert.equal(f.a.clippingPolygons, undefined);
    const ar = f.manager.suspend({}), section = f.manager.suspendTarget(f.a, {});
    f.renderer.setSuspended(false); assert.equal(f.renderer.status.state, 'blocked');
    ar(); f.postUpdate.raiseEvent(); assert.equal(f.renderer.status.state, 'blocked');
    section(); f.postUpdate.raiseEvent(); assert.equal(f.renderer.status.state, 'active');
    const expected = buildTemporaryWorksClipPolygons(footprints(121.002));
    assert.deepEqual((f.a.clippingPolygons as ClippingPolygonCollection).get(0).positions, expected[0].positions);
  } finally { f.close(); }
});

test('foreign clipping stays untouched and statuses update in the same manager frame', () => {
  const f = fixture();
  const foreign = new ClippingPolygonCollection({ polygons: buildTemporaryWorksClipPolygons(footprints(122)), inverse: true, enabled: false });
  try {
    f.renderer.apply(f.target(), footprints()); f.a.clippingPolygons = foreign; f.postUpdate.raiseEvent();
    assert.equal(f.renderer.status.state, 'blocked'); assert.equal(f.a.clippingPolygons, foreign);
    assert.equal(foreign.isDestroyed(), false); assert.equal(foreign.inverse, true); assert.equal(foreign.enabled, false);
    f.renderer.dispose(); assert.equal(f.a.clippingPolygons, foreign); assert.equal(foreign.isDestroyed(), false);
  } finally { f.close(); }
});

test('changing to a blocked target withdraws the old request and reports pending until target ownership is released', () => {
  const f = fixture();
  try {
    f.renderer.apply(f.target(), footprints());
    const release = f.manager.suspendTarget(f.b, {});
    f.renderer.apply(f.target('b', f.b), footprints(122));
    assert.equal(f.a.clippingPolygons, undefined); assert.equal(f.b.clippingPolygons, undefined);
    assert.equal(f.renderer.status.state, 'blocked'); assert.equal(f.renderer.getUsage().contributors, 1);
    release(); f.postUpdate.raiseEvent(); assert.equal(f.renderer.status.state, 'active'); assert.equal((f.b.clippingPolygons as ClippingPolygonCollection).length, 1);
  } finally { f.close(); }
});

test('deleted targets are reported and can be replaced without disposing the shared manager', () => {
  const f = fixture();
  try {
    f.renderer.apply(f.target(), footprints()); f.a.destroy(); f.postUpdate.raiseEvent();
    assert.equal(f.renderer.status.state, 'blocked'); assert.match(f.renderer.status.message, /卸载/);
    assert.throws(() => f.renderer.apply(f.target(), footprints()), /卸载/);
    f.renderer.apply(f.target('b', f.b), footprints(122)); assert.equal(f.renderer.status.state, 'active');
    f.renderer.clear(); assert.equal(f.b.clippingPolygons, undefined); assert.equal(f.postUpdate.numberOfListeners, 0);
    f.manager.upsert({ id: 'camp', tileset: f.b, footprints: footprints(122) });
    assert.equal(f.manager.getStatus('camp')?.state, 'active');
  } finally { f.close(); }
});

test('hidden photograph target and external model visibility have no contribution gate', () => {
  const f = fixture();
  try {
    f.a.show = false; f.renderer.apply(f.target(), footprints());
    assert.equal(f.renderer.status.state, 'active'); assert.equal(f.a.clippingPolygons.length, 1);
    f.a.show = true; f.postUpdate.raiseEvent(); assert.equal(f.a.clippingPolygons.length, 1);
  } finally { f.close(); }
});

test('real holes survive compilation and clean frames allocate no collection or duplicate status notification', () => {
  const f = fixture();
  try {
    assert.equal(f.postUpdate.numberOfListeners, 0);
    f.renderer.apply(f.target(), [{ outer: rect(), holes: [rect(121.0002, 31.0002, .0002)] }]);
    assert.equal(f.a.clippingPolygons.length, 8); assert.equal(f.renderer.getUsage().polygons, 8);
    const collection = f.a.clippingPolygons, count = f.states.length, renders = f.renders();
    for (let i = 0; i < 20; i++) f.postUpdate.raiseEvent();
    assert.equal(f.a.clippingPolygons, collection); assert.equal(f.states.length, count); assert.equal(f.renders(), renders);
    const status = f.renderer.status; status.state = 'forged'; assert.equal(f.renderer.status.state, 'active');
    f.renderer.clear(); assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('status observer failure cannot roll back accepted clipping and disposal is idempotent', () => {
  const original = console.warn, warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  const f = fixture(() => { throw new Error('observer-failure'); });
  try {
    assert.doesNotThrow(() => f.renderer.apply(f.target(), footprints()));
    assert.equal(f.renderer.status.state, 'active'); assert.equal(f.a.clippingPolygons.length, 1); assert.equal(warnings.length, 1);
    f.renderer.dispose(); f.renderer.dispose(); f.renderer.clear(); f.renderer.setSuspended(false);
    assert.equal(f.renderer.status.state, 'disposed'); assert.equal(f.a.clippingPolygons, undefined);
    assert.throws(() => f.renderer.apply(f.target(), footprints()), /已关闭/);
    assert.equal(f.postUpdate.numberOfListeners, 0);
  } finally { f.close(); console.warn = original; }
});

test('clear and disposal finish their lifecycle even when Cesium redraw notification fails', () => {
  const f = fixture();
  try {
    f.renderer.apply(f.target(), footprints()); f.failNextRequest();
    assert.throws(() => f.renderer.clear(), /injected-render-failure/);
    assert.equal(f.renderer.status.state, 'disabled'); assert.equal(f.a.clippingPolygons, undefined);
    assert.equal(f.postUpdate.numberOfListeners, 0); assert.equal(f.renderer.getUsage().contributors, 0);
    f.renderer.apply(f.target(), footprints()); f.failNextRequest();
    assert.throws(() => f.renderer.dispose(), /injected-render-failure/);
    assert.equal(f.renderer.status.state, 'disposed'); assert.equal(f.a.clippingPolygons, undefined);
    assert.equal(f.postUpdate.numberOfListeners, 0); assert.throws(() => f.renderer.apply(f.target(), footprints()), /已关闭/);
  } finally { f.close(); }
});
