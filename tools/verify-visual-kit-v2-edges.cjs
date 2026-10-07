// Supplemental checks after verify-visual-kit-v2.cjs, against the SAME isolated spatial-data server.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), base = process.env.VISUAL_URL || 'http://127.0.0.1:5195';
const output = path.join(root, 'output/visual-kit-v2/edge-acceptance-report.json');
const report = { checks: [], pageErrors: [], consoleErrors: [] };
let browser, page;
const action = name => page.locator(`.safety-dashboard [data-action="${name}"]`);
const spatial = name => page.locator(`.safety-spatial-editor [data-spatial="${name}"]`);
const field = name => page.locator(`.safety-spatial-editor [data-spatial-field="${name}"]`);
const check = (name, data) => { report.checks.push({ name, data }); console.log('PASS', name); };
const settle = async () => { await page.waitForFunction(() => !__safetyWorkspace.options.viewer.camera._currentFlight); await page.waitForTimeout(300); };
async function snapshot() { return page.evaluate(() => __safetyWorkspace.spatial.getSnapshot()); }
async function counts(riskId) {
  return page.evaluate(id => {
    const w = __safetyWorkspace, v = w.store.view;
    return {
      selected: v.selected.id,
      alerts: v.alerts.length,
      list: document.querySelectorAll('[data-ref=alerts] [data-alert]').length,
      chart: w.dashboard.distribution.getOption().series[0].data.reduce((s, p) => s + p.value, 0),
      riskInView: v.nodes.some(n => n.spatialObjectId === id),
      riskEntityShown: w.spatial.entities.get(id)?.show,
      contextKinds: v.nodes.filter(n => n.spatialKind).map(n => n.spatialKind),
    };
  }, riskId);
}
(async () => {
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.route('**/__library/**', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.fulfill({ json: { ok: true } }));
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', e => report.pageErrors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
    await page.goto(base + '/?screen=safety', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__safetyWorkspace?.store?.dataset.nodes.length > 0 && __safetyWorkspace.spatial.getSnapshot().objects.length === 3, null, { timeout: 180000 });
    await settle();
    const original = await snapshot();
    assert.ok(original.objects.every(o => o.name.startsWith('验收示例')), 'Use only isolated acceptance objects');
    const risk = original.objects.find(o => o.kind === 'risk-point');
    const area = original.objects.find(o => o.kind === 'construction-area');
    await action('include-demo').uncheck();
    await action('authoring').click();
    await page.locator(`[data-spatial=select][data-id="${risk.id}"]`).click(); await settle();
    await spatial('close').click();
    await page.locator('.safety-time-popover summary').click();
    const oldVideoEnd = await page.evaluate(() => __safetyWorkspace.store.dataset.devices[0].track.at(-1).time);
    await action('range-end').fill(String(oldVideoEnd)); await action('range-end').dispatchEvent('change');
    let state = await counts(risk.id);
    assert.equal(state.alerts, 0); assert.equal(state.list, 0); assert.equal(state.chart, 0);
    assert.equal(state.riskInView, false); assert.equal(state.riskEntityShown, false);
    assert.notEqual(state.selected, 'spatial:' + risk.id);
    check('时间窗排除人工风险时，场景、列表、图表及选中态同步回退', state);
    await action('range-reset').click();
    await page.locator('[data-ref=breadcrumbs] [data-node]').first().click(); await settle();
    state = await counts(risk.id); assert.equal(state.alerts, 1); assert.equal(state.riskEntityShown, true);
    assert.ok(state.contextKinds.includes('construction-area')); assert.ok(state.contextKinds.includes('railway'));
    await page.locator('.safety-time-popover summary').click();
    check('恢复时间范围后风险及施工区域、铁路上下文恢复', state);

    // Verify the existing real source video actually decodes and advances with the scene.
    const replayStart = await page.evaluate(() => __safetyWorkspace.store.dataset.timeExtent[0]);
    await action('time').fill(String(replayStart)); await action('time').dispatchEvent('change');
    await action('play').click();
    await page.waitForFunction(() => { const v = document.querySelector('#videoArSourceVideo'); return !v.paused && v.currentTime > 1 && v.videoWidth === 3840; }, null, { timeout: 30000 });
    report.videoBefore = await page.evaluate(() => { const v = document.querySelector('#videoArSourceVideo'); return { time: v.currentTime, width: v.videoWidth, height: v.videoHeight, quality: v.getVideoPlaybackQuality().toJSON?.() || { totalVideoFrames: v.getVideoPlaybackQuality().totalVideoFrames, droppedVideoFrames: v.getVideoPlaybackQuality().droppedVideoFrames } }; });
    await action('motion-toggle').click();
    await page.evaluate(() => { const times = []; window.__edgeFrames = { start: performance.now(), times, remove: __safetyWorkspace.options.viewer.scene.postRender.addEventListener(() => times.push(performance.now())) }; });
    await page.waitForTimeout(30500);
    report.videoPerformance = await page.evaluate(() => { const p = __edgeFrames; p.remove(); const elapsed = performance.now() - p.start; const v = document.querySelector('#videoArSourceVideo'); const q = v.getVideoPlaybackQuality(); return { method: 'Cesium scene.postRender with real 3840x2160 source playing', sampleMs: elapsed, renderedFrames: p.times.length, fps: p.times.length * 1000 / elapsed, videoTime: v.currentTime, totalVideoFrames: q.totalVideoFrames, droppedVideoFrames: q.droppedVideoFrames, paused: v.paused }; });
    assert.ok(report.videoPerformance.videoTime > report.videoBefore.time + 25); assert.equal(report.videoPerformance.paused, false);
    check('真实4K原片与场景同时播放，原片解码与回放时间持续推进', report.videoPerformance);
    await action('play').click(); await action('motion-toggle').click();

    await action('authoring').click();
    await page.locator(`[data-spatial=select][data-id="${area.id}"]`).click(); await settle();
    await spatial('new-area').click();
    for (const [x, y] of [[860, 430], [990, 430], [970, 540]]) { await page.mouse.click(x, y); await page.waitForTimeout(250); }
    await spatial('finish').click(); await field('name').fill('验收示例 · 响应丢失恢复测试'); await field('confirmed').check();
    const draftId = await page.evaluate(() => __safetyWorkspace.spatial.draft.id);
    let lost = false;
    await context.route('**/__safety/spatial', async route => {
      if (route.request().method() === 'POST' && !lost) {
        lost = true; const response = await route.fetch(); assert.equal(response.status(), 200);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{ack-truncated' });
      }
      return route.continue();
    });
    await spatial('save').click(); await page.waitForFunction(() => !__safetyWorkspace.spatial.saving);
    assert.match(await page.locator('[data-spatial-ref=message]').textContent(), /草稿已保留/);
    assert.equal(await page.evaluate(() => __safetyWorkspace.spatial.draft.id), draftId);
    await spatial('restore').click(); await page.waitForFunction(() => __safetyWorkspace.spatial.getSnapshot().objects.length === 4);
    assert.equal(await field('confirmed').isChecked(), false);
    await field('confirmed').check(); await spatial('save').click(); await page.waitForFunction(() => !__safetyWorkspace.spatial.saving);
    let saved = await snapshot(); assert.equal(saved.objects.length, 4); assert.equal(saved.objects.filter(o => o.id === draftId).length, 1);
    check('服务端已保存但响应丢失：保留草稿，重新读取并确认后不生成重复对象', { draftId, count: saved.objects.length });

    await page.locator(`[data-spatial=visibility][data-id="${draftId}"]`).click(); await page.waitForFunction(() => !__safetyWorkspace.spatial.saving);
    assert.equal((await snapshot()).objects.find(o => o.id === draftId).visible, false);
    await page.locator(`[data-spatial=delete][data-id="${draftId}"]`).click();
    assert.equal((await snapshot()).objects.length, 4, 'first delete click only confirms');
    await page.locator(`[data-spatial=delete][data-id="${draftId}"]`).click(); await page.waitForFunction(() => !__safetyWorkspace.spatial.saving);
    saved = await snapshot(); assert.deepEqual(saved.objects, original.objects);
    check('显隐与两步删除生效，测试结束后原三个验收对象逐字段保持不变', { count: saved.objects.length, revision: saved.revision });
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  } catch (e) {
    report.failure = { message: e.message, stack: e.stack }; console.error(e); process.exitCode = 1;
  } finally { await fs.writeFile(output, JSON.stringify(report, null, 2)); await browser?.close(); }
})();
