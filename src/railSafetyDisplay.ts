/** Presentation preferences only; never part of the saved safety geometry. */
export type RailSafetyAreaDisplay = {
  surface: "model" | "terrain" | "absolute";
  style: "fill" | "outline";
  opacity: number;
  lineWidth: number;
};
export type RailSafetyDisplaySettings = {
  guards: RailSafetyAreaDisplay;
  envelopes: RailSafetyAreaDisplay;
  personnel: { representation: "model" | "point"; scale: number; heading: number };
};

export const DEFAULT_RAIL_SAFETY_DISPLAY: RailSafetyDisplaySettings = {
  guards: { surface: "model", style: "fill", opacity: 0.25, lineWidth: 3 },
  envelopes: { surface: "model", style: "fill", opacity: 0.22, lineWidth: 3 },
  personnel: { representation: "model", scale: 1, heading: 0 },
};

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

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
  const personnel = object(input.personnel);
  return {
    guards: area(input.guards, DEFAULT_RAIL_SAFETY_DISPLAY.guards),
    envelopes: area(input.envelopes, DEFAULT_RAIL_SAFETY_DISPLAY.envelopes),
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
