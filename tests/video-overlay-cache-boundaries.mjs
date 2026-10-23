import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { Matrix4, SceneMode } from 'cesium';

// Exercise the shipped controller methods at asynchronous ownership boundaries.
// Media/OPFS/Cesium rendering itself is covered by verify-video-overlay-native-cache.
const workspace = resolve(process.cwd());
const directory = await mkdtemp(workspace + '/.video-overlay-cache-boundaries-');
assert.ok(resolve(directory).startsWith(workspace + sep));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
try {
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts"; export { VideoOverlayResources } from "./src/videoOverlayResources.ts";', resolveDir: workspace, loader: 'ts' },
    outfile: directory + '/fixture.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  const { VideoModelOverlay, VideoOverlayResources } = await import(pathToFileURL(directory + '/fixture.mjs').href);
  const nodes = new Map();
  const el = id => { if (!nodes.has(id)) nodes.set(id, { disabled: false, textContent: '', replaceChildren() {} }); return nodes.get(id); };
  const owner = extra => Object.assign(Object.create(VideoModelOverlay.prototype), {
    epoch: 0, inputGeneration: 0, destroyed: false, resourceMatricesBeforeAR: new Map(), selected: new Set(), selectionInitialized: true,
    video: { currentTime: 0, seeking: false, src: '' }, viewer: { scene: { mode: SceneMode.SCENE3D, requestRender() {} }, canvas: { width: 640, height: 360, clientWidth: 640, clientHeight: 360 } },
    options: { getImports: () => [], getRecord: () => undefined }, el,
    occlusion: { enabled: false }, adjustments: {}, cameraRegistration: { enabled: false }, cameraCorrection: Matrix4.toArray(Matrix4.IDENTITY), annotations: [], effects: [],
    updatePlayback() {}, updateTargets() {}, refreshSceneReferences() {}, refreshOcclusionSources() {},
    assertVideoAccess() {}, checkSceneReference() {}, checkOcclusionSource() {},
    // Keep this test focused on enter's cancellation wiring, not DOM/GL disposal.
    exit() { this.controller?.abort(); this.controller = undefined; this.epoch++; this.resources?.restore(); this.resources = undefined; this.restoreScene = undefined; },
  }, extra);

  const originalCreate = VideoOverlayResources.create;
  try {
    let creates = 0, entered = 0, captured = 0, mounted = 0;
    VideoOverlayResources.create = async () => { creates++; throw new Error('Cancelled entry reached resource creation'); };
    const gate = deferred(), started = deferred(), cancellation = new AbortController();
    let preparationSignal;
    const preparing = owner({
      options: { getImports: () => [], onEnter() { entered++; } },
      async prepare(_validate, signal) { preparationSignal = signal; started.resolve(); await gate.promise; signal.throwIfAborted(); },
      captureScene() { captured++; this.restoreScene = () => {}; }, mountStage() { mounted++; },
    });
    const opening = preparing.enter(true, cancellation.signal);
    const rejected = assert.rejects(opening, error => error.name === 'AbortError');
    await started.promise; cancellation.abort();
    assert.equal(preparationSignal.aborted, true, 'Cancelling the cache must abort an entry still awaiting XML/media preparation');
    gate.resolve(); await rejected;
    assert.equal(creates, 0); assert.equal(entered, 0); assert.equal(captured, 0); assert.equal(mounted, 0); assert.equal(preparing.active, false);
    assert.equal(el('ccStart').disabled, false);

    const resourcesGate = deferred(), resourcesStarted = deferred(), resourceCancellation = new AbortController();
    let resourceSignal;
    VideoOverlayResources.create = async options => { creates++; resourceSignal = options.signal; resourcesStarted.resolve(); await resourcesGate.promise; options.signal.throwIfAborted(); throw new Error('Cancelled resource creation continued'); };
    const creating = owner({ prepare: async () => {}, options: { getImports: () => [], onEnter() { entered++; } },
      captureScene() { this.restoreScene = () => {}; }, mountStage() { mounted++; } });
    const creatingPromise = creating.enter(true, resourceCancellation.signal);
    const creationRejected = assert.rejects(creatingPromise, error => error.name === 'AbortError');
    await resourcesStarted.promise; resourceCancellation.abort();
    assert.equal(resourceSignal.aborted, true, 'Cancelling the cache must reach the resource creation signal');
    resourcesGate.resolve(); await creationRejected;
    assert.equal(mounted, 0); assert.equal(creating.active, false); assert.equal(creating.resources, undefined);
    console.log('PASS: cancelled cache preparation/resource creation cannot mount a late AR session');
  } finally { VideoOverlayResources.create = originalCreate; }

  const requested = { start: 0, end: 2.1 }, actual = { start: 0, end: 2 };
  let plays = 0, clears = 0, rebuilds = 0;
  const signature = JSON.stringify(requested);
  const cached = owner({
    cachedPreview: { ...actual, signature, signatureRange: requested, video: { paused: true, ended: false, async play() { plays++; } } },
    cacheSignature: range => JSON.stringify(range), clearCachedPreview() { clears++; }, prepareCachedPlayback() { rebuilds++; return Promise.resolve(); },
  });
  for (let i = 0; i < 3; i++) { cached.playCachedPreview(); cached.refreshResources(); }
  assert.equal(plays, 3); assert.equal(clears, 0); assert.equal(rebuilds, 0);
  cached.cachedPreview.signature = 'genuinely-changed-inputs';
  cached.playCachedPreview(); assert.equal(clears, 1); assert.equal(rebuilds, 1);
  console.log('PASS: audio-tail trimming uses the requested signature range without hiding genuine invalidation');

  const diagnosticState = {
    metadata: { width: 640, height: 360, duration: 2.1 }, dataset: { photos: [], photogroups: [] },
    track: { sample: () => null, intrinsics: {}, distortion: {}, startTime: 0, endTime: 2 },
    files: { video: { name: 'source.mp4' }, source: { name: 'camera.xml' } }, resumeTime: 1.25,
  };
  let prepares = 0, mediaReleases = 0;
  const exited = owner({ ...diagnosticState, async prepare() { prepares++; throw new Error('Diagnostics must not restart the decoder'); }, releaseSourceMedia() { mediaReleases++; } });
  const diagnostic = await exited.createDiagnostics();
  assert.equal(prepares, 0); assert.equal(mediaReleases, 0); assert.equal(diagnostic.video.currentTime, 1.25);
  assert.equal(diagnostic.video.width, 640); assert.equal(diagnostic.video.duration, 2.1); assert.equal(diagnostic.liveCamera, null);
  console.log('PASS: diagnostics after exit reuse stored metadata without reopening media');

  const diagnosticGate = deferred(), diagnosticStarted = deferred();
  const raced = owner({ ...diagnosticState, metadata: undefined,
    async prepare(_validate, signal) { diagnosticStarted.resolve(); await diagnosticGate.promise; signal.throwIfAborted(); },
    releaseSourceMedia() { mediaReleases++; },
  });
  const reading = raced.createDiagnostics(), readingRejected = assert.rejects(reading, error => error.name === 'AbortError');
  await diagnosticStarted.promise;
  const oldController = raced.controller, newController = new AbortController();
  oldController.abort(); raced.epoch++; raced.controller = newController; raced.restoreScene = () => {}; raced.video.src = 'blob:new-session';
  diagnosticGate.resolve(); await readingRejected;
  assert.equal(raced.controller, newController); assert.equal(newController.signal.aborted, false);
  assert.equal(raced.video.src, 'blob:new-session'); assert.equal(raced.active, true); assert.equal(mediaReleases, 0);
  console.log('PASS: cancelled diagnostic fallback cannot release a newer entry decoder or controller');
} finally { await rm(directory, { recursive: true, force: true }); }
