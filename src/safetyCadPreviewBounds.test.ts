import test from "node:test";
import assert from "node:assert/strict";
import { cadPreviewBounds } from "./safetyCadPreviewBounds.ts";
import type { CadImportEntity } from "./cadImport.ts";
const text = (name: string, x: number, y: number): CadImportEntity => ({ type: "TEXT", sourceType: "TEXT", layer: "numbers", text: name, vertices: [{ x, y }] });
test("known CAD entity indices fit the selected numbered area without modifying original vertices", () => {
  const entities = [text("13-1", 510000, 3413000), text("13-2", 510020, 3413010), text("far", 1020000, 6826000)];
  const original = structuredClone(entities), bounds = cadPreviewBounds(entities, [0, 1])!;
  assert.equal(bounds.mode, "selected"); assert.equal(bounds.cx, 510010); assert.ok(bounds.spanX < 100); assert.deepEqual(entities, original);
  const entire = cadPreviewBounds(entities, [0, 1], true)!;
  assert.equal(entire.mode, "all"); assert.ok(entire.spanY > 3_000_000);
});
test("unbound drawings fit real numbered anchors, while drawings without numbers use all geometry", () => {
  const entities = [text("13-1", 100, 100), text("14-2", 200, 250), text("outlier", 100000, 900000)];
  assert.equal(cadPreviewBounds(entities)?.mode, "numbered");
  assert.ok(cadPreviewBounds(entities)!.spanY < 300);
  assert.equal(cadPreviewBounds([text("title", 30, 40)])?.mode, "all");
  assert.equal(cadPreviewBounds([]), undefined);
});
