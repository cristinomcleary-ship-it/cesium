// Real-library, read-only end-to-end acceptance. All library writes are intercepted.
// Start the ordinary dev server first; set SAFETY_URL / PLAYWRIGHT_MODULE if required.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'output/safety-dashboard');
const base = process.env.SAFETY_URL || 'http://127.0.0.1:5173';
const report = { checks: [], timings: {}, errors: [], consoleErrors: [], blockedWrites: [], resources: [] };
const check = (label, detail) => { report.checks.push({ label, detail }); console.log('PASS', label); };
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
let browser, page;
const snapshot = () => page.evaluate(() => window.__safetyWorkspace.debugStats());
const action = name => page.locator(`.safety-dashboard [data-action="${name}"]`);
const settle = () => page.waitForFunction(() => !window.__safetyWorkspace.options.viewer.camera._currentFlight, null, { timeout: 15000 });
async function filterAgreement() {
  const evidence = await page.evaluate(() => {
    const ws = window.__safetyWorkspace, stats = ws.debugStats();
    return { ids: [...document.querySelectorAll('[data-ref="alerts"] [data-alert]')].map(e => e.dataset.alert), stats,
      pieTotal: ws.dashboard.distribution.getOption().series[0].data.reduce((n, d) => n + d.value, 0),
      trendTotal: ws.dashboard.trend.getOption().series[0].data.reduce((n, d) => n + d.value, 0) };
  });
  assert.deepEqual(evidence.ids.sort(), evidence.stats.data.alerts.slice().sort());
  assert.equal(evidence.pieTotal, evidence.ids.length); assert.equal(evidence.trendTotal, evidence.ids.length);
  assert.ok(evidence.stats.effects.visibleNodeIds.every(id => evidence.stats.data.nodeIds.includes(id)));
  return { alerts: evidence.ids.length, visibleNodes: evidence.stats.effects.visibleNodeIds.length };
}
async function inputValue(selector, value, event = 'input') {
  await page.locator(selector).evaluate((el, [v, name]) => { el.value = String(v); el.dispatchEvent(new Event(name, { bubbles: true })); }, [value, event]);
}
async function memory(label) {
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage');
  const values = await session.send('Runtime.getHeapUsage'); await session.detach();
  const stats = await snapshot(); report.resources.push({ label, heapBytes: values.usedSize, effects: stats.effects, ui: stats.ui, clockListeners: stats.clockListeners });
  return { values, stats };
}
(async () => {
  await fs.mkdir(out, { recursive: true });
  const metadata = [path.join(root, 'project-data/view.json')];
  for (const item of await fs.readdir(path.join(root, 'project-data/records'))) metadata.push(path.join(root, 'project-data/records', item, 'record.json'));
  const before = Object.fromEntries(await Promise.all(metadata.map(async file => [file, await hash(file)])));
  const listing = await (await fetch(base + '/__library/records')).json();
  const records = new Map(listing.records.map(record => [record.id, record]));
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await context.route('**/__library/**', async route => {
      const request = route.request(); if (['GET', 'HEAD'].includes(request.method())) return route.continue();
      report.blockedWrites.push({ method: request.method(), url: request.url() });
      const id = new URL(request.url()).pathname.split('/')[3], record = records.get(id);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(record || { ok: true }) });
    });
    const started = Date.now();
    await page.goto(base + '/?screen=safety', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__safetyWorkspace?.isOpen && window.__safetyWorkspace.debugStats().data?.nodes > 0, null, { timeout: 180000 });
    await settle(); report.timings.firstDashboardMs = Date.now() - started;
    await page.waitForTimeout(1600);
    report.initial = await snapshot();
    assert.equal(report.initial.viewerCount, 1); assert.equal(report.initial.clockListeners, 1);
    assert.equal(report.initial.effects.actualTrackVertices, 3467);
    assert.equal(report.initial.data.nodes, 227);
    check('真实库载入：单 Viewer、共享时钟、227 个导航对象和3467个实录轨迹坐标', report.initial.effects);
    report.environment = await page.evaluate(() => {
      const viewer = window.__safetyWorkspace.options.viewer, gl = viewer.scene.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable', videoWidth: document.querySelector('#videoArSourceVideo').videoWidth };
    });
    await page.screenshot({ path: path.join(out, 'dashboard-overview-1920.png') });
    check('图表、告警列表和场景筛选集一致', await filterAgreement());
    await page.evaluate(() => { window.__originalSafetyVideo = document.querySelector('#videoArSourceVideo'); });
    const navStarted = Date.now();
    await page.locator('[data-ref="hierarchy"] [data-node]:not(.is-selected)').first().click(); await settle();
    assert.equal(await page.evaluate(() => __safetyWorkspace.store.view.selected.kind), 'section');
    await page.screenshot({ path: path.join(out, 'dashboard-section-1920.png') });
    await page.locator('[data-ref="hierarchy"] [data-node]:not(.is-selected)').first().click(); await settle();
    assert.equal(await page.evaluate(() => __safetyWorkspace.store.view.selected.kind), 'pier');
    await page.locator('[data-ref="hierarchy"] [data-node]:not(.is-selected)').first().click(); await settle();
    assert.equal(await page.evaluate(() => __safetyWorkspace.store.view.selected.kind), 'component');
    await page.locator('[data-ref="breadcrumbs"] [data-node]').first().click(); await settle();
    report.timings.fourHierarchyFlightsMs = Date.now() - navStarted;
    check('项目→区段→墩组→构件→项目返回可用', { elapsedMs: report.timings.fourHierarchyFlightsMs });
    const alert = await page.locator('[data-ref="alerts"] [data-alert]').first().evaluate(el => ({ id: el.dataset.alert, node: el.dataset.node }));
    const oldCamera = await page.evaluate(() => __safetyWorkspace.options.viewer.camera.position.clone());
    await page.locator(`[data-alert="${alert.id}"]`).click(); await settle();
    const selected = await snapshot();
    assert.equal(selected.data.selectedId, alert.node); assert.equal(selected.data.state.selectedAlertId, alert.id);
    assert.equal(selected.effects.selectedNodeId, alert.node);
    assert.match(await page.locator('[data-ref="detail"]').textContent(), /演示|整改|处置/);
    assert.ok(await page.locator('[data-ref="media"] .safety-media-item').count() > 0);
    assert.notDeepEqual(await page.evaluate(() => __safetyWorkspace.options.viewer.camera.position.clone()), oldCamera);
    await page.locator('[data-ref="videoChoices"] [data-media]').first().click();
    assert.equal(await page.evaluate(() => document.querySelector('#videoArSourceVideo') === window.__originalSafetyVideo), true);
    await page.screenshot({ path: path.join(out, 'dashboard-alert-13-1.png') });
    check('真实 CAD 点13-1：演示告警→镜头→选中高亮→详情→项目原视频联动', { alert, selectedName: await page.locator('[data-ref="selectedName"]').textContent(), media: await page.locator('[data-ref="media"]').textContent() });
    await page.locator('[data-ref="breadcrumbs"] [data-node]').first().click(); await settle();
    await action('severity').selectOption('high'); check('高风险筛选一致', await filterAgreement());
    await action('include-demo').uncheck(); const realOnly = await filterAgreement(); assert.equal(realOnly.alerts, 0); check('关闭演示后无虚构真实告警', realOnly);
    await action('include-demo').check(); await action('severity').selectOption('all');
    const chart = page.locator('[data-ref="distribution"]'); await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox(); await page.mouse.click(box.x + box.width / 2 + box.height * .25, box.y + box.height * .25);
    await page.waitForFunction(() => __safetyWorkspace.store.state.severity !== 'all');
    check('鼠标点击环图反向筛选列表与场景', await filterAgreement());
    await action('severity').selectOption('all');
    const extent = await page.evaluate(() => __safetyWorkspace.store.dataset.timeExtent);
    await page.locator('.safety-time-popover summary').click();
    await inputValue('[data-action="range-end"]', Math.floor((extent[0] + extent[1]) / 2), 'change');
    const half = await filterAgreement(); assert.ok(half.alerts < 6); check('时间范围同步过滤图表、列表、场景', half);
    await action('range-reset').click(); await page.locator('.safety-time-popover summary').click();
    await page.locator('.safety-layer-popover summary').click();
    await page.locator('[data-action="effect-layer"][data-layer="heat"]').check();
    await page.waitForTimeout(900); assert.equal((await snapshot()).effects.heatVisible, true);
    await inputValue('[data-action="opacity"]', .4); assert.equal((await snapshot()).data.state.heatOpacity, .4);
    const layer = page.locator('[data-action="library-layer"]:checked').first(), id = await layer.getAttribute('data-layer');
    await page.locator(`[data-action="library-layer"][data-layer="${id}"]`).uncheck(); assert.equal(await page.evaluate(id => __safetyWorkspace.options.getImports().find(r => r.id === id).resource.show, id), false);
    await page.locator(`[data-action="library-layer"][data-layer="${id}"]`).check();
    assert.equal(await page.evaluate(id => __safetyWorkspace.options.getImports().find(r => r.id === id).resource.show, id), true);
    await page.locator('.safety-layer-popover summary').click();
    check('热力、透明度、原有工程图层显隐可用，原资料只读保护开启');
    await action('mode').filter({ hasText: '现场巡检' }).click(); assert.equal((await snapshot()).data.state.mode, 'inspection');
    await page.screenshot({ path: path.join(out, 'dashboard-inspection-1920.png') });
    await action('mode').filter({ hasText: '汇报展示' }).click();
    await inputValue('[data-action="time"]', extent[0] + 10000);
    const timeBefore = await page.evaluate(() => document.querySelector('#videoArSourceVideo').currentTime);
    await action('play').click(); await page.waitForTimeout(1500); await action('play').click();
    const timeAfter = await page.evaluate(() => document.querySelector('#videoArSourceVideo').currentTime);
    assert.ok(timeAfter > timeBefore + .7); assert.ok(Math.abs((await snapshot()).data.state.time - (extent[0] + timeAfter * 1000)) < 250);
    check('真实3840视频播放与实际无人机回放时标同步', { timeBefore, timeAfter });
    await inputValue('[data-action="time"]', extent[1] - 500); await action('play').click(); await page.waitForTimeout(1700);
    assert.equal((await snapshot()).data.state.playing, false);
    check('范围尾端停止，不将航迹外推');
    await action('earth').click(); await settle(); assert.ok(await page.evaluate(() => __safetyWorkspace.options.viewer.camera.positionCartographic.height > 10000000));
    await action('locate').click(); await settle();
    await action('cruise').click(); await page.waitForTimeout(2200); assert.equal((await snapshot()).data.state.cruise, true);
    assert.notEqual((await snapshot()).data.selectedId, await page.evaluate(() => __safetyWorkspace.store.dataset.projectId));
    await action('cruise').click(); check('地球返回与自动巡游镜头切换正常');
    const videoBeforeExit = await page.evaluate(() => document.querySelector('#videoArSourceVideo').currentTime);
    await action('video-settings').click();
    assert.equal(await page.locator('.tab[data-tab="videoar"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.evaluate(() => document.querySelector('#videoArPreview').contains(window.__originalSafetyVideo)), true);
    assert.ok(Math.abs(await page.evaluate(() => document.querySelector('#videoArSourceVideo').currentTime) - videoBeforeExit) < .005);
    check('返回原视频AR：原video节点恢复、时刻未按比例错移');
    await page.locator('.tab[data-tab="cad"]').click();
    await page.locator('#openSafetyWorkspace').click(); await settle();
    const stable = await memory('before20Cycles');
    for (let i = 0; i < 20; i++) {
      await action('exit').click(); const closed = await snapshot(); assert.equal(closed.clockListeners, 0); assert.equal(closed.effects.active, false);
      await page.locator('#openSafetyWorkspace').click();
      await page.waitForFunction(() => __safetyWorkspace.isOpen);
      if (i % 5 === 4) await memory(`cycle${i + 1}`);
    }
    await settle(); const final = await snapshot();
    assert.equal(final.effects.entities, stable.stats.effects.entities); assert.equal(final.effects.dataSources, 1);
    assert.equal(final.ui.chartCount, 2); assert.equal(final.clockListeners, 1); assert.equal(final.effects.pickHandlers, 1); assert.equal(final.videoElements, stable.stats.videoElements);
    check('20次大屏/工作台切换：单Viewer、单视频、实体/图表/监听器数量稳定', { before: stable.stats.effects.entities, after: final.effects.entities });
    await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(500);
    const layout = await page.evaluate(() => { const left = document.querySelector('.safety-left').getBoundingClientRect(), right = document.querySelector('.safety-right').getBoundingClientRect(); return { freeWidth: right.left - left.right, centerTag: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName, overflow: document.documentElement.scrollWidth > innerWidth }; });
    assert.ok(layout.freeWidth >= 600); assert.equal(layout.overflow, false); assert.equal(layout.centerTag, 'CANVAS');
    await page.screenshot({ path: path.join(out, 'dashboard-1366.png') }); check('1366×768中央可操作区域与面板布局', layout);
    report.timings.frameCadence = await page.evaluate(() => new Promise(resolve => { const samples = []; let previous = performance.now(); const frame = now => { samples.push(now - previous); previous = now; if (samples.length >= 90) { const sorted = samples.slice(5).sort((a, b) => a - b); resolve({ medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], note: 'Headless Edge rAF cadence on this machine; not a production FPS guarantee' }); } else requestAnimationFrame(frame); }; requestAnimationFrame(frame); }));
    await action('exit').click(); await page.waitForTimeout(250);
    assert.equal((await snapshot()).clockListeners, 0);
    assert.equal(report.errors.length, 0); assert.equal(report.consoleErrors.filter(e => /render error|InvalidState|DeveloperError|RuntimeError/i.test(e)).length, 0);
    check('原工作台可恢复，无持续 Cesium 渲染异常');
    report.passed = true;
  } catch (error) {
    report.failure = error.stack; console.error(error);
    if (page) { await page.screenshot({ path: path.join(out, 'dashboard-failure.png') }).catch(() => {}); report.failedState = await snapshot().catch(() => null); }
    process.exitCode = 1;
  } finally {
    await browser?.close();
    const after = Object.fromEntries(await Promise.all(metadata.map(async file => [file, await hash(file)])));
    report.sourceMetadataUnchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!report.sourceMetadataUnchanged) { report.passed = false; process.exitCode = 1; }
    await fs.writeFile(path.join(out, 'integration-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, timings: report.timings, errors: report.errors, consoleErrors: report.consoleErrors, sourceMetadataUnchanged: report.sourceMetadataUnchanged }));
  }
})();
