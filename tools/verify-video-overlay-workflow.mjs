#!/usr/bin/env node
/** Real decoding, completed WebGL frame, autosave and lifecycle integration. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright'));
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5176';
const server = process.env.START_VITE === '1' ? await (await import('vite')).createServer({ server: {
  host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port) || 5176, strictPort: true, hmr: false, watch: null } }) : undefined;
await server?.listen();
const work = await mkdtemp(path.join(os.tmpdir(), 'cc-workflow-')), output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const videoPath = path.join(work, 'synthetic-changing-flight.mp4'), xmlPath = path.join(work, 'synthetic-camera.xml');
// Every frame has a different background; a stale video copy cannot pass pairing.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "nullsrc=s=640x360:r=10:d=9,geq=r='40+2*N':g='30+N':b='80+N'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
const longitude = [120, 120.00006218, 120.00012436, 120.003109, 120.00317118];
const photo = (lon, i) => `<Photo><Id>${i}</Id><ImagePath>frame_${i}.jpg</ImagePath><Component>1</Component><Pose><Center><x>${lon}</x><y>30</y><z>80</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
await writeFile(xmlPath, `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><SRSId>0</SRSId><Photogroups><Photogroup><Name>Synthetic nadir camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew>${longitude.map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(20000);
const errors = [], consoleErrors = [], checks = [], pendingContent = new Map(), fulfilledNames = new Set();
page.on('pageerror', e => errors.push(String(e.stack || e))); page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const state = () => page.evaluate(() => window.__workflow.snapshot());
// Explicit probes run only at assertion boundaries, never in per-frame hooks.
const hash = () => page.evaluate(() => window.__workflow.presentationHash());
const record = (name, details = {}) => { checks.push({ name, pass: true, ...details }); console.log(`PASS ${name}`); };
let planeBody, report, baseline;
await page.route('**/__workflow-fixture__/*.gltf', async route => {
  const name = path.basename(new URL(route.request().url()).pathname, '.gltf');
  if ((name === 'detail' || fulfilledNames.has(name)) && planeBody) await route.fulfill({ status: 200, contentType: 'model/gltf+json', body: planeBody });
  else pendingContent.set(name, route);
});
const wait = fn => page.waitForFunction(fn);
const waitForRequest = async name => { for (let i = 0; i < 150 && !pendingContent.has(name); i++) await page.waitForTimeout(50); assert.ok(pendingContent.has(name), `actual ${name} request must be pending`); return pendingContent.get(name); };
const fulfill = async name => { fulfilledNames.add(name); return (await waitForRequest(name)).fulfill({ status: 200, contentType: 'model/gltf+json', body: planeBody }); };
const setInput = async (selector, value, event = 'input') => page.locator(selector).evaluate((input, { value, event }) => { input.value = String(value); input.dispatchEvent(new Event(event, { bubbles: true })); }, { value, event });
const assertPairs = pairs => {
  assert.ok(pairs.length, 'actual video and WebGL compositing must have happened');
  for (const pair of pairs) {
    assert.ok(pair.cameraError < .001, `decoded frame ${pair.time} camera error ${pair.cameraError}m`);
    assert.ok(Math.abs(pair.pendingTime - pair.time) < .000001, `video/camera timestamps differ: ${JSON.stringify(pair)}`);
    assert.ok(pair.sourcePtsError < .000001, `captured video frame PTS differs: ${JSON.stringify(pair)}`);
    assert.equal(pair.sourceTime, pair.time); assert.equal(pair.depthReady, true, 'incomplete depth must never be committed');
  }
};
const assertExited = s => {
  assert.equal(s.active, false); assert.equal(s.hasResources, false); assert.equal(s.hasSourceFrame, false); assert.equal(s.hasPresentation, false); assert.equal(s.presentationDom, 0);
  assert.equal(s.mediaSrc, null); assert.equal(s.frameHandle, null); assert.equal(s.animationHandle, null); assert.equal(s.pendingCallbacks, 0); assert.equal(s.callbacksAfterExit, 0);
  assert.equal(s.compositor, null); assert.ok(s.released.length > 0 && s.released.every(item => item.disposed && item.width === 0 && item.height === 0));
  assert.equal(s.dimensions.cachedDom, 0); assert.equal(s.dimensions.editorDom, 0);
  for (const key of ['resolutionScale', 'useDefaultRenderLoop', 'requestRenderMode', 'maximumRenderTimeChange', 'shadows', 'highDynamicRange', 'cameraInputs', 'width', 'height']) assert.equal(s.renderer[key], baseline.renderer[key], `renderer ${key} must restore`);
  assert.equal(s.shaderRestored, true); assert.equal(s.styleRestored, true); assert.equal(s.sourceShow, false);
  assert.deepEqual(s.lifecycle, baseline.lifecycle); assert.deepEqual(s.geometry, baseline.geometry);
};
try {
  await page.goto(`${baseUrl}/tools/fixtures/video-overlay-workflow.html`, { waitUntil: 'networkidle' });
  await wait(() => window.__workflow?.snapshot().modelReady); baseline = await state();
  planeBody = await page.evaluate(() => window.__workflow.planeGltf());
  await page.locator('#ccVideoFile').setInputFiles(videoPath); await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  await page.locator('#ccInterval').fill('2'); await setInput('#ccOpacity', 1);
  await page.locator('#ccOcclusionEnabled').evaluate(el => { el.closest('details').open = true; });
  await page.locator('#ccOcclusionSource').selectOption('ground'); await page.locator('#ccOcclusionEnabled').check();
  await page.locator('#ccStart').click(); await wait(() => window.__workflow.snapshot().active);
  await waitForRequest('parent'); await wait(() => window.__workflow.snapshot().buffering);
  const initialWait = await state(); assert.equal(initialWait.presentedTime, null); assert.equal(initialWait.sourceShow, true); assert.equal(initialWait.status.ready, false);
  record('initial presentation waits for complete surface depth instead of flashing a source-only frame');
  await fulfill('parent');
  await wait(() => { const s = window.__workflow.snapshot(); return s.presentedTime !== null && s.status?.ready && !s.buffering; });
  const initialPixels = await page.evaluate(() => window.__workflow.pixels());
  assert.equal(initialPixels.orange, 0); assert.equal(initialPixels.green, 0); assert.ok(initialPixels.cyan > 50 && initialPixels.yellow > 50); assert.equal(initialPixels.glError, 0);
  record('completed presentation contains protected above-ground geometry', { pixels: initialPixels });
  await page.locator('[data-cc-speed]').selectOption('0.5'); await page.locator('[data-cc-play]').click();
  await wait(() => new Set(window.__workflow.snapshot().pairs.map(pair => pair.time)).size >= 6);
  await page.locator('[data-cc-play]').click(); await wait(() => window.__workflow.snapshot().paused);
  const played = await state(); assertPairs(played.pairs); assert.ok(played.presentedTime > .3 && played.presentedTime < 4);
  record('real decoded video frames are paired with the matching completed camera render', { pairedFrames: played.pairs.length, lastTime: played.presentedTime });
  await page.waitForTimeout(150); const beforeSeek = await state(), beforeSeekHash = await hash();
  await setInput('[data-cc-seek]', 6);
  await waitForRequest('remote'); await wait(() => { const s = window.__workflow.snapshot(); return s.buffering && !s.seeking; });
  await page.waitForTimeout(250); const waiting = await state();
  assert.equal(await hash(), beforeSeekHash); assert.equal(waiting.presentedTime, beforeSeek.presentedTime);
  assert.equal(waiting.paused, true); assert.equal(waiting.sourceShow, true);
  await page.evaluate(() => window.__workflow.resetMediaStats());
  await page.locator('[data-cc-play]').click(); await wait(() => !window.__workflow.snapshot().paused);
  const requestedPlay = await state(); assert.equal(requestedPlay.wantedPlaying, true);
  await page.waitForTimeout(450); const flowing = await state(); assert.ok(flowing.mediaTime > requestedPlay.mediaTime + .1); assert.equal(flowing.buffering, true); assert.equal(await hash(), beforeSeekHash);
  assert.equal(flowing.pauseCalls, 0); assert.equal(flowing.cpuVideoCopies, 0); assert.ok(flowing.callbackCount > requestedPlay.callbackCount);
  record('missing depth holds the complete GPU frame while the native decoder keeps playing without pause or CPU video copies', { pauseCalls: flowing.pauseCalls, cpuVideoCopies: flowing.cpuVideoCopies, mediaAdvance: flowing.mediaTime - requestedPlay.mediaTime });
  await fulfill('remote'); await wait(() => { const s = window.__workflow.snapshot(); return s.presentedTime > 6.1 && !s.buffering && s.status?.ready; });
  await page.locator('[data-cc-play]').click(); await wait(() => window.__workflow.snapshot().paused);
  const recovered = await state(); assertPairs(recovered.pairs);
  const protectedRemote = await page.evaluate(() => window.__workflow.pixels()); assert.equal(protectedRemote.orange, 0); assert.equal(protectedRemote.green, 0); assert.ok(protectedRemote.cyan > 50 && protectedRemote.yellow > 50);
  record('loaded depth atomically presents the new video/camera pair and resumes the requested playback');
  const complete = await state();
  await page.evaluate(() => { window.__workflow.resetMediaStats(); window.__workflow.setDepthMode('alternate'); });
  await page.locator('[data-cc-play]').click();
  await page.waitForTimeout(650);
  const alternating = await state(); assert.equal(alternating.paused, false); assert.equal(alternating.pauseCalls, 0); assert.equal(alternating.cpuVideoCopies, 0);
  assert.ok(alternating.mediaTime > complete.mediaTime + .1); assertPairs(alternating.pairs);
  await page.evaluate(() => window.__workflow.setDepthMode('actual'));
  await wait(() => { const s = window.__workflow.snapshot(); return !s.buffering && s.presentedTime > 6.1; });
  await page.locator('[data-cc-play]').click(); await wait(() => window.__workflow.snapshot().paused);
  const afterAlternating = await page.evaluate(() => window.__workflow.pixels());
  assert.equal(afterAlternating.orange, 0); assert.equal(afterAlternating.green, 0); assert.ok(afterAlternating.cyan > 50 && afterAlternating.yellow > 50);
  record('alternating per-frame depth readiness commits only complete GPU pairs without restarting decoding');
  await page.locator('#ccTarget').selectOption('cad'); await setInput('#ccUp', 29);
  await page.locator('#ccSchemeName').fill('现场融合 · CAD 高程保留');
  await page.locator('#ccExit').click();
  await wait(() => { const s = window.__workflow.snapshot(); return !s.active && s.saved?.name === '现场融合 · CAD 高程保留' && s.saved.settings.adjustments.cad?.up === 29; });
  const exited = await state(); assertExited(exited); assert.ok(exited.saved.settings.currentTime >= 6);
  record('leaving saves the latest name, CAD +29m and presented position before releasing decoder and scene resources');
  await page.evaluate(() => window.__workflow.restoreSaved());
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.locator('#ccStart').click(); await wait(() => { const s = window.__workflow.snapshot(); return s.active && s.presentedTime !== null && !s.buffering; });
    assert.equal(await page.locator('#ccSchemeName').inputValue(), '现场融合 · CAD 高程保留');
    await page.locator('#ccTarget').selectOption('cad'); assert.equal(await page.locator('#ccUp').inputValue(), '29');
    await page.locator('#ccStop').click(); await wait(() => !window.__workflow.snapshot().active);
    assertExited(await state());
  }
  await page.waitForTimeout(150); const repeated = await state(); assert.equal(repeated.initialUploads, 1); assert.ok(repeated.settingsUpdates >= 1); assert.ok(repeated.savedIds.every(id => id === 'workflow-saved')); assert.equal(repeated.enterCount, repeated.exitCount);
  record('save/reopen and three repeat entries preserve CAD height without repeated video uploads or leaked callbacks, event listeners or GPU stages');
  await page.evaluate(() => window.__workflow.waitOutsideFrames(3)); assertExited(await state());
  const freed = await state(); assert.equal(freed.renderer.loadedTiles, baseline.renderer.loadedTiles); assert.equal(freed.renderer.tileBytes, baseline.renderer.tileBytes);
  record('normal map continues rendering after exit and releases AR-only tile cache memory', { renderer: freed.renderer });
  const final = await state(); assert.deepEqual(final.renderErrors, []); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  await page.screenshot({ path: path.join(output, 'video-overlay-workflow.png') });
  report = { pass: true, checks, final, browserErrors: errors, consoleErrors };
} catch (error) {
  report = { pass: false, checks, error: String(error.stack || error), final: await state().catch(() => null), browserErrors: errors, consoleErrors };
  await page.screenshot({ path: path.join(output, 'video-overlay-workflow-failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'video-overlay-workflow-report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await server?.close();
}
console.log(JSON.stringify({ pass: report.pass, checks: checks.length, report: path.join(output, 'video-overlay-workflow-report.json'), error: report.error }, null, 2));
if (!report.pass) process.exitCode = 1;
