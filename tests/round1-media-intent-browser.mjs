/** Native UI acceptance of saved-scheme/manual-file ordering and AR occlusion.
 * Uses generated MP4/XML and existing synthetic Tiles/GLB fixture only.
 * node tests/round1-media-intent-browser.mjs
 * PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE or BROWSER_LAUNCH_OPTIONS select installed
 * runtimes. FFMPEG_EXECUTABLE and MEDIA_BROWSER_ENCODER (default libx264; Windows
 * builds may use libopenh264) select an existing encoder; no installs are made.
 * ROUND1_REQUIRE_HARDWARE=1 rejects software renderer. Launch/environment blocks
 * exit 2, assertion failures exit 1. A blocked run is never reported as passed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const output = resolve(process.env.ROUND1_MEDIA_BROWSER_OUT || 'output/round1-media-intent-browser');
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'cesium-round1-media-intent-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) {
  process.env[key] = join(work, key.toLowerCase()); await mkdir(process.env[key], { recursive: true });
}
const report = { classification: 'native-cc-panel-real-scene-library-and-cesium-with-synthetic-http-media',
  startedAt: new Date().toISOString(), execution: 'not-started', passed: false,
  productionDataReadOrModified: false, checks: [], pageErrors: [], consoleErrors: [], httpErrors: [], requestFailures: [] };
const require = createRequire(import.meta.url);
let server, browser, page, initialized = false, phase = 'browser-launch', heldRequest, releaseHeld, releasedResponse;
const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.__round1MediaIntent[method](...args), { method, args });
const check = async (name, fn) => {
  console.log('RUN', name); const result = { name, status: 'running' }; report.checks.push(result);
  try { result.evidence = await fn(); result.status = 'passed'; console.log('PASS', name); }
  catch (error) { result.status = 'failed'; result.error = String(error); throw error; }
};
const timeout = (promise, message) => new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), 30000);
  promise.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); reject(error); });
});
const nativeDiagnostics = async label => {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#ccDiagnostics').click();
  const download = await downloadPromise, target = join(output, `${label}.json`);
  await download.saveAs(target); return JSON.parse(await readFile(target, 'utf8'));
};
try {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
    ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright'));
  const customLauncher = process.env.BROWSER_LAUNCH_OPTIONS;
  const options = customLauncher ? (await import(pathToFileURL(resolve(customLauncher)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] };
  report.launchMode = customLauncher ? 'custom launcher; inspect renderer below' : 'software WebGL requested';
  browser = await chromium.launch(options);
  phase = 'synthetic-media-generation';
  const videoPath = join(work, 'synthetic.mp4');
  report.encoder = process.env.MEDIA_BROWSER_ENCODER || 'libx264';
  execFileSync(process.env.FFMPEG_EXECUTABLE || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=0x1b242c:s=640x360:r=15:d=2.2', '-c:v', report.encoder, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath],
  { timeout: 30000 });
  const videoBytes = await readFile(videoPath);
  const photo = i => `<Photo><Id>${i}</Id><ImagePath>synthetic_frame_${String(i).padStart(6, '0')}.jpg</ImagePath><Component>1</Component><Pose><Center><x>121</x><y>31</y><z>120</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
  const xml = `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84 3D</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><Name>Synthetic native selection</Name><SRSId>0</SRSId><Photogroups><Photogroup><Name>Synthetic camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew><Distortion><K1>0</K1><K2>0</K2><K3>0</K3><P1>0</P1><P2>0</P2></Distortion>${[0, 1, 2].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`;
  const record = (id, kind, settings = {}, files = {}) => ({ version: 1, id, kind, name: id,
    visible: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', settings, files });
  const mediaRecord = id => record(id, 'Drone Video', { video: {
    version: 1, mode: 'cc-overlay', schemeName: `Synthetic ${id}`, videoName: `${id}.mp4`, videoSize: videoBytes.length,
    width: 640, height: 360, selectedIds: ['synthetic-engineering'], opacity: .8, currentTime: 0, adjustments: {},
    timing: { mode: 'ordinal', firstTimeSeconds: 0, intervalSeconds: 1, heightReference: 'ellipsoid' },
  } }, { video: { name: `${id}.mp4`, url: `/__round1_media__/${id}.mp4` }, source: { name: 'synthetic.xml', url: '/__round1_media__/camera.xml' } });
  const records = [record('synthetic-photography', '3D Tiles'), record('synthetic-engineering', 'Model'), mediaRecord('slow'), mediaRecord('fast')];
  phase = 'server-start';
  server = await createServer({ optimizeDeps: { entries: ['tools/fixtures/round1-media-intent.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen();
  report.origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ message: message.text(), location: message.location() }); });
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ url: response.url(), status: response.status() }); });
  page.on('requestfailed', request => report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.route('**/__library/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/__library/records' && request.method() === 'GET')
      return route.fulfill({ json: { records, problems: [], deletedVideoIds: [] } });
    if (pathname.startsWith('/__library/records/') && request.method() === 'GET') {
      const result = records.find(record => record.id === decodeURIComponent(pathname.split('/').at(-1)));
      if (result) return route.fulfill({ json: result });
    }
    if (pathname === '/__library/view' && request.method() === 'PUT') return route.fulfill({ json: {} });
    throw new Error(`Unexpected fixture library request: ${request.method()} ${pathname}`);
  });
  await page.route('**/__round1_media__/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/camera.xml')) return route.fulfill({ contentType: 'application/xml', body: xml });
    if (pathname.endsWith('/slow.mp4') && heldRequest) {
      const waitRelease = new Promise(resolveRelease => { releaseHeld = resolveRelease; });
      heldRequest(); heldRequest = undefined; await waitRelease;
      await route.fulfill({ contentType: 'video/mp4', body: videoBytes }); releasedResponse?.(); return;
    }
    return route.fulfill({ contentType: 'video/mp4', body: videoBytes });
  });
  phase = 'fixture-initialization';
  await page.goto(report.origin + '/tools/fixtures/round1-media-intent.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__round1MediaIntent?.ready || window.__round1MediaIntent?.failure, undefined, { timeout: 60000 });
  const failure = await page.evaluate(() => window.__round1MediaIntent.failure); if (failure) throw new Error(failure);
  report.gpu = await invoke('gpu');
  report.gpuClassification = /swiftshader|llvmpipe|software/i.test(report.gpu.renderer) ? 'software WebGL'
    : /NVIDIA|AMD|Radeon|Intel|Apple|Adreno|Mali/i.test(report.gpu.renderer) ? 'reported hardware WebGL' : 'unidentified WebGL';
  if (process.env.ROUND1_REQUIRE_HARDWARE === '1' && report.gpuClassification !== 'reported hardware WebGL')
    throw new Error('BLOCKED: hardware acceptance requested, software/unidentified renderer found');
  initialized = true; phase = 'assertions'; report.execution = 'running';
  await check('native-saved-scheme-restores-valid-video', async () => {
    const diagnostic = await nativeDiagnostics('initial-fast'); assert.equal(diagnostic.video.name, 'fast.mp4');
    assert.equal(diagnostic.video.width, 640); assert.equal(diagnostic.video.height, 360);
    return { video: diagnostic.video.name, dimensions: [diagnostic.video.width, diagnostic.video.height] };
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await check(`pending-scheme-cannot-overwrite-new-native-file-${attempt}`, async () => {
      const began = new Promise(resolveBegan => { heldRequest = resolveBegan; });
      const responseSent = new Promise(resolveSent => { releasedResponse = resolveSent; });
      await page.locator('[data-saved-id="slow"] button').first().click();
      await timeout(began, 'Slow scheme never requested its video');
      const name = `manual-newer-${attempt}.mp4`;
      await page.locator('#ccVideoFile').setInputFiles({ name, mimeType: 'video/mp4', buffer: videoBytes });
      const before = await nativeDiagnostics(`manual-${attempt}-before-old-response`);
      assert.equal(before.video.name, name); assert.equal(before.video.width, 640); assert.equal(before.video.height, 360);
      const selected = await invoke('state'); assert.equal(selected.videoFileInput, name);
      releaseHeld(); releaseHeld = undefined;
      await timeout(responseSent, 'Held response was not fulfilled'); releasedResponse = undefined;
      await page.waitForFunction(() => !window.__round1MediaIntent.state().libraryBusy);
      const after = await nativeDiagnostics(`manual-${attempt}-after-old-response`), state = await invoke('settle');
      assert.equal(after.video.name, name, 'Late scheme replaced the decoder/diagnostic identity');
      assert.equal(state.videoFileInput, name, 'Late restore cleared the newer native file input');
      assert.equal(state.schemeName, `${name} · CC 融合`); assert.equal(state.leases, 0);
      return { heldResponseReleasedOnlyAfterManualDecode: true, before: before.video.name, after: after.video.name, nativeFileInput: state.videoFileInput };
    });
  }
  await check('native-occlusion-toggle-pauses-legacy-cut-before-check-and-restores-on-exit', async () => {
    const before = await invoke('legacySection', true); assert.equal(before.sourceClipping?.enabled, true); assert.equal(before.leases, 0);
    await page.locator('#ccOcclusionSource').selectOption('synthetic-photography');
    await page.locator('#ccOcclusionEnabled').check();
    const enabled = await invoke('settle'); assert.equal(enabled.occlusion, true); assert.equal(enabled.leases, 1);
    assert.equal(enabled.sourceClipping, null); assert.equal(enabled.engineeringClipping, null);
    const diagnostic = await nativeDiagnostics('occlusion-enabled'); assert.equal(diagnostic.occlusion.error, null);
    await page.locator('#ccStart').click(); await page.waitForFunction(() => window.__round1MediaIntent.state().active);
    await invoke('settle'); await page.locator('#ccStop').click();
    await page.waitForFunction(() => !window.__round1MediaIntent.state().active && window.__round1MediaIntent.state().leases === 0);
    const restored = await invoke('settle'); assert.deepEqual(restored.sourceClipping, before.sourceClipping);
    assert.deepEqual(restored.engineeringClipping, before.engineeringClipping); assert.equal(restored.sectionOffset, '17');
    // Re-enable after an actual manual source change has released panel ownership.
    await page.locator('#ccVideoFile').setInputFiles({ name: 'after-exit.mp4', mimeType: 'video/mp4', buffer: videoBytes });
    await page.locator('#ccOcclusionSource').selectOption('synthetic-photography'); await page.locator('#ccOcclusionEnabled').check();
    const reentered = await invoke('settle'); assert.equal(reentered.occlusion, true); assert.equal(reentered.leases, 1); assert.equal(reentered.sourceClipping, null);
    await page.locator('#ccStop').click(); const final = await invoke('settle'); assert.deepEqual(final.sourceClipping, before.sourceClipping);
    return { toggleAccepted: true, nativeEnterExit: true, parametersRestored: true, manualPickReentry: true };
  });
  await check('unknown-clipping-owner-remains-protected-with-no-leaked-lease', async () => {
    await page.locator('#ccVideoFile').setInputFiles({ name: 'foreign-owner.mp4', mimeType: 'video/mp4', buffer: videoBytes });
    const before = await invoke('addForeignClip'); assert.equal(before.foreignBound, true);
    assert.ok(before.foreignBorrowers > 0, 'Foreign clipping must be borrowed by at least one loaded tile model');
    await page.locator('#ccOcclusionSource').selectOption('synthetic-photography');
    // A rejected native checkbox change resets checked=false, so click rather
    // than Playwright.check() (which requires the checkbox to remain checked).
    await page.locator('#ccOcclusionEnabled').click();
    const after = await invoke('settle'); assert.equal(after.occlusion, false); assert.equal(after.leases, 0);
    assert.equal(after.foreignBound, true); assert.equal(after.foreignDestroyed, false);
    assert.ok(after.foreignBorrowers > 0, 'AR rejection must preserve the foreign owner and its loaded aliases');
    assert.ok(after.messages.slice(before.messages.length).some(item => item.error && /剖切或开挖/.test(item.message)));
    const cleaned = await invoke('removeForeignClip');
    assert.equal(cleaned.sourceClipping, null); assert.equal(cleaned.foreignBound, false);
    assert.equal(cleaned.foreignCleanup?.detached, true); assert.equal(cleaned.foreignCleanup?.destroyed, true);
    assert.ok(cleaned.foreignCleanup.releasedAliases > 0, 'Cleanup must exercise an actual loaded tile-model borrower');
    assert.equal(cleaned.foreignCleanup.releasedAliases, cleaned.foreignCleanup.aliasesBefore);
    assert.equal(cleaned.foreignCleanup.remainingAliases, 0, 'No loaded model may retain the destroyed texture owner after rendering');
    assert.equal(cleaned.leases, 0); assert.deepEqual(cleaned.renderErrors, []);
    return { rejected: true, foreignOwnerPreserved: true, leases: after.leases, cleanup: cleaned.foreignCleanup };
  });
  const final = await invoke('state'); assert.deepEqual(final.renderErrors, []);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.httpErrors, []); assert.deepEqual(report.requestFailures, []);
  report.execution = 'completed'; report.passed = true;
} catch (error) {
  const environmentBlock = ['browser-launch', 'synthetic-media-generation'].includes(phase)
    || phase === 'server-start' && /EPERM|EACCES/.test(String(error)) || String(error).includes('BLOCKED:');
  report.execution = environmentBlock ? 'blocked' : 'failed'; report.failedPhase = phase;
  report.error = String(error.stack || error); process.exitCode = report.execution === 'blocked' ? 2 : 1;
  console.error(report.error);
} finally {
  releaseHeld?.();
  if (page && initialized) await page.screenshot({ path: join(output, 'final-state.png') }).catch(() => {});
  await browser?.close(); await server?.close();
  report.finishedAt = new Date().toISOString();
  report.notProven = ['No production scene, saved business scheme or long video was used.', 'Legacy VideoArFusion native panel is not exercised by this focused CC browser harness.'];
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ execution: report.execution, passed: report.passed, checks: report.checks.map(item => ({ name: item.name, status: item.status })), report: join(output, 'report.json') }));
}
