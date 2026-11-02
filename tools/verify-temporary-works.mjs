// Browser acceptance using an isolated platform instance and two synthetic 3D Tiles surfaces.
// Set PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE when using externally installed tools.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cartesian3, Matrix4 } from 'cesium';
import { createServer } from 'vite';
import { dxf, surface, lon, lat, transform } from './fixtures/temporary-works-survey.mjs';
const directory = await mkdtemp(join(tmpdir(), 'cesium-temporary-works-'));
const output = resolve(process.env.TEMPORARY_WORKS_VERIFY_OUT || 'output/temporary-works');
await mkdir(output, { recursive: true });
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR'])
  process.env[key] = directory;
const plan = dxf('known-areas.dxf', [
  { layer: 'YARD', points: [[0, 0], [20, 0], [20, 10], [0, 10]], closed: true },
  { layer: 'CENTERLINE', points: [[-20, -8], [0, -8]], closed: false },
  { layer: 'ARC_AXIS', points: [[-20, 0, 1], [0, 0]], closed: false },
  { layer: 'HOUSE', points: [[6, 2], [16, 2], [16, 8], [6, 8]], closed: true },
  { layer: 'HOUSE2', points: [[1, 1], [4, 1], [4, 3], [1, 3]], closed: true },
  { layer: 'OUTSIDE', points: [[25, 0], [30, 0], [30, 5], [25, 5]], closed: true },
]);
const typical = dxf('four-metre-typical-section.dxf', [
  { layer: 'SURFACE', points: [[-2, -0.04], [0, 0], [2, -0.04]], closed: false },
  { layer: 'THICKNESS', points: [[-2, -0.04], [-2, -0.54]], closed: false },
]);
const fixtures = { target: surface(10.25, 8), other: surface(60, 18) };
const report = { checks: [], pageErrors: [], rendererErrors: [] };
let server, browser, context, page;
const input = key => page.locator('#tw-' + key);
const tab = () => page.locator(".tab[data-tab='temporary-works']");
async function field(key, value) { await input(key).fill(String(value)); await input(key).dispatchEvent('change'); }
async function chooseLabel(key, part) {
  const option = input(key).locator('option').filter({ hasText: part }).first();
  await option.waitFor({ state: 'attached' });
  await input(key).selectOption(await option.getAttribute('value'));
}
async function check(name, test) {
  console.log('CHECK', name);
  const evidence = await test();
  report.checks.push({ name, evidence });
  console.log('PASS', name, JSON.stringify(evidence ?? {}));
}
async function runPlan() {
  await input('confirmed').check();
  await input('run').click();
  await input('save').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#tw-save')?.disabled || document.querySelector('#tw-status')?.hasAttribute('data-error'), undefined, { timeout: 90000 });
  assert(!(await input('save').isDisabled()), await input('status').innerText());
}
const near = (value, expected, tolerance) => assert(Math.abs(value - expected) <= tolerance, `Expected ${expected} ± ${tolerance}, got ${value}`);
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  server = await createServer({ plugins: [{ name: 'temporary-works-test-tiles', configureServer(vite) {
          vite.middlewares.use('/__works_tiles/', (req, res, next) => {
            const match = /^\/(target|other)\/(tileset\.json|surface\.glb)$/.exec(req.url);
            if (!match)
              return next();
            const fixture = fixtures[match[1]], json = match[2] === 'tileset.json';
            res.setHeader('Content-Type', json ? 'application/json' : 'model/gltf-binary');
            res.end(json ? JSON.stringify(fixture.tileset) : fixture.glb);
          });
        } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (/INVALID_(OPERATION|FRAMEBUFFER_OPERATION)|object does not belong to this context/.test(message.text()) && report.rendererErrors.length < 3) {
      report.rendererErrors.push(message.text());
    }
    if (message.type() === 'error') console.warn('Browser:', message.text().slice(0, 300));
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId, undefined, { timeout: 90000 });
  await page.locator('#basemap').selectOption('none');
  await check('实际倾斜摄影模型覆盖与重叠干扰模型', async () => {
    await page.locator('.tab[data-tab="tiles"]').click();
    await page.locator('#tilesUrl').fill(origin + '/__works_tiles/target/tileset.json');
    await page.locator('#loadTiles').click();
    await page.waitForFunction(() => {
      const scene = window.__managementWorkspace.viewer.scene.primitives;
      return !document.querySelector('#loadTiles').disabled && Array.from({ length: scene.length }, (_, i) => scene.get(i)).some(p => p.root);
    });
    await page.evaluate(async ({ lon, lat, origin }) => {
      const v = window.__managementWorkspace.viewer;
      const scene = v.scene.primitives;
      // Reuse the loaded application's Cesium constructors to keep one engine runtime.
      const target = Array.from({ length: scene.length }, (_, i) => scene.get(i)).find(p => p.root);
      const Cesium3DTileset = target.constructor, Cartesian3 = v.camera.positionWC.constructor;
      v.scene.primitives.add(await Cesium3DTileset.fromUrl(origin + '/__works_tiles/other/tileset.json'));
      v.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, 260), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      v.scene.requestRender();
    }, { lon, lat, origin });
    await page.waitForFunction(() => {
      const p = window.__managementWorkspace.viewer.scene.primitives;
      return Array.from({ length: p.length }, (_, i) => p.get(i)).filter(t => t?.root?.content && t.show).length >= 2;
    }, undefined, { timeout: 45000 });
    return { targetHeight: 58, overlyingNonTargetHeight: 68 };
  });
  await check('在重叠实景上拾取选定模型的相对零点', async () => {
    await tab().click();
    await input('kind').selectOption('camp');
    await input('pick').click();
    const pixel = await page.evaluate(({ lon, lat }) => {
      const v = window.__managementWorkspace.viewer;
      const point = v.camera.positionWC.constructor.fromDegrees(lon - 0.00005, lat, 58);
      const screen = v.scene.cartesianToCanvasCoordinates(point);
      const rect = v.canvas.getBoundingClientRect();
      return { x: rect.x + screen.x, y: rect.y + screen.y };
    }, { lon, lat });
    await page.mouse.click(pixel.x, pixel.y);
    await page.waitForFunction(() => document.querySelector('#tw-ref-mode')?.value === 'geo', undefined, { timeout: 15000 });
    near(Number(await input('ref-x').inputValue()), lon - 0.00005, 0.00001);
    return { longitude: Number(await input('ref-x').inputValue()), latitude: Number(await input('ref-y').inputValue()) };
  });
  async function records() {
    return page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('cesium-temporary-works-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        return await new Promise((resolve, reject) => {
          const q = db.transaction('plans').objectStore('plans').getAll();
          q.onsuccess = () => resolve(q.result.map(r => ({ ...r.plan, attachmentName: r.plan.sectionAttachment?.name, sectionAttachment: undefined })));
          q.onerror = () => reject(q.error);
        });
      }
      finally {
        db.close();
      }
    });
  }
  async function savePlan(name) {
    await input('save').click();
    await page.waitForFunction(name => document.querySelector('#tw-plans')?.textContent.includes(name), name);
    const item = (await records()).find(p => p.name === name);
    assert(item, 'Saved item missing from project store');
    return item;
  }
  async function loadSiteSection() {
    await input('section').setInputFiles(typical);
    await input('sec-profile').locator('option').filter({ hasText: 'SURFACE' }).first().waitFor({ state: 'attached' });
  }
  async function common(name, kind, layer) {
    await input('kind').selectOption(kind);
    await field('name', name);
    await input('cad').setInputFiles(plan);
    await chooseLabel('layer', layer);
    const opts = input('feature').locator('option[value]:not([value=""])');
    await opts.first().waitFor({ state: 'attached' });
    await input('feature').selectOption(await opts.first().getAttribute('value'));
    await input('coord').selectOption('local');
    for (const [key, value] of Object.entries({ 'anchor-x': 0, 'anchor-y': 0, 'anchor-lon': lon, 'anchor-lat': lat, rotation: 0 }))
      await field(key, value);
    if (kind !== 'road') {
      await input('ref-mode').selectOption('cad');
      await field('ref-x', 0);
      await field('ref-y', 0);
    }
    await field('grid', 3);
    await field('thickness', 0.5);
  }
  const campName = '验收－半幅驻地';
  let campsite;
  await check('上传平面及断面、指定相对零点、裁切驻地并核对开挖体积', async () => {
    await tab().click();
    await common(campName, 'camp', 'YARD');
    await loadSiteSection();
    await input('remove-section').click();
    assert.equal(await input('section').evaluate(el => el.files.length), 0);
    await loadSiteSection();
    const values = await input('building').locator('option').evaluateAll(options =>
      options.filter(o => /HOUSE2? ·|OUTSIDE ·/.test(o.textContent)).map(o => o.value));
    assert.equal(values.length, 3);
    await input('building').selectOption(values);
    await field('building-height', 4);
    await field('finished', -0.5);
    await runPlan();
    campsite = await savePlan(campName);
    const { planArea, coveredArea, excludedArea, cutVolume, fillVolume } = campsite.metrics;
    near(campsite.inputs.reference.height, 58, 0.12);
    near(planArea, 200, 0.05);
    assert(coveredArea >= 75 && coveredArea <= 105, `Selected model should cover about half of the CAD; area ${coveredArea}`);
    near(coveredArea + excludedArea, planArea, 0.01);
    near(cutVolume, coveredArea, 1);
    near(fillVolume, 0, 0.05);
    assert(campsite.mesh.triangles.length > 0);
    assert.equal(campsite.buildings.length, 3);
    assert(campsite.buildings.every(b => b.height===4));
    assert.deepEqual(campsite.inputs.structures.map(b => [b.layer, b.included]).sort(),
      [['HOUSE',true],['HOUSE2',true],['OUTSIDE',false]]);

    return { reference: campsite.inputs.reference.height, planArea, coveredArea, excludedArea, cutVolume, fillVolume, faces: campsite.mesh.triangles.length };
  });
  const roadName = '验收－分段纵坡便道';
  const gradeRows = () => input('grades').locator('[data-grade-row]');
  async function grade(row, key, value) {
    const el = gradeRows().nth(row).locator(`[data-grade-field="${key}"]`);
    await el.fill(String(value));
    await el.dispatchEvent('change');
  }
  async function noDraftFile() {
    assert.equal(await input('cad').evaluate(el => el.files.length), 0);
    assert.equal(await input('feature').locator('option[value]:not([value=""])').count(), 0);
    assert.equal(await input('cad-preview').locator('[data-route-endpoint]').count(), 0);
    assert(await input('save').isDisabled());
  }
  async function assertRoadLabels(startEast, endEast) {
    const markers = await page.evaluate(() => {
      const v = window.__managementWorkspace.viewer;
      const now = v.clock.currentTime;
      return v.entities.values.filter(entity => entity.isShowing).map(entity => {
        const text = entity.label?.text?.getValue(now), p = entity.position?.getValue(now);
        return {text,x:p?.x,y:p?.y,z:p?.z};
      }).filter(marker => /^(起点|终点) K/.test(marker.text));
    });
    assert.equal(markers.length,2, '应只显示当前可见便道的两个里程标签');
    const inverse = Matrix4.inverseTransformation(transform,new Matrix4());
    for (const [label,expectedEast] of [['起点 K0+000.000',startEast],['终点 K0+020.000',endEast]]) {
      const marker = markers.find(m=>m.text===label);
      assert(marker,`场景缺少 ${label}`);
      const enu=Matrix4.multiplyByPoint(inverse,new Cartesian3(marker.x,marker.y,marker.z),new Cartesian3());
      near(enu.x,expectedEast,.015); near(enu.y,-8,.015);
    }
  }
  await check('错误及正在读取的图纸可删除，相同文件可重传且保留已保存方案', async () => {
    await input('kind').selectOption('road');
    await input('cad').setInputFiles({name:'wrong.dxf',mimeType:'text/plain',buffer:Buffer.from('invalid')});
    await page.waitForFunction(() => document.querySelector('#tw-status')?.hasAttribute('data-error'));
    await input('remove-cad').click();
    await noDraftFile();
    // Gate just this file read to exercise a late completion after the normal remove/re-upload workflow.
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        if(this.name === 'slow.dxf') {
          await new Promise(resolve => { window.__releaseSlowPlanningRead = resolve; });
        }
        return original.call(this);
      };
      window.__restorePlanningRead = () => { File.prototype.arrayBuffer = original; };
    });
    try {
      const staleFile = dxf('slow.dxf',[{layer:'STALE_AXIS',points:[[0,0],[7,0]]}]);
      await input('cad').setInputFiles(staleFile);
      await page.waitForFunction(() => typeof window.__releaseSlowPlanningRead === 'function');
      await input('remove-cad').click();
      await noDraftFile();
      await input('cad').setInputFiles(plan);
      await chooseLabel('layer','CENTERLINE');
      await page.evaluate(async () => {
        window.__releaseSlowPlanningRead();
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      assert.equal(await input('layer').locator('option').filter({hasText:'STALE_AXIS'}).count(),0);
      await input('remove-cad').click(); await noDraftFile();
      await input('cad').setInputFiles(plan); await chooseLabel('layer','CENTERLINE');
      assert.equal(await input('cad').evaluate(el => el.files[0].name),plan.name);
      assert.equal((await records()).length,1);
      const chooser = page.waitForEvent('filechooser');
      await input('replace-cad').click();
      await (await chooser).setFiles(staleFile);
      // Use a different name to bypass our synthetic slow-file hook during replacement.
      await input('cad').setInputFiles({...plan,name:'corrected.dxf'});
      await chooseLabel('layer','CENTERLINE');
      assert.equal(await input('cad').evaluate(el => el.files[0].name),'corrected.dxf');
    } finally {
      await page.evaluate(() => { window.__releaseSlowPlanningRead?.(); window.__restorePlanningRead?.(); });
    }
    return {malformedRemoved:true,lateReadIgnored:true,sameFilenameReloaded:true,campRetained:campsite.id};
  });

  await check('CAD 弧形中心线长度、端点、毫米单位换算', async () => {
    await chooseLabel('layer','ARC_AXIS');
    const gradeEnd=gradeRows().first().locator('[data-grade-field="end"]');
    near(Number(await gradeEnd.inputValue()),Math.PI*10,.0006);
    assert.match(await input('road-length').innerText(),/31.416/);
    assert.match(await input('road-start').innerText(),/X=-20/);
    await input('unit').selectOption('mm');
    near(Number(await gradeEnd.inputValue()),Math.PI*.01,.0006);
    await input('unit').selectOption('m');
    near(Number(await gradeEnd.inputValue()),Math.PI*10,.0006);
    return {radius:10,semicircleLength:Number(await gradeEnd.inputValue())};
  });
  await check('便道只用中心线并按断面参数计算坡脚、面积与土方', async () => {
    await common('验收－梯形路槽','road','CENTERLINE');
    assert(!(await input('section').isVisible()),'路用表单仍显示典型断面上载');
    assert.match(await input('feature').locator('option:checked').innerText(),/CENTERLINE/);
    await field('width',4); await field('thickness',0.5); await field('treatment',0.5);
    await field('slope-height',1); await field('slope-width',1);
    await field('finished',0);
    assert.match(await input('road-length').innerText(),/20(?:[.,]0+)?/);
    await grade(0,'gradePct',0);
    await runPlan();
    const draft = await input('metrics').innerText();
    const flat = await savePlan('验收－梯形路槽');
    near(flat.metrics.cutVolume,120,0.3); near(flat.metrics.fillVolume,0,0.1);
    near(flat.metrics.coveredArea,120,0.25);
    near(flat.inputs.road.length,20,0.002);
    near(flat.inputs.road.hardeningBottomWidth,5,0.001);
    near(flat.inputs.road.formationWidth,6,0.001);
    near(flat.inputs.road.pavementArea,80,0.02);
    // Inspect the actual rendered/stored elevations, including both sloping shoulders.
    for (const sign of [-1,1]) {
      for(const [offset,drop] of [[2,0],[2.5,0.5],[3,1]]) {
        const row=flat.mesh.vertices.filter(v=>Math.abs(v.roadOffset - sign*offset)<0.0001);
        assert(row.length, `缺少边坡横断点 ${sign*offset}`);
        for(const v of row) near(v.surfaceHeight-flat.inputs.reference.height,-drop,.002);
      }
    }
    assert(!flat.attachmentName);
    await assertRoadLabels(-20,0);
    const flatRow=page.locator(`[data-plan-id="${flat.id}"]`);
    await flatRow.locator('[data-tw-action="hide"]').click();
    await input('remove-cad').click(); await noDraftFile();
    assert((await records()).some(r=>r.id===flat.id));
    return {width:4,hardening:0.5,treatment:0.5,slope:'1:1',expectedCut:120,cut:flat.metrics.cutVolume,area:flat.metrics.coveredArea,showsQuantity:/挖方/.test(draft)};
  });
  await check('首末点与里程方向、断坡范围校验、反向两段纵坡高程', async () => {
    await common(roadName,'road','CENTERLINE');
    await field('width',4); await field('thickness',0.5); await field('treatment',0.5);
    await field('slope-height',2); await field('slope-width',3);
    await field('finished',0);
    assert.match(await input('road-start').innerText(),/[-−]20/);
    assert.equal(await input('cad-preview').locator('[data-route-endpoint="start"]').count(),1);
    assert.equal(await input('cad-preview').locator('[data-route-endpoint="end"]').count(),1);
    await input('reverse').click();
    assert.match(await input('road-end').innerText(),/[-−]20/);
    assert(!/[-−]20/.test(await input('road-start').innerText()));
    const routeLength = await gradeRows().first().locator('[data-grade-field="end"]').inputValue();
    near(Number(routeLength),20,0.005);
    await input('add-grade').click();
    assert.equal(await gradeRows().count(),2);
    await grade(0,'start',0); await grade(0,'end',8); await grade(0,'gradePct',5);
    await grade(1,'start',9); await grade(1,'end',routeLength); await grade(1,'gradePct',-2.5);
    assert(await input('grade-status').evaluate(el=>el.hasAttribute('data-error')),'有缺口的坡段被错误接受');
    if (!await input('run').isDisabled()) {
      await input('confirmed').check(); await input('run').click();
      assert(await input('save').isDisabled());
    }
    // Test overlap and out-of-range numerics before entering the valid profile.
    await grade(1,'start',7);
    assert(await input('grade-status').evaluate(el=>el.hasAttribute('data-error')),'重叠坡段被错误接受');
    await grade(1,'start',8); await grade(1,'end',25);
    assert(await input('grade-status').evaluate(el=>el.hasAttribute('data-error')),'越过终点的坡段被错误接受');
    await grade(1,'end',routeLength);
    assert(!(await input('grade-status').evaluate(el=>el.hasAttribute('data-error'))));
    await input('reverse').click();
    near(Number(await gradeRows().nth(0).locator('[data-grade-field="end"]').inputValue()),12,.002);
    near(Number(await gradeRows().nth(0).locator('[data-grade-field="gradePct"]').inputValue()),2.5,.001);
    near(Number(await gradeRows().nth(1).locator('[data-grade-field="gradePct"]').inputValue()),-5,.001);
    await input('reverse').click();
    assert.equal(await input('finished').inputValue(),'','新起点应重新填写顶面相对标高');
    await field('finished',0);
    await runPlan(); const road = await savePlan(roadName);
    near(road.inputs.road.length,20,0.002); assert.equal(road.inputs.road.reversed,true);
    assert.deepEqual(road.inputs.road.grades.map(r=>r.gradePct),[5,-2.5]);
    near(road.metrics.coveredArea,140,0.2); // Base width = 4 + 2 × 1 × (3/2) = 7 m.
    near(road.metrics.cutVolume,107.8,0.2); // Bottom depth area = 20 − (8×0.2 + 12×0.25).
    near(road.metrics.fillVolume,0,0.05);
    await assertRoadLabels(0,-20);
    const enu = Matrix4.inverseTransformation(transform,new Matrix4());
    const axisVertices = road.mesh.vertices.map(v => {
      const pos=Cartesian3.fromDegrees(v.longitude,v.latitude,50);
      const local=Matrix4.multiplyByPoint(enu,pos,new Cartesian3());
      return {east:local.x,north:local.y,height:v.surfaceHeight-road.inputs.reference.height};
    }).filter(v => Math.abs(v.north+8)<1.8);
    for(const [station,elevation] of [[0,0],[8,0.4],[20,0.1]]) {
      const candidates=axisVertices.filter(v=>Math.abs(v.east+station)<0.025);
      assert(candidates.length,`未在分段桩号 ${station} 形成设计折线`);
      for(const v of candidates) near(v.height,elevation,0.005);
    }
    return {length:road.inputs.road.length,start:await input('road-start').innerText(),slopes:road.inputs.road.grades,gradeBreakHeight:0.4,endHeight:0.1,cut:road.metrics.cutVolume};
  });
  const steelName = '验收－钢筋厂棚';
  await check('厂棚硬化、按处理底计算另挖深度', async () => {
    await common(steelName, 'steel', 'HOUSE2');
    await chooseLabel('building', 'HOUSE2'); await field('building-height',5.5);
    await field('finished',0); await field('treatment',0.25); await runPlan();
    const steel = await savePlan(steelName);
    near(steel.metrics.coveredArea,6,0.02); near(steel.metrics.cutVolume,4.5,0.05);
    near(steel.metrics.fillVolume,0,0.02); assert.equal(steel.inputs.structures[0].included,true);
    return {canopyHeight:steel.building.height,...steel.metrics};
  });
  await check('基准点落在其他模型上时禁止出量', async () => {
    await common('错误基准点', 'steel', 'YARD');
    await field('ref-x', 26);
    await field('finished', 0);
    await input('confirmed').check();
    await input('run').click();
    await page.waitForFunction(() => /基准点未落/.test(document.querySelector('#tw-status')?.textContent ?? ''), undefined, { timeout: 90000 });
    assert(await input('save').isDisabled());
    return { message: await input('status').innerText() };
  });
  await check('厂区越界无模型数据时停止出量', async () => {
    await common('验收－界外钢筋厂', 'steel', 'OUTSIDE');
    await field('finished', 0);
    await input('confirmed').check();
    await input('run').click();
    await page.waitForFunction(() => /无有效|有效.*为\s*0|未.*覆盖|范围外|均.*舍弃|未命中|无覆盖|没有.*有效|没有.*模型|没有.*覆盖|全部.*(越界|覆盖|舍弃)|完全.*覆盖/.test(document.querySelector('#tw-status')?.textContent ?? ''), undefined, { timeout: 90000 });
    assert(await input('save').isDisabled());
    assert.equal((await records()).length, 4);
    return { message: await input('status').innerText() };
  });
  await check('保存方案显隐、刷新恢复、查看与删除', async () => {
    let row = page.locator(`[data-plan-id="${campsite.id}"]`);
    await row.locator('[data-tw-action="hide"]').click();
    await page.waitForFunction(id => { const el = document.querySelector(`[data-plan-id="${id}"] [data-tw-action="hide"]`); return el && /显示/.test(el.textContent + ' ' + el.title); }, campsite.id);
    // Visibility is stored in the platform's scene display preferences.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await tab().click();
    await row.waitFor({ state: 'visible' });
    assert.match(await row.locator('[data-tw-action="hide"]').innerText(), /显示/);
    await row.locator('[data-tw-action="inspect"]').click();
    assert.match(await input('metrics').innerText(), /挖/);
    await row.locator('[data-tw-action="hide"]').click();
    page.once('dialog', d => d.accept());
    await row.locator('[data-tw-action="delete"]').click();
    await row.waitFor({ state: 'detached' });
    assert.deepEqual((await records()).map(p=>p.name).sort(),[roadName,'验收－梯形路槽',steelName].sort());
    return { savedRoad: roadName, deletedCamp: campName };
  });
  // A real V1 record captured from the original released viewer may be supplied for migration QA.
  if (process.env.TEMPORARY_WORKS_V1_FIXTURE) {
    const legacy=JSON.parse(await readFile(process.env.TEMPORARY_WORKS_V1_FIXTURE,'utf8'));
    await check('第一版典型断面便道在新版中恢复、复核与保留原数量', async () => {
      assert(!legacy.inputs.road && legacy.inputs.design.sectionProfile.length>0);
      await page.evaluate(async ({plan,bytes}) => {
        const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('cesium-temporary-works-v1');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
        try {
          plan.sectionAttachment=new File([new Uint8Array(bytes)],plan.inputs.sectionName);
          const projectId=window.__managementWorkspace.ui.getSnapshot().projectId;
          await new Promise((resolve,reject)=>{const tx=db.transaction('plans','readwrite');tx.objectStore('plans').put({projectId,id:plan.id,plan});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
        } finally {db.close();}
      },{plan:legacy,bytes:[...typical.buffer]});
      await page.reload({waitUntil:'domcontentloaded'}); await tab().click();
      const row=page.locator(`[data-plan-id="${legacy.id}"]`);
      await row.waitFor(); await row.locator('[data-tw-action="inspect"]').click();
      assert.match(await input('metrics').innerText(),/78[.,]4/);
      const saved=(await records()).find(x=>x.id===legacy.id);
      assert.deepEqual(saved.metrics,legacy.metrics); assert.equal(saved.attachmentName,legacy.inputs.sectionName);
      return {restoredId:saved.id,fill:saved.metrics.fillVolume,attachment:saved.attachmentName};
    });
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.rendererErrors, []);
  report.result = 'passed';
}
catch (error) {
  report.result = 'failed';
  report.error = String(error?.stack || error);
  process.exitCode = 1;
  if (page) {
    report.status = await input('status').textContent({ timeout: 1000 }).catch(() => '');
    report.models = await page.evaluate(() => {
      const v = window.__managementWorkspace?.viewer, p = v?.scene.primitives;
      if (!p) return [];
      return Array.from({length:p.length}, (_,i)=>p.get(i)).filter(t=>t?.root).map(t=>({name:t.resource?.url, ready:t.root.contentReady, visible:t.show, loaded:t.tilesLoaded, selected:t._selectedTiles?.length, sphere:t.boundingSphere.radius}));
    }).catch(()=>[]);
    report.body = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(-3500);
  }
  console.error(report.error, report.status, report.pageErrors);
}
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await context?.close();
  await browser?.close();
  await server?.close();
}
