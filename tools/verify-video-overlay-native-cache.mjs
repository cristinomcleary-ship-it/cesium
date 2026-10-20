#!/usr/bin/env node
/** Actual WebCodecs + OPFS acceptance. Uses only generated source media.
 * Requires FFmpeg 6+, ffprobe, Playwright and Chromium. START_VITE=1 (default without
 * BASE_URL) serves this checkout. BROWSER_EXECUTABLE / PLAYWRIGHT_MODULE override
 * installed tools; OUTPUT_DIR keeps the machine-readable report and output files.
 * CONTROLLER=1 also exercises the actual Cesium controller and five reuse/exit cycles.
 * This does not measure the user's GPU or claim acceptance of their actual flight.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (runtime ? path.join(runtime, 'playwright') : 'playwright'));
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5191';
const work = await mkdtemp(path.join(os.tmpdir(), 'ar-native-cache-'));
const output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const ffmpeg = process.env.FFMPEG_EXECUTABLE || 'ffmpeg';
const ffprobe = process.env.FFPROBE_EXECUTABLE || 'ffprobe';
const encode = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const inspect = file => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-show_frames', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
const videoFrames = probe => probe.frames.filter(frame => frame.media_type === 'video');
const pts = frame => Number(frame.best_effort_timestamp_time ?? frame.pts_time);
const source60 = path.join(work, 'source60.mp4');
const sourceVfr = path.join(work, 'source-vfr.mp4');
encode(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=2', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source60]);
encode(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60:duration=2', '-vf', "select='if(lt(t,1),not(mod(n,3)),not(mod(n,2)))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sourceVfr]);
const sourceProbes = { source60: inspect(source60), sourceVfr: inspect(sourceVfr) };
assert.equal(videoFrames(sourceProbes.source60).length, 120);
assert.equal(videoFrames(sourceProbes.sourceVfr).length, 50);
const startsServer = process.env.START_VITE === '1' || (!process.env.BASE_URL && process.env.START_VITE !== '0');
const server = startsServer ? await (await import('vite')).createServer({ server: {
  host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port) || 5191, strictPort: true, hmr: false, watch: null,
} }) : undefined;
await server?.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(120000);
const errors = [], report = { pass: false, checks: [], sources: {}, results: {}, browserErrors: errors };
page.on('pageerror', error => errors.push(String(error.stack || error)));
const mark = (name, detail = {}) => { report.checks.push({ name, ...detail }); console.log(`PASS ${name}`); };

async function setup() {
  await page.goto(`${baseUrl}/tools/fixtures/video-overlay-native-cache.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    window.__native = await import('/src/videoOverlayNativeCache.ts');
    window.__cache = await import('/src/videoOverlayCacheStore.ts');
  });
}

async function convert(file, name, duration, delay = 0, start = 0, includeAudio = true, dimensions = { width: 640, height: 360 }) {
  await page.locator('#source').setInputFiles(file);
  const result = await page.evaluate(async ({ name, duration, delay, start, includeAudio, dimensions }) => {
    const sourceFile = document.querySelector('#source').files[0];
    const controller = new AbortController();
    const store = await window.__cache.VideoOverlayCacheStore.open();
    const key = await window.__cache.hashVideoOverlayInputs({ video: sourceFile }, { acceptance: name, range: [start, duration] }, controller.signal);
    const txn = await store.begin(key, { schemeId: `acceptance-${name}`, signal: controller.signal });
    const canvas = document.createElement('canvas'); canvas.width = dimensions.width; canvas.height = dimensions.height;
    const context = canvas.getContext('2d'); const samples = [];
    const started = performance.now();
    let metadata;
    try {
      metadata = await window.__native.prepareNativeVideoCache({ sourceFile, range: { start, end: duration }, ...dimensions, includeAudio,
        signal: controller.signal, target: txn.handle,
        getFrame: async (time, signal, source) => {
          signal.throwIfAborted(); samples.push(time);
          context.drawImage(source, 0, 0, canvas.width, canvas.height);
          context.fillStyle = '#00ffff'; context.fillRect(10, 10, 24, 24);
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          signal.throwIfAborted(); return canvas;
        } });
      window.__nativeMetadata = metadata;
      await txn.commit(metadata);
    } catch (error) { await txn.abort(); throw error; }
    const cached = await store.get(key);
    if (!cached) throw new Error('Finalized native cache was not published');
    window.__nativeLast = { key, file: cached.file, metadata: cached.metadata };
    return { key, metadata, samples, wallMs: performance.now() - started, bytes: cached.file.size, name: cached.file.name };
  }, { name, duration, delay, start, includeAudio, dimensions });
  const saved = path.join(output, `${name}.webm`);
  const base64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await window.__nativeLast.file.arrayBuffer());
    let raw = ''; for (let i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(raw);
  });
  await writeFile(saved, Buffer.from(base64, 'base64'));
  return { ...result, file: saved, probe: inspect(saved) };
}

function assertTimeline(source, converted, tolerance = .0011) {
  const before = videoFrames(source).filter(frame => pts(frame) >= converted.metadata.start - .000001 && pts(frame) < converted.metadata.end - .000001), after = videoFrames(converted.probe);
  assert.equal(after.length, before.length, 'Every decoded source frame must survive into the finalized movie');
  assert.equal(converted.metadata.frames, before.length);
  assert.equal(converted.samples.length, before.length);
  const first = pts(before[0]);
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(converted.samples[i] - pts(before[i])) <= .00001, `Render source PTS ${i} differs`);
    assert.ok(Math.abs(pts(after[i]) - (pts(before[i]) - first)) <= tolerance, `Encoded source PTS ${i} differs`);
  }
  const stream = converted.probe.streams.find(stream => stream.codec_type === 'video');
  assert.equal(stream.width, converted.metadata.width); assert.equal(stream.height, converted.metadata.height);
}

async function verifyController() {
  // Reuse the existing real Cesium fixture. This suite checks lifetime/ownership;
  // the separate verify-ar-exit-performance suite instruments actual GL allocations.
  await page.addInitScript(() => { window.__glStats = { snapshot: () => ({}) }; });
  await page.goto(`${baseUrl}/tools/fixtures/ar-exit-performance.html?models=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__exitPerformance?.state().ready);
  const controllerState = () => page.evaluate(() => {
    const harness = window.__exitPerformance, overlay = harness.overlay, scene = harness.viewer.scene, host = harness.state();
    return {
      active: overlay.active, liveScene: !!overlay.restoreScene, resources: !!overlay.resources, compositor: !!overlay.compositor,
      sourceSrc: overlay.video.getAttribute('src'), frameHandle: overlay.frameHandle ?? null, animationHandle: overlay.animationHandle ?? null,
      cache: overlay.cachedPreview ? { ready: overlay.cachedPreview.video.readyState, width: overlay.cachedPreview.video.videoWidth,
        height: overlay.cachedPreview.video.videoHeight, currentTime: overlay.cachedPreview.video.currentTime,
        paused: overlay.cachedPreview.video.paused } : null,
      renderingEntries: window.__cacheRenderingEntries,
      callbacks: Object.fromEntries(['preUpdate', 'postUpdate', 'preRender', 'postRender'].map(key => [key, scene[key].numberOfListeners])),
      renderer: host.renderer, glError: host.glError, errors: host.errors,
      modelMatrices: Array.from(overlay.options.getImports(), item => Array.from(item.resource.modelMatrix)),
      messages: host.messages,
    };
  });
  await page.evaluate(() => {
    const overlay = window.__exitPerformance.overlay, original = overlay.options.onEnter;
    window.__cacheRenderingEntries = 0;
    overlay.options.onEnter = () => { window.__cacheRenderingEntries++; original?.(); };
  });
  const baseline = await controllerState();
  const photo = i => `<Photo><Id>${i}</Id><ImagePath>frame_${i}.jpg</ImagePath><Component>1</Component><Pose><Center><x>120</x><y>30</y><z>200</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
  const xml = path.join(work, 'controller-camera.xml');
  await writeFile(xml, `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS84</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><SRSId>0</SRSId><Photogroups><Photogroup><Name>Native cache acceptance</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew>${[0, 1, 2].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`);
  await page.locator('#ccVideoFile').setInputFiles(source60);
  await page.locator('#ccXmlFile').setInputFiles(xml);
  await page.locator('#ccInterval').fill('1');
  await page.locator('#ccStart').click();
  await page.waitForFunction(() => window.__exitPerformance.overlay.presentedTime !== undefined);
  await page.locator('[data-cc-play]').click();
  await page.waitForFunction(() => window.__exitPerformance.overlay.cachedPreview?.video.readyState >= 2);
  const prepared = await controllerState();
  assert.equal(prepared.cache.width, 640); assert.equal(prepared.cache.height, 360);
  assert.equal(prepared.resources, false); assert.equal(prepared.compositor, false); assert.equal(prepared.liveScene, false);
  assert.equal(prepared.sourceSrc, null); assert.equal(prepared.frameHandle, null); assert.equal(prepared.animationHandle, null);
  assert.deepEqual(prepared.callbacks, baseline.callbacks, 'Cached playback must remove the AR scene callbacks');
  assert.deepEqual(prepared.renderer, baseline.renderer, 'Cached playback must restore the main renderer before showing the ordinary video');
  const entries = prepared.renderingEntries;
  assert.ok(entries >= 1);
  mark('Ordinary Play waits for complete native cache, then releases live AR resources before playing');

  for (let cycle = 0; cycle < 5; cycle++) {
    await page.locator('#ccExit').click();
    await page.waitForFunction(() => !window.__exitPerformance.overlay.active);
    await page.evaluate(() => window.__exitPerformance.frames(2));
    const exited = await controllerState();
    assert.equal(exited.resources, false); assert.equal(exited.compositor, false); assert.equal(exited.liveScene, false); assert.equal(exited.cache, null);
    assert.equal(exited.sourceSrc, null); assert.equal(exited.frameHandle, null); assert.equal(exited.animationHandle, null);
    assert.deepEqual(exited.callbacks, baseline.callbacks);
    assert.deepEqual(exited.renderer, baseline.renderer);
    assert.deepEqual(exited.modelMatrices, baseline.modelMatrices);
    assert.equal(exited.glError, 0); assert.deepEqual(exited.errors, []);
    const pick = await page.evaluate(() => window.__exitPerformance.pick());
    assert.equal(pick.picked, true); assert.equal(pick.glError, 0);
    await page.locator('#ccBuildPreview').click();
    await page.waitForFunction(() => window.__exitPerformance.overlay.cachedPreview?.video.readyState >= 2);
    const reused = await controllerState();
    assert.equal(reused.renderingEntries, entries, 'An unchanged completed cache must not reopen Cesium fusion rendering');
    assert.equal(reused.resources, false); assert.equal(reused.compositor, false);
    assert.deepEqual(reused.callbacks, baseline.callbacks);
  }
  mark('Five cache reuse/exit cycles retain map rendering, picking and model transforms without AR callback growth');
  await page.locator('#ccExit').click();
  await page.locator('#ccOpacity').evaluate(input => { input.value = '.72'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#ccBuildPreview').click();
  await page.waitForFunction(() => window.__exitPerformance.overlay.nativeCacheRendering && window.__exitPerformance.overlay.pendingTime !== undefined);
  const cancelledKey = await page.evaluate(async () => {
    const overlay = window.__exitPerformance.overlay;
    const { hashVideoOverlayInputs } = await import('/src/videoOverlayCacheStore.ts');
    return hashVideoOverlayInputs({ video: overlay.files.video, source: overlay.files.source, manifest: overlay.files.manifest }, overlay.cacheSignature({ start: 0, end: 2 }));
  });
  await page.locator('#ccExit').click();
  await page.waitForFunction(() => !window.__exitPerformance.overlay.cacheTask && !window.__exitPerformance.overlay.active);
  const cancelledCache = await page.evaluate(async key => {
    const { VideoOverlayCacheStore } = await import('/src/videoOverlayCacheStore.ts');
    return !!await (await VideoOverlayCacheStore.open()).get(key);
  }, cancelledKey);
  assert.equal(cancelledCache, false);
  const cancelledState = await controllerState();
  assert.equal(cancelledState.resources, false); assert.equal(cancelledState.compositor, false); assert.equal(cancelledState.cache, null);
  assert.deepEqual(cancelledState.callbacks, baseline.callbacks); assert.deepEqual(cancelledState.renderer, baseline.renderer);
  mark('Exiting during actual fusion preparation settles the job, restores the map and leaves no playable partial cache');
  report.controller = { baseline, prepared, final: cancelledState };
}

try {
  await setup();
  const constant = await convert(source60, 'native-60fps', 2, 20);
  assertTimeline(sourceProbes.source60, constant);
  assert.ok(constant.wallMs > 2000, 'Deliberate preparation overhead must exceed playback duration');
  assert.ok(Math.abs(Number(constant.probe.format.duration) - 2) < .1, 'Preparation overhead must not extend video playback duration');
  assert.equal(constant.probe.streams.filter(stream => stream.codec_type === 'audio').length, 1, 'Original audio track must remain present');
  report.results.constant = { metadata: constant.metadata, frames: videoFrames(constant.probe).length, wallMs: constant.wallMs, bytes: constant.bytes, duration: constant.probe.format.duration };
  mark('60fps retains all 120 source frames, timestamps, native dimensions and audio despite slow preparation', report.results.constant);
  const reused = await page.evaluate(async key => {
    const store = await window.__cache.VideoOverlayCacheStore.open(); const result = await store.get(key);
    return result ? { bytes: result.file.size, frames: result.metadata.frames } : null;
  }, constant.key);
  assert.deepEqual(reused, { bytes: constant.bytes, frames: 120 });
  await setup();
  const afterReload = await page.evaluate(async key => {
    const store = await window.__cache.VideoOverlayCacheStore.open(); const result = await store.get(key);
    return result ? { bytes: result.file.size, frames: result.metadata.frames } : null;
  }, constant.key);
  assert.deepEqual(afterReload, reused);
  mark('Completed OPFS cache survives a page reload without recomputation');

  const variable = await convert(sourceVfr, 'native-vfr', Number(sourceProbes.sourceVfr.format.duration));
  assertTimeline(sourceProbes.sourceVfr, variable);
  report.results.variable = { metadata: variable.metadata, frames: videoFrames(variable.probe).length, bytes: variable.bytes };
  mark('Variable-frame-rate source retains its 50 distinct frame timestamps', report.results.variable);

  const trimmed = await convert(source60, 'native-trimmed', 1.5, 0, .5);
  assertTimeline(sourceProbes.source60, trimmed);
  assert.equal(trimmed.metadata.frames, 60);
  assert.equal(trimmed.metadata.duration, 1);
  mark('Mid-video trimming renders the original source times and preserves all 60 frames in the selected second');

  const silent = await convert(source60, 'native-explicit-silent', 1, 0, 0, false);
  assertTimeline(sourceProbes.source60, silent);
  assert.equal(silent.probe.streams.filter(stream => stream.codec_type === 'audio').length, 0);
  assert.equal(silent.metadata.audioStatus, 'excluded');
  assert.equal(silent.metadata.audioTracks, 0);
  mark('Explicitly disabling audio removes only audio and still retains all source video frames');

  const rotatedPath = path.join(work, 'source-rotated.mp4');
  encode(['-display_rotation', '90', '-i', source60, '-c', 'copy', rotatedPath]);
  assert.equal(inspect(rotatedPath).streams.find(stream => stream.codec_type === 'video').side_data_list?.find(side => side.side_data_type === 'Display Matrix')?.rotation, 90);
  const rotated = await convert(rotatedPath, 'native-rotated', 2, 0, 0, true, { width: 360, height: 640 });
  assertTimeline(inspect(rotatedPath), rotated);
  assert.equal(rotated.metadata.width, 360); assert.equal(rotated.metadata.height, 640);
  mark('A source with 90-degree rotation retains all frames and its native displayed dimensions');

  await page.locator('#source').setInputFiles(source60);
  const cancelled = await page.evaluate(async () => {
    const sourceFile = document.querySelector('#source').files[0], controller = new AbortController();
    const store = await window.__cache.VideoOverlayCacheStore.open();
    const key = await window.__cache.hashVideoOverlayInputs({ video: sourceFile }, { acceptance: 'cancel-native' }, controller.signal);
    const txn = await store.begin(key, { schemeId: 'acceptance-cancel', signal: controller.signal });
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    let calls = 0, failed = false;
    try {
      await window.__native.prepareNativeVideoCache({ sourceFile, range: { start: 0, end: 2 }, width: 640, height: 360, signal: controller.signal, target: txn.handle,
        getFrame: async (_time, signal, source) => { canvas.getContext('2d').drawImage(source, 0, 0); if (++calls === 5) controller.abort(); signal.throwIfAborted(); return canvas; } });
    } catch (error) { failed = error.name === 'AbortError'; }
    finally { await txn.abort(); }
    const published = await store.get(key);
    return { calls, failed, published: !!published };
  });
  assert.equal(cancelled.failed, true); assert.equal(cancelled.published, false); assert.equal(cancelled.calls, 5);
  mark('Cancellation stops source-frame processing and never publishes a partial cache', cancelled);

  // Cheap long-source preflight only. 60fps continuity is tested above; this
  // deliberately 1fps, 65-second 4K source exercises the removed duration/size
  // rejection without pretending to have encoded a minute of full-rate 4K.
  const longPath = path.join(work, 'source-long-4k.mp4');
  encode(['-f', 'lavfi', '-i', 'color=c=0x243648:s=3840x2160:r=1:d=65', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', longPath]);
  await page.locator('#source').setInputFiles(longPath);
  const longPreflight = await page.evaluate(async () => {
    const sourceFile = document.querySelector('#source').files[0], controller = new AbortController();
    const store = await window.__cache.VideoOverlayCacheStore.open();
    const key = await window.__cache.hashVideoOverlayInputs({ video: sourceFile }, { acceptance: 'long-4k-preflight' }, controller.signal);
    const txn = await store.begin(key, { schemeId: 'acceptance-long-4k', signal: controller.signal });
    let calls = 0, firstTime, failed = false;
    try {
      await window.__native.prepareNativeVideoCache({ sourceFile, range: { start: 0, end: 65 }, width: 3840, height: 2160, signal: controller.signal, target: txn.handle,
        getFrame: async (time, signal) => { calls++; firstTime = time; controller.abort(); signal.throwIfAborted(); throw new Error('unreachable'); } });
    } catch (error) { failed = error.name === 'AbortError'; }
    finally { await txn.abort(); }
    return { calls, firstTime, cancelled: failed, published: !!await store.get(key) };
  });
  assert.equal(longPreflight.calls, 1); assert.equal(longPreflight.cancelled, true); assert.equal(longPreflight.published, false);
  mark('A 65-second native 4K source reaches its first frame without the old 512MiB estimate rejection (preflight only)', longPreflight);
  if (process.env.CONTROLLER === '1') await verifyController();
  assert.deepEqual(errors, []);
  report.pass = true;
} catch (error) { report.error = String(error.stack || error); report.lastMetadata = await page.evaluate(() => window.__nativeMetadata).catch(() => undefined); process.exitCode = 1; }
finally {
  await writeFile(path.join(output, 'native-cache-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, checks: report.checks.length, report: path.join(output, 'native-cache-report.json'), error: report.error }));
  await browser.close(); await server?.close();
}
