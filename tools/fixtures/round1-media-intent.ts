import { Cartesian3, ClippingPlane, ClippingPlaneCollection } from 'cesium';
import { CadLoadRegistry } from '../../src/cadLoadRegistry';
import { releaseBorrowedClippingPlanes } from '../../src/borrowedClippingPolygons';
import type { ModelEditor } from '../../src/modelEditor';
import { SceneEffectsCoordinator } from '../../src/sceneEffectsCoordinator';
import { SceneLibrary } from '../../src/sceneLibrary';
import { SubsurfaceTools, subsurfacePanelHtml } from '../../src/subsurfaceTools';
import { getTemporaryWorksClippingManager } from '../../src/temporaryWorksGlbScene';
import { VideoModelOverlay, videoModelOverlayPanelHtml, type SavedVideoOverlaySettings } from '../../src/videoModelOverlay';
import type { ImportRecord } from '../../src/types';
import { surfaceFixture, syntheticSurfaceAssets, viewer, world, renderFrames } from './surface-edit';

// Actual panel handlers, decoders, SceneLibrary HTTP reads and scene owners.
// The runner supplies synthetic catalogue/file HTTP responses, not substitutes
// for controller functions. No production files or browser profile are used.
document.getElementById('overlay-panel')!.innerHTML = videoModelOverlayPanelHtml;
document.getElementById('subsurface-host')!.insertAdjacentHTML('beforeend', subsurfacePanelHtml);
const coordinator = new SceneEffectsCoordinator();
const messages: { message: string; error: boolean }[] = [];
const imports: ImportRecord[] = [];
let library: SceneLibrary, overlay: VideoModelOverlay, subsurface: SubsurfaceTools;
let foreign: ClippingPlaneCollection | undefined;
let foreignCleanup: { aliasesBefore: number; releasedAliases: number; remainingAliases: number; detached: boolean; destroyed: boolean } | undefined;
type BorrowedContent = { _model?: { _clippingPlanes?: object }; innerContents?: readonly BorrowedContent[] };
type BorrowedTile = { content?: BorrowedContent; children?: readonly BorrowedTile[] };
const countBorrowers = (collection: object) => {
  const pending: BorrowedTile[] = [syntheticSurfaceAssets().tiles.root as unknown as BorrowedTile];
  const tiles = new Set<BorrowedTile>(), contents = new Set<BorrowedContent>(), models = new Set<object>();
  while (pending.length) {
    const tile = pending.pop()!; if (tiles.has(tile)) continue; tiles.add(tile);
    for (const child of tile.children ?? []) pending.push(child);
    const children = tile.content ? [tile.content] : [];
    while (children.length) {
      const content = children.pop()!; if (contents.has(content)) continue; contents.add(content);
      for (const child of content.innerContents ?? []) children.push(child);
      if (content._model?._clippingPlanes === collection) models.add(content._model);
    }
  }
  return models.size;
};
const change = (id: string, value: string | boolean, event = 'change') => {
  const element = document.getElementById(id) as HTMLInputElement;
  if (typeof value === 'boolean') element.checked = value; else element.value = value;
  element.dispatchEvent(new Event(event, { bubbles: true }));
};
const clip = (target: { clippingPlanes?: ClippingPlaneCollection }) => {
  const collection = target.clippingPlanes;
  return collection ? { enabled: collection.enabled, length: collection.length, destroyed: collection.isDestroyed(),
    distance: collection.length ? collection.get(0).distance : null } : null;
};
const state = () => ({
  ready: api.ready, active: overlay?.active ?? false, leases: coordinator.leaseCount,
  videoFileInput: (document.getElementById('ccVideoFile') as HTMLInputElement).files?.[0]?.name ?? null,
  schemeName: (document.getElementById('ccSchemeName') as HTMLInputElement).value,
  occlusion: (document.getElementById('ccOcclusionEnabled') as HTMLInputElement).checked,
  occlusionSource: (document.getElementById('ccOcclusionSource') as HTMLSelectElement).value,
  sourceClipping: api.ready ? clip(syntheticSurfaceAssets().tiles) : null,
  engineeringClipping: api.ready ? clip(syntheticSurfaceAssets().engineering) : null,
  sectionEnabled: (document.getElementById('sectionEnabled') as HTMLInputElement).checked,
  sectionOffset: (document.getElementById('sectionOffset') as HTMLInputElement).value,
  foreignBound: api.ready && !!foreign && syntheticSurfaceAssets().tiles.clippingPlanes === foreign,
  foreignDestroyed: foreign?.isDestroyed() ?? null,
  foreignBorrowers: api.ready && foreign ? countBorrowers(foreign) : 0,
  foreignCleanup: foreignCleanup ?? null,
  libraryActiveVideo: library?.activeVideoRecordId ?? null, libraryBusy: library?.busy ?? true,
  messages: [...messages], renderErrors: surfaceFixture.errors(),
});
const api = {
  ready: false, failure: '', state, gpu: () => surfaceFixture.gpu(),
  // Picked points are supplied analytically. Toggle handlers and resource owners
  // remain the product code, with real Cesium collections and lifecycle.
  async legacySection(enabled: boolean) {
    overlay.setPanelActive(false);
    (subsurface as unknown as { sectionAnchor: Cartesian3 }).sectionAnchor = world(0, 0, 5);
    change('sectionDirection', 'eastWest'); change('sectionOffset', '17', 'input');
    change('sectionEnabled', enabled); subsurface.refreshClipping(); await renderFrames(6);
    return state();
  },
  async addForeignClip() {
    if (coordinator.leaseCount) throw new Error('Must release AR before foreign-owner scenario');
    change('sectionEnabled', false); subsurface.refreshClipping();
    foreignCleanup = undefined;
    foreign = new ClippingPlaneCollection({ planes: [new ClippingPlane(Cartesian3.UNIT_X, 3)] });
    syntheticSurfaceAssets().tiles.clippingPlanes = foreign; await renderFrames(4); return state();
  },
  async removeForeignClip() {
    const tiles = syntheticSurfaceAssets().tiles, owned = foreign;
    if (!owned || tiles.clippingPlanes !== owned) throw new Error('Fixture no longer owns its foreign clipping collection');
    // This fixture is the foreign owner. Cesium 1.144 destroys the collection
    // in the public tileset setter, but loaded tile-model commands can still
    // capture its texture. Use the same exact-alias release as SubsurfaceTools
    // before the setter; the AR rejection itself must never perform this cleanup.
    const aliasesBefore = countBorrowers(owned), releasedAliases = releaseBorrowedClippingPlanes(tiles, owned);
    owned.enabled = false;
    (tiles as { clippingPlanes?: ClippingPlaneCollection }).clippingPlanes = undefined;
    if (!owned.isDestroyed()) owned.destroy();
    foreign = undefined;
    await renderFrames(4);
    foreignCleanup = { aliasesBefore, releasedAliases, remainingAliases: countBorrowers(owned),
      detached: tiles.clippingPlanes !== owned, destroyed: owned.isDestroyed() };
    return state();
  },
  async settle() { await renderFrames(5); return state(); },
};
Object.assign(window, { __round1MediaIntent: api });
void (async () => {
  const deadline = performance.now() + 60_000;
  while (!surfaceFixture.ready) {
    if (surfaceFixture.failure) throw new Error(surfaceFixture.failure);
    if (performance.now() > deadline) throw new Error('Synthetic geometry initialization timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const { tiles, engineering, renderer } = syntheticSurfaceAssets();
  imports.push({ id: 'synthetic-photography', name: 'Synthetic photography', kind: '3D Tiles', resource: tiles, visible: true },
    { id: 'synthetic-engineering', name: 'Synthetic engineering', kind: 'Model', resource: engineering, visible: true });
  subsurface = new SubsurfaceTools(viewer, () => imports, (message, error = false) => messages.push({ message, error }));
  const managerOwner = {};
  coordinator.register('subsurface', () => subsurface.suspendExternalSceneEffects());
  coordinator.register('managed-clipping', () => getTemporaryWorksClippingManager(viewer).suspend(managerOwner));
  coordinator.register('surface-edit', () => { renderer.setSuspended(true); return () => renderer.setSuspended(false); });
  overlay = new VideoModelOverlay(viewer, { getImports: () => imports, getRecord: id => library?.records.get(id),
    notify: (message, error = false) => messages.push({ message, error }),
    onReplayInputChanged: () => library.invalidatePendingVideoRestore(),
    suspendExternalSceneEffects: () => coordinator.acquire() });
  library = new SceneLibrary({ viewer, getImports: () => imports, cadLoads: new CadLoadRegistry(),
    modelEditor: {} as ModelEditor, addImport: () => { throw new Error('Fixture dependencies must already be loaded'); }, removeImport() {},
    waitForModelReady: async () => {}, cacheGisBoundingSphere: async () => {}, replaceImagery() {},
    setBasemap() {}, getBasemap: () => 'none', notify: (message, error = false) => messages.push({ message, error }),
    layersChanged() {}, clearVideo: () => overlay.clear(), getContextKey: () => 'synthetic-project-owner',
    restoreVideo: (files, settings, id, checkCurrent) => overlay.restoreReplay(files, settings as SavedVideoOverlaySettings, id, checkCurrent),
  });
  await library.start();
  if (library.busy) throw new Error('Synthetic library startup did not settle');
  // Exercise a normal panel activation followed by file selection releasing it.
  overlay.setPanelActive(true); overlay.setPanelActive(false);
  await renderFrames(4); api.ready = true;
})().catch(error => { api.failure = String(error.stack || error); });
