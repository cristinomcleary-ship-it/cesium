#!/usr/bin/env node
/**
 * Real WebGL / browser regression of VideoModelOverlay. Start Vite separately.
 * BASE_URL=http://127.0.0.1:5173 PLAYWRIGHT_MODULE=/absolute/path/to/playwright
 * Optional: BROWSER_EXECUTABLE or CHROMIUM_MODULE (@sparticuz/chromium),
 * START_VITE=1 (same-process Vite for isolated loopback environments), OUTPUT_DIR,
 * CC_XML_PATH (read-only DOM parse of an operator-supplied CC XML).
 * All video and geographic test data are synthetic and generated in a temp dir.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
const { chromium } = require(playwrightPath);
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5173';
const viteServer = process.env.START_VITE === '1' ? await (await import('vite')).createServer({
  server: { host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port) || 5173, strictPort: true, hmr: false, watch: null },
}) : undefined;
await viteServer?.listen();
const work = await mkdtemp(path.join(os.tmpdir(), 'cc-overlay-browser-'));
const output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const videoPath = path.join(work, 'synthetic-flight.mp4'), xmlPath = path.join(work, 'synthetic-cc.xml');
execFileSync(process.env.FFMPEG_EXECUTABLE || 'ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1b242c:s=640x360:r=30:d=6',
  '-vf', 'drawgrid=w=80:h=60:t=1:c=0x75818b@0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath,
]);
const photo = index => `<Photo><Id>${index}</Id><ImagePath>synthetic_frame_${String(index).padStart(6, '0')}.jpg</ImagePath><Component>1</Component><Pose><Center><x>${120 + index * .0001}</x><y>30</y><z>120</z></Center><Rotation><Yaw>0</Yaw><Pitch>-45</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
const privateContentMarker = 'synthetic-private-original-content-must-not-appear';
const xml = `<?xml version="1.0"?><!-- ${privateContentMarker} --><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84 3D</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><Name>Synthetic browser verification</Name><SRSId>0</SRSId><Photogroups><Photogroup><Name>640x360 synthetic camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew><Distortion><K1>0</K1><K2>0</K2><K3>0</K3><P1>0</P1><P2>0</P2></Distortion>${[0, 1, 2].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`;
await writeFile(xmlPath, xml);

let launchArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
let executablePath = process.env.BROWSER_EXECUTABLE;
if (process.env.CHROMIUM_MODULE) {
  let modulePath = process.env.CHROMIUM_MODULE;
  if (path.isAbsolute(modulePath) && !/\.[mc]?js$/.test(modulePath)) {
    const manifest = JSON.parse(await readFile(path.join(modulePath, 'package.json'), 'utf8'));
    modulePath = path.resolve(modulePath, manifest.main || manifest.exports?.['.']?.default || 'index.js');
  }
  const imported = path.isAbsolute(modulePath) ? await import(pathToFileURL(modulePath).href) : require(modulePath), packaged = imported.default || imported;
  executablePath ||= await packaged.executablePath();
  launchArgs = [...packaged.args, '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: launchArgs });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(25000);
const browserErrors = [], consoleErrors = [], checks = [];
page.on('pageerror', error => browserErrors.push(String(error.stack || error)));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const state = () => page.evaluate(() => window.__ccOverlayHarness.snapshot());
const wait = async fn => page.waitForFunction(fn, undefined, { timeout: 25000 });
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
const approx = (value, expected, tolerance = 1e-5) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} != ${expected}`);
const xyz = point => [point.x, point.y, point.z];
const sameNumbers = (actual, expected, tolerance = 1e-7) => {
  assert.equal(actual.length, expected.length); actual.forEach((value, index) => approx(value, expected[index], tolerance));
};
const record = (name, details) => { checks.push({ name, pass: true, ...details }); process.stdout.write(`PASS ${name}\n`); };
async function seek(time, correctionMatrix = null) {
  await page.locator('[data-cc-seek]').evaluate((element, value) => { element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await waitForSeek(time, correctionMatrix);
}
async function waitForSeek(time, correctionMatrix = null) {
  await page.waitForFunction(({ target, matrix }) => {
    const h = window.__ccOverlayHarness, s = h.snapshot();
    if (s.mediaTime === null || Math.abs(s.mediaTime - target) > .03) return false;
    if (target > 4) return !s.modelShow && /没有空三/.test(s.badge);
    let expected = h.expected(target);
    if (matrix) expected = [0, 1, 2].map(row => matrix[row] * expected[0] + matrix[4 + row] * expected[1] + matrix[8 + row] * expected[2] + matrix[12 + row]);
    return s.modelShow && Math.hypot(...s.position.map((value, index) => value - expected[index])) < .1;
  }, { target: time, matrix: correctionMatrix }, { timeout: 25000 });
}
let report;
try {
  await page.goto(`${baseUrl}/tools/fixtures/cc-video-overlay.html`, { waitUntil: 'networkidle', timeout: 60000 });
  await wait(() => !!window.__ccOverlayHarness);
  const initial = await page.evaluate(() => window.__ccOverlayHarness.initial);
  const parsed = await page.evaluate(source => window.__ccOverlayHarness.parseXml(source), xml);
  assert.equal(parsed.photos, 3); assert.equal(parsed.width, 640); assert.equal(parsed.height, 360);
  record('real browser DOM parses synthetic CC XML', { photos: parsed.photos });
  if (process.env.CC_XML_PATH) {
    const supplied = await page.evaluate(source => window.__ccOverlayHarness.parseXml(source), await readFile(process.env.CC_XML_PATH, 'utf8'));
    record('operator-supplied CC XML parses in browser DOM', { photos: supplied.photos, width: supplied.width, height: supplied.height });
  }
  await page.locator('#ccVideoFile').setInputFiles(videoPath);
  await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  await page.locator('#ccInterval').fill('2');
  await page.locator('#ccHeightReference').selectOption('ellipsoid');
  await page.locator('#ccStart').click();
  await wait(() => window.__ccOverlayHarness.snapshot().active && !!document.querySelector('[data-cc-seek]'));
  await wait(() => { const s = window.__ccOverlayHarness.pixelStats(); return s.orange > 100 && s.cyan > 50; });
  const pixels = await page.evaluate(() => window.__ccOverlayHarness.pixelStats());
  assert.equal(pixels.glError, 0); assert.ok(pixels.transparent > pixels.total * .5);
  const started = await state();
  assert.equal(started.modelType, 'Model'); assert.equal(started.modelScale, 2.5); assert.equal(started.minimumPixelSize, 0);
  assert.equal(started.globe, false); assert.equal(started.inputs, false); assert.equal(started.extraShow, false); assert.equal(started.gisShow, false);
  assert.ok(Number.isFinite(started.frustum.left) && Number.isFinite(started.frustum.right));
  await page.screenshot({ path: path.join(output, 'cc-overlay-visible.png'), fullPage: true });
  record('video backdrop + actual Cesium box and CAD pixels + transparent background', { pixels });
  await page.locator('#ccOpacity').evaluate(element => { element.value = '0'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(() => { const p = window.__ccOverlayHarness.pixelStats(); return p.transparent === p.total; });
  await page.locator('#ccOpacity').evaluate(element => { element.value = '0.8'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(() => window.__ccOverlayHarness.pixelStats().orange > 100);
  record('zero overlay opacity makes the entire Cesium canvas transparent');

  const playStart = started.position;
  await page.locator('[data-cc-play]').click();
  await wait(() => window.__ccOverlayHarness.snapshot().mediaTime > .8);
  await page.locator('[data-cc-play]').click();
  const played = await state();
  assert.ok(distance(played.position, playStart) > 1, 'camera must move during actual video decode');
  record('decoded video playback continuously drives camera', { mediaTime: played.mediaTime, cameraTravelMeters: distance(played.position, playStart) });
  await seek(2);
  const atKey = await state();
  const expectedKey = await page.evaluate(() => window.__ccOverlayHarness.expected(2));
  assert.ok(distance(atKey.position, expectedKey) < .1);
  await seek(1);
  const atInterpolated = await state();
  assert.match(atInterpolated.badge, /关键帧间估计/);
  record('seek updates exact keyframe and interpolated camera');
  for (const time of [2, 1, 2, 0, 3.5, 1]) await seek(time);
  await page.locator('[data-cc-seek]').evaluate(async element => {
    for (const value of [.4, 2.7, .8, 3.2, 1.4]) {
      element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  await waitForSeek(1.4);
  const rapidSeek = await state();
  assert.equal(rapidSeek.paused, true); assert.equal(rapidSeek.videoSeeking, false);
  assert.equal(rapidSeek.modelShow, true); assert.equal(rapidSeek.cadShow, true);
  record('repeated paused seeks and rapid scrub bursts restore visible overlays at the final decoded frame');
  const modelAlignment = [];
  for (const time of [0, 1, 2, 3.5]) {
    await seek(time);
    await wait(() => window.__ccOverlayHarness.modelPixelAlignment().allMatch);
    const alignment = await page.evaluate(() => window.__ccOverlayHarness.modelPixelAlignment());
    assert.equal(alignment.modelScale, 2.5); assert.equal(alignment.minimumPixelSize, 0);
    modelAlignment.push({ time, ...alignment });
  }
  await seek(1);
  record('real GLB with nonzero source origin and scale matches CAD at all 8 corners and multiple camera poses', { modelAlignment });

  await page.locator('#ccEast').fill('5');
  await wait(() => Math.abs(window.__ccOverlayHarness.snapshot().modelDelta[0] - 5) < .001);
  await page.locator('#ccUndo').click();
  await wait(() => Math.abs(window.__ccOverlayHarness.snapshot().modelDelta[0]) < .001);
  await page.locator('#ccRedo').click();
  await wait(() => Math.abs(window.__ccOverlayHarness.snapshot().modelDelta[0] - 5) < .001);
  await page.locator('#ccTarget').selectOption('synthetic-model');
  await page.locator('#ccEast').fill('2'); await page.locator('#ccNorth').fill('3'); await page.locator('#ccUp').fill('4');
  const adjusted = await state();
  adjusted.modelDelta.forEach((value, index) => approx(value, [2, 3, 4][index]));
  record('ENU edits and first-edit undo/redo affect actual geometry');
  await page.locator('#ccSave').click();
  await wait(() => window.__ccOverlayHarness.snapshot().saveCount === 1);
  const saved = await state();
  assert.equal(saved.saved.adjustments['synthetic-model'].east, 2);
  assert.equal(saved.saved.adjustments['synthetic-model'].north, 3);
  assert.equal(saved.saved.adjustments['synthetic-model'].up, 4);
  await page.locator('#ccStop').click();
  const exited = await state();
  assert.equal(exited.active, false); assert.ok(distance(exited.position, initial.position) < 1e-7);
  assert.ok(distance(exited.direction, initial.direction) < 1e-10); assert.ok(distance(exited.up, initial.up) < 1e-10);
  assert.deepEqual(exited.background, initial.background); assert.deepEqual(exited.modelMatrix, initial.modelMatrix);
  for (const key of ['globe', 'fog', 'inputs', 'modelShow', 'cadShow', 'extraShow', 'gisShow']) assert.equal(exited[key], initial[key], key);
  record('exit exactly restores map camera, scene flags, transforms and visibility');

  await page.evaluate(() => window.__ccOverlayHarness.restoreSaved());
  await page.locator('#ccStart').click();
  await wait(() => window.__ccOverlayHarness.snapshot().active && !!document.querySelector('[data-cc-seek]'));
  await seek(1);
  const replay = await state();
  replay.modelDelta.forEach((value, index) => approx(value, [2, 3, 4][index]));
  assert.deepEqual(replay.modelMatrix, adjusted.modelMatrix);
  record('saved plan restores and re-entry does not accumulate offsets');
  await seek(5);
  const outOfRange = await state();
  assert.equal(outOfRange.modelShow, false); assert.equal(outOfRange.cadShow, false);
  await page.screenshot({ path: path.join(output, 'cc-overlay-outside-coverage.png'), fullPage: true });
  await seek(2);
  assert.equal((await state()).modelShow, true);
  record('outside solved time span hides overlay and returns correctly after seek');
  await page.setViewportSize({ width: 1100, height: 760 });
  await wait(() => { const p = window.__ccOverlayHarness.pixelStats(); return p.orange > 50 && p.cyan > 25; });
  const resized = await state();
  assert.ok(Number.isFinite(resized.frustum.left) && Number.isFinite(resized.frustum.right));
  for (const key of ['left', 'right', 'top', 'bottom', 'near']) approx(resized.frustum[key], started.frustum[key], 1e-12);
  record('resize retains calibrated off-center projection and visible geometry');
  await page.locator('[data-cc-exit]').click();
  const final = await state();
  assert.deepEqual(final.modelMatrix, initial.modelMatrix);
  assert.equal(final.renderErrors.length, 0, final.renderErrors.join('\n'));
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  assert.equal(consoleErrors.filter(error => /shader|WebGL|render|DeveloperError/i.test(error)).length, 0, consoleErrors.join('\n'));

  // Independent phase: models were positioned against a translated photogrammetry
  // production, while the imported CC camera still uses the original source frame.
  await page.setViewportSize({ width: 1280, height: 900 });
  const referenceBaseline = await page.evaluate(() => window.__ccOverlayHarness.moveToReferenceFrame());
  await page.locator('#ccVideoFile').setInputFiles(videoPath);
  await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  await page.locator('#ccInterval').fill('2');
  await page.locator('#ccHeightReference').selectOption('ellipsoid');
  assert.equal(await page.locator('#ccSceneReference').inputValue(), '');
  await page.locator('#ccStart').click();
  await wait(() => window.__ccOverlayHarness.snapshot().active);
  await seek(1);
  await wait(() => window.__ccOverlayHarness.modelPixelAlignment().allMatch);
  const unregistered = await page.evaluate(() => window.__ccOverlayHarness.modelPixelAlignment());
  const rawPixels = modelAlignment.find(item => item.time === 1).points;
  const unregisteredErrors = unregistered.points.map((point, index) => Math.hypot(point.x - rawPixels[index].x, point.y - rawPixels[index].y));
  assert.ok(Math.min(...unregisteredErrors) > 10, 'shifted production must visibly disagree with the raw video camera');
  await page.screenshot({ path: path.join(output, 'cc-overlay-reference-unregistered.png'), fullPage: true });
  await page.locator('#ccStop').click();
  await page.locator('#ccSceneReference').evaluate(element => { element.closest('details').open = true; });
  await page.locator('#ccSceneReference').selectOption('synthetic-reference');
  await page.locator('#ccStart').click();
  await wait(() => window.__ccOverlayHarness.snapshot().active);
  const registeredAlignment = [];
  for (const baseline of modelAlignment) {
    await seek(baseline.time);
    await wait(() => window.__ccOverlayHarness.modelPixelAlignment().allMatch);
    const alignment = await page.evaluate(() => window.__ccOverlayHarness.modelPixelAlignment());
    const pixelErrors = alignment.points.map((point, index) => Math.hypot(point.x - baseline.points[index].x, point.y - baseline.points[index].y));
    assert.ok(Math.max(...pixelErrors) < .05, 'registered production must project back onto original-video pixels at every height');
    const current = await state();
    sameNumbers(current.modelMatrix, referenceBaseline.modelMatrix);
    sameNumbers(current.cadFirst, referenceBaseline.cadFirst);
    current.cadCorners.forEach((point, index) => sameNumbers(point, referenceBaseline.cadCorners[index]));
    sameNumbers(current.referenceMatrix, referenceBaseline.referenceMatrix);
    assert.equal(current.referenceShow, false);
    registeredAlignment.push({ time: baseline.time, pixelErrors, allMatch: alignment.allMatch });
  }
  await seek(1);
  await page.screenshot({ path: path.join(output, 'cc-overlay-reference-registered.png'), fullPage: true });
  record('explicit saved production reference registers camera at every GLB/CAD height without editing resource placement', { unregisteredErrors, registeredAlignment });

  const diagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  assert.equal(diagnostic.format, 'cesium-cc-registration-diagnostic'); assert.equal(diagnostic.version, 1);
  assert.equal(diagnostic.referenceError, null); assert.equal(diagnostic.sceneReference.recordId, 'synthetic-reference');
  assert.deepEqual(diagnostic.sceneReference.matrix, referenceBaseline.referenceSavedMatrix);
  assert.equal(diagnostic.xml.photos, 3); assert.equal(diagnostic.video.width, 640); assert.equal(diagnostic.video.height, 360);
  approx(diagnostic.video.renderedTime, 1, .03);
  const registeredExpected = await page.evaluate(() => window.__ccOverlayHarness.expected(1));
  sameNumbers(xyz(diagnostic.registeredCamera.position), registeredExpected);
  sameNumbers(xyz(diagnostic.liveCamera.position), registeredExpected);
  // Independent translation arithmetic: root.transform and a second application of T
  // would both produce an unmistakably different result.
  const m = referenceBaseline.referenceSavedMatrix;
  sameNumbers(xyz(diagnostic.registeredCamera.position), xyz(diagnostic.rawCamera.position).map((value, index) => value + m[12 + index]));
  sameNumbers(xyz(diagnostic.registeredCamera.direction), xyz(diagnostic.rawCamera.direction), 1e-12);
  sameNumbers(xyz(diagnostic.registeredCamera.up), xyz(diagnostic.rawCamera.up), 1e-12);
  const diagnosticModel = diagnostic.resources.find(item => item.id === 'synthetic-model');
  const diagnosticReference = diagnostic.resources.find(item => item.id === 'synthetic-reference');
  sameNumbers(diagnosticModel.savedMatrix, referenceBaseline.modelMatrix);
  sameNumbers(diagnosticModel.displayedMatrix, referenceBaseline.modelMatrix);
  assert.equal(diagnosticModel.scale, 2.5); assert.equal(diagnosticModel.minimumPixelSize, 0);
  assert.deepEqual(diagnosticReference.savedMatrix, referenceBaseline.referenceSavedMatrix);
  sameNumbers(diagnosticReference.displayedMatrix, referenceBaseline.referenceMatrix);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#ccDiagnostics').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'cc-registration-diagnostic.json');
  const diagnosticPath = path.join(output, 'cc-registration-diagnostic.json');
  await download.saveAs(diagnosticPath);
  const diagnosticText = await readFile(diagnosticPath, 'utf8'), downloadedDiagnostic = JSON.parse(diagnosticText);
  assert.equal(downloadedDiagnostic.format, diagnostic.format);
  assert.deepEqual(downloadedDiagnostic.sceneReference, diagnostic.sceneReference);
  for (const forbidden of [privateContentMarker, '<BlocksExchange', '"buffers"', 'data:video', 'data:model', '"files"']) assert.ok(!diagnosticText.includes(forbidden), `diagnostic must exclude original content: ${forbidden}`);
  record('downloaded registration diagnostic reports raw/live cameras and saved/displayed matrices without original file contents');

  await page.locator('#ccSave').click();
  await wait(() => window.__ccOverlayHarness.snapshot().saveCount === 2);
  const referenceSaved = await state();
  assert.deepEqual(referenceSaved.saved.sceneReference, diagnostic.sceneReference);
  await page.locator('#ccStop').click();
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.evaluate(() => window.__ccOverlayHarness.restoreSaved());
    assert.equal(await page.locator('#ccSceneReference').inputValue(), 'synthetic-reference');
    await page.locator('#ccStart').click();
    await wait(() => window.__ccOverlayHarness.snapshot().active);
    await seek(1);
    await wait(() => window.__ccOverlayHarness.modelPixelAlignment().allMatch);
    const current = await state();
    sameNumbers(current.position, registeredExpected);
    sameNumbers(current.modelMatrix, referenceBaseline.modelMatrix);
    sameNumbers(current.cadFirst, referenceBaseline.cadFirst);
    await page.locator('#ccStop').click();
    const restored = await state();
    assert.deepEqual(restored.modelMatrix, referenceBaseline.modelMatrix);
    assert.deepEqual(restored.cadCorners, referenceBaseline.cadCorners);
    assert.equal(restored.referenceShow, true);
  }
  record('saved scene reference survives repeated restore/re-entry without accumulated camera or resource transforms');

  const changedReference = await page.evaluate(() => window.__ccOverlayHarness.changeSavedReference(4, -2, 15));
  assert.notDeepEqual(changedReference.referenceSavedMatrix, referenceSaved.saved.sceneReference.matrix);
  assert.deepEqual(changedReference.saved.sceneReference, referenceSaved.saved.sceneReference, 'saved association must own its matrix snapshot');
  await page.locator('#ccStart').click();
  await wait(() => { const current = window.__ccOverlayHarness.snapshot(); return !current.active && /重新读取成果定位/.test(current.info || ''); });
  const rejectedReference = await state();
  assert.deepEqual(rejectedReference.modelMatrix, referenceBaseline.modelMatrix);
  assert.deepEqual(rejectedReference.cadCorners, referenceBaseline.cadCorners);
  const staleDiagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  assert.match(staleDiagnostic.referenceError, /重新读取成果定位/);
  assert.equal(staleDiagnostic.registeredCamera, null); assert.ok(staleDiagnostic.rawCamera);
  assert.deepEqual(staleDiagnostic.sceneReference, referenceSaved.saved.sceneReference);
  assert.deepEqual(staleDiagnostic.resources.find(item => item.id === 'synthetic-reference').savedMatrix, changedReference.referenceSavedMatrix);
  await page.locator('#ccReferenceUpdate').click();
  await page.locator('#ccStart').click();
  await wait(() => window.__ccOverlayHarness.snapshot().active);
  await seek(1);
  sameNumbers((await state()).modelMatrix, referenceBaseline.modelMatrix);
  await page.locator('#ccStop').click();
  const referenceFinal = await state();
  assert.deepEqual(referenceFinal.modelMatrix, referenceBaseline.modelMatrix);
  assert.deepEqual(referenceFinal.cadCorners, referenceBaseline.cadCorners);
  assert.equal(referenceFinal.renderErrors.length, 0, referenceFinal.renderErrors.join('\n'));
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  record('changed saved reference blocks fusion, remains diagnosable and resumes only after explicit reread');

  // Camera registration is independent of the object offsets and uses a single
  // fixed transform after the selected production's saved world transform.
  await page.evaluate(() => window.__ccOverlayHarness.changeSavedReference(3, -2, 15));
  const cameraResourceBaseline = await page.evaluate(() => window.__ccOverlayHarness.moveToReferenceFrame());
  await page.locator('#ccVideoFile').setInputFiles(videoPath);
  // CC's 4326 export permits the explicit height-correction control exercised
  // below; 4979 correctly rejects a second vertical correction.
  await page.locator('#ccXmlFile').setInputFiles({ name: 'synthetic-camera-registration.xml', mimeType: 'application/xml', buffer: Buffer.from(xml.replace('EPSG:4979', 'EPSG:4326')) });
  await page.locator('#ccInterval').fill('2');
  await page.locator('#ccHeightReference').selectOption('ellipsoid');
  await page.locator('#ccSceneReference').selectOption('synthetic-reference');
  await page.locator('#ccStart').click();
  await wait(() => window.__ccOverlayHarness.snapshot().active);
  await seek(0);
  const firstCameraDiagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  const cameraAnchorSample = firstCameraDiagnostic.registeredCamera;
  const cameraAnchor = firstCameraDiagnostic.cameraRegistration.anchor;
  assert.ok(cameraAnchor, 'prepare must establish the first registered camera as the fixed anchor');
  sameNumbers(xyz(cameraAnchor.position), xyz(cameraAnchorSample.position), 1e-7);
  sameNumbers(Object.values(cameraAnchor.orientation), Object.values(cameraAnchorSample.orientation), 1e-10);
  await seek(1);
  await page.locator('#ccTarget').selectOption('synthetic-cad');
  await page.locator('#ccUp').fill('29');
  const objectAdjustedForCamera = await state();
  const objectAdjustmentDiagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  assert.equal(objectAdjustmentDiagnostic.resources.find(item => item.id === 'synthetic-cad').adjustment.up, 29);
  assert.ok(distance(objectAdjustedForCamera.cadFirst, cameraResourceBaseline.cadFirst) > 28.9);
  const cameraValues = { enabled: true, east: 6, north: -4, up: 8, heading: 3, pitch: -2, roll: 1.5 };
  await page.locator('#ccCameraEnabled').evaluate(element => { const details = element.closest('details'); if (details) details.open = true; });
  const setCameraValues = async values => {
    await page.locator('#ccCameraEnabled').setChecked(values.enabled);
    for (const [key, value] of Object.entries(values)) {
      if (key === 'enabled') continue;
      const id = `ccCamera${key[0].toUpperCase()}${key.slice(1)}`;
      await page.locator(`#${id}`).fill(String(value));
      await page.locator(`#${id}`).dispatchEvent('change');
    }
  };
  const oracleFor = async (sample, values = cameraValues) => page.evaluate(({ sample, anchor, controls }) => window.__ccOverlayHarness.cameraOracle(sample, anchor, controls), { sample, anchor: cameraAnchorSample, controls: values });
  const assertCameraCorrection = async (values = cameraValues, restored = false) => {
    const diag = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
    const expected = await oracleFor(diag.registeredCamera, values), current = await state();
    sameNumbers(diag.cameraRegistration.matrix, expected.matrix, 1e-7);
    sameNumbers(xyz(diag.correctedCamera.position), expected.position, 1e-5);
    sameNumbers(xyz(diag.correctedCamera.direction), expected.direction, 1e-8);
    sameNumbers(xyz(diag.correctedCamera.up), expected.up, 1e-8);
    sameNumbers(current.position, expected.position, 1e-5);
    sameNumbers(current.direction, expected.direction, 1e-8); sameNumbers(current.up, expected.up, 1e-8);
    assert.deepEqual(diag.cameraRegistration.anchor, cameraAnchor);
    assert.deepEqual(diag.correctedCamera.intrinsics, diag.rawCamera.intrinsics);
    assert.deepEqual(diag.correctedCamera.distortion, diag.rawCamera.distortion);
    // Recreating a resource session recomputes its display ENU transform; allow
    // only 10-nanometre roundoff while requiring the library matrix unchanged.
    if (restored) {
      sameNumbers(current.modelMatrix, objectAdjustedForCamera.modelMatrix, 1e-8);
      sameNumbers(current.cadCorners.flat(), objectAdjustedForCamera.cadCorners.flat(), 1e-8);
    } else {
      assert.deepEqual(current.modelMatrix, objectAdjustedForCamera.modelMatrix);
      assert.deepEqual(current.cadCorners, objectAdjustedForCamera.cadCorners);
    }
    assert.deepEqual(current.modelSavedMatrix, cameraResourceBaseline.modelSavedMatrix);
    assert.equal(diag.resources.find(item => item.id === 'synthetic-cad').adjustment.up, 29);
    return { diag, expected, current };
  };
  await setCameraValues(cameraValues);
  const cameraOracle = await oracleFor(objectAdjustmentDiagnostic.registeredCamera);
  await waitForSeek(1, cameraOracle.matrix);
  const pausedCamera = await assertCameraCorrection();
  assert.equal(pausedCamera.current.paused, true); approx(pausedCamera.current.mediaTime, 1, .001);
  assert.ok(distance(pausedCamera.current.position, objectAdjustedForCamera.position) > 5);
  assert.ok(distance(pausedCamera.current.direction, objectAdjustedForCamera.direction) > .01);
  await page.locator('#ccCameraEast').fill('7'); await page.locator('#ccCameraEast').dispatchEvent('change');
  const editedCameraValues = { ...cameraValues, east: 7 };
  const editedCameraOracle = await oracleFor(objectAdjustmentDiagnostic.registeredCamera, editedCameraValues);
  await waitForSeek(1, editedCameraOracle.matrix);
  await assertCameraCorrection(editedCameraValues);
  await setCameraValues(cameraValues);
  await waitForSeek(1, cameraOracle.matrix);
  const cameraPixels = await page.evaluate(() => window.__ccOverlayHarness.pixelStats());
  assert.ok(cameraPixels.orange > 100 && cameraPixels.cyan > 25); assert.equal(cameraPixels.glError, 0);
  record('paused camera ENU and nonzero heading/pitch/roll edits immediately update the live camera without moving objects');

  const correctedSamples = [];
  for (const time of [0, 1, 2, 3.5]) {
    await seek(time, cameraOracle.matrix);
    const checked = await assertCameraCorrection();
    sameNumbers(checked.diag.cameraRegistration.matrix, cameraOracle.matrix, 1e-7);
    correctedSamples.push({ time, original: xyz(checked.diag.registeredCamera.position), corrected: checked.current.position });
  }
  approx(distance(correctedSamples[0].corrected, correctedSamples[3].corrected), distance(correctedSamples[0].original, correctedSamples[3].original), 1e-6);
  await seek(1, cameraOracle.matrix);
  await page.locator('#ccCameraEnabled').uncheck();
  await waitForSeek(1);
  assert.deepEqual((await state()).cameraControls, { ...cameraValues, enabled: false });
  sameNumbers((await state()).position, await page.evaluate(() => window.__ccOverlayHarness.expected(1)));
  await page.locator('#ccCameraEnabled').check();
  await waitForSeek(1, cameraOracle.matrix); await assertCameraCorrection();
  record('whole-trajectory camera correction composes after scene reference and toggles without accumulated transforms', { correctedSamples });

  await page.locator('#ccCameraReset').click();
  await waitForSeek(1);
  const resetCamera = await state(), resetDiagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  assert.deepEqual(resetCamera.cameraControls, { enabled: false, east: 0, north: 0, up: 0, heading: 0, pitch: 0, roll: 0 });
  assert.deepEqual(resetCamera.modelMatrix, objectAdjustedForCamera.modelMatrix);
  assert.deepEqual(resetCamera.cadCorners, objectAdjustedForCamera.cadCorners);
  assert.equal(resetDiagnostic.resources.find(item => item.id === 'synthetic-cad').adjustment.up, 29);
  assert.deepEqual(resetDiagnostic.cameraRegistration.anchor, cameraAnchor);
  record('reset camera correction leaves the existing 29-metre CAD adjustment and model placement intact');

  await setCameraValues(cameraValues);
  await seek(2, cameraOracle.matrix);
  const saveCountBeforeCamera = (await state()).saveCount;
  await page.locator('#ccSave').click();
  await page.waitForFunction(count => window.__ccOverlayHarness.snapshot().saveCount === count, saveCountBeforeCamera + 1);
  const savedCameraState = await state();
  assert.deepEqual(savedCameraState.saved.cameraRegistration.anchor, cameraAnchor);
  for (const [key, value] of Object.entries(cameraValues)) assert.equal(savedCameraState.saved.cameraRegistration[key], value);
  assert.equal(savedCameraState.saved.adjustments['synthetic-cad'].up, 29);
  await page.locator('#ccStop').click();
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.evaluate(() => window.__ccOverlayHarness.restoreSaved());
    assert.deepEqual((await state()).cameraControls, cameraValues);
    await page.locator('#ccStart').click(); await wait(() => window.__ccOverlayHarness.snapshot().active);
    await seek(2, cameraOracle.matrix); await assertCameraCorrection(cameraValues, true);
    await seek(0, cameraOracle.matrix); await assertCameraCorrection(cameraValues, true);
    await page.locator('#ccStop').click();
    const after = await state(); sameNumbers(after.position, initial.position);
    assert.deepEqual(after.modelMatrix, cameraResourceBaseline.modelMatrix);
    assert.deepEqual(after.cadCorners, cameraResourceBaseline.cadCorners);
    assert.deepEqual(after.modelSavedMatrix, cameraResourceBaseline.modelSavedMatrix);
  }
  record('saved camera controls and first-frame anchor survive nonzero-time restore and repeated entry without drift');

  await page.evaluate(() => window.__ccOverlayHarness.restoreSaved());
  await page.locator('#ccFirstTime').fill('0.5');
  await page.locator('#ccHeightReference').selectOption('offset-to-ellipsoid');
  await page.locator('#ccHeightOffset').fill('2');
  const changedTimingDiagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  assert.deepEqual(changedTimingDiagnostic.cameraRegistration.anchor, cameraAnchor);
  sameNumbers(changedTimingDiagnostic.cameraRegistration.matrix, cameraOracle.matrix, 1e-7);
  await page.locator('#ccSceneReference').selectOption('');
  const changedSceneDiagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  assert.deepEqual(changedSceneDiagnostic.cameraRegistration.anchor, cameraAnchor);
  sameNumbers(changedSceneDiagnostic.cameraRegistration.matrix, cameraOracle.matrix, 1e-7);
  record('timing, height and scene-reference changes preserve the explicitly saved camera anchor');

  await page.evaluate(() => window.__ccOverlayHarness.restoreLegacySaved());
  assert.deepEqual((await state()).cameraControls, { enabled: false, east: 0, north: 0, up: 0, heading: 0, pitch: 0, roll: 0 });
  await page.locator('#ccStart').click(); await wait(() => window.__ccOverlayHarness.snapshot().active);
  await seek(2);
  const legacyDiagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  sameNumbers(xyz(legacyDiagnostic.correctedCamera.position), xyz(legacyDiagnostic.registeredCamera.position));
  assert.equal(legacyDiagnostic.resources.find(item => item.id === 'synthetic-cad').adjustment.up, 29);
  await page.locator('#ccStop').click();
  await page.evaluate(() => window.__ccOverlayHarness.restoreSaved());
  await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  const newFileState = await state(), newFileDiagnostic = await page.evaluate(() => window.__ccOverlayHarness.diagnostics());
  assert.deepEqual(newFileState.cameraControls, { enabled: false, east: 0, north: 0, up: 0, heading: 0, pitch: 0, roll: 0 });
  assert.equal(newFileState.referenceSelection, '');
  assert.ok(distance(xyz(newFileDiagnostic.cameraRegistration.anchor.position), xyz(cameraAnchor.position)) > 10, 'new input must establish a fresh raw-frame anchor');
  const cameraFinal = await state();
  assert.equal(cameraFinal.renderErrors.length, 0, cameraFinal.renderErrors.join('\n'));
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  record('legacy plans without camera registration remain compatible and new input clears prior correction');

  const mainPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const mainErrors = [], mainConsoleErrors = [];
  mainPage.on('pageerror', error => mainErrors.push(String(error.stack || error)));
  mainPage.on('console', message => { if (message.type() === 'error') mainConsoleErrors.push(message.text()); });
  // Basemap connectivity is outside this local regression; suppress external tile fetching only.
  await mainPage.route('**/__basemap/**', route => route.abort('blockedbyclient'));
  await mainPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await mainPage.locator('.tab[data-tab="videoar"]').click({ timeout: 30000 });
  await mainPage.locator('.cc-overlay-panel.active #ccVideoFile').waitFor({ state: 'visible', timeout: 30000 });
  await mainPage.locator('.cc-overlay-panel.active #ccStart').waitFor({ state: 'visible' });
  assert.equal(await mainPage.locator('.cc-overlay-panel.active').count(), 1);
  assert.equal(mainErrors.length, 0, mainErrors.join('\n'));
  await mainPage.screenshot({ path: path.join(output, 'cc-overlay-main-page.png'), fullPage: true });
  record('actual main page initializes and opens the new AR panel without JS exceptions', { mainErrors, ignoredBasemapNetworkErrors: mainConsoleErrors.filter(message => /ERR_BLOCKED_BY_CLIENT|basemap|瓦片|底图/.test(message)).length });
  await mainPage.close();
  report = { pass: true, checks, browserErrors, consoleErrors, final, referenceFinal, cameraFinal, screenshots: ['cc-overlay-visible.png', 'cc-overlay-outside-coverage.png', 'cc-overlay-reference-unregistered.png', 'cc-overlay-reference-registered.png', 'cc-overlay-main-page.png'] };
} catch (error) {
  report = { pass: false, error: String(error.stack || error), checks, browserErrors, consoleErrors, diagnostic: await state().catch(() => null), pixels: await page.evaluate(() => window.__ccOverlayHarness?.pixelStats()).catch(() => null) };
  await page.screenshot({ path: path.join(output, 'cc-overlay-failure.png'), fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'cc-overlay-browser-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await viteServer?.close();
}
process.stdout.write(JSON.stringify({ pass: report.pass, checks: checks.length, report: path.join(output, 'cc-overlay-browser-report.json'), ...(report.error ? { error: report.error } : {}) }, null, 2) + '\n');
