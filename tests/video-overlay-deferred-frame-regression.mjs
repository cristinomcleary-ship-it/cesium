import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { build } from 'esbuild';

// Reproduce cancellation restoring a paused 2s decoder while a stale 1.033s
// GPU/camera pair is still pending. No callback is delivered after it completes.
const workspace = resolve(process.cwd());
const directory = await mkdtemp(workspace + '/.video-overlay-deferred-test-');
assert.ok(resolve(directory).startsWith(workspace + sep));
const originalVideoFrame = globalThis.VideoFrame, originalWindow = globalThis.window;
try {
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts";', resolveDir: workspace, loader: 'ts' },
    outfile: directory + '/fixture.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  const { VideoModelOverlay } = await import(pathToFileURL(directory + '/fixture.mjs').href);
  globalThis.window = { setTimeout };
  for (const nativeFrame of [true, false]) {
    let closed = 0, captured = 1.033333, uploads = 0, pauseCalls = 0, requests = 0;
    const commits = [];
    globalThis.VideoFrame = nativeFrame ? class { constructor() { this.timestamp = 2000000; } close() { closed++; } } : undefined;
    const video = { readyState: 2, currentTime: 2, paused: true, ended: !nativeFrame, seeking: false,
      pause() { pauseCalls++; }, load() {}, removeAttribute() {} };
    const viewer = { canvas: {}, container: { dataset: {}, parentElement: { classList: { remove() {} } } }, resize() {}, isDestroyed: () => false,
      scene: { frameState: { frameNumber: 1 }, requestRender() { requests++; } } };
    const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
      viewer, video, restoreScene() {}, epoch: 0, frameGeneration: 0, wantedPlaying: false,
      sourceTime: 1.033333, sourceTarget: 2, pendingTime: 1.033333, presentedTime: 0,
      annotations: [], editRevision: 0, lastPresentationKey: '', renderReady: false,
      lensFrame: { number: 1, time: 1.033333, ready: true }, track: { sample: () => ({}) },
      presentation: { width: 2, height: 2, remove() {} }, presentationEditor: { unmount() {} },
      options: {},
      resources: { isPresentationReady: () => true, getOcclusionStatus: () => ({ enabled: true, ready: true }), setVisible() {}, restore() {} },
      compositor: { captureSource(_source, time) { captured = time; uploads++; return true; },
        commit(_canvas, time) { assert.equal(time, captured, 'every presentation must use the captured source PTS'); commits.push(time); return true; }, dispose() {} },
      renderFrame(time) { this.pendingTime = time; this.lensFrame = { number: 1, time, ready: true }; viewer.scene.requestRender(); },
      requestFrame() {}, updatePlayback() {},
    });
    for (let cycle = 0; cycle < 5; cycle++) {
      if (cycle) { assert.equal(owner.presentedTime, 2); owner.pendingTime = 1.033333; owner.sourceTime = captured = 1.033333; owner.lastPresentationKey = ''; owner.lensFrame.time = 1.033333; owner.renderReady = false; }
      const previous = owner.presentedTime, beforeUploads = uploads;
      assert.equal(owner.captureDecodedFrame(1.5), false);
      assert.equal(owner.captureDecodedFrame(nativeFrame ? 1.966667 : 2), false);
      assert.equal(uploads, beforeUploads, 'backpressure retains one immutable pair');
      owner.commitPresentation();
      assert.equal(owner.presentedTime, previous, 'incomplete geometry retains the previous completed view');
      assert.equal(pauseCalls, 0, 'backpressure never restarts native decoding');
      owner.renderReady = true; owner.commitPresentation();
      assert.equal(owner.presentedTime, 1.033333, 'finish the original pair before consuming the deferred source');
      assert.equal(owner.pendingTime, 2); assert.equal(captured, 2);
      assert.equal(owner.deferredFrame, undefined, 'consume one deferred notification without scheduling a busy loop');
      owner.commitPresentation();
      assert.equal(owner.presentedTime, 2, 'paused or ended source catches up without another video callback');
      assert.equal(owner.sourceTime, 2); assert.equal(owner.sourceTarget, 2);
      const settledUploads = uploads, settledRequests = requests, settledCommits = commits.length;
      for (let idle = 0; idle < 10; idle++) owner.commitPresentation();
      assert.equal(uploads, settledUploads); assert.equal(requests, settledRequests); assert.equal(commits.length, settledCommits);
    }
    assert.equal(pauseCalls, 0); assert.equal(closed, nativeFrame ? uploads : 0, 'every native VideoFrame is closed');
    owner.deferredFrame = { time: 9 }; owner.beginSeek(3);
    assert.equal(owner.deferredFrame, undefined, 'a new seek cannot consume the previous target deferred callback');
    owner.deferredFrame = { time: 4 }; owner.exit();
    assert.equal(owner.deferredFrame, undefined, 'exit releases deferred state before a new session');
    assert.equal(owner.active, false);
  }
  console.log('PASS: paused/ended deferred tail frame converges after five cancellation races with/without VideoFrame, preserves same-PTS pairs, avoids decoder restarts/idle loops and clears state on seek/exit');
} finally {
  globalThis.VideoFrame = originalVideoFrame; globalThis.window = originalWindow;
  await rm(directory, { recursive: true, force: true });
}
