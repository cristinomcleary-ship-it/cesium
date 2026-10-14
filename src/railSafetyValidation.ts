import { RAIL_SAFETY_MAX_EXTENT_METRES, RAIL_SAFETY_MAX_REFERENCES, RAIL_SAFETY_MAX_VERTICES, type RailSafetyDefinition, type RailSafetyPolygon, type RailSafetyPosition, type RailSafetySupport, type RailSafetyWorkArea } from "./railSafetyTypes.ts";

export class RailSafetyValidationError extends Error {
  readonly code = "INVALID_RAIL_SAFETY";
  constructor(message: string, readonly field: string) { super(message); }
}
function fail(message: string, field: string): never { throw new RailSafetyValidationError(message, field); }
function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("请提供完整的管控配置", field);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) fail("配置包含不支持的字段", field);
  return result;
}
function number(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`数值须在 ${min} 至 ${max} 范围内`, field);
  return value;
}
function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{1,120}$/.test(value)) fail("关联编号无效", field);
  return value;
}
function references(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > RAIL_SAFETY_MAX_REFERENCES) fail(`关联对象须为最多 ${RAIL_SAFETY_MAX_REFERENCES} 项的列表`, field);
  const result = value.map((item, index) => identifier(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) fail("关联对象不能重复", field);
  return result;
}
export function validateRailSafetyPosition(value: unknown, field = "position"): RailSafetyPosition {
  const p = object(value, ["longitude", "latitude", "height"], field);
  return { longitude: number(p.longitude, -180, 180, `${field}.longitude`), latitude: number(p.latitude, -90, 90, `${field}.latitude`), height: number(p.height, -1000, 100_000, `${field}.height`) };
}
type Point = { x: number; y: number };
function orient(a: Point, b: Point, c: Point) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function onSegment(a: Point, b: Point, p: Point) { return Math.abs(orient(a, b, p)) <= 1e-7 && p.x >= Math.min(a.x, b.x) - 1e-7 && p.x <= Math.max(a.x, b.x) + 1e-7 && p.y >= Math.min(a.y, b.y) - 1e-7 && p.y <= Math.max(a.y, b.y) + 1e-7; }
function intersects(a: Point, b: Point, c: Point, d: Point) {
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
export function validateRailSafetyPolygon(value: unknown, field = "polygon"): RailSafetyPolygon {
  if (!Array.isArray(value) || value.length < 3 || value.length > RAIL_SAFETY_MAX_VERTICES) fail(`区域须有 3 至 ${RAIL_SAFETY_MAX_VERTICES} 个顶点，首尾无需重复`, field);
  const ring = value.map((p, index) => validateRailSafetyPosition(p, `${field}[${index}]`));
  const rad = Math.PI / 180, lat0 = ring[0].latitude * rad, lon0 = ring[0].longitude * rad, radius = 6378137;
  const points = ring.map(p => {
    const lat = p.latitude * rad, dLon = p.longitude * rad - lon0;
    const angular = Math.acos(Math.max(-1, Math.min(1, Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(dLon))));
    if (angular * radius > RAIL_SAFETY_MAX_EXTENT_METRES) fail("区域超过本模块的 20 km 工点范围，请拆分", field);
    return { x: radius * Math.cos(lat) * Math.sin(dLon), y: radius * (Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(dLon)) };
  });
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < 0.01) fail("区域包含重合顶点或小于 1 cm 的边", field);
    const next = (i + 1) % points.length;
    for (let j = i + 1; j < points.length; j++) {
      const jNext = (j + 1) % points.length;
      if (j === next || jNext === i) continue;
      if (intersects(points[i], points[next], points[j], points[jNext])) fail("区域边界不能自交或接触自身", field);
    }
  }
  const area = Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
  if (area < 0.01) fail("区域面积须至少 0.01 m²", field);
  return ring;
}
export function validateRailSafetySupport(value: unknown): RailSafetySupport {
  const p = object(value, ["length", "width", "centerX", "centerZ"], "support");
  return { length: number(p.length, 0.1, 200, "support.length"), width: number(p.width, 0.1, 200, "support.width"), centerX: number(p.centerX, -100, 100, "support.centerX"), centerZ: number(p.centerZ, -100, 100, "support.centerZ") };
}
export function validateRailSafetyWorkArea(value: unknown): RailSafetyWorkArea {
  const p = object(value, ["polygon", "deviceId", "staleAfterSeconds"], "workArea");
  return {
    polygon: validateRailSafetyPolygon(p.polygon, "workArea.polygon"),
    ...(p.deviceId === undefined ? {} : { deviceId: identifier(p.deviceId, "workArea.deviceId") }),
    ...(p.staleAfterSeconds === undefined ? {} : { staleAfterSeconds: number(p.staleAfterSeconds, 1, 3600, "workArea.staleAfterSeconds") }),
  };
}
/** Strict replacement contract: neither geometry approval nor automatic attendance is inferred. */
export function validateRailSafetyDefinition(value: unknown): RailSafetyDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("缺少管控配置", "definition");
  const kind = (value as Record<string, unknown>).kind;
  const extra = kind === "guard" ? ["station", "polygon", "resourceIds", "workArea"] : kind === "limit" ? ["polygon"] : kind === "machine" ? ["resourceId", "selectedLimitIds", "inspectionStatus", "support"] : fail("不支持的管控对象类别", "kind");
  const p = object(value, ["schemaVersion", "kind", ...extra], "definition");
  if (p.schemaVersion !== 1) fail("不支持的管控数据版本", "schemaVersion");
  if (kind === "guard") return { schemaVersion: 1, kind, station: validateRailSafetyPosition(p.station, "station"), polygon: validateRailSafetyPolygon(p.polygon), resourceIds: references(p.resourceIds, "resourceIds"), ...(p.workArea === undefined ? {} : { workArea: validateRailSafetyWorkArea(p.workArea) }) };
  if (kind === "limit") return { schemaVersion: 1, kind, polygon: validateRailSafetyPolygon(p.polygon) };
  if (p.inspectionStatus !== undefined && (typeof p.inspectionStatus !== "string" || !["unknown", "reported", "unreported"].includes(p.inspectionStatus))) fail("报验标记无效", "inspectionStatus");
  return { schemaVersion: 1, kind: "machine", resourceId: identifier(p.resourceId, "resourceId"), selectedLimitIds: references(p.selectedLimitIds, "selectedLimitIds"), ...(p.inspectionStatus === undefined ? {} : { inspectionStatus: p.inspectionStatus as "unknown" | "reported" | "unreported" }), ...(p.support === undefined ? {} : { support: validateRailSafetySupport(p.support) }) };
}
