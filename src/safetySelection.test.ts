import test from "node:test";
import assert from "node:assert/strict";
import { SafetyStore } from "./safetyStore.ts";
import type { SafetyDataset } from "./safetyTypes.ts";

function dataset(): SafetyDataset {
  return { version: 1, projectId: "project", name: "实际项目", timeExtent: [1000, 3000], coordinateNote: "unknown", sourceNotes: [], missingData: [], tasks: [],
    nodes: [
      { id: "project", kind: "project", name: "项目", position: { longitude: 120, latitude: 30, height: 0 }, provenance: "real", description: "", mediaIds: ["project-video"] },
      { id: "anchor", parentId: "project", kind: "component", componentType: "pile", name: "CAD 点", position: { longitude: 120, latitude: 30, height: 0 }, provenance: "real", description: "", mediaIds: ["drawing"] },
      { id: "cap", parentId: "project", kind: "component", componentType: "cap", name: "盖梁", position: { longitude: 120, latitude: 30, height: 0 }, provenance: "derived", description: "", mediaIds: [], navigationDisabledReason: "未绑定 BIM" },
      { id: "risk", parentId: "project", kind: "component", spatialKind: "risk-point", spatialObjectId: "user-risk", name: "人工风险", position: { longitude: 120, latitude: 30, height: 0 }, provenance: "user", description: "", mediaIds: [] },
    ],
    alerts: [{ id: "alert", nodeId: "risk", title: "人工风险", severity: "high", timestamp: 2000, status: "open", description: "", provenance: "user", mediaIds: [], rectifications: [] }],
    media: [{ id: "project-video", name: "无人机原片", kind: "video", provenance: "real", relation: "project", url: "/video.mp4", note: "项目参考" }, { id: "drawing", name: "图纸", kind: "drawing", provenance: "real", relation: "object", url: "/plan.dwg", note: "CAD 来源" }],
    devices: [{ id: "drone", nodeId: "project", name: "无人机", kind: "drone", provenance: "real", status: "replay", mediaId: "project-video", coordinateNote: "", track: [{ longitude: 120, latitude: 30, height: 50, time: 1000, mediaSeconds: 0 }, { longitude: 120, latitude: 30, height: 50, time: 3000, mediaSeconds: 2 }] }],
  };
}
test("CAD object keeps its drawing without inheriting unrelated project video", () => {
  const store = new SafetyStore(dataset()); assert.ok(store.view.media.some(m => m.id === "project-video"));
  store.select({ nodeId: "anchor" }); assert.deepEqual(store.view.media.map(m => m.id), ["drawing"]);
});
test("manual risk requires an explicit media association and remains visible when demo is excluded", () => {
  const store = new SafetyStore(dataset()); store.patch({ includeDemo: false }); store.select({ nodeId: "risk", alertId: "alert" });
  assert.equal(store.state.selectedAlertId, "alert"); assert.deepEqual(store.view.media, []); assert.equal(store.view.metrics.alerts, 1);
});
test("logical component with no model binding cannot change the selected object", () => {
  const store = new SafetyStore(dataset()); store.select({ nodeId: "anchor" }); store.select({ nodeId: "cap" }); assert.equal(store.state.selectedId, "anchor");
});
test("ornamental animation pause does not alter telemetry time or business selection", () => {
  const store = new SafetyStore(dataset()); store.select({ nodeId: "risk", alertId: "alert" }); store.patch({ time: 2100, playing: true });
  store.patch({ animationPaused: false }); store.patch({ animationPaused: true }); assert.equal(store.state.time, 2100); assert.equal(store.state.playing, true); assert.equal(store.state.selectedId, "risk");
});


test("selecting an alert from another scope uses the new scope then applies shared filters", () => {
  const store = new SafetyStore(dataset()); store.select({ nodeId: "anchor" }); assert.equal(store.view.alerts.length, 0);
  store.select({ nodeId: "risk", alertId: "alert" }); assert.equal(store.state.selectedAlertId, "alert");
  store.patch({ severity: "low" }); assert.equal(store.state.selectedAlertId, undefined);
});


function spatialDataset(): SafetyDataset {
  const data = dataset();
  const risk = data.nodes.find(node => node.id === "risk")!;
  risk.parentId = "area";
  const template = { position: { longitude: 120, latitude: 30, height: 0 }, provenance: "user" as const, description: "人工参考范围", mediaIds: [] };
  data.nodes.push({ ...template, id: "area", parentId: "project", kind: "section", name: "施工区域", spatialKind: "construction-area", spatialObjectId: "area" },
    { ...template, id: "railway", parentId: "project", kind: "section", name: "铁路参考范围", spatialKind: "railway", spatialObjectId: "railway" });
  return data;
}

test("manual definitions persist when event time and severity filters exclude related events", () => {
  const store = new SafetyStore(spatialDataset());
  store.select({ nodeId: "risk", alertId: "alert" });
  store.patch({ timeRange: [1000, 1500], severity: "low", includeDemo: false });
  assert.equal(store.view.alerts.length, 0);
  assert.equal(store.state.selectedId, "risk"); assert.equal(store.state.selectedAlertId, undefined);
  assert.ok(store.view.nodes.some(node => node.id === "risk"));
  store.select({ nodeId: "project" });
  assert.ok(store.view.nodes.some(node => node.id === "area"));
  assert.ok(store.view.nodes.some(node => node.id === "railway"));
  assert.ok(store.view.nodes.some(node => node.id === "risk"));
});


test("saving a dataset retains the shared time filter and selection while pausing playback", () => {
  const store = new SafetyStore(dataset());
  store.select({ nodeId: "risk", alertId: "alert" });
  store.patch({ timeRange: [1800, 2400], time: 2100, severity: "high", playing: true });
  store.setDataset(structuredClone(store.dataset), true);
  assert.deepEqual(store.state.timeRange, [1800, 2400]); assert.equal(store.state.time, 2100);
  assert.equal(store.state.selectedId, "risk"); assert.equal(store.state.selectedAlertId, "alert");
  assert.equal(store.state.severity, "high"); assert.equal(store.state.playing, false);
  assert.deepEqual(store.view.alerts.map(a => a.id), ["alert"]);
});

test("a preserved time filter clamps to a changed dataset extent without expanding the filter", () => {
  const store = new SafetyStore(dataset()); store.patch({ timeRange: [1800, 2400], time: 2100 });
  const smaller = dataset(); smaller.timeExtent = [2000, 2300]; store.setDataset(smaller, true);
  assert.deepEqual(store.state.timeRange, [2000, 2300]); assert.equal(store.state.time, 2100);
  const later = dataset(); later.timeExtent = [4000, 5000]; store.setDataset(later, true);
  assert.deepEqual(store.state.timeRange, [4000, 4000]); assert.equal(store.state.time, 4000);
  store.setDataset(dataset());
  assert.deepEqual(store.state.timeRange, [1000, 3000]); assert.equal(store.state.time, 1000);
});
