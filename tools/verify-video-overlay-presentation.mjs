#!/usr/bin/env node
/** Native-pixel annotation/model cue persistence and baked continuous-preview regression. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5191';
const server = process.env.START_VITE === '1' ? await (await import('vite')).createServer({ server: { host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port), strictPort: true, hmr: false, watch: null } }) : undefined;
await server?.listen();
const work = await mkdtemp(path.join(os.tmpdir(), 'cc-presentation-')), output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const videoPath = path.join(work, 'native-1080p.mp4'), xmlPath = path.join(work, 'native-camera.xml');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x283050:s=1920x1080:r=30:d=2.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
const photo = index => `<Photo><Id>${index}</Id><ImagePath>frame_${index}.jpg</ImagePath><Component>1</Component><Pose><Center><x>120</x><y>30</y><z>80</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
await writeFile(xmlPath, `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><SRSId>0</SRSId><Photogroups><Photogroup><Name>Native camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>1920</Width><Height>1080</Height></ImageDimensions><FocalLengthPixels>1500</FocalLengthPixels><PrincipalPoint><x>959.5</x><y>539.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew>${[0, 1, 2].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); page.setDefaultTimeout(60000);
const errors = [], consoleErrors = [], checks = [];
page.on('pageerror', error => errors.push(String(error.stack || error))); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const state = () => page.evaluate(() => window.__workflow.snapshot());
const check = (name, details = {}) => { checks.push({ name, pass: true, ...details }); console.log(`PASS ${name}`); };
const setInput = async (selector, value, event = 'input') => page.locator(selector).evaluate((input, { value, event }) => { input.value = String(value); input.dispatchEvent(new Event(event, { bubbles: true })); }, { value, event });
const field = (kind, name, value) => setInput(`[data-${kind}-field="${name}"]`, value);
async function seek(time) {
  await setInput('[data-cc-seek]', time);
  await page.waitForFunction(time => { const s = window.__workflow.snapshot(); return !s.buffering && !s.seeking && s.presentedTime !== null && Math.abs(s.presentedTime - time) < .035; }, time);
  await page.waitForTimeout(100);
}
function decodedPixels(file, time) {
  const data = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
  let cyan = 0, red = 0;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r < 80 && g > 150 && b > 150) cyan++;
    if (r > 150 && g < 80 && b < 80) red++;
  }
  return { cyan, red };
}
let report, baseline, timeline;
try {
  await page.goto(`${baseUrl}/tools/fixtures/video-overlay-workflow.html?native=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__workflow?.snapshot().modelReady); baseline = await state();
  await page.locator('#ccVideoFile').setInputFiles(videoPath); await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  await page.locator('#ccInterval').fill('1'); await setInput('#ccOpacity', 1);
  await page.locator('#ccStart').click(); await page.waitForFunction(() => { const s = window.__workflow.snapshot(); return s.active && s.presentedTime !== null && !s.buffering; });
  const native = await state(); const nativePixels = await page.evaluate(() => ({ cyan: window.__workflow.sample(.6465, .7604), orange: window.__workflow.sample(.4023, .6736) })); assert.deepEqual(native.dimensions.source, [1920, 1080]); assert.deepEqual(native.dimensions.gpuSource, [1920, 1080]); assert.deepEqual(native.dimensions.presentation, [1920, 1080]); assert.equal(native.renderer.width, 1920); assert.equal(native.renderer.height, 1080);
  assert.equal(native.cpuVideoCopies, 0); assert.equal(native.compositor.lost, false);
  assert.equal(await page.locator('#ccExportResolution').inputValue(), 'source');
  check('native 1920×1080 source, WebGL, composition and default export dimensions are preserved');
  await page.locator('[data-add-mark="rectangle"]').click();
  await field('ann', 'end', 1); await field('ann', 'start', .2); await field('ann', 'color', '#ff0000');
  await field('ann', 'lineWidth', 20); await field('ann', 'x', .1); await field('ann', 'y', .1); await field('ann', 'x2', .35); await field('ann', 'y2', .35);
  await page.locator('[data-ann-field="effect"]').selectOption('fade'); await field('ann', 'fadeIn', .2); await field('ann', 'fadeOut', .2);
  // Exercise every add path, retaining only the rectangle used by the pixel oracle.
  for (const type of ['text', 'arrow', 'circle']) { await page.locator(`[data-add-mark="${type}"]`).click(); assert.equal((await state()).annotations.at(-1).type, type); await page.locator('[data-delete-mark]').click(); }
  await page.locator('[data-add-cue]').click(); await field('cue', 'end', 1); await field('cue', 'start', .2);
  await page.locator('[data-cue-field="inMode"]').selectOption('fade'); await page.locator('[data-cue-field="outMode"]').selectOption('fade');
  await field('cue', 'fadeIn', .2); await field('cue', 'fadeOut', .2);
  await seek(0); const off = await page.evaluate(() => ({ pixel: window.__workflow.sample(.1, .2), cyanPixel: window.__workflow.sample(.6465, .7604), orangePixel: window.__workflow.sample(.4023, .6736), counts: window.__workflow.pixels(), models: window.__workflow.snapshot().modelStates }));
  await seek(.3); const half = await page.evaluate(() => ({ pixel: window.__workflow.sample(.1, .2), cyanPixel: window.__workflow.sample(.6465, .7604), orangePixel: window.__workflow.sample(.4023, .6736), counts: window.__workflow.pixels(), models: window.__workflow.snapshot().modelStates }));
  await seek(.6); const on = await page.evaluate(() => ({ pixel: window.__workflow.sample(.1, .2), cyanPixel: window.__workflow.sample(.6465, .7604), orangePixel: window.__workflow.sample(.4023, .6736), counts: window.__workflow.pixels(), models: window.__workflow.snapshot().modelStates }));
  await page.screenshot({ path: path.join(output, 'native-full-model-state.png') });
  await seek(1.1); const gone = await page.evaluate(() => ({ pixel: window.__workflow.sample(.1, .2), cyanPixel: window.__workflow.sample(.6465, .7604), orangePixel: window.__workflow.sample(.4023, .6736), counts: window.__workflow.pixels(), models: window.__workflow.snapshot().modelStates }));
  timeline = { off, half, on, gone };
  assert.ok(off.pixel[0] < 80 && gone.pixel[0] < 80); assert.ok(half.pixel[0] > 100 && half.pixel[0] < 210); assert.ok(on.pixel[0] > 245 && on.pixel[1] < 10);
  assert.equal(off.counts.cyan, 0); assert.equal(gone.counts.cyan, 0); assert.ok(on.counts.cyan > 400); assert.ok(on.cyanPixel[1] > 240 && on.cyanPixel[2] > 240); assert.ok(half.cyanPixel[1] > 100 && half.cyanPixel[1] < on.cyanPixel[1]);
  on.cyanPixel.slice(0, 3).forEach((value, index) => assert.ok(Math.abs(value - nativePixels.cyan[index]) <= 2, 'full-opacity cue must preserve original cyan material'));
  on.orangePixel.slice(0, 3).forEach((value, index) => assert.ok(Math.abs(value - nativePixels.orange[index]) <= 3, 'full-opacity cue must preserve original orange material'));
  check('annotation and model visibility follow actual decoded media time, including fade-in, full opacity and disappearance', { off, half, on, gone });
  await page.locator('#ccSchemeName').fill('原清晰度 · 标注与展示'); await page.locator('#ccSave').click();
  await page.waitForFunction(() => { const saved = window.__workflow.snapshot().saved; return saved?.settings.annotations?.length === 1 && saved.settings.effects?.length === 1; });
  const saved = (await state()).saved.settings;
  await page.locator('#ccStop').click(); await page.waitForFunction(() => !window.__workflow.snapshot().active);
  await page.evaluate(() => window.__workflow.restoreSaved()); await page.locator('#ccStart').click();
  await page.waitForFunction(() => { const s = window.__workflow.snapshot(); return s.active && s.presentedTime !== null && !s.buffering; });
  assert.deepEqual((await state()).annotations, saved.annotations); assert.deepEqual((await state()).effects, saved.effects);
  assert.equal(await page.locator('[data-ann-field="effect"]').inputValue(), 'fade');
  check('saved scheme reopens with exact annotation coordinates, time spans and model fade settings');
  await page.locator('#ccExport').evaluate(button => { button.closest('details').open = true; });
  await page.locator('#ccExportStart').fill('0'); await page.locator('#ccExportEnd').fill('1.2'); await page.locator('#ccExportFrameRate').selectOption('25');
  await page.locator('#ccBuildPreview').click();
  await page.waitForFunction(() => window.__workflow.snapshot().dimensions.cached?.[0] === 1920, null, { timeout: 180000 });
  const cachedState = await state(); assert.deepEqual(cachedState.dimensions.cached, [1920, 1080]); assert.equal(cachedState.renderer.useDefaultRenderLoop, false); assert.equal(cachedState.paused, true); assert.equal(cachedState.pendingCallbacks, 0); assert.equal(cachedState.cpuVideoCopies, 0);
  const previewFile = path.join(output, 'native-timed-presentation.webm');
  await writeFile(previewFile, Buffer.from(await page.evaluate(() => window.__workflow.cachedBlob())));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', previewFile], { encoding: 'utf8' }));
  const stream = probe.streams.find(stream => stream.codec_type === 'video'); assert.equal(stream.width, 1920); assert.equal(stream.height, 1080); assert.equal(Number(stream.nb_read_frames), 30);
  const pts = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', previewFile], { encoding: 'utf8' })).frames.map(frame => Number(frame.best_effort_timestamp_time));
  pts.slice(1).forEach((time, index) => assert.ok(Math.abs(time - pts[index] - .04) < .0011));
  const bakedOff = decodedPixels(previewFile, .04), bakedOn = decodedPixels(previewFile, .6), bakedGone = decodedPixels(previewFile, 1.12);
  assert.equal(bakedOff.red, 0); assert.equal(bakedGone.red, 0); assert.equal(bakedOff.cyan, 0); assert.equal(bakedGone.cyan, 0); assert.ok(bakedOn.red > 1000 && bakedOn.cyan > 400);
  check('continuous preview bakes timed annotations and model effects into all 30 native 1080p frames at fixed 25 fps', { file: previewFile, bakedOff, bakedOn, bakedGone });
  await page.locator('[data-cc-play]').click(); await page.waitForFunction(() => window.__workflow.snapshot().dimensions.cachedTime > .2);
  const playing = await state(); assert.equal(playing.renderer.useDefaultRenderLoop, false); assert.equal(playing.paused, true); assert.equal(playing.dimensions.cachedPaused, false); assert.equal(playing.pendingCallbacks, 0);
  check('cached movie plays while Cesium render loop and source decoding remain paused');
  await page.locator('#ccStop').click(); await page.waitForFunction(() => !window.__workflow.snapshot().active);
  await page.evaluate(() => window.__workflow.waitOutsideFrames(3));
  const exited = await state(); assert.equal(exited.dimensions.cachedDom, 0); assert.equal(exited.dimensions.editorDom, 0); assert.equal(exited.presentationDom, 0); assert.equal(exited.pendingCallbacks, 0); assert.equal(exited.mediaSrc, null);
  assert.equal(exited.compositor, null); assert.ok(exited.released.length > 0 && exited.released.every(item => item.disposed && item.width === 0 && item.height === 0));
  assert.deepEqual(exited.lifecycle, baseline.lifecycle); assert.deepEqual(exited.geometry, baseline.geometry);
  for (const key of ['resolutionScale', 'useDefaultRenderLoop', 'requestRenderMode', 'maximumRenderTimeChange', 'shadows', 'highDynamicRange', 'cameraInputs', 'width', 'height']) assert.equal(exited.renderer[key], baseline.renderer[key], `exit renderer ${key} must restore`);
  check('exit releases both decoders, cached movie, native canvases, callbacks and added Cesium listeners, and restores normal map rendering');
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(exited.renderErrors, []);
  report = { pass: true, checks, browserErrors: errors, consoleErrors, final: exited };
} catch (error) {
  report = { pass: false, checks, timeline, error: String(error.stack || error), browserErrors: errors, consoleErrors, final: await state().catch(() => null) };
  await page.screenshot({ path: path.join(output, 'video-overlay-presentation-failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'video-overlay-presentation-report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await server?.close();
}
console.log(JSON.stringify({ pass: report.pass, checks: checks.length, report: path.join(output, 'video-overlay-presentation-report.json'), error: report.error }, null, 2));
if (!report.pass) process.exitCode = 1;
