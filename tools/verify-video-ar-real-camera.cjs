// Real original video + trajectory + model, through the complete app in isolated storage.
// Only record/view JSON is copied. File GETs redirect to read-only original /@fs paths.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/video-ar-execution-20261002/frame_10.01');
const scratch = path.join(root, 'tmp/video-ar-real-camera-' + Date.now());
const isolatedData = path.join(scratch, 'project-data');
const port = Number(process.env.VIDEO_AR_REAL_CAMERA_PORT || 5195);
const base = `http://127.0.0.1:${port}`;
const modelId = '8bc58629-cf26-45de-986e-086479db11a0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const write = (filename, value) => fs.writeFile(filename, JSON.stringify(value, null, 2));
const checks = { schema: 'video-ar-real-camera-isolated-probe/v1', startedAt: new Date().toISOString(),
  acceptance: 'not-validated', output, scratch, mapping: 'Unmodified record JSON; GET/HEAD /__library/files/<allowed-id>/... redirects inside the isolated browser to same-server /@fs/<original-absolute-path>. No original metadata writes or large-file copies.',
  server: { port, hmr: false, watch: null, isolatedData }, cameraParametersChangedByTest: false,
  originalModelVisibilityChangedByTest: false, originalFilesBefore: [], originalFilesAfter: [],
  mappedRequestCount: 0, mappingSamples: [], pageErrors: [], consoleErrors: [], requestFailures: [], errors: [] };
let browser, server, page;
let serverLog = '';
let originalPaths = [];
async function fingerprint(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return { path: filename, bytes: (await fs.stat(filename)).size, sha256: hash.digest('hex') };
}
async function waitFor(description, action, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    try { latest = await action(); if (latest) return latest; } catch (error) { latest = error.message; }
    await sleep(150);
  }
  throw new Error(`${description}: timed out (${JSON.stringify(latest)})`);
}
const totalTimeout = setTimeout(() => {
  checks.errors.push('Overall 220-second deadline reached');
  void browser?.close(); server?.kill();
}, 220000);
totalTimeout.unref();
(async () => {
  await fs.mkdir(output, { recursive: true });
  const originalData = path.join(root, 'project-data');
  const viewPath = path.join(originalData, 'view.json');
  const view = await read(viewPath);
  const activeId = view.activeVideoId;
  if (activeId !== '111f64c7-062e-4ac5-bc8c-26c27f4374ed') throw new Error('Active video changed; inspect the current selection before re-running');
  const ids = [activeId, modelId];
  const records = {};
  for (const id of ids) {
    const recordPath = path.join(originalData, 'records', id, 'record.json');
    records[id] = await read(recordPath);
    await fs.mkdir(path.join(isolatedData, 'records', id), { recursive: true });
    await fs.copyFile(recordPath, path.join(isolatedData, 'records', id, 'record.json'));
  }
  await fs.copyFile(viewPath, path.join(isolatedData, 'view.json'));
  checks.activeVideoId = activeId;
  checks.savedControls = records[activeId].settings.video.controls;
  checks.savedModelVisible = records[modelId].visible;
  checks.savedCalibrationSessionCount = (records[activeId].settings.video.calibrationSessions || []).length;
  const originalFileFor = (id, slot) => path.join(originalData, 'records', id, slot, records[id].files[slot].name);
  originalPaths = [viewPath, ...ids.map(id => path.join(originalData, 'records', id, 'record.json')),
    originalFileFor(activeId, 'source'), originalFileFor(activeId, 'video'), originalFileFor(modelId, 'tiles')];
  for (const filename of originalPaths) checks.originalFilesBefore.push(await fingerprint(filename));
  const viteModule = pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href;
  const bootstrap = `import { createServer } from ${JSON.stringify(viteModule)}; const s=await createServer({root:${JSON.stringify(root)},server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}}); await s.listen(); console.log('ISOLATED_REAL_CAMERA_READY');`;
  server = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root,
    env: { ...process.env, CESIUM_DATA_DIR: isolatedData }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => serverLog += data);
  server.stderr.on('data', data => serverLog += data);
  await waitFor('isolated Vite start', async () => {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { return (await fetch(base + '/__library/records', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, 25000);
  const listing = await (await fetch(base + '/__library/records')).json();
  if (listing.records.length !== 2 || listing.problems?.length) throw new Error('Isolated record listing failed: ' + JSON.stringify(listing.problems));
  checks.isolatedRecordsAccepted = true;
  console.log('Isolated records accepted; loading original resources in complete application');
  checks.browserLaunchArgs = process.env.VIDEO_AR_FORCE_SWIFTSHADER === '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] : ['--autoplay-policy=no-user-gesture-required'];
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: checks.browserLaunchArgs });
  checks.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  await context.route('**/__library/files/**', async route => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/__library\/files\/([^/]+)\/(.+)$/);
    if (url.origin !== base || !match || !ids.includes(match[1]) || !['GET', 'HEAD'].includes(route.request().method())) return route.abort();
    const sourceRoot = path.join(originalData, 'records', match[1]);
    const filename = path.resolve(sourceRoot, decodeURIComponent(match[2]));
    if (!filename.startsWith(sourceRoot + path.sep)) return route.abort();
    const destination = base + '/@fs/' + encodeURI(filename.replaceAll('\\', '/'));
    checks.mappedRequestCount++;
    if (checks.mappingSamples.length < 20) checks.mappingSamples.push({ from: url.pathname, to: destination });
    return route.fulfill({ status: 302, headers: { location: destination } });
  });
  await context.addInitScript(() => {
    window.realCameraProbeFrames = [];
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    if (original) HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return original.call(this, (now, metadata) => {
        window.realCameraProbeFrames.push({ mediaTime: metadata.mediaTime, currentTime: this.currentTime,
          width: metadata.width, height: metadata.height, paused: this.paused, seeking: this.seeking });
        if (window.realCameraProbeFrames.length > 200) window.realCameraProbeFrames.shift();
        callback(now, metadata);
      });
    };
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => checks.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && checks.consoleErrors.length < 40) checks.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => { if (checks.requestFailures.length < 40) checks.requestFailures.push({ url: request.url(), failure: request.failure() }); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.locator('[data-tab="videoar"]').click();
  await page.waitForFunction(() => {
    const v = document.querySelector('#videoArSourceVideo');
    return v && v.readyState >= 2 && v.videoWidth === 3840 && !document.querySelector('#videoArPlay')?.disabled;
  }, undefined, { timeout: 70000 });
  checks.originalVideoRestored = true;
  console.log('Original HEVC restored at 3840x2160; seeking 10.01 seconds');
  await page.evaluate(() => {
    const v = document.querySelector('#videoArSourceVideo');
    if (document.querySelector('#videoArPlay').textContent.includes('❚❚')) document.querySelector('#videoArPlay').click();
    v.pause(); v.currentTime = 10.01;
  });
  await page.waitForFunction(() => {
    const v = document.querySelector('#videoArSourceVideo');
    const frame = window.realCameraProbeFrames.at(-1);
    return v && v.paused && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 10.01) < 0.001 && frame && Math.abs(frame.mediaTime - 10.01) < 0.001;
  }, undefined, { timeout: 25000 });
  const depthWaitStarted = Date.now();
  checks.depthWait = { maximumMilliseconds: 90000, observations: [], uiReady: false, elapsedMilliseconds: 0 };
  let readyObservations = 0;
  while (Date.now() - depthWaitStarted < 90000) {
    const state = await page.evaluate(() => {
      const status = document.querySelector('#videoArModelStatus');
      const v = document.querySelector('#videoArSourceVideo');
      return { ready: status?.dataset.ready === 'true', text: status?.textContent,
        currentTime: v.currentTime, paused: v.paused, seeking: v.seeking };
    });
    checks.depthWait.observations.push({ elapsedMilliseconds: Date.now() - depthWaitStarted, ...state });
    readyObservations = state.ready && state.paused && !state.seeking && Math.abs(state.currentTime - 10.01) < 0.001 ? readyObservations + 1 : 0;
    if (readyObservations >= 3) { checks.depthWait.uiReady = true; break; }
    if (checks.depthWait.observations.length % 8 === 1) console.log(JSON.stringify({ waitingForRealModelDepth: true, elapsedMilliseconds: Date.now() - depthWaitStarted, ...state }));
    await sleep(2000);
  }
  checks.depthWait.elapsedMilliseconds = Date.now() - depthWaitStarted;
  const exportButton = page.locator('#videoArExportDiagnostics');
  await exportButton.evaluate(button => { let parent = button.parentElement; while (parent) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; } });
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await exportButton.click();
  const download = await downloadPromise;
  const diagnosticPath = path.join(output, 'runtime-camera.json');
  await download.saveAs(diagnosticPath);
  checks.diagnosticFile = diagnosticPath;
  const diagnostic = await read(diagnosticPath);
  const effective = diagnostic.effectiveCamera;
  checks.resolvedCamera = effective;
  checks.runtimeExportAtRequestedFrame = Boolean(effective && Math.abs(effective.frameTime - 10.01) < 0.001);
  checks.ui = await page.evaluate(() => ({ status: document.querySelector('#videoArStatus')?.textContent,
    position: document.querySelector('#videoArPosition')?.textContent,
    effectiveCamera: document.querySelector('#videoArEffectiveCamera')?.textContent,
    projectionMode: document.querySelector('#videoArProjectionMode')?.textContent,
    libraryStatus: document.querySelector('#libraryStatus')?.textContent,
    media: (() => { const v = document.querySelector('#videoArSourceVideo'); return { currentTime: v.currentTime, paused: v.paused, seeking: v.seeking, readyState: v.readyState, width: v.videoWidth, height: v.videoHeight, error: v.error?.message || null }; })(),
    frameCallbacks: window.realCameraProbeFrames,
  }));
  checks.controlDifferences = Object.entries(checks.savedControls).filter(([key, value]) => diagnostic.inputs?.[key] !== value)
    .map(([key, expected]) => ({ key, expected, actual: diagnostic.inputs?.[key] }));
  checks.savedControlsRestoredExactly = checks.controlDifferences.length === 0;
  checks.modelVisibilityPreserved = diagnostic.rendering?.models?.find(model => model.id === modelId)?.runtimeVisible === checks.savedModelVisible;
  checks.modelDiagnostic = diagnostic.rendering?.model ?? null;
  const depth = checks.modelDiagnostic?.depth;
  checks.sourceDepthCurrentAndAccepted = Boolean(checks.modelDiagnostic?.ready && depth?.coverageReady && depth?.currentFrameDepth && depth?.shaderSourceDepthAccepted);
  checks.sameFrameCameraAndTexture = Boolean(diagnostic.effectiveCamera?.videoTimeMs === 10010 && diagnostic.committedModelCamera?.videoTimeMs === 10010
    && ['active', 'uploaded', 'committedModel'].every(key => diagnostic.textureFrames?.[key]?.mediaTimeMs === 10010));
  checks.renderedFusionAccepted = null;
  checks.captureLimitation = 'Readiness and matching frame identities certify operational camera/texture/depth state only; geographic alignment and valid projected-area coverage require real independent checkpoints.';
  checks.renderingSnapshot = diagnostic.rendering ?? null;
  checks.runtimeCaptureScope = 'Complete real application restored original files in isolated storage. Resolved-camera/committed-camera/texture/depth states are separate fields in the original user-facing export. No independent checkpoints; no geographical registration acceptance.';
  if (diagnostic.images?.scenePng) {
    const target = path.join(output, 'runtime-scene.png');
    await fs.writeFile(target, Buffer.from(diagnostic.images.scenePng.split(',')[1], 'base64'));
    checks.sceneScreenshot = target;
  }
  await page.screenshot({ path: path.join(output, 'runtime-app.png'), timeout: 30000 });
  checks.applicationScreenshot = path.join(output, 'runtime-app.png');
  checks.capturePassed = checks.runtimeExportAtRequestedFrame && checks.savedControlsRestoredExactly && checks.modelVisibilityPreserved;
  console.log(JSON.stringify({ capturePassed: checks.capturePassed, frameTime: effective?.frameTime, cameraHeight: effective?.ellipsoidHeight,
    sourceDepthCurrentAndAccepted: checks.sourceDepthCurrentAndAccepted, sameFrameCameraAndTexture: checks.sameFrameCameraAndTexture, intrinsics: effective?.intrinsics, controlDifferences: checks.controlDifferences, modelVisible: checks.savedModelVisible }));
})().catch(async error => {
  checks.capturePassed = false;
  checks.errors.push({ message: error.message, stack: error.stack });
  if (page) {
    try { checks.failureUi = await page.evaluate(() => ({ body: document.body.innerText.slice(-10000), video: (() => { const v = document.querySelector('video'); return v ? { readyState: v.readyState, currentTime: v.currentTime, paused: v.paused, seeking: v.seeking, frames: window.realCameraProbeFrames, src: v.currentSrc, error: v.error?.message } : null; })() })); } catch {}
    try { await page.screenshot({ path: path.join(output, 'runtime-failure.png'), timeout: 5000 }); } catch {}
  }
}).finally(async () => {
  clearTimeout(totalTimeout);
  await browser?.close();
  if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
  for (const filename of originalPaths) checks.originalFilesAfter.push(await fingerprint(filename));
  checks.originalsUnchanged = checks.originalFilesBefore.length === checks.originalFilesAfter.length
    && checks.originalFilesBefore.every((file, i) => file.sha256 === checks.originalFilesAfter[i].sha256);
  checks.finishedAt = new Date().toISOString();
  await fs.mkdir(output, { recursive: true });
  await write(path.join(output, 'runtime-checks.json'), checks);
  await fs.writeFile(path.join(output, 'runtime-server.log'), serverLog);
  console.log(JSON.stringify({ capturePassed: checks.capturePassed, originalsUnchanged: checks.originalsUnchanged, output, errors: checks.errors }));
  process.exitCode = checks.capturePassed && checks.originalsUnchanged ? 0 : 1;
});
