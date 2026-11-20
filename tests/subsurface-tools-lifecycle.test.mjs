import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Cartesian3, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection, ClippingPolygon,
  ClippingPolygonCollection, DataSourceCollection, Event as CesiumEvent, Matrix4, Model, Transforms,
} from 'cesium';
import { SubsurfaceTools } from '../src/subsurfaceTools.ts';
import { getTemporaryWorksClippingManager } from '../src/temporaryWorksGlbScene.ts';
import { assertVideoOverlayOccluder } from '../src/videoOverlayOcclusion.ts';

const positions = (x = 120) => [Cartesian3.fromDegrees(x, 30), Cartesian3.fromDegrees(x + .001, 30), Cartesian3.fromDegrees(x, 30.001)];
const footprint = [{ outer: [{ longitude: 120, latitude: 30 }, { longitude: 120.001, latitude: 30 }, { longitude: 120, latitude: 30.001 }] }];
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
class Element extends EventTarget {
  value = ''; checked = false; files = []; innerHTML = ''; textContent = ''; dataset = {}; disableRootEvents = true;
  classes = new Set(); classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value),
    contains: value => this.classes.has(value), toggle: value => this.classes.has(value) ? this.classes.delete(value) : this.classes.add(value) };
  querySelectorAll() { return []; } scrollTo() {} getBoundingClientRect() { return { left: 0, top: 0 }; }
}
function fixture({ delayedArchives = false, globePolygons } = {}) {
  const previousDocument = globalThis.document, previousIndexedDB = globalThis.indexedDB;
  const nodes = new Map(), node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const doc = Object.assign(new EventTarget(), { querySelector: node, querySelectorAll: () => [], onmousewheel: undefined });
  globalThis.document = doc;
  const archiveOpens = []; let databaseCloses = 0, archiveReads = 0;
  const database = { close() { databaseCloses++; }, transaction() { return { objectStore() { return { getAll() {
    archiveReads++; const request = { result: [] }; queueMicrotask(() => request.onsuccess?.()); return request;
  } }; } }; } };
  globalThis.indexedDB = { open() { const request = { result: database }; archiveOpens.push(request);
    if (!delayedArchives) queueMicrotask(() => request.onsuccess?.()); return request; } };
  node('#sectionDirection').value = 'northSouth'; node('#sectionOffset').value = '0'; node('#groundAlpha').value = '.35';
  node('#excavationMode').value = 'vertical'; node('#excavationDepth').value = '5';
  const preUpdate = new CesiumEvent(), postUpdate = new CesiumEvent(), dataSources = new DataSourceCollection();
  const globe = { translucency: { enabled: false, frontFaceAlpha: 1, backFaceAlpha: 1 }, depthTestAgainstTerrain: true };
  for (const [key, Collection] of [['clippingPlanes', ClippingPlaneCollection], ['clippingPolygons', ClippingPolygonCollection]]) {
    Object.defineProperty(globe, key, { get() { return this['_' + key]; }, set(value) { Collection.setOwner(value, this, '_' + key); } });
  }
  if (globePolygons) globe.clippingPolygons = globePolygons;
  let renders = 0, destroyed = false, imports = [];
  const viewer = { dataSources, scene: { globe, context: { webgl2: true }, canvas: new Element(), preUpdate, postUpdate,
    screenSpaceCameraController: { enableCollisionDetection: true }, requestRender() { renders++; } }, isDestroyed: () => destroyed };
  const notifications = [], tools = new SubsurfaceTools(viewer, () => imports, (message, error) => notifications.push({ message, error }));
  const manager = getTemporaryWorksClippingManager(viewer), targets = [];
  const addTileset = (id = 'photo') => {
    const target = new Cesium3DTileset({}); target._root = { transform: Transforms.eastNorthUpToFixedFrame(positions()[0]), children: [] };
    targets.push(target); const item = { id, kind: '3D Tiles', resource: target }; imports.push(item); return item;
  };
  const addModel = () => {
    const target = Object.assign(Object.create(Model.prototype), { modelMatrix: Matrix4.clone(Matrix4.IDENTITY), _drawCommandsBuilt: true });
    const item = { id: 'model', kind: 'Model', resource: target }; imports.push(item); targets.push(target); return item;
  };
  function activate({ section = true, excavation = true } = {}) {
    tools.sectionAnchor = positions()[0]; tools.excavationPoints = positions(); tools.excavationFinished = true;
    node('#sectionEnabled').checked = section; node('#clipExcavationSurface').checked = excavation;
    tools.refreshClipping(); preUpdate.raiseEvent(viewer.scene);
  }
  return { tools, viewer, manager, globe, node, preUpdate, postUpdate, dataSources, notifications, addTileset, addModel, activate,
    renders: () => renders, setImports: next => { imports = next; }, setDestroyed: () => { destroyed = true; },
    archiveOpens, archiveReads: () => archiveReads, databaseCloses: () => databaseCloses,
    close() {
      tools.dispose(); manager.dispose();
      for (const target of targets) {
        if (target instanceof Cesium3DTileset) { if (!target.isDestroyed()) { target._root = undefined; target.destroy(); } }
        else for (const key of ['clippingPlanes', 'clippingPolygons']) { const value = target[key]; if (value && !value.isDestroyed()) target[key] = undefined; }
      }
      for (const key of ['clippingPlanes', 'clippingPolygons']) if (globe[key]) globe[key] = undefined;
      globalThis.document = previousDocument; globalThis.indexedDB = previousIndexedDB;
    } };
}

test('real constructor, nested effects suspension and current parameters restore fresh clipping and ground state', async () => {
  const f = fixture();
  try {
    const { resource: photo } = f.addTileset(); const { resource: model } = f.addModel(); f.activate(); await flush();
    const oldPlane = photo.clippingPlanes, oldPolygon = photo.clippingPolygons;
    f.node('#groundTransparent').checked = true; f.node('#undergroundMode').checked = true;
    f.node('#groundTransparent').dispatchEvent(new Event('change'));
    assert.equal(f.globe.translucency.enabled, true); assert.equal(f.viewer.scene.screenSpaceCameraController.enableCollisionDetection, false);
    const first = f.tools.suspendExternalSceneEffects(), second = f.tools.suspendExternalSceneEffects();
    assert.equal(f.tools.interactionSuspensionDepth, 1); assert.equal(f.tools.overlay.show, false);
    for (const target of [photo, model, f.globe]) assert.equal(target.clippingPlanes, undefined);
    for (const target of [photo, model]) assert.equal(target.clippingPolygons, undefined);
    assert.equal(oldPlane.isDestroyed(), true); assert.equal(oldPolygon.isDestroyed(), true);
    assert.doesNotThrow(() => assertVideoOverlayOccluder(photo));
    assert.equal(f.globe.translucency.enabled, false); assert.equal(f.viewer.scene.screenSpaceCameraController.enableCollisionDetection, true);
    f.node('#sectionOffset').value = '29'; f.node('#sectionOffset').dispatchEvent(new Event('input'));
    f.node('#groundAlpha').value = '.65'; f.node('#groundAlpha').dispatchEvent(new Event('input'));
    f.preUpdate.raiseEvent(f.viewer.scene); assert.equal(photo.clippingPlanes, undefined);
    first(); first(); assert.equal(photo.clippingPolygons, undefined); assert.equal(f.tools.interactionSuspensionDepth, 1);
    second(); f.preUpdate.raiseEvent(f.viewer.scene);
    assert.equal(f.tools.interactionSuspensionDepth, 0); assert.equal(f.tools.overlay.show, true);
    assert.notEqual(photo.clippingPlanes, oldPlane); assert.equal(photo.clippingPlanes.get(0).distance, -29);
    assert.notEqual(photo.clippingPolygons, oldPolygon); assert.equal(photo.clippingPolygons.enabled, true);
    assert.equal(f.globe.translucency.frontFaceAlpha, .65); assert.equal(f.globe.depthTestAgainstTerrain, false);
    assert.equal(f.dataSources.length, 1);
  } finally { f.close(); }
});

test('old section and excavation take independent target leases and closing both restores managed contributions without reload', () => {
  const f = fixture();
  try {
    const { resource: photo } = f.addTileset();
    f.manager.upsert({ id: 'camp', tileset: photo, footprints: footprint }); const initial = photo.clippingPolygons;
    f.activate(); assert.equal(initial.isDestroyed(), true); assert.equal(f.manager.getStatus('camp').state, 'blocked');
    f.node('#sectionEnabled').checked = false; f.tools.refreshClipping();
    assert.equal(photo.clippingPlanes, undefined); assert.equal(f.manager.getStatus('camp').state, 'blocked');
    f.node('#clipExcavationSurface').checked = false; f.tools.refreshClipping();
    assert.equal(f.manager.getStatus('camp').state, 'active'); assert.notEqual(photo.clippingPolygons, initial);
    assert.equal(f.tools.sectionTargetLeases.size, 0); assert.equal(f.tools.excavationTargetLeases.size, 0);
    assert.equal(photo.clippingPolygons.length, 1);
  } finally { f.close(); }
});

test('pause keeps leases until last release, honors disabled controls and never reattaches removed or destroyed imports', () => {
  const f = fixture();
  try {
    const a = f.addTileset('a'), b = f.addTileset('b'); f.activate();
    const release = f.tools.suspendExternalSceneEffects();
    f.tools.detachImport(a); a.resource._root = undefined; a.resource.destroy();
    f.setImports([b]); f.node('#sectionEnabled').checked = false; f.node('#clipExcavationSurface').checked = false;
    f.tools.refreshClipping(); release(); f.preUpdate.raiseEvent(f.viewer.scene);
    assert.equal(a.resource.isDestroyed(), true); assert.equal(b.resource.clippingPlanes, undefined); assert.equal(b.resource.clippingPolygons, undefined);
    assert.equal(f.tools.clippingTargets.size, 0); assert.equal(f.tools.excavationClipTargets.size, 0);
    assert.equal(f.tools.sectionTargetLeases.size, 0); assert.equal(f.tools.excavationTargetLeases.size, 0);
  } finally { f.close(); }
});

test('removed targets are pruned on resume even when importer omitted detachImport', () => {
  const f = fixture();
  try {
    const removed = f.addTileset(); f.activate(); const release = f.tools.suspendExternalSceneEffects();
    f.setImports([]); release(); f.preUpdate.raiseEvent(f.viewer.scene);
    assert.equal(removed.resource.clippingPolygons, undefined); assert.equal(removed.resource.clippingPlanes, undefined);
    assert.equal(f.tools.sectionTargetLeases.size, 0); assert.equal(f.tools.excavationTargetLeases.size, 0);
  } finally { f.close(); }
});

test('unknown polygon replacements survive refresh, suspension, close and disposal', () => {
  const f = fixture();
  try {
    const { resource: photo } = f.addTileset(); f.activate({ section: false });
    const foreign = new ClippingPolygonCollection({ polygons: [new ClippingPolygon({ positions: positions(121) })] });
    photo.clippingPolygons = foreign;
    assert.throws(() => f.tools.refreshClipping(), /其他功能/);
    const release = f.tools.suspendExternalSceneEffects(); assert.equal(photo.clippingPolygons, foreign);
    f.node('#clipExcavationSurface').checked = false; release(); f.tools.dispose();
    assert.equal(photo.clippingPolygons, foreign); assert.equal(foreign.enabled, true); assert.equal(foreign.isDestroyed(), false);
  } finally { f.close(); }
});

test('constructor and disposal never disable or destroy a foreign globe polygon owner', () => {
  const foreign = new ClippingPolygonCollection({ polygons: [new ClippingPolygon({ positions: positions() })] });
  const f = fixture({ globePolygons: foreign });
  try {
    assert.equal(f.globe.clippingPolygons, foreign); assert.equal(foreign.enabled, true);
    const release = f.tools.suspendExternalSceneEffects(); release(); f.tools.dispose();
    assert.equal(f.globe.clippingPolygons, foreign); assert.equal(foreign.enabled, true); assert.equal(foreign.isDestroyed(), false);
  } finally { f.close(); }
});

test('an unknown plane owner blocks only the attempted cut and survives deferred failure cleanup', () => {
  const f = fixture();
  try {
    const { resource: photo } = f.addTileset();
    const foreign = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_Z, 43)] }); photo.clippingPlanes = foreign;
    f.activate({ excavation: false });
    assert.equal(photo.clippingPlanes, foreign); assert.equal(foreign.get(0).distance, 43); assert.equal(foreign.enabled, true);
    assert.ok(f.notifications.some(value => value.error && /其他功能/.test(value.message)));
    assert.equal(f.tools.sectionTargetLeases.size, 0);
    f.tools.dispose(); assert.equal(photo.clippingPlanes, foreign); assert.equal(foreign.isDestroyed(), false);
  } finally { f.close(); }
});

test('borrowed section and excavation aliases are released before destroying exact owned collections', () => {
  const f = fixture();
  try {
    const { resource: photo } = f.addTileset(); f.activate();
    const borrower = { _clippingPlanes: photo.clippingPlanes, _clippingPolygons: photo.clippingPolygons, resets: 0,
      resetDrawCommands() { this.resets++; } };
    photo.root.content = { innerContents: [{ _model: borrower }] };
    const release = f.tools.suspendExternalSceneEffects();
    assert.equal(borrower._clippingPlanes, undefined); assert.equal(borrower._clippingPolygons, undefined); assert.equal(borrower.resets, 2);
    assert.equal(photo.root.clippingPlanesDirty, true); assert.equal(photo.root.clippingPolygonsDirty, true);
    f.tools.dispose(); assert.doesNotThrow(release); assert.equal(photo.clippingPolygons, undefined);
  } finally { f.close(); }
});

test('suspension failure rolls back its counters and surfaces both initial and rollback failures', () => {
  const f = fixture();
  try {
    f.addTileset(); f.activate(); const original = f.tools.clearExcavationClipping;
    f.tools.clearExcavationClipping = () => { throw new Error('pause injection'); };
    assert.throws(() => f.tools.suspendExternalSceneEffects(), /pause injection/);
    assert.equal(f.tools.effectsSuspensions, 0); assert.equal(f.tools.interactionSuspensionDepth, 0); assert.equal(f.tools.overlay.show, true);
    f.tools.clearExcavationClipping = original; f.preUpdate.raiseEvent(f.viewer.scene);
    f.tools.clearExcavationClipping = () => { throw new Error('pause injection'); };
    const refresh = f.tools.refreshClipping; f.tools.refreshClipping = () => { throw new Error('rollback injection'); };
    assert.throws(() => f.tools.suspendExternalSceneEffects(), error => error instanceof AggregateError && error.errors.length === 2);
    f.tools.clearExcavationClipping = original; f.tools.refreshClipping = refresh;
  } finally { f.close(); }
});

test('a failing ownership setter retains exact ownership proof so rollback and retry can recover', () => {
  const f = fixture();
  try {
    const { resource: photo } = f.addTileset(); f.activate({ section: false }); const owned = photo.clippingPolygons;
    const descriptor = Object.getOwnPropertyDescriptor(Cesium3DTileset.prototype, 'clippingPolygons'); let rejectDetach = true;
    Object.defineProperty(photo, 'clippingPolygons', { configurable: true, get() { return descriptor.get.call(this); },
      set(value) { if (rejectDetach && value === undefined) throw new Error('detach injection'); descriptor.set.call(this, value); } });
    assert.throws(() => f.tools.suspendExternalSceneEffects(), /detach injection/);
    assert.equal(f.tools.excavationClipTargets.get(photo), owned); assert.equal(photo.clippingPolygons, owned);
    assert.equal(owned.enabled, true); assert.equal(f.tools.effectsSuspensions, 0); assert.equal(f.tools.interactionSuspensionDepth, 0);
    rejectDetach = false; f.node('#clipExcavationSurface').checked = false; f.tools.refreshClipping();
    assert.equal(photo.clippingPolygons, undefined); assert.equal(owned.isDestroyed(), true); assert.equal(f.tools.excavationClipTargets.size, 0);
  } finally { f.close(); }
});

test('authorization/context refresh prunes target leases during suspension without erasing the global draft', () => {
  const f = fixture();
  try {
    const item = f.addTileset(); f.activate(); const boundary = f.tools.excavationPoints, anchor = f.tools.sectionAnchor;
    const release = f.tools.suspendExternalSceneEffects(); f.setImports([]); f.tools.refreshClipping();
    assert.equal(f.tools.sectionTargetLeases.size, 0); assert.equal(f.tools.excavationTargetLeases.size, 0);
    release(); f.preUpdate.raiseEvent(f.viewer.scene);
    assert.equal(item.resource.clippingPlanes, undefined); assert.equal(item.resource.clippingPolygons, undefined);
    assert.equal(f.tools.excavationPoints, boundary); assert.equal(f.tools.sectionAnchor, anchor);
    assert.equal(f.node('#sectionEnabled').checked, true); assert.equal(f.node('#clipExcavationSurface').checked, true);
  } finally { f.close(); }
});

test('detachImport continues other cleanup after one owner fails and retains the failed owner for retry', () => {
  const f = fixture();
  try {
    const item = f.addTileset(); f.activate(); const photo = item.resource, plane = photo.clippingPlanes, polygon = photo.clippingPolygons;
    const descriptor = Object.getOwnPropertyDescriptor(Cesium3DTileset.prototype, 'clippingPlanes'); let rejectDetach = true;
    Object.defineProperty(photo, 'clippingPlanes', { configurable: true, get() { return descriptor.get.call(this); },
      set(value) { if (rejectDetach && value === undefined) throw new Error('plane detach injection'); descriptor.set.call(this, value); } });
    assert.throws(() => f.tools.detachImport(item), error => error instanceof AggregateError);
    assert.equal(photo.clippingPolygons, undefined); assert.equal(polygon.isDestroyed(), true);
    assert.equal(f.tools.clippingTargets.get(photo), plane); assert.equal(f.tools.sectionTargetLeases.size, 0); assert.equal(f.tools.excavationTargetLeases.size, 0);
    rejectDetach = false; f.tools.detachImport(item); assert.equal(photo.clippingPlanes, undefined); assert.equal(plane.isDestroyed(), true);
  } finally { f.close(); }
});

test('dispose removes real DOM/map handlers, pending updates, subscribers and late archive results', async () => {
  const f = fixture({ delayedArchives: true });
  try {
    const { resource: photo } = f.addTileset();
    f.tools.sectionAnchor = positions()[0]; f.node('#sectionEnabled').checked = true; f.tools.refreshClipping();
    assert.equal(f.preUpdate.numberOfListeners, 1);
    let archiveNotifications = 0; f.tools.subscribeArchiveOverview(() => archiveNotifications++);
    f.tools.dispose(); f.tools.dispose();
    assert.equal(f.preUpdate.numberOfListeners, 0); assert.equal(f.tools.handler.isDestroyed(), true);
    f.node('#openSubsurfacePanel').dispatchEvent(new Event('click'));
    assert.equal(f.node('#subsurfacePanel').classList.contains('hidden'), false, 'disposed DOM callback must not run');
    f.node('#sectionEnabled').dispatchEvent(new Event('change')); f.preUpdate.raiseEvent(f.viewer.scene);
    assert.equal(photo.clippingPlanes, undefined); assert.equal(f.tools.archiveOverviewListeners.size, 0);
    for (const request of f.archiveOpens) request.onsuccess(); await flush();
    assert.equal(f.databaseCloses(), 1); assert.equal(archiveNotifications, 0); assert.deepEqual(f.tools.records, []);
    assert.equal(f.node('#hiddenWorkList').innerHTML, ''); assert.equal(f.dataSources.length, 0);
  } finally { f.close(); }
});

test('dispose during photo reading prevents a later archive write or UI mutation', async () => {
  const previousReader = globalThis.FileReader, readers = [], f = fixture();
  globalThis.FileReader = class { readAsDataURL() { readers.push(this); } };
  try {
    await flush(); const opens = f.archiveOpens.length;
    f.node('#hiddenWorkName').value = 'synthetic'; f.node('#hiddenWorkLon').value = '120'; f.node('#hiddenWorkLat').value = '30';
    f.node('#beforePhotos').files = [{ name: 'synthetic.png', type: 'image/png', size: 1 }];
    const pending = f.tools.saveArchive(); assert.equal(readers.length, 1);
    f.tools.dispose(); readers[0].result = 'data:image/png;base64,eA=='; readers[0].onload(); await pending;
    assert.equal(f.archiveOpens.length, opens, 'no new write transaction may start after disposal');
    assert.equal(f.node('#hiddenWorkName').value, 'synthetic'); assert.equal(f.notifications.length, 0);
  } finally { globalThis.FileReader = previousReader; f.close(); }
});

test('recovery traverses a wide cyclic tile tree without function-argument overflow', () => {
  const f = fixture();
  try {
    const { resource: photo } = f.addTileset(); const dead = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 0)] });
    const borrower = { _clippingPlanes: dead, resetDrawCommands() {} }; dead.destroy();
    const child = { content: { _model: borrower }, children: [photo.root] };
    photo.root.children = Array.from({ length: 150_000 }, () => child);
    assert.equal(f.tools.recoverFromDestroyedResources(), 1); assert.equal(borrower._clippingPlanes, undefined);
  } finally { f.close(); }
});
