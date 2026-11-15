import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Cesium3DTileset } from 'cesium';
import { VideoOverlaySceneIsolation } from './videoOverlaySceneIsolation.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('panel, scene and pending encoder leases restore only after the final owner settles', async () => {
  const events: string[] = [], gate = deferred();
  const isolation = new VideoOverlaySceneIsolation(() => {
    events.push('suspended'); return () => { events.push('restored'); };
  });
  const panel = isolation.acquire(), scene = isolation.acquire();
  const task = isolation.run(async () => { await gate.promise; events.push('encoder settled'); });
  panel(); scene(); scene();
  assert.deepEqual(events, ['suspended'], 'leaving AR cannot restore effects into an unfinished render task');
  gate.resolve(); await task;
  assert.deepEqual(events, ['suspended', 'encoder settled', 'restored']);
  panel();
  const later = isolation.acquire(); later();
  assert.deepEqual(events.slice(-2), ['suspended', 'restored']);
});

test('restore failure never replaces the original media error or strands the next session', async () => {
  const failures: unknown[] = [], mediaError = new Error('media failed');
  let starts = 0;
  const isolation = new VideoOverlaySceneIsolation(() => {
    starts++; return () => { throw new Error('host restore failed'); };
  }, error => { failures.push(error); });
  await assert.rejects(isolation.run(async () => { throw mediaError; }), error => error === mediaError);
  assert.equal(failures.length, 1);
  const next = isolation.acquire(); next(); next();
  assert.equal(starts, 2); assert.equal(failures.length, 2);
});

test('failed suspension does not create an owner and an absent hook preserves results', async () => {
  let attempts = 0, restored = 0;
  const isolation = new VideoOverlaySceneIsolation(() => {
    if (++attempts === 1) throw new Error('not ready');
    return () => { restored++; };
  });
  assert.throws(() => isolation.acquire(), /not ready/);
  isolation.acquire()(); assert.equal(restored, 1);
  assert.equal(await new VideoOverlaySceneIsolation().run(async () => 42), 42);
});

let directory: string;
// Exercise the shipped controller entry points while replacing only DOM/media
// inputs. The existing browser suite remains responsible for WebGL pixels.
let Overlay: { prototype: object };
let LegacyOverlay: { prototype: object };
before(async () => {
  directory = await mkdtemp(join(process.cwd(), '.video-overlay-isolation-'));
  const output = join(directory, 'overlay.mjs');
  await build({ entryPoints: ['src/videoModelOverlay.ts'], outfile: output, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  Overlay = (await import(pathToFileURL(output).href)).VideoModelOverlay;
  const legacyOutput = join(directory, 'legacy-overlay.mjs');
  await build({ entryPoints: ['src/videoArFusion.ts'], outfile: legacyOutput, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  LegacyOverlay = (await import(pathToFileURL(legacyOutput).href)).VideoArFusion;
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function fixture() {
  const events: string[] = [];
  const owner = Object.assign(Object.create(Overlay.prototype), {
    options: { suspendExternalSceneEffects() {
      events.push('suspend'); return () => { events.push('restore'); };
    } },
    cleanupReport: { errors: [] },
    refreshResources() { events.push('list'); },
    exit() { events.push('exit'); },
    autoSaveReady: false,
  });
  return { owner, events };
}

test('dormant occlusion status reads never acquire an effects lease or cancel a map task', () => {
  const { owner, events } = fixture();
  const source = Object.create(Cesium3DTileset.prototype);
  Object.defineProperties(source, {
    isDestroyed: { value: () => false },
    clippingPolygons: { value: { enabled: true, length: 1 }, writable: true },
  });
  const info = { textContent: '' };
  Object.assign(owner, {
    occlusion: { enabled: true, sourceId: 'survey' }, adjustments: {}, el: () => info,
    options: { ...owner.options,
      getImports: () => [{ id: 'survey', kind: '3D Tiles', resource: source }],
      getRecord: () => ({ kind: '3D Tiles' }),
    },
  });
  for (let index = 0; index < 3; index++) owner.updateOcclusionStatus();
  assert.match(info.textContent, /剖切或开挖/);
  assert.deepEqual(events, []);
  assert.equal(source.clippingPolygons.enabled, true);
  source.clippingPolygons = undefined;
  owner.updateOcclusionStatus();
  assert.match(info.textContent, /已选择遮挡参照/); assert.deepEqual(events, []);
});

test('actual panel activation still suspends before the read-only source compatibility check', () => {
  const { owner, events } = fixture();
  const source = Object.create(Cesium3DTileset.prototype);
  const clipping = { enabled: true, length: 1 };
  Object.defineProperties(source, { isDestroyed: { value: () => false }, clippingPolygons: { value: clipping } });
  Object.assign(owner, { occlusion: { enabled: true, sourceId: 'survey' }, adjustments: {},
    options: {
      getImports: () => [{ id: 'survey', kind: '3D Tiles', resource: source }], getRecord: () => ({ kind: '3D Tiles' }),
      suspendExternalSceneEffects() { events.push('suspend'); clipping.enabled = false; return () => { events.push('restore'); clipping.enabled = true; }; },
    },
    refreshResources() { owner.checkOcclusionSource(); events.push('validated'); },
  });
  owner.setPanelActive(true); assert.deepEqual(events, ['suspend', 'validated']);
  owner.setPanelActive(false); assert.equal(clipping.enabled, true); assert.deepEqual(events.slice(-2), ['exit', 'restore']);
});

function occlusionInteractionFixture() {
  const { owner, events } = fixture();
  const failures: unknown[] = [];
  const controls = new Map<string, { checked: boolean; value: string; textContent: string }>();
  const control = (id: string) => {
    if (!controls.has(id)) controls.set(id, { checked: false, value: '', textContent: '' });
    return controls.get(id)!;
  };
  const clippings = [{ enabled: true, length: 1 }, { enabled: true, length: 1 }];
  const sources = clippings.map(clipping => Object.defineProperties(Object.create(Cesium3DTileset.prototype), {
    isDestroyed: { value: () => false }, clippingPolygons: { value: clipping, writable: true },
    clippingPlanes: { value: undefined, writable: true },
  }));
  Object.assign(owner, {
    inputGeneration: 0, replayInputIntent: 0, sessionGeneration: 0, files: {}, occlusion: { enabled: false, sourceId: '' }, adjustments: {},
    options: {
      getImports: () => sources.map((resource, index) => ({ id: `survey-${index}`, kind: '3D Tiles', resource })),
      getRecord: () => ({ kind: '3D Tiles' }),
      onReplayInputChanged() { events.push('manual intent'); },
      suspendExternalSceneEffects() {
        events.push('suspend'); clippings.forEach(clipping => { clipping.enabled = false; });
        return () => { events.push('restore'); clippings.forEach(clipping => { clipping.enabled = true; }); };
      },
    },
    el: control, dirty() { events.push('dirty'); }, fail(error: unknown) { failures.push(error); },
    refreshSceneReferences() {}, refreshOcclusionSources() {}, syncCameraInputs() {}, syncAdjustmentInputs() {},
    presentationEditor: { setValue() {} }, spatialEditor: { setValue() {} },
    refreshResources() { owner.updateOcclusionStatus(); control('ccOcclusionEnabled').checked = owner.occlusion.enabled; },
  });
  const select = (enabled = true, index = 0) => {
    control('ccOcclusionEnabled').checked = enabled; control('ccOcclusionSource').value = `survey-${index}`;
    owner.changeOcclusion();
  };
  return { owner, events, failures, control, clippings, sources, select };
}

test('occlusion change reacquires a panel lease after manual file selection releases it', () => {
  const { owner, events, failures, control, clippings, select } = occlusionInteractionFixture();
  owner.setPanelActive(true);
  owner.pickFile('video', new File(['synthetic'], 'new-manual.mp4'));
  assert.deepEqual(events.slice(1, 4), ['manual intent', 'exit', 'restore']);
  assert.equal(clippings[0].enabled, true, 'picking a file ended the preceding AR session');
  events.length = 0;
  select();
  assert.deepEqual(events, ['suspend', 'exit', 'dirty']);
  assert.deepEqual(owner.occlusion, { enabled: true, sourceId: 'survey-0' });
  assert.equal(clippings[0].enabled, false);
  assert.match(control('ccOcclusionInfo').textContent, /已选择遮挡参照/);
  assert.deepEqual(failures, []);
  select(true, 1); select(false, 1);
  assert.equal(events.filter(event => event === 'suspend').length, 1, 'source changes share the panel owner');
  assert.equal(events.filter(event => event === 'restore').length, 0);
  owner.setPanelActive(false); owner.setPanelActive(false);
  assert.equal(events.filter(event => event === 'restore').length, 1);
  assert.ok(clippings.every(clipping => clipping.enabled));
});

test('occlusion source changes bridge the live lease through exit and leave restores the scene', () => {
  const { owner, events, failures, clippings, select } = occlusionInteractionFixture();
  owner.releaseLiveSceneEffects = owner.externalSceneIsolation().acquire();
  owner.exit = () => {
    events.push('exit'); owner.releaseLiveSceneEffects?.(); owner.releaseLiveSceneEffects = undefined;
  };
  select(true, 1);
  assert.deepEqual(failures, []);
  assert.deepEqual(events, ['suspend', 'exit', 'dirty']);
  assert.equal(clippings[1].enabled, false, 'exit cannot restore cuts before validating the new source');
  owner.leave();
  assert.deepEqual(events.slice(-2), ['exit', 'restore']);
  assert.ok(clippings.every(clipping => clipping.enabled));
});

test('unknown clipping still rejects occlusion and releases only the attempted activation lease', () => {
  const { owner, events, failures, clippings, sources, select } = occlusionInteractionFixture();
  const unknown = { enabled: true, length: 1 };
  sources[0].clippingPlanes = unknown;
  select();
  assert.match(String(failures[0]), /剖切或开挖/);
  assert.deepEqual(owner.occlusion, { enabled: false, sourceId: '' });
  assert.deepEqual(events, ['suspend', 'exit', 'restore']);
  assert.equal(owner.releasePanelSceneEffects, undefined);
  assert.equal(sources[0].clippingPlanes, unknown); assert.equal(unknown.enabled, true);
  assert.ok(clippings.every(clipping => clipping.enabled));

  events.length = 0; owner.setPanelActive(true); select();
  assert.equal(failures.length, 2);
  assert.deepEqual(events, ['suspend', 'exit']);
  assert.equal(clippings[0].enabled, false, 'a failed change does not release an existing panel owner');
  owner.setPanelActive(false);
  assert.equal(events.filter(event => event === 'restore').length, 1);
});

test('disabled source selection does not acquire an AR lease and invalid inputs never pause the scene', () => {
  const { owner, events, failures, control, select } = occlusionInteractionFixture();
  select(false);
  assert.deepEqual(events, ['exit', 'dirty']);
  events.length = 0; control('ccOcclusionEnabled').checked = true; control('ccOcclusionSource').value = '';
  owner.changeOcclusion();
  assert.equal(failures.length, 1); assert.deepEqual(events, []);
  owner.options.suspendExternalSceneEffects = () => { throw new Error('host cannot suspend'); };
  select();
  assert.match(String(failures[1]), /host cannot suspend/); assert.deepEqual(events, []);
  assert.deepEqual(owner.occlusion, { enabled: false, sourceId: 'survey-0' });
});

test('opening the AR panel suspends before object validation and explicit leave restores once', () => {
  const { owner, events } = fixture();
  owner.setPanelActive(true); owner.setPanelActive(true);
  assert.deepEqual(events, ['suspend', 'list', 'list']);
  owner.setPanelActive(false); owner.setPanelActive(false);
  assert.deepEqual(events, ['suspend', 'list', 'list', 'exit', 'restore', 'exit']);
});

test('failed AR panel initialization restores its lease', () => {
  const { owner, events } = fixture();
  owner.refreshResources = () => { throw new Error('list failed'); };
  assert.throws(() => owner.setPanelActive(true), /list failed/);
  assert.deepEqual(events, ['suspend', 'restore']);
});

test('direct prepare used by saved-scheme, export and diagnostics paths is isolated across awaits', async () => {
  const { owner, events } = fixture(), gate = deferred(), input = new AbortController();
  owner.prepareInputs = async (validate: boolean, signal: AbortSignal) => {
    assert.equal(validate, false); assert.equal(signal, input.signal);
    events.push('read scene'); await gate.promise; signal.throwIfAborted();
  };
  const preparation = owner.prepare(false, input.signal);
  assert.deepEqual(events, ['suspend', 'read scene']);
  input.abort(); gate.resolve();
  await assert.rejects(preparation, { name: 'AbortError' });
  assert.deepEqual(events, ['suspend', 'read scene', 'restore']);
});

test('direct prepare without the optional hook keeps prior behavior', async () => {
  const { owner } = fixture();
  owner.options = {}; owner.prepareInputs = async () => 'unchanged';
  assert.equal(await owner.prepare(), 'unchanged');
});

test('actual AR exit keeps map effects suspended until an in-flight entry has unwound', async () => {
  const { owner, events } = fixture(), gate = deferred(), started = deferred();
  delete owner.exit;
  const node = { disabled: false };
  Object.assign(owner, {
    epoch: 0, frameGeneration: 0, inputGeneration: 0, destroyed: false,
    presentationEditor: { unmount() {} }, spatialEditor: { unmount() {} },
    video: { readyState: 0, pause() {}, removeAttribute() {}, load() {} },
    viewer: { isDestroyed: () => false, container: { dataset: {}, parentElement: { classList: { remove() {} } } } },
    el: () => node,
    async prepare(_validate: boolean, signal: AbortSignal) {
      events.push('prepare'); started.resolve(); await gate.promise; signal.throwIfAborted();
    },
  });
  const opening = owner.enter(true);
  await started.promise;
  owner.setPanelActive(false);
  assert.deepEqual(events, ['suspend', 'prepare']);
  gate.resolve(); await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual(events, ['suspend', 'prepare', 'restore']);
  assert.equal(node.disabled, false);
  owner.setPanelActive(false);
  assert.equal(events.filter(event => event === 'restore').length, 1);
});

function legacyFixture() {
  const events: string[] = [];
  const owner = Object.assign(Object.create(LegacyOverlay.prototype), {
    options: { suspendExternalSceneEffects() {
      events.push('suspend'); return () => { events.push('restore'); };
    } },
    dataSource: { show: false }, points: [{}], playbackMs: 0, panelActive: false,
    updateAtPlayback() { events.push('read scene'); },
    applyVisibility() { events.push(this.panelActive ? 'show' : 'hide'); },
    pause() {}, cancelPendingProjectionUpdates() {}, clearLiveGeometryTimer() {}, clearLiveFrameQueue() {},
    viewer: { scene: { requestRender() {} } },
  });
  return { owner, events };
}

test('legacy AR panel suspends before geometry and restores after hiding projection', () => {
  const { owner, events } = legacyFixture();
  owner.setPanelActive(true); owner.setPanelActive(true);
  owner.setPanelActive(false); owner.setPanelActive(false);
  assert.deepEqual(events, ['suspend', 'read scene', 'show', 'read scene', 'show', 'hide', 'restore', 'hide']);
  assert.equal(owner.dataSource.show, false);
});

test('legacy AR without the new hook preserves panel operations and failures', () => {
  const { owner, events } = legacyFixture(); owner.options = {};
  owner.setPanelActive(true); owner.setPanelActive(false);
  assert.deepEqual(events, ['read scene', 'show', 'hide']);
  const failure = new Error('legacy scene failed');
  owner.updateAtPlayback = () => { throw failure; };
  assert.throws(() => owner.setPanelActive(true), error => error === failure);
});

test('legacy preview and control-point session share isolation until both close', () => {
  const { owner, events } = legacyFixture();
  const controls = new Map([
    ['#videoArSurfaceMode', { value: 'terrain' }], ['#videoArTerrain', { checked: false }], ['#videoArFps', { value: '8' }],
  ]);
  Object.assign(owner, { videoObjectUrl: 'blob:test', video: { readyState: 0 },
    element: (id: string) => controls.get(id), refreshCurrentGeometry() { events.push('preview geometry'); } });
  owner.setModelPreviewActive(true);
  owner.beginControlPointPicking();
  owner.setModelPreviewActive(false);
  assert.equal(events.filter(event => event === 'restore').length, 0);
  owner.endControlPointPicking(); owner.endControlPointPicking();
  assert.equal(events[0], 'suspend'); assert.equal(events.filter(event => event === 'restore').length, 1);
  assert.equal(controls.get('#videoArSurfaceMode')?.value, 'terrain');
  assert.equal(controls.get('#videoArTerrain')?.checked, false);
  assert.equal(controls.get('#videoArFps')?.value, '8');
});

test('legacy dormant media metadata does not suspend map edits, while direct diagnostic capture does', () => {
  const { owner, events } = legacyFixture();
  owner.updateIsolatedSceneGeometry = (...args: unknown[]) => { events.push('sample'); assert.deepEqual(args, ['state', false]); return 7; };
  owner.exportIsolatedDiagnostics = () => { events.push('capture'); return 9; };
  assert.equal(owner.updateSceneGeometry('state', false), 7);
  assert.deepEqual(events, ['sample']);
  assert.equal(owner.exportDiagnostics(), 9);
  assert.deepEqual(events, ['sample', 'suspend', 'capture', 'restore']);
  owner.panelActive = true;
  assert.equal(owner.updateSceneGeometry('state', false), 7);
  assert.deepEqual(events.slice(-2), ['suspend', 'sample']);
  owner.setPanelActive(false);
  assert.deepEqual(events.slice(-2), ['hide', 'restore']);
});

test('legacy failed activation and clear release leases without replacing original failures', () => {
  const { owner, events } = legacyFixture(), failure = new Error('scene failed');
  owner.updateAtPlayback = () => { throw failure; };
  assert.throws(() => owner.setPanelActive(true), error => error === failure);
  assert.deepEqual(events, ['suspend', 'restore']);
  owner.updateAtPlayback = () => {};
  owner.setPanelActive(true); owner.beginControlPointPicking();
  owner.clearScene = () => { throw failure; };
  assert.throws(() => owner.clear(), error => error === failure);
  assert.equal(events.filter(event => event === 'restore').length, 2);
  // clear retains the legacy panel flag; a subsequent frame must reacquire isolation.
  owner.updateIsolatedSceneGeometry = () => { events.push('sample after clear'); };
  owner.updateSceneGeometry('state'); owner.setPanelActive(false);
  assert.deepEqual(events.slice(-4), ['suspend', 'sample after clear', 'hide', 'restore']);
});
