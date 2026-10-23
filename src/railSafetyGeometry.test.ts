import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadMachineryAsset } from './machinery/assets';
import { computeMachineryGeometry, defaultMachineryParameters, resolveMachineryParameters } from './machinery/engine';
import type { LoadedMachineryAsset, MachineryModelId } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import { computeMachineryFallEnvelope, intersectPolygons, pointInPolygon, polygonArea, projectWgs84ToLocal, unprojectLocalToWgs84, type Point2 } from './railSafetyGeometry';

const origin = { longitude: 121.47, latitude: 31.23, height: 12 };
const near = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
const rectangle = (x: number, y: number, width: number, height: number): Point2[] => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
function box(): LoadedMachineryAsset {
  const positions = [];
  for (const x of [-1, 1]) for (const y of [0, 3]) for (const z of [-0.5, 0.5]) positions.push(x, y, z);
  return {
    id: 'excavator', name: '分析立方体', type: 'excavator', version: '2026-10-13-v1',
    config: { type: 'excavator', parameters: [{ key: 'overall_scale', original: 1, label: '倍率', unit: '×' }, { key: 'body_height_m', original: 3, label: '机身高度', unit: 'm' }, { key: 'overall_height_m', original: 3, label: '总高', unit: 'm' }], local_parameters: [], reference_dimensions: { anchor_m: [0, 0, 0], ground_y_m: 0, body_height_m: 3, overall_height_m: 3, body_top_y_m: 3 } },
    sourcePositions: new Float64Array(positions), indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 0]), partIds: new Uint8Array(8), palette: new Float32Array([1, 1, 0]), faceColorIndices: new Uint8Array(3),
  };
}
function metadata(asset: LoadedMachineryAsset): MachineryMetadata {
  return { schemaVersion: 1, assetId: asset.id, assetVersion: '2026-10-13-v1', proportional: true, parameters: defaultMachineryParameters(asset), placement: { ...origin, heading: 0 }, visible: true };
}
const fileFetch: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new Response(new Uint8Array(await readFile(fileURLToPath(url))));
};
const modelCache = new Map<MachineryModelId, Promise<LoadedMachineryAsset>>();
function model(id: MachineryModelId) {
  if (!modelCache.has(id)) modelCache.set(id, loadMachineryAsset(id, { baseUrl: new URL('../public/machinery/', import.meta.url).href, fetcher: fileFetch }));
  return modelCache.get(id)!;
}

test('WGS84 tangent-plane round trip uses metres and preserves orientation near the dateline', () => {
  for (const base of [origin, { longitude: 179.99999, latitude: 45, height: 23 }]) for (const p of [{ x: 100, y: 0 }, { x: -250, y: 500 }, { x: 0, y: -75 }]) {
    const geographic = unprojectLocalToWgs84(p, base), back = projectWgs84ToLocal(geographic, base);
    near(back.x, p.x); near(back.y, p.y);
  }
  assert.ok(unprojectLocalToWgs84({ x: 10, y: 0 }, origin).longitude > origin.longitude);
  assert.ok(unprojectLocalToWgs84({ x: 0, y: 10 }, origin).latitude > origin.latitude);
  assert.throws(() => projectWgs84ToLocal({ longitude: -58.53, latitude: -31.23 }, origin), /20 km/);
  assert.throws(() => projectWgs84ToLocal({ longitude: NaN, latitude: 3 }, origin), /坐标无效/);
});

test('intersection distinguishes overlap, containment, edge contact, point contact and gaps', () => {
  const a = rectangle(0, 0, 4, 4);
  let r = intersectPolygons(a, rectangle(2, 2, 4, 4));
  assert.equal(r.relation, 'overlap'); near(r.intersectionPolygons.reduce((sum, p) => sum + Math.abs(polygonArea(p)), 0), 4);
  r = intersectPolygons(a, rectangle(1, 1, 1, 1)); assert.equal(r.containment, 'b-in-a'); assert.equal(r.distanceMeters, 0);
  assert.equal(intersectPolygons(a, [...a].reverse()).containment, 'equal');
  for (const b of [rectangle(4, 1, 2, 2), rectangle(4, 4, 2, 2)]) {
    r = intersectPolygons(a, b); assert.equal(r.relation, 'touching'); assert.equal(r.distanceMeters, 0); assert.deepEqual(r.intersectionPolygons, []);
  }
  r = intersectPolygons(a, rectangle(7, 0, 1, 1)); assert.equal(r.relation, 'disjoint'); near(r.distanceMeters, 3);
  assert.throws(() => intersectPolygons(a, [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 }]), /区域/);
});

test('concave user polygons preserve notches and output only intersected pieces', () => {
  const l = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 6 }, { x: 0, y: 6 }];
  assert.equal(intersectPolygons(l, rectangle(3, 3, 1, 1)).relation, 'disjoint');
  const result = intersectPolygons(l, rectangle(1, 1, 3, 3));
  assert.equal(result.relation, 'overlap');
  near(result.intersectionPolygons.reduce((sum, p) => sum + Math.abs(polygonArea(p)), 0), 5);
  for (const p of result.intersectionPolygons.flat()) assert.notEqual(pointInPolygon(p, l), 'outside');
  // All vertices of this triangle are inside the L, but part of its edge crosses the notch.
  const triangle = [{ x: 1, y: 5 }, { x: 5, y: 1 }, { x: 1, y: 1 }];
  assert.equal(intersectPolygons(triangle, l).containment, 'none');
});

test('analytical 0–90° box sweep includes support offset without independent beyond-90° landings', () => {
  const asset = box(), state = metadata(asset), before = asset.sourcePositions.slice();
  const result = computeMachineryFallEnvelope(asset, state);
  assert.equal(result.status, 'estimated', result.warnings.join('; '));
  assert.equal(result.supportSource, 'model-base-estimate');
  // At source +X, all top corners reach x=1+3 at 90°. The former independent
  // landing of the opposite corner (1+sqrt(13)) needs >90° and is excluded.
  near(result.landingPoints[0].y, 4);
  near(Math.abs(result.landingPoints[0].x), 0.5);
  assert.ok(result.maxDistanceMeters > 4); assert.ok(result.maxDistanceMeters < 4.4); assert.ok(result.envelopeRadiusMeters > result.maxDistanceMeters);
  for (const p of result.landingPoints) assert.notEqual(pointInPolygon(p, result.polygon), 'outside');
  assert.equal(result.method, 'support-line-rigid-0-90-sweep-convex-envelope/v2');
  assert.ok(result.stripMarginMeters > 0);
  assert.deepEqual(asset.sourcePositions, before);
  assert.deepEqual(computeMachineryFallEnvelope(asset, state), result);
});

test('heading rotates around station and common scale scales full landing envelope exactly', () => {
  const asset = box(), state = metadata(asset), a = computeMachineryFallEnvelope(asset, state);
  const b = computeMachineryFallEnvelope(asset, { ...state, placement: { ...state.placement, heading: 90 } });
  near(a.maxDistanceMeters, b.maxDistanceMeters);
  for (let i = 0; i < a.polygon.length; i++) { near(b.polygon[i].x, a.polygon[i].y); near(b.polygon[i].y, -a.polygon[i].x); }
  const scaled = { ...state, parameters: resolveMachineryParameters(asset, state.parameters, { overall_scale: 2 }) };
  const c = computeMachineryFallEnvelope(asset, scaled); near(c.maxDistanceMeters, 2 * a.maxDistanceMeters); near(c.envelopeRadiusMeters, 2 * a.envelopeRadiusMeters); near(c.samplingMarginMeters, 2 * a.samplingMarginMeters);
});

test('outboard components affect reach and unavailable geometry never produces a valid polygon', () => {
  const asset = box(), state = metadata(asset), a = computeMachineryFallEnvelope(asset, state);
  const bigger: LoadedMachineryAsset = { ...asset, sourcePositions: new Float64Array([...asset.sourcePositions, 8, 2, 0]), partIds: new Uint8Array(9), indices: new Uint32Array([...asset.indices, 8, 0, 1]) };
  assert.ok(computeMachineryFallEnvelope(bigger, state).maxDistanceMeters > a.maxDistanceMeters + 2);
  const missingSupport = { ...asset, sourcePositions: new Float64Array([0, 0, 0, 0, 3, 0, 0, 1, 0]), partIds: new Uint8Array(3), indices: new Uint32Array([0, 1, 2]) };
  const failed = computeMachineryFallEnvelope(missingSupport, state); assert.equal(failed.status, 'unavailable'); assert.deepEqual(failed.polygon, []);
  assert.equal(computeMachineryFallEnvelope(missingSupport, state, { centerX: 0, centerZ: 0, width: 1, length: 1 }).status, 'estimated');
  assert.equal(computeMachineryFallEnvelope(asset, state, { centerX: 0, centerZ: 0, width: -1, length: 2 }).status, 'unavailable');
});

test('unsampled directions and all intermediate rigid inclinations contain triangle interiors', () => {
  const asset = box(), state = metadata(asset), result = computeMachineryFallEnvelope(asset, state);
  const sourceSupport = rectangle(-1, -0.5, 2, 1);
  for (let k = 0; k < 137; k++) {
    const angle = (k + 0.237) * 2 * Math.PI / 137, nx = Math.cos(angle), nz = Math.sin(angle);
    const support = Math.max(...sourceSupport.map(p => p.x * nx + p.y * nz));
    // Several interior points as well as vertices: interpolation of mesh triangles is covered.
    for (const x of [-1, -0.4, 0.3, 1]) for (const z of [-0.5, 0.13, 0.5]) for (const h of [0, 1.27, 3]) {
      for (const inclination of [0, 0.137, 0.419, 0.713, 1.037, 1.397, Math.PI / 2]) {
        const d = x * nx + z * nz - support, move = d * (Math.cos(inclination) - 1) + h * Math.sin(inclination);
        assert.notEqual(pointInPolygon({ x: z + move * nz, y: x + move * nx }, result.polygon), 'outside');
      }
    }
  }
});

test('outboard vertices include their intermediate-angle maximum, not only upright and horizontal poses', () => {
  const base = box();
  const asset: LoadedMachineryAsset = { ...base, sourcePositions: new Float64Array([...base.sourcePositions, 8, 2, 0]), partIds: new Uint8Array(9), indices: new Uint32Array([...base.indices, 8, 0, 1]) };
  const result = computeMachineryFallEnvelope(asset, metadata(asset));
  // d=8-1=7 and h=2. The maximum is at atan2(2,7), not at 0° or 90°.
  near(result.landingPoints[0].y, 1 + Math.sqrt(53));
  assert.ok(result.landingPoints[0].y > 8);
});

test('default polygon follows unequal support dimensions rather than a station-radius circle', () => {
  const result = computeMachineryFallEnvelope(box(), metadata(box()));
  const radii = result.polygon.map(p => Math.hypot(p.x, p.y));
  assert.ok(Math.max(...radii) / Math.min(...radii) > 1.01);
  const narrow = computeMachineryFallEnvelope(box(), metadata(box()), { centerX: 0, centerZ: 0, length: 2, width: 0.2 });
  assert.notDeepEqual(narrow.polygon, result.polygon);
  const farthest = result.landingPoints.reduce((a, b) => Math.hypot(a.x, a.y) > Math.hypot(b.x, b.y) ? a : b);
  near(Math.hypot(farthest.x, farthest.y), result.maxDistanceMeters);
  assert.ok(result.envelopeRadiusMeters > result.maxDistanceMeters);
});

for (const id of ['crane', 'pile', 'excavator'] as const) test(`${id}: real immutable asset computes finite footprint and linked scale`, async () => {
  const asset = await model(id), state = metadata(asset), copy = asset.sourcePositions.slice();
  const a = computeMachineryFallEnvelope(asset, state);
  assert.equal(a.status, 'estimated', a.warnings.join('; ')); assert.ok(a.polygon.length >= 3);
  assert.equal(a.supportSource, id === 'crane' ? 'model-outriggers' : 'model-base-estimate');
  assert.ok(a.envelopeRadiusMeters >= a.maxDistanceMeters);
  const mesh = computeMachineryGeometry(asset, state.parameters), used = [...new Set(mesh.indices)];
  // Independently transform representative real-mesh vertices at non-sampled
  // bearings and non-integer inclinations, including both motion endpoints.
  for (const bearing of [0.371, 23.137, 91.431, 167.237, 223.817, 297.119, 359.641]) {
    const theta = bearing * Math.PI / 180, nx = Math.sin(theta), ny = Math.cos(theta);
    const offset = Math.max(...a.supportPolygon.map(p => nx * p.x + ny * p.y));
    for (let k = 0; k < Math.min(32, used.length); k++) {
      const index = used[Math.floor(k * used.length / Math.min(32, used.length))];
      const x = mesh.positions[index * 3 + 2], y = mesh.positions[index * 3], h = mesh.positions[index * 3 + 1];
      for (const inclination of [0, 13.37, 37.19, 61.41, 89.713, 90]) {
        const alpha = inclination * Math.PI / 180, d = nx * x + ny * y - offset;
        const move = d * (Math.cos(alpha) - 1) + h * Math.sin(alpha);
        assert.notEqual(pointInPolygon({ x: x + nx * move, y: y + ny * move }, a.polygon), 'outside', `${id}: ${bearing}° / ${inclination}°`);
      }
    }
  }
  const b = computeMachineryFallEnvelope(asset, { ...state, parameters: resolveMachineryParameters(asset, state.parameters, { overall_scale: 1.5 }) });
  assert.equal(b.status, 'estimated', b.warnings.join('; ')); near(b.maxDistanceMeters, 1.5 * a.maxDistanceMeters, 1e-5);
  assert.deepEqual(asset.sourcePositions, copy);
});

test('real crane boom pose and outrigger spacing enter the computed geometry', async () => {
  const asset = await model('crane'), state = metadata(asset), original = computeMachineryFallEnvelope(asset, state);
  const parameters = resolveMachineryParameters(asset, state.parameters, { outrigger_lateral_m: state.parameters.outrigger_lateral_m * 1.4, boom_length_m: state.parameters.boom_length_m * 1.3, boom_rotation_deg: 47, boom_elevation_deg: 80 }, { proportional: false });
  const changed = computeMachineryFallEnvelope(asset, { ...state, parameters });
  assert.equal(changed.status, 'estimated', changed.warnings.join('; '));
  assert.notDeepEqual(changed.supportPolygon, original.supportPolygon);
  assert.notDeepEqual(changed.landingPoints, original.landingPoints);
  assert.ok(changed.maxDistanceMeters > original.maxDistanceMeters);
});

test('a real lowered crane with its hanging block below the assumed ground cannot show a clear result', async () => {
  const asset = await model('crane'), state = metadata(asset);
  const parameters = resolveMachineryParameters(asset, state.parameters, { boom_elevation_deg: 0 }, { proportional: false });
  const result = computeMachineryFallEnvelope(asset, { ...state, parameters });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.polygon, []);
  assert.ok(result.warnings.some(message => message.includes('低于假定地面')));
});
