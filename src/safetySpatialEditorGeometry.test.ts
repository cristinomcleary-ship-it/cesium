import test from "node:test";
import assert from "node:assert/strict";
import { Cartesian2, Cartesian3, Matrix4, type Cesium3DTileset, type Viewer } from "cesium";
import { validateDraftShape, nextSpatialName } from "./safetyDraftGeometry.ts";
import { strictModelSurfacePick, type RegisteredPhotogrammetry } from "./safetyModelSurfacePicker.ts";
import type { SafetyPosition } from "./safetyTypes.ts";

const points = (xy: number[][]): SafetyPosition[] => xy.map(([x, y]) => ({ longitude: 120 + x / 100_000, latitude: 30 + y / 100_000, height: 23 }));
test("polygon draft validation marks crossing edges without changing original points", () => {
  const vertices = points([[0, 0], [40, 40], [40, 0], [0, 40]]), original = structuredClone(vertices);
  const result = validateDraftShape("construction-area", vertices);
  assert.equal(result.ok, false); assert.deepEqual(result.badEdges, [0, 2]); assert.deepEqual(vertices, original);
});
test("polygon draft requires three different non-collinear points for both area types", () => {
  for (const kind of ["construction-area", "railway"] as const) {
    assert.equal(validateDraftShape(kind, points([[0, 0], [10, 0]])).ok, false);
    assert.equal(validateDraftShape(kind, points([[0, 0], [10, 0], [20, 0]])).ok, false);
    assert.equal(validateDraftShape(kind, points([[0, 0], [10, 0], [10, 10], [0, 0]])).ok, false);
    assert.equal(validateDraftShape(kind, points([[0, 0], [10, 0], [10, 10], [5, 5], [0, 10]])).ok, true);
  }
});
test("risk points require exactly one real position and default names avoid existing records", () => {
  assert.equal(validateDraftShape("risk-point", []).ok, false);
  assert.equal(validateDraftShape("risk-point", points([[0, 0]])).ok, true);
  assert.equal(validateDraftShape("risk-point", points([[0, 0], [10, 0]])).ok, false);
  assert.equal(nextSpatialName("railway", ["铁路范围 01", "铁路范围 02"]), "铁路范围 03");
});

function fixture() {
  const model = { show: true, modelMatrix: Matrix4.clone(Matrix4.IDENTITY), tilesLoaded: true, isDestroyed: () => false } as unknown as Cesium3DTileset;
  const other = { show: true }, initiallyHidden = { show: false }, source = { show: true, isDestroyed: false }, entities = { show: true, isDestroyed: () => false }, globe = { show: true };
  const nested = { show: true, length: 2, get: (index: number) => [model, other][index] };
  const primitives = { show: true, length: 2, get: (index: number) => [nested, initiallyHidden][index] };
  const ground = { show: true, length: 0, get: () => undefined };
  const screen = new Cartesian2(120, 140), world = Cartesian3.fromDegrees(120, 30, 25);
  const entry: RegisteredPhotogrammetry = { assetId: "photo-one", assetVersion: "v1", coordinateTransformVersion: "t1", projectId: "project", name: "Photo", url: "/photo", kind: "photogrammetry", matrix: Matrix4.toArray(Matrix4.IDENTITY), coordinateOffsets: { longitude: 0, latitude: 0, height: 0 }, capabilitySource: "test-registry", tileset: model };
  let depthCalls = 0, renders = 0;
  const scene = {
    primitives, groundPrimitives: ground, globe, pickPositionSupported: true, pickTranslucentDepth: true,
    pick: (_screen: Cartesian2, width: number, height: number): unknown => { assert.equal(width, 1); assert.equal(height, 1); return { primitive: model }; },
    pickPosition: () => { depthCalls++; assert.equal(scene.pickTranslucentDepth, false); return world; },
    cartesianToCanvasCoordinates: () => screen,
    requestRender: () => {},
  };
  const viewer = { scene, entities, canvas: { clientWidth: 1920, clientHeight: 1080 }, dataSources: { length: 1, get: () => source }, render: () => {
    renders++; assert.equal(globe.show, false); assert.equal(other.show, false); assert.equal(source.show, false); assert.equal(entities.show, false);
    assert.equal(model.show, true); assert.equal(nested.show, true); assert.equal(primitives.show, true); assert.equal(scene.pickTranslucentDepth, false);
  } } as unknown as Viewer;
  const restored = () => { assert.equal(other.show, true); assert.equal(initiallyHidden.show, false); assert.equal(model.show, true); assert.equal(source.show, true); assert.equal(entities.show, true); assert.equal(globe.show, true); assert.equal(ground.show, true); assert.equal(scene.pickTranslucentDepth, true); };
  return { viewer, scene, entry, screen, world, restored, counts: () => ({ depthCalls, renders }) };
}
test("strict picker isolates only registered model and stores matching double precision anchor", () => {
  const f = fixture(); let suspended = false, restored = false;
  const result = strictModelSurfacePick(f.viewer, f.screen, [f.entry], () => { suspended = true; return () => { restored = true; }; }, "project");
  assert.equal(result.ok, true); assert.equal(suspended && restored, true); f.restored();
  if (!result.ok) return;
  assert.deepEqual(result.anchor.position, { space: "ecef-meters", x: f.world.x, y: f.world.y, z: f.world.z });
  assert.equal(result.anchor.model.assetId, "photo-one"); assert.equal(result.anchor.provenance, "verified-project-photogrammetry-surface");
  assert.ok(Math.abs(result.position.height - 25) < 1e-5); assert.ok(Number.isFinite(Date.parse(result.anchor.pickedAt)));
});
test("sky or unregistered BIM pick never calls depth and never falls back", () => {
  for (const hit of [undefined, { primitive: {} }, { id: "photo-one" }]) {
    const f = fixture(); f.scene.pick = () => hit;
    assert.deepEqual(strictModelSurfacePick(f.viewer, f.screen, [f.entry]), { ok: false, reason: "no-model-hit" });
    assert.equal(f.counts().depthCalls, 0); f.restored();
  }
});
test("loading is reported without inventing a point", () => {
  const f = fixture(); Object.defineProperty(f.entry.tileset, "tilesLoaded", { value: false, configurable: true }); f.scene.pick = () => undefined;
  assert.deepEqual(strictModelSurfacePick(f.viewer, f.screen, [f.entry]), { ok: false, reason: "model-loading" }); f.restored();
});
test("changed runtime transform, hidden model and foreign project are refused before rendering", () => {
  const a = fixture(); a.entry.tileset.modelMatrix = Matrix4.fromTranslation(new Cartesian3(10, 0, 0));
  assert.deepEqual(strictModelSurfacePick(a.viewer, a.screen, [a.entry]), { ok: false, reason: "model-version-unavailable" }); assert.equal(a.counts().renders, 0);
  const b = fixture(); b.entry.tileset.show = false; assert.equal(strictModelSurfacePick(b.viewer, b.screen, [b.entry]).ok, false); assert.equal(b.counts().renders, 0);
  const c = fixture(); assert.equal(strictModelSurfacePick(c.viewer, c.screen, [c.entry], undefined, "other-project").ok, false); assert.equal(c.counts().renders, 0);
});
test("invalid depth, reprojected pixel mismatch and render failure restore every visibility flag", () => {
  const a = fixture(); a.scene.pickPosition = () => new Cartesian3(NaN, 0, 0);
  assert.deepEqual(strictModelSurfacePick(a.viewer, a.screen, [a.entry]), { ok: false, reason: "invalid-depth" }); a.restored();
  const b = fixture(); b.scene.cartesianToCanvasCoordinates = () => new Cartesian2(10, 20);
  assert.deepEqual(strictModelSurfacePick(b.viewer, b.screen, [b.entry]), { ok: false, reason: "invalid-depth" }); b.restored();
  const c = fixture(); c.viewer.render = () => { throw new Error("render failed"); };
  assert.deepEqual(strictModelSurfacePick(c.viewer, c.screen, [c.entry]), { ok: false, reason: "invalid-depth" }); c.restored();
});
test("a changed same-pixel object after isolation rejects the pick", () => {
  const f = fixture(); let count = 0; f.scene.pick = () => count++ === 0 ? { primitive: f.entry.tileset } : { primitive: {} };
  assert.deepEqual(strictModelSurfacePick(f.viewer, f.screen, [f.entry]), { ok: false, reason: "overlay-hit" }); assert.equal(f.counts().depthCalls, 0); f.restored();
});
