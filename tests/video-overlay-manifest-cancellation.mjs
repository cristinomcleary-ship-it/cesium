import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Run the production import/extraction owners with delayed I/O. Frame encoding
// itself is covered separately; this reproduces exit during manifest validation.
const workspace = resolve(process.cwd());
const directory = await mkdtemp(`${workspace}/.video-overlay-manifest-test-`);
const previousHooks = globalThis.__manifestTest;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
try {
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts";', resolveDir: workspace, loader: 'ts' },
    outfile: `${directory}/fixture.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' },
    plugins: [{ name: 'controlled-frame-io', setup(build) {
      build.onResolve({ filter: /(?:^|\/)videoFrameExtraction$/ }, () => ({ path: 'controlled-frame-io', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
        export const parseVideoFrameManifest = value => JSON.parse(value);
        export const verifyVideoFrameSource = (...args) => globalThis.__manifestTest.verify(...args);
        export const extractVideoFrames = (...args) => globalThis.__manifestTest.extract(...args);
        export const pickVideoFrameDirectory = async () => undefined;
      ` }));
    } }] });
  const { VideoModelOverlay } = await import(pathToFileURL(`${directory}/fixture.mjs`).href);
  const manifest = { frames: [{ filename: 'frame_000000.jpg' }] };
  function owner() {
    const elements = new Map();
    return Object.assign(Object.create(VideoModelOverlay.prototype), {
      options: { canAccessVideo: () => true }, files: { video: new File(['video'], 'flight.mp4') },
      inputGeneration: 0, epoch: 0, sessionGeneration: 0, manifestImportGeneration: 0, destroyed: false, commits: 0,
      el(id) { if (!elements.has(id)) elements.set(id, { value: '', disabled: false, textContent: '' }); return elements.get(id); },
      number() { return 1; }, dirty() {}, downloadBlob() {},
      leave() { this.commits++; this.extraction?.abort(); this.epoch++; },
      exit() { this.extraction?.abort(); this.epoch++; },
    });
  }
  globalThis.__manifestTest = { verify: async () => {}, extract: async () => ({ manifest, output: { kind: 'directory' } }) };
  {
    const ar = owner(), text = deferred();
    const importing = ar.importManifest({ text: () => text.promise });
    ar.epoch++; // A new AR entry or exit while the old file is being read.
    text.resolve(JSON.stringify(manifest));
    await assert.rejects(importing, { name: 'AbortError' });
    assert.equal(ar.commits, 0); assert.equal(ar.manifest, undefined);
  }
  {
    const ar = owner(), validation = deferred(), entered = deferred(), abort = new AbortController();
    let handedOff = false;
    globalThis.__manifestTest.verify = async () => { entered.resolve(); await validation.promise; };
    const importing = ar.importManifest(new File([JSON.stringify(manifest)], 'manifest.json'), abort.signal, () => { handedOff = true; });
    await entered.promise; abort.abort(); validation.resolve();
    await assert.rejects(importing, { name: 'AbortError' });
    assert.equal(handedOff, false); assert.equal(ar.commits, 0);
  }
  for (const cancel of [true, false]) {
    const ar = owner(), validation = deferred(), entered = deferred();
    globalThis.__manifestTest.verify = async () => { entered.resolve(); await validation.promise; };
    const extracting = ar.extractFrames(false);
    await entered.promise;
    const task = ar.extractionTask, controller = ar.extraction;
    assert.ok(task); assert.ok(controller, 'exit can still reach the extraction controller during manifest validation');
    assert.equal(ar.el('ccExtract').disabled, true);
    if (cancel) { controller.abort(); ar.epoch++; }
    validation.resolve(); await extracting; await task;
    assert.equal(ar.extractionTask, undefined); assert.equal(ar.extraction, undefined);
    assert.equal(ar.el('ccExtract').disabled, false);
    if (cancel) {
      assert.equal(ar.commits, 0, 'cancelled extraction cannot leave a newly entered AR session');
      assert.equal(ar.manifest, undefined);
      assert.equal(ar.el('ccExtractStatus').textContent, '抽帧已取消');
    } else {
      assert.equal(ar.commits, 1); assert.deepEqual(ar.manifest, manifest);
      assert.equal(controller.signal.aborted, false, 'successful import transfers the owner immediately before its intentional exit');
    }
  }
  console.log('PASS: delayed manifest read, cancelled fingerprint validation, extraction cancellation and successful owner transfer');
} finally {
  globalThis.__manifestTest = previousHooks;
  await rm(directory, { recursive: true, force: true });
}
