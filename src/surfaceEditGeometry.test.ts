import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSurfaceEditGeometry, estimateSurfaceEditGeometry, SURFACE_EDIT_GEOMETRY_LIMITS,
  type SurfaceEditGeometryInput, type SurfaceEditLocalPoint, type SurfaceEditMesh,
} from './surfaceEditGeometry';

const rectangle = (x = 0, y = 0, width = 10, height = width, z = 5): SurfaceEditLocalPoint[] =>
  [{ x, y, z }, { x: x + width, y, z }, { x: x + width, y: y + height, z }, { x, y: y + height, z }];
const parameters = (patch: Partial<SurfaceEditGeometryInput> = {}): SurfaceEditGeometryInput =>
  ({ mode: 'excavation', outer: rectangle(), targetElevation: 0, ...patch });
const near = (a: number, b: number, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
const vertex = (mesh: SurfaceEditMesh, i: number) => [...mesh.positions.slice(i * 3, i * 3 + 3)];
function validateMesh(mesh: SurfaceEditMesh) {
  assert.equal(mesh.positions.length % 3, 0);
  assert.equal(mesh.indices.length % 3, 0);
  assert.equal(mesh.normals.length, mesh.positions.length);
  assert.equal(mesh.uvs.length * 3, mesh.positions.length * 2);
  assert.ok([...mesh.positions, ...mesh.normals, ...mesh.uvs].every(Number.isFinite));
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = [...mesh.indices.slice(i, i + 3)];
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every(id => id < mesh.positions.length / 3));
    const [a, b, c] = ids.map(id => vertex(mesh, id));
    const ab = b.map((v, j) => v - a[j]), ac = c.map((v, j) => v - a[j]);
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    assert.ok(Math.hypot(...normal) > 1e-12, 'no degenerate faces');
    for (const id of ids) {
      const declared = [...mesh.normals.slice(id * 3, id * 3 + 3)];
      near(Math.hypot(...declared), 1, 1e-6);
      assert.ok(normal.reduce((sum, n, j) => sum + n * declared[j], 0) > 0, 'normal must agree with face winding');
    }
  }
}
function surfaceArea(mesh: SurfaceEditMesh) {
  let result = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [...mesh.indices.slice(i, i + 3)].map(id => vertex(mesh, id));
    result += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return result;
}
function wallArea(mesh: SurfaceEditMesh) {
  let result = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [...mesh.indices.slice(i, i + 3)].map(id => vertex(mesh, id));
    const ab = b.map((v, j) => v - a[j]), ac = c.map((v, j) => v - a[j]);
    result += Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
  }
  return result;
}

test('horizontal excavation uses a constant-size design surface, with inward walls and no sampling', () => {
  for (const size of [10, 100, 10_000]) {
    const result = buildSurfaceEditGeometry(parameters({ outer: rectangle(0, 0, size) }));
    near(result.area, size * size); near(surfaceArea(result.surface), result.area);
    near(result.perimeter, size * 4); near(wallArea(result.walls), size * 4 * 5);
    assert.equal(result.surface.positions.length / 3, 4);
    assert.equal(result.surface.indices.length / 3, 2);
    assert.equal(result.walls.indices.length / 3, 8);
    assert.equal(result.sampleCount, 0);
    assert.equal(result.algorithmVersion, 1);
    for (let i = 2; i < result.surface.positions.length; i += 3) assert.equal(result.surface.positions[i], 0);
    validateMesh(result.surface); validateMesh(result.walls);
  }
});

test('concave boundaries and preserved holes maintain exact area and leave hole interiors empty', () => {
  const outer = [{ x: 0, y: 0, z: 8 }, { x: 20, y: 0, z: 9 }, { x: 20, y: 20, z: 7 },
    { x: 10, y: 20, z: 8 }, { x: 10, y: 10, z: 8 }, { x: 0, y: 10, z: 6 }];
  const input = parameters({ outer, holes: [rectangle(12, 12, 4, 4, 6)] });
  const source = structuredClone(input), result = buildSurfaceEditGeometry(input);
  near(result.area, 284); near(surfaceArea(result.surface), 284);
  assert.equal(result.boundaryPoints, 10);
  assert.deepEqual(input, source, 'caller-owned boundaries and heights are immutable');
  for (let i = 0; i < result.surface.indices.length; i += 3) {
    const triangle = [...result.surface.indices.slice(i, i + 3)].map(id => vertex(result.surface, id));
    const x = triangle.reduce((sum, p) => sum + p[0], 0) / 3, y = triangle.reduce((sum, p) => sum + p[1], 0) / 3;
    assert.ok(!(x > 12 && x < 16 && y > 12 && y < 16), 'triangles never cover the protected island');
  }
  validateMesh(result.surface); validateMesh(result.walls);
});

test('reverse winding and explicitly closed rings preserve geometry without mutating inputs', () => {
  const original = parameters({ holes: [rectangle(2, 2, 2)] });
  const expected = buildSurfaceEditGeometry(original);
  const outer = [...original.outer].reverse(), hole = [...original.holes![0]].reverse();
  outer.push({ ...outer[0] }); hole.push({ ...hole[0] });
  const input = parameters({ outer, holes: [hole] }), snapshot = structuredClone(input), actual = buildSurfaceEditGeometry(input);
  near(actual.area, expected.area); near(actual.perimeter, expected.perimeter);
  near(surfaceArea(actual.surface), surfaceArea(expected.surface));
  near(wallArea(actual.walls), wallArea(expected.walls));
  assert.deepEqual(input, snapshot);
  validateMesh(actual.surface); validateMesh(actual.walls);
});

test('flattening permits both cut and fill, splitting side walls at plane crossings', () => {
  const outer = rectangle().map((p, i) => ({ ...p, z: i % 2 ? -2 : 2 }));
  const result = buildSurfaceEditGeometry(parameters({ mode: 'flatten', outer }));
  near(result.area, 100); near(wallArea(result.walls), 40);
  assert.equal(result.walls.indices.length / 3, 8);
  assert.ok([...result.walls.positions].includes(5), 'crossing edges include their exact midpoint');
  validateMesh(result.surface); validateMesh(result.walls);
  const filled = buildSurfaceEditGeometry(parameters({ mode: 'flatten', targetElevation: 8 }));
  near(wallArea(filled.walls), 120);
  validateMesh(filled.walls);
  const alreadyFlat = buildSurfaceEditGeometry(parameters({ mode: 'flatten', targetElevation: 5 }));
  assert.equal(alreadyFlat.walls.indices.length, 0);
  assert.equal(alreadyFlat.surface.indices.length, 6);
});

test('excavation floor must be below all outer and inner boundaries', () => {
  assert.throws(() => buildSurfaceEditGeometry(parameters({ targetElevation: 5 })), /坑底/);
  assert.throws(() => buildSurfaceEditGeometry(parameters({ outer: rectangle().map((p, i) => ({ ...p, z: i ? 5 : -1 })) })), /坑底/);
  assert.throws(() => buildSurfaceEditGeometry(parameters({ holes: [rectangle(2, 2, 2, 2, -1)] })), /坑底/);
});

test('invalid topology is rejected rather than simplified or filled', () => {
  const point = (x: number, y: number): SurfaceEditLocalPoint => ({ x, y, z: 5 });
  for (const outer of [
    [point(0, 0), point(10, 10), point(0, 10), point(10, 0)],
    [point(0, 0), point(10, 0), point(5, 0), point(5, 10), point(0, 10)],
    [point(0, 0), point(10, 0), point(10, 10), point(10, 0), point(0, 10)],
    [point(0, 0), point(10, 0), point(20, 0)],
  ]) assert.throws(() => buildSurfaceEditGeometry(parameters({ outer })), /自相交|重叠|重复|退化|面积/);
  for (const holes of [
    [rectangle(0, 2, 2)],
    [rectangle(9, 2, 2)],
    [rectangle(2, 2, 4), rectangle(3, 3, 1)],
    [rectangle(2, 2, 3), rectangle(4, 4, 3)],
    [rectangle(2, 2, 3), rectangle(5, 2, 2)],
  ]) assert.throws(() => buildSurfaceEditGeometry(parameters({ holes })), /保留区/);
});

test('nonfinite or inconsistent coordinates, target and material scale are never coerced to zero', () => {
  for (const property of ['x', 'y', 'z']) {
    const outer = rectangle(); outer[1] = { ...outer[1], [property]: NaN };
    assert.throws(() => buildSurfaceEditGeometry(parameters({ outer })), /坐标|高程/);
  }
  const closed = rectangle(); closed.push({ ...closed[0], z: 6 });
  assert.throws(() => buildSurfaceEditGeometry(parameters({ outer: closed })), /高程不一致/);
  assert.throws(() => buildSurfaceEditGeometry(parameters({ targetElevation: Infinity })), /标高/);
  for (const textureScaleMeters of [0, -1, NaN, 1e-12, 10001])
    assert.throws(() => buildSurfaceEditGeometry(parameters({ textureScaleMeters })), /纹理/);
  assert.throws(() => buildSurfaceEditGeometry(parameters({ targetElevation: -1001 })), /高差/);
  assert.throws(() => buildSurfaceEditGeometry(parameters({ outer: rectangle(0, 0, 10_001) })), /范围/);
});

test('point budgets reject huge input by its length before reading any coordinate', () => {
  const inaccessible = new Array(SURFACE_EDIT_GEOMETRY_LIMITS.boundaryPoints + 1);
  Object.defineProperty(inaccessible, 0, { get() { throw new Error('must not read coordinate'); } });
  assert.throws(() => estimateSurfaceEditGeometry(parameters({ outer: inaccessible })), /点数/);
  assert.throws(() => buildSurfaceEditGeometry(parameters({ outer: inaccessible })), /点数/);
  assert.throws(() => buildSurfaceEditGeometry(parameters({ holes: new Array(17) })), /保留区数量/);
  assert.throws(() => estimateSurfaceEditGeometry(parameters({ holes: [new Array(509)] })), /累计点数/);
});

test('topology, output and memory budgets are checked before triangulation; callers cannot increase ceilings', () => {
  const input = parameters();
  const estimate = estimateSurfaceEditGeometry(input);
  assert.equal(estimate.boundaryPoints, 4);
  assert.equal(estimate.vertices, 28);
  assert.equal(estimate.triangles, 10);
  for (const override of [
    { topologyChecks: 63 }, { vertices: 27 }, { triangles: 9 }, { memoryBytes: estimate.memoryBytes - 1 },
  ]) assert.throws(() => buildSurfaceEditGeometry(input, override), /预算/);
  for (const override of [{ boundaryPoints: 513 }, { vertices: NaN }, { triangles: 1.1 }, { extent: Infinity }])
    assert.throws(() => buildSurfaceEditGeometry(input, override), /预算/);
  assert.throws(() => buildSurfaceEditGeometry(parameters({ holes: [rectangle(2, 2, 1)] }), { holes: 0 }), /保留区数量/);
  const result = buildSurfaceEditGeometry(input, { vertices: estimate.vertices, triangles: estimate.triangles, memoryBytes: estimate.memoryBytes });
  validateMesh(result.surface); validateMesh(result.walls);
});

test('maximum supported boundary remains bounded without allocating an interior grid', () => {
  const n = SURFACE_EDIT_GEOMETRY_LIMITS.boundaryPoints;
  const outer = Array.from({ length: n }, (_, i) => ({ x: Math.cos(i * Math.PI * 2 / n) * 100, y: Math.sin(i * Math.PI * 2 / n) * 100, z: 5 }));
  const result = buildSurfaceEditGeometry(parameters({ outer }));
  assert.equal(result.boundaryPoints, n);
  assert.equal(result.surface.positions.length / 3, n);
  assert.equal(result.surface.indices.length / 3, n - 2);
  assert.ok((result.surface.positions.length + result.walls.positions.length) / 3 <= result.estimate.vertices);
  assert.ok((result.surface.indices.length + result.walls.indices.length) / 3 <= result.estimate.triangles);
  const bytes = [result.surface, result.walls].reduce((sum, mesh) => sum + mesh.positions.byteLength + mesh.normals.byteLength + mesh.uvs.byteLength + mesh.indices.byteLength, 0);
  assert.ok(bytes <= result.estimate.memoryBytes);
  validateMesh(result.surface); validateMesh(result.walls);
});

test('metric UVs follow requested material size without changing geometric detail', () => {
  const a = buildSurfaceEditGeometry(parameters({ textureScaleMeters: 2 })), b = buildSurfaceEditGeometry(parameters({ textureScaleMeters: 4 }));
  assert.deepEqual(a.surface.positions, b.surface.positions);
  assert.deepEqual(a.walls.positions, b.walls.positions);
  for (const [ma, mb] of [[a.surface, b.surface], [a.walls, b.walls]])
    for (let i = 0; i < ma.uvs.length; i++) near(ma.uvs[i], mb.uvs[i] * 2);
});
