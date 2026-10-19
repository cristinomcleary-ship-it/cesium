import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
const server = await (await import('vite')).createServer({ server: { host: '127.0.0.1', port: 5207, strictPort: true, hmr: false, watch: null } }); await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); const errors = []; page.on('pageerror', error => errors.push(String(error.stack || error)));
try { await page.goto('http://127.0.0.1:5207/tools/fixtures/video-overlay-playback-lens.html'); await page.waitForFunction(() => !!window.__lens); const dims = [Number(process.env.LENS_WIDTH || 1920),Number(process.env.LENS_HEIGHT || 1080)]; const report = await page.evaluate(([width,height]) => window.__lens.verify(width,height), dims);
assert.equal(report.stats.mode, 'cached-float32'); assert.equal(report.stats.builds, 1); assert.equal(report.repeated.builds, 1); assert.equal(report.stats.bytes, Math.ceil(dims[0] / 2) * dims[1] * 16); assert.equal(report.resized.builds, 2); assert.equal(report.resized.bytes, 1280 * 720 * 8); assert.equal(report.disabled.bytes, 0); assert.equal(report.destroyed.bytes, 0); assert.equal(report.destroyed.released, true); assert.equal(report.analytic.mode, 'analytic'); assert.equal(report.analytic.bytes, 0); assert.equal(report.changed, 0); assert.ok(report.maxDelta <= 1); assert.ok(report.maxGeometryErrorPx < .005, 'cached float32 map must retain independent CPU geometry to <.005 native pixel'); assert.equal(report.contextError, 0); assert.deepEqual(errors, []);
const output = process.env.OUTPUT_DIR || '/tmp/ar-lens-verification'; await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'playback-lens-report.json'), JSON.stringify({ ...report, errors }, null, 2)); console.log(JSON.stringify(report, null, 2)); await page.evaluate(() => window.__lens.destroy());
} finally { await browser.close(); await server.close(); }
