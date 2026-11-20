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
  const state = { clears: 0, pauses: 0, inputChanges: 0, restoredCalibration: 0, zip: deferred(), load: deferred() };
  const owner = Object.assign(Object.create(VideoArFusion.prototype), {
    loadGeneration: 0, restoringReplay: false, frameFiles: new Map(), points: [], element: ui(),
    options: { onReplayInputChanged() { state.inputChanges++; } },
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
  assert.equal(f.state.inputChanges, 0, 'internal clear and restoration never masquerade as manual input');
});

function legacyInputUi() {
  ui(); const elements = new Map(), state = { inputChanges: 0, clears: 0, pauses: 0, errors: [] };
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(new EventTarget(), {
      files: [], value: '', textContent: '', classList: { add() {}, remove() {} },
    }));
    return elements.get(id);
  };
  const owner = Object.assign(Object.create(VideoArFusion.prototype), {
    abortController: new AbortController(), element, options: { onReplayInputChanged() { state.inputChanges++; } },
    loadGeneration: 3, restoringReplay: false, frameFiles: new Map(), zipReader: null,
    calibrationSessions: [{ id: 'existing' }], points: [{ id: 'displayed' }],
    setModelPreviewActive() {}, resetCalibration() {}, invalidateCameraFrame() {},
    pause() { state.pauses++; }, setStatus() {}, setBusy() {}, reportError(_message, error) { state.errors.push(error); },
    clear() { ++this.loadGeneration; state.clears++; },
  });
  owner.bindUi(); return { owner, element, state };
}

for (const [selector, name] of [
  ['#videoArTrajectoryFile', 'track.json'], ['#videoArVideoFile', 'manual-newer.mp4'],
  ['#videoArZipFile', 'invalid.zip'], ['#videoArFramesDirectory', 'frame.png'], ['#videoArGeoreferenceFile', 'surface.json'],
]) {
  test(`manual native ${selector} change invalidates older library work before any await`, async () => {
    const f = legacyInputUi(), file = new File(['synthetic'], name); Object.defineProperty(file, 'webkitRelativePath', { value: '' });
    f.element(selector).files = [file]; f.element(selector).dispatchEvent(new Event('change'));
    assert.equal(f.state.inputChanges, 1);
    await new Promise(resolve => setImmediate(resolve)); f.owner.abortController.abort();
  });
  test(`empty/cancelled ${selector} chooser does not supersede library selection`, () => {
    const f = legacyInputUi(); f.element(selector).dispatchEvent(new Event('change'));
    assert.equal(f.state.inputChanges, 0); f.owner.abortController.abort();
  });
}

for (const selector of ['#videoArFramesDirectory', '#videoArGeoreferenceFile', '#videoArClearGeoreference']) {
  test(`${selector} preserves existing calibration but protects new attachments from an in-flight restore cleanup`, () => {
    const f = legacyInputUi(), sessions = f.owner.calibrationSessions, points = f.owner.points;
    f.owner.restoringReplay = true;
    const file = new File(['synthetic'], 'surface.json'); Object.defineProperty(file, 'webkitRelativePath', { value: '' });
    f.element(selector).files = [file]; f.element(selector).dispatchEvent(new Event(selector.endsWith('Georeference') ? 'click' : 'change'));
    assert.equal(f.state.inputChanges, 1); assert.equal(f.owner.loadGeneration, 4); assert.equal(f.owner.restoringReplay, false);
    assert.equal(f.owner.calibrationSessions, sessions); assert.equal(f.owner.points, points); assert.equal(f.state.pauses, 0);
    f.owner.abortController.abort();
  });
}

test('a normal auxiliary attachment retains the displayed source generation', () => {
  const f = legacyInputUi(), sessions = f.owner.calibrationSessions;
  f.element('#videoArGeoreferenceFile').files = [new File(['{}'], 'surface.json')];
  f.element('#videoArGeoreferenceFile').dispatchEvent(new Event('change'));
  assert.equal(f.state.inputChanges, 1); assert.equal(f.owner.loadGeneration, 3); assert.equal(f.owner.calibrationSessions, sessions);
  f.owner.abortController.abort();
});

test('the explicit legacy Clear button supersedes a pending restore without making internal clear a manual selection', () => {
  const f = legacyInputUi(); f.owner.clear(); assert.equal(f.state.inputChanges, 0);
  f.element('#videoArClear').dispatchEvent(new Event('click'));
  assert.equal(f.state.inputChanges, 1); assert.equal(f.state.clears, 2); f.owner.abortController.abort();
});

test('manual Load supersedes pending library work, while internal restore loading does not', async () => {
  const f = legacyInputUi(), stop = new Error('controlled media boundary'); f.owner.invalidateCameraFrame = () => { throw stop; };
  await assert.rejects(f.owner.loadSelectedSource(), error => error === stop);
  assert.equal(f.state.inputChanges, 1);
  await assert.rejects(f.owner.loadSelectedSource(() => {}), error => error === stop);
  assert.equal(f.state.inputChanges, 1); f.owner.abortController.abort();
});

for (const superseded of [false, true]) {
  test(`legacy manual parsing/decoding ${superseded ? 'keeps the original intent when a library choice arrives before autosave' : 'reaches saved readiness after its own successful commit'}`, async () => {
    const decoded = deferred(), decoding = deferred(), state = { intent: 0, saves: 0, controls: 0, errors: [], statuses: [] };
    const owner = Object.assign(Object.create(VideoArFusion.prototype), {
      loadGeneration: 0, restoringReplay: false, frameFiles: new Map(), zipReader: null, element: ui(), calibrationSessions: [],
      trajectoryFile: new File([JSON.stringify([{ longitude: 120, latitude: 30, altitude: 100, time: 0 }, { longitude: 120.001, latitude: 30, altitude: 100, time: 1000 }])], 'manual.json'),
      videoFile: new File(['synthetic'], 'manual.mp4'),
      options: { onReplayInputChanged() { const intent = ++state.intent; return () => intent === state.intent; } },
      frameBlobCache: new Map(), footprintPositionCache: new Map(), projectionMeshSurfaceCache: new Map(),
      invalidateCameraFrame() {}, pause() {}, disconnectLive() {}, removeProjectionPrimitive() {}, releaseVideo() {}, clearCanvases() {},
      setBusy() {}, setApplicationStatus() {}, setStatus(message) { state.statuses.push(message); }, resetFailedLoadState() {},
      reportError(_message, error) { state.errors.push(error); }, attachSelectedGeoreference: async () => false,
      async prepareVideo() { decoding.resolve(); await decoded.promise; },
      async initializeFlight(points) { this.points = points; },
      async onReplayLoaded(_snapshot, current) { if (!current()) return false; state.saves++; return true; },
      saveReplayControls() { state.controls++; },
    });
    const loading = owner.loadSelectedSource(); await decoding.promise;
    if (superseded) ++state.intent; // A later library request has not activated a decoder yet.
    decoded.resolve(); await loading;
    assert.deepEqual(state.errors, []); assert.equal(state.saves, superseded ? 0 : 1);
    assert.equal(owner.replaySettingsReady, !superseded); assert.equal(state.controls, superseded ? 0 : 1);
    assert.equal(state.statuses.includes('回放已保存到本机'), !superseded);
  });
}
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
    inputGeneration: 0, replayInputIntent: 0, epoch: 0, destroyed: false, editRevision: 0, selected: new Set(), options: {},
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

test('manual POS attachment takes cleanup ownership from a CC restore already preparing', async () => {
  const f = cc(); let current = true, notifications = 0;
  f.owner.options = { onReplayInputChanged() { current = false; notifications++; } };
  f.owner.dirty = () => {};
  const pending = f.owner.restoreReplay({ video: f.video }, f.settings, 'A', () => {
    if (!current) throw new DOMException('new input', 'AbortError');
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const generation = f.owner.inputGeneration;
  f.owner.pickPosFile(new File(['new POS'], 'manual-pos.csv'));
  f.state.preparation.resolve(); await rejected;
  assert.equal(notifications, 1);
  assert.equal(f.owner.inputGeneration, generation, 'an auxiliary edit keeps normal playback generation semantics');
  assert.equal(f.state.clears, 1, 'the superseded restore cannot clear a newer attachment');
  assert.equal(await f.owner.files.pos.text(), 'new POS'); assert.equal(f.owner.files.video, f.video);
  assert.equal(f.state.seeks, 0); assert.equal(f.owner.autoSaveReady, false);
});

test('a pending manual manifest survives cleanup of a superseded CC restore and can commit', async () => {
  const f = cc(), read = deferred(); let current = true, notifications = 0;
  Object.assign(f.owner, {
    options: { onReplayInputChanged() { current = false; notifications++; } },
    dirty() {}, exit() { this.epoch++; }, manifestImportGeneration: 0, sessionGeneration: 0,
  });
  const pending = f.owner.restoreReplay({ video: f.video }, f.settings, 'A', () => {
    if (!current) throw new DOMException('new input', 'AbortError');
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const manifest = { version: 1, kind: 'cesium-video-frames',
    source: { name: f.video.name, size: f.video.size, lastModified: f.video.lastModified, duration: 3, width: 640, height: 360 },
    extraction: { start: 0, end: 3, intervalSeconds: 1, requestedCount: 3, width: 640, height: 360 },
    frames: [0, 1, 2].map(index => ({ filename: `frame_${index}.jpg`, index, requestedTime: index, mediaTime: index, width: 640, height: 360 })) };
  const file = new File([JSON.stringify(manifest)], 'manual-manifest.json');
  Object.defineProperty(file, 'text', { value: () => read.promise });
  const importing = f.owner.importManifest(file), generation = f.owner.inputGeneration;
  f.state.preparation.resolve(); await rejected;
  assert.equal(notifications, 1); assert.equal(f.state.clears, 1);
  assert.equal(f.owner.inputGeneration, generation); assert.equal(f.owner.files.video, f.video);
  read.resolve(JSON.stringify(manifest)); await importing;
  assert.equal(f.owner.files.manifest, file); assert.deepEqual(f.owner.manifest, manifest);
  assert.equal(f.owner.el('ccTimeMode').value, 'photo-times'); assert.equal(f.state.seeks, 0);
});

test('CC preparation receives the manual intent guard before it can publish decoded state', async () => {
  const f = cc(); let preparationCheck;
  Object.assign(f.owner, {
    options: {}, dirty() {},
    async prepare(_validate, _signal, check) { preparationCheck = check; await f.state.preparation.promise; check(); },
  });
  const pending = f.owner.restoreReplay({ video: f.video }, f.settings, 'A');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  f.owner.pickPosFile(new File(['POS'], 'manual-pos.csv'));
  assert.throws(preparationCheck, { name: 'AbortError' });
  f.state.preparation.resolve(); await rejected;
  assert.equal(f.state.clears, 1); assert.equal(f.state.seeks, 0);
});
