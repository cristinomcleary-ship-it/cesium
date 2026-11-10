import { Cartesian2, Cartesian3, Color, ColorBlendMode, type Model } from "cesium";

/** Model-level presentation overrides. The source GLB and its materials stay intact. */
export type ModelAppearanceSettings = {
  version: 1;
  colorMode: "original" | "tint" | "replace";
  color: string;
  colorAmount: number;
  opacity: number;
  lighting: "original" | "soft" | "bright";
  brightness: number;
};

export const DEFAULT_MODEL_APPEARANCE: Readonly<ModelAppearanceSettings> = Object.freeze({
  version: 1, colorMode: "original", color: "#b6bec9", colorAmount: 0.45,
  opacity: 1, lighting: "original", brightness: 1,
});

const number = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Old records have no appearance; invalid future versions also preserve original materials. */
export function normalizeModelAppearance(value?: unknown): ModelAppearanceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_MODEL_APPEARANCE };
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return { ...DEFAULT_MODEL_APPEARANCE };
  return {
    version: 1,
    colorMode: input.colorMode === "tint" || input.colorMode === "replace" ? input.colorMode : "original",
    color: typeof input.color === "string" && /^#[\da-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : DEFAULT_MODEL_APPEARANCE.color,
    colorAmount: number(input.colorAmount, DEFAULT_MODEL_APPEARANCE.colorAmount, 0, 1),
    opacity: number(input.opacity, 1, 0, 1),
    lighting: input.lighting === "soft" || input.lighting === "bright" ? input.lighting : "original",
    brightness: number(input.brightness, 1, 0.25, 2.5),
  };
}

type AppearanceModel = Pick<Model, "color" | "colorBlendMode" | "colorBlendAmount" | "isDestroyed"> & {
  lightColor: Cartesian3 | undefined;
  imageBasedLighting: { imageBasedLightingFactor: Cartesian2 };
};
type InitialAppearance = {
  color: Color; colorBlendMode: Model["colorBlendMode"]; colorBlendAmount: number;
  lightColor?: Cartesian3; imageBasedLightingFactor: Cartesian2;
};
const initial = new WeakMap<AppearanceModel, InitialAppearance>();
const applied = new WeakMap<AppearanceModel, ModelAppearanceSettings>();

export function getModelAppearance(model: AppearanceModel): ModelAppearanceSettings {
  return { ...(applied.get(model) ?? DEFAULT_MODEL_APPEARANCE) };
}

/** Uses public Cesium properties only; does not modify visibility, transforms or material textures. */
export function applyModelAppearance(model: AppearanceModel, value?: unknown): ModelAppearanceSettings {
  const settings = normalizeModelAppearance(value);
  if (model.isDestroyed()) return settings;
  let original = initial.get(model);
  if (!original) {
    original = {
      color: Color.clone(model.color ?? Color.WHITE), colorBlendMode: model.colorBlendMode,
      colorBlendAmount: model.colorBlendAmount, lightColor: model.lightColor ? Cartesian3.clone(model.lightColor) : undefined,
      imageBasedLightingFactor: Cartesian2.clone(model.imageBasedLighting.imageBasedLightingFactor),
    };
    initial.set(model, original);
  }
  const color = settings.colorMode === "original" ? Color.clone(original.color) : Color.fromCssColorString(settings.color)!;
  // The new overall opacity multiplies the original model alpha; per-material glass stays translucent.
  color.alpha = original.color.alpha * settings.opacity;
  model.color = color;
  model.colorBlendMode = settings.colorMode === "original" ? original.colorBlendMode : settings.colorMode === "tint" ? ColorBlendMode.MIX : ColorBlendMode.REPLACE;
  model.colorBlendAmount = settings.colorMode === "original" ? original.colorBlendAmount : settings.colorAmount;
  const [diffuse, specular, direct] = settings.lighting === "soft" ? [1.2, 0.55, 0.8] : settings.lighting === "bright" ? [1.45, 1.1, 1.35] : [1, 1, 1];
  model.imageBasedLighting.imageBasedLightingFactor = new Cartesian2(
    Math.min(1, original.imageBasedLightingFactor.x * diffuse * settings.brightness),
    Math.min(1, original.imageBasedLightingFactor.y * specular * settings.brightness),
  );
  model.lightColor = settings.lighting === "original" && settings.brightness === 1
    ? original.lightColor ? Cartesian3.clone(original.lightColor) : undefined
    : Cartesian3.multiplyByScalar(original.lightColor ?? Cartesian3.ONE, direct * settings.brightness, new Cartesian3());
  applied.set(model, settings);
  return { ...settings };
}
