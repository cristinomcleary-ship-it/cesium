import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4, Transforms, type Ray } from 'cesium';

export type HardeningGeoPoint = { longitude: number; latitude: number };
export type HardeningReference = HardeningGeoPoint & { height: number };
export type HardeningLocalPoint = { x: number; y: number };

export const HARDENING_DRAW_MAX_RADIUS = 20_000;

export function validateHardeningReference(reference: HardeningReference) {
  if (![reference.longitude, reference.latitude, reference.height].every(Number.isFinite) ||
      Math.abs(reference.longitude) > 180 || Math.abs(reference.latitude) >= 89.9)
    throw new Error('请填写有效的参考经纬度和场地顶椭球高；极区场地暂不支持。');
}

function localFrame(reference: HardeningReference) {
  validateHardeningReference(reference);
  return Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(reference.longitude, reference.latitude, reference.height));
}

/** The anchor is fixed while the outline changes; these coordinates never come from photography depth. */
export function hardeningLocalFromGeo(point: HardeningGeoPoint, reference: HardeningReference): HardeningLocalPoint {
  if (![point.longitude, point.latitude].every(Number.isFinite) || Math.abs(point.longitude) > 180 || Math.abs(point.latitude) > 90)
    throw new Error('硬化边界存在无效经纬度。');
  const inverse = Matrix4.inverseTransformation(localFrame(reference), new Matrix4());
  const local = Matrix4.multiplyByPoint(inverse, Cartesian3.fromDegrees(point.longitude, point.latitude, reference.height), new Cartesian3());
  return { x: local.x, y: local.y };
}

export function hardeningGeoFromLocal(point: HardeningLocalPoint, reference: HardeningReference): HardeningGeoPoint {
  if (![point.x, point.y].every(Number.isFinite) || Math.hypot(point.x, point.y) > HARDENING_DRAW_MAX_RADIUS)
    throw new Error('硬化范围距参考点过远，请调整参考点或分区绘制。');
  const world = Matrix4.multiplyByPoint(localFrame(reference), new Cartesian3(point.x, point.y, 0), new Cartesian3());
  const location = Cartographic.fromCartesian(world);
  return { longitude: CesiumMath.toDegrees(location.longitude), latitude: CesiumMath.toDegrees(location.latitude) };
}

/** Intersect the camera ray with the user's ENU design plane, never pickPosition/sampleHeight. */
export function intersectHardeningDesignPlane(
  ray: Pick<Ray, 'origin' | 'direction'>,
  reference: HardeningReference,
  gradeEastPct = 0,
  gradeNorthPct = 0,
): HardeningLocalPoint | undefined {
  if (![gradeEastPct, gradeNorthPct].every(Number.isFinite)) throw new Error('场地坡率必须为有效数值。');
  const inverse = Matrix4.inverseTransformation(localFrame(reference), new Matrix4());
  const origin = Matrix4.multiplyByPoint(inverse, ray.origin, new Cartesian3());
  const direction = Matrix4.multiplyByPointAsVector(inverse, ray.direction, new Cartesian3());
  const east = gradeEastPct / 100, north = gradeNorthPct / 100;
  const divisor = direction.z - east * direction.x - north * direction.y;
  // About 0.5 degrees from the plane: avoid magnifying pointer noise near the horizon.
  if (Math.abs(divisor) / Math.sqrt(1 + east * east + north * north) < 0.01) return undefined;
  const distance = (east * origin.x + north * origin.y - origin.z) / divisor;
  if (!Number.isFinite(distance) || distance < 0) return undefined;
  const point = { x: origin.x + distance * direction.x, y: origin.y + distance * direction.y };
  return Math.hypot(point.x, point.y) <= HARDENING_DRAW_MAX_RADIUS ? point : undefined;
}

export function hardeningRectangle(first: HardeningLocalPoint, opposite: HardeningLocalPoint): HardeningLocalPoint[] {
  if (![first.x, first.y, opposite.x, opposite.y].every(Number.isFinite)) throw new Error('矩形端点无效。');
  if (Math.abs(first.x - opposite.x) < 0.001 || Math.abs(first.y - opposite.y) < 0.001)
    throw new Error('矩形长、宽须大于1毫米，请重新选取对角点。');
  const west = Math.min(first.x, opposite.x), east = Math.max(first.x, opposite.x);
  const south = Math.min(first.y, opposite.y), north = Math.max(first.y, opposite.y);
  return [{ x: west, y: south }, { x: east, y: south }, { x: east, y: north }, { x: west, y: north }];
}

/** Positive slope rises along the selected direction, clockwise from north. */
export function hardeningSlopeComponents(enabled: boolean, directionDegrees: number, gradePct: number) {
  if (!enabled) return { gradeEastPct: 0, gradeNorthPct: 0 };
  if (![directionDegrees, gradePct].every(Number.isFinite)) throw new Error('请填写有效的坡向和坡率。');
  const direction = CesiumMath.toRadians(directionDegrees);
  return { gradeEastPct: Math.sin(direction) * gradePct, gradeNorthPct: Math.cos(direction) * gradePct };
}
