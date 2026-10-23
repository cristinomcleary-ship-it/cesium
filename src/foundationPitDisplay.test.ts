import test from "node:test";
import assert from "node:assert/strict";
import { Cartesian2, Cartesian3, CustomDataSource, JulianDate, PrimitiveCollection, ScreenSpaceEventType, type Entity, type Primitive, type ScreenSpaceEventHandler, type Viewer } from "cesium";
import { FoundationPitMonitoring } from "./foundationPitMonitoring.ts";

const pit = (id: string, visible = true) => ({
  id, name: `基坑 ${id}`, longitude: 121, latitude: 31, groundHeight: 10, heading: 15,
  length: 4, width: 3, depth: 2, exposure: 0.2, supportDepth: 3, displayOffset: 5,
  displayScale: 1, visible, enclosureType: "sheetPile", hasWaler: true, walerType: "steel",
  walerWidth: 0.2, walerHeight: 0.3, hasStrut: true, strutType: "steelPipe", strutLayout: "transverse",
  strutWidth: 0.2, strutHeight: 0.2, supportDepths: [1], customSupports: [],
});
const point = (id: string, pitId: string | null) => ({
  id, name: `位移点 ${id}`, pitId, placement: pitId ? "enclosure" : "free", edge: "A",
  along: 1, depth: 1, offset: 0, longitude: 121, latitude: 31, height: 10,
  speedThreshold: 5, cumulativeThreshold: 10,
  records: [{ id: `reading:${id}`, pointId: id, timestamp: "2026-10-14T00:00:00Z", x: 1, y: 0, z: 0, note: "原始监测值" }],
});
const support = (id: string, pitId: string) => ({
  id, pitId, name: `轴力点 ${id}`, targetType: "level", targetId: "level-1", depth: 1,
  axialForceThreshold: 100, deformationThreshold: 10,
  records: [{ id: `reading:${id}`, timestamp: "2026-10-14T00:00:00Z", axialForce: 20, deformation: 0, note: "原始监测值" }],
});
const savedState = () => ({
  version: 3,
  pits: [pit("visible"), pit("hidden", false)],
  points: [point("linked", "visible"), point("hidden", "hidden"), point("free", null)],
  supportMonitors: [support("linked", "visible"), support("hidden", "hidden")],
});

function fixture() {
  const state = savedState();
  const source = new CustomDataSource("pit-display-test");
  const primitives = new PrimitiveCollection();
  const viewer = { selectedEntity: undefined, scene: { requestRender() {} } } as unknown as Viewer;
  // Bypass DOM construction only; exercise the real catalogue, geometry and presentation methods.
  const monitoring = Object.assign(Object.create(FoundationPitMonitoring.prototype), {
    viewer, state, dataSource: source, sheetPilePrimitives: primitives,
    displayOverrides: {}, displayLabelsVisible: true, displayScope: "", displayAllowed: true,
    displayLayerVisible: true, displayDisposed: false, displayGroup: undefined,
    displayEntities: new Map<string, Entity[]>(), displayPrimitives: new Map<string, Primitive[]>(),
    pickMode: null,
    input(selector: string) {
      assert.equal(selector, "#pitDeformationScale", "scene rendering should need no editing controls");
      return { value: "1" };
    },
    saveState() { throw new Error("Display controls must not persist business state"); },
    notifyOverview() { throw new Error("Display controls must not announce a business-state change"); },
  }) as FoundationPitMonitoring;
  const internal = monitoring as unknown as { renderScene(): void };
  internal.renderScene();
  return { monitoring, internal, state, source, primitives };
}

function entity(f: ReturnType<typeof fixture>, id: string): Entity {
  const result = f.source.entities.getById(id);
  assert.ok(result, `expected rendered entity ${id}`);
  return result;
}

test("pit catalogue includes saved-hidden centre markers and only business objects", () => {
  const f = fixture();
  f.source.entities.add({ id: "foundation-pit-edit-handle", position: Cartesian3.ZERO, point: { pixelSize: 5 } });
  const items = f.monitoring.getDisplayItems();
  assert.deepEqual(items.map(({ id, kind, visible, defaultVisible }) => ({ id, kind, visible, defaultVisible })), [
    { id: "pit:model:visible", kind: "model", visible: true, defaultVisible: true },
    { id: "pit:marker:visible", kind: "marker", visible: true, defaultVisible: true },
    { id: "pit:model:hidden", kind: "model", visible: false, defaultVisible: false },
    { id: "pit:marker:hidden", kind: "marker", visible: true, defaultVisible: true },
    { id: "pit:point:linked", kind: "point", visible: true, defaultVisible: true },
    { id: "pit:point:hidden", kind: "point", visible: false, defaultVisible: false },
    { id: "pit:point:free", kind: "point", visible: true, defaultVisible: true },
    { id: "pit:support:linked", kind: "support", visible: true, defaultVisible: true },
    { id: "pit:support:hidden", kind: "support", visible: false, defaultVisible: false },
  ]);
  assert.equal(entity(f, "foundation-pit-anchor-hidden").show, true, "hidden engineering model retains its centre hint by default");
  assert.equal(f.source.entities.getById("foundation-pit-point-hidden"), undefined);
  assert.equal(f.source.entities.getById("foundation-pit-support-monitor-hidden"), undefined);
  f.state.supportMonitors.push(support("orphan", "missing-pit"));
  assert.equal(f.monitoring.getDisplayItems().some(item => item.id === "pit:support:orphan"), false, "a support without its required model is not a displayable object");
  items[0].name = "caller mutation";
  assert.equal(f.monitoring.getDisplayItems()[0].name, "基坑 visible · 基坑模型");
  for (let index = 0; index < 110; index++) f.state.points.push(point(`extra:${index}`, null));
  assert.equal(f.monitoring.getDisplayItems().length, 119, "the display catalogue is not capped like overview summaries");
});

test("centre hints, complete pit geometry and monitoring points have independent temporary visibility", () => {
  const f = fixture(), before = structuredClone(f.state);
  assert.equal(f.primitives.length, 1, "sheet-pile wall uses a real Cesium primitive");
  const override = { "pit:marker:visible": false, "pit:point:linked": false, "pit:support:linked": false };
  f.monitoring.setDisplayVisibility(override);
  override["pit:marker:visible"] = true;
  assert.equal(entity(f, "foundation-pit-anchor-visible").show, false);
  assert.equal(entity(f, "foundation-pit-display-label-visible").show, false, "the model centre hint and its elevated label hide together");
  assert.equal(entity(f, "foundation-pit-model-visible-bottom").show, true, "hiding a centre hint preserves the model");
  assert.equal(f.primitives.get(0).show, true);
  assert.equal(f.source.entities.getById("foundation-pit-point-linked"), undefined);
  assert.equal(f.source.entities.getById("foundation-pit-support-monitor-linked"), undefined);
  assert.equal(entity(f, "foundation-pit-point-free").show, true);
  f.internal.renderScene();
  assert.equal(entity(f, "foundation-pit-anchor-visible").show, false, "rebuilding honours a cloned override");

  f.monitoring.setDisplayVisibility({ "pit:model:visible": false });
  assert.equal(f.primitives.length, 0, "hiding a model removes its sheet-pile wall too");
  assert.equal(f.source.entities.values.some(item => item.id.startsWith("foundation-pit-model-visible-")), false);
  assert.equal(entity(f, "foundation-pit-anchor-visible").show, true, "model visibility does not hide its separately controlled centre hint");
  assert.equal(entity(f, "foundation-pit-point-linked").show, true, "display overrides do not change saved monitoring defaults");

  f.monitoring.setDisplayVisibility({ "pit:model:hidden": true, "pit:point:hidden": true, "pit:support:hidden": true });
  assert.equal(entity(f, "foundation-pit-model-hidden-bottom").show, true);
  assert.equal(entity(f, "foundation-pit-point-hidden").show, true);
  assert.equal(entity(f, "foundation-pit-support-monitor-hidden").show, true);
  assert.equal(f.primitives.length, 2);
  assert.deepEqual(f.state, before, "temporary visibility never changes saved visibility, geometry, names or readings");
  f.monitoring.setDisplayVisibility({});
  assert.equal(f.source.entities.getById("foundation-pit-model-hidden-bottom"), undefined);
  assert.equal(f.source.entities.getById("foundation-pit-point-hidden"), undefined);
  assert.equal(entity(f, "foundation-pit-anchor-hidden").show, true);
});

test("nameplate toggles preserve centre dots, monitoring markers and existing geometry", () => {
  const f = fixture(), now = JulianDate.now();
  const marker = entity(f, "foundation-pit-anchor-hidden");
  const monitoringPoint = entity(f, "foundation-pit-point-linked");
  const geometry = entity(f, "foundation-pit-model-visible-bottom");
  const wall = f.primitives.get(0);
  f.monitoring.setDisplayVisibility({}, false);
  assert.equal(entity(f, marker.id), marker);
  assert.equal(entity(f, monitoringPoint.id), monitoringPoint);
  assert.equal(entity(f, geometry.id), geometry);
  assert.equal(f.primitives.get(0), wall, "label-only changes do not rebuild wall primitives");
  for (const rendered of f.source.entities.values) {
    assert.equal(rendered.show, true);
    if (rendered.label) assert.equal(rendered.label.show!.getValue(now), false, `${rendered.id} nameplate must hide`);
  }
  assert.ok(marker.point); assert.ok(monitoringPoint.point);
  f.internal.renderScene();
  assert.equal(entity(f, marker.id).label!.show!.getValue(now), false, "later geometry rebuilds retain label preference");
  f.monitoring.setDisplayVisibility({});
  assert.equal(entity(f, marker.id).label!.show!.getValue(now), true);
});

test("denied context beats overrides and changing project/account clears display preferences", () => {
  const f = fixture(), before = structuredClone(f.state), now = JulianDate.now();
  f.monitoring.setDisplayContext("project-a/actor-a");
  f.monitoring.setDisplayVisibility({ "pit:marker:hidden": false, "pit:model:hidden": true }, false);
  f.monitoring.setDisplayContext("project-a/actor-a");
  assert.equal(entity(f, "foundation-pit-anchor-hidden").show, false, "refreshing the same context keeps preferences");
  f.monitoring.setDisplayContext("project-a/actor-a", false);
  assert.deepEqual(f.monitoring.getDisplayItems(), []);
  assert.equal(f.source.show, false); assert.equal(f.primitives.show, false);
  assert.equal(f.source.entities.values.length, 0); assert.equal(f.primitives.length, 0);
  f.monitoring.setDisplayVisibility({ "pit:marker:hidden": true, "pit:model:hidden": true });
  assert.equal(f.source.show, false); assert.equal(f.primitives.show, false);
  assert.equal(f.source.entities.values.length, 0, "visibility cannot repopulate a denied context");
  f.monitoring.setDisplayContext("project-b/actor-b");
  assert.equal(f.source.show, true); assert.equal(f.primitives.show, true);
  assert.equal(entity(f, "foundation-pit-anchor-hidden").show, true);
  assert.equal(entity(f, "foundation-pit-anchor-hidden").label!.show!.getValue(now), true);
  assert.equal(f.source.entities.getById("foundation-pit-model-hidden-bottom"), undefined);
  assert.equal(f.monitoring.getDisplayItems().find(item => item.id === "pit:model:hidden")!.visible, false);
  assert.deepEqual(f.state, before);
});

test("unknown display keys cannot acquire visibility overrides before an object exists", () => {
  const f = fixture();
  const marker = entity(f, "foundation-pit-anchor-visible");
  f.monitoring.setDisplayVisibility({ "pit:point:future": false, "foundation-pit-edit-handle": false });
  assert.equal(entity(f, marker.id), marker, "unknown overrides do not force a scene rebuild");
  f.state.points.push(point("future", null));
  f.internal.renderScene();
  assert.equal(entity(f, "foundation-pit-point-future").show, true);
  assert.equal(f.monitoring.getDisplayItems().find(item => item.id === "pit:point:future")!.visible, true);
});

test("an in-progress support handle survives display rebuilds without joining the catalogue", () => {
  const f = fixture(), before = structuredClone(f.state);
  const draft = f.source.entities.add({ id: "foundation-pit-custom-support-draft", position: Cartesian3.ZERO, point: { pixelSize: 9 } });
  Object.assign(f.monitoring, { pickMode: "support", customSupportStart: { x: 0, y: 0, z: -1 } });
  f.monitoring.setDisplayVisibility({ "pit:marker:hidden": false });
  assert.equal(entity(f, draft.id), draft, "a display preference must not discard the user's first selected support endpoint");
  assert.equal(draft.show, true);
  assert.equal(f.monitoring.getDisplayItems().length, 9);
  assert.equal(f.monitoring.getDisplayItems().some(item => item.id.includes("draft")), false);
  assert.deepEqual(f.state, before);
});

test("centre selection skips GPU picking without visible hints and resumes for saved-hidden pit centres", () => {
  const f = fixture();
  class Surface extends EventTarget { disableRootEvents = true; onwheel = null; }
  let picks = 0;
  const selected: string[] = [];
  Object.assign(f.monitoring, {
    interactionSuspensionDepth: 0,
    viewer: { scene: { canvas: new Surface(), requestRender() {}, pick() {
      picks++;
      return { id: f.source.entities.getById("foundation-pit-anchor-hidden") };
    } } },
    selectPitForManagement(pit: { id: string }, fromMap: boolean) {
      assert.equal(fromMap, true); selected.push(pit.id);
    },
  });
  const internal = f.monitoring as unknown as { bindCenterSelection(): void; centerSelectionHandler: ScreenSpaceEventHandler };
  internal.bindCenterSelection();
  try {
    const click = () => (internal.centerSelectionHandler.getInputAction(ScreenSpaceEventType.LEFT_CLICK) as ScreenSpaceEventHandler.PositionedEventCallback)({ position: new Cartesian2(1, 1) });
    const pits = f.state.pits;
    f.state.pits = [];
    for (let index = 0; index < 25; index++) click();
    assert.equal(picks, 0, "an empty pit catalogue does not issue GPU picks");
    f.state.pits = pits;
    f.monitoring.setDisplayVisibility({ "pit:marker:visible": false, "pit:marker:hidden": false });
    for (let index = 0; index < 25; index++) click();
    assert.equal(picks, 0, "visible pit models without centre hints do not issue GPU picks");
    f.monitoring.setDisplayVisibility({ "pit:marker:visible": false });
    f.source.show = false;
    click();
    assert.equal(picks, 0, "a hidden pit layer does not issue GPU picks");
    f.source.show = true;
    click();
    assert.equal(picks, 1);
    assert.deepEqual(selected, ["hidden"], "a saved-hidden model retains its selectable centre hint");
    for (let index = 0; index < 5; index++) {
      const resume = f.monitoring.suspendInteractions();
      click();
      assert.equal(picks, index + 1, "suspended interactions never pick");
      resume(); resume();
      click();
      assert.equal(picks, index + 2, "each resumed click issues exactly one pick");
    }
    assert.deepEqual(selected, Array(6).fill("hidden"));
  } finally {
    internal.centerSelectionHandler.destroy();
  }
});
