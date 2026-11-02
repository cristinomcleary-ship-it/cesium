import type { PlanXY, PlanningTriangle } from "./temporaryWorksGeometry";

import { RoadMeshCapacity } from "./temporaryWorksRoadChunks";
import { visibleStrokeEdges, type StrokePiece } from "./temporaryWorksRoadUnion";

type Band = readonly [number, number];
type Coordinate = { station: number; offset: number; absoluteOffset: number };
type Edge = { a: PlanXY; b: PlanXY; low: number; high: number; level: number; delta: number; radius?: number };
type Row = { edge: Edge; radius?: number };
type Cell = { l: number; r: number; bottom: Row; top: Row; inner: number; outer: number };
const EPS = 1e-8;
const cross = (a: PlanXY, b: PlanXY, c: PlanXY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const yAt = (e: Edge, x: number) => e.a.y + (e.b.y - e.a.y) * ((x - e.a.x) / (e.b.x - e.a.x));
const key = (x: number, y: number) => x.toFixed(8) + "/" + y.toFixed(8);


/**
 * A folded miter cannot be used as the ring of a polygon. Sweep the union of
 * butt-ended segment rectangles and round exterior joins at every design radius.
 * Each open x-slab has invariant edge order. Only changes in union membership
 * (plus the centreline) bound disjoint cells, including any enclosed holes.
 */
function makeRoundedStrip(line: PlanXY[], width: number, offsets: readonly number[], breaks: readonly number[],
  factors: readonly number[] | undefined, maxSamples: number, spacing: number) {
  const half = width / 2, radii = [...new Set([half, ...offsets.map(Math.abs).filter(r => r > EPS && r < half - EPS)])].sort((a, b) => a - b);
  const edges: Edge[] = [], eventsX: number[] = [], lineNodes = new Map<number, number[]>();
  const first = line[0];
  // A sweep normal to a long tangent propagates the bend's columns along the
  // entire tangent. Choose an axis that avoids near-vertical long segments.
  const vectors = line.slice(1).map((p, i) => ({ x: p.x - line[i].x, y: p.y - line[i].y }));
  let angle = 0, best = Infinity;
  for (let k = 0; k < 32; k++) {
    const a = k * Math.PI / 32, ca = Math.cos(a), sa = Math.sin(a);
    const cost = vectors.reduce((worst, v) => {
      const len = Math.hypot(v.x, v.y), dx = Math.abs(ca * v.x + sa * v.y) / len;
      return Math.max(worst, len / (0.02 + dx));
    }, 0);
    if (cost < best) {
      best = cost;
      angle = a;
    }
  }
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const local = line.map(p => ({ x: (p.x - first.x) * cos + (p.y - first.y) * sin, y: -(p.x - first.x) * sin + (p.y - first.y) * cos }));
  const stations = [0];
  const segments = local.slice(1).map((b, i) => {
    const a = local[i], len = Math.hypot(b.x - a.x, b.y - a.y);
    const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len, factor = factors?.[i] ?? 1;
    stations.push(stations[i] + len * factor);
    return {
      a, b, len, dx, dy, factor, at: stations[i], minX: Math.min(a.x, b.x) - half, maxX: Math.max(a.x, b.x) + half,
      minY: Math.min(a.y, b.y) - half, maxY: Math.max(a.y, b.y) + half
    };
  });
  function add(a: PlanXY, b: PlanXY, level: number, radius?: number) {
    eventsX.push(a.x, b.x);
    if (Math.abs(b.x - a.x) <= 1e-12) return;
    const forward = b.x > a.x;
    edges.push({
      a: forward ? a : b, b: forward ? b : a, low: Math.min(a.y, b.y), high: Math.max(a.y, b.y),
      delta: level < 0 ? 0 : forward ? 1 : -1, level, radius
    });
  }
  for (const p of local) {
    const col = lineNodes.get(p.x) ?? [];
    col.push(p.y);
    lineNodes.set(p.x, col);
  }
  for (const s of segments) add(s.a, s.b, -1, 0);
  const overlapStations: [number, number][] = [];
  for (let k = 0; k < radii.length; k++) {
    const pieces:StrokePiece[]=[];
    const r = radii[k];
    for (const [i, s] of segments.entries()) {
      const pos = (p: PlanXY, x: number, y: number) => ({ x: p.x + x * r, y: p.y + y * r });
      const ar = pos(s.a, s.dy, -s.dx), br = pos(s.b, s.dy, -s.dx), bl = pos(s.b, -s.dy, s.dx), al = pos(s.a, -s.dy, s.dx);
      pieces.push({ segment:i, at:s.at, end:stations[i+1], stationAt:p=>s.at+s.factor*((p.x-s.a.x)*s.dx+(p.y-s.a.y)*s.dy),
        edges:[{a:ar,b:br,radius:r},{a:br,b:bl},{a:bl,b:al,radius:r},{a:al,b:ar}] });
      if (!i) continue;
      const prev = segments[i - 1], angle = Math.atan2(prev.dx * s.dy - prev.dy * s.dx, prev.dx * s.dx + prev.dy * s.dy);
      if (Math.abs(angle) < 1e-10) continue;
      const sign = Math.sign(angle), start = Math.atan2(-sign * prev.dx, sign * prev.dy);
      const n = Math.max(1, Math.ceil(Math.abs(angle) / (Math.PI / 36) - 1e-10));
      const arc = Array.from({ length: n + 1 }, (_, j) => pos(s.a, Math.cos(start + angle * j / n), Math.sin(start + angle * j / n)));
      // Match the side endpoints exactly instead of creating tiny trigonometric seams.
      arc[0] = pos(s.a, sign * prev.dy, -sign * prev.dx);
      arc[n] = pos(s.a, sign * s.dy, -sign * s.dx);
      if (angle < 0) arc.reverse();
      pieces.push({ segment:i, at:s.at, end:s.at, stationAt:()=>s.at,
        edges:[{a:s.a,b:arc[0]}, ...arc.slice(1).map((b,j)=>({a:arc[j],b,radius:r})),{a:arc[n],b:s.a}] });
    }
    visibleStrokeEdges(pieces,e=>add(e.a,e.b,k,e.radius),k===radii.length-1 ? {
      gap:4*width, breaks, add:(a,b)=>overlapStations.push([a,b])
    } : undefined);
  }
  // Different offset bands are nested; their visible boundaries can meet but
  // never cross in the interior. Their clipped endpoints supply all x events.
  edges.sort((u,v)=>u.a.x-v.a.x);
  function uniqueSorted(v: number[]) {
    v.sort((a, b) => a - b);
    const result: number[] = [];
    for (const x of v) if (!result.length || x - result[result.length - 1] > EPS) result.push(x);
    return result;
  }
  const xs = uniqueSorted(eventsX), cells: Cell[] = [];
  const size = Math.max(width, 1), tiles = new Map<string, number[]>();
  // Index the segment width corridor along its axis rather than filling a diagonal bounding box.
  for (const [i, s] of segments.entries()) {
    const steps = Math.ceil(s.len / size);
    if (steps > maxSamples * 4) throw new RoadMeshCapacity(maxSamples);
    const buckets = new Set<string>();
    for (let j = 0; j <= steps; j++) {
      const x = Math.floor((s.a.x + (s.b.x - s.a.x) * j / steps) / size), y = Math.floor((s.a.y + (s.b.y - s.a.y) * j / steps) / size);
      for (let dx = -1; dx <= 1; dx++)for (let dy = -1; dy <= 1; dy++)buckets.add((x + dx) + ":" + (y + dy));
    }
    for (const bucket of buckets) {
      const ids = tiles.get(bucket) ?? [];
      ids.push(i);
      tiles.set(bucket, ids);
    }
  }
  function coords(p: PlanXY): Coordinate {
    let dist = Infinity, sMin = Infinity, sMax = -Infinity, signed = 0;
    const hits = tiles.get(Math.floor(p.x / size) + ":" + Math.floor(p.y / size)) ?? [];
    for (const i of hits) {
      const s = segments[i];
      if (p.x < s.minX - EPS || p.x > s.maxX + EPS || p.y < s.minY - EPS || p.y > s.maxY + EPS) continue;
      const x = p.x - s.a.x, y = p.y - s.a.y, raw = x * s.dx + y * s.dy;
      if ((i === 0 && raw < -EPS) || (i === segments.length - 1 && raw > s.len + EPS)) continue;
      const along = Math.max(0, Math.min(s.len, raw));
      const d = Math.hypot(x - along * s.dx, y - along * s.dy), at = s.at + along * s.factor;
      if (d > half + EPS * 2) continue;
      if (d < dist - EPS) {
        dist = d;
        sMin = sMax = at;
        signed = x * s.dy - y * s.dx;
      }
      else if (Math.abs(d - dist) <= EPS) {
        sMin = Math.min(sMin, at);
        sMax = Math.max(sMax, at);
      }
    }
    if (!Number.isFinite(dist)) throw new Error("弯道局部坐标超出设计范围，请核对中心线");
    return { station: (sMin + sMax) / 2, offset: (signed < 0 ? -1 : 1) * dist, absoluteOffset: dist };
  }
  let nextEdge = 0, active: Edge[] = [], prior = new Map<string,Cell>();
  const edgeIds = new Map(edges.map((e,i)=>[e,i]));
  for (let i = 0; i + 1 < xs.length; i++) {
    const x = (xs[i] + xs[i + 1]) / 2;
    active = active.filter(e => e.b.x > x);
    while (nextEdge < edges.length && edges[nextEdge].a.x < x) {
      if (edges[nextEdge].b.x > x) active.push(edges[nextEdge]);
      nextEdge++;
    }
    const current: Cell[] = [];
    const sorted = active.map(e => ({ e, y: yAt(e, x) })).sort((a, b) => a.y - b.y);
    const counts = radii.map(() => 0);
    let last: Row | undefined, band = -1;
    for (let j = 0; j < sorted.length;) {
      const y = sorted[j].y;
      let end = j;
      while (end < sorted.length && sorted[end].y - y < EPS) end++;
      let center: Edge | undefined;
      for (let t = j; t < end; t++) {
        const e = sorted[t].e;
        if (e.level < 0) center = e; else counts[e.level] += e.delta;
      }
      const after = counts.findIndex(c => c > 0);
      if (after !== band || center) {
        const boundaryLevel = band < 0 ? after : after < 0 ? band : Math.min(band, after);
        let edge = center ?? sorted[j].e, radius = center ? 0 : undefined;
        if (!center) for (let t = j; t < end; t++) {
          const e = sorted[t].e;
          if (e.level === boundaryLevel) {
            edge = e;
            if (e.radius !== undefined) {
              radius = e.radius;
              break;
            }
          }
        }
        const top = { edge, radius };
        if (last && band >= 0) {
          current.push({ l: i, r: i + 1, bottom: last, top, inner: band ? radii[band - 1] : 0, outer: radii[band] });
        }
        last = top;
        band = after;
      }
      j = end;
    }
    // A change to an outside arc must not subdivide all the parallel bands
    // or a different limb on the other side of the drawing.
    const next = new Map<string,Cell>();
    for (const c of current) {
      const id=edgeIds.get(c.bottom.edge)+"/"+edgeIds.get(c.top.edge);
      const previous=prior.get(id);
      const axisNodes=lineNodes.get(xs[i]);
      const mustCut=axisNodes?.some(y=>y>yAt(c.bottom.edge,xs[i])+EPS && y<yAt(c.top.edge,xs[i])-EPS);
      if (previous && !mustCut) {previous.r=c.r;next.set(id,previous);}
      else {cells.push(c);next.set(id,c);}
    }
    prior=next;
  }
  // Add stations only within long cells. Each source edge records cuts from
  // both adjacent cells so all T-junctions become conforming mesh vertices.
  const atX=new Map<number,number[]>();
  const cuts=new Map<Edge,number[]>();
  const panels:{xl:number;xr:number;cell:Cell}[]=[];
  function splitColumn(x:number,ys:number[]) {
    const col=atX.get(x);
    if(col) { for(const y of ys)col.push(y); } else atX.set(x,ys);
  }
  for(const [x,ys] of lineNodes)splitColumn(x,ys);
  for(const c of cells) {
    const left=xs[c.l],right=xs[c.r], dx=right-left;
    const bottom=c.bottom.edge,top=c.top.edge;
    const len=Math.max(Math.hypot(dx,yAt(bottom,right)-yAt(bottom,left)),Math.hypot(dx,yAt(top,right)-yAt(top,left)));
    const count=Math.max(1,Math.ceil(len/(1.2*spacing)));
    if(panels.length+count>maxSamples)throw new RoadMeshCapacity(maxSamples);
    let last=left;
    for(let j=0;j<=count;j++){
      const x=j===0?left:j===count?right:left+j/count*dx;
      splitColumn(x,[yAt(bottom,x),yAt(top,x)]);
      for(const e of [bottom,top]){const list=cuts.get(e);if(list)list.push(x);else cuts.set(e,[x]);}
      if(j)panels.push({xl:last,xr:x,cell:c});
      last=x;
    }
  }
  for(const [e,list] of cuts)cuts.set(e,uniqueSorted(list));
  for(const [x,list] of atX)atX.set(x,uniqueSorted(list));
  const points: PlanXY[] = [], coordinates: Coordinate[] = [], faces: PlanningTriangle[] = [], index = new Map<string, number>();
  function at(p: PlanXY, inner: number, outer: number, force?: number) {
    const c = coords(p), radius = force ?? Math.min(outer, Math.max(inner, c.absoluteOffset));
    const k = key(p.x, p.y) + "/" + radius.toFixed(7), existing = index.get(k);
    if (existing !== undefined) return existing;
    if (points.length >= maxSamples) throw new RoadMeshCapacity(maxSamples);
    c.offset = (c.offset < 0 ? -1 : 1) * radius;
    c.absoluteOffset = radius;
    const id = points.length;
    index.set(k, id);
    coordinates.push(c);
    points.push({ x: p.x * cos - p.y * sin + first.x, y: p.x * sin + p.y * cos + first.y });
    return id;
  }
  // Map cells by identity; adjacent surface bands can meet at an oblique butt cap.
  const bands = new WeakMap<PlanningTriangle, Band>();
  function radiusAt(p: PlanXY, band: Band, a: { absoluteOffset?: number }, b: { absoluteOffset?: number }) {
    const x = p.x - first.x, y = p.y - first.y;
    const actual = coords({ x: cos * x + sin * y, y: -sin * x + cos * y }).absoluteOffset;
    // The short chords used for a circular boundary lie slightly inside its true radius.
    // Preserve that design edge, but never flatten long interior chords with equal end radii.
    const av = a.absoluteOffset!, bv = b.absoluteOffset!;
    if (Math.abs(av - bv) < EPS && band.some(r => Math.abs(r - av) < EPS)
      && Math.abs(actual - av) < av * (1 - Math.cos(Math.PI / 72)) + EPS * 4) return av;
    return Math.max(band[0], Math.min(band[1], actual));
  }
  let planArea = 0;
  for (const {xl,xr,cell:c} of panels) {
    const bl = yAt(c.bottom.edge, xl), br = yAt(c.bottom.edge, xr), tl = yAt(c.top.edge, xl), tr = yAt(c.top.edge, xr);
    const area = (xr - xl) * (tl - bl + tr - br) / 2;
    if (area <= 1e-13) continue;
    planArea += area;
    const add = (x: number, y: number, r?: number) => at({ x, y }, c.inner, c.outer, r);
    const polygon = [add(xl, bl, c.bottom.radius)];
    for(const x of cuts.get(c.bottom.edge)!)if(x>xl+EPS && x<xr-EPS)polygon.push(add(x,yAt(c.bottom.edge,x),c.bottom.radius));
    polygon.push(add(xr,br,c.bottom.radius));
    for (const y of atX.get(xr)!) if (y > br + EPS && y < tr - EPS) polygon.push(add(xr, y));
    polygon.push(add(xr, tr, c.top.radius));
    const upper=cuts.get(c.top.edge)!;
    for(let j=upper.length-1;j>=0;j--){const x=upper[j];if(x>xl+EPS && x<xr-EPS)polygon.push(add(x,yAt(c.top.edge,x),c.top.radius));}
    polygon.push(add(xl,tl,c.top.radius));
    const column=atX.get(xl)!;
    for (let j = column.length - 1; j >= 0; j--) {
      const y = column[j];
      if (y > bl + EPS && y < tl - EPS) polygon.push(add(xl, y));
    }
    const mid = add((xl + xr) / 2, (bl + br + tl + tr) / 4);
    for (let j = 0; j < polygon.length; j++) {
      const a = polygon[j], b = polygon[(j + 1) % polygon.length];
      if (cross(points[a], points[b], points[mid]) > 2e-13) {
        const tri: PlanningTriangle = [a, b, mid];
        faces.push(tri);
        bands.set(tri, [c.inner, c.outer]);
      }
    }
  }
  if (breaks.length) splitAtGrades(points, coordinates, faces, breaks, maxSamples, bands, radiusAt);
  return {
    points, faces, ring: points.slice(), planArea, frame: {
      centerline: line, coordinates, faces,
      bands, radiusAt, bendJoin: "round-union" as const, overlapStations
    }
  };
}

// Cut the linear station field at every entered change of grade. Split shared
// edges once, so interpolation at the datum and at the grade line uses one mesh.
function splitAtGrades(points: PlanXY[], cs: Coordinate[], faces: PlanningTriangle[], breaks: readonly number[], cap: number,
  bands: WeakMap<PlanningTriangle, Band>, radiusAt: (p: PlanXY, band: Band, a: Coordinate, b: Coordinate) => number) {
  let band: Band;
  const original = faces.splice(0), cache = new Map<string, number>();
  function intersection(i: number, j: number, s: number) {
    if (Math.abs(cs[i].station - s) < 1e-9) return i;
    if (Math.abs(cs[j].station - s) < 1e-9) return j;
    const k = Math.min(i, j) + "/" + Math.max(i, j) + "/" + s, cached = cache.get(k);
    if (cached !== undefined) return cached;
    const t = (s - cs[i].station) / (cs[j].station - cs[i].station), id = points.length;
    if (id >= cap) throw new RoadMeshCapacity(cap);
    const lerp = (a: number, b: number) => a + t * (b - a);
    points.push({ x: lerp(points[i].x, points[j].x), y: lerp(points[i].y, points[j].y) });
    cs.push({ station: s, offset: lerp(cs[i].offset, cs[j].offset), absoluteOffset: radiusAt(points[id], band, cs[i], cs[j]) });
    cache.set(k, id);
    return id;
  }
  function clip(poly: number[], s: number, below: boolean) {
    const out: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i + poly.length - 1) % poly.length], b = poly[i], ia = below ? cs[a].station <= s : cs[a].station >= s, ib = below ? cs[b].station <= s : cs[b].station >= s;
      if (ia !== ib) out.push(intersection(a, b, s));
      if (ib) out.push(b);
    }
    return out;
  }
  function emit(poly: number[]) {
    for (let i = 1; i + 1 < poly.length; i++)if (cross(points[poly[0]], points[poly[i]], points[poly[i + 1]]) > 2e-13) {
      const t: PlanningTriangle = [poly[0], poly[i], poly[i + 1]];
      faces.push(t);
      bands.set(t, band);
    }
  }
  for (const tri of original) {
    band = bands.get(tri)!;
    let poly: number[] = tri;
    const min = Math.min(...tri.map(i => cs[i].station)), max = Math.max(...tri.map(i => cs[i].station));
    for (const s of breaks) {
      if (s <= min + 1e-9) continue;
      if (s >= max - 1e-9) break;
      emit(clip(poly, s, true));
      poly = clip(poly, s, false);
    }
    emit(poly);
  }
}

/** Use the same geometric decomposition for both CAD chainage directions. */
export function roundedRoadStrip(line: PlanXY[], width: number, offsets: readonly number[], breaks: readonly number[],
  factors: readonly number[] | undefined, maxSamples: number, spacing: number) {
  const a = line[0], b = line[line.length - 1];
  if (a.x < b.x || (a.x === b.x && a.y <= b.y)) return makeRoundedStrip(line, width, offsets, breaks, factors, maxSamples, spacing);
  const length = line.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - line[i].x, p.y - line[i].y) * (factors?.[i] ?? 1), 0);
  const result = makeRoundedStrip([...line].reverse(), width, offsets, [...breaks].reverse().map(s => length - s), factors?.slice().reverse(), maxSamples, spacing);
  result.frame.centerline = line;
  for (const c of result.frame.coordinates) {
    c.station = length - c.station;
    c.offset = -c.offset;
  }
  result.frame.overlapStations = result.frame.overlapStations.map(([lo, hi]) => [length - hi, length - lo]);
  return result;
}
