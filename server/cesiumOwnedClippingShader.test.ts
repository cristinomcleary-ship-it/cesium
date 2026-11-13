import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { OWNED_FRAGMENT_CLIPPING, markOwnedFragmentClipping } from '../src/ownedClippingPolygons.ts';
import { CLIPPING_PIPELINE_SHA256, OWNED_CLIPPING_FRAGMENT_SHADER, cesiumOwnedClippingShaderPlugin, isCesiumClippingPipeline, transformCesiumClippingPipeline } from './cesiumOwnedClippingShader.ts';

const require = createRequire(import.meta.url);
const cesiumEntry = require.resolve('cesium');
const engineEntry = createRequire(cesiumEntry).resolve('@cesium/engine');
const pipelinePath = resolve(engineEntry, '../Source/Scene/Model/ModelClippingPolygonsPipelineStage.js');
const pipelineUrl = pathToFileURL(pipelinePath);
const originalSource = readFileSync(pipelinePath, 'utf8');
const transformedSource = transformCesiumClippingPipeline(originalSource);
const original = (await import(pipelineUrl.href)).default;
const absoluteSource = transformedSource.replace(new RegExp('from "([.][.]/[^\"]+)"', 'g'), (_match, path) => 'from ' + JSON.stringify(new URL(path, pipelineUrl).href));
const transformed = (await import('data:text/javascript;base64,' + Buffer.from(absoluteSource).toString('base64'))).default;

function run(stage: typeof original, clippingPolygons: object) {
  const calls: unknown[][] = [];
  const shaderBuilder = Object.fromEntries(['addDefine', 'addUniform', 'addVarying', 'addVertexLines', 'addFragmentLines'].map(name => [name, (...args: unknown[]) => calls.push([name, ...args])]));
  const resources = { shaderBuilder, uniformMap: { existing: () => 42 } };
  const model = { clippingPolygons };
  stage.process(resources, model, { context: { defaultTexture: 'default' } });
  return { calls, resources };
}

// Exercise the real pinned upstream module, not a duplicate hand-written fixture.
test('only the exact locked pipeline is transformed and dependency drift fails closed', () => {
  assert.equal(createHash('sha256').update(originalSource).digest('hex'), CLIPPING_PIPELINE_SHA256);
  assert(isCesiumClippingPipeline(pipelinePath));
  assert(isCesiumClippingPipeline('C:\\app\\node_modules\\@cesium\\engine\\Source\\Scene\\Model\\ModelClippingPolygonsPipelineStage.js'));
  assert(!isCesiumClippingPipeline('/app/src/ModelClippingPolygonsPipelineStage.js'));
  assert(!isCesiumClippingPipeline(pipelinePath + '?other'));
  assert.throws(() => transformCesiumClippingPipeline(originalSource + '\n'), /SHA-256/);
  assert.throws(() => transformCesiumClippingPipeline(transformedSource), /SHA-256/);
});

test('unmarked normal and inverse owners preserve every upstream shader and uniform binding', () => {
  for (const inverse of [false, true]) {
    const collection = { inverse, extentsCount: 3, clippingTexture: {}, extentsTexture: {} };
    const before = run(original, collection), after = run(transformed, collection);
    assert.deepEqual(after.calls, before.calls);
    for (const [name, value] of Object.entries(before.resources.uniformMap)) {
      assert.equal((after.resources.uniformMap as Record<string, () => unknown>)[name](), value());
    }
    const inherited = Object.create({ [OWNED_FRAGMENT_CLIPPING]: true });
    Object.assign(inherited, collection);
    assert.deepEqual(run(transformed, inherited).calls, before.calls);
  }
});

test('owned collections use fragment position and keep upstream texture/vertex/inverse behavior', () => {
  for (const inverse of [false, true]) {
    const collection = markOwnedFragmentClipping({ inverse, extentsCount: 3, clippingTexture: {}, extentsTexture: {} });
    const before = run(original, collection), after = run(transformed, collection);
    const expected = before.calls.map(call => call[0] === 'addUniform' && call[2] === 'model_clippingExtents'
      ? [call[0], call[1], call[2], 3] : call[0] === 'addFragmentLines' ? [call[0], OWNED_CLIPPING_FRAGMENT_SHADER] : call);
    assert.deepEqual(after.calls, expected);
    assert.match(OWNED_CLIPPING_FRAGMENT_SHADER, /czm_approximateSphericalCoordinates\(v_positionWC\)/);
    assert.doesNotMatch(OWNED_CLIPPING_FRAGMENT_SHADER, /v_regionIndex|v_clippingPosition/);
    for (const [name, value] of Object.entries(before.resources.uniformMap)) {
      assert.equal((after.resources.uniformMap as Record<string, () => unknown>)[name](), value());
    }
    assert.equal(Object.getOwnPropertyDescriptor(collection, OWNED_FRAGMENT_CLIPPING)?.writable, false);
    assert.equal(Object.keys(collection).includes(OWNED_FRAGMENT_CLIPPING), false);
  }
});

test('Vite and development optimizer use the same guarded transform', async () => {
  const plugin = cesiumOwnedClippingShaderPlugin();
  assert.equal(plugin.name, 'cesium-owned-fragment-clipping-' + createHash('sha256').update(transformedSource).digest('hex').slice(0, 16));
  const viteResult = (plugin.transform as Function)(originalSource, pipelinePath);
  assert.equal(viteResult.code, transformedSource);
  assert.equal((plugin.transform as Function)(originalSource, '/unrelated.js'), undefined);
  const config = (plugin.config as Function)();
  assert.equal(config.optimizeDeps.esbuildOptions.plugins[0].name, plugin.name);
  let handler: Function | undefined;
  config.optimizeDeps.esbuildOptions.plugins[0].setup({ onLoad(_options: unknown, callback: Function) { handler = callback; } });
  const optimized = await handler!({ path: pipelinePath });
  assert.equal(optimized.contents, viteResult.code);
  assert.equal(await handler!({ path: '/unrelated/ModelClippingPolygonsPipelineStage.js' }), undefined);
});
