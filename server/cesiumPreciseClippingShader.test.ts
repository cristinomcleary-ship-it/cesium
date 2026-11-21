import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OWNED_FRAGMENT_CLIPPING, PRECISE_FRAGMENT_CLIPPING, markOwnedFragmentClipping } from '../src/ownedClippingPolygons.ts';
import { transformCesiumClippingPipeline } from './cesiumOwnedClippingShader.ts';

const require = createRequire(import.meta.url), engine = createRequire(require.resolve('cesium')).resolve('@cesium/engine');
const url = pathToFileURL(resolve(engine, '../Source/Scene/Model/ModelClippingPolygonsPipelineStage.js'));
const source = readFileSync(url, 'utf8'), original = (await import(url.href)).default;
const shaderDestination = (await import(new URL('../../Renderer/ShaderDestination.js', url).href)).default;
const transformedSource = transformCesiumClippingPipeline(source).replace(/from "([.][.]\/[^\"]+)"/g,
  (_match, path) => 'from ' + JSON.stringify(new URL(path, url).href));
const transformed = (await import('data:text/javascript;base64,' + Buffer.from(transformedSource).toString('base64'))).default;
function run(stage: typeof original, clippingPolygons: object) {
  const calls: unknown[][] = [], shaderBuilder = Object.fromEntries(['addDefine', 'addUniform', 'addVarying', 'addVertexLines', 'addFragmentLines']
    .map(name => [name, (...args: unknown[]) => calls.push([name, ...args])]));
  const resources = { shaderBuilder, uniformMap: { existing: () => 42 } as Record<string, () => unknown> };
  const model = { clippingPolygons }, frame = { context: { defaultTexture: 'default' } };
  stage.process(resources, model, frame); return { calls, resources, model, frame };
}
const data = (inverse: boolean) => ({ inverse, extentsCount: 3, clippingTexture: {}, extentsTexture: {} });
function assertSame(actual: ReturnType<typeof run>, expected: ReturnType<typeof run>) {
  assert.deepEqual(actual.calls, expected.calls); assert.deepEqual(Object.keys(actual.resources.uniformMap), Object.keys(expected.resources.uniformMap));
  for (const [key, value] of Object.entries(expected.resources.uniformMap)) assert.equal(actual.resources.uniformMap[key](), value());
}

test('a precise hook without an explicit own true ownership marker cannot change normal or inverse upstream behavior', () => {
  const hook = { process() { assert.fail('unowned hook must never be called'); } };
  for (const inverse of [false, true]) for (const ownership of ['absent', 'false', 'inherited']) {
    const value = data(inverse), candidate = ownership === 'inherited' ? Object.assign(Object.create({ [OWNED_FRAGMENT_CLIPPING]: true }), value) : { ...value };
    if (ownership === 'false') Object.defineProperty(candidate, OWNED_FRAGMENT_CLIPPING, { value: false });
    Object.defineProperty(candidate, PRECISE_FRAGMENT_CLIPPING, { value: hook });
    assertSame(run(transformed, candidate), run(original, value));
  }
});

test('an inherited precise hook cannot replace the ordinary owned clipping pipeline, including inverse mode', () => {
  for (const inverse of [false, true]) {
    const value = data(inverse), candidate = markOwnedFragmentClipping(Object.assign(Object.create({
      [PRECISE_FRAGMENT_CLIPPING]: { process() { assert.fail('inherited hook must never run'); } },
    }), value));
    assertSame(run(transformed, candidate), run(transformed, markOwnedFragmentClipping({ ...value })));
  }
});

test('both explicit own markers invoke exactly one precise hook and preserve existing resources', () => {
  const received: unknown[][] = [], value = markOwnedFragmentClipping(data(false));
  Object.defineProperty(value, PRECISE_FRAGMENT_CLIPPING, { value: { process(...args: unknown[]) { received.push(args); } } });
  const result = run(transformed, value);
  assert.equal(received.length, 1); assert.equal(received[0][0], result.resources); assert.equal(received[0][1], result.model);
  assert.equal(received[0][2], result.frame); assert.equal(received[0][3], shaderDestination);
  assert.deepEqual(result.calls, [], 'upstream SDF stage is not also appended after precise delegation');
  assert.equal(result.resources.uniformMap.existing(), 42); assert.equal(value.inverse, false);
});
