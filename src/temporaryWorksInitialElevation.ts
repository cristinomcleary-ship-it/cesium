import { ShapeUtils, Vector2 } from 'three';
import type { PlanXY } from './temporaryWorksGeometry';
import { measureRoadAxis } from './temporaryWorksRoadAxis';

export const MAX_INITIAL_ELEVATION_SAMPLES = 9;
const MAX_BOUNDARY_POINTS = 20_000;
const EPS = 1e-8;
export type InitialElevationFootprint = { outer: readonly PlanXY[]; holes?: readonly (readonly PlanXY[])[] };
export type InitialElevationGeoPoint = { longitude: number; latitude: number };
export type InitialElevationOptions = { signal?: AbortSignal; checkCurrent?: () => void };
export type InitialElevationSample<T extends InitialElevationGeoPoint = InitialElevationGeoPoint> = T & {
  height: number;
  /** Number of points actually submitted to the selected photography sampler. */
  sampleCount: number;
  candidateIndex: number;
};

const distance2 = (a: PlanXY, b: PlanXY) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const cross = (a: PlanXY, b: PlanXY, c: PlanXY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const validPoint = (p: PlanXY) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
function containsStrictly(ring: readonly PlanXY[], point: PlanXY): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (Math.abs(cross(a, b, point)) <= EPS * Math.max(1, Math.sqrt(distance2(a, b))) &&
        point.x >= Math.min(a.x, b.x) - EPS && point.x <= Math.max(a.x, b.x) + EPS &&
        point.y >= Math.min(a.y, b.y) - EPS && point.y <= Math.max(a.y, b.y) + EPS) return false;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function containsOrTouches(ring: readonly PlanXY[], point: PlanXY): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (Math.abs(cross(a, b, point)) <= EPS * Math.max(1, Math.sqrt(distance2(a, b))) &&
        point.x >= Math.min(a.x, b.x) - EPS && point.x <= Math.max(a.x, b.x) + EPS &&
        point.y >= Math.min(a.y, b.y) - EPS && point.y <= Math.max(a.y, b.y) + EPS) return true;
  }
  return containsStrictly(ring, point);
}
function copyRing(input: readonly PlanXY[]): PlanXY[] {
  if (!input.every(validPoint)) throw new Error('取高范围包含无效坐标，请重新选择范围。');
  const points = input.filter((point, i) => !i || distance2(point, input[i - 1]) > EPS * EPS).map(point => ({ ...point }));
  if (points.length > 1 && distance2(points[0], points.at(-1)!) <= EPS * EPS) points.pop();
  if (points.length < 3) throw new Error('取高范围至少需要三个有效边界点。');
  return points;
}

/**
 * Choose a few interior positions, never an unverified bounding-box center. Triangulation is
 * used only to find valid points in concave outlines/holes; it does not sample a surface mesh.
 * The caller supplies local metre coordinates and converts the result through its own frame.
 */
export function polygonInitialElevationCandidates(footprints: readonly InitialElevationFootprint[]): PlanXY[] {
  const count = footprints.reduce((n, polygon) => n + polygon.outer.length + (polygon.holes ?? []).reduce((m, ring) => m + ring.length, 0), 0);
  if (!footprints.length || count > MAX_BOUNDARY_POINTS) throw new Error('取高范围为空或边界过于复杂，请分区选择或手动输入标高。');
  const polygons = footprints.map(polygon => ({ outer: copyRing(polygon.outer), holes: (polygon.holes ?? []).map(copyRing) }));
  const inPolygon = (point: PlanXY, polygon: typeof polygons[number]) =>
    containsStrictly(polygon.outer, point) && !polygon.holes.some(hole => containsOrTouches(hole, point));
  const pool: { point: PlanXY; area: number; center: boolean }[] = [];
  for (const polygon of polygons) {
    const outer = polygon.outer.map(p => new Vector2(p.x, p.y)), holes = polygon.holes.map(ring => ring.map(p => new Vector2(p.x, p.y)));
    const points = [...outer, ...holes.flat()], triangles = ShapeUtils.triangulateShape(outer, holes);
    let area = 0;
    for (const [a, b, c] of triangles) {
      const triangleArea = Math.abs(cross(points[a], points[b], points[c])) / 2;
      if (triangleArea <= EPS * EPS) continue;
      const point = { x: (points[a].x + points[b].x + points[c].x) / 3, y: (points[a].y + points[b].y + points[c].y) / 3 };
      if (inPolygon(point, polygon)) { pool.push({ point, area: triangleArea, center: false }); area += triangleArea; }
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of polygon.outer) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    // Nine inexpensive candidate positions also spread fallbacks across a large simple pad.
    // Only candidates inside the actual polygon, excluding all holes, enter the sample list.
    for (const x of [.5, .25, .75]) for (const y of [.5, .25, .75]) {
      const point = { x: minX + (maxX - minX) * x, y: minY + (maxY - minY) * y };
      if (inPolygon(point, polygon)) pool.push({ point, area, center: x === .5 && y === .5 });
    }
  }
  if (!pool.length) throw new Error('所选范围没有可用的内部取高点，请重新框选或手动输入标高。');
  pool.sort((a, b) => Number(b.center) - Number(a.center) || b.area - a.area);
  const selected = [pool[0].point];
  // Farthest-point selection distributes a fixed, small fallback set across disconnected
  // facilities and irregular pads without increasing the photography sampling budget.
  while (selected.length < MAX_INITIAL_ELEVATION_SAMPLES) {
    let best: PlanXY | undefined, separation = EPS * EPS;
    for (const { point } of pool) {
      const nearest = Math.min(...selected.map(chosen => distance2(point, chosen)));
      if (nearest > separation) { separation = nearest; best = point; }
    }
    if (!best) break;
    selected.push(best);
  }
  return selected.map(point => ({ ...point }));
}

/** Candidates stay on the imported/tessellated axis; measured stations retain arc factors. */
export function roadInitialElevationCandidates(input: readonly PlanXY[], factors?: readonly number[]): (PlanXY & { station: number })[] {
  if (input.length > MAX_BOUNDARY_POINTS) throw new Error('便道中心线过于复杂，请分段选择或手动输入标高。');
  const { points, stationFactors, length } = measureRoadAxis(input, factors);
  const candidates: (PlanXY & { station: number })[] = [];
  for (const fraction of [.5, 0, 1, .25, .75, .125, .375, .625, .875]) {
    const station = length * fraction;
    let travelled = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], measured = Math.sqrt(distance2(a, b)) * stationFactors[i - 1];
      if (station <= travelled + measured || i === points.length - 1) {
        const t = Math.max(0, Math.min(1, (station - travelled) / measured));
        const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, station };
        if (!candidates.some(old => distance2(old, point) <= EPS * EPS)) candidates.push(point);
        break;
      }
      travelled += measured;
    }
  }
  return candidates;
}

/** Read one valid initial height, not a minimum/average/fit of a sampled surface. */
export async function sampleTemporaryWorksInitialElevation<T extends InitialElevationGeoPoint>(
  candidates: readonly T[], sample: (points: T[]) => Promise<readonly (number | null | undefined)[]>,
  options: InitialElevationOptions = {},
): Promise<InitialElevationSample<T>> {
  const check = () => { options.signal?.throwIfAborted(); options.checkCurrent?.(); };
  check();
  const points = candidates.slice(0, MAX_INITIAL_ELEVATION_SAMPLES).map(point => ({ ...point }));
  if (!points.length) throw new Error('所选范围没有可用取高点，请重新选择范围或手动输入标高。');
  if (points.some(p => !Number.isFinite(p.longitude) || !Number.isFinite(p.latitude) || Math.abs(p.longitude) > 180 || Math.abs(p.latitude) >= 90))
    throw new Error('初始取高点包含无效经纬度，请核对定位参数。');
  let sampleCount = 0;
  for (const [start, end] of [[0, 1], [1, points.length]]) {
    if (start >= end) continue;
    check();
    const requested = points.slice(start, end);
    const heights = await sample(requested);
    sampleCount += requested.length;
    check();
    if (heights.length !== requested.length) throw new Error('倾斜摄影取高结果不完整，请重试或手动输入标高。');
    for (let index = 0; index < heights.length; index++) {
      const height = heights[index];
      if (typeof height === 'number' && Number.isFinite(height))
        return { ...points[start + index], height, sampleCount, candidateIndex: start + index };
    }
  }
  throw new Error('所选范围内未读取到有效倾斜摄影高程，请检查摄影覆盖或切换手动输入标高。');
}
