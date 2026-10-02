import assert from "node:assert/strict";
import test from "node:test";
import { projectControlPointCpu, reprojectControlPointSessionCpu } from "./videoArCpuReprojection.ts";
import { projectControlPoint, type ControlPointCamera, type PoseRefinementResult } from "./videoArControlPoints.ts";
import { makeControlPointSession } from "./videoArControlPointSession.ts";

const k = { width: 3840, height: 2160, fx: 1000, fy: 1200, cx: 1000, cy: 900 };
const camera: ControlPointCamera = { position: { x: 0, y: 0, z: 0 }, attitude: { yaw: 0, pitch: 0, roll: 0 }, intrinsics: k };
const near = (value: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} != ${expected}`);

test("CPU analytic axes: north-facing image right is east, down is negative up", () => {
  assert.deepEqual(projectControlPointCpu(camera, { x: 0, y: 100, z: 0 }), { pixelX: 1000, pixelY: 900, depth: 100 });
  assert.deepEqual(projectControlPointCpu(camera, { x: 20, y: 100, z: -10 }), { pixelX: 1200, pixelY: 1020, depth: 100 });
  const east = projectControlPointCpu({ ...camera, attitude: { yaw: 90, pitch: 0, roll: 0 } }, { x: 100, y: -20, z: -10 });
  near(east.pixelX, 1200); near(east.pixelY, 1020); near(east.depth, 100);
  const nadir = projectControlPointCpu({ ...camera, attitude: { yaw: 0, pitch: -90, roll: 0 } }, { x: 20, y: -10, z: -100 });
  near(nadir.pixelX, 1200); near(nadir.pixelY, 1020); near(nadir.depth, 100);
});

test("CPU quarter-roll with off-center principal point and all Brown-Conrady terms has analytic pixels", () => {
  const c = { ...camera, attitude: { yaw: 0, pitch: 0, roll: 90 }, distortion: { k1: -0.1, k2: 0.03, k3: 0.002, p1: 0.004, p2: -0.003 } };
  // FRD after inverse 90-degree roll is [100, 10, -20], hence x=.1, y=-.2.
  const p = projectControlPointCpu(c, { x: 20, y: 100, z: -10 });
  const radial = 1 - 0.1 * 0.05 + 0.03 * 0.0025 + 0.002 * 0.000125;
  near(p.pixelX, 1000 + 1000 * (0.1 * radial - 0.00016 - 0.00021));
  near(p.pixelY, 900 + 1200 * (-0.2 * radial + 0.00052 + 0.00012));
});

test("independent CPU matrices cross-check production projections for oblique poses, translations and lens distortion", () => {
  for (const attitude of [{ yaw: -30, pitch: -30, roll: 0 }, { yaw: 723, pitch: -55, roll: 14 }, { yaw: -131, pitch: -77, roll: -9 }]) {
    const c = { position: { x: 20, y: -30, z: 120 }, attitude, intrinsics: k,
      distortion: { k1: -0.12, k2: 0.03, k3: 0.001, p1: -0.001, p2: 0.003 } };
    for (const world of [{ x: 10, y: 20, z: 0 }, { x: 50, y: 50, z: 10 }, { x: -20, y: 70, z: -15 }]) {
      const expected = projectControlPoint(c, world), actual = projectControlPointCpu(c, world);
      near(actual.pixelX, expected.pixelX, 1e-8); near(actual.pixelY, expected.pixelY, 1e-8); near(actual.depth, expected.depth, 1e-10);
    }
  }
});

test("CPU rejects behind-camera, singular-depth and non-finite inputs", () => {
  assert.throws(() => projectControlPointCpu(camera, { x: 0, y: -10, z: 0 }), /behind/);
  assert.throws(() => projectControlPointCpu(camera, { x: 0, y: 0, z: 0 }), /behind/);
  assert.throws(() => projectControlPointCpu(camera, { x: Infinity, y: 10, z: 0 }), /finite/);
  assert.throws(() => projectControlPointCpu({ ...camera, attitude: { yaw: NaN, pitch: 0, roll: 0 } }, { x: 0, y: 10, z: 0 }), /finite/);
  assert.throws(() => projectControlPointCpu({ ...camera, intrinsics: { ...k, fx: 0 } }, { x: 0, y: 10, z: 0 }), /intrinsics/);
  assert.throws(() => projectControlPointCpu({ ...camera, distortion: { k1: NaN } }, { x: 0, y: 10, z: 0 }), /finite/);
});

function fixture() {
  const solution: PoseRefinementResult = { position: { x: 10, y: 0, z: 0 }, attitude: camera.attitude,
    rmsePx: 0, maxErrorPx: 0, residuals: [], iterations: 1, inlierIndices: [1], outlierIndices: [0],
    allPointsRmsePx: 0, allPointsMaxErrorPx: 0,
    robust: { method: "deterministic-consensus", thresholdPx: 8, minimumInliers: 1, hypothesesTested: 1 } };
  return makeControlPointSession({ frame: { originEcef: { x: 6378137, y: 0, z: 0 }, frameTime: 10.01, attitude: camera.attitude, intrinsics: k },
    points: [
      { role: "fit", pixelX: 1020, pixelY: 900, world: { x: 0, y: 100, z: 0 }, worldEcef: { x: 6378137, y: 0, z: 100 } },
      { role: "check", pixelX: 1010, pixelY: 900, world: { x: 0, y: 100, z: 0 }, worldEcef: { x: 6378137, y: 0, z: 100 } },
      { role: "fit", pixelX: 1040, pixelY: 900, world: { x: 0, y: 100, z: 0 }, worldEcef: { x: 6378137, y: 0, z: 100 } },
      { role: "check", pixelX: 1000, pixelY: 900, world: { x: 0, y: -10, z: 0 }, worldEcef: { x: 6378137, y: 0, z: -10 } },
    ], solution });
}

test("CPU session report recomputes before/after, maps fit-subset indices and never discards an invalid check", () => {
  const session = fixture();
  session.points[0].before.errorPx = 99999; // Saved solver/session residuals must not be trusted.
  const snapshot = structuredClone(session), report = reprojectControlPointSessionCpu(session);
  assert.deepEqual(session, snapshot);
  assert.equal(report.acceptance, "not-validated");
  assert.equal(report.image.scale, 0.5);
  assert.deepEqual(report.points.map(point => point.fitInputIndex), [0, null, 1, null]);
  assert.deepEqual(report.points.map(point => point.fitMembership), ["outlier", "not-fit", "inlier", "not-fit"]);
  assert.equal(report.points[0].before.errorPx, 20);
  near(report.summary.before.original.fitAll.rmsePx!, Math.sqrt(1000));
  assert.equal(report.summary.before.original.fitInliers.rmsePx, 40);
  assert.equal(report.summary.after!.normalized1080.fitInliers.rmsePx, 70);
  assert.deepEqual(report.summary.after!.original.checks, { count: 2, validCount: 1, invalidCount: 1, rmsePx: null, p95Px: null, maxErrorPx: null });
  assert.equal(report.points[3].after!.valid, false);
  assert.match(report.points[3].after!.reason!, /behind/);
  assert.equal(report.points[1].after!.errorPx1080, 55);
  assert.notStrictEqual(report.cameras.before.attitude, session.frame.attitude);
  assert.notStrictEqual(report.cameras.before.intrinsics, session.frame.intrinsics);
  assert.deepEqual(session, snapshot);
});

test("unsolved sessions retain all observations without inventing inliers or after-camera statistics", () => {
  const session = fixture(); session.solution = null;
  const report = reprojectControlPointSessionCpu(session);
  assert.equal(report.summary.after, null);
  assert.equal(report.points.length, 4);
  assert.equal(report.summary.before.original.fitInliers.count, 0);
  assert.equal(report.summary.before.original.fitInliers.rmsePx, null);
  assert.ok(report.points.every(point => point.after === null));
  assert.equal(report.points[0].fitMembership, "unclassified");
});
