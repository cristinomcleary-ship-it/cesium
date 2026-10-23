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
  assert.deepEqual(result, { cacheUpdated: true, releasedManagers: 2, skipped: false, releasedAuxiliaryManagers: [], issues: [] });
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
  assert.deepEqual(release(), { cacheUpdated: true, releasedManagers: 0, skipped: false, resizedTo: [1440, 900], releasedAuxiliaryManagers: [], issues: [] });
  assert.equal(h.stages.fxaa.enabled, true); assert.deepEqual(h.color.texture, { width: 1440, height: 900 });
  assert.deepEqual(h.counts(), { cacheUpdates: 1, colorDeletes: 0, idDeletes: 0 });
});

test('a replaced View or unsupported runtime is left to its current owner', () => {
  const h = harness(), release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene);
  h.arAllocated(); h.scene._defaultView = { sceneFramebuffer: { ...h.target } };
  assert.equal(release().skipped, true); assert.equal(h.counts().cacheUpdates, 0); assert.ok(h.color.texture);
  assert.deepEqual(release().issues, [{ target: 'scene', reason: 'owner-changed' }]);
  assert.deepEqual(captureVideoOverlayRenderTargets({} as Scene)().issues, [{ target: 'scene', reason: 'unsupported-runtime' }]);
});

test('a failing framebuffer release cannot strand another attachment manager', () => {
  const h = harness(), release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene); h.arAllocated();
  h.color.destroy = () => { throw new Error('deleted by another owner'); };
  const result = release(); assert.equal(result.skipped, true); assert.equal(result.releasedManagers, 1); assert.equal(h.id.texture, undefined);
  assert.deepEqual(result.issues, [{ target: 'scene-color', reason: 'failed', message: 'deleted by another owner' }]);
});

function auxiliaryManager(depthOnly = false) {
  return {
    texture: undefined as { width: number; height: number } | undefined,
    deletions: 0,
    getColorTexture() { if (depthOnly) throw new Error('No color attachment'); return this.texture; },
    getDepthStencilTexture() { return depthOnly ? this.texture : undefined; },
    update(_context: unknown, width: number, height: number) { this.texture = { width, height }; },
    isDirty(width: number, height: number) { return !this.texture || this.texture.width !== width || this.texture.height !== height; },
    destroy() { this.texture = undefined; this.deletions++; },
  };
}

test('AR-sized picking attachments are released without destroying shared owners and can be reused', () => {
  const h = harness(), pick = auxiliaryManager(), depth = auxiliaryManager(true), globe = auxiliaryManager(), snap = auxiliaryManager();
  pick.update(h.scene.context, 1024, 768);
  const view = Object.assign(h.scene._defaultView, { pickFramebuffer: { _fb: pick }, pickDepthFramebuffer: { _framebuffer: depth },
    globeDepth: { _pickColorFramebuffer: globe, _snapColorFramebuffer: snap } });
  const release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene);
  for (const manager of [pick, depth, globe, snap]) manager.update(h.scene.context, 3840, 2160);
  const result = release();
  assert.equal(result.skipped, false);
  assert.deepEqual(result.releasedAuxiliaryManagers, ['pick', 'pick-depth', 'globe-pick', 'globe-snap']);
  assert.equal(h.scene._defaultView, view);
  assert.equal(view.pickFramebuffer._fb, pick);
  for (const manager of [pick, depth, globe, snap]) {
    assert.equal(manager.texture, undefined);
    assert.equal(manager.deletions, 1);
    assert.equal(manager.isDirty(1024, 768), true);
    manager.update(h.scene.context, 1024, 768);
    assert.deepEqual(manager.texture, { width: 1024, height: 768 });
  }
  release();
  assert.equal(pick.deletions, 1);
});

test('pre-existing large buffers, normal-sized buffers and replacement owners are preserved', () => {
  const h = harness(), existing = auxiliaryManager(), normal = auxiliaryManager(), replaced = auxiliaryManager();
  existing.update(h.scene.context, 4096, 4096);
  const view = Object.assign(h.scene._defaultView, { pickFramebuffer: { _fb: existing }, pickDepthFramebuffer: { _framebuffer: normal },
    globeDepth: { _pickColorFramebuffer: replaced } });
  const release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene);
  normal.update(h.scene.context, 1024, 768);
  replaced.update(h.scene.context, 3840, 2160);
  view.globeDepth = { _pickColorFramebuffer: auxiliaryManager() };
  const result = release();
  assert.deepEqual(result.releasedAuxiliaryManagers, []);
  assert.deepEqual(result.issues, [{ target: 'globe-pick', reason: 'owner-changed' }]);
  assert.equal(existing.deletions, 0); assert.equal(normal.deletions, 0); assert.equal(replaced.deletions, 0);
});

test('a cache update failure is diagnosable and does not prevent independent framebuffer release', () => {
  const h = harness(), release = captureVideoOverlayRenderTargets(h.scene as unknown as Scene);
  h.arAllocated(); h.stages.update = () => { throw new Error('cache failure'); };
  const result = release();
  assert.equal(result.cacheUpdated, false); assert.equal(result.skipped, true); assert.equal(result.releasedManagers, 2);
  assert.deepEqual(result.issues, [{ target: 'postprocess-cache', reason: 'failed', message: 'cache failure' }]);
});
