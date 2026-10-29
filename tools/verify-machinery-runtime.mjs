/** Actual GPU regression for persistent machinery geometry, isolated from user projects.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
 * BROWSER_EXECUTABLE=/absolute/path/to/chromium node tools/verify-machinery-runtime.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/runtime-shader-'));
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataDir;
const modulePath = process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? resolve(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/index.mjs') : 'playwright');
const { chromium } = await import(modulePath);
const launchOptions = process.env.BROWSER_LAUNCH_OPTIONS
  ? (await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default
  : { headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] };
let server, browser;
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } }); await server.listen();
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tools/fixtures/machinery-runtime.html`);
  await page.waitForFunction(() => window.smokeReady, undefined, { timeout: 30000 });
  await page.waitForFunction(() => {
    const { viewer } = window.smoke, ready = new Set();
    for (let i = 0; i < viewer.scene.primitives.length; i++) {
      const primitive = viewer.scene.primitives.get(i);
      if (primitive.ready && primitive.id?.id) ready.add(primitive.id.id);
    }
    return ['crane', 'pile', 'excavator'].every(id => ready.has(`machinery:${id}`));
  }, undefined, { timeout: 30000 });
  // Let the first GPU draw compile before measuring pose continuity. Model.ready
  // alone does not imply that a software WebGL implementation has drawn a frame.
  await page.waitForTimeout(1000);
  const urls = await page.evaluate(() => Object.fromEntries(['crane', 'pile', 'excavator']
    .map(id => [id, window.smoke.scene.getRenderState(id).modelUrl])));
  await page.evaluate(() => {
    const { scene, assets, resources, resolveMachineryParameters } = window.smoke;
    const primitiveRefs = new Map();
    for (let i = 0; i < window.smoke.viewer.scene.primitives.length; i++) {
      const primitive = window.smoke.viewer.scene.primitives.get(i);
      if (primitive.id?.id) primitiveRefs.set(primitive.id.id, primitive);
    }
    window.smoke.observations = [];
    const states = new Map(resources.map(resource => [resource.id, structuredClone(resource.machinery)]));
    const crane = states.get('crane');
    crane.parameters = resolveMachineryParameters(assets.crane, crane.parameters,
      { boom_length_m: 20, boom_elevation_deg: 25, boom_rotation_deg: 90 }, { proportional: false });
    const pile = states.get('pile');
    pile.parameters = resolveMachineryParameters(assets.pile, pile.parameters, { total_height_m: 16 }, { proportional: false });
    states.get('excavator').placement.heading = 75;
    scene.setLiveStates(states);
    const observe = () => {
      const livePrimitives = new Set();
      for (let i = 0; i < window.smoke.viewer.scene.primitives.length; i++) livePrimitives.add(window.smoke.viewer.scene.primitives.get(i));
      window.smoke.observations.push({ continuous: [...primitiveRefs.values()].every(primitive => livePrimitives.has(primitive) && primitive.ready && primitive.show),
        boomLength: scene.getRenderState('crane').displayedState.parameters.boom_length_m });
      if (scene.getRenderState('crane').interpolating && window.smoke.observations.length < 120) requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  });
  await page.waitForFunction(() => ['crane', 'pile', 'excavator'].every(id => !window.smoke.scene.getRenderState(id).interpolating));
  const after = await page.evaluate(() => {
    const { scene, viewer, errors, Cartesian2 } = window.smoke, hits = {};
    // Deterministic projected locations in this fixed synthetic fixture. Picking
    // checks the real GPU-deformed triangles rather than a CPU proxy envelope.
    for (const [cx, cy] of [[390, 420], [645, 430], [900, 430]]) {
      for (let x = cx - 5; x <= cx + 5; x += 5) for (let y = cy - 5; y <= cy + 5; y += 5) {
        const id = viewer.scene.pick(new Cartesian2(x, y))?.id?.id;
        if (id) hits[id] = (hits[id] || 0) + 1;
      }
    }
    return { errors, hits, observations: window.smoke.observations,
      states: Object.fromEntries(['crane', 'pile', 'excavator'].map(id => [id, scene.getRenderState(id)])) };
  });
  assert.deepEqual(after.errors, []); assert.deepEqual(pageErrors, []);
  assert.ok(after.observations.length >= 2, `actual browser frames observe an animated transition: ${JSON.stringify(after.observations)}`);
  assert.ok(after.observations.every(sample => sample.continuous), 'the same ready GPU models remain visible throughout the transition');
  assert.ok(after.observations.some(sample => sample.boomLength < 20), 'boom extension has intermediate rendered poses');
  for (const id of ['crane', 'pile', 'excavator']) {
    assert.equal(after.states[id].modelUrl, urls[id], `${id} keeps its already-loaded GLB`);
    assert.deepEqual(after.states[id].displayedState, after.states[id].targetState);
    assert.ok(after.hits[`machinery:${id}`], `${id} must remain visibly pickable after GPU parameter changes`);
  }
  await mkdir('output/runtime-shader', { recursive: true });
  await page.screenshot({ path: 'output/runtime-shader/actual-gpu.png' });
  console.log(JSON.stringify({ pass: true, hits: after.hits, stableModelUrls: true, continuousFrames: after.observations.length, pageErrors, renderErrors: after.errors }));
} finally { await browser?.close(); await server?.close(); }
