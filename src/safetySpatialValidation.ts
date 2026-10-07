import type { SafetyPosition } from "./safetyTypes.ts";
import { EMPTY_SPATIAL_SNAPSHOT, type ModelSurfaceAnchor, type ModelRegistryEntry, type SpatialGeometry, type SpatialMutation, type SpatialObject, type SpatialSnapshot } from "./safetySpatialTypes.ts";

export const SPATIAL_LIMITS = { objects: 500, verticesPerObject: 1024, totalVertices: 10_000, bodyBytes: 1_048_576, snapshotBytes: 4_194_304, extentMetres: 100_000 } as const;
export class SpatialValidationError extends Error { constructor(message: string) { super(message); this.name = "SpatialValidationError"; } }
function fail(message: string): never { throw new SpatialValidationError(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}必须是对象`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 240, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${label}无效`);
  return value.trim();
}
function finite(value: unknown, label: string, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) fail(`${label}超出允许范围`);
  return value;
}
function member<T extends string>(value: unknown, label: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(`${label}无效`);
  return value as T;
}
function timestamp(value: unknown, label: string): string {
  const raw = text(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) fail(`${label}必须包含有效日期和时区`);
  return new Date(raw).toISOString();
}
function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = finite(value, label, 0, maximum);
  if (!Number.isSafeInteger(result)) fail(`${label}必须为非负整数`);
  return result;
}
export function validateSpatialId(value: unknown): string {
  const result = text(value, "空间对象编号", 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) fail("空间对象编号只允许字母、数字、下划线和连字符");
  return result;
}
function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) fail(`${label}必须是最多100项的编号数组`);
  const result = value.map((item) => text(item, label));
  if (new Set(result).size !== result.length) fail(`${label}包含重复编号`);
  return result;
}
function position(value: unknown): SafetyPosition {
  const point = record(value, "坐标");
  return { longitude: finite(point.longitude, "经度", -180, 180), latitude: finite(point.latitude, "纬度", -90, 90),
    height: finite(point.height, "场景高程", -100_000, 1_000_000) };
}
export function spatialPositions(geometry: SpatialGeometry): SafetyPosition[] { return geometry.type === "Point" ? [geometry.position] : geometry.positions; }

type XY = { x: number; y: number };
function localPoints(points: SafetyPosition[]): XY[] {
  const origin = points[0]; const cos = Math.cos(origin.latitude * Math.PI / 180);
  return points.map((point) => ({ x: (point.longitude - origin.longitude) * 111_320 * cos, y: (point.latitude - origin.latitude) * 111_320 }));
}
function cross(a: XY, b: XY, c: XY): number { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function onSegment(a: XY, b: XY, p: XY): boolean {
  return Math.abs(cross(a, b, p)) < 1e-7 && p.x >= Math.min(a.x, b.x) - 1e-7 && p.x <= Math.max(a.x, b.x) + 1e-7
    && p.y >= Math.min(a.y, b.y) - 1e-7 && p.y <= Math.max(a.y, b.y) + 1e-7;
}
function intersects(a: XY, b: XY, c: XY, d: XY): boolean {
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  return ((x > 0 && y < 0 || x < 0 && y > 0) && (z > 0 && w < 0 || z < 0 && w > 0))
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function validateShape(geometry: SpatialGeometry): void {
  if (geometry.type === "Point") return;
  const points = localPoints(geometry.positions);
  if (points.some((point) => Math.hypot(point.x, point.y) > SPATIAL_LIMITS.extentMetres)) fail("当前人工标绘只支持100km以内的单个项目范围");
  for (let index = 1; index < points.length; index++) if (Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y) < .001) fail("相邻标绘顶点重合或过近");
  if (geometry.type !== "Polygon") return;
  if (Math.hypot(points[0].x - points.at(-1)!.x, points[0].y - points.at(-1)!.y) < .001) fail("多边形无需重复首点，结束绘制后将自动闭合");
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = (index + 1) % points.length;
    area += points[index].x * points[next].y - points[next].x * points[index].y;
    for (let other = index + 1; other < points.length; other++) {
      const otherNext = (other + 1) % points.length;
      if (other === next || otherNext === index) continue;
      if (intersects(points[index], points[next], points[other], points[otherNext])) fail("多边形边界自交或重复，请调整顶点");
    }
  }
  if (Math.abs(area / 2) < .01) fail("多边形面积为零或顶点共线");
}


/** WGS84 scene coordinate check; does not convert an unknown source vertical datum. */
export function spatialPositionToEcef(point: SafetyPosition): { x: number; y: number; z: number } {
  const longitude = point.longitude * Math.PI / 180, latitude = point.latitude * Math.PI / 180;
  const eccentricitySquared = 6.6943799901413165e-3;
  const n = 6378137 / Math.sqrt(1 - eccentricitySquared * Math.sin(latitude) ** 2);
  return { x: (n + point.height) * Math.cos(latitude) * Math.cos(longitude),
    y: (n + point.height) * Math.cos(latitude) * Math.sin(longitude),
    z: (n * (1 - eccentricitySquared) + point.height) * Math.sin(latitude) };
}
function validateAnchor(value: unknown, geographic: SafetyPosition): ModelSurfaceAnchor {
  const anchor = record(value, "模型表面锚点"), world = record(anchor.position, "世界坐标"), model = record(anchor.model, "模型版本");
  if (anchor.provenance !== "verified-project-photogrammetry-surface" || world.space !== "ecef-meters") fail("必须使用已核验项目倾斜摄影表面锚点");
  const position = { space: "ecef-meters" as const, x: finite(world.x, "ECEF X", -100_000_000, 100_000_000), y: finite(world.y, "ECEF Y", -100_000_000, 100_000_000), z: finite(world.z, "ECEF Z", -100_000_000, 100_000_000) };
  const expected = spatialPositionToEcef(geographic);
  if (Math.hypot(position.x - expected.x, position.y - expected.y, position.z - expected.z) > .02) fail("模型世界坐标与保存位置不一致，请重新定位");
  return { position, model: { assetId: validateSpatialId(model.assetId), assetVersion: text(model.assetVersion, "模型资产版本"), coordinateTransformVersion: text(model.coordinateTransformVersion, "坐标变换版本") },
    provenance: "verified-project-photogrammetry-surface", pickedAt: timestamp(anchor.pickedAt, "拾取时间") };
}
export function validateModelRegistry(value: unknown): ModelRegistryEntry[] {
  if (!Array.isArray(value) || value.length > 100) fail("项目模型注册信息无效");
  return value.map((entry) => {
    const item = record(entry, "模型注册项"), offsets = record(item.coordinateOffsets, "模型偏移");
    if (item.kind !== "photogrammetry" || !["project-verified", "test-registry"].includes(String(item.capabilitySource))) fail("模型未登记倾斜摄影能力");
    if (!Array.isArray(item.matrix) || item.matrix.length !== 16) fail("模型变换矩阵无效");
    const url = text(item.url, "模型地址", 1000);
    if (!url.startsWith("/__library/files/") || /[\\?#]/.test(url) || url.split("/").some(part => part === "." || part === "..")) fail("模型注册只能引用本项目本地资料");
    return { assetId: validateSpatialId(item.assetId), projectId: text(item.projectId, "模型项目编号"), name: text(item.name, "模型名称"), url,
      kind: "photogrammetry", assetVersion: text(item.assetVersion, "资产版本"), coordinateTransformVersion: text(item.coordinateTransformVersion, "变换版本"),
      matrix: item.matrix.map((number) => finite(number, "矩阵分量", -100_000_000, 100_000_000)),
      coordinateOffsets: { longitude: finite(offsets.longitude, "经度偏移", -360, 360), latitude: finite(offsets.latitude, "纬度偏移", -180, 180), height: finite(offsets.height, "高程偏移", -1_000_000, 1_000_000) },
      capabilitySource: item.capabilitySource as ModelRegistryEntry["capabilitySource"] };
  });
}

export function validateSpatialObject(value: unknown): SpatialObject {
  const input = record(value, "空间对象");
  const v3 = input.creationSource !== undefined;
  if (v3 && input.creationSource !== "user_drawn_model_surface") fail("人工定义创建来源无效");
  const kind = member(input.kind, "空间对象类型", ["construction-area", "railway", "risk-point"] as const);
  const shape = record(input.geometry, "空间几何");
  const shapeType = member(shape.type, "空间几何类型", ["Point", "Polygon", "Corridor"] as const);
  if (kind === "risk-point" && shapeType !== "Point" || kind === "construction-area" && shapeType !== "Polygon"
    || kind === "railway" && shapeType === "Point") fail("空间对象类型与几何类型不匹配");
  let geometry: SpatialGeometry;
  if (shapeType === "Point") geometry = { type: "Point", position: position(shape.position) };
  else {
    const minimum = shapeType === "Polygon" ? 3 : 2;
    if (!Array.isArray(shape.positions) || shape.positions.length < minimum || shape.positions.length > SPATIAL_LIMITS.verticesPerObject) fail(`空间几何需要 ${minimum}–${SPATIAL_LIMITS.verticesPerObject} 个顶点`);
    const positions = shape.positions.map(position);
    geometry = shapeType === "Polygon" ? { type: shapeType, positions } : { type: shapeType, positions, widthMeters: finite(shape.widthMeters, "铁路总宽度（米）", .1, 10_000) };
  }
  validateShape(geometry);
  if (v3 && kind === "railway" && geometry.type !== "Polygon") fail("新铁路范围必须绘制闭合多边形");
  if (typeof input.visible !== "boolean") fail("空间对象显隐状态无效");
  const source = record(input.source, "坐标来源");
  if (source.kind !== "user-drawn" || source.sceneCrs !== "EPSG:4979" || source.heightDatum !== "unknown") fail("人工标绘必须保留场景坐标与未知源高程基准说明");
  if (!Array.isArray(source.vertices) || source.vertices.length !== spatialPositions(geometry).length) fail("坐标来源记录必须与每个顶点一一对应");
  const vertices = source.vertices.map((item, index) => {
    const entry = record(item, "顶点来源");
    if (v3 && (entry.pickKind !== "model-depth" || !entry.anchor)) fail("新定义的每个顶点必须来自注册倾斜摄影表面");
    const anchor = entry.anchor === undefined ? undefined : validateAnchor(entry.anchor, spatialPositions(geometry)[index]);
    if (anchor && entry.sourceRecordId !== anchor.model.assetId) fail("模型锚点与来源记录不一致");
    if (v3 && (typeof entry.sourceHeight !== "number" || Math.abs(entry.sourceHeight - spatialPositions(geometry)[index].height) > .02)) fail("来源高程与模型拾取位置不一致");
    return { ...(anchor ? { anchor } : {}), pickKind: member(entry.pickKind, "拾取来源", ["model-depth", "terrain", "ellipsoid", "manual"] as const),
      sourceHeight: finite(entry.sourceHeight, "来源高程", -100_000, 1_000_000),
      ...(entry.sourceRecordId === undefined ? {} : { sourceRecordId: text(entry.sourceRecordId, "来源记录编号") }),
      ...(entry.sourceEntityIndex === undefined ? {} : { sourceEntityIndex: integer(entry.sourceEntityIndex, "来源实体索引") }) };
  });
  const confirmation = record(input.confirmation, "用户确认");
  if (confirmation.status !== "user-confirmed" || confirmation.scope !== "geometry-and-description") fail("请先确认人工绘制范围及输入说明");
  const result: SpatialObject = {
    id: validateSpatialId(input.id), kind, name: text(input.name, "空间对象名称", 120), geometry, visible: input.visible,
    projectId: text(input.projectId, "项目编号"), linkedNodeIds: ids(input.linkedNodeIds, "关联对象"), linkedMediaIds: ids(input.linkedMediaIds, "关联资料"),
    ...(input.areaId === undefined ? {} : { areaId: validateSpatialId(input.areaId) }),
    ...(input.railwayId === undefined ? {} : { railwayId: validateSpatialId(input.railwayId) }),
    source: { kind: "user-drawn", sceneCrs: "EPSG:4979", heightDatum: "unknown", vertices },
    confirmation: { status: "user-confirmed", scope: "geometry-and-description", confirmedAt: timestamp(confirmation.confirmedAt, "确认时间") },
    createdAt: timestamp(input.createdAt, "创建时间"), updatedAt: timestamp(input.updatedAt, "更新时间"),
  };
  if (v3) result.creationSource = "user_drawn_model_surface";
  if (input.level !== undefined || v3 && kind === "risk-point") {
    if (kind !== "risk-point") fail("只有风险点具有风险等级");
    result.level = member(input.level ?? "unassessed", "风险等级", ["unassessed", "low", "medium", "high"] as const);
  }
  for (const key of ["description", "responsiblePerson", "lineName", "riskType", "createdBy", "updatedBy", "deletedBy"] as const) {
    if (input[key] !== undefined) result[key] = text(input[key], key, key === "description" ? 4000 : 240, true);
  }
  if (input.deletedAt !== undefined) result.deletedAt = timestamp(input.deletedAt, "删除时间");
  if (result.areaId === result.id || result.railwayId === result.id) fail("空间对象不能关联自身作为施工区域或铁路范围");
  if (kind === "risk-point" && (input.risk !== undefined || !v3)) {
    const risk = record(input.risk, "风险信息");
    const observationSource = member(risk.observationSource, "风险记录来源", ["replay-review", "field-entry"] as const);
    const mediaSeconds = risk.mediaSeconds === undefined ? undefined : finite(risk.mediaSeconds, "视频时刻", 0, 864_000);
    const videoId = risk.videoId === undefined ? undefined : text(risk.videoId, "关联视频编号");
    if (observationSource === "replay-review" && (!videoId || mediaSeconds === undefined || !result.linkedMediaIds.includes(videoId))) fail("回放复核需明确选择关联视频及视频时刻");
    if (observationSource === "field-entry" && (videoId !== undefined || mediaSeconds !== undefined)) fail("现场人工录入不能自动套用历史视频时标");
    result.risk = { severity: member(risk.severity, "风险等级", ["high", "medium", "low"] as const),
      status: member(risk.status, "处置状态", ["open", "rectifying", "closed"] as const), description: text(risk.description, "风险说明", 4000),
      observedAt: finite(risk.observedAt, "观察时间", 0, 7_258_118_400_000), observationSource,
      ...(videoId === undefined ? {} : { videoId }), ...(mediaSeconds === undefined ? {} : { mediaSeconds }) };
  } else if (input.risk !== undefined) fail("仅风险点可以携带风险等级及处置信息");
  return result;
}

export function validateSpatialSnapshot(value: unknown): SpatialSnapshot {
  const input = record(value, "空间对象快照");
  if (input.version !== 1 || !Array.isArray(input.objects) || input.objects.length > SPATIAL_LIMITS.objects) fail("空间对象版本或对象数量无效");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > SPATIAL_LIMITS.snapshotBytes) fail("人工标绘快照不能超过4MB");
  const objects = input.objects.map(validateSpatialObject);
  if (new Set(objects.map((item) => item.id)).size !== objects.length) fail("空间对象存在重复编号");
  if (objects.reduce((sum, item) => sum + spatialPositions(item.geometry).length, 0) > SPATIAL_LIMITS.totalVertices) fail("空间对象顶点总数超过10000个");
  return { version: 1, revision: integer(input.revision, "空间数据版本号"), updatedAt: timestamp(input.updatedAt, "快照更新时间"), objects };
}
export function emptySpatialSnapshot(): SpatialSnapshot { return structuredClone(EMPTY_SPATIAL_SNAPSHOT); }
export function validateSpatialMutation(value: unknown): SpatialMutation {
  const input = record(value, "保存请求");
  const expectedRevision = integer(input.expectedRevision, "预期版本号");
  const mutationId = validateSpatialId(input.mutationId);
  if (input.operation === "upsert") return { operation: "upsert", expectedRevision, mutationId, object: validateSpatialObject(input.object) };
  if (input.operation === "delete" || input.operation === "restore") return { operation: input.operation, expectedRevision, mutationId, id: validateSpatialId(input.id) };
  return fail("保存操作无效");
}
