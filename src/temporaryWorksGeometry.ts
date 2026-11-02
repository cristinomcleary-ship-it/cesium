import { ShapeUtils, Vector2 } from "three";
import { meshRoadSections } from "./temporaryWorksRoadRows";
import { partitionRoad, joinRoadSeam, RoadMeshCapacity, type RoadCut } from "./temporaryWorksRoadChunks";
import { roundedRoadStrip } from "./temporaryWorksRoadBends";
import { checkRoadAxis, compactRoadTangents, measureRoadAxis } from "./temporaryWorksRoadAxis";

export type PlanXY = { x: number; y: number };
export type PlanningTriangle = [number, number, number];
export type PlanningFootprint = {
  points: readonly PlanXY[];
  kind: "boundary" | "centerline";
  width?: number;
  sectionOffsets?: readonly number[];
  stationBreaks?: readonly number[];
  stationFactors?: readonly number[];
};
type RoadCoordinate = { station: number; offset: number; absoluteOffset?: number };
type RoadFrame = {
  centerline: PlanXY[];
  stationFactors?: number[];
  coordinates: RoadCoordinate[];
  bendJoin?: "round-union";
  bands?: WeakMap<PlanningTriangle,readonly [number,number]>;
  radiusAt?: (p:PlanXY,band:readonly [number,number],a:RoadCoordinate,b:RoadCoordinate)=>number;
  overlapStations?: [number,number][];
  // Original strip faces locate the reference on the same station/offset surface as mesh vertices.
  faces: PlanningTriangle[];
};
export type PlanningMesh = {
  points: PlanXY[];
  triangles: PlanningTriangle[];
  spacing: number;
  planArea: number;
  roadFrame?: RoadFrame;
  seamStations?: readonly number[];
};
export type PlanningDesign = {
  reference: PlanXY;
  referenceHeight: number;
  finishedOffset: number;
  surfaceToTreatment: number;
  treatmentDepth: number;
  gradeEastPct?: number;
  gradeNorthPct?: number;
  centerline?: readonly PlanXY[];
  longitudinalPct?: number;
  crossfallPct?: number;
  sectionProfile?: readonly { offset: number; rise: number }[];
};

const EPS = 1e-7;
export const MAX_PLANNING_VERTICES = 8192;
const distance = (a: PlanXY, b: PlanXY) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a: PlanXY, b: PlanXY, c: PlanXY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const validPoint = (p: PlanXY) => Number.isFinite(p?.x) && Number.isFinite(p?.y);

function cleanLine(input: readonly PlanXY[], closed: boolean) {
  if (input.length > MAX_PLANNING_VERTICES) throw new Error("所选线的顶点过多，请简化或分段导入");
  const points: PlanXY[] = [];
  for (const p of input) {
    if (!validPoint(p)) throw new Error("CAD 平面坐标含有无效数值");
    if (!points.length || distance(points[points.length - 1], p) > EPS) points.push({ ...p });
  }
  if (closed && points.length && distance(points[0], points[points.length - 1]) <= EPS) points.pop();
  if (points.length < (closed ? 3 : 2)) throw new Error("所选线的有效顶点不足");
  return points;
}

class FoldedRing extends Error {}

function ensureSimpleRing(points: PlanXY[]) {
  const edges = points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    return { a, b, i, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
  }).sort((s, t) => s.minX - t.minX);
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i + points.length - 1) % points.length], p = points[i], next = points[(i + 1) % points.length];
    if (Math.abs(cross(prev, p, next)) <= EPS && (prev.x - p.x) * (next.x - p.x) + (prev.y - p.y) * (next.y - p.y) > 0)
      throw new FoldedRing("边界存在重叠回折，请修正 CAD 图线");
    const e = edges[i];
    for (let j = i + 1; j < edges.length && edges[j].minX <= e.maxX; j++) {
      const f = edges[j], delta = Math.abs(e.i - f.i);
      if (delta === 1 || delta === points.length - 1 || f.maxY < e.minY || f.minY > e.maxY) continue;
      if (cross(e.a, e.b, f.a) * cross(e.a, e.b, f.b) <= 0 && cross(f.a, f.b, e.a) * cross(f.a, f.b, e.b) <= 0)
        throw new FoldedRing("范围边界自交或重叠，请调整边界、路线或便道宽度");
    }
  }
}

export function cleanPlanningBoundary(input: readonly PlanXY[]) {
  const ring = cleanLine(input, true);
  ensureSimpleRing(ring);
  return ring;
}

function ringArea(points: PlanXY[]) {
  return Math.abs(points.reduce((sum, p, i) => sum + cross(points[0], p, points[(i + 1) % points.length]), 0)) / 2;
}

function roadStrip(centerline: PlanXY[], width: number, sectionOffsets: readonly number[], maxSamples: number,
  stationBreaks: readonly number[] = [], stationFactors?: readonly number[]) {
  if (!Number.isFinite(width) || width <= EPS) throw new Error("请输入大于零的便道宽度（米）");
  if (sectionOffsets.some(offset => !Number.isFinite(offset))) throw new Error("断面折点的横向距离无效");
  const half = width / 2;
  const offsets = [...new Set([-half, 0, half, ...sectionOffsets.filter(x => x > -half + EPS && x < half - EPS)])].sort((a, b) => a - b);
  if (offsets.length * centerline.length > maxSamples) throw new RoadMeshCapacity(maxSamples);
  let station = 0, nextBreak = 0;
  const points: PlanXY[] = [], coordinates: RoadCoordinate[] = [], faces: PlanningTriangle[] = [], left: PlanXY[] = [], right: PlanXY[] = [];
  // In an east/north frame, (dy,-dx) points right looking in increasing chainage.
  const normals = centerline.slice(1).map((end, i) => {
    const start = centerline[i], len = distance(start, end);
    return { x: (end.y - start.y) / len, y: (start.x - end.x) / len };
  });
  const miters = centerline.map((_, i) => {
    const prev = normals[Math.max(0, i - 1)], next = normals[Math.min(i, normals.length - 1)];
    const denominator = 1 + prev.x * next.x + prev.y * next.y;
    if (denominator < 0.125) throw new FoldedRing("便道转角过急，需要有界转接");
    return { x: (prev.x + next.x) / denominator, y: (prev.y + next.y) / denominator };
  });
  function addSection(origin: PlanXY, miter: PlanXY, chainage: number) {
    const base = points.length;
    if (base + offsets.length > maxSamples) throw new RoadMeshCapacity(maxSamples);
    for (const offset of offsets) {
      points.push({ x: origin.x + offset * miter.x, y: origin.y + offset * miter.y });
      coordinates.push({ station: chainage, offset });
    }
    left.push(points[base]); right.push(points[points.length - 1]);
    if (!base) return;
    const previous = base - offsets.length;
    for (let j = 0; j < offsets.length - 1; j++) {
      faces.push([previous + j, base + j + 1, base + j], [previous + j, previous + j + 1, base + j + 1]);
    }
  }
  addSection(centerline[0], miters[0], 0);
  const lerp = (a: PlanXY, b: PlanXY, t: number) => ({x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t});
  for (let i = 1; i < centerline.length; i++) {
    const length = distance(centerline[i-1], centerline[i]) * (stationFactors?.[i-1] ?? 1);
    const end = station + length;
    // Interpolate both mitered edges, preserving the original CAD outline even if
    // a grade break falls just before a curve or the inside of a sharp corner.
    while (nextBreak < stationBreaks.length && stationBreaks[nextBreak] < end - EPS) {
      const at = stationBreaks[nextBreak++]; if (at <= station + EPS) continue;
      const t = (at - station) / length;
      addSection(lerp(centerline[i-1],centerline[i],t), lerp(miters[i-1],miters[i],t), at);
    }
    addSection(centerline[i], miters[i], end);
    station = end;
  }
  const ring = [...left, ...right.reverse()];
  ensureSimpleRing(ring);
  const planArea = ringArea(ring);
  const seededArea = faces.reduce((sum,[a,b,c])=>sum+Math.abs(cross(points[a],points[b],points[c]))/2,0);
  if (Math.abs(seededArea-planArea)>Math.max(1e-6,planArea*1e-8))
    throw new FoldedRing("弯道内侧断面需要裁剪");
  return { ring, points, faces, planArea, frame: { centerline, coordinates, faces } };
}

/** Triangulate the exact CAD outline and bound every cell edge by the requested horizontal spacing. */
export function buildPlanningMesh(footprint: PlanningFootprint, spacing: number, maxSamples = 12000): PlanningMesh {
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 3 || maxSamples > 100000) throw new Error("采样点数上限无效");
  return buildMesh(footprint, spacing, maxSamples);
}

function buildMesh(footprint:PlanningFootprint,spacing:number,maxSamples:number, forceRound=false):PlanningMesh {
  if (!Number.isFinite(spacing) || spacing <= 0) throw new Error("请输入大于零的采样间距（米）");
  let points: PlanXY[], ring: PlanXY[], initial: PlanningTriangle[], roadFrame: RoadFrame | undefined;
  let corridorArea: number | undefined;
  if (footprint.kind === "centerline") {
    const measured = measureRoadAxis(footprint.points, footprint.stationFactors);
    const { points:line, stationFactors } = compactRoadTangents(measured.points, measured.stationFactors);
    checkRoadAxis(line, stationFactors);
    let strip;
    try {
      if(forceRound)throw new FoldedRing();
      strip = roadStrip(line, footprint.width ?? NaN, footprint.sectionOffsets ?? [], maxSamples, footprint.stationBreaks, stationFactors);
    } catch (error) {
      if (!(error instanceof FoldedRing)) throw error;
      strip = roundedRoadStrip(line, footprint.width!, footprint.sectionOffsets ?? [], footprint.stationBreaks ?? [], stationFactors, maxSamples, spacing);
    }
    corridorArea = strip.planArea;
    points = strip.points; ring = strip.ring; initial = strip.faces; roadFrame = { ...strip.frame, stationFactors };
  } else {
    points = ring = cleanPlanningBoundary(footprint.points);
    initial = ShapeUtils.triangulateShape(ring.map(p => new Vector2(p.x - ring[0].x, p.y - ring[0].y)), []) as PlanningTriangle[];
  }
  const planArea = corridorArea ?? ringArea(ring);
  if (planArea < 0.0001 || !Number.isFinite(planArea)) throw new Error("选定范围的平面面积过小或坐标无效");
  const area = (t: PlanningTriangle) => cross(points[t[0]], points[t[1]], points[t[2]]) / 2;
  const seededArea = initial.reduce((sum, t) => sum + Math.abs(area(t)), 0);
  if (Math.abs(seededArea - planArea) > Math.max(1e-6, planArea * 1e-8)) throw new Error("无法构成连续范围，请检查边界或缩小便道宽度");

  // A planar mesh with at most limit vertices and edge length <= h cannot
  // cover more than limit * h², even with equilateral triangles.
  if (roadFrame && planArea > maxSamples*spacing*spacing) throw new RoadMeshCapacity(maxSamples);
  if (roadFrame?.bendJoin === "round-union") {
    // The union sweep already has sampled interiors. Refine only its long edges;
    // clipping every small sweep face through a second XY lattice creates slivers.
    const triangles: PlanningTriangle[] = [], pending = [...initial], midpoints = new Map<string,number>();
    while (pending.length) {
      const t = pending.pop()!;
      const lengths = t.map((a,i)=>distance(points[a],points[t[(i+1)%3]]));
      const band=roadFrame.bands!.get(t)!;
      const longest = Math.max(...lengths);
      if (longest <= spacing * (1+1e-9)) { triangles.push(t); continue; }
      const i=lengths.indexOf(longest);
      const a=t[i], b=t[(i+1)%3], c=t[(i+2)%3];
      const k=Math.min(a,b)+"/"+Math.max(a,b);
      let m=midpoints.get(k);
      if(m===undefined) {
        m=points.length;
        if(m>=maxSamples)throw new RoadMeshCapacity(maxSamples);
        midpoints.set(k,m);
        points.push({x:(points[a].x+points[b].x)/2,y:(points[a].y+points[b].y)/2});
        const ca=roadFrame.coordinates[a],cb=roadFrame.coordinates[b];
        roadFrame.coordinates.push({station:(ca.station+cb.station)/2,offset:(ca.offset+cb.offset)/2,
          absoluteOffset:roadFrame.radiusAt!(points[m],band,ca,cb)});
      }
      const subA:PlanningTriangle=[a,m,c],subB:PlanningTriangle=[m,b,c];
      roadFrame.bands!.set(subA,band);roadFrame.bands!.set(subB,band);
      pending.push(subA,subB);
    }
    return {points,triangles,roadFrame,spacing,planArea};
  }

  if (roadFrame) {
    const triangles = meshRoadSections(points, roadFrame.coordinates, spacing, maxSamples);
    return { points, triangles, roadFrame, spacing, planArea };
  }

  // Slice each original face by the same metric grid. A long, narrow road remains
  // proportional to its area and perimeter instead of recursively splitting slivers.
  const sizeError = () => new Error(`本次超过 ${maxSamples} 个采样点，请增大采样间距或分段计算`);
  const cell = spacing / Math.SQRT2;
  const origin = { x: Math.min(...ring.map(p => p.x)), y: Math.min(...ring.map(p => p.y)) };
  const extent = Math.max(...ring.map(p => Math.max(p.x - origin.x, p.y - origin.y)));
  if (points.length > maxSamples || extent / cell > maxSamples || planArea / (cell * cell) > maxSamples) throw sizeError();
  const triangles: PlanningTriangle[] = [], vertices = new Map<string, number>();
  const key = (p: PlanXY) => p.x.toFixed(8) + "/" + p.y.toFixed(8);
  points.forEach((p, i) => vertices.set(key(p), i));

  function vertex(p: PlanXY) {
    const k = key(p), existing = vertices.get(k);
    if (existing !== undefined) return existing;
    if (points.length >= maxSamples) throw sizeError();
    vertices.set(k, points.length);
    points.push(p);
    return points.length - 1;
  }
  for (const face of initial) {
    if (area(face) < 0) [face[1], face[2]] = [face[2], face[1]];
    const base = face.map(i => points[i]);
    const [firstY, lastY] = bins(base, "y");
    for (let y = firstY; y <= lastY; y++) {
      const strip = clipBand(base, "y", origin.y + y * cell, origin.y + (y + 1) * cell);
      if (strip.length < 3) continue;
      const [firstX, lastX] = bins(strip, "x");
      for (let x = firstX; x <= lastX; x++) {
        const polygon = clipBand(strip, "x", origin.x + x * cell, origin.x + (x + 1) * cell);
        if (polygon.length < 3 || ringArea(polygon) < 1e-13) continue;
        // Include an interior model sample in every accepted cell, including holes/boundaries.
        const x0 = polygon[0].x, y0 = polygon[0].y;
        const center = vertex({ x: x0 + polygon.reduce((s, p) => s + p.x - x0, 0) / polygon.length,
          y: y0 + polygon.reduce((s, p) => s + p.y - y0, 0) / polygon.length });
        const ids = polygon.map(p => vertex(p));
        for (let i = 0; i < ids.length; i++) {
          const t: PlanningTriangle = [ids[i], ids[(i + 1) % ids.length], center];
          if (area(t) > 1e-13) triangles.push(t);
        }
      }
    }
  }
  return { points, triangles, spacing, planArea, roadFrame };

  function bins(vertices: PlanXY[], axis: "x" | "y") {
    const values = vertices.map(p => (p[axis] - origin[axis]) / cell);
    const first = Math.floor(Math.min(...values));
    return [first, Math.max(first, Math.ceil(Math.max(...values)) - 1)];
  }
}

/** Generate independently surveyable sections. A cut is accepted only when its
 * complete transverse plane separates all preceding and following geometry. */
export function* buildRoadMeshChunks(footprint:PlanningFootprint,spacing:number,maxSamples=12000):Generator<PlanningMesh> {
  if(footprint.kind!=="centerline") {yield buildPlanningMesh(footprint,spacing,maxSamples);return;}
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 3 || maxSamples > 100000) throw new Error("采样点数上限无效");
  const measured=measureRoadAxis(footprint.points,footprint.stationFactors);
  const {points,stationFactors}=compactRoadTangents(measured.points,measured.stationFactors);
  const width=footprint.width ?? NaN;
  if(!Number.isFinite(spacing)||spacing<=0 || !Number.isFinite(width)||width<=EPS)
    throw new Error("采样间距和道路宽度须为有效正数");
  checkRoadAxis(points,stationFactors);
  const a=points[0],b=points.at(-1)!, reverse=a.x>b.x || a.x===b.x && a.y>b.y;
  const ordered=reverse?[...points].reverse():points;
  const factors=reverse?[...stationFactors].reverse():stationFactors;
  const partition = partitionRoad(ordered, factors, width, spacing);
  // Select the design once, before any size-dependent cuts or retries.
  let round = false;
  try { roadStrip(points,width,footprint.sectionOffsets??[],Number.MAX_SAFE_INTEGER,[],stationFactors); }
  catch (e) { if (!(e instanceof FoldedRing)) throw e; round=true; }

  const flip = (c:RoadCut):RoadCut => ({...c, edge:points.length-2-c.edge, t:1-c.t, station:measured.length-c.station});
  const stops = reverse ? partition.cuts.reverse().map(flip) : partition.cuts;
  const inseparableLimit = 500_000; // Bound simultaneous vertices/faces of a single overlapping region.
  function* section(begin:RoadCut, end:RoadCut):Generator<PlanningMesh> {
    const line = [begin.point,...points.slice(begin.edge+1,end.edge+1),end.point];
    const breaks = footprint.stationBreaks?.filter(s=>s>begin.station+EPS && s<end.station-EPS).map(s=>s-begin.station);
    const local = {...footprint,points:line,stationFactors:stationFactors.slice(begin.edge,end.edge+1),stationBreaks:breaks};
    const union = round && line.length>2;
    let mesh:PlanningMesh;
    try { mesh=buildMesh(local,spacing,maxSamples,union); }
    catch (error) {
      if (!(error instanceof RoadMeshCapacity)) throw error;
      const split = reverse ? partition.bisect(flip(end), flip(begin)) : partition.bisect(begin,end);
      if (split) {
        const cut=reverse ? flip(split) : split;
        yield* section(begin,cut);
        yield* section(cut,end);
        return;
      }
      // A shared pair of hairpin legs cannot be separated by chainage without
      // double counting their overlap. Mesh that union once; surface requests
      // still stream in the same bounded batches as all other sections.
      try { mesh=buildMesh(local,spacing,inseparableLimit,union); }
      catch (e) {
        if (!(e instanceof RoadMeshCapacity)) throw e;
        throw new Error(`桩号 ${begin.station.toFixed(3)}～${end.station.toFixed(3)} m 的单个相连区域超过 ${inseparableLimit} 个网格点，请核对图纸单位、断面宽度和采样间距。`);
      }
    }
    const frame=mesh.roadFrame!;
    frame.centerline=points; frame.stationFactors=stationFactors;
    for (const c of frame.coordinates) c.station+=begin.station;
    if (frame.overlapStations) for (const pair of frame.overlapStations) {pair[0]+=begin.station;pair[1]+=begin.station;}
    const seams:number[]=[];
    if (begin.station>EPS) seams.push(begin.station);
    if (end.station<measured.length-EPS) seams.push(end.station);
    mesh.seamStations=seams;
    yield mesh;
  }
  let previous:PlanningMesh|undefined;
  for (let i=1;i<stops.length;i++) for (const mesh of section(stops[i-1],stops[i])) {
    if (previous) {
      joinRoadSeam(previous,mesh,mesh.seamStations![0]);
      yield previous;
    }
    previous=mesh;
  }
  if (previous) yield previous;
}

function clipBand(points: PlanXY[], axis: "x" | "y", start: number, end: number) {
  function clip(input: PlanXY[], bound: number, minimum: boolean) {
    const output: PlanXY[] = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length], b = input[i];
      const aInside = minimum ? a[axis] >= bound : a[axis] <= bound;
      const bInside = minimum ? b[axis] >= bound : b[axis] <= bound;
      if (aInside !== bInside) {
        const f = (bound - a[axis]) / (b[axis] - a[axis]);
        const p = { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
        p[axis] = bound;
        output.push(p);
      }
      if (bInside) output.push(b);
    }
    return output;
  }
  return clip(clip(points, start, true), end, false);
}

/** Add shared edge midpoints only at sampled coverage boundaries. Each level is one batched survey. */
export async function refinePlanningCoverage(mesh: PlanningMesh, ground: readonly (number | null | undefined)[],
  sample: (points: PlanXY[]) => Promise<readonly (number | null | undefined)[]>, maxLevels = 2, maxSamples = 12000) {
  if (mesh.points.length !== ground.length) throw new Error("模型采样与当前范围不匹配");
  if (!Number.isSafeInteger(maxLevels) || maxLevels < 0 || maxLevels > 6 || ((!Number.isSafeInteger(maxSamples) || maxSamples < 3 || maxSamples > 100000) && maxSamples !== Infinity))
    throw new Error("边界加密参数无效");
  const points = [...mesh.points], heights = [...ground];
  const frame = mesh.roadFrame && { ...mesh.roadFrame, coordinates: [...mesh.roadFrame.coordinates] };
  let triangles = mesh.triangles, levels = 0, budgetLimited = false;
  while (levels < maxLevels) {
    const edges = new Map<string, number>(), start = points.length;
    const key = (a: number, b: number) => a < b ? a + "/" + b : b + "/" + a;
    for (const [a,b,c] of triangles) {
      const hits = Number(Number.isFinite(heights[a])) + Number(Number.isFinite(heights[b])) + Number(Number.isFinite(heights[c]));
      if (hits === 0 || hits === 3) continue;
      for (const [i,j] of [[a,b], [b,c], [c,a]]) {
        const k = key(i,j);
        if (!edges.has(k)) edges.set(k, start + edges.size);
      }
    }
    if (!edges.size) break;
    // Keep the previous uniform boundary resolution if the whole next level exceeds the budget.
    if (start + edges.size > maxSamples) { budgetLimited = true; break; }
    const additions: PlanXY[] = [];
    for (const edge of edges.keys()) {
      const [i,j] = edge.split("/").map(Number);
      additions.push({ x: (points[i].x + points[j].x) / 2, y: (points[i].y + points[j].y) / 2 });
      if (frame) {
        const a = frame.coordinates[i], b = frame.coordinates[j];
        frame.coordinates.push({ station: (a.station + b.station) / 2, offset: (a.offset + b.offset) / 2,
          ...(a.absoluteOffset!==undefined ? {absoluteOffset:(a.absoluteOffset+b.absoluteOffset!)/2} : {}) });
      }
    }
    const samples = await sample(additions);
    if (samples.length !== additions.length) throw new Error("模型边界加密采样未完成");
    for(const point of additions)points.push(point);
    for(const value of samples)heights.push(value);
    const refined: PlanningTriangle[] = [];
    for (const t of triangles) {
      const mids = t.map((id, i) => edges.get(key(id, t[(i + 1) % 3])));
      const count = mids.filter(m => m !== undefined).length;
      if (!count) { refined.push(t); continue; }
      if (count === 3) {
        const [a,b,c] = t, [ab,bc,ca] = mids as number[];
        refined.push([a,ab,ca], [b,bc,ab], [c,ca,bc], [ab,bc,ca]);
      } else {
        // Split adjacent covered/empty faces at shared midpoints as well, so no hanging edges occur.
        const i = count === 1 ? mids.findIndex(m => m !== undefined) : (mids.findIndex(m => m === undefined) + 1) % 3;
        const a = t[i], b = t[(i+1)%3], c = t[(i+2)%3], ab = mids[i]!;
        if (count === 1) refined.push([a,ab,c], [ab,b,c]);
        else {
          const bc = mids[(i+1)%3]!;
          refined.push([b,bc,ab], [a,ab,c], [ab,bc,c]);
        }
      }
    }
    triangles = refined;
    levels++;
  }
  return { mesh: { ...mesh, points, triangles, roadFrame: frame }, ground: heights, levels, budgetLimited };
}

export function projectRoad(p: PlanXY, line: readonly PlanXY[], stationFactors?: readonly number[]): RoadCoordinate {
  let station = 0, nearest = Infinity, result = { station: 0, offset: 0 };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], len = distance(a, b);
    const east = (b.x - a.x) / len, north = (b.y - a.y) / len;
    const dx = p.x - a.x, dy = p.y - a.y, along = Math.max(0, Math.min(len, dx * east + dy * north));
    const d = Math.hypot(dx - along * east, dy - along * north);
    const factor = stationFactors?.[i-1] ?? 1;
    if (d < nearest) {
      nearest = d;
      result = { station: station + along * factor, offset: dx * north - dy * east };
    }
    station += len * factor;
  }
  return result;
}

export function roadReferenceInside(p: PlanXY, mesh: PlanningMesh, frame: RoadFrame) {
  for (const [a, b, c] of frame.faces) {
    const pa = mesh.points[a], pb = mesh.points[b], pc = mesh.points[c], det = cross(pa, pb, pc);
    const u = cross(p, pb, pc) / det, v = cross(p, pc, pa) / det, w = 1 - u - v;
    if (Math.min(u, v, w) >= -1e-9) {
      const ca = frame.coordinates[a], cb = frame.coordinates[b], cc = frame.coordinates[c];
      return { station: u * ca.station + v * cb.station + w * cc.station, offset: u * ca.offset + v * cb.offset + w * cc.offset };
    }
  }
}

export function roadReference(p: PlanXY, mesh: PlanningMesh, frame: RoadFrame, stationFactors?: readonly number[]) {
  return roadReferenceInside(p,mesh,frame) ?? projectRoad(p, frame.centerline, frame.stationFactors ?? stationFactors);
}

function finishedLevels(mesh: PlanningMesh, d: PlanningDesign) {
  const values = [d.referenceHeight, d.finishedOffset, d.surfaceToTreatment, d.treatmentDepth,
    d.gradeEastPct ?? 0, d.gradeNorthPct ?? 0, d.longitudinalPct ?? 0, d.crossfallPct ?? 0];
  if (!validPoint(d.reference) || !values.every(Number.isFinite) || d.surfaceToTreatment < 0 || d.treatmentDepth < 0)
    throw new Error("请核对基准点、高程、坡度与非负的结构厚度");
  const zero = d.referenceHeight + d.finishedOffset;
  const road = mesh.roadFrame?.centerline ?? (d.centerline && cleanLine(d.centerline, false));
  if (!road) {
    if (d.sectionProfile?.length) throw new Error("典型横断面需要配合便道中心线使用");
    return mesh.points.map(p => zero + ((p.x - d.reference.x) * (d.gradeEastPct ?? 0) + (p.y - d.reference.y) * (d.gradeNorthPct ?? 0)) / 100);
  }
  const profile = d.sectionProfile;
  if (profile && (profile.length < 2 || profile.some((p, i) => !Number.isFinite(p.rise) || !Number.isFinite(p.offset) || (i > 0 && p.offset <= profile[i - 1].offset))))
    throw new Error("断面折点须由左至右排列，横向距离须递增");
  function relativeHeight({ station, offset }: RoadCoordinate) {
    let rise = -Math.abs(offset) * (d.crossfallPct ?? 0) / 100;
    if (profile) {
      if (offset < profile[0].offset - EPS || offset > profile[profile.length - 1].offset + EPS)
        throw new Error("断面宽度未覆盖道路或基准点，请复核道路宽度、断面及基准点位置");
      let hi = profile.length - 1, lo = 0;
      while (hi - lo > 1) {
        const mid = (hi + lo) >>> 1;
        if (profile[mid].offset >= offset) hi = mid; else lo = mid;
      }
      const a = profile[lo], b = profile[hi], t = (offset - a.offset) / (b.offset - a.offset);
      rise = a.rise + t * (b.rise - a.rise);
    }
    return station * (d.longitudinalPct ?? 0) / 100 + rise;
  }
  const frame = mesh.roadFrame;
  const base = relativeHeight(frame ? roadReference(d.reference, mesh, frame) : projectRoad(d.reference, road));
  return mesh.points.map((p, i) => zero + relativeHeight(frame?.coordinates[i] ?? projectRoad(p, road)) - base);
}

/** Exact positive and negative volumes of a linearly interpolated signed depth over a triangle. */
export function signedVolumes(area: number, depths: number[]) {
  const [a, b, c] = depths.sort((x, y) => x - y), net = area * (a + b + c) / 3;
  if (a >= 0) return [net, 0];
  if (c <= 0) return [0, -net];
  if (b <= 0) {
    const cut = area / 3 * c * (c / (c - a)) * (c / (c - b));
    return [cut, Math.max(0, cut - net)];
  }
  const fill = area / 3 * -a * (a / (a - b)) * (a / (a - c));
  return [Math.max(0, net + fill), fill];
}

export function calculatePlanningEarthwork(mesh: PlanningMesh, ground: readonly (number | null | undefined)[], design: PlanningDesign) {
  if (ground.length !== mesh.points.length) throw new Error("模型采样尚未完成或与当前计算范围不匹配");
  const finishedHeights = finishedLevels(mesh, design);
  const treatmentTopHeights = finishedHeights.map(h => h - design.surfaceToTreatment);
  const formationHeights = treatmentTopHeights.map(h => h - design.treatmentDepth);
  let cutVolume = 0, fillVolume = 0, coveredArea = 0;
  const triangles: PlanningTriangle[] = [];
  for (const t of mesh.triangles) {
    if (t.some(i => !Number.isFinite(ground[i]))) continue;
    const area = Math.abs(cross(mesh.points[t[0]], mesh.points[t[1]], mesh.points[t[2]])) / 2;
    const [cut, fill] = signedVolumes(area, t.map(i => ground[i]! - formationHeights[i]));
    cutVolume += cut; fillVolume += fill; coveredArea += area;
    triangles.push(t);
  }
  return { triangles, finishedHeights, treatmentTopHeights, formationHeights, planArea: mesh.planArea,
    coveredArea, excludedArea: Math.max(0, mesh.planArea - coveredArea), cutVolume, fillVolume };
}
