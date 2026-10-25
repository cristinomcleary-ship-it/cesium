import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Cartesian3, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection, ClippingPolygon, ClippingPolygonCollection, Matrix4, Model, Transforms } from 'cesium';
import { recoverDestroyedClippingReferences } from '../src/destroyedClippingRecovery.ts';
import { SubsurfaceTools } from '../src/subsurfaceTools.ts';

// Exercise the installed, pinned engine's actual content synchronization rather
// than reproducing its branch in a test double. npm may nest this dependency.
const requireFromCesium = createRequire(import.meta.resolve('cesium'));
const engine = pathToFileURL(requireFromCesium.resolve('@cesium/engine'));
const { default: Model3DTileContent } = await import(new URL('./Source/Scene/Model/Model3DTileContent.js', engine));
const { default: Cesium3DTile } = await import(new URL('./Source/Scene/Cesium3DTile.js', engine));
const { default: Cesium3DTileContentState } = await import(new URL('./Source/Scene/Cesium3DTileContentState.js', engine));
const { default: Cesium3DTilesetTraversal } = await import(new URL('./Source/Scene/Cesium3DTilesetTraversal.js', engine));

function planes() {
  return new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 0)] });
}
function polygons() {
  return new ClippingPolygonCollection({ polygons: [new ClippingPolygon({ positions: [
    Cartesian3.fromDegrees(120, 30), Cartesian3.fromDegrees(120.001, 30), Cartesian3.fromDegrees(120, 30.001),
  ] })] });
}
function borrowedModel(planeCollection, polygonCollection) {
  return {
    _clippingPlanes: planeCollection, _clippingPolygons: polygonCollection,
    _drawCommandsBuilt: true, ready: false, isDestroyed: () => false,
    resetDrawCommands: Model.prototype.resetDrawCommands,
    update() {},
  };
}

test('real tile content update retains destroyed clipping after its tileset owner was cleared; recovery detaches it', () => {
  const collection = planes();
  const model = borrowedModel(collection);
  const tile = { computedTransform: Matrix4.IDENTITY, clippingPlanesDirty: true, clippingPolygonsDirty: true };
  const tileset = { clippingPlanes: undefined, clippingPolygons: undefined };
  const content = new Model3DTileContent(tileset, tile, undefined);
  content._model = model;
  tile.content = content;
  tileset.root = tile;
  collection.destroy();

  content.update(tileset, {});
  assert.equal(model._clippingPlanes, collection, 'clearing only the tileset cannot repair the borrowed reference');
  assert.equal(Model.prototype.isClippingEnabled.call(model), true, 'the stale collection still enters the clipping pipeline');
  assert.equal(recoverDestroyedClippingReferences(tileset), 1);
  assert.equal(model._clippingPlanes, undefined);
  assert.equal(Model.prototype.isClippingEnabled.call(model), false);
  assert.equal(model._drawCommandsBuilt, false, 'discard commands whose uniforms captured the deleted textures');
  content.update(tileset, {});
  assert.equal(model._clippingPlanes, undefined);
});

test('repair handles planes and polygons in composite tile contents and is idempotent over five recovery cycles', () => {
  for (let cycle = 0; cycle < 5; cycle++) {
    const plane = planes(), polygon = polygons();
    const model = borrowedModel(plane, polygon);
    const composite = { innerContents: [{ _model: model }, { _model: model }] };
    const root = { children: [{ content: composite }] };
    const tileset = { _clippingPlanes: plane, _clippingPolygons: polygon, root };
    plane.destroy(); polygon.destroy();
    assert.equal(recoverDestroyedClippingReferences(tileset), 4);
    assert.equal(tileset._clippingPlanes, undefined); assert.equal(tileset._clippingPolygons, undefined);
    assert.equal(model._clippingPlanes, undefined); assert.equal(model._clippingPolygons, undefined);
    assert.equal(model._drawCommandsBuilt, false);
    assert.equal(recoverDestroyedClippingReferences(tileset), 0);
  }
});

test('repair preserves replacement owners, live clipping and custom shaders', () => {
  const old = planes(), current = planes(), livePolygon = polygons();
  const liveModel = borrowedModel(current, livePolygon), staleModel = borrowedModel(old, livePolygon);
  const shader = { isDestroyed: () => false };
  liveModel.customShader = shader; staleModel.customShader = shader;
  const tileset = { _clippingPlanes: current, _clippingPolygons: livePolygon,
    root: { children: [{ content: { _model: liveModel } }, { content: { _model: staleModel } }] } };
  old.destroy();
  try {
    assert.equal(recoverDestroyedClippingReferences(tileset), 1);
    assert.equal(tileset._clippingPlanes, current); assert.equal(liveModel._clippingPlanes, current);
    assert.equal(staleModel._clippingPlanes, undefined);
    assert.equal(staleModel._clippingPolygons, livePolygon);
    assert.equal(liveModel._drawCommandsBuilt, true);
    assert.equal(liveModel.customShader, shader); assert.equal(staleModel.customShader, shader);
    assert.equal(current.isDestroyed(), false); assert.equal(livePolygon.isDestroyed(), false);
  } finally { current.destroy(); livePolygon.destroy(); }
});

test('repair avoids public ownership setters and skips already destroyed models', () => {
  const collection = planes(); collection.destroy();
  const model = borrowedModel(collection);
  Object.defineProperty(model, 'clippingPlanes', {
    get() { return this._clippingPlanes; },
    set() { assert.fail('public setter would destroy the former collection again'); },
  });
  const dead = { isDestroyed: () => true, get _clippingPlanes() { assert.fail('do not inspect destroyed models'); } };
  const resource = { root: { content: { innerContents: [{ _model: model }, { _model: dead }] } } };
  assert.equal(recoverDestroyedClippingReferences(resource), 1);
  assert.equal(model.clippingPlanes, undefined);
});

test('unclipped and not-yet-loaded contents require no changes', () => {
  const model = borrowedModel();
  const root = { children: [{ content: undefined }, { content: { _model: model } }] };
  root.children.push(root);
  assert.equal(recoverDestroyedClippingReferences({ root }), 0);
  assert.equal(model._drawCommandsBuilt, true);
});

test('the render-error recovery entry point repairs borrowed references after clearing the tracked owner', () => {
  const originalDocument = globalThis.document;
  const inputs = new Map([['#sectionEnabled', { checked: false }], ['#clipExcavationSurface', { checked: false }]]);
  globalThis.document = { querySelector: selector => inputs.get(selector) };
  const collection = planes(), model = borrowedModel(collection);
  const tileset = { _clippingPlanes: collection, root: { content: { _model: model } } };
  Object.defineProperty(tileset, 'clippingPlanes', { get() { return this._clippingPlanes; } });
  const tools = Object.create(SubsurfaceTools.prototype);
  let requested = 0;
  Object.assign(tools, {
    viewer: { scene: { globe: {}, requestRender: () => requested++ } },
    imports: () => [{ kind: '3D Tiles', resource: tileset }],
    clippingTargets: new Map([[tileset, collection]]), excavationClipTargets: new Map(),
  });
  collection.destroy();
  try {
    assert.equal(tools.recoverFromDestroyedResources(), 2);
    assert.equal(tileset._clippingPlanes, undefined); assert.equal(model._clippingPlanes, undefined);
    assert.equal(model._drawCommandsBuilt, false); assert.equal(tools.clippingTargets.size, 0);
    assert.equal(inputs.get('#sectionEnabled').checked, false); assert.equal(inputs.get('#clipExcavationSurface').checked, false);
    assert.equal(requested, 1);
  } finally { globalThis.document = originalDocument; }
});

test('tracked ordinary Models invalidate draw commands even when the owner is repaired before tile traversal', () => {
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ checked: true }) };
  const collection = planes();
  const model = Object.assign(Object.create(Model.prototype), { _clippingPlanes: collection, _drawCommandsBuilt: true });
  const tools = Object.assign(Object.create(SubsurfaceTools.prototype), {
    viewer: { scene: { globe: {}, requestRender() {} } },
    imports: () => [{ kind: 'Model', resource: model }],
    clippingTargets: new Map([[model, collection]]), excavationClipTargets: new Map(),
  });
  collection.destroy();
  try {
    assert.equal(tools.recoverFromDestroyedResources(), 1);
    assert.equal(model.clippingPlanes, undefined); assert.equal(model._drawCommandsBuilt, false);
  } finally { globalThis.document = originalDocument; }
});

test('actual Cesium root and content getters tolerate unloaded tiles and a not-yet-populated tileset', () => {
  const tileset = new Cesium3DTileset({});
  try {
    assert.equal(tileset.root, undefined);
    assert.equal(recoverDestroyedClippingReferences(tileset), 0);
    const tile = Object.assign(Object.create(Cesium3DTile.prototype), { children: [], _content: undefined });
    tileset._root = tile;
    assert.equal(tile.content, undefined);
    assert.equal(recoverDestroyedClippingReferences(tileset), 0);
    tileset._root = undefined;
  } finally { tileset.destroy(); }
});

function recoveryInputs() {
  return new Map([
    ['#sectionEnabled', { checked: true }], ['#clipExcavationSurface', { checked: true }],
    ['#sectionDirection', { value: 'northSouth' }], ['#sectionInvert', { checked: false }],
    ['#sectionOffset', { value: '25' }],
  ]);
}

function clippingModel(plane, polygon) {
  const model = Object.assign(Object.create(Model.prototype), {
    modelMatrix: Matrix4.clone(Matrix4.IDENTITY), _drawCommandsBuilt: true,
  });
  if (plane) model.clippingPlanes = plane;
  if (polygon) model.clippingPolygons = polygon;
  return model;
}

test('an unrelated render failure leaves healthy clipping and user settings unchanged', () => {
  const originalDocument = globalThis.document;
  const inputs = recoveryInputs();
  globalThis.document = { querySelector: selector => inputs.get(selector) };
  const plane = planes(), polygon = polygons();
  plane.get(0).distance = 37; plane.enabled = true;
  polygon.enabled = false; polygon.inverse = true; polygon.quality = 0.75;
  const model = clippingModel(plane, polygon);
  model._drawCommandsBuilt = true;
  const tools = Object.assign(Object.create(SubsurfaceTools.prototype), {
    viewer: { scene: { globe: {}, requestRender() {} } },
    imports: () => [{ kind: 'Model', resource: model }],
    clippingTargets: new Map([[model, plane]]), excavationClipTargets: new Map([[model, polygon]]),
  });
  try {
    for (let cycle = 0; cycle < 5; cycle++) assert.equal(tools.recoverFromDestroyedResources(), 0);
    assert.equal(model.clippingPlanes, plane); assert.equal(model.clippingPolygons, polygon);
    assert.equal(plane.enabled, true); assert.equal(plane.get(0).distance, 37);
    assert.equal(polygon.enabled, false); assert.equal(polygon.inverse, true); assert.equal(polygon.quality, 0.75);
    assert.equal(plane.isDestroyed(), false); assert.equal(polygon.isDestroyed(), false);
    assert.equal(model._drawCommandsBuilt, true);
    assert.equal(inputs.get('#sectionEnabled').checked, true); assert.equal(inputs.get('#clipExcavationSurface').checked, true);
  } finally { plane.destroy(); polygon.destroy(); globalThis.document = originalDocument; }
});

test('mixed recovery rebuilds only damaged owned clipping with the existing configuration and is idempotent', () => {
  const originalDocument = globalThis.document;
  const inputs = recoveryInputs();
  globalThis.document = { querySelector: selector => inputs.get(selector) };
  const healthyPlane = planes(), healthyPolygon = polygons();
  healthyPlane.get(0).distance = 71; healthyPolygon.inverse = true;
  const healthy = clippingModel(healthyPlane, healthyPolygon);
  healthy._drawCommandsBuilt = true;
  const destroyedPlane = planes(), destroyedPolygon = polygons();
  const damaged = clippingModel(destroyedPlane, destroyedPolygon);
  const supersededPlane = planes(), replacementPlane = planes();
  const replacementOwner = clippingModel(replacementPlane);
  const anchor = Cartesian3.fromDegrees(120, 30);
  const points = [anchor, Cartesian3.fromDegrees(120.001, 30), Cartesian3.fromDegrees(120, 30.001)];
  const tools = Object.assign(Object.create(SubsurfaceTools.prototype), {
    viewer: { scene: { globe: {}, requestRender() {} } },
    imports: () => [healthy, damaged, replacementOwner].map(resource => ({ kind: 'Model', resource })),
    clippingTargets: new Map([[healthy, healthyPlane], [damaged, destroyedPlane], [replacementOwner, supersededPlane]]),
    excavationClipTargets: new Map([[healthy, healthyPolygon], [damaged, destroyedPolygon]]),
    sectionAnchor: anchor, excavationFinished: true, excavationPoints: points,
  });
  destroyedPlane.destroy(); destroyedPolygon.destroy(); supersededPlane.destroy();
  try {
    assert.equal(tools.recoverFromDestroyedResources(), 3);
    const recoveredPlane = damaged.clippingPlanes, recoveredPolygon = damaged.clippingPolygons;
    assert.ok(recoveredPlane && recoveredPolygon);
    assert.notEqual(recoveredPlane, destroyedPlane); assert.notEqual(recoveredPolygon, destroyedPolygon);
    assert.equal(recoveredPlane.isDestroyed(), false); assert.equal(recoveredPolygon.isDestroyed(), false);
    assert.equal(recoveredPlane.owner, damaged); assert.equal(recoveredPolygon.owner, damaged);
    assert.equal(recoveredPlane.enabled, true); assert.equal(recoveredPlane.get(0).distance, -25);
    assert.equal(Cartesian3.equals(recoveredPlane.get(0).normal, Cartesian3.UNIT_X), true);
    assert.deepEqual(recoveredPlane.modelMatrix, Transforms.eastNorthUpToFixedFrame(anchor));
    assert.equal(recoveredPolygon.enabled, true); assert.deepEqual(recoveredPolygon.get(0).positions, points);
    assert.equal(tools.clippingTargets.get(damaged), recoveredPlane);
    assert.equal(tools.excavationClipTargets.get(damaged), recoveredPolygon);
    assert.equal(healthy.clippingPlanes, healthyPlane); assert.equal(healthy.clippingPolygons, healthyPolygon);
    assert.equal(healthyPlane.get(0).distance, 71); assert.equal(healthyPolygon.inverse, true);
    assert.equal(healthy._drawCommandsBuilt, true);
    assert.equal(replacementOwner.clippingPlanes, replacementPlane); assert.equal(replacementPlane.isDestroyed(), false);
    assert.equal(inputs.get('#sectionEnabled').checked, true); assert.equal(inputs.get('#clipExcavationSurface').checked, true);
    for (let cycle = 0; cycle < 5; cycle++) assert.equal(tools.recoverFromDestroyedResources(), 0);
    assert.equal(damaged.clippingPlanes, recoveredPlane); assert.equal(damaged.clippingPolygons, recoveredPolygon);
  } finally {
    for (const model of [healthy, damaged, replacementOwner]) {
      for (const collection of [model.clippingPlanes, model.clippingPolygons]) if (collection && !collection.isDestroyed()) collection.destroy();
    }
    globalThis.document = originalDocument;
  }
});

test('disabled clipping is cleaned without silently enabling it or changing the UI', () => {
  const originalDocument = globalThis.document;
  const inputs = recoveryInputs();
  inputs.get('#sectionEnabled').checked = false; inputs.get('#clipExcavationSurface').checked = false;
  globalThis.document = { querySelector: selector => inputs.get(selector) };
  const plane = planes(), polygon = polygons(), model = clippingModel(plane, polygon);
  const tools = Object.assign(Object.create(SubsurfaceTools.prototype), {
    viewer: { scene: { globe: {}, requestRender() {} } },
    imports: () => [{ kind: 'Model', resource: model }],
    clippingTargets: new Map([[model, plane]]), excavationClipTargets: new Map([[model, polygon]]),
    sectionAnchor: Cartesian3.fromDegrees(120, 30), excavationFinished: true,
    excavationPoints: [Cartesian3.fromDegrees(120, 30), Cartesian3.fromDegrees(120.001, 30), Cartesian3.fromDegrees(120, 30.001)],
  });
  plane.destroy(); polygon.destroy();
  try {
    assert.equal(tools.recoverFromDestroyedResources(), 2);
    assert.equal(model.clippingPlanes, undefined); assert.equal(model.clippingPolygons, undefined);
    assert.equal(inputs.get('#sectionEnabled').checked, false); assert.equal(inputs.get('#clipExcavationSurface').checked, false);
    assert.equal(tools.recoverFromDestroyedResources(), 0);
  } finally { globalThis.document = originalDocument; }
});

test('rebuilding an equal-sized tileset collection rebinds loaded tile models on their next real update', () => {
  const originalDocument = globalThis.document;
  const inputs = recoveryInputs();
  globalThis.document = { querySelector: selector => inputs.get(selector) };
  const plane = planes(), polygon = polygons();
  const tileset = new Cesium3DTileset({});
  tileset.clippingPlanes = plane; tileset.clippingPolygons = polygon;
  const model = borrowedModel(plane, polygon);
  const tile = {
    computedTransform: Matrix4.IDENTITY, transform: Matrix4.fromTranslation(new Cartesian3(1, 2, 3)), children: [],
    clippingPlanesDirty: false, clippingPolygonsDirty: false, _isClipped: true, _isClippedByPolygon: true,
  };
  const content = new Model3DTileContent(tileset, tile, undefined);
  content._model = model; tile.content = content; tileset._root = tile;
  const points = [Cartesian3.fromDegrees(120, 30), Cartesian3.fromDegrees(120.001, 30), Cartesian3.fromDegrees(120, 30.001)];
  const tools = Object.assign(Object.create(SubsurfaceTools.prototype), {
    viewer: { scene: { globe: {}, requestRender() {} } }, imports: () => [{ kind: '3D Tiles', resource: tileset }],
    clippingTargets: new Map([[tileset, plane]]), excavationClipTargets: new Map([[tileset, polygon]]),
    sectionAnchor: points[0], excavationFinished: true, excavationPoints: points,
  });
  plane.destroy(); polygon.destroy();
  try {
    assert.equal(tools.recoverFromDestroyedResources(), 4);
    assert.equal(model._clippingPlanes, undefined); assert.equal(model._clippingPolygons, undefined);
    assert.equal(tile.clippingPlanesDirty, true); assert.equal(tile.clippingPolygonsDirty, true);
    content.update(tileset, {});
    assert.equal(model._clippingPlanes, tileset.clippingPlanes);
    assert.equal(model._clippingPolygons, tileset.clippingPolygons);
    assert.equal(model._clippingPlanes.isDestroyed(), false); assert.equal(model._clippingPolygons.isDestroyed(), false);
    tile.clippingPlanesDirty = false; tile.clippingPolygonsDirty = false;
    assert.equal(tools.recoverFromDestroyedResources(), 0);
    assert.equal(tile.clippingPlanesDirty, false); assert.equal(tile.clippingPolygonsDirty, false);
  } finally { tileset._root = undefined; tileset.destroy(); globalThis.document = originalDocument; }
});

test('a real tile.update clipping failure remains explicitly stopped instead of silently losing the failed tile', () => {
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: selector => recoveryInputs().get(selector) };
  const collection = planes(), model = borrowedModel(collection);
  model.update = function () { this._clippingPlanes?.get(0); };
  const tileset = { clippingPlanes: undefined, clippingPolygons: undefined, _requestedTiles: [] };
  const unrelatedFailed = Object.assign(Object.create(Cesium3DTile.prototype), {
    _contentState: Cesium3DTileContentState.FAILED, hasRenderableContent: true,
    _content: { update() {} }, children: [], _tileset: tileset,
  });
  const tile = Object.assign(Object.create(Cesium3DTile.prototype), {
    _contentState: Cesium3DTileContentState.READY, hasRenderableContent: true, _tileset: tileset,
    computedTransform: Matrix4.IDENTITY, children: [unrelatedFailed],
  });
  const content = new Model3DTileContent(tileset, tile, undefined);
  content._model = model; tile._content = content; tileset.root = tile;
  let requested = 0;
  const tools = Object.assign(Object.create(SubsurfaceTools.prototype), {
    viewer: { scene: { globe: {}, requestRender() { requested++; } } },
    imports: () => [{ kind: '3D Tiles', resource: tileset }],
    clippingTargets: new Map(), excavationClipTargets: new Map(),
  });
  const frame = { commandList: [], frameNumber: 10 };
  collection.destroy();
  try {
    assert.equal(tile.contentAvailable, true);
    assert.throws(() => tile.update(tileset, frame, { isRender: false }), /object was destroyed/);
    assert.equal(tile.contentFailed, true); assert.equal(tile.contentAvailable, false);
    assert.throws(() => tools.recoverFromDestroyedResources(), /1 个倾斜摄影瓦片仍处于失败状态.*停止自动恢复/);
    assert.equal(model._clippingPlanes, undefined, 'the actual destroyed reference is cleared');
    assert.equal(tile.content, content, 'keep the affected content and layer in place');
    assert.equal(unrelatedFailed._contentState, Cesium3DTileContentState.FAILED, 'never revive unrelated failures');
    Cesium3DTilesetTraversal.loadTile(tile, frame);
    assert.equal(tileset._requestedTiles.length, 0, 'the engine does not retry FAILED tiles as UNLOADED');
    tile.update(tileset, frame, { isRender: false });
    assert.equal(tile.contentFailed, true, 'even a manually successful content update does not repair tile availability');
    assert.equal(tile.contentAvailable, false);
    assert.throws(() => tools.recoverFromDestroyedResources(), /仍处于失败状态/,
      'repeating recovery must not forget a previously identified failed tile');
    assert.equal(requested, 0, 'no successful-recovery render request is emitted');
    // Removing/reloading the affected resource releases this guard; other
    // existing network/parse failures remain untouched and are not revived.
    tileset.root = unrelatedFailed;
    assert.equal(tools.recoverFromDestroyedResources(), 0);
    assert.equal(unrelatedFailed._contentState, Cesium3DTileContentState.FAILED);
  } finally { globalThis.document = originalDocument; }
});
