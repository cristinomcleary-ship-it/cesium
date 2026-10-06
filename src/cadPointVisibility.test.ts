import assert from "node:assert/strict";
import test, { before, after } from "node:test";

const originalAnimationFrame = globalThis.requestAnimationFrame;
before(() => { globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0) as unknown as number; });
after(() => { globalThis.requestAnimationFrame = originalAnimationFrame; });
import { JulianDate, type PrimitiveCollection } from "cesium";
import type { CadImportEntity, CadImportPackage } from "./cadImport.ts";
import { loadCadPrimitiveCollection } from "./cadPrimitiveLoader.ts";
import { getCadBoundingSphere, loadCadImport } from "./dxfLoader.ts";
import type { CadCoordinateOptions } from "./types.ts";

const coordinates: CadCoordinateOptions = {
  mode: "local", longitude: 120, latitude: 30, altitude: 20,
  referenceX: 0, referenceY: 0, rotation: 0, scale: 1,
};

function drawing(entities: CadImportEntity[], version: 1 | 2 = 2): CadImportPackage {
  return {
    format: "cesium-cad-import", version,
    source: { name: "point-display-regression.dwg", format: "DWG", generatedAt: "2026-10-06T00:00:00Z" },
    statistics: { sourceEntities: entities.length, displayEntities: entities.length,
      skippedEntities: 0, unknownEntities: 0, layers: ["管线"] },
    entities, warnings: [],
  };
}

const point = (x: number): CadImportEntity => ({
  type: "POINT", sourceType: "POINT", layer: "管线", vertices: [{ x, y: 0, z: 0 }],
});
const line: CadImportEntity = {
  type: "POLYLINE", sourceType: "LINE", layer: "管线", color: "#00FF00",
  vertices: [{ x: 0, y: 0, z: 1 }, { x: 20, y: 10, z: 1 }],
};
const circle: CadImportEntity = {
  type: "POLYLINE", sourceType: "CIRCLE", layer: "管线", closed: true,
  vertices: [{ x: 0, y: 2 }, { x: 2, y: 0 }, { x: 0, y: -2 }, { x: -2, y: 0 }],
};

for (const version of [1, 2] as const) {
  test(`v${version} package hides POINT without changing line/circle identity or collision vertices`, async () => {
    const source = drawing([point(-1_000_000), line, point(1_000_000), circle], version);
    const before = JSON.stringify(source);
    const result = await loadCadPrimitiveCollection(source, coordinates);
    const expected = await loadCadPrimitiveCollection(drawing([line, circle], version), coordinates);
    try {
      assert.equal(result.featureCount, 2);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.collection.cadFeatureCount, 2);
      assert.deepEqual(result.cadPolylineFeatures.map(feature => feature.entity.id), ["cad-1", "cad-3"]);
      assert.deepEqual(result.cadPolylineFeatures.map(feature => feature.sourceType), ["LINE", "CIRCLE"]);
      assert.deepEqual(result.cadPolylineFeatures.map(feature => feature.positions), expected.cadPolylineFeatures.map(feature => feature.positions));
      assert.deepEqual(result.boundingSphere, expected.boundingSphere);
      assert.equal(result.collection.length, expected.collection.length);
      assert.equal(JSON.stringify(source), before);
    } finally {
      result.collection.destroy();
      expected.collection.destroy();
    }
  });

  test(`v${version} POINT-only package remains an empty loadable layer in both renderers`, async () => {
    const source = drawing([point(-1_000_000), point(1_000_000)], version);
    const result = await loadCadPrimitiveCollection(source, coordinates);
    try {
      assert.equal(result.featureCount, 0);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.collection.length, 0);
      assert.equal(result.boundingSphere, undefined);
      assert.deepEqual(result.cadPolylineFeatures, []);
    } finally { result.collection.destroy(); }
    const entitySource = await loadCadImport(source, coordinates);
    assert.equal(entitySource.entities.values.length, 0);
    assert.equal(getCadBoundingSphere(entitySource), undefined);
  });
}

test("Entity compatibility loader preserves line, circle and text while hiding only POINT", async () => {
  const text: CadImportEntity = {
    type: "TEXT", sourceType: "TEXT", layer: "编号", text: "13-2", vertices: [{ x: 3, y: 2 }],
  };
  const source = drawing([point(-1_000_000), line, circle, text]);
  const data = await loadCadImport(source, coordinates);
  assert.deepEqual(data.entities.values.map(entity => entity.id), ["POLYLINE-1", "POLYLINE-2", "TEXT-3"]);
  assert.ok(data.entities.values.every(entity => !entity.point));
  assert.equal(data.entities.getById("TEXT-3")?.label?.text?.getValue(JulianDate.now()), "13-2");
  const expected = await loadCadImport(drawing([line, circle, text]), coordinates);
  assert.deepEqual(getCadBoundingSphere(data), getCadBoundingSphere(expected));
});

test("unknown and incomplete CAD geometry cannot produce fallback points", async () => {
  const badLine: CadImportEntity = { ...line, vertices: [{ x: 2, y: 3 }] };
  const unknown = { type: "UNSUPPORTED", sourceType: "UNSUPPORTED", layer: "0", vertices: [{ x: 3, y: 2 }] } as unknown as CadImportEntity;
  const source = drawing([point(-1000), line, badLine, unknown]);
  const result = await loadCadPrimitiveCollection(source, coordinates);
  try {
    assert.equal(result.featureCount, 1);
    assert.equal(result.skippedCount, 2);
    assert.deepEqual(result.cadPolylineFeatures.map(feature => feature.entity.id), ["cad-1"]);
  } finally { result.collection.destroy(); }
  const data = await loadCadImport(source, coordinates);
  assert.deepEqual(data.entities.values.map(entity => entity.id), ["POLYLINE-1"]);
  await assert.rejects(loadCadPrimitiveCollection(drawing([point(0), badLine]), coordinates), /没有生成可显示对象/);
  await assert.rejects(loadCadImport(drawing([point(0), badLine]), coordinates), /没有生成可显示对象/);
});

test("hidden points still advance progress and honor cancellation at batch boundaries", async () => {
  const source = drawing(Array.from({ length: 251 }, (_, index) => point(index)));
  const progress: number[] = [];
  const result = await loadCadPrimitiveCollection(source, coordinates, {
    batchSize: 100, onProgress: completed => progress.push(completed),
  });
  result.collection.destroy();
  assert.deepEqual(progress, [100, 200, 251]);

  const controller = new AbortController();
  let collection: PrimitiveCollection | undefined;
  await assert.rejects(loadCadPrimitiveCollection(source, coordinates, {
    batchSize: 100, signal: controller.signal,
    beforePopulate: value => { collection = value; },
    onProgress: () => controller.abort(),
  }), error => error instanceof DOMException && error.name === "AbortError");
  collection?.destroy();
});
