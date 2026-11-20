#!/usr/bin/env node
/** Real 3D Tiles / Model WebGL regression with synthetic assets and coordinates.
 * START_VITE=1 starts an isolated service. --engineering runs the independent
 * model-role checks without the separate photogrammetry refinement sequence.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5173';
const tileRequestTimeout = Number(process.env.CC_OCCLUSION_TILE_REQUEST_TIMEOUT_MS ?? 5000);
assert.ok(Number.isSafeInteger(tileRequestTimeout) && tileRequestTimeout > 0 && tileRequestTimeout <= 60000,
  'CC_OCCLUSION_TILE_REQUEST_TIMEOUT_MS must be within 1–60000');
const work = await mkdtemp(path.join(os.tmpdir(), 'cc-occlusion-')), output = process.env.OUTPUT_DIR || work;
const dataRoots = [];
if (process.env.START_VITE === '1') {
  for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR', 'CESIUM_TEMPORARY_WORKS_ASSETS_DIR']) {
    const root = path.join(work, key.toLowerCase());
    await mkdir(root);
    process.env[key] = root;
    dataRoots.push(root);
  }
  delete process.env.CESIUM_STRUCTURE_LIBRARY_DIR;
}
const server = process.env.START_VITE === '1' ? await (await import('vite')).createServer({ server: {
  host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port) || 5173, strictPort: true, hmr: false, watch: null } }) : undefined;
await server?.listen();
await mkdir(output, { recursive: true });
const videoPath = path.join(work, 'synthetic-flight.mp4'), xmlPath = path.join(work, 'synthetic-camera.xml');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1b242c:s=640x360:r=30:d=9', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
const photo = i => `<Photo><Id>${i}</Id><ImagePath>frame_${i}.jpg</ImagePath><Component>1</Component><Pose><Center><x>${i < 3 ? 120 : 120.003109}</x><y>30</y><z>${i === 0 ? 200 : 80}</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
await writeFile(xmlPath, `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><SRSId>0</SRSId><Photogroups><Photogroup><Name>Synthetic nadir camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew><Distortion><K1>0.025</K1><K2>-0.067</K2><K3>0.108</K3><P1>0.00062</P1><P2>0.0000566</P2></Distortion>${[0, 1, 2, 3, 4].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`);
let executablePath = process.env.BROWSER_EXECUTABLE, args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
if (process.env.CHROMIUM_MODULE) {
  const modulePath = process.env.CHROMIUM_MODULE, manifest = JSON.parse(await readFile(path.join(modulePath, 'package.json'), 'utf8'));
  const packaged = (await import(pathToFileURL(path.resolve(modulePath, manifest.main || manifest.exports?.['.']?.default || 'build/index.js')).href)).default;
  executablePath ||= await packaged.executablePath(); args = [...packaged.args, '--enable-unsafe-swiftshader'];
}
const browser = await chromium.launch({ headless: true, executablePath, args }), page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(20000);
const errors = [], consoleErrors = [], expectedNetworkErrors = [], checks = [];
let expectDetail404 = false;
page.on('pageerror', e => errors.push(String(e.stack || e))); page.on('console', m => {
  if (m.type() !== 'error') return;
  if (expectDetail404 && /404/.test(m.text())) expectedNetworkErrors.push(m.text()); else consoleErrors.push(m.text());
});
const state = () => page.evaluate(() => window.__occlusion.snapshot()), pixels = () => page.evaluate(() => window.__occlusion.pixels());
const record = (name, details = {}) => { checks.push({ name, pass: true, ...details }); console.log(`PASS ${name}`); };
const pendingContent = new Map(); let report, refinementEvidence;
await page.route('**/__occlusion-fixture__/*.gltf', route => { pendingContent.set(path.basename(new URL(route.request().url()).pathname, '.gltf'), route); });
const wait = fn => page.waitForFunction(fn);
const unchanged = (current, baseline) => { assert.deepEqual(current.matrices, baseline.matrices); assert.deepEqual(current.cad, baseline.cad); assert.deepEqual(current.tilesMatrix, baseline.tilesMatrix); };
const waitForRequest = async name => {
  const deadline = Date.now() + tileRequestTimeout;
  while (Date.now() < deadline && !pendingContent.has(name)) await page.waitForTimeout(50);
  assert.ok(pendingContent.has(name), `real ${name} tile request must be in flight`);
  return pendingContent.get(name);
};
const fulfill = async name => (await waitForRequest(name)).fulfill({ status: 200, contentType: 'model/gltf+json', body: await page.evaluate(() => window.__occlusion.planeGltf()) });
const seek = async time => {
  await page.locator('[data-cc-seek]').evaluate((input, time) => { input.value = String(time); input.dispatchEvent(new Event('input', { bubbles: true })); }, time);
  await page.waitForFunction(time => { const video = document.querySelector('.cc-video-backdrop video'); return video && !video.seeking && Math.abs(video.currentTime - time) < .02; }, time);
};
const assertProtected = (p, label) => { assert.equal(p.orange, 0, `${label}: opaque underground`); assert.equal(p.green, 0, `${label}: translucent underground`); assert.equal(p.magenta, 0, `${label}: source color`); assert.ok(p.cyan > 50 && p.yellow > 50 && p.white > 20, `${label}: above-ground/CAD disappeared: ${JSON.stringify(p)}`); };
const engineeringOnly = process.argv.includes('--engineering');
async function verifyEngineeringOcclusion(baseline) {
  await page.locator('#ccStart').click();
  await wait(() => window.__occlusion.snapshot().active);
  await wait(() => { const p = window.__occlusion.pixels(); return p.orange > 50 && p.green > 50; });
  const capControl = page.locator('[data-cc-engineering-occlusion="engineering-cap"]');
  const capVisibility = page.locator('[data-cc-resource="engineering-cap"]');
  assert.equal(await capVisibility.isChecked(), false);
  await capControl.selectOption('on');
  await wait(() => { const p = window.__occlusion.pixels(); return p.orange === 0 && p.green === 0 && p.cyan > 50; });
  const engineeringMasked = await pixels();
  assertProtected(engineeringMasked, 'engineering cap enabled');
  assert.equal(engineeringMasked.blue, 0, 'A depth-only engineering cap wrote its visible color');
  assert.equal(engineeringMasked.dirtyTransparent, 0);
  assert.equal(engineeringMasked.glError, 0);
  assert.equal(await capVisibility.isChecked(), false);
  await capControl.selectOption('off');
  await wait(() => { const p = window.__occlusion.pixels(); return p.orange > 50 && p.green > 50; });
  const engineeringUnmasked = await pixels();
  assert.equal(engineeringUnmasked.blue, 0);
  assert.equal((await state()).active, true);
  unchanged(await state(), baseline);
  record('deselected engineering GLB writes only depth when enabled; disabling restores opaque and translucent models live', {
    masked: engineeringMasked, unmasked: engineeringUnmasked });
  await capVisibility.check();
  await wait(() => { const p = window.__occlusion.presentationPixels(); return p.blue > 50 && p.orange > 50; });
  const engineeringColorOnly = await page.evaluate(() => window.__occlusion.presentationPixels());
  assert.equal(engineeringColorOnly.glError, 0);
  await capControl.selectOption('on');
  await wait(() => { const p = window.__occlusion.presentationPixels(); return p.blue > 50 && p.orange === 0 && p.green === 0; });
  const engineeringVisibleOccluder = await page.evaluate(() => window.__occlusion.presentationPixels());
  assert.equal(engineeringVisibleOccluder.glError, 0);
  assert.equal(await capVisibility.isChecked(), true);
  record('selected engineering model keeps its color while the depth choice independently determines whether other models are covered', {
    selectedColorOnly: engineeringColorOnly, selectedWithDepth: engineeringVisibleOccluder });
  await capVisibility.uncheck();
  await capControl.selectOption('on');
  await page.locator('#ccSave').click();
  await wait(() => window.__occlusion.snapshot().saved?.engineeringOcclusion?.['engineering-cap'] === true);
  await page.locator('#ccStop').click();
  assert.deepEqual((await state()).engineeringCap, { show: true, hasShader: false });
  await page.evaluate(() => window.__occlusion.restoreSaved());
  assert.equal(await capControl.inputValue(), 'on');
  assert.equal(await capVisibility.isChecked(), false);
  await page.locator('#ccStart').click();
  await wait(() => window.__occlusion.snapshot().active);
  await wait(() => { const p = window.__occlusion.pixels(); return p.orange === 0 && p.green === 0 && p.cyan > 50; });
  assertProtected(await pixels(), 'engineering cap reopened');
  await page.locator('#ccStop').click();
  assert.deepEqual((await state()).engineeringCap, { show: true, hasShader: false });
  unchanged(await state(), baseline);
  record('saved engineering occlusion override reopens independently and releases the original model state at exit');
  await capControl.selectOption('default');
}

try {
  await page.goto(`${baseUrl}/tools/fixtures/cc-video-occlusion.html`, { waitUntil: 'networkidle' });
  await wait(() => window.__occlusion?.snapshot().modelReady);
  const baseline = await page.evaluate(() => window.__occlusion.baseline);
  for (const id of ['engineering-cap', 'remote-engineering-cap']) await page.locator(`[data-cc-resource="${id}"]`).uncheck();
  await page.locator('#ccVideoFile').setInputFiles(videoPath); await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  await page.locator('#ccInterval').fill('2'); await page.locator('#ccOpacity').fill('1'); await page.locator('#ccOpacity').dispatchEvent('input');
  await page.locator('#ccStart').click(); await wait(() => window.__occlusion.snapshot().active);
  await wait(() => { const p = window.__occlusion.pixels(); return p.orange > 50 && p.green > 50 && p.cyan > 50 && p.yellow > 50; });
  const without = await pixels(); unchanged(await state(), baseline);
  record('opaque and translucent engineering components above and below ground are visible without occlusion', { pixels: without });
  await page.locator('#ccStop').click();
  await verifyEngineeringOcclusion(baseline);
  if (!engineeringOnly) {
    await page.locator('#ccOcclusionEnabled').evaluate(el => { const details = el.closest('details'); if (details) details.open = true; });
    // Select the same tile as an ordinary overlay too: its occluder role wins.
    await page.locator('[data-cc-resource="ground"]').check();
    await page.locator('#ccOcclusionSource').selectOption('ground'); await page.locator('#ccOcclusionEnabled').check();
    await page.locator('#ccStart').click(); await wait(() => window.__occlusion.snapshot().active);
    await waitForRequest('parent');
    const loading = await pixels(); assert.equal(loading.transparent, loading.total); assert.equal(loading.dirtyTransparent, 0);
    record('pending real surface content suppresses all overlays instead of exposing underground geometry', { pixels: loading });
    await fulfill('parent');
    await wait(() => { const s = window.__occlusion.snapshot(), p = window.__occlusion.pixels(); return s.contentReady && s.tilesLoaded && p.cyan > 50 && p.yellow > 50; });
    const occluded = await pixels();
    assert.equal(occluded.orange, 0); assert.equal(occluded.green, 0); assert.equal(occluded.magenta, 0);
    assert.ok(occluded.cyan > 50 && occluded.yellow > 50 && occluded.white > 20); assert.equal(occluded.glError, 0); assert.equal(occluded.dirtyTransparent, 0);
    unchanged(await state(), baseline);
    record('actual 3D Tiles MASK surface hides opaque and translucent underground models through Brown lens without drawing surface color', { pixels: occluded });
    assert.equal(pendingContent.has('detail'), false, 'initial camera must select only the coarse parent');
    // Move via decoded video frames. Refinement starts while the video is playing,
    // and the outstanding detail request must not blank the loaded parent coverage.
    await page.locator('[data-cc-speed]').selectOption('0.5');
    await page.locator('[data-cc-play]').click();
    await waitForRequest('detail');
    const refinement = await page.evaluate(() => window.__occlusion.capturePlaybackFrames(8));
    refinementEvidence = refinement;
    assert.ok(refinement.some(sample => !sample.tilesLoaded), 'refinement must genuinely be pending');
    assert.ok(refinement.at(-1).time > refinement[0].time, 'video must continue playing during the samples');
    for (const sample of refinement) {
      assert.ok(sample.time < 4 && Math.abs(sample.local[0]) < .25 && Math.abs(sample.local[1]) < .25, 'LOD samples must remain over A, before the move to B');
      assert.ok(sample.selected.some(url => url?.endsWith('/parent.gltf'))); assertProtected(sample.pixels, `pending t=${sample.time}`);
    }
    record('playing camera retains above-ground models and CAD while the loaded REPLACE parent occludes through pending detail requests');
    expectDetail404 = true;
    await pendingContent.get('detail').fulfill({ status: 404, contentType: 'text/plain', body: 'Intentional missing synthetic LOD detail' });
    await wait(() => { const s = window.__occlusion.snapshot(); return s.detailFailed && s.failedTileUrls.some(url => url.endsWith('/detail.gltf')); });
    const failedDetail = await pixels(); assertProtected(failedDetail, 'failed detail with parent fallback');
    assert.ok((await state()).selectedContents.some(url => url?.endsWith('/parent.gltf')));
    record('a failed optional detail tile preserves loaded parent occlusion without hiding the engineering overlays', { pixels: failedDetail });
    await seek(6); await waitForRequest('remote');
    const remoteLoading = await pixels(); assert.equal(remoteLoading.transparent, remoteLoading.total); assert.equal(remoteLoading.dirtyTransparent, 0);
    assert.equal((await state()).remoteReady, false);
    record('jump to a wholly unloaded region hides overlays even though a different region remains cached', { pixels: remoteLoading });
    await fulfill('remote');
    await wait(() => window.__occlusion.snapshot().remoteReady && window.__occlusion.pixels().cyan > 50);
    assertProtected(await pixels(), 'remote region loaded'); unchanged(await state(), baseline);
    record('new region recovers visible above-ground geometry only after its real surface arrives');
    await page.screenshot({ path: path.join(output, 'cc-occlusion-visible.png') });
    await page.locator('#ccSave').click(); await wait(() => !!window.__occlusion.snapshot().saved);
    assert.deepEqual((await state()).saved.occlusion, { enabled: true, sourceId: 'ground' });
    await page.locator('#ccStop').click();
    const exited = await state(); assert.equal(exited.shaderRestored, true); assert.equal(exited.styleRestored, true); assert.equal(exited.sourceShow, false); unchanged(exited, baseline);
    await page.evaluate(() => window.__occlusion.restoreSaved());
    await page.locator('#ccStart').click(); await wait(() => window.__occlusion.snapshot().active);
    await wait(() => window.__occlusion.pixels().cyan > 50);
    const reopened = await pixels(); assert.equal(reopened.orange, 0); assert.equal(reopened.green, 0); assert.equal(reopened.magenta, 0); assert.ok(reopened.yellow > 50);
    unchanged(await state(), baseline);
    await page.locator('#ccStop').click();
    assert.equal((await state()).shaderRestored, true); assert.equal((await state()).styleRestored, true);
    record('save and restore retain occluder selection, preserve all model/CAD positioning and restore original surface shader/style on exit');
    await page.evaluate(() => window.__occlusion.revoke());
    await page.locator('#ccStart').click();
    await wait(() => window.__occlusion.snapshot().messages.some(m => m.error));
    assert.equal((await state()).active, false); assert.equal((await state()).sourceShow, false);
    record('revoked or unavailable surface source blocks fusion instead of silently removing occlusion');
  }
  const final = await state(); assert.deepEqual(final.renderErrors, []); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  report = { pass: true, checks, final, refinementEvidence, browserErrors: errors, consoleErrors, expectedNetworkErrors };
} catch (error) {
  report = { pass: false, checks, error: String(error.stack || error), final: await state().catch(() => null),
    currentPixels: await pixels().catch(() => null), presentationPixels: await page.evaluate(() => window.__occlusion.presentationPixels()).catch(() => null),
    refinementEvidence, browserErrors: errors, consoleErrors, expectedNetworkErrors };
  await page.screenshot({ path: path.join(output, 'cc-occlusion-failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'cc-occlusion-browser-report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await server?.close();
  await Promise.all(dataRoots.map(root => rm(root, { recursive: true, force: true })));
}
console.log(JSON.stringify({ pass: report.pass, checks: checks.length, report: path.join(output, 'cc-occlusion-browser-report.json'), error: report.error }, null, 2));
if (!report.pass) process.exitCode = 1;
