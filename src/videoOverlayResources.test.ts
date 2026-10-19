import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundingSphere, Cartesian3, CustomDataSource, GroundPolylinePrimitive,
  JulianDate, Matrix4, PolygonHierarchy, PrimitiveCollection, Transforms, type Viewer,
} from "cesium";
import { VideoOverlayResources } from "./videoOverlayResources.ts";
import type { CadImportPackage } from "./cadImport.ts";
import type { LibraryRecord } from "./projectLibrary.ts";
import type { ImportRecord } from "./types.ts";

const center = Cartesian3.fromDegrees(120, 30, 25);
const base = Transforms.eastNorthUpToFixedFrame(center);
function viewer(primitives = new PrimitiveCollection()): Viewer {
  return { clock: { currentTime: JulianDate.now() }, scene: { primitives, requestRender() {} } } as unknown as Viewer;
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
