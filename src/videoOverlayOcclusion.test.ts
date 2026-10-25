import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  BoundingSphere, Cartesian3, Cesium3DTileset, Cesium3DTileStyle, CustomShader,
  CustomShaderMode, CustomShaderTranslucencyMode, Event as CesiumEvent, JulianDate,
  LightingModel, Matrix4, PointCloudShading, PrimitiveCollection, Transforms,
  type Cesium3DTile, type Viewer,
} from 'cesium';
import {
  assertVideoOverlayOccluder, validateVideoOverlayOcclusion, VideoOverlayOcclusion, VideoOverlayTileCoverage,
  type SavedVideoOverlayOcclusion,
} from './videoOverlayOcclusion.ts';
import { VideoOverlayResources } from './videoOverlayResources.ts';
import type { ImportRecord } from './types.ts';

const center = Cartesian3.fromDegrees(120, 30, 25);
const base = Transforms.eastNorthUpToFixedFrame(center);
const mesh = () => ({ pointsLength: 0, trianglesLength: 12, geometryByteLength: 144, ready: true });
const empty = () => ({ pointsLength: 0, trianglesLength: 0, geometryByteLength: 0, ready: true });
function tile(content: unknown = mesh(), children: Cesium3DTile[] = [], overrides: Record<string, unknown> = {}): Cesium3DTile {
  return { content, children, _updatedVisibilityFrame: 0, _visibilityPlaneMask: 0, _inRequestVolume: true,
    refine: 1, hasRenderableContent: (content as { trianglesLength?: number })?.trianglesLength !== 0,
    hasTilesetContent: false, hasImplicitContent: false, commandsLength: 1, ...overrides } as unknown as Cesium3DTile;
}
function source(overrides: Record<string, unknown> = {}): Cesium3DTileset {
  // A prototype-backed test double exercises the real instanceof guard without
  // creating WebGL state. Ordinary structurally similar resources are rejected.
  const value = Object.create(Cesium3DTileset.prototype) as Cesium3DTileset;
  const state = {
    show: true, modelMatrix: Matrix4.clone(base), boundingSphere: new BoundingSphere(center, 20),
    isDestroyed: () => false, root: tile(), classificationType: undefined,
    clippingPlanes: undefined, clippingPolygons: undefined, customShader: undefined,
    style: undefined, colorBlendMode: 2, splitDirection: -1, edgeDisplayMode: 0,
    pointCloudShading: new PointCloudShading(), tilesLoaded: true,
    _updatedVisibilityFrame: 0, _pass: 0, skipLevelOfDetail: true, debugFreezeFrame: true,
    cullRequestsWhileMoving: true, foveatedTimeDelay: .1, memoryAdjustedScreenSpaceError: 16,
    statistics: { numberOfPendingRequests: 0, numberOfTilesProcessing: 0, numberOfAttemptedRequests: 0 },
    tileLoad: new CesiumEvent(), tileVisible: new CesiumEvent(), tileFailed: new CesiumEvent(),
    debugColorizeTiles: true, debugWireframe: true, debugShowBoundingVolume: true,
    debugShowContentBoundingVolume: true, debugShowViewerRequestVolume: true,
    debugShowGeometricError: true, debugShowRenderingStatistics: true,
    debugShowMemoryUsage: true, debugShowUrl: true, showOutline: true,
    ...overrides,
  };
  for (const [key, property] of Object.entries(state)) {
    Object.defineProperty(value, key, { value: property, writable: true, configurable: true, enumerable: true });
  }
  return value;
}
function mutate(value: object, key: string, next: unknown) { (value as Record<string, unknown>)[key] = next; }
function viewer(): Viewer {
  return { clock: { currentTime: JulianDate.now() }, scene: {
    primitives: new PrimitiveCollection(), preRender: new CesiumEvent(), frameState: { frameNumber: 0 }, requestRender() {},
  } } as unknown as Viewer;
}
function render(view: Viewer, value: Cesium3DTileset, selected: Cesium3DTile[] = [value.root]) {
  const state = (view.scene as unknown as { frameState: { frameNumber: number } }).frameState;
  state.frameNumber += 1; view.scene.preRender.raiseEvent(view.scene, JulianDate.now());
  const epoch = state.frameNumber * 3;
  mutate(value, '_updatedVisibilityFrame', epoch); mutate(value, '_pass', 0);
  const visit = (node: Cesium3DTile) => { mutate(node, '_updatedVisibilityFrame', epoch); node.children.forEach(visit); };
  visit(value.root);
  selected.forEach(node => value.tileVisible.raiseEvent(node));
}
function record(id: string, resource: unknown, kind: ImportRecord['kind'] = '3D Tiles'): ImportRecord {
  return { id, name: id, resource, kind, visible: true } as ImportRecord;
}

test('occlusion settings default off, clone values, and reject malformed enabled source', () => {
  assert.deepEqual(validateVideoOverlayOcclusion(), { enabled: false, sourceId: '' });
  const original = { enabled: true, sourceId: 'survey' };
  const saved = validateVideoOverlayOcclusion(original);
  assert.deepEqual(saved, original); assert.notEqual(saved, original);
  for (const value of [null, {}, { enabled: 'true', sourceId: 'a' }, { enabled: true, sourceId: ' ' }, { enabled: false, sourceId: 2 }]) {
    assert.throws(() => validateVideoOverlayOcclusion(value as SavedVideoOverlayOcclusion), /地表遮挡设置无效/);
  }
});

test('compatibility rejects impostors, vertex deformation, active clipping and classification only', () => {
  assert.throws(() => assertVideoOverlayOccluder({ show: true, modelMatrix: base, root: tile() }), /Cesium 3D Tiles/);
  assert.throws(() => assertVideoOverlayOccluder(source({ isDestroyed: () => true })), /已移除/);
  assert.throws(() => assertVideoOverlayOccluder(source({ classificationType: 0 })), /分类瓦片/);
  const deform = new CustomShader({ vertexShaderText: 'void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {}' });
  assert.throws(() => assertVideoOverlayOccluder(source({ customShader: deform })), /顶点变形/);
  deform.destroy();
  for (const key of ['clippingPlanes', 'clippingPolygons']) {
    assert.throws(() => assertVideoOverlayOccluder(source({ [key]: { enabled: true, length: 1 } })), /裁剪/);
    assert.doesNotThrow(() => assertVideoOverlayOccluder(source({ [key]: { enabled: false, length: 1 } })));
    assert.doesNotThrow(() => assertVideoOverlayOccluder(source({ [key]: { enabled: true, length: 0 } })));
  }
});

test('depth role uses an opaque replace shader and restores exact material/debug references', () => {
  const originalShader = new CustomShader({ fragmentShaderText: 'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {}' });
  const style = new Cesium3DTileStyle({ color: "color('red')" });
  const originalShading = new PointCloudShading({ attenuation: true });
  const value = source({ customShader: originalShader, style, pointCloudShading: originalShading });
  const matrix = value.modelMatrix;
  const view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  const depthShader = value.customShader!;
  assert.notEqual(depthShader, originalShader);
  assert.equal(depthShader.mode, CustomShaderMode.REPLACE_MATERIAL);
  assert.equal(depthShader.lightingModel, LightingModel.UNLIT);
  assert.equal(depthShader.translucencyMode, CustomShaderTranslucencyMode.OPAQUE);
  assert.match(depthShader.fragmentShaderText!, /material.alpha = 0.0/);
  assert.equal(value.style, undefined); assert.equal(value.debugWireframe, false);
  assert.equal(value.showOutline, false); assert.equal(value.splitDirection, 0);
  assert.equal(value.modelMatrix, matrix); assert.equal(value.show, true);
  assert.doesNotThrow(() => assertVideoOverlayOccluder(value));
  assert.equal(owner.getStatus().ready, false);
  assert.equal(value.skipLevelOfDetail, false); assert.equal(value.debugFreezeFrame, false);
  assert.equal(value.cullRequestsWhileMoving, false); assert.equal(value.foveatedTimeDelay, 0);
  render(view, value);
  assert.equal(owner.getStatus().ready, true);
  assert.equal(value.tileLoad.numberOfListeners, 1);
  owner.restore(); owner.restore();
  assert.equal(value.customShader, originalShader); assert.equal(value.style, style);
  assert.equal(value.pointCloudShading, originalShading); assert.equal(value.debugWireframe, true);
  assert.equal(value.showOutline, true); assert.equal(value.splitDirection, -1);
  assert.equal(value.skipLevelOfDetail, true); assert.equal(value.debugFreezeFrame, true);
  assert.equal(value.cullRequestsWhileMoving, true); assert.equal(value.foveatedTimeDelay, .1);
  assert.equal(depthShader.isDestroyed(), true); assert.equal(originalShader.isDestroyed(), false);
  assert.equal(value.tileLoad.numberOfListeners, 0); assert.equal(value.tileVisible.numberOfListeners, 0);
  assert.equal(value.tileFailed.numberOfListeners, 0);
  assert.equal(view.scene.preRender.numberOfListeners, 0);
  assert.equal(owner.getStatus().ready, false);
  originalShader.destroy();
});

test('depth role exit discards a destroyed previous shader without overwriting another live owner', () => {
  for (const replaced of [false, true]) {
    const original = new CustomShader({}), style = new Cesium3DTileStyle({ color: "color('red')" });
    const shading = new PointCloudShading({ attenuation: true });
    const value = source({ customShader: original, style, pointCloudShading: shading });
    const matrix = value.modelMatrix, view = viewer();
    const owner = new VideoOverlayOcclusion('survey', value, view.scene), owned = value.customShader!;
    original.destroy();
    const external = replaced ? new CustomShader({}) : undefined;
    if (external) value.customShader = external;
    assert.doesNotThrow(() => { owner.restore(); owner.restore(); });
    assert.equal(value.customShader, external);
    assert.equal(owned.isDestroyed(), true); assert.equal(original.isDestroyed(), true);
    assert.equal(value.modelMatrix, matrix); assert.equal(value.show, true);
    assert.equal(value.style, style); assert.equal(value.pointCloudShading, shading);
    assert.equal(value.debugWireframe, true); assert.equal(value.skipLevelOfDetail, true);
    assert.equal(value.tileLoad.numberOfListeners, 0); assert.equal(value.tileVisible.numberOfListeners, 0);
    assert.equal(view.scene.preRender.numberOfListeners, 0);
    if (external) { assert.equal(external.isDestroyed(), false); external.destroy(); }
  }
});

test('entry avoids a full cached tree scan and leaves unchanged style/debug setters alone', () => {
  const root = tile(); let branches = 0, styleWrites = 0, debugWrites = 0;
  Object.defineProperty(root, 'children', { get: () => { branches++; return []; }, configurable: true });
  const value = source({ root, debugWireframe: false });
  Object.defineProperty(value, 'style', { get: () => undefined, set: () => { styleWrites++; }, configurable: true });
  Object.defineProperty(value, 'debugWireframe', { get: () => false, set: () => { debugWrites++; }, configurable: true });
  const view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  assert.equal(branches, 0);
  owner.restore();
  assert.equal(styleWrites, 0, 'reassigning undefined style would unnecessarily dirty Cesium styling');
  assert.equal(debugWrites, 0);
});

test('coverage is reused only after complete commands and never across a new view or material owner', () => {
  const child = tile(), root = tile(empty(), [child]);
  let coverageReads = 0;
  Object.defineProperty(root, '_visibilityPlaneMask', { get: () => { coverageReads++; return 0; }, configurable: true });
  const statistics = { numberOfCommands: 0, numberOfPendingRequests: 0, numberOfTilesProcessing: 0, numberOfAttemptedRequests: 0 };
  const value = source({ root, statistics }), view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, [child]);
  owner.getStatus(); const duringUpdate = coverageReads;
  owner.getStatus(); assert.ok(coverageReads > duringUpdate, 'pre-submission status is never cached');
  statistics.numberOfCommands = 1;
  assert.equal(owner.getStatus().ready, true); const afterSubmission = coverageReads;
  for (let read = 0; read < 20; read++) assert.equal(owner.getStatus().ready, true);
  assert.equal(coverageReads, afterSubmission, 'uniform/UI/postRender share the completed frame coverage');
  render(view, value, []); assert.equal(owner.getStatus().ready, false);
  render(view, value, [child]); assert.equal(owner.getStatus().ready, true);
  const external = new CustomShader({}); value.customShader = external;
  assert.equal(owner.getStatus().ready, false); assert.match(owner.getStatus().error!, /其他功能/);
  owner.restore(); external.destroy();
});

test('a drawn replacement parent stays ready during pending/processing/preload detail refinement', () => {
  const value = source({ tilesLoaded: false });
  value.root.children.push(tile(undefined));
  const view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  assert.equal(owner.getStatus().ready, false);
  render(view, value);
  assert.equal(owner.getStatus().ready, true);
  assert.equal(owner.getStatus().refining, true);
  for (const key of ['numberOfPendingRequests', 'numberOfTilesProcessing', 'numberOfAttemptedRequests']) {
    const counters = { numberOfPendingRequests: 0, numberOfTilesProcessing: 0, numberOfAttemptedRequests: 0, [key]: 1 };
    mutate(value, 'statistics', counters);
    render(view, value);
    assert.equal(owner.getStatus().ready, true, key);
  }
  mutate(value, 'statistics', undefined);
  assert.equal(owner.getStatus().ready, true);
  owner.restore();
});

test('empty-root siblings, request volumes and camera/pass changes require complete current coverage', () => {
  const a = tile(), b = tile(), value = source({ root: tile(empty(), [a, b]) });
  const view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, [a]);
  assert.equal(owner.getStatus().ready, false, 'one visible branch cannot cover the missing sibling');
  render(view, value, [a, b]); assert.equal(owner.getStatus().ready, true);
  render(view, value, []); assert.equal(owner.getStatus().ready, false, 'previous-frame coverage is never latched');
  render(view, value, [a]);
  mutate(b, '_visibilityPlaneMask', 0xffffffff); assert.equal(owner.getStatus().ready, true);
  mutate(b, '_updatedVisibilityFrame', -1); assert.equal(owner.getStatus().ready, false, 'stale outside status is unsafe');
  render(view, value, [a]);
  mutate(b, '_visibilityPlaneMask', 0); mutate(b, '_inRequestVolume', false);
  assert.equal(owner.getStatus().ready, false, 'request-volume culling is not outside the image');
  mutate(b, '_inRequestVolume', true); render(view, value, [a, b]);
  mutate(b, 'commandsLength', 0); assert.equal(owner.getStatus().ready, false, 'tileVisible precedes actual draw submission');
  mutate(b, 'commandsLength', 1); assert.equal(owner.getStatus().ready, true);
  mutate(value, '_pass', 1); assert.equal(owner.getStatus().ready, false, 'a pick/preload traversal cannot prove render coverage');
  render(view, value, [a, b]);
  mutate(value, '_updatedVisibilityFrame', -1); assert.equal(owner.getStatus().ready, false);
  render(view, value, [a, b]);
  mutate(view.scene, 'frameState', undefined); assert.equal(owner.getStatus().ready, false);
  owner.restore();
});

test('empty routing tiles below the LOD threshold refine to real depth and restore method descriptors', async () => {
  // Use the pinned engine's own traversal decision, not a duplicate of its SSE rule.
  const engine = await import('cesium') as unknown as { Cesium3DTilesetTraversal: { canTraverse(tile: unknown): boolean } };
  const canTraverse = engine.Cesium3DTilesetTraversal.canTraverse;
  const sibling = tile(), missing = tile({ ...empty(), ready: false });
  const original = function (_frameState: unknown, useParent: boolean, fraction?: number) { return useParent ? 2300 : fraction ? 3 : 8; };
  const branch = tile(empty(), [missing], { hasEmptyContent: true, hasRenderableContent: false,
    _screenSpaceError: 8, _visible: true, geometricError: 3, getScreenSpaceError: original });
  const value = source({ root: tile(empty(), [sibling, branch]), memoryAdjustedScreenSpaceError: 32 });
  mutate(branch, 'tileset', value);
  const descriptor = Object.getOwnPropertyDescriptor(branch, 'getScreenSpaceError');
  const view = viewer(); let renderRequests = 0;
  view.scene.requestRender = () => { renderRequests++; };
  const owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, [sibling]); mutate(branch, '_visitedFrame', 1); mutate(missing, '_updatedVisibilityFrame', -1);
  assert.equal(canTraverse(branch), false, 'the real engine stops at a coarse empty parent');
  assert.equal(owner.getStatus().ready, false, 'installing a refinement request is never proof of coverage');
  const patched = (branch as unknown as { getScreenSpaceError: typeof original }).getScreenSpaceError;
  assert.notEqual(patched, original); assert.equal(renderRequests, 1);
  assert.equal(patched.call(branch, {}, true), 2300, 'parent error queries retain their exact semantics');
  assert.equal(patched.call(branch, {}, false, .3), 3, 'progressive detail/priority queries retain their exact semantics');
  mutate(branch, '_screenSpaceError', patched.call(branch, {}, false));
  assert.equal(canTraverse(branch), true, 'the next pinned traversal can descend into the required child');
  assert.equal(branch.geometricError, 3, 'the original geometric error is never edited');
  assert.equal(owner.getStatus().ready, false, 'missing child remains blocking after traversal is enabled');
  render(view, value, [sibling]); mutate(branch, '_visitedFrame', 2);
  assert.equal(owner.getStatus().ready, false, 'a visited but unloaded child still has no depth');
  mutate(missing, 'content', mesh()); render(view, value, [sibling, missing]);
  assert.equal(owner.getStatus().ready, true, 'only a current drawn child completes the depth coverage');
  owner.restore(); owner.restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(branch, 'getScreenSpaceError'), descriptor);
  assert.equal(view.scene.preRender.numberOfListeners, 0);
  // A second session reuses the same tile safely; inheritance is restored exactly.
  delete (branch as unknown as { getScreenSpaceError?: typeof original }).getScreenSpaceError;
  const prototype = { getScreenSpaceError: original }; Object.setPrototypeOf(branch, prototype);
  mutate(branch, '_screenSpaceError', 8);
  const second = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, [sibling]); mutate(branch, '_visitedFrame', 4); mutate(missing, '_updatedVisibilityFrame', -1);
  assert.equal(second.getStatus().ready, false);
  assert.equal(Object.hasOwn(branch, 'getScreenSpaceError'), true);
  second.restore();
  assert.equal(Object.hasOwn(branch, 'getScreenSpaceError'), false);
  assert.equal((branch as unknown as { getScreenSpaceError: typeof original }).getScreenSpaceError, original);
  assert.equal(view.scene.preRender.numberOfListeners, 0);
});

test('empty refinement cannot bypass stale views, request volumes, external content or new method owners', () => {
  const sibling = tile(), missing = tile({ ...empty(), ready: false });
  const original = () => 8;
  const branch = tile(empty(), [missing], { hasEmptyContent: true, hasRenderableContent: false,
    _screenSpaceError: 8, _visible: true, getScreenSpaceError: original });
  const value = source({ root: tile(empty(), [sibling, branch]) }), view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, [sibling]); mutate(missing, '_updatedVisibilityFrame', -1);
  const method = () => (branch as unknown as { getScreenSpaceError: () => number }).getScreenSpaceError;
  assert.equal(owner.getStatus().ready, false); assert.equal(method(), original, 'unvisited containers are not forced');
  mutate(branch, '_visitedFrame', 1); mutate(branch, '_inRequestVolume', false);
  assert.equal(owner.getStatus().ready, false); assert.equal(method(), original, 'viewer request limits remain blocking');
  mutate(branch, '_inRequestVolume', true); mutate(branch, '_visible', false);
  assert.equal(owner.getStatus().ready, false); assert.equal(method(), original, 'culled containers are not forced');
  mutate(branch, '_visible', true); mutate(branch, 'hasTilesetContent', true);
  assert.equal(owner.getStatus().ready, false); assert.equal(method(), original, 'external branches keep native traversal/loading rules');
  mutate(branch, 'hasTilesetContent', false); mutate(branch, 'hasRenderableContent', true);
  assert.equal(owner.getStatus().ready, false); assert.equal(method(), original, 'missing coarse geometry is not called an empty routing tile');
  mutate(branch, 'hasRenderableContent', false); mutate(branch, '_updatedVisibilityFrame', -1);
  assert.equal(owner.getStatus().ready, false); assert.equal(method(), original, 'old visibility cannot cause a refinement override');
  render(view, value, [sibling]); mutate(branch, '_visitedFrame', 2); mutate(missing, '_updatedVisibilityFrame', -1);
  assert.equal(owner.getStatus().ready, false); assert.notEqual(method(), original);
  const otherOwner = () => 123; mutate(branch, 'getScreenSpaceError', otherOwner);
  owner.restore(); assert.equal(method(), otherOwner, 'exit preserves a later method owner');
});

test('an empty-only current render can start refinement but cannot report depth coverage', () => {
  const missing = tile({ ...empty(), ready: false }), original = () => 8;
  const branch = tile(empty(), [missing], { hasEmptyContent: true, hasRenderableContent: false,
    _screenSpaceError: 8, _visible: true, getScreenSpaceError: original });
  const root = tile(empty(), [branch], { hasEmptyContent: true, hasRenderableContent: false, _screenSpaceError: 100, _visible: true });
  const value = source({ root }), view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, []); mutate(root, '_visitedFrame', 1); mutate(branch, '_visitedFrame', 1); mutate(missing, '_updatedVisibilityFrame', -1);
  assert.equal(owner.getStatus().ready, false, 'zero tileVisible/draw commands never proves depth');
  const method = (branch as unknown as { getScreenSpaceError: typeof original }).getScreenSpaceError;
  assert.notEqual(method, original, 'a completed current empty traversal can still request missing descendants');
  mutate(branch, '_screenSpaceError', method.call(branch));
  assert.equal(owner.getStatus().ready, false);
  mutate(missing, 'content', mesh()); render(view, value, [missing]);
  assert.equal(owner.getStatus().ready, true, 'readiness starts only after a descendant mesh is submitted');
  owner.restore();
  // A render callback alone is insufficient if the source did not traverse.
  mutate(branch, '_screenSpaceError', 8);
  const idle = new VideoOverlayOcclusion('survey', value, view.scene);
  const state = (view.scene as unknown as { frameState: { frameNumber: number } }).frameState;
  state.frameNumber++; view.scene.preRender.raiseEvent();
  mutate(root, '_visitedFrame', state.frameNumber); mutate(branch, '_visitedFrame', state.frameNumber);
  assert.equal(idle.getStatus().ready, false);
  assert.equal((branch as unknown as { getScreenSpaceError: typeof original }).getScreenSpaceError, original, 'an unchanged pre-render epoch cannot prime stale geometry');
  idle.restore();
});

test('real empty leaves and outside content can be skipped but unopened external branches cannot', () => {
  const a = tile(), b = tile(empty(), [], { hasEmptyContent: true, hasRenderableContent: false });
  const value = source({ root: tile(empty(), [a, b]) });
  const view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, [a]); assert.equal(owner.getStatus().ready, true);
  mutate(b, 'hasTilesetContent', true); assert.equal(owner.getStatus().ready, false);
  const c = tile(); b.children.push(c);
  render(view, value, [a, c]); assert.equal(owner.getStatus().ready, true);
  b.children.length = 0; mutate(b, 'hasTilesetContent', false); mutate(b, 'hasEmptyContent', false);
  mutate(b, 'content', mesh()); mutate(b, 'hasRenderableContent', true);
  mutate(b, 'contentVisibility', () => -1);
  render(view, value, [a]); assert.equal(owner.getStatus().ready, true);
  mutate(b, 'contentVisibility', () => 0); assert.equal(owner.getStatus().ready, false);
  owner.restore();
});

test('ADD respects explicit SSE exclusions but retains required visible children', () => {
  const child = tile(), root = tile(mesh(), [child], { refine: 0, _screenSpaceError: 8 });
  const value = source({ root }), view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, [root]); mutate(child, '_updatedVisibilityFrame', -1);
  assert.equal(owner.getStatus().ready, true, 'low SSE does not require unvisited descendants');
  mutate(root, '_screenSpaceError', 32); assert.equal(owner.getStatus().ready, false);
  render(view, value, [root]); assert.equal(owner.getStatus().ready, false);
  mutate(child, 'getScreenSpaceError', () => 8); assert.equal(owner.getStatus().ready, true, 'matches explicit ADD-child SSE cull');
  child.children.push(tile()); mutate(child, 'hasTilesetContent', true);
  render(view, value, [root]);
  assert.equal(owner.getStatus().ready, false, 'expanded external wrappers traverse their missing child before ADD SSE culling');
  child.children.length = 0; mutate(child, 'hasTilesetContent', false);
  mutate(child, 'getScreenSpaceError', () => 32); assert.equal(owner.getStatus().ready, false);
  render(view, value, [root, child]); assert.equal(owner.getStatus().ready, true);
  owner.restore();
});

test('partially failed multiple content and external branches cannot bypass missing content', () => {
  const child = tile(), content = { ...empty(), innerContents: [mesh()], _innerContentHeaders: [{}, {}] };
  const root = tile(content, [child], { hasRenderableContent: true, hasTilesetContent: true });
  const value = source({ root }), view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value, [root, child]); assert.equal(owner.getStatus().ready, false);
  render(view, value, [child]); assert.equal(owner.getStatus().ready, false, 'missing external header cannot be hidden by surviving children');
  content._innerContentHeaders.pop();
  render(view, value, [root]); assert.equal(owner.getStatus().ready, false, 'mixed parent mesh does not replace external child coverage');
  render(view, value, [root, child]); assert.equal(owner.getStatus().ready, true);
  mutate(root, 'commandsLength', 0); assert.equal(owner.getStatus().ready, false);
  render(view, value, [child]); assert.equal(owner.getStatus().ready, true, 'replacement descendants may replace a complete external parent');
  owner.restore();
});

test('empty/external containers wait for a mesh; nested point clouds and unsupported geometry fail', () => {
  const value = source({ root: tile(empty()) });
  const view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  assert.equal(owner.getStatus().ready, false);
  const loaded = tile({ ...empty(), innerContents: [mesh()] });
  value.tileLoad.raiseEvent(loaded);
  assert.equal(owner.getStatus().ready, false, 'loaded/cached mesh alone proves no current coverage');
  value.root.children.push(loaded); render(view, value, [loaded]);
  assert.equal(owner.getStatus().ready, true);
  value.tileVisible.raiseEvent(tile({ ...empty(), innerContents: [mesh(), { ...empty(), pointsLength: 10 }] }));
  assert.match(owner.getStatus().error!, /点云/);
  owner.restore();
  assert.throws(() => new VideoOverlayOcclusion('bad', source({ root: tile({ ...empty(), innerContents: [mesh(), { ...empty(), pointsLength: 1 }] }) }), view.scene), /点云/);
  assert.throws(() => new VideoOverlayOcclusion('bad', source({ root: tile({ ...empty(), geometryByteLength: 123 }) }), view.scene), /不支持/);
});

test('network failures remain warnings while current coverage recovers; shader conflicts remain fatal', () => {
  const value = source();
  const view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  render(view, value);
  value.tileFailed.raiseEvent({ message: 'network failed' });
  assert.equal(owner.getStatus().ready, true); assert.equal(owner.getStatus().error, undefined);
  assert.match(owner.getStatus().warning!, /加载失败/);
  render(view, value, []); assert.equal(owner.getStatus().ready, false);
  render(view, value); assert.equal(owner.getStatus().ready, true);
  owner.restore();
  const originalStyle = new Cesium3DTileStyle({ color: "color('red')" });
  const externalStyle = new Cesium3DTileStyle({ color: "color('blue')" });
  const other = source({ style: originalStyle });
  const second = new VideoOverlayOcclusion('survey', other, view.scene);
  const owned = other.customShader!;
  const external = new CustomShader({});
  other.customShader = external; other.style = externalStyle;
  assert.equal(second.getStatus().ready, false); assert.match(second.getStatus().error!, /其他功能/);
  second.restore();
  assert.equal(other.customShader, external); assert.equal(other.style, externalStyle);
  assert.equal(other.debugWireframe, true); assert.equal(other.splitDirection, -1);
  assert.equal(owned.isDestroyed(), true); assert.equal(external.isDestroyed(), false);
  external.destroy();
});

test('resource depth role wins over texture selection and respects global visibility', async () => {
  const value = source(), depth = record('survey', value);
  const view = viewer(), session = await VideoOverlayResources.create({ viewer: view, imports: () => [depth], getRecord: () => undefined });
  session.applyAdjustments({ survey: { east: 0, north: 0, up: 0, heading: 0 } });
  assert.ok(Matrix4.equals(value.modelMatrix, base));
  session.setOcclusion('survey');
  const matrix = value.modelMatrix, shader = value.customShader;
  session.setSelection([]);
  assert.equal(value.show, true); assert.equal(session.get('survey')?.selected, false);
  render(view, value);
  assert.equal(session.get('survey')?.occluder, true); assert.equal(session.getOcclusionStatus().ready, true);
  session.setSelection(['survey']);
  assert.equal(value.customShader, shader); assert.equal(value.show, true);
  value.tileFailed.raiseEvent({ message: 'one detail tile failed' }); session.setVisible(true);
  assert.equal(value.show, true); assert.equal(session.getOcclusionStatus().ready, true);
  assert.match(session.getOcclusionStatus().warning!, /加载失败/);
  session.applyAdjustments({ survey: { east: 0, north: 0, up: 0, heading: 0 } });
  assert.equal(value.modelMatrix, matrix);
  session.setVisible(false); assert.equal(value.show, false);
  session.setVisible(true); assert.equal(value.show, true);
  session.setOcclusion();
  assert.equal(value.customShader, undefined); assert.equal(value.show, true);
  assert.equal(session.get('survey')?.occluder, undefined);
  assert.deepEqual(session.getOcclusionStatus(), { enabled: false, ready: true });
  session.restore();
  assert.ok(Matrix4.equals(value.modelMatrix, base)); assert.equal(value.show, true);
});

test('source offsets are preserved and forbidden active edits reject the entire patch', async () => {
  const value = source();
  const engineer = { show: true, modelMatrix: Matrix4.clone(base), boundingSphere: new BoundingSphere(center, 20) };
  const imports = [record('survey', value), record('bridge', engineer, 'Model')];
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  session.applyAdjustments({ survey: { up: 29 } });
  const moved = Matrix4.clone(value.modelMatrix);
  assert.throws(() => session.setOcclusion('survey'), /已有独立 AR 位置微调/);
  assert.ok(Matrix4.equals(value.modelMatrix, moved)); assert.equal(session.getAdjustments().survey.up, 29);
  session.applyAdjustments({ survey: { up: 0 } });
  for (const key of ['tiltEast', 'tiltNorth'] as const) {
    session.applyAdjustments({ survey: { [key]: 0.1 } });
    assert.throws(() => session.setOcclusion('survey'), /已有独立 AR 位置微调/);
    session.applyAdjustments({ survey: { [key]: 0 } });
  }
  session.setOcclusion('survey');
  assert.throws(() => session.applyAdjustments({ bridge: { east: 20 }, survey: { north: 1 } }), /不能同时/);
  for (const key of ['tiltEast', 'tiltNorth'] as const) {
    assert.throws(() => session.applyAdjustments({ bridge: { east: 20 }, survey: { [key]: 0.1 } }), /不能同时/);
  }
  assert.ok(Matrix4.equals(engineer.modelMatrix, base)); assert.ok(Matrix4.equals(value.modelMatrix, base));
  assert.equal(session.getAdjustments().bridge.east, 0);
  session.restore();
});

test('revocation or replacement stops readiness, hides source and releases only the owned shader', async () => {
  const value = source();
  let imports = [record('survey', value)];
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  session.setOcclusion('survey');
  const owned = value.customShader!;
  imports = [record('survey', source())];
  assert.equal(session.getOcclusionStatus().ready, false);
  assert.match(session.getOcclusionStatus().error!, /已移除或不可用/);
  assert.equal(value.show, false); assert.equal(value.customShader, undefined);
  assert.equal(owned.isDestroyed(), true);
  session.restore();
});

test('presentation coverage never edits shader or detail and distinguishes offscreen models from missing occluder coverage', () => {
  const originalShader = new CustomShader({}), value = source({ customShader: originalShader, maximumScreenSpaceError: 6 });
  const view = viewer(), presentation = new VideoOverlayTileCoverage(value, view.scene, false);
  assert.equal(value.customShader, originalShader); assert.equal(value.maximumScreenSpaceError, 6);
  assert.equal(presentation.isReady(), false);
  render(view, value); assert.equal(presentation.isReady(), true);
  render(view, value, []); mutate(value.root, '_visibilityPlaneMask', 0xffffffff);
  assert.equal(presentation.isReady(), true, 'an offscreen engineering model has no missing image geometry');
  const surface = new VideoOverlayTileCoverage(value, view.scene);
  render(view, value, []); mutate(value.root, '_visibilityPlaneMask', 0xffffffff);
  assert.equal(surface.isReady(), false, 'an offscreen surface cannot prove ground coverage');
  presentation.restore(); presentation.restore(); surface.restore();
  assert.equal(view.scene.preRender.numberOfListeners, 0); assert.equal(value.tileVisible.numberOfListeners, 0);
  assert.equal(presentation.isReady(), false); assert.equal(value.customShader, originalShader);
  originalShader.destroy();
});

test('exit retains full detail, trims only unused video-route tile cache on the next map frame, and is idempotent', async () => {
  // Exercise the actual pinned Cesium cache, which queues trim for the next
  // render frame rather than issuing WebGL deletes from event handlers.
  const enginePath = createRequire(import.meta.resolve('cesium')).resolve('@cesium/engine');
  const cacheUrl = new URL('./Source/Scene/Cesium3DTilesetCache.js', pathToFileURL(enginePath)).href;
  const { default: CesiumTilesetCache } = await import(cacheUrl);
  const cache = new CesiumTilesetCache();
  const mapTile = { cacheNode: undefined, bytes: 128 }, arCurrent = { cacheNode: undefined, bytes: 256 }, arRoute = { cacheNode: undefined, bytes: 512 };
  const resident = new Set([mapTile, arCurrent, arRoute]);
  for (const entry of resident) cache.add(entry);
  cache.reset(); cache.touch(arCurrent);
  let trims = 0, releases = 0;
  const value = source({ maximumScreenSpaceError: 6, _cache: cache, cacheBytes: 4096, totalMemoryUsageInBytes: 896,
    trimLoadedTiles: () => { trims++; cache.trim(); } });
  const view = viewer(), owner = new VideoOverlayOcclusion('survey', value, view.scene);
  assert.equal(value.maximumScreenSpaceError, 6, 'AR must preserve the requested geometry detail');
  owner.restore(); owner.restore();
  assert.equal(trims, 1); assert.equal(resident.size, 3, 'exit schedules cache release without deleting live GPU tiles immediately');
  // The controller restores the map camera before this next frame traverses.
  cache.reset(); cache.touch(mapTile);
  cache.unloadTiles(value, (_source: unknown, entry: typeof mapTile) => { resident.delete(entry); releases += entry.bytes; });
  assert.deepEqual([...resident], [mapTile]); assert.equal(releases, 768);
  cache.unloadTiles(value, () => { throw new Error('trim must not keep evicting every frame'); });
  assert.equal(view.scene.preRender.numberOfListeners, 0); assert.equal(value.tileVisible.numberOfListeners, 0);
});

test('a failing property restore or listener remover cannot leave AR callbacks or shader allocations active', () => {
  const originalStyle = new Cesium3DTileStyle({ color: "color('white')" }), value = source({ style: originalStyle });
  const view = viewer();
  const event = view.scene.preRender, add = event.addEventListener.bind(event);
  event.addEventListener = ((...args: Parameters<typeof event.addEventListener>) => {
    const remove = add(...args); return () => { remove(); throw new Error('host listener teardown failed'); };
  }) as typeof event.addEventListener;
  let style = originalStyle as Cesium3DTileStyle | undefined, trims = 0;
  Object.defineProperty(value, 'style', { configurable: true, get: () => style, set: next => {
    if (next === originalStyle) throw new Error('host refuses old style'); style = next;
  } });
  mutate(value, 'trimLoadedTiles', () => { trims++; });
  const owner = new VideoOverlayOcclusion('survey', value, view.scene), shader = value.customShader!;
  assert.doesNotThrow(() => owner.restore());
  assert.equal(shader.isDestroyed(), true); assert.equal(trims, 1);
  assert.equal(value.debugWireframe, true); assert.equal(value.cullRequestsWhileMoving, true);
  assert.equal(view.scene.preRender.numberOfListeners, 0); assert.equal(value.tileVisible.numberOfListeners, 0);
  assert.equal(value.tileLoad.numberOfListeners, 0); assert.equal(value.tileFailed.numberOfListeners, 0);
});

test('model timeline effects preserve the independent depth role, current-pass Tiles readiness, and exit releases selection trackers', async () => {
  let surfaceTrims = 0, engineeringTrims = 0;
  const surface = source({ trimLoadedTiles: () => { surfaceTrims++; } });
  const engineering = source({ trimLoadedTiles: () => { engineeringTrims++; } });
  const view = viewer(), imports = [record('surface', surface), record('engineering', engineering)];
  const session = await VideoOverlayResources.create({ viewer: view, imports: () => imports, getRecord: () => undefined });
  session.setOcclusion('surface'); session.setSelection(['surface', 'engineering']);
  const depthShader = surface.customShader;
  session.setTimelineOpacity({ surface: { opacity: 0, visible: false } });
  assert.equal(surface.customShader, depthShader); assert.equal(surface.show, true, 'fade cues must never hide the occluder');
  assert.equal(session.isPresentationReady(true), true, 'preRender leaves current Tiles coverage to the render pass');
  assert.equal(session.isPresentationReady(), false, 'loading/cached Tiles cannot prove submitted current geometry');
  render(view, engineering);
  assert.equal(session.isPresentationReady(), true);
  mutate(engineering.root, 'commandsLength', 0);
  assert.equal(session.isPresentationReady(), false, 'tileVisible alone is not a submitted model frame');
  session.restore(); session.restore();
  assert.equal(engineeringTrims, 1); assert.ok(surfaceTrims >= 1);
  assert.equal(view.scene.preRender.numberOfListeners, 0);
  assert.equal(surface.tileVisible.numberOfListeners, 0); assert.equal(engineering.tileVisible.numberOfListeners, 0);
  assert.equal(surface.customShader, undefined); assert.equal(surface.show, true); assert.equal(engineering.show, true);
});
