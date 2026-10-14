import test from "node:test";
import assert from "node:assert/strict";
import { unprojectLocalToWgs84 } from "./railSafetyGeometry.ts";
import { evaluateRailSafetyPositioning, RailSafetyPositioningStore, validateRailSafetyPositionSample } from "./railSafetyPositioning.ts";
import { validateRailSafetyDefinition } from "./railSafetyValidation.ts";
import type { RailSafetyGuard, RailSafetyPositionSample, RailSafetyRecord } from "./railSafetyTypes.ts";

const now = Date.parse("2026-10-14T08:00:00Z");
const origin = { longitude: 121.4, latitude: 31.2, height: 10 };
const point = (x: number, y: number) => unprojectLocalToWgs84({ x, y }, origin);
const polygon = [point(0, 0), point(20, 0), point(20, 20), point(0, 20)];
const guard = (): RailSafetyGuard => ({ schemaVersion: 1, kind: "guard", station: point(10, 10), resourceIds: [], polygon: [point(-100, -100), point(100, -100), point(100, 100), point(-100, 100)], workArea: { polygon: structuredClone(polygon), deviceId: "tracker:01" } });
const sample = (x = 10, y = 10, patch: Partial<RailSafetyPositionSample> = {}): RailSafetyPositionSample => ({ projectId: "project:A", deviceId: "tracker:01", coordinateSystem: "WGS84", position: point(x, y), timestamp: new Date(now).toISOString(), accuracyMeters: 0.2, source: "simulated", ...patch });
const evaluate = (s: RailSafetyPositionSample | undefined, g = guard()) => evaluateRailSafetyPositioning(g, s, { projectId: "project:A", now });
const record = (id = "guard:1", projectId = "project:A"): RailSafetyRecord => ({ id, projectId, name: id, status: "active", revision: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), createdBy: "owner", definition: guard() });

test("independent work area screens horizontal uncertainty without changing responsibility area", () => {
  const g = guard(), original = structuredClone(g);
  assert.equal(evaluate(sample()).state, "inside");
  const outside = evaluate(sample(30, 10));
  assert.equal(outside.state, "outside"); assert.equal(outside.isAlarm, true);
  assert.equal(outside.source, "simulated"); assert.ok(outside.boundaryDistanceMeters! > 9.9);
  assert.equal(evaluate(sample(30, 10, { source: "measured" })).source, "measured");
  assert.equal(evaluate(sample(19.9, 10)).state, "uncertain");
  assert.equal(evaluate(sample(20.1, 10)).state, "uncertain");
  assert.equal(evaluate(sample(20, 10, { accuracyMeters: 0 })).state, "uncertain");
  assert.equal(evaluate(sample(10, 10, { accuracyMeters: 15 })).state, "uncertain");
  assert.equal(evaluate(sample(10, 10, { position: { ...point(10, 10), height: 500 } })).state, "inside", "height does not change a horizontal geofence");
  assert.deepEqual(g, original);
});

test("missing binding, missing fix, duplicate binding and stale clocks never report inside", () => {
  const unconfigured = guard(); delete unconfigured.workArea;
  assert.equal(evaluate(sample(), unconfigured).state, "unconfigured");
  const noDevice = guard(); delete noDevice.workArea!.deviceId;
  assert.equal(evaluate(sample(), noDevice).state, "unconfigured");
  assert.equal(evaluate(undefined).state, "no-fix");
  assert.equal(evaluate(sample(10, 10, { projectId: "project:B" })).state, "no-fix");
  assert.equal(evaluate(sample(10, 10, { deviceId: "tracker:02" })).state, "no-fix");
  assert.equal(evaluate(sample(10, 10, { timestamp: new Date(now - 30_000).toISOString() })).state, "stale");
  const short = guard(); short.workArea!.staleAfterSeconds = 5;
  assert.equal(evaluate(sample(10, 10, { timestamp: new Date(now - 5000).toISOString() }), short).state, "stale");
  assert.equal(evaluate(sample(10, 10, { timestamp: new Date(now + 6000).toISOString() })).state, "uncertain");
  assert.equal(evaluateRailSafetyPositioning(guard(), sample(), { projectId: "project:A", now, duplicateBinding: true }).state, "unconfigured");
});

test("sample boundary rejects guessed coordinates, precision, source, identities and invalid dates", () => {
  for (const patch of [
    { coordinateSystem: "GCJ02" }, { coordinateSystem: "BD09" }, { coordinateSystem: undefined },
    { accuracyMeters: undefined }, { accuracyMeters: -1 }, { accuracyMeters: Infinity },
    { source: undefined }, { source: "gps" }, { deviceId: "" }, { projectId: "A/B" },
    { timestamp: "2026-10-14T08:00:00" }, { timestamp: "2026-02-30T08:00:00Z" },
    { position: { longitude: 181, latitude: 31, height: 0 } }, { unexpected: true },
  ]) assert.throws(() => validateRailSafetyPositionSample({ ...sample(), ...patch }));
  const zoned = validateRailSafetyPositionSample(sample(10, 10, { timestamp: "2026-10-14T16:00:00+08:00" }));
  assert.equal(zoned.timestamp, new Date(now).toISOString());
  const wrongSystem = sample() as unknown as Record<string, unknown>; wrongSystem.coordinateSystem = "GCJ02";
  assert.equal(evaluate(wrongSystem as unknown as RailSafetyPositionSample).state, "uncertain");
  assert.equal(evaluate(sample(0, 0, { position: { longitude: -50, latitude: 0, height: 0 } })).state, "uncertain", "out-of-range geometry is not treated as healthy");
});

test("work area validation preserves schema 1 and independently rejects bad work polygons/config", () => {
  const legacy = guard(); delete legacy.workArea;
  assert.deepEqual(validateRailSafetyDefinition(legacy), legacy);
  assert.deepEqual(validateRailSafetyDefinition(guard()), guard());
  for (const workArea of [
    { polygon: polygon.slice(0, 2) }, { polygon, deviceId: "" }, { polygon, staleAfterSeconds: 0 },
    { polygon, staleAfterSeconds: 3601 }, { polygon, enabled: true }, null,
  ]) assert.throws(() => validateRailSafetyDefinition({ ...guard(), workArea }));
});

test("concave and dateline work areas use actual polygon membership", () => {
  const concave = guard(); concave.workArea!.polygon = [point(0, 0), point(20, 0), point(20, 20), point(10, 10), point(0, 20)];
  assert.equal(evaluate(sample(10, 17), concave).state, "outside");
  assert.equal(evaluate(sample(5, 5), concave).state, "inside");
  const dateline = guard();
  dateline.workArea!.polygon = [{ longitude: 179.9999, latitude: 0, height: 0 }, { longitude: -179.9999, latitude: 0, height: 0 }, { longitude: -179.9999, latitude: 0.0002, height: 0 }, { longitude: 179.9999, latitude: 0.0002, height: 0 }];
  assert.equal(evaluate(sample(0, 0, { position: { longitude: 180, latitude: 0.0001, height: 0 } }), dateline).state, "inside");
});

test("ingest isolates project/device, rejects replay and preserves samples against caller mutation", () => {
  const store = new RailSafetyPositioningStore(() => now), a = record(), b = record("guard:1", "project:B");
  const first = sample(), result = store.ingest(first);
  first.position.longitude = 0; result.position.latitude = 0;
  assert.equal(store.evaluate(a, [a]).state, "inside");
  assert.equal(store.evaluate(b, [b]).state, "no-fix");
  store.ingest(sample(30, 10, { projectId: "project:B" }));
  assert.equal(store.evaluate(b, [b]).state, "outside");
  assert.equal(store.evaluate(a, [a]).state, "inside");
  assert.throws(() => store.ingest(sample()), /重复|乱序/);
  assert.throws(() => store.ingest(sample(30, 10, { timestamp: new Date(now - 1).toISOString() })), /重复|乱序/);
  assert.throws(() => store.ingest(sample(10, 10, { timestamp: new Date(now + 6000).toISOString() })), /超前/);
  const copy = store.getSample("project:A", "tracker:01")!; copy.position.longitude = 0;
  assert.equal(store.evaluate(a, [a]).state, "inside");
  assert.equal(store.evaluate(a, [a], now + 30_000).state, "stale");
  assert.equal(store.evaluate(a, [a, record("guard:2")]).state, "unconfigured");
  assert.equal(store.evaluate(a, [a, { ...record("guard:2"), status: "deleted" }]).state, "inside");
  store.removeSample("project:A", "tracker:01", "measured");
  assert.equal(store.evaluate(a, [a]).state, "inside", "source-limited removal leaves the other source intact");
  store.removeSample("project:B", "tracker:01", "simulated");
  assert.equal(store.evaluate(b, [b]).state, "no-fix");
  store.ingest(sample(30, 10, { projectId: "project:B", source: "measured" }));
  store.removeSample("project:B", "tracker:01", "simulated");
  assert.equal(store.evaluate(b, [b]).source, "measured", "ending simulation cannot clear a measured fix");
  store.clearProject("project:A"); assert.equal(store.evaluate(a, [a]).state, "no-fix");
  assert.equal(store.evaluate(b, [b]).state, "outside");
  store.clear(); assert.equal(store.evaluate(b, [b]).state, "no-fix");
});

test("simulation cannot hide measured alerts and a simulation clock cannot block a measured fix", () => {
  const store = new RailSafetyPositioningStore(() => now), a = record();
  store.ingest(sample(30, 10, { source: "measured" }));
  assert.throws(() => store.ingest(sample(10, 10, { timestamp: new Date(now + 1000).toISOString() })), /模拟不能覆盖实测/);
  assert.equal(store.evaluate(a, [a]).state, "outside");
  assert.equal(store.evaluate(a, [a]).source, "measured");
  store.removeSample("project:A", "tracker:01", "simulated");
  assert.equal(store.evaluate(a, [a]).isAlarm, true, "ending simulation does not clear a measured alert");
  const separate = new RailSafetyPositioningStore(() => now);
  separate.ingest(sample(10, 10, { timestamp: new Date(now + 4000).toISOString() }));
  separate.ingest(sample(30, 10, { source: "measured" }));
  assert.equal(separate.evaluate(a, [a]).state, "outside");
  assert.equal(separate.evaluate(a, [a]).source, "measured");
  assert.throws(() => separate.ingest(sample(10, 10, { source: "measured", timestamp: new Date(now - 1000).toISOString() })), /重复|乱序/);
});
