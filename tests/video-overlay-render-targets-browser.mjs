/** Real Cesium framebuffer reuse regression; no user media or network models.
 * BROWSER_EXECUTABLE and PLAYWRIGHT_MODULE may select installed local runtimes.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (runtimeModules ? path.join(runtimeModules, 'playwright') : 'playwright'));
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => { window.__glStats = { snapshot: () => ({}) }; });
  await page.goto(`http://127.0.0.1:${address.port}/tools/fixtures/ar-exit-performance.html?models=1`);
  await page.waitForFunction(() => window.__exitPerformance?.state().ready);
  const result = await page.evaluate(async () => {
    const { captureVideoOverlayRenderTargets } = await import('/src/videoOverlayRenderTargets.ts');
    const fixture = window.__exitPerformance, viewer = fixture.viewer;
    viewer.useDefaultRenderLoop = false;
    const release = captureVideoOverlayRenderTargets(viewer.scene);
    const originalStyle = viewer.container.style.cssText;
    const originalScale = viewer.resolutionScale;
    viewer.container.style.width = '1920px'; viewer.container.style.height = '1080px';
    viewer.resolutionScale = 2; viewer.resize();
    const nativePick = fixture.pick();
    const manager = viewer.scene._defaultView.pickFramebuffer._fb;
    const nativeTexture = manager.getColorTexture();
    const nativeSize = [nativeTexture.width, nativeTexture.height];
    viewer.container.style.cssText = originalStyle;
    viewer.resolutionScale = originalScale; viewer.resize();
    const report = release();
    const released = manager.getColorTexture() === undefined;
    const restoredPick = fixture.pick();
    const restoredTexture = manager.getColorTexture();
    return { nativePick, nativeSize, report, released, restoredPick,
      restoredSize: [restoredTexture.width, restoredTexture.height],
      normalSize: [viewer.canvas.width, viewer.canvas.height],
      sameManager: viewer.scene._defaultView.pickFramebuffer._fb === manager,
      errors: fixture.state().errors };
  });
  assert.deepEqual(result.nativeSize, [3840, 2160]);
  assert.equal(result.nativePick.picked, true); assert.equal(result.nativePick.glError, 0);
  assert.equal(result.report.skipped, false, JSON.stringify(result.report));
  assert.ok(result.report.releasedAuxiliaryManagers.includes('pick'));
  assert.equal(result.released, true); assert.equal(result.sameManager, true);
  assert.equal(result.restoredPick.picked, true); assert.equal(result.restoredPick.glError, 0);
  assert.deepEqual(result.restoredSize, result.normalSize);
  assert.deepEqual(result.errors, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, ...result }));
} finally {
  await browser?.close();
  await server.close();
}
