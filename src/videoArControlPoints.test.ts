import assert from "node:assert/strict";
import test from "node:test";
import { projectControlPoint, refineCameraPose, type ControlPointMatch } from "./videoArControlPoints.ts";

const intrinsics = { width: 1920, height: 1080, fx: 1350, fy: 1320, cx: 970, cy: 530 };
const truth = { position: { x: 20, y: -30, z: 120 }, attitude: { yaw: 23, pitch: -55, roll: 4 } };

// Independent analytic ENU forward/right/down basis, rather than projecting
// expected pixels with the implementation under test.
function observed(world: { x: number; y: number; z: number }, lens = { k1: 0, k2: 0, p1: 0, p2: 0 }) {
  const yaw = truth.attitude.yaw * Math.PI / 180;
  const pitch = truth.attitude.pitch * Math.PI / 180;
  const roll = truth.attitude.roll * Math.PI / 180;
  const f = [Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
  const r0 = [Math.cos(yaw), -Math.sin(yaw), 0];
  const d0 = [Math.sin(yaw) * Math.sin(pitch), Math.cos(yaw) * Math.sin(pitch), -Math.cos(pitch)];
  const right = r0.map((value, index) => value * Math.cos(roll) + d0[index] * Math.sin(roll));
  const down = d0.map((value, index) => value * Math.cos(roll) - r0[index] * Math.sin(roll));
  const relative = [world.x - truth.position.x, world.y - truth.position.y, world.z - truth.position.z];
  const dot = (basis: number[]) => basis.reduce((sum, value, index) => sum + value * relative[index], 0);
  const x = dot(right) / dot(f);
  const y = dot(down) / dot(f);
  const radius2 = x * x + y * y;
  const radial = 1 + lens.k1 * radius2 + lens.k2 * radius2 * radius2;
  const xd = x * radial + 2 * lens.p1 * x * y + lens.p2 * (radius2 + 2 * x * x);
  const yd = y * radial + lens.p1 * (radius2 + 2 * y * y) + 2 * lens.p2 * x * y;
  return { pixelX: intrinsics.cx + intrinsics.fx * xd, pixelY: intrinsics.cy + intrinsics.fy * yd, world };
}

const points = [
  { x: 15, y: 25, z: 0 }, { x: 50, y: 25, z: 0 }, { x: 85, y: 25, z: 0 },
  { x: 15, y: 75, z: 0 }, { x: 50, y: 75, z: 0 }, { x: 85, y: 75, z: 0 },
  { x: 35, y: 50, z: 0 }, { x: 65, y: 50, z: 0 },
];

const biased = {
  initialPosition: { x: truth.position.x + 8, y: truth.position.y - 6, z: truth.position.z + 10 },
  initialAttitude: { yaw: truth.attitude.yaw + 4, pitch: truth.attitude.pitch - 3, roll: truth.attitude.roll + 2 },
};

function assertPose(fitted: ReturnType<typeof refineCameraPose>, tolerance = 1e-4) {
  for (const key of ["x", "y", "z"] as const) assert.ok(Math.abs(fitted.position[key] - truth.position[key]) < tolerance);
  for (const key of ["yaw", "pitch", "roll"] as const) assert.ok(Math.abs(fitted.attitude[key] - truth.attitude[key]) < tolerance);
}

test("control-point projection agrees with an independent pinhole camera and off-center intrinsics", () => {
  for (const point of points) {
    const actual = projectControlPoint({ ...truth, intrinsics }, point);
    const expected = observed(point);
    assert.ok(Math.abs(actual.pixelX - expected.pixelX) < 1e-9);
    assert.ok(Math.abs(actual.pixelY - expected.pixelY) < 1e-9);
    assert.ok(actual.depth > 0);
  }
});

test("well-spread planar controls correct GPS offsets, altitude and all camera angles", () => {
  const fitted = refineCameraPose({ ...biased, intrinsics, controls: points.map((point) => observed(point)), maxRmsePx: 0.001 });
  assertPose(fitted);
  assert.ok(fitted.rmsePx < 1e-6);
  assert.ok(fitted.maxErrorPx < 1e-6);
  assert.ok(fitted.iterations > 0 && fitted.iterations <= 80);
});

test("four planar correspondences are sufficient for a local pose correction", () => {
  const controls = [points[0], points[2], points[3], points[5]].map((point) => observed(point));
  const fitted = refineCameraPose({ ...biased, intrinsics, controls, maxRmsePx: 0.001 });
  assertPose(fitted);
  assert.equal(fitted.residuals.length, 4);
});

test("different roof heights and nonzero lens calibration remain consistent with small pixel noise", () => {
  const lens = { k1: -0.15, k2: 0.04, p1: 0.001, p2: -0.002 };
  const controls = points.map((point, index) => {
    const match = observed({ ...point, z: (index % 3) * 12 }, lens);
    return { ...match, pixelX: match.pixelX + Math.sin(index) * 0.3, pixelY: match.pixelY + Math.cos(index) * 0.3 };
  });
  const fitted = refineCameraPose({ ...biased, intrinsics, controls, distortion: lens, maxRmsePx: 1, maxErrorPx: 2 });
  assertPose(fitted, 0.4);
  assert.ok(fitted.rmsePx < 0.5);
  const rms = Math.sqrt(fitted.residuals.reduce((sum, residual) => sum + residual.errorPx ** 2, 0) / controls.length);
  assert.ok(Math.abs(rms - fitted.rmsePx) < 1e-10);
});

test("a mismatched landmark is excluded while its original residual remains auditable", () => {
  const controls = points.map((point) => observed(point));
  controls[5] = { ...controls[5], pixelX: controls[5].pixelX + 100, pixelY: controls[5].pixelY - 80 };
  const snapshot = structuredClone(controls);
  const result = refineCameraPose({ ...biased, intrinsics, controls });
  assertPose(result);
  assert.deepEqual(result.outlierIndices, [5]);
  assert.deepEqual(result.inlierIndices, [0, 1, 2, 3, 4, 6, 7]);
  assert.equal(result.residuals.length, controls.length);
  assert.ok(result.residuals[5].errorPx > 128);
  assert.ok(result.rmsePx < 1e-6 && result.allPointsRmsePx > 45);
  assert.equal(result.robust.method, "deterministic-consensus");
  assert.deepEqual(controls, snapshot);
  assert.throws(() => refineCameraPose({ ...biased, intrinsics, controls, robust: false }), /fit failed/);
  assert.deepEqual(refineCameraPose({ ...biased, intrinsics, controls }), result);
});

test("clean noisy controls retain the ordinary solution and no points are silently pruned", () => {
  const controls = points.map((point, index) => {
    const match = observed(point);
    return { ...match, pixelX: match.pixelX + Math.sin(index) * 0.4, pixelY: match.pixelY + Math.cos(index) * 0.4 };
  });
  const robust = refineCameraPose({ ...biased, intrinsics, controls });
  const ordinary = refineCameraPose({ ...biased, intrinsics, controls, robust: false });
  assert.deepEqual(robust, ordinary);
  assert.deepEqual(robust.outlierIndices, []);
  assert.equal(robust.robust.method, "none");
  assert.equal(robust.rmsePx, robust.allPointsRmsePx);
});

test("two mismatches are recoverable with six independent consistent fit points", () => {
  const controls = points.map((point) => observed(point));
  controls[1] = { ...controls[1], pixelX: controls[1].pixelX - 160, pixelY: controls[1].pixelY + 90 };
  controls[5] = { ...controls[5], pixelX: controls[5].pixelX + 100, pixelY: controls[5].pixelY - 80 };
  const result = refineCameraPose({ ...biased, intrinsics, controls });
  assertPose(result);
  assert.deepEqual(result.outlierIndices, [1, 5]);
  assert.equal(result.inlierIndices.length, 6);
});

test("a majority of inconsistent pairs cannot be rescued by a four-point subset", () => {
  const offsets = [[110, -70], [-160, 100], [170, -120], [-130, -110], [200, 80]];
  const controls = points.map((point, index) => {
    const match = observed(point), offset = offsets[index];
    return offset ? { ...match, pixelX: match.pixelX + offset[0], pixelY: match.pixelY + offset[1] } : match;
  });
  assert.throws(() => refineCameraPose({ ...biased, intrinsics, controls }), /no stable consensus/);
});

test("an apparent consensus with only collinear correct landmarks is rejected", () => {
  const controls = [0, 1, 2, 3, 4, 5].map(index => observed({ x: 20 + index * 10, y: 35 + index * 5, z: 0 }));
  const a = observed({ x: 20, y: 85, z: 0 }), b = observed({ x: 80, y: 70, z: 0 });
  controls.push({ ...a, pixelX: a.pixelX + 180, pixelY: a.pixelY - 140 },
    { ...b, pixelX: b.pixelX - 140, pixelY: b.pixelY + 110 });
  assert.throws(() => refineCameraPose({ ...biased, intrinsics, controls, inlierThresholdPx: 2, maxRmsePx: 1, maxErrorPx: 2 }), /fit failed/);
});

test("insufficient, collinear, nearly-collinear and non-finite control sets are rejected", () => {
  const controls = points.map((point) => observed(point));
  assert.throws(() => refineCameraPose({ ...biased, intrinsics, controls: controls.slice(0, 3) }), /4 and 200/);
  const line = [0, 1, 2, 3].map((index) => observed({ x: 25 + index * 10, y: 40 + index * 10, z: 0 }));
  assert.throws(() => refineCameraPose({ ...biased, intrinsics, controls: line }), /collinear/);
  const nearlyLine = line.map((match, index) => ({ ...match, pixelY: match.pixelY + index % 2 * 0.001 }));
  assert.throws(() => refineCameraPose({ ...biased, intrinsics, controls: nearlyLine }), /collinear/);
  const bad: ControlPointMatch[] = [...controls];
  bad[0] = { ...bad[0], world: { x: Number.NaN, y: 0, z: 0 } };
  assert.throws(() => refineCameraPose({ ...biased, intrinsics, controls: bad }), /finite/);
});

test("visibility and total correction bounds prevent invalid or distant pose solutions", () => {
  assert.throws(() => projectControlPoint({
    position: { x: 0, y: 0, z: 100 }, attitude: { yaw: 0, pitch: -90, roll: 0 }, intrinsics,
  }, { x: 0, y: 0, z: 200 }), /behind/);
  assert.throws(() => refineCameraPose({
    ...biased, intrinsics, controls: points.map((point) => observed(point)), maxPositionCorrectionMeters: 1,
    maxRmsePx: 0.01, maxErrorPx: 0.05,
  }), /fit failed/);
});

test("an exact nadir pose stays finite despite Euler yaw-roll redundancy", () => {
  const camera = { position: { x: 10, y: 20, z: 100 }, attitude: { yaw: 0, pitch: -90, roll: 0 }, intrinsics };
  const controls = points.map((world) => ({
    world,
    pixelX: intrinsics.cx + intrinsics.fx * (world.x - 10) / 100,
    pixelY: intrinsics.cy - intrinsics.fy * (world.y - 20) / 100,
  })).filter((point) => point.pixelX >= 0 && point.pixelX <= intrinsics.width && point.pixelY >= 0 && point.pixelY <= intrinsics.height);
  assert.ok(controls.length >= 4);
  const fitted = refineCameraPose({ initialPosition: camera.position, initialAttitude: camera.attitude, intrinsics, controls, maxRmsePx: 0.001 });
  assert.ok(fitted.rmsePx < 1e-8);
});


test("a biased near-nadir DJI pose refines without relying on a unique Euler yaw-roll split", () => {
  const controls = [-20, 0, 20].flatMap((east) => [-20, 20].map((north) => ({
    world: { x: 10 + east, y: 20 + north, z: 0 },
    pixelX: intrinsics.cx + intrinsics.fx * east / 100,
    pixelY: intrinsics.cy - intrinsics.fy * north / 100,
  })));
  const fitted = refineCameraPose({
    initialPosition: { x: 17, y: 14, z: 110 },
    initialAttitude: { yaw: 4, pitch: -85, roll: -3 },
    intrinsics, controls, maxRmsePx: 0.001, maxErrorPx: 0.005,
  });
  assert.ok(Math.abs(fitted.position.x - 10) < 1e-4);
  assert.ok(Math.abs(fitted.position.y - 20) < 1e-4);
  assert.ok(Math.abs(fitted.position.z - 100) < 1e-4);
  assert.ok(fitted.rmsePx < 1e-6);
});


test("six pairs require five consistent points, while a five-pair set cannot discard one", () => {
  const controls = points.slice(0, 6).map(point => observed(point));
  controls[1] = { ...controls[1], pixelX: controls[1].pixelX - 160, pixelY: controls[1].pixelY + 90 };
  const result = refineCameraPose({ ...biased, intrinsics, controls });
  assertPose(result);
  assert.deepEqual(result.outlierIndices, [1]);
  assert.equal(result.robust.minimumInliers, 5);
  assert.throws(() => refineCameraPose({ ...biased, intrinsics, controls: controls.slice(0, 5) }), /fit failed/);
});

test("bounded deterministic sampling recovers a twelve-point set with three mismatches", () => {
  const controls = [...points, { x: 25, y: 40, z: 5 }, { x: 75, y: 65, z: 10 },
    { x: 35, y: 85, z: 12 }, { x: 60, y: 35, z: 5 }].map(point => observed(point));
  for (const index of [2, 9, 10]) controls[index] = { ...controls[index],
    pixelX: controls[index].pixelX + 80 * (index % 2 ? -1 : 1), pixelY: controls[index].pixelY + 90 };
  const result = refineCameraPose({ ...biased, intrinsics, controls, maxRmsePx: 0.5, maxErrorPx: 2 });
  assertPose(result);
  assert.deepEqual(result.outlierIndices, [2, 9, 10]);
  assert.equal(result.robust.hypothesesTested, 161);
  assert.equal(result.robust.minimumInliers, 8);
});
