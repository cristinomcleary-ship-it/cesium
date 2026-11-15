import test, { before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundle the production class without changing the source or creating artifacts.
// The fixture bypasses DOM/GPU setup; apply, selection, cancellation, history,
// validation and persistence run through their real implementation.
let MarkupTools;
before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/markupTools.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', write: false, loader: { '.css': 'empty' },
    plugins: [{ name: 'node-cesium', setup(plugin) {
      plugin.onResolve({ filter: /^cesium$/ }, () => ({ path: import.meta.resolve('cesium'), external: true }));
    } }],
  });
  ({ MarkupTools } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));
});

const oldDocument = globalThis.document, oldStorage = globalThis.localStorage;
afterEach(() => {
  if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage;
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const style = { color: '#32d5f2', opacity: 0.55, lineWidth: 4, pointSize: 12, fontSize: 15,
  lineEffect: 'solid', effectSpeed: 1, verticalHeight: 10 };
const record = (id = 'wall', name = 'original') => ({
  id, kind: 'facade', name, note: '', visible: true, heightMode: 'picked',
  positions: [{ longitude: 120, latitude: 30, height: 10 }, { longitude: 120.0001, latitude: 30, height: 10 }],
  style: { ...style }, createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z',
});
function fixture() {
  const controls = new Map(), stored = new Map(), messages = [], writes = [];
  const input = (id, value) => { const control = { value, get valueAsNumber() { return Number(this.value); } }; controls.set(id, control); return control; };
  input('#markupName', 'original'); input('#markupNote', ''); input('#markupHeightMode', 'picked');
  for (const [suffix, value] of Object.entries({ Color: style.color, Opacity: style.opacity, LineWidth: style.lineWidth,
    PointSize: style.pointSize, FontSize: style.fontSize, LineEffect: style.lineEffect, EffectSpeed: style.effectSpeed,
    VerticalHeight: style.verticalHeight })) input(`#markup${suffix}`, String(value));
  globalThis.document = { querySelector: selector => controls.get(selector) };
  const state = { storageError: undefined, destroyed: false, removedSource: 0 };
  globalThis.localStorage = {
    setItem(key, value) { if (state.storageError) throw state.storageError; stored.set(key, value); writes.push(JSON.parse(value)); },
    getItem(key) { return stored.get(key) ?? null; },
  };
  const textureSave = deferred(), pendingTexture = { id: 'texture', name: 'wall.png', url: 'blob:fixture' };
  const tools = Object.assign(Object.create(MarkupTools.prototype), {
    viewer: { isDestroyed: () => state.destroyed, scene: { requestRender() {} }, canvas: { style: {} },
      entities: { contains: () => false, remove() {} }, dataSources: { remove() { state.removedSource++; } } },
    dataSource: { entities: { getById: () => undefined } }, records: [record()], selectedId: 'wall', propertyApplyVersion: 0,
    disposed: false, recoveryPayload: null, recoveryBackupDownloaded: false, undoStack: [], redoStack: [],
    drawingSession: 0, drawingKind: null, redrawId: null, drawingPoints: [], hoverPoint: null, draftEntity: null, draftVertices: [],
    textureSelectionVersion: 0, textureSelectionPromise: null, textureReferenceVersion: 0, textureGcTimer: null,
    pendingTexture, textureSavePromises: new Map([['texture', textureSave.promise]]), textureSaveErrors: new Map(),
    textureUrls: new Map([['texture', pendingTexture.url]]), textureLoads: new Set(), missingTextureIds: new Set(),
    overviewListeners: new Set(), displayVisibility: new Map(), abortController: new AbortController(),
    handler: null, removeSelectedListener: null, resumeExternalInteractions: null,
    toast: (message, error) => messages.push({ message, error }),
    // These ports only render UI/GPU or schedule texture housekeeping.
    render() {}, rebuildEntities() {}, updateDrawingUi() {}, updateTextureStatus() {}, scheduleTextureGarbageCollection() {},
    fillForm(value) { controls.get('#markupName').value = value.name; controls.get('#markupNote').value = value.note; },
  });
  return { tools, controls, state, messages, writes, textureSave,
    setName(name) { controls.get('#markupName').value = name; },
    apply() { return tools.applySelectedProperties(); },
  };
}

test('latest apply wins during the same texture save and creates one undo step', async () => {
  const f = fixture();
  f.setName('first'); const first = f.apply();
  f.setName('latest'); const latest = f.apply();
  f.textureSave.resolve(); await Promise.all([first, latest]);
  assert.equal(f.tools.records[0].name, 'latest');
  assert.equal(f.tools.records[0].textureId, 'texture');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].items[0].name, 'latest');
  assert.equal(f.tools.undoStack.length, 1); assert.equal(f.tools.pendingTexture, null);
  f.tools.undo(); assert.equal(f.tools.records[0].name, 'original');
  f.tools.redo(); assert.equal(f.tools.records[0].name, 'latest');
});

test('latest apply also wins while image decoding is still pending', async () => {
  const f = fixture(), decoding = deferred();
  f.tools.textureSelectionPromise = decoding.promise;
  f.setName('first'); const first = f.apply();
  f.setName('latest'); const latest = f.apply();
  decoding.resolve(); f.textureSave.resolve(); await Promise.all([first, latest]);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].items[0].name, 'latest');
});

test('selecting another object and returning does not revive an old apply', async () => {
  const f = fixture(); f.tools.records.push(record('other', 'other'));
  f.setName('obsolete'); const pending = f.apply();
  f.tools.selectRecord('other', false); f.tools.selectRecord('wall', false);
  f.textureSave.resolve(); await pending;
  assert.equal(f.tools.records[0].name, 'original'); assert.equal(f.writes.length, 0);
  assert.equal(f.tools.pendingTexture.id, 'texture');
});

test('undo during texture persistence preserves the restored record after the old apply settles', async () => {
  const f = fixture();
  f.tools.records[0].name = 'current'; f.tools.undoStack.push(JSON.stringify([record('wall', 'earlier')]));
  f.setName('obsolete'); const pending = f.apply();
  f.tools.undo(); assert.equal(f.tools.records[0].name, 'earlier');
  f.textureSave.resolve(); await pending;
  assert.equal(f.tools.records[0].name, 'earlier'); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].items[0].name, 'earlier');
  assert.equal(f.tools.pendingTexture.id, 'texture');
});

test('cancelling interaction leaves late property work unapplied and retains the unconsumed texture', async () => {
  const f = fixture(); f.setName('obsolete'); const pending = f.apply();
  f.tools.cancelInteraction(false, true); f.textureSave.resolve(); await pending;
  assert.equal(f.tools.records[0].name, 'original'); assert.equal(f.writes.length, 0);
  assert.equal(f.tools.pendingTexture.id, 'texture');
});

test('clearing a texture during decoding does not apply stale properties after decode completes', async () => {
  const f = fixture(), decoding = deferred(); f.tools.textureSelectionPromise = decoding.promise;
  f.setName('obsolete'); const pending = f.apply();
  f.tools.clearFacadeTexture(); decoding.resolve(); f.textureSave.resolve(); await pending;
  assert.equal(f.tools.records[0].name, 'original'); assert.equal(f.writes.length, 0);
  assert.equal(f.tools.pendingTexture, null);
});

test('only the current apply reports a shared texture save failure', async () => {
  const f = fixture();
  f.setName('first'); const first = f.apply(); f.setName('latest'); const latest = f.apply();
  f.textureSave.reject(new Error('texture quota')); await Promise.all([first, latest]);
  assert.equal(f.writes.length, 0); assert.equal(f.tools.records[0].name, 'original');
  assert.equal(f.messages.length, 1); assert.match(f.messages[0].message, /texture quota/);
  assert.equal(f.tools.pendingTexture.id, 'texture');
});

test('disposing the workspace prevents late writes and stale failure messages', async () => {
  const f = fixture(); f.setName('obsolete'); const pending = f.apply();
  f.tools.dispose(); f.textureSave.reject(new Error('late failure')); await pending;
  assert.equal(f.writes.length, 0); assert.equal(f.messages.length, 0);
  assert.equal(f.state.removedSource, 1); assert.equal(f.tools.abortController.signal.aborted, true);
});

test('a storage failure preserves the old record and keeps the texture available for retry', async context => {
  const warning = context.mock.method(console, 'warn', () => {});
  const f = fixture(); f.state.storageError = new DOMException('quota', 'QuotaExceededError');
  f.setName('latest'); const pending = f.apply(); f.textureSave.resolve(); await pending;
  assert.equal(f.tools.records[0].name, 'original'); assert.equal(f.writes.length, 0);
  assert.equal(f.tools.undoStack.length, 0); assert.equal(f.tools.pendingTexture.id, 'texture');
  assert.equal(warning.mock.callCount(), 1);
  f.state.storageError = undefined;
  await f.apply();
  assert.equal(f.tools.records[0].name, 'latest'); assert.equal(f.writes.length, 1);
});
