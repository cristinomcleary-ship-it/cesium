#!/usr/bin/env node
/** Real WebGL pixels, frame pairing, native resolution and complete GPU teardown. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5199';
const server = process.env.START_VITE === '1' ? await (await import('vite')).createServer({ server: { host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port), strictPort: true, hmr: false, watch: null } }) : undefined;
await server?.listen();
const output = process.env.OUTPUT_DIR || path.join(os.tmpdir(), 'cc-gpu-compositor'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = []; page.on('pageerror', error => errors.push(String(error.stack || error)));
let report;
try {
  await page.goto(`${baseUrl}/tools/fixtures/video-overlay-gpu-compositor.html`);
  const result = await page.evaluate(async () => {
    const { VideoOverlayPlaybackCompositor } = await import('/src/videoOverlayPlaybackCompositor.ts');
    const checks = [];
    const check = (name, detail = {}) => checks.push({ name, ...detail });
    const canvas = (width = 96, height = 54) => { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; };
    const read = c => { const snap = canvas(c.width, c.height); snap.getContext('2d').drawImage(c, 0, 0); return [...snap.getContext('2d').getImageData(0, 0, snap.width, snap.height).data]; };
    const source = canvas(), overlay = canvas(), marks = canvas(), oracle = canvas();
    const s = source.getContext('2d'), o = overlay.getContext('2d'), m = marks.getContext('2d'), reference = oracle.getContext('2d');
    s.fillStyle = '#345678'; s.fillRect(0, 0, 96, 54); s.fillStyle = '#ffdb00'; s.fillRect(0, 0, 16, 8);
    o.fillStyle = '#08c4e080'; o.fillRect(17, 8, 62, 39); o.fillStyle = '#ff0030'; o.fillRect(4, 20, 20, 22);
    m.fillStyle = '#ffffff80'; m.fillRect(30, 3, 40, 32); m.fillStyle = '#0011ff'; m.fillRect(70, 45, 23, 8);
    reference.drawImage(source, 0, 0); reference.drawImage(overlay, 0, 0); reference.drawImage(marks, 0, 0);
    const compositor = new VideoOverlayPlaybackCompositor(96, 54);
    document.body.append(compositor.canvas);
    if (!compositor.captureSource(source, 12.5) || !compositor.commit(overlay, 12.5, marks)) throw new Error('First native pair failed');
    const actual = read(compositor.canvas), expected = read(oracle);
    const maxDelta = Math.max(...actual.map((v, i) => Math.abs(v - expected[i])));
    if (maxDelta > 2) throw new Error(`GPU source-over differs from native Canvas2D oracle by ${maxDelta}`);
    check('native GPU source-over matches Canvas2D including alpha and orientation', { maxDelta });
    for (const premultipliedAlpha of [true, false]) {
      const webglOverlay = canvas(), overlayGl = webglOverlay.getContext('webgl', { alpha: true, premultipliedAlpha, preserveDrawingBuffer: true });
      overlayGl.clearColor(.1, .4, .2, .5); overlayGl.clear(overlayGl.COLOR_BUFFER_BIT);
      reference.clearRect(0, 0, 96, 54); reference.drawImage(source, 0, 0); reference.drawImage(webglOverlay, 0, 0);
      compositor.commit(webglOverlay, 12.5);
      const actualGl = read(compositor.canvas), expectedGl = read(oracle);
      const delta = Math.max(...actualGl.map((v, i) => Math.abs(v - expectedGl[i])));
      overlayGl.getExtension('WEBGL_lose_context')?.loseContext();
      if (delta > 2) throw new Error(`WebGL overlay premultipliedAlpha=${premultipliedAlpha} differs by ${delta}`);
    }
    compositor.commit(overlay, 12.5, marks);
    check('both premultiplied and straight-alpha WebGL overlays match browser source-over');
    s.fillStyle = '#009933'; s.fillRect(0, 0, 96, 54);
    compositor.captureSource(source, 12.533333);
    if (compositor.commit(overlay, 12.5, marks)) throw new Error('Mismatched source/camera PTS was accepted');
    if (JSON.stringify(read(compositor.canvas)) !== JSON.stringify(actual)) throw new Error('Incomplete pair changed the previous complete presentation');
    if (compositor.presentedTime !== 12.5 || compositor.sourceTime !== 12.533333) throw new Error('Frame pairing state wrong');
    if (!compositor.commit(overlay, 12.533333)) throw new Error('New complete pair failed');
    reference.clearRect(0, 0, 96, 54); reference.drawImage(source, 0, 0); reference.drawImage(overlay, 0, 0);
    const withoutMarks = read(compositor.canvas), expectedWithout = read(oracle);
    if (Math.max(...withoutMarks.map((v, i) => Math.abs(v - expectedWithout[i]))) > 2) throw new Error('Removed annotations remained in the GPU texture');
    check('mismatched PTS retains last complete pair; next pair clears removed annotations');
    compositor.commit(overlay, 12.533333, marks);
    if (JSON.stringify(read(compositor.canvas)) === JSON.stringify(read(source))) throw new Error('Revocation fixture did not contain model/annotation pixels');
    if (!compositor.clearOverlay()) throw new Error('Active compositor refused permission sanitation');
    // No rAF, scene render or new source callback occurs before this pixel read.
    const revoked = read(compositor.canvas), sourceOnly = read(source);
    const revokeDelta = Math.max(...revoked.map((value, i) => Math.abs(value - sourceOnly[i])));
    if (revokeDelta > 2) throw new Error('Permission revocation retained GPU model or annotation pixels');
    if (compositor.presentedTime !== undefined || compositor.sourceTime !== 12.533333) throw new Error('Sanitation certified a fused frame or discarded the source snapshot');
    if (compositor.commit(overlay, 12.5, marks) || JSON.stringify(read(compositor.canvas)) !== JSON.stringify(revoked)) throw new Error('Stale PTS restored revoked pixels after sanitation');
    if (!compositor.commit(overlay, 12.533333)) throw new Error('Sanitized compositor cannot present a subsequent authorized complete pair');
    check('permission sanitation removes cached GPU model and annotation pixels synchronously before another frame', { maxDelta: revokeDelta });
    if (compositor.captureSource(source, NaN)) throw new Error('Nonfinite source PTS accepted');
    compositor.resize(1920, 1080);
    if (compositor.sourceTime !== undefined || compositor.presentedTime !== undefined || compositor.commit(overlay, 12.533333)) throw new Error('Resize retained stale pairing');
    const large = canvas(3840, 2160), transparent = canvas(3840, 2160), largeContext = large.getContext('2d');
    largeContext.fillStyle = '#df2605'; largeContext.fillRect(0, 0, 3840, 2160);
    largeContext.fillStyle = '#21db99'; largeContext.fillRect(3839, 2159, 1, 1);
    compositor.resize(3840, 2160); compositor.captureSource(large, 20); compositor.commit(transparent, 20);
    if (compositor.canvas.width !== 3840 || compositor.canvas.height !== 2160) throw new Error('Native 4K dimensions changed');
    const corner = canvas(1, 1); corner.getContext('2d').drawImage(compositor.canvas, 3839, 2159, 1, 1, 0, 0, 1, 1);
    const cornerPixel = read(corner);
    if (Math.max(...cornerPixel.map((v, i) => Math.abs(v - [33, 219, 153, 255][i]))) > 1) throw new Error('Last native 4K pixel was rescaled/blurred');
    check('3840×2160 dimensions and single last-pixel detail are retained', { cornerPixel });
    const gl = compositor.canvas.getContext('webgl2') || compositor.canvas.getContext('webgl');
    const removed = { texture: 0, buffer: 0, program: 0 };
    for (const [method, kind] of [['deleteTexture', 'texture'], ['deleteBuffer', 'buffer'], ['deleteProgram', 'program']]) { const original = gl[method].bind(gl); gl[method] = resource => { removed[kind] += 1; original(resource); }; }
    compositor.dispose(); compositor.dispose();
    if (removed.texture !== 3 || removed.buffer !== 1 || removed.program !== 1) throw new Error(`GPU resource deletion incomplete: ${JSON.stringify(removed)}`);
    if (!compositor.isDisposed || compositor.canvas.width !== 0 || compositor.canvas.height !== 0 || compositor.captureSource(large, 21) || compositor.commit(transparent, 21) || compositor.clearOverlay()) throw new Error('Disposed compositor retained frame resources');
    await new Promise(resolve => setTimeout(resolve, 50));
    if (!gl.isContextLost()) throw new Error('Native GPU compositor context was not released');
    check('dispose deletes every owned GPU object once, loses the context and releases native buffers', { removed });
    const scaledSource = canvas(192, 108), scaledMarks = canvas(), scaledOverlay = canvas(), wrongAspect = canvas(192, 100);
    scaledSource.getContext('2d').fillStyle = '#7b1fc9'; scaledSource.getContext('2d').fillRect(0, 0, 192, 108);
    const explicitExport = new VideoOverlayPlaybackCompositor(96, 54, { allowSourceScaling: true, allowOverlayRounding: true });
    try {
      if (!explicitExport.captureSource(scaledSource, 2) || !explicitExport.commit(scaledOverlay, 2, scaledMarks)) throw new Error('Explicit export size could not accept native source');
      const sample = read(explicitExport.canvas).slice(0, 4);
      if (sample.some((v, i) => Math.abs(v - [123, 31, 201, 255][i]) > 1)) throw new Error('Explicit export scaling changed source colors');
      let rejectedAspect = false; try { explicitExport.captureSource(wrongAspect, 3); } catch { rejectedAspect = true; }
      if (!rejectedAspect) throw new Error('Explicit scaling accepted distorted aspect ratio');
      const rounded = canvas(96, 55); if (!explicitExport.commit(rounded, 2)) throw new Error('One-pixel Cesium drawing-buffer rounding rejected');
      const frame = new VideoFrame(explicitExport.canvas, { timestamp: 2000000 });
      try { if (frame.displayWidth !== 96 || frame.displayHeight !== 54 || frame.timestamp !== 2000000) throw new Error('Direct GPU-canvas WebCodecs handoff lost dimensions or PTS'); }
      finally { frame.close(); }
    } finally { explicitExport.dispose(); }
    check('explicit smaller export keeps aspect ratio, tolerates one-pixel Cesium rounding and feeds WebCodecs directly');
    const oversampled = new VideoOverlayPlaybackCompositor(3840, 2160, { allowOverlayRounding: true });
    try {
      oversampled.setOverlayRoundingPixels(6); oversampled.captureSource(large, 21);
      if (!oversampled.commit(canvas(3845, 2160), 21)) throw new Error('CSS 940×528 to native 4K oversampling blocked a complete frame');
      for (const [width, height] of [[3839, 2160], [3847, 2160]]) {
        let rejected = false; try { oversampled.commit(canvas(width, height), 21); } catch { rejected = true; }
        if (!rejected) throw new Error('CSS tolerance accepted lower detail or unbounded stretching');
      }
    } finally { oversampled.dispose(); }
    check('CSS-to-native 4K rounding tolerates bounded extra pixels and rejects lower-detail or excessive overlays');
    const realCreateElement = document.createElement.bind(document);
    document.createElement = name => { const c = realCreateElement(name); if (name === 'canvas') { const native = c.getContext.bind(c); c.getContext = (kind, attributes) => kind === 'webgl2' ? null : native(kind, attributes); } return c; };
    let fallback;
    try { fallback = new VideoOverlayPlaybackCompositor(96, 54); fallback.captureSource(source, 1); if (!fallback.commit(overlay, 1)) throw new Error('WebGL1 fallback failed'); }
    finally { document.createElement = realCreateElement; fallback?.dispose(); }
    check('WebGL1 fallback renders when WebGL2 is unavailable');
    return { pass: true, checks };
  });
  assert.equal(result.pass, true); assert.deepEqual(errors, []); report = { ...result, browserErrors: errors };
} catch (error) { report = { pass: false, error: String(error.stack || error), browserErrors: errors }; }
finally { await browser.close(); await server?.close(); }
await writeFile(path.join(output, 'video-overlay-gpu-compositor-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2)); if (!report.pass) process.exitCode = 1;
