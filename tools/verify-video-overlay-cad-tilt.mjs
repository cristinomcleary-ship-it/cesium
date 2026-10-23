#!/usr/bin/env node
/** CAD individual and whole-group two-axis tilt acceptance on real Cesium geometry with synthetic media (no user project footage).
 * START_VITE=1 by default; PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE and OUTPUT_DIR are optional.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (runtime ? path.join(runtime, 'playwright') : 'playwright'));
const work = await mkdtemp(path.join(os.tmpdir(), 'ar-cad-tilt-'));
const output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const videoPath = path.join(work, 'spatial-15fps.mp4'), xmlPath = path.join(work, 'spatial-camera.xml');
const ffmpeg = process.env.FFMPEG_EXECUTABLE || 'ffmpeg', ffprobe = process.env.FFPROBE_EXECUTABLE || 'ffprobe';
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x283050:s=640x360:r=15:d=2.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
const photo = (index, longitude) => `<Photo><Id>${index}</Id><ImagePath>frame_${index}.jpg</ImagePath><Component>1</Component><Pose><Center><x>${longitude}</x><y>30</y><z>80</z></Center><Rotation><Yaw>0</Yaw><Pitch>-90</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
await writeFile(xmlPath, `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS84</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><SRSId>0</SRSId><Photogroups><Photogroup><Name>Spatial annotations</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew>${[120,120.00006218,120.00012436].map((longitude,index)=>photo(index,longitude)).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`);
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5194';
const server = process.env.START_VITE !== '0' && !process.env.BASE_URL || process.env.START_VITE === '1' ? await (await import('vite')).createServer({ cacheDir: path.resolve('node_modules/.vite-cad-acceptance'), server: { host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port), strictPort: true, hmr: false, watch: null, fs: { allow: [process.cwd(), realpathSync('node_modules')] } } }) : undefined;
await server?.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(90000);
const errors = [], loadErrors = [], report = { pass: false, checks: [], browserErrors: errors, loadErrors };
page.on('pageerror', error => { errors.push(String(error.stack || error)); console.error('BROWSER',String(error)); });
page.on('requestfailed', request => { const message=`${request.url()}: ${request.failure()?.errorText}`;loadErrors.push(message);console.error('LOAD',message); });
page.on('console', message => { if (message.type() === 'error') { loadErrors.push(message.text());console.error('CONSOLE',message.text()); } });
const check = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const state = () => page.evaluate(() => window.__workflow.snapshot());
const input = (selector, value, event = 'input') => page.locator(selector).evaluate((element, { value,event }) => { element.value = String(value); element.dispatchEvent(new Event(event,{bubbles:true})); }, {value,event});
const magentaPixels = file => {
  const data = execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-ss','0.6','-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'], {maxBuffer: 4*1024*1024});
  // VP9 YUV chroma subsampling softens a one-pixel magenta leader/border.
  // Check its hue against the synthetic scene (which has no magenta objects).
  let count=0; for(let i=0;i<data.length;i+=3) if(data[i]>100 && data[i+2]>100 && data[i+1]<.6*Math.min(data[i],data[i+2])) count++;
  return count;
};
const decodedHash = file => createHash('sha256').update(execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-ss','0.6','-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{maxBuffer:4*1024*1024})).digest('hex');
const projection = local => page.evaluate(local => window.__workflow.spatial.project('cad',local),local);
const settled = () => page.waitForFunction(() => { const s=window.__workflow.snapshot(); return s.active && s.presentedTime !== null && !s.buffering && !s.seeking; });
const near = (actual,expected,epsilon=1e-8) => assert.ok(Math.abs(actual-expected)<epsilon,`${actual} differs from ${expected}`);
const tilt = (east,north) => Promise.resolve().then(async()=>{await input('#ccTiltEast',east);await input('#ccTiltNorth',north);});
try {
  await page.goto(`${baseUrl}/tools/fixtures/video-overlay-workflow.html?cadTilt=1`, {waitUntil:'networkidle'});
  console.log('Page loaded, awaiting fixture models');
  await page.waitForFunction(()=>window.__workflow?.snapshot().modelReady);
  const baseline=await state();
  await page.locator('#ccVideoFile').setInputFiles(videoPath);await page.locator('#ccXmlFile').setInputFiles(xmlPath);
  await page.locator('#ccInterval').fill('1');await input('#ccOpacity',1);
  await page.locator('#ccStart').click();await settled();
  await page.locator('#ccTarget').selectOption('*');
  for(const selector of ['#ccHeading','#ccTiltEast','#ccTiltNorth','#ccTiltReset','[data-cc-tilt="tiltEast:1"]']) assert.equal(await page.locator(selector).isEnabled(),true,`${selector} must work in whole-group mode`);
  await page.locator('#ccTarget').selectOption('cad');
  await page.locator('#ccTiltEast').evaluate(element=>element.closest('details').open=true);
  assert.equal(await page.locator('#ccTiltEast').inputValue(),'0');assert.equal(await page.locator('#ccTiltNorth').inputValue(),'0');
  near(Number(await page.locator('#ccTiltStep').inputValue()),.1);
  await page.locator('[data-cc-tilt="tiltEast:1"]').click();near((await state()).adjustments.cad.tiltEast,.1);
  await page.locator('#ccTiltReset').click();
  const playbackLayout = await page.locator('.cc-video-controls').evaluate(el => { const slider=el.querySelector('input[type=range]'),speed=el.querySelector('select');return {controls:el.clientWidth,slider:slider.getBoundingClientRect().width,speed:speed.getBoundingClientRect().width}; });
  assert.ok(playbackLayout.slider > playbackLayout.controls * .9);assert.ok(playbackLayout.speed < playbackLayout.slider * .25);
  check('Default tilt nudge remains 0.1 degrees and the full-width playback slider is preserved',playbackLayout);
  const local=await page.evaluate(()=>window.__workflow.spatial.fromWorld('cad',{x:12,y:18,z:20}));
  const originalPixel=await projection(local);
  const marks=await page.evaluate(async local=>{
    const {createSpatialAnnotation}=await import('/src/videoOverlaySpatialAnnotations.ts');
    return [createSpatialAnnotation('label',{targetId:'cad',targetName:'CAD 控制线',points:[local],text:'CAD 倾角锚点',color:'#ff00ff',fontSize:40,offsetX:70,offsetY:100,start:0,end:2,fadeIn:0,fadeOut:0})];
  },local);
  await page.evaluate(marks=>window.__workflow.spatial.set(marks),marks);
  await input('#ccEast',1.5);await input('#ccNorth',-1);await input('#ccUp',2);await input('#ccHeading',12);
  const beforeTilt=(await state()).geometry.cad;
  await tilt(8,-6);await page.evaluate(()=>window.__workflow.waitOutsideFrames(2));await page.waitForFunction(()=>window.__workflow.spatial.counts().magenta>30);
  assert.notDeepEqual((await state()).geometry.cad,beforeTilt,'Both CAD geometry and annotations must use the tilt transform');
  const tiltedPixel=await projection(local);
  assert.ok(Math.hypot(tiltedPixel.x-originalPixel.x,tiltedPixel.y-originalPixel.y)>.015);
  // Entity polylines rebuild asynchronously after their position property changes.
  // Wait for the real pick buffer, rather than assuming two animation frames suffice.
  const pickedHandle=await page.waitForFunction(({pixel,local})=>{
    try {
      const point=window.__workflow.spatial.pick('cad',pixel.x,pixel.y);
      if(Math.hypot(point.x-local.x,point.y-local.y,point.z-local.z)<.15)return point;
    } catch { /* Wait for Cesium's geometry update. */ }
    return false;
  },{pixel:tiltedPixel,local},{timeout:15000});
  const picked=await pickedHandle.jsonValue();await pickedHandle.dispose();
  assert.ok(Math.hypot(picked.x-local.x,picked.y-local.y,picked.z-local.z)<.15,JSON.stringify({local,picked}));
  assert.deepEqual((await state()).spatialAnnotations,marks,'Tilting must not rewrite saved local annotation anchors');
  check('Individual CAD geometry and its surface-snapped annotation move together',{originalPixel,tiltedPixel,picked});

  const committed=(await state()).adjustments.cad;
  await input('#ccTiltEast',91);assert.deepEqual((await state()).adjustments.cad,committed,'Out-of-range input must not modify saved state');
  await input('#ccTiltEast',91,'change');near(Number(await page.locator('#ccTiltEast').inputValue()),8);
  await input('#ccTiltStep',.25);
  await page.locator('[data-cc-tilt="tiltEast:1"]').click();near((await state()).adjustments.cad.tiltEast,8.25);
  await page.locator('[data-cc-tilt="tiltNorth:-1"]').click();near((await state()).adjustments.cad.tiltNorth,-6.25);
  const adjusted=(await state()).adjustments.cad;
  await page.locator('#ccTiltReset').click();
  const reset=(await state()).adjustments.cad;
  near(reset.tiltEast,0);near(reset.tiltNorth,0);
  for(const field of ['east','north','up','heading'])near(reset[field],adjusted[field]);
  await page.locator('#ccUndo').click();assert.deepEqual((await state()).adjustments.cad,adjusted);
  await page.locator('#ccRedo').click();assert.deepEqual((await state()).adjustments.cad,reset);
  await page.locator('#ccUndo').click();
  check('Tilt validation, configurable nudges, angle-only reset, undo and redo preserve placement and heading',{adjusted,reset});

  await page.locator('#ccTarget').selectOption('*');
  const individualBeforeGroup=structuredClone((await state()).adjustments);
  await page.locator('[data-cc-resource="above-translucent"]').uncheck();
  const groupBaseGeometry=(await state()).geometry;
  // Each CAD endpoint and each distinct model origin is an independent point.
  // A genuine common-pivot tilt preserves all cross-object pair distances;
  // tilting every object around its own origin would fail this assertion.
  const points=geometry=>[...geometry.cad.flat(),...geometry.matrices.map(matrix=>matrix.slice(12,15))];
  const distances=geometry=>{const p=points(geometry),out=[];for(let i=0;i<p.length;i++)for(let j=0;j<i;j++)out.push(Math.hypot(...p[i].map((value,axis)=>value-p[j][axis])));return out;};
  const baseDistances=distances(groupBaseGeometry);
  await input('#ccTiltStep',.1);
  await page.locator('[data-cc-tilt="tiltEast:1"]').click();
  near((await state()).groupAdjustment.values.tiltEast,.1);
  const fixedAnchor=(await state()).groupAdjustment.anchor;
  await input('#ccEast',1);await input('#ccNorth',-.5);await input('#ccUp',.25);await input('#ccHeading',2);
  await tilt(.6,-.4);await page.evaluate(()=>window.__workflow.waitOutsideFrames(2));
  const groupAdjusted=await state();
  assert.deepEqual(groupAdjusted.adjustments,individualBeforeGroup,'Group correction must retain each individual adjustment');
  assert.deepEqual(groupAdjusted.groupAdjustment.anchor,fixedAnchor,'Changing values must not move the shared pivot');
  assert.notDeepEqual(groupAdjusted.geometry.cad,groupBaseGeometry.cad);
  assert.notDeepEqual(groupAdjusted.geometry.matrices,groupBaseGeometry.matrices);
  assert.deepEqual(groupAdjusted.geometry.tilesMatrix,groupBaseGeometry.tilesMatrix,'Whole engineering correction must leave the 3D Tiles reference unchanged');
  await page.locator('[data-cc-resource="above-translucent"]').check();
  assert.deepEqual((await state()).groupAdjustment.anchor,fixedAnchor,'Visibility changes must not recenter the group');
  assert.deepEqual((await state()).geometry,groupAdjusted.geometry,'Showing a member must reveal its existing group-corrected geometry');
  distances(groupAdjusted.geometry).forEach((distance,index)=>near(distance,baseDistances[index],1e-7));
  assert.deepEqual(groupAdjusted.spatialAnnotations,marks,'Whole-group tilt must preserve local annotation anchors');
  const groupPixel=await projection(local);
  assert.ok(Math.hypot(groupPixel.x-tiltedPixel.x,groupPixel.y-tiltedPixel.y)>.001);
  const savedGroup=structuredClone(groupAdjusted.groupAdjustment);
  await page.locator('#ccTiltReset').click();
  const groupReset=(await state()).groupAdjustment;
  near(groupReset.values.tiltEast,0);near(groupReset.values.tiltNorth,0);
  for(const field of ['east','north','up','heading'])near(groupReset.values[field],savedGroup.values[field]);
  await page.locator('#ccUndo').click();assert.deepEqual((await state()).groupAdjustment,savedGroup);
  await page.locator('#ccRedo').click();assert.deepEqual((await state()).groupAdjustment,groupReset);
  await page.locator('#ccUndo').click();assert.deepEqual((await state()).groupAdjustment,savedGroup);
  assert.deepEqual((await state()).adjustments,individualBeforeGroup);
  check('Whole-group two-axis tilt is enabled, moves CAD/models rigidly about one fixed pivot, and supports angle-only reset/undo/redo',{group:savedGroup,independentDistances:baseDistances.length,groupPixel});

  await page.locator('#ccSchemeName').fill('CAD 整体倾角回归');await page.locator('#ccSave').click();
  await page.waitForFunction(()=>window.__workflow.snapshot().saved?.settings.adjustments.cad?.tiltEast===8.25 && window.__workflow.snapshot().saved?.settings.groupAdjustment?.values.tiltEast===.6);
  const saved=(await state()).saved.settings;
  await page.locator('#ccStop').click();
  assert.deepEqual((await state()).geometry,baseline.geometry,'Exiting must restore all source geometry');
  await page.evaluate(()=>window.__workflow.restoreSaved());await page.locator('#ccStart').click();await settled();
  await page.locator('#ccTarget').selectOption('cad');
  assert.deepEqual((await state()).adjustments.cad,saved.adjustments.cad);assert.deepEqual((await state()).spatialAnnotations,marks);
  near(Number(await page.locator('#ccTiltEast').inputValue()),8.25);near(Number(await page.locator('#ccTiltNorth').inputValue()),-6.25);
  assert.deepEqual((await state()).groupAdjustment,saved.groupAdjustment);
  await page.locator('#ccTarget').selectOption('*');
  near(Number(await page.locator('#ccTiltEast').inputValue()),.6);near(Number(await page.locator('#ccTiltNorth').inputValue()),-.4);
  const groupRestored=await state();
  groupRestored.geometry.cad.flat(2).forEach((value,index)=>near(value,groupAdjusted.geometry.cad.flat(2)[index],1e-7));
  groupRestored.geometry.matrices.flat().forEach((value,index)=>near(value,groupAdjusted.geometry.matrices.flat()[index],1e-7));
  check('Fusion save/reopen restores whole-group pivot, both group angles, individual placement and annotation anchors');

  await page.locator('#ccExport').evaluate(button=>button.closest('details').open=true);
  await page.locator('#ccExportStart').fill('0');await page.locator('#ccExportEnd').fill('1.2');
  await page.locator('#ccBuildPreview').click();
  await page.waitForFunction(()=>window.__workflow.snapshot().dimensions.cached?.[0]===640,null,{timeout:180000});
  const cacheBefore=await state();
  assert.equal(cacheBefore.hasResources,false);assert.equal(cacheBefore.pendingCallbacks,0);
  const file=path.join(output,'cad-tilt-native-cache.webm');
  await writeFile(file,Buffer.from(await page.evaluate(()=>window.__workflow.cachedBlob())));
  const firstBytes=Buffer.from(await page.evaluate(()=>window.__workflow.cachedBlob()));
  const firstHash=createHash('sha256').update(firstBytes).digest('hex'), firstPixelHash=decodedHash(file);
  const stream=JSON.parse(execFileSync(ffprobe,['-v','error','-count_frames','-show_streams','-of','json',file],{encoding:'utf8'})).streams.find(stream=>stream.codec_type==='video');
  assert.equal(stream.width,640);assert.equal(stream.height,360);assert.equal(Number(stream.nb_read_frames),18);
  const pts=JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',file],{encoding:'utf8'})).frames.map(frame=>Number(frame.best_effort_timestamp_time));
  pts.forEach((time,index)=>near(time,index/15,.0011));
  const count=magentaPixels(file);assert.ok(count>30,`Cached frame missing label (${count})`);
  await input('#ccTiltEast',1.5);
  near((await state()).groupAdjustment.values.tiltEast,1.5);
  assert.deepEqual((await state()).groupAdjustment.anchor,savedGroup.anchor,'Cached-player edit keeps the saved shared pivot');
  await page.waitForFunction(()=>window.__workflow.snapshot().dimensions.cached===null);await settled();
  await page.locator('#ccBuildPreview').click();
  await page.waitForFunction(()=>window.__workflow.snapshot().dimensions.cached?.[0]===640,null,{timeout:180000});
  const cacheAfter=await state();assert.notEqual(cacheAfter.dimensions.cachedSrc,cacheBefore.dimensions.cachedSrc);
  assert.equal(cacheAfter.hasResources,false);assert.equal(cacheAfter.pendingCallbacks,0);
  const cadRebuilt=Buffer.from(await page.evaluate(()=>window.__workflow.cachedBlob()));
  const cadHash=createHash('sha256').update(cadRebuilt).digest('hex');assert.notEqual(cadHash,firstHash,'Whole-group edit must produce changed rendered bytes');
  await writeFile(path.join(output,'cad-tilt-rebuilt-cache.webm'),cadRebuilt);
  const cadPixelHash=decodedHash(path.join(output,'cad-tilt-rebuilt-cache.webm'));assert.notEqual(cadPixelHash,firstPixelHash,'Decoded pixels must change after whole-group adjustment');
  check('Whole-group tilted CAD/models/label bake into 18 native 640×360 frames; editing group tilt from cached playback invalidates and rebuilds changed pixels',{frames:Number(stream.nb_read_frames),magentaPixels:count,sourceFps:15,pts,firstHash,cadHash,firstPixelHash,cadPixelHash});

  await page.locator('#ccTarget').selectOption('above-opaque');
  await input('#ccTiltNorth',15);await input('#ccEast',4);
  await page.waitForFunction(()=>window.__workflow.snapshot().dimensions.cached===null);await settled();
  const modelAdjustment=(await state()).adjustments['above-opaque'];near(modelAdjustment.tiltNorth,15);near(modelAdjustment.east,4);
  await page.locator('#ccBuildPreview').click();
  await page.waitForFunction(()=>window.__workflow.snapshot().dimensions.cached?.[0]===640,null,{timeout:180000});
  const modelRebuilt=Buffer.from(await page.evaluate(()=>window.__workflow.cachedBlob()));
  const modelHash=createHash('sha256').update(modelRebuilt).digest('hex');assert.notEqual(modelHash,cadHash,'Model edit must produce changed rendered bytes');
  await writeFile(path.join(output,'model-tilt-rebuilt-cache.webm'),modelRebuilt);
  const modelPixelHash=decodedHash(path.join(output,'model-tilt-rebuilt-cache.webm'));assert.notEqual(modelPixelHash,cadPixelHash,'Decoded pixels must change after model adjustment');
  check('Model tilt and translation invalidate CAD cache and rebuild different rendered media',{modelAdjustment,modelHash,modelPixelHash});

  const signatureBeforeExit=await page.evaluate(()=>window.__workflow.cacheSignature());
  await page.locator('#ccStop').click();
  assert.equal(await page.evaluate(()=>window.__workflow.cacheSignature()),signatureBeforeExit);
  const movedMapModel=await page.evaluate(()=>window.__workflow.moveMapModel(6));
  assert.notDeepEqual(movedMapModel.modelMatrix,movedMapModel.recordMatrix);
  const movedSignature=await page.evaluate(()=>window.__workflow.cacheSignature());assert.notEqual(movedSignature,signatureBeforeExit);
  await page.locator('#ccStart').click();await settled();
  assert.equal(await page.evaluate(()=>window.__workflow.cacheSignature()),movedSignature,'AR temporary adjustment must not alter base-placement signature');
  await page.locator('#ccBuildPreview').click();
  await page.waitForFunction(()=>window.__workflow.snapshot().dimensions.cached?.[0]===640,null,{timeout:180000});
  const mapMovedBytes=Buffer.from(await page.evaluate(()=>window.__workflow.cachedBlob()));
  const mapMovedHash=createHash('sha256').update(mapMovedBytes).digest('hex');assert.notEqual(mapMovedHash,modelHash);
  await writeFile(path.join(output,'map-placement-rebuilt-cache.webm'),mapMovedBytes);
  const mapMovedPixelHash=decodedHash(path.join(output,'map-placement-rebuilt-cache.webm'));assert.notEqual(mapMovedPixelHash,modelPixelHash,'Decoded pixels must change after unsaved map placement');
  await page.locator('#ccStop').click();
  assert.equal(await page.evaluate(()=>window.__workflow.cacheSignature()),movedSignature);
  await page.evaluate(()=>window.__workflow.moveMapModel(0));
  check('Unsaved map-model placement changes invalidate cache while AR adjustment keeps its base signature stable',{mapMovedHash,mapMovedPixelHash});
  await page.evaluate(()=>window.__workflow.restoreSaved(true));await page.locator('#ccStart').click();await settled();
  await page.locator('#ccTarget').selectOption('cad');
  near(Number(await page.locator('#ccTiltEast').inputValue()),0);near(Number(await page.locator('#ccTiltNorth').inputValue()),0);
  await page.locator('#ccTarget').selectOption('*');
  near(Number(await page.locator('#ccTiltEast').inputValue()),0);near(Number(await page.locator('#ccTiltNorth').inputValue()),0);
  assert.equal((await state()).groupAdjustment,null);
  await page.locator('#ccStop').click();
  const final=await state();assert.deepEqual(final.geometry,baseline.geometry);assert.deepEqual(final.lifecycle,baseline.lifecycle);assert.deepEqual(final.renderErrors,[]);assert.deepEqual(errors,[]);
  check('Legacy schemes without individual tilt or whole-group fields default to zero; final exit restores original geometry and listeners');
  const cycles=[];
  for(let cycle=1;cycle<=5;cycle++) {
    console.log(`Checking AR exit cycle ${cycle}/5`);
    const mapBefore=await state();
    await page.locator('#ccStart').click();await settled();
    await page.locator('#ccTarget').selectOption('*');await tilt(cycle*.1,-cycle*.1);
    await page.locator('#ccStop').click();
    await page.evaluate(()=>window.__workflow.waitOutsideFrames(3));
    const exited=await state();
    assert.deepEqual(exited.camera.controls,mapBefore.camera.controls);assert.deepEqual(exited.camera.frustum,mapBefore.camera.frustum);
    for(const key of ['position','direction','up','transform']) exited.camera[key].forEach((value,index)=>near(value,mapBefore.camera[key][index],key==='position'?1e-7:1e-8));
    assert.deepEqual(exited.geometry,baseline.geometry);assert.deepEqual(exited.lifecycle,baseline.lifecycle);
    assert.equal(exited.hasResources,false);assert.equal(exited.hasPresentation,false);assert.equal(exited.pendingCallbacks,0);
    assert.equal(exited.animationHandle,null);assert.equal(exited.frameHandle,null);assert.equal(exited.callbacksAfterExit,0);
    assert.equal(exited.presentationDom,0);assert.equal(exited.dimensions.cachedDom,0);assert.equal(exited.dimensions.editorDom,0);assert.equal(exited.dimensions.spatialEditorDom,0);
    assert.ok(exited.released.every(item=>item.disposed&&item.width===0&&item.height===0));
    const pick=await page.evaluate(()=>window.__workflow.mapPick());assert.equal(pick.picked,true);assert.equal(pick.glError,0);
    const canvas=await page.locator('#viewer canvas').boundingBox();
    const start=Date.now();
    await page.mouse.move(canvas.x+canvas.width*.55,canvas.y+canvas.height*.5);
    await page.mouse.down();await page.mouse.move(canvas.x+canvas.width*.58,canvas.y+canvas.height*.52,{steps:5});await page.mouse.up();
    await page.waitForFunction(before=>JSON.stringify(window.__workflow.snapshot().camera.position)!==JSON.stringify(before),exited.camera.position,{timeout:10000});
    const afterPan=await state();
    await page.mouse.wheel(0,-120);
    await page.waitForFunction(before=>Math.abs(window.__workflow.snapshot().camera.height-before)>.001,afterPan.camera.height,{timeout:10000});
    await page.evaluate(()=>window.__workflow.restoreMapCamera());await page.evaluate(()=>window.__workflow.waitOutsideFrames(3));
    cycles.push({cycle,pick,lifecycle:exited.lifecycle,pendingCallbacks:exited.pendingCallbacks,inputResponseMs:Date.now()-start,cameraMaxComponentError:Object.fromEntries(['position','direction','up','transform'].map(key=>[key,Math.max(...exited.camera[key].map((value,index)=>Math.abs(value-mapBefore.camera[key][index])))]))});
  }
  check('Five consecutive AR enter/exit cycles restore camera, real map pan/zoom/picking and release session resources',{cycles});
  report.scope='Synthetic absolute-height Cesium CAD/entities/models and generated 640x360 15fps video. This suite does not cover GroundPrimitive CAD draping or conversion from source DWG. Save/reopen covers frontend settings serialization and restoreReplay, not server persistence/restart or main.ts application tool suspension. Real user DWG, video, machine performance and full application tools require on-site acceptance.';
  const completed=await state();assert.deepEqual(completed.renderErrors,[]);assert.deepEqual(errors,[]);
  report.pass=true;report.final={renderErrors:completed.renderErrors,lifecycle:completed.lifecycle,enterCount:completed.enterCount,exitCount:completed.exitCount};
} catch(error) {
  report.error=String(error.stack||error);report.final=await state().catch(()=>null);
  await page.screenshot({path:path.join(output,'cad-tilt-failure.png')}).catch(()=>{});
} finally {
  await writeFile(path.join(output,'cad-tilt-report.json'),JSON.stringify(report,null,2));
  await browser.close();await server?.close();
}
console.log(JSON.stringify({pass:report.pass,checks:report.checks.length,report:path.join(output,'cad-tilt-report.json'),error:report.error},null,2));
if(!report.pass)process.exitCode=1;
