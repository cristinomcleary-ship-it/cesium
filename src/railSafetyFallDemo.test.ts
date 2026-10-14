import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Cartesian3, JulianDate, type CustomDataSource, type Viewer } from 'cesium';
import { RailSafetyFallDemo } from './railSafetyFallDemo.ts';
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
