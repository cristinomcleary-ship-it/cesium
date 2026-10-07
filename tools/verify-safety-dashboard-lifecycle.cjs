// Real-library, read-only lifecycle acceptance. Start the ordinary dev server first.
// Library mutations are intercepted before navigation; source metadata is hashed before and after.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/safety-dashboard');
const base = process.env.SAFETY_URL || 'http://127.0.0.1:5173';
const report = { checks: [], timings: {}, errors: [], consoleErrors: [], blockedWrites: [], passed: false };
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const check = (label, detail) => { report.checks.push({ label, detail }); console.log('PASS', label); };
let browser, page, releaseFirstRead;

const action = name => page.locator(`.safety-dashboard [data-action="${name}"]`);
const stats = () => page.evaluate(() => window.__safetyWorkspace?.debugStats());
const waitOpen = () => page.waitForFunction(() => window.__safetyWorkspace?.isOpen
  && window.__safetyWorkspace.debugStats().data?.nodes > 0, null, { timeout: 180000 });
const waitFlight = () => page.waitForFunction(() => !window.__safetyWorkspace.options.viewer.camera._currentFlight,
  null, { timeout: 20000 });

async function openDashboard() {
  await page.locator('#openSafetyWorkspace').click();
  await waitOpen();
  await waitFlight();
}

async function closeDashboard() {
  await action('exit').click();
  await page.waitForFunction(() => !window.__safetyWorkspace.isOpen);
  assert.equal((await stats()).clockListeners, 0);
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const metadata = [path.join(root, 'project-data/view.json')];
  for (const item of await fs.readdir(path.join(root, 'project-data/records'))) {
    metadata.push(path.join(root, 'project-data/records', item, 'record.json'));
  }
  const before = Object.fromEntries(await Promise.all(metadata.map(async file => [file, await hash(file)])));
  const listing = await (await fetch(base + '/__library/records')).json();
  const records = new Map(listing.records.map(record => [record.id, record]));
  const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve; });
  let firstReadHeld = false;
  try {
    browser = await chromium.launch({
      executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await context.route('**/__library/**', async route => {
      const request = route.request();
      if (!['GET', 'HEAD'].includes(request.method())) {
        report.blockedWrites.push({ method: request.method(), url: request.url() });
        const id = new URL(request.url()).pathname.split('/')[3];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(records.get(id) || { ok: true }) });
      }
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/__library/records' && !firstReadHeld) {
        firstReadHeld = true;
        report.firstReadHeldAt = Date.now();
        await firstReadGate;
      }
      return route.continue();
    });

    const startedAt = Date.now();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.locator('#openSafetyWorkspace').waitFor({ state: 'visible' });
    assert.equal(firstReadHeld, true, 'first records request must still be held before the early click');
    await page.evaluate(() => { window.__lifecycleOriginalVideo = document.querySelector('#videoArSourceVideo'); });
    await page.locator('#openSafetyWorkspace').click();
    await page.waitForFunction(() => window.__safetyWorkspace?.isOpen);
    report.beforeLibraryReady = await stats();
    assert.equal(report.beforeLibraryReady.data, null, 'dashboard opened before the library-ready gate released');
    report.firstReadReleasedAt = Date.now();
    releaseFirstRead();
    await waitOpen();
    await page.waitForFunction(() => {
      const ws = window.__safetyWorkspace;
      const video = document.querySelector('#videoArSourceVideo');
      return ws.hasBoundVideo() && !video.hidden && video.videoWidth > 0 && ws.dashboard.videoHost.contains(video);
    }, null, { timeout: 180000 });
    await waitFlight();
    report.timings.earlyOpenToBoundVideoMs = Date.now() - startedAt;
    report.readyBinding = await page.evaluate(() => {
      const ws = window.__safetyWorkspace;
      const video = document.querySelector('#videoArSourceVideo');
      const gl = ws.options.viewer.scene.context._gl;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { sameVideo: video === window.__lifecycleOriginalVideo, bound: ws.hasBoundVideo(),
        source: ws.options.getPlaybackSource(), videoWidth: video.videoWidth, videoHeight: video.videoHeight,
        hidden: video.hidden, nativeControls: video.controls, stats: ws.debugStats(),
        gpu: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable' };
    });
    assert.equal(report.readyBinding.sameVideo, true);
    assert.equal(report.readyBinding.bound, true);
    assert.equal(report.readyBinding.nativeControls, true);
    assert.equal(report.readyBinding.stats.viewerCount, 1);
    assert.equal(report.readyBinding.stats.clockListeners, 1);
    check('首次资料请求被阻塞时提前打开大屏，ready 后绑定同一个真实原视频', {
      videoWidth: report.readyBinding.videoWidth, videoHeight: report.readyBinding.videoHeight,
      elapsedMs: report.timings.earlyOpenToBoundVideoMs, gpu: report.readyBinding.gpu,
    });

    const interactionBefore = await page.evaluate(() => {
      const ws = window.__safetyWorkspace;
      return { camera: ws.options.viewer.camera.position.clone(), matrices: ws.options.getImports()
        .filter(record => record.resource.modelMatrix)
        .map(record => ({ id: record.id, kind: record.kind, values: Array.from({ length: 16 }, (_, index) => record.resource.modelMatrix[index]) })) };
    });
    assert.ok(interactionBefore.matrices.length > 0, 'loaded engineering model matrices are available for comparison');
    const sceneBox = await page.locator('.safety-scene-hud').boundingBox();
    const centerX = sceneBox.x + sceneBox.width / 2;
    const centerY = sceneBox.y + sceneBox.height / 2;
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + 120, centerY + 35, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(previous => {
      const p = window.__safetyWorkspace.options.viewer.camera.position;
      return Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z) > .01;
    }, interactionBefore.camera);
    const afterDrag = await page.evaluate(() => window.__safetyWorkspace.options.viewer.camera.position.clone());
    await page.mouse.move(centerX, centerY);
    await page.mouse.wheel(0, -360);
    await page.waitForFunction(previous => {
      const p = window.__safetyWorkspace.options.viewer.camera.position;
      return Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z) > .01;
    }, afterDrag);
    await page.waitForTimeout(800);
    const interactionAfter = await page.evaluate(() => {
      const ws = window.__safetyWorkspace;
      return { camera: ws.options.viewer.camera.position.clone(), matrices: ws.options.getImports()
        .filter(record => record.resource.modelMatrix)
        .map(record => ({ id: record.id, kind: record.kind, values: Array.from({ length: 16 }, (_, index) => record.resource.modelMatrix[index]) })) };
    });
    assert.deepEqual(interactionAfter.matrices, interactionBefore.matrices);
    check('中央场景真实鼠标拖动与滚轮均改变镜头，工程模型矩阵不变', {
      before: interactionBefore.camera, afterDrag, afterWheel: interactionAfter.camera,
      checkedModelCount: interactionBefore.matrices.length, modelMatricesUnchanged: true,
    });
    await closeDashboard();
    await page.locator('.tab[data-tab="overview"]').click();
    await page.locator('#digitalTwinOverviewHost .is-open').waitFor({ state: 'visible' });
    await openDashboard();
    assert.equal(await page.locator('#digitalTwinOverviewHost .is-open').count(), 0);
    await closeDashboard();
    await page.locator('#digitalTwinOverviewHost .is-open').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.tab[data-tab="overview"]').getAttribute('aria-current'), 'page');
    check('从平台总览进入大屏再退出，原总览可见状态和活动导航恢复');

    await page.locator('.tab[data-tab="sandtable"]').click();
    await page.waitForFunction(() => !document.querySelector('#sandTableStage').hidden);
    const sandTableBefore = await page.locator('#sandTableStage').evaluate(stage => ({ hidden: stage.hidden, ariaHidden: stage.getAttribute('aria-hidden') }));
    await openDashboard();
    assert.equal(await page.locator('#sandTableStage').evaluate(stage => stage.hidden), true);
    await closeDashboard();
    await page.waitForFunction(() => !document.querySelector('#sandTableStage').hidden);
    const sandTableAfter = await page.locator('#sandTableStage').evaluate(stage => ({ hidden: stage.hidden, ariaHidden: stage.getAttribute('aria-hidden') }));
    assert.deepEqual(sandTableAfter, sandTableBefore);
    assert.equal(await page.locator('.tab[data-tab="sandtable"]').getAttribute('aria-current'), 'page');
    check('从电子沙盘进入大屏再退出，沙盘 stage 与活动导航恢复', sandTableAfter);

    await openDashboard();
    const sourceBeforeClear = await page.evaluate(() => window.__safetyWorkspace.options.getPlaybackSource());
    await action('video-settings').click();
    await page.waitForFunction(() => !window.__safetyWorkspace.isOpen);
    assert.equal(await page.locator('.tab[data-tab="videoar"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.evaluate(() => document.querySelector('#videoArPreview').contains(window.__lifecycleOriginalVideo)), true);
    await page.locator('#videoArClear').click();
    await page.waitForFunction(() => !window.__safetyWorkspace.options.getPlaybackSource().url);
    const sourceAfterClear = await page.evaluate(() => window.__safetyWorkspace.options.getPlaybackSource());
    assert.ok(sourceAfterClear.generation > sourceBeforeClear.generation);
    await openDashboard();
    await page.waitForFunction(() => !window.__safetyWorkspace.hasBoundVideo()
      && document.querySelector('#videoArSourceVideo').hidden);
    const cleared = await page.evaluate(() => {
      const ws = window.__safetyWorkspace;
      const video = document.querySelector('#videoArSourceVideo');
      return { sameVideo: video === window.__lifecycleOriginalVideo, hidden: video.hidden,
        currentSrc: video.currentSrc, srcAttribute: video.getAttribute("src"), paused: video.paused, readyState: video.readyState, networkState: video.networkState, currentTime: video.currentTime, bound: ws.hasBoundVideo(),
        boundSourceKey: ws.boundSourceKey, source: ws.options.getPlaybackSource(),
        status: document.querySelector('[data-ref="videoStatus"]').textContent,
        retainedLibraryTrackPoints: ws.debugStats().effects.actualTrackVertices };
    });
    assert.equal(cleared.sameVideo, true);
    assert.equal(cleared.hidden, true);
    assert.equal(cleared.bound, false);
    assert.equal(cleared.boundSourceKey, '');
    assert.equal(cleared.srcAttribute, null);
    assert.equal(cleared.paused, true);
    assert.equal(cleared.source.url, '');
    assert.match(cleared.status, /暂无可播放/);
    check('原视频关闭后重新进入大屏：失效原片隐藏，媒体身份绑定被清除', cleared);

    // A stale native event or timeline seek must not resurrect the cleared media/track binding.
    await page.evaluate(() => {
      const video = document.querySelector('#videoArSourceVideo');
      video.dispatchEvent(new Event('play'));
    });
    assert.equal((await stats()).data.state.playing, false);
    const targetTime = await page.evaluate(() => window.__safetyWorkspace.store.state.timeRange[0] + 5000);
    await action('time').evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, targetTime);
    const afterStaleEvents = await page.evaluate(() => {
      const ws = window.__safetyWorkspace;
      const video = document.querySelector('#videoArSourceVideo');
      return { bound: ws.hasBoundVideo(), playing: ws.store.state.playing,
        timeline: ws.store.state.time, currentTime: video.currentTime, hidden: video.hidden, currentSrc: video.currentSrc, srcAttribute: video.getAttribute("src") };
    });
    assert.equal(afterStaleEvents.bound, false);
    assert.equal(afterStaleEvents.playing, false);
    assert.equal(afterStaleEvents.currentTime, cleared.currentTime);
    assert.equal(afterStaleEvents.srcAttribute, null);
    assert.equal(afterStaleEvents.hidden, true);
    check('失效视频事件与共享时间轴 seek 不会重新使用旧媒体身份驱动航迹时间', afterStaleEvents);
    report.note = '已保存的真实轨迹仍可作为独立工程资料存在；本验收检查失效视频不再参与媒体/航迹时间绑定。关闭回放只改变当前测试浏览器内存，所有持久化写请求均被拦截。';
    report.finalState = await stats();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.consoleErrors, []);
    check('生命周期边界流程无页面异常和控制台错误');
    report.passed = true;
  } catch (error) {
    report.failure = error.stack;
    console.error(error);
    report.failedState = await stats().catch(() => null);
    process.exitCode = 1;
  } finally {
    releaseFirstRead?.();
    await browser?.close();
    const after = Object.fromEntries(await Promise.all(metadata.map(async file => [file, await hash(file)])));
    report.sourceMetadataUnchanged = JSON.stringify(before) === JSON.stringify(after);
    report.metadataHashes = { before, after };
    if (!report.sourceMetadataUnchanged) { report.passed = false; process.exitCode = 1; }
    await fs.writeFile(path.join(out, 'lifecycle-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, errors: report.errors,
      consoleErrors: report.consoleErrors, sourceMetadataUnchanged: report.sourceMetadataUnchanged,
      blockedWriteCount: report.blockedWrites.length }));
  }
})();
