import { cleanPlanningBoundary, type PlanXY } from './temporaryWorksGeometry';
import { validateTemporaryWorksGlbResource, type TemporaryWorksGlbDimensions, type TemporaryWorksGlbResource } from './temporaryWorksGlb';

export type TemporaryWorksGlbAutoFit = {
  /** Bottom anchor in the same local east/north metre frame as the CAD boundary. */
  anchor: PlanXY;
  headingDeg: number;
  scaleMode: 'xyz';
  dimensions: TemporaryWorksGlbDimensions;
  scale: { x: number; y: number; z: number };
  footprints: PlanXY[][];
  targetArea: number;
  footprintArea: number;
  coverageRatio: number;
  method: 'rectangle' | 'inscribed';
  message: string;
};

type Box = { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number; center: PlanXY };
type Candidate = { center: PlanXY; angle: number; sx: number; sy: number; area: number; distortion: number; footprints: PlanXY[][] };
const EPS = 1e-7;
const TAU = Math.PI * 2;
const cross = (a: PlanXY, b: PlanXY, c: PlanXY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const rotate = (p: PlanXY, angle: number): PlanXY => ({ x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) });
function area(ring: readonly PlanXY[]) {
  return Math.abs(ring.reduce((sum, p, i) => sum + cross(ring[0], p, ring[(i + 1) % ring.length]), 0)) / 2;
}
function box(points: readonly PlanXY[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } };
}
function pointSegmentDistance(p: PlanXY, a: PlanXY, b: PlanXY) {
  const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
  const t = d ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / d)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function inside(p: PlanXY, ring: readonly PlanXY[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (pointSegmentDistance(p, a, b) <= EPS) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

/** Prepare once: checking only vertices would let an edge bridge a concave CAD recess. */
function prepareContainment(site: readonly PlanXY[], clearance: number) {
  const limits = box(site);
  const edges = site.map((a, i) => ({ a, b: site[(i + 1) % site.length] }));
  return (rings: readonly (readonly PlanXY[])[]) => {
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a.x < limits.minX - EPS || a.x > limits.maxX + EPS || a.y < limits.minY - EPS || a.y > limits.maxY + EPS || !inside(a, site)) return false;
      const dx = b.x - a.x, dy = b.y - a.y, cuts = [0, 1];
      for (const { a: c, b: d } of edges) {
        const ex = d.x - c.x, ey = d.y - c.y, den = dx * ey - dy * ex;
        if (Math.abs(den) > 1e-12) {
          const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
          const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
          if (t > 0 && t < 1 && u >= -EPS && u <= 1 + EPS) cuts.push(t);
        }
        if (clearance > 0 && Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b)) < clearance - EPS) return false;
      }
      cuts.sort((a, b) => a - b);
      for (let j = 1; j < cuts.length; j++) {
        const t = (cuts[j - 1] + cuts[j]) / 2;
        if (!inside({ x: a.x + t * dx, y: a.y + t * dy }, site)) return false;
      }
    }
    return true;
  };
}

function hull(points: readonly PlanXY[]) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (list: readonly PlanXY[]) => {
    const result: PlanXY[] = [];
    for (const p of list) {
      while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], p) <= 0) result.pop();
      result.push(p);
    }
    return result;
  };
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}

function unique(values: number[], tolerance = 1e-7) {
  return values.sort((a, b) => a - b).filter((value, i, all) => !i || Math.abs(value - all[i - 1]) > tolerance);
}
function sample<T>(values: T[], count: number) {
  return values.length <= count ? values : Array.from({ length: count }, (_, i) => values[Math.round(i * (values.length - 1) / (count - 1))]);
}

/**
 * Fit audited structural footprints, never the scene bounds (which can contain trees/helpers).
 * A rectangle permits exact horizontal independent scaling; height is retained. For other
 * outlines this bounded orientation/position/aspect search returns a verified feasible fit,
 * not a proof of a largest packing or a distortion-free match to an arbitrary polygon.
 */
export function fitTemporaryWorksGlbToBoundary(
  asset: TemporaryWorksGlbResource,
  boundary: readonly PlanXY[],
  options: { flip180?: boolean; clearanceMetres?: number } = {},
): TemporaryWorksGlbAutoFit {
  validateTemporaryWorksGlbResource(asset);
  const site = cleanPlanningBoundary(boundary), targetArea = area(site);
  const clearance = options.clearanceMetres ?? 0.05;
  if (!Number.isFinite(clearance) || clearance < 0 || clearance > 10) throw new Error('自动布置边界余量必须为 0 至 10 米。');
  if (!Number.isFinite(targetArea) || targetArea < 0.0001) throw new Error('CAD 闭合轮廓面积过小，无法自动布置。');
  const sourcePoint = ([x, y]: [number, number]): PlanXY => ({ x: x - asset.anchor[0], y: asset.upAxis === 'Y' ? asset.anchor[2] - y : y - asset.anchor[1] });
  const source = asset.footprints.map(p => cleanPlanningBoundary(p.outer.map(sourcePoint)));
  const sourceBox = box(source.flat());
  const sourceArea = source.reduce((sum, ring, i) => sum + area(ring) - (asset.footprints[i].holes ?? []).reduce((holes, ring) => holes + area(cleanPlanningBoundary(ring.map(sourcePoint))), 0), 0);
  if (sourceBox.width < EPS || sourceBox.height < EPS || sourceArea < EPS) throw new Error('已核验建筑底面没有有效面积，无法自动布置。');
  const centered = source.map(ring => ring.map(p => ({ x: p.x - sourceBox.center.x, y: p.y - sourceBox.center.y })));
  const contains = prepareContainment(site, clearance);
  const convex = hull(site), quarter = Math.PI / 2;
  // A minimum-area enclosing rectangle has an edge parallel to a convex-hull edge.
  const angles = unique(convex.map((p, i) => {
    const q = convex[(i + 1) % convex.length];
    const a = Math.atan2(q.y - p.y, q.x - p.x);
    const normalized = ((a % quarter) + quarter) % quarter;
    return Math.abs(normalized - quarter) < 1e-7 ? 0 : normalized;
  }));
  // Dense arcs can have thousands of hull edges; bound this candidate generation too.
  const oriented = sample(angles, 64).map(angle => ({ angle, bounds: box(site.map(p => rotate(p, -angle))) }))
    .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height || a.angle - b.angle);
  let best: Candidate | undefined;
  const preferable = (a: Candidate, b: Candidate | undefined) => !b || a.area > b.area + targetArea * 1e-7 ||
    (Math.abs(a.area - b.area) <= targetArea * 1e-7 && (a.distortion < b.distortion - 1e-8 || (Math.abs(a.distortion - b.distortion) < 1e-8 && a.angle < b.angle)));
  const candidate = (center: PlanXY, angle: number, sx: number, sy: number): Candidate | undefined => {
    if (sx <= EPS || sy <= EPS) return;
    const footprints = centered.map(ring => ring.map(p => {
      const q = rotate({ x: p.x * sx, y: p.y * sy }, angle);
      return { x: q.x + center.x, y: q.y + center.y };
    }));
    if (!contains(footprints)) return;
    return { center, angle, sx, sy, footprints, area: sourceArea * sx * sy, distortion: Math.abs(Math.log(sx / sy)) };
  };
  const flip = options.flip180 ? Math.PI : 0;
  // A flip means exactly half a turn from the normal result. Re-ranking all
  // orientations after flipping an asymmetric building could silently turn it 90°.
  const flippedAngle = options.flip180
    ? fitTemporaryWorksGlbToBoundary(asset, boundary, { ...options, flip180: false }).headingDeg * Math.PI / 180 + Math.PI
    : undefined;
  const acceptsAngle = (angle: number) => flippedAngle === undefined || Math.abs(angle - flippedAngle) < 1e-7;
  let rectangle = false;
  for (const entry of oriented) {
    if (Math.abs(entry.bounds.width * entry.bounds.height - targetArea) > targetArea * 1e-7) continue;
    rectangle = true;
    for (const turn of [0, quarter]) {
      const angle = entry.angle + turn + flip, bounds = box(site.map(p => rotate(p, -angle)));
      if (!acceptsAngle(angle)) continue;
      // CAD -> geodetic -> local ENU can turn a nominal rectangle into a very
      // slightly tapered quadrilateral. Retain the original edges as the check.
      for (const inset of [1, 1 - 1e-6, 1 - 1e-5, 1 - 1e-4, 1 - 1e-3]) {
        const result = candidate(rotate(bounds.center, angle), angle, (bounds.width - 2 * clearance) / sourceBox.width * inset, (bounds.height - 2 * clearance) / sourceBox.height * inset);
        if (result) { if (preferable(result, best)) best = result; break; }
      }
    }
  }

  // Keep dense curved CAD responsive. All candidates still use the complete original
  // boundary for containment; only the search sampling density is reduced.
  const complexity = site.length * centered.reduce((count, ring) => count + ring.length, 0);
  const density = Math.min(1, Math.sqrt(24 / complexity));
  const angleLimit = Math.max(1, Math.floor(8 * density));
  const coordinateLimit = Math.max(3, Math.floor(18 * density));
  const ratioLimit = Math.max(3, Math.floor(18 * density));
  if (!rectangle) for (const entry of oriented.slice(0, angleLimit)) for (const turn of [0, quarter]) {
    const angle = entry.angle + turn + flip;
    if (!acceptsAngle(angle)) continue;
    const projected = site.map(p => rotate(p, -angle)), bounds = box(projected);
    if (bounds.width <= 2 * clearance || bounds.height <= 2 * clearance) continue;
    const xs = sample(unique(projected.map(p => p.x)), 12), ys = sample(unique(projected.map(p => p.y)), 12);
    const coordinates = (values: number[], min: number, extent: number) => sample(unique([
      min + extent / 2, ...values.slice(1).map((v, i) => (v + values[i]) / 2),
      ...Array.from({ length: 7 }, (_, i) => min + extent * (i + 1) / 8),
    ]), coordinateLimit);
    const centers = coordinates(xs, bounds.minX, bounds.width).flatMap(x => coordinates(ys, bounds.minY, bounds.height).map(y => rotate({ x, y }, angle)));
    // Include aspect ratios suggested by actual CAD subdivisions, such as each arm of an L.
    const xFractions = xs.slice(1).flatMap((x, i) => xs.slice(0, i + 1).map(a => (x - a) / bounds.width));
    const yFractions = ys.slice(1).flatMap((y, i) => ys.slice(0, i + 1).map(a => bounds.height / (y - a)));
    const ratios = unique([1, ...sample(unique([0.25, 0.5, 1, 2, 4, ...xFractions, ...yFractions].filter(v => v >= 0.05 && v <= 20)), ratioLimit)]);
    let orientationBest: Candidate | undefined, bestRatio = 1;
    const at = (center: PlanXY, ratio: number) => {
      const sx = (bounds.width - 2 * clearance) / sourceBox.width * Math.min(1, ratio);
      const sy = (bounds.height - 2 * clearance) / sourceBox.height * Math.min(1, 1 / ratio);
      let result = candidate(center, angle, sx, sy);
      if (result) return result;
      // A concave footprint can have its bbox centre outside the site. Search brackets
      // in that case too; do not incorrectly reject a U-shaped building by its centre.
      let low = 0, high = 1;
      if (!contains([[center, center, center]])) {
        for (let step = 9; step >= 1; step--) {
          const t = step / 10, found = candidate(center, angle, sx * t, sy * t);
          if (found) { low = t; high = t + 0.1; result = found; break; }
        }
        if (!result) return;
      }
      for (let iteration = 0; iteration < 18; iteration++) {
        const mid = (low + high) / 2, found = candidate(center, angle, sx * mid, sy * mid);
        if (found) { low = mid; result = found; } else high = mid;
      }
      return result;
    };
    for (const ratio of ratios) for (const center of centers) {
      const result = at(center, ratio);
      if (result && preferable(result, orientationBest)) { orientationBest = result; bestRatio = ratio; }
    }
    // Refine centre continuously; a fixed grid alone badly under-fits narrow/recessed sites.
    if (orientationBest) {
      for (let step = 0; step < 8; step++) {
        const dx = bounds.width / (8 * 2 ** step), dy = bounds.height / (8 * 2 ** step);
        for (const offset of [{ x: -dx, y: 0 }, { x: dx, y: 0 }, { x: 0, y: -dy }, { x: 0, y: dy }]) {
          const delta = rotate(offset, angle), center = { x: orientationBest.center.x + delta.x, y: orientationBest.center.y + delta.y };
          const result = at(center, bestRatio);
          if (result && preferable(result, orientationBest)) orientationBest = result;
        }
      }
      if (preferable(orientationBest, best)) best = orientationBest;
    }
  }
  if (!best || best.area < 0.0001) throw new Error('无法在所选闭合轮廓内布置完整建筑底面，请检查轮廓或减小边界余量。');
  const offset = rotate({ x: sourceBox.center.x * best.sx, y: sourceBox.center.y * best.sy }, best.angle);
  const footprintArea = best.area, coverageRatio = Math.min(1, footprintArea / targetArea);
  return {
    anchor: { x: best.center.x - offset.x, y: best.center.y - offset.y },
    headingDeg: ((best.angle % TAU) + TAU) % TAU * 180 / Math.PI,
    scaleMode: 'xyz', scale: { x: best.sx, y: best.sy, z: 1 },
    dimensions: { length: asset.dimensions.length * best.sx, width: asset.dimensions.width * best.sy, height: asset.dimensions.height },
    footprints: best.footprints, targetArea, footprintArea, coverageRatio,
    method: rectangle ? 'rectangle' : 'inscribed',
    message: `${rectangle ? '已按矩形轮廓自动旋转并独立匹配平面长宽' : '已在非矩形轮廓内搜索完整底面的可行布置，未保证最大覆盖或无畸变贴合'}；保留原建筑高度；建筑覆盖率 ${(coverageRatio * 100).toFixed(1)}%${clearance ? `；边界预留 ${clearance.toFixed(2)} 米` : ''}。`,
  };
}
