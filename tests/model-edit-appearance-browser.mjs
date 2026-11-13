/** Original-workbench acceptance with a synthetic GLB and an isolated database.
 * PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE may select installed runtimes.
 * This is intentionally separate from CPU *.test.mjs suites: it requires WebGL.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { GlbWriter, IDENTITY } from '../tools/sketchup/glb-writer.mjs';

const output = resolve(process.env.MODEL_EDIT_BROWSER_OUT || 'output/model-edit-appearance-browser');
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(join(output, 'isolated-data-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const require = createRequire(import.meta.url);
const modulePath = process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
const { chromium } = require(modulePath);
const report = { startedAt: new Date().toISOString(), classification: 'original-workbench-synthetic-model-isolated-data',
  dataDir, productionDataReadOrModified: false, checks: [], pageErrors: [], screenshots: [] };
let server, browser, context, page, origin, modelId;
const modelName = 'Synthetic-bridge-component.glb';

function syntheticModel() {
  const writer = new GlbWriter();
  const vertices = [[-6,-3,0],[6,-3,0],[6,3,0],[-6,3,0],[-6,-3,8],[6,-3,8],[6,3,8],[-6,3,8]];
  for (const [corners, normal] of [
    [[0,3,2,1],[0,0,-1]], [[4,5,6,7],[0,0,1]], [[0,1,5,4],[0,-1,0]],
    [[1,2,6,5],[1,0,0]], [[2,3,7,6],[0,1,0]], [[3,0,4,7],[-1,0,0]],
  ]) writer.addFace({ positions: corners.flatMap(i => vertices[i].map(n => n / .0254)),
    normals: corners.flatMap(() => normal), indices: [0,1,2,0,2,3] }, IDENTITY,
  { key: 'synthetic-concrete', rgba: [.63,.68,.73,1] });
  return writer.finish('Synthetic bridge component').bytes;
}

async function check(name, callback) {
  console.log('RUN', name);
  const item = { name, status: 'running' }; report.checks.push(item);
  item.evidence = await callback(); item.status = 'passed'; console.log('PASS', name);
}
async function ready() {
  await page.waitForFunction(() => window.__managementWorkspace?.ui?.getSnapshot()?.projectId, undefined, { timeout: 60000 });
}
async function modelReady() {
  await page.waitForFunction(id => {
    const viewer = window.__managementWorkspace?.viewer; if (!viewer) return false;
    for (let i = 0; i < viewer.scene.primitives.length; i++) {
      const model = viewer.scene.primitives.get(i);
      if (model.id?.engineeringModelId === id && model.ready) return true;
    }
    return false;
  }, modelId, { timeout: 60000 });
}
async function modelState() {
  return page.evaluate(async id => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), viewer = window.__managementWorkspace.viewer;
    let model; for (let i=0;i<viewer.scene.primitives.length;i++) {
      const candidate = viewer.scene.primitives.get(i); if (candidate.id?.engineeringModelId === id) model = candidate;
    }
    if (!model) throw new Error('Synthetic model is not loaded');
    const guides = viewer.entities.values.filter(entity => entity.label?.text?.getValue(viewer.clock.currentTime)?.includes('旋转中心'));
    const color = model.color ?? C.Color.WHITE;
    return { matrix: C.Matrix4.toArray(model.modelMatrix), color: [color.red,color.green,color.blue,color.alpha],
      blend: model.colorBlendMode, lighting: [model.imageBasedLighting.imageBasedLightingFactor.x,model.imageBasedLighting.imageBasedLightingFactor.y],
      lightColor: model.lightColor ? [model.lightColor.x,model.lightColor.y,model.lightColor.z] : null,
      show: model.show, silhouette: model.silhouetteSize, guideCount: guides.length,
      cameraInputs: viewer.scene.screenSpaceCameraController.enableInputs };
  }, modelId);
}
async function frameAndPick() {
  return page.evaluate(async id => {
    const C = await import('/node_modules/.vite/deps/cesium.js'), viewer = window.__managementWorkspace.viewer;
    let model; for (let i=0;i<viewer.scene.primitives.length;i++) {
      const candidate=viewer.scene.primitives.get(i); if(candidate.id?.engineeringModelId===id) model=candidate;
    }
    viewer.camera.cancelFlight(); viewer.camera.lookAt(model.boundingSphere.center,new C.HeadingPitchRange(.4,-.55,70));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY); viewer.scene.requestRender(); viewer.render();
    const center=C.SceneTransforms.worldToWindowCoordinates(viewer.scene,model.boundingSphere.center);
    const rect=viewer.canvas.getBoundingClientRect();
    for(const [dx,dy] of [[-25,20],[25,20],[-30,-20],[30,-20],[0,0]]) {
      const point=new C.Cartesian2(center.x+dx,center.y+dy),hit=viewer.scene.pick(point);
      if(hit?.primitive===model||hit?.id?.engineeringModelId===id) return {x:rect.left+point.x,y:rect.top+point.y};
    }
    throw new Error('Rendered synthetic model is not pickable');
  }, modelId);
}
async function dragModel(shift=false) {
  const point=await frameAndPick();
  if(shift)await page.keyboard.down('Shift');
  await page.mouse.move(point.x,point.y);await page.mouse.down();
  await page.mouse.move(point.x+40,point.y,{steps:4});await page.mouse.up();
  if(shift)await page.keyboard.up('Shift');
}
async function openModelTab() {
  await page.locator('[data-dock="editor"]').click();
  const toggle = page.locator('.function-centers-toggle');
  if (await toggle.isVisible()) await toggle.click();
  const button=page.locator('.tab[data-tab="models"]');
  if(!await button.isVisible())await page.locator('.function-center').filter({has:button}).locator('summary').click();
  await button.click();
}
const row=()=>page.locator(`.sdp-item[data-display-id="layer:${modelId}"]`);
async function directoryAction(action) {
  await page.locator('[data-dock="display"]').click();
  const category=page.locator('.sdp-category').filter({hasText:'工程模型'});
  if(!await row().isVisible())await category.locator('summary').click();
  await row().locator(`[data-action="${action}"]`).click();
}
async function records() {
  const response=await context.request.get(origin+'/__library/records'); assert.equal(response.status(),200,await response.text());
  return (await response.json()).records;
}
async function savedAppearance(expected) {
  for(let n=0;n<30;n++) {
    const item=(await records()).find(item=>item.id===modelId);
    if(Object.entries(expected).every(([key,value])=>item.settings.appearance?.[key]===value))return item.settings;
    await page.waitForTimeout(100);
  }
  throw new Error('Appearance not persisted: '+JSON.stringify((await records()).find(item=>item.id===modelId)?.settings));
}
async function screenshot(name) {
  const path=join(output,name+'.png');await page.screenshot({path});report.screenshots.push(path);
}

try {
  server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});await server.listen();
  origin=`http://127.0.0.1:${server.httpServer.address().port}`;report.origin=origin;
  const launchOptions=process.env.BROWSER_LAUNCH_OPTIONS
    ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : {headless:true,executablePath:process.env.BROWSER_EXECUTABLE||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),
      args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']};
  browser=await chromium.launch(launchOptions);
  context=await browser.newContext({viewport:{width:1500,height:1000}});page=await context.newPage();page.setDefaultTimeout(30000);
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});await ready();
  report.browserVersion = browser.version();
  report.renderer = await page.evaluate(() => { const gl=window.__managementWorkspace.viewer.scene.context._gl;const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER); });
  await openModelTab();
  await page.locator('#modelFile').setInputFiles({name:modelName,mimeType:'model/gltf-binary',buffer:syntheticModel()});
  const positionCategory = page.locator('details').filter({ has: page.locator('#modelPlacement') });
  if (await positionCategory.getAttribute('open') === null) await positionCategory.locator(':scope > summary').click();
  await page.locator('#modelPlacement').selectOption('customGeo');
  await page.locator('#modelHeight').fill('10');await page.locator('#loadModel').click();
  await page.waitForFunction(()=>document.querySelector('#modelLoadStatus')?.textContent?.includes('已放置并保存'),undefined,{timeout:60000});
  modelId=(await records()).find(item=>item.name===modelName).id;await modelReady();
  await check('import-is-locked',async()=>{
    assert.equal(await page.locator('#modelTools').isVisible(),false);const before=await modelState();
    await dragModel();const after=await modelState();assert.deepEqual(after.matrix,before.matrix);assert.equal(after.guideCount,0);
    return {matrixUnchanged:true,panelHidden:true};
  });
  await check('explicit-editor-and-rotation-guide',async()=>{
    await directoryAction('item-edit');assert.equal(await page.locator('#modelTools').isVisible(),true);
    await page.locator('[data-edit-mode="rotate"]').click();const state=await modelState();assert.equal(state.guideCount,1);
    await frameAndPick();await screenshot('rotation-center');return {guideCount:state.guideCount};
  });
  await check('shift-fine-mouse-rotation',async()=>{
    await page.locator('#resetModelTransform').click();await dragModel();const normal=Number(await page.locator('#modelEditHeading').inputValue());
    await page.locator('#resetModelTransform').click();await dragModel(true);const fine=Number(await page.locator('#modelEditHeading').inputValue());
    assert.ok(Math.abs(normal)>1,`normal rotation ${normal}`);assert.ok(Math.abs(normal/10-fine)<.001,`normal ${normal}, fine ${fine}`);
    assert.equal((await modelState()).cameraInputs,true);return {normalDegrees:normal,fineDegrees:fine};
  });
  await check('numeric-microstep-and-finish',async()=>{
    await page.locator('#resetModelTransform').click();await page.locator('[data-model-rotate="1"]').click();
    await page.locator('[data-model-rotate="1"]').click({modifiers:['Shift']});
    assert.equal(Number(await page.locator('#modelEditHeading').inputValue()),1.1);
    await page.locator('#finishModelEditing').click();assert.equal(await page.locator('#modelTools').isVisible(),false);
    const before=await modelState();assert.equal(before.guideCount,0);await dragModel();assert.deepEqual((await modelState()).matrix,before.matrix);
    return {degrees:1.1,lockedAfterFinish:true};
  });
  await check('appearance-edit-without-position-edit',async()=>{
    const before=await modelState();await directoryAction('item-appearance');
    assert.equal(await page.locator('#modelTools').isVisible(),false);
    await page.locator('[data-appearance="colorMode"]').selectOption('replace');
    await page.locator('[data-appearance="color"]').fill('#e02b40');await page.locator('[data-appearance="color"]').dispatchEvent('change');
    await page.locator('[data-appearance="lighting"]').selectOption('bright');
    await page.locator('[data-appearance="brightness"]').fill('125');await page.locator('[data-appearance="brightness"]').dispatchEvent('change');
    await savedAppearance({colorMode:'replace',color:'#e02b40',lighting:'bright',brightness:1.25});
    const after=await modelState();assert.deepEqual(after.matrix,before.matrix);assert.ok(Math.abs(after.color[0]-224/255)<1e-8);
    assert.ok(Math.abs(after.color[1]-43/255)<1e-8);assert.ok(after.lighting.every(value=>value>=0&&value<=1));assert.deepEqual(after.lightColor,[1.6875,1.6875,1.6875]);
    await frameAndPick();await screenshot('model-appearance');return {color:after.color,lighting:after.lighting,matrixUnchanged:true};
  });
  await check('reload-restores-appearance-and-keeps-locked',async()=>{
    const before=await modelState();await page.reload({waitUntil:'domcontentloaded'});await ready();await modelReady();
    const after=await modelState();assert.deepEqual(after.color,before.color);assert.deepEqual(after.lighting,before.lighting);assert.deepEqual(after.matrix,before.matrix);
    assert.equal(await page.locator('#modelTools').isVisible(),false);assert.equal(after.guideCount,0);return {savedColor:after.color,locked:true};
  });
  await check('reset-original-material-and-escape',async()=>{
    await directoryAction('item-appearance');await page.locator('[data-appearance="reset"]').click();
    await savedAppearance({colorMode:'original',lighting:'original',brightness:1});const state=await modelState();
    assert.deepEqual(state.color,[1,1,1,1]);assert.deepEqual(state.lighting,[1,1]);assert.equal(state.lightColor,null);
    await page.locator('[data-appearance="close"]').click();await directoryAction('item-edit');
    await page.locator('[data-edit-mode="rotate"]').click();assert.equal((await modelState()).guideCount,1);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#modelTools').isVisible(),false);assert.equal((await modelState()).guideCount,0);
    return {originalRestored:true,escapeLocked:true};
  });
  assert.deepEqual(report.pageErrors,[]);report.passed=true;
} catch(error) {
  report.passed=false;report.error=error.stack||String(error);console.error(report.error);
  if(page){await screenshot('failure').catch(()=>{});report.visibleText=(await page.locator('body').innerText().catch(()=>'' )).slice(-7000);}
  process.exitCode=1;
} finally {
  report.finishedAt=new Date().toISOString();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();await server?.close();
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.map(({name,status})=>({name,status})),report:join(output,'report.json')}));
}
