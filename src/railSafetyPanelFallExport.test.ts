import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { SceneVideoResult } from './sceneVideoRecorder.ts';

// Exercise the actual export lifecycle without DOM construction or GPU work.
registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', shortCircuit: true, source: 'export {};' } : next(url, context);
} });
const { RailSafetyPanel } = await import('./railSafetyPanel.ts');
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const firstFrame = deferred<void>(), finalScene = deferred<void>(), encoded = deferred<SceneVideoResult | undefined>();
  const patches: Array<{ angle?: number; playing?: boolean }> = [];
  const controller = { enableInputs: true };
  let starts = 0, stops = 0, readyChecks = 0;
  const recorder = {
    snapshot: { state: 'idle' }, active: false,
    start: async () => {
      starts++; recorder.active = true; recorder.snapshot.state = 'starting';
      await firstFrame.promise;
      if (recorder.snapshot.state === 'starting') recorder.snapshot.state = 'recording';
    },
    stop: () => { stops++; recorder.snapshot.state = 'stopping'; return encoded.promise; },
    cancel: () => { recorder.active = false; recorder.snapshot.state = 'cancelled'; },
  };
  const project = { resourceId: 'crane', scene: { resources: [] }, display: {} };
  const panel = Object.assign(Object.create(RailSafetyPanel.prototype), {
    destroyed: false, fallExportPhase: 'idle', fallExportGeneration: 0, fallExportResourceId: '',
    fallExportView: 'current', fallExportFormat: 'webm', fallRecorder: recorder, display: {},
    fallDemo: { active: true, loading: false, resourceId: 'crane', angle: 0, playing: false },
    options: { viewer: { isDestroyed: () => false, scene: { screenSpaceCameraController: controller } }, getSceneResources: () => [] },
    updateFallDemo: () => undefined, fallProjectSnapshot: () => project,
    waitFallCaptureReady: () => ++readyChecks === 1 ? Promise.resolve() : finalScene.promise,
  });
  panel.scene = {
    frameFallDemo: () => undefined,
    setFallDemo: (patch: { angle?: number; playing?: boolean }) => { patches.push(patch); Object.assign(panel.fallDemo, patch); },
  };
  return { panel, firstFrame, finalScene, encoded, patches, controller, starts: () => starts, stops: () => stops, project };
}
const result = (): SceneVideoResult => ({ blob: new Blob(['encoded']), fileName: 'fall.webm', mimeType: 'video/webm', width: 640, height: 480, durationSeconds: 8 });

test('fall animation remains at zero until the recorder confirms its first submitted frame', async () => {
  const f = fixture(), exporting = f.panel.exportFallVideo();
  await turn();
  assert.equal(f.starts(), 1); assert.equal(f.panel.fallExportPhase, 'preparing');
  assert.equal(f.panel.fallDemo.angle, 0); assert.equal(f.panel.fallDemo.playing, false);
  assert.equal(f.controller.enableInputs, false);
  f.firstFrame.resolve(); await exporting;
  assert.equal(f.panel.fallExportPhase, 'recording'); assert.equal(f.panel.fallDemo.playing, true);
  f.panel.cancelFallExport('finished test'); assert.equal(f.controller.enableInputs, true);
});

test('cancellation or a changed live pose during encoder startup cannot restart animation', async () => {
  for (const changedPose of [false, true]) {
    const f = fixture(), exporting = f.panel.exportFallVideo(); await turn();
    if (changedPose) f.panel.checkFallExport({ ...f.panel.fallDemo, active: false });
    else f.panel.cancelFallExport('项目已切换');
    f.firstFrame.resolve(); await exporting;
    assert.equal(f.panel.fallExportPhase, 'idle'); assert.equal(f.controller.enableInputs, true);
    assert.equal(f.patches.some(patch => patch.playing === true), false);
  }
});

test('encoder startup failure leaves the demonstration paused and restores camera controls', async () => {
  const f = fixture(), exporting = f.panel.exportFallVideo(); await turn();
  f.firstFrame.reject(new Error('首帧编码超时')); await exporting;
  assert.equal(f.panel.fallExportPhase, 'idle'); assert.equal(f.controller.enableInputs, true);
  assert.equal(f.panel.fallDemo.playing, false); assert.match(f.panel.fallExportMessage, /首帧编码超时/);
});

test('cancelling during final geometry readiness cannot stop a subsequent recording', async () => {
  const f = fixture(), exporting = f.panel.exportFallVideo(); await turn(); f.firstFrame.resolve(); await exporting;
  Object.assign(f.panel.fallDemo, { playing: false, angle: 90, projectionBusy: false });
  const finishing = f.panel.finishFallVideo(); await turn();
  f.panel.cancelFallExport('项目已切换'); f.finalScene.resolve(); await finishing;
  assert.equal(f.stops(), 0); assert.equal(f.panel.fallCompleted, undefined);
});

test('final model readiness precedes encoder stop and a late result cannot escape cancellation', async () => {
  for (const cancelDuringStop of [false, true]) {
    const f = fixture(), exporting = f.panel.exportFallVideo(); await turn(); f.firstFrame.resolve(); await exporting;
    Object.assign(f.panel.fallDemo, { playing: false, angle: 90, projectionBusy: false });
    const finishing = f.panel.finishFallVideo(); await turn();
    assert.equal(f.panel.fallExportPhase, 'finishing'); assert.equal(f.stops(), 0, 'unready final geometry must not stop recording');
    f.finalScene.resolve(); await turn();
    assert.equal(f.stops(), 1); assert.equal(f.panel.fallCompleted, undefined, 'wait for recorder terminal-frame/encoding barrier');
    if (cancelDuringStop) f.panel.cancelFallExport('项目已切换');
    const video = result(); f.encoded.resolve(video); await finishing;
    assert.equal(f.panel.fallExportPhase, 'idle'); assert.equal(f.controller.enableInputs, true);
    if (cancelDuringStop) assert.equal(f.panel.fallCompleted, undefined);
    else assert.deepEqual(f.panel.fallCompleted, { video, project: f.project });
  }
});
