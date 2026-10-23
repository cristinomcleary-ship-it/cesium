import { Color, ColorMaterialProperty, Event, ImageMaterialProperty, Material, type JulianDate, type MaterialProperty, type Property } from 'cesium';
import { normalizeRailSafetyRangeEffect, type RailSafetyRangeEffect } from './railSafetyDisplay';

const COLOR_TYPE = 'RailSafetyRangeEffectColorV1';
const IMAGE_TYPE = 'RailSafetyRangeEffectImageV1';
const bounded = (value: number, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function isRailSafetyEffectAnimated(effect: RailSafetyRangeEffect, alpha = 1): boolean {
  const normalized = normalizeRailSafetyRangeEffect(effect);
  return normalized.mode !== 'static' && normalized.intensity > 0 && alpha > 0;
}

/** The image UV never moves: animation changes opacity inside the existing footprint only. */
function shader(image: boolean): string {
  return `czm_material czm_getMaterial(czm_materialInput materialInput) {
    czm_material material = czm_getDefaultMaterial(materialInput);
    vec4 surface = ${image ? 'texture(image, materialInput.st) * color' : 'color'};
    float phase = mod(czm_frameNumber * speed / 180.0, 1.0);
    float modulation = 1.0;
    if (mode > 1.5) {
      float band = 0.5 + 0.5 * sin(6.28318530718 * (materialInput.st.s * 6.0 + materialInput.st.t * 2.0 - phase));
      modulation = 1.0 - intensity * (1.0 - smoothstep(0.15, 0.85, band));
    } else if (mode > 0.5) {
      modulation = 1.0 - intensity * (0.5 + 0.5 * sin(6.28318530718 * phase));
    }
    material.diffuse = czm_gammaCorrect(surface.rgb);
    material.alpha = surface.a * clamp(modulation, 0.0, 1.0);
    return material;
  }`;
}

type MaterialCache = {
  getMaterial(type: string): unknown;
  addMaterial(type: string, template: { fabric: { type: string; uniforms: Record<string, unknown>; source: string }; translucent: boolean }): void;
};

// Cesium 1.144 uses this cache for MaterialProperty.getType() -> Material.fromType().
// Register once without allocating any WebGL resources or touching geometry.
function registerMaterial(image: boolean): string {
  const type = image ? IMAGE_TYPE : COLOR_TYPE;
  const cache = (Material as unknown as { _materialCache: MaterialCache })._materialCache;
  if (!cache.getMaterial(type)) cache.addMaterial(type, {
    fabric: {
      type,
      uniforms: { color: Color.WHITE.clone(), speed: 1, mode: 1, intensity: 0.55, ...(image ? { image: Material.DefaultImageId } : {}) },
      source: shader(image),
    },
    // Effects may dim an otherwise opaque line; the image also contains transparent holes.
    translucent: true,
  });
  return type;
}

export type RailSafetyEffectMaterialOptions = {
  color: Color;
  effect: RailSafetyRangeEffect;
  image?: HTMLCanvasElement;
};

export type RailSafetyEffectUniforms = {
  color?: Color;
  speed?: number;
  mode?: number;
  intensity?: number;
  image?: HTMLCanvasElement;
};

/**
 * Constant parameters, animated entirely by Cesium's render-frame shader clock.
 * This is deliberately a constant MaterialProperty: Cesium 1.144 ground polygons
 * otherwise rebuild geometry for a nonconstant custom material. The shader clock
 * runs while rendered even when the simulation clock is paused. Speed is a visual
 * multiplier, not a wall-time measurement; no phase or geometry is updated in JS.
 */
export class RailSafetyEffectMaterialProperty implements MaterialProperty {
  readonly definitionChanged = new Event();
  readonly isConstant = true;
  readonly animated: boolean;
  private readonly color: Color;
  private readonly effect: RailSafetyRangeEffect;
  private readonly image?: HTMLCanvasElement;
  private readonly type: string;

  constructor(options: RailSafetyEffectMaterialOptions) {
    this.color = options.color.clone();
    this.color.alpha = bounded(this.color.alpha, 0, 0, 1);
    this.effect = normalizeRailSafetyRangeEffect(options.effect);
    this.image = options.image;
    this.type = registerMaterial(!!options.image);
    this.animated = isRailSafetyEffectAnimated(this.effect, this.color.alpha);
  }

  getType(_time?: JulianDate): string { return this.type; }

  getValue(_time?: JulianDate, result: RailSafetyEffectUniforms = {}): RailSafetyEffectUniforms {
    result.color = Color.clone(this.color, result.color);
    result.speed = this.effect.speed;
    result.mode = !this.animated ? 0 : this.effect.mode === 'flow' ? 2 : 1;
    result.intensity = this.effect.intensity;
    if (this.image) result.image = this.image;
    else delete result.image;
    return result;
  }

  equals(other?: Property): boolean {
    return this === other || other instanceof RailSafetyEffectMaterialProperty
      && Color.equals(this.color, other.color) && this.effect.mode === other.effect.mode
      && this.effect.speed === other.effect.speed && this.effect.intensity === other.effect.intensity
      && this.image === other.image;
  }
}

export function isRailSafetyEffectMaterialAnimated(material: MaterialProperty | undefined): boolean {
  return material instanceof RailSafetyEffectMaterialProperty && material.animated;
}

/** Static or fully transparent settings retain Cesium's standard, constant materials. */
export function createRailSafetyEffectMaterial(options: RailSafetyEffectMaterialOptions): MaterialProperty {
  if (isRailSafetyEffectAnimated(options.effect, options.color.alpha)) return new RailSafetyEffectMaterialProperty(options);
  return options.image
    ? new ImageMaterialProperty({ image: options.image, color: options.color.clone(), transparent: true })
    : new ColorMaterialProperty(options.color.clone());
}

type VisibilitySource = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
export type RailSafetyEffectRenderLoopOptions = {
  requestRender: () => void;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
  /** Defaults to document in browsers; injectable for lifecycle tests. */
  visibility?: VisibilitySource;
};

/** A single owned render request loop, active only while visible effects need animation. */
export class RailSafetyEffectRenderLoop {
  private wanted = false;
  private disposed = false;
  private frame?: number;
  private generation = 0;
  private readonly schedule?: (callback: FrameRequestCallback) => number;
  private readonly cancel: (handle: number) => void;
  private readonly requestRender: () => void;
  private readonly visibility?: VisibilitySource;
  private readonly visibilityChanged = () => this.sync();

  constructor(options: RailSafetyEffectRenderLoopOptions) {
    this.requestRender = options.requestRender;
    this.schedule = options.schedule ?? (typeof globalThis.requestAnimationFrame === 'function' ? callback => globalThis.requestAnimationFrame(callback) : undefined);
    this.cancel = options.cancel ?? (handle => { if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle); });
    this.visibility = options.visibility ?? (typeof document === 'undefined' ? undefined : document);
    this.visibility?.addEventListener('visibilitychange', this.visibilityChanged);
  }

  get active(): boolean { return this.frame !== undefined && !this.disposed; }
  get running(): boolean { return this.wanted && !this.disposed && !this.visibility?.hidden && !!this.schedule; }
  get pendingFrame(): boolean { return this.frame !== undefined; }

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.wanted = active;
    this.sync();
  }

  private sync(): void {
    if (!this.running) {
      this.generation++;
      if (this.frame !== undefined) this.cancel(this.frame);
      this.frame = undefined;
      return;
    }
    if (this.frame !== undefined || !this.schedule) return;
    const generation = this.generation;
    this.frame = this.schedule(() => {
      if (this.disposed || generation !== this.generation) return;
      this.frame = undefined;
      if (!this.running) return;
      this.requestRender();
      this.sync();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.wanted = false;
    this.disposed = true;
    this.sync();
    this.visibility?.removeEventListener('visibilitychange', this.visibilityChanged);
  }
}
