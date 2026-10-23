import { pointInPolygon, projectWgs84ToLocal, type Point2 } from "./railSafetyGeometry.ts";
import { RAIL_SAFETY_DEFAULT_STALE_SECONDS, type RailSafetyGuard, type RailSafetyPositionSample, type RailSafetyPositioningResult, type RailSafetyRecord } from "./railSafetyTypes.ts";
import { RailSafetyValidationError, validateRailSafetyPosition, validateRailSafetyWorkArea } from "./railSafetyValidation.ts";

/** Clock skew is not silently converted into a fresh, normal fix. */
export const RAIL_SAFETY_MAX_FUTURE_SKEW_MS = 5_000;
const sampleKeys = ["projectId", "deviceId", "coordinateSystem", "position", "timestamp", "accuracyMeters", "source"];
function invalid(message: string, field: string): never { throw new RailSafetyValidationError(message, field); }
function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{1,120}$/.test(value)) invalid("定位项目或设备编号无效", field);
  return value;
}

/** Strict adapter boundary. No coordinate-system guessing or default accuracy/source. */
export function validateRailSafetyPositionSample(input: unknown): RailSafetyPositionSample {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("定位样本须为完整对象", "sample");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !sampleKeys.includes(key))) invalid("定位样本包含不支持的字段", "sample");
  if (value.coordinateSystem !== "WGS84") invalid("仅接收明确标注 WGS84 的坐标；GCJ-02/BD-09 须由接入适配器转换", "coordinateSystem");
  if (value.source !== "measured" && value.source !== "simulated") invalid("须明确定位来源为实测或模拟", "source");
  if (typeof value.accuracyMeters !== "number" || !Number.isFinite(value.accuracyMeters) || value.accuracyMeters < 0 || value.accuracyMeters > 100_000) invalid("须提供 0 至 100000 米的水平定位精度", "accuracyMeters");
  if (typeof value.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp))) invalid("定位时间须为带时区的有效 ISO 8601 时间", "timestamp");
  // Date.parse rolls invalid calendar dates forward; reject those at the input boundary.
  const datePart = value.timestamp.slice(0, 10);
  if (new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) !== datePart) invalid("定位日期无效", "timestamp");
  return {
    projectId: identifier(value.projectId, "projectId"), deviceId: identifier(value.deviceId, "deviceId"),
    coordinateSystem: "WGS84", position: validateRailSafetyPosition(value.position, "sample.position"),
    timestamp: new Date(value.timestamp).toISOString(), accuracyMeters: value.accuracyMeters, source: value.source,
  };
}

function distanceToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Pure horizontal work-area screening, distinct from the protection-responsibility polygon. */
export function evaluateRailSafetyPositioning(
  guard: RailSafetyGuard,
  input: RailSafetyPositionSample | null | undefined,
  options: { projectId: string; now?: number; duplicateBinding?: boolean },
): RailSafetyPositioningResult {
  const no = (state: RailSafetyPositioningResult["state"], reason: string): RailSafetyPositioningResult => ({ state, reason, isAlarm: false });
  if (!guard.workArea) return no("unconfigured", "尚未设置独立人员工作区域");
  let area;
  try { area = validateRailSafetyWorkArea(guard.workArea); }
  catch { return no("unconfigured", "人员工作区域配置无效，请重新保存"); }
  if (!area.deviceId) return no("unconfigured", "工作区域尚未绑定定位设备");
  if (options.duplicateBinding) return no("unconfigured", "本项目设备编号重复绑定，无法确定人员归属");
  if (!input) return no("no-fix", "尚未收到该设备的定位样本");
  let sample: RailSafetyPositionSample;
  try { sample = validateRailSafetyPositionSample(input); }
  catch { return no("uncertain", "定位样本格式或坐标系无效，无法判定"); }
  if (sample.projectId !== options.projectId || sample.deviceId !== area.deviceId) return no("no-fix", "定位样本与当前项目或绑定设备不匹配");
  const result = (state: RailSafetyPositioningResult["state"], reason: string, boundaryDistanceMeters?: number): RailSafetyPositioningResult => ({
    state, reason, isAlarm: state === "outside", source: sample.source, sample,
    ...(boundaryDistanceMeters === undefined ? {} : { boundaryDistanceMeters }),
  });
  const now = options.now ?? Date.now(), age = now - Date.parse(sample.timestamp);
  if (!Number.isFinite(now) || age < -RAIL_SAFETY_MAX_FUTURE_SKEW_MS) return result("uncertain", "定位时间超前或判定时钟无效，请核对时钟");
  if (age >= (area.staleAfterSeconds ?? RAIL_SAFETY_DEFAULT_STALE_SECONDS) * 1000) return result("stale", "定位已过期，不能作为当前在岗或范围内的依据");
  try {
    // Work-area boundaries are horizontal. Ellipsoid heights are retained for display only.
    const origin = { ...area.polygon[0], height: 0 };
    const polygon = area.polygon.map(point => projectWgs84ToLocal({ ...point, height: 0 }, origin));
    const point = projectWgs84ToLocal({ ...sample.position, height: 0 }, origin);
    const boundaryDistance = Math.min(...polygon.map((a, i) => distanceToSegment(point, a, polygon[(i + 1) % polygon.length])));
    const relation = pointInPolygon(point, polygon);
    if (relation === "boundary" || boundaryDistance <= sample.accuracyMeters + 0.01) return result("uncertain", "定位精度范围接触或跨越工作区边界，暂不能确定是否越界", boundaryDistance);
    return relation === "inside"
      ? result("inside", "定位精度范围位于工作区域内", boundaryDistance)
      : result("outside", "定位精度范围已位于工作区域外", boundaryDistance);
  } catch { return result("uncertain", "定位或工作区超出本地几何判定范围，无法判定"); }
}

/**
 * In-memory adapter seam shared by simulation and future device adapters.
 * It does not connect a tracker, persist personnel tracks, or send external alerts.
 * Samples are partitioned by project AND device; simulation remains explicitly labelled.
 */
export class RailSafetyPositioningStore {
  private readonly samples = new Map<string, RailSafetyPositionSample>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  private key(projectId: string, deviceId: string): string { return JSON.stringify([projectId, deviceId]); }
  ingest(input: unknown): RailSafetyPositionSample {
    const sample = validateRailSafetyPositionSample(input);
    if (Date.parse(sample.timestamp) > this.now() + RAIL_SAFETY_MAX_FUTURE_SKEW_MS) invalid("拒绝超前的定位时间，请核对设备时钟", "timestamp");
    const key = this.key(sample.projectId, sample.deviceId), previous = this.samples.get(key);
    if (previous?.source === "measured" && sample.source === "simulated") invalid("该设备已有实测定位，模拟不能覆盖实测状态；请使用独立演示设备", "source");
    // An actual measurement takes precedence over a simulation, including its clock.
    if (previous?.source === sample.source && Date.parse(sample.timestamp) <= Date.parse(previous.timestamp)) invalid("拒绝重复或乱序定位样本，当前样本保持不变", "timestamp");
    this.samples.set(key, sample);
    return structuredClone(sample);
  }
  getSample(projectId: string, deviceId: string): RailSafetyPositionSample | undefined {
    const sample = this.samples.get(this.key(projectId, deviceId));
    return sample ? structuredClone(sample) : undefined;
  }
  /** Remove only the requested source when supplied, so ending simulation cannot delete a measured fix. */
  removeSample(projectId: string, deviceId: string, source?: RailSafetyPositionSample["source"]): void {
    const key = this.key(projectId, deviceId), sample = this.samples.get(key);
    if (sample && (source === undefined || sample.source === source)) this.samples.delete(key);
  }
  evaluate(record: RailSafetyRecord, records: readonly RailSafetyRecord[], now = this.now()): RailSafetyPositioningResult {
    if (record.status !== "active" || record.definition.kind !== "guard") return { state: "unconfigured", reason: "人员配置不存在或已停用", isAlarm: false };
    const deviceId = record.definition.workArea?.deviceId;
    const duplicateBinding = !!deviceId && records.some(other => other.id !== record.id && other.projectId === record.projectId && other.status === "active" && other.definition.kind === "guard" && other.definition.workArea?.deviceId === deviceId);
    return evaluateRailSafetyPositioning(record.definition, deviceId ? this.getSample(record.projectId, deviceId) : undefined, { projectId: record.projectId, now, duplicateBinding });
  }
  clearProject(projectId: string): void {
    for (const [key, sample] of this.samples) if (sample.projectId === projectId) this.samples.delete(key);
  }
  clear(): void { this.samples.clear(); }
}
