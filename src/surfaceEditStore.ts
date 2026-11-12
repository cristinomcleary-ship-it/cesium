import { SURFACE_EDIT_LIMITS, type SurfaceEditPlan, type SurfaceEditPoint } from './surfaceEditTypes';

export const SURFACE_EDIT_STORAGE_PREFIX = 'cesium.surfaceEdit.v1:';
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
type UnknownRecord = Record<string, unknown>;
const planKeys = ['version', 'id', 'name', 'kind', 'targetId', 'targetTransform', 'boundary', 'holes', 'targetHeight',
  'clipTerrain', 'bottomVisible', 'texture', 'enabled', 'createdAt', 'updatedAt'] as const;

function record(value: unknown, required: readonly string[], optional: readonly string[] = [], label = '方案'): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}必须是有效对象。`);
  const result = value as UnknownRecord, allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(result).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    return typeof key !== 'string' || !allowed.has(key) || !descriptor?.enumerable || !('value' in descriptor);
  }))
    throw new Error(`${label}包含无法识别的字段，已保留原记录。`);
  if (required.some(key => !Object.hasOwn(result, key))) throw new Error(`${label}缺少必要字段。`);
  return result;
}
function text(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`${label}不能为空、包含控制字符或超过 ${maximum} 个字符。`);
}
function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是有限数值。`);
}
function boolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label}必须是明确的开关值。`);
}
function date(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length > 32 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error(`${label}必须是有效的 UTC 日期时间。`);
}
function point(value: unknown): void {
  const p = record(value, ['longitude', 'latitude', 'height'], [], '边界点');
  finite(p.longitude, '经度'); finite(p.latitude, '纬度'); finite(p.height, '边界高程');
  if (Math.abs(p.longitude) > 180 || Math.abs(p.latitude) > 90) throw new Error('边界经纬度超出有效范围。');
}
function ring(value: unknown): asserts value is SurfaceEditPoint[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > SURFACE_EDIT_LIMITS.boundaryPoints)
    throw new Error(`每个边界至少需要 3 个点，单方案累计不得超过 ${SURFACE_EDIT_LIMITS.boundaryPoints} 点。`);
  // Explicit indexing rejects sparse arrays, unlike Array.every/map.
  for (let index = 0; index < value.length; index++) point(value[index]);
}
function textureImage(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > Math.ceil(SURFACE_EDIT_LIMITS.imageBytes / 3) * 4 + 32)
    throw new Error('土体贴图超过单张 2 MB 上限。');
  const match = /^data:image\/(png|jpeg|webp);base64,/.exec(value);
  if (!match) throw new Error('土体贴图仅接受内嵌 PNG、JPEG 或 WebP 图片。');
  const encoded = value.slice(match[0].length);
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error('土体贴图编码损坏，已保留原记录。');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bytes = encoded.length / 4 * 3 - padding;
  if (bytes > SURFACE_EDIT_LIMITS.imageBytes) throw new Error('土体贴图超过单张 2 MB 上限。');
  let header: string;
  try { header = atob(encoded.slice(0, 16)); }
  catch { throw new Error('土体贴图编码损坏，已保留原记录。'); }
  const matches = match[1] === 'png' ? header.startsWith('\x89PNG\r\n\x1a\n')
    : match[1] === 'jpeg' ? header.startsWith('\xff\xd8\xff')
      : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  if (!matches) throw new Error('土体贴图内容与声明的图片格式不符。');
}
function checkDocumentSize(serialized: string): void {
  if (serialized.length > SURFACE_EDIT_LIMITS.documentBytes ||
      new TextEncoder().encode(serialized).byteLength > SURFACE_EDIT_LIMITS.documentBytes)
    throw new Error('地表编辑方案超过 16 MB 存储上限，已保留原记录。');
}

/** Version 1 has no legacy extension fields. Unknown fields are refused rather
 * than discarded, so opening a future schema cannot silently rewrite it. */
export function validateSurfaceEditPlan(value: unknown): SurfaceEditPlan {
  const plan = record(value, planKeys);
  if (plan.version !== 1) throw new Error('不支持的地表编辑方案版本，已保留原记录。');
  text(plan.id, 128, '方案编号'); text(plan.name, 160, '方案名称'); text(plan.targetId, 512, '摄影图层编号');
  if (plan.kind !== 'excavation' && plan.kind !== 'flatten') throw new Error('地表编辑类型无效。');
  if (!Array.isArray(plan.targetTransform) || ![16, 32].includes(plan.targetTransform.length))
    throw new Error('摄影变换必须包含 16 或 32 个矩阵数值。');
  for (let index = 0; index < plan.targetTransform.length; index++) finite(plan.targetTransform[index], '摄影变换');
  ring(plan.boundary);
  if (!Array.isArray(plan.holes) || plan.holes.length > SURFACE_EDIT_LIMITS.holes)
    throw new Error(`单方案保留区不得超过 ${SURFACE_EDIT_LIMITS.holes} 个。`);
  let points = plan.boundary.length;
  for (let index = 0; index < plan.holes.length; index++) {
    const hole = plan.holes[index]; ring(hole); points += hole.length;
    if (points > SURFACE_EDIT_LIMITS.boundaryPoints) throw new Error(`单方案累计边界点不得超过 ${SURFACE_EDIT_LIMITS.boundaryPoints} 点。`);
  }
  finite(plan.targetHeight, '设计高程');
  boolean(plan.clipTerrain, '地形开挖'); boolean(plan.bottomVisible, '底面显示'); boolean(plan.enabled, '方案启用');
  const texture = record(plan.texture, ['ground', 'wall', 'scaleMeters'], ['groundImage', 'wallImage'], '土体材质');
  if (!['soil', 'sand', 'gravel'].includes(texture.ground as string) || !['soil', 'sand'].includes(texture.wall as string))
    throw new Error('土体材质类型无效。');
  finite(texture.scaleMeters, '纹理尺寸');
  if (texture.scaleMeters <= 0) throw new Error('纹理尺寸必须大于零。');
  textureImage(texture.groundImage); textureImage(texture.wallImage);
  date(plan.createdAt, '创建时间'); date(plan.updatedAt, '更新时间');
  return structuredClone(plan) as SurfaceEditPlan;
}

export function validateSurfaceEditPlans(value: unknown): SurfaceEditPlan[] {
  if (!Array.isArray(value) || value.length > SURFACE_EDIT_LIMITS.plans)
    throw new Error(`地表编辑方案不得超过 ${SURFACE_EDIT_LIMITS.plans} 个。`);
  const plans: SurfaceEditPlan[] = [], ids = new Set<string>();
  let points = 0, bytes = new TextEncoder().encode('{"version":1,"plans":[]}').byteLength;
  for (let index = 0; index < value.length; index++) {
    const plan = validateSurfaceEditPlan(value[index]);
    if (ids.has(plan.id)) throw new Error('地表编辑方案编号重复。');
    ids.add(plan.id);
    points += plan.boundary.length + plan.holes.reduce((count, hole) => count + hole.length, 0);
    if (points > SURFACE_EDIT_LIMITS.totalBoundaryPoints)
      throw new Error(`地表编辑累计边界点不得超过 ${SURFACE_EDIT_LIMITS.totalBoundaryPoints} 点。`);
    bytes += new TextEncoder().encode(JSON.stringify(plan)).byteLength + (index ? 1 : 0);
    if (bytes > SURFACE_EDIT_LIMITS.documentBytes) throw new Error('地表编辑方案超过 16 MB 存储上限，已保留原记录。');
    plans.push(plan);
  }
  return plans;
}

function decodeDocument(serialized: string): SurfaceEditPlan[] {
  checkDocumentSize(serialized);
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { throw new Error('已保存的地表编辑方案损坏，不能直接覆盖。'); }
  const document = record(parsed, ['version', 'plans'], [], '地表编辑存档');
  if (document.version !== 1) throw new Error('不支持的地表编辑存档版本，不能直接覆盖。');
  return validateSurfaceEditPlans(document.plans);
}

export class SurfaceEditStore {
  constructor(private readonly storage?: StorageAccess) {}

  private access(): StorageAccess {
    // No browser globals are evaluated when importing or constructing this class.
    const storage = this.storage ?? globalThis.localStorage;
    if (!storage) throw new Error('当前环境无法访问地表编辑存储。');
    return storage;
  }

  private key(context: string): string {
    if (typeof context !== 'string' || !context.trim() || context.length > 4096)
      throw new Error('地表编辑缺少有效的项目及用户上下文。');
    try { return SURFACE_EDIT_STORAGE_PREFIX + encodeURIComponent(context); }
    catch { throw new Error('地表编辑项目及用户上下文无效。'); }
  }

  load(context: string): SurfaceEditPlan[] {
    const key = this.key(context), serialized = this.access().getItem(key);
    return serialized === null ? [] : decodeDocument(serialized);
  }

  save(context: string, plans: SurfaceEditPlan[]): void {
    const key = this.key(context), valid = validateSurfaceEditPlans(plans);
    const serialized = JSON.stringify({ version: 1, plans: valid });
    checkDocumentSize(serialized);
    const storage = this.access(), previous = storage.getItem(key);
    // Invalid/future/over-budget data cannot be overwritten even if a caller
    // forgot to stop editing after a load error. Never clear unrelated keys.
    if (previous !== null) decodeDocument(previous);
    // Storage.setItem is atomic on quota failure. No delete, retry or fallback write.
    storage.setItem(key, serialized);
  }
}
