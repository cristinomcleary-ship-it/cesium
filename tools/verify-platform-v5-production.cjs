// Read-only acceptance against the existing production project. Run serially with other GPU checks.
// PowerShell: & 'F:/Node.js/node.exe' tools/verify-platform-v5-production.cjs
// Optional: $env:VISUAL_URL='http://127.0.0.1:5173'
// This script blocks EVERY non-GET/HEAD/OPTIONS network request, including camera autosave.
// It never supplies fake media, routes, business objects, successful writes, or model settings.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/胡航/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/platform-v5/production');
const base = process.env.VISUAL_URL || 'http://127.0.0.1:5173';
const target = new URL('/?screen=safety', base).href;
const report = { startedAt: new Date().toISOString(), target, scope: 'Actual existing production data, read-only browser navigation. No business creation/edit/save, no model configuration changes, no mocked business/media data. One explicitly identified 503 is injected into the read-only model inspection GET to verify retry.', checks: [], screenshots: [], blockedWrites: [], pageErrors: [], consoleErrors: [], failedRequests: [], layouts: [], timings: {} };
let browser, context, page, baselineFiles, baselineSpatial, baselineMatrices, failNextInspection = false;
const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); console.log(pass ? 'PASS' : 'FAIL', name); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function metadataHashes() {
  const dataRoot = path.join(root, 'project-data');
  const result = {};
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) result[path.relative(root, file).replaceAll('\\', '/')] = sha(await fs.readFile(file));
    }
  }
  await walk(dataRoot);
  return result;
}
async function snapshot() {
  return page.evaluate(() => {
    const w = window.__SAFETY_WORKSPACE__ || window.__safetyWorkspace;
    const c = w.options.viewer.camera;
    const xyz = p => ({ x: p.x, y: p.y, z: p.z });
    return {
      camera: { position: xyz(c.positionWC), direction: xyz(c.directionWC), up: xyz(c.upWC) },
      spatial: JSON.stringify(w.spatial.getSnapshot()),
      matrices: w.runtimeModels().map(m => ({ assetId: m.assetId, matrix: Array.from({ length: 16 }, (_, i) => m.tileset.modelMatrix[i]) })),
      stats: w.debugStats(),
      models: w.runtimeModels().map(m => ({ assetId: m.assetId, assetVersion: m.assetVersion, coordinateTransformVersion: m.coordinateTransformVersion, tilesLoaded: m.tileset.tilesLoaded, selectedTriangles: m.tileset._statistics?.numberOfTrianglesSelected, selectedTiles: m.tileset._selectedTiles?.length }))
    };
  });
}
async function ready() {
  await page.waitForFunction(() => {
    const w = window.__SAFETY_WORKSPACE__ || window.__safetyWorkspace;
    if (!w?.store) return false;
    const p = w.effects.presentation.debugStats();
    return !p.installationPending && p.status?.ok && w.runtimeModels().length > 0 && w.runtimeModels().every(m => m.tileset.tilesLoaded) && !w.options.viewer.camera._currentFlight;
  }, null, { timeout: 180000 });
  await page.waitForTimeout(600);
}
async function shot(name) {
  await page.screenshot({ path: path.join(out, name), fullPage: false });
  report.screenshots.push(name);
}
async function clickTab(tab) {
  await page.locator(`.v3-header [data-tab="${tab}"]`).click();
  await page.waitForFunction(tab => document.querySelector('.safety-dashboard-v5')?.dataset.page === tab, tab);
  await page.waitForTimeout(450);
}
async function home() {
  await page.locator('.v3-toolbar [data-action="home"]').click();
  await ready();
}
async function mode(value) {
  await page.locator(`.v3-toolbar [data-action="mode"][data-mode="${value}"]`).click();
  await ready();
  const state = await snapshot();
  check(`actual runtime mode ${value}`, state.stats.ui.appliedMode === value, { requested: state.stats.data.state.mode, applied: state.stats.ui.appliedMode, presentation: state.stats.effects.presentation.status });
}
async function layout() {
  return page.evaluate(() => {
    const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const rect = el => { if (!visible(el)) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
    const hit = el => { const r = rect(el); if (!r) return false; const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at === el || el.contains(at); };
    const $ = s => document.querySelector(s);
    const describe = el => ({ text: el.textContent.trim().slice(0, 160), tag: el.tagName, href: el.getAttribute('href'), bounds: rect(el), hit: hit(el) });
    const creditRoot = $('.cesium-widget-credits');
    return {
      viewport: { width: innerWidth, height: innerHeight }, page: $('.safety-dashboard-v5')?.dataset.page,
      header: rect($('.v3-header')), left: rect($('.v3-left')), right: rect($('.v3-right')),
      timeline: rect($('[data-ref="timeline"]')), footer: rect($('.v3-footer-note')), toolbar: rect($('.v3-toolbar')),
      nativeToolbar: rect($('.cesium-viewer-toolbar')), geocoder: rect($('.cesium-geocoder-input')),
      credits: rect(creditRoot), creditText: creditRoot?.textContent,
      creditControls: [...document.querySelectorAll('.cesium-widget-credits a,.cesium-widget-credits img,.cesium-credit-expand-link')].filter(visible).map(describe),
      logoCount: [...document.querySelectorAll('.cesium-widget-credits img')].filter(visible).length,
      cards: [...document.querySelectorAll('.v3-card')].filter(visible).map(el => ({ title: el.querySelector('h2')?.textContent, bounds: rect(el) })),
      toolbarControls: [...document.querySelectorAll('.v3-toolbar button,.cesium-viewer-toolbar button,.cesium-geocoder-input')].filter(visible).map(describe),
      overflow: document.documentElement.scrollWidth > innerWidth
    };
  });
}
const overlap = (a, b) => !!a && !!b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
const inside = (r, size) => !!r && r.left >= -0.5 && r.top >= -0.5 && r.right <= size.width + 0.5 && r.bottom <= size.height + 0.5;
function validateLayout(r, label) {
  report.layouts.push({ label, ...r });
  check(`${label}: no horizontal overflow`, !r.overflow);
  check(`${label}: full Cesium logo remains visible`, r.logoCount > 0 && r.creditControls.filter(x => x.tag === 'IMG').every(x => inside(x.bounds, r.viewport) && x.hit), r.creditControls);
  check(`${label}: credit avoids timeline, footer and panels`, !!r.credits && ![r.timeline, r.footer, r.left, r.right].some(p => overlap(r.credits, p)), { credits: r.credits, timeline: r.timeline, footer: r.footer });
  check(`${label}: attribution controls are reachable without navigating`, r.creditControls.length > 0 && r.creditControls.every(x => inside(x.bounds, r.viewport) && x.hit));
  check(`${label}: native and platform toolbars do not overlap`, !overlap(r.nativeToolbar, r.toolbar), { native: r.nativeToolbar, custom: r.toolbar });
  check(`${label}: no default Ion token warning`, !/default.*ion.*access.*token/i.test(r.creditText || ''));
}
async function probeMesh() {
  return page.evaluate(async () => {
    const C = await import('/node_modules/.vite/deps/cesium.js');
    const w = window.__SAFETY_WORKSPACE__ || window.__safetyWorkspace;
    const v = w.options.viewer, models = w.runtimeModels();
    const stage = w.effects.presentation.stageRect();
    v.render();
    // Capture visible mesh statistics before pick passes reset the internal frame counters.
    const meshModels = models.map(m => ({assetId:m.assetId,triangles:m.tileset._statistics?.numberOfTrianglesSelected,selectedContentTriangles:(m.tileset._selectedTiles||[]).reduce((sum,t)=>sum+(t.content?.trianglesLength||0),0),tilesLoaded:m.tileset.tilesLoaded}));
    const samples = [];
    for (let y = stage.top + 35; y < stage.top + stage.height - 35; y += 90) {
      for (let x = stage.left + 35; x < stage.left + stage.width - 35; x += 90) {
        const p = new C.Cartesian2(x, y), h = v.scene.pick(p, 1, 1);
        const model = models.find(m => h?.primitive === m.tileset || h?.content?.tileset === m.tileset);
        if (!model) continue;
        const world = v.scene.pickPosition(p);
        if (world) samples.push({ assetId: model.assetId, x, y, ecef: { x: world.x, y: world.y, z: world.z } });
      }
    }
    return { stage, samples, visibleModelSamples: samples.length, models: meshModels };
  });
}
async function screenshotSceneOnly(name) {
  // Preserve credits and all Cesium entities/materials; only temporarily hide HTML controls.
  const selectors = ['.safety-dashboard', '.cesium-viewer-toolbar', '.safety-spatial-editor', '.safety-model-optimization'];
  await page.evaluate(selectors => {
    window.__productionHiddenUi = [...new Set(selectors.flatMap(s => [...document.querySelectorAll(s)]))].map(el => ({ el, visibility: el.style.visibility }));
    for (const x of window.__productionHiddenUi) x.el.style.visibility = 'hidden';
  }, selectors);
  try { await page.waitForTimeout(300); await shot(name); }
  finally { await page.evaluate(() => { for (const x of window.__productionHiddenUi || []) x.el.style.visibility = x.visibility; delete window.__productionHiddenUi; }); }
}
(async () => {
  await fs.mkdir(out, { recursive: true });
  baselineFiles = await metadataHashes();
  report.metadataBefore = baselineFiles;
  try {
    const start = Date.now();
    browser = await chromium.launch({ executablePath: process.env.EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const request = route.request();
      if (failNextInspection && request.method() === 'GET' && new URL(request.url()).pathname === '/__safety/model-optimization/inspect') {
        failNextInspection = false;
        report.injectedInspectionFailure = { method: 'GET', url: request.url(), status: 503, reason: 'Explicit read-only acceptance fault; no success or source data fabricated.' };
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '验收注入：只读检查暂时不可用' }) });
      }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      report.blockedWrites.push({ method: request.method(), url: request.url(), at: new Date().toISOString() });
      return route.abort('blockedbyclient');
    });
    page = await context.newPage();
    page.setDefaultTimeout(25000);
    page.on('pageerror', e => report.pageErrors.push(e.stack || e.message));
    page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({ text: m.text(), location: m.location() }); });
    page.on('requestfailed', request => report.failedRequests.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText }));
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await ready();
    report.timings.loadedActualModelsMs = Date.now() - start;
    let initial = await snapshot();
    baselineSpatial = initial.spatial; baselineMatrices = initial.matrices;
    report.initial = initial;
    check('formal production entry defaults to overview and actual showcase', initial.stats.ui.page === 'overview' && initial.stats.ui.appliedMode === 'presentation');
    check('exactly one existing Viewer canvas', initial.stats.viewerCount === 1);
    const originalObjects = JSON.parse(initial.spatial).objects || [];
    check('production keeps its one existing railway', originalObjects.filter(o => o.kind === 'railway' && !o.deletedAt).length === 1, originalObjects.map(o => ({ id: o.id, name: o.name, kind: o.kind, deletedAt: o.deletedAt })));
    check('formal entry has no drawing or draft', !initial.stats.spatial.drawing && !initial.stats.spatial.draftId && initial.stats.spatial.draftVertices === 0, initial.stats.spatial);
    for (const size of [{ width: 1920, height: 1080 }, { width: 2048, height: 988 }, { width: 1366, height: 768 }, { width: 2048, height: 1145 }]) {
      await page.setViewportSize(size); await page.waitForTimeout(250); await home();
      const label = `${size.width}x${size.height}`, homeState = await snapshot();
      const r = await layout(); validateLayout(r, `${label} overview`);
      check(`${label}: six overview categories`, r.cards.length === 6, r.cards.map(c => c.title));
      check(`${label}: full-width 64px timeline`, r.timeline?.height === 64 && r.timeline.left === 16 && Math.abs(r.timeline.right - size.width + 16) < 1, r.timeline);
      await shot(`overview-${label}.png`);
      const mesh = await probeMesh(); report.meshEvidence ??= []; report.meshEvidence.push({ viewport: size, ...mesh });
      check(`${label}: actual loaded engineering mesh is pickable`, mesh.visibleModelSamples > 5 && mesh.models.some(m => m.triangles > 0 || m.selectedContentTriangles > 0), { visibleSamples: mesh.visibleModelSamples, models: mesh.models });
      await screenshotSceneOnly(`scene-only-${label}.png`);
      await mode('inspection');
      check(`${label}: reality switch retains the exact camera`, JSON.stringify((await snapshot()).camera) === JSON.stringify(homeState.camera));
      await shot(`reality-same-camera-${label}.png`);
      await mode('presentation');
      check(`${label}: showcase switch retains the exact camera`, JSON.stringify((await snapshot()).camera) === JSON.stringify(homeState.camera));
      const urlBefore = page.url();
      const input = page.locator('.cesium-viewer-geocoderContainer .cesium-geocoder-input');
      await input.focus(); await page.waitForTimeout(450);
      const expanded = await layout();
      report.layouts.push({ label: `${label} native search focused`, ...expanded });
      check(`${label}: native search expands inside viewport`, inside(expanded.geocoder, size) && expanded.geocoder.width > r.geocoder.width + 10, { closed: r.geocoder, expanded: expanded.geocoder });
      check(`${label}: expanded native search avoids platform tools`, !overlap(expanded.geocoder, expanded.toolbar), { expanded: expanded.geocoder, toolbar: expanded.toolbar });
      await shot(`native-search-${label}.png`);
      await input.blur(); await page.waitForTimeout(400);
      check(`${label}: attribution/search checks did not navigate`, page.url() === urlBefore);
      check(`${label}: original model matrices remain unchanged`, JSON.stringify((await snapshot()).matrices) === JSON.stringify(baselineMatrices));
    }
    await page.setViewportSize({ width: 1920, height: 1080 }); await home();
    // Read-only optimization entry from reality must preserve its mode and camera on close.
    await mode('inspection');
    const optimizationEntry = await snapshot();
    await page.locator('[data-action="model-optimization"]').click();
    await page.locator('.safety-model-optimization').waitFor({ state: 'visible' });
    failNextInspection = true;
    await page.locator('[data-optimize="inspect"]').click();
    await page.waitForFunction(() => { const w = window.__SAFETY_WORKSPACE__ || window.__safetyWorkspace; const s = w.debugStats().optimization; return !s.loading && s.error?.includes('验收注入'); }, null, { timeout: 30000 });
    const failedInspect = await snapshot();
    check('inspection failure preserves actual raw model and original business records', failedInspect.stats.ui.appliedMode === 'inspection' && failedInspect.spatial === baselineSpatial && JSON.stringify(failedInspect.matrices) === JSON.stringify(baselineMatrices) && JSON.stringify(failedInspect.camera) === JSON.stringify(optimizationEntry.camera), failedInspect.stats.optimization);
    const failedMesh = await probeMesh();
    check('engineering mesh remains visible after read-only inspection failure', failedMesh.visibleModelSamples > 5, { samples: failedMesh.visibleModelSamples, models: failedMesh.models });
    await shot('optimization-inspect-failure-preserves-model.png');
    const inspectStart = Date.now();
    await page.locator('[data-optimize="inspect"]').click();
    await page.waitForFunction(() => { const w = window.__SAFETY_WORKSPACE__ || window.__safetyWorkspace; const s = w.debugStats().optimization; return !s.loading && !!s.reportId && !s.error; }, null, { timeout: 120000 });
    report.timings.actualReadOnlyModelInspectionMs = Date.now() - inspectStart;
    report.modelInspection = (await snapshot()).stats.optimization;
    check('successful inspection retry reflects reality entry selection', await page.locator('[data-optimize="original"]').getAttribute('aria-pressed') === 'true', report.modelInspection);
    check('no fabricated candidate is offered for apply', report.modelInspection.candidateCount === 0 && await page.locator('[data-optimize="apply"]').isDisabled() && await page.locator('[data-optimize="candidate"]').isDisabled());
    await shot('optimization-real-inspection.png');
    await page.locator('[data-optimize="display"]').click(); await ready();
    const comparison = await snapshot();
    check('optimization display comparison switches actual mode without changing camera', comparison.stats.ui.appliedMode === 'presentation' && JSON.stringify(comparison.camera) === JSON.stringify(optimizationEntry.camera));
    await page.locator('[data-optimize="close"]').click(); await ready();
    const afterOptimization = await snapshot();
    check('closing optimization restores actual reality entry mode and exact camera', afterOptimization.stats.ui.appliedMode === 'inspection' && JSON.stringify(afterOptimization.camera) === JSON.stringify(optimizationEntry.camera) && !afterOptimization.stats.optimization.visible);
    check('optimization read-only checks retain source matrices and user coordinates', afterOptimization.spatial === baselineSpatial && JSON.stringify(afterOptimization.matrices) === JSON.stringify(baselineMatrices));
    await shot('optimization-close-restores-reality.png');
    await home();
    await clickTab('inspection');
    await page.locator('[data-action="inspection-mode"][data-inspection-mode="replay"]').click();
    await page.waitForTimeout(350);
    const realSources = page.locator('[data-ref="mediaSources"] [data-media]');
    report.realReplayCount = await realSources.count();
    if (report.realReplayCount) {
      await realSources.first().click();
      await page.waitForFunction(() => { const v = document.querySelector('#videoArSourceVideo'); return v && v.readyState >= 2 && v.videoWidth > 0; }, null, { timeout: 60000 });
      report.realMedia = await page.evaluate(() => {
        const v = document.querySelector('#videoArSourceVideo'), w = window.__SAFETY_WORKSPACE__ || window.__safetyWorkspace;
        return { url: v.currentSrc, width: v.videoWidth, height: v.videoHeight, duration: v.duration, currentTime: v.currentTime, paused: v.paused, roam: w.debugStats().videoRoam, status: document.querySelector('[data-ref="trackStatus"]')?.textContent, reason: document.querySelector('[data-ref="roamStatus"]')?.textContent };
      });
      check('inspection uses an actual loaded recording', report.realMedia.width > 0 && Number.isFinite(report.realMedia.duration) && !report.realMedia.url.includes('fixture'), report.realMedia);
      await page.waitForFunction(()=>__safetyWorkspace.debugStats().videoRoam?.state==='unavailable');
      const mediaCamera=(await snapshot()).camera;
      await page.locator('[data-action="time"]').fill('10');
      await page.locator('[data-action="playback-rate"]').selectOption('2');
      await page.locator('[data-action="play"]').click();
      const rateStart=await page.evaluate(()=>({wall:performance.now(),media:document.querySelector('#videoArSourceVideo').currentTime}));
      await page.waitForTimeout(1600);
      const rateEnd=await page.evaluate(()=>({wall:performance.now(),media:document.querySelector('#videoArSourceVideo').currentTime,rate:document.querySelector('#videoArSourceVideo').playbackRate}));
      await page.locator('[data-action="play"]').click();
      report.actualMediaRate={...rateEnd,wallDelta:(rateEnd.wall-rateStart.wall)/1000,mediaDelta:rateEnd.media-rateStart.media};
      check('actual video 2x playback uses the native media clock',rateEnd.rate===2&&report.actualMediaRate.mediaDelta/report.actualMediaRate.wallDelta>1.65&&report.actualMediaRate.mediaDelta/report.actualMediaRate.wallDelta<2.35,report.actualMediaRate);
      const paused=await page.evaluate(()=>document.querySelector('#videoArSourceVideo').currentTime);await page.waitForTimeout(3200);
      check('actual video pause is stable for three seconds and unavailable roam does not move camera',Math.abs(await page.evaluate(()=>document.querySelector('#videoArSourceVideo').currentTime)-paused)<.05&&JSON.stringify((await snapshot()).camera)===JSON.stringify(mediaCamera));
      await page.locator('[data-action="playback-rate"]').selectOption('1');
      if(report.realReplayCount>1){
        const old=await page.evaluate(()=>__safetyWorkspace.videoRoam.debugStats());
        await realSources.nth(1).click();
        await page.waitForFunction(oldKey=>{const w=__safetyWorkspace,s=w.videoRoam.debugStats();return !w.mediaLoading&&s.state==='unavailable'&&s.bindingKey&&s.bindingKey!==oldKey;},old.bindingKey,{timeout:120000});
        const next=await page.evaluate(()=>({roam:__safetyWorkspace.videoRoam.debugStats(),video:__safetyWorkspace.options.getPlaybackSource(),legacy:__safetyWorkspace.effects.debugStats()}));
        report.actualSourceSwitch={before:old,after:next};
        check('switching actual library recording discards the old roam binding and does not draw unverified altitude',!next.roam.available&&next.roam.hostListenerCount===4&&next.legacy.visibleActualTrackSegments===0&&next.roam.bindingKey!==old.bindingKey,next);
      }

    } else report.limitations = ['No existing real replay was available; inspection screenshot records the actual empty state.'];
    validateLayout(await layout(), '1920x1080 inspection'); await shot('inspection-actual-records.png');
    await clickTab('events'); validateLayout(await layout(), '1920x1080 risk'); await shot('risk-actual-data.png');
    await clickTab('components');
    const pier = page.locator('[data-ref="piers"] [data-action="pier"]');
    if (await pier.count()) {
      await pier.first().click();
      const category = page.locator('[data-action="component"][data-component="cap"]');
      if (await category.isEnabled()) await category.click();
      await page.waitForTimeout(1000);
    }
    validateLayout(await layout(), '1920x1080 components'); await shot('components-actual-data.png');
    report.final = await snapshot();
    check('production spatial records remain identical after all navigation', report.final.spatial === baselineSpatial);
    check('engineering model matrices remain identical after all navigation', JSON.stringify(report.final.matrices) === JSON.stringify(baselineMatrices));
    check('single Viewer retained after all navigation', report.final.stats.viewerCount === 1);
    check('production still has exactly its original railway and no draft', JSON.parse(report.final.spatial).objects.filter(o => o.kind === 'railway' && !o.deletedAt).length === 1 && !report.final.stats.spatial.drawing && !report.final.stats.spatial.draftId && report.final.stats.spatial.draftVertices === 0, report.final.stats.spatial);
    check('no runtime JavaScript exceptions', report.pageErrors.length === 0, report.pageErrors);
  } catch (e) {
    report.failure = { message: e.message, stack: e.stack };
    check('production acceptance sequence completed', false, report.failure);
    if (page) await shot('acceptance-failure.png').catch(() => {});
  } finally {
    // Keep request interception active through browser shutdown, including keepalive autosaves.
    await browser?.close();
    report.metadataAfter = await metadataHashes();
    check('all production project JSON files remain byte-for-byte unchanged', JSON.stringify(baselineFiles) === JSON.stringify(report.metadataAfter));
    const blockedUrls = new Set(report.blockedWrites.map(r => r.url));
    report.expectedReadOnlyRequestFailures = report.failedRequests.filter(r => blockedUrls.has(r.url));
    report.unexpectedFailedRequests = report.failedRequests.filter(r => !blockedUrls.has(r.url) && !r.error?.includes('ERR_ABORTED'));
    report.expectedReadOnlyConsoleErrors = report.consoleErrors.filter(e => /ERR_BLOCKED_BY_CLIENT/.test(e.text) || blockedUrls.has(e.location.url));
    report.expectedInjectedFaultConsoleErrors = report.consoleErrors.filter(e => report.injectedInspectionFailure && e.location.url === report.injectedInspectionFailure.url && /503/.test(e.text));
    report.unexpectedConsoleErrors = report.consoleErrors.filter(e => !report.expectedReadOnlyConsoleErrors.includes(e) && !report.expectedInjectedFaultConsoleErrors.includes(e));
    check('no unexpected persistent console errors', report.unexpectedConsoleErrors.length === 0, report.unexpectedConsoleErrors);
    report.completedAt = new Date().toISOString();
    report.summary = { passed: report.checks.filter(c => c.pass).length, failed: report.checks.filter(c => !c.pass).length, screenshots: report.screenshots.length, blockedWrites: report.blockedWrites.length, unexpectedFailedRequests: report.unexpectedFailedRequests.length };
    report.result = report.summary.failed ? 'failed' : 'passed';
    await fs.writeFile(path.join(out, 'production-acceptance-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ result: report.result, ...report.summary, output: out }, null, 2));
    if (report.result !== 'passed') process.exitCode = 1;
  }
})();
