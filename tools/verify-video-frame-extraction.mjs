#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5173';
const server = process.env.START_VITE === '1' ? await (await import('vite')).createServer({ server: { host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port) || 5173, strictPort: true, hmr: false, watch: null } }) : undefined;
await server?.listen();
const work = await mkdtemp(path.join(os.tmpdir(), 'video-frames-')), output = process.env.OUTPUT_DIR || work; await mkdir(output, { recursive: true });
const videoPath = path.join(work, 'synthetic-flight.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=lime:s=320x180:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
let executablePath = process.env.BROWSER_EXECUTABLE, args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
if (process.env.CHROMIUM_MODULE) {
  const modulePath = process.env.CHROMIUM_MODULE, manifest = JSON.parse(await readFile(path.join(modulePath, 'package.json'), 'utf8'));
  const packaged = (await import(pathToFileURL(path.resolve(modulePath, manifest.main || manifest.exports?.['.']?.default || 'build/index.js')).href)).default;
  executablePath ||= await packaged.executablePath(); args = [...packaged.args, '--enable-unsafe-swiftshader'];
}
const browser = await chromium.launch({ headless: true, executablePath, args }), page = await browser.newPage();
const errors = [], checks = []; page.on('pageerror', error => errors.push(String(error))); let report;
const record = name => { checks.push({ name, pass: true }); console.log(`PASS ${name}`); };
try {
  await page.goto(`${baseUrl}/tools/fixtures/video-frame-extraction.html`); await page.waitForFunction(() => !!window.__frames);
  await page.locator('#file').setInputFiles(videoPath);
  const first = await page.evaluate(async () => {
    const file = document.querySelector('#file').files[0], original = document.querySelector('#original'), originalUrl = URL.createObjectURL(file);
    original.src = originalUrl; await original.play(); const before = original.currentTime;
    const result = await window.__frames.extractVideoFrames(file, { intervalSeconds: .7, maxWidth: 160 });
    const after = original.currentTime, originalUnchanged = original.src === originalUrl && !original.paused;
    original.pause(); original.removeAttribute('src'); original.load(); URL.revokeObjectURL(originalUrl);
    return { manifest: result.manifest, zip: Array.from(new Uint8Array(await result.output.blob.arrayBuffer())), before, after, originalUnchanged, videos: document.querySelectorAll('video').length };
  });
  assert.equal(first.manifest.frames.length, 5); assert.equal(first.manifest.extraction.width, 160); assert.equal(first.manifest.extraction.height, 90);
  assert.ok(first.originalUnchanged); assert.ok(first.after >= first.before); assert.equal(first.videos, 1);
  for (const [index, frame] of first.manifest.frames.entries()) assert.ok(Math.abs(frame.mediaTime - [0, .7, 1.4, 2.1, 2.8][index]) < .001, JSON.stringify(frame));
  const zipPath = path.join(output, 'extracted-test.zip'); await writeFile(zipPath, Uint8Array.from(first.zip));
  execFileSync('python', ['-c', 'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; m=json.loads(z.read("video-frame-manifest.json")); assert len(m["frames"])==5; z.extractall(sys.argv[2])', zipPath, path.join(output, 'frames')]);
  record('real paused seek captures frame zero and subsequent decoded PTS, preserves aspect ratio, produces valid ZIP and leaves original video playing');
  const colorEvidence = await page.evaluate(async bytes => {
    const view = new DataView(new Uint8Array(bytes).buffer), evidence = []; let offset = 0;
    while (view.getUint32(offset, true) === 0x04034b50) {
      const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), start = offset + 30 + nameLength;
      const name = new TextDecoder().decode(new Uint8Array(view.buffer, offset + 30, nameLength));
      if (name.endsWith('.jpg')) {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(view.buffer, start, size)], { type: 'image/jpeg' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); evidence.push({ name, rgba: [...context.getImageData(10, 10, 1, 1).data] }); bitmap.close();
      }
      offset = start + size;
    } return evidence;
  }, first.zip);
  colorEvidence.forEach((sample, index) => { const channel = index < 2 ? 0 : index < 3 ? 1 : 2; assert.ok(sample.rgba[channel] > 240); assert.ok(sample.rgba.filter((_, i) => i < 3 && i !== channel).every(v => v < 15)); });
  record('JPEG pixels match the decoded frame PTS, including real color transitions');
  const range = await page.evaluate(async () => (await window.__frames.extractVideoFrames(document.querySelector('#file').files[0], { start: .15, end: 2.55, count: 4 })).manifest);
  assert.equal(range.frames.length, 4); for (const [index, frame] of range.frames.entries()) assert.ok(Math.abs(frame.mediaTime - [.1, .9, 1.7, 2.5][index]) < .001, JSON.stringify(frame));
  record('requested subframe timestamps map to actual decoded timestamps rather than requested currentTime');
  const noCallback = await page.evaluate(async () => {
    const prototype = HTMLVideoElement.prototype, request = prototype.requestVideoFrameCallback, cancel = prototype.cancelVideoFrameCallback;
    const NativeFrame = window.VideoFrame, close = NativeFrame.prototype.close;
    let requested = 0, cancelled = 0, createdFrames = 0, closedFrames = 0;
    prototype.requestVideoFrameCallback = function () { return ++requested; };
    prototype.cancelVideoFrameCallback = function () { ++cancelled; };
    window.VideoFrame = new Proxy(NativeFrame, { construct(target, args) { ++createdFrames; return Reflect.construct(target, args); } });
    NativeFrame.prototype.close = function () { ++closedFrames; return close.call(this); };
    try {
      const result = await window.__frames.extractVideoFrames(document.querySelector('#file').files[0], { start: .15, end: 2.55, count: 4 });
      return { manifest: result.manifest, requested, cancelled, createdFrames, closedFrames, videos: document.querySelectorAll('video').length };
    } finally { prototype.requestVideoFrameCallback = request; prototype.cancelVideoFrameCallback = cancel; window.VideoFrame = NativeFrame; NativeFrame.prototype.close = close; }
  });
  assert.equal(noCallback.manifest.frames.length, 4); assert.equal(noCallback.requested, 4); assert.equal(noCallback.cancelled, noCallback.requested);
  assert.equal(noCallback.createdFrames, 4); assert.equal(noCallback.closedFrames, noCallback.createdFrames); assert.equal(noCallback.videos, 1);
  for (const [index, frame] of noCallback.manifest.frames.entries()) {
    assert.ok(Math.abs(frame.mediaTime - [.1, .9, 1.7, 2.5][index]) < .001, JSON.stringify(frame));
    assert.ok(Math.abs(frame.mediaTime - frame.requestedTime) > .01, 'PTS must not be requested currentTime');
  }
  record('paused seeks with all rVFC callbacks suppressed retain actual VideoFrame PTS and close every atomic snapshot/callback');
  const abort = await page.evaluate(async () => {
    const aborter = new AbortController(), created = [], removed = [], files = [], originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, urls = [], revoked = [];
    URL.createObjectURL = blob => { const url = originalCreate(blob); urls.push(url); return url; }; URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
    const root = { name: 'test', async getDirectoryHandle(name) { created.push(name); return { ...root, async getFileHandle(name) { files.push(name); return { async createWritable() { return { async write() {}, async close() {}, async abort() {} }; } }; } }; }, async removeEntry(name) { removed.push(name); } };
    let name = ''; try { await window.__frames.extractVideoFrames(document.querySelector('#file').files[0], { signal: aborter.signal, onProgress() { aborter.abort(); } }, root); } catch (e) { name = e.name; }
    finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
    return { name, created, removed, files, urls, revoked, videos: document.querySelectorAll('video').length };
  });
  assert.equal(abort.name, 'AbortError'); assert.deepEqual(abort.created, abort.removed); assert.deepEqual(abort.urls, abort.revoked); assert.equal(abort.files.length, 1); assert.equal(abort.videos, 1);
  record('cancelling folder extraction releases decoder/blob URL and deletes only its own incomplete output directory');
  assert.deepEqual(errors, []); report = { pass: true, checks, first: { ...first, zip: undefined }, range, noCallback, colorEvidence, abort, errors };
} catch (error) { report = { pass: false, checks, error: String(error.stack || error), errors }; }
finally { await writeFile(path.join(output, 'video-frame-extraction-report.json'), JSON.stringify(report, null, 2)); await browser.close(); await server?.close(); }
console.log(JSON.stringify({ pass: report.pass, checks: checks.length, error: report.error, output }, null, 2)); if (!report.pass) process.exitCode = 1;
