import assert from 'node:assert/strict';
import test from 'node:test';
import type { Scene } from 'cesium';
import { captureVideoOverlayRenderTargets } from './videoOverlayRenderTargets.ts';

function harness() {
  let cacheUpdates = 0, colorDeletes = 0, idDeletes = 0;
  const color = { texture: { width: 1024, height: 768 } as { width: number; height: number } | undefined,
    destroy() { colorDeletes++; this.texture = undefined; }, getColorTexture() { return this.texture; } };
  const id = { texture: undefined as { width: number; height: number } | undefined,
    destroy() { idDeletes++; this.texture = undefined; }, getColorTexture() { return this.texture; } };
  const target = { _colorFramebuffer: color, _idFramebuffer: id,
    update(_context: unknown, viewport: { width: number; height: number }, _hdr: boolean, _samples: number) {
      color.texture = { width: viewport.width, height: viewport.height }; id.texture = { ...color.texture };
    } };
  const cache = { dirty: false, bytes: 0 };
  const stages = { length: 0, fxaa: { enabled: false }, bloom: { enabled: false }, ambientOcclusion: { enabled: false }, _textureCache: cache,
    update() { cacheUpdates++; if (cache.dirty) { cache.bytes = 0; cache.dirty = false; } } };
  const scene = { _defaultView: { sceneFramebuffer: target }, context: { drawingBufferWidth: 1024, drawingBufferHeight: 768 },
    postProcessStages: stages, logarithmicDepthBuffer: true, highDynamicRange: false, msaaSamples: 4, isDestroyed: () => false };
  const arAllocated = () => { color.texture = { width: 3840, height: 2160 }; id.texture = { ...color.texture }; cache.bytes = 3840 * 2160 * 4; cache.dirty = true; };
  return { scene, stages, color, id, target, cache, arAllocated, counts: () => ({ cacheUpdates, colorDeletes, idDeletes }) };
}

test('exit releases idle native AR framebuffers even when the normal map never updates postprocessing', () => {
  const h = harness(), release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene);
  h.arAllocated();
  const result = release();
  assert.deepEqual(result, { cacheUpdated: true, releasedManagers: 2, skipped: false });
  assert.equal(h.cache.bytes, 0); assert.equal(h.color.texture, undefined); assert.equal(h.id.texture, undefined);
  assert.equal(h.scene._defaultView.sceneFramebuffer, h.target, 'keep Cesium scene and picking owners intact');
  assert.equal(release(), result); assert.deepEqual(h.counts(), { cacheUpdates: 1, colorDeletes: 1, idDeletes: 1 });
  h.target.update(h.scene.context, { width: 1024, height: 768 }, false, 4);
  assert.deepEqual(h.color.texture, { width: 1024, height: 768 }, 'a later postprocess reuses the same manager');
});

test('active normal FXAA retains its stages and resizes all AR scene targets to the restored map dimensions', () => {
  const h = harness(); h.stages.fxaa.enabled = true;
  const release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene); h.arAllocated();
  h.scene.context.drawingBufferWidth = 1440; h.scene.context.drawingBufferHeight = 900;
  assert.deepEqual(release(), { cacheUpdated: true, releasedManagers: 0, skipped: false, resizedTo: [1440, 900] });
  assert.equal(h.stages.fxaa.enabled, true); assert.deepEqual(h.color.texture, { width: 1440, height: 900 });
  assert.deepEqual(h.counts(), { cacheUpdates: 1, colorDeletes: 0, idDeletes: 0 });
});

test('a replaced View or unsupported runtime is left to its current owner', () => {
  const h = harness(), release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene);
  h.arAllocated(); h.scene._defaultView = { sceneFramebuffer: { ...h.target } };
  assert.equal(release().skipped, true); assert.equal(h.counts().cacheUpdates, 0); assert.ok(h.color.texture);
  assert.equal(captureVideoOverlayRenderTargets({} as Scene)().skipped, true);
});

test('a failing framebuffer release cannot strand another attachment manager', () => {
  const h = harness(), release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene); h.arAllocated();
  h.color.destroy = () => { throw new Error('deleted by another owner'); };
  const result = release(); assert.equal(result.skipped, true); assert.equal(result.releasedManagers, 1); assert.equal(h.id.texture, undefined);
});
