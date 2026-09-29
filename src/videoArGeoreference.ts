export type GeoCorner = {
  longitude: number;
  latitude: number;
  height?: number;
};

export type SupportedGeoCrs = "EPSG:4326" | "EPSG:4979" | "CGCS2000";

export type GeoFootprint = {
  topLeft: GeoCorner;
  topRight: GeoCorner;
  bottomRight: GeoCorner;
  bottomLeft: GeoCorner;
  crs: SupportedGeoCrs;
  timestampMs?: number;
  videoFrame?: string;
};

export type GeoFootprintCollection = {
  readonly items: readonly GeoFootprint[];
  readonly byFrame: ReadonlyMap<string, GeoFootprint>;
  readonly byBaseName: ReadonlyMap<string, GeoFootprint>;
  readonly timed: readonly GeoFootprint[];
  readonly sourceVideo?: GeoProjectionVideoIdentity;
};

export type GeoProjectionMesh = {
  /** WGS84 longitude, latitude and ellipsoid height, packed per vertex. */
  readonly positionsWgs84: Float64Array;
  /** Normalized image coordinates with a top-left origin, packed as u, v. */
  readonly textureCoordinates: Float32Array;
  /** Explicit visible-surface triangles. Depth discontinuities must not be joined. */
  readonly indices: Uint16Array;
  readonly crs: "EPSG:4979";
  readonly heightReference: "WGS84_ELLIPSOID";
  readonly videoSampleIndex?: number;
  readonly videoTimeMs?: number;
  readonly timestampMs?: number;
  readonly videoFrame?: string;
  readonly imageWidthPx?: number;
  readonly imageHeightPx?: number;
  readonly method?: string;
  readonly reprojectionRmsePx?: number;
};

export type GeoProjectionMeshCollection = {
  readonly items: readonly GeoProjectionMesh[];
  readonly bySampleIndex: ReadonlyMap<number, GeoProjectionMesh>;
  readonly byFrame: ReadonlyMap<string, GeoProjectionMesh>;
  readonly byBaseName: ReadonlyMap<string, GeoProjectionMesh>;
  readonly videoTimed: readonly GeoProjectionMesh[];
  readonly timed: readonly GeoProjectionMesh[];
  readonly sourceVideo?: GeoProjectionVideoIdentity;
};

export type GeoProjectionVideoIdentity = {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly durationMs: number;
};

const EARTH_RADIUS_METERS = 6_378_137;
const MAX_FOOTPRINT_ITEMS = 100_000;
const MAX_EDGE_METERS = 50_000;
const MAX_DIAGONAL_METERS = 70_000;
const MIN_POINT_SEPARATION_METERS = 0.05;
const MIN_AREA_SQUARE_METERS = 0.01;
const MAX_PROJECTION_MESH_ITEMS = 10_000;
const MAX_PROJECTION_MESH_VERTICES = 4_096;
const MAX_PROJECTION_MESH_TRIANGLES = 8_192;
const MAX_TOTAL_PROJECTION_MESH_VERTICES = 2_000_000;
const MAX_TOTAL_PROJECTION_MESH_TRIANGLES = 2_000_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSourceVideoIdentity(input: Record<string, unknown>, hasItems: boolean) {
  if (!hasItems) return undefined;
  const source = record(input.source_video ?? input.sourceVideo);
  if (!Object.keys(source).length) return undefined;
  const fileName = source.file_name ?? source.fileName ?? source.name;
  const sizeBytes = finiteNumber(source.size_bytes ?? source.sizeBytes);
  const durationMs = finiteNumber(source.duration_ms ?? source.durationMs);
  if (
    typeof fileName !== "string"
    || !fileName.trim()
    || !Number.isInteger(sizeBytes)
    || sizeBytes! <= 0
    || !Number.isFinite(durationMs)
    || durationMs! <= 0
  ) throw new Error("精确配准 source_video 必须包含有效的 file_name、size_bytes 和 duration_ms");
  return {
    fileName: fileName.trim().replaceAll("\\", "/").split("/").pop()!,
    sizeBytes: sizeBytes!,
    durationMs: durationMs!,
  } satisfies GeoProjectionVideoIdentity;
}

function timestampToMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_(\d{1,3}))?$/.exec(trimmed);
  if (compact) {
    return Date.UTC(
      Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]),
      Number(compact[4]), Number(compact[5]), Number(compact[6]),
      Number((compact[7] ?? "0").padEnd(3, "0")),
    );
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    throw new Error("精确配准时间戳必须带 Z/UTC 偏移，不能使用依赖浏览器本地时区的日期字符串");
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeFrameName(value: string) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function baseName(value: string) {
  const normalized = normalizeFrameName(value);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizeCrs(value: unknown, wgs84Field = false): SupportedGeoCrs {
  if ((value === null || value === undefined || value === "") && wgs84Field) return "EPSG:4326";
  const normalized = String(value ?? "").trim().toUpperCase().replaceAll("_", "-").replaceAll(" ", "");
  if (["WGS84", "WGS-84", "EPSG:4326", "4326"].includes(normalized)) return "EPSG:4326";
  if (["WGS84-3D", "EPSG:4979", "4979"].includes(normalized)) return "EPSG:4979";
  if (["CGCS2000", "EPSG:4490", "4490"].includes(normalized)) return "CGCS2000";
  if (/GCJ|MARS|BD-?09|BAIDU/.test(normalized)) {
    throw new Error(`地理角点坐标系 ${String(value)} 不是 WGS84，请先在后端完成坐标转换`);
  }
  throw new Error(value
    ? `不支持地理角点坐标系：${String(value)}`
    : "地理角点缺少 source_crs；请明确填写 EPSG:4326 或 EPSG:4979");
}

function parseCorner(value: unknown, label: string): GeoCorner {
  const tuple = Array.isArray(value) ? value : undefined;
  const source = record(value);
  const longitude = finiteNumber(tuple?.[0] ?? source.longitude ?? source.lon ?? source.lng);
  const latitude = finiteNumber(tuple?.[1] ?? source.latitude ?? source.lat);
  const height = finiteNumber(tuple?.[2] ?? source.height ?? source.altitude ?? source.elevation);
  if (longitude === undefined || latitude === undefined) throw new Error(`地理角点 ${label} 缺少经纬度`);
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error(`地理角点 ${label} 超出 WGS84 经纬度范围`);
  }
  if (height !== undefined && (height < -1_000 || height > 100_000)) {
    throw new Error(`地理角点 ${label} 高程超出允许范围`);
  }
  return { longitude, latitude, ...(height === undefined ? {} : { height }) };
}

function namedValue(source: Record<string, unknown>, snake: string, camel: string) {
  return source[snake] ?? source[camel];
}

function hasFourCorners(source: Record<string, unknown>) {
  return namedValue(source, "top_left", "topLeft") !== undefined
    && namedValue(source, "top_right", "topRight") !== undefined
    && namedValue(source, "bottom_right", "bottomRight") !== undefined
    && namedValue(source, "bottom_left", "bottomLeft") !== undefined;
}

function sourceBinding(source: Record<string, unknown>, fallback: Record<string, unknown>) {
  const frameValue = source.video_frame ?? source.videoFrame ?? source.frame_name ?? source.frame
    ?? fallback.video_frame ?? fallback.videoFrame ?? fallback.frame_name ?? fallback.frame;
  const timestampValue = source.mesh_timestamp_ms ?? source.meshTimestampMs
    ?? source.footprint_timestamp_ms ?? source.footprintTimestampMs
    ?? source.video_frame_timestamp_ms ?? source.frame_timestamp_ms ?? source.timestamp_ms ?? source.timestamp
    ?? fallback.footprint_timestamp_ms ?? fallback.footprintTimestampMs
    ?? fallback.video_frame_timestamp_ms ?? fallback.frame_timestamp_ms ?? fallback.timestamp_ms ?? fallback.timestamp;
  return {
    videoFrame: typeof frameValue === "string" && frameValue.trim() ? frameValue.trim() : undefined,
    timestampMs: timestampToMs(timestampValue),
  };
}

function projectionMeshBinding(source: Record<string, unknown>, fallback: Record<string, unknown>) {
  const binding = sourceBinding(source, fallback);
  const sampleIndex = finiteNumber(
    source.video_sample_index ?? source.videoSampleIndex
      ?? fallback.video_sample_index ?? fallback.videoSampleIndex,
  );
  if (sampleIndex !== undefined && (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleIndex > 10_000_000)) {
    throw new Error("三维控制网格的 video_sample_index 无效");
  }
  const videoTimeMs = finiteNumber(
    source.video_time_ms ?? source.videoTimeMs ?? fallback.video_time_ms ?? fallback.videoTimeMs,
  );
  if (videoTimeMs !== undefined && (videoTimeMs < 0 || videoTimeMs > 7 * 24 * 60 * 60 * 1000)) {
    throw new Error("三维控制网格的 video_time_ms 无效");
  }
  return { ...binding, videoSampleIndex: sampleIndex, videoTimeMs };
}

function localMeters(corners: readonly GeoCorner[]) {
  const referenceLongitude = corners[0].longitude;
  const unwrappedLongitudes = corners.map((corner) => {
    let delta = corner.longitude - referenceLongitude;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return referenceLongitude + delta;
  });
  const centerLongitude = unwrappedLongitudes.reduce((sum, value) => sum + value, 0) / corners.length;
  const centerLatitude = corners.reduce((sum, corner) => sum + corner.latitude, 0) / corners.length;
  const longitudeScale = Math.cos(centerLatitude * Math.PI / 180) * Math.PI / 180 * EARTH_RADIUS_METERS;
  const latitudeScale = Math.PI / 180 * EARTH_RADIUS_METERS;
  return corners.map((corner, index) => ({
    x: (unwrappedLongitudes[index] - centerLongitude) * longitudeScale,
    y: (corner.latitude - centerLatitude) * latitudeScale,
  }));
}

function validateFootprint(corners: readonly GeoCorner[]) {
  const local = localMeters(corners);
  const distance = (left: number, right: number) => Math.hypot(
    local[right].x - local[left].x,
    local[right].y - local[left].y,
  );
  for (let left = 0; left < local.length; left += 1) {
    for (let right = left + 1; right < local.length; right += 1) {
      if (distance(left, right) < MIN_POINT_SEPARATION_METERS) throw new Error("地理角点存在重复点");
    }
  }
  for (const [left, right] of [[0, 1], [1, 2], [2, 3], [3, 0]] as const) {
    if (distance(left, right) > MAX_EDGE_METERS) throw new Error("地理角点边长超过 50km，疑似坐标或单位错误");
  }
  if (distance(0, 2) > MAX_DIAGONAL_METERS || distance(1, 3) > MAX_DIAGONAL_METERS) {
    throw new Error("地理角点跨度异常，疑似坐标或顺序错误");
  }
  const crosses = local.map((point, index) => {
    const next = local[(index + 1) % local.length];
    const after = local[(index + 2) % local.length];
    return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
  });
  const positive = crosses.every((value) => value > 1e-6);
  const negative = crosses.every((value) => value < -1e-6);
  if (!positive && !negative) throw new Error("地理角点必须按 TL→TR→BR→BL 构成非自交凸四边形");
  let twiceArea = 0;
  for (let index = 0; index < local.length; index += 1) {
    const next = local[(index + 1) % local.length];
    twiceArea += local[index].x * next.y - next.x * local[index].y;
  }
  if (Math.abs(twiceArea) / 2 < MIN_AREA_SQUARE_METERS) throw new Error("地理角点覆盖面积过小");
}

const WRAPPER_KEYS = [
  "footprint_wgs84",
  "ground_footprint_wgs84",
  "groundFootprintWgs84",
  "ground_footprint",
  "groundFootprint",
  "projection_corners",
  "projectionCorners",
  "canvas_corners_gps",
] as const;

export function parseGeoFootprint(value: unknown, inheritedCrs?: unknown): GeoFootprint | undefined {
  const outer = record(value);
  if (!Object.keys(outer).length) return undefined;
  const quality = record(outer.quality);
  if (quality.valid === false) throw new Error("地理角点质量标记为无效");

  let candidate = outer;
  let wgs84Field = false;
  for (const key of WRAPPER_KEYS) {
    if (outer[key] !== undefined) {
      candidate = record(outer[key]);
      wgs84Field = key.toLowerCase().includes("wgs84");
      break;
    }
  }
  if (!hasFourCorners(candidate)) {
    const metadata = record(outer.frame_metadata ?? outer.frameMetadata);
    if (Object.keys(metadata).length) {
      const merged = { ...outer, ...metadata };
      delete merged.frame_metadata;
      delete merged.frameMetadata;
      return parseGeoFootprint(merged, inheritedCrs ?? outer.source_crs ?? outer.crs);
    }
    return undefined;
  }

  const crs = normalizeCrs(
    candidate.source_crs ?? candidate.crs ?? outer.source_crs ?? outer.crs ?? outer.coordinate_system ?? inheritedCrs,
    wgs84Field,
  );
  const topLeft = parseCorner(namedValue(candidate, "top_left", "topLeft"), "top_left");
  const topRight = parseCorner(namedValue(candidate, "top_right", "topRight"), "top_right");
  const bottomRight = parseCorner(namedValue(candidate, "bottom_right", "bottomRight"), "bottom_right");
  const bottomLeft = parseCorner(namedValue(candidate, "bottom_left", "bottomLeft"), "bottom_left");
  validateFootprint([topLeft, topRight, bottomRight, bottomLeft]);
  const binding = sourceBinding(candidate, outer);
  return { topLeft, topRight, bottomRight, bottomLeft, crs, ...binding };
}

function collectionCandidates(input: unknown): Array<{ value: unknown; frame?: string }> {
  if (Array.isArray(input)) return input.map((value) => ({ value }));
  const root = record(input);
  const array = root.frame_footprints ?? root.frameFootprints ?? root.footprints
    ?? root.ground_footprints ?? root.frames ?? root.items ?? root.trajectory_points;
  if (Array.isArray(array)) return array.map((value) => ({ value }));
  const mapped = record(root.by_frame ?? root.byFrame ?? root.frame_footprints ?? root.frameFootprints);
  if (Object.keys(mapped).length) return Object.entries(mapped).map(([frame, value]) => ({ value, frame }));
  return [{ value: input }];
}

export function parseGeoFootprintCollection(input: unknown): GeoFootprintCollection {
  const root = record(input);
  const inheritedCrs = root.source_crs ?? root.crs ?? root.coordinate_system;
  const candidates = collectionCandidates(input);
  if (candidates.length > MAX_FOOTPRINT_ITEMS) {
    throw new Error(`地理角点记录超过 ${MAX_FOOTPRINT_ITEMS.toLocaleString()} 条，请先抽稀`);
  }
  const items: GeoFootprint[] = [];
  for (const candidate of candidates) {
    const parsed = parseGeoFootprint(candidate.value, inheritedCrs);
    if (!parsed) continue;
    const bound = parsed.videoFrame || !candidate.frame
      ? parsed
      : { ...parsed, videoFrame: candidate.frame };
    if (!bound.videoFrame && bound.timestampMs === undefined) {
      throw new Error("地理角点必须与 video_frame 或 footprint_timestamp_ms 绑定；不能把静态画布范围套到逐帧视频");
    }
    items.push(bound);
  }
  const byFrame = new Map<string, GeoFootprint>();
  const baseCandidates = new Map<string, GeoFootprint | null>();
  for (const item of items) {
    if (!item.videoFrame) continue;
    const normalized = normalizeFrameName(item.videoFrame);
    byFrame.set(normalized, item);
    const base = baseName(normalized);
    baseCandidates.set(base, baseCandidates.has(base) ? null : item);
  }
  const byBaseName = new Map<string, GeoFootprint>();
  for (const [name, item] of baseCandidates) if (item) byBaseName.set(name, item);
  const timed = items.filter((item) => item.timestampMs !== undefined)
    .sort((left, right) => left.timestampMs! - right.timestampMs!);
  return { items, byFrame, byBaseName, timed, sourceVideo: parseSourceVideoIdentity(root, items.length > 0) };
}

export function matchGeoFootprint(
  collection: GeoFootprintCollection,
  videoFrame: string | undefined,
  timestampMs: number | undefined,
  maxDeltaMs: number,
) {
  if (videoFrame) {
    const normalized = normalizeFrameName(videoFrame);
    const matched = collection.byFrame.get(normalized) ?? collection.byBaseName.get(baseName(normalized));
    if (
      matched
      && (timestampMs === undefined || matched.timestampMs === undefined || Math.abs(matched.timestampMs - timestampMs) <= maxDeltaMs)
    ) return matched;
  }
  if (timestampMs === undefined || !Number.isFinite(timestampMs) || !collection.timed.length) return undefined;
  let low = 0;
  let high = collection.timed.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (collection.timed[middle].timestampMs! < timestampMs) low = middle + 1;
    else high = middle;
  }
  const candidates = [collection.timed[low - 1], collection.timed[low]].filter((item): item is GeoFootprint => Boolean(item));
  const nearest = candidates.sort((left, right) => (
    Math.abs(left.timestampMs! - timestampMs) - Math.abs(right.timestampMs! - timestampMs)
  ))[0];
  return nearest && Math.abs(nearest.timestampMs! - timestampMs) <= maxDeltaMs ? nearest : undefined;
}

export function geoFootprintCorners(footprint: GeoFootprint) {
  return [footprint.topLeft, footprint.topRight, footprint.bottomRight, footprint.bottomLeft] as const;
}

const PROJECTION_MESH_WRAPPER_KEYS = [
  "projection_mesh_wgs84",
  "projectionMeshWgs84",
  "video_projection_mesh",
  "videoProjectionMesh",
  "control_mesh_wgs84",
  "controlMeshWgs84",
  "projection_mesh",
  "projectionMesh",
] as const;

function positiveInteger(value: unknown, label: string, maximum: number) {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} 无效`);
  }
  return parsed;
}

function projectionMeshCandidate(value: unknown) {
  const outer = record(value);
  let candidate = outer;
  for (const key of PROJECTION_MESH_WRAPPER_KEYS) {
    if (outer[key] !== undefined) {
      candidate = record(outer[key]);
      break;
    }
  }
  return { outer, candidate };
}

function parseProjectionMeshVertex(value: unknown, index: number) {
  const tuple = Array.isArray(value) ? value : undefined;
  const source = record(value);
  const u = finiteNumber(tuple?.[0] ?? source.u);
  const v = finiteNumber(tuple?.[1] ?? source.v);
  const longitude = finiteNumber(tuple?.[2] ?? source.longitude ?? source.lon ?? source.lng);
  const latitude = finiteNumber(tuple?.[3] ?? source.latitude ?? source.lat);
  const height = finiteNumber(tuple?.[4] ?? source.height ?? source.ellipsoid_height ?? source.ellipsoidHeight);
  if ([u, v, longitude, latitude, height].some((item) => item === undefined)) {
    throw new Error(`三维控制网格顶点 ${index} 必须包含 [u,v,longitude,latitude,ellipsoidHeight]`);
  }
  if (u! < 0 || u! > 1 || v! < 0 || v! > 1) throw new Error(`三维控制网格顶点 ${index} 的 UV 超出 [0,1]`);
  if (longitude! < -180 || longitude! > 180 || latitude! < -90 || latitude! > 90) {
    throw new Error(`三维控制网格顶点 ${index} 的 WGS84 经纬度无效`);
  }
  if (height! < -1_000 || height! > 100_000) throw new Error(`三维控制网格顶点 ${index} 的椭球高无效`);
  return { u: u!, v: v!, longitude: longitude!, latitude: latitude!, height: height! };
}

function parseProjectionMeshIndices(value: unknown, vertexCount: number) {
  if (!Array.isArray(value)) throw new Error("三维控制网格必须提供显式 triangles，楼缘和遮挡边界不能自动跨接");
  const nested = value.length > 0 && Array.isArray(value[0]);
  if (nested && value.some((triangle) => !Array.isArray(triangle) || triangle.length !== 3)) {
    throw new Error("三维控制网格 triangles 的每一项必须恰好包含 3 个索引");
  }
  if (!nested && value.some(Array.isArray)) throw new Error("三维控制网格 triangles 不能混用扁平和嵌套格式");
  const indexCount = nested ? value.length * 3 : value.length;
  if (!indexCount || indexCount % 3 !== 0) throw new Error("三维控制网格 triangles 必须由完整三角形组成");
  if (indexCount / 3 > MAX_PROJECTION_MESH_TRIANGLES) {
    throw new Error(`单帧三维控制网格不能超过 ${MAX_PROJECTION_MESH_TRIANGLES.toLocaleString()} 个三角形`);
  }
  const indices = new Uint16Array(indexCount);
  for (let index = 0; index < indexCount; index += 1) {
    const raw = nested
      ? (value[Math.floor(index / 3)] as unknown[])[index % 3]
      : value[index];
    const parsed = finiteNumber(raw);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0 || parsed >= vertexCount) {
      throw new Error(`三维控制网格索引 ${index} 越界或不是整数`);
    }
    indices[index] = parsed;
  }
  return indices;
}

function validateProjectionMeshTriangles(
  positionsWgs84: Float64Array,
  textureCoordinates: Float32Array,
  indices: Uint16Array,
) {
  const vertexCount = positionsWgs84.length / 3;
  const centerLatitude = Array.from({ length: vertexCount }, (_, index) => positionsWgs84[index * 3 + 1])
    .reduce((sum, latitude) => sum + latitude, 0) / vertexCount;
  const longitudeScale = Math.cos(centerLatitude * Math.PI / 180) * Math.PI / 180 * EARTH_RADIUS_METERS;
  const latitudeScale = Math.PI / 180 * EARTH_RADIUS_METERS;
  const originLongitude = positionsWgs84[0];
  const originLatitude = positionsWgs84[1];
  const originHeight = positionsWgs84[2];
  const point = (vertexIndex: number) => {
    let longitudeDelta = positionsWgs84[vertexIndex * 3] - originLongitude;
    if (longitudeDelta > 180) longitudeDelta -= 360;
    if (longitudeDelta < -180) longitudeDelta += 360;
    return {
      x: longitudeDelta * longitudeScale,
      y: (positionsWgs84[vertexIndex * 3 + 1] - originLatitude) * latitudeScale,
      z: positionsWgs84[vertexIndex * 3 + 2] - originHeight,
    };
  };
  const seen = new Set<string>();
  const edgeUse = new Map<string, number>();
  let uvWinding = 0;
  let totalUvArea = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset];
    const b = indices[offset + 1];
    const c = indices[offset + 2];
    if (a === b || b === c || a === c) throw new Error("三维控制网格存在重复顶点三角形");
    const triangleKey = [a, b, c].sort((left, right) => left - right).join(":");
    if (seen.has(triangleKey)) throw new Error("三维控制网格存在重复三角形");
    seen.add(triangleKey);
    const au = textureCoordinates[a * 2];
    const av = textureCoordinates[a * 2 + 1];
    const bu = textureCoordinates[b * 2];
    const bv = textureCoordinates[b * 2 + 1];
    const cu = textureCoordinates[c * 2];
    const cv = textureCoordinates[c * 2 + 1];
    const uvArea = (bu - au) * (cv - av) - (bv - av) * (cu - au);
    if (!Number.isFinite(uvArea) || Math.abs(uvArea) < 1e-9) throw new Error("三维控制网格存在 UV 退化三角形");
    const winding = Math.sign(uvArea);
    if (uvWinding && winding !== uvWinding) throw new Error("三维控制网格 triangles 的 UV 绕序不一致");
    uvWinding = winding;
    totalUvArea += Math.abs(uvArea) / 2;
    for (const [left, right] of [[a, b], [b, c], [c, a]] as const) {
      const edgeKey = left < right ? `${left}:${right}` : `${right}:${left}`;
      const uses = (edgeUse.get(edgeKey) ?? 0) + 1;
      if (uses > 2) throw new Error("三维控制网格存在非流形边，可能导致重叠投影");
      edgeUse.set(edgeKey, uses);
    }
    const pa = point(a);
    const pb = point(b);
    const pc = point(c);
    const ab = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
    const ac = { x: pc.x - pa.x, y: pc.y - pa.y, z: pc.z - pa.z };
    const cross = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x,
    };
    if (Math.hypot(cross.x, cross.y, cross.z) < 1e-4) throw new Error("三维控制网格存在空间退化三角形");
    const edge = (left: typeof pa, right: typeof pa) => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
    if (Math.max(edge(pa, pb), edge(pb, pc), edge(pc, pa)) > MAX_EDGE_METERS) {
      throw new Error("三维控制网格存在超过 50km 的异常三角边");
    }
  }
  // A first-visible-surface triangulation occupies image space at most once.
  // This bound also prevents pathological full-screen overdraw from locking up
  // the GPU even when the index/vertex counts are individually legal.
  if (totalUvArea > 1.02) throw new Error("三维控制网格 UV 覆盖面积超过画面，存在重叠/过绘");
}

export function parseGeoProjectionMesh(
  value: unknown,
  inheritedCrs?: unknown,
  inheritedDefaults: Record<string, unknown> = {},
): GeoProjectionMesh | undefined {
  const { outer, candidate } = projectionMeshCandidate(value);
  if (!Object.keys(outer).length) return undefined;
  const vertices = candidate.vertices ?? candidate.control_points ?? candidate.controlPoints;
  if (!Array.isArray(vertices)) {
    const metadata = record(outer.frame_metadata ?? outer.frameMetadata);
    if (!Object.keys(metadata).length) return undefined;
    const merged = { ...outer, ...metadata };
    delete merged.frame_metadata;
    delete merged.frameMetadata;
    return parseGeoProjectionMesh(merged, inheritedCrs ?? outer.source_crs ?? outer.crs, inheritedDefaults);
  }
  if (vertices.length < 3 || vertices.length > MAX_PROJECTION_MESH_VERTICES) {
    throw new Error(`单帧三维控制网格顶点数必须为 3–${MAX_PROJECTION_MESH_VERTICES.toLocaleString()}`);
  }
  const quality = record(candidate.quality ?? outer.quality);
  if (quality.valid === false) throw new Error("三维控制网格质量标记为无效");
  const crs = normalizeCrs(
    candidate.source_crs ?? candidate.crs ?? outer.source_crs ?? outer.crs ?? inheritedCrs,
  );
  if (crs !== "EPSG:4979") throw new Error("三维控制网格必须使用 EPSG:4979（三维 WGS84 椭球高）");
  const heightReference = String(
    candidate.height_reference ?? candidate.heightReference
      ?? outer.height_reference ?? outer.heightReference
      ?? inheritedDefaults.height_reference ?? inheritedDefaults.heightReference ?? "",
  ).trim().toUpperCase().replaceAll("-", "_");
  if (!["WGS84_ELLIPSOID", "ELLIPSOID", "ELLIPSOIDAL"].includes(heightReference)) {
    throw new Error("三维控制网格高程必须先转换为 WGS84 椭球高；不能直接使用海拔/正高");
  }
  const uvOrigin = String(candidate.uv_origin ?? candidate.uvOrigin ?? outer.uv_origin
    ?? inheritedDefaults.uv_origin ?? inheritedDefaults.uvOrigin ?? "top_left").trim().toLowerCase();
  const uvUnits = String(candidate.uv_units ?? candidate.uvUnits ?? outer.uv_units
    ?? inheritedDefaults.uv_units ?? inheritedDefaults.uvUnits ?? "normalized").trim().toLowerCase();
  if (uvOrigin !== "top_left" || uvUnits !== "normalized") {
    throw new Error("三维控制网格 UV 必须是浏览器解码画面的左上原点归一化坐标");
  }
  const visibility = candidate.visibility ?? outer.visibility ?? inheritedDefaults.visibility;
  if (String(visibility ?? "").trim().toLowerCase() !== "first_surface_hit") {
    throw new Error("三维控制网格必须声明 visibility: first_surface_hit，不能把遮挡后的表面叠在同一像素上");
  }
  const imageSpace = String(candidate.image_space ?? candidate.imageSpace ?? outer.image_space ?? outer.imageSpace
    ?? inheritedDefaults.image_space ?? inheritedDefaults.imageSpace ?? "").trim().toLowerCase();
  if (imageSpace !== "browser_display") {
    throw new Error("三维控制网格必须声明 image_space: browser_display（已应用视频旋转、裁剪和像素宽高比）");
  }
  const positionsWgs84 = new Float64Array(vertices.length * 3);
  const textureCoordinates = new Float32Array(vertices.length * 2);
  vertices.forEach((vertex, index) => {
    const parsed = parseProjectionMeshVertex(vertex, index);
    positionsWgs84.set([parsed.longitude, parsed.latitude, parsed.height], index * 3);
    textureCoordinates.set([parsed.u, parsed.v], index * 2);
  });
  const indices = parseProjectionMeshIndices(candidate.triangles ?? candidate.indices, vertices.length);
  validateProjectionMeshTriangles(positionsWgs84, textureCoordinates, indices);
  const imageWidthPx = positiveInteger(
    candidate.image_width_px ?? candidate.imageWidthPx ?? outer.image_width_px ?? outer.imageWidthPx
      ?? inheritedDefaults.image_width_px ?? inheritedDefaults.imageWidthPx,
    "三维控制网格 image_width_px",
    16_384,
  );
  const imageHeightPx = positiveInteger(
    candidate.image_height_px ?? candidate.imageHeightPx ?? outer.image_height_px ?? outer.imageHeightPx
      ?? inheritedDefaults.image_height_px ?? inheritedDefaults.imageHeightPx,
    "三维控制网格 image_height_px",
    16_384,
  );
  if (imageWidthPx === undefined || imageHeightPx === undefined) {
    throw new Error("三维控制网格必须声明浏览器显示空间的 image_width_px 和 image_height_px");
  }
  const reprojectionRmsePx = finiteNumber(quality.reprojection_rmse_px ?? quality.reprojectionRmsePx);
  if (reprojectionRmsePx !== undefined && (reprojectionRmsePx < 0 || reprojectionRmsePx > 1_000)) {
    throw new Error("三维控制网格重投影误差无效");
  }
  const methodValue = quality.method ?? candidate.method ?? outer.method;
  const binding = projectionMeshBinding(candidate, outer);
  return {
    positionsWgs84,
    textureCoordinates,
    indices,
    crs: "EPSG:4979",
    heightReference: "WGS84_ELLIPSOID",
    ...binding,
    imageWidthPx,
    imageHeightPx,
    ...(typeof methodValue === "string" && methodValue.trim() ? { method: methodValue.trim() } : {}),
    ...(reprojectionRmsePx === undefined ? {} : { reprojectionRmsePx }),
  };
}

function projectionMeshCollectionCandidates(input: unknown): Array<{ value: unknown; frame?: string }> {
  if (Array.isArray(input)) return input.map((value) => ({ value }));
  const root = record(input);
  const array = root.frame_meshes ?? root.frameMeshes ?? root.projection_meshes ?? root.projectionMeshes
    ?? root.frames ?? root.items ?? root.trajectory_points;
  if (Array.isArray(array)) return array.map((value) => ({ value }));
  const mapped = record(root.meshes_by_frame ?? root.meshesByFrame ?? root.by_frame ?? root.byFrame);
  if (Object.keys(mapped).length) return Object.entries(mapped).map(([frame, value]) => ({ value, frame }));
  return [{ value: input }];
}

export function parseGeoProjectionMeshCollection(input: unknown): GeoProjectionMeshCollection {
  const root = record(input);
  const inheritedCrs = root.source_crs ?? root.crs ?? root.coordinate_system;
  const candidates = projectionMeshCollectionCandidates(input);
  if (candidates.length > MAX_PROJECTION_MESH_ITEMS) {
    throw new Error(`三维控制网格记录超过 ${MAX_PROJECTION_MESH_ITEMS.toLocaleString()} 帧，请改用分块数据`);
  }
  const items: GeoProjectionMesh[] = [];
  let totalVertices = 0;
  let totalTriangles = 0;
  for (const candidate of candidates) {
    const parsed = parseGeoProjectionMesh(candidate.value, inheritedCrs, root);
    if (!parsed) continue;
    const bound = parsed.videoFrame || !candidate.frame ? parsed : { ...parsed, videoFrame: candidate.frame };
    if (bound.videoSampleIndex === undefined && !bound.videoFrame && bound.videoTimeMs === undefined && bound.timestampMs === undefined) {
      throw new Error("三维控制网格必须与 video_sample_index、video_frame 或精确 PTS 绑定");
    }
    totalVertices += bound.positionsWgs84.length / 3;
    if (totalVertices > MAX_TOTAL_PROJECTION_MESH_VERTICES) {
      throw new Error(`三维控制网格总顶点超过 ${MAX_TOTAL_PROJECTION_MESH_VERTICES.toLocaleString()}，请使用分块二进制数据`);
    }
    totalTriangles += bound.indices.length / 3;
    if (totalTriangles > MAX_TOTAL_PROJECTION_MESH_TRIANGLES) {
      throw new Error(`三维控制网格总三角形超过 ${MAX_TOTAL_PROJECTION_MESH_TRIANGLES.toLocaleString()}，请按时间分块`);
    }
    items.push(bound);
  }
  const bySampleIndex = new Map<number, GeoProjectionMesh>();
  const byFrame = new Map<string, GeoProjectionMesh>();
  const baseCandidates = new Map<string, GeoProjectionMesh | null>();
  for (const item of items) {
    if (item.videoSampleIndex !== undefined) {
      if (bySampleIndex.has(item.videoSampleIndex)) throw new Error(`三维控制网格 video_sample_index ${item.videoSampleIndex} 重复`);
      bySampleIndex.set(item.videoSampleIndex, item);
    }
    if (!item.videoFrame) continue;
    const normalized = normalizeFrameName(item.videoFrame);
    if (byFrame.has(normalized)) throw new Error(`三维控制网格视频帧 ${item.videoFrame} 重复`);
    byFrame.set(normalized, item);
    const base = baseName(normalized);
    baseCandidates.set(base, baseCandidates.has(base) ? null : item);
  }
  const byBaseName = new Map<string, GeoProjectionMesh>();
  for (const [name, item] of baseCandidates) if (item) byBaseName.set(name, item);
  const videoTimed = items.filter((item) => item.videoTimeMs !== undefined)
    .sort((left, right) => left.videoTimeMs! - right.videoTimeMs!);
  const timed = items.filter((item) => item.timestampMs !== undefined)
    .sort((left, right) => left.timestampMs! - right.timestampMs!);
  for (let index = 1; index < videoTimed.length; index += 1) {
    if (videoTimed[index].videoTimeMs === videoTimed[index - 1].videoTimeMs) {
      throw new Error(`三维控制网格 video_time_ms ${videoTimed[index].videoTimeMs} 重复`);
    }
  }
  for (let index = 1; index < timed.length; index += 1) {
    if (timed[index].timestampMs === timed[index - 1].timestampMs) {
      throw new Error(`三维控制网格 timestamp_ms ${timed[index].timestampMs} 重复`);
    }
  }
  const sourceVideo = parseSourceVideoIdentity(root, items.length > 0);
  return { items, bySampleIndex, byFrame, byBaseName, videoTimed, timed, sourceVideo };
}

export function matchGeoProjectionMesh(
  collection: GeoProjectionMeshCollection,
  videoSampleIndex: number | undefined,
  videoFrame: string | undefined,
  videoTimeMs: number | undefined,
  timestampMs: number | undefined,
  maxDeltaMs: number,
) {
  const compatible = (mesh: GeoProjectionMesh) => {
    if (videoSampleIndex !== undefined && mesh.videoSampleIndex !== undefined && videoSampleIndex !== mesh.videoSampleIndex) return false;
    if (videoFrame && mesh.videoFrame) {
      const requested = normalizeFrameName(videoFrame);
      const declared = normalizeFrameName(mesh.videoFrame);
      if (requested !== declared && baseName(requested) !== baseName(declared)) return false;
    }
    if (videoTimeMs !== undefined && mesh.videoTimeMs !== undefined && Math.abs(videoTimeMs - mesh.videoTimeMs) > maxDeltaMs) return false;
    if (timestampMs !== undefined && mesh.timestampMs !== undefined && Math.abs(timestampMs - mesh.timestampMs) > maxDeltaMs) return false;
    return true;
  };
  if (videoSampleIndex !== undefined) {
    const matched = collection.bySampleIndex.get(videoSampleIndex);
    if (matched) return compatible(matched) ? matched : undefined;
    if (collection.bySampleIndex.size) return undefined;
  }
  if (videoFrame) {
    const normalized = normalizeFrameName(videoFrame);
    const matched = collection.byFrame.get(normalized) ?? collection.byBaseName.get(baseName(normalized));
    if (matched) return compatible(matched) ? matched : undefined;
    if (collection.byFrame.size) return undefined;
  }
  const nearestTimed = (items: readonly GeoProjectionMesh[], target: number, readTime: (item: GeoProjectionMesh) => number) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (readTime(items[middle]) < target) low = middle + 1;
      else high = middle;
    }
    const candidates = [items[low - 1], items[low]].filter((item): item is GeoProjectionMesh => Boolean(item));
    const nearest = candidates.sort((left, right) => (
      Math.abs(readTime(left) - target) - Math.abs(readTime(right) - target)
    ))[0];
    return nearest && Math.abs(readTime(nearest) - target) <= maxDeltaMs && compatible(nearest) ? nearest : undefined;
  };
  if (videoTimeMs !== undefined && Number.isFinite(videoTimeMs) && collection.videoTimed.length) {
    const nearest = nearestTimed(collection.videoTimed, videoTimeMs, (item) => item.videoTimeMs!);
    if (nearest) return nearest;
  }
  if (timestampMs === undefined || !Number.isFinite(timestampMs) || !collection.timed.length) return undefined;
  return nearestTimed(collection.timed, timestampMs, (item) => item.timestampMs!);
}
