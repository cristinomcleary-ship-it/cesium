import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoadCoordinateFrame, type PlanningCadCoordinates } from './temporaryWorksCad.ts';
import type { TemporaryWorksPlan } from './temporaryWorksPanel.ts';
import { translateTemporaryWorksPlan } from './temporaryWorksPosition.ts';

const close = (a: number, b: number, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const local: PlanningCadCoordinates = { mode: 'local', referenceX: 0, referenceY: 0, longitude: 121, latitude: 31,
  rotation: 17, unit: 'm', axisOrder: 'eastNorth' };
function fixture(coordinates: PlanningCadCoordinates = local): TemporaryWorksPlan {
  const first = coordinates.mode === 'gaussKruger' ? { x: 40_510_000, y: 3_450_000 } : { x: 0, y: 0 };
  const points = [first, { x: first.x + 100, y: first.y + 25 }];
  const frame = createRoadCoordinateFrame(coordinates, first), origin = frame.origin;
  const vertices = [{ x: 0, y: -3 }, { x: 100, y: -3 }, { x: 100, y: 3 }, { x: 0, y: 3 }].map((p, i) => ({
    ...frame.localToGeo(p), surfaceHeight: 100 + i, baseHeight: 99.7 + i, formationHeight: 99.2 + i,
    groundHeight: 98 + i, roadOffset: p.y, roadStation: p.x,
  }));
  return {
    id: 'road-1', name: '便道', kind: 'road', visible: true, createdAt: '2026-11-07T00:00:00Z', modelId: 'photo', modelName: '摄影',
    inputs: { cadName: 'road.dxf', modelMatrix: [], modelRootTransform: [],
      feature: { id: 'axis', layer: '便道', sourceType: 'POLYLINE', closed: false, points, stationFactors: [1.0001] },
      coordinates, reference: { ...origin, height: 100 }, referenceInput: { mode: 'geo', first: origin.longitude, second: origin.latitude },
      design: { reference: { x: 0, y: 0 }, referenceHeight: 100, finishedOffset: 0, surfaceToTreatment: .3, treatmentDepth: .5,
        centerline: points.map(frame.cadToLocal) }, width: 6, spacing: 2, sampleCount: 50, refinementLevels: 2, budgetLimited: false,
      road: { surfaceMode: 'designed', startHeight: 100, endHeight: 102, gradesEnabled: true, length: 100, reversed: false,
        grades: [{ start: 0, end: 100, gradePct: 2 }], slopeHeight: 1, slopeWidth: 0, referenceStation: 0,
        hardeningBottomWidth: 6, formationWidth: 6, pavementArea: 600, coveredPavementArea: 600 } },
    mesh: { vertices, triangles: [[0, 1, 2], [0, 2, 3]] },
    surface: { version: 1, clippingEnabled: true, footprints: [{ outer: vertices.map(v => ({ ...v, height: v.surfaceHeight })),
      holes: [[vertices[0], vertices[1], vertices[2]].map(v => ({ longitude: v.longitude, latitude: v.latitude, height: 100 }))] }] },
    metrics: { planArea: 600, coveredArea: 600, excludedArea: 0, cutVolume: 17, fillVolume: 23 },
  };
}

test('vertical adjustment preserves horizontal positions, slope, thickness, chainage and sampled evidence', () => {
  const original = fixture(), snapshot = structuredClone(original);
  const result = translateTemporaryWorksPlan(original, { east: 0, north: 0, up: 1.25 });
  assert.deepEqual(original, snapshot);
  assert.notEqual(result.mesh, original.mesh);
  result.mesh.vertices.forEach((v, i) => {
    const old = original.mesh.vertices[i];
    assert.equal(v.longitude, old.longitude); assert.equal(v.latitude, old.latitude);
    close(v.surfaceHeight, old.surfaceHeight + 1.25); close(v.baseHeight, old.baseHeight + 1.25); close(v.formationHeight, old.formationHeight + 1.25);
    assert.equal(v.groundHeight, old.groundHeight); assert.equal(v.roadStation, old.roadStation); assert.equal(v.roadOffset, old.roadOffset);
  });
  assert.deepEqual(result.mesh.triangles, original.mesh.triangles);
  assert.deepEqual(result.inputs.road!.grades, original.inputs.road!.grades);
  assert.equal(result.inputs.road!.startHeight, 101.25); assert.equal(result.inputs.road!.endHeight, 103.25);
  assert.equal(result.inputs.design.referenceHeight, 101.25);
  assert.equal(result.surface!.footprints[0].outer[0].height, 101.25);
  assert.equal(result.surface!.footprints[0].holes![0][0].height, 101.25);
  assert.equal(result.earthworkDisabled, true); assert.equal(result.positionAdjusted, true); assert.deepEqual(result.metrics, original.metrics);
});

test('local and projected road frames reopen at the translated mesh and preserve CAD chainage', () => {
  for (const coordinates of [local, { mode: 'gaussKruger', centralMeridian: 120, hasZonePrefix: true, zoneNumber: 40,
    unit: 'm', axisOrder: 'eastNorth', modelOffset: { east: 12, north: -4 } } satisfies PlanningCadCoordinates]) {
    const original = fixture(coordinates), result = translateTemporaryWorksPlan(original, { east: 25, north: -12, up: .5 });
    const first = original.inputs.feature.points[0];
    const old = createRoadCoordinateFrame(coordinates, first), next = createRoadCoordinateFrame(result.inputs.coordinates, first);
    assert.deepEqual(result.inputs.feature, original.inputs.feature);
    for (let i = 0; i < original.mesh.vertices.length; i++) {
      const expected = next.localToGeo(old.geoToLocal(original.mesh.vertices[i])), actual = result.mesh.vertices[i];
      close(expected.longitude, actual.longitude, 1e-10); close(expected.latitude, actual.latitude, 1e-10);
    }
    for (const point of original.inputs.feature.points) assert.deepEqual(next.cadToLocal(point), old.cadToLocal(point));
    const metreCheck = createRoadCoordinateFrame({ ...local, longitude: old.origin.longitude, latitude: old.origin.latitude, rotation: 0 }, { x: 0, y: 0 });
    const shift = metreCheck.geoToLocal(result.inputs.reference); close(shift.x, 25, .001); close(shift.y, -12, .001);
  }
});

test('geographic drawings honor both axis orders and update the editable line rather than only the mesh', () => {
  for (const axisOrder of ['eastNorth', 'northEast'] as const) {
    const original = fixture(), points = original.mesh.vertices.slice(0, 2);
    original.inputs.coordinates = { mode: 'geographic', axisOrder };
    original.inputs.feature.points = points.map(p => axisOrder === 'eastNorth' ? { x: p.longitude, y: p.latitude } : { x: p.latitude, y: p.longitude });
    const result = translateTemporaryWorksPlan(original, { east: -3, north: 4, up: 0 });
    result.inputs.feature.points.forEach((p, i) => {
      assert.equal(axisOrder === 'eastNorth' ? p.x : p.y, result.mesh.vertices[i].longitude);
      assert.equal(axisOrder === 'eastNorth' ? p.y : p.x, result.mesh.vertices[i].latitude);
    });
  }
});

test('GLB placement becomes manual and keeps dimensions, orientation, branding and identity', () => {
  const original = fixture(); original.kind = 'steel';
  original.glb = { resourceId: 'steel', placement: { ...original.inputs.reference, headingDeg: 42, scaleMode: 'xyz',
    dimensions: { length: 70, width: 30, height: 12 } }, placementMode: 'cad-auto', clippingEnabled: true, branding: { text: '项目名称', visible: true } };
  const result = translateTemporaryWorksPlan(original, { east: 2, north: 3, up: -.2 });
  assert.equal(result.id, original.id); assert.equal(result.glb!.placementMode, 'manual');
  assert.deepEqual(result.glb!.placement.dimensions, original.glb.placement.dimensions);
  assert.equal(result.glb!.placement.headingDeg, 42); assert.deepEqual(result.glb!.branding, original.glb.branding);
  close(result.glb!.placement.height, 99.8);
  assert.equal(result.glb!.placement.longitude, result.inputs.reference.longitude);
  assert.equal(result.glb!.placement.latitude, result.inputs.reference.latitude);
});

test('hardening moves its boundary and permanent holes while external facility bindings stay fixed', () => {
  const original = fixture(); original.kind = 'hardening';
  const boundary = original.mesh.vertices.map(v => ({ longitude: v.longitude, latitude: v.latitude }));
  original.hardening = { version: 1, priority: 1, name: '硬化', reference: { ...original.inputs.reference }, boundary,
    holes: [boundary.slice(0, 3)], thickness: .3, slopeEnabled: true, gradeEastPct: 1, gradeNorthPct: 2,
    clippingEnabled: true, acceptedHeightDifference: true, acceptedDependencies: { camp: 'old' },
    facilityExclusions: [{ objectId: 'camp', boundary: boundary.slice(0, 3), floorHeight: 100, floorThickness: .2 }],
    facilityBindings: { camp: { placement: { ...original.inputs.reference, headingDeg: 0, scaleMode: 'xyz', dimensions: { length: 10, width: 10, height: 10 } },
      floorHeight: 100, floorThickness: .2, resourceVersion: 'a'.repeat(64) } } };
  const result = translateTemporaryWorksPlan(original, { east: 10, north: 5, up: 1 }), config = result.hardening!;
  assert.notDeepEqual(config.boundary, original.hardening.boundary);
  assert.notDeepEqual(config.holes, original.hardening.holes);
  assert.deepEqual(config.facilityExclusions, original.hardening.facilityExclusions);
  assert.deepEqual(config.facilityBindings, original.hardening.facilityBindings);
  assert.equal(config.reference.height, 101); assert.equal(config.gradeEastPct, 1); assert.equal(config.gradeNorthPct, 2); assert.equal(config.thickness, .3);
  assert.equal(config.acceptedHeightDifference, false); assert.equal(config.acceptedDependencies, undefined);
});

test('legacy pads, standard placements, buildings and draped roads move without inventing new ground measurements', () => {
  for (const kind of ['camp', 'steel', 'road'] as const) {
    const original = fixture(); original.kind = kind;
    original.inputs.road!.surfaceMode = 'draped';
    const footprint = original.mesh.vertices.map(v => ({ longitude: v.longitude, latitude: v.latitude }));
    original.building = { footprint, height: 6 }; original.buildings = [{ footprint, height: 8 }];
    original.inputs.facilityPlacement = { ...original.inputs.reference, scale: 1.2, rotationDeg: 17, roles: ['office'], cars: 3 };
    const result = translateTemporaryWorksPlan(original, { east: 1, north: 0, up: 2 });
    assert.notDeepEqual(result.building!.footprint, footprint); assert.equal(result.building!.height, 6); assert.equal(result.buildings![0].height, 8);
    assert.notEqual(result.inputs.facilityPlacement!.longitude, original.inputs.facilityPlacement.longitude);
    assert.equal(result.inputs.facilityPlacement!.scale, 1.2);
    assert.equal(result.mesh.vertices[0].groundHeight, original.mesh.vertices[0].groundHeight);
    assert.equal(result.earthworkDisabled, true); assert.equal(result.positionAdjusted, true);
  }
});

test('small opposite moves return within a millimetre and invalid inputs leave the source untouched', () => {
  const original = fixture(), snapshot = structuredClone(original);
  const forward = translateTemporaryWorksPlan(original, { east: 2, north: -3, up: .1 });
  const back = translateTemporaryWorksPlan(forward, { east: -2, north: 3, up: -.1 });
  const frame = createRoadCoordinateFrame(local, original.inputs.feature.points[0]);
  for (let i = 0; i < back.mesh.vertices.length; i++) {
    const a = frame.geoToLocal(original.mesh.vertices[i]), b = frame.geoToLocal(back.mesh.vertices[i]);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < .001);
    close(back.mesh.vertices[i].surfaceHeight, original.mesh.vertices[i].surfaceHeight);
  }
  for (const offset of [{ east: NaN, north: 0, up: 0 }, { east: 0, north: Infinity, up: 0 }, { east: 20_000, north: 0, up: 0 }, { east: 0, north: 0, up: 20_000 }])
    assert.throws(() => translateTemporaryWorksPlan(original, offset), /位置调整/);
  const invalid = structuredClone(original); invalid.mesh.vertices[0].surfaceHeight = NaN;
  assert.throws(() => translateTemporaryWorksPlan(invalid, { east: 1, north: 0, up: 1 }), /高程/);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(translateTemporaryWorksPlan(original, { east: 0, north: 0, up: 0 }), original);
});
