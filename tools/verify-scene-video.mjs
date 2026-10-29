/** Real Chromium proof: shipped crane in one Cesium Viewer, MediaRecorder output decoded as video.
 * PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BROWSER_EXECUTABLE=/path/to/chromium node tools/verify-scene-video.mjs
 * Temporary fixture/data and reports are isolated from user projects.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

await mkdir('tmp', { recursive: true });
const temporary = await mkdtemp(resolve('tmp/scene-video-'));
const output = resolve(process.env.SCENE_VIDEO_VERIFY_OUT || 'output/scene-video');
await mkdir(output, { recursive: true });
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = temporary;
const report = { classification: 'actual-cesium-canvas-recording-and-browser-video-decoding', checks: [], pageErrors: [], startedAt: new Date().toISOString() };
let server, browser, page;
async function check(id, run) {
  const item = { id, status: 'running' }; report.checks.push(item); console.log('RUN', id);
  try { item.evidence = await run(); item.status = 'passed'; console.log('PASS', id); }
  catch (error) { item.status = 'failed'; item.error = error.stack; throw error; }
}
// The product deliberately denies raw /tmp and /output URLs. Serve only this
// disposable, nonsensitive fixture from the normal Vite HTML entry boundary.
const fixture = resolve(`scene-video-verify-${basename(temporary)}.html`);
await writeFile(fixture, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#152332;color:#fff;font:14px sans-serif}#view{width:960px;height:540px}#controls{padding:12px;width:900px}canvas{display:block}</style></head>
<body><div id="view"></div><div id="controls"></div><script type="module">
import {Viewer,Cartesian3,Color,Math as CM} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {MachineryScene} from '/src/machineryScene.ts';
import {loadMachineryAsset,defaultMachineryParameters,MACHINERY_ASSET_VERSION} from '/src/machinery/index.ts';
import {SceneVideoExportUi} from '/src/sceneVideoExportUi.ts';
import {SceneVideoRecorder,supportedSceneVideoFormats} from '/src/sceneVideoRecorder.ts';
window.fixtureReady=(async()=>{window.fixtureStep='viewer';
const viewer=new Viewer('view',{baseLayer:false,animation:false,timeline:false,geocoder:false,homeButton:false,
sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,baseLayerPicker:false,selectionIndicator:false,
infoBox:false,requestRenderMode:true,maximumRenderTimeChange:Infinity,contextOptions:{webgl:{preserveDrawingBuffer:false}}});
viewer.scene.globe.baseColor=Color.fromCssColorString('#325461'); viewer.scene.globe.enableLighting=false;
const scene=new MachineryScene(viewer); window.fixtureStep='asset';const asset=await loadMachineryAsset('crane');
const state={schemaVersion:1,assetId:'crane',assetVersion:MACHINERY_ASSET_VERSION,proportional:true,
parameters:defaultMachineryParameters(asset),placement:{longitude:116.391,latitude:39.907,height:0,heading:0},visible:true};
window.fixtureStep='preview';await scene.preview('test-crane',state,asset); window.fixtureStep='fly';await scene.flyTo('test-crane');window.fixtureStep='controls';
viewer.entities.add({position:Cartesian3.fromDegrees(116.39108,39.90703,2),box:{dimensions:new Cartesian3(3,3,4),material:Color.RED}});
viewer.entities.add({position:Cartesian3.fromDegrees(116.39094,39.90704,1.5),box:{dimensions:new Cartesian3(3,3,3),material:Color.LIME}});
let requests=0;const native=viewer.scene.requestRender.bind(viewer.scene); viewer.scene.requestRender=()=>{requests++;native()};
const ui=new SceneVideoExportUi({viewer,host:document.getElementById('controls'),onPrepare:async view=>{if(view==='preset')await scene.flyTo('test-crane')},fileName:()=> '真实场景录像验证'});
window.demo={viewer,scene,state,asset,ui,SceneVideoRecorder,supportedSceneVideoFormats,requests:()=>requests};
native();return true;
})().catch(error=>{window.fixtureError=error.stack;throw error});
</script></body></html>`);

async function decoded(resultExpression) {
  return page.evaluate(async expression => {
    const result = expression === 'ui' ? window.demo.ui.recorder.result : window.alternateResult;
    if (!result) throw new Error('No completed video');
    const video = document.createElement('video'), url = URL.createObjectURL(result.blob);
    video.muted = true; video.preload = 'auto'; video.src = url; document.body.append(video);
    try {
      await new Promise((done, fail) => { video.onloadedmetadata = done; video.onerror = () => fail(new Error('Encoded output could not decode')); });
      const duration = video.duration, width = video.videoWidth, height = video.videoHeight;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); const samples = [];
      for (const at of [.25, Math.min(1.7, duration * .6)]) {
        video.currentTime = at;
        await new Promise((done, fail) => { video.onseeked = done; video.onerror = () => fail(new Error('Encoded frame could not seek')); });
        ctx.drawImage(video, 0, 0); const pixels = ctx.getImageData(0, 0, width, height).data;
        let visible = 0, colored = 0, red = 0, green = 0, hash = 0;
        for (let i = 0; i < pixels.length; i += 16) {
          const r=pixels[i],g=pixels[i+1],b=pixels[i+2]; if (r+g+b>30)visible++;
          if(Math.max(r,g,b)-Math.min(r,g,b)>30)colored++;
          if(r>g*1.6&&r>b*1.6&&r>80)red++;
          if(g>r*1.6&&g>b*1.6&&g>80)green++;
          hash=(Math.imul(hash,31)+r+g*3+b*7)|0;
        }
        samples.push({at,visible,colored,red,green,hash,readyState:video.readyState,currentTime:video.currentTime});
      }
      const encoded = new Uint8Array(await result.blob.arrayBuffer());
      return {mimeType:result.mimeType,fileName:result.fileName,bytes:encoded.length,duration,width,height,samples,magic:Array.from(encoded.slice(0,12))};
    } finally { video.remove(); URL.revokeObjectURL(url); }
  }, resultExpression);
}
try {
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const options=process.env.BROWSER_LAUNCH_OPTIONS ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
    : {headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']};
  server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false,watch:null}}); await server.listen();
  browser=await chromium.launch(options); report.browserVersion=browser.version();
  page=await browser.newPage({viewport:{width:1020,height:940},acceptDownloads:true}); page.setDefaultTimeout(30000);
  page.on('pageerror',e=>{report.pageErrors.push(e.message);console.error('PAGE',e.message)});
  page.on('console',message=>{if(message.type()==='error')console.error('CONSOLE',message.text())});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${basename(fixture)}`);
  await page.waitForFunction(()=>window.demo || window.fixtureError,undefined,{timeout:60000});
  assert.equal(await page.evaluate(()=>window.fixtureError),undefined);
  await page.waitForTimeout(1000);
  await page.screenshot({path:resolve(output,'scene-ready.png')});
  await check('one-real-viewer-no-idle-recorder-loop',async()=>{
    const before=await page.evaluate(()=>({requests:demo.requests(),canvases:document.querySelectorAll('.cesium-widget canvas').length,
      timer:demo.ui.recorder.renderTimer,attributes:demo.viewer.canvas.getContext('webgl2').getContextAttributes()}));
    await page.waitForTimeout(300);
    const after=await page.evaluate(()=>demo.requests());
    assert.equal(before.canvases,1);assert.equal(before.timer,undefined);assert.equal(before.attributes.preserveDrawingBuffer,false);
    assert.equal(await page.evaluate(()=>demo.ui.recorder.stream),undefined);
    return {...before,requestsAfter:after};
  });
  await check('webm-decodes-scene-and-live-pose-not-black',async()=>{
    await page.locator('[data-scene-video-role=duration]').fill('6');await page.locator('[data-scene-video-action=start]').click();
    await page.waitForFunction(()=>demo.ui.recorder.snapshot.state==='recording',undefined,{polling:25});
    await page.waitForTimeout(700);
    console.log('CAPTURE_DIAGNOSTIC',await page.evaluate(async()=>{demo.state.placement.heading=110;await demo.scene.preview('test-crane',demo.state,demo.asset);return{frames:demo.ui.recorder.capturedFrames,renderer:demo.viewer.useDefaultRenderLoop,running:demo.viewer.cesiumWidget._renderLoopRunning,state:demo.ui.recorder.snapshot,frame:demo.viewer.scene.frameState.frameNumber,canvas:demo.viewer.canvas.getBoundingClientRect().toJSON()}}));
    await page.waitForFunction(()=>['complete','error','cancelled'].includes(demo.ui.recorder.snapshot.state),undefined,{timeout:20000,polling:100});
    assert.equal(await page.evaluate(()=>demo.ui.recorder.snapshot.state),'complete',JSON.stringify(await page.evaluate(()=>demo.ui.recorder.snapshot)));
    const downloadEvent=page.waitForEvent('download');await page.locator('[data-scene-video-action=download]').click();
    const download=await downloadEvent;await download.saveAs(resolve(output,'actual-scene.webm'));
    const result=await decoded('ui');console.log('DECODED',JSON.stringify(result));report.decoded=result;assert.match(result.mimeType,/^video\/webm/);assert.deepEqual(result.magic.slice(0,4),[26,69,223,163]);
    assert.ok(result.duration>=5.8&&result.duration<9);assert.equal(result.width,960);assert.equal(result.height,540);
    assert.ok(result.samples.every(sample=>sample.visible>50000&&sample.colored>5000));
    assert.notEqual(result.samples[0].hash,result.samples[1].hash);
    await page.screenshot({path:resolve(output,'actual-scene.png')});return result;
  });
  await check('supported-mp4-is-real-mp4-and-decodes',async()=>{
    const formats=await page.evaluate(()=>demo.supportedSceneVideoFormats());
    if(!formats.includes('mp4'))return {supported:false,assertion:'MP4 unavailable; UI option disabled',disabled:await page.locator('[data-scene-video-role=format] option[value=mp4]').isDisabled()};
    await page.evaluate(async()=>{window.alternate=new demo.SceneVideoRecorder(demo.viewer,{onComplete:result=>{window.alternateResult=result}});await alternate.start({format:'mp4',maxDurationSeconds:2})});
    await page.waitForFunction(()=>window.alternateResult,undefined,{timeout:15000});
    const result=await decoded('alternate');assert.match(result.mimeType,/^video\/mp4/);assert.equal(String.fromCharCode(...result.magic.slice(4,8)),'ftyp');
    assert.ok(result.duration >= 1.8 && result.duration <= 4.5, `A 2-second MP4 must not contain a long startup segment: ${result.duration}s`);
    assert.ok(result.samples[0].visible>50000);await page.evaluate(()=>alternate.destroy());return result;
  });
  await check('cancel-unlocks-canvas-and-cleans-render-loop',async()=>{
    const result=await page.evaluate(async()=>{
      const recorder=new demo.SceneVideoRecorder(demo.viewer), contender=new demo.SceneVideoRecorder(demo.viewer);
      await recorder.start();let collision='';try{await contender.start()}catch(error){collision=error.message}
      recorder.cancel('测试切换项目');await contender.start();contender.cancel();recorder.destroy();contender.destroy();
      return {collision,state:recorder.snapshot.state,renderTimer:recorder.renderTimer,stream:recorder.stream,encoder:recorder.encoder,canvasCount:document.querySelectorAll('.cesium-widget canvas').length,requests:demo.requests()};
    });
    await page.waitForTimeout(500);result.requestsAfter=await page.evaluate(()=>demo.requests());
    assert.match(result.collision,/正在录制其他/);assert.equal(result.state,'cancelled');assert.equal(result.renderTimer,undefined);assert.equal(result.stream,undefined);assert.equal(result.canvasCount,1);return result;
  });
  assert.deepEqual(report.pageErrors,[]);
} catch(error) { report.failure=error.stack;process.exitCode=1;console.error(error);if(page){report.pageState=await page.evaluate(()=>({url:location.href,title:document.title,step:window.fixtureStep,recorder:window.demo?.ui.recorder.snapshot,capturedFrames:window.demo?.ui.recorder.capturedFrames,body:document.body.innerText.slice(0,1000)})).catch(()=>null);await page.screenshot({path:resolve(output,'failure.png'),timeout:5000}).catch(()=>{});} }
finally {report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close();await rm(fixture,{force:true});}
