import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { BoundingSphere, Cartesian3, GroundPolylinePrimitive, JulianDate, Matrix4, PrimitiveCollection, Transforms } from 'cesium';

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
  const hostCode = ts.transpileModule(`${declarations.map(node => node.getText(source)).join('\n')}\nreturn { ${names.join(',')}, getImports: ${property('getImports')}, onExit: ${property('onExit')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
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
  const viewer = { container, clock: { currentTime: JulianDate.now() }, scene: { primitives: new PrimitiveCollection(), requestRender() {} }, isDestroyed: () => false, resize() {} };
  const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
    viewer, selected: new Set(), selectionInitialized: false, destroyed: false, epoch: 0,
    occlusion: { enabled: false, sourceId: '' }, presentationEditor: { unmount() {} },
    video: { pause() {}, removeAttribute() {}, load() {} }, updateTargets() {},
  });
  const host = new Function('managementWorkspace', 'imports', 'videoModelOverlay', 'viewer', 'scheduleSceneDisplay', 'modelEditor', 'projectLibrary', 'sceneDisplayPanel', 'document', `
    let sceneDisplayOverrides = {}, resumeVideoOverlayInteractions;
    const markupTools = undefined, foundationPitMonitoring = { setDisplayVisibility() {} }, modelQualityTrackers = new Map(), videoArFusion = { invalidateProjection() {} };
    ${hostCode}`)(
    { getWorkbenchLayerAccess: () => permissions, setWorkbenchDisplayVisibility() {} }, imports, owner, viewer, () => scheduled++, { select() {} }, { saveView() {}, render() {} }, { labelsVisible: true }, globalThis.document);
  owner.options = { getImports: host.getImports, getRecord: () => undefined, onExit: host.onExit };
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
  owner.restoreScene = () => {}; owner.enterHooksActive = true;
  owner.refreshResources();
  assert.equal(model.resource.show, false);
  assert.equal(cad.resource.show, true, 'an authorized overlay selection is independent of map display preferences');
  owner.setPanelActive(false);
  assert.equal(model.resource.show, false);
  assert.equal(cad.resource.show, false, 'exit reapplies saved map visibility');

  permissions.models = true; model.resource.show = true;
  owner.selected = new Set([model.id, cad.id]);
  owner.resources = await VideoOverlayResources.create({ viewer, imports: host.getImports, getRecord: () => undefined });
  owner.restoreScene = () => {}; owner.enterHooksActive = true; owner.refreshResources();
  assert.equal(model.resource.show, true);
  owner.resources.applyAdjustments({ [model.id]: { east: 10 } });
  permissions.models = false;
  host.renderWorkbenchMachinery(); // Existing session-change callback; no playback frame is delivered.
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
  owner.restoreScene = () => {}; owner.enterHooksActive = true; owner.refreshResources();
  permissions.models = false;
  owner.resources.setVisible(true);
  assert.equal(model.resource.show, false, 'playing-frame visibility checks the live gate even before host refresh');
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
  owner.restoreScene = () => {}; owner.enterHooksActive = true; owner.refreshResources();
  assert.equal(viewer.scene.primitives.length, 2);
  const copy = viewer.scene.primitives.get(1); assert.equal(copy.show, true);
  permissions.files = false; host.renderWorkbenchMachinery();
  assert.equal(copy.show, false, 'paused ground CAD copy is revoked with its source permission');
  assert.equal(nodes.get('ccResources').textContent.includes(ground.name), false);
  owner.setPanelActive(false);
  assert.equal(root.show, false, 'exit cannot reveal the original ground layer after revocation');
  assert.equal(copy.isDestroyed(), true);
  viewer.scene.primitives.destroy(); cadResource.destroy();
  console.log('PASS: AR permissions on entry, saved selections, playing/paused revocation, CAD copies, display overrides, late loads, and exit restoration');
} finally {
  globalThis.document = oldDocument; globalThis.fetch = oldFetch;
  await rm(directory, { recursive: true, force: true });
}

