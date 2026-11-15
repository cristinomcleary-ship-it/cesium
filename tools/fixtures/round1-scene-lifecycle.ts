import { Cartesian3, ClippingPolygonCollection, Matrix4 } from 'cesium';
import { SubsurfaceTools, subsurfacePanelHtml } from '../../src/subsurfaceTools';
import { SceneEffectsCoordinator } from '../../src/sceneEffectsCoordinator';
import { getTemporaryWorksClippingManager } from '../../src/temporaryWorksGlbScene';
import { assertVideoOverlayOccluder, VideoOverlayOcclusion } from '../../src/videoOverlayOcclusion';
import type { ImportRecord } from '../../src/types';
import { surfaceFixture, syntheticSurfaceAssets, viewer, world, renderFrames } from './surface-edit';

// The browser is launched with an empty, ephemeral profile and this fixture uses
// generated GLBs only. SubsurfaceTools is the real class with real Cesium owners;
// only initial picked world points are supplied directly to avoid pixel ambiguity.
type SyntheticSubsurface = {
  sectionAnchor: Cartesian3 | null;
  excavationPoints: Cartesian3[];
  excavationPointSources: string[];
  excavationFinished: boolean;
  updateExcavationGraphic(closed: boolean): void;
};
let subsurface: SubsurfaceTools;
const coordinator = new SceneEffectsCoordinator(), managerOwner = {};
const releases = new Map<string, () => void>();
const messages: { message: string; error: boolean }[] = [];
let imports: ImportRecord[] = [], occluder: VideoOverlayOcclusion | undefined;
let disposed = false, lastReleasedCollections: { destroyed: boolean }[] = [];
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const change = (id: string, value: boolean | string, event = 'change') => {
  const element = input(id);
  if (typeof value === 'boolean') element.checked = value; else element.value = value;
  element.dispatchEvent(new Event(event, { bubbles: true }));
};
const owned = () => {
  const { tiles, engineering } = syntheticSurfaceAssets();
  return [viewer.scene.globe, tiles, engineering].filter(target => !target.isDestroyed?.())
    .flatMap(target => [target.clippingPlanes, target.clippingPolygons])
    .filter(collection => collection && collection.enabled && collection.length > 0);
};
const clipping = (target: { isDestroyed(): boolean; clippingPlanes?: any; clippingPolygons?: any }) => {
  if (target.isDestroyed()) return { destroyed: true, planes: null, polygons: null };
  const plane = target.clippingPlanes, polygon = target.clippingPolygons;
  return { destroyed: false,
    planes: plane ? { enabled: plane.enabled, length: plane.length, destroyed: plane.isDestroyed(),
      distance: plane.length ? plane.get(0).distance : null,
      normal: plane.length ? [plane.get(0).normal.x, plane.get(0).normal.y, plane.get(0).normal.z] : [],
      modelMatrix: Matrix4.toArray(plane.modelMatrix) } : null,
    polygons: polygon ? { enabled: polygon.enabled, length: polygon.length, destroyed: polygon.isDestroyed(), inverse: polygon.inverse,
      positions: polygon.length ? polygon.get(0).positions.map((p: Cartesian3) => [p.x, p.y, p.z]) : [] } : null };
};
const controls = () => Object.fromEntries(['sectionEnabled', 'sectionDirection', 'sectionOffset', 'sectionInvert',
  'groundTransparent', 'groundAlpha', 'undergroundMode', 'clipExcavationSurface', 'excavationDepth', 'excavationMode', 'excavationSlope']
  .map(id => [id, input(id).type === 'checkbox' ? input(id).checked : input(id).value]));
const state = () => {
  const { tiles, engineering, renderer } = syntheticSurfaceAssets();
  return { leases: coordinator.leaseCount, imports: imports.map(item => item.id), controls: controls(),
    tiles: clipping(tiles), engineering: clipping(engineering), globe: clipping(viewer.scene.globe),
    surface: !tiles.isDestroyed() && !engineering.isDestroyed() ? surfaceFixture.state() : null,
    surfacePrimitives: renderer.getPrimitives().map(p => ({ destroyed: p.isDestroyed(), show: p.show })),
    primitiveCount: viewer.scene.primitives.length, dataSources: viewer.dataSources.length,
    ground: { collision: viewer.scene.screenSpaceCameraController.enableCollisionDetection,
      depthTest: viewer.scene.globe.depthTestAgainstTerrain, translucency: viewer.scene.globe.translucency.enabled,
      frontAlpha: viewer.scene.globe.translucency.frontFaceAlpha, backAlpha: viewer.scene.globe.translucency.backFaceAlpha },
    shaderPresent: !tiles.isDestroyed() && !!tiles.customShader,
    occluder: occluder?.getStatus() ?? null, releasedCollections: lastReleasedCollections,
    messages: [...messages], renderErrors: surfaceFixture.errors(), disposed };
};
async function legacy(mode: 'section' | 'pit' | 'none') {
  const synthetic = subsurface as unknown as SyntheticSubsurface;
  change('sectionEnabled', false); change('clipExcavationSurface', false);
  if (mode === 'section') {
    synthetic.sectionAnchor = world(0, 0, 5);
    change('sectionDirection', 'eastWest'); change('sectionOffset', '7', 'input'); change('sectionInvert', true);
    change('sectionEnabled', true);
  } else if (mode === 'pit') {
    synthetic.excavationPoints = [[-45, -45], [45, -45], [45, 45], [-45, 45]].map(([x, y]) => world(x, y, 5));
    synthetic.excavationPointSources = Array(4).fill('倾斜摄影/模型表面'); synthetic.excavationFinished = true;
    change('excavationMode', 'vertical'); change('excavationDepth', '9', 'input');
    synthetic.updateExcavationGraphic(true); change('clipExcavationSurface', true);
  }
  subsurface.refreshClipping(); await renderFrames(8); return state();
}
const api = {
  ready: false, failure: '', state, legacy, gpu: () => surfaceFixture.gpu(),
  async setupContributions() {
    await surfaceFixture.create('excavation', 'round1-surface', 0);
    await surfaceFixture.legacy(true); await renderFrames(6); return state();
  },
  async groundMode(enabled: boolean) {
    change('groundAlpha', '0.4', 'input'); change('groundTransparent', enabled); change('undergroundMode', enabled);
    await renderFrames(); return state();
  },
  async acquire(id: string) {
    if (releases.has(id)) throw new Error('Duplicate fixture lease');
    const previous = owned(); releases.set(id, coordinator.acquire());
    lastReleasedCollections = previous.map(collection => ({ destroyed: collection!.isDestroyed() }));
    await renderFrames(6); return state();
  },
  async release(id: string) {
    const release = releases.get(id); releases.delete(id); release?.(); release?.();
    await renderFrames(8); return state();
  },
  async beginOcclusion() {
    const { tiles } = syntheticSurfaceAssets(); assertVideoOverlayOccluder(tiles);
    occluder = new VideoOverlayOcclusion('synthetic-photography', tiles, viewer.scene);
    const deadline = performance.now() + 30_000;
    do {
      await renderFrames(2); const status = occluder.getStatus();
      if (status.error) throw new Error(status.error);
      if (status.ready) return state();
    } while (performance.now() < deadline);
    throw new Error('Real Cesium occluder coverage did not become ready');
  },
  async endOcclusion() { occluder?.restore(); occluder?.restore(); occluder = undefined; await renderFrames(); return state(); },
  async editWhileSuspended() {
    if (!coordinator.leaseCount) throw new Error('Expected active fixture lease');
    change('sectionOffset', '19', 'input'); change('sectionInvert', false); await renderFrames(); return state();
  },
  async removeContributions() {
    await surfaceFixture.remove('round1-surface'); await surfaceFixture.legacy(false); return state();
  },
  async deleteImport(id: 'synthetic-engineering' | 'synthetic-photography') {
    const item = imports.find(item => item.id === id); if (!item) throw new Error('Missing synthetic import');
    subsurface.detachImport(item); imports = imports.filter(candidate => candidate !== item);
    viewer.scene.primitives.remove(item.resource); subsurface.refreshClipping();
    await renderFrames(6); return state();
  },
  async disposeOwners() {
    occluder?.restore(); occluder = undefined;
    subsurface.dispose(); subsurface.dispose(); coordinator.dispose(); coordinator.dispose();
    for (const release of releases.values()) release(); releases.clear();
    syntheticSurfaceAssets().renderer.destroy(); getTemporaryWorksClippingManager(viewer).dispose();
    disposed = true; await renderFrames(4); return state();
  },
  destroyViewer() { if (!viewer.isDestroyed()) surfaceFixture.destroy(); return { destroyed: viewer.isDestroyed(), errors: surfaceFixture.errors() }; },
};
Object.assign(window, { __round1SceneLifecycle: api });
void (async () => {
  const deadline = performance.now() + 60_000;
  while (!surfaceFixture.ready) {
    if (surfaceFixture.failure) throw new Error(surfaceFixture.failure);
    if (performance.now() > deadline) throw new Error('Synthetic assets initialization timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!ClippingPolygonCollection.isSupported(viewer.scene)) throw new Error('BLOCKED: WebGL polygon clipping is unsupported');
  document.querySelector('#fixture-controls')!.insertAdjacentHTML('beforeend', subsurfacePanelHtml);
  const { tiles, engineering, renderer } = syntheticSurfaceAssets();
  imports = [{ id: 'synthetic-photography', name: '合成摄影', kind: '3D Tiles', resource: tiles, visible: true },
    { id: 'synthetic-engineering', name: '合成构件', kind: 'Model', resource: engineering, visible: true }] as ImportRecord[];
  subsurface = new SubsurfaceTools(viewer, () => imports, (message, error = false) => messages.push({ message, error }));
  // This is the production registration order. All three real owners participate.
  coordinator.register('subsurface', () => subsurface.suspendExternalSceneEffects());
  coordinator.register('managed-clipping', () => getTemporaryWorksClippingManager(viewer).suspend(managerOwner));
  coordinator.register('surface-edit', () => { renderer.setSuspended(true); return () => renderer.setSuspended(false); });
  await renderFrames(6); api.ready = true;
})().catch(error => { api.failure = String(error.stack || error); });
