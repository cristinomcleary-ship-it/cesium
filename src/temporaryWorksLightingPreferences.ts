import { clampTemporaryWorksBrightness, TEMPORARY_WORKS_BRIGHTNESS_DEFAULT } from './temporaryWorksGlbLighting';

export type TemporaryWorksLightingPreferences = {
  schemaVersion: 1;
  globalPercent: number;
  /** Absolute values, never multipliers of globalPercent. */
  overrides: Record<string, number>;
};
type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

const defaults = (): TemporaryWorksLightingPreferences => ({
  schemaVersion: 1, globalPercent: TEMPORARY_WORKS_BRIGHTNESS_DEFAULT, overrides: Object.create(null),
});
function key(projectId: string, userId: string) {
  if (!projectId || !userId) throw new Error('请选择项目后保存临建显示偏好。');
  return `cesium-temporary-works-lighting-v1:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;
}
function storedNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? clampTemporaryWorksBrightness(value) : fallback;
}

/** Browser-local preferences; pass a real user ID when the host supplies one. */
export function loadTemporaryWorksLightingPreferences(
  projectId: string, storage?: ReadStorage, userId = 'local-browser',
): TemporaryWorksLightingPreferences {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(key(projectId, userId));
    if (!raw) return defaults();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults();
    const saved = value as Partial<TemporaryWorksLightingPreferences>;
    if (saved.schemaVersion !== 1) return defaults();
    const result = defaults();
    result.globalPercent = storedNumber(saved.globalPercent, result.globalPercent);
    if (saved.overrides && typeof saved.overrides === 'object' && !Array.isArray(saved.overrides)) {
      for (const [id, number] of Object.entries(saved.overrides))
        if (id && typeof number === 'number' && Number.isFinite(number)) result.overrides[id] = clampTemporaryWorksBrightness(number);
    }
    return result;
  } catch { return defaults(); }
}

/** Errors propagate: a failed write must not be reported as saved. */
export function saveTemporaryWorksLightingPreferences(
  projectId: string, preferences: TemporaryWorksLightingPreferences, storage?: WriteStorage, userId = 'local-browser',
) {
  const target = storage ?? globalThis.localStorage;
  if (!target) throw new Error('当前浏览器不能保存临建显示偏好，调整仅用于本次预览。');
  const saved = defaults();
  saved.globalPercent = clampTemporaryWorksBrightness(preferences.globalPercent);
  for (const [id, value] of Object.entries(preferences.overrides))
    if (id) saved.overrides[id] = clampTemporaryWorksBrightness(value);
  target.setItem(key(projectId, userId), JSON.stringify(saved));
}

export function getEffectiveTemporaryWorksBrightness(preferences: TemporaryWorksLightingPreferences, id: string): number {
  return clampTemporaryWorksBrightness(Object.hasOwn(preferences.overrides, id) ? preferences.overrides[id] : preferences.globalPercent);
}

export function withTemporaryWorksBrightnessOverride(
  preferences: TemporaryWorksLightingPreferences, id: string, percent: number | undefined,
): TemporaryWorksLightingPreferences {
  if (!id) throw new Error('临建对象标识不能为空。');
  const overrides: Record<string, number> = Object.assign(Object.create(null), preferences.overrides);
  if (percent === undefined) delete overrides[id]; else overrides[id] = clampTemporaryWorksBrightness(percent);
  return {schemaVersion: 1, globalPercent: clampTemporaryWorksBrightness(preferences.globalPercent), overrides};
}
