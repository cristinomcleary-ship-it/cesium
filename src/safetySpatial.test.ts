import test from "node:test";
import assert from "node:assert/strict";
import { createSafetyDemoDataset } from "./safetyData.ts";
import { mergeSpatialDataset, spatialReplayTimeAt, SPATIAL_REPLAY_TOLERANCE_MS } from "./safetySpatialData.ts";
import { SafetySpatialError, SafetySpatialRepository } from "./safetySpatialRepository.ts";
import { spatialFixture, spatialSnapshot } from "./safetySpatial.testFixtures.ts";
import { emptySpatialSnapshot, validateSpatialMutation, validateSpatialObject, validateSpatialSnapshot } from "./safetySpatialValidation.ts";

test("spatial validation preserves clicked geometry, source heights and explicit confirmation", () => {
  for (const kind of ["construction-area", "railway", "risk-point"] as const) {
    const object = spatialFixture(kind); const original = JSON.stringify(object); const result = validateSpatialObject(object);
    assert.deepEqual(result, object); assert.equal(JSON.stringify(object), original); assert.notEqual(result, object);
    assert.equal(result.source.heightDatum, "unknown"); assert.equal(result.source.vertices[0].sourceHeight, 12);
  }
});

test("polygon validation rejects self intersections, zero area and duplicate closure", () => {
  const crossed = spatialFixture();
  assert.equal(crossed.geometry.type, "Polygon"); if (crossed.geometry.type !== "Polygon") return;
  [crossed.geometry.positions[1], crossed.geometry.positions[2]] = [crossed.geometry.positions[2], crossed.geometry.positions[1]];
  assert.throws(() => validateSpatialObject(crossed), /自交/);
  const flat = spatialFixture(); if (flat.geometry.type !== "Polygon") return;
  flat.geometry.positions.forEach((point, index) => { point.latitude = 30.836; point.longitude = 120.89 + index * .001; });
  assert.throws(() => validateSpatialObject(flat), /共线|自交/);
  const closed = spatialFixture(); if (closed.geometry.type !== "Polygon") return;
  closed.geometry.positions.push({ ...closed.geometry.positions[0] }); closed.source.vertices.push({ ...closed.source.vertices[0] });
  assert.throws(() => validateSpatialObject(closed), /重复首点/);
});

test("geometry/source mismatches, invalid coordinates and dangerous identifiers are rejected", () => {
  const object = spatialFixture(); object.source.vertices.pop(); assert.throws(() => validateSpatialObject(object), /一一对应/);
  const nan = spatialFixture("risk-point"); if (nan.geometry.type !== "Point") return;
  nan.geometry.position.height = NaN; assert.throws(() => validateSpatialObject(nan), /高程/);
  assert.throws(() => validateSpatialObject({ ...spatialFixture(), id: "../../view" }), /编号/);
  assert.throws(() => validateSpatialObject({ ...spatialFixture(), confirmation: { status: "draft" } }), /确认/);
  assert.throws(() => validateSpatialObject({ ...spatialFixture("railway"), geometry: { type: "Point", position: { longitude: 120, latitude: 30, height: 0 } } }), /不匹配/);
});

test("railway corridor uses positive total width and can also be a user polygon", () => {
  const corridor = spatialFixture("railway"); if (corridor.geometry.type !== "Corridor") return;
  corridor.geometry.widthMeters = 0; assert.throws(() => validateSpatialObject(corridor), /总宽度/);
  const polygon = { ...spatialFixture(), kind: "railway" as const }; assert.equal(validateSpatialObject(polygon).geometry.type, "Polygon");
});

test("replay risks require explicit media binding and field entries cannot borrow replay timestamps", () => {
  const risk = spatialFixture("risk-point"); risk.risk!.observationSource = "replay-review";
  assert.throws(() => validateSpatialObject(risk), /选择关联视频/);
  risk.risk!.videoId = "video:one"; risk.risk!.mediaSeconds = 4;
  assert.throws(() => validateSpatialObject(risk), /选择关联视频/);
  risk.linkedMediaIds = ["video:one"]; assert.equal(validateSpatialObject(risk).risk?.mediaSeconds, 4);
  risk.risk!.observationSource = "field-entry"; assert.throws(() => validateSpatialObject(risk), /历史视频时标/);
});

test("snapshot validation rejects duplicate IDs and unsupported versions without dropping bad objects", () => {
  const one = spatialFixture();
  assert.throws(() => validateSpatialSnapshot(spatialSnapshot(one, one)), /重复编号/);
  assert.throws(() => validateSpatialSnapshot({ ...spatialSnapshot(one), version: 2 }), /版本/);
  assert.throws(() => validateSpatialMutation({ operation: "delete", id: one.id, mutationId: "ok", expectedRevision: -1 }), /版本号/);
});

test("merge adds user hierarchy and risks without changing original engineering data or fabricating media", () => {
  const base = createSafetyDemoDataset(Date.parse("2026-08-19T08:20:16Z"));
  base.railway = { positions: [{ longitude: 120, latitude: 30, height: 5 }, { longitude: 120.01, latitude: 30.01, height: 6 }], provenance: "real", note: "original" };
  const area = spatialFixture(), rail = spatialFixture("railway", "rail"), risk = spatialFixture("risk-point", "risk");
  risk.areaId = area.id; risk.railwayId = rail.id;
  const before = JSON.stringify(base); const merged = mergeSpatialDataset(base, spatialSnapshot(area, rail, risk));
  assert.equal(JSON.stringify(base), before); assert.equal(merged.railway, base.railway);
  const point = merged.nodes.find((node) => node.id === "spatial:risk")!;
  assert.equal(point.parentId, "spatial:area-one"); assert.equal(point.provenance, "user"); assert.equal(point.componentType, undefined);
  assert.deepEqual(point.position, risk.geometry.type === "Point" ? risk.geometry.position : undefined);
  assert.deepEqual(point.mediaIds, []);
  const alert = merged.alerts.find((entry) => entry.id === "spatial-alert:risk")!;
  assert.equal(alert.provenance, "user"); assert.equal(alert.timestamp, risk.risk?.observedAt); assert.equal(alert.mediaSeconds, undefined);
  assert.equal(merged.timeExtent[1], risk.risk!.observedAt); assert.match(point.description, /高程基准未知/);
});

test("merge preserves missing-link warnings and refuses hidden/foreign objects instead of guessing matches", () => {
  const base = createSafetyDemoDataset(); const area = spatialFixture(); area.visible = false;
  const risk = spatialFixture("risk-point", "risk"); risk.areaId = area.id; risk.linkedNodeIds = ["removed-node"]; risk.linkedMediaIds = ["removed-media"];
  const foreign = spatialFixture("railway", "foreign"); foreign.projectId = "another-project";
  const merged = mergeSpatialDataset(base, spatialSnapshot(area, risk, foreign));
  assert.equal(merged.nodes.some((node) => node.id === "spatial:area-one"), false);
  assert.equal(merged.nodes.some((node) => node.id === "spatial:foreign"), false);
  assert.equal(merged.nodes.find((node) => node.id === "spatial:risk")?.parentId, base.projectId);
  assert.match(merged.sourceNotes.join(" "), /关联对象失效/); assert.match(merged.sourceNotes.join(" "), /关联资料失效/);
  assert.deepEqual(merged.nodes.find((node) => node.id === "spatial:risk")?.mediaIds, []);
});

test("replay merge only enables explicit valid media time, leaving unverified associations disclosed", () => {
  const base = createSafetyDemoDataset(); const risk = spatialFixture("risk-point", "risk");
  base.media = [{ id: "video:one", kind: "video", name: "recorded.mp4", url: "/__library/files/one/video/recorded.mp4", provenance: "real", relation: "project", note: "project only" }];
  base.devices = [{ id: "device", name: "drone", nodeId: base.projectId, kind: "drone", provenance: "real", status: "replay", coordinateNote: "unknown datum",
    mediaId: "video:one", track: [{ longitude: 120, latitude: 30, height: 80, time: 100000, mediaSeconds: 0 }, { longitude: 120.1, latitude: 30, height: 80, time: 110000, mediaSeconds: 10 }] }];
  risk.risk = { ...risk.risk!, observationSource: "replay-review", videoId: "video:one", mediaSeconds: 4, observedAt: 104000 }; risk.linkedMediaIds = ["video:one"];
  assert.equal(mergeSpatialDataset(base, spatialSnapshot(risk)).alerts.at(-1)?.mediaSeconds, 4);
  risk.risk.mediaSeconds = 12;
  const invalid = mergeSpatialDataset(base, spatialSnapshot(risk));
  assert.equal(invalid.alerts.at(-1)?.mediaSeconds, undefined); assert.match(invalid.sourceNotes.join(" "), /无法核对/);
});

test("repository binds native fetch receiver and reports revision conflicts with the latest snapshot", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async function (this: unknown) { assert.equal(this, globalThis); calls++; return new Response(JSON.stringify(emptySpatialSnapshot())); };
  try { assert.equal((await new SafetySpatialRepository().load()).revision, 0); assert.equal(calls, 1); } finally { globalThis.fetch = original; }
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ code: "REVISION_CONFLICT", error: "changed", snapshot: spatialSnapshot(spatialFixture()) }), { status: 409 });
  await assert.rejects(new SafetySpatialRepository(fetcher).upsert(spatialFixture(), 0), (error: unknown) => error instanceof SafetySpatialError && error.status === 409 && error.snapshot?.revision === 1);
});

test("repository retry reuses the same mutation ID and refuses malformed success responses", async () => {
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); if (bodies.length === 1) throw new TypeError("connection lost after commit"); return new Response(JSON.stringify(spatialSnapshot(spatialFixture()))); };
  const result = await new SafetySpatialRepository(fetcher).upsert(spatialFixture(), 0);
  assert.equal(result.revision, 1); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  const malformed: typeof fetch = async () => new Response(JSON.stringify({ version: 999, objects: [] }));
  await assert.rejects(new SafetySpatialRepository(malformed).load(), (error: unknown) => error instanceof SafetySpatialError && error.code === "INVALID_RESPONSE");
});


test("invalid JSON error payloads still produce the typed repository error", async () => {
  const fetcher: typeof fetch = async () => new Response("null", { status: 500 });
  await assert.rejects(new SafetySpatialRepository(fetcher).load(), (error: unknown) => error instanceof SafetySpatialError && error.code === "SERVER_ERROR");
});


function replayRiskContext() {
  const base = createSafetyDemoDataset(); const risk = spatialFixture("risk-point", "time-risk");
  base.media = [{ id: "video:clock", kind: "video", name: "original.mp4", url: "/__library/files/clock/video/original.mp4", provenance: "real", relation: "project", note: "项目参考" }];
  base.devices = [{ id: "clock-device", name: "drone", nodeId: base.projectId, kind: "drone", provenance: "real", status: "replay", coordinateNote: "unknown datum", mediaId: "video:clock",
    track: [{ longitude: 120, latitude: 30, height: 80, time: 100000, mediaSeconds: 0 }, { longitude: 120.1, latitude: 30, height: 80, time: 110000, mediaSeconds: 10 }] }];
  risk.risk = { ...risk.risk!, observationSource: "replay-review", videoId: "video:clock", mediaSeconds: 4, observedAt: 104000 };
  risk.linkedMediaIds = ["video:clock"];
  return { base, risk };
}

test("replay event and media clocks must agree within the explicit frame-scale allowance", () => {
  const { base, risk } = replayRiskContext();
  for (const offset of [-SPATIAL_REPLAY_TOLERANCE_MS, 0, SPATIAL_REPLAY_TOLERANCE_MS]) {
    risk.risk!.observedAt = 104000 + offset;
    const merged = mergeSpatialDataset(base, spatialSnapshot(risk));
    assert.equal(merged.alerts.at(-1)?.mediaSeconds, 4); assert.equal(merged.alerts.at(-1)?.timestamp, risk.risk!.observedAt);
    assert.match(merged.alerts.at(-1)!.description, /尚未核验.*取景/);
  }
  for (const offset of [-SPATIAL_REPLAY_TOLERANCE_MS - 1, SPATIAL_REPLAY_TOLERANCE_MS + 1, 5000]) {
    risk.risk!.observedAt = 104000 + offset;
    const merged = mergeSpatialDataset(base, spatialSnapshot(risk));
    assert.equal(merged.alerts.at(-1)?.mediaSeconds, undefined); assert.equal(merged.alerts.at(-1)?.timestamp, risk.risk!.observedAt);
    assert.match(merged.alerts.at(-1)!.description, /事件时标无法核对/);
    assert.match(merged.nodes.at(-1)!.description, /不自动跳转/);
  }
});

test("source clock mapping refuses ambiguous, reversed, missing and extrapolated times", () => {
  const { base, risk } = replayRiskContext(); const track = base.devices[0].track;
  assert.equal(spatialReplayTimeAt(track, 4), 104000); assert.equal(spatialReplayTimeAt(track, 10), 110000);
  assert.equal(spatialReplayTimeAt(track, -1), undefined); assert.equal(spatialReplayTimeAt(track, 11), undefined);
  assert.equal(spatialReplayTimeAt(track, NaN), undefined); assert.equal(spatialReplayTimeAt([], 4), undefined);
  track[1].segment = 1;
  assert.equal(spatialReplayTimeAt(track, 4), undefined); assert.equal(spatialReplayTimeAt(track, 10), 110000);
  assert.equal(mergeSpatialDataset(base, spatialSnapshot(risk)).alerts.at(-1)?.mediaSeconds, undefined);
  delete track[1].segment;
  track[1].time = track[0].time;
  assert.equal(spatialReplayTimeAt(track, 4), undefined);
  track[1].time = 110000; track[1].mediaSeconds = 0;
  assert.equal(spatialReplayTimeAt(track, 0), undefined);
  track[1].mediaSeconds = 10; track[0].time = NaN;
  assert.equal(spatialReplayTimeAt(track, 4), undefined);
});

test("field-entry linked video remains project reference rather than incident footage", () => {
  const { base } = replayRiskContext(); const risk = spatialFixture("risk-point", "field-reference");
  risk.linkedMediaIds = ["video:clock"];
  const merged = mergeSpatialDataset(base, spatialSnapshot(risk));
  assert.deepEqual(merged.alerts.at(-1)?.mediaIds, ["video:clock"]); assert.equal(merged.alerts.at(-1)?.mediaSeconds, undefined);
  assert.equal(merged.alerts.at(-1)?.timestamp, risk.risk!.observedAt);
  for (const description of [merged.alerts.at(-1)!.description, merged.nodes.at(-1)!.description]) {
    assert.match(description, /项目参考资料/); assert.match(description, /未核验.*事发画面/); assert.match(description, /不自动跳转/);
  }
});

test("valid explicit engineering, construction-area and railway links show names with stable IDs", () => {
  const base = createSafetyDemoDataset(); const engineeringNode = base.nodes.find((node) => node.kind === "component")!;
  const area = spatialFixture(), railway = spatialFixture("railway", "named-railway"), risk = spatialFixture("risk-point", "linked-risk");
  area.name = "试验施工区"; railway.name = "人工营业线参考区"; risk.areaId = area.id; risk.railwayId = railway.id;
  risk.linkedNodeIds = [engineeringNode.id];
  const merged = mergeSpatialDataset(base, spatialSnapshot(area, railway, risk));
  for (const description of [merged.nodes.at(-1)!.description, merged.alerts.at(-1)!.description]) {
    assert.ok(description.includes(`${engineeringNode.name}（${engineeringNode.id}）`));
    assert.ok(description.includes("关联施工区域：试验施工区（spatial:area-one）"));
    assert.ok(description.includes("关联铁路范围：人工营业线参考区（spatial:named-railway）"));
  }
  const removed = mergeSpatialDataset(base, spatialSnapshot());
  assert.deepEqual(removed.timeExtent, base.timeExtent); assert.equal(removed.nodes.some((node) => node.spatialObjectId), false);
});
