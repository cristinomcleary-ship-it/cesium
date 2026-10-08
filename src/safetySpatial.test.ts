import test from "node:test";
import assert from "node:assert/strict";
import { createSafetyDemoDataset } from "./safetyData.ts";
import { mergeSpatialDataset, spatialReplayTimeAt } from "./safetySpatialData.ts";
import { SafetySpatialError, SafetySpatialRepository } from "./safetySpatialRepository.ts";
import { spatialFixture, spatialV3Fixture, spatialSnapshot } from "./safetySpatial.testFixtures.ts";
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

test("merge adds user hierarchy without mutating engineering data or producing synthetic events", () => {
  const base = createSafetyDemoDataset(Date.parse("2026-08-19T08:20:16Z"));
  base.railway = { positions: [{ longitude: 120, latitude: 30, height: 5 }, { longitude: 120.01, latitude: 30.01, height: 6 }], provenance: "real", note: "original" };
  const area = spatialFixture(), rail = spatialFixture("railway", "rail"), risk = spatialFixture("risk-point", "risk");
  risk.areaId = area.id; risk.railwayId = rail.id;
  const before = JSON.stringify(base); const merged = mergeSpatialDataset(base, spatialSnapshot(area, rail, risk));
  assert.equal(JSON.stringify(base), before); assert.equal(merged.railway, base.railway);
  const point = merged.nodes.find((node) => node.id === "spatial:risk")!;
  assert.equal(point.parentId, "spatial:area-one"); assert.equal(point.provenance, "user"); assert.equal(point.componentType, undefined);
  assert.deepEqual(point.position, risk.geometry.type === "Point" ? risk.geometry.position : undefined);
  assert.deepEqual(point.mediaIds, []); assert.equal(point.riskLevel, "high");
  assert.deepEqual(merged.alerts, base.alerts); assert.deepEqual(merged.timeExtent, base.timeExtent);
  assert.match(point.description, /高程基准未知/); assert.match(point.description, /不自动生成业务事件/);
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

test("legacy replay-risk properties never become a new event or automatic video seek", () => {
  const base = createSafetyDemoDataset(); const risk = spatialFixture("risk-point", "risk");
  risk.risk = { ...risk.risk!, observationSource: "replay-review", videoId: "video:one", mediaSeconds: 4, observedAt: 104000 }; risk.linkedMediaIds = ["video:one"];
  const before = JSON.stringify(risk), merged = mergeSpatialDataset(base, spatialSnapshot(risk));
  assert.equal(JSON.stringify(risk), before); assert.deepEqual(merged.alerts, base.alerts); assert.deepEqual(merged.timeExtent, base.timeExtent);
  assert.match(merged.nodes.at(-1)!.description, /V2 历史风险属性已保留/);
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

test("V3 risk is an unassessed optional-description definition, independent of events and their time range", () => {
  const risk = spatialV3Fixture("risk-point", "v3-risk"); delete risk.level;
  const valid = validateSpatialObject(risk); assert.equal(valid.level, "unassessed"); assert.equal(valid.description, undefined); assert.equal(valid.risk, undefined);
  const base = createSafetyDemoDataset(); base.alerts = [];
  const merged = mergeSpatialDataset(base, spatialSnapshot(valid));
  assert.equal(merged.alerts.length, 0); assert.equal(merged.nodes.at(-1)?.riskLevel, "unassessed"); assert.deepEqual(merged.timeExtent, base.timeExtent);
});

test("source clock mapping refuses ambiguous, reversed, missing and extrapolated times", () => {
  const { base, risk } = replayRiskContext(); const track = base.devices[0].track;
  assert.equal(spatialReplayTimeAt(track, 4), 104000); assert.equal(spatialReplayTimeAt(track, 10), 110000);
  assert.equal(spatialReplayTimeAt(track, -1), undefined); assert.equal(spatialReplayTimeAt(track, 11), undefined);
  assert.equal(spatialReplayTimeAt(track, NaN), undefined); assert.equal(spatialReplayTimeAt([], 4), undefined);
  track[1].segment = 1;
  assert.equal(spatialReplayTimeAt(track, 4), undefined); assert.equal(spatialReplayTimeAt(track, 10), 110000);
  assert.deepEqual(mergeSpatialDataset(base, spatialSnapshot(risk)).alerts, base.alerts);
  delete track[1].segment;
  track[1].time = track[0].time;
  assert.equal(spatialReplayTimeAt(track, 4), undefined);
  track[1].time = 110000; track[1].mediaSeconds = 0;
  assert.equal(spatialReplayTimeAt(track, 0), undefined);
  track[1].mediaSeconds = 10; track[0].time = NaN;
  assert.equal(spatialReplayTimeAt(track, 4), undefined);
});

test("definition media is reference material, never incident footage or a synthetic event", () => {
  const { base } = replayRiskContext(); const risk = spatialFixture("risk-point", "field-reference");
  risk.linkedMediaIds = ["video:clock"];
  const merged = mergeSpatialDataset(base, spatialSnapshot(risk));
  assert.deepEqual(merged.nodes.at(-1)?.mediaIds, ["video:clock"]); assert.deepEqual(merged.alerts, base.alerts);
  assert.match(merged.nodes.at(-1)!.description, /参考资料/); assert.match(merged.nodes.at(-1)!.description, /未核验.*事发画面/);
});

test("valid explicit engineering, construction-area and railway links show names with stable IDs", () => {
  const base = createSafetyDemoDataset(); const engineeringNode = base.nodes.find((node) => node.kind === "component")!;
  const area = spatialFixture(), railway = spatialFixture("railway", "named-railway"), risk = spatialFixture("risk-point", "linked-risk");
  area.name = "试验施工区"; railway.name = "人工营业线参考区"; risk.areaId = area.id; risk.railwayId = railway.id;
  risk.linkedNodeIds = [engineeringNode.id];
  const merged = mergeSpatialDataset(base, spatialSnapshot(area, railway, risk));
  for (const description of [merged.nodes.at(-1)!.description]) {
    assert.ok(description.includes(`${engineeringNode.name}（${engineeringNode.id}）`));
    assert.ok(description.includes("关联施工区域：试验施工区（spatial:area-one）"));
    assert.ok(description.includes("关联铁路范围：人工营业线参考区（spatial:named-railway）"));
  }
  const removed = mergeSpatialDataset(base, spatialSnapshot());
  assert.deepEqual(removed.timeExtent, base.timeExtent); assert.equal(removed.nodes.some((node) => node.spatialObjectId), false);
});


test("V3 railway is polygon-only and every vertex requires matching ECEF and model-surface provenance", () => {
  const railway = spatialV3Fixture("railway"); assert.equal(validateSpatialObject(railway).geometry.type, "Polygon");
  railway.geometry = spatialFixture("railway").geometry;
  assert.throws(() => validateSpatialObject(railway), /闭合多边形/);
  const point = spatialV3Fixture("risk-point"); point.source.vertices[0].anchor!.position.x += 1;
  assert.throws(() => validateSpatialObject(point), /世界坐标.*不一致/);
  const missing = spatialV3Fixture("risk-point"); delete missing.source.vertices[0].anchor;
  assert.throws(() => validateSpatialObject(missing), /倾斜摄影表面/);
  const falseSource = spatialV3Fixture("risk-point"); falseSource.source.vertices[0].pickKind = "terrain";
  assert.throws(() => validateSpatialObject(falseSource), /倾斜摄影表面/);
});

test("V3 retains all valid V2 corridor/status sources and skips soft-deleted definitions without converting them", () => {
  for (const status of ["open", "rectifying", "closed"] as const) {
    const corridor = spatialFixture("railway", "legacy-corridor"), risk = spatialFixture("risk-point", "legacy-risk"); risk.risk!.status = status;
    const input = spatialSnapshot(corridor, risk), result = validateSpatialSnapshot(input);
    assert.deepEqual(result, input); assert.equal(result.objects[0].creationSource, undefined);
    assert.equal(result.objects[1].risk!.status, status);
  }
  const deleted = spatialV3Fixture("risk-point", "deleted"); deleted.deletedAt = deleted.updatedAt;
  const base = createSafetyDemoDataset(); base.alerts.push({ ...base.alerts[0], id: "spatial-alert:legacy", spatialObjectId: "legacy" });
  const merged = mergeSpatialDataset(base, spatialSnapshot(deleted));
  assert.equal(merged.nodes.some(node => node.spatialObjectId === "deleted"), false);
  assert.equal(merged.alerts.some(alert => alert.id.startsWith("spatial-alert:")), false);
});


test("optional object revisions preserve historical absence and reject invalid persisted numbers", () => {
  const historical = spatialV3Fixture();
  assert.equal(Object.hasOwn(validateSpatialObject(historical), "revision"), false);
  assert.equal(validateSpatialObject({ ...historical, revision: 7 }).revision, 7);
  assert.equal(validateSpatialSnapshot(spatialSnapshot({ ...historical, revision: 7 })).objects[0].revision, 7);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null]) {
    assert.throws(() => validateSpatialObject({ ...historical, revision }), /修订号/);
  }
});
