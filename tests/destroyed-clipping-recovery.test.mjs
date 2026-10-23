import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Cartesian3, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection, ClippingPolygon, ClippingPolygonCollection, Matrix4, Model } from 'cesium';
import { recoverDestroyedClippingReferences } from '../src/destroyedClippingRecovery.ts';
import { SubsurfaceTools } from '../src/subsurfaceTools.ts';

// Exercise the installed, pinned engine's actual content synchronization rather
// than reproducing its branch in a test double. npm may nest this dependency.
const requireFromCesium = createRequire(import.meta.resolve('cesium'));
const engine = pathToFileURL(requireFromCesium.resolve('@cesium/engine'));
const { default: Model3DTileContent } = await import(new URL('./Source/Scene/Model/Model3DTileContent.js', engine));
const { default: Cesium3DTile } = await import(new URL('./Source/Scene/Cesium3DTile.js', engine));

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
  const inputs = new Map([['#sectionEnabled', { checked: true }], ['#clipExcavationSurface', { checked: true }]]);
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
