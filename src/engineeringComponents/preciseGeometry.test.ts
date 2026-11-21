import assert from 'node:assert/strict';
import test from 'node:test';
import { Cartesian3, Matrix4, Transforms } from '@cesium/engine';
import { buildPreciseClippingGeometry, type PreciseClippingGeometry } from './preciseGeometry.ts';

const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 100));
const point = (x: number, y: number, z = 0) => Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3());
const ring = (pairs: number[][]) => pairs.map(([x, y, z = 0]) => point(x, y, z));
function query(geometry: PreciseClippingGeometry, world: Cartesian3) {
  const p = Matrix4.multiplyByPoint(geometry.worldToLocal, world, new Cartesian3()), denominator = p.z - geometry.earth.z;
  const x = p.x - p.z * (p.x - geometry.earth.x) / denominator, y = p.y - p.z * (p.y - geometry.earth.y) / denominator;
  const nodes = geometry.nodes, vertices = geometry.vertices; let index = 0, visited = 0;
  while (index < geometry.nodeCount) {
    assert.ok(visited++ <= geometry.nodeCount, 'escape walk must terminate');
    const offset = index * 8, escape = nodes[offset + 4], start = nodes[offset + 5], count = nodes[offset + 6];
    assert.ok(Number.isInteger(escape) && escape > index && escape <= geometry.nodeCount);
    if (x < nodes[offset] || y < nodes[offset + 1] || x > nodes[offset + 2] || y > nodes[offset + 3]) { index = escape; continue; }
    if (!count) { index++; continue; }
    let inside = false;
    for (let i = 0, j = count - 1; i < count; j = i++) {
      const ax = vertices[(start + i) * 4], ay = vertices[(start + i) * 4 + 1], bx = vertices[(start + j) * 4], by = vertices[(start + j) * 4 + 1];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    if (inside) return { inside, visited }; index = escape;
  }
  return { inside: false, visited };
}
test('BVH leaf winding preserves concavity instead of accepting its bounding rectangle', () => {
  const g = buildPreciseClippingGeometry([ring([[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]])]);
  assert.equal(query(g, point(3, .5)).inside, true); assert.equal(query(g, point(.5, 3)).inside, true);
  assert.equal(query(g, point(2, 2)).inside, false); assert.equal(query(g, point(-1, 2)).inside, false);
  assert.equal(g.vertexCount, 6); assert.equal(g.nodeCount, 1);
});
test('hole triangulation remains open while all original triangles and vertices are retained', () => {
  const boxes = [[0, 0, 4, 1], [0, 3, 4, 4], [0, 1, 1, 3], [3, 1, 4, 3]];
  const triangles = boxes.flatMap(([x0, y0, x1, y1]) => [ring([[x0, y0], [x1, y0], [x1, y1]]), ring([[x0, y0], [x1, y1], [x0, y1]])]);
  const original = JSON.stringify(triangles), g = buildPreciseClippingGeometry(triangles);
  assert.equal(g.vertexCount, 24); assert.equal(g.nodeCount, 15); assert.equal(query(g, point(2, 2)).inside, false);
  assert.equal(query(g, point(.5, 2)).inside, true); assert.equal(JSON.stringify(triangles), original);
});
test('one metre circular pile remains resolved at either end of a ten kilometre corridor', () => {
  const circles = [-5000, 5000].map(center => ring(Array.from({ length: 64 }, (_, i) => [center + .5 * Math.cos(i * Math.PI / 32), .5 * Math.sin(i * Math.PI / 32)])));
  const g = buildPreciseClippingGeometry(circles);
  for (const center of [-5000, 5000]) {
    assert.equal(query(g, point(center, 0)).inside, true); assert.equal(query(g, point(center + .4, 0)).inside, true);
    assert.equal(query(g, point(center + .6, 0)).inside, false);
  }
  let maximumError = 0, i = 0;
  for (const polygon of circles) for (const world of polygon) {
    const p = Matrix4.multiplyByPoint(g.worldToLocal, world, new Cartesian3()), k = p.z / (p.z - g.earth.z);
    maximumError = Math.max(maximumError, Math.hypot(g.vertices[i * 4] - (p.x - k * (p.x - g.earth.x)), g.vertices[i * 4 + 1] - (p.y - k * (p.y - g.earth.y)))); i++;
  }
  assert.ok(maximumError < .0005, `local float precision ${maximumError} m`);
  assert.equal(new Set(Array.from({ length: 64 }, (_, i) => `${g.vertices[i * 4]},${g.vertices[i * 4 + 1]}`)).size, 64);
});
test('median BVH escape indices skip complete subtrees and bound empty-space traversal', () => {
  const polygons = Array.from({ length: 1000 }, (_, i) => ring([[i * 3, 0], [i * 3 + 1, 0], [i * 3 + 1, 1], [i * 3, 1]]));
  const g = buildPreciseClippingGeometry(polygons); assert.equal(g.nodeCount, 1999); assert.ok(g.maxDepth <= 11);
  for (const index of [0, 1, 499, 999]) {
    assert.equal(query(g, point(index * 3 + .5, .5)).inside, true);
    const empty = query(g, point(index * 3 + 1.5, .5)); assert.equal(empty.inside, false); assert.ok(empty.visited < 30);
  }
  assert.deepEqual(query(g, point(-10, .5)), { inside: false, visited: 1 });
  for (let i = 0; i < g.nodeCount; i++) {
    const offset = i * 8; assert.ok(g.nodes[offset + 4] > i && g.nodes[offset + 4] <= g.nodeCount);
    if (g.nodes[offset + 6]) assert.equal(g.nodes[offset + 4], i + 1);
  }
});
test('invalid and over-budget inputs fail explicitly without truncation or hull substitution', () => {
  assert.throws(() => buildPreciseClippingGeometry([]), /多边形数量/);
  assert.throws(() => buildPreciseClippingGeometry([[point(0, 0), point(1, 0)]]), /边界数量/);
  assert.throws(() => buildPreciseClippingGeometry([[new Cartesian3(NaN, 0, 0), point(1, 0), point(0, 1)]]), /非有限/);
  assert.throws(() => buildPreciseClippingGeometry([Array.from({ length: 65537 }, () => point(0, 0))]), /预算/);
  const back = Cartesian3.negate(point(0, 0), new Cartesian3());
  assert.throws(() => buildPreciseClippingGeometry([[point(0, 0), point(1, 0), point(0, 1)], [back, back, back]]), /地心|反向/);
});
