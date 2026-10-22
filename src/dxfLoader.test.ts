import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  Cartesian3, Cartographic, CustomDataSource, HeightReference, JulianDate, PolygonHierarchy, PrimitiveCollection,
  type Scene,
} from "cesium";
import { clampCadToScene, getCadModelSamplingExclusions, sampleCadHeights, useSampledCadHeights } from "./dxfLoader.ts";
import type { ImportRecord } from "./types.ts";

const originalAnimationFrame = globalThis.requestAnimationFrame;
before(() => { globalThis.requestAnimationFrame = callback => { queueMicrotask(() => callback(performance.now())); return 1; }; });
after(() => { globalThis.requestAnimationFrame = originalAnimationFrame; });

const time = JulianDate.now();
const point = (index: number, height = 12) => Cartesian3.fromDegrees(120 + index * 1e-6, 30, height);
const height = (position: Cartesian3) => Cartographic.fromCartesian(position).height;
function onSurface(position: Cartesian3) {
  const value = Cartographic.fromCartesian(position);
  return Cartesian3.fromRadians(value.longitude, value.latitude, 100);
}
function makeLine(data: CustomDataSource, count: number) {
  return data.entities.add({ polyline: { positions: Array.from({ length: count }, (_, index) => point(index)), clampToGround: true } });
}

test("ordinary-model CAD samples every vertex beyond 2000 in bounded batches and excludes itself", async () => {
  const data = new CustomDataSource("large CAD");
  const short = makeLine(data, 2), long = makeLine(data, 2201);
  const source = long.polyline!.positions!.getValue(time).map((p: Cartesian3) => Cartesian3.clone(p));
  const excludedObject = {};
  const sizes: number[] = [];
  const scene = { clampToHeightSupported: true, async clampToHeightMostDetailed(points: Cartesian3[], excluded: object[]) {
    sizes.push(points.length);
    assert.ok(excluded.includes(short)); assert.ok(excluded.includes(long)); assert.ok(excluded.includes(excludedObject));
    return points.map(onSurface);
  } } as unknown as Scene;
  const result = await clampCadToScene(data, scene, { objectsToExclude: [excludedObject] });
  assert.deepEqual(result, { clamped: 2203, skipped: 0 });
  assert.equal(sizes.reduce((sum, value) => sum + value, 0), 2203);
  assert.ok(sizes.every(size => size <= 200));
  useSampledCadHeights(data);
  for (const entity of [short, long]) {
    assert.equal(entity.polyline!.clampToGround!.getValue(time), false);
    assert.ok(entity.polyline!.positions!.getValue(time).every((p: Cartesian3) => Math.abs(height(p) - 100) < 1e-6));
  }
  assert.ok(source.every((p: Cartesian3) => Math.abs(height(p) - 12) < 1e-6));
});

test("a later missing surface rejects the complete operation without applying earlier successful samples", async () => {
  const data = new CustomDataSource("partial coverage");
  const first = makeLine(data, 2), second = makeLine(data, 3);
  const properties = [first.polyline!.positions, second.polyline!.positions];
  let calls = 0;
  await assert.rejects(sampleCadHeights(data, async points => ++calls === 1 ? points.map(onSurface) : [onSurface(points[0]), undefined, onSurface(points[2])]), /未能依附到表面/);
  assert.equal(calls, 2);
  [first, second].forEach((entity, index) => {
    assert.equal(entity.polyline!.positions, properties[index]);
    assert.equal(entity.polyline!.clampToGround!.getValue(time), true);
    assert.ok(entity.polyline!.positions!.getValue(time).every((p: Cartesian3) => Math.abs(height(p) - 12) < 1e-6));
  });
});

test("unsupported depth sampling fails explicitly and leaves CAD attached to its original height mode", async () => {
  const data = new CustomDataSource("unsupported");
  const line = makeLine(data, 2), original = line.polyline!.positions;
  const scene = { clampToHeightSupported: false, clampToHeightMostDetailed() { assert.fail("unsupported sampling must not run"); } } as unknown as Scene;
  await assert.rejects(clampCadToScene(data, scene), /不支持模型表面高程采样/);
  assert.equal(line.polyline!.positions, original);
  assert.equal(line.polyline!.clampToGround!.getValue(time), true);
});

test("a rejected surface query leaves all positions unchanged, even if the sampler changed its input", async () => {
  const data = new CustomDataSource("query failure");
  const line = makeLine(data, 201), original = line.polyline!.positions;
  const originalFirst = Cartesian3.clone(original!.getValue(time)[0]);
  let calls = 0;
  await assert.rejects(sampleCadHeights(data, async points => {
    points[0].z += 500;
    if (++calls === 2) throw new Error("surface unavailable");
    return points.map(onSurface);
  }), /surface unavailable/);
  assert.equal(line.polyline!.positions, original);
  assert.deepEqual(original!.getValue(time)[0], originalFirst);
});

test("cancel during a pending surface query rejects promptly and late completion never writes CAD", async () => {
  const data = new CustomDataSource("cancelled");
  const line = makeLine(data, 2), original = line.polyline!.positions;
  const controller = new AbortController();
  let finish!: (positions: Cartesian3[]) => void;
  const pending = sampleCadHeights(data, () => new Promise(resolve => { finish = resolve; }), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  finish([point(0, 100), point(1, 100)]);
  await Promise.resolve();
  assert.equal(line.polyline!.positions, original);
  assert.equal(line.polyline!.clampToGround!.getValue(time), true);
});

test("sampling retains polygon holes and samples label positions along with outer rings", async () => {
  const data = new CustomDataSource("holes and label");
  const hole = new PolygonHierarchy([point(3), point(4), point(5)]);
  const face = data.entities.add({ polygon: { hierarchy: new PolygonHierarchy([point(0), point(1), point(2)], [hole]), perPositionHeight: false } });
  const label = data.entities.add({ position: point(6), label: { text: "A", heightReference: HeightReference.CLAMP_TO_3D_TILE } });
  const result = await sampleCadHeights(data, async points => points.map(onSurface));
  assert.deepEqual(result, { clamped: 7, skipped: 0 });
  const hierarchy = face.polygon!.hierarchy!.getValue(time) as PolygonHierarchy;
  assert.equal(hierarchy.holes.length, 1);
  assert.equal(hierarchy.holes[0].positions.length, 3);
  assert.ok([...hierarchy.positions, ...hierarchy.holes[0].positions, label.position!.getValue(time)!].every(p => Math.abs(height(p) - 100) < 1e-6));
  assert.ok(hole.positions.every(p => Math.abs(height(p) - 12) < 1e-6));
  useSampledCadHeights(data);
  assert.equal(face.polygon!.perPositionHeight!.getValue(time), true);
  assert.equal(label.label!.heightReference!.getValue(time), HeightReference.NONE);
});

for (const [name, values] of [
  ["short response", [point(0)]],
  ["non-finite response", [point(0), new Cartesian3(Number.NaN, 0, 0)]],
  ["sparse response", Array<Cartesian3>(2)],
] as const) {
  test(`${name} cannot silently fall back to CAD source Z`, async () => {
    const data = new CustomDataSource(name);
    const line = makeLine(data, 2), original = line.polyline!.positions;
    await assert.rejects(sampleCadHeights(data, async () => [...values]), /未能依附到表面/);
    assert.equal(line.polyline!.positions, original);
  });
}

for (const outcome of ["success", "missing", "error", "cancel"] as const) {
  for (const visible of [true, false]) {
    test(`model-only sampling restores globe visibility ${visible} after ${outcome}`, async () => {
      const data = new CustomDataSource("model-only");
      makeLine(data, 2);
      const globe = { show: visible };
      const controller = new AbortController();
      const scene = { globe, clampToHeightSupported: true, async clampToHeightMostDetailed(points: Cartesian3[]) {
        assert.equal(globe.show, false, "terrain must not fill a gap in the model surface");
        if (outcome === "missing") return [undefined, undefined];
        if (outcome === "error") throw new Error("query failed");
        if (outcome === "cancel") controller.abort();
        return points.map(onSurface);
      } } as unknown as Scene;
      const pending = clampCadToScene(data, scene, { signal: controller.signal });
      if (outcome === "success") await pending;
      else if (outcome === "cancel") await assert.rejects(pending, { name: "AbortError" });
      else await assert.rejects(pending);
      assert.equal(globe.show, visible);
    });
  }
}

test("model sampling exclusions cover nested CAD primitives and GIS entities without excluding receiving models", () => {
  const root = new PrimitiveCollection({ destroyPrimitives: false });
  const nested = root.add(new PrimitiveCollection({ destroyPrimitives: false }));
  const leaf = nested.add({ show: true });
  const gis = new CustomDataSource("GIS"), entity = makeLine(gis, 2);
  const model = {}, tileset = {};
  const record = (kind: ImportRecord["kind"], resource: unknown): ImportRecord => ({ id: kind, name: kind, kind, resource, visible: true });
  const excluded = getCadModelSamplingExclusions([record("CAD", root), record("GIS", gis), record("Model", model), record("3D Tiles", tileset)]);
  for (const value of [root, nested, leaf, gis, entity]) assert.ok(excluded.includes(value));
  assert.ok(!excluded.includes(model)); assert.ok(!excluded.includes(tileset));
  root.destroy(); nested.destroy();
});
