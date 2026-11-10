import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Matrix4 } from 'cesium';
let directory, VideoModelOverlay, VideoOverlayResources;
const previousDocument = globalThis.document;
before(async () => {
  directory = await mkdtemp(`${process.cwd()}/.layered-annotations-`);
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts"; export { VideoOverlayResources } from "./src/videoOverlayResources.ts";', resolveDir: process.cwd(), loader: 'ts' },
    outfile: `${directory}/fixture.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' },
    plugins: [{ name: 'native-encoder-fixture', setup(build) {
      build.onResolve({ filter: /videoOverlayNativeCache$/ }, () => ({ path: 'native-cache', namespace: 'native-encoder-fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'native-encoder-fixture' }, () => ({ contents: `export async function prepareNativeVideoCache(options) {
        await options.getFrame(0.25, options.signal, {frame:'base pixels'});
        return {start:0,end:2,duration:2,width:640,height:360,frames:30,mimeType:'video/webm',audioStatus:'none'};
      }`, loader: 'js' }));
    } }] });
  ({ VideoModelOverlay, VideoOverlayResources } = await import(pathToFileURL(`${directory}/fixture.mjs`).href));
});
after(async () => { await rm(directory, { recursive: true, force: true }); globalThis.document = previousDocument; });
const owner = data => Object.assign(Object.create(VideoModelOverlay.prototype), data);

test('annotation dirty updates keep cached frame identity and never abort or re-enter fusion', () => {
  let aborts = 0, clears = 0;
  const cache = {}, value = owner({ editRevision: 4, autoSaveReady: false, cachedPreview: cache,
    cacheLifecycle: { abort() { aborts++; } }, clearCachedPreview() { clears++; }, el: () => ({ textContent: '' }) });
  value.dirty(false);
  assert.equal(value.editRevision, 5); assert.equal(value.cachedPreview, cache); assert.equal(aborts, 0); assert.equal(clears, 0);
  value.spatialEditor = { cancelPicking() {} }; value.dirty(true);
  assert.equal(aborts, 1); assert.equal(clears, 1, 'Actual fusion edits still invalidate the current player');
});

test('native base rendering never reads or bakes annotation content', () => {
  let annotationInput = 'not called';
  const value = owner({ nativeCacheRendering: true, restoreScene() {}, pendingTime: 1, presentation: { width: 640, height: 360 },
    resources: { getOcclusionStatus: () => ({ ready: true }), isPresentationReady: () => true },
    track: { sample: () => ({}) }, lensFrame: { number: 1, time: 1, ready: true }, renderReady: true, editRevision: 7,
    sceneFrameNumber: () => 1, compositor: { commit(_canvas, _time, annotations) { annotationInput = annotations; return true; } },
    viewer: { canvas: {} }, updatePlayback() {},
  });
  Object.defineProperty(value, 'annotations', { get() { throw new Error('Base rendering accessed annotations'); } });
  value.commitPresentation();
  assert.equal(annotationInput, undefined); assert.equal(value.presentedTime, 1);
});

test('annotation export draws cached pixels then latest marks at original absolute video time', async () => {
  const calls = [], canvas = { width: 0, height: 0, getContext: () => ({ clearRect() { calls.push('clear'); }, drawImage(source) { calls.push(source.frame); } }) };
  globalThis.document = { createElement: () => canvas };
  const marks = [{ text: 'latest revision' }], frames = { model: Matrix4.toArray(Matrix4.IDENTITY) };
  const value = owner({ annotations: marks, spatialAnnotations: [], files: { video: new File(['original'], 'source.mp4') },
    drawAnnotationLayer(_context, time, received) { assert.equal(time, 4.25); assert.deepEqual(received, frames); calls.push(marks[0].text); },
    downloadBlob() { calls.push('download'); }, el: () => ({ textContent: '' }) });
  let layer;
  const store = { async get() {}, async begin(_key, options) { assert.equal(options.schemeId, 'scheme'); return {
    handle: {}, async commit(metadata) { layer = metadata.layer; return { file: new File(['output'], 'result.webm'), metadata }; }, async abort() { calls.push('settled'); },
  }; } };
  await value.downloadAnnotatedCache({ file: new File(['base'], 'base.webm'), metadata: { start: 4, end: 6, duration: 2, width: 640, height: 360, audioStatus: 'none', spatialFrames: frames } }, 'base-key', store, 'scheme', new AbortController().signal, () => {});
  assert.deepEqual(calls, ['clear', 'base pixels', 'latest revision', 'settled', 'download']); assert.equal(layer, 'annotated');
});

test('cancelled cache picking restores late resources without clearing the movie or mounting a late scene', async () => {
  const original = VideoOverlayResources.create;
  let ready; const gate = new Promise(resolve => { ready = resolve; }); let restored = 0, captured = 0;
  const cache = { video: { pause() {}, readyState: 2, paused: true, seeking: false }, displayTime: 1, signature: 'valid', signatureRange: {start:0,end:2} };
  const value = owner({ cachedPreview: cache, drawCachedAnnotations() {}, updatePlayback() {}, cacheSignature: () => 'valid', correctedSample: () => ({}),
    assertVideoAccess() {}, resourceMatricesBeforeAR: new Map(), options: { getImports: () => [], onEnter() {}, onExit() {} },
    cleanupReport: { errors: [] }, viewer: { container: { style: {} }, isDestroyed: () => false, resize() {}, scene: { requestRender() {} } },
    captureScene() { captured++; } });
  VideoOverlayResources.create = async () => { await gate; return { restore() { restored++; } }; };
  try {
    const pending = value.prepareCachedPicking(); value.releaseCachedPicking(); ready();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(value.cachedPreview, cache); assert.equal(restored, 1); assert.equal(captured, 0);
  } finally { VideoOverlayResources.create = original; }
});

test('picking cleanup restores camera and tools even when a resource fails to restore', () => {
  const calls = [], value = owner({ cachedPickController: new AbortController(), cachedPickTime: 1, cleanupReport: { errors: [] },
    removeProjectionGuard() { calls.push('guard'); }, resources: { restore() { throw new Error('one resource'); } },
    restoreScene() { calls.push('camera'); }, releaseRenderTargets() { calls.push('targets'); }, enterHooksActive: true,
    options: { onExit() { calls.push('tools'); } }, viewer: { container: { style: {} }, isDestroyed: () => false, resize() {}, scene: { requestRender() {} } } });
  value.releaseCachedPicking(); value.releaseCachedPicking();
  assert.deepEqual(calls, ['guard', 'camera', 'tools', 'targets']); assert.deepEqual(value.cleanupReport.errors, ['one resource']);
  assert.equal(value.resources, undefined); assert.equal(value.restoreScene, undefined);
});
