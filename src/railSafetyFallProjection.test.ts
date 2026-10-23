import assert from 'node:assert/strict';
import test from 'node:test';
import { computeRailSafetyFallProjection, resolveRailSafetyFallAxis, type PreparedRailSafetyFallProjection } from './railSafetyFallProjection';

const near = (a: number, b: number, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
function box(): PreparedRailSafetyFallProjection {
  const vertices = new Float64Array([
    -1, -2, 0, 1, -2, 0, 1, 2, 0, -1, 2, 0,
    -1, -2, 3, 1, -2, 3, 1, 2, 3, -1, 2, 3,
  ]);
  return { vertices, indices: new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]), usedVertices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
  supportPolygon: [{ x: -1, y: -2 }, { x: 1, y: -2 }, { x: 1, y: 2 }, { x: -1, y: 2 }],
  supportSource: 'model-base-estimate', groundToleranceMeters: 1e-5 };
}

test('continuous support bearings remain tangent to the hull without snapping or crossing its interior', () => {
  const prepared = box();
  for (let bearing = 0; bearing < 360; bearing++) {
    const axis = resolveRailSafetyFallAxis(prepared, bearing);
    near(axis.direction, bearing);
    near(axis.normal.x * axis.tangent.x + axis.normal.y * axis.tangent.y, 0);
    for (const p of [axis.start, axis.end]) near(axis.normal.x * p.x + axis.normal.y * p.y, axis.offset);
    assert.ok(prepared.supportPolygon.every(p => axis.normal.x * p.x + axis.normal.y * p.y <= axis.offset + 1e-8));
    assert.ok(prepared.supportPolygon.some(p => Math.abs(axis.normal.x * p.x + axis.normal.y * p.y - axis.offset) < 1e-8));
  }
  assert.deepEqual(resolveRailSafetyFallAxis(prepared, -17), resolveRailSafetyFallAxis(prepared, 343));
});

test('tilted box footprint follows the analytical rigid projection with conservative cell area', () => {
  const prepared = box();
  for (const angle of [0, 15, 30, 45, 60, 90]) {
    const projection = computeRailSafetyFallProjection(prepared, 90, angle);
    const radians = angle * Math.PI / 180;
    const exactWidth = 2 * Math.cos(radians) + 3 * Math.sin(radians), exactArea = 4 * exactWidth;
    assert.ok(projection.areaMeters2 >= exactArea - 1e-8);
    assert.ok(projection.areaMeters2 - exactArea <= 2 * (4 + exactWidth) * projection.cellSizeMeters + 8 * projection.cellSizeMeters ** 2);
    near(projection.bounds.xMax - projection.bounds.xMin, projection.width * projection.cellSizeMeters);
    near(projection.bounds.yMax - projection.bounds.yMin, projection.height * projection.cellSizeMeters);
    assert.equal(projection.firstContactAngle, 90); assert.equal(projection.belowGround, false);
    assert.equal(projection.angle, angle); assert.equal(projection.direction, 90);
  }
});

test('first outside-body ground contact is reported while requested geometric continuation remains available', () => {
  const base = box();
  const prepared = { ...base,
    vertices: new Float64Array([...base.vertices, 3, 0, 1, 2.8, 0.3, 1.1, 2.8, -0.3, 1.1]),
    indices: new Uint32Array([...base.indices, 8, 9, 10]),
    usedVertices: new Uint32Array([...base.usedVertices, 8, 9, 10]),
  };
  const before = computeRailSafetyFallProjection(prepared, 90, 20);
  const after = computeRailSafetyFallProjection(prepared, 90, 40);
  near(before.firstContactAngle, Math.atan2(1, 2) * 180 / Math.PI);
  assert.equal(before.belowGround, false); assert.equal(after.belowGround, true);
  assert.equal(after.angle, 40, 'contact information never silently truncates the requested rigid pose');
  assert.ok(after.areaMeters2 > 0);
});

test('projection calls preserve the prepared geometry and reject invalid angles', () => {
  const prepared = box(), original = structuredClone(prepared);
  const first = computeRailSafetyFallProjection(prepared, 43, 19);
  for (const direction of [0, 43, 90, 211, 359]) computeRailSafetyFallProjection(prepared, direction, 47);
  assert.deepEqual(prepared, original);
  assert.deepEqual(computeRailSafetyFallProjection(prepared, 403, 19), first);
  for (const angle of [-1, 91, NaN, Infinity]) assert.throws(() => computeRailSafetyFallProjection(prepared, 0, angle), /0–90/);
  assert.throws(() => computeRailSafetyFallProjection(prepared, NaN, 20), /有限/);
  first.mask.fill(0);
  assert.ok(computeRailSafetyFallProjection(prepared, 43, 19).mask.some(value => value === 1), 'returned masks do not alias future results');
});
