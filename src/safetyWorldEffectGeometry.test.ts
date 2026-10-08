import test from "node:test";
import assert from "node:assert/strict";
import { Cartesian3, Cartographic, Matrix4, Transforms } from "cesium";
import { selectionOutlinePositions, selectDecorativeTrackRun, splitActualTrackRuns, inspectionDeviceEligible, sceneLabelPixels } from "./safetyWorldEffectGeometry.ts";
import type { SafetyDevice, SafetyNode, SafetyTrackPoint } from "./safetyTypes.ts";

const point = (time: number, segment = 0): SafetyTrackPoint => ({ longitude: 120 + time / 1e8, latitude: 30,
  height: 20 + time / 1000, time, mediaSeconds: time / 1000, segment });
const node = (changes: Partial<SafetyNode> = {}): SafetyNode => ({ id: "real-node", kind: "pier", name: "真实点",
  position: { longitude: 120, latitude: 30, height: 25 }, provenance: "real", description: "", mediaIds: [], ...changes });

test("actual runs preserve every source sample and height, and split gaps, segments and non-increasing time", () => {
  const track = [point(0), point(1000), point(6000), point(12000), point(13000), point(14000, 1), point(15000, 1), point(15000, 1), point(16000, 1)];
  const before = structuredClone(track), runs = splitActualTrackRuns(track, [0, 20000]);
  assert.deepEqual(runs.map(run => run.length), [3, 2, 2, 2]);
  const sourceRuns = [track.slice(0, 3), track.slice(3, 5), track.slice(5, 7), track.slice(7)];
  runs.forEach((run, i) => run.forEach((world, j) => assert.ok(Cartesian3.equals(world,
    Cartesian3.fromDegrees(sourceRuns[i][j].longitude, sourceRuns[i][j].latitude, sourceRuns[i][j].height)))));
  assert.deepEqual(track, before);
});

test("excluded and invalid telemetry cannot create joins across missing data", () => {
  const track = [point(1000), point(2000), point(9000), point(3000), point(4000),
    { ...point(4500), height: NaN }, point(5000), point(6000), { ...point(6500), latitude: 100 }, point(7000)];
  assert.deepEqual(splitActualTrackRuns(track, [1000, 7000]).map(run => run.length), [2, 2, 2]);
  assert.deepEqual(splitActualTrackRuns(track, [7000, 1000]), []);
  assert.deepEqual(splitActualTrackRuns(track, [NaN, 7000]), []);
  assert.deepEqual(splitActualTrackRuns([point(NaN), point(0)], [0, 7000]), []);
});

test("decoration selects a single existing longest run without combining or changing coordinates", () => {
  const runs = splitActualTrackRuns([point(0), point(1000), point(8000), point(9000), point(10000)], [0, 11000]);
  const before = structuredClone(runs);
  assert.equal(selectDecorativeTrackRun(runs), runs[1]);
  assert.deepEqual(structuredClone(runs), before);
  assert.equal(selectDecorativeTrackRun([]), undefined);
  assert.equal(selectDecorativeTrackRun([[new Cartesian3()]]), undefined);
});

test("user boundary outline preserves varying heights plus exactly 0.12 m and closes without mutating source", () => {
  const object = node({ spatialObjectId: "manual-area", boundary: [{ longitude: 120, latitude: 30, height: 9 },
    { longitude: 120.001, latitude: 30, height: 18 }, { longitude: 120.001, latitude: 30.001, height: 33 }] });
  const before = structuredClone(object), positions = selectionOutlinePositions(object, Cartesian3.fromDegrees(0, 0));
  assert.equal(positions.length, 4);
  object.boundary!.forEach((source, index) => {
    assert.ok(Cartesian3.equals(positions[index], Cartesian3.fromDegrees(source.longitude, source.latitude, source.height + 0.12)));
    assert.ok(Math.abs(Cartographic.fromCartesian(positions[index]).height - source.height - 0.12) < 1e-6);
  });
  assert.ok(Cartesian3.equals(positions[0], positions[3]));
  assert.notEqual(positions[0], positions[3]);
  assert.deepEqual(object, before);
});

test("nonspatial selection is a closed local ENU world ring around the supplied center", () => {
  const center = Cartesian3.fromDegrees(121, 31, 70), before = Cartesian3.clone(center), positions = selectionOutlinePositions(node(), center);
  const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(center), new Matrix4());
  assert.equal(positions.length, 65);
  for (const world of positions) {
    const local = Matrix4.multiplyByPoint(inverse, world, new Cartesian3());
    assert.ok(Math.abs(Math.hypot(local.x, local.y) - 15.6) < 1e-7);
    assert.ok(Math.abs(local.z) < 1e-7);
  }
  assert.ok(Cartesian3.equals(positions[0], positions[64]));
  assert.deepEqual(center, before);
});

test("default ring origin offsets only display by 0.6 m and bounds decoration radius", () => {
  for (const [kind, radius, expected] of [["pier", 1, 5], ["section", 1, 7.7], ["project", 1, 22], ["component", 1000, 120]] as const) {
    const object = node({ kind, radius }), before = structuredClone(object), positions = selectionOutlinePositions(object);
    const origin = Cartesian3.fromDegrees(object.position.longitude, object.position.latitude, object.position.height + 0.6);
    assert.ok(Math.abs(Cartesian3.distance(positions[0], origin) - expected) < 1e-7);
    assert.deepEqual(object, before);
  }
});


test("current flight requires the inspection page, selected recording and verified time/position association", () => {
  const device: SafetyDevice = { id: "device-a", nodeId: "node-a", name: "Recorded flight", kind: "drone",
    provenance: "real", status: "replay", mediaId: "recording-a", coordinateNote: "explicit test fixture",
    track: [point(0), point(1000)] };
  const original = structuredClone(device), context = { mediaId: "recording-a", trajectoryValid: true };
  assert.equal(inspectionDeviceEligible(device, "inspection", context), true);
  for (const page of ["overview", "events", "components", undefined] as const) assert.equal(inspectionDeviceEligible(device, page, context), false);
  assert.equal(inspectionDeviceEligible(device, "inspection"), false);
  assert.equal(inspectionDeviceEligible(device, "inspection", { ...context, mediaId: "recording-b" }), false);
  assert.equal(inspectionDeviceEligible(device, "inspection", { ...context, trajectoryValid: false }), false);
  assert.equal(inspectionDeviceEligible(device, "inspection", { ...context, deviceId: "device-b" }), false);
  assert.equal(inspectionDeviceEligible({ ...device, provenance: "demo" }, "inspection", context), false);
  assert.equal(inspectionDeviceEligible({ ...device, track: [point(0), point(8000)] }, "inspection", context), false);
  assert.equal(inspectionDeviceEligible({ ...device, track: [point(0), { ...point(1000), mediaSeconds: NaN }] }, "inspection", context), false);
  assert.deepEqual(device, original, "context changes never trim or rewrite the saved trajectory");
});

test("scene text sizes match selected and large-text collision layout inputs", () => {
  assert.equal(sceneLabelPixels("pier"), 12); assert.equal(sceneLabelPixels("section"), 13);
  assert.equal(sceneLabelPixels("device"), 13); assert.equal(sceneLabelPixels("pier", true), 14);
  assert.equal(sceneLabelPixels("pier", false, true), 14); assert.equal(sceneLabelPixels("section", false, true), 15);
  assert.equal(sceneLabelPixels("component", true, true), 16);
});
