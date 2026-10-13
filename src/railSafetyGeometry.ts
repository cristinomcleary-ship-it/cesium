import { computeMachineryGeometry } from './machinery/engine';
import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';

/** East / north metres in the tangent plane at origin. No longitude-degree arithmetic. */
export type Point2 = { x: number; y: number };
export type GeoPoint = { longitude: number; latitude: number; height?: number };
/** Dimensions and offsets in the posed source mesh's horizontal +X / +Z axes, metres. */
export type FallSupportRectangle = { length: number; width: number; centerX: number; centerZ: number };
export type FallEnvelope = {
  status: 'estimated' | 'unavailable'; origin: GeoPoint; polygon: Point2[];
  landingPoints: Point2[]; supportPolygon: Point2[]; maxDistanceMeters: number;
  envelopeRadiusMeters: number; samplingMarginMeters: number;
  supportSource: 'user-defined' | 'model-outriggers' | 'model-base-estimate' | 'unavailable';
  method: string; assumptions: string[]; warnings: string[];
};
export type PolygonIntersection = {
  relation: 'overlap' | 'touching' | 'disjoint';
  containment: 'a-in-b' | 'b-in-a' | 'equal' | 'none';
  intersectionPolygons: Point2[][]; distanceMeters: number;
};
const EPS = 1e-7;
const MAX_LOCAL = 20_000;
const RAD = Math.PI / 180;
const WGS_A = 6378137;
const WGS_E2 = 6.6943799901413165e-3;
const cross = (a: Point2, b: Point2, c: Point2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const distance = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
const finitePoint = (p: Point2) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= MAX_LOCAL && Math.abs(p.y) <= MAX_LOCAL;

function validateGeo(p: GeoPoint): void {
  if (![p.longitude, p.latitude, p.height ?? 0].every(Number.isFinite) || Math.abs(p.longitude) > 180 || Math.abs(p.latitude) >= 89.9 || Math.abs(p.height ?? 0) > 100_000) {
    throw new RangeError('坐标无效，局部筛查不支持极区或超出范围的高程');
  }
}
function ecef(p: GeoPoint): [number, number, number] {
  validateGeo(p);
  const lon = p.longitude * RAD, lat = p.latitude * RAD, h = p.height ?? 0;
  const sin = Math.sin(lat), cos = Math.cos(lat), n = WGS_A / Math.sqrt(1 - WGS_E2 * sin * sin);
  return [(n + h) * cos * Math.cos(lon), (n + h) * cos * Math.sin(lon), (n * (1 - WGS_E2) + h) * sin];
}
export function projectWgs84ToLocal(point: GeoPoint, origin: GeoPoint): Point2 {
  const a = ecef(origin), b = ecef(point), lon = origin.longitude * RAD, lat = origin.latitude * RAD;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  // Check 3D range too: an antipodal point can have misleadingly small ENU x/y.
  if (Math.hypot(dx, dy, dz) > MAX_LOCAL) throw new RangeError('几何筛查仅支持距工点原点 20 km 内的范围');
  return { x: -Math.sin(lon) * dx + Math.cos(lon) * dy, y: -Math.sin(lat) * Math.cos(lon) * dx - Math.sin(lat) * Math.sin(lon) * dy + Math.cos(lat) * dz };
}
export function unprojectLocalToWgs84(point: Point2, origin: GeoPoint): { longitude: number; latitude: number; height: number } {
  if (!finitePoint(point) || Math.hypot(point.x, point.y) > MAX_LOCAL) throw new RangeError('局部坐标超出 20 km 筛查范围');
  const base = ecef(origin), lon = origin.longitude * RAD, lat = origin.latitude * RAD;
  const x = base[0] - Math.sin(lon) * point.x - Math.sin(lat) * Math.cos(lon) * point.y;
  const y = base[1] + Math.cos(lon) * point.x - Math.sin(lat) * Math.sin(lon) * point.y;
  const z = base[2] + Math.cos(lat) * point.y;
  const radial = Math.hypot(x, y);
  let latitude = Math.atan2(z, radial * (1 - WGS_E2));
  for (let i = 0; i < 8; i++) {
    const n = WGS_A / Math.sqrt(1 - WGS_E2 * Math.sin(latitude) ** 2);
    latitude = Math.atan2(z + WGS_E2 * n * Math.sin(latitude), radial);
  }
  const n = WGS_A / Math.sqrt(1 - WGS_E2 * Math.sin(latitude) ** 2);
  return { longitude: Math.atan2(y, x) / RAD, latitude: latitude / RAD, height: radial / Math.cos(latitude) - n };
}

export function polygonArea(polygon: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) { const a = polygon[i], b = polygon[(i + 1) % polygon.length]; area += a.x * b.y - a.y * b.x; }
  return area / 2;
}
export function convexHull(points: readonly Point2[]): Point2[] {
  const sorted = points.map(p => ({ ...p })).sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter((p, i) => !i || distance(p, sorted[i - 1]) > EPS);
  if (unique.length < 3) return unique;
  const half = (source: Point2[]) => {
    const output: Point2[] = [];
    for (const p of source) {
      while (output.length >= 2 && cross(output[output.length - 2], output[output.length - 1], p) <= EPS * EPS) output.pop();
      output.push(p);
    }
    output.pop(); return output;
  };
  return [...half(unique), ...half([...unique].reverse())];
}
function pointSegmentDistance(p: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy;
  const t = square ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / square)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function pointInPolygon(point: Point2, polygon: readonly Point2[]): 'inside' | 'boundary' | 'outside' {
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    if (pointSegmentDistance(point, a, b) <= EPS) return 'boundary';
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}
function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const ab = distance(a, b), cd = distance(c, d), toleranceAB = EPS * Math.max(ab, EPS), toleranceCD = EPS * Math.max(cd, EPS);
  const x = cross(a, b, c), y = cross(a, b, d), u = cross(c, d, a), v = cross(c, d, b);
  if (((x > toleranceAB && y < -toleranceAB) || (x < -toleranceAB && y > toleranceAB)) && ((u > toleranceCD && v < -toleranceCD) || (u < -toleranceCD && v > toleranceCD))) return true;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b)) <= EPS;
}
function cleanPolygon(input: readonly Point2[]): Point2[] {
  if (input.length < 3 || input.length > 4096 || input.some(p => !finitePoint(p))) throw new RangeError('区域需要 3–4096 个有限米制坐标点，且在局部筛查范围内');
  const output: Point2[] = [];
  for (const p of input) if (!output.length || distance(p, output[output.length - 1]) > EPS) output.push({ ...p });
  if (output.length > 1 && distance(output[0], output[output.length - 1]) <= EPS) output.pop();
  for (let i = output.length - 1; i >= 0 && output.length >= 3; i--) {
    const a = output[(i + output.length - 1) % output.length], b = output[i], c = output[(i + 1) % output.length];
    if (pointSegmentDistance(b, a, c) <= EPS) output.splice(i, 1);
  }
  if (output.length < 3 || Math.abs(polygonArea(output)) <= EPS * EPS) throw new RangeError('区域不能退化为点或线');
  for (let i = 0; i < output.length; i++) for (let j = i + 1; j < output.length; j++) {
    if (j === i + 1 || (i === 0 && j === output.length - 1)) continue;
    if (segmentsIntersect(output[i], output[(i + 1) % output.length], output[j], output[(j + 1) % output.length])) throw new RangeError('区域边界自交或自接触，请重新绘制简单多边形');
  }
  return polygonArea(output) < 0 ? output.reverse() : output;
}
function isConvex(p: readonly Point2[]): boolean {
  return p.every((point, i) => cross(p[(i + p.length - 1) % p.length], point, p[(i + 1) % p.length]) >= -EPS * EPS);
}
function triangulate(polygon: Point2[]): Point2[][] {
  const ring = [...polygon], triangles: Point2[][] = [];
  while (ring.length > 3) {
    let removed = false;
    for (let i = 0; i < ring.length; i++) {
      const before = (i + ring.length - 1) % ring.length, after = (i + 1) % ring.length;
      const a = ring[before], b = ring[i], c = ring[after];
      if (cross(a, b, c) <= EPS * EPS) continue;
      if (ring.some((p, j) => j !== before && j !== i && j !== after && cross(a, b, p) >= -EPS * EPS && cross(b, c, p) >= -EPS * EPS && cross(c, a, p) >= -EPS * EPS)) continue;
      triangles.push([a, b, c]); ring.splice(i, 1); removed = true; break;
    }
    if (!removed) throw new RangeError('区域三角化失败，请检查重复点或退化边界');
  }
  triangles.push(ring); return triangles;
}
function clipConvex(subject: Point2[], clip: Point2[]): Point2[] {
  let output = [...subject];
  for (let i = 0; i < clip.length && output.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length], input = output; output = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length], cp = cross(a, b, p), cq = cross(a, b, q);
      const insideP = cp >= 0, insideQ = cq >= 0;
      if (insideP) output.push(p);
      if (insideP !== insideQ) {
        const t = cp / (cp - cq);
        output.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
  }
  const clean = output.filter((p, i) => !i || distance(p, output[i - 1]) > EPS);
  if (clean.length > 1 && distance(clean[0], clean[clean.length - 1]) <= EPS) clean.pop();
  return clean.length >= 3 && Math.abs(polygonArea(clean)) > EPS * EPS ? clean : [];
}
/** Simple (possibly concave) polygons. Returned pieces partition the highlighted overlap.
 * Boundary contact has zero distance and is not silently discarded as a zero-area overlap. */
export function intersectPolygons(left: readonly Point2[], right: readonly Point2[]): PolygonIntersection {
  const a = cleanPolygon(left), b = cleanPolygon(right), pieces: Point2[][] = [];
  const ac = isConvex(a), bc = isConvex(b);
  if (ac) for (const part of bc ? [b] : triangulate(b)) { const p = clipConvex(part, a); if (p.length) pieces.push(p); }
  else if (bc) for (const part of triangulate(a)) { const p = clipConvex(part, b); if (p.length) pieces.push(p); }
  else for (const ta of triangulate(a)) for (const tb of triangulate(b)) { const p = clipConvex(ta, tb); if (p.length) pieces.push(p); }
  let minimum = Infinity;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const p = a[i], q = a[(i + 1) % a.length], r = b[j], s = b[(j + 1) % b.length];
    if (segmentsIntersect(p, q, r, s)) minimum = 0;
    else minimum = Math.min(minimum, pointSegmentDistance(p, r, s), pointSegmentDistance(q, r, s), pointSegmentDistance(r, p, q), pointSegmentDistance(s, p, q));
  }
  const area = pieces.reduce((total, p) => total + Math.abs(polygonArea(p)), 0);
  const areaA = Math.abs(polygonArea(a)), areaB = Math.abs(polygonArea(b));
  const areaTolerance = EPS * Math.max(1, Math.sqrt(areaA), Math.sqrt(areaB));
  const aInB = pieces.length > 0 && Math.abs(area - areaA) <= areaTolerance;
  const bInA = pieces.length > 0 && Math.abs(area - areaB) <= areaTolerance;
  return { relation: pieces.length ? 'overlap' : minimum <= EPS ? 'touching' : 'disjoint', containment: aInB && bInA ? 'equal' : aInB ? 'a-in-b' : bInA ? 'b-in-a' : 'none', intersectionPolygons: pieces, distanceMeters: pieces.length ? 0 : minimum };
}

/** Outer parallel-line intersection: contains the convex polygon's full radius-margin buffer. */
function offsetConvex(polygon: Point2[], margin: number): Point2[] {
  return polygon.map((point, i) => {
    const a = polygon[(i + polygon.length - 1) % polygon.length], b = polygon[(i + 1) % polygon.length];
    const l1 = distance(a, point), l2 = distance(point, b);
    const n1 = { x: (point.y - a.y) / l1, y: -(point.x - a.x) / l1 };
    const n2 = { x: (b.y - point.y) / l2, y: -(b.x - point.x) / l2 };
    const denominator = 1 + n1.x * n2.x + n1.y * n2.y;
    if (denominator <= 1e-10) throw new RangeError('倾覆外包出现退化拐点');
    return { x: point.x + margin * (n1.x + n2.x) / denominator, y: point.y + margin * (n1.y + n2.y) / denominator };
  });
}

/** Pure geometry screen; never a stability calculation or prediction of an actual accident.
 * For outward normal n and support line n·x=s, a mesh point (p,h) could reach
 * q=p+(sqrt((n·p-s)^2+h^2)-(n·p-s))*n on the horizontal ground if allowed to
 * rotate until THAT point touches. Allowing all points to do this independently ignores
 * earlier rigid-body contacts and therefore overestimates reachable landing locations.
 * At each sampled angle, tangent strips bound ALL mesh points (not just boom tips).
 * Their convex hull is expanded by 2*R*delta: |dq/dtheta| <= 4R, so the nearest
 * sample (<=delta/2 away) plus this margin bounds unsampled normals as well.
 * Mesh triangle interiors are covered too: the normal reach is a convex norm,
 * tangent position is linear, and each interior landing lies between the original
 * plan projection and the convex combination of its vertex landing positions.
 * The result is explicitly a conservative outer envelope, not an exact fall footprint. */
export function computeMachineryFallEnvelope(asset: LoadedMachineryAsset, metadata: MachineryMetadata, supportOverride?: FallSupportRectangle): FallEnvelope {
  const origin = { longitude: metadata.placement.longitude, latitude: metadata.placement.latitude, height: metadata.placement.height };
  const result: FallEnvelope = {
    status: 'unavailable', origin, polygon: [], landingPoints: [], supportPolygon: [], maxDistanceMeters: 0, envelopeRadiusMeters: 0, samplingMarginMeters: 0, supportSource: 'unavailable',
    method: 'support-line-independent-ground-reach-outer-envelope/v1',
    assumptions: ['水平地面；机械不滑移、不解体；固定地面支承线', '采用当前完整模型形状，逐点求可达地面位置；忽略刚体首次接地挡止', '360 个倾覆方向；切向分条外包、凸包及角度采样余量，属于保守几何筛查', '未计吊载、未建模附件、地基沉降及现场尺寸误差'], warnings: [],
  };
  try {
    validateGeo(origin);
    if (metadata.assetId !== asset.id || metadata.assetVersion !== asset.version) throw new RangeError('机械资产与保存参数版本不匹配');
    if (!Number.isFinite(metadata.placement.heading)) throw new RangeError('机械朝向无效');
    const mesh = computeMachineryGeometry(asset, metadata.parameters);
    const used = [...new Set(mesh.indices)];
    if (!used.length) throw new RangeError('机械模型没有可用于计算的实体顶点');
    const vertices = used.map(index => ({ x: mesh.positions[index * 3], y: mesh.positions[index * 3 + 2], h: mesh.positions[index * 3 + 1], part: asset.partIds[index] }));
    if (vertices.some(v => ![v.x, v.y, v.h].every(Number.isFinite) || Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.h)) > 1000)) throw new RangeError('机械尺寸超出本地筛查可支持范围');
    const height = mesh.bounds.size[1], groundTolerance = Math.max(1e-5, height * 1e-6);
    if (vertices.some(v => v.h < -groundTolerance)) throw new RangeError('当前机械姿态有部件低于假定地面，请调整姿态或核对模型地面基准后重算');
    let support: Point2[];
    if (supportOverride) {
      const s = supportOverride;
      if (![s.length, s.width, s.centerX, s.centerZ].every(Number.isFinite) || s.length <= 0 || s.width <= 0 || Math.max(s.length, s.width, Math.abs(s.centerX), Math.abs(s.centerZ)) > 1000) throw new RangeError('自定义支承尺寸或中心偏移无效');
      support = [{ x: s.centerX - s.length / 2, y: s.centerZ - s.width / 2 }, { x: s.centerX + s.length / 2, y: s.centerZ - s.width / 2 }, { x: s.centerX + s.length / 2, y: s.centerZ + s.width / 2 }, { x: s.centerX - s.length / 2, y: s.centerZ + s.width / 2 }];
      result.supportSource = 'user-defined';
    } else if (asset.type === 'crane') {
      const bottom: Point2[] = [];
      for (let part = 10; part <= 13; part++) {
        const points = vertices.filter(v => v.part === part), min = Math.min(...points.map(v => v.h));
        if (!points.length || min > Math.max(0.01 * metadata.parameters.overall_scale, groundTolerance)) throw new RangeError('无法识别四个落地支腿，请填写实际支承矩形');
        const tolerance = Math.max(1e-6, height * 1e-5);
        for (const point of points) if (point.h <= min + tolerance) bottom.push({ x: point.x, y: point.y });
      }
      support = convexHull(bottom); result.supportSource = 'model-outriggers';
      result.warnings.push('支承来自当前模型支脚底面，需核对实际支腿落地情况与模型尺寸。');
    } else {
      const min = vertices.reduce((value, v) => Math.min(value, v.h), Infinity), tolerance = Math.max(1e-6, height * 1e-5);
      support = convexHull(vertices.filter(v => v.h <= min + tolerance).map(v => ({ x: v.x, y: v.y })));
      result.supportSource = 'model-base-estimate';
      result.warnings.push('支承由模型最低点估计，尚未识别厂家履带/底座接触边；可填写实际支承矩形修正。');
    }
    if (support.length < 3 || Math.abs(polygonArea(support)) < 1e-8) throw new RangeError('无法得到有效地面支承区域，请填写实际支承矩形');
    const theta = metadata.placement.heading * RAD, cosine = Math.cos(theta), sine = Math.sin(theta);
    // glTF +X north, +Z east at heading 0; preserve exactly the existing renderer convention.
    const enu = (p: Point2): Point2 => ({ x: p.x * sine + p.y * cosine, y: p.x * cosine - p.y * sine });
    result.supportPolygon = support.map(enu);
    let radius = 0;
    for (const v of vertices) for (const p of support) radius = Math.max(radius, Math.hypot(v.x - p.x, v.y - p.y, Math.max(0, v.h)));
    const directions = 360, strips = 16, delta = 2 * Math.PI / directions, outerPoints: Point2[] = [], landings: Point2[] = [];
    // The bound also covers changes of the active support vertex: the support function is continuous.
    result.samplingMarginMeters = 2 * radius * delta;
    const xmin = mesh.bounds.min[0], xmax = mesh.bounds.max[0], zmin = mesh.bounds.min[2], zmax = mesh.bounds.max[2];
    for (let direction = 0; direction < directions; direction++) {
      const angle = direction * delta, nx = Math.cos(angle), ny = Math.sin(angle), tx = -ny, ty = nx;
      let offset = -Infinity;
      for (const p of support) offset = Math.max(offset, p.x * nx + p.y * ny);
      const tangentMin = (tx >= 0 ? xmin : xmax) * tx + (ty >= 0 ? zmin : zmax) * ty;
      const tangentMax = (tx >= 0 ? xmax : xmin) * tx + (ty >= 0 ? zmax : zmin) * ty;
      const step = Math.max(1e-10, (tangentMax - tangentMin) / strips);
      const nmin = new Float64Array(strips).fill(Infinity), nmax = new Float64Array(strips).fill(-Infinity);
      const tmin = new Float64Array(strips).fill(Infinity), tmax = new Float64Array(strips).fill(-Infinity);
      let farthest = { x: 0, y: 0 }, farthestSquare = -1;
      for (const v of vertices) {
        const d = v.x * nx + v.y * ny - offset, h = Math.max(0, v.h), normal = offset + Math.sqrt(d * d + h * h), tangent = v.x * tx + v.y * ty;
        const qx = normal * nx + tangent * tx, qy = normal * ny + tangent * ty, square = qx * qx + qy * qy;
        if (square > farthestSquare) { farthestSquare = square; farthest = { x: qx, y: qy }; }
        const bin = Math.max(0, Math.min(strips - 1, Math.floor((tangent - tangentMin) / step)));
        nmin[bin] = Math.min(nmin[bin], normal); nmax[bin] = Math.max(nmax[bin], normal);
        tmin[bin] = Math.min(tmin[bin], tangent); tmax[bin] = Math.max(tmax[bin], tangent);
      }
      landings.push(enu(farthest)); result.maxDistanceMeters = Math.max(result.maxDistanceMeters, Math.sqrt(farthestSquare));
      for (let bin = 0; bin < strips; bin++) if (Number.isFinite(nmin[bin])) {
        for (const n of [nmin[bin], nmax[bin]]) for (const t of [tmin[bin], tmax[bin]]) outerPoints.push({ x: n * nx + t * tx, y: n * ny + t * ty });
      }
    }
    // Include the current body plan so already-occupied equipment is also screened.
    for (const v of vertices) outerPoints.push({ x: v.x, y: v.y });
    const polygon = offsetConvex(convexHull(outerPoints), result.samplingMarginMeters).map(enu);
    if (polygon.some(p => !finitePoint(p))) throw new RangeError('倾覆外包超出局部坐标范围');
    result.polygon = polygon; result.landingPoints = landings;
    result.envelopeRadiusMeters = Math.max(...polygon.map(p => Math.hypot(p.x, p.y)));
    result.status = 'estimated';
    result.warnings.push('模型几何推算，未包含首次接触停止、吊载和地基变化，不作为机械稳定性或作业许可结论。');
  } catch (error) {
    result.polygon = []; result.landingPoints = []; result.maxDistanceMeters = 0; result.envelopeRadiusMeters = 0;
    result.warnings.push(error instanceof Error ? error.message : '无法计算倾覆外包');
  }
  return result;
}
