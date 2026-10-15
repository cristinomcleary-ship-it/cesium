import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rasterizeProjectedTriangles, type ProjectedTriangleRaster } from './railSafetyProjectionRaster';

function rectangles(rects: number[][]) {
  const xy: number[] = [], indices: number[] = [];
  for (const [x0, y0, x1, y1] of rects) {
    const first = xy.length / 2;
    xy.push(x0, y0, x1, y0, x1, y1, x0, y1);
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { xy: new Float64Array(xy), indices: new Uint32Array(indices) };
}
function at(raster: ProjectedTriangleRaster, x: number, y: number) {
  const column = Math.floor((x - raster.bounds.xMin) / raster.cellSizeMeters);
  const row = Math.floor((raster.bounds.yMax - y) / raster.cellSizeMeters);
  assert.ok(row >= 0 && row < raster.height && column >= 0 && column < raster.width);
  return raster.mask[row * raster.width + column];
}

test('triangle union retains an asymmetric L-shaped notch, not its convex hull', () => {
  const mesh = rectangles([[0, 0, 8, 2], [0, 2, 2, 7]]);
  const raster = rasterizeProjectedTriangles(mesh.xy, mesh.indices);
  assert.equal(at(raster, 7, 1), 1);
  assert.equal(at(raster, 1, 6), 1);
  assert.equal(at(raster, 4, 4), 0);
  assert.equal(at(raster, 7, 6), 0);
});

test('enclosed ring hole and disjoint components remain empty between triangles', () => {
  const ring = rectangles([[0, 0, 10, 2], [0, 8, 10, 10], [0, 2, 2, 8], [8, 2, 10, 8]]);
  const raster = rasterizeProjectedTriangles(ring.xy, ring.indices);
  for (const [x, y] of [[1, 5], [5, 1], [9, 5], [5, 9]]) assert.equal(at(raster, x, y), 1);
  assert.equal(at(raster, 5, 5), 0);
  const parts = rectangles([[-8, -2, -5, 2], [5, -1, 9, 3]]);
  const separated = rasterizeProjectedTriangles(parts.xy, parts.indices);
  assert.equal(at(separated, -6, 0), 1); assert.equal(at(separated, 7, 0), 1);
  assert.equal(at(separated, 0, 0), 0);
});

test('conservative coverage does not miss long subpixel diagonal triangles or degenerate edges', () => {
  for (const thickness of [0, 0.00001]) {
    const raster = rasterizeProjectedTriangles(new Float64Array([0, 0, 80, 47, 80, 47 + thickness]), new Uint32Array([0, 1, 2]), { maxPixels: 64 });
    for (let step = 0; step <= 1000; step++) {
      const t = step / 1000;
      assert.equal(at(raster, t * 80, t * 47), 1, `edge point at ${t}`);
    }
    assert.ok(raster.mask.reduce((sum, value) => sum + value, 0) < raster.width * raster.height / 10);
  }
  const point = rasterizeProjectedTriangles(new Float64Array([2, 3]), new Uint32Array([0, 0, 0]));
  assert.equal(at(point, 2, 3), 1);
});

test('every closed square touched at an exact grid corner is conservatively occupied', () => {
  const xy = new Float64Array([0, 0, 2, 2, 1, 1]);
  const raster = rasterizeProjectedTriangles(xy, new Uint32Array([0, 1, 2]), { minCellSizeMeters: 1 });
  assert.equal(raster.bounds.xMin, -1); assert.equal(raster.bounds.yMax, 3);
  // The segment through (1, 1) touches all four neighbours of this grid corner.
  for (const [x, y] of [[0.5, 0.5], [0.5, 1.5], [1.5, 0.5], [1.5, 1.5]]) {
    assert.equal(at(raster, x, y), 1);
  }
});

test('north-up layout, margin, resolution cap and occupied area have explicit pixel semantics', () => {
  const mesh = rectangles([[0, 0, 120, 20], [0, 20, 5, 80]]);
  const raster = rasterizeProjectedTriangles(mesh.xy, mesh.indices, { maxPixels: 64 });
  assert.equal(Math.max(raster.width, raster.height), 64);
  assert.ok(raster.cellSizeMeters >= 0.1);
  assert.ok(raster.bounds.xMin <= -raster.cellSizeMeters + 1e-10);
  assert.ok(raster.bounds.yMax >= 80 + raster.cellSizeMeters - 1e-10);
  assert.equal(at(raster, 60, 10), 1); assert.equal(at(raster, 60, 70), 0);
  assert.equal(raster.mask.length, raster.width * raster.height);
  assert.ok(raster.mask.every(value => value === 0 || value === 1));
  assert.equal(raster.areaMeters2, raster.mask.reduce((sum, value) => sum + value, 0) * raster.cellSizeMeters ** 2);
  for (const [requested, expected] of [[-10, 32], [9999, 768]]) {
    const result = rasterizeProjectedTriangles(mesh.xy, mesh.indices, { maxPixels: requested, minCellSizeMeters: 0.01 });
    assert.equal(Math.max(result.width, result.height), expected);
  }
});

test('duplicate triangles do not inflate union area and input arrays remain unchanged', () => {
  const mesh = rectangles([[0, 0, 4, 3]]), originalXY = mesh.xy.slice(), originalIndices = mesh.indices.slice();
  const single = rasterizeProjectedTriangles(mesh.xy, mesh.indices);
  const duplicate = rasterizeProjectedTriangles(mesh.xy, new Uint32Array([...mesh.indices, ...mesh.indices]));
  assert.deepEqual(single, duplicate);
  assert.deepEqual(mesh.xy, originalXY); assert.deepEqual(mesh.indices, originalIndices);
});

test('empty meshes return empty results and unused vertices do not expand rendered bounds', () => {
  const empty = rasterizeProjectedTriangles(new Float64Array(), new Uint32Array());
  assert.equal(empty.mask.length, 0); assert.equal(empty.width, 0); assert.equal(empty.height, 0);
  assert.equal(empty.areaMeters2, 0);
  const a = rasterizeProjectedTriangles(new Float64Array([0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
  const b = rasterizeProjectedTriangles(new Float64Array([0, 0, 1, 0, 0, 1, 9999, -9999]), new Uint32Array([0, 1, 2]));
  assert.deepEqual(a, b);
});

test('malformed geometry and non-finite options fail explicitly', () => {
  const xy = new Float64Array([0, 0, 1, 0, 0, 1]), indices = new Uint32Array([0, 1, 2]);
  assert.throws(() => rasterizeProjectedTriangles(new Float64Array([0]), indices), /pairs/);
  assert.throws(() => rasterizeProjectedTriangles(xy, new Uint32Array([0, 1])), /triples/);
  assert.throws(() => rasterizeProjectedTriangles(xy, new Uint32Array([0, 1, 3])), /bounds/);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => rasterizeProjectedTriangles(new Float64Array([0, 0, value, 1, 1, 1]), indices), /finite/);
    assert.throws(() => rasterizeProjectedTriangles(xy, indices, { maxPixels: value }), /finite/);
  }
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => rasterizeProjectedTriangles(xy, indices, { minCellSizeMeters: value }), /positive/);
  }
  assert.throws(() => rasterizeProjectedTriangles(new Float64Array([-1e308, 0, 1e308, 0, 0, 1]), indices), /large/);
});
