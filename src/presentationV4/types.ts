import type { Cartesian3, Cesium3DTileset } from "cesium";

/** Display-only configuration. It is never persisted by the spatial-object API. */
export type DisplayEnvelope = {
  id: string;
  positions: Cartesian3[];
  /** Same planar perimeter without the dense upper-edge height samples. */
  clippingPositions?: Cartesian3[];
  heightSource: "surveyed" | "sampled-model" | "dataset";
  baseDepthMeters: number;
};
export type PresentationHome = {
  target?: { x: number; y: number; z: number };
  duration?: number;
  headingDegrees?: number;
  pitchDegrees?: number;
  rangeMeters?: number;
  rangeMultiplier?: number;
  padding?: { left: number; right: number; top: number; bottom: number };
};
export type PresentationPalette = {
  saturation?: number; brightness?: number; contrast?: number; coolness?: number; blueGrayMix?: number; shadowLift?: number;
  background?: string; sidewall?: string; bottom?: string; outline?: string; outlineOpacity?: number; outlineWidth?: number;
  outlineGlowWidth?: number; outlineGlowOpacity?: number; bottomOutline?: string; bottomOutlineOpacity?: number; bottomOutlineWidth?: number;
};
export type ProjectDisplayConfiguration = { displayEnvelope: DisplayEnvelope; home: PresentationHome; palette?: PresentationPalette };
export type PresentationStatus = {
  ok: boolean; state?: string; mode?: "showcase" | "reality"; code?: string; message?: string;
  engineStatus?: PresentationStatus; [key: string]: unknown;
};
export type PresentationController = {
  setMode(mode: "showcase" | "reality"): PresentationStatus;
  home(override?: PresentationHome): PresentationStatus;
  dispatch(action: string | { type: string; value?: boolean }): PresentationStatus;
  getStatus(): PresentationStatus;
  getEvidence(): Record<string, unknown>;
  destroy(): PresentationStatus;
  addPulseRing(config: { id: string; anchor: Cartesian3; radiusMeters?: number; color?: string; opacity?: number }): string;
  addFlowRoute(config: { id: string; positions: Cartesian3[]; widthPx?: number; color?: string }): string;
  addSelectionOutline(config: { id: string; positions: Cartesian3[]; widthPx?: number; color?: string; closed?: boolean }): string;
  removeEffect(id: string): boolean;
  setEffectVisible(id: string, visible: boolean): boolean;
  pauseEffects(): PresentationStatus;
  resumeEffects(): PresentationStatus;
  setReducedMotion(value: boolean): PresentationStatus;
  setEffectsTime(seconds: number): void;
  samplingExclusions(): object[];
};
export type PresentationModel = { id: string; tileset: Cesium3DTileset; contentType: "model" };
