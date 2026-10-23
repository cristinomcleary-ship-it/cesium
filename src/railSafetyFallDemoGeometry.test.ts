import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Cartesian3, Entity, JulianDate, Matrix3, Matrix4, Quaternion } from 'cesium';
import { loadMachineryAsset } from './machinery/assets';
import { defaultMachineryParameters, resolveMachineryParameters } from './machinery/engine';
import type { LoadedMachineryAsset, MachineryModelId } from './machinery/types';
import { MachineryScene } from './machineryScene';
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from './machineryTypes';
import { computeMachineryFallEnvelope, convexHull } from './railSafetyGeometry';
import { computeRailSafetyFallDemoPose, prepareRailSafetyFallDemo, type PreparedRailSafetyFallDemo, type RailSafetyFallDemoPose } from './railSafetyFallDemoGeometry';
import { computeRailSafetyFallProjection, resolveRailSafetyFallAxis } from './railSafetyFallProjection';

const origin = { longitude: 121.47, latitude: 31.23, height: 112 };
const near = (a: number, b: number, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
function nearVector(a: Cartesian3, b: Cartesian3, tolerance = 1e-7) {
  near(a.x, b.x, tolerance); near(a.y, b.y, tolerance); near(a.z, b.z, tolerance);
}
function metadata(asset: LoadedMachineryAsset, heading = 0): MachineryMetadata {
  return { schemaVersion: 1, assetId: asset.id, assetVersion: MACHINERY_ASSET_VERSION, proportional: false,
    parameters: defaultMachineryParameters(asset), placement: { ...origin, heading }, visible: true };
}
function box(): LoadedMachineryAsset {
  const positions = [];
  for (const x of [-1, 1]) for (const y of [0, 3]) for (const z of [-0.5, 0.5]) positions.push(x, y, z);
  return {
    id: 'excavator', name: '演示验证立方体', type: 'excavator', version: '2026-10-13-v1',
    config: { type: 'excavator', parameters: [{ key: 'overall_scale', original: 1, label: '倍率', unit: '×' }, { key: 'body_height_m', original: 3, label: '机身高度', unit: 'm' }, { key: 'overall_height_m', original: 3, label: '总高', unit: 'm' }], local_parameters: [], reference_dimensions: { anchor_m: [0, 0, 0], ground_y_m: 0, body_height_m: 3, overall_height_m: 3, body_top_y_m: 3 } },
    sourcePositions: new Float64Array(positions), indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 0]), partIds: new Uint8Array(8), palette: new Float32Array([1, 1, 0]), faceColorIndices: new Uint8Array(3),
  };
}
const fileFetch: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new Response(new Uint8Array(await readFile(new URL(url))));
};
const models = new Map<MachineryModelId, Promise<LoadedMachineryAsset>>();
function model(id: MachineryModelId) {
  if (!models.has(id)) models.set(id, loadMachineryAsset(id, { baseUrl: new URL('../public/machinery/', import.meta.url).href, fetcher: fileFetch }));
  return models.get(id)!;
}
/** Move a world point originally attached to the GLB by the returned Entity pose. */
function moveAttached(prepared: PreparedRailSafetyFallDemo, pose: RailSafetyFallDemoPose, original: Cartesian3): Cartesian3 {
  const inverse = Matrix3.transpose(Matrix3.fromQuaternion(prepared.initialOrientation), new Matrix3());
  const local = Matrix3.multiplyByVector(inverse, Cartesian3.subtract(original, prepared.initialPosition, new Cartesian3()), new Cartesian3());
  return Cartesian3.add(pose.position, Matrix3.multiplyByVector(Matrix3.fromQuaternion(pose.orientation), local, new Cartesian3()), new Cartesian3());
}

test('angle zero exactly preserves MachineryScene.place position/orientation and GLB axis convention', () => {
  const asset = box();
  for (const heading of [0, 37, 90, 193, 359]) {
    const state = metadata(asset, heading), entity = new Entity();
    const placement = MachineryScene.prototype as unknown as {
      place(this: { isDisplayed(recordId: string, state: MachineryMetadata): boolean }, recordId: string, entity: Entity, state: MachineryMetadata): void;
    };
    placement.place.call({ isDisplayed: (_id, current) => current.visible }, 'pose-fixture', entity, state);
    const prepared = prepareRailSafetyFallDemo(asset, state);
    const pose = computeRailSafetyFallDemoPose(prepared, 71, 0), time = JulianDate.now();
    assert.deepEqual(pose.position, entity.position!.getValue(time));
    assert.deepEqual(pose.orientation, entity.orientation!.getValue(time));
    // The generated GLB's Y-up source (x,y,z) receives Cesium's (z,x,y) correction.
    const worldRotation = Matrix3.fromQuaternion(pose.orientation);
    const inverseTangent = Matrix4.inverseTransformation(prepared.tangentToWorld, new Matrix4());
    const sourceX = Matrix4.multiplyByPointAsVector(inverseTangent, Matrix3.multiplyByVector(worldRotation, new Cartesian3(0, 1, 0), new Cartesian3()), new Cartesian3());
    nearVector(sourceX, new Cartesian3(Math.sin(heading * Math.PI / 180), Math.cos(heading * Math.PI / 180), 0));
    const sourceY = Matrix4.multiplyByPointAsVector(inverseTangent, Matrix3.multiplyByVector(worldRotation, new Cartesian3(0, 0, 1), new Cartesian3()), new Cartesian3());
    nearVector(sourceY, Cartesian3.UNIT_Z);
  }
});

test('every continuous-bearing support pivot remains fixed while the upper body rotates outward at 0–90 degrees', () => {
  const asset = box();
  for (const heading of [0, 37, 90]) {
    const prepared = prepareRailSafetyFallDemo(asset, metadata(asset, heading));
    const inverseTangent = Matrix4.inverseTransformation(prepared.tangentToWorld, new Matrix4());
    for (const direction of [0, 31, 90, 180, 270, 359]) for (const angle of [0, 1, 30, 65, 90]) {
      const pose = computeRailSafetyFallDemoPose(prepared, direction, angle);
      for (const pivot of pose.pivot) nearVector(moveAttached(prepared, pose, pivot), pivot);
      const midpoint = Cartesian3.midpoint(...pose.pivot, new Cartesian3());
      const up = Matrix4.multiplyByPointAsVector(prepared.tangentToWorld, new Cartesian3(0, 0, 10), new Cartesian3());
      const highPoint = Cartesian3.add(midpoint, up, new Cartesian3());
      const rotated = moveAttached(prepared, pose, highPoint);
      const delta = Matrix4.multiplyByPointAsVector(inverseTangent, Cartesian3.subtract(rotated, midpoint, new Cartesian3()), new Cartesian3());
      const bearing = pose.actualDirectionDegrees * Math.PI / 180, radians = angle * Math.PI / 180;
      nearVector(delta, new Cartesian3(10 * Math.sin(radians) * Math.sin(bearing), 10 * Math.sin(radians) * Math.cos(bearing), 10 * Math.cos(radians)));
      // A requested corner direction is preserved instead of snapping to a box side.
      const difference = Math.abs(((pose.actualDirectionDegrees - direction + 540) % 360) - 180);
      near(difference, 0);
      near(Quaternion.magnitude(pose.orientation), 1);
    }
  }
});

test('the GLB pose and projected triangle mask share the same ENU rotation at oblique bearings', async () => {
  for (const id of ['crane', 'pile', 'excavator'] as const) {
    const asset = await model(id), state = metadata(asset, 37);
    const prepared = prepareRailSafetyFallDemo(asset, state);
    const inverse = Matrix4.inverseTransformation(prepared.tangentToWorld, new Matrix4());
    for (const [direction, angle] of [[17, 0], [51, 37], [223, 75], [319, 90]]) {
      const pose = computeRailSafetyFallDemoPose(prepared, direction, angle);
      const projection = computeRailSafetyFallProjection(prepared.projection, direction, angle);
      const axis = resolveRailSafetyFallAxis(prepared.projection, direction);
      const radians = angle * Math.PI / 180;
      // Cover distributed indexed vertices from each full real asset, including the
      // boom, counterweight and feet, while the raster suite checks triangle interiors.
      for (let i = 0; i < prepared.projection.usedVertices.length; i += 37) {
        const index = prepared.projection.usedVertices[i], vertices = prepared.projection.vertices;
        const vertex = new Cartesian3(vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]);
        const original = Matrix4.multiplyByPoint(prepared.tangentToWorld, vertex, new Cartesian3());
        const actual = Matrix4.multiplyByPoint(inverse, moveAttached(prepared, pose, original), new Cartesian3());
        const d = axis.normal.x * vertex.x + axis.normal.y * vertex.y - axis.offset;
        const t = axis.tangent.x * vertex.x + axis.tangent.y * vertex.y;
        const n = axis.offset + d * Math.cos(radians) + vertex.z * Math.sin(radians);
        nearVector(actual, new Cartesian3(axis.normal.x * n + axis.tangent.x * t,
          axis.normal.y * n + axis.tangent.y * t, vertex.z * Math.cos(radians) - d * Math.sin(radians)), 1e-7);
        const column = Math.floor((actual.x - projection.bounds.xMin) / projection.cellSizeMeters);
        const row = Math.floor((projection.bounds.yMax - actual.y) / projection.cellSizeMeters);
        assert.ok(column >= 0 && column < projection.width && row >= 0 && row < projection.height);
        assert.equal(projection.mask[row * projection.width + column], 1, `${id} source vertex is inside projected silhouette`);
      }
    }
  }
});

test('actual posed crane supports and base supports agree with the screening convention', async () => {
  for (const id of ['crane', 'pile', 'excavator'] as const) {
    const asset = await model(id), state = metadata(asset, 43);
    if (id === 'crane') state.parameters = resolveMachineryParameters(asset, state.parameters, {
      overall_scale: 1.25, outrigger_lateral_m: state.parameters.outrigger_lateral_m * 1.5,
      boom_length_m: state.parameters.boom_length_m * 1.3, boom_rotation_deg: 52, boom_elevation_deg: 75,
    }, { proportional: false });
    const prepared = prepareRailSafetyFallDemo(asset, state), envelope = computeMachineryFallEnvelope(asset, state);
    assert.equal(envelope.status, 'estimated', envelope.warnings.join('; '));
    assert.equal(prepared.supportSource, envelope.supportSource);
    assert.deepEqual(prepared.supportPolygon, convexHull(envelope.supportPolygon));
    const pose = computeRailSafetyFallDemoPose(prepared, 123, 70);
    for (const pivot of pose.pivot) nearVector(moveAttached(prepared, pose, pivot), pivot);
  }
});

test('custom support uses posed source metres, offset and heading, with no second scaling', () => {
  const asset = box(), state = metadata(asset, 90);
  state.parameters = resolveMachineryParameters(asset, state.parameters, { overall_scale: 2 });
  const support = { length: 6, width: 4, centerX: 2, centerZ: -3 };
  const prepared = prepareRailSafetyFallDemo(asset, state, support);
  const pose = computeRailSafetyFallDemoPose(prepared, 90, 90);
  assert.equal(prepared.supportSource, 'user-defined');
  near(pose.actualDirectionDegrees, 90);
  const inverse = Matrix4.inverseTransformation(prepared.tangentToWorld, new Matrix4());
  const pivots = pose.pivot.map(p => Matrix4.multiplyByPoint(inverse, p, new Cartesian3()));
  for (const p of pivots) { near(p.x, 5); near(p.z, 0); }
  assert.deepEqual(pivots.map(p => Math.round(p.y)).sort((a, b) => a - b), [1, 5]);
});

test('preparation and repeated playback leave original metadata, source arrays and prepared snapshot untouched', async () => {
  const asset = await model('crane'), state = metadata(asset, 137);
  const before = structuredClone(state), positions = asset.sourcePositions.slice(), indices = asset.indices.slice();
  const support = { length: 4, width: 5, centerX: 0.3, centerZ: -0.2 };
  const supportBefore = { ...support }, prepared = prepareRailSafetyFallDemo(asset, state, support);
  const preparedBefore = JSON.stringify(prepared);
  for (let angle = 0; angle <= 90; angle++) computeRailSafetyFallDemoPose(prepared, 231, angle);
  assert.deepEqual(state, before); assert.deepEqual(asset.sourcePositions, positions); assert.deepEqual(asset.indices, indices);
  assert.deepEqual(support, supportBefore); assert.equal(JSON.stringify(prepared), preparedBefore);
  const original = computeRailSafetyFallDemoPose(prepared, 231, 70);
  state.placement.height += 30; state.placement.heading = 0; state.parameters.overall_scale *= 2; support.length = 100;
  assert.deepEqual(computeRailSafetyFallDemoPose(prepared, 231, 70), original, 'prepared preview is a snapshot, not live mutable state');
  original.position.x = 0; original.orientation.w = 0; original.pivot[0].x = 0;
  assert.equal(JSON.stringify(prepared), preparedBefore, 'returned pose owns its mutable Cartesian and quaternion values');
});

test('invalid support and angle inputs cannot produce a misleading demo pose', () => {
  const asset = box(), state = metadata(asset), prepared = prepareRailSafetyFallDemo(asset, state);
  for (const angle of [-1, 91, NaN, Infinity]) assert.throws(() => computeRailSafetyFallDemoPose(prepared, 0, angle), /0–90/);
  assert.throws(() => computeRailSafetyFallDemoPose(prepared, NaN, 10), /有限/);
  assert.throws(() => prepareRailSafetyFallDemo(asset, { ...state, assetId: 'pile' }), /版本不匹配/);
  assert.throws(() => prepareRailSafetyFallDemo(asset, state, { length: 0, width: 3, centerX: 0, centerZ: 0 }), /支承/);
  assert.throws(() => prepareRailSafetyFallDemo(asset, { ...state, placement: { ...state.placement, latitude: 90 } }), /站位/);
  assert.deepEqual(computeRailSafetyFallDemoPose(prepared, -90, 20), computeRailSafetyFallDemoPose(prepared, 270, 20));
});
