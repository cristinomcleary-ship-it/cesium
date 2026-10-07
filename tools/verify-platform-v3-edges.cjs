// Run AFTER the main V3 acceptance, against its isolated data server. This script
// never writes spatial/library records: every mutation request is intercepted.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), base = process.env.PLATFORM_V3_URL || 'http://127.0.0.1:5196';
const out = path.join(root, 'output/platform-v3'), bridge = '/tmp/platform-v3-edge-cesium.ts';
const report = { checks: [], pageErrors: [], consoleErrors: [], blockedWrites: [] };
let browser, page, context;
const action = name => page.locator(`.v3-toolbar [data-action="${name}"]`);
const spatial = name => page.locator(`.safety-spatial-editor [data-spatial="${name}"]`);
const field = name => page.locator(`.safety-spatial-editor [data-spatial-field="${name}"]`);
const check = (label, data) => { report.checks.push({ label, data }); console.log('PASS', label); };
const stats = () => page.evaluate(() => __safetyWorkspace.spatial.debugStats());
const snapshot = () => page.evaluate(() => __safetyWorkspace.spatial.getSnapshot());
async function settle() { await page.waitForFunction(() => !__safetyWorkspace.options.viewer.camera._currentFlight); await page.waitForTimeout(350); }
async function cancelDraft() {
  if (!(await stats()).draftId) return;
  await spatial('cancel').click();
  if (await page.locator('.spatial-discard').isVisible()) await page.locator('.spatial-discard [data-spatial="discard"]').click();
  await page.waitForFunction(() => !__safetyWorkspace.spatial.debugStats().draftId);
}
async function choose() {
  await cancelDraft();
  if (!await page.locator('.safety-spatial-editor').isVisible()) await action('authoring').click();
  if ((await stats()).stage === 'detail') await spatial('choose').click();
  assert.equal((await stats()).stage, 'choose');
}
async function begin(kind) { await choose(); await spatial('new-' + kind).click(); assert.equal((await stats()).stage, 'draw'); }
async function clickPoint(point) { await page.mouse.click(point.x, point.y); await page.waitForTimeout(150); }
async function cameraSave() {
  await page.evaluate(async bridge => {
    const C = await import(bridge), camera = __safetyWorkspace.options.viewer.camera;
    window.__edgeCamera = { position: C.Cartesian3.clone(camera.positionWC), direction: C.Cartesian3.clone(camera.directionWC), up: C.Cartesian3.clone(camera.upWC) };
  }, bridge);
}
async function cameraRestore() {
  await page.evaluate(() => { const v = __safetyWorkspace.options.viewer; v.camera.setView({ destination: __edgeCamera.position, orientation: { direction: __edgeCamera.direction, up: __edgeCamera.up } }); v.scene.requestRender(); });
  await page.waitForTimeout(500);
}
async function projectExisting() {
  return page.evaluate(async bridge => {
    const C = await import(bridge), w = __safetyWorkspace, v = w.options.viewer, panel = document.querySelector('.safety-spatial-editor').getBoundingClientRect();
    const all = w.spatial.getSnapshot().objects.filter(o => !o.deletedAt).flatMap(o => o.geometry.type === 'Point' ? [o.geometry.position] : o.geometry.positions);
    const candidates = all.map(p => { const q = v.scene.cartesianToCanvasCoordinates(C.Cartesian3.fromDegrees(p.longitude, p.latitude, p.height)); return q && { x: q.x, y: q.y, position: p }; })
      .filter(p => p && p.x > panel.right + 36 && p.x < v.canvas.clientWidth - 55 && p.y > 210 && p.y < v.canvas.clientHeight - 160);
    return candidates.filter((p, i) => candidates.slice(0, i).every(other => Math.hypot(p.x - other.x, p.y - other.y) > 15));
  }, bridge);
}
async function dragHandle(handle, end, cancel = false) {
  const box = await handle.boundingBox(); assert.ok(box, 'editable vertex is visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  if (cancel) await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up(); await page.waitForTimeout(200);
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(root, bridge.slice(1)), 'export {Cartesian2,Cartesian3,Cartographic,Matrix4,Color,PointPrimitiveCollection} from "cesium";\n');
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.route('**/__library/**', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.fulfill({ json: { ok: true } }));
    await context.route('**/__safety/spatial', route => {
      if (['GET', 'HEAD'].includes(route.request().method())) return route.continue();
      report.blockedWrites.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { error: '边界验证禁止持久化', code: 'TEST_WRITE_BLOCKED' } });
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', e => report.pageErrors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
    await page.goto(base + '/?screen=safety', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__safetyWorkspace?.isOpen && __safetyWorkspace.spatial.getSnapshot().objects.filter(o => !o.deletedAt).length >= 3, null, { timeout: 180000 });
    await page.waitForFunction(() => __safetyWorkspace.runtimeModels().length > 0 && __safetyWorkspace.runtimeModels().every(m => m.tileset.tilesLoaded), null, { timeout: 120000 });
    await settle(); const original = await snapshot();
    const area = original.objects.find(o => !o.deletedAt && o.kind === 'construction-area' && o.creationSource === 'user_drawn_model_surface'); assert.ok(area, 'main acceptance must save a V3 area first');
    await choose(); await page.locator(`[data-spatial="select"][data-id="${area.id}"]`).click(); await settle();
    await begin('risk'); const points = await projectExisting(); assert.ok(points.length >= 2, 'two saved real-model anchors are visible outside the drawer');

    await cameraSave();
    await page.evaluate(() => { const v = __safetyWorkspace.options.viewer; v.camera.setView({ orientation: { heading: v.camera.heading, pitch: 1.2, roll: 0 } }); v.scene.requestRender(); });
    await page.waitForTimeout(400); await clickPoint({ x: 1100, y: 440 });
    assert.equal((await stats()).draftVertices, 0); assert.match(await page.locator('[data-spatial-ref="message"]').innerText(), /没有可选模型|尚未就绪/);
    await cameraRestore();
    // A captured pointer can leave the viewport; a browser click outside the canvas also must not add geometry.
    await page.mouse.click(-15, 430); assert.equal((await stats()).draftVertices, 0);
    check('天空和画布外操作没有生成业务位置，草稿保持可继续');

    await page.evaluate(() => { const w = __safetyWorkspace; window.__edgeRegistry = w.modelRegistry; w.modelRegistry = []; });
    await clickPoint(points[0]); assert.equal((await stats()).draftVertices, 0);
    await page.evaluate(() => { __safetyWorkspace.modelRegistry = window.__edgeRegistry; delete window.__edgeRegistry; });
    check('注册表不匹配时，即使下方存在模型也不写入候选点');

    await clickPoint(points[0]); const first = (await stats()).draftGeometry; assert.equal(first.positions.length, 1);
    await clickPoint(points[1]); const second = (await stats()).draftGeometry;
    assert.equal(second.positions.length, 1); assert.equal((await stats()).stage, 'draw'); assert.notDeepEqual(second.positions[0], first.positions[0]);
    assert.equal(second.sources[0].anchor.provenance, 'verified-project-photogrammetry-surface');
    check('风险点可重复调整候选位置，仍须点击使用此位置才进入命名', { candidates: 1, model: second.sources[0].anchor.model });

    const overlayInfo = await page.evaluate(async ({ bridge, anchor }) => {
      const C = await import(bridge), v = __safetyWorkspace.options.viewer;
      const world = new C.Cartesian3(anchor.position.x, anchor.position.y, anchor.position.z), nearer = C.Cartesian3.lerp(world, v.camera.positionWC, .12, new C.Cartesian3());
      const overlay = new C.PointPrimitiveCollection(); overlay.add({ position: nearer, pixelSize: 96, color: C.Color.RED }); v.scene.primitives.add(overlay); window.__edgeOverlay = overlay; v.scene.requestRender();
      const screen = v.scene.cartesianToCanvasCoordinates(world); return { x: screen.x, y: screen.y, world: { x: nearer.x, y: nearer.y, z: nearer.z } };
    }, { bridge, anchor: second.sources[0].anchor });
    await page.waitForTimeout(300);
    await clickPoint(overlayInfo); const isolated = (await stats()).draftGeometry;
    assert.equal(isolated.positions.length, 1); assert.equal(isolated.sources[0].anchor.model.assetId, second.sources[0].anchor.model.assetId);
    const actual = isolated.sources[0].anchor.position;
    assert.ok(Math.hypot(actual.x - overlayInfo.world.x, actual.y - overlayInfo.world.y, actual.z - overlayInfo.world.z) > 5, 'saved depth must not be the foreground point');
    assert.equal(await page.evaluate(() => __edgeOverlay.show), true, 'external overlay visibility restored');
    await page.evaluate(() => { __safetyWorkspace.options.viewer.scene.primitives.remove(__edgeOverlay); delete window.__edgeOverlay; });
    check('非倾斜摄影前景覆盖层被暂时隔离，anchor仍来自注册模型且覆盖层显隐恢复', { asset: isolated.sources[0].anchor.model.assetId });

    await spatial('finish').click(); await field('name').fill('临时边界验证草稿（不保存）');
    await page.evaluate(async bridge => { const C = await import(bridge), tile = __safetyWorkspace.runtimeModels()[0].tileset; window.__edgeTile = tile; window.__edgeMatrix = C.Matrix4.clone(tile.modelMatrix); const moved = C.Matrix4.clone(tile.modelMatrix); moved[12] += 25; tile.modelMatrix = moved; }, bridge);
    await spatial('save').click(); assert.equal((await stats()).stage, 'name');
    assert.match(await page.locator('[data-spatial-ref="message"]').innerText(), /模型已更新|不可用/); assert.equal(report.blockedWrites.length, 0);
    await page.evaluate(() => { __edgeTile.modelMatrix = __edgeMatrix; delete window.__edgeTile; delete window.__edgeMatrix; __safetyWorkspace.options.viewer.scene.requestRender(); });
    assert.equal(await field('name').inputValue(), '临时边界验证草稿（不保存）');
    check('模型实际变换不符时在保存前拒绝，保留名称和原始候选坐标，不发持久化请求');
    await cancelDraft();

    await choose(); await page.locator(`[data-spatial="edit"][data-id="${area.id}"]`).click();
    const beforeEdit = (await stats()).draftGeometry;
    const handle = page.locator('.spatial-handles [data-spatial-vertex]:visible').first();
    await dragHandle(handle, { x: 2040, y: -60 });
    assert.deepEqual((await stats()).draftGeometry, beforeEdit); assert.equal(await page.evaluate(() => __safetyWorkspace.options.viewer.scene.screenSpaceCameraController.enableInputs), true);
    check('顶点拖到画布外后回滚该次调整，原坐标与来源保持一致，相机控制恢复');

    const box = await handle.boundingBox(); assert.ok(box);
    await dragHandle(handle, { x: box.x + 30, y: box.y + 10 }, true);
    assert.deepEqual((await stats()).draftGeometry, beforeEdit); assert.equal(await page.evaluate(() => __safetyWorkspace.options.viewer.scene.screenSpaceCameraController.enableInputs), true);
    check('拖动期间失去窗口焦点取消调整，草稿和相机状态恢复');

    const midpoint = page.locator('.spatial-handles [data-spatial-midpoint]:visible').first(); await midpoint.click();
    assert.equal((await stats()).draftVertices, beforeEdit.positions.length + 1);
    await spatial('delete-vertex').click(); assert.equal((await stats()).draftVertices, beforeEdit.positions.length);
    // Field changes force the one-time discard flow; Continue Editing must not discard them.
    await field('name').fill('临时编辑草稿（不保存）'); await spatial('close').click();
    assert.equal(await page.locator('.spatial-discard').isVisible(), true);
    await page.locator('.spatial-discard [data-spatial="keep-editing"]').click(); assert.equal(await field('name').inputValue(), '临时编辑草稿（不保存）');
    await spatial('close').click(); await page.locator('.spatial-discard [data-spatial="discard"]').click();
    assert.equal(await page.locator('.safety-spatial-editor').isVisible(), false);
    check('边中点添加后可删除，关闭只显示一次放弃确认，继续编辑保留输入');

    assert.deepEqual(await snapshot(), original); const remote = await context.request.get(base + '/__safety/spatial', { headers: { 'X-Cesium-Library': '1' } });
    assert.deepEqual(await remote.json(), original); assert.equal(report.blockedWrites.length, 0);
    check('所有边界测试未留下新增对象，也未改写已有对象、版本或模型锚点');
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    await page.screenshot({ path: path.join(out, 'edge-acceptance-complete.png') });
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1;
    await page?.screenshot({ path: path.join(out, 'edge-acceptance-failure.png') }).catch(() => {});
  } finally {
    if (page) await page.evaluate(() => { const w = window.__safetyWorkspace; if (!w) return; if (window.__edgeRegistry) w.modelRegistry = __edgeRegistry; if (window.__edgeTile && window.__edgeMatrix) __edgeTile.modelMatrix = __edgeMatrix; if (window.__edgeOverlay) w.options.viewer.scene.primitives.remove(__edgeOverlay); }).catch(() => {});
    await fs.writeFile(path.join(out, 'edge-acceptance-report.json'), JSON.stringify(report, null, 2)); await browser?.close();
  }
})();
