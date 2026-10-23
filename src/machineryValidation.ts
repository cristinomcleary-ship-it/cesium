import { MACHINERY_ASSET_IDS, MACHINERY_ASSET_VERSION, type MachineryAssetId, type MachineryMetadata } from "./machineryTypes.ts";

/** Source geometry measurements for this asset version, not manufacturer specifications. */
export const MACHINERY_PARAMETER_DEFAULTS: Readonly<Record<MachineryAssetId, Readonly<Record<string, number>>>> = {
  crane: { overall_scale: 1, overall_height_m: 3.236115124958876, body_height_m: 0.34396821030206226, boom_length_m: 3.065900560376245, boom_rotation_deg: 0, boom_elevation_deg: 69.80598827502023, outrigger_lateral_m: 0.5799999999999923, outrigger_longitudinal_m: 0.47520002508163417 },
  pile: { overall_scale: 1, body_height_m: 0.3334010813725085, total_height_m: 1.9759868909710676 },
  excavator: { overall_scale: 1, overall_height_m: 5.40582724161427, body_height_m: 3.04186663301146 },
};
/** Numeric rendering/storage limits only. They do not certify a machine's operating range. */
export const MACHINERY_NUMERIC_LIMITS = {
  scale: { min: 0.0001, max: 1000 },
  dimension: { min: 0.000001, max: 10000 },
  height: { min: -10000, max: 100000 },
} as const;
export class MachineryValidationError extends Error {
  readonly code = "INVALID_MACHINERY";
  constructor(message: string, readonly field: string) { super(message); this.name = "MachineryValidationError"; }
}
function requireValue(test: unknown, field: string, message: string): asserts test {
  if (!test) throw new MachineryValidationError(message, field);
}
function object(value: unknown, field: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), field, `${field}必须是对象`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[], field: string) {
  requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), field, `${field}必须包含完整且唯一的允许字段：${keys.join(", ")}`);
}
function numeric(value: unknown, field: string, min: number, max: number): number {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max, field, `${field}必须是 ${min} 至 ${max} 的有限数值`);
  return value;
}
function matching(actual: number, expected: number, field: string) {
  requireValue(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-7, field, `${field}与当前整体倍率不一致，请重新计算完整参数`);
}

/** Pure shared schema validation; returns a detached value without coercing coordinates or sizes.
 * Legacy crane records may omit either angle: rotation defaults to zero and elevation to the
 * source boom's asin(axis.y), preserving the original model pose rather than making it horizontal.
 * Reading such records never rewrites the stored equipment record or its history.
 * proportional changes future editing, so a saved independent pose remains legal in either mode.
 * Crane's displayed total height is a derived mesh measurement; full bounds are recomputed by
 * the geometry engine. This lightweight validator enforces the fixed body and local constraints. */
export function validateMachineryMetadata(value: unknown): MachineryMetadata {
  const v = object(value, "machinery");
  exactKeys(v, ["schemaVersion", "assetId", "assetVersion", "proportional", "parameters", "placement", "visible"], "machinery");
  requireValue(v.schemaVersion === 1, "schemaVersion", "机械模型数据版本不支持");
  requireValue(typeof v.assetId === "string" && (MACHINERY_ASSET_IDS as readonly string[]).includes(v.assetId), "assetId", "机械模型类型不支持");
  const assetId = v.assetId as MachineryAssetId;
  requireValue(v.assetVersion === MACHINERY_ASSET_VERSION, "assetVersion", "机械模型资产版本不匹配，请重新加载模型");
  requireValue(typeof v.proportional === "boolean", "proportional", "联动模式必须为布尔值");
  requireValue(typeof v.visible === "boolean", "visible", "可见状态必须为布尔值");
  const incoming = object(v.parameters, "parameters"), defaults = MACHINERY_PARAMETER_DEFAULTS[assetId];
  const legacyAngles = new Set(assetId === "crane" ? ["boom_rotation_deg", "boom_elevation_deg"].filter(key => !Object.hasOwn(incoming, key)) : []);
  exactKeys(incoming, Object.keys(defaults).filter(key => !legacyAngles.has(key)), "parameters");
  const parameters: Record<string, number> = {};
  for (const key of Object.keys(defaults)) {
    if (key === "boom_rotation_deg") {
      parameters[key] = numeric(legacyAngles.has(key) ? defaults[key] : incoming[key], `parameters.${key}`, 0, 360);
      requireValue(parameters[key] < 360, `parameters.${key}`, "吊臂回转角须为 0（含）至 360（不含）的度数");
      continue;
    }
    if (key === "boom_elevation_deg") {
      parameters[key] = numeric(legacyAngles.has(key) ? defaults[key] : incoming[key], `parameters.${key}`, 0, 90);
      continue;
    }
    const limits = key === "overall_scale" ? MACHINERY_NUMERIC_LIMITS.scale : MACHINERY_NUMERIC_LIMITS.dimension;
    parameters[key] = numeric(incoming[key], `parameters.${key}`, limits.min, limits.max);
  }
  const scale = parameters.overall_scale;
  matching(parameters.body_height_m, defaults.body_height_m * scale, "parameters.body_height_m");
  if (assetId === "excavator") matching(parameters.overall_height_m, defaults.overall_height_m * scale, "parameters.overall_height_m");
  if (assetId === "crane") {
    const minima = { boom_length_m: 0.7682004842290806, outrigger_lateral_m: 0.1038330386464208, outrigger_longitudinal_m: 0.050000032424926566 };
    for (const [key, min] of Object.entries(minima)) requireValue(parameters[key] / scale >= min - 1e-12, `parameters.${key}`, `${key}小于该倍率下的固定部件几何下限`);
    requireValue(parameters.overall_height_m >= parameters.body_height_m, "parameters.overall_height_m", "整机高度不能低于机身参考高度");
  }
  if (assetId === "pile") requireValue(parameters.total_height_m / scale > 0.474801588279715, "parameters.total_height_m", "桩机总高须高于固定机身与顶部帽架的合计高度");
  const p = object(v.placement, "placement");
  exactKeys(p, ["longitude", "latitude", "height", "heading"], "placement");
  const placement = {
    longitude: numeric(p.longitude, "placement.longitude", -180, 180),
    latitude: numeric(p.latitude, "placement.latitude", -90, 90),
    height: numeric(p.height, "placement.height", MACHINERY_NUMERIC_LIMITS.height.min, MACHINERY_NUMERIC_LIMITS.height.max),
    heading: numeric(p.heading, "placement.heading", 0, 360),
  };
  requireValue(placement.heading < 360, "placement.heading", "方位角须为 0（含）至 360（不含）的度数");
  return { schemaVersion: 1, assetId, assetVersion: MACHINERY_ASSET_VERSION, proportional: v.proportional, parameters, placement, visible: v.visible };
}
