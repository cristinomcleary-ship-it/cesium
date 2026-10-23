/** Presentation cues use video seconds, never wall-clock time or frame deltas. */
export type VideoOverlayEffectMode = 'instant' | 'fade';

export type SavedVideoOverlayEffect = {
  id: string;
  name: string;
  enabled: boolean;
  /** '*' applies to all selected engineering resources, excluding the depth occluder. */
  targetId: string;
  start: number;
  end: number;
  inMode: VideoOverlayEffectMode;
  outMode: VideoOverlayEffectMode;
  fadeIn: number;
  fadeOut: number;
  /** Multiplier on the resource's ORIGINAL alpha; never on the preceding frame's alpha. */
  opacity: number;
};

export type VideoOverlayEffectState = Readonly<{ opacity: number; visible: boolean }>;
export type VideoOverlayEffectsOptions = Readonly<{ occluderId?: string }>;

const modes = new Set<VideoOverlayEffectMode>(['instant', 'fade']);
const invalid = () => new Error('模型展示效果无效：请检查对象、起止时间、淡入淡出时长和透明度');
function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A newly added cue. Existing saved plans default to an empty cue list. */
export function defaultVideoOverlayEffect(overrides: Partial<SavedVideoOverlayEffect> = {}): SavedVideoOverlayEffect {
  return validateVideoOverlayEffect({
    id: 'effect-1', name: '模型展示', enabled: true, targetId: '*',
    start: 0, end: 10, inMode: 'fade', outMode: 'fade', fadeIn: .5, fadeOut: .5, opacity: 1,
    ...overrides,
  });
}

/** Returns an independent, serializable value and rejects corrupt imported plans. */
export function validateVideoOverlayEffect(value: unknown): SavedVideoOverlayEffect {
  if (!plainRecord(value)
    || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.enabled !== 'boolean'
    || typeof value.targetId !== 'string' || !value.targetId.trim()
    || !finite(value.start) || value.start < 0
    || !finite(value.end) || value.end <= value.start
    || !modes.has(value.inMode as VideoOverlayEffectMode)
    || !modes.has(value.outMode as VideoOverlayEffectMode)
    || !finite(value.fadeIn) || value.fadeIn < 0
    || !finite(value.fadeOut) || value.fadeOut < 0
    || !finite(value.opacity) || value.opacity < 0 || value.opacity > 1) throw invalid();
  return {
    id: value.id.trim(), name: value.name.trim(), enabled: value.enabled, targetId: value.targetId.trim(),
    start: value.start, end: value.end, inMode: value.inMode as VideoOverlayEffectMode,
    outMode: value.outMode as VideoOverlayEffectMode,
    fadeIn: value.fadeIn, fadeOut: value.fadeOut, opacity: value.opacity,
  };
}

/** Missing cues preserve pre-effects plans: every selected model remains visible. */
export function validateVideoOverlayEffects(value?: unknown): SavedVideoOverlayEffect[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid();
  const effects = value.map(validateVideoOverlayEffect), ids = new Set<string>();
  for (const effect of effects) {
    if (ids.has(effect.id)) throw new Error('模型展示效果 ID 重复，请重新添加该效果');
    ids.add(effect.id);
  }
  return effects;
}

function state(opacity: number): VideoOverlayEffectState {
  const clamped = Math.max(0, Math.min(1, opacity));
  return { opacity: clamped, visible: clamped > 0 };
}

/**
 * A cue owns the half-open interval [start, end). An enabled cue hides its target
 * outside that interval; disabling it is neutral. Long fades are shortened in
 * proportion so every cue can reach its chosen peak opacity, even in short clips.
 */
export function evaluateVideoOverlayEffect(effect: Readonly<SavedVideoOverlayEffect>, time: number): VideoOverlayEffectState {
  if (!Number.isFinite(time)) throw new Error('模型展示效果的视频时间必须为有限数值');
  if (!effect.enabled) return state(1);
  if (time < effect.start || time >= effect.end) return state(0);
  const duration = effect.end - effect.start;
  let enter = effect.inMode === 'fade' ? effect.fadeIn : 0;
  let leave = effect.outMode === 'fade' ? effect.fadeOut : 0;
  // Divide before multiplying to remain finite for very large imported durations.
  if (enter > duration || leave > duration || enter > duration - leave) {
    const maximum = Math.max(enter, leave);
    const relativeEnter = enter / maximum, relativeLeave = leave / maximum;
    const total = relativeEnter + relativeLeave;
    enter = duration * (relativeEnter / total);
    leave = duration * (relativeLeave / total);
  }
  const fadeIn = enter > 0 ? (time - effect.start) / enter : 1;
  const fadeOut = leave > 0 ? (effect.end - time) / leave : 1;
  return state(effect.opacity * Math.min(1, fadeIn, fadeOut));
}

/**
 * Cues for the same target form a union (maximum alpha), enabling repeated
 * appearances in separate intervals. A '*' track is multiplied by each object's
 * track. Targets without an enabled track retain alpha 1. This pure calculation
 * is shared by preview, pause, seeking and exported frames in any evaluation order.
 *
 * The caller still applies selection and visibility. The returned multiplier must
 * be applied against a saved material baseline and restored on exiting AR. Depth
 * occluders are omitted entirely to protect their dedicated shader/material role.
 */
export function evaluateVideoOverlayEffects(
  effects: readonly Readonly<SavedVideoOverlayEffect>[],
  time: number,
  resourceIds: readonly string[],
  options: VideoOverlayEffectsOptions = {},
): Record<string, VideoOverlayEffectState> {
  if (!Number.isFinite(time)) throw new Error('模型展示效果的视频时间必须为有限数值');
  const tracks = new Map<string, number>();
  for (const effect of effects) {
    if (!effect.enabled || effect.targetId === options.occluderId) continue;
    const opacity = evaluateVideoOverlayEffect(effect, time).opacity;
    tracks.set(effect.targetId, Math.max(tracks.get(effect.targetId) ?? 0, opacity));
  }
  const overall = tracks.get('*') ?? 1;
  return Object.fromEntries([...new Set(resourceIds)]
    .filter(id => id !== options.occluderId && id !== '*')
    .map(id => [id, state(overall * (tracks.get(id) ?? 1))]));
}
