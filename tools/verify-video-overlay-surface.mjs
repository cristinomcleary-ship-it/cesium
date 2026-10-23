#!/usr/bin/env node
/** Real WebGL GroundPolyline -> AR sampling regression, synthetic ellipsoid and 3D Tiles surface. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url), runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (runtime ? path.join(runtime, 'playwright') : 'playwright'));
const output = process.env.OUTPUT_DIR || await mkdtemp(path.join(os.tmpdir(), 'ar-surface-'));
await mkdir(output, { recursive: true });
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5195';
const server = !process.env.BASE_URL || process.env.START_VITE === '1' ? await (await import('vite')).createServer({ cacheDir: path.resolve('node_modules/.vite-surface-acceptance'), server: { host: new URL(baseUrl).hostname, port: Number(new URL(baseUrl).port), strictPort: true, hmr: false, watch: null, fs: { allow: [process.cwd(), realpathSync('node_modules')] } } }) : undefined;
await server?.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.setDefaultTimeout(90000);
const report = { pass: false, checks: [], browserErrors: [] };
page.on('pageerror', error => { report.browserErrors.push(String(error)); console.error(error); });
const check = (name, values = {}) => { report.checks.push({ name, ...values }); console.log(`PASS ${name}`); };
try {
  await page.goto(`${baseUrl}/tools/fixtures/video-overlay-surface.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__surface?.ready);
  for (const mode of ['terrain', 'model']) {
    const original = await page.evaluate(mode => window.__surface.setup(mode), mode);
    assert.equal(original.groundPrimitive, true);
    assert.ok(Math.abs(original.source[1] - original.source[0] - 20) < 1e-6, 'Source fixture must actually slope by 20m');
    assert.equal(original.clampSupported, true);
    const frozen = await page.evaluate(() => window.__surface.enter());
    assert.equal(frozen.item.available, true, frozen.item.error);
    assert.ok(frozen.geometry.length >= 21, 'Sampling must cover line interior, not only the endpoints');
    const height = point => mode === 'terrain' ? point.height : point.local[2];
    const actualHeights = frozen.geometry.map(height), expected = mode === 'terrain' ? 0 : 100;
    assert.ok(actualHeights.every(value => Math.abs(value - expected) < .03), JSON.stringify(actualHeights));
    assert.equal(frozen.sourceShow, false);
    assert.equal(frozen.globeShow, original.globeShow);
    check(`${mode}: a source line sloping 20m freezes to the actual rendered surface`, { vertices: actualHeights.length, minHeight: Math.min(...actualHeights), maxHeight: Math.max(...actualHeights), expectedHeight: expected });
    const tilted = await page.evaluate(() => window.__surface.tilt(8, -5));
    assert.ok(Math.abs(tilted.at(-1).local[2] - tilted[0].local[2]) > 12, 'Frozen CAD must respond to tilt');
    const reset = await page.evaluate(() => window.__surface.tilt(0, 0));
    assert.deepEqual(reset, frozen.geometry, 'Reset must exactly recover sampled coordinates');
    await page.screenshot({ path: path.join(output, `${mode}-surface-frozen.png`) });
    const restored = await page.evaluate(() => window.__surface.restore());
    assert.equal(restored.copyDestroyed, true); assert.equal(restored.copyCount, 0);
    assert.equal(restored.sourceShow, original.sourceShow); assert.equal(restored.surfaceShow, original.surfaceShow); assert.equal(restored.globeShow, original.globeShow);
    assert.equal(restored.primitiveCount, original.primitiveCount); assert.deepEqual(restored.source, original.source);
    assert.deepEqual(restored.camera, original.camera); assert.equal(restored.inputs, true);
    assert.deepEqual(restored.errors, []);
    check(`${mode}: tilt, exact reset and resource/visibility restoration preserve original map geometry`);
  }
  const original = await page.evaluate(() => window.__surface.setup('model', true));
  const failed = await page.evaluate(() => window.__surface.enter());
  assert.equal(original.surfaceShow, true, 'The gap test must retain a loaded model outside the CAD coverage');
  assert.equal(failed.item.available, false, 'Missing model coverage must not silently use source Z or globe');
  assert.equal(failed.copyCount, 0); assert.equal(failed.geometry.length, 0); assert.ok(failed.item.error);
  const restored = await page.evaluate(() => window.__surface.restore());
  assert.equal(restored.primitiveCount, original.primitiveCount); assert.equal(restored.globeShow, original.globeShow); assert.equal(restored.sourceShow, true);
  check('Missing model coverage fails explicitly without source-height fallback or a leaked copy', { error: failed.item.error });
  assert.deepEqual(report.browserErrors, []);
  assert.deepEqual(await page.evaluate(() => window.__surface.errors()), []);
  report.pass = true;
} catch (error) { report.failure = String(error.stack || error); throw error; }
finally { await writeFile(path.join(output, 'surface-report.json'), JSON.stringify(report, null, 2)); await browser.close(); await server?.close(); console.log(`Report: ${path.join(output, 'surface-report.json')}`); }
