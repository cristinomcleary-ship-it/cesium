import assert from "node:assert/strict";
import test from "node:test";

import { buildProjectiveGrid, createProjectiveQuadMapper } from "./videoArProjection.ts";

test("projective interpolation preserves all four control corners", () => {
  const corners = [
    { x: 0, y: 10, z: 2 },
    { x: 10, y: 10, z: 2 },
    { x: 3, y: 0, z: 0 },
    { x: 7, y: 0, z: 0 },
  ] as const;
  const mapper = createProjectiveQuadMapper(corners);

  assert.equal(mapper.projective, true);
  assert.deepEqual(mapper.pointAt(0, 0), corners[0]);
  assert.deepEqual(mapper.pointAt(1, 0), corners[1]);
  assert.deepEqual(mapper.pointAt(0, 1), corners[2]);
  const bottomRight = mapper.pointAt(1, 1);
  assert.ok(Math.abs(bottomRight.x - corners[3].x) < 1e-12);
  assert.ok(Math.abs(bottomRight.y - corners[3].y) < 1e-12);
  assert.ok(Math.abs(bottomRight.z - corners[3].z) < 1e-12);
});

test("oblique footprint center uses a homography instead of a two-triangle affine stretch", () => {
  const mapper = createProjectiveQuadMapper([
    { x: 0, y: 10, z: 0 },
    { x: 10, y: 10, z: 0 },
    { x: 3, y: 0, z: 0 },
    { x: 7, y: 0, z: 0 },
  ]);
  const center = mapper.pointAt(0.5, 0.5);

  assert.ok(Math.abs(center.x - 5) < 1e-12);
  assert.ok(Math.abs(center.y - 20 / 7) < 1e-12);
  assert.notEqual(center.y, 5);
});

test("projection grid keeps source crop in UVs without changing its geographic boundary", () => {
  const grid = buildProjectiveGrid([
    { x: 0, y: 1, z: 0 },
    { x: 2, y: 1, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
  ], 2, 2, 0.125);

  assert.equal(grid.points.length, 9);
  assert.equal(grid.indices.length, 24);
  assert.deepEqual(grid.textureCoordinates.slice(0, 2), [0, 0.875]);
  assert.deepEqual(grid.textureCoordinates.slice(-2), [1, 0]);
});

test("projection grid concentrates rows near the high-distortion far edge", () => {
  const grid = buildProjectiveGrid([
    { x: 0, y: 1, z: 0 },
    { x: 2, y: 1, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
  ], 1, 2, 0, 2);

  // Row-major order: the first vertex in the middle row is much closer to
  // the top edge than a uniform 0.5 sample would be.
  assert.ok(Math.abs(grid.points[2].y - 0.75) < 1e-12);
  assert.ok(Math.abs(grid.textureCoordinates[5] - 0.75) < 1e-12);
});
