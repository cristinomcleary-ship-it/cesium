import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Cesium from 'cesium';
import { MACHINERY_ASSET_IDS, MACHINERY_ASSET_VERSION, type MachineryAssetId, type MachineryMetadata } from './machineryTypes.ts';
import { MACHINERY_PARAMETER_DEFAULTS, validateMachineryMetadata } from './machineryValidation.ts';
import { MACHINERY_CATALOG, loadMachineryAsset, defaultMachineryParameters, resolveMachineryParameters, computeMachineryGeometry, type LoadedMachineryAsset } from './machinery/index.ts';
import { MachineryScene, readMachineryState } from './machineryScene.ts';
import { machineryParameterForEditor, machineryParameterFromEditor } from './machineryEditorParameters';

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

test('display overrides reveal saved-hidden machinery and survive preview, restore, sync and read-only context', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = fileFetcher;
  const fixture = viewerFixture(), scene = new MachineryScene(fixture.viewer), model = await asset('pile');
  const saved = { ...state('pile'), visible: false }, original = structuredClone(saved);
  const record = { id: 'display-guarded', projectId: 'project:A', name: 'Pile', machinery: saved };
  try {
    scene.setContext({ projectId: record.projectId, records: [record], canView: true, active: true });
    assert.equal(scene.getDisplayVisibility(record.id), false);
    assert.equal(fixture.source().entities.values.length, 0);
    scene.setDisplayVisibility({ [record.id]: true });
    assert.equal(await scene.flyTo(record.id), true, 'explicit show starts loading even when persistent visible=false');
    const entity = fixture.source().entities.getById(`machinery:${record.id}`)!;
    assert.equal(entity.show, true);
    const draft = structuredClone(saved); draft.placement.heading = 90;
    await scene.preview(record.id, draft, model);
    assert.equal(entity.show, true, 'display override also applies to an editing preview');
    scene.clearPreview(); assert.equal(entity.show, true, 'restore cannot discard the presentation override');
    scene.sync([record]); assert.equal(entity.show, true);
    scene.setDisplayVisibility({ [record.id]: false }); assert.equal(entity.show, false);
    await scene.preview(record.id, { ...draft, visible: true }, model);
    assert.equal(entity.show, false, 'editing visible=true cannot bypass an explicit display hide');
    scene.clearPreview();
    scene.setDisplayVisibility({}); assert.equal(entity.show, false, 'reset restores the persisted hidden default');
    scene.setDisplayVisibility({ [record.id]: true });
    scene.setContext({ projectId: record.projectId, records: [record], canView: false, active: true });
    assert.equal(fixture.source().show, false, 'display overrides cannot bypass viewing permission');
    scene.setContext({ projectId: record.projectId, records: [record], canView: true, active: true });
    assert.equal(scene.getDisplayVisibility(record.id), true);
    scene.setContext({ projectId: 'project:B', records: [{ ...record, projectId: 'project:B' }], canView: true, active: true });
    assert.equal(scene.getDisplayVisibility(record.id), false, 'project changes clear preferences for reused resource ids');
    assert.deepEqual(saved, original, 'display choices never rewrite persisted machinery metadata');
  } finally { scene.destroy(); globalThis.fetch = originalFetch; }
});

test('hiding machinery during staged loading cannot resurrect it after the load resolves', async () => {
  const model = await asset('pile'), fixture = viewerFixture(true), scene = new MachineryScene(fixture.viewer);
  scene.setContext({ projectId: 'project:A', records: [], canView: true, active: true });
  try {
    const pending = scene.preview('staged-display', state('pile'), model);
    scene.setDisplayVisibility({ 'staged-display': false });
    fixture.release(); await pending;
    assert.equal(fixture.source().entities.values.length, 0);
    assert.equal(scene.getDisplayVisibility('staged-display'), false);
    scene.setDisplayVisibility({ 'staged-display': true });
    assert.equal(await scene.flyTo('staged-display'), true);
    assert.equal(fixture.source().entities.getById('machinery:staged-display')!.show, true);
  } finally { scene.destroy(); }
});

test('all three machines rotate actual entity orientation clockwise without moving the station or regenerating local geometry', async () => {
  // ModelUtility is Cesium's actual renderer helper, exposed at runtime but omitted from public TS declarations.
  const utility = (Cesium as unknown as { ModelUtility: { getAxisCorrectionMatrix(up: number, forward: number, result: Cesium.Matrix4): Cesium.Matrix4 } }).ModelUtility;
  const correction = utility.getAxisCorrectionMatrix(Axis.Y, Axis.Z, new Matrix4());
  for (const id of MACHINERY_ASSET_IDS) {
    const model = await asset(id), fixture = viewerFixture(), scene = new MachineryScene(fixture.viewer);
    const parameters = resolveMachineryParameters(model, defaultMachineryParameters(model),
      id === 'crane' ? { overall_scale: 2, boom_rotation_deg: 75, boom_elevation_deg: 30 } : { overall_scale: 2 });
    const metadata = state(id, parameters), original = structuredClone(metadata);
    scene.setContext({ projectId: 'safety:project', records: [], canView: true, active: true });
    try {
      await scene.preview('equipment-1', metadata, model);
      const entity = fixture.source().entities.getById('machinery:equipment-1')!, initialPosition = entity.position!.getValue(JulianDate.now())!;
      const glb = entity.model!.uri!.getValue(JulianDate.now());
      const runtimeBound = entity.model!.scale!.getValue(JulianDate.now());
      for (const heading of [0, 90, 180, 270, 359.999]) {
        const rotated = structuredClone(metadata); rotated.placement.heading = heading;
        await scene.preview('equipment-1', rotated, model);
        assert.equal(fixture.source().entities.values.length, 1, 'rotation retains the single equipment entity in the host viewer');
        assert.equal(fixture.source().entities.getById(entity.id), entity);
        assert.equal(entity.model!.uri!.getValue(JulianDate.now()), glb, 'heading changes reuse the same immutable GLB, including crane slew/elevation and dimensions');
        const position = entity.position!.getValue(JulianDate.now())!;
        assert.deepEqual(position, initialPosition, 'every source vertex rotates around the unchanged placement anchor');
        const orientation = entity.orientation!.getValue(JulianDate.now())!;
        const world = Matrix4.fromRotationTranslation(Matrix3.fromQuaternion(orientation), position);
        const inverseEnu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(position), new Matrix4());
        const local = Matrix4.multiply(inverseEnu, Matrix4.multiply(world, correction, new Matrix4()), new Matrix4());
        const up = Matrix4.multiplyByPointAsVector(local, Cartesian3.UNIT_Y, new Cartesian3());
        near(up.x, 0); near(up.y, 0); near(up.z, 1);
        const forward = Matrix4.multiplyByPointAsVector(local, Cartesian3.UNIT_X, new Cartesian3());
        near(forward.x, Math.sin(heading * Math.PI / 180)); near(forward.y, Math.cos(heading * Math.PI / 180)); near(forward.z, 0);
        near(Cartographic.fromCartesian(position).height, metadata.placement.height, 1e-6);
        assert.equal(entity.model!.scale!.getValue(JulianDate.now()), runtimeBound, 'heading preserves the finite shader culling bound');
        assert.equal(scene.getRenderState('equipment-1')!.targetState.parameters.overall_scale, rotated.parameters.overall_scale);
        assert.deepEqual(rotated.parameters, original.parameters, 'heading cannot rewrite internal articulation or dimensions');
      }
      assert.deepEqual(metadata, original, 'preview leaves its source record unchanged');
    } finally { scene.destroy(); }
  }
});

test('whole-machine heading cancels to the saved pose and reloads through the original scene lifecycle for every asset', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fileFetcher;
  try {
    for (const id of MACHINERY_ASSET_IDS) {
      const model = await asset(id), fixture = viewerFixture(), scene = new MachineryScene(fixture.viewer);
      const parameters = resolveMachineryParameters(model, defaultMachineryParameters(model),
        id === 'crane' ? { boom_rotation_deg: 270, boom_elevation_deg: 45, boom_length_m: 4 } : {});
      const saved = state(id, parameters); saved.placement.heading = 35;
      const record = { id: `heading-${id}`, name: id, machinery: saved, projectId: 'safety:project' };
      let persisted!: MachineryMetadata, savedPosition!: Cesium.Cartesian3, savedOrientation!: Cesium.Quaternion;
      try {
        scene.setContext({ projectId: record.projectId, records: [record], canView: true, active: true });
        assert.equal(await scene.flyTo(record.id), true, 'saved records load using the original asset path');
        const entity = fixture.source().entities.getById(`machinery:${record.id}`)!;
        const initialOrientation = entity.orientation!.getValue(JulianDate.now())!;
        savedPosition = entity.position!.getValue(JulianDate.now())!;
        const glb = entity.model!.uri!.getValue(JulianDate.now());
        const draft = structuredClone(saved); draft.placement.heading = 185;
        await scene.preview(record.id, draft, model);
        assert.notDeepEqual(entity.orientation!.getValue(JulianDate.now()), initialOrientation, 'the preview visibly changes orientation');
        scene.clearPreview();
        assert.deepEqual(entity.orientation!.getValue(JulianDate.now()), initialOrientation, 'cancel immediately restores the committed heading');
        assert.equal(record.machinery.placement.heading, 35, 'cancel does not mutate the saved resource');
        assert.equal(entity.model!.uri!.getValue(JulianDate.now()), glb);
        draft.placement.heading = 359.999;
        await scene.preview(record.id, draft, model);
        persisted = validateMachineryMetadata(JSON.parse(JSON.stringify(draft)));
        scene.sync([{ ...record, machinery: persisted }]);
        scene.clearPreview();
        savedOrientation = entity.orientation!.getValue(JulianDate.now())!;
        assert.deepEqual(entity.position!.getValue(JulianDate.now()), savedPosition);
        assert.equal(entity.model!.uri!.getValue(JulianDate.now()), glb);
        assert.deepEqual(persisted.parameters, saved.parameters);
      } finally { scene.destroy(); }
      const reloadedFixture = viewerFixture(), reloadedScene = new MachineryScene(reloadedFixture.viewer);
      try {
        reloadedScene.setContext({ projectId: record.projectId, records: [{ ...record, machinery: persisted }], canView: true, active: true });
        assert.equal(await reloadedScene.flyTo(record.id), true);
        const entity = reloadedFixture.source().entities.getById(`machinery:${record.id}`)!;
        assert.deepEqual(entity.orientation!.getValue(JulianDate.now()), savedOrientation, 'a new scene restores the persisted quaternion without a parallel model store');
        assert.deepEqual(entity.position!.getValue(JulianDate.now()), savedPosition);
        assert.equal(reloadedFixture.source().entities.values.length, 1);
      } finally { reloadedScene.destroy(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('latest preview placement wins a pending load; replace/remove release every object URL', async () => {
  const model = await asset('pile'), fixture = viewerFixture(true), scene = new MachineryScene(fixture.viewer);
  const created: string[] = [], revoked: string[] = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
  scene.setContext({ projectId: 'safety:project', records: [], canView: true, active: true });
  try {
    const first = state('pile'), latest = state('pile'); latest.placement.longitude = 122; latest.placement.height = 345; latest.placement.heading = 90;
    const a = scene.preview('equipment-1', first, model), b = scene.preview('equipment-1', latest, model);
    fixture.release(); await Promise.all([a, b]);
    assert.equal(fixture.source().entities.values.length, 1);
    const entity = fixture.source().entities.values[0];
    const position = Cartographic.fromCartesian(entity.position!.getValue(JulianDate.now())!);
    near(position.longitude * 180 / Math.PI, 122); near(position.height, 345, 1e-6);
    const worldRotation = Matrix3.fromQuaternion(entity.orientation!.getValue(JulianDate.now())!);
    const inverseEnu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(entity.position!.getValue(JulianDate.now())!), new Matrix4());
    const localX = Matrix4.multiplyByPointAsVector(inverseEnu, Matrix3.multiplyByVector(worldRotation, Cartesian3.UNIT_X, new Cartesian3()), new Cartesian3());
    near(localX.x, 0); near(localX.y, -1); near(localX.z, 0);
    const changed = state('pile', resolveMachineryParameters(model, latest.parameters, { total_height_m: 10 }, { proportional: false }));
    await scene.preview('equipment-1', changed, model);
    assert.equal(fixture.source().entities.values[0], entity, 'same equipment keeps one entity');
    assert.equal(created.length, 1, 'parameter changes retain one GLB and update only persistent shader uniforms'); assert.deepEqual(revoked, []);
    scene.clearPreview(); assert.equal(fixture.source().entities.values.length, 0);
    assert.deepEqual(revoked, created);
  } finally { scene.destroy(); URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});

test('live geometry and compass angles interpolate on one bounded loop without replacing the GLB or shader', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = fileFetcher;
  let clock = 0, handle = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const f = viewerFixture(), scene = new MachineryScene(f.viewer, { now: () => clock,
    scheduleFrame: callback => { frames.set(++handle, callback); return handle; }, cancelFrame: id => { frames.delete(id); } });
  const base = state('crane'); base.placement.heading = 359; base.parameters.boom_rotation_deg = 359;
  const advance = (milliseconds: number) => { clock += milliseconds; const active = [...frames.values()]; frames.clear(); active.forEach(callback => callback(clock)); };
  try {
    scene.setContext({ projectId: 'project', records: [{ id: 'crane', projectId: 'project', machinery: base }], canView: true, active: true });
    assert.equal(await scene.flyTo('crane'), true);
    const entity = f.source().entities.getById('machinery:crane')!, graphics = entity.model!, shader = graphics.customShader!.getValue(JulianDate.now());
    const uri = graphics.uri!.getValue(JulianDate.now()), model = await asset('crane');
    const target = structuredClone(base);
    target.parameters = resolveMachineryParameters(model, base.parameters, { boom_length_m: 6, boom_elevation_deg: 30, boom_rotation_deg: 1 }, { proportional: false });
    target.placement.heading = 1; target.placement.longitude = 121.001;
    scene.setLiveStates(new Map([['crane', target]]));
    assert.deepEqual(scene.getRenderState('crane')!.targetState, target, 'latest target is immediately available for assessment');
    assert.equal(scene.getRenderState('crane')!.displayedState.parameters.boom_length_m, base.parameters.boom_length_m);
    assert.equal(frames.size, 1);
    advance(0);
    advance(175);
    const halfway = scene.getRenderState('crane')!;
    near(halfway.displayedState.parameters.boom_length_m, (base.parameters.boom_length_m + 6) / 2);
    near(halfway.displayedState.parameters.boom_elevation_deg, (base.parameters.boom_elevation_deg + 30) / 2);
    near(halfway.displayedState.parameters.boom_rotation_deg, 0); near(halfway.displayedState.placement.heading, 0);
    assert.equal(entity.model, graphics); assert.equal(graphics.customShader!.getValue(JulianDate.now()), shader);
    assert.equal(graphics.uri!.getValue(JulianDate.now()), uri);
    assert.equal(frames.size, 1);
    advance(175); assert.deepEqual(scene.getRenderState('crane')!.displayedState, target); assert.equal(frames.size, 0);
    const before = f.renders(); scene.setLiveStates(new Map([['crane', structuredClone(target)]]));
    assert.equal(f.renders(), before); assert.equal(frames.size, 0, 'equal data never creates an idle render loop');
    const next = structuredClone(target); next.placement.heading = 90;
    scene.setLiveStates(new Map([['crane', next]])); advance(0); advance(100);
    const middle = scene.getRenderState('crane')!.displayedState.placement.heading;
    const latest = structuredClone(next); latest.placement.heading = 180;
    scene.setLiveStates(new Map([['crane', latest]]));
    near(scene.getRenderState('crane')!.displayedState.placement.heading, middle);
    assert.equal(frames.size, 1, 'retargeting reuses one loop and the actual displayed pose');
    scene.setDisplayVisibility({ crane: false }); assert.equal(frames.size, 0); assert.equal(entity.show, false);
    scene.setDisplayVisibility({ crane: true }); assert.equal(entity.show, true);
    assert.deepEqual(scene.getRenderState('crane')!.displayedState, latest, 'showing without another packet cannot leave the old interpolation midpoint');
    const moving = structuredClone(latest); moving.placement.heading = 230;
    scene.setLiveStates(new Map([['crane', moving]])); advance(0); advance(100); assert.equal(frames.size, 1);
    const replacement = state('pile');
    scene.setContext({ projectId: 'project', records: [{ id: 'crane', projectId: 'project', machinery: replacement }], canView: true, active: true });
    assert.equal(frames.size, 0, 'changing asset schema cancels the old pose interpolation before loading');
    assert.equal(await scene.flyTo('crane'), true);
    assert.deepEqual(scene.getRenderState('crane')!.displayedState, replacement);
    assert.equal(scene.getRenderState('crane')!.interpolating, false);
    scene.destroy(); assert.equal(shader.isDestroyed(), true); assert.equal(frames.size, 0);
  } finally { scene.destroy(); globalThis.fetch = originalFetch; }
});

test('live display starts its clock on the first frame and preserves intermediate poses after main-thread stalls', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = fileFetcher;
  let clock = 0, handle = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const fixture = viewerFixture(), scene = new MachineryScene(fixture.viewer, { now: () => clock,
    scheduleFrame: callback => { frames.set(++handle, callback); return handle; }, cancelFrame: id => { frames.delete(id); } });
  const base = state('pile'), target = structuredClone(base);
  target.parameters.total_height_m = 16;
  const advance = (milliseconds: number) => { clock += milliseconds; const active = [...frames.values()]; frames.clear(); active.forEach(callback => callback(clock)); };
  try {
    scene.setContext({ projectId: 'project', records: [{ id: 'pile', projectId: 'project', machinery: base }], canView: true, active: true });
    assert.equal(await scene.flyTo('pile'), true);
    scene.setLiveStates(new Map([['pile', target]]));
    assert.deepEqual(scene.getRenderState('pile')!.targetState, target, 'assessment receives the exact target before any animation frame');
    advance(2000);
    assert.deepEqual(scene.getRenderState('pile')!.displayedState, base, 'synchronous assessment work cannot consume the visual transition before the first frame');
    advance(2000);
    const middle = scene.getRenderState('pile')!.displayedState;
    near(middle.parameters.total_height_m, (base.parameters.total_height_m + target.parameters.total_height_m) / 2);
    assert.equal(scene.getRenderState('pile')!.interpolating, true, 'a delayed frame cannot skip all intermediate poses');
    clock += 2000; // A newer packet arrives after more blocked work, without another displayed frame.
    const latest = structuredClone(target); latest.parameters.total_height_m = 20;
    scene.setLiveStates(new Map([['pile', latest]]));
    assert.deepEqual(scene.getRenderState('pile')!.displayedState, middle, 'retargeting starts from the last displayed frame, not an unrendered wall-clock pose');
    assert.deepEqual(scene.getRenderState('pile')!.targetState, latest);
    assert.equal(frames.size, 1, 'retargeting retains a single scheduled frame');
    advance(2000);
    assert.deepEqual(scene.getRenderState('pile')!.displayedState, middle);
    advance(2000);
    near(scene.getRenderState('pile')!.displayedState.parameters.total_height_m, (middle.parameters.total_height_m + 20) / 2);
    advance(2000);
    assert.deepEqual(scene.getRenderState('pile')!.displayedState, latest);
    assert.equal(frames.size, 0, 'the bounded transition stops scheduling once it reaches the target');
  } finally { scene.destroy(); globalThis.fetch = originalFetch; }
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

test('multiple sensor poses remain transient, deduplicate renders and restore through preview and permission changes', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = fileFetcher;
  const f = viewerFixture(), scene = new MachineryScene(f.viewer);
  const savedA = state('crane'), savedB = state('pile');
  const records = [{ id: 'a', name: '吊机', machinery: savedA, projectId: 'project' },
    { id: 'b', name: '桩机', machinery: savedB, projectId: 'project' }];
  const context = { projectId: 'project', records, canView: true, active: true };
  const longitude = (id: string) => Cartographic.fromCartesian(f.source().entities.getById(`machinery:${id}`)!.position!.getValue(JulianDate.now())!).longitude * 180 / Math.PI;
  try {
    scene.setContext(context); await Promise.all([scene.flyTo('a'), scene.flyTo('b')]);
    const liveA = structuredClone(savedA), liveB = structuredClone(savedB);
    liveA.placement.longitude = 122; liveB.placement.longitude = 123;
    scene.setLiveStates(new Map([['a', liveA], ['b', liveB], ['foreign-resource', liveA]]));
    near(longitude('a'), 122); near(longitude('b'), 123);
    assert.equal(f.source().entities.values.length, 2, 'an unknown resource cannot create a sensor-only model');
    const renders = f.renders();
    scene.setLiveStates(new Map([['b', structuredClone(liveB)], ['a', structuredClone(liveA)]]));
    assert.equal(f.renders(), renders, 'equal states in a different map order do not request rendering');
    liveA.placement.longitude = 124;
    near(longitude('a'), 122, 1e-8);
    const draft = structuredClone(savedA); draft.placement.longitude = 125;
    await scene.preview('a', draft, await asset('crane'));
    scene.setLiveStates(new Map([['a', liveA], ['b', liveB]]));
    near(longitude('a'), 125, 1e-8);
    scene.clearPreview(); near(longitude('a'), 124, 1e-8);
    assert.equal(savedA.placement.longitude, 121, 'sensor poses never mutate saved initialization');
    scene.setContext({ ...context, canView: false });
    scene.setLiveStates(new Map([['a', liveA]]));
    scene.setContext(context); await scene.flyTo('a');
    near(longitude('a'), 121, 1e-8);
    scene.setLiveStates(new Map([['a', liveA], ['b', liveB]]));
    scene.setContext({ ...context, records: [records[1]] });
    assert.equal(f.source().entities.getById('machinery:a'), undefined);
    scene.setContext(context); await scene.flyTo('a'); near(longitude('a'), 121, 1e-8);
  } finally { scene.destroy(); globalThis.fetch = originalFetch; }
});

test('newest sensor placement wins a staged geometry load', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = fileFetcher;
  const f = viewerFixture(true), scene = new MachineryScene(f.viewer), saved = state('pile');
  try {
    scene.setContext({ projectId: 'project', records: [{ id: 'pile', machinery: saved, projectId: 'project' }], canView: true, active: true });
    const first = structuredClone(saved); first.placement.longitude = 122;
    scene.setLiveStates(new Map([['pile', first]]));
    const latest = structuredClone(first); latest.placement.longitude = 123; latest.placement.height = 321;
    scene.setLiveStates(new Map([['pile', latest]]));
    f.release(); assert.equal(await scene.flyTo('pile'), true);
    const position = Cartographic.fromCartesian(f.source().entities.getById('machinery:pile')!.position!.getValue(JulianDate.now())!);
    near(position.longitude * 180 / Math.PI, 123); near(position.height, 321, 1e-6);
    assert.equal(f.source().entities.values.length, 1);
  } finally { scene.destroy(); globalThis.fetch = originalFetch; }
});


test('editor canonical boom input is converted once while legacy stored poses survive service save/reload', async () => {
  const model = await asset('crane');
  const legacy = state('crane'); legacy.parameters.boom_rotation_deg = 270;
  const before = structuredClone(legacy);
  const displayed = machineryParameterForEditor(model, 'boom_rotation_deg', legacy.parameters.boom_rotation_deg);
  const unchanged = validateMachineryMetadata({ ...legacy, parameters: { ...legacy.parameters,
    boom_rotation_deg: machineryParameterFromEditor(model, 'boom_rotation_deg', displayed, legacy.parameters.boom_rotation_deg) } });
  assert.deepEqual(readMachineryState(unchanged), before, 'displaying and saving an old machine never rebases its source yaw');
  const edited = validateMachineryMetadata({ ...legacy, parameters: resolveMachineryParameters(model, legacy.parameters,
    { boom_rotation_deg: machineryParameterFromEditor(model, 'boom_rotation_deg', 0, legacy.parameters.boom_rotation_deg) }, { proportional: false }) });
  const restored = readMachineryState(edited)!;
  near(machineryParameterForEditor(model, 'boom_rotation_deg', restored.parameters.boom_rotation_deg), 0);
  assert.deepEqual(restored.placement, legacy.placement, 'relative boom yaw does not rotate/move the machine chassis');
  assert.deepEqual(legacy, before, 'adapter never rewrites saved input');
});

test('cancelled video preset never moves the camera after a staged machinery load completes', async () => {
  const model = await asset('pile'), fixture = viewerFixture(true), scene = new MachineryScene(fixture.viewer);
  let flights = 0; fixture.viewer.flyTo = async () => { flights++; return true; };
  scene.setContext({ projectId: 'safety:project', records: [], canView: true, active: true });
  const loading = scene.preview('capture-pile', state('pile'), model);
  const abort = new AbortController(), flight = scene.flyTo('capture-pile', abort.signal);
  abort.abort(); fixture.release(); await loading;
  try { assert.equal(await flight, false); assert.equal(flights, 0); }
  finally { scene.destroy(); }
});

test('video preset camera flight cancellation settles and removes its signal listener', async () => {
  const model = await asset('pile'), fixture = viewerFixture(), scene = new MachineryScene(fixture.viewer);
  let flights = 0, cancellations = 0, callbacks: { complete?: () => void; cancel?: () => void } | undefined;
  Object.defineProperty(fixture.viewer, 'camera', { value: {
    flyToBoundingSphere(_sphere: unknown, options: { complete?: () => void; cancel?: () => void }) { flights++; callbacks = options; },
    cancelFlight() { cancellations++; callbacks?.cancel?.(); },
  } });
  scene.setContext({ projectId: 'safety:project', records: [], canView: true, active: true });
  await scene.preview('capture-pile', state('pile'), model);
  const abort = new AbortController(), flight = scene.flyTo('capture-pile', abort.signal);
  await Promise.resolve(); await Promise.resolve();
  try {
    assert.equal(flights, 1); abort.abort(); assert.equal(await flight, false); assert.equal(cancellations, 1);
    callbacks?.complete?.(); assert.equal(cancellations, 1, 'late completion cannot restart a cancelled flight');
  } finally { scene.destroy(); }
});
