import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallExportProject, parseFallExportProject, validateFallExportReplayScope, safeFallSceneReferences, type FallExportCamera } from './railSafetyFallExportProject.ts';
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from './machineryTypes.ts';
import { MACHINERY_PARAMETER_DEFAULTS } from './machineryValidation.ts';
import { DEFAULT_RAIL_SAFETY_DISPLAY } from './railSafetyDisplay.ts';

const state = (): MachineryMetadata => ({ schemaVersion: 1, assetId: 'crane', assetVersion: MACHINERY_ASSET_VERSION, proportional: false,
  parameters: { ...MACHINERY_PARAMETER_DEFAULTS.crane }, placement: { longitude: 121, latitude: 31, height: 100, heading: 15 }, visible: true });
const camera: FallExportCamera = { positionWorld: [6378237, 0, 0], directionWorld: [-1, 0, 0], upWorld: [0, 0, 1], longitude: 0, latitude: 0, height: 100,
  headingDegrees: 0, pitchDegrees: -90, rollDegrees: 0, fovRadians: 1 };
const resources = [{ id: 'tiles-1', name: '倾斜摄影', kind: '3D Tiles', visible: true }];
const project = () => createFallExportProject({ projectId: 'project', resourceId: 'crane-1', resourceName: '汽车吊', state: state(), direction: 270,
  camera, display: DEFAULT_RAIL_SAFETY_DISPLAY, resources, support: { length: 6, width: 4, centerX: 0, centerZ: 0 } });

test('animation project round trips frozen geometry, direction, camera and scene references without retaining mutable inputs', () => {
  const source = state(), expected = structuredClone(source);
  const exported = createFallExportProject({ projectId: 'project', resourceId: 'crane-1', resourceName: '吊机', state: source, direction: -90,
    camera, display: DEFAULT_RAIL_SAFETY_DISPLAY, resources });
  source.placement.heading = 200; source.parameters.boom_length_m = 100;
  assert.deepEqual(exported.modelState, expected); assert.equal(exported.animation.directionDegrees, 270);
  assert.deepEqual(parseFallExportProject(JSON.parse(JSON.stringify(exported))), exported);
  assert.equal(exported.scene.mode, 'references-only'); assert.match(exported.scene.note, /不包含完整/);
  assert.equal(exported.animation.speedDegreesPerSecond, 12); assert.equal(exported.animation.endAngleDegrees, 90);
});

test('exports whitelist references and reject URL-bearing or executable extra properties on import', () => {
  const refs = safeFallSceneReferences([{ ...resources[0], url: 'https://example.invalid/model?token=secret', provider: { credential: 'secret' } } as any]);
  assert.deepEqual(refs, resources); assert.ok(!JSON.stringify(refs).includes('secret'));
  const value = project();
  assert.throws(() => parseFallExportProject({ ...value, url: 'https://example.invalid/' }), /不支持的字段/);
  assert.throws(() => parseFallExportProject({ ...value, scene: { ...value.scene, resources: [{ ...resources[0], url: 'https://example.invalid/' }] } }), /不支持的字段/);
});

test('replay requires the same authorised project, machine and loaded visible scene resources', () => {
  const value = project();
  assert.doesNotThrow(() => validateFallExportReplayScope(value, 'project', ['crane-1'], resources));
  assert.throws(() => validateFallExportReplayScope(value, 'other', ['crane-1'], resources), /其他项目/);
  assert.throws(() => validateFallExportReplayScope(value, 'project', [], resources), /机械不存在/);
  assert.throws(() => validateFallExportReplayScope(value, 'project', ['crane-1'], []), /不包含完整场景资源/);
  assert.throws(() => validateFallExportReplayScope(value, 'project', ['crane-1'], [{ ...resources[0], visible: false }]), /先显示/);
});

test('import rejects malformed camera vectors, modified animation version, invalid support and invalid model data', () => {
  const value = project();
  for (const patch of [{ positionWorld: [0, 0, 0] }, { directionWorld: [0, 0, 1] }, { directionWorld: [NaN, 0, 0] }, { fovRadians: 0 }]) {
    assert.throws(() => parseFallExportProject({ ...value, camera: { ...value.camera, ...patch } }));
  }
  assert.throws(() => parseFallExportProject({ ...value, animation: { ...value.animation, speedDegreesPerSecond: 60 } }), /不兼容/);
  assert.throws(() => parseFallExportProject({ ...value, support: { ...value.support, width: 0 } }));
  assert.throws(() => parseFallExportProject({ ...value, modelState: { ...value.modelState, placement: { ...value.modelState.placement, latitude: 999 } } }));
  assert.throws(() => parseFallExportProject({ ...value, schemaVersion: 2 }), /不支持/);
});
