import assert from "node:assert/strict";
import test from "node:test";
import { Cartesian2, Cartesian3, Color, ColorBlendMode, ImageBasedLighting, Matrix4 } from "cesium";
import { applyModelAppearance, DEFAULT_MODEL_APPEARANCE, getModelAppearance, normalizeModelAppearance } from "./modelAppearance.ts";

function fixture() {
  const imageBasedLighting = new ImageBasedLighting();
  imageBasedLighting.imageBasedLightingFactor = new Cartesian2(0.9, 0.7);
  return {
    color: new Color(0.8, 0.9, 1, 0.6), colorBlendMode: ColorBlendMode.HIGHLIGHT, colorBlendAmount: 0.32,
    lightColor: undefined as Cartesian3 | undefined,
    // Exercise Cesium's actual factor setter: unsupported factors above 1 must never be assigned.
    imageBasedLighting,
    show: false, modelMatrix: Matrix4.clone(Matrix4.IDENTITY), isDestroyed: () => false,
  };
}

test("older and invalid saved appearance records preserve original materials", () => {
  for (const value of [undefined, null, [], "red", {}, { version: 2, colorMode: "replace", color: "#ff0000" }]) {
    assert.deepEqual(normalizeModelAppearance(value), DEFAULT_MODEL_APPEARANCE);
  }
  const settings = normalizeModelAppearance({ version: 1, colorMode: "tint", color: "#FF0000", colorAmount: 2, opacity: -1, lighting: "bright", brightness: Infinity });
  assert.deepEqual(settings, { ...DEFAULT_MODEL_APPEARANCE, colorMode: "tint", color: "#ff0000", colorAmount: 1, opacity: 0, lighting: "bright" });
  assert.deepEqual(normalizeModelAppearance(JSON.parse(JSON.stringify(settings))), settings);
});

test("model tint/opacity leaves visibility and transform intact, and reset restores initial state", () => {
  const model = fixture(), color = Color.clone(model.color), matrix = Matrix4.clone(model.modelMatrix);
  const values = { ...DEFAULT_MODEL_APPEARANCE, colorMode: "tint" as const, color: "#ff0000", colorAmount: 0.25, opacity: 0.5, lighting: "soft" as const, brightness: 1.2 };
  applyModelAppearance(model, values);
  assert.equal(model.colorBlendMode, ColorBlendMode.MIX); assert.equal(model.colorBlendAmount, 0.25);
  assert.deepEqual(model.color, new Color(1, 0, 0, 0.3)); assert.equal(model.show, false); assert.deepEqual(model.modelMatrix, matrix);
  assert.ok(model.lightColor); assert.ok(model.imageBasedLighting.imageBasedLightingFactor.y < 0.7);
  // Repeated edits use the original alpha and lighting, never compounding each previous override.
  applyModelAppearance(model, values); assert.equal(model.color.alpha, 0.3);
  applyModelAppearance(model, DEFAULT_MODEL_APPEARANCE);
  assert.deepEqual(model.color, color); assert.equal(model.colorBlendMode, ColorBlendMode.HIGHLIGHT); assert.equal(model.colorBlendAmount, 0.32);
  assert.deepEqual(model.imageBasedLighting.imageBasedLightingFactor, new Cartesian2(0.9, 0.7)); assert.equal(model.lightColor, undefined);
  assert.equal(model.show, false); assert.deepEqual(model.modelMatrix, matrix);
});

test("bright rendering respects Cesium factor bounds and restores an existing directional light", () => {
  const model = fixture(); model.lightColor = new Cartesian3(0.6, 0.7, 0.8);
  applyModelAppearance(model, { ...DEFAULT_MODEL_APPEARANCE, lighting: "bright", brightness: 2.5 });
  assert.deepEqual(model.imageBasedLighting.imageBasedLightingFactor, new Cartesian2(1, 1));
  assert.ok(model.lightColor.x > 0.6);
  applyModelAppearance(model); assert.deepEqual(model.lightColor, new Cartesian3(0.6, 0.7, 0.8));
});

test("replacement settings round-trip to a new model without sharing mutable appearance state", () => {
  const first = fixture(); applyModelAppearance(first, { ...DEFAULT_MODEL_APPEARANCE, colorMode: "replace", color: "#33aa66" });
  const saved = JSON.parse(JSON.stringify(getModelAppearance(first))), restored = fixture(); applyModelAppearance(restored, saved);
  assert.equal(restored.colorBlendMode, ColorBlendMode.REPLACE); assert.deepEqual(restored.color, first.color);
  const returned = getModelAppearance(first); returned.color = "#000000";
  assert.equal(getModelAppearance(first).color, "#33aa66");
  applyModelAppearance(restored); assert.equal(getModelAppearance(first).colorMode, "replace");
});

test("appearance updates on an already removed model never access destroyed render properties", () => {
  const model = fixture(); model.isDestroyed = () => true;
  const color = model.color;
  applyModelAppearance(model, { ...DEFAULT_MODEL_APPEARANCE, colorMode: "replace", color: "#ff0000" });
  assert.equal(model.color, color); assert.deepEqual(getModelAppearance(model), DEFAULT_MODEL_APPEARANCE);
});
