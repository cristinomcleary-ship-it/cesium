import assert from 'node:assert/strict';
import test from 'node:test';
import type { Viewer } from 'cesium';
import { waitForSceneVideoReady } from './sceneVideoReady';
function fixture() {
  const frames = new Set<() => void>(); let renders = 0, destroyed = false;
  const dataSourceDisplay = { ready: false };
  const scene = { requestRenderMode: true, postRender: { addEventListener(callback: () => void) { frames.add(callback); return () => frames.delete(callback); } }, requestRender() { renders++; } };
  const viewer = { dataSourceDisplay, scene, isDestroyed: () => destroyed } as unknown as Viewer;
  return { viewer, frames, dataSourceDisplay, scene, render: () => { for (const frame of [...frames]) frame(); }, renders: () => renders, destroy: () => { destroyed = true; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
test('recording readiness requires two consecutive postRender frames with ready data sources', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(), abort = new AbortController(); let done = false;
  const pending = waitForSceneVideoReady(f.viewer, { signal: abort.signal }).then(() => { done = true; }); await flush();
  f.render(); f.render(); await flush(); assert.equal(done, false);
  f.dataSourceDisplay.ready = true; f.render(); await flush(); assert.equal(done, false);
  f.render(); await pending; assert.equal(f.frames.size, 0); assert.equal(f.scene.requestRenderMode, true);
  const renders = f.renders(); t.mock.timers.tick(30_000); assert.equal(f.renders(), renders, 'success releases the preparation render pulse');
});
test('a not-ready frame resets the consecutive ready-frame count', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); let done = false;
  const pending = waitForSceneVideoReady(f.viewer, { signal: new AbortController().signal }).then(() => { done = true; }); await flush();
  f.dataSourceDisplay.ready = true; f.render(); f.dataSourceDisplay.ready = false; f.render();
  f.dataSourceDisplay.ready = true; f.render(); await flush(); assert.equal(done, false);
  f.render(); await pending;
});
test('closing/switching during preparation immediately removes postRender listeners and timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(), abort = new AbortController();
  const pending = waitForSceneVideoReady(f.viewer, { signal: abort.signal }); const rejected = assert.rejects(pending, /取消/); await flush();
  assert.equal(f.frames.size, 1); abort.abort(new Error('录像准备已取消')); await rejected;
  assert.equal(f.frames.size, 0); const renders = f.renders(); t.mock.timers.tick(30_000); assert.equal(f.renders(), renders);
});
test('software GPU or model loading cannot wait indefinitely, and deadline cancels camera preparation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); let preparationSignal: AbortSignal | undefined;
  const pending = waitForSceneVideoReady(f.viewer, { signal: new AbortController().signal, prepare: signal => { preparationSignal = signal; return new Promise(() => {}); } });
  const rejected = assert.rejects(pending, /20 秒/); await flush(); t.mock.timers.tick(20_000); await rejected;
  assert.equal(preparationSignal?.aborted, true); assert.equal(f.frames.size, 0); assert.equal(f.renders(), 0);
});
test('late camera preparation completion after cancellation never installs new listeners or requests frames', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(), abort = new AbortController(); let complete!: () => void;
  const pending = waitForSceneVideoReady(f.viewer, { signal: abort.signal, prepare: () => new Promise<void>(resolve => { complete = resolve; }) });
  const rejected = assert.rejects(pending); abort.abort(); await rejected; complete(); await flush();
  assert.equal(f.frames.size, 0); assert.equal(f.renders(), 0); t.mock.timers.tick(30_000); assert.equal(f.renders(), 0);
});
test('destroyed Viewer and pre-aborted requests clean up without changing global render settings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  const pending = waitForSceneVideoReady(f.viewer, { signal: new AbortController().signal }); const rejected = assert.rejects(pending, /关闭/); await flush();
  f.destroy(); t.mock.timers.tick(50); await rejected; assert.equal(f.frames.size, 0);
  const abort = new AbortController(); abort.abort(); const before = f.renders();
  await assert.rejects(waitForSceneVideoReady(f.viewer, { signal: abort.signal })); assert.equal(f.renders(), before); assert.equal(f.scene.requestRenderMode, true);
});
