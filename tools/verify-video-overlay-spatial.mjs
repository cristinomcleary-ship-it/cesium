#!/usr/bin/env node
/** Real Cesium picking/projection, persistence and native-cache acceptance on synthetic geometry/media.
 * START_VITE=1 by default; PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE and OUTPUT_DIR are optional.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (runtime ? path.join(runtime, 'playwright') : 'playwright'));
const work = await mkdtemp(path.join(os.tmpdir(), 'ar-spatial-'));
const output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const videoPath = path.join(work, 'spatial-15fps.mp4'), xmlPath = path.join(work, 'spatial-camera.xml');
const ffmpeg = process.env.FFMPEG_EXECUTABLE || 'ffmpeg', ffprobe = process.env.FFPROBE_EXECUTABLE || 'ffprobe';
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x283050:s=640x360:r=15:d=2.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
const photo = (index, longitude) => `<Photo><Id>${index}</Id><ImagePath>frame_${index}.jpg</ImagePath><Component>1</Component><Pose><Center><x>${longitude}</x><y>30</y><z>80</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
await writeFile(xmlPath, `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS84</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><SRSId>0</SRSId><Photogroups><Photogroup><Name>Spatial annotations</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew>${[120,120.00006218,120.00012436].map((longitude,index)=>photo(index,longitude)).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`);
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5193';
const server = process.env.START_VITE !== '0' && !process.env.BASE_URL || process.env.START_VITE === '1' ? await (await import('vite')).createServer({ server: { host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port), strictPort: true, hmr: false, watch: null } }) : undefined;
await server?.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(90000);
const errors = [], report = { pass: false, checks: [], browserErrors: errors };
page.on('pageerror', error => errors.push(String(error.stack || error)));
const check = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const state = () => page.evaluate(() => window.__workflow.snapshot());
const input = (selector, value, event = 'input') => page.locator(selector).evaluate((element, { value,event }) => { element.value = String(value); element.dispatchEvent(new Event(event,{bubbles:true})); }, {value,event});
const project = point => page.evaluate(point => window.__workflow.spatial.project('above-opaque', point), point);
async function seek(time) {
  await input('[data-cc-seek]', time);
  await page.waitForFunction(time => { const s = window.__workflow.snapshot(); return !s.buffering && !s.seeking && Math.abs(s.presentedTime - time) < .07; }, time);
}
const magentaPixels = file => {
  const data = execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-ss','0.6','-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'], {maxBuffer: 4*1024*1024});
  let count=0; for(let i=0;i<data.length;i+=3) if(data[i]>180 && data[i+1]<80 && data[i+2]>180) count++;
  return count;
};
try {
  await page.goto(`${baseUrl}/tools/fixtures/video-overlay-workflow.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__workflow?.snapshot().modelReady);
  const baseline = await state();
  await page.locator('#ccVideoFile').setInputFiles(videoPath); await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  await page.locator('#ccInterval').fill('1'); await input('#ccOpacity', 1);
  await page.locator('#ccStart').click();
  await page.waitForFunction(() => { const s=window.__workflow.snapshot(); return s.active && s.presentedTime !== null && !s.buffering; });
  const top = {x:0,y:0,z:5};
  const screen = await project(top);
  assert.ok(screen && screen.x>0 && screen.x<1 && screen.y>0 && screen.y<1);
  const picked = await page.evaluate(({x,y}) => window.__workflow.spatial.pick('above-opaque',x,y), screen);
  assert.ok(Math.hypot(picked.x-top.x,picked.y-top.y,picked.z-top.z)<.35, `Picked surface differs: ${JSON.stringify(picked)}`);
  const rejected = await page.evaluate(({x,y}) => {
    const attempt=(id,u,v)=>{ try { window.__workflow.spatial.pick(id,u,v); return false; } catch {return true;} };
    return { otherTarget:attempt('buried-opaque',x,y), blank:attempt('above-opaque',.02,.02), missing:attempt('removed-model',x,y) };
  }, screen);
  assert.deepEqual(rejected,{otherTarget:true,blank:true,missing:true});
  check('Real model surface pick round-trips through calibrated camera; wrong target, blank sky and missing target are rejected',{picked});

  const cad = await page.evaluate(() => {
    const spatial=window.__workflow.spatial;
    const local=spatial.fromWorld('cad',{x:0,y:18,z:20});
    const pixel=spatial.project('cad',local);
    const picked=spatial.pick('cad',pixel.x,pixel.y);
    return {local,picked,pixel,projected:spatial.project('cad',picked)};
  });
  assert.ok(Math.hypot(cad.local.x-cad.picked.x,cad.local.y-cad.picked.y,cad.local.z-cad.picked.z)<.15,`CAD snap differs: ${JSON.stringify(cad)}`);
  check('CAD click snaps to its real line geometry instead of taking background depth',{cad});

  await page.locator('[data-sp-target]').selectOption('above-opaque');
  await page.locator('[data-sp-add="label"]').click();
  const surfaceCanvas = page.locator('.cc-video-spatial-editor');
  const bounds = await surfaceCanvas.boundingBox();
  await surfaceCanvas.click({position:{x:screen.x*bounds.width,y:screen.y*bounds.height}});
  await page.waitForFunction(() => window.__workflow.snapshot().spatialAnnotations.length===1);
  await input('[data-sp-field="text"]','桥墩标绘 UI 验收');
  assert.equal((await state()).spatialAnnotations[0].text,'桥墩标绘 UI 验收');
  await page.locator('[data-sp-add="area"]').click();
  await surfaceCanvas.click({position:{x:screen.x*bounds.width,y:screen.y*bounds.height}});
  await page.keyboard.press('Escape');
  assert.equal((await state()).spatialAnnotations.length,1,'Escape must discard incomplete area');
  await page.locator('[data-sp-add="route"]').click();
  await seek(.2);
  assert.equal(await page.locator('[data-sp-draft]').isVisible(),false,'Seeking must cancel unfinished picking');
  assert.equal(await page.locator('[data-sp-field="text"]').isEnabled(),true,'Cancelled picking must restore property editing');
  await page.locator('[data-sp-delete]').click();
  assert.equal((await state()).spatialAnnotations.length,0);
  check('User creates a label by clicking its actual surface, edits text, and cancels an unfinished area without saving it');

  const marks = await page.evaluate(async picked => {
    const {createSpatialAnnotation} = await import('/src/videoOverlaySpatialAnnotations.ts');
    return [
      createSpatialAnnotation('label',{targetId:'above-opaque',targetName:'上部结构',points:[picked],text:'桥墩 P1\n结构说明',color:'#ff00ff',fontSize:44,offsetX:100,offsetY:-130,start:0,end:2,fadeIn:0,fadeOut:0}),
      createSpatialAnnotation('route',{targetId:'above-opaque',targetName:'上部结构',points:[{x:-4,y:-3,z:5},{x:0,y:0,z:5},{x:4,y:3,z:5}],text:'线路走向',color:'#ff00ff',lineWidth:12,start:0,end:2,fadeIn:0,fadeOut:0,flow:true}),
      createSpatialAnnotation('area',{targetId:'above-opaque',targetName:'上部结构',points:[{x:-4,y:-4,z:5},{x:4,y:-4,z:5},{x:4,y:4,z:5},{x:-4,y:4,z:5}],text:'施工区',color:'#ff00ff',fillOpacity:.5,lineWidth:10,start:0,end:2,fadeIn:0,fadeOut:0}),
    ];
  },picked);
  await page.evaluate(marks => window.__workflow.spatial.set(marks), marks);
  await page.waitForFunction(() => window.__workflow.spatial.counts().magenta>30);
  const first=await project(picked); await seek(.8); const moved=await project(picked);
  assert.ok(Math.abs(first.x-moved.x)>.02,'Camera movement must change screen position');
  assert.deepEqual((await state()).spatialAnnotations,marks,'Camera movement must retain local coordinates');
  await page.locator('#ccTarget').selectOption('above-opaque'); await input('#ccEast',4);
  await page.waitForTimeout(150);
  const adjusted=await project(picked);
  assert.ok(Math.abs(adjusted.x-moved.x)>.02,'Model adjustment must move the bound annotation');
  assert.deepEqual((await state()).spatialAnnotations,marks,'Model adjustments must retain local coordinates');
  check('Label, directional route and region render; anchors follow camera and model movement without rewriting local geometry',{first,moved,adjusted});
  const draftPixels = await page.locator('.cc-video-spatial-editor').evaluate(canvas => {
    const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let alpha=0;for(let i=3;i<data.length;i+=4)if(data[i])alpha++;
    return alpha;
  });


  assert.equal(draftPixels,0,'Completed/cancelled draft handles must clear');
  assert.equal(await page.locator('.cc-video-spatial-editor').evaluate(canvas=>canvas.hidden),true,'Inactive helper canvas must be hidden');
  await page.locator('#ccSpatialEditor').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'spatial-live.png')});
  await page.locator('#ccSchemeName').fill('结构标绘验收'); await page.locator('#ccSave').click();
  await page.waitForFunction(() => window.__workflow.snapshot().saved?.settings.spatialAnnotations?.length===3);
  const saved=(await state()).saved.settings;
  await page.locator('[data-sp-add="area"]').click();
  await page.locator('#ccStop').click();
  assert.equal(await page.locator('[data-sp-field="text"]').isEnabled(),true,'Exit during draft must restore property editing');
  await page.evaluate(() => window.__workflow.restoreSaved()); await page.locator('#ccStart').click();
  await page.waitForFunction(() => {const s=window.__workflow.snapshot();return s.active&&s.presentedTime!==null&&!s.buffering;});
  assert.deepEqual((await state()).spatialAnnotations,saved.spatialAnnotations);
  assert.equal(await page.locator('[data-sp-field="text"]').isEnabled(),true,'Reopened annotations must remain editable');
  check('Spatial bindings, text, time spans and display styles survive save/reopen');
  await page.locator('#ccExport').evaluate(button => {button.closest('details').open=true;});
  await page.locator('#ccExportStart').fill('0'); await page.locator('#ccExportEnd').fill('1.2');
  await page.locator('#ccBuildPreview').click();
  await page.waitForFunction(() => window.__workflow.snapshot().dimensions.cached?.[0]===640,null,{timeout:180000});
  const cached=await state();
  assert.equal(cached.hasResources,false); assert.equal(cached.hasPresentation,false); assert.equal(cached.pendingCallbacks,0); assert.equal(cached.mediaSrc,null);
  assert.equal(cached.dimensions.spatialEditorDom,0);
  assert.deepEqual(cached.lifecycle,baseline.lifecycle);
  const file=path.join(output,'spatial-native-cache.webm');
  await writeFile(file,Buffer.from(await page.evaluate(() => window.__workflow.cachedBlob())));
  const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-count_frames','-show_streams','-of','json',file],{encoding:'utf8'}));
  const stream=probe.streams.find(stream=>stream.codec_type==='video');
  assert.equal(stream.width,640);assert.equal(stream.height,360);assert.equal(Number(stream.nb_read_frames),18);
  const count=magentaPixels(file);assert.ok(count>30,`Baked video missing annotations (${count})`);
  check('All 18 native frames retain spatial annotations at 640×360; finished cache releases Cesium resources and editor canvas',{frames:Number(stream.nb_read_frames),magentaPixels:count});
  await page.locator('[data-cc-play]').click(); await page.waitForFunction(() => window.__workflow.snapshot().dimensions.cachedTime>.2);
  const playing=await state();assert.equal(playing.hasResources,false);assert.equal(playing.pendingCallbacks,0);assert.equal(playing.dimensions.cachedPaused,false);
  await page.locator('#ccStop').click(); await page.waitForFunction(() => !window.__workflow.snapshot().active);
  const final=await state();assert.equal(final.dimensions.cachedDom,0);assert.equal(final.dimensions.spatialEditorDom,0);assert.deepEqual(final.lifecycle,baseline.lifecycle);assert.deepEqual(final.geometry,baseline.geometry);assert.deepEqual(final.renderErrors,[]);assert.deepEqual(errors,[]);
  check('Cached playback runs without live fusion callbacks; exit restores original model and CAD geometry');
  report.pass=true;report.final={renderErrors:final.renderErrors,lifecycle:final.lifecycle};
} catch(error) {
  report.error=String(error.stack||error);report.final=await state().catch(()=>null);
  await page.screenshot({path:path.join(output,'spatial-failure.png')}).catch(()=>{});
} finally {
  await writeFile(path.join(output,'spatial-report.json'),JSON.stringify(report,null,2));
  await browser.close();await server?.close();
}
console.log(JSON.stringify({pass:report.pass,checks:report.checks.length,report:path.join(output,'spatial-report.json'),error:report.error},null,2));
if(!report.pass)process.exitCode=1;
