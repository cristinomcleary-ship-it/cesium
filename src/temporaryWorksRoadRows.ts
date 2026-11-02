import type { PlanXY, PlanningTriangle } from "./temporaryWorksGeometry";

import { RoadMeshCapacity } from "./temporaryWorksRoadChunks";

type SectionPoint = { station: number; offset: number };
type UV = [number, number];

/** Refine the original two affine CAD faces per band, using station rows rather
 * than clipping every triangle of a dense centerline through a second XY grid. */
export function meshRoadSections(points: PlanXY[], coordinates: SectionPoint[], spacing: number, limit: number) {
  const columns = coordinates.findIndex(c => c.station !== coordinates[0].station);
  if (columns < 2 || points.length % columns !== 0) throw new Error("便道断面行列不一致");
  const rows = points.length / columns;
  const acrossSteps: number[] = [];
  const overflow = () => new RoadMeshCapacity(limit);
  for (let col = 0; col < columns - 1; col++) {
    let widest = 0;
    for (let row = 0; row < rows; row++) {
      const i = row * columns + col;
      widest = Math.max(widest, Math.hypot(points[i+1].x-points[i].x, points[i+1].y-points[i].y));
    }
    acrossSteps.push(Math.max(1, Math.ceil(widest / (spacing / Math.SQRT2))));
  }
  const rowSize = 1 + acrossSteps.reduce((sum, n) => sum + n, 0);
  if (rows * rowSize > limit) throw overflow();
  const ids = new Map<string, number>();
  const triangles: PlanningTriangle[] = [];

  // For one affine map, any two points in a grid cell are at most one diagonal apart.
  // Solve |along/n ± across/k| <= spacing, including skewed miter cross-sections.
  function requiredRows(from: PlanXY, to: PlanXY, lo: PlanXY, hi: PlanXY, k: number) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const ex = (hi.x - lo.x) / k, ey = (hi.y - lo.y) / k;
    const dot = Math.abs(dx * ex + dy * ey);
    const slack = spacing * spacing - ex * ex - ey * ey;
    return Math.ceil((dot + Math.sqrt(dot * dot + slack * (dx*dx + dy*dy))) / slack);
  }

  for (let row = 0; row < rows - 1; row++) {
    const base = row * columns;
    let steps = 1;
    for (let col = 0; col < columns - 1; col++) {
      const a = points[base+col], b = points[base+col+1];
      const c = points[base+columns+col], d = points[base+columns+col+1];
      const k = acrossSteps[col];
      steps = Math.max(steps, requiredRows(a,c,c,d,k), requiredRows(b,d,a,b,k));
    }
    if (!Number.isSafeInteger(steps) || steps * rowSize > limit) throw overflow();
    for (let col = 0; col < columns - 1; col++) {
      const i = base + col, a = points[i], b = points[i+1], c = points[i+columns], d = points[i+columns+1];
      const k = acrossSteps[col];
      const affine = Math.hypot((d.x-c.x)-(b.x-a.x), (d.y-c.y)-(b.y-a.y)) < 1e-10;

      function vertex([t,u]: UV) {
        if ((t === 0 || t === 1) && (u === 0 || u === 1)) return i + t*columns + u;
        const key = (row+t).toFixed(12) + "/" + (col+u).toFixed(12);
        const existing = ids.get(key);
        if (existing !== undefined) return existing;
        if (points.length >= limit) throw overflow();
        const dx = t >= u ? t*(c.x-a.x) + u*(d.x-c.x) : u*(b.x-a.x) + t*(d.x-b.x);
        const dy = t >= u ? t*(c.y-a.y) + u*(d.y-c.y) : u*(b.y-a.y) + t*(d.y-b.y);
        const id = points.length, origin = coordinates[i];
        points.push({x:a.x+dx, y:a.y+dy});
        coordinates.push({station:origin.station+t*(coordinates[i+columns].station-origin.station),
          offset:origin.offset+u*(coordinates[i+1].offset-origin.offset)});
        ids.set(key,id);
        return id;
      }
      function emit(poly: UV[]) {
        const origin = vertex(poly[0]);
        for (let j = 1; j + 1 < poly.length; j++) triangles.push([origin, vertex(poly[j+1]), vertex(poly[j])]);
      }
      for (let r = 0; r < steps; r++) for (let h = 0; h < k; h++) {
        const t0 = r/steps, t1 = (r+1)/steps, u0 = h/k, u1 = (h+1)/k;
        const box: UV[] = [[t0,u0],[t1,u0],[t1,u1],[t0,u1]];
        if (affine || t1 <= u0 || u1 <= t0) { emit(box); continue; }
        // The CAD diagonal (t=u) carries the original station and level on a
        // skewed bend. Preserve it exactly instead of interpolating across it.
        const lower: UV[] = [], upper: UV[] = [];
        for (let j = 0; j < 4; j++) {
          const p = box[j], q = box[(j+1)%4], v = p[0]-p[1], w = q[0]-q[1];
          if (v >= 0) lower.push(p);
          if (v <= 0) upper.push(p);
          if (v*w < 0) {
            const at = p[0] === q[0] ? p[0] : p[1];
            lower.push([at,at]); upper.push([at,at]);
          }
        }
        emit(lower); emit(upper);
      }
    }
  }
  return triangles;
}
