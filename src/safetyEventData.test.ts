import test from "node:test";
import assert from "node:assert/strict";
import { mergeSafetyEvents } from "./safetyEventData.ts";
import { SafetyStore } from "./safetyStore.ts";
import type { SafetyDataset } from "./safetyTypes.ts";
import type { SafetyEventSnapshot } from "./safetyEventTypes.ts";

const base = (): SafetyDataset => ({ version: 1, projectId: "p", name: "工程", nodes: [
  { id: "p", kind: "project", name: "项目", position: { longitude: 120, latitude: 30, height: 0 }, provenance: "real", description: "", mediaIds: [] },
  { id: "risk", parentId: "p", kind: "component", name: "人工位置", spatialKind: "risk-point", spatialObjectId: "r", riskLevel: "unassessed", position: { longitude: 120.1, latitude: 30.1, height: 42 }, provenance: "user", description: "", mediaIds: [] },
], alerts: [], tasks: [], devices: [], media: [], timeExtent: [1000, 3000], coordinateNote: "", sourceNotes: [], missingData: [] });
const events = (position = false): SafetyEventSnapshot => ({ version: 1, revision: 1, updatedAt: "2026-10-07T00:00:00.000Z", events: [{
  id: "e", projectId: "p", title: "已记录事件", severity: "medium", status: "pending", occurredAt: 2000, spatialObjectId: "r", mediaIds: [],
  source: { kind: "manual-record" }, createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z",
  ...(position ? { position: { longitude: 120.05, latitude: 30.05, height: 31 } } : {}),
}] });

test("manual point without events stays visible through event filters and never creates an alert", () => {
  const store = new SafetyStore(base()); store.patch({ eventStatus: "closed", eventQuery: "missing", severity: "high", timeRange: [1000, 1100] });
  assert.equal(store.view.alerts.length, 0); assert.ok(store.view.nodes.some(n => n.id === "risk"));
  assert.equal(store.view.nodes.find(n => n.id === "risk")!.riskLevel, "unassessed");
});
test("an event relationship does not invent an observed position or mutate the definition", () => {
  const original = base(), copy = structuredClone(original), merged = mergeSafetyEvents(original, events());
  assert.deepEqual(original, copy); assert.equal(merged.alerts.length, 1); assert.equal(merged.alerts[0].positionAvailable, false);
  assert.equal(merged.nodes.find(n => n.eventId === "e")!.sceneAvailable, false);
  assert.deepEqual(merged.nodes.find(n => n.id === "risk"), original.nodes[1]);
});
test("event positions and status share filtering while manual positions remain unchanged", () => {
  const store = new SafetyStore(mergeSafetyEvents(base(), events(true)));
  store.select({ nodeId: "safety-event:e", alertId: "event:e" });
  store.patch({ eventStatus: "closed" });
  assert.equal(store.state.selectedId, "risk"); assert.equal(store.state.selectedAlertId, undefined);
  assert.equal(store.view.alerts.length, 0); assert.equal(store.view.nodes.some(n => n.eventId === "e"), false);
  assert.ok(store.view.nodes.some(n => n.id === "risk"));
});
test("completion updates only its event, and removed definitions do not erase event history", () => {
  const snapshot = events(true); snapshot.events[0].status = "completed";
  snapshot.events[0].handling = { description: "已完成现场复核", handledAt: "2026-10-07T01:00:00Z", attachmentIds: [] };
  const dataset = base(); dataset.nodes = dataset.nodes.slice(0, 1);
  const result = mergeSafetyEvents(dataset, snapshot);
  assert.equal(result.alerts[0].status, "closed"); assert.equal(result.alerts[0].rectifications[0].text, "已完成现场复核");
  assert.equal(result.nodes.find(n => n.eventId === "e")!.parentId, "p");
  assert.equal(result.nodes.some(n => n.spatialKind === "risk-point"), false);
});
