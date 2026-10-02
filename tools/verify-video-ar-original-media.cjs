// Read-only original DJI HEVC validation. No proxy, no production application state.
// PLAYWRIGHT_MODULE may point to an absolute installed Playwright package.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const original = path.join(root, 'project-data/records/04cc67b0-4208-4fb4-9706-d064a45cefaf/video/DJI_20260819162016_0001_V_航点1.mp4');
const out = path.join(root, 'output/video-ar-execution-20261002/media');
const times = [0, 10.01, 30, 60, 90, 114];
const origin = process.env.VIDEO_AR_BASE_URL || 'http://localhost:5173';
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
let browser;
const result = { schema: 'video-ar-original-media/v1', startedAt: new Date().toISOString(), original, proxyUsed: false, requestedTimes: times, samples: [], errors: [] };
(async () => {
  await fs.mkdir(out, { recursive: true });
  result.before = { bytes: (await fs.stat(original)).size, sha256: await digest(original) };
  const ffprobe = path.join(root, 'video_ar_backend/tools/FFmpeg/bin/ffprobe.exe');
  const metadata = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,codec_tag_string,profile,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration', '-of', 'json', original], { windowsHide: true });
  result.ffprobe = JSON.parse(metadata.stdout);
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  result.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1000, height: 650 } });
  const page = await context.newPage();
  const requests = [];
  page.on('response', response => { if (response.url().includes('/@fs/')) requests.push({ status: response.status(), url: response.url(), contentType: response.headers()['content-type'], contentRange: response.headers()['content-range'] }); });
  page.on('pageerror', error => result.errors.push(String(error)));
  await page.route(origin + '/__original_media_probe__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Original DJI media probe</title><video id="v" muted controls playsinline style="width:960px"></video>' }));
  await page.goto(origin + '/__original_media_probe__');
  const mediaUrl = origin + '/@fs/' + encodeURI(original.replaceAll('\\', '/'));
  result.url = mediaUrl;
  const headerResponse = await fetch(mediaUrl, { headers: { Range: 'bytes=0-63' } });
  const headerBytes = Buffer.from(await headerResponse.arrayBuffer());
  result.httpPreflight = { status: headerResponse.status, contentType: headerResponse.headers.get('content-type'), contentRange: headerResponse.headers.get('content-range'), first64Hex: headerBytes.subarray(0, 64).toString('hex'), bytesReceived: headerBytes.length };
  if (headerResponse.status !== 206 || result.httpPreflight.contentType !== 'video/mp4' || headerBytes.subarray(4, 8).toString() !== 'ftyp') throw new Error('Original MP4 HTTP range response verification failed');
  result.initial = await page.evaluate(async url => {
    const v = document.querySelector('video');
    window.probeFrames = [];
    window.probeEvents = [];
    for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'seeking', 'seeked', 'playing', 'pause', 'error', 'stalled']) v.addEventListener(event, () => window.probeEvents.push({ event, at: performance.now(), currentTime: v.currentTime, readyState: v.readyState, error: v.error ? { code: v.error.code, message: v.error.message } : null }));
    const callback = (_, meta) => {
      window.probeFrames.push({ mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames, width: meta.width, height: meta.height, currentTime: v.currentTime, paused: v.paused, seeking: v.seeking, at: performance.now() });
      v.requestVideoFrameCallback(callback);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(callback);
    const capability = { userAgent: navigator.userAgent, rvfc: typeof v.requestVideoFrameCallback === 'function', hevcHvc1: v.canPlayType('video/mp4; codecs="hvc1"'), hevcHev1: v.canPlayType('video/mp4; codecs="hev1"') };
    v.src = url;
    v.load();
    const end = performance.now() + 25000;
    while (performance.now() < end && !v.error && v.readyState < 2) await new Promise(resolve => setTimeout(resolve, 100));
    return { ...capability, readyState: v.readyState, networkState: v.networkState, currentTime: v.currentTime, width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : null, error: v.error ? { code: v.error.code, message: v.error.message } : null };
  }, mediaUrl);
  if (result.initial.error || result.initial.readyState < 2) {
    result.decodePassed = false;
    result.errors.push(result.initial.error || 'Original video did not decode within 25 seconds');
  } else {
    for (const requestedTime of times) {
      const sample = await page.evaluate(async requestedTime => {
        const v = document.querySelector('video');
        v.pause();
        const beforeCount = window.probeFrames.length;
        v.currentTime = requestedTime;
        const end = performance.now() + 12000;
        let frame;
        while (performance.now() < end && !v.error) {
          frame = window.probeFrames.at(-1);
          if (!v.seeking && v.readyState >= 2 && frame && Math.abs(frame.mediaTime - requestedTime) < 0.06 && (window.probeFrames.length > beforeCount || requestedTime === 0)) break;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        const seekMatched = Boolean(!v.seeking && frame && Math.abs(frame.mediaTime - requestedTime) < 0.06);
        const pausedTime = v.currentTime;
        await new Promise(resolve => setTimeout(resolve, 200));
        const canvas = document.createElement('canvas'); canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        let jpeg = null, canvasError = null;
        try { canvas.getContext('2d').drawImage(v, 0, 0); jpeg = canvas.toDataURL('image/jpeg', 0.9); } catch (error) { canvasError = String(error); }
        return { requestedTime, seekMatched, frame, currentTime: v.currentTime, paused: v.paused, pausedTimeUnchanged: v.currentTime === pausedTime, readyState: v.readyState, seeking: v.seeking, ptsDeltaSeconds: frame ? frame.mediaTime - requestedTime : null, quality: v.getVideoPlaybackQuality?.(), canvasError, jpeg, error: v.error ? { code: v.error.code, message: v.error.message } : null };
      }, requestedTime);
      if (sample.jpeg) {
        const file = `original-${requestedTime.toFixed(2)}s.jpg`;
        await fs.writeFile(path.join(out, file), Buffer.from(sample.jpeg.split(',')[1], 'base64'));
        sample.frameFile = file;
      }
      delete sample.jpeg;
      result.samples.push(sample);
      console.log(JSON.stringify({ requestedTime, seekMatched: sample.seekMatched, mediaTime: sample.frame?.mediaTime, error: sample.error }));
    }
    result.playback = await page.evaluate(async () => {
      const v = document.querySelector('video');
      v.currentTime = 10.01;
      while (v.seeking) await new Promise(resolve => setTimeout(resolve, 20));
      const before = window.probeFrames.length;
      try { await v.play(); } catch (error) { return { passed: false, error: String(error) }; }
      await new Promise(resolve => setTimeout(resolve, 1500));
      v.pause();
      const frames = window.probeFrames.slice(before);
      const pauseTime = v.currentTime;
      await new Promise(resolve => setTimeout(resolve, 250));
      return { passed: frames.length > 5 && v.currentTime === pauseTime, paused: v.paused, pausedTimeUnchanged: v.currentTime === pauseTime, framesReceived: frames.length, first: frames[0], last: frames.at(-1), currentTime: v.currentTime };
    });
    result.decodePassed = result.samples.length === times.length && result.samples.every(s => s.seekMatched && s.paused && s.pausedTimeUnchanged && !s.error && !s.canvasError) && result.playback.passed;
  }
  result.events = await page.evaluate(() => window.probeEvents);
  result.frames = await page.evaluate(() => window.probeFrames);
  result.mediaResponses = requests;
})().catch(error => { result.errors.push({ message: error.message, stack: error.stack }); result.decodePassed = false; }).finally(async () => {
  await browser?.close();
  result.after = { bytes: (await fs.stat(original)).size, sha256: await digest(original) };
  result.originalUnchanged = result.before?.sha256 === result.after.sha256;
  result.finishedAt = new Date().toISOString();
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ decodePassed: result.decodePassed, originalUnchanged: result.originalUnchanged, output: path.join(out, 'result.json'), errors: result.errors }));
  process.exitCode = result.decodePassed && result.originalUnchanged ? 0 : 1;
});
