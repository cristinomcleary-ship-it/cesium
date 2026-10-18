import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoundingSphere, Cartesian3, Cesium3DTileset, Cesium3DTileStyle, CustomShader,
  CustomShaderMode, CustomShaderTranslucencyMode, Event as CesiumEvent, JulianDate,
  LightingModel, Matrix4, PointCloudShading, PrimitiveCollection, Transforms,
  type Cesium3DTile, type Viewer,
} from 'cesium';
import {
  assertVideoOverlayOccluder, validateVideoOverlayOcclusion, VideoOverlayOcclusion,
  type SavedVideoOverlayOcclusion,
} from './videoOverlayOcclusion.ts';
import { VideoOverlayResources } from './videoOverlayResources.ts';
import type { ImportRecord } from './types.ts';

const center = Cartesian3.fromDegrees(120, 30, 25);
const base = Transforms.eastNorthUpToFixedFrame(center);
const mesh = () => ({ pointsLength: 0, trianglesLength: 12, geometryByteLength: 144, ready: true });
function tile(content: unknown = mesh()): Cesium3DTile { return { content, children: [] } as unknown as Cesium3DTile; }
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
  return { clock: { currentTime: JulianDate.now() }, scene: { primitives: new PrimitiveCollection(), requestRender() {} } } as unknown as Viewer;
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
  const owner = new VideoOverlayOcclusion('survey', value);
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
  assert.equal(owner.getStatus().ready, true);
  assert.equal(value.tileLoad.numberOfListeners, 1);
  owner.restore(); owner.restore();
  assert.equal(value.customShader, originalShader); assert.equal(value.style, style);
  assert.equal(value.pointCloudShading, originalShading); assert.equal(value.debugWireframe, true);
  assert.equal(value.showOutline, true); assert.equal(value.splitDirection, -1);
  assert.equal(depthShader.isDestroyed(), true); assert.equal(originalShader.isDestroyed(), false);
  assert.equal(value.tileLoad.numberOfListeners, 0); assert.equal(value.tileVisible.numberOfListeners, 0);
  assert.equal(value.tileFailed.numberOfListeners, 0);
  assert.equal(owner.getStatus().ready, false);
  originalShader.destroy();
});

test('readiness checks current traversal counters before tilesLoaded catches up and fails closed', () => {
  const value = source({ tilesLoaded: false });
  const owner = new VideoOverlayOcclusion('survey', value);
  assert.equal(owner.getStatus().ready, false);
  mutate(value, 'tilesLoaded', true);
  assert.equal(owner.getStatus().ready, true);
  for (const key of ['numberOfPendingRequests', 'numberOfTilesProcessing', 'numberOfAttemptedRequests']) {
    const counters = { numberOfPendingRequests: 0, numberOfTilesProcessing: 0, numberOfAttemptedRequests: 0, [key]: 1 };
    mutate(value, 'statistics', counters);
    assert.equal(owner.getStatus().ready, false, key);
  }
  mutate(value, 'statistics', undefined);
  assert.equal(owner.getStatus().ready, false);
  owner.restore();
});

test('empty/external containers wait for a mesh; nested point clouds and unsupported geometry fail', () => {
  const empty = { pointsLength: 0, trianglesLength: 0, geometryByteLength: 0 };
  const value = source({ root: tile(empty) });
  const owner = new VideoOverlayOcclusion('survey', value);
  assert.equal(owner.getStatus().ready, false);
  value.tileLoad.raiseEvent(tile({ ...empty, innerContents: [mesh()] }));
  assert.equal(owner.getStatus().ready, true);
  value.tileVisible.raiseEvent(tile({ ...empty, innerContents: [mesh(), { ...empty, pointsLength: 10 }] }));
  assert.match(owner.getStatus().error!, /点云/);
  owner.restore();
  assert.throws(() => new VideoOverlayOcclusion('bad', source({ root: tile({ ...empty, innerContents: [mesh(), { ...empty, pointsLength: 1 }] }) })), /点云/);
  assert.throws(() => new VideoOverlayOcclusion('bad', source({ root: tile({ ...empty, geometryByteLength: 123 }) })), /不支持/);
});

test('loading failures and external material ownership never reveal an unmasked overlay', () => {
  const value = source();
  const owner = new VideoOverlayOcclusion('survey', value);
  value.tileFailed.raiseEvent({ message: 'network failed' });
  assert.equal(owner.getStatus().ready, false); assert.match(owner.getStatus().error!, /加载失败/);
  owner.restore();
  const originalStyle = new Cesium3DTileStyle({ color: "color('red')" });
  const externalStyle = new Cesium3DTileStyle({ color: "color('blue')" });
  const other = source({ style: originalStyle });
  const second = new VideoOverlayOcclusion('survey', other);
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
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [depth], getRecord: () => undefined });
  session.applyAdjustments({ survey: { east: 0, north: 0, up: 0, heading: 0 } });
  assert.ok(Matrix4.equals(value.modelMatrix, base));
  session.setOcclusion('survey');
  const matrix = value.modelMatrix, shader = value.customShader;
  session.setSelection([]);
  assert.equal(value.show, true); assert.equal(session.get('survey')?.selected, false);
  assert.equal(session.get('survey')?.occluder, true); assert.equal(session.getOcclusionStatus().ready, true);
  session.setSelection(['survey']);
  assert.equal(value.customShader, shader); assert.equal(value.show, true);
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
  session.setOcclusion('survey');
  assert.throws(() => session.applyAdjustments({ bridge: { east: 20 }, survey: { north: 1 } }), /不能同时/);
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
