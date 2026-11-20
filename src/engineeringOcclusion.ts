export type EngineeringOcclusionRules = Record<string, boolean>;

const modelId = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/;

/** Missing entries use the existing renderer behavior. */
export function validateEngineeringOcclusion(value: unknown): EngineeringOcclusionRules {
  if (value === undefined) return Object.create(null) as EngineeringOcclusionRules;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工程模型遮挡设置无效');
  const entries = Object.entries(value);
  if (entries.length > 2048 || entries.some(([id, rule]) => !modelId.test(id) || typeof rule !== 'boolean')) {
    throw new Error('工程模型遮挡设置包含无效的模型 ID 或规则');
  }
  return Object.assign(Object.create(null) as EngineeringOcclusionRules, Object.fromEntries(entries));
}

export function engineeringOcclusionFrameRole(selected: boolean, rule: boolean | undefined): 'normal' | 'depth' | 'color' | 'hidden' {
  if (selected) return rule === false ? 'color' : 'normal';
  return rule === true ? 'depth' : 'hidden';
}
