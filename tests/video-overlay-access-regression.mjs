import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { BoundingSphere, Cartesian3, Event, GroundPolylinePrimitive, JulianDate, Matrix4, Primitive, PrimitiveCollection, Transforms } from 'cesium';

// Exercise the production host callbacks and AR resource owner together, without WebGL.
const workspace = resolve(process.cwd());
const directory = await mkdtemp(`${workspace}/.video-overlay-access-test-`);
assert.ok(resolve(directory).startsWith(workspace + sep), 'temporary fixture stays within this workspace');
const oldDocument = globalThis.document, oldFetch = globalThis.fetch;
try {
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts"; export { VideoOverlayResources } from "./src/videoOverlayResources.ts";', resolveDir: process.cwd(), loader: 'ts' },
    outfile: `${directory}/fixture.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  const { VideoModelOverlay, VideoOverlayResources } = await import(pathToFileURL(`${directory}/fixture.mjs`).href);
  const source = ts.createSourceFile('main.ts', await readFile('src/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['isLibraryRecordAllowed', 'isImportAllowed', 'isImportDisplayed', 'applyImportDisplay', 'applySceneDisplay', 'renderWorkbenchMachinery'];
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(declarations.length, names.length);
  let overlayOptions;
  function visit(node) {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'VideoModelOverlay') overlayOptions = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(source);
  const property = name => overlayOptions.properties.find(node => node.name?.getText(source) === name).initializer.getText(source);
  const hostCode = ts.transpileModule(`${declarations.map(node => node.getText(source)).join('\n')}\nreturn { ${names.join(',')}, getImports: ${property('getImports')}, canAccessVideo: ${property('canAccessVideo')}, onExit: ${property('onExit')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let permissions = { models: true, files: true, media: true }, scheduled = 0;
  const imports = [], nodes = new Map();
  class Element {
    children = []; value = ''; dataset = {}; style = {}; classList = { remove() {} };
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    addEventListener() {}
    get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    set textContent(text) { this.children = [text]; }
  }
  globalThis.document = { createElement: () => new Element(), createTextNode: text => text, getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }, querySelector: () => null };
  const container = new Element(); container.parentElement = new Element();
  const postRender = new Event();
  const compile = primitive => {
    if (primitive instanceof PrimitiveCollection) { if (primitive.show) for (let i = 0; i < primitive.length; i++) compile(primitive.get(i)); }
    else if (primitive instanceof Primitive) primitive._ready = true;
  };
  let renderQueued = false;
  const viewer = { container, clock: { currentTime: JulianDate.now() }, scene: { primitives: new PrimitiveCollection(), postRender, requestRender() {
    if (renderQueued || !postRender.numberOfListeners) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; compile(viewer.scene.primitives); postRender.raiseEvent(); });
  } }, isDestroyed: () => false, resize() {} };
  const blankCompositor = () => ({ clearOverlay: () => true, dispose() {} });
  const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
    viewer, selected: new Set(), selectionInitialized: false, destroyed: false, epoch: 0,
    occlusion: { enabled: false, sourceId: '' },
    presentationEditor: { unmount() {}, setValue() {}, destroy() {} }, annotations: [],
    video: { pause() {}, removeAttribute() {}, load() {} }, updateTargets() {},
  });
  const host = new Function('managementWorkspace', 'imports', 'videoModelOverlay', 'viewer', 'scheduleSceneDisplay', 'modelEditor', 'projectLibrary', 'sceneDisplayPanel', 'document', `
    let sceneDisplayOverrides = {}, resumeVideoOverlayInteractions;
    const markupTools = undefined, foundationPitMonitoring = { setDisplayVisibility() {} }, modelQualityTrackers = new Map(), videoArFusion = { invalidateProjection() {} };
    ${hostCode}`)(
    { getWorkbenchLayerAccess: () => permissions, setWorkbenchDisplayVisibility() {} }, imports, owner, viewer, () => scheduled++, { select() {} }, { saveView() {}, render() {} }, { labelsVisible: true }, globalThis.document);
  owner.options = { getImports: host.getImports, getRecord: () => undefined, onExit: host.onExit, canAccessVideo: host.canAccessVideo };
  const anchor = Cartesian3.fromDegrees(120, 30, 25), base = Transforms.eastNorthUpToFixedFrame(anchor);
  const model = { id: 'restricted-model', name: 'Private model', kind: 'Model', visible: true, resource: { show: false, modelMatrix: Matrix4.clone(base), boundingSphere: new BoundingSphere(anchor, 20), isDestroyed: () => false } };
  const cadLeaf = { show: true, modelMatrix: Matrix4.clone(Matrix4.IDENTITY), isDestroyed: () => false, destroy() {} };
  const cadResource = new PrimitiveCollection(); cadResource.add(cadLeaf);
  const cad = { id: 'allowed-cad', name: 'Allowed CAD', kind: 'CAD', representation: 'primitive', visible: false, resource: cadResource, boundingSphere: new BoundingSphere(anchor, 20) };
  imports.push(model, cad);

  permissions.models = false;
  owner.selected = new Set([model.id, cad.id]); owner.selectionInitialized = true;
  owner.refreshResources();
  assert.deepEqual(host.getImports().map(item => item.id), [cad.id], 'AR entry uses the existing account resource gate');
  assert.equal(nodes.get('ccResources').textContent.includes(model.name), false, 'restricted names are not listed');
  assert.deepEqual([...owner.selected], [model.id, cad.id], 'revocation must preserve saved dependencies instead of overwriting the original scheme');
  assert.equal(owner.accessInvalid, true, 'inaccessible dependencies block automatic persistence while rendered resources remain filtered');
  owner.resources = await VideoOverlayResources.create({ viewer, imports: host.getImports, getRecord: () => undefined });
  owner.restoreScene = () => {}; owner.enterHooksActive = true; owner.compositor ??= blankCompositor();
  owner.refreshResources();
  assert.equal(model.resource.show, false);
  assert.equal(cad.resource.show, true, 'an authorized overlay selection is independent of map display preferences');
  owner.setPanelActive(false);
  assert.equal(model.resource.show, false);
  assert.equal(cad.resource.show, false, 'exit reapplies saved map visibility');

  permissions.models = true; model.resource.show = true;
  owner.selected = new Set([model.id, cad.id]);
  owner.resources = await VideoOverlayResources.create({ viewer, imports: host.getImports, getRecord: () => undefined });
  owner.restoreScene = () => {}; owner.enterHooksActive = true; owner.compositor ??= blankCompositor(); owner.refreshResources();
  assert.equal(model.resource.show, true);
  owner.resources.applyAdjustments({ [model.id]: { east: 10 } });
  let presentedPixels = '', gpuClearCalls = 0;
  viewer.canvas = {};
  owner.pendingTime = 0; owner.editRevision = 0; owner.track = { sample: () => ({}) };
  viewer.scene.frameState = { frameNumber: 1 }; owner.lensFrame = { number: 1, time: 0, ready: true }; owner.renderReady = true;
  owner.presentation = { width: 2, height: 2, style: {}, remove() {}, getContext() { throw new Error('A WebGL presentation must not be redrawn through Canvas2D'); } };
  owner.compositor = { commit() { presentedPixels = model.resource.show ? 'source-video+restricted-model' : 'source-video'; return true; },
    clearOverlay() { gpuClearCalls++; presentedPixels = 'source-video'; return true; }, dispose() {} };
  owner.commitPresentation();
  assert.equal(presentedPixels, 'source-video+restricted-model');
  assert.ok(owner.lastPresentationKey, 'the paused composition is cached');
  let cachePaused = 0, cacheReleased = 0;
  const previewUrl = URL.createObjectURL(new Blob(['baked-private-model']));
  owner.cachedPreview = { url: previewUrl, start: 0, end: 1, revision: 0, video: {
    currentTime: 0, pause() { cachePaused++; }, removeAttribute() {}, load() {}, remove() { cacheReleased++; },
  } };
  owner.resumeRenderLoop = true; viewer.useDefaultRenderLoop = false; owner.presentation.style.visibility = 'hidden';
  permissions.models = false;
  host.renderWorkbenchMachinery(); // Existing session-change callback; no playback frame is delivered.
  assert.equal(owner.cachedPreview, undefined, 'revocation removes the baked preview containing restricted model pixels');
  assert.equal(cachePaused, 1); assert.equal(cacheReleased, 1);
  assert.equal(viewer.useDefaultRenderLoop, true, 'revocation restores the original render loop');
  assert.equal(owner.presentation.style.visibility, '', 'the sanitized live composition replaces the restricted baked video');
  assert.equal(gpuClearCalls, 1, 'revocation synchronously clears the compositor before another scene render');
  assert.equal(presentedPixels, 'source-video', 'revocation removes cached restricted pixels before another render');
  assert.equal(owner.lastPresentationKey, '', 'resource refresh invalidates the paused composition cache');
  owner.commitPresentation();
  assert.equal(presentedPixels, 'source-video', 'the next completed frame cannot reuse the old restricted composition');
  assert.ok(scheduled > 0);
  assert.equal(model.resource.show, false, 'revocation hides a paused AR object synchronously');
  assert.equal(cad.resource.show, true);
  assert.equal(nodes.get('ccResources').textContent.includes(model.name), false);
  assert.equal(owner.selected.has(model.id), true, 'saved selection survives revocation without granting rendering access');
  assert.equal(owner.accessInvalid, true);
  host.applySceneDisplay({ [`layer:${model.id}`]: true }, true);
  assert.equal(model.resource.show, false, 'personal display overrides cannot bypass access while AR is active');
  model.resource.show = true; host.applyImportDisplay(model);
  assert.equal(model.resource.show, false, 'a late-loaded unauthorized resource is hidden during AR');
  owner.setPanelActive(false);
  assert.equal(model.resource.show, false, 'exit does not restore the authorized-session visibility snapshot');
  assert.ok(Matrix4.equals(model.resource.modelMatrix, base), 'revocation still restores the normal map transform');

  permissions.models = true; model.resource.show = true;
  owner.selected = new Set([model.id]);
  owner.resources = await VideoOverlayResources.create({ viewer, imports: host.getImports, getRecord: () => undefined });
  owner.restoreScene = () => {}; owner.enterHooksActive = true; owner.compositor ??= blankCompositor(); owner.refreshResources();
  permissions.models = false;
  owner.resources.setVisible(true);
  assert.equal(model.resource.show, false, 'playing-frame visibility checks the live gate even before host refresh');
  owner.compositor.clearOverlay = () => false;
  owner.refreshResources();
  assert.equal(owner.active, false, 'failed or lost GPU sanitation safely exits the active overlay');
  assert.equal(owner.resources, undefined); assert.equal(owner.selected.has(model.id), true);
  assert.ok(Matrix4.equals(model.resource.modelMatrix, base), 'GPU loss fallback restores original model positioning');
  owner.setPanelActive(false);
  assert.equal(model.resource.show, false);

  // Ground-clamped CAD has a separate temporary renderer: revoke that copy too.
  const root = new PrimitiveCollection();
  root.add(Object.assign(Object.create(GroundPolylinePrimitive.prototype), { show: true, isDestroyed: () => false, destroy() {} }));
  const ground = { id: 'ground-cad', name: 'Private ground CAD', kind: 'CAD', representation: 'primitive', visible: true, resource: root };
  imports.push(ground); viewer.scene.primitives.add(root);
  const saved = { settings: { displayMode: 'terrain', coordinates: { mode: 'local', longitude: 120, latitude: 30, altitude: 25, referenceX: 0, referenceY: 0, rotation: 0, scale: 1 } }, files: { data: { url: '/fixture.cadimport' } } };
  globalThis.fetch = async () => new Response(JSON.stringify({ format: 'cesium-cad-import', version: 2, source: { name: 'fixture', format: 'DWG', generatedAt: '' }, statistics: { sourceEntities: 1, displayEntities: 1, skippedEntities: 0, unknownEntities: 0, layers: ['0'] }, entities: [{ type: 'POLYLINE', sourceType: 'LINE', layer: '0', vertices: [{ x: 0, y: 0, z: 12 }, { x: 10, y: 0, z: 12 }] }], warnings: [] }));
  owner.selected = new Set([ground.id]);
  owner.resources = await VideoOverlayResources.create({ viewer, imports: host.getImports, getRecord: id => id === ground.id ? saved : undefined });
  owner.restoreScene = () => {}; owner.enterHooksActive = true; owner.compositor ??= blankCompositor(); owner.refreshResources();
  assert.equal(viewer.scene.primitives.length, 2);
  const copy = viewer.scene.primitives.get(1); assert.equal(copy.show, true);
  permissions.files = false; host.renderWorkbenchMachinery();
  assert.equal(copy.show, false, 'paused ground CAD copy is revoked with its source permission');
  assert.equal(nodes.get('ccResources').textContent.includes(ground.name), false);
  owner.setPanelActive(false);
  assert.equal(root.show, false, 'exit cannot reveal the original ground layer after revocation');
  assert.equal(copy.isDestroyed(), true);
  // A revoked account must not reopen cached video through any alternate entry.
  let sourceReads = 0, manifestReads = 0;
  const cachedFiles = { video: new File(['cached-video'], 'private.mp4'), source: { text: async () => { sourceReads++; return 'unread XML'; } } };
  const manifestFile = { text: async () => { manifestReads++; return 'unread manifest'; } };
  owner.files = cachedFiles; owner.savedId = 'saved-private-video'; owner.inputGeneration = 0; owner.manifestImportGeneration = 0;
  permissions.media = false; host.renderWorkbenchMachinery();
  assert.equal(host.canAccessVideo(), false, 'the host uses the existing media permission, independently of model/file access');
  assert.throws(() => owner.playCachedPreview(), /没有录像权限/, 'cached preview playback checks the media gate');
  assert.throws(() => owner.installCachedPreview(new Blob(['private']), 0, 1), /没有录像权限/, 'cached preview installation cannot allocate media after revocation');
  for (const invoke of [() => owner.prepare(), () => owner.loadMedia(), () => owner.enter(),
    () => owner.createDiagnostics(), () => owner.exportVideo(), () => owner.extractFrames(false),
    () => owner.extractFrames(true), () => owner.importManifest(manifestFile), () => owner.restoreReplay(cachedFiles, {}, 'other')]) {
    await assert.rejects(invoke(), /没有录像权限/);
  }
  assert.equal(sourceReads, 0, 'revoked prepare does not read cached XML');
  assert.equal(manifestReads, 0, 'revoked import does not read manifests or hash the cached video');
  assert.equal(owner.files, cachedFiles, 'revocation preserves original files for an authorized session');
  assert.equal(owner.savedId, 'saved-private-video', 'revocation preserves the saved scheme identity');
  owner.restoreScene = () => {};
  await assert.rejects(owner.exportVideo(), /没有录像权限/, 'an already active exporter entry also checks the live gate');
  owner.restoreScene = undefined;

  // Permission changes during an awaited manifest read cannot proceed to video hashing.
  permissions.media = true; owner.assertVideoAccess();
  let finishManifest;
  const waitingImport = owner.importManifest({ text: () => new Promise(resolve => { finishManifest = resolve; }) });
  permissions.media = false; finishManifest('not parsed after revocation');
  await assert.rejects(waitingImport, /没有录像权限/);
  assert.equal(owner.files, cachedFiles); assert.equal(owner.savedId, 'saved-private-video');
  const previousPos = { text: async () => 'retained-position-data' }; cachedFiles.pos = previousPos;
  assert.throws(() => owner.pickPosFile(new File(['replacement'], 'new-pos.csv')), /没有录像权限/);
  assert.equal(cachedFiles.pos, previousPos, 'revoked POS selection must not replace the existing attachment');
  permissions.media = true;
  let finishPos;
  cachedFiles.pos = { text: () => new Promise(resolve => { finishPos = resolve; }) };
  const waitingExtraction = owner.extractFrames(false);
  permissions.media = false; finishPos('not parsed after revocation');
  await assert.rejects(waitingExtraction, /没有录像权限/, 'revocation during POS reading stops before parsing or video decoding');
  assert.equal(owner.files, cachedFiles); assert.equal(owner.savedId, 'saved-private-video');
  assert.equal(owner.extraction, undefined, 'the denied extraction releases its controller');
  const mediaGate = owner.options.canAccessVideo; delete owner.options.canAccessVideo;
  assert.doesNotThrow(() => owner.assertVideoAccess(), 'standalone fixtures without a permission hook keep their prior behavior');
  owner.options.canAccessVideo = mediaGate;
  viewer.scene.primitives.destroy(); cadResource.destroy();
  console.log('PASS: AR resource/media permissions, paused-pixel invalidation, cached-video/POS guards, saved selections, CAD copies, and exit restoration');
} finally {
  globalThis.document = oldDocument; globalThis.fetch = oldFetch;
  await rm(directory, { recursive: true, force: true });
}

