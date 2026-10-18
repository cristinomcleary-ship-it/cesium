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
const xml = `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84 3D</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><Name>Synthetic browser verification</Name><SRSId>0</SRSId><Photogroups><Photogroup><Name>640x360 synthetic camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew><Distortion><K1>0</K1><K2>0</K2><K3>0</K3><P1>0</P1><P2>0</P2></Distortion>${[0, 1, 2].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`;
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
const record = (name, details) => { checks.push({ name, pass: true, ...details }); process.stdout.write(`PASS ${name}\n`); };
async function seek(time) {
  await page.locator('[data-cc-seek]').evaluate((element, value) => { element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await page.waitForFunction(target => {
    const h = window.__ccOverlayHarness, s = h.snapshot();
    if (s.mediaTime === null || Math.abs(s.mediaTime - target) > .03) return false;
    if (target > 4) return !s.modelShow && /没有空三/.test(s.badge);
    const expected = h.expected(target);
    return s.modelShow && Math.hypot(...s.position.map((value, index) => value - expected[index])) < .1;
  }, time, { timeout: 25000 });
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
  report = { pass: true, checks, browserErrors, consoleErrors, final, screenshots: ['cc-overlay-visible.png', 'cc-overlay-outside-coverage.png', 'cc-overlay-main-page.png'] };
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
