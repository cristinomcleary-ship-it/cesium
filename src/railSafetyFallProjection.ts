import { computeMachineryGeometry } from './machinery/engine';
import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import { convexHull, polygonArea, type FallSupportRectangle, type Point2 } from './railSafetyGeometry';
import { rasterizeProjectedTriangles, type ProjectionRasterOptions } from './railSafetyProjectionRaster';

/** An owned, immutable-by-contract snapshot of the complete posed source mesh.
 * Vertices use the station's east/north/up frame, in metres, with no map projection
 * or display scale baked in. Indices retain every original mesh triangle. */
export type PreparedRailSafetyFallProjection = {
  readonly vertices: Float64Array;
  readonly indices: Uint32Array;
  readonly usedVertices: Uint32Array;
  readonly supportPolygon: readonly Readonly<Point2>[];
  readonly supportSource: 'user-defined' | 'model-outriggers' | 'model-base-estimate';
  readonly groundToleranceMeters: number;
};

export type RailSafetyFallAxis = {
  readonly normal: Readonly<Point2>;
  readonly tangent: Readonly<Point2>;
  readonly offset: number;
  readonly start: Readonly<Point2>;
  readonly end: Readonly<Point2>;
  readonly direction: number;
};

export type RailSafetyFallProjection = {
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
  width: number; height: number;
  /** 0 or 1, row-major. Row zero is the north / yMax edge of bounds. */
  mask: Uint8Array;
  cellSizeMeters: number;
  /** Occupied raster-cell area, including the conservative raster edge allowance. */
  areaMeters2: number;
  direction: number; angle: number;
  firstContactAngle: number; belowGround: boolean;
};

const RAD = Math.PI / 180;

/** Capture the geometry used by both the moving GLB copy and its projected mask. */
export function prepareRailSafetyFallProjection(
  asset: LoadedMachineryAsset,
  state: MachineryMetadata,
  supportOverride?: FallSupportRectangle,
): PreparedRailSafetyFallProjection {
  const p = state.placement;
  if (asset.id !== state.assetId || asset.version !== state.assetVersion) throw new RangeError('机械资产与保存参数版本不匹配');
  if (![p.longitude, p.latitude, p.height, p.heading].every(Number.isFinite)
    || Math.abs(p.longitude) > 180 || Math.abs(p.latitude) >= 89.9 || Math.abs(p.height) > 100_000) {
    throw new RangeError('机械站位或朝向无效');
  }
  const mesh = computeMachineryGeometry(asset, state.parameters);
  const used = [...new Set(mesh.indices)];
  if (!used.length) throw new RangeError('机械模型没有可用于演示的实体顶点');
  const sourceVertices = used.map(index => ({ x: mesh.positions[index * 3], y: mesh.positions[index * 3 + 2], h: mesh.positions[index * 3 + 1], part: asset.partIds[index] }));
  if (sourceVertices.some(v => ![v.x, v.y, v.h].every(Number.isFinite) || Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.h)) > 1000)) {
    throw new RangeError('机械尺寸超出本地演示可支持范围');
  }
  const height = mesh.bounds.size[1], groundToleranceMeters = Math.max(1e-5, height * 1e-6);
  if (sourceVertices.some(v => v.h < -groundToleranceMeters)) throw new RangeError('当前机械姿态有部件低于假定地面，请核对模型地面基准');
  let support: Point2[];
  let supportSource: PreparedRailSafetyFallProjection['supportSource'];
  if (supportOverride) {
    const s = supportOverride;
    if (![s.length, s.width, s.centerX, s.centerZ].every(Number.isFinite) || s.length <= 0 || s.width <= 0
      || Math.max(s.length, s.width, Math.abs(s.centerX), Math.abs(s.centerZ)) > 1000) {
      throw new RangeError('自定义支承尺寸或中心偏移无效');
    }
    support = [
      { x: s.centerX - s.length / 2, y: s.centerZ - s.width / 2 },
      { x: s.centerX + s.length / 2, y: s.centerZ - s.width / 2 },
      { x: s.centerX + s.length / 2, y: s.centerZ + s.width / 2 },
      { x: s.centerX - s.length / 2, y: s.centerZ + s.width / 2 },
    ];
    supportSource = 'user-defined';
  } else if (asset.type === 'crane') {
    const bottom: Point2[] = [];
    for (let part = 10; part <= 13; part++) {
      const points = sourceVertices.filter(v => v.part === part);
      const min = points.reduce((value, v) => Math.min(value, v.h), Infinity);
      if (!points.length || min > Math.max(0.01 * state.parameters.overall_scale, groundToleranceMeters)) {
        throw new RangeError('无法识别四个落地支腿，请填写实际支承矩形');
      }
      const tolerance = Math.max(1e-6, height * 1e-5);
      for (const point of points) if (point.h <= min + tolerance) bottom.push({ x: point.x, y: point.y });
    }
    support = convexHull(bottom); supportSource = 'model-outriggers';
  } else {
    const min = sourceVertices.reduce((value, v) => Math.min(value, v.h), Infinity);
    const tolerance = Math.max(1e-6, height * 1e-5);
    support = convexHull(sourceVertices.filter(v => v.h <= min + tolerance).map(v => ({ x: v.x, y: v.y })));
    supportSource = 'model-base-estimate';
  }
  if (support.length < 3 || Math.abs(polygonArea(support)) < 1e-8) throw new RangeError('无法得到有效地面支承区域，请填写实际支承矩形');
  const theta = p.heading * RAD, cosine = Math.cos(theta), sine = Math.sin(theta);
  const vertices = new Float64Array(mesh.positions.length);
  for (const index of used) {
    const x = mesh.positions[index * 3], y = mesh.positions[index * 3 + 1], z = mesh.positions[index * 3 + 2];
    // Cesium's GLB Y-up correction maps source +X north, +Y up, +Z east.
    vertices[index * 3] = x * sine + z * cosine;
    vertices[index * 3 + 1] = x * cosine - z * sine;
    vertices[index * 3 + 2] = y;
  }
  return { vertices, indices: mesh.indices.slice(), usedVertices: Uint32Array.from(used),
    supportPolygon: convexHull(support.map(v => ({ x: v.x * sine + v.y * cosine, y: v.x * cosine - v.y * sine }))),
    supportSource, groundToleranceMeters };
}

/** The support line is continuous in bearing. At a hull corner it touches that
 * corner; it is not snapped to a neighbouring physical edge or a centre axis.
 * Positive rotation around tangent=(-north,east,0) tips up toward the normal. */
export function resolveRailSafetyFallAxis(
  prepared: Pick<PreparedRailSafetyFallProjection, 'supportPolygon'>,
  directionDegrees: number,
): RailSafetyFallAxis {
  if (!Number.isFinite(directionDegrees)) throw new RangeError('倾覆演示方向必须为有限角度');
  const direction = ((directionDegrees % 360) + 360) % 360;
  const angle = direction * RAD, nx = Math.sin(angle), ny = Math.cos(angle), tx = -ny, ty = nx;
  let offset = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (const p of prepared.supportPolygon) {
    if (![p.x, p.y].every(Number.isFinite)) throw new RangeError('倾覆演示缺少有效支承边');
    offset = Math.max(offset, p.x * nx + p.y * ny);
    const t = p.x * tx + p.y * ty;
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
  }
  if (prepared.supportPolygon.length < 3 || !Number.isFinite(offset) || tMax - tMin <= 1e-9) throw new RangeError('倾覆演示缺少有效支承边');
  return { normal: { x: nx, y: ny }, tangent: { x: tx, y: ty }, offset, direction,
    start: { x: nx * offset + tx * tMin, y: ny * offset + ty * tMin },
    end: { x: nx * offset + tx * tMax, y: ny * offset + ty * tMax } };
}

/** Orthographic projection of the very same rigid rotation as the displayed GLB.
 * No convex hull, centre-radius circle, or per-vertex independent fall is used. */
export function computeRailSafetyFallProjection(
  prepared: PreparedRailSafetyFallProjection,
  directionDegrees: number,
  angleDegrees: number,
  options?: ProjectionRasterOptions,
): RailSafetyFallProjection {
  if (!Number.isFinite(angleDegrees) || angleDegrees < 0 || angleDegrees > 90) throw new RangeError('倾覆演示角度须在 0–90° 之间');
  const axis = resolveRailSafetyFallAxis(prepared, directionDegrees);
  const { x: nx, y: ny } = axis.normal, { x: tx, y: ty } = axis.tangent;
  const theta = angleDegrees * RAD, cosine = Math.cos(theta), sine = Math.sin(theta);
  const xy = new Float64Array(prepared.vertices.length / 3 * 2);
  let firstContactAngle = 90, belowGround = false;
  for (const index of prepared.usedVertices) {
    const x = prepared.vertices[index * 3], y = prepared.vertices[index * 3 + 1], h = prepared.vertices[index * 3 + 2];
    const d = nx * x + ny * y - axis.offset, t = tx * x + ty * y;
    const normal = axis.offset + d * cosine + h * sine;
    xy[index * 2] = nx * normal + tx * t;
    xy[index * 2 + 1] = ny * normal + ty * t;
    if (h * cosine - d * sine < -prepared.groundToleranceMeters) belowGround = true;
    if (d > prepared.groundToleranceMeters) firstContactAngle = Math.min(firstContactAngle, Math.atan2(Math.max(0, h), d) / RAD);
  }
  return { ...rasterizeProjectedTriangles(xy, prepared.indices, options),
    direction: axis.direction, angle: angleDegrees, firstContactAngle, belowGround };
}
