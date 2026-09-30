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


test("vertical-plane trapezoids use their surface plane instead of degenerating in XY", () => {
  const corners = [
    { x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 },
    { x: 3, y: 0, z: 0 }, { x: 7, y: 0, z: 0 },
  ] as const;
  const mapper = createProjectiveQuadMapper(corners);
  assert.equal(mapper.projective, true);
  const center = mapper.pointAt(0.5, 0.5);
  assert.ok(Math.abs(center.x - 5) < 1e-12);
  assert.ok(Math.abs(center.z - 20 / 7) < 1e-12);
  for (const [u, v, index] of [[0, 0, 0], [1, 0, 1], [0, 1, 2], [1, 1, 3]]) {
    assert.deepEqual(mapper.pointAt(u, v), corners[index]);
  }
});

test("invalid surfaces are rejected instead of silently producing folded or flattened projections", () => {
  const p = (x: number, y: number, z = 0) => ({ x, y, z });
  assert.throws(() => createProjectiveQuadMapper([p(0, 0), p(1, 1), p(0, 1), p(1, 0)]), /degenerate|intersect|convex/);
  assert.throws(() => createProjectiveQuadMapper([p(0, 0), p(3, 0), p(0, 3), p(0.5, 0.5)]), /convex/);
  assert.throws(() => createProjectiveQuadMapper([p(0, 0), p(1, 0), p(2, 0), p(3, 0)]), /degenerate/);
  assert.throws(() => createProjectiveQuadMapper([p(0, 10, 2), p(10, 10, 2), p(3, 0), p(7, 0, 5)]), /nonplanar/);
  const mapper = createProjectiveQuadMapper([p(0, 10), p(10, 10), p(3, 0), p(7, 0)]);
  assert.throws(() => mapper.homogeneousWeightAt(0, -2 / 3), /pole/);
});

test("small accepted height rounding retains every supplied corner", () => {
  const corners = [
    { x: 0, y: 10, z: 2 }, { x: 10, y: 10, z: 2 },
    { x: 3, y: 0, z: 0 }, { x: 7, y: 0, z: 0.01 },
  ] as const;
  const mapper = createProjectiveQuadMapper(corners);
  assert.deepEqual(mapper.pointAt(1, 1), corners[3]);
});

test("homogeneous UV interpolation reprojects an 82-degree-oblique camera exactly on horizontal and vertical planes", () => {
  const depression = 8 * Math.PI / 180;
  const halfWidth = 0.35;
  const halfHeight = Math.tan(6 * Math.PI / 180);
  const origin = { x: 0, y: 0, z: 100 };
  const forward = { x: 0, y: Math.cos(depression), z: -Math.sin(depression) };
  const right = { x: 1, y: 0, z: 0 };
  const down = { x: 0, y: -Math.sin(depression), z: -Math.cos(depression) };
  const rayPlane = (u: number, v: number) => {
    const x = (2 * u - 1) * halfWidth;
    const y = (2 * v - 1) * halfHeight;
    const dx = forward.x + right.x * x + down.x * y;
    const dy = forward.y + right.y * x + down.y * y;
    const dz = forward.z + right.z * x + down.z * y;
    const distance = -origin.z / dz;
    return { x: origin.x + dx * distance, y: origin.y + dy * distance, z: 0 };
  };
  const corners = [rayPlane(0, 0), rayPlane(1, 0), rayPlane(0, 1), rayPlane(1, 1)] as const;
  const barycentric = [0.25, 0.3, 0.45];
  const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
    a.x * b.x + a.y * b.y + a.z * b.z;
  for (const vertical of [false, true]) {
    const surfaceCorners = corners.map((point) => vertical
      ? { x: point.x, y: point.z, z: point.y } : point) as unknown as typeof corners;
    // Just two triangles: increased tessellation is not masking the error.
    const grid = buildProjectiveGrid(surfaceCorners, 1, 1);
    for (let triangle = 0; triangle < 2; triangle += 1) {
      const vertices = grid.indices.slice(triangle * 3, triangle * 3 + 3);
      const world = { x: 0, y: 0, z: 0 };
      let weight = 0;
      let uWeighted = 0;
      let vWeighted = 0;
      let affineU = 0;
      let affineV = 0;
      vertices.forEach((vertex, index) => {
        const amount = barycentric[index];
        const point = grid.points[vertex];
        world.x += amount * point.x;
        world.y += amount * point.y;
        world.z += amount * point.z;
        const q = grid.textureWeights[vertex];
        const u = grid.textureCoordinates[vertex * 2];
        const v = 1 - grid.textureCoordinates[vertex * 2 + 1];
        weight += amount * q;
        uWeighted += amount * u * q;
        vWeighted += amount * v * q;
        affineU += amount * u;
        affineV += amount * v;
      });
      const horizontalWorld = vertical ? { x: world.x, y: world.z, z: world.y } : world;
      const relative = { x: horizontalWorld.x - origin.x, y: horizontalWorld.y - origin.y, z: horizontalWorld.z - origin.z };
      const cameraDepth = dot(relative, forward);
      const expectedU = (dot(relative, right) / cameraDepth / halfWidth + 1) / 2;
      const expectedV = (dot(relative, down) / cameraDepth / halfHeight + 1) / 2;
      assert.ok(Math.abs(uWeighted / weight - expectedU) < 1e-12);
      assert.ok(Math.abs(vWeighted / weight - expectedV) < 1e-12);
      assert.ok(Math.hypot(affineU - expectedU, affineV - expectedV) > 0.1,
        "Ordinary affine UV interpolation should show the original large error");
    }
  }
});

test("homogeneous UV weights preserve cropped-source coordinates", () => {
  const grid = buildProjectiveGrid([
    { x: 0, y: 10, z: 0 }, { x: 10, y: 10, z: 0 },
    { x: 3, y: 0, z: 0 }, { x: 7, y: 0, z: 0 },
  ], 1, 1, 0.2);
  const amount = [0.2, 0.3, 0.5];
  const vertices = grid.indices.slice(0, 3);
  let q = 0;
  let sourceV = 0;
  let normalizedV = 0;
  vertices.forEach((vertex, index) => {
    const weighted = amount[index] * grid.textureWeights[vertex];
    q += weighted;
    sourceV += weighted * (1 - grid.textureCoordinates[vertex * 2 + 1]);
    normalizedV += weighted * (vertex >= 2 ? 1 : 0);
  });
  assert.ok(Math.abs(sourceV / q - (0.2 + 0.8 * normalizedV / q)) < 1e-12);
});
