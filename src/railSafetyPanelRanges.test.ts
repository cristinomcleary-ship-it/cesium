import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { RailSafetyMachine, RailSafetyPolygon } from "./railSafetyTypes.ts";
import { MACHINERY_ASSET_VERSION } from "./machineryTypes.ts";
import { MACHINERY_PARAMETER_DEFAULTS } from "./machineryValidation.ts";

registerHooks({ load(url, context, next) {
  return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "export {};" } : next(url, context);
} });
const { RailSafetyPanel } = await import("./railSafetyPanel.ts");
const polygon = (): RailSafetyPolygon => [
  { longitude: 121, latitude: 31, height: 12 },
  { longitude: 121.0001, latitude: 31, height: 12 },
  { longitude: 121.0001, latitude: 31.0001, height: 12 },
];
function fixture() {
  let changed = 0, draw: ((points: RailSafetyPolygon) => void) | undefined;
  const messages: string[] = [];
  const state = { schemaVersion: 1, assetId: "crane", assetVersion: MACHINERY_ASSET_VERSION, proportional: true,
    parameters: { ...MACHINERY_PARAMETER_DEFAULTS.crane }, constructionClass: "C", visible: true,
    placement: { longitude: 121, latitude: 31, height: 12, heading: 25 } };
  const definition: RailSafetyMachine = { schemaVersion: 1, kind: "machine", resourceId: "resource:with:colons", selectedLimitIds: ["limit"] };
  const records: unknown[] = [];
  const panel = Object.assign(Object.create(RailSafetyPanel.prototype), {
    destroyed: false, opened: true, busy: false, picking: false, generation: 2, dirty: false,
    context: { projectId: "project", canView: true, canEdit: true, active: true },
    draft: { id: "config", name: "测试机械", definition },
    resources: () => [{ id: definition.resourceId, name: "测试机械", machinery: state }],
    records: () => records,
    scene: {
      getMachineState: () => structuredClone(state),
      getSnapshot: () => ({ pending: false }),
      beginPolygon: (callback: (points: RailSafetyPolygon) => void) => { draw = callback; },
    },
    renderMachineRanges: () => undefined, changed: () => { changed++; }, renderLimitSelection: () => undefined,
    find: () => ({ textContent: "", scrollIntoView: () => undefined }),
    message: (message: string) => { messages.push(message); },
  });
  const button = (range: string, zoneId?: string, index?: number) => ({ dataset: { range, zoneId, index: String(index ?? 0) } });
  return { panel, definition, state, records, button, messages, changed: () => changed, complete: () => draw?.(polygon()) };
}

test("drawn attached ranges use the current completion pose and cannot change fixed site ranges", () => {
  const f = fixture();
  f.definition.activityPolygon = polygon();
  f.panel.machineRangeAction("draw-machine-range", f.button("workRange"));
  assert.equal(f.definition.workRange, undefined, "starting or cancelling a draw must preserve automatic mode");
  f.state.placement.heading = 70;
  f.complete();
  assert.deepEqual((f.definition as RailSafetyMachine).workRange?.anchor, f.state.placement);
  assert.deepEqual((f.definition as RailSafetyMachine).workRange?.polygon, polygon());
  assert.deepEqual(f.definition.activityPolygon, polygon());
  assert.equal(f.changed(), 1);
  f.state.placement.heading = 110;
  assert.equal((f.definition as RailSafetyMachine).workRange?.anchor.heading, 70, "saved anchor must not alias a live state");
});

test("late drawing callbacks are discarded after generation, draft or permission changes", () => {
  for (const change of ["generation", "draft", "permission"]) {
    const f = fixture();
    f.panel.machineRangeAction("draw-machine-range", f.button("fallRange"));
    if (change === "generation") f.panel.generation++;
    else if (change === "draft") f.panel.draft = { ...f.panel.draft, definition: structuredClone(f.definition) };
    else f.panel.context.canEdit = false;
    f.complete();
    assert.equal(f.definition.fallRange, undefined);
    assert.equal(f.changed(), 0);
  }
});

test("readonly, busy and picking panels cannot add or remove machine ranges", () => {
  for (const state of ["readonly", "busy", "picking"]) {
    const f = fixture();
    if (state === "readonly") f.panel.context.canEdit = false; else f.panel[state] = true;
    f.panel.machineRangeAction("add-machine-vertex", f.button("activityPolygon"));
    f.panel.machineRangeAction("add-construction-zone", f.button("zone"));
    assert.equal(f.definition.activityPolygon, undefined);
    assert.equal(f.definition.constructionZones, undefined);
    assert.equal(f.changed(), 0);
  }
});

test("coordinate editing, classification changes and reset keep each range independent", () => {
  const f = fixture();
  for (const target of ["workRange", "fallRange", "activityPolygon"]) f.panel.machineRangeAction("add-machine-vertex", f.button(target));
  f.panel.machineRangeAction("add-construction-zone", f.button("zone"));
  const zone = f.definition.constructionZones![0];
  f.panel.machineRangeAction("add-machine-vertex", f.button("zone", zone.id));
  f.panel.input({ dataset: { machineCoordinate: "longitude", range: "workRange", vertexIndex: "0" }, value: "121.3" });
  f.panel.input({ dataset: { zoneName: zone.id }, value: "天窗施工围界" });
  f.panel.change({ dataset: { zoneClass: zone.id }, value: "window" });
  assert.equal(f.definition.workRange!.polygon[0].longitude, 121.3);
  assert.ok(Number.isNaN(f.definition.fallRange!.polygon[0].longitude));
  assert.ok(Number.isNaN(f.definition.activityPolygon![0].longitude));
  assert.equal(zone.classification, "window"); assert.equal(zone.name, "天窗施工围界");
  f.panel.machineRangeAction("reset-machine-range", f.button("workRange"));
  assert.equal(f.definition.workRange, undefined);
  assert.ok(f.definition.fallRange); assert.ok(f.definition.activityPolygon);
  f.panel.machineRangeAction("reset-machine-range", f.button("zone", zone.id));
  assert.deepEqual(f.definition.constructionZones, []);
});

test("machine range validation blocks incomplete custom coordinates before saving", () => {
  const f = fixture();
  f.panel.machineRangeAction("add-machine-vertex", f.button("activityPolygon"));
  assert.match(f.panel.validateDraft(), /3|顶点|角点/);
  f.definition.activityPolygon = polygon();
  assert.equal(f.panel.validateDraft(), undefined);
});

test("display navigation resolves colon-containing resource and zone IDs without splitting", () => {
  const f = fixture();
  f.definition.constructionZones = [{ id: "zone:part:1", name: "分类区", classification: "A", polygon: polygon() }];
  const selections: string[][] = [], locations: string[] = [];
  f.panel.openFieldObject = (kind: string, id: string) => { selections.push([kind, id]); return true; };
  f.panel.scene.flyTo = (id: string) => { locations.push(id); };
  const zoneKey = f.definition.resourceId + ":zone:part:1";
  assert.equal(f.panel.selectDisplayObject("constructionZone", zoneKey), true);
  f.panel.locateDisplayObject(zoneKey);
  assert.deepEqual(selections, [["machine", f.definition.resourceId]]);
  assert.deepEqual(locations, [f.definition.resourceId]);
  assert.equal(f.panel.selectDisplayObject("constructionZone", "missing"), false);
  assert.equal(f.panel.selectDisplayObject("machineWorkRange", f.definition.resourceId), true);
});

test("activity alarms count as risk even with clear limit geometry and cannot count as clear", () => {
  const f = fixture();
  f.records.push({ id: "config", definition: f.definition });
  f.panel.results = [{
    resourceId: f.definition.resourceId, resourceName: "测试机械", status: "clear", label: "未相交", message: "",
    draft: false, limits: [], guards: [], warnings: [], signature: "", classification: "C", classificationComplete: true,
    classificationReasons: [], activityStatus: "outside", alarms: [{ kind: "activity", message: "机械站位超出活动范围" }],
  }];
  const summary = f.panel.getFieldSummary();
  assert.equal(summary.riskCount, 1); assert.equal(summary.clearCount, 0);
  assert.equal(summary.machines[0].alarms[0].kind, "activity");
});


/** Small DOM surface for exercising the rendered alarm groups without a WebGL viewer. */
class StatusNode {
  children: StatusNode[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; className = "";
  private ownText = ""; private classes = new Set<string>();
  constructor(readonly tagName: string) {}
  classList = { toggle: (name: string, enabled: boolean) => { if (enabled) this.classes.add(name); else this.classes.delete(name); }, contains: (name: string) => this.classes.has(name) };
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get childElementCount() { return this.children.length; }
  append(...nodes: StatusNode[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; this.ownText = ""; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  findAll(predicate: (node: StatusNode) => boolean): StatusNode[] { return this.children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.findAll(predicate)]); }
}
function withStatusDom(run: (host: StatusNode) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => new StatusNode(tag) } });
  try { run(new StatusNode("div")); } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
}
function statusResult(resourceId: string) {
  return { resourceId, resourceName: "测试机械", status: "clear", label: "未相交", message: "", draft: false, limits: [], guards: [], warnings: [], signature: "",
    declaredClass: "B+window", classification: "A", classifications: ["window", "A", "B"], classificationComplete: true, classificationReasons: [], activityStatus: "inside",
    alarms: [{ kind: "classification", classification: "A", message: "工作范围触及设备限界" }, { kind: "zone", classification: "A", message: "工作范围触及A类区域" }],
  };
}

test("construction status preserves combined declaration and every simultaneous type in separate alarm columns", () => withStatusDom(host => {
  const f = fixture(), result = statusResult(f.definition.resourceId);
  result.declaredClass = "B";
  result.alarms.push({ kind: "classification", classification: "window", message: "倾覆范围触及线路限界" });
  f.panel.results = [result]; f.panel.fillConstructionStatus(host, f.definition.resourceId);
  assert.equal(host.dataset.classification, "A"); assert.equal(host.dataset.classifications, "A,window,B");
  assert.match(host.textContent, /实时判定：A类施工、天窗点施工、B类施工/);
  const groups = host.findAll(node => !!node.dataset.alarmClass);
  assert.deepEqual(groups.map(node => node.dataset.alarmClass), ["A", "window"]);
  assert.deepEqual(groups.map(node => node.children[0].textContent), ["A类施工报警", "天窗点施工报警"]);
  assert.equal(groups[0].findAll(node => !!node.dataset.alarmKind).length, 2);
  assert.equal(groups[1].findAll(node => !!node.dataset.alarmKind).length, 1);
  assert.ok(groups.every(node => node.attributes.role === "alert"));
  result.declaredClass = "B+window"; result.alarms = result.alarms.filter(alarm => alarm.classification !== "window");
  f.panel.fillConstructionStatus(host, f.definition.resourceId);
  assert.equal(host.dataset.declaredClass, "B+window"); assert.match(host.textContent, /申报分类：B类施工＋天窗点施工/);
  assert.deepEqual(host.findAll(node => !!node.dataset.alarmClass).map(node => node.dataset.alarmClass), ["A"]);
}));

test("live redraw removes cleared category alarms and supports legacy untyped alarms", () => withStatusDom(host => {
  const f = fixture(), result = statusResult(f.definition.resourceId);
  f.panel.results = [result]; f.panel.fillConstructionStatus(host, f.definition.resourceId);
  assert.equal(host.classList.contains("is-alarm"), true);
  result.declaredClass = "A"; result.classification = "window"; result.classifications = ["window"]; result.alarms = [];
  f.panel.fillConstructionStatus(host, f.definition.resourceId);
  assert.equal(host.classList.contains("is-alarm"), false); assert.equal(host.findAll(node => !!node.dataset.alarmClass).length, 0);
  assert.match(host.textContent, /申报分类：A类施工 · 实时判定：天窗点施工/);
  f.panel.results = [{ ...result, classifications: undefined, classification: "B", alarms: [{ kind: "activity", message: "机械站位超出活动范围" }, { kind: "classification", message: "旧格式施工报警" }] }];
  f.panel.fillConstructionStatus(host, f.definition.resourceId);
  assert.equal(host.dataset.classifications, "B");
  assert.deepEqual(host.findAll(node => !!node.dataset.alarmClass).map(node => node.dataset.alarmClass), ["activity", "unknown"]);
  assert.match(host.textContent, /机械站位超出活动范围/); assert.match(host.textContent, /旧格式施工报警/);
}));
