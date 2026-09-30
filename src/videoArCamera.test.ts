import assert from "node:assert/strict";
import test from "node:test";
import {
  cameraDirectionToEnu,
  cameraPixelToEnuDirection,
  distortNormalizedPoint,
  undistortPixel,
  validateCameraIntrinsics,
} from "./videoArCamera.ts";

const intrinsics = { width: 1920, height: 1080, fx: 1200, fy: 1150, cx: 923, cy: 517 };
const zeroAttitude = { yaw: 0, pitch: 0, roll: 0 };

function near(actual: number, expected: number, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test("off-center principal point defines the optical axis without recentering or aspect substitution", () => {
  assert.deepEqual(undistortPixel(intrinsics, 923, 517), { x: 0, y: 0 });
  assert.deepEqual(undistortPixel(intrinsics, 923 + 600, 517 + 230), { x: 0.5, y: 0.2 });
  const center = cameraPixelToEnuDirection(intrinsics, 923, 517, zeroAttitude);
  near(center.x, 0);
  near(center.y, 1);
  near(center.z, 0);
  assert.notDeepEqual(undistortPixel(intrinsics, 960, 540), { x: 0, y: 0 });
});

test("camera rays obey cardinal NED headings and nadir top/right orientation", () => {
  for (const [yaw, east, north] of [[0, 0, 1], [90, 1, 0], [180, 0, -1], [270, -1, 0]]) {
    const ray = cameraDirectionToEnu({ x: 0, y: 0 }, { yaw, pitch: 0, roll: 0 });
    near(ray.x, east);
    near(ray.y, north);
    near(ray.z, 0);
  }
  const nadir = cameraDirectionToEnu({ x: 0, y: 0 }, { yaw: 0, pitch: -90, roll: 0 });
  near(nadir.x, 0);
  near(nadir.y, 0);
  near(nadir.z, -1);
  const topRight = cameraDirectionToEnu({ x: 1, y: -1 }, { yaw: 0, pitch: -90, roll: 0 });
  near(topRight.x, 1 / Math.sqrt(3));
  near(topRight.y, 1 / Math.sqrt(3));
  near(topRight.z, -1 / Math.sqrt(3));
});

test("relative gimbal rotations compose with aircraft bank instead of adding Euler angles", () => {
  const aircraft = { yaw: 0, pitch: 0, roll: 30 };
  const relativeGimbal = { yaw: 90, pitch: -90, roll: 0 };
  const ray = cameraDirectionToEnu({ x: 0, y: 0 }, relativeGimbal, aircraft);
  near(ray.x, -0.5);
  near(ray.y, 0);
  near(ray.z, -Math.sqrt(3) / 2);
  const incorrectlyAdded = cameraDirectionToEnu({ x: 0, y: 0 }, { yaw: 90, pitch: -90, roll: 30 });
  const dot = ray.x * incorrectlyAdded.x + ray.y * incorrectlyAdded.y + ray.z * incorrectlyAdded.z;
  near(Math.acos(dot) * 180 / Math.PI, 30);
});

test("Brown-Conrady forward model matches an independently calculated radial/tangential example", () => {
  const distorted = distortNormalizedPoint(
    { x: 0.4, y: -0.3 },
    { k1: -0.2, k2: 0.05, k3: 0.01, p1: 0.002, p2: -0.001 },
  );
  // r^2=.25; radial=.95328125; dx=-.00105; dy=.00110.
  near(distorted.x, 0.3802625);
  near(distorted.y, -0.284884375);
});

test("inverse radial/tangential distortion recovers rays across all image quadrants", () => {
  const lens = { k1: -0.24, k2: 0.08, k3: 0.015, p1: 0.002, p2: -0.003 };
  for (const x of [-0.8, -0.4, 0, 0.4, 0.8]) {
    for (const y of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const distorted = distortNormalizedPoint({ x, y }, lens);
      const recovered = undistortPixel(
        intrinsics, intrinsics.cx + intrinsics.fx * distorted.x,
        intrinsics.cy + intrinsics.fy * distorted.y, lens,
      );
      near(recovered.x, x);
      near(recovered.y, y);
    }
  }
});

test("pixel rays use inverse lens distortion before pose rotation", () => {
  const lens = { k1: 0.25, k2: 0.04, p1: 0.002, p2: -0.002 };
  const ideal = { x: 0.7, y: -0.4 };
  const distorted = distortNormalizedPoint(ideal, lens);
  const attitude = { yaw: 123, pitch: -55, roll: 7 };
  const ray = cameraPixelToEnuDirection(
    intrinsics, distorted.x * intrinsics.fx + intrinsics.cx,
    distorted.y * intrinsics.fy + intrinsics.cy, attitude, lens,
  );
  const expected = cameraDirectionToEnu(ideal, attitude);
  near(ray.x, expected.x);
  near(ray.y, expected.y);
  near(ray.z, expected.z);
  near(Math.hypot(ray.x, ray.y, ray.z), 1);
});

test("calibration rejects invalid dimensions, coefficients, pixels, angles and folded lens mapping", () => {
  assert.throws(() => validateCameraIntrinsics({ ...intrinsics, fx: 0 }), /positive/);
  assert.throws(() => validateCameraIntrinsics({ ...intrinsics, width: 0 }), /positive/);
  assert.throws(() => validateCameraIntrinsics({ ...intrinsics, cx: Number.NaN }), /finite/);
  assert.throws(() => undistortPixel(intrinsics, Number.NaN, 0), /finite/);
  assert.throws(() => undistortPixel(intrinsics, 923, 517, { k1: Number.POSITIVE_INFINITY }), /finite/);
  assert.throws(() => cameraDirectionToEnu({ x: 0, y: 0 }, { ...zeroAttitude, pitch: Number.NaN }), /finite/);
  assert.throws(() => undistortPixel(
    { width: 4, height: 4, fx: 1, fy: 1, cx: 0, cy: 0 }, 1, 0, { k1: -1 },
  ), /folded|non-invertible|converge/);
});


test("inverse lens mapping rejects an outer root separated from the optical axis by a folded annulus", () => {
  // radial=(1-r^2)^2 becomes invertible again beyond r=1. A local-only
  // Jacobian check can converge there even though rays crossed a fold.
  assert.throws(() => undistortPixel(
    { width: 8, height: 8, fx: 1, fy: 1, cx: 0, cy: 0 },
    2, 0, { k1: -2, k2: 1 },
  ), /folded/);
  const ideal = { x: 1.4, y: 0.3 };
  const lens = { k1: 0.4, k2: 0.1 };
  const observed = distortNormalizedPoint(ideal, lens);
  const recovered = undistortPixel(
    intrinsics, observed.x * intrinsics.fx + intrinsics.cx,
    observed.y * intrinsics.fy + intrinsics.cy, lens,
  );
  near(recovered.x, ideal.x);
  near(recovered.y, ideal.y);
});
