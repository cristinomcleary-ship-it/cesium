import test from "node:test";
import assert from "node:assert/strict";
import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4, Transforms } from "cesium";
import type { CadImportPackage } from "./cadImport.ts";
import type { LibraryListing, LibraryRecord } from "./projectLibrary.ts";
import type { SafetyDevice } from "./safetyTypes.ts";
import { adaptSafetyCadSources, adaptSafetyTrajectory, createSafetyCadConverter, createSafetyDemoDataset, LocalSafetyDataAdapter, safeLibraryUrl } from "./safetyData.ts";
import { interpolateDevicePosition, SafetyStore } from "./safetyStore.ts";

const T = 1_787_127_616_562;
function source(id = "cad-1", updatedAt = "2026-10-07T00:00:00Z") {
  const record: LibraryRecord = { version: 1, id, name: "区段.dwg", kind: "CAD", visible: true, createdAt: updatedAt, updatedAt,
    files: { data: { name: "区段.cadimport", url: `/__library/files/${id}/data/section.cadimport` }, source: { name: "区段.dwg", url: `/__library/files/${id}/source/section.dwg` } },
    settings: { coordinates: { mode: "crs", sourceCrs: "EPSG:4326", heightOffset: 2 }, displayMode: "model" } };
  const cad: CadImportPackage = { format: "cesium-cad-import", version: 2, source: { name: "区段.dwg", format: "DWG", generatedAt: updatedAt },
    statistics: { sourceEntities: 4, displayEntities: 4, skippedEntities: 0, unknownEntities: 0, layers: [] }, warnings: [],
    entities: [
      { type: "TEXT", sourceType: "TEXT", layer: "编号", text: "13-1", vertices: [{ x: 120.89, y: 30.836, z: 4 }] },
      { type: "TEXT", sourceType: "TEXT", layer: "编号", text: "13-2", vertices: [{ x: 120.8901, y: 30.8362, z: 4 }] },
      { type: "TEXT", sourceType: "TEXT", layer: "编号", text: "14-1", vertices: [{ x: 120.891, y: 30.837, z: 4 }] },
      { type: "POINT", sourceType: "POINT", layer: "节点", vertices: [{ x: 120.8, y: 30.8, z: 0 }] },
    ] };
  return { record, cad };
}

function row(time: number, longitude = 120.89) {
  return { source_timestamp_ms: time, video_time_ms: time - T, recorded_at: "2026-08-19T16:20:16.562", position: { longitude, latitude: 30.836, altitude: 99.221, relative_altitude: 70.105 } };
}

test("CAD converter reuses the existing Gauss projection and preserves source height", () => {
  const convert = createSafetyCadConverter({ mode: "gaussKruger", centralMeridian: 120.7833333, ellipsoid: "GRS80", axisOrder: "eastNorth", hasZonePrefix: false, zoneNumber: 40, heightOffset: 3 });
  const point = convert({ x: 500000, y: 0, z: 4 })!;
  assert.ok(Math.abs(point.longitude - 120.7833333) < 1e-9); assert.ok(Math.abs(point.latitude) < 1e-9); assert.equal(point.height, 7);
  assert.equal(convert({ x: NaN, y: 0 }), undefined);
});

test("local CAD converter agrees with the existing ENU transform", () => {
  const options = { mode: "local" as const, longitude: 120, latitude: 30, altitude: 12, referenceX: 100, referenceY: 200, rotation: 90, scale: 2 };
  const value = createSafetyCadConverter(options)({ x: 110, y: 205, z: 3 })!;
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(120, 30, 12));
  const expected = Cartographic.fromCartesian(Matrix4.multiplyByPoint(frame, new Cartesian3(-10, 20, 6), new Cartesian3()));
  assert.ok(Math.abs(value.longitude - CesiumMath.toDegrees(expected.longitude)) < 1e-10);
  assert.ok(Math.abs(value.latitude - CesiumMath.toDegrees(expected.latitude)) < 1e-10);
  assert.ok(Math.abs(value.height - expected.height) < 1e-5);
});

test("CAD navigation retains text entity IDs and distinguishes real anchors from inferred components", () => {
  const input = source(); const before = JSON.stringify(input); const result = adaptSafetyCadSources([input]);
  assert.equal(JSON.stringify(input), before, "source CAD must not be modified");
  assert.equal(result.nodes.filter((node) => node.kind === "section").length, 1);
  assert.equal(result.nodes.filter((node) => node.kind === "pier").length, 2);
  const anchors = result.nodes.filter((node) => node.provenance === "real"); assert.equal(anchors.length, 3);
  assert.deepEqual(anchors.map((node) => node.sourceEntityIndex), [0, 1, 2]);
  assert.ok(anchors.every((node) => node.sourceRecordId === "cad-1" && node.position.height === 6 && node.componentType === "pile"));
  const cap = result.nodes.find((node) => node.componentType === "cap")!;
  assert.equal(cap.provenance, "derived"); assert.equal(cap.modelFeatureId, undefined); assert.match(cap.description, /逻辑/);
  assert.ok(result.nodes.filter((node) => node.boundary).every((node) => node.provenance === "derived"));
});

test("CAD identical imports deduplicate while updated geometry remains distinct", () => {
  const older = source("old", "2026-10-06T00:00:00Z"); const newer = source("new");
  const deduplicated = adaptSafetyCadSources([older, newer]);
  assert.equal(deduplicated.nodes.filter((node) => node.kind === "pier").length, 2);
  assert.ok(deduplicated.nodes.every((node) => node.sourceRecordId === "new"));
  assert.match(deduplicated.notes.join(" "), /已合并重复/);
  older.cad.entities[0].vertices[0].x += .01;
  assert.equal(adaptSafetyCadSources([older, newer]).nodes.filter((node) => node.kind === "pier").length, 4);
});

test("hidden CAD and malformed anchor coordinates never become construction points", () => {
  const hidden = source("hidden"); hidden.record.visible = false;
  const invalid = source("invalid"); invalid.cad.entities.forEach((entity) => { entity.vertices[0].x = Infinity; });
  assert.equal(adaptSafetyCadSources([hidden, invalid]).nodes.length, 0);
});

test("library URLs reject external origins, scripting and path traversal", () => {
  assert.equal(safeLibraryUrl("/__library/files/id/video/flight.mp4"), "/__library/files/id/video/flight.mp4");
  for (const value of ["https://example.com/video.mp4", "javascript:alert(1)", "//evil.test/__library/files/a", "/__library/files/a/../../secret", "/__library/files/a/%2E%2E/%2E%2E/secret", "/__library/files/a/evil%5C..", "/__library/files/a/file?redirect=evil"]) assert.equal(safeLibraryUrl(value), undefined, value);
});

test("trajectory uses absolute timestamps and media time separately and retains every valid coordinate", () => {
  const raw = { source_crs: "EPSG:4326", trajectory_points: [row(T + 33, 120.8901), row(T), row(T + 66, 120.8902)] };
  raw.trajectory_points[0].video_time_ms = 100;
  const before = JSON.stringify(raw); const result = adaptSafetyTrajectory(raw);
  assert.equal(JSON.stringify(raw), before); assert.equal(result.track.length, 3);
  assert.deepEqual(result.track.map((point) => point.time), [T, T + 33, T + 66]);
  assert.equal(result.track[1].mediaSeconds, .1); assert.equal(result.track[0].height, 99.221);
  assert.match(result.coordinateNote, /高程基准未知/); assert.match(result.coordinateNote, /relative_altitude/);
});

test("trajectory rejects relative-only altitude, invalid WGS coordinates and ambiguous local timestamps", () => {
  const relativeOnly = { source_timestamp_ms: T, video_time_ms: 0, position: { longitude: 120, latitude: 30, relative_altitude: 4 } };
  const ambiguous = { ...row(T), source_timestamp_ms: undefined };
  const result = adaptSafetyTrajectory({ trajectory_points: [relativeOnly, { ...row(T), position: { longitude: 200, latitude: 30, altitude: 5 } }] });
  assert.equal(result.track.length, 0);
  assert.equal(adaptSafetyTrajectory({ trajectory_points: [ambiguous] }).track.length, 0);
  assert.equal(adaptSafetyTrajectory({ trajectory_points: [{ ...ambiguous, recorded_at: "2026-08-19T16:20:16.562+08:00" }] }).track.length, 1);
});

test("trajectory cursor does not extrapolate or bridge long missing intervals", () => {
  const track = adaptSafetyTrajectory({ trajectory_points: [row(T), row(T + 1000, 120.9), row(T + 11000, 121)] }).track;
  const device: SafetyDevice = { id: "drone", nodeId: "project", name: "test", kind: "drone", provenance: "real", status: "replay", track, coordinateNote: "test" };
  const middle = interpolateDevicePosition(device, T + 500)!;
  assert.ok(Math.abs(middle.longitude - 120.895) < 1e-10); assert.equal(middle.mediaSeconds, .5);
  assert.equal(interpolateDevicePosition(device, T - 1), undefined); assert.equal(interpolateDevicePosition(device, T + 11001), undefined);
  assert.equal(interpolateDevicePosition(device, T + 5000), undefined);
  assert.notEqual(interpolateDevicePosition(device, T), track[0], "cursor must not expose a mutable source sample");
});

test("store applies identical severity and time filters to alerts, task lists, scene nodes and metrics", () => {
  const dataset = createSafetyDemoDataset(T); const store = new SafetyStore(dataset);
  store.patch({ includeDemo: true, severity: "high" });
  assert.ok(store.view.alerts.length > 0); assert.ok(store.view.alerts.every((alert) => alert.severity === "high"));
  assert.equal(store.view.metrics.alerts, store.view.alerts.length); assert.equal(store.view.metrics.high, store.view.alerts.length);
  assert.ok(store.view.alerts.every((alert) => store.view.nodes.some((node) => node.id === alert.nodeId)));
  assert.ok(store.view.tasks.every((task) => store.view.nodes.some((node) => node.id === task.nodeId)));
  const first = store.view.alerts[0]; store.patch({ timeRange: [first.timestamp + 1, T] });
  assert.ok(!store.view.alerts.some((alert) => alert.id === first.id));
  store.patch({ includeDemo: false }); assert.equal(store.view.alerts.length, 0); assert.equal(store.view.tasks.length, 0); assert.equal(store.view.nodes.length, 0);
});

test("store navigation preserves ancestry and clears filtered selections without duplicate subscriptions", () => {
  const dataset = createSafetyDemoDataset(T); const store = new SafetyStore(dataset); store.patch({ includeDemo: true }); let calls = 0;
  const unsubscribe = store.subscribe(() => calls++); assert.equal(calls, 1);
  const alert = store.view.alerts[0]; store.select({ nodeId: alert.nodeId, alertId: alert.id });
  assert.equal(store.state.selectedAlertId, alert.id); assert.equal(store.view.breadcrumbs.at(-1)?.id, alert.nodeId);
  assert.equal(store.view.breadcrumbs[0].id, dataset.projectId); assert.equal(store.view.alerts.length, 1);
  store.patch({ severity: alert.severity === "high" ? "low" : "high" }); assert.equal(store.state.selectedAlertId, undefined);
  unsubscribe(); const count = calls; store.patch({ severity: "all" }); assert.equal(calls, count);
  store.dispose(); store.patch({ playing: true }); assert.equal(calls, count); assert.equal(store.state.playing, false);
});

test("store clamps time and opacity, repairs reversed range and keeps the source dataset untouched", () => {
  const dataset = createSafetyDemoDataset(T); const before = JSON.stringify(dataset); const store = new SafetyStore(dataset);
  store.patch({ timeRange: [T + 100, T - 100], time: T + 500, heatOpacity: 9 });
  assert.deepEqual(store.state.timeRange, [T - 100, T]); assert.equal(store.state.time, T); assert.equal(store.state.heatOpacity, 1);
  store.setDataset(createSafetyDemoDataset(T + 10000)); assert.equal(store.state.time, T + 10000 - 86_400_000);
  assert.equal(JSON.stringify(dataset), before);
});

test("adapter reads the active video only, produces real CAD linkage, and never invents a railway", async () => {
  const cad = source(); const video = (id: string): LibraryRecord => ({ version: 1, id, name: id, kind: "Drone Video", visible: true,
    createdAt: "2026-10-07", updatedAt: "2026-10-07", settings: {}, files: {
      source: { name: "track.json", url: `/__library/files/${id}/source/track.json` }, video: { name: "flight.mp4", url: `/__library/files/${id}/video/flight.mp4` },
    } });
  const listing: LibraryListing = { records: [cad.record, video("inactive"), video("active")], problems: [],
    view: { position: [], direction: [], up: [], basemap: "satellite", activeVideoId: "active" } };
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => { const url = String(input); requested.push(url);
    return new Response(JSON.stringify(url === "/__library/records" ? listing : url.includes("cad-1") ? cad.cad : { source_crs: "EPSG:4326", trajectory_points: [row(T), row(T + 1000)] }), { status: 200 }); };
  const dataset = await new LocalSafetyDataAdapter(fetcher).load();
  assert.equal(dataset.devices.length, 1); assert.equal(dataset.devices[0].id, "drone:active");
  assert.ok(!requested.some((url) => url.includes("inactive"))); assert.deepEqual(dataset.timeExtent, [T, T + 1000]);
  assert.equal(dataset.media.find(m => m.id === "video:active")?.recordedAt, T);
  assert.equal(dataset.media.find(m => m.id === "video:inactive")?.recordedAt, undefined);
  assert.equal(dataset.railway, undefined); assert.deepEqual(dataset.alerts, []); assert.deepEqual(dataset.tasks, []); assert.ok(dataset.media.some(m => m.id === "video:inactive"));
  assert.ok(dataset.media.some((media) => media.kind === "video" && media.relation === "project" && /取景/.test(media.note)));
  assert.ok(dataset.nodes.some((node) => node.provenance === "real" && node.sourceEntityIndex === 0));
});

test("adapter reports unavailable data without seeding production demo objects and respects abort", async () => {
  const fetcher: typeof fetch = async () => { throw new Error("unavailable"); };
  await assert.rejects(new LocalSafetyDataAdapter(fetcher).load(), /工程资料暂不可用/);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(new LocalSafetyDataAdapter(fetcher).load(controller.signal), /cancelled/);
});


test("invalid trajectory samples create a break even when the missing interval is short", () => {
  const result = adaptSafetyTrajectory({ trajectory_points: [row(T), { ...row(T + 33), position: { longitude: null, latitude: 30, altitude: 9 } }, row(T + 66)] });
  assert.equal(result.track.length, 2);
  assert.notEqual(result.track[0].segment, result.track[1].segment);
  const device: SafetyDevice = { id: "gap", nodeId: "project", name: "gap", kind: "drone", provenance: "real", status: "replay", track: result.track, coordinateNote: "test" };
  assert.equal(interpolateDevicePosition(device, T + 33), undefined);
});

test("explicit flight timezone makes local recorded_at usable without browser timezone guessing", () => {
  const sample = { ...row(T), source_timestamp_ms: undefined };
  const result = adaptSafetyTrajectory({ flight_info: { timezone: "+08:00" }, trajectory_points: [sample] });
  assert.equal(result.track[0].time, Date.parse("2026-08-19T16:20:16.562+08:00"));
});

test("a narrow time window retains a real device if a continuous measured segment crosses it", () => {
  const dataset = createSafetyDemoDataset(T);
  dataset.timeExtent = [T, T + 1000];
  dataset.devices = [{ id: "device", nodeId: dataset.projectId, name: "real drone", kind: "drone", status: "replay", provenance: "real", coordinateNote: "test",
    track: adaptSafetyTrajectory({ trajectory_points: [row(T), row(T + 1000)] }).track }];
  const store = new SafetyStore(dataset); store.patch({ timeRange: [T + 400, T + 600] });
  assert.equal(store.view.devices.length, 1);
});


test("default adapter binds native fetch to its global receiver instead of the adapter instance", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function (this: unknown, input: string | URL | Request): Promise<Response> {
    assert.equal(this, globalThis, "browser native fetch requires the Window/global receiver");
    assert.equal(String(input), "/__library/records");
    calls++;
    return new Response(JSON.stringify({ records: [], problems: [] }), { status: 200 });
  };
  try {
    const data = await new LocalSafetyDataAdapter().load();
    assert.equal(calls, 1);
    assert.ok(!data.sourceNotes.some((note) => note.includes("资料库暂不可读")));
  } finally {
    globalThis.fetch = original;
  }
});
