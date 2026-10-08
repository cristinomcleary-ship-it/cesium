// Actual V5 G07/G10 motion evidence. Run AFTER main acceptance, never alongside it.
// Read-only business data: every library/spatial/event mutation is blocked and reported.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/胡航/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'output/platform-v5');
const base = process.env.PLATFORM_V5_URL || 'http://127.0.0.1:5198', bridge = '/tmp/platform-v5-motion-cesium.ts';
const report = { scope: 'Actual V5 existing-project G07/G10 evidence; manual-object pulse/outline, unverified-height tracks hidden; no created formal objects', checks: [], errors: [], consoleErrors: [], blockedWrites: [], blockedLibraryWrites: [], cameraMethod: 'existing Cesium Camera.lookAt + lookAtTransform(identity); 30 degree orbit and 18 percent range reduction' };
let browser, page, context, session, recording, recordStart, frameIndex = 0, frames = [], frameWrites = [];
const check = (label, data) => { report.checks.push({ label, data }); console.log('PASS', label); };
const act = name => page.locator(`.v3-toolbar [data-action="${name}"]`);
const spatial = name => page.locator(`.safety-spatial-editor [data-spatial="${name}"]`);
const stats = () => page.evaluate(() => __safetyWorkspace.debugStats());
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// The CDP recorder below uses timestamped actual browser JPEG frames, exactly as
// the main workflow recorder does. The encoded frame rate is not platform FPS.
async function caption(text) {
  await page.evaluate(text => {
    let el = document.getElementById('acceptance-caption');
    if (!el) { el = document.createElement('div'); el.id = 'acceptance-caption'; el.style.cssText = 'position:fixed;left:50%;top:105px;transform:translateX(-50%);z-index:99999;pointer-events:none;background:#071a2df0;border:1px solid #43d9ff88;color:#e5f7ff;padding:8px 18px;font:16px Microsoft YaHei;max-width:52vw;text-align:center'; document.body.append(el); }
    el.textContent = text;
  }, text);
}
async function beginRecording(name) {
  session = await context.newCDPSession(page); frameIndex = 0; frames = []; frameWrites = []; recording = name; recordStart = Date.now();
  await fs.mkdir(path.join(out, name + '-frames'), { recursive: true });
  session.on('Page.screencastFrame', e => {
    const index = frameIndex++, file = path.join(out, name + '-frames', String(index).padStart(6, '0') + '.jpg');
    frames.push({ file, time: Date.now() }); frameWrites.push(fs.writeFile(file, Buffer.from(e.data, 'base64')));
    void session.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
  });
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 64, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 2 });
}
async function endRecording() {
  if (!recording) return;
  await session.send('Page.stopScreencast'); const end = Date.now(); await Promise.all(frameWrites); await session.detach();
  const name = recording; recording = null; assert.ok(frames.length > 5, 'actual browser frames');
  const file = path.join(out, name + '.ffconcat'), lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    lines.push("file '" + f.file.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'");
    lines.push('duration ' + Math.max(.001, ((frames[i + 1]?.time || end) - f.time) / 1000).toFixed(6));
  });
  lines.push("file '" + frames.at(-1).file.replaceAll('\\', '/') + "'"); await fs.writeFile(file, lines.join('\n') + '\n');
  const ffmpeg = process.env.FFMPEG_EXECUTABLE || path.join(root, 'video_ar_backend/tools/FFmpeg/bin/ffmpeg.exe');
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', file, '-vf', 'fps=24,format=yuv420p', '-c:v', 'libopenh264', '-b:v', '5M', '-movflags', '+faststart', path.join(out, name + '.mp4')], { windowsHide: true });
    let errors = ''; proc.stderr.on('data', d => errors += d); proc.on('error', reject); proc.on('exit', code => code === 0 ? resolve() : reject(Error(errors)));
  });
  report.recordings ??= []; report.recordings.push({ file: name + '.mp4', actualDurationMs: end - recordStart, capturedFrames: frames.length, encodedFps: 24, note: '真实浏览器录制；编码24fps不是平台性能' });
}
async function settle() {
  await page.waitForFunction(() => !__safetyWorkspace.options.viewer.camera._currentFlight);
  await page.waitForFunction(() => __safetyWorkspace.runtimeModels().length && __safetyWorkspace.runtimeModels().every(m => m.tileset.tilesLoaded), null, { timeout: 120000 });
  await page.waitForTimeout(600);
}
async function recordState() {
  return page.evaluate(() => {
    const w = __safetyWorkspace, p = w.effects.presentation, v = w.options.viewer;
    const properties = [], visited = new Set();
    function walk(object) {
      if (!object || visited.has(object)) return; visited.add(object);
      const uniforms = object.appearance?.material?.uniforms;
      if (uniforms && (Number.isFinite(uniforms.seconds) || Number.isFinite(uniforms.glowPower))) {
        properties.push({ kind: 'delay' in uniforms ? 'pulse-ring' : 'tailLength' in uniforms ? 'flow-route' : 'selection-outline', visible: object.show,
          uniforms: Object.fromEntries(Object.entries(uniforms).filter(([, value]) => typeof value === 'number')),
          matrix: object.modelMatrix ? Array.from(object.modelMatrix) : null });
      }
      if (typeof object.length === 'number' && typeof object.get === 'function') for (let i = 0; i < object.length; i++) walk(object.get(i));
    }
    for (const object of p.controller?.samplingExclusions() || []) walk(object);
    const time = v.clock.currentTime;
    const businessWidths = [...w.spatial.entities.values()].filter(e => e.show && e.polyline).map(e => ({id:e.id,width:e.polyline.width.getValue(time)}));
    const baseLines = (p.controller?.samplingExclusions() || []).filter(e => e.polyline).map(e => ({id:e.id,width:e.polyline.width.getValue(time)}));
    const outline = p.worldEffects.get('selected-outline')?.positions || [], focus = p.focusPosition;
    const anchors = [...(focus ? [focus] : []), ...outline.filter((_, i) => i === 0 || i === Math.floor(outline.length / 4))];
    return { businessWidths, baseLines, presentation: p.debugStats(), actualUniforms: properties, state: structuredClone(w.store.state),
      labels: { total: w.effects.debugStats().visibleLabels, node: w.effects.debugStats().visibleNodeLabels, device: w.effects.debugStats().visibleDeviceLabels, limit: w.effects.debugStats().labelLimit },
      modelMatrices: w.runtimeModels().map(m => ({ id: m.assetId, matrix: Array.from(m.tileset.modelMatrix) })),
      worldAnchors: anchors.map(p => ({ x: p.x, y: p.y, z: p.z })),
      screenAnchors: anchors.map(p => { const s = v.scene.cartesianToCanvasCoordinates(p); return s ? { x: s.x, y: s.y } : null; }),
      route: p.worldEffects.get('actual-flight-route')?.positions.map(p => ({ x: p.x, y: p.y, z: p.z })) || [],
      effectStats: w.effects.debugStats(), camera: { position: { ...v.camera.positionWC }, direction: { ...v.camera.directionWC }, up: { ...v.camera.upWC } } };
  });
}
function checkBudget(value, overview) {
  assert.equal(value.labels.total, value.labels.node + value.labels.device);
  assert.ok(value.labels.total <= (overview ? 8 : 5)); assert.equal(value.labels.limit, overview ? 8 : 5);
  assert.equal(value.presentation.status.ok, true, 'presentation ownership/render status must stay healthy');
  const effects = value.presentation.effects.effects;
  assert.ok(effects.length <= 3); assert.ok(effects.filter(e => e.visible).length <= 3);
  assert.equal(value.presentation.effects.clockOwner, 'host');
  assert.equal(value.presentation.basePrimitives, 5, 'V5 independent skirt/bottom/three edges remain present');
  assert.deepEqual(value.effectStats.labelFontPixels, { ordinary: 12, section: 13, selected: 14 });
  assert.ok(value.businessWidths.every(line => line.width === 2 || line.width === 3), 'business boundaries use 2px / 3px');
  assert.equal(value.effectStats.visibleActualTrackSegments, 0, 'actual tracks with unverified heights remain hidden');
  assert.equal(value.effectStats.visibleDeviceIds.length, 0, 'unverified 3D device marker is not fabricated');
  assert.equal(value.effectStats.decoratedRouteVertexCount, 0);
  assert.deepEqual(value.route, []);
  assert.ok(!effects.some(e => e.id === 'actual-flight-route' && e.visible), 'no cross-scene flight route in overview or manual-object focus');
}
async function captureRaw(name) {
  const data = await page.evaluate(() => { const v = __safetyWorkspace.options.viewer; v.scene.requestRender(); v.render(); return v.canvas.toDataURL('image/png'); });
  assert.ok(data.startsWith('data:image/png;base64,'));
  const bytes = Buffer.from(data.split(',')[1], 'base64'); assert.ok(bytes.length > 10000, 'actual model image, not an empty capture');
  const file = path.join(out, name + '.png'); await fs.writeFile(file, bytes); return { file, sha256: digest(bytes) };
}
function comparePixels(a, b) {
  const python = process.env.PYTHON_EXECUTABLE || path.join(root, 'ar_v2/.venv/Scripts/python.exe');
  const script = 'from PIL import Image,ImageChops,ImageStat\nimport json,sys\na=Image.open(sys.argv[1]).convert("RGB");b=Image.open(sys.argv[2]).convert("RGB")\nassert a.size==b.size\nd=ImageChops.difference(a,b);s=ImageStat.Stat(d);h=d.convert("L").histogram()\nprint(json.dumps({"width":a.width,"height":a.height,"meanChannelDelta":sum(s.mean)/3,"fractionAbove2":sum(h[3:])/(a.width*a.height),"maximumDelta":max(x[1] for x in s.extrema)}))';
  const result = spawnSync(python, ['-c', script, a.file, b.file], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); const metrics = JSON.parse(result.stdout);
  assert.ok(metrics.meanChannelDelta <= .03 && metrics.fractionAbove2 <= .001, 'Paused scene pixels continued changing: ' + JSON.stringify(metrics));
  return { before: path.basename(a.file), after: path.basename(b.file), beforeSha256: a.sha256, afterSha256: b.sha256,
    ...metrics, tolerances: { meanChannelDelta: .03, fractionAbove2: .001 }, scope: 'raw existing Viewer canvas, excluding changing HTML clock; minor GPU raster differences only' };
}
async function orbit(degrees, rangeScale = 1) {
  await page.evaluate(async ({ bridge, degrees, rangeScale }) => {
    const C = await import(bridge), w = __safetyWorkspace, v = w.options.viewer;
    const center = C.Cartesian3.clone(w.effects.presentation.focusPosition), camera = v.camera;
    const range = C.Cartesian3.distance(camera.positionWC, center) * rangeScale;
    camera.cancelFlight(); camera.lookAt(center, new C.HeadingPitchRange(camera.heading + C.Math.toRadians(degrees), camera.pitch, range));
    camera.lookAtTransform(C.Matrix4.IDENTITY); v.scene.requestRender();
  }, { bridge, degrees, rangeScale });
  await settle();
}
function assertWorldAnchored(a, b) {
  assert.deepEqual(b.worldAnchors, a.worldAnchors); assert.deepEqual(b.modelMatrices, a.modelMatrices); assert.deepEqual(b.route, a.route);
  const deltas = a.screenAnchors.map((s, i) => s && b.screenAnchors[i] ? Math.hypot(s.x - b.screenAnchors[i].x, s.y - b.screenAnchors[i].y) : 0);
  assert.ok(Math.max(...deltas) > 5, 'World outline should move in screen coordinates during camera change'); return deltas;
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(root, bridge.slice(1)), 'export {Cartesian3,Matrix4,HeadingPitchRange,Math} from "cesium";\n');
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    for (const pattern of ['**/__library/**', '**/__safety/**']) await context.route(pattern, route => {
      if (['GET', 'HEAD'].includes(route.request().method())) return route.continue();
      const request = { url: route.request().url(), method: route.request().method() };
      if (request.url.includes('/__library/')) { report.blockedLibraryWrites.push(request); return route.fulfill({ json: { ok: true } }); }
      report.blockedWrites.push(request);
      return route.fulfill({ status: 503, json: { error: '只读动效验收禁止写入', code: 'MOTION_TEST_WRITE_BLOCKED' } });
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(base + '/?screen=safety', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__safetyWorkspace?.debugStats().effects.presentation.v4?.scene?.mode === 'showcase', null, { timeout: 180000 });
    await settle();
    await page.evaluate(() => { window.__motionRenderErrors = []; window.__motionRemoveError = __safetyWorkspace.options.viewer.scene.renderError.addEventListener((_scene, error) => __motionRenderErrors.push(String(error?.message || error))); });
    // Known preference baseline through the actual settings controls, leaving business data untouched.
    await act('settings').click(); await page.locator('[data-action="preference-font"]').uncheck();
    await page.locator('[data-action="preference-motion"]').uncheck(); await page.locator('[data-action="popover-close"]').last().click();
    const original = await page.evaluate(() => ({ snapshot: __safetyWorkspace.spatial.getSnapshot(), tracks: structuredClone(__safetyWorkspace.store.dataset.devices.map(d => ({ id: d.id, track: d.track }))) }));
    assert.equal(original.tracks.reduce((sum, d) => sum + d.track.length, 0), 3467, 'real project source track retained');
    const object = original.snapshot.objects.find(o => !o.deletedAt && o.kind === 'risk-point' && o.creationSource === 'user_drawn_model_surface')
      || original.snapshot.objects.find(o => !o.deletedAt && o.kind === 'construction-area' && o.creationSource === 'user_drawn_model_surface');
    assert.ok(object, 'Run actual-model main workflow first; no synthetic fallback objects');
    const overview = await recordState(); checkBudget(overview, true);
    check('项目总览最多8个标签、五项底座实体；高程未核验设备航迹隐藏，共用宿主时钟', { labels: overview.labels, effects: overview.presentation.effects });
    await act('authoring').click(); await page.locator(`[data-spatial="select"][data-id="${object.id}"]`).click(); await settle(); await spatial('close').click();
    await settle(); await page.waitForTimeout(1500);
    const selected = await recordState(); checkBudget(selected, false);
    assert.equal((await stats()).data.selectedId, 'spatial:' + object.id);
    assert.ok(selected.presentation.effects.effects.some(e => e.id === 'selected-pulse' && e.visible));
    assert.ok(selected.presentation.effects.effects.some(e => e.id === 'selected-outline' && e.visible));
    assert.equal(selected.effectStats.schematicLinks, 0);
    assert.ok(selected.actualUniforms.some(u => u.kind === 'pulse-ring' && u.visible));
    assert.ok(selected.actualUniforms.some(u => u.kind === 'selection-outline' && u.visible));
    report.before = { businessSnapshotSha256: digest(JSON.stringify(original.snapshot)), tracksSha256: digest(JSON.stringify(original.tracks)), modelMatrices: selected.modelMatrices, selection: object.id };
    check('选中真实模型人工对象：局部脉冲与描边可见；高程未核验航迹保持隐藏，3467源点保留', { labels: selected.labels, effects: selected.presentation.effects, sourceTrackCount: 3467, visibleTrackSegments: selected.effectStats.visibleActualTrackSegments, fonts:selected.effectStats.labelFontPixels, businessWidths:selected.businessWidths, baseLines:selected.baseLines });
    await act('settings').click(); await page.locator('[data-action="preference-motion"]').uncheck(); await page.locator('[data-action="popover-close"]').last().click();
    if ((await stats()).data.state.animationPaused) await act('motion-toggle').click();
    await page.waitForFunction(() => !__safetyWorkspace.effects.presentation.debugStats().effects.paused && !__safetyWorkspace.effects.presentation.debugStats().effects.reducedMotion);
    await caption('真实位置动效 · 人工对象轮廓与局部脉冲，原始航迹数据保留'); await beginRecording('05-world-effects');
    const motionStart = Date.now(), first = await recordState(); await page.screenshot({ path: path.join(out, 'motion-01-focused.png') });
    await page.waitForTimeout(4300);
    const flowing = await recordState(); assert.ok(flowing.presentation.effects.elapsedSeconds > first.presentation.effects.elapsedSeconds + 3);
    assert.ok(flowing.actualUniforms.some(u => u.kind === 'pulse-ring' && u.uniforms.seconds > first.actualUniforms.find(v => v.kind === 'pulse-ring')?.uniforms.seconds + 3), 'actual material seconds advanced');
    await caption('旋转约30°：轮廓随真实位置变化，不粘在屏幕上'); await orbit(30);
    const rotated = await recordState(); checkBudget(rotated, false); const rotationMovementPx = assertWorldAnchored(first, rotated);
    await page.screenshot({ path: path.join(out, 'motion-02-rotated.png') }); await page.waitForTimeout(4300);
    await caption('缩放场景：世界锚点不变，真实工程坐标不动'); await orbit(0, .82);
    const zoomed = await recordState(); checkBudget(zoomed, false); const zoomMovementPx = assertWorldAnchored(rotated, zoomed);
    await page.screenshot({ path: path.join(out, 'motion-03-zoomed.png') });
    await page.waitForTimeout(Math.max(3300, 13000 - (Date.now() - motionStart)));
    check('至少13秒实际三维动效与旋转缩放，世界坐标固定、屏幕投影随镜头变化', { elapsedMs: Date.now() - motionStart, rotationMovementPx, zoomMovementPx });
    await caption('点击暂停装饰：观察3秒，实际材质时间和三维画面稳定'); await act('motion-toggle').click();
    await page.waitForFunction(() => __safetyWorkspace.effects.presentation.debugStats().effects.paused); await settle();
    const pausedA = await recordState(), pauseImageA = await captureRaw('motion-04-paused-start');
    assert.ok(pausedA.actualUniforms.some(u => u.kind === 'pulse-ring') && pausedA.actualUniforms.some(u => u.kind === 'selection-outline'), 'actual pulse animation and static selected-outline materials are both inspected');
    assert.ok(pausedA.actualUniforms.every(u => u.visible), 'the checked animation materials belong to visible primitives');
    await page.waitForTimeout(3200);
    const pausedB = await recordState(), pauseImageB = await captureRaw('motion-05-paused-after-3s');
    assert.deepEqual(pausedB.actualUniforms, pausedA.actualUniforms); assert.equal(pausedB.presentation.effects.elapsedSeconds, pausedA.presentation.effects.elapsedSeconds);
    assert.equal(pausedB.state.time, pausedA.state.time); assert.equal(pausedB.state.playing, false);
    report.pausePixelComparison = comparePixels(pauseImageA, pauseImageB);
    check('真实暂停按钮停止材质时间至少3秒，像素稳定，未推动真实遥测时标', report.pausePixelComparison);
    await act('motion-toggle').click(); await act('settings').click(); await page.locator('[data-action="preference-motion"]').check(); await page.locator('[data-action="popover-close"]').last().click();
    await page.waitForFunction(() => __safetyWorkspace.effects.presentation.debugStats().effects.reducedMotion);
    await caption('减少动态：关闭周期呼吸，位置与原始轨迹记录保持'); await settle();
    const reducedA = await recordState(), reducedImageA = await captureRaw('motion-06-reduced-start'); await page.waitForTimeout(3200);
    const reducedB = await recordState(), reducedImageB = await captureRaw('motion-07-reduced-after-3s');
    assert.deepEqual(reducedB.actualUniforms, reducedA.actualUniforms); assert.equal(reducedB.presentation.effects.elapsedSeconds, reducedA.presentation.effects.elapsedSeconds);
    report.reducedPixelComparison = comparePixels(reducedImageA, reducedImageB);
    check('实际减少动态设置无周期呼吸，3秒材质参数及原三维画面保持', report.reducedPixelComparison);
    await endRecording(); assert.ok(report.recordings[0].actualDurationMs >= 20000);
    const final = await page.evaluate(() => ({ snapshot: __safetyWorkspace.spatial.getSnapshot(), tracks: structuredClone(__safetyWorkspace.store.dataset.devices.map(d => ({ id: d.id, track: d.track }))) }));
    const finalState = await recordState(); assert.deepEqual(final, original); assert.deepEqual(finalState.modelMatrices, selected.modelMatrices); assert.deepEqual(finalState.route, selected.route); checkBudget(finalState, false);
    const response = await context.request.get(base + '/__safety/spatial', { headers: { 'X-Cesium-Library': '1' } }); assert.deepEqual(await response.json(), original.snapshot);
    report.finalState = finalState;
    report.after = { businessSnapshotSha256: digest(JSON.stringify(final.snapshot)), tracksSha256: digest(JSON.stringify(final.tracks)), modelMatrices: finalState.modelMatrices };
    report.renderErrors = await page.evaluate(() => __motionRenderErrors);
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.renderErrors, []); assert.deepEqual(report.blockedWrites, []);
    check('业务快照/原始3467轨迹/模型矩阵逐项不变，零业务写入、零页面/控制台/渲染错误；原工作台视图自动保存已拦截', { blockedViewOrLibraryWrites: report.blockedLibraryWrites.length }); report.result = 'passed';
  } catch (error) {
    report.result = 'failed'; report.failure = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1;
    if (page) { report.lastStats = await stats().catch(() => null); await page.screenshot({ path: path.join(out, 'motion-acceptance-failure.png') }).catch(() => {}); }
  } finally {
    if (recording) await endRecording().catch(error => { report.recordingError = error.message; });
    if (page) await page.evaluate(() => window.__motionRemoveError?.()).catch(() => {});
    await fs.writeFile(path.join(out, 'motion-acceptance-report.json'), JSON.stringify(report, null, 2)); await browser?.close();
  }
})();
