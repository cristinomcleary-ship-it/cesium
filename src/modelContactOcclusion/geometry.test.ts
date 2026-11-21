import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContactGeometry, classifyContactPoint, contactTriangleDistanceSquared } from './geometry.ts';
import type { ContactMeshInput, ContactPrimitiveInput, ContactPoint } from './types.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
function box(low: ContactPoint, high: ContactPoint, groupId = 'box', reversed = false): ContactPrimitiveInput {
  const [a, b, c] = low, [x, y, z] = high;
  const indices = [...faces]; if (reversed) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  return { groupId, nodeIndex: 0, positions: Float64Array.from([a, b, c, x, b, c, x, y, c, a, y, c, a, b, z, x, b, z, x, y, z, a, y, z]), indices: Uint32Array.from(indices) };
}
const build = (...primitives: ContactPrimitiveInput[]) => buildContactGeometry({ primitives, worldFromLocal: identity });
const hit = (g: ReturnType<typeof build>, p: ContactPoint) => classifyContactPoint(g, p).clipped;

test('a raised closed beam clips its actual volume and contact, preserving ground and sky at identical XY', () => {
  const source = box([-4, -1, 10], [4, 1, 12]), before = [...source.positions], g = build(source);
  assert.equal(g.stats.sourceTriangles, 12); assert.equal(g.stats.packedTriangles, 12); assert.equal(g.stats.solidEntities, 1);
  assert.equal(g.stats.surfaceEntities, 0); assert.equal(g.stats.selfIntersectingShells, 0);
  for (const z of [0, 9, 13, 100]) assert.equal(hit(g, [0, 0, z]), false);
  for (const z of [10, 10.5, 11, 12]) assert.equal(hit(g, [0, 0, z]), true);
  assert.equal(hit(g, [5, 0, 11]), false); assert.deepEqual([...source.positions], before);
});

test('disconnected vertically stacked volumes preserve the gap and overlapping volumes form OR rather than XOR', () => {
  const g = build(box([-1, -1, 0], [1, 1, 1], 'shared'), box([-1, -1, 3], [1, 1, 4], 'shared'));
  assert.equal(g.stats.solidEntities, 2); assert.equal(hit(g, [0, 0, 2]), false); assert.equal(hit(g, [0, 0, .5]), true); assert.equal(hit(g, [0, 0, 3.5]), true);
  const overlap = build(box([-2, -2, -2], [1, 1, 1]), box([0, 0, 0], [2, 2, 2]));
  assert.equal(overlap.stats.solidEntities, 2); assert.equal(hit(overlap, [.5, .5, .5]), true); assert.equal(hit(overlap, [-1, -1, -1]), true); assert.equal(hit(overlap, [1.5, 1.5, 1.5]), true);
});

test('oppositely oriented nested shells preserve cavities and nested positive islands', () => {
  const outer = box([-5, -5, -5], [5, 5, 5]), hole = box([-3, -3, -3], [3, 3, 3], 'box', true), island = box([-1, -1, -1], [1, 1, 1]);
  const g = build(outer, hole, island);
  assert.equal(g.stats.cavityShells, 1); assert.equal(g.stats.solidEntities, 2); assert.equal(g.stats.packedTriangles, 36);
  assert.equal(hit(g, [4, .2, .1]), true); assert.equal(hit(g, [2, .2, .1]), false); assert.equal(hit(g, [0, .2, .1]), true);
  const inverted = build(box([-5, -5, -5], [5, 5, 5], 'box', true), box([-3, -3, -3], [3, 3, 3]));
  assert.equal(hit(inverted, [0, 0, 0]), false); assert.equal(hit(inverted, [4, 0, 0]), true);
});

test('an independent nested object never becomes a cavity just because its normals are reversed', () => {
  const g = build(box([-5, -5, -5], [5, 5, 5], 'one'), box([-3, -3, -3], [3, 3, 3], 'two', true));
  assert.equal(g.stats.cavityShells, 0); assert.equal(g.stats.solidEntities, 2); assert.equal(hit(g, [0, 0, 0]), true);
});

test('material primitive seams are joined analytically without welding coordinates or changing source indices', () => {
  const source = box([-1, -1, -1], [1, 1, 1]), a = { ...source, indices: source.indices.slice(0, 18) }, b = { ...source, indices: source.indices.slice(18) };
  const g = build(a, b); assert.equal(g.stats.sourcePrimitives, 2); assert.equal(g.stats.solidEntities, 1); assert.equal(hit(g, [0, 0, 0]), true);
  const shifted = { ...b, positions: b.positions.slice() }; shifted.positions[0] += 1e-8;
  const open = build(a, shifted); assert(open.stats.surfaceEntities > 0, 'small real gaps must not be epsilon-welded');
});

test('a body split across importer nodes closes only through unique exact boundary edges', () => {
  const source = box([-1, -1, -1], [1, 1, 1]);
  const split = Array.from({ length: 12 }, (_, i) => ({ ...source, indices: source.indices.slice(i * 3, i * 3 + 3), groupId: `node:${i}`, nodeIndex: i }));
  const g = build(...split);
  assert.equal(g.stats.sourceGroups, 12); assert.equal(g.stats.solidEntities, 1); assert.equal(g.stats.openShells, 0); assert.equal(g.stats.packedTriangles, 12);
  assert.equal(hit(g, [0, 0, 0]), true); assert.equal(hit(g, [0, 0, 2]), false);
  const closedCopy = box([-1, -1, -1], [1, 1, 1], 'independent');
  const overlap = build(...split, closedCopy); assert.equal(overlap.stats.solidEntities, 2); assert.equal(hit(overlap, [0, 0, 0]), true);
  const ambiguous = build(...split, { ...split[0], groupId: 'third-seam', nodeIndex: 20 });
  assert.equal(ambiguous.stats.solidEntities, 0); assert.equal(ambiguous.stats.packedTriangles, 13); assert.equal(hit(ambiguous, [0, 0, 0]), false);
});

test('open surfaces and nonmanifold duplicates never acquire invented interior volume', () => {
  const closed = box([-1, -1, -1], [1, 1, 1]), open = { ...closed, indices: closed.indices.slice(6) }, g = build(open);
  assert.equal(g.stats.openShells, 1); assert.equal(g.stats.solidEntities, 0); assert.equal(hit(g, [0, 0, 0]), false); assert.equal(hit(g, [0, 0, 1]), true);
  assert.equal(hit(g, [0, 0, 1 + g.numericalTolerance * 4]), false);
  const repeated = { ...closed, indices: Uint32Array.from([...closed.indices, ...closed.indices.slice(0, 3)]) }, bad = build(repeated);
  assert.equal(bad.stats.duplicateTriangles, 1); assert.equal(bad.stats.nonManifoldShells, 1); assert.equal(bad.stats.solidEntities, 0);
  assert.equal(bad.stats.packedTriangles, 13); assert.equal(hit(bad, [0, 0, 0]), false); assert.equal(hit(bad, [0, 0, -1]), true);
});

test('inconsistent face directions and geometric degeneracies are explicitly surface-only', () => {
  const source = box([-1, -1, -1], [1, 1, 1]); [source.indices[0], source.indices[1]] = [source.indices[1], source.indices[0]];
  const g = build(source); assert.equal(g.stats.inconsistentShells, 1); assert.equal(g.stats.solidEntities, 0); assert.equal(hit(g, [0, 0, 0]), false);
  const line: ContactPrimitiveInput = { positions: Float64Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), indices: Uint32Array.from([0, 1, 2]), groupId: 'line', nodeIndex: 1 };
  const d = build(line); assert.equal(d.stats.degenerateTriangles, 1); assert.equal(d.stats.solidEntities, 0); assert.equal(hit(d, [.5, 0, 0]), true); assert.equal(hit(d, [.5, .01, 0]), false);
});

test('noncoplanar neighboring faces meeting on their exact common edge are not self intersections', () => {
  const source = box([-1, -1, -1], [1, 1, 1]); source.positions[6 * 3] += .002; source.positions[6 * 3 + 1] -= .003;
  const g = build(source); assert.equal(g.stats.solidEntities, 1); assert.equal(g.stats.selfIntersectingShells, 0); assert.equal(hit(g, [0, 0, 0]), true);
});

test('a topologically closed body with a face crossing another face remains surface-only', () => {
  const source = box([-1, -1, -1], [1, 1, 1]);
  source.positions[18] = .5; source.positions[19] = .5; source.positions[20] = -2;
  const g = build(source);
  assert.equal(g.stats.openShells, 0); assert.equal(g.stats.nonManifoldShells, 0);
  assert.equal(g.stats.selfIntersectingShells, 1); assert.equal(g.stats.solidEntities, 0); assert.equal(g.stats.packedTriangles, 12);
});

test('half-open ray crossings handle triangulated face diagonals, exact projected edges and negative orientation', () => {
  for (const reverse of [false, true]) {
    const g = build(box([-1, -1, -1], [1, 1, 1], 'cube', reverse));
    for (const p of [[0, 0, 0], [0, .5, .5], [0, -.5, -.5], [0, .999, -.999]] as ContactPoint[]) assert.equal(hit(g, p), true, JSON.stringify(p));
    for (const p of [[-2, 0, 0], [2, 0, 0], [0, 1.1, 0]] as ContactPoint[]) assert.equal(hit(g, p), false);
  }
});

test('root origin rebasing is reversible and independent of placement matrix', () => {
  const a = box([100000, -10000, 2000], [100002, -9998, 2002]), g = build(a);
  assert.equal(hit(g, [100001, -9999, 2001]), true); assert.equal(hit(g, [100001, -9999, 1000]), false);
  const input: ContactMeshInput = { primitives: [a], worldFromLocal: [...identity] }; input.worldFromLocal = [...identity.slice(0, 12), 1e6, 2e6, 3e6, 1];
  const moved = buildContactGeometry(input); assert.deepEqual(moved.nodes, g.nodes); assert.deepEqual(moved.triangles, g.triangles);
});

test('invalid input and cancellation fail before publishing a partial result', () => {
  assert.throws(() => buildContactGeometry({ primitives: [], worldFromLocal: identity }), /没有/);
  const bad = box([0, 0, 0], [1, 1, 1]); bad.indices[0] = 500;
  assert.throws(() => build(bad), /越界/);
  assert.throws(() => buildContactGeometry({ primitives: [box([0, 0, 0], [1, 1, 1])], worldFromLocal: identity }, { shouldAbort: () => true }), /取消/);
  const nonfinite = box([0, 0, 0], [1, 1, 1]); nonfinite.positions[0] = NaN; assert.throws(() => build(nonfinite), /非有限/);
});

test('triangle distance uses the real surface, not its box or its plane outside the boundary', () => {
  const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  assert.equal(contactTriangleDistanceSquared([.2, .2, 2], triangle), 4);
  assert(contactTriangleDistanceSquared([.9, .9, 0], triangle) > .3);
  assert.equal(contactTriangleDistanceSquared([0, 0, 0], triangle), 0);
});
