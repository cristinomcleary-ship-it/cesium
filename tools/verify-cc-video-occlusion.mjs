#!/usr/bin/env node
/** Real 3D Tiles / Model WebGL regression; all assets and coordinates are synthetic. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5173';
const server = process.env.START_VITE === '1' ? await (await import('vite')).createServer({ server: {
  host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port) || 5173, strictPort: true, hmr: false, watch: null } }) : undefined;
await server?.listen();
const work = await mkdtemp(path.join(os.tmpdir(), 'cc-occlusion-')), output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const videoPath = path.join(work, 'synthetic-flight.mp4'), xmlPath = path.join(work, 'synthetic-camera.xml');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1b242c:s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
const photo = i => `<Photo><Id>${i}</Id><ImagePath>frame_${i}.jpg</ImagePath><Component>1</Component><Pose><Center><x>120</x><y>30</y><z>100</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
await writeFile(xmlPath, `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><SRSId>0</SRSId><Photogroups><Photogroup><Name>Synthetic nadir camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew><Distortion><K1>0.025</K1><K2>-0.067</K2><K3>0.108</K3><P1>0.00062</P1><P2>0.0000566</P2></Distortion>${photo(0)}${photo(1)}</Photogroup></Photogroups></Block></BlocksExchange>`);
let executablePath = process.env.BROWSER_EXECUTABLE, args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
if (process.env.CHROMIUM_MODULE) {
  const modulePath = process.env.CHROMIUM_MODULE, manifest = JSON.parse(await readFile(path.join(modulePath, 'package.json'), 'utf8'));
  const packaged = (await import(pathToFileURL(path.resolve(modulePath, manifest.main || manifest.exports?.['.']?.default || 'build/index.js')).href)).default;
  executablePath ||= await packaged.executablePath(); args = [...packaged.args, '--enable-unsafe-swiftshader'];
}
const browser = await chromium.launch({ headless: true, executablePath, args }), page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(20000);
const errors = [], consoleErrors = [], checks = [];
page.on('pageerror', e => errors.push(String(e.stack || e))); page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const state = () => page.evaluate(() => window.__occlusion.snapshot()), pixels = () => page.evaluate(() => window.__occlusion.pixels());
const record = (name, details = {}) => { checks.push({ name, pass: true, ...details }); console.log(`PASS ${name}`); };
let pendingContent, report;
await page.route('**/__occlusion-fixture__/plane.gltf', route => { pendingContent = route; });
const wait = fn => page.waitForFunction(fn);
const unchanged = (current, baseline) => { assert.deepEqual(current.matrices, baseline.matrices); assert.deepEqual(current.cad, baseline.cad); assert.deepEqual(current.tilesMatrix, baseline.tilesMatrix); };
try {
  await page.goto(`${baseUrl}/tools/fixtures/cc-video-occlusion.html`, { waitUntil: 'networkidle' });
  await wait(() => window.__occlusion?.snapshot().modelReady);
  const baseline = await page.evaluate(() => window.__occlusion.baseline);
  await page.locator('#ccVideoFile').setInputFiles(videoPath); await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  await page.locator('#ccInterval').fill('2'); await page.locator('#ccOpacity').fill('1'); await page.locator('#ccOpacity').dispatchEvent('input');
  await page.locator('#ccStart').click(); await wait(() => window.__occlusion.snapshot().active);
  await wait(() => { const p = window.__occlusion.pixels(); return p.orange > 50 && p.green > 50 && p.cyan > 50 && p.yellow > 50; });
  const without = await pixels(); unchanged(await state(), baseline);
  record('opaque and translucent engineering components above and below ground are visible without occlusion', { pixels: without });
  await page.locator('#ccStop').click();
  await page.locator('#ccOcclusionEnabled').evaluate(el => { const details = el.closest('details'); if (details) details.open = true; });
  // Select the same tile as an ordinary overlay too: its occluder role wins.
  await page.locator('[data-cc-resource="ground"]').check();
  await page.locator('#ccOcclusionSource').selectOption('ground'); await page.locator('#ccOcclusionEnabled').check();
  await page.locator('#ccStart').click(); await wait(() => window.__occlusion.snapshot().active);
  for (let i = 0; i < 50 && !pendingContent; i++) await page.waitForTimeout(100);
  assert.ok(pendingContent, 'a real ground tile request must be in flight');
  const loading = await pixels(); assert.equal(loading.transparent, loading.total); assert.equal(loading.dirtyTransparent, 0);
  record('pending real surface content suppresses all overlays instead of exposing underground geometry', { pixels: loading });
  await pendingContent.fulfill({ status: 200, contentType: 'model/gltf+json', body: await page.evaluate(() => window.__occlusion.planeGltf()) });
  await wait(() => { const s = window.__occlusion.snapshot(), p = window.__occlusion.pixels(); return s.contentReady && s.tilesLoaded && p.cyan > 50 && p.yellow > 50; });
  const occluded = await pixels();
  assert.equal(occluded.orange, 0); assert.equal(occluded.green, 0); assert.equal(occluded.magenta, 0);
  assert.ok(occluded.cyan > 50 && occluded.yellow > 50 && occluded.white > 20); assert.equal(occluded.glError, 0); assert.equal(occluded.dirtyTransparent, 0);
  unchanged(await state(), baseline);
  record('actual 3D Tiles MASK surface hides opaque and translucent underground models through Brown lens without drawing surface color', { pixels: occluded });
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
  const final = await state(); assert.deepEqual(final.renderErrors, []); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  report = { pass: true, checks, final, browserErrors: errors, consoleErrors };
} catch (error) {
  report = { pass: false, checks, error: String(error.stack || error), final: await state().catch(() => null), browserErrors: errors, consoleErrors };
  await page.screenshot({ path: path.join(output, 'cc-occlusion-failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'cc-occlusion-browser-report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await server?.close();
}
console.log(JSON.stringify({ pass: report.pass, checks: checks.length, report: path.join(output, 'cc-occlusion-browser-report.json'), error: report.error }, null, 2));
if (!report.pass) process.exitCode = 1;
