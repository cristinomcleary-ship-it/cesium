import assert from "node:assert/strict";
import test from "node:test";
import {
  Appearance, BoundingSphere, Cartesian3, Color, CustomDataSource, CustomShader,
  CustomShaderTranslucencyMode, Event, GroundPolylinePrimitive, JulianDate, Matrix4,
  PolygonHierarchy, PolylineColorAppearance, Primitive, PrimitiveCollection,
  Transforms, UniformType, type Viewer,
} from "cesium";
import { VideoOverlayResources } from "./videoOverlayResources.ts";
import type { CadImportPackage } from "./cadImport.ts";
import type { LibraryRecord } from "./projectLibrary.ts";
import type { ImportRecord } from "./types.ts";

const center = Cartesian3.fromDegrees(120, 30, 25);
const base = Transforms.eastNorthUpToFixedFrame(center);
function viewer(primitives = new PrimitiveCollection(), autoCompile = true): Viewer {
  const postRender = new Event();
  let queued = false;
  const compile = (resource: unknown) => {
    if (resource instanceof PrimitiveCollection) {
      if (resource.show) for (let index = 0; index < resource.length; index++) compile(resource.get(index));
    } else if (resource instanceof Primitive) (resource as unknown as { _ready: boolean })._ready = true;
  };
  return { clock: { currentTime: JulianDate.now() }, scene: { primitives, postRender, requestRender() {
    if (!autoCompile || queued || !postRender.numberOfListeners) return;
    queued = true;
    queueMicrotask(() => { queued = false; compile(primitives); postRender.raiseEvent(); });
  } } } as unknown as Viewer;
}
function model(id: string, show = true) {
  const resource = { show, modelMatrix: Matrix4.clone(base), boundingSphere: new BoundingSphere(center, 20), isDestroyed: () => false };
  return { record: { id, name: id, kind: "Model", visible: show, resource } as ImportRecord, resource };
}
function localDisplacement(actual: Cartesian3, anchor = center): Cartesian3 {
  return Matrix4.multiplyByPoint(Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(anchor), new Matrix4()), actual, new Cartesian3());
}
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`); }

test("ENU edits are absolute, are video-local, and selection restores all imported layer visibility", async () => {
  const first = model("a"), second = model("b", false);
  const gis = { show: true };
  const imports = [first.record, second.record, { id: "gis", name: "gis", kind: "GIS", visible: true, resource: gis } as ImportRecord];
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  assert.equal(gis.show, false);
  session.setSelection(["a", "b"]);
  assert.equal(first.resource.show, true);
  assert.equal(second.resource.show, true);
  assert.equal(second.record.visible, false);
  session.applyAdjustments({ a: { east: 10, north: 4, up: 3 } });
  const once = Matrix4.clone(first.resource.modelMatrix);
  session.applyAdjustments({ a: { east: 10, north: 4, up: 3 } });
  assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
  const position = localDisplacement(Matrix4.getTranslation(once, new Cartesian3()));
  close(position.x, 10); close(position.y, 4); close(position.z, 3);
  session.setVisible(false);
  assert.equal(first.resource.show, false);
  assert.equal(session.get("a")?.selected, true);
  session.setVisible(true);
  assert.equal(first.resource.show, true);
  const saved = session.getAdjustments();
  saved.a.east = 999;
  assert.equal(session.getAdjustments().a.east, 10);
  session.restore(); session.restore();
  assert.ok(Matrix4.equals(first.resource.modelMatrix, base));
  assert.equal(first.resource.show, true);
  assert.equal(second.resource.show, false);
  assert.equal(gis.show, true);
  const restored = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  restored.applyAdjustments({ a: { east: 10, north: 4, up: 3 } });
  assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
  restored.restore();
});

test("CAD entity lines, polygons including holes, and text retain sampled heights and restore original properties", async () => {
  const data = new CustomDataSource("sampled");
  const at = (east: number, north: number, up: number) => Matrix4.multiplyByPoint(base, new Cartesian3(east, north, up), new Cartesian3());
  const line = data.entities.add({ polyline: { positions: [at(0, 0, 12), at(10, 0, 15)], clampToGround: false } });
  const polygon = data.entities.add({ polygon: {
    hierarchy: new PolygonHierarchy([at(0, 0, 12), at(20, 0, 12), at(0, 20, 12)], [new PolygonHierarchy([at(2, 2, 12), at(3, 2, 12), at(2, 3, 12)])]),
    perPositionHeight: true,
  } });
  const label = data.entities.add({ position: at(3, 3, 17), label: { text: "sampled" } });
  const lineProperty = line.polyline!.positions, hierarchyProperty = polygon.polygon!.hierarchy, labelProperty = label.position;
  const imports = [{ id: "cad", name: "sampled", kind: "CAD", representation: "dataSource", visible: true, resource: data } as ImportRecord];
  const view = viewer();
  const time = view.clock.currentTime;
  const originalLine = lineProperty!.getValue(time) as Cartesian3[];
  const session = await VideoOverlayResources.create({ viewer: view, imports: () => imports, getRecord: () => undefined });
  assert.match(session.get("cad")!.description, /已采样/);
  session.applyAdjustments({ cad: { up: 5 } });
  const once = line.polyline!.positions!.getValue(time) as Cartesian3[];
  const adjustedLineProperty = line.polyline!.positions;
  assert.ok(Math.abs(Cartesian3.distance(once[0], originalLine[0]) - 5) < 1e-6);
  const hierarchy = polygon.polygon!.hierarchy!.getValue(time) as PolygonHierarchy;
  assert.equal(hierarchy.holes.length, 1);
  assert.ok(Cartesian3.distance(hierarchy.holes[0].positions[0], hierarchyProperty!.getValue(time).holes[0].positions[0]) > 4.99);
  session.applyAdjustments({ cad: { up: 5 } });
  assert.equal(line.polyline!.positions, adjustedLineProperty, 'repeating an offset must not replace every CAD property');
  assert.deepEqual(line.polyline!.positions!.getValue(time), once);
  session.restore();
  assert.equal(line.polyline!.positions, lineProperty);
  assert.equal(polygon.polygon!.hierarchy, hierarchyProperty);
  assert.equal(label.position, labelProperty);
});

test("recursive primitive CAD transforms leaves about the object's fixed center", async () => {
  const nested = new PrimitiveCollection(), root = new PrimitiveCollection();
  const leaf = { show: true, modelMatrix: Matrix4.clone(Matrix4.IDENTITY), isDestroyed: () => false, destroy() {} };
  nested.add(leaf); root.add(nested);
  const record: ImportRecord = { id: "cad", name: "cad", kind: "CAD", representation: "primitive", visible: true, resource: root, boundingSphere: new BoundingSphere(center, 30) };
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [record], getRecord: () => undefined });
  session.applyAdjustments({ cad: { heading: 90, east: 2 } });
  const eastPoint = Matrix4.multiplyByPoint(base, new Cartesian3(10, 0, 0), new Cartesian3());
  const moved = localDisplacement(Matrix4.multiplyByPoint(leaf.modelMatrix, eastPoint, new Cartesian3()));
  close(moved.x, 2); close(moved.y, -10); close(moved.z, 0);
  session.restore();
  assert.ok(Matrix4.equals(leaf.modelMatrix, Matrix4.IDENTITY));
  root.destroy();
});

const drawing: CadImportPackage = {
  format: "cesium-cad-import", version: 2,
  source: { name: "ground.dwg", format: "DWG", generatedAt: "2026-10-18T00:00:00Z" },
  statistics: { sourceEntities: 1, displayEntities: 1, skippedEntities: 0, unknownEntities: 0, layers: ["0"] },
  entities: [{ type: "POLYLINE", sourceType: "LINE", layer: "0", vertices: [{ x: 0, y: 0, z: 12 }, { x: 10, y: 0, z: 12 }] }], warnings: [],
};
function savedCad(): LibraryRecord {
  return { version: 1, id: "cad", name: "ground", kind: "CAD", visible: true, createdAt: "", updatedAt: "",
    files: { data: { name: "ground.cadimport", url: "/saved/ground.cadimport" } },
    settings: { displayMode: "terrain", coordinates: { mode: "local", longitude: 120, latitude: 30, altitude: 25, referenceX: 0, referenceY: 0, rotation: 0, scale: 1 } },
  };
}

// No WebGL context is needed to test replacement of an already-loaded ground primitive.
function groundSource(): GroundPolylinePrimitive {
  return Object.assign(Object.create(GroundPolylinePrimitive.prototype), { show: true, isDestroyed: () => false, destroy() {} });
}

test("ground CAD uses an absolute-height copy, discloses height change, and destroys copy on exit", async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(drawing), { status: 200 });
  const root = new PrimitiveCollection(), original = new PrimitiveCollection();
  original.add(groundSource()); root.add(original);
  const record: ImportRecord = { id: "cad", name: "ground", kind: "CAD", representation: "primitive", resource: original, visible: true };
  try {
    const session = await VideoOverlayResources.create({ viewer: viewer(root), imports: () => [record], getRecord: savedCad });
    assert.equal(session.get("cad")!.available, true);
    assert.match(session.get("cad")!.description, /按图纸标高叠加，可用高程微调/);
    assert.equal(root.length, 2);
    session.setSelection(["cad"]);
    assert.equal(original.show, false);
    const copy = root.get(1) as PrimitiveCollection;
    assert.equal(copy.show, true);
    session.applyAdjustments({ cad: { up: 7 } });
    assert.ok(!Matrix4.equals(copy.get(0).modelMatrix, Matrix4.IDENTITY));
    session.restore();
    assert.equal(root.length, 1);
    assert.equal(original.show, true);
    assert.equal(copy.isDestroyed(), true);
  } finally { globalThis.fetch = fetchBefore; root.destroy(); }
});

test("cancel during ground source fetch restores every layer, including non-CAD resources", async () => {
  const fetchBefore = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    queueMicrotask(() => controller.abort());
  });
  const root = new PrimitiveCollection(), original = new PrimitiveCollection();
  original.add(groundSource()); root.add(original);
  const gis = { show: true };
  const imports: ImportRecord[] = [
    { id: "cad", name: "ground", kind: "CAD", representation: "primitive", resource: original, visible: true },
    { id: "gis", name: "gis", kind: "GIS", resource: gis, visible: true },
  ];
  try {
    await assert.rejects(VideoOverlayResources.create({ viewer: viewer(root), imports: () => imports, getRecord: savedCad, signal: controller.signal }), { name: "AbortError" });
    assert.equal(original.show, true);
    assert.equal(gis.show, true);
    assert.equal(root.length, 1);
  } finally { globalThis.fetch = fetchBefore; root.destroy(); }
});

test("invalid offsets fail before touching any valid object", async () => {
  const first = model("a"), second = model("b");
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record, second.record], getRecord: () => undefined });
  assert.throws(() => session.applyAdjustments({ a: { east: 1 }, b: { up: Number.NaN } }), /有限数值/);
  assert.ok(Matrix4.equals(first.resource.modelMatrix, base));
  session.restore();
});


test("restored CAD waits for the geometry worker before snapshotting and applying offsets", async () => {
  const root = new PrimitiveCollection(), nested = new PrimitiveCollection({ show: false });
  const leaf = new Primitive(), originallyHidden = new Primitive({ show: false });
  (originallyHidden as unknown as { _ready: boolean })._ready = true;
  nested.add(leaf); nested.add(originallyHidden); root.add(nested);
  const sceneRoot = new PrimitiveCollection(); sceneRoot.add(root);
  const record: ImportRecord = { id: "cad", name: "restored", kind: "CAD", representation: "primitive", resource: root, visible: true, boundingSphere: new BoundingSphere(center, 20) };
  const view = viewer(sceneRoot, false);
  let resolved = false;
  const creating = VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined }).then(value => { resolved = true; return value; });
  await Promise.resolve();
  assert.equal(resolved, false, "ready library records alone do not mean GPU geometry has compiled");
  assert.equal(root.show, true); assert.equal(nested.show, true);
  assert.equal(leaf.show, false); assert.equal(originallyHidden.show, false, "compilation cannot expose CAD");
  // Match Cesium's asynchronous combine callback, which writes its captured matrix.
  leaf.modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
  (leaf as unknown as { _ready: boolean })._ready = true;
  view.scene.postRender.raiseEvent(view.scene, view.clock.currentTime);
  const session = await creating;
  assert.equal(root.show, false); assert.equal(nested.show, false);
  assert.equal(leaf.show, true); assert.equal(originallyHidden.show, false);
  session.setSelection(["cad"]); session.applyAdjustments({ cad: { east: 3, north: -2, up: 29 } });
  const moved = localDisplacement(Matrix4.multiplyByPoint(leaf.modelMatrix, center, new Cartesian3()));
  close(moved.x, 3); close(moved.y, -2); close(moved.z, 29);
  assert.equal(view.scene.postRender.numberOfListeners, 0);
  session.restore();
  assert.equal(root.show, true); assert.equal(nested.show, false); assert.equal(leaf.show, true);
  assert.ok(Matrix4.equals(leaf.modelMatrix, Matrix4.IDENTITY));
  sceneRoot.destroy();
});

test("cancelling CAD compilation restores the user's layer and removes readiness listeners", async () => {
  const root = new PrimitiveCollection(), leaf = new Primitive(); root.add(leaf);
  const controller = new AbortController(), view = viewer(new PrimitiveCollection(), false);
  const record: ImportRecord = { id: "cad", name: "pending", kind: "CAD", representation: "primitive", resource: root, visible: true, boundingSphere: new BoundingSphere(center, 20) };
  const creating = VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined, signal: controller.signal });
  controller.abort();
  await assert.rejects(creating, { name: "AbortError" });
  assert.equal(root.show, true); assert.equal(leaf.show, true);
  assert.equal(view.scene.postRender.numberOfListeners, 0);
  root.destroy();
});

test("CAD removed or denied during compilation stays unavailable and hidden", async () => {
  for (const destroy of [false, true]) {
    const root = new PrimitiveCollection(), leaf = new Primitive(); root.add(leaf);
    const view = viewer(new PrimitiveCollection(), false);
    const record: ImportRecord = { id: "cad", name: "pending", kind: "CAD", representation: "primitive", resource: root, visible: true, boundingSphere: new BoundingSphere(center, 20) };
    let imports = [record];
    const creating = VideoOverlayResources.create({ viewer: view, imports: () => imports, getRecord: () => undefined });
    if (destroy) root.destroy(); else imports = [];
    view.scene.postRender.raiseEvent(view.scene, view.clock.currentTime);
    const session = await creating;
    assert.equal(session.get("cad")?.available, false);
    session.setSelection(["cad"]);
    if (!destroy) assert.equal(root.show, false);
    assert.equal(view.scene.postRender.numberOfListeners, 0);
    session.restore();
    if (!destroy) root.destroy();
  }
});


test("CAD compilation timeout is bounded and restores temporary visibility", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const root = new PrimitiveCollection(), leaf = new Primitive(); root.add(leaf);
  const view = viewer(new PrimitiveCollection(), false);
  const record: ImportRecord = { id: "cad", name: "pending", kind: "CAD", representation: "primitive", resource: root, visible: true, boundingSphere: new BoundingSphere(center, 20) };
  const creating = VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined });
  context.mock.timers.tick(60_000);
  const session = await creating;
  assert.equal(session.get("cad")?.available, false);
  assert.match(session.get("cad")?.error ?? "", /准备超时/);
  assert.equal(root.show, false); assert.equal(leaf.show, true);
  assert.equal(view.scene.postRender.numberOfListeners, 0);
  session.restore(); assert.equal(root.show, true);
  root.destroy();
});

test('resource lookup stays linear and unchanged frames never rewrite visibility or zero transforms', async () => {
  const models = Array.from({ length: 80 }, (_, index) => model(`model-${index}`));
  const imports = models.map(item => item.record);
  let reads = 0, shows = 0, matrices = 0, renders = 0;
  for (const { resource } of models) {
    let show = resource.show, matrix = resource.modelMatrix;
    Object.defineProperty(resource, 'show', { get: () => show, set: value => { shows++; show = value; }, configurable: true });
    Object.defineProperty(resource, 'modelMatrix', { get: () => matrix, set: value => { matrices++; matrix = value; }, configurable: true });
  }
  const view = viewer(); view.scene.requestRender = () => { renders++; };
  const session = await VideoOverlayResources.create({ viewer: view, imports: () => { reads++; return imports; }, getRecord: () => undefined });
  session.setSelection(imports.map(item => item.id));
  reads = shows = matrices = renders = 0;
  assert.equal(session.list().length, imports.length); assert.equal(reads, 1);
  assert.equal(session.get('model-40')?.available, true); assert.equal(reads, 2);
  reads = 0;
  for (let frame = 0; frame < 30; frame++) session.setVisible(true);
  assert.equal(reads, 30, 'one import snapshot per frame, independent of layer count');
  assert.equal(shows, 0); assert.equal(renders, 0);
  reads = 0;
  session.applyAdjustments(Object.fromEntries(imports.map(item => [item.id, { east: 0, north: 0, up: 0, heading: 0 }])));
  assert.equal(reads, 1); assert.equal(matrices, 0); assert.equal(renders, 0);
  session.restore();
  assert.equal(shows, 0); assert.equal(matrices, 0, 'untouched map matrices need no restoration setter');
});

test('unchanged entity CAD playback emits no per-entity visibility changes and still applies revocation', async () => {
  const data = new CustomDataSource('entity-cad');
  let events = 0;
  for (let index = 0; index < 40; index++) {
    const entity = data.entities.add({ polyline: { positions: [center, Cartesian3.add(center, new Cartesian3(index + 1, 2, 3), new Cartesian3())], clampToGround: false } });
    entity.definitionChanged.addEventListener((_entity, property) => { if (property === 'isShowing') events++; });
  }
  let imports = [{ id: 'cad', name: 'entity-cad', kind: 'CAD', representation: 'dataSource', resource: data, visible: true } as ImportRecord];
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  session.setSelection(['cad']); events = 0;
  for (let frame = 0; frame < 30; frame++) session.setVisible(true);
  assert.equal(events, 0, 'selected CAD must not be hidden and re-shown each video frame');
  imports = []; session.setVisible(true);
  assert.equal(data.show, false); assert.equal(events, data.entities.values.length);
  session.restore();
});

test('model effects preserve material alpha and original shader, reuse one translucent shader and never compound', async () => {
  const first = model('model');
  const original = new CustomShader({
    uniforms: { u_original: { type: UniformType.FLOAT, value: .6 } },
    fragmentShaderText: 'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { material.alpha *= u_original; }',
  });
  const resource = Object.assign(first.resource, { customShader: original, color: Color.RED.withAlpha(.7), ready: true, _drawCommandsBuilt: true });
  const originalColor = resource.color;
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record], getRecord: () => undefined });
  session.setSelection(['model']);
  session.setTimelineOpacity({ model: { opacity: 1, visible: true } });
  assert.equal(resource.customShader, original, 'old plans need no shader replacement');
  session.setTimelineOpacity({ model: { opacity: .5, visible: true } });
  const owned = resource.customShader;
  assert.notEqual(owned, original);
  assert.equal(owned.translucencyMode, CustomShaderTranslucencyMode.TRANSLUCENT);
  assert.equal(owned.uniforms.u_original, original.uniforms.u_original);
  assert.match(owned.fragmentShaderText, /arOriginalFragmentMain\(fsInput, material\)/);
  assert.match(owned.fragmentShaderText, /material.alpha \*= u_arPresentationOpacity/);
  assert.equal(owned.uniforms.u_arPresentationOpacity.value, .5);
  for (let frame = 0; frame < 20; frame++) session.setTimelineOpacity({ model: { opacity: .5, visible: true } });
  assert.equal(resource.customShader, owned); assert.equal(owned.uniforms.u_arPresentationOpacity.value, .5);
  assert.equal(resource.color, originalColor); assert.equal(resource.color.alpha, .7);
  session.setTimelineOpacity({ model: { opacity: 0, visible: false } });
  assert.equal(resource.show, false); assert.equal(session.get('model')?.selected, true);
  session.setTimelineOpacity({ model: { opacity: 1, visible: true } });
  assert.equal(resource.show, true); assert.equal(resource.customShader, owned);
  assert.equal(owned.uniforms.u_arPresentationOpacity.value, 1);
  session.restore();
  assert.equal(resource.customShader, original); assert.equal(resource.color, originalColor);
  assert.equal(owned.isDestroyed(), true); assert.equal(original.isDestroyed(), false);
  original.destroy();
});

test('model command rebuild readiness gates fused output while alpha-hidden or unselected objects do not block', async () => {
  const first = model('model');
  const resource = Object.assign(first.resource, { ready: false, _drawCommandsBuilt: false });
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record], getRecord: () => undefined });
  assert.equal(session.isPresentationReady(), true);
  session.setSelection(['model']); assert.equal(session.isPresentationReady(), false);
  resource.ready = true; assert.equal(session.isPresentationReady(), false);
  resource._drawCommandsBuilt = true; assert.equal(session.isPresentationReady(), true);
  resource._drawCommandsBuilt = false;
  session.setTimelineOpacity({ model: { opacity: 0, visible: false } });
  assert.equal(session.isPresentationReady(), true);
  session.setTimelineOpacity({ model: { opacity: .2, visible: true } });
  assert.equal(session.isPresentationReady(), false);
  resource._drawCommandsBuilt = true; assert.equal(session.isPresentationReady(), true);
  session.restore(); assert.equal(session.isPresentationReady(), false);
});

test('primitive CAD fading retains original depth shader, uses one numeric uniform and restores appearance', async () => {
  const appearance = new PolylineColorAppearance({
    translucent: false,
    fragmentShaderSource: 'in vec4 v_color; void main() { out_FragColor = v_color; czm_writeLogDepth(); }',
  });
  const primitive = new Primitive({ appearance });
  const collection = new PrimitiveCollection(); collection.add(primitive);
  const record: ImportRecord = { id: 'cad', name: 'cad', kind: 'CAD', representation: 'primitive', resource: collection, visible: true, boundingSphere: new BoundingSphere(center, 10) };
  const session = await VideoOverlayResources.create({ viewer: viewer(collection), imports: () => [record], getRecord: () => undefined });
  session.setSelection(['cad']); session.setTimelineOpacity({ cad: { opacity: .5, visible: true } });
  const owned = primitive.appearance;
  assert.ok(owned instanceof Appearance); assert.notEqual(owned, appearance);
  assert.equal(owned.isTranslucent(), true);
  assert.match(owned.fragmentShaderSource, /czm_writeLogDepth/);
  assert.match(owned.fragmentShaderSource, /out_FragColor.a \*= arPresentationOpacity\(\)/);
  assert.equal(owned.material.uniforms.arOpacity, .5);
  for (let frame = 0; frame < 5; frame++) session.setTimelineOpacity({ cad: { opacity: .3, visible: true } });
  assert.equal(primitive.appearance, owned); assert.equal(owned.material.uniforms.arOpacity, .3);
  session.restore();
  assert.equal(primitive.appearance, appearance); assert.equal(owned.material.isDestroyed(), true);
  collection.destroy();
});

test('entity CAD fading reads original color properties at every time without multiplying prior output', async () => {
  const data = new CustomDataSource('colored');
  const line = data.entities.add({ polyline: { positions: [center, Cartesian3.add(center, new Cartesian3(1, 2, 3), new Cartesian3())], material: Color.RED.withAlpha(.6), clampToGround: false } });
  const opaque = data.entities.add({ polyline: { positions: [center, Cartesian3.add(center, new Cartesian3(2, 3, 4), new Cartesian3())], material: Color.WHITE, clampToGround: false } });
  const label = data.entities.add({ position: center, label: { text: 'CAD', fillColor: Color.BLUE.withAlpha(.8) } });
  const originalMaterial = line.polyline!.material, originalFill = label.label!.fillColor;
  const imports: ImportRecord[] = [{ id: 'cad', name: 'cad', kind: 'CAD', representation: 'dataSource', resource: data, visible: true }];
  const view = viewer(), session = await VideoOverlayResources.create({ viewer: view, imports: () => imports, getRecord: () => undefined });
  session.setSelection(['cad']); session.setTimelineOpacity({ cad: { opacity: .5, visible: true } });
  const ownedMaterial = line.polyline!.material, ownedFill = label.label!.fillColor;
  for (let frame = 0; frame < 10; frame++) {
    session.setTimelineOpacity({ cad: { opacity: .5, visible: true } });
    close(line.polyline!.material!.getValue(view.clock.currentTime).color.alpha, .3);
    close(label.label!.fillColor!.getValue(view.clock.currentTime).alpha, .4);
  }
  session.setTimelineOpacity({});
  close(line.polyline!.material!.getValue(view.clock.currentTime).color.alpha, .6);
  const alpha = opaque.polyline!.material!.getValue(view.clock.currentTime).color.alpha as number;
  assert.ok(alpha < 1, 'CPU material batching retains its fixed translucent pass');
  assert.equal(Math.fround(alpha), 1, 'GPU float precision retains exact full opacity');
  assert.equal(line.polyline!.material, ownedMaterial); assert.equal(label.label!.fillColor, ownedFill);
  session.restore();
  assert.equal(line.polyline!.material, originalMaterial); assert.equal(label.label!.fillColor, originalFill);
});

test('an external shader owner wins over restore and even a failing restore setter releases the owned shader', async () => {
  const first = model('model');
  const resource = first.resource as typeof first.resource & { customShader?: CustomShader };
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record], getRecord: () => undefined });
  session.setSelection(['model']); session.setTimelineOpacity({ model: { opacity: .5, visible: true } });
  const owned = resource.customShader!;
  const external = new CustomShader({}); resource.customShader = external;
  session.restore(); assert.equal(resource.customShader, external); assert.equal(owned.isDestroyed(), true);
  external.destroy();
  const second = model('second');
  const target = second.resource as typeof second.resource & { customShader?: CustomShader };
  const another = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [second.record], getRecord: () => undefined });
  another.setTimelineOpacity({ second: { opacity: .5, visible: true } });
  const shader = target.customShader!;
  Object.defineProperty(target, 'customShader', { get: () => shader, set() { throw new Error('host already disposed'); }, configurable: true });
  assert.doesNotThrow(() => another.restore()); assert.equal(shader.isDestroyed(), true);
  assert.deepEqual(another.list(), []); assert.deepEqual(another.getAdjustments(), {});
});

test('a non-owning host still destroys temporary absolute CAD copies on exit', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(drawing), { status: 200 });
  const root = new PrimitiveCollection({ destroyPrimitives: false }), original = new PrimitiveCollection();
  original.add(groundSource()); root.add(original);
  const record: ImportRecord = { id: 'cad', name: 'ground', kind: 'CAD', representation: 'primitive', resource: original, visible: true };
  try {
    const session = await VideoOverlayResources.create({ viewer: viewer(root), imports: () => [record], getRecord: savedCad });
    const copy = root.get(1) as PrimitiveCollection;
    session.restore();
    assert.equal(root.length, 1); assert.equal(copy.isDestroyed(), true);
  } finally { globalThis.fetch = fetchBefore; root.destroy(); original.destroy(); }
});
