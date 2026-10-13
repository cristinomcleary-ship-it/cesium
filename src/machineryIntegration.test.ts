import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Cesium from 'cesium';
import { MACHINERY_ASSET_IDS, MACHINERY_ASSET_VERSION, type MachineryAssetId, type MachineryMetadata } from './machineryTypes.ts';
import { MACHINERY_PARAMETER_DEFAULTS, validateMachineryMetadata } from './machineryValidation.ts';
import { MACHINERY_CATALOG, loadMachineryAsset, defaultMachineryParameters, resolveMachineryParameters, computeMachineryGeometry, type LoadedMachineryAsset } from './machinery/index.ts';
import { MachineryScene, readMachineryState } from './machineryScene.ts';

const { Cartesian3, Cartographic, Matrix4, Matrix3, Transforms, JulianDate, Axis } = Cesium;
const publicRoot = new URL('../public/', import.meta.url);
const fileFetcher: typeof fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://fixture.local');
  const bytes = await readFile(new URL(url.pathname.slice(1), publicRoot));
  return new Response(new Uint8Array(bytes));
};
const assets = new Map<MachineryAssetId, Promise<LoadedMachineryAsset>>();
function asset(id: MachineryAssetId): Promise<LoadedMachineryAsset> {
  let value = assets.get(id);
  if (!value) { value = loadMachineryAsset(id, { baseUrl: '/machinery/', fetcher: fileFetcher }); assets.set(id, value); }
  return value;
}
function state(id: MachineryAssetId, parameters = { ...MACHINERY_PARAMETER_DEFAULTS[id] }): MachineryMetadata {
  return { schemaVersion: 1, assetId: id, assetVersion: MACHINERY_ASSET_VERSION, proportional: true, parameters,
    placement: { longitude: 121, latitude: 31, height: 120, heading: 0 }, visible: true };
}
function near(actual: number, expected: number, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function viewerFixture(staged = false) {
  const gate = deferred<Cesium.CustomDataSource>();
  let source!: Cesium.CustomDataSource;
  let renders = 0;
  const viewer = {
    dataSources: {
      add(value: Cesium.CustomDataSource) { source = value; return staged ? gate.promise : Promise.resolve(value); },
      remove(value: Cesium.CustomDataSource) { if (value === source) source.entities.removeAll(); return true; },
    },
    scene: { requestRender() { renders++; } }, isDestroyed: () => false,
    flyTo: async () => true,
  } as unknown as Cesium.Viewer;
  return { viewer, source: () => source, release: () => gate.resolve(source), renders: () => renders };
}

// Independent contract check: asset measurements are the source of defaults; the server must accept them unchanged.
test('all shipped catalog defaults exactly match persisted metadata and remain grounded', async () => {
  assert.deepEqual(MACHINERY_CATALOG.map(item => item.id), [...MACHINERY_ASSET_IDS]);
  for (const id of MACHINERY_ASSET_IDS) {
    const model = await asset(id), parameters = defaultMachineryParameters(model);
    assert.equal(model.version, MACHINERY_ASSET_VERSION);
    assert.deepEqual(parameters, MACHINERY_PARAMETER_DEFAULTS[id]);
    assert.deepEqual(validateMachineryMetadata(state(id, parameters)), state(id, parameters));
    const geometry = computeMachineryGeometry(model, parameters);
    near(geometry.bounds.min[1], 0, 1e-9);
    assert.deepEqual(geometry.sourceAnchor, model.config.reference_dimensions.anchor_m);
    near(geometry.bounds.size[1], parameters.total_height_m ?? parameters.overall_height_m, 1e-9);
  }
});

test('real independent shapes survive mode changes and service validation, including 60 m pile height', async () => {
  for (const id of MACHINERY_ASSET_IDS) {
    const model = await asset(id), defaults = defaultMachineryParameters(model);
    const edits = id === 'crane' ? { boom_length_m: defaults.boom_length_m * 1.6, outrigger_lateral_m: defaults.outrigger_lateral_m * 1.4 }
      : id === 'pile' ? { total_height_m: 60 } : { body_height_m: defaults.body_height_m * 1.5 };
    const changed = resolveMachineryParameters(model, defaults, edits, { proportional: false });
    const before = computeMachineryGeometry(model, changed);
    for (const proportional of [false, true]) {
      const saved = validateMachineryMetadata({ ...state(id, changed), proportional });
      const restored = resolveMachineryParameters(model, saved.parameters, {}, { proportional });
      assert.deepEqual(restored, changed);
      assert.deepEqual(computeMachineryGeometry(model, restored).positions, before.positions);
    }
    near(before.bounds.min[1], 0, 1e-9);
    near(before.bounds.size[1], changed.total_height_m ?? changed.overall_height_m, 1e-9);
  }
});

test('legacy crane reads normalize only missing angles without changing the source record or original elevation geometry', async () => {
  const model = await asset('crane');
  assert.equal(model.config.type, 'crane');
  if (model.config.type !== 'crane') throw new Error('expected crane config');
  const originalElevation = Math.asin(model.config.boom.axis[1]) * 180 / Math.PI;
  assert.equal(MACHINERY_PARAMETER_DEFAULTS.crane.boom_elevation_deg, originalElevation, 'default comes from the extracted source axis rather than an assumed upright or horizontal pose');
  for (const missing of [['boom_rotation_deg'], ['boom_elevation_deg'], ['boom_rotation_deg', 'boom_elevation_deg']]) {
    const legacy = state('crane');
    for (const key of missing) delete legacy.parameters[key];
    const before = structuredClone(legacy), normalized = readMachineryState(legacy)!;
    assert.ok(normalized, 'pre-angle saved cranes remain readable');
    assert.equal(normalized.parameters.boom_rotation_deg, 0);
    assert.equal(normalized.parameters.boom_elevation_deg, originalElevation);
    assert.deepEqual(legacy, before, 'normalization never mutates saved records');
    assert.notEqual(normalized.parameters, legacy.parameters);
    assert.deepEqual(normalized.placement, legacy.placement);
    assert.deepEqual(computeMachineryGeometry(model, normalized.parameters).positions, computeMachineryGeometry(model, defaultMachineryParameters(model)).positions);
  }
  const legacy = state('crane'); delete legacy.parameters.boom_elevation_deg;
  legacy.parameters.boom_rotation_deg = 270;
  assert.equal(readMachineryState(legacy)!.parameters.boom_rotation_deg, 270, 'elevation migration does not reset an existing slew pose');
  const missingDimension = structuredClone(legacy); delete missingDimension.parameters.boom_length_m;
  assert.equal(readMachineryState(missingDimension), undefined, 'legacy compatibility does not permit missing dimensions');
  const extraParameter = structuredClone(legacy); extraParameter.parameters.unrecognized_angle = 90;
  assert.equal(readMachineryState(extraParameter), undefined, 'legacy compatibility keeps strict allowed keys');
});

test('crane elevation and slew persist independently through real geometry validation, scaling and reload', async () => {
  const model = await asset('crane'), defaults = defaultMachineryParameters(model);
  const extended = resolveMachineryParameters(model, defaults, { boom_length_m: defaults.boom_length_m * 1.4 }, { proportional: false });
  for (const proportional of [true, false]) {
    for (const angle of [0, 30, 45.25, defaults.boom_elevation_deg, 90]) {
      const parameters = resolveMachineryParameters(model, extended, { boom_elevation_deg: angle, boom_rotation_deg: 270 }, { proportional });
      const metadata = { ...state('crane', parameters), proportional };
      metadata.placement.heading = 35;
      const restored = validateMachineryMetadata(metadata);
      assert.equal(restored.parameters.boom_elevation_deg, angle);
      assert.equal(restored.parameters.boom_rotation_deg, 270);
      assert.equal(restored.parameters.boom_length_m, extended.boom_length_m);
      assert.deepEqual(restored.placement, metadata.placement);
      const geometry = computeMachineryGeometry(model, restored.parameters);
      near(restored.parameters.overall_height_m, geometry.bounds.size[1]);
      assert.deepEqual(geometry.sourceAnchor, model.config.reference_dimensions.anchor_m, 'lowering the boom cannot recenter the foundation');
      assert.deepEqual(resolveMachineryParameters(model, restored.parameters, {}, { proportional }), restored.parameters);
      const scaled = resolveMachineryParameters(model, restored.parameters, { overall_scale: 2 }, { proportional });
      assert.equal(scaled.boom_elevation_deg, angle);
      assert.equal(scaled.boom_rotation_deg, 270);
      const persisted = validateMachineryMetadata({ ...metadata, parameters: scaled });
      assert.deepEqual(resolveMachineryParameters(model, persisted.parameters, {}, { proportional }), persisted.parameters, 'derived bounds and both angles survive save/reload');
    }
  }
});

test('locating a lowered long boom uses its horizontal extent in the existing viewer and keeps the same equipment entity', async () => {
  const model = await asset('crane'), fixture = viewerFixture(), scene = new MachineryScene(fixture.viewer);
  const flights: Array<{ target: unknown; offset: Cesium.HeadingPitchRange | undefined }> = [];
  fixture.viewer.flyTo = async (target, options) => { flights.push({ target, offset: options?.offset }); return true; };
  scene.setContext({ projectId: 'safety:project', records: [], canView: true, active: true });
  try {
    const raised = resolveMachineryParameters(model, defaultMachineryParameters(model), { boom_length_m: 20, boom_elevation_deg: 90 }, { proportional: false });
    await scene.preview('long-boom', state('crane', raised), model);
    const entity = fixture.source().entities.getById('machinery:long-boom')!;
    const position = entity.position!.getValue(JulianDate.now())!;
    const lowered = resolveMachineryParameters(model, raised, { boom_elevation_deg: 0 }, { proportional: false });
    await scene.preview('long-boom', state('crane', lowered), model);
    assert.equal(fixture.source().entities.values.length, 1);
    assert.equal(fixture.source().entities.getById(entity.id), entity, 'pose updates reuse the equipment entity');
    assert.deepEqual(entity.position!.getValue(JulianDate.now()), position, 'lowering does not move its station');
    assert.equal(await scene.flyTo('long-boom'), true);
    assert.equal(flights.length, 1, 'the original host viewer performs the locate operation');
    assert.equal(flights[0].target, entity);
    assert.ok(lowered.boom_length_m > lowered.overall_height_m, 'fixture represents the horizontal long-boom regression');
    assert.ok(flights[0].offset!.range >= lowered.boom_length_m * 4, 'locating leaves room for the horizontal boom, not just its low height');
    assert.ok(flights[0].offset!.range > lowered.overall_height_m * 4);
  } finally { scene.destroy(); }
});

test('crane rotation survives service validation and proportional size edits without scaling the angle or changing placement', async () => {
  const model = await asset('crane'), defaults = defaultMachineryParameters(model);
  for (const proportional of [true, false]) {
    for (const angle of [0, 90, 180, 270, 359.999]) {
      const parameters = resolveMachineryParameters(model, defaults, { boom_rotation_deg: angle }, { proportional });
      const metadata = { ...state('crane', parameters), proportional };
      metadata.placement.heading = 35;
      const restored = validateMachineryMetadata(metadata);
      assert.equal(restored.parameters.boom_rotation_deg, angle);
      assert.deepEqual(restored.placement, metadata.placement);
      const scaled = resolveMachineryParameters(model, restored.parameters, { overall_scale: 2 }, { proportional });
      assert.equal(scaled.boom_rotation_deg, angle, 'a dimensionless angle is never multiplied by the overall scale');
      assert.equal(validateMachineryMetadata({ ...metadata, parameters: scaled }).parameters.boom_rotation_deg, angle);
      assert.deepEqual(resolveMachineryParameters(model, restored.parameters, {}, { proportional }), restored.parameters, 'saved angle is stable on reload');
    }
  }
  for (const id of ['pile', 'excavator'] as const) {
    const unchanged = state(id);
    assert.deepEqual(validateMachineryMetadata(unchanged), unchanged);
    assert.equal(Object.hasOwn(unchanged.parameters, 'boom_rotation_deg'), false, 'other assets retain their exact parameter contracts');
    assert.equal(Object.hasOwn(unchanged.parameters, 'boom_elevation_deg'), false);
  }
});

test('scene rejects unsupported asset versions and incomplete metadata instead of silently rendering another geometry', () => {
  assert.equal(readMachineryState({ ...state('pile'), assetVersion: 'unavailable-v0' }), undefined);
  assert.equal(readMachineryState({ ...state('pile'), parameters: {} }), undefined);
  assert.equal(readMachineryState({ ...state('pile'), placement: { ...state('pile').placement, heading: 361 } }), undefined);
});

test('actual entity orientation plus Cesium glTF correction preserves up and clockwise reference heading', async () => {
  // ModelUtility is Cesium's actual renderer helper, exposed at runtime but omitted from public TS declarations.
  const utility = (Cesium as unknown as { ModelUtility: { getAxisCorrectionMatrix(up: number, forward: number, result: Cesium.Matrix4): Cesium.Matrix4 } }).ModelUtility;
  const correction = utility.getAxisCorrectionMatrix(Axis.Y, Axis.Z, new Matrix4());
  const model = await asset('pile'), fixture = viewerFixture(), scene = new MachineryScene(fixture.viewer);
  scene.setContext({ projectId: 'safety:project', records: [], canView: true, active: true });
  try {
    for (const heading of [0, 90, 180, 270]) {
      const metadata = state('pile'); metadata.placement.heading = heading;
      await scene.preview('equipment-1', metadata, model);
      const entity = fixture.source().entities.getById('machinery:equipment-1')!;
      const position = entity.position!.getValue(JulianDate.now())!;
      const orientation = entity.orientation!.getValue(JulianDate.now())!;
      const world = Matrix4.fromRotationTranslation(Matrix3.fromQuaternion(orientation), position);
      const inverseEnu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(position), new Matrix4());
      const local = Matrix4.multiply(inverseEnu, Matrix4.multiply(world, correction, new Matrix4()), new Matrix4());
      const up = Matrix4.multiplyByPointAsVector(local, Cartesian3.UNIT_Y, new Cartesian3());
      near(up.x, 0); near(up.y, 0); near(up.z, 1);
      const forward = Matrix4.multiplyByPointAsVector(local, Cartesian3.UNIT_X, new Cartesian3());
      near(forward.x, Math.sin(heading * Math.PI / 180)); near(forward.y, Math.cos(heading * Math.PI / 180)); near(forward.z, 0);
      near(Cartographic.fromCartesian(position).height, metadata.placement.height, 1e-6);
      assert.equal(entity.model!.scale!.getValue(JulianDate.now()), 1, 'geometry already contains the requested scale');
    }
  } finally { scene.destroy(); }
});

test('latest preview placement wins a pending load; replace/remove release every object URL', async () => {
  const model = await asset('pile'), fixture = viewerFixture(true), scene = new MachineryScene(fixture.viewer);
  const created: string[] = [], revoked: string[] = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
  scene.setContext({ projectId: 'safety:project', records: [], canView: true, active: true });
  try {
    const first = state('pile'), latest = state('pile'); latest.placement.longitude = 122; latest.placement.height = 345;
    const a = scene.preview('equipment-1', first, model), b = scene.preview('equipment-1', latest, model);
    fixture.release(); await Promise.all([a, b]);
    assert.equal(fixture.source().entities.values.length, 1);
    const entity = fixture.source().entities.values[0];
    const position = Cartographic.fromCartesian(entity.position!.getValue(JulianDate.now())!);
    near(position.longitude * 180 / Math.PI, 122); near(position.height, 345, 1e-6);
    const changed = state('pile', resolveMachineryParameters(model, latest.parameters, { total_height_m: 10 }, { proportional: false }));
    await scene.preview('equipment-1', changed, model);
    assert.equal(fixture.source().entities.values[0], entity, 'same equipment keeps one entity');
    assert.equal(created.length, 2); assert.deepEqual(revoked, [created[0]]);
    scene.clearPreview(); assert.equal(fixture.source().entities.values.length, 0);
    assert.deepEqual(revoked, created);
  } finally { scene.destroy(); URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});

test('project switch, permission loss and disposal invalidate staged models before they reach the scene', async () => {
  const model = await asset('pile');
  for (const action of ['project', 'permission', 'dispose'] as const) {
    const fixture = viewerFixture(true), scene = new MachineryScene(fixture.viewer);
    scene.setContext({ projectId: 'safety:project', records: [], canView: true, active: true });
    const loading = scene.preview('equipment-1', state('pile'), model);
    if (action === 'dispose') scene.destroy();
    else scene.setContext({ projectId: action === 'project' ? 'other-project' : 'safety:project', records: [], canView: action !== 'permission', active: true });
    fixture.release(); await loading;
    assert.equal(fixture.source().entities.values.length, 0, action);
    scene.destroy();
  }
});
