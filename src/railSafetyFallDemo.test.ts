import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Cartesian3, ClassificationType, JulianDate, type CustomDataSource, type Viewer } from 'cesium';
import { RailSafetyFallDemo } from './railSafetyFallDemo.ts';
import type { RailSafetyFallProjectionClient, RailSafetyFallProjectionResult } from './railSafetyFallProjectionClient';
import { loadMachineryAsset, type LoadedMachineryAsset } from './machinery/index.ts';
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from './machineryTypes.ts';
import { MACHINERY_PARAMETER_DEFAULTS } from './machineryValidation.ts';

let asset: LoadedMachineryAsset;
test.before(async () => {
  asset = await loadMachineryAsset('crane', { fetcher: async input => {
    const url = new URL(String(input), 'http://fixture.local');
    return new Response(new Uint8Array(await readFile(new URL(`../public/${url.pathname.slice(1)}`, import.meta.url))));
  } });
});
const state = (): MachineryMetadata => ({ schemaVersion: 1, assetId: 'crane', assetVersion: MACHINERY_ASSET_VERSION,
  proportional: false, parameters: { ...MACHINERY_PARAMETER_DEFAULTS.crane },
  placement: { longitude: 121, latitude: 31, height: 120, heading: 25 }, visible: true });
function fixture() {
  const sources = new Set<CustomDataSource>();
  const frames = new Map<number, (time: number) => void>(); let next = 0;
  const viewer = { dataSources: { add(source: CustomDataSource) { sources.add(source); return Promise.resolve(source); },
    remove(source: CustomDataSource) { sources.delete(source); source.entities.removeAll(); return true; } },
    scene: { requestRender() {} }, isDestroyed: () => false } as unknown as Viewer;
  return { sources, viewer, frames, schedule(callback: (time: number) => void) { const id = ++next; frames.set(id, callback); return id; },
    cancel: (handle: number) => { frames.delete(handle); }, tick(time: number) {
      const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(time);
    } };
}

test('a real current-pose GLB copy plays, pauses, scrubs and resets without changing its machinery input', async () => {
  const f = fixture(), input = { resourceId: 'crane', resourceName: '吊机', state: state() }, original = structuredClone(input);
  let font = '13px sans-serif';
  const demo = new RailSafetyFallDemo(f.viewer, { loadAsset: async () => asset, schedule: f.schedule, cancel: f.cancel, labelFont: () => font });
  try {
    assert.equal(await demo.start(input), true);
    assert.deepEqual(demo.getInput(), original, 'export uses the exact pose that constructed the demo copy');
    const exported = demo.getInput()!; exported.state.placement.heading = 180;
    assert.deepEqual(demo.getInput(), original, 'export snapshots cannot mutate the demonstration');
    assert.equal(demo.getSnapshot().sourceTriangleCount, asset.indices.length / 3);
    assert.ok(demo.getSnapshot().sourcePartCount > 1 && demo.getSnapshot().modelCreated);
    const entity = [...f.sources][0].entities.getById('rail-safety:fall-demo:crane:model')!;
    const initial = Cartesian3.clone(entity.position!.getValue(JulianDate.now())!);
    demo.set({ angle: 45, direction: 270 });
    assert.equal(demo.getSnapshot().angle, 45);
    assert.ok(!Cartesian3.equalsEpsilon(entity.position!.getValue(JulianDate.now())!, initial, 1e-12));
    assert.equal(demo.getSnapshot().direction, 270);
    const tiltedPosition = Cartesian3.clone(entity.position!.getValue(JulianDate.now())!);
    font = '13px "Noto Sans SC", sans-serif'; demo.refreshLabelFont();
    assert.equal(entity.label!.font!.getValue(JulianDate.now()), font);
    assert.equal(demo.getSnapshot().angle, 45);
    assert.ok(Cartesian3.equals(entity.position!.getValue(JulianDate.now())!, tiltedPosition), 'font arrival never resets the motion or original placement');
    demo.reset(); assert.equal(demo.getSnapshot().angle, 0);
    assert.ok(Cartesian3.equalsEpsilon(entity.position!.getValue(JulianDate.now())!, initial, 1e-12));
    demo.set({ playing: true }); f.tick(0); f.tick(250);
    assert.equal(demo.getSnapshot().angle, 3, 'playback advances the display angle using elapsed time');
    demo.set({ playing: false }); f.tick(500);
    assert.equal(demo.getSnapshot().angle, 3); assert.equal(f.frames.size, 0);
    demo.set({ angle: 89, playing: true }); f.tick(750); f.tick(1000);
    assert.equal(demo.getSnapshot().angle, 90); assert.equal(demo.getSnapshot().playing, false);
    assert.deepEqual(input, original, 'no placement, dimensions or model pose is written back');
    demo.stop(); assert.equal(f.sources.size, 0); assert.equal(f.frames.size, 0);
    assert.equal(demo.getInput(), undefined, 'a stopped demo cannot export a stale pose');
    assert.equal(demo.getSnapshot().active, false);
  } finally { demo.dispose(); }
});

test('stopping while the source model is pending prevents late ghost geometry', async () => {
  const f = fixture(); let release!: (asset: LoadedMachineryAsset) => void;
  const pending = new Promise<LoadedMachineryAsset>(resolve => { release = resolve; });
  const demo = new RailSafetyFallDemo(f.viewer, { loadAsset: () => pending });
  const start = demo.start({ resourceId: 'crane', resourceName: '吊机', state: state() });
  assert.equal(demo.getSnapshot().loading, true);
  demo.stop(); release(asset);
  assert.equal(await start, false);
  assert.equal(f.sources.size, 0); assert.deepEqual(demo.getSnapshot().entityIds, []);
  demo.dispose();
});

test('a pending Cesium datasource add is removed after cancellation and replaced URLs are released', async () => {
  const f = fixture(); let release!: (source: CustomDataSource) => void, entered!: () => void;
  const added = new Promise<void>(resolve => { entered = resolve; });
  const normalAdd = f.viewer.dataSources.add.bind(f.viewer.dataSources);
  f.viewer.dataSources.add = ((source: CustomDataSource) => {
    f.sources.add(source); entered(); return new Promise<CustomDataSource>(resolve => { release = () => resolve(source); });
  }) as typeof f.viewer.dataSources.add;
  const demo = new RailSafetyFallDemo(f.viewer, { loadAsset: async () => asset });
  const start = demo.start({ resourceId: 'crane', resourceName: '吊机', state: state() });
  await added; demo.stop(); release([...f.sources][0]);
  assert.equal(await start, false); assert.equal(f.sources.size, 0);
  f.viewer.dataSources.add = normalAdd;
  const revoked: string[] = [], originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
  try {
    await demo.start({ resourceId: 'crane', resourceName: '吊机', state: state() });
    const source = [...f.sources][0], uri = source.entities.values.find(e => e.model)!.model!.uri!.getValue(JulianDate.now());
    demo.dispose();
    assert.ok(revoked.includes(uri)); assert.equal(f.sources.size, 0);
  } finally { URL.revokeObjectURL = originalRevoke; demo.dispose(); }
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function projectionFixture() {
  const requests: { direction: number; angle: number; resolve: (result: RailSafetyFallProjectionResult) => void; reject: (error: Error) => void }[] = [];
  const canvases: HTMLCanvasElement[] = [];
  let disposed = false;
  const client: RailSafetyFallProjectionClient = {
    compute(direction, angle) { return new Promise((resolve, reject) => { requests.push({ direction, angle, resolve, reject }); }); },
    dispose() { disposed = true; },
  };
  const createCanvas = () => {
    const canvas = { width: 0, height: 0, pixels: undefined as ImageData | undefined,
      getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData(data: ImageData) { canvas.pixels = data; } }) };
    const element = canvas as unknown as HTMLCanvasElement;
    canvases.push(element); return element;
  };
  const resolve = (index: number) => {
    const request = requests[index];
    request.resolve({ bounds: { xMin: -2, yMin: -2, xMax: 2, yMax: 2 }, width: 8, height: 8,
      mask: new Uint8Array(64).fill(1), cellSizeMeters: 0.5, areaMeters2: 16,
      direction: request.direction, angle: request.angle, firstContactAngle: 70, belowGround: request.angle > 70 });
  };
  return { client, requests, createCanvas, canvases, resolve, get disposed() { return disposed; } };
}
const footprintDisplay = () => ({ footprintVisible: true, modelVisible: true,
  area: { surface: 'model' as const, style: 'fill' as const, opacity: 0.3, lineWidth: 2 }, color: '#319ad4' });

test('projection commits a matching model pose, collapses pending drag targets and cannot return after stop', async () => {
  const f = fixture(), p = projectionFixture();
  const demo = new RailSafetyFallDemo(f.viewer, { loadAsset: async () => asset, createProjectionClient: () => p.client, createCanvas: p.createCanvas });
  demo.setDisplay(footprintDisplay());
  try {
    await demo.start({ resourceId: 'crane', resourceName: '吊机', state: state() });
    const source = [...f.sources][0], model = source.entities.getById('rail-safety:fall-demo:crane:model')!;
    assert.equal(model.show, false, 'no uncomputed angle is presented as ready');
    assert.equal(demo.getSnapshot().projectionBusy, true); assert.equal(p.requests.length, 1);
    p.resolve(0); await flush();
    assert.equal(demo.getSnapshot().projectionReady, true); assert.equal(model.show, true);
    const original = Cartesian3.clone(model.position!.getValue(JulianDate.now())!);
    const footprint = source.entities.getById('rail-safety:fall-demo:crane:footprint')!;
    assert.equal(footprint.polygon!.classificationType!.getValue(), ClassificationType.BOTH);
    demo.set({ angle: 35, direction: 130 }); demo.set({ angle: 55, direction: 145 });
    assert.equal(p.requests.length, 2, 'only the first target is in flight');
    assert.equal(demo.getSnapshot().projectionAngle, 0);
    assert.ok(Cartesian3.equals(model.position!.getValue(JulianDate.now())!, original), 'model retains the same angle as the visible mask');
    p.resolve(1); await flush();
    assert.equal(p.requests.length, 3); assert.equal(p.requests[2].angle, 55);
    assert.equal(demo.getSnapshot().projectionAngle, 0, 'a late superseded target is discarded');
    p.resolve(2); await flush();
    assert.equal(demo.getSnapshot().projectionAngle, 55); assert.equal(demo.getSnapshot().actualDirection, 145);
    assert.equal(demo.getSnapshot().projectionCellSizeMeters, 0.5); assert.equal(demo.getSnapshot().projectionAreaMeters2, 16);
    assert.ok(!Cartesian3.equals(model.position!.getValue(JulianDate.now())!, original));
    demo.set({ angle: 80 }); demo.stop(); p.resolve(3); await flush();
    assert.equal(p.disposed, true); assert.equal(f.sources.size, 0); assert.equal(demo.getSnapshot().projectionReady, false);
    assert.equal(p.canvases.at(-1)!.width, 0, 'the last displayed canvas is released on stop');
  } finally { demo.dispose(); }
});

test('range styles reuse the projection; hiding a footprint leaves the model available and does not revive on a late result', async () => {
  const f = fixture(), p = projectionFixture();
  const demo = new RailSafetyFallDemo(f.viewer, { loadAsset: async () => asset, createProjectionClient: () => p.client, createCanvas: p.createCanvas });
  demo.setDisplay(footprintDisplay());
  try {
    await demo.start({ resourceId: 'crane', resourceName: '吊机', state: state() }); p.resolve(0); await flush();
    const source = [...f.sources][0], footprint = source.entities.getById('rail-safety:fall-demo:crane:footprint')!;
    demo.setDisplay({ ...footprintDisplay(), area: { ...footprintDisplay().area, surface: 'absolute', style: 'outline' }, color: '#e36523' });
    assert.equal(p.requests.length, 1); assert.equal(footprint.polygon!.perPositionHeight!.getValue(), true);
    assert.ok(footprint.polygon!.textureCoordinates!.getValue());
    demo.setDisplay({ ...footprintDisplay(), area: { ...footprintDisplay().area, surface: 'terrain' } });
    assert.equal(footprint.polygon!.classificationType!.getValue(), ClassificationType.TERRAIN);
    demo.set({ angle: 50 }); demo.setDisplay({ ...footprintDisplay(), footprintVisible: false });
    assert.equal(footprint.show, false); assert.equal(source.entities.getById('rail-safety:fall-demo:crane:model')!.show, true);
    p.resolve(1); await flush(); assert.equal(footprint.show, false); assert.equal(p.requests.length, 2);
    demo.setDisplay({ ...footprintDisplay(), modelVisible: false }); p.resolve(2); await flush();
    assert.equal(footprint.show, true); assert.equal(source.entities.getById('rail-safety:fall-demo:crane:model')!.show, false);
  } finally { demo.dispose(); }
});

test('worker errors expose an honest failed projection and stop playback without inventing a ready footprint', async () => {
  const f = fixture(), p = projectionFixture();
  const demo = new RailSafetyFallDemo(f.viewer, { loadAsset: async () => asset, createProjectionClient: () => p.client,
    createCanvas: p.createCanvas, schedule: f.schedule, cancel: f.cancel });
  demo.setDisplay(footprintDisplay());
  try {
    await demo.start({ resourceId: 'crane', resourceName: '吊机', state: state() });
    p.requests[0].reject(new Error('test worker unavailable')); await flush();
    assert.equal(demo.getSnapshot().projectionReady, false); assert.equal(demo.getSnapshot().projectionBusy, false);
    assert.match(demo.getSnapshot().projectionError!, /worker unavailable/); assert.equal(demo.getSnapshot().playing, false);
    assert.equal([...f.sources][0].entities.values.filter(entity => entity.polygon).length, 0);
  } finally { demo.dispose(); }
});

test('a failure after a ready projection hides the old mask before the overview fallback is restored', async () => {
  const f = fixture(), p = projectionFixture();
  const demo = new RailSafetyFallDemo(f.viewer, { loadAsset: async () => asset, createProjectionClient: () => p.client, createCanvas: p.createCanvas });
  demo.setDisplay(footprintDisplay());
  try {
    await demo.start({ resourceId: 'crane', resourceName: '吊机', state: state() }); p.resolve(0); await flush();
    const footprint = [...f.sources][0].entities.getById('rail-safety:fall-demo:crane:footprint')!;
    demo.set({ angle: 45 }); p.requests[1].reject(new Error('second projection failed')); await flush();
    assert.equal(footprint.show, false); assert.equal(demo.getSnapshot().projectionReady, false);
    demo.setDisplay({ ...footprintDisplay(), color: '#112233' });
    assert.equal(footprint.show, false, 'style refresh after failure never restores a stale mask');
    assert.equal(p.requests.length, 2, 'error-driven panel rendering does not requeue recursively');
  } finally { demo.dispose(); }
});

test('projection effects animate an unchanged mask and stop on hide, static mode, exit and disposal', async () => {
  const f = fixture(), p = projectionFixture();
  const demo = new RailSafetyFallDemo(f.viewer, { loadAsset: async () => asset, createProjectionClient: () => p.client,
    createCanvas: p.createCanvas, schedule: f.schedule, cancel: f.cancel });
  const display = { ...footprintDisplay(), effect: { mode: 'flow' as 'flow' | 'breathe' | 'static', speed: 1.5, intensity: 0.7 } };
  demo.setDisplay(display);
  try {
    await demo.start({ resourceId: 'crane', resourceName: '吊机', state: state() }); p.resolve(0); await flush();
    const footprint = [...f.sources][0].entities.getById('rail-safety:fall-demo:crane:footprint')!, time = JulianDate.now();
    const polygon = footprint.polygon!, canvas = polygon.material!.getValue(time).image, hierarchy = polygon.hierarchy;
    assert.equal(polygon.material!.getValue(time).mode, 2); assert.equal(polygon.material!.isConstant, true);
    assert.equal(f.frames.size, 1);
    f.tick(0); f.tick(1000);
    assert.equal(footprint.polygon, polygon); assert.equal(footprint.polygon!.hierarchy, hierarchy);
    assert.equal(footprint.polygon!.material!.getValue(time).image, canvas);
    assert.equal(p.requests.length, 1); assert.equal(p.canvases.length, 1, 'animation never regenerates the mesh mask or texture');
    display.effect.mode = 'breathe'; demo.setDisplay(display);
    assert.equal(footprint.polygon!.material!.getValue(time).mode, 1);
    assert.equal(footprint.polygon!.material!.getValue(time).image, canvas);
    assert.equal(p.canvases.length, 1, 'changing only effect parameters preserves the same raster');
    demo.setDisplay({ ...display, footprintVisible: false }); assert.equal(f.frames.size, 0);
    demo.setDisplay(display); assert.equal(f.frames.size, 1);
    display.effect.mode = 'static'; demo.setDisplay(display); assert.equal(f.frames.size, 0);
    assert.equal(footprint.polygon!.material!.getType(time), 'Image');
    display.effect.mode = 'flow'; demo.setDisplay(display); assert.equal(f.frames.size, 1);
    demo.stop(); assert.equal(f.frames.size, 0); assert.equal(f.sources.size, 0);
    demo.dispose(); assert.equal(f.frames.size, 0);
  } finally { demo.dispose(); }
});
