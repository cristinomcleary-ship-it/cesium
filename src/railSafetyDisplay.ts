/** Presentation preferences only; never part of the saved safety geometry. */
export type RailSafetyAreaDisplay = {
  surface: "model" | "terrain" | "absolute";
  style: "fill" | "outline";
  opacity: number;
  lineWidth: number;
};
/** Pose display applies to the machine in the active angle preview; others keep their overview. */
export type RailSafetyEnvelopeDisplay = RailSafetyAreaDisplay & {
  representation: "overview" | "pose" | "both";
};
export type RailSafetyLimitDisplay = {
  representation: "plane" | "wall" | "both";
  wallHeight: number;
  wallOpacity: number;
};
/** Range colours do not encode the measured alarm state; state labels retain their own colours. */
export type RailSafetyRangeColors = {
  responsibility: string;
  workArea: string;
  limit: string;
  envelope: string;
  risk: string;
  support: string;
};
export type RailSafetyRangeEffect = {
  mode: "static" | "breathe" | "flow";
  /** Multiples of the default cycle, independent from playback and geometry. */
  speed: number;
  /** Alpha modulation depth. Zero keeps the chosen presentation unchanged. */
  intensity: number;
};
export type RailSafetyRangeEffects = Record<keyof RailSafetyRangeColors, RailSafetyRangeEffect>;
export type RailSafetyDisplaySettings = {
  effects: RailSafetyRangeEffects;
  colors: RailSafetyRangeColors;
  limits: RailSafetyLimitDisplay;
  guards: RailSafetyAreaDisplay;
  envelopes: RailSafetyEnvelopeDisplay;
  personnel: { representation: "model" | "point"; scale: number; heading: number };
};

export const DEFAULT_RAIL_SAFETY_DISPLAY: RailSafetyDisplaySettings = {
  colors: {
    responsibility: "#39bfff", workArea: "#45e99b", limit: "#c78bff",
    envelope: "#ffae39", risk: "#ff3c50", support: "#d3d3d3",
  },
  effects: {
    responsibility: { mode: "static", speed: 1, intensity: 0.55 },
    workArea: { mode: "static", speed: 1, intensity: 0.55 },
    limit: { mode: "static", speed: 1, intensity: 0.55 },
    envelope: { mode: "static", speed: 1, intensity: 0.55 },
    risk: { mode: "static", speed: 1, intensity: 0.55 },
    support: { mode: "static", speed: 1, intensity: 0.55 },
  },
  limits: { representation: "plane", wallHeight: 5, wallOpacity: 0.22 },
  guards: { surface: "model", style: "fill", opacity: 0.25, lineWidth: 3 },
  envelopes: { surface: "model", style: "fill", opacity: 0.22, lineWidth: 3, representation: "pose" },
  personnel: { representation: "model", scale: 1, heading: 0 },
};

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
export function normalizeRailSafetyRangeEffect(value: unknown): RailSafetyRangeEffect {
  const candidate = object(value);
  return {
    mode: candidate.mode === "breathe" || candidate.mode === "flow" ? candidate.mode : "static",
    speed: bounded(candidate.speed, 1, 0.25, 3),
    intensity: bounded(candidate.intensity, 0.55, 0, 1),
  };
}
const hexColor = (value: unknown, fallback: string): string => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;

export function normalizeRailSafetyDisplay(value: unknown): RailSafetyDisplaySettings {
  const input = object(value);
  const area = (value: unknown, defaults: RailSafetyAreaDisplay): RailSafetyAreaDisplay => {
    const candidate = object(value);
    return {
      surface: candidate.surface === "model" || candidate.surface === "terrain" || candidate.surface === "absolute" ? candidate.surface : defaults.surface,
      style: candidate.style === "fill" || candidate.style === "outline" ? candidate.style : defaults.style,
      opacity: bounded(candidate.opacity, defaults.opacity, 0, 1),
      lineWidth: bounded(candidate.lineWidth, defaults.lineWidth, 1, 8),
    };
  };
  const personnel = object(input.personnel), limits = object(input.limits), colors = object(input.colors), envelopes = object(input.envelopes);
  const effects = object(input.effects);
  return {
    effects: {
      responsibility: normalizeRailSafetyRangeEffect(effects.responsibility),
      workArea: normalizeRailSafetyRangeEffect(effects.workArea),
      limit: normalizeRailSafetyRangeEffect(effects.limit),
      envelope: normalizeRailSafetyRangeEffect(effects.envelope),
      risk: normalizeRailSafetyRangeEffect(effects.risk),
      support: normalizeRailSafetyRangeEffect(effects.support),
    },
    colors: {
      responsibility: hexColor(colors.responsibility, DEFAULT_RAIL_SAFETY_DISPLAY.colors.responsibility),
      workArea: hexColor(colors.workArea, DEFAULT_RAIL_SAFETY_DISPLAY.colors.workArea),
      limit: hexColor(colors.limit, DEFAULT_RAIL_SAFETY_DISPLAY.colors.limit),
      envelope: hexColor(colors.envelope, DEFAULT_RAIL_SAFETY_DISPLAY.colors.envelope),
      risk: hexColor(colors.risk, DEFAULT_RAIL_SAFETY_DISPLAY.colors.risk),
      support: hexColor(colors.support, DEFAULT_RAIL_SAFETY_DISPLAY.colors.support),
    },
    limits: {
      representation: limits.representation === "plane" || limits.representation === "wall" || limits.representation === "both" ? limits.representation : DEFAULT_RAIL_SAFETY_DISPLAY.limits.representation,
      wallHeight: bounded(limits.wallHeight, DEFAULT_RAIL_SAFETY_DISPLAY.limits.wallHeight, 0.5, 100),
      wallOpacity: bounded(limits.wallOpacity, DEFAULT_RAIL_SAFETY_DISPLAY.limits.wallOpacity, 0, 1),
    },
    guards: area(input.guards, DEFAULT_RAIL_SAFETY_DISPLAY.guards),
    envelopes: {
      ...area(input.envelopes, DEFAULT_RAIL_SAFETY_DISPLAY.envelopes),
      representation: envelopes.representation === "overview" || envelopes.representation === "pose" || envelopes.representation === "both" ? envelopes.representation : DEFAULT_RAIL_SAFETY_DISPLAY.envelopes.representation,
    },
    personnel: {
      representation: personnel.representation === "point" || personnel.representation === "model" ? personnel.representation : DEFAULT_RAIL_SAFETY_DISPLAY.personnel.representation,
      scale: bounded(personnel.scale, DEFAULT_RAIL_SAFETY_DISPLAY.personnel.scale, 0.5, 3),
      heading: bounded(personnel.heading, DEFAULT_RAIL_SAFETY_DISPLAY.personnel.heading, 0, 360),
    },
  };
}

const storageKey = (projectId: string, actorId?: string) => `rail-safety-display:v1:${JSON.stringify([projectId, actorId ?? null])}`;

/** A denied/full browser store must not prevent viewing or adjusting the scene. */
export function readRailSafetyDisplay(projectId: string, actorId?: string, storage?: Pick<Storage, "getItem">): RailSafetyDisplaySettings {
  try {
    if (!projectId) return normalizeRailSafetyDisplay(undefined);
    const saved = (storage ?? globalThis.localStorage).getItem(storageKey(projectId, actorId));
    return normalizeRailSafetyDisplay(saved ? JSON.parse(saved) : undefined);
  } catch { return normalizeRailSafetyDisplay(undefined); }
}

export function writeRailSafetyDisplay(projectId: string, actorId: string | undefined, settings: RailSafetyDisplaySettings, storage?: Pick<Storage, "setItem">): boolean {
  try {
    if (!projectId) return false;
    (storage ?? globalThis.localStorage).setItem(storageKey(projectId, actorId), JSON.stringify(normalizeRailSafetyDisplay(settings)));
    return true;
  } catch { return false; }
}
