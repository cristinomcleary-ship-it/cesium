/** Native workbench acceptance of post-load photogrammetry position editing.
 * All Tiles/GLB/MP4/XML and database contents are generated for this run. The
 * test observes the existing workbench viewer; it adds no production debug API.
 * PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE / BROWSER_LAUNCH_OPTIONS select existing
 * runtimes. PHOTOGRAMMETRY_REQUIRE_HARDWARE=1 refuses software WebGL evidence.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { createServer } from 'vite';
import { GlbWriter, IDENTITY } from '../tools/sketchup/glb-writer.mjs';

const output = resolve(process.env.PHOTOGRAMMETRY_BROWSER_OUT || 'output/photogrammetry-transform-browser');
await mkdir(output, { recursive: true });
const createdWork = await mkdtemp(join(tmpdir(), 'cesium-photogrammetry-browser-'));
const work = await realpath(createdWork);
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) {
  process.env[key] = join(work, key.toLowerCase()); await mkdir(process.env[key]);
}
const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePrefix = '/__photogrammetry_test_source__/';
const sourcePath = sourcePrefix + 'photogrammetry-tileset.json';
const report = { classification: 'native-workbench-photogrammetry-with-synthetic-tiles-media-isolated-library',
  startedAt: new Date().toISOString(), execution: 'not-started', passed: false,
  productionDataReadOrModified: false, checks: [], pageErrors: [], renderErrors: [], consoleErrors: [],
  sourceHttpErrors: [], sourceRequests: [], screenshots: [] };
let server, browser, context, page, origin, photoId, initialMatrix, committedMatrix;
let initialized = false, phase = 'browser-launch';

function syntheticPhotography() {
  const writer = new GlbWriter();
  // Flat cyan survey patch and one raised marker: SketchUp Z-up/inches enters
  // the existing GLB writer, producing self-contained Y-up/metre geometry.
  const face = (points, normal, color) => writer.addFace({
    positions: points.flatMap(point => point.map(value => value / .0254)),
    normals: points.flatMap(() => normal), indices: [0, 1, 2, 0, 2, 3],
  }, IDENTITY, { key: color.join(','), rgba: color });
  face([[-140, -140, 0], [140, -140, 0], [140, 140, 0], [-140, 140, 0]], [0, 0, 1], [.15, .7, .75, 1]);
  face([[55, 55, 9], [70, 55, 9], [70, 70, 9], [55, 70, 9]], [0, 0, 1], [.8, .55, .2, 1]);
  const glb = writer.finish('Synthetic photography patch').bytes;
  const transform = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 15)));
  const tiles = Buffer.from(JSON.stringify({ asset: { version: '1.1' }, geometricError: 0, root: {
    boundingVolume: { box: [0, 0, 5, 145, 0, 0, 0, 145, 0, 0, 0, 10] },
    transform, geometricError: 0, refine: 'REPLACE', content: { uri: 'photography.glb' },
  } }));
  return new Map([[sourcePath, { bytes: tiles, mime: 'application/json' }],
    [sourcePrefix + 'photography.glb', { bytes: Buffer.from(glb), mime: 'model/gltf-binary' }]]);
}
const source = syntheticPhotography();
report.sourceHashesBefore = Object.fromEntries([...source].map(([name, file]) => [name, hash(file.bytes)]));

const panel = () => page.locator('.photogrammetry-editor');
const input = name => panel().locator(`[data-photogrammetry="${name}"]`);
const action = name => panel().locator(`[data-photo-action="${name}"]`);
const row = () => page.locator(`.sdp-item[data-display-id="layer:${photoId}"]`);
async function check(name, fn) {
  console.log('RUN', name); const result = { name, status: 'running' }; report.checks.push(result);
  try { result.evidence = await fn(); result.status = 'passed'; console.log('PASS', name); }
  catch (error) { result.status = 'failed'; result.error = String(error); throw error; }
}
async function screenshot(name) {
  const path = join(output, name + '.png'); await page.screenshot({ path }); report.screenshots.push(path);
}
async function ready() {
  await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId, undefined, { timeout: 60000 });
  await page.evaluate(() => {
    const viewer = window.__managementWorkspace.viewer;
    window.__photogrammetryAcceptanceErrors = [];
    viewer.scene.renderError.addEventListener((_scene, error) => window.__photogrammetryAcceptanceErrors.push(String(error.stack || error)));
  });
}
async function tilesReady() {
  await page.waitForFunction(async () => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), viewer = window.__managementWorkspace?.viewer;
    if (!viewer) return false;
    for (let i = 0; i < viewer.scene.primitives.length; i++) {
      const object = viewer.scene.primitives.get(i);
      if (object instanceof C.Cesium3DTileset && !object.isDestroyed() && object.tilesLoaded) return true;
    }
    viewer.scene.requestRender(); return false;
  }, undefined, { timeout: 60000 });
}
async function frames(count = 4) {
  await page.evaluate(async count => {
    const { renderFixtureFrames } = await import('/tools/fixtures/render-fixture-frames.ts');
    await renderFixtureFrames(window.__managementWorkspace.viewer.scene, count, () => window.__photogrammetryAcceptanceErrors);
  }, count);
}
async function sceneState() {
  return page.evaluate(async () => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), viewer = window.__managementWorkspace.viewer;
    const tiles = Array.from({ length: viewer.scene.primitives.length }, (_, i) => viewer.scene.primitives.get(i))
      .find(object => object instanceof C.Cesium3DTileset && !object.isDestroyed());
    if (!tiles) throw new Error('Synthetic photography is not loaded');
    return { matrix: C.Matrix4.toArray(tiles.modelMatrix), show: tiles.show,
      center: C.Cartesian3.pack(tiles.boundingSphere.center, []), radius: tiles.boundingSphere.radius,
      renderErrors: [...window.__photogrammetryAcceptanceErrors], cameraInputs: viewer.scene.screenSpaceCameraController.enableInputs,
      guideCount: viewer.entities.values.filter(entity => entity.label?.text?.getValue(viewer.clock.currentTime) === '摄影旋转中心').length,
      cursor: viewer.scene.canvas.style.cursor, requestRenderMode: viewer.scene.requestRenderMode };
  });
}
async function records() {
  const response = await context.request.get(origin + '/__library/records');
  assert.equal(response.status(), 200, await response.text()); return (await response.json()).records;
}
async function savedPhoto() {
  const record = (await records()).find(record => record.id === photoId);
  assert.ok(record, 'Saved photogrammetry record disappeared'); return record;
}
async function openTab(name) {
  await page.locator('[data-dock="editor"]').click();
  const toggle = page.locator('.function-centers-toggle');
  if (await toggle.isVisible()) await toggle.click();
  const button = page.locator(`.tab[data-tab="${name}"]`);
  if (!await button.isVisible()) await page.locator('.function-center').filter({ has: button }).locator('summary').click();
  await button.click();
}
async function openEditor() {
  await page.locator('[data-dock="display"]').click();
  if (!await row().isVisible()) await page.locator('.sdp-category').filter({ has: row() }).locator(':scope > summary').click();
  await row().locator('[data-action="item-edit"]').click();
  await panel().waitFor({ state: 'visible' });
}
async function expandContaining(selector) {
  // The native workbench groups controls into an outer category accordion and
  // sometimes an inner details block. Open both through their real summaries,
  // in document (outer-to-inner) order; never set DOM visibility or force clicks.
  const details = page.locator('details').filter({ has: page.locator(selector) });
  for (let i = 0; i < await details.count(); i++) {
    const detail = details.nth(i);
    if (await detail.getAttribute('open') === null) await detail.locator(':scope > summary').click();
  }
}
async function framePhotography() {
  await page.evaluate(async () => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), viewer = window.__managementWorkspace.viewer;
    const tiles = Array.from({ length: viewer.scene.primitives.length }, (_, i) => viewer.scene.primitives.get(i))
      .find(object => object instanceof C.Cesium3DTileset && !object.isDestroyed());
    viewer.camera.cancelFlight();
    viewer.camera.lookAt(tiles.boundingSphere.center, new C.HeadingPitchRange(0, -Math.PI / 2, 330));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY); viewer.scene.requestRender();
  });
  await frames();
}
async function mapProbe(dx, dy) {
  return page.evaluate(async ({ dx, dy }) => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), viewer = window.__managementWorkspace.viewer;
    const tiles = Array.from({ length: viewer.scene.primitives.length }, (_, i) => viewer.scene.primitives.get(i))
      .find(object => object instanceof C.Cesium3DTileset && !object.isDestroyed());
    const rect = viewer.canvas.getBoundingClientRect();
    const screen = new C.Cartesian2(viewer.canvas.clientWidth / 2 + dx, viewer.canvas.clientHeight / 2 + dy);
    const hit = viewer.scene.pick(screen), world = viewer.scene.pickPosition(screen);
    if (!world || !(hit?.primitive === tiles || hit?.tileset === tiles || hit?.content?.tileset === tiles))
      throw new Error('The map probe did not hit the rendered synthetic photography');
    const x = rect.left + screen.x, y = rect.top + screen.y;
    if (document.elementFromPoint(x, y) !== viewer.canvas) throw new Error('A workbench panel covers the synthetic map pick');
    const frame = C.Transforms.eastNorthUpToFixedFrame(tiles.boundingSphere.center);
    return { x, y, world: C.Cartesian3.pack(world, []), frame: C.Matrix4.toArray(frame) };
  }, { dx, dy });
}
async function saveEditor() {
  await action('save').click(); await panel().waitFor({ state: 'hidden', timeout: 30000 }); await frames();
  return savedPhoto();
}
async function captureSceneErrors() {
  if (!page) return;
  report.renderErrors.push(...await page.evaluate(() => window.__photogrammetryAcceptanceErrors ?? []).catch(() => []));
}
async function reload() {
  await captureSceneErrors(); await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); await ready(); await tilesReady(); await frames();
}
async function nativeDiagnostics(name) {
  await expandContaining('#ccDiagnostics');
  const pending = page.waitForEvent('download'); await page.locator('#ccDiagnostics').click();
  const download = await pending, file = join(output, name + '.json'); await download.saveAs(file);
  return JSON.parse(await readFile(file, 'utf8'));
}

try {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
    ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright'));
  const custom = process.env.BROWSER_LAUNCH_OPTIONS;
  const launch = custom ? (await import(pathToFileURL(resolve(custom)).href)).default
    : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] };
  browser = await chromium.launch(launch);
  phase = 'server-start';
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [{
    name: 'synthetic-photogrammetry-source', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const path = (request.url ?? '/').split('?')[0]; if (!path.startsWith(sourcePrefix)) return next();
        report.sourceRequests.push({ path, method: request.method });
        const file = source.get(path);
        if (!file || !['GET', 'HEAD'].includes(request.method ?? 'GET')) { response.statusCode = 404; response.end(); return; }
        response.setHeader('Content-Type', file.mime); response.setHeader('Content-Length', file.bytes.length);
        response.setHeader('Cache-Control', 'no-store'); response.end(request.method === 'HEAD' ? undefined : file.bytes);
      });
    },
  }] });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`; report.origin = origin;
  context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ text: message.text(), location: message.location() }); });
  page.on('response', response => { if (response.url().includes(sourcePrefix) && response.status() >= 400)
    report.sourceHttpErrors.push({ url: response.url(), status: response.status() }); });
  // Local synthetic imagery prevents this acceptance from depending on public
  // basemap availability. Source photography and library routes remain real.
  await page.route('**/__basemap/**', route => route.fulfill({ contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }));
  phase = 'workbench-initialization'; await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 }); await ready();
  report.browserVersion = browser.version();
  report.gpu = await page.evaluate(() => {
    const gl = window.__managementWorkspace.viewer.scene.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { webgl2: gl instanceof WebGL2RenderingContext, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  });
  report.gpuClassification = /swiftshader|llvmpipe|software/i.test(report.gpu.renderer) ? 'software WebGL'
    : /NVIDIA|AMD|Radeon|Intel|Apple|Adreno|Mali/i.test(report.gpu.renderer) ? 'reported hardware WebGL' : 'unidentified WebGL';
  if (process.env.PHOTOGRAMMETRY_REQUIRE_HARDWARE === '1' && report.gpuClassification !== 'reported hardware WebGL')
    throw new Error('BLOCKED: hardware acceptance requested, software or unidentified renderer found');
  initialized = true; report.execution = 'running'; phase = 'native-photography-load';
  await openTab('tiles'); await expandContaining('#tilesUrl'); await page.locator('#tilesUrl').fill(origin + sourcePath);
  await expandContaining('#tilesHeight'); await page.locator('#tilesHeight').fill('4'); await page.locator('#loadTiles').click();
  await page.waitForFunction(() => document.querySelector('#tilesQualityStatus')?.textContent?.includes('photogrammetry-tileset.json'), undefined, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#loadTiles')?.disabled === false, undefined, { timeout: 60000 });
  for (let i = 0; i < 60 && !photoId; i++) {
    photoId = (await records()).find(record => record.kind === '3D Tiles' && record.settings.url?.includes('/__photogrammetry_test_source__/'))?.id;
    if (!photoId) await page.waitForTimeout(100);
  }
  assert.ok(photoId, 'Native import did not persist the synthetic Tiles record'); await tilesReady(); await framePhotography();
  initialMatrix = (await sceneState()).matrix; report.initialMatrix = initialMatrix;
  phase = 'assertions';

  await check('native-load-keeps-original-offset-and-is-locked', async () => {
    assert.notDeepEqual(initialMatrix, IDENTITY, 'The regression must protect a pre-existing nonidentity placement');
    assert.equal((await savedPhoto()).settings.tiles.heightOffset, 4);
    assert.equal(await panel().isVisible(), false);
    assert.equal((await sceneState()).guideCount, 0);
    const probe = await mapProbe(-70, 0); await page.mouse.click(probe.x, probe.y); await frames();
    assert.deepEqual((await sceneState()).matrix, initialMatrix);
    return { originalHeightOffset: 4, originalMatrix: initialMatrix, locked: true };
  });
  await check('numeric-preview-is-not-saved-and-cancel-is-exact', async () => {
    const before = await savedPhoto(); await openEditor();
    await input('east').fill('12.5'); await input('north').fill('-8.25'); await input('up').fill('3.75'); await frames();
    assert.notDeepEqual((await sceneState()).matrix, initialMatrix);
    assert.equal((await sceneState()).guideCount, 1);
    assert.deepEqual((await savedPhoto()).settings, before.settings, 'Preview wrote the library before confirmation');
    await screenshot('numeric-preview'); await action('cancel').click(); await panel().waitFor({ state: 'hidden' }); await frames();
    assert.deepEqual((await sceneState()).matrix, initialMatrix);
    assert.equal((await sceneState()).cameraInputs, true);
    assert.equal((await sceneState()).guideCount, 0);
    return { previewUnpersisted: true, exactCancel: true };
  });
  await check('existing-surface-and-underground-entries-cancel-photography-preview-and-remain-usable', async () => {
    const before = await savedPhoto(), surfacePanel = page.locator('.surface-edit-panel'), undergroundPanel = page.locator('#subsurfacePanel');
    await openEditor(); await input('east').fill('23'); await frames();
    assert.notDeepEqual((await sceneState()).matrix, initialMatrix);
    await page.locator('#openSurfaceEdit').click();
    await panel().waitFor({ state: 'hidden' }); await surfacePanel.waitFor({ state: 'visible' }); await frames();
    assert.deepEqual((await sceneState()).matrix, initialMatrix);
    assert.equal((await sceneState()).guideCount, 0);
    assert.deepEqual((await savedPhoto()).settings, before.settings);
    assert.equal(await surfacePanel.locator('[data-se-action="polygon"]').isEnabled(), true);
    await surfacePanel.locator('[data-se-action="close"]').click(); await surfacePanel.waitFor({ state: 'hidden' });

    await openEditor(); await input('east').fill('-17'); await frames();
    assert.notDeepEqual((await sceneState()).matrix, initialMatrix);
    await page.locator('#openSubsurfacePanel').click();
    await panel().waitFor({ state: 'hidden' }); await undergroundPanel.waitFor({ state: 'visible' }); await frames();
    assert.deepEqual((await sceneState()).matrix, initialMatrix);
    assert.equal((await sceneState()).guideCount, 0);
    assert.deepEqual((await savedPhoto()).settings, before.settings);
    assert.equal(await undergroundPanel.locator('#groundTransparent').isEnabled(), true);
    await undergroundPanel.locator('#closeSubsurfacePanel').click(); await undergroundPanel.waitFor({ state: 'hidden' });
    assert.equal((await sceneState()).cameraInputs, true);
    return { surfaceEntryUsable: true, undergroundEntryUsable: true, exactRestorationAtBothEntries: true, previewUnpersisted: true };
  });
  await check('two-native-map-picks-produce-east-north-offset-without-height-change', async () => {
    await openEditor(); await framePhotography();
    // Keep the probes away from the visible rotation-center guide and label.
    const first = await mapProbe(-70, 35), second = await mapProbe(80, -60);
    const expected = await page.evaluate(async ({ first, second }) => {
      const C = await import('/node_modules/.vite/deps/cesium.js');
      const delta = C.Cartesian3.subtract(C.Cartesian3.fromArray(second.world), C.Cartesian3.fromArray(first.world), new C.Cartesian3());
      const local = C.Matrix4.multiplyByPointAsVector(C.Matrix4.inverseTransformation(C.Matrix4.fromArray(first.frame), new C.Matrix4()), delta, new C.Cartesian3());
      return { east: local.x, north: local.y };
    }, { first, second });
    await action('move-points').click();
    await page.waitForFunction(() => document.querySelector('.photogrammetry-editor')?.dataset.picking === 'move-start');
    await page.mouse.click(first.x, first.y);
    await page.waitForFunction(() => document.querySelector('.photogrammetry-editor')?.dataset.picking === 'move-end');
    await page.mouse.click(second.x, second.y);
    await page.waitForFunction(() => !document.querySelector('.photogrammetry-editor')?.dataset.picking);
    const actual = { east: Number(await input('east').inputValue()), north: Number(await input('north').inputValue()), up: Number(await input('up').inputValue()) };
    assert.ok(Math.abs(actual.east - expected.east) < .03, JSON.stringify({ expected, actual }));
    assert.ok(Math.abs(actual.north - expected.north) < .03, JSON.stringify({ expected, actual }));
    assert.equal(actual.up, 0); assert.ok(Math.hypot(actual.east, actual.north) > 10);
    assert.deepEqual((await savedPhoto()).settings.matrix, initialMatrix);
    await action('cancel').click(); await panel().waitFor({ state: 'hidden' }); assert.deepEqual((await sceneState()).matrix, initialMatrix);
    return { expected, actual, clicks: 2, heightUnchanged: true };
  });
  await check('picked-rotation-center-is-fixed-and-confirmation-persists-the-preview', async () => {
    await openEditor(); await input('east').fill('12.5'); await input('north').fill('-8.25'); await input('up').fill('3.75');
    await framePhotography(); const pivot = await mapProbe(-85, -45);
    await action('pick-pivot').click();
    await page.waitForFunction(() => document.querySelector('.photogrammetry-editor')?.dataset.picking === 'pivot');
    await page.mouse.click(pivot.x, pivot.y);
    await page.waitForFunction(() => !document.querySelector('.photogrammetry-editor')?.dataset.picking);
    const before = (await sceneState()).matrix;
    await input('heading').fill('30'); await frames(); committedMatrix = (await sceneState()).matrix;
    const pivotError = await page.evaluate(async ({ before, after, point }) => {
      const C = await import('/node_modules/.vite/deps/cesium.js');
      const relative = C.Matrix4.multiply(C.Matrix4.fromArray(after), C.Matrix4.inverse(C.Matrix4.fromArray(before), new C.Matrix4()), new C.Matrix4());
      const p = C.Cartesian3.fromArray(point);
      return C.Cartesian3.distance(p, C.Matrix4.multiplyByPoint(relative, p, new C.Cartesian3()));
    }, { before, after: committedMatrix, point: pivot.world });
    assert.ok(pivotError < .03, `Rotation moved its selected world pivot by ${pivotError} m`);
    const record = await saveEditor(); assert.deepEqual(record.settings.matrix, committedMatrix);
    assert.deepEqual(record.settings.photogrammetryEditor.originalMatrix, initialMatrix);
    assert.equal(record.settings.photogrammetryEditor.heading, 30); assert.equal(record.settings.tiles.heightOffset, 4);
    return { pivotErrorMeters: pivotError, savedMatrix: record.settings.matrix, originalOffsetPreserved: true };
  });
  await check('refresh-restores-confirmed-position-and-editor-parameters', async () => {
    await reload(); assert.deepEqual((await sceneState()).matrix, committedMatrix); assert.equal(await panel().isVisible(), false);
    await openEditor();
    for (const [key, value] of Object.entries({ east: 12.5, north: -8.25, up: 3.75, heading: 30 }))
      assert.equal(Number(await input(key).inputValue()), value, key);
    await action('cancel').click(); assert.deepEqual((await sceneState()).matrix, committedMatrix);
    return { matrixRestored: true, editableParametersRestored: true, initiallyLocked: true };
  });
  await check('native-ar-entry-uses-confirmed-photography-matrix-and-exit-restores-it', async () => {
    await openEditor(); await input('east').fill('98'); assert.notDeepEqual((await sceneState()).matrix, committedMatrix);
    await openTab('videoar'); await panel().waitFor({ state: 'hidden' }); assert.deepEqual((await sceneState()).matrix, committedMatrix);
    const videoPath = join(work, 'photogrammetry-ar.mp4');
    report.encoder = process.env.MEDIA_BROWSER_ENCODER || 'libx264';
    execFileSync(process.env.FFMPEG_EXECUTABLE || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=0x1b242c:s=640x360:r=15:d=2.2', '-c:v', report.encoder, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath], { timeout: 30000 });
    const photo = i => `<Photo><Id>${i}</Id><ImagePath>frame_${String(i).padStart(6, '0')}.jpg</ImagePath><Component>1</Component><Pose><Center><x>121</x><y>31</y><z>150</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
    const xml = `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84 3D</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><Name>Synthetic photography transform</Name><SRSId>0</SRSId><Photogroups><Photogroup><Name>Synthetic camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew><Distortion><K1>0</K1><K2>0</K2><K3>0</K3><P1>0</P1><P2>0</P2></Distortion>${[0, 1, 2].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`;
    await expandContaining('#ccVideoFile');
    await page.locator('#ccVideoFile').setInputFiles({ name: 'synthetic-photogrammetry.mp4', mimeType: 'video/mp4', buffer: await readFile(videoPath) });
    await page.locator('#ccXmlFile').setInputFiles({ name: 'synthetic-photogrammetry.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
    await expandContaining('#ccTimeMode'); await page.locator('#ccTimeMode').selectOption('ordinal'); await page.locator('#ccInterval').fill('1');
    await expandContaining('#ccSceneReference'); await page.locator('#ccSceneReference').selectOption(photoId);
    await expandContaining('#ccOcclusionSource');
    await page.locator('#ccOcclusionSource').selectOption(photoId); await page.locator('#ccOcclusionEnabled').check();
    await page.locator('#ccStart').click(); await page.locator('.cc-video-controls').waitFor({ state: 'visible', timeout: 60000 }); await frames();
    await page.locator('#ccOcclusionInfo').filter({ hasText: '实景遮挡已生效' }).waitFor({ state: 'visible', timeout: 20000 });
    const diagnostic = await nativeDiagnostics('photography-in-ar');
    assert.equal(diagnostic.lifecycle.liveRendering, true); assert.equal(diagnostic.referenceError, null); assert.equal(diagnostic.occlusion.error, null);
    assert.equal(diagnostic.occlusion.enabled, true); assert.equal(diagnostic.occlusion.sourceId, photoId); assert.equal(diagnostic.occlusion.status.ready, true);
    assert.deepEqual(diagnostic.sceneReference.matrix, committedMatrix);
    const photography = diagnostic.resources.find(item => item.id === photoId); assert.ok(photography);
    assert.equal(photography.occluder, true);
    assert.deepEqual(photography.savedMatrix, committedMatrix); assert.deepEqual(photography.displayedMatrix, committedMatrix);
    await page.locator('#ccStop').click(); await page.locator('.cc-video-controls').waitFor({ state: 'hidden' }); await frames();
    assert.deepEqual((await sceneState()).matrix, committedMatrix);
    assert.deepEqual((await savedPhoto()).settings.matrix, committedMatrix);
    return { previewCancelledBeforeAR: true, sceneReference: diagnostic.sceneReference, nativeOcclusion: diagnostic.occlusion.enabled, matrixAfterExit: committedMatrix };
  });
  await check('restore-original-is-a-preview-until-confirmed-and-survives-refresh', async () => {
    await openEditor(); await action('reset').click(); await frames(); assert.deepEqual((await sceneState()).matrix, initialMatrix);
    assert.deepEqual((await savedPhoto()).settings.matrix, committedMatrix);
    await action('cancel').click(); assert.deepEqual((await sceneState()).matrix, committedMatrix);
    await openEditor(); await action('reset').click(); const record = await saveEditor(); assert.deepEqual(record.settings.matrix, initialMatrix);
    await reload(); assert.deepEqual((await sceneState()).matrix, initialMatrix); assert.equal((await savedPhoto()).settings.tiles.heightOffset, 4);
    return { resetPreviewUnpersisted: true, exactOriginalRestored: true, originalHeightCorrection: 4 };
  });
  await check('failed-confirmation-preserves-original-record-and-all-source-bytes', async () => {
    const before = await savedPhoto(); await openEditor(); await input('north').fill('16');
    let attempts = 0;
    const url = origin + '/__library/records/' + photoId;
    const rejectSave = route => route.request().method() === 'PATCH'
      ? (attempts++, route.fulfill({ status: 503, json: { error: 'synthetic-save-denied' } })) : route.fallback();
    await page.route(url, rejectSave);
    try {
      await action('save').click(); await input('status').filter({ hasText: 'synthetic-save-denied' }).waitFor({ state: 'visible' });
      assert.equal(attempts, 1); assert.equal(await panel().isVisible(), true);
      assert.deepEqual((await savedPhoto()).settings, before.settings);
      await action('cancel').click(); await panel().waitFor({ state: 'hidden' }); assert.deepEqual((await sceneState()).matrix, initialMatrix);
    } finally { await page.unroute(url, rejectSave); }
    const after = {};
    for (const [path, file] of source) {
      const response = await context.request.get(origin + path); assert.equal(response.status(), 200);
      after[path] = hash(await response.body()); assert.equal(after[path], hash(file.bytes));
    }
    assert.deepEqual(after, report.sourceHashesBefore); report.sourceHashesAfter = after;
    assert.ok(report.sourceRequests.every(request => ['GET', 'HEAD'].includes(request.method)));
    assert.deepEqual(report.sourceHttpErrors, []); assert.equal((await sceneState()).cameraInputs, true);
    await screenshot('restored-original');
    return { rejectedSaveAttempts: attempts, previousSettingsPreserved: true, sourceHashes: after, noSourceWrites: true };
  });
  await captureSceneErrors(); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.renderErrors, []);
  report.passed = true; report.execution = 'completed';
} catch (error) {
  report.error = error.stack || String(error); report.failedPhase = phase;
  const blocked = !initialized && (/BLOCKED:|Target page, context or browser has been closed|browserType.launch|Failed to create WebGL|WebGL.*not supported|Operation not permitted/i.test(report.error));
  report.execution = blocked ? 'blocked' : 'failed'; process.exitCode = blocked ? 2 : 1; console.error(report.error);
  if (page) { await screenshot('failure').catch(() => {}); report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(-9000); }
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await server?.close(); await rm(createdWork, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, execution: report.execution, checks: report.checks.map(({ name, status }) => ({ name, status })), report: join(output, 'report.json') }));
}
