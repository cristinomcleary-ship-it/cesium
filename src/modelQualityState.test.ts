import test from "node:test";
import assert from "node:assert/strict";
import { ModelQualityTracker } from "./modelQualityState.ts";
class Signal<T extends unknown[] = []> {
  listeners = new Set<(...args: T) => void>();
  addEventListener(fn: (...args: T) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(...args: T) { for (const fn of [...this.listeners]) fn(...args); }
}
function fixture(coarse = false) {
  let time = 0;
  const tileset = { show: true, tilesLoaded: false, maximumScreenSpaceError: coarse ? 20 : 4, memoryAdjustedScreenSpaceError: coarse ? 20 : 4,
    isDestroyed: () => false, loadProgress: new Signal<[number, number]>(), initialTilesLoaded: new Signal(), allTilesLoaded: new Signal(),
    tileVisible: new Signal<[unknown]>(), tileFailed: new Signal<[{ url?: string; message?: string }]>() };
  const scene = { preRender: new Signal(), postRender: new Signal() };
  const camera = { changed: new Signal<[number]>(), moveStart: new Signal(), moveEnd: new Signal() };
  let updates = 0;
  const tracker = new ModelQualityTracker({ modelId: "real-id", name: "tile fixture", tileset, scene, camera, quality: "high", targetScreenSpaceError: 4,
    initialCoarse: coarse, now: () => time, onInitialReady: () => { tileset.maximumScreenSpaceError = 4; tileset.memoryAdjustedScreenSpaceError = 4; }, onChange: () => { updates += 1; } });
  const frame = (visible: number, elapsed = 20) => { time += elapsed; scene.preRender.emit(); for (let i = 0; i < visible; i++) tileset.tileVisible.emit({}); scene.postRender.emit(); };
  return { tileset, scene, camera, tracker, frame, updates: () => updates,
    listeners: () => [...Object.values(tileset), ...Object.values(scene), ...Object.values(camera)].reduce<number>((sum, value) => sum + (value instanceof Signal ? value.listeners.size : 0), 0) };
}
test("first screen never implies target detail; camera changes keep tracking after initial load", () => {
  const f = fixture(true); f.frame(2, 100);
  assert.equal(f.tracker.getState().phase, "first-screen-usable");
  assert.equal(f.tracker.getState().firstUsableAfterMs, 100);
  f.tileset.tilesLoaded = true; f.tileset.allTilesLoaded.emit();
  assert.equal(f.tracker.getState().currentViewReady, false);
  f.tileset.initialTilesLoaded.emit(); f.tileset.tilesLoaded = false; f.tileset.loadProgress.emit(5, 1); f.frame(3);
  assert.equal(f.tracker.getState().phase, "detail-loading");
  f.tileset.tilesLoaded = true; f.tileset.loadProgress.emit(0, 0); f.frame(6, 50);
  assert.equal(f.tracker.getState().phase, "target-ready"); assert.equal(f.tracker.getState().currentViewReadyAfterMs, 70);
  f.camera.moveStart.emit(); f.camera.changed.emit(.5); f.tileset.loadProgress.emit(2, 0); f.frame(4);
  assert.equal(f.tracker.getState().currentViewReady, false);
  f.camera.moveEnd.emit(); f.tileset.loadProgress.emit(0, 0); f.frame(8);
  assert.equal(f.tracker.getState().phase, "target-ready"); assert.equal(f.tracker.getState().currentViewReadyAfterMs, 20);
  f.tracker.dispose();
});
test("empty sky, hidden models and memory-degraded LOD cannot pass current-view target readiness", () => {
  const f = fixture(); f.tileset.tilesLoaded = true; f.tileset.allTilesLoaded.emit(); f.frame(0);
  assert.equal(f.tracker.getState().currentViewReady, false); assert.equal(f.tracker.getState().firstUsableAfterMs, null);
  f.tileset.memoryAdjustedScreenSpaceError = 10; f.frame(2);
  assert.equal(f.tracker.getState().phase, "detail-loading");
  f.tileset.memoryAdjustedScreenSpaceError = 4; f.frame(2); assert.equal(f.tracker.getState().currentViewReady, true);
  f.frame(0); assert.equal(f.tracker.getState().phase, "out-of-view"); assert.equal(f.tracker.getState().currentViewReadyAfterMs, null);
  f.tileset.show = false; f.frame(2); assert.equal(f.tracker.getState().phase, "not-visible"); assert.equal(f.tracker.getState().currentViewReady, false);
  f.tracker.dispose();
});
test("failures remain explicit after loading stops, and stricter preset invalidates the prior ready state", () => {
  const f = fixture(); f.tileset.tilesLoaded = true; f.frame(3);
  f.tracker.setTarget("ultra", 1); assert.equal(f.tracker.getState().currentViewReady, false); f.frame(3);
  assert.equal(f.tracker.getState().phase, "detail-loading");
  f.tileset.maximumScreenSpaceError = f.tileset.memoryAdjustedScreenSpaceError = 1; f.frame(3);
  assert.equal(f.tracker.getState().phase, "target-ready");
  f.tileset.tileFailed.emit({ url: "/tile.b3dm", message: "HTTP 404" }); f.tileset.loadProgress.emit(0, 0); f.frame(3);
  const state = f.tracker.getState(); assert.equal(state.phase, "partial-failure"); assert.equal(state.currentViewReady, false);
  assert.deepEqual(state.failures, [{ url: "/tile.b3dm", message: "HTTP 404" }]);
  state.failures.length = 0; assert.equal(f.tracker.getState().failures.length, 1); f.tracker.dispose();
});
test("unload releases every listener, with no event updates after disposal or destroyed resource", () => {
  const f = fixture(); assert.equal(f.listeners(), 10); const before = f.updates(); f.tracker.dispose(); f.tracker.dispose(); assert.equal(f.listeners(), 0);
  f.tileset.loadProgress.emit(5, 6); f.camera.changed.emit(1); f.frame(4); assert.equal(f.updates(), before);
  const g = fixture(); g.tileset.isDestroyed = () => true; g.frame(0); assert.equal(g.listeners(), 0);
});

test("Cesium end-of-frame initialTilesLoaded must not bless coarse-frame evidence after switching the target", () => {
  const f=fixture(true);f.scene.preRender.emit();f.tileset.tileVisible.emit({});
  f.tileset.tilesLoaded=true;f.tileset.allTilesLoaded.emit();f.tileset.initialTilesLoaded.emit();f.scene.postRender.emit();
  assert.equal(f.tileset.maximumScreenSpaceError,4);assert.equal(f.tracker.getState().firstScreenUsable,true);
  assert.equal(f.tracker.getState().currentViewReady,false);assert.equal(f.tracker.getState().phase,"detail-loading");
  f.frame(4);assert.equal(f.tracker.getState().currentViewReady,true);f.tracker.dispose();
});
