import test from "node:test";
import assert from "node:assert/strict";
import { ArcType, Cartesian3, Cartographic, JulianDate, PolygonGeometry, VertexFormat } from "cesium";
import { createSpatialDisplayEntity, spatialDisplayPositions, SPATIAL_DISPLAY_OFFSET_METERS } from "./safetySpatialDisplayGeometry.ts";
import { spatialFixture, spatialV3Fixture } from "./safetySpatial.testFixtures.ts";

test("saved area renders at original model-surface heights, never as a bridge-height classification volume", () => {
  const object = spatialV3Fixture(), original = structuredClone(object), time = JulianDate.now();
  const entity = createSpatialDisplayEntity(object), hierarchy = entity.polygon!.hierarchy!.getValue(time);
  assert.equal(entity.polygon!.perPositionHeight!.getValue(time), true);
  assert.equal(entity.polygon!.classificationType, undefined);
  assert.equal(entity.polyline!.clampToGround!.getValue(time), false);
  assert.equal(entity.polyline!.arcType!.getValue(time), ArcType.NONE);
  assert.equal(entity.polyline!.depthFailMaterial, undefined);
  const geometry = PolygonGeometry.createGeometry(new PolygonGeometry({ polygonHierarchy: hierarchy,
    perPositionHeight: true, vertexFormat: VertexFormat.POSITION_ONLY }));
  assert.ok(geometry);
  const attribute = geometry.attributes.position;
  assert.ok(attribute);
  const values = attribute.values;
  for (let i = 0; i < values.length; i += 3) {
    const height = Cartographic.fromCartesian(new Cartesian3(values[i], values[i + 1], values[i + 2])).height;
    assert.ok(Math.abs(height - (12 + SPATIAL_DISPLAY_OFFSET_METERS)) < 0.01, String(height));
  }
  assert.deepEqual(object, original);
});

test("display-only offset preserves independent surface elevations and the exact raw ECEF anchors", () => {
  const object = spatialV3Fixture();
  for (let i = 0; i < object.source.vertices.length; i++) {
    const anchor = object.source.vertices[i].anchor!;
    const world = Cartesian3.fromDegrees(120.89 + (i % 2) * .001, 30.836 + Math.floor(i / 2) * .001, 12 + i * 3);
    anchor.position = { space: "ecef-meters", x: world.x, y: world.y, z: world.z };
  }
  const original = structuredClone(object), displayed = spatialDisplayPositions(object);
  displayed.forEach((world, i) => {
    const raw = object.source.vertices[i].anchor!.position;
    assert.ok(Math.abs(Cartesian3.distance(world, new Cartesian3(raw.x, raw.y, raw.z)) - SPATIAL_DISPLAY_OFFSET_METERS) < 1e-8);
    assert.ok(Math.abs(Cartographic.fromCartesian(world).height - (12 + i * 3 + SPATIAL_DISPLAY_OFFSET_METERS)) < 1e-5);
  });
  assert.deepEqual(object, original);
});

test("legacy corridor and unassessed point remain separate source records without inferred area or alert", () => {
  const corridor = spatialFixture("railway"), risk = spatialV3Fixture("risk-point"), originals = structuredClone([corridor, risk]);
  const railEntity = createSpatialDisplayEntity(corridor), riskEntity = createSpatialDisplayEntity(risk);
  assert.equal(railEntity.polygon, undefined); assert.equal(railEntity.corridor, undefined);
  assert.equal(railEntity.polyline!.positions!.getValue(JulianDate.now()).length, 2);
  assert.ok(riskEntity.point); assert.equal(risk.level, "unassessed"); assert.equal(risk.risk, undefined);
  assert.deepEqual([corridor, risk], originals);
});
