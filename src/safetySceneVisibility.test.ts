import test from "node:test";
import assert from "node:assert/strict";
import { safetyHeatWeights, spatialNodeLayerVisible } from "./safetySceneVisibility.ts";
import { SafetyStore } from "./safetyStore.ts";
import { mergeSafetyEvents } from "./safetyEventData.ts";
import type { SafetyDataset, SafetyNode } from "./safetyTypes.ts";
import type { SafetyEventRecord } from "./safetyEventTypes.ts";

const node = (id: string, spatialKind?: SafetyNode["spatialKind"]): SafetyNode => ({ id, parentId: id === "p" ? undefined : "p",
  kind: id === "p" ? "project" : "component", name: id, position: { longitude: 120, latitude: 30, height: 20 },
  provenance: "user", description: "", mediaIds: [], spatialKind, ...(spatialKind ? { spatialObjectId: id } : {}) });
const dataset = (): SafetyDataset => ({ version: 1, projectId: "p", name: "工程", nodes: [node("p"), node("risk", "risk-point")],
  alerts: [], tasks: [], devices: [], media: [], timeExtent: [1000, 3000], coordinateNote: "", sourceNotes: [], missingData: [] });
const event = (id: string, positioned: boolean): SafetyEventRecord => ({ id, projectId: "p", title: id, severity: "high", status: "pending",
  occurredAt: 2000, spatialObjectId: "risk", mediaIds: [], source: { kind: "manual-record" },
  createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
  ...(positioned ? { position: { longitude: 120, latitude: 30, height: 20 } } : {}) });

test("spatial layer switches hide only their kind without changing definitions or selection", () => {
  const nodes = [node("a", "construction-area"), node("rail", "railway"), node("risk", "risk-point"), node("event")];
  const copy = structuredClone(nodes);
  assert.deepEqual(nodes.map(n => spatialNodeLayerVisible(n, { riskPoints: false })), [true, true, false, true]);
  assert.deepEqual(nodes.map(n => spatialNodeLayerVisible(n, { constructionAreas: false })), [false, true, true, true]);
  assert.deepEqual(nodes.map(n => spatialNodeLayerVisible(n, { railwayAreas: false })), [true, false, true, true]);
  assert.deepEqual(nodes.map(n => spatialNodeLayerVisible(n, {})), [true, true, true, true]);
  assert.deepEqual(nodes, copy);
});

test("unlocated real events never create a heat position while located events retain their measured coordinates", () => {
  const merged = mergeSafetyEvents(dataset(), { version: 1, revision: 1, updatedAt: "2026-10-07T00:00:00Z", events: [event("missing", false), event("located", true)] });
  const store = new SafetyStore(merged), before = structuredClone(merged);
  const weights = safetyHeatWeights(merged, store.view);
  assert.deepEqual([...weights.keys()], ["safety-event:located"]);
  assert.deepEqual(weights.get("safety-event:located"), { position: { longitude: 120, latitude: 30, height: 20 }, count: 1 });
  assert.deepEqual(merged, before);
  store.patch({ timeRange: [1000, 1500] }); assert.equal(safetyHeatWeights(merged, store.view).size, 0);
});

test("only missing-position events leave heat empty, and explicit position-unavailable wins over a numeric coordinate", () => {
  const merged = mergeSafetyEvents(dataset(), { version: 1, revision: 1, updatedAt: "2026-10-07T00:00:00Z", events: [event("missing", false)] });
  assert.equal(safetyHeatWeights(merged, new SafetyStore(merged).view).size, 0);
  merged.nodes.find(n => n.eventId === "missing")!.sceneAvailable = true;
  assert.equal(safetyHeatWeights(merged, new SafetyStore(merged).view).size, 0);
});
