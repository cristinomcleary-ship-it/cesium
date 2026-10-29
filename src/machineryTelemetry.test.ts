import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultMachineryParameters, loadMachineryAsset, resolveMachineryParameters } from './machinery/index';
import type { LoadedMachineryAsset, MachineryModelId } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import { MACHINERY_ASSET_VERSION } from './machineryTypes';
import { validateMachineryMetadata } from './machineryValidation';
import {
  MachineryTelemetryState, canonicalBoomToSource, sourceBoomToCanonical,
  canonicalHeadingToSource, sourceHeadingToCanonical, defaultMachineryTelemetryConfig,
  type MachineryTelemetryBinding, type MachineryTelemetryFrame,
} from './machineryTelemetry';

const now = Date.parse('2026-10-28T12:00:00.000Z');
const assets = new Map<MachineryModelId, Promise<LoadedMachineryAsset>>();
function model(id: MachineryModelId = 'crane') {
  if (!assets.has(id)) assets.set(id, loadMachineryAsset(id, {
    baseUrl: new URL('../public/machinery/', import.meta.url).href,
    fetcher: async input => new Response(new Uint8Array(await readFile(fileURLToPath(String(input))))),
  }));
  return assets.get(id)!;
}
function initial(asset: LoadedMachineryAsset): MachineryMetadata {
  return { schemaVersion: 1, assetId: asset.id, assetVersion: MACHINERY_ASSET_VERSION,
    proportional: true, parameters: defaultMachineryParameters(asset),
    placement: { longitude: 120, latitude: 30, height: 5, heading: 20 }, visible: true };
}
function binding(target: string, sourceId = 'device-a', sourceField = target, scale = 1, offset = 0): MachineryTelemetryBinding {
  return { target, sourceId, sourceField, scale, offset, enabled: true };
}
function frame(values: Record<string, number>, timestamp = now, sourceId = 'device-a'): MachineryTelemetryFrame {
  return { schemaVersion: 1, projectId: 'project-a', resourceId: 'machine-a', sourceId,
    timestamp: new Date(timestamp).toISOString(), mode: 'measured', values };
}
async function setup(bindings: MachineryTelemetryBinding[], id: MachineryModelId = 'crane') {
  const asset = await model(id), source = initial(asset), config = defaultMachineryTelemetryConfig('project-a', 'machine-a');
  config.bindings = bindings;
  return { asset, source, config, runtime: new MachineryTelemetryState(asset, source, config) };
}
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);

test('crane canonical zero points away from +X cab; stored source pose is preserved on conversion round trip', async () => {
  const asset = await model(); assert.equal(asset.config.type, 'crane'); if (asset.config.type !== 'crane') return;
  const sourceYaw = Math.atan2(asset.config.boom.axis[2], asset.config.boom.axis[0]) * 180 / Math.PI;
  assert.ok(sourceYaw > 119 && sourceYaw < 120, 'source boom is visibly oblique, not an arbitrary 180 degree assumption');
  near(sourceYaw + canonicalBoomToSource(asset, 0), 180);
  near(sourceYaw + canonicalBoomToSource(asset, 90), 270);
  for (const angle of [0, 90, 180, 359.999]) near(sourceBoomToCanonical(asset, canonicalBoomToSource(asset, angle)), angle);
  near(canonicalHeadingToSource(90, 25), 65); near(sourceHeadingToCanonical(65, 25), 90);
  const { runtime } = await setup([binding('heading'), binding('boom_rotation_deg')]);
  assert.equal(runtime.apply(frame({ heading: 0, boom_rotation_deg: 0 }), now).accepted, true);
  near(runtime.state.placement.heading, 0); near(runtime.value('boom_rotation_deg'), 0);
  near((sourceYaw + runtime.state.parameters.boom_rotation_deg + runtime.state.placement.heading) % 360, 180);
});

test('only selected channels update; dimensions bypass proportional editing and derived height stays valid', async () => {
  const { runtime, source } = await setup([binding('boom_length_m')]);
  const result = runtime.apply(frame({ boom_length_m: 5, heading: 90, latitude: 0, boom_elevation_deg: 0 }), now);
  assert.equal(result.accepted, true); assert.equal(result.state.parameters.boom_length_m, 5);
  assert.deepEqual(result.state.placement, source.placement);
  for (const key of ['overall_scale', 'body_height_m', 'outrigger_lateral_m', 'outrigger_longitudinal_m', 'boom_elevation_deg']) assert.equal(result.state.parameters[key], source.parameters[key]);
  assert.ok(result.state.parameters.overall_height_m > source.parameters.overall_height_m);
  assert.deepEqual(validateMachineryMetadata(result.state), result.state);
  assert.equal(source.parameters.boom_length_m, (await model()).config.parameters.find(p => p.key === 'boom_length_m')!.original);
});

test('partial packets retain previous values and numeric zero is applied', async () => {
  const { runtime } = await setup([binding('longitude'), binding('latitude'), binding('boom_elevation_deg')]);
  runtime.apply(frame({ longitude: 0, latitude: 0, boom_elevation_deg: 0 }), now);
  const result = runtime.apply(frame({ longitude: 1 }, now + 1000), now + 1000);
  assert.equal(result.state.placement.longitude, 1); assert.equal(result.state.placement.latitude, 0);
  assert.equal(result.state.parameters.boom_elevation_deg, 0);
  assert.equal(runtime.fieldStatus(now + 6000).find(f => f.target === 'latitude')?.status, 'stale');
  assert.equal(runtime.fieldStatus(now + 6000).find(f => f.target === 'longitude')?.status, 'fresh');
});

test('invalid values, impossible geometry and invalid times cannot partially change the model or clocks', async () => {
  const { runtime, source } = await setup([binding('heading'), binding('boom_length_m'), binding('boom_elevation_deg')]);
  for (const values of [{ heading: 40, boom_length_m: -1 }, { heading: 40, boom_length_m: .01 },
    { heading: 40, boom_elevation_deg: 91 }, { heading: 40, boom_length_m: null }, { heading: 40, boom_length_m: '5' }, { heading: 40, boom_length_m: Infinity }]) {
    assert.equal(runtime.apply(frame(values as unknown as Record<string, number>), now).accepted, false);
    assert.deepEqual(runtime.state, source); assert.ok(runtime.fieldStatus(now).every(f => f.status === 'waiting'));
  }
  for (const timestamp of [now - 60_001, now + 5001]) assert.equal(runtime.apply(frame({ heading: 0 }, timestamp), now).accepted, false);
  assert.equal(runtime.apply({ ...frame({ heading: 0 }), timestamp: '2026-02-30T12:00:00Z' }, now).accepted, false);
  assert.equal(runtime.apply(frame({ heading: 0 }), now).accepted, true, 'failed packets never advance accepted clocks');
});

test('per-field ordering accepts older independent source data, rejects duplicates and wraps angles', async () => {
  const { runtime } = await setup([binding('heading', 'gps'), binding('boom_rotation_deg', 'encoder')]);
  runtime.apply(frame({ heading: 359 }, now, 'gps'), now);
  assert.equal(runtime.apply(frame({ boom_rotation_deg: -360 }, now - 1000, 'encoder'), now).accepted, true);
  assert.equal(runtime.apply(frame({ heading: 20 }, now, 'gps'), now).accepted, false);
  assert.equal(runtime.apply(frame({ heading: 20 }, now - 10, 'gps'), now).accepted, false);
  runtime.apply(frame({ heading: 361 }, now + 1, 'gps'), now + 1); near(runtime.state.placement.heading, 1);
  near(runtime.value('boom_rotation_deg'), 0);
});

test('binding calibration supports millimetres and reversed encoders; rebind invalidates old source', async () => {
  const { runtime, config } = await setup([binding('boom_length_m', 'sensor', 'length_mm', .001), binding('boom_rotation_deg', 'sensor', 'encoder', -1, 20)]);
  assert.equal(runtime.apply(frame({ length_mm: 5000, encoder: 20 }, now, 'sensor'), now).accepted, true);
  assert.equal(runtime.state.parameters.boom_length_m, 5); near(runtime.value('boom_rotation_deg'), 0);
  config.bindings[0].sourceId = 'sensor-new'; runtime.setConfig(config);
  assert.equal(runtime.apply(frame({ length_mm: 6000 }, now + 1, 'sensor'), now + 1).accepted, false);
  assert.equal(runtime.apply(frame({ length_mm: 6000 }, now - 100, 'sensor-new'), now).accepted, true);
  assert.equal(runtime.state.parameters.boom_length_m, 6);
});

test('manual edits preserve bound values; unbinding holds last state then permits manual edits', async () => {
  const { runtime, config, asset } = await setup([binding('heading'), binding('boom_length_m')]);
  runtime.apply(frame({ heading: 0, boom_length_m: 5 }), now);
  const manual = runtime.state; manual.placement.heading = 90; manual.placement.latitude = 31;
  manual.parameters = resolveMachineryParameters(asset, manual.parameters, { boom_length_m: 6, boom_elevation_deg: 20 }, { proportional: false });
  runtime.setManualState(manual);
  assert.equal(runtime.state.placement.heading, 0); assert.equal(runtime.state.placement.latitude, 31);
  assert.equal(runtime.state.parameters.boom_length_m, 5); assert.equal(runtime.state.parameters.boom_elevation_deg, 20);
  config.bindings.forEach(b => b.enabled = false); runtime.setConfig(config);
  assert.equal(runtime.state.parameters.boom_length_m, 5); runtime.setManualState(manual);
  assert.equal(runtime.state.parameters.boom_length_m, 6); assert.equal(runtime.state.placement.heading, 90);
});

test('project/resource isolation and simulation/measurement source isolation', async () => {
  const { runtime, source } = await setup([binding('heading')]);
  assert.equal(runtime.apply({ ...frame({ heading: 0 }), projectId: 'other' }, now).accepted, false);
  assert.equal(runtime.apply({ ...frame({ heading: 0 }), resourceId: 'other' }, now).accepted, false);
  assert.deepEqual(runtime.state, source);
  runtime.apply(frame({ heading: 0 }), now);
  assert.equal(runtime.apply({ ...frame({ heading: 60 }, now + 1), mode: 'simulated' }, now + 1).accepted, false);
  assert.equal(runtime.state.placement.heading, 0); assert.equal(runtime.fieldStatus(now)[0].mode, 'measured');
});

test('pile height is independent; excavator uses existing overall height scaling without inventing joints', async () => {
  const pile = await setup([binding('total_height_m')], 'pile');
  const p = pile.runtime.apply(frame({ total_height_m: 5 }), now);
  assert.equal(p.accepted, true); near(p.state.parameters.total_height_m, 5);
  assert.equal(p.state.parameters.overall_scale, 1); assert.equal(p.state.parameters.body_height_m, pile.source.parameters.body_height_m);
  const excavator = await setup([binding('overall_height_m')], 'excavator');
  const e = excavator.runtime.apply(frame({ overall_height_m: 10 }), now);
  assert.equal(e.accepted, true); near(e.state.parameters.overall_height_m, 10);
  assert.throws(() => new MachineryTelemetryState(excavator.asset, excavator.source,
    { ...excavator.config, bindings: [binding('boom_rotation_deg')] }), /绑定无效/);
});

test('batch coalescing keeps partial channels, latest values and each actual acquisition time', async () => {
  const { runtime } = await setup([binding('longitude'), binding('heading'), binding('boom_length_m')]);
  const r = runtime.applyBatch([
    frame({ longitude: 121 }, now - 5500), frame({ heading: 30 }, now - 200),
    frame({ boom_length_m: 4 }, now - 100), frame({ boom_length_m: 5 }, now),
  ], now);
  assert.equal(r.accepted, true); assert.equal(r.state.placement.longitude, 121);
  assert.equal(r.state.placement.heading, 30); assert.equal(r.state.parameters.boom_length_m, 5);
  const statuses = runtime.fieldStatus(now);
  assert.equal(statuses.find(f => f.target === 'longitude')?.status, 'stale');
  assert.equal(statuses.find(f => f.target === 'longitude')?.ageMs, 5500);
  assert.equal(statuses.find(f => f.target === 'heading')?.ageMs, 200);
  assert.equal(statuses.find(f => f.target === 'boom_length_m')?.ageMs, 0);
  assert.equal(runtime.apply(frame({ longitude: 122 }, now - 1000), now).accepted, true, 'newer independent partial sample is not hidden by another field clock');
});

test('same source field bound to targets with different histories preserves their own ordering in a batch', async () => {
  const { runtime, config } = await setup([binding('heading', 'device-a', 'angle')]);
  runtime.apply(frame({ angle: 20 }, now), now);
  config.bindings.push(binding('boom_rotation_deg', 'device-a', 'angle')); config.bindings.push(binding('longitude'));
  runtime.setConfig(config);
  runtime.applyBatch([frame({ angle: 10 }, now - 1000), frame({ longitude: 121 }, now + 100)], now + 100);
  assert.equal(runtime.state.placement.heading, 20, 'newer longitude does not lend its timestamp to the older angle');
  near(runtime.value('boom_rotation_deg'), 10);
});
