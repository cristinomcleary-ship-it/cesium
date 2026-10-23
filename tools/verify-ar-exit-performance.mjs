#!/usr/bin/env node
/** Synthetic 4K GPU-lifetime regression. Requires ffmpeg/ffprobe, Playwright and Chromium.
 * START_VITE=1 starts Vite (default when BASE_URL is omitted). Set START_VITE=0
 * to reuse a server. PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE, BASE_URL, OUTPUT_DIR,
 * SOURCE_VIDEO and STRESS_MODELS are optional. BASELINE=1 explicitly disables
 * only the render-target cleanup module in this test browser to reproduce R2.
 * Timings are diagnostics; software rendering is not a user-device FPS guarantee.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (runtimeModules ? path.join(runtimeModules, 'playwright') : 'playwright'));
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5187';
const startServer = process.env.START_VITE === '1' || (!process.env.BASE_URL && process.env.START_VITE !== '0');
const server = startServer ? await (await import('vite')).createServer({ server: {
  host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port) || 5187, strictPort: true, hmr: false, watch: null,
} }) : undefined;
await server?.listen();
const work = await mkdtemp(path.join(os.tmpdir(), 'ar-exit-gpu-'));
const output = process.env.OUTPUT_DIR || work; await mkdir(output, { recursive: true });
const baseline = process.env.BASELINE === '1';
const videoPath = process.env.SOURCE_VIDEO || path.join(work, 'synthetic-native4k.mp4');
if (!process.env.SOURCE_VIDEO) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1b242c:s=3840x2160:r=30:d=2.1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', videoPath], { encoding: 'utf8' }));
const { width, height } = probe.streams[0];
assert.ok(width >= 3840 && height >= 2160 && Number(probe.format.duration) > 2, 'SOURCE_VIDEO must provide at least 2 seconds of native 4K video');
const photo = i => `<Photo><Id>${i}</Id><ImagePath>frame_${i}.jpg</ImagePath><Component>1</Component><Pose><Center><x>120</x><y>30</y><z>200</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
const xmlPath = path.join(work, 'synthetic-camera.xml');
await writeFile(xmlPath, `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS84</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><SRSId>0</SRSId><Photogroups><Photogroup><Name>4K synthetic stress</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>${width}</Width><Height>${height}</Height></ImageDimensions><FocalLengthPixels>${width * .78125}</FocalLengthPixels><PrincipalPoint><x>${width / 2 - .5}</x><y>${height / 2 - .5}</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew>${[0, 1, 2].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(90000);
await page.addInitScript(() => {
  const textures = new Map(), renderbuffers = new Map(), contexts = new WeakMap();
  let draws = 0, textureCreates = 0, textureDeletes = 0, framebufferCreates = 0, framebufferDeletes = 0;
  const state = context => {
    if (!contexts.has(context)) contexts.set(context, { unit: 0, textures: new Map(), renderbuffers: new Map() });
    return contexts.get(context);
  };
  const pixelBytes = (internal, type) => ({ 34836: 16, 34842: 8, 33326: 4, 33327: 4, 33328: 8 }[internal] ?? (internal === 6408 && type === 5126 ? 16 : internal === 6408 && type === 5131 ? 8 : 4));
  for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const wrap = (name, operation) => { const original = proto[name]; if (typeof original === 'function') proto[name] = function (...args) { return operation.call(this, original, args); }; };
    wrap('createTexture', function (original, args) { const value = original.apply(this, args); textures.set(value, { bytes: 0, w: 0, h: 0, levels: new Map() }); textureCreates++; return value; });
    wrap('deleteTexture', function (original, args) { textures.delete(args[0]); textureDeletes++; return original.apply(this, args); });
    wrap('activeTexture', function (original, args) { state(this).unit = args[0] - this.TEXTURE0; return original.apply(this, args); });
    wrap('bindTexture', function (original, args) { const s = state(this); s.textures.set(`${s.unit}/${args[0]}`, args[1]); return original.apply(this, args); });
    wrap('texImage2D', function (original, args) {
      const value = original.apply(this, args), s = state(this);
      const binding = args[0] >= 34069 && args[0] <= 34074 ? 34067 : args[0];
      const texture = textures.get(s.textures.get(`${s.unit}/${binding}`)); if (!texture) return value;
      let w, h, type;
      if (args.length >= 9) { w = args[3]; h = args[4]; type = args[7]; }
      else { const source = args[5]; w = source?.videoWidth ?? source?.displayWidth ?? source?.width ?? 0; h = source?.videoHeight ?? source?.displayHeight ?? source?.height ?? 0; type = args[4]; }
      texture.levels.set(`${args[0]}/${args[1]}`, w * h * pixelBytes(args[2], type));
      texture.bytes = [...texture.levels.values()].reduce((sum, bytes) => sum + bytes, 0);
      if (args[1] === 0) Object.assign(texture, { w, h, internal: args[2] });
      return value;
    });
    wrap('createRenderbuffer', function (original, args) { const value = original.apply(this, args); renderbuffers.set(value, 0); return value; });
    wrap('deleteRenderbuffer', function (original, args) { renderbuffers.delete(args[0]); return original.apply(this, args); });
    wrap('bindRenderbuffer', function (original, args) { state(this).renderbuffers.set(args[0], args[1]); return original.apply(this, args); });
    wrap('renderbufferStorage', function (original, args) { const value = original.apply(this, args); renderbuffers.set(state(this).renderbuffers.get(args[0]), args[2] * args[3] * pixelBytes(args[1])); return value; });
    wrap('renderbufferStorageMultisample', function (original, args) { const value = original.apply(this, args); renderbuffers.set(state(this).renderbuffers.get(args[0]), args[1] * args[3] * args[4] * pixelBytes(args[2])); return value; });
    wrap('createFramebuffer', function (original, args) { framebufferCreates++; return original.apply(this, args); });
    wrap('deleteFramebuffer', function (original, args) { framebufferDeletes++; return original.apply(this, args); });
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) wrap(name, function (original, args) { draws++; return original.apply(this, args); });
  }
  window.__glStats = { snapshot: () => ({ draws, textureCreates, textureDeletes, framebufferCreates, framebufferDeletes,
    liveTextureCount: textures.size, textureBytes: [...textures.values()].reduce((sum, texture) => sum + texture.bytes, 0),
    renderbufferBytes: [...renderbuffers.values()].reduce((sum, bytes) => sum + bytes, 0),
    largeTextures: [...textures.values()].filter(texture => texture.w > 2048 || texture.h > 2048).map(({ levels, ...texture }) => texture) }) };
});
if (baseline) {
  // Browser interception is explicit and test-local. Production source is never edited.
  await page.route(/\/src\/videoOverlayRenderTargets\.ts(?:\?t=\d+)?$/, route => route.fulfill({ contentType: 'application/javascript',
    body: 'export function captureVideoOverlayRenderTargets(){return ()=>({cacheUpdated:false,releasedManagers:0,skipped:false})}' }));
}
const errors = []; page.on('pageerror', error => errors.push(String(error.stack || error)));
const report = { pass: false, mode: baseline ? 'baseline-explicit-noop' : 'fixed', source: { width, height }, checks: [] };
const getState = () => page.evaluate(() => window.__exitPerformance.state());
const assertClean = value => {
  assert.equal(value.glError, 0); assert.deepEqual(value.errors, []);
  assert.equal(value.sceneColorSize, null); assert.equal(value.sceneIdSize, null); assert.deepEqual(value.cachedFramebuffers, []);
  assert.deepEqual(value.glAllocations.largeTextures, [], 'native AR texture allocations must not survive exit');
};
const mark = name => { report.checks.push(name); console.log(`PASS ${name}`); };
try {
  await page.goto(`${baseUrl}/tools/fixtures/ar-exit-performance.html?models=${Number(process.env.STRESS_MODELS || 28)}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__exitPerformance?.state().ready);
  report.beforeFrames = await page.evaluate(() => window.__exitPerformance.frames()); report.before = await getState();
  await page.locator('#ccVideoFile').setInputFiles(videoPath); await page.locator('#ccXmlFile').setInputFiles(xmlPath); await page.locator('#ccInterval').fill('1');
  await page.locator('#ccStart').click(); await page.waitForFunction(() => window.__exitPerformance.state().presentedTime !== null);
  report.ar = await getState(); assert.ok(report.ar.renderer.width >= width && report.ar.renderer.height >= height);
  assert.ok(report.ar.glAllocations.largeTextures.length >= 1); mark('native 4K rendering allocates real GPU targets');
  await page.locator('#ccStop').click(); await page.waitForFunction(() => !window.__exitPerformance.state().active);
  report.afterFrames = await page.evaluate(() => window.__exitPerformance.frames()); report.after = await getState();
  if (baseline) {
    assert.ok(report.after.glAllocations.largeTextures.length > 0); assert.ok(report.after.cachedFramebuffers.length > 0);
    mark('explicit baseline reproduces retained native AR framebuffers');
    report.manualRelease = await page.evaluate(async () => {
      const { captureVideoOverlayRenderTargets } = await import('/src/videoOverlayRenderTargets.ts?gpu-audit=1');
      return captureVideoOverlayRenderTargets(window.__exitPerformance.viewer.scene)();
    });
    report.cleanedFrames = await page.evaluate(() => window.__exitPerformance.frames()); report.cleaned = await getState(); assertClean(report.cleaned);
    mark('manual application releases the reproduced idle GPU allocations');
  } else { assertClean(report.after); mark('fixed exit releases native textures and idle postprocess pools'); }
  report.pick = await page.evaluate(() => window.__exitPerformance.pick()); assert.equal(report.pick.glError, 0); assert.equal(report.pick.picked, true);
  mark('normal map picking still finds real model geometry');
  // A second real AR session starts with normal FXAA enabled. Its exit must keep
  // that map effect and resize its reusable targets to the native map canvas.
  await page.evaluate(() => { const viewer = window.__exitPerformance.viewer; viewer.scene.postProcessStages.fxaa.enabled = true; viewer.scene.requestRender(); viewer.render(); });
  await page.locator('#ccStart').click(); await page.waitForFunction(() => window.__exitPerformance.state().presentedTime !== null);
  await page.locator('#ccStop').click(); await page.waitForFunction(() => !window.__exitPerformance.state().active);
  if (baseline) await page.evaluate(async () => { const { captureVideoOverlayRenderTargets } = await import('/src/videoOverlayRenderTargets.ts?gpu-audit=1'); captureVideoOverlayRenderTargets(window.__exitPerformance.viewer.scene)(); });
  await page.evaluate(() => { const viewer = window.__exitPerformance.viewer; viewer.scene.requestRender(); viewer.render(); });
  report.repeat = await getState(); assert.equal(report.repeat.glError, 0); assert.deepEqual(report.repeat.errors, []); assert.equal(report.repeat.renderer.fxaa, true);
  assert.deepEqual(report.repeat.sceneColorSize, [report.repeat.renderer.width, report.repeat.renderer.height]);
  assert.deepEqual(report.repeat.glAllocations.largeTextures, []);
  report.repeatPick = await page.evaluate(() => window.__exitPerformance.pick()); assert.equal(report.repeatPick.picked, true); assert.equal(report.repeatPick.glError, 0);
  mark('repeat AR exit preserves native map FXAA and model picking');
  assert.deepEqual(errors, []); report.pass = true;
} catch (error) { report.error = String(error.stack || error); report.failure = await getState().catch(() => null); process.exitCode = 1; }
finally {
  report.browserErrors = errors;
  const reportPath = path.join(output, baseline ? 'ar-exit-gpu-baseline-report.json' : 'ar-exit-gpu-fixed-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ pass: report.pass, mode: report.mode, report: reportPath, error: report.error }));
  await browser.close(); await server?.close();
}
