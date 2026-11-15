import test, { before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Real restore/commit methods; only browser setup, media decoding and GPU work
// are controlled. Deferred boundaries reproduce external imports and revocation.
let VideoArFusion, VideoModelOverlay;
before(async () => {
  const result = await build({ stdin: { contents: 'export { VideoArFusion } from "./src/videoArFusion.ts"; export { VideoModelOverlay } from "./src/videoModelOverlay.ts";', resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    plugins: [{ name: 'node-cesium', setup(plugin) { plugin.onResolve({ filter: /^cesium$/ }, () => ({ path: import.meta.resolve('cesium'), external: true })); } }] });
  ({ VideoArFusion, VideoModelOverlay } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')));
});
const originals = { document: globalThis.document, HTMLInputElement: globalThis.HTMLInputElement, HTMLSelectElement: globalThis.HTMLSelectElement };
afterEach(() => { for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function ui() {
  globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
  globalThis.HTMLInputElement = class {}; globalThis.HTMLSelectElement = class {};
  const elements = new Map();
  return id => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '', classList: { add() {}, remove() {} } }); return elements.get(id); };
}
function legacy() {
  const state = { clears: 0, pauses: 0, restoredCalibration: 0, zip: deferred(), load: deferred() };
  const owner = Object.assign(Object.create(VideoArFusion.prototype), {
    loadGeneration: 0, restoringReplay: false, frameFiles: new Map(), points: [], element: ui(),
    clear() { ++this.loadGeneration; this.restoringReplay = false; this.points = []; state.clears++; },
    pause() { state.pauses++; }, controlPointPicker: { restoreLastSession() { state.restoredCalibration++; } },
    async prepareZip() { ++this.loadGeneration; await state.zip.promise; },
    async loadSelectedSource() { const generation = ++this.loadGeneration; await state.load.promise; if (generation === this.loadGeneration) this.points = [{}]; },
  });
  return { owner, state };
}
test('legacy ZIP restoration cannot overwrite or clear a newer manually loaded video', async () => {
  const f = legacy(); const restore = f.owner.restoreReplay({ source: new File(['zip'], 'A.zip') }, { flight: '' });
  const rejected = assert.rejects(restore, { name: 'AbortError' });
  f.owner.clear(); f.owner.videoFile = new File(['new'], 'manual.mp4'); f.owner.points = [{ name: 'manual' }];
  f.state.zip.resolve(); await rejected;
  assert.equal(f.owner.videoFile.name, 'manual.mp4'); assert.equal(f.owner.points[0].name, 'manual');
  assert.equal(f.state.clears, 2); assert.equal(f.owner.restoringReplay, false); assert.equal(f.state.restoredCalibration, 0);
});
test('legacy restoration releases its own pending session when context is revoked', async () => {
  const f = legacy(); let allowed = true;
  const restore = f.owner.restoreReplay({ source: new File(['{}'], 'A.json') }, { controls: {} }, () => { if (!allowed) throw new Error('revoked'); });
  const rejected = assert.rejects(restore, /revoked/); allowed = false; f.state.load.resolve(); await rejected;
  assert.equal(f.state.clears, 2); assert.deepEqual(f.owner.points, []); assert.equal(f.owner.restoringReplay, false); assert.equal(f.state.restoredCalibration, 0);
});
test('legacy restoration still commits an unchanged context', async () => {
  const f = legacy(); const restore = f.owner.restoreReplay({ source: new File(['{}'], 'A.json') }, { controls: {}, calibrationSessions: [{ id: 'saved' }] });
  f.state.load.resolve(); await restore;
  assert.equal(f.state.clears, 1); assert.equal(f.owner.points.length, 1); assert.equal(f.state.restoredCalibration, 1); assert.equal(f.owner.restoringReplay, false);
});
test('late native media metadata never releases the newer video URL', async () => {
  const video = Object.assign(new EventTarget(), { load() {}, readyState: 0 });
  let releases = 0;
  const owner = Object.assign(Object.create(VideoArFusion.prototype), { loadGeneration: 1, video,
    releaseVideo() { releases++; this.videoObjectUrl = null; } });
  const pending = owner.prepareVideo(new File(['video'], 'A.mp4'), 1), oldUrl = owner.videoObjectUrl;
  owner.loadGeneration = 2; owner.videoObjectUrl = 'blob:manual'; video.dispatchEvent(new Event('loadedmetadata'));
  await pending; URL.revokeObjectURL(oldUrl);
  assert.equal(owner.videoObjectUrl, 'blob:manual'); assert.equal(releases, 1);
});
test('flight publication checks context after datasource readiness, before writing scene state', async () => {
  const gate = deferred(), owner = Object.assign(Object.create(VideoArFusion.prototype), { dataSourceReady: gate.promise, loadGeneration: 1, points: ['previous'] });
  let allowed = true;
  const pending = owner.initializeFlight([], 'A', 1, () => { if (!allowed) throw new Error('revoked'); });
  const rejected = assert.rejects(pending, /revoked/); allowed = false; gate.resolve(); await rejected;
  assert.deepEqual(owner.points, ['previous']);
});
function cc() {
  const state = { clears: 0, seeks: 0, preparation: deferred() };
  const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
    inputGeneration: 0, epoch: 0, destroyed: false, editRevision: 0, selected: new Set(),
    assertVideoAccess() {}, leave() {},
    clear() { ++this.inputGeneration; ++this.epoch; this.controller?.abort(); this.autoSaveReady = false; this.savedId = undefined; state.clears++; },
    el: ui(), presentationEditor: { setValue() {} }, spatialEditor: { setValue() {} },
    syncCameraInputs() {}, refreshSceneReferences() {}, refreshOcclusionSources() {}, syncHeightInputs() {}, refreshResources() {},
    prepare: () => state.preparation.promise, video: { duration: 10 }, seekVideo() { state.seeks++; },
  });
  const video = new File(['video'], 'A.mp4');
  const settings = { mode: 'cc-overlay', version: 1, videoName: video.name, videoSize: video.size,
    timing: { mode: 'interval', firstTimeSeconds: 0, intervalSeconds: 1, heightReference: 'ellipsoid' } };
  return { owner, state, video, settings };
}
test('CC restoration clears only its own session when permission changes during preparation', async () => {
  const f = cc(); let allowed = true;
  const pending = f.owner.restoreReplay({ video: f.video }, f.settings, 'A', () => { if (!allowed) throw new Error('revoked'); });
  const rejected = assert.rejects(pending, /revoked/); allowed = false; f.state.preparation.resolve(); await rejected;
  assert.equal(f.state.clears, 2); assert.equal(f.owner.savedId, undefined); assert.equal(f.owner.autoSaveReady, false); assert.equal(f.state.seeks, 0);
});
test('CC restoration cannot clear a new manual owner after the old preparation completes', async () => {
  const f = cc(); const pending = f.owner.restoreReplay({ video: f.video }, f.settings, 'A');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  f.owner.clear(); f.owner.savedId = 'manual'; f.owner.autoSaveReady = true;
  f.state.preparation.resolve(); await rejected;
  assert.equal(f.state.clears, 2); assert.equal(f.owner.savedId, 'manual'); assert.equal(f.owner.autoSaveReady, true); assert.equal(f.state.seeks, 0);
});
