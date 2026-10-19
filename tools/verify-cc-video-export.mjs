#!/usr/bin/env node
/** Legacy recorder and production offline WebCodecs export, verified with ffprobe. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules', 'playwright'));
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5178';
const server = process.env.START_VITE === '1' ? await (await import('vite')).createServer({ server: {
  host: new URL(baseURL).hostname, port: Number(new URL(baseURL).port), strictPort: true, hmr: false, watch: null,
} }) : undefined;
await server?.listen();
const work = await mkdtemp(path.join(os.tmpdir(), 'cc-video-export-'));
const output = process.env.OUTPUT_DIR || work;
await mkdir(output, { recursive: true });
const source = path.join(work, 'flight-with-audio.mp4');
const ffmpeg = process.env.FFMPEG_EXECUTABLE || 'ffmpeg', ffprobe = process.env.FFPROBE_EXECUTABLE || 'ffprobe';
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x143ca0:s=640x360:r=30:d=5',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', '-vf', "drawbox=x=400:y=0:w=240:h=120:c=yellow:t=fill:enable='gte(t,2)'",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
await page.addInitScript(() => {
  const request = HTMLVideoElement.prototype.requestVideoFrameCallback, cancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;
  const timers = new WeakMap();
  window.__ccExportDelayPaused = false; window.__ccExportDelayedCallbacks = 0;
  window.__ccExportFrameEvents = [];
  const trace = (phase, video, mediaTime) => {
    if (video !== document.querySelector('.cc-video-backdrop video')) return;
    window.__ccExportFrameEvents.push({ phase, mediaTime, currentTime: video.currentTime, seeking: video.seeking, paused: video.paused });
    if (window.__ccExportFrameEvents.length > 300) window.__ccExportFrameEvents.shift();
  };
  for (const type of ['seeking', 'seeked']) document.addEventListener(type, event => trace(type, event.target), true);
  HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
    const video = this;
    const handle = request.call(video, (now, metadata) => {
      trace('native callback', video, metadata.mediaTime);
      // Delay delivery of the sought frame only. Holding an unrelated in-flight
      // frame would artificially suppress registration for the actual seek frame.
      if (window.__ccExportDelayPaused && video.paused && Math.abs(metadata.mediaTime - video.currentTime) < .12) {
        const pending = timers.get(video) || new Map(); timers.set(video, pending);
        window.__ccExportDelayedCallbacks += 1;
        pending.set(handle, setTimeout(() => { pending.delete(handle); trace('delayed delivery', video, metadata.mediaTime); callback(now, metadata); }, 80));
      } else callback(now, metadata);
    });
    return handle;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function(handle) {
    const pending = timers.get(this); if (pending?.has(handle)) { clearTimeout(pending.get(handle)); pending.delete(handle); }
    cancel.call(this, handle);
  };
});
const errors = [], checks = [];
page.on('pageerror', error => errors.push(String(error.stack || error)));
const check = (name, details = {}) => { checks.push({ name, pass: true, ...details }); console.log(`PASS ${name}`); };
function pixel(file, time, x, y) {
  return [...execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},format=rgb24`, '-f', 'rawvideo', 'pipe:1']).subarray(0, 3)];
}
const near = (actual, expected, tolerance = 20) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `${actual} differs from ${expected}`));
try {
  await page.goto(`${baseURL}/tools/fixtures/cc-video-export.html`, { waitUntil: 'networkidle' });
  await page.locator('#video-file').setInputFiles(source);
  await page.waitForFunction(() => window.__ccExportHarness?.ready());
  if (process.env.SKIP_HELPER !== '1') {
  for (const format of ['auto', 'webm']) {
    const downloadPromise = page.waitForEvent('download');
    void downloadPromise.catch(() => undefined);
    const result = await page.evaluate(options => window.__ccExportHarness.run(options), { format, pause: true });
    const download = await downloadPromise, file = path.join(output, `${format}-${download.suggestedFilename()}`);
    await download.saveAs(file);
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
    const video = probe.streams.find(stream => stream.codec_type === 'video'), audio = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video.width, 640); assert.equal(video.height, 360);
    const duration = Number(probe.format.duration || video.duration);
    assert.ok(duration > 2.75 && duration < 3.35, `unexpected recorded duration ${duration}`);
    assert.ok(result.elapsed > 3.45 && result.elapsed < 5.2, `pause was not exercised: ${result.elapsed}`);
    assert.ok(result.progress.some(progress => progress.state === 'paused'));
    assert.equal(result.silent, !audio); assert.equal(result.audioStatus, audio ? 'captured' : 'silent-no-audio');
    assert.ok(audio, 'Chromium captureStream should preserve the generated audio track');
    const samples = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '0.4', '-i', file, '-t', '0.5', '-vn', '-f', 'f32le', 'pipe:1']);
    let squared = 0; for (let i = 0; i + 4 <= samples.length; i += 4) squared += samples.readFloatLE(i) ** 2;
    const rms = Math.sqrt(squared / (samples.length / 4)); assert.ok(rms > .01, `captured audio track is silent: ${rms}`);
    if (result.mimeType.startsWith('video/mp4')) { assert.match(file, /\.mp4$/); assert.equal(video.codec_name, 'h264'); }
    else { assert.match(file, /\.webm$/); assert.ok(['vp8', 'vp9'].includes(video.codec_name)); }
    near(pixel(file, .5, 250, 250), [20, 60, 160]);
    near(pixel(file, .5, 50, 50), [208, 63, 32]);
    near(pixel(file, .5, 50, 200), [255, 0, 255]); near(pixel(file, 2.5, 50, 200), [0, 255, 0]);
    near(pixel(file, .5, 500, 50), [20, 60, 160]); near(pixel(file, 2.5, 500, 50), [255, 255, 0]);
    check(`${format}: source pixels, alpha overlay, synchronized timeline, audio, pause-excluded duration and accurate extension`, {
      file, mimeType: result.mimeType, codec: video.codec_name, audio: audio.codec_name, audioRms: rms, duration, wallSeconds: result.elapsed, bytes: result.bytes, frames: result.frames,
    });
  }
  const cancelled = await page.evaluate(() => window.__ccExportHarness.run({ cancel: true }));
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.progress.at(-1).state, 'cancelled');
  check('cancellation rejects without publishing a partial recording');
  }

  // Exercise the actual controller and Cesium postRender path, using the existing
  // synthetic Model/CAD fixture. The helper-only fixture above checks pixel timing.
  const photo = index => `<Photo><Id>${index}</Id><ImagePath>frame_${index}.jpg</ImagePath><Component>1</Component><Pose><Center><x>${120 + index * .0001}</x><y>30</y><z>120</z></Center><Rotation><Yaw>0</Yaw><Pitch>-45</Pitch><Roll>0</Roll></Rotation></Pose></Photo>`;
  const xml = `<?xml version="1.0"?><BlocksExchange version="3.2"><SpatialReferenceSystems><SRS><Id>0</Id><Name>WGS 84 3D</Name><Definition>EPSG:4979</Definition></SRS></SpatialReferenceSystems><Block><Name>Synthetic export</Name><SRSId>0</SRSId><Photogroups><Photogroup><Name>Camera</Name><CameraModelType>Perspective</CameraModelType><CameraOrientation>XRightYDown</CameraOrientation><ImageDimensions><Width>640</Width><Height>360</Height></ImageDimensions><FocalLengthPixels>500</FocalLengthPixels><PrincipalPoint><x>319.5</x><y>179.5</y></PrincipalPoint><AspectRatio>1</AspectRatio><Skew>0</Skew><Distortion><K1>0</K1><K2>0</K2><K3>0</K3><P1>0</P1><P2>0</P2></Distortion>${[0, 1, 2].map(photo).join('')}</Photogroup></Photogroups></Block></BlocksExchange>`;
  const xmlFile = path.join(work, 'export-cc.xml'); await writeFile(xmlFile, xml);
  await page.goto(`${baseURL}/tools/fixtures/cc-video-overlay.html`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => !!window.__ccOverlayHarness);
  await page.locator('#ccVideoFile').setInputFiles(source); await page.locator('#ccXmlFile').setInputFiles(xmlFile);
  await page.locator('#ccInterval').fill('2'); await page.locator('#ccStart').click();
  await page.waitForFunction(() => window.__ccOverlayHarness.snapshot().active && document.querySelector('[data-cc-seek]'));
  await page.locator('[data-cc-seek]').evaluate(element => { element.value = '2'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => { const s = window.__ccOverlayHarness.snapshot(); return !s.videoSeeking && Math.abs(s.mediaTime - 2) < .04 && document.querySelector('.cc-clock')?.textContent.startsWith('0:02.00'); });
  await page.locator('[data-cc-speed]').selectOption('2');
  await page.locator('#ccExport').evaluate(element => { element.closest('details').open = true; });
  await page.locator('#ccExportStart').fill('1'); await page.locator('#ccExportEnd').fill('3');
  await page.evaluate(async () => {
    const { VideoModelOverlay } = await import('/src/videoModelOverlay.ts');
    const { VideoOverlayPlaybackCompositor } = await import('/src/videoOverlayPlaybackCompositor.ts');
    const wait = VideoModelOverlay.prototype.waitForPresentedStart;
    VideoModelOverlay.prototype.waitForPresentedStart = async function(...args) { window.__offlineController=this; await wait.apply(this,args); await new Promise(resolve=>setTimeout(resolve,45)); };
    const seek = VideoModelOverlay.prototype.seekVideo;
    window.__sameTargetExportHits=0;
    VideoModelOverlay.prototype.seekVideo = function(time) {
      if (this.exportAbort && !this.seeking && !this.video.seeking && this.video.paused && this.sourceTime !== undefined && this.sourceTarget === time && this.video.currentTime === time) window.__sameTargetExportHits++;
      return seek.call(this,time);
    };
    const NativeFrame=window.VideoFrame, encode=VideoEncoder.prototype.encode;
    window.__offlineSourcePts=[]; window.__offlineDetails=[]; window.__gpuEncoded=[]; window.__controllerCpuCopies=0; let sourceTime, detail, compositor;
    const capture = VideoOverlayPlaybackCompositor.prototype.captureSource;
    VideoOverlayPlaybackCompositor.prototype.captureSource = function(...args) { const result = capture.apply(this, args); if (result) compositor=this; return result; };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(image,...args) { if (image instanceof HTMLVideoElement || image instanceof VideoFrame || image instanceof HTMLCanvasElement && image.classList.contains('cesium-widget')) window.__controllerCpuCopies++; return draw.call(this,image,...args); };
    window.VideoFrame=new Proxy(NativeFrame,{construct(target,args) { const frame=Reflect.construct(target,args); if(args[0] instanceof HTMLVideoElement) { sourceTime=frame.timestamp/1e6; detail={pts:sourceTime,target:args[0].currentTime,duration:frame.duration}; } return frame; }});
    VideoEncoder.prototype.encode=function(frame,options) { window.__offlineSourcePts.push(sourceTime); window.__offlineDetails.push(detail); window.__gpuEncoded.push({ pts: frame.timestamp/1e6, sourcePts: compositor?.sourceTime, presentedPts: compositor?.presentedTime, width: frame.displayWidth, height: frame.displayHeight }); return encode.call(this,frame,options); };
    window.__offlineStartedAt=performance.now();
  });
  const controllerDownload = page.waitForEvent('download');
  void controllerDownload.catch(() => undefined);
  await page.locator('#ccExport').click();
  assert.equal(await page.locator('[data-cc-seek]').isDisabled(), true);
  assert.equal(await page.locator('#ccCameraEast').isDisabled(), true);
  let complete;
  try { complete = await controllerDownload; }
  catch (error) {
    console.error('Controller export failure', await page.evaluate(() => ({ state: window.__ccOverlayHarness.snapshot(),
      exportStatus: document.querySelector('#ccExportStatus')?.textContent, info: document.querySelector('#ccOverlayInfo')?.textContent })));
    throw error;
  }
  const controllerFile = path.join(output, `controller-${complete.suggestedFilename()}`);
  await complete.saveAs(controllerFile);
  await page.waitForFunction(() => { const v = document.querySelector('.cc-video-backdrop video'); return v && !v.seeking && v.paused && Math.abs(v.currentTime - 2) < .04 && v.playbackRate === 2 && document.querySelector('.cc-clock')?.textContent.startsWith('0:02.00'); });
  assert.equal(await page.locator('[data-cc-seek]').isDisabled(), false);
  const controllerProbe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', controllerFile], { encoding: 'utf8' }));
  assert.ok(controllerProbe.streams.some(stream => stream.codec_type === 'audio'));
  const counted = JSON.parse(execFileSync(ffprobe, ['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',controllerFile], {encoding:'utf8'}));
  assert.equal(Number(counted.streams[0].nb_read_frames), 60, 'two seconds at 30 fps must contain all 60 frames');
  const pts = JSON.parse(execFileSync(ffprobe, ['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',controllerFile], {encoding:'utf8'})).frames.map(f=>Number(f.best_effort_timestamp_time));
  for (let i=1;i<pts.length;i++) assert.ok(Math.abs(pts[i]-pts[i-1]-1/30)<.0011, 'constant frame cadence');
  const sourcePts=await page.evaluate(()=>window.__offlineSourcePts);
  assert.equal(sourcePts.length,60); assert.equal(new Set(sourcePts).size,60,'30 fps source frames must not be duplicated or skipped: '+JSON.stringify(await page.evaluate(()=>window.__offlineDetails)));
  sourcePts.forEach((time,i)=>assert.ok(Math.abs(time-(1+i/30))<.001,`source frame mismatch ${i}: ${time}`));
  const gpuEncoded = await page.evaluate(() => window.__gpuEncoded);
  assert.equal(gpuEncoded.length,60);
  gpuEncoded.forEach((frame,index)=> { assert.ok(Math.abs(frame.pts-index/30)<1e-6); assert.equal(frame.sourcePts,sourcePts[index]); assert.equal(frame.presentedPts,sourcePts[index]); assert.equal(frame.width,640); assert.equal(frame.height,360); });
  assert.equal(await page.evaluate(() => window.__controllerCpuCopies),0,'controller export must consume the GPU canvas without CPU source-frame copies');
  const wallTime=await page.evaluate(()=>(performance.now()-window.__offlineStartedAt)/1000); assert.ok(wallTime>2.7,'slow renderer must be exercised');
  const pixels = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', controllerFile, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  let orange = 0, cyan = 0, background = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    // Unlit [1,.45,.14] is converted to sRGB, then blended at the
    // controller's .8 opacity over [20,60,160]. Correct OIT alpha must
    // preserve that orange (~[208,154,115]), rather than oversaturating it.
    if (Math.abs(r - 208) < 25 && Math.abs(g - 154) < 25 && Math.abs(b - 115) < 25) orange += 1;
    if (r < 100 && g > 90 && b > 90 && g > r * 1.5 && b > r * 1.5) cyan += 1;
    if (Math.abs(r - 20) < 15 && Math.abs(g - 60) < 15 && Math.abs(b - 160) < 15) background += 1;
  }
  assert.ok(orange > 50 && cyan > 25 && background > 10000, `missing source/Cesium pixels: ${JSON.stringify({ orange, cyan, background })}`);
  // Spatial and temporal source oracle catches VideoFrame upload flips as well
  // as stale texture reuse. These probes run after encoding, outside playback.
  near(pixel(controllerFile,.5,500,50),[20,60,160]);
  near(pixel(controllerFile,1.5,500,50),[255,255,0]);
  near(pixel(controllerFile,1.5,500,300),[20,60,160]);
  check('offline export preserves all 60 frames and constant 30 fps under delayed rendering, with paired GPU Model/CAD pixels and audio', { file: controllerFile, frames:60, frameRate:30, wallTime, orange, cyan, background });
  await page.evaluate(async () => {
    const original = VideoEncoder.prototype.encode;
    window.__ccExportAcceptedTimes = [];
    VideoEncoder.prototype.encode = function(frame, options) {
      window.__ccExportAcceptedTimes.push(frame.timestamp / 1e6);
      return original.call(this, frame, options);
    };
  });
  // Force seeked to precede delivery of a paused decoded-frame callback. This
  // must not turn the requested seek time into a fabricated camera/frame PTS.
  await page.evaluate(() => { window.__ccExportDelayPaused = true; });
  await page.locator('[data-cc-seek]').evaluate(element => { element.value = '1.15'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => { const v = document.querySelector('.cc-video-backdrop video'); return v && !v.seeking && v.paused && Math.abs(v.currentTime - 1.15) < .001 && document.querySelector('.cc-clock')?.textContent.startsWith('0:01.13'); });
  await page.locator('[data-cc-seek]').evaluate(element => { element.value = '2'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('.cc-clock')?.textContent.startsWith('0:02.00'));
  await page.locator('#ccExportStart').fill('0.15'); await page.locator('#ccExportEnd').fill('1.165');
  const fractionalDownload = page.waitForEvent('download'); void fractionalDownload.catch(() => undefined);
  await page.locator('#ccExport').click(); const fractional = await fractionalDownload;
  await fractional.saveAs(path.join(output, `fractional-${fractional.suggestedFilename()}`));
  const acceptedTimes = await page.evaluate(() => window.__ccExportAcceptedTimes);
  assert.ok(acceptedTimes.length > 5);
  assert.ok(acceptedTimes.every(time => Math.abs(time * 30 - Math.round(time * 30)) < .001), `fabricated seek timestamp committed: ${acceptedTimes.slice(0, 8)}`);
  await page.waitForFunction(() => { const v = document.querySelector('.cc-video-backdrop video'); return v && !v.seeking && v.paused && Math.abs(v.currentTime - 2) < .04 && v.playbackRate === 2 && document.querySelector('.cc-clock')?.textContent.startsWith('0:02.00'); });
  const delayedCallbacks = await page.evaluate(() => { window.__ccExportDelayPaused = false; return window.__ccExportDelayedCallbacks; });
  assert.ok(delayedCallbacks >= 3);
  check('delayed paused callbacks preserve actual decoded PTS, fractional export and paused seek without hanging', { acceptedTimes, delayedCallbacks });
  // A paused frame already sought to the exporter's precise first target
  // must be recaptured after presentedTime invalidation, rather than rejected
  // by the normal immutable in-flight-frame guard.
  await page.locator('[data-cc-seek]').evaluate(element => { element.step='0.0001'; element.value='2.0001'; element.dispatchEvent(new Event('input',{bubbles:true})); });
  await page.waitForFunction(() => { const c=window.__offlineController; return c && c.sourceTarget === 2.0001 && c.video.currentTime === 2.0001 && c.video.paused && !c.video.seeking && !c.seeking && !c.buffering && c.presentedTime === 2; });
  await page.locator('#ccExportStart').fill('2'); await page.locator('#ccExportEnd').fill('2.2');
  await page.evaluate(() => { window.__sameTargetExportHits=0; window.__offlineSourcePts=[]; window.__offlineDetails=[]; window.__gpuEncoded=[]; });
  const sameTargetStarted=Date.now(), sameTargetDownload=page.waitForEvent('download',{timeout:15000}); void sameTargetDownload.catch(()=>undefined);
  await page.locator('#ccExport').click(); const sameTarget=await sameTargetDownload;
  const sameTargetFile=path.join(output,`same-target-${sameTarget.suggestedFilename()}`); await sameTarget.saveAs(sameTargetFile);
  const sameTargetFrames=JSON.parse(execFileSync(ffprobe,['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',sameTargetFile],{encoding:'utf8'}));
  assert.equal(Number(sameTargetFrames.streams[0].nb_read_frames),6);
  const sameTargetMeta=await page.evaluate(()=>({ hits:window.__sameTargetExportHits, sourcePts:window.__offlineSourcePts, frames:window.__gpuEncoded }));
  assert.ok(sameTargetMeta.hits>=1,'must exercise the exact same-target export seek branch'); assert.equal(sameTargetMeta.frames.length,6);
  sameTargetMeta.frames.forEach((frame,index)=>{ assert.ok(Math.abs(frame.pts-index/30)<1e-6); assert.ok(Math.abs(frame.sourcePts-(2+index/30))<.000001); assert.equal(frame.presentedPts,frame.sourcePts); });
  const sameTargetWallSeconds=(Date.now()-sameTargetStarted)/1000; assert.ok(sameTargetWallSeconds<15,'same-target export must finish without the 45-second readiness timeout');
  await page.waitForFunction(()=>{ const c=window.__offlineController; return c && c.video.paused && !c.video.seeking && !c.seeking && !c.buffering && c.presentedTime===2 && c.video.playbackRate===2; });
  check('paused exact same-target export recaptures its first frame and completes all six GPU frames without a readiness deadlock',{file:sameTargetFile,frames:6,sameTargetHits:sameTargetMeta.hits,wallSeconds:sameTargetWallSeconds});
  await page.locator('#ccExportStart').fill('1'); await page.locator('#ccExportEnd').fill('3');
  await page.locator('#ccExport').click();
  await page.waitForFunction(() => !document.querySelector('#ccExportCancel').disabled);
  await page.locator('#ccExportCancel').click();
  await page.waitForFunction(() => document.querySelector('#ccExportStatus').textContent.includes('已取消'));
  await page.waitForFunction(() => { const v = document.querySelector('.cc-video-backdrop video'); return v && !v.seeking && v.paused && Math.abs(v.currentTime - 2) < .04 && v.playbackRate === 2 && document.querySelector('.cc-clock')?.textContent.startsWith('0:02.00'); });
  check('controller cancellation restores the original viewing state');
  await page.locator('#ccExport').click(); await page.locator('#ccStop').click();
  await page.waitForFunction(() => !window.__ccOverlayHarness.snapshot().active);
  assert.equal(await page.locator('#ccExport').isDisabled(), false);
  check('leaving AR cancels recording without restoring a departed AR session');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'cc-video-export-report.json'), JSON.stringify({ checks, browserErrors: errors }, null, 2));
  console.log(`Report: ${path.join(output, 'cc-video-export-report.json')}`);
} catch (error) {
  console.error('Export verification state', await page.evaluate(() => {
    const video = document.querySelector('.cc-video-backdrop video');
    return { url: location.pathname, exportStatus: document.querySelector('#ccExportStatus')?.textContent,
      info: document.querySelector('#ccOverlayInfo')?.textContent, clock: document.querySelector('.cc-clock')?.textContent,
      videoTime: video?.currentTime, paused: video?.paused, seeking: video?.seeking,
      delayedCallbacks: window.__ccExportDelayedCallbacks, acceptedTimes: window.__ccExportAcceptedTimes, frameEvents: window.__ccExportFrameEvents?.slice(-25) };
  }).catch(() => undefined));
  throw error;
} finally { await browser.close(); await server?.close(); }
