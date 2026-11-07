import polygonClipping from 'polygon-clipping';
import { ShapeUtils, Vector2 } from 'three';
import { cleanPlanningBoundary, type PlanXY, type PlanningTriangle } from './temporaryWorksGeometry';

/** Coordinates must share one local, metre-based project frame. No photography heights are read here. */
export type HardeningFootprint = { outer: readonly PlanXY[]; holes?: readonly (readonly PlanXY[])[] };
export type HardeningPlane = {
  reference: PlanXY; height: number; gradeEastPct?: number; gradeNorthPct?: number;
};
export type HardeningSurfaceVertex = PlanXY & { surfaceHeight: number; formationHeight?: number };
export type HardeningBlocker = {
  id: string; name?: string; kind?: 'road' | 'facility' | 'hardening';
  footprints: readonly HardeningFootprint[];
  plane?: HardeningPlane;
  surface?: { vertices: readonly HardeningSurfaceVertex[]; triangles: readonly PlanningTriangle[] };
  /** Occupancy only: exclude its plan footprint without claiming a known floor or connection level. */
  footprintOnly?: boolean;
  /** A known structural thickness allows shared vertical wall intervals to be removed exactly. */
  thickness?: number;
  visible?: boolean; ready?: boolean;
};
export type HardeningParameters = {
  footprints: readonly HardeningFootprint[]; plane: HardeningPlane; thickness: number;
  /** Callers supply only higher-priority occupants, sorted by persisted priority, not load order. */
  blockers?: readonly HardeningBlocker[];
  acceptedHeightDifferences?: readonly string[];
};
export type HardeningVertex = PlanXY & {
  surfaceHeight: number; baseHeight: number; formationHeight: number;
};
export type HardeningSideEdge = { a: PlanXY & { surfaceHeight: number; baseHeight: number };
  b: PlanXY & { surfaceHeight: number; baseHeight: number } };
export type HardeningConflict = {
  id: string; name?: string; kind: 'height' | 'unknown-height'; maxDifference: number | null; accepted: boolean;
};
export type HardeningResult = {
  vertices: HardeningVertex[]; triangles: PlanningTriangle[]; footprints: HardeningFootprint[];
  sideEdges: HardeningSideEdge[]; sourceArea: number; visibleArea: number; excludedArea: number;
  conflicts: HardeningConflict[]; canSave: boolean; sampleCount: 0; algorithmVersion: 1;
};

/** Numerical tolerance, not a design allowance for steps or open joints. */
export const HARDENING_HEIGHT_TOLERANCE = 0.001;
export const HARDENING_LIMITS = Object.freeze({
  sourcePoints: 4096, inputBoundaryPoints: 20000, blockers: 512, surfaceTriangles: 100000,
  outputPoints: 50000, outputTriangles: 100000, outputFootprints: 2048,
  heightIntersections: 12000, extent: 20000,
});
const EPS = 1e-7;
type Pair = [number, number];
type Polygon = Pair[][];
type MultiPolygon = Polygon[];
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Edge = { a: PlanXY; b: PlanXY; bounds: Bounds };
type SurfaceTriangle = { points: [HardeningSurfaceVertex, HardeningSurfaceVertex, HardeningSurfaceVertex]; bounds: Bounds };
type SpatialNode<T extends {bounds:Bounds}> = {bounds:Bounds;items?:T[];left?:SpatialNode<T>;right?:SpatialNode<T>};
type PreparedBlocker = { blocker: HardeningBlocker; geometry: MultiPolygon; bounds: Bounds;
  edges: Edge[]; edgeIndex?:SpatialNode<Edge>; triangles: SurfaceTriangle[]; triangleIndex?:SpatialNode<SurfaceTriangle> };

const cross = (a: PlanXY, b: PlanXY, c: PlanXY) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const mix = (a: PlanXY, b: PlanXY, t: number): PlanXY => ({ x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t });
const distance = (a: PlanXY, b: PlanXY) => Math.hypot(a.x-b.x,a.y-b.y);
const onSegment = (p: PlanXY, a: PlanXY, b: PlanXY) =>
  Math.abs(cross(a,b,p)) <= EPS*Math.max(1,distance(a,b)) &&
  p.x>=Math.min(a.x,b.x)-EPS && p.x<=Math.max(a.x,b.x)+EPS &&
  p.y>=Math.min(a.y,b.y)-EPS && p.y<=Math.max(a.y,b.y)+EPS;
function bounds(points: readonly PlanXY[]): Bounds {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of points) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); }
  return {minX,minY,maxX,maxY};
}
const intersects = (a: Bounds,b: Bounds) => a.minX<=b.maxX+EPS && b.minX<=a.maxX+EPS && a.minY<=b.maxY+EPS && b.minY<=a.maxY+EPS;
/** Immutable local AABB tree: far-away route triangles never enter point/contact queries. */
function spatialIndex<T extends {bounds:Bounds}>(items:readonly T[]):SpatialNode<T>|undefined {
  if (!items.length) return;
  const box=items.reduce((b,item)=>({minX:Math.min(b.minX,item.bounds.minX),minY:Math.min(b.minY,item.bounds.minY),
    maxX:Math.max(b.maxX,item.bounds.maxX),maxY:Math.max(b.maxY,item.bounds.maxY)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
  if (items.length<=12) return {bounds:box,items:[...items]};
  const x=box.maxX-box.minX>=box.maxY-box.minY;
  const sorted=[...items].sort((a,b)=>x?(a.bounds.minX+a.bounds.maxX)-(b.bounds.minX+b.bounds.maxX)
    :(a.bounds.minY+a.bounds.maxY)-(b.bounds.minY+b.bounds.maxY));
  const middle=sorted.length>>>1;
  return {bounds:box,left:spatialIndex(sorted.slice(0,middle)),right:spatialIndex(sorted.slice(middle))};
}
function* spatialQuery<T extends {bounds:Bounds}>(node:SpatialNode<T>|undefined,box:Bounds):Generator<T> {
  if (!node || !intersects(node.bounds,box)) return;
  if (node.items) {for(const item of node.items) if(intersects(item.bounds,box)) yield item;}
  else {yield* spatialQuery(node.left,box);yield* spatialQuery(node.right,box);}
}
const ringEdges = (ring: readonly PlanXY[]): Edge[] => ring.map((a,i)=>({a,b:ring[(i+1)%ring.length],bounds:bounds([a,ring[(i+1)%ring.length]])}));
const footprintEdges = (footprints: readonly HardeningFootprint[]) => footprints.flatMap(f=>[f.outer,...f.holes??[]].flatMap(ringEdges));
function signedArea(points: readonly PlanXY[]) {
  if (!points.length) return 0;
  return points.reduce((sum,p,i)=>sum+cross(points[0],p,points[(i+1)%points.length]),0)/2;
}
function ringContains(ring: readonly PlanXY[], p: PlanXY, boundary = true) {
  let inside=false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[j],b=ring[i];
    if (onSegment(p,a,b)) return boundary;
    if ((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
  }
  return inside;
}
function segmentsTouch(a: PlanXY,b: PlanXY,c: PlanXY,d: PlanXY) {
  if (!intersects(bounds([a,b]),bounds([c,d]))) return false;
  const u=cross(a,b,c),v=cross(a,b,d),w=cross(c,d,a),z=cross(c,d,b);
  return u*v<0 && w*z<0 || onSegment(a,c,d) || onSegment(b,c,d) || onSegment(c,a,b) || onSegment(d,a,b);
}
function ringsTouch(a: readonly PlanXY[],b: readonly PlanXY[]) {
  if (!intersects(bounds(a),bounds(b))) return false;
  return ringEdges(a).some(e=>ringEdges(b).some(f=>segmentsTouch(e.a,e.b,f.a,f.b)));
}
function validPlane(plane: HardeningPlane) {
  if (![plane?.reference?.x,plane?.reference?.y,plane?.height,plane?.gradeEastPct??0,plane?.gradeNorthPct??0].every(Number.isFinite))
    throw new Error('请填写有效的场地参考点、顶标高和坡度。');
}
export function hardeningHeightAt(plane: HardeningPlane,p: PlanXY) {
  return plane.height+(p.x-plane.reference.x)*(plane.gradeEastPct??0)/100+(p.y-plane.reference.y)*(plane.gradeNorthPct??0)/100;
}
function normaliseFootprints(input: readonly HardeningFootprint[], label: string): HardeningFootprint[] {
  const result=input.map((f,i)=>{
    const outer=cleanPlanningBoundary(f.outer);
    if (Math.abs(signedArea(outer))<1e-6) throw new Error(`${label}第 ${i+1} 个轮廓面积为零或过小。`);
    const holes=(f.holes??[]).map(h=>cleanPlanningBoundary(h));
    for (let j=0;j<holes.length;j++) {
      const hole=holes[j];
      if (Math.abs(signedArea(hole))<1e-6 || !ringContains(outer,hole[0],false) || ringsTouch(outer,hole))
        throw new Error(`${label}保留区须严格位于外轮廓内，不能越界或接触外边界。`);
      for (let k=0;k<j;k++) if (ringsTouch(hole,holes[k]) || ringContains(hole,holes[k][0]) || ringContains(holes[k],hole[0]))
        throw new Error(`${label}保留区不能交叉、相切或相互包含。`);
    }
    return {outer,holes};
  });
  const b=bounds(result.flatMap(f=>[...f.outer,...(f.holes??[]).flat()]));
  if (b.maxX-b.minX>HARDENING_LIMITS.extent || b.maxY-b.minY>HARDENING_LIMITS.extent)
    throw new Error('场地范围超过局部建模支持范围，请分区建模。');
  return result;
}
const asGeometry = (footprints: readonly HardeningFootprint[]): MultiPolygon => footprints.map(f=>
  [f.outer,...f.holes??[]].map(r=>r.map(p=>[p.x,p.y] as Pair)));
function asFootprints(geometry: MultiPolygon): HardeningFootprint[] {
  return geometry.map(p=>{
    const rings=p.map(r=>{
      const ring=r.map(([x,y])=>({x,y}));
      if (ring.length>1 && distance(ring[0],ring.at(-1)!)<=EPS) ring.pop();
      return ring;
    });
    return {outer:rings[0],holes:rings.slice(1)};
  });
}
function geometryArea(geometry: MultiPolygon) {
  return asFootprints(geometry).reduce((sum,f)=>sum+Math.abs(signedArea(f.outer))-(f.holes??[]).reduce((s,h)=>s+Math.abs(signedArea(h)),0),0);
}
function geometryPoints(geometry: MultiPolygon) { return geometry.flat(2).map(([x,y])=>({x,y})); }
function enforceOutputBudget(geometry: MultiPolygon) {
  if (geometry.length>HARDENING_LIMITS.outputFootprints || geometry.reduce((sum,p)=>sum+p.reduce((s,r)=>s+r.length,0),0)>HARDENING_LIMITS.outputPoints)
    throw new Error('硬化重叠计算产生过多轮廓或碎片，请减少交叠或分区建模。');
}
function boundaryPointCount(footprints: readonly HardeningFootprint[]) {
  return footprints.reduce((sum,f)=>sum+f.outer.length+(f.holes??[]).reduce((n,h)=>n+h.length,0),0);
}
function prepareBlocker(blocker: HardeningBlocker): PreparedBlocker {
  if (!blocker.id || blocker.thickness!==undefined && (!Number.isFinite(blocker.thickness)||blocker.thickness<=0))
    throw new Error('相邻设施的标识或结构厚度无效。');
  if (blocker.plane) validPlane(blocker.plane);
  const footprints=normaliseFootprints(blocker.footprints,'相邻设施');
  const geometry=asGeometry(footprints), all=footprints.flatMap(f=>[...f.outer,...(f.holes??[]).flat()]);
  const triangles: PreparedBlocker['triangles']=[];
  if (blocker.surface) for (const t of blocker.surface.triangles) {
    if (t.length!==3 || t.some(i=>!Number.isSafeInteger(i)||i<0||i>=blocker.surface!.vertices.length))
      throw new Error('相邻设施的网格索引无效。');
    const points=t.map(i=>blocker.surface!.vertices[i]) as PreparedBlocker['triangles'][number]['points'];
    if (points.some(p=>![p.x,p.y,p.surfaceHeight].every(Number.isFinite)||p.formationHeight!==undefined&&!Number.isFinite(p.formationHeight)))
      throw new Error('相邻设施的设计面高程无效。');
    if (Math.abs(cross(...points))<1e-12) continue;
    triangles.push({points,bounds:bounds(points)});
  }
  const edges=footprintEdges(footprints);
  return {blocker,geometry,bounds:bounds(all),edges,edgeIndex:spatialIndex(edges),triangles,triangleIndex:spatialIndex(triangles)};
}
function triangleValue(t: PreparedBlocker['triangles'][number]['points'],p: PlanXY,key: 'surfaceHeight'|'formationHeight') {
  if (t.some(v=>v[key]===undefined)) return undefined;
  const area=cross(t[0],t[1],t[2]),u=cross(p,t[1],t[2])/area,v=cross(t[0],p,t[2])/area,w=1-u-v;
  if (Math.min(u,v,w)<-1e-6) return undefined;
  return t[0][key]!*u+t[1][key]!*v+t[2][key]!*w;
}
function blockerLevels(blocker: PreparedBlocker,p: PlanXY): {top:number;bottom?:number}|undefined {
  if (blocker.blocker.footprintOnly) return;
  if (blocker.blocker.plane) {
    const top=hardeningHeightAt(blocker.blocker.plane,p);
    return {top,bottom:blocker.blocker.thickness===undefined?undefined:top-blocker.blocker.thickness};
  }
  for (const t of spatialQuery(blocker.triangleIndex,bounds([p]))) {
    const top=triangleValue(t.points,p,'surfaceHeight');
    if (top===undefined) continue;
    return {top,bottom:triangleValue(t.points,p,'formationHeight')??(blocker.blocker.thickness===undefined?undefined:top-blocker.blocker.thickness)};
  }
}
function edgeContacts(a: Edge,b: Edge): PlanXY[] {
  if (!segmentsTouch(a.a,a.b,b.a,b.b)) return [];
  const result=[a.a,a.b,b.a,b.b].filter(p=>onSegment(p,a.a,a.b)&&onSegment(p,b.a,b.b));
  if (result.length) return result;
  const den=(a.b.x-a.a.x)*(b.b.y-b.a.y)-(a.b.y-a.a.y)*(b.b.x-b.a.x);
  if (Math.abs(den)<1e-15) return [];
  const t=((b.a.x-a.a.x)*(b.b.y-b.a.y)-(b.a.y-a.a.y)*(b.b.x-b.a.x))/den;
  return [mix(a.a,a.b,t)];
}
function findHeightConflict(source: MultiPolygon,sourceEdges: Edge[],plane: HardeningPlane,entry: PreparedBlocker,
  accepted: ReadonlySet<string>,count: {value:number},signal?: AbortSignal): HardeningConflict|undefined {
  signal?.throwIfAborted();
  // A building outline is authoritative occupancy, but its model anchor is not a surveyed floor.
  // Automatic exclusion needs no invented floor data or height-difference acknowledgement.
  if (entry.blocker.footprintOnly) return;
  const overlap=polygonClipping.intersection(source,entry.geometry);
  const points=geometryPoints(overlap);
  // Include boundary-only contacts: touching a sloping road can have a real step despite zero overlap area.
  for (const edge of sourceEdges) {
    const box=edge.bounds;
    if (!intersects(box,entry.bounds)) continue;
    for (const other of spatialQuery(entry.edgeIndex,box)) points.push(...edgeContacts(edge,other));
  }
  if (!points.length) return;
  let maximum=0,unknown=false;
  const check=(p: PlanXY,top?: number)=>{
    if (top===undefined) {unknown=true;return;}
    maximum=Math.max(maximum,Math.abs(hardeningHeightAt(plane,p)-top));
  };
  if (entry.blocker.plane) for (const p of points) check(p,hardeningHeightAt(entry.blocker.plane,p));
  else if (entry.triangles.length) {
    for (const p of points) check(p,blockerLevels(entry,p)?.top);
    // A piecewise road may rise and fall inside an overlap. Checking its centre or outer ring alone misses that peak.
    const overlapBox=bounds(points);
    const covered: MultiPolygon[]=[];
    for (const triangle of spatialQuery(entry.triangleIndex,overlapBox)) {
      if (++count.value>HARDENING_LIMITS.heightIntersections) throw new Error('硬化接界高程核对过于复杂，请缩小范围或分区建模。');
      signal?.throwIfAborted();
      if (overlap.length) {
        const original:MultiPolygon=[[triangle.points.map(p=>[p.x,p.y] as Pair)]];
        const part=polygonClipping.intersection(overlap,original);
        if (part.length) {
          // Preserve shared mesh endpoints for the coverage boolean. Independently
          // clipping neighbours first creates slightly different intersections on
          // the same edge, which can disconnect polygon-clipping's output rings.
          covered.push(original);
          for (const p of geometryPoints(part)) check(p,triangleValue(triangle.points,p,'surfaceHeight'));
        }
      }
      // Grade break vertices on a shared edge matter even when the intersection has no area.
      for (const edge of sourceEdges) if (intersects(edge.bounds,triangle.bounds)) {
        for (const other of ringEdges(triangle.points)) if (intersects(edge.bounds,other.bounds)) {
          for (const p of edgeContacts(edge,other)) check(p,triangleValue(triangle.points,p,'surfaceHeight'));
        }
      }
    }
    // Missing design mesh coverage is not permission to assume a matching level.
    if (overlap.length && (!covered.length || geometryArea(polygonClipping.difference(overlap,...covered))>1e-6)) unknown=true;
  } else unknown=true;
  if (unknown) return {id:entry.blocker.id,name:entry.blocker.name,kind:'unknown-height',maxDifference:null,accepted:false};
  if (maximum>HARDENING_HEIGHT_TOLERANCE) return {id:entry.blocker.id,name:entry.blocker.name,kind:'height',maxDifference:maximum,accepted:accepted.has(entry.blocker.id)};
}

type WallBand = { a: PlanXY; b: PlanXY; lowA: number; lowB: number; highA: number; highB: number };
const lerp = (a:number,b:number,t:number)=>a+(b-a)*t;
function subtractWallBand(band: WallBand,entry: PreparedBlocker,other: Edge): WallBand[] {
  const len=distance(band.a,band.b);
  if (len<=EPS || Math.abs(cross(band.a,band.b,other.a))>EPS*len || Math.abs(cross(band.a,band.b,other.b))>EPS*len) return [band];
  const dx=band.b.x-band.a.x,dy=band.b.y-band.a.y,den=dx*dx+dy*dy;
  const position=(p:PlanXY)=>((p.x-band.a.x)*dx+(p.y-band.a.y)*dy)/den;
  const u=position(other.a),v=position(other.b),lo=Math.max(0,Math.min(u,v)),hi=Math.min(1,Math.max(u,v));
  if (hi-lo<EPS) return [band];
  const levelA=blockerLevels(entry,mix(band.a,band.b,lo)),levelB=blockerLevels(entry,mix(band.a,band.b,hi));
  // A GLB's floor thickness cannot be inferred from its whole model height.
  if (levelA?.bottom===undefined || levelB?.bottom===undefined) return [band];
  const otherTop=(t:number)=>lerp(levelA.top,levelB.top,(t-lo)/(hi-lo));
  const otherBottom=(t:number)=>lerp(levelA.bottom!,levelB.bottom!,(t-lo)/(hi-lo));
  const low=(t:number)=>lerp(band.lowA,band.lowB,t),high=(t:number)=>lerp(band.highA,band.highB,t);
  const splits=[0,lo,hi,1];
  for (const ours of [low,high]) for (const theirs of [otherBottom,otherTop]) {
    const a=ours(lo)-theirs(lo),b=ours(hi)-theirs(hi);
    if (a*b<0) splits.push(lo+(hi-lo)*a/(a-b));
  }
  const ordered=[...new Set(splits)].sort((a,b)=>a-b),out: WallBand[]=[];
  const add=(a:number,b:number,lower:(t:number)=>number,upper:(t:number)=>number)=>{
    if (b-a<EPS || upper((a+b)/2)-lower((a+b)/2)<=EPS) return;
    out.push({a:mix(band.a,band.b,a),b:mix(band.a,band.b,b),lowA:lower(a),lowB:lower(b),highA:upper(a),highB:upper(b)});
  };
  for (let i=0;i<ordered.length-1;i++) {
    const a=ordered[i],b=ordered[i+1],mid=(a+b)/2;
    if (mid<lo || mid>hi || otherTop(mid)<=low(mid)+EPS || otherBottom(mid)>=high(mid)-EPS) add(a,b,low,high);
    else {
      if (otherBottom(mid)>low(mid)+EPS) add(a,b,low,otherBottom);
      if (otherTop(mid)<high(mid)-EPS) add(a,b,otherTop,high);
    }
  }
  return out;
}
function makeSideEdges(footprints: HardeningFootprint[],plane: HardeningPlane,thickness: number,blockers: PreparedBlocker[]): HardeningSideEdge[] {
  const result: HardeningSideEdge[]=[];
  const splitEdges=new Map<Edge,Edge[]>();
  const atSurfaceBreaks=(entry:PreparedBlocker,edge:Edge)=>{
    if (entry.blocker.plane || !entry.triangles.length) return [edge];
    const cached=splitEdges.get(edge);if(cached)return cached;
    const dx=edge.b.x-edge.a.x,dy=edge.b.y-edge.a.y,den=dx*dx+dy*dy;
    const parts=[0,1];
    for (const triangle of spatialQuery(entry.triangleIndex,edge.bounds)) {
      for (const other of ringEdges(triangle.points)) if (intersects(edge.bounds,other.bounds))
        for (const p of edgeContacts(edge,other)) parts.push(Math.max(0,Math.min(1,((p.x-edge.a.x)*dx+(p.y-edge.a.y)*dy)/den)));
    }
    parts.sort((a,b)=>a-b);
    const distinct=parts.filter((t,i)=>!i||t-parts[i-1]>EPS);
    const pieces=distinct.slice(1).map((t,i)=>{
      const a=mix(edge.a,edge.b,distinct[i]),b=mix(edge.a,edge.b,t);
      return {a,b,bounds:bounds([a,b])};
    });
    splitEdges.set(edge,pieces);return pieces;
  };
  for (const {a,b} of footprintEdges(footprints)) {
    const highA=hardeningHeightAt(plane,a),highB=hardeningHeightAt(plane,b);
    let bands: WallBand[]=[{a,b,highA,highB,lowA:highA-thickness,lowB:highB-thickness}];
    const box=bounds([a,b]);
    for (const blocker of blockers) {
      if (!intersects(box,blocker.bounds)) continue;
      for (const edge of spatialQuery(blocker.edgeIndex,box)) {
        const len=distance(a,b);
        if (Math.abs(cross(a,b,edge.a))>EPS*len || Math.abs(cross(a,b,edge.b))>EPS*len) continue;
        for (const piece of atSurfaceBreaks(blocker,edge)) bands=bands.flatMap(band=>subtractWallBand(band,blocker,piece));
      }
    }
    for (const band of bands) result.push({a:{...band.a,surfaceHeight:band.highA,baseHeight:band.lowA},b:{...band.b,surfaceHeight:band.highB,baseHeight:band.lowB}});
    if (result.length>HARDENING_LIMITS.outputPoints) throw new Error('硬化侧壁分区过多，请简化交叠关系或分区建模。');
  }
  return result;
}

/** Exact planar difference + boundary triangulation; never samples, refines to, or edits photography. */
export function calculateHardening(parameters: HardeningParameters,signal?: AbortSignal): HardeningResult {
  signal?.throwIfAborted();
  validPlane(parameters.plane);
  if (!Number.isFinite(parameters.thickness)||parameters.thickness<=0) throw new Error('场地硬化厚度须大于零。');
  if (!parameters.footprints.length) throw new Error('请先框选场地硬化范围。');
  const active=(parameters.blockers??[]).filter(b=>b.visible!==false&&b.ready!==false);
  if (boundaryPointCount(parameters.footprints)>HARDENING_LIMITS.sourcePoints || active.length>HARDENING_LIMITS.blockers ||
      boundaryPointCount(parameters.footprints)+active.reduce((n,b)=>n+boundaryPointCount(b.footprints),0)>HARDENING_LIMITS.inputBoundaryPoints ||
      active.reduce((n,b)=>n+(b.surface?.triangles.length??0),0)>HARDENING_LIMITS.surfaceTriangles)
    throw new Error('场地硬化边界或相邻设施过于复杂，请减少交叠或分区建模。');
  if (new Set(active.map(b=>b.id)).size!==active.length) throw new Error('相邻设施标识重复，无法确定硬化避让归属。');
  const source=normaliseFootprints(parameters.footprints,'硬化场地'),sourceGeometry=polygonClipping.union(asGeometry(source));
  const sourceBounds=bounds(geometryPoints(sourceGeometry)),sourceEdges=footprintEdges(asFootprints(sourceGeometry));
  const prepared=active.map(prepareBlocker).filter(b=>intersects(sourceBounds,b.bounds));
  const accepted=new Set(parameters.acceptedHeightDifferences??[]),conflicts: HardeningConflict[]=[],count={value:0};
  for (const blocker of prepared) {
    const conflict=findHeightConflict(sourceGeometry,sourceEdges,parameters.plane,blocker,accepted,count,signal);
    if (conflict) conflicts.push(conflict);
  }
  signal?.throwIfAborted();
  const display=prepared.length?polygonClipping.difference(sourceGeometry,...prepared.map(b=>b.geometry)):sourceGeometry;
  enforceOutputBudget(display);
  const footprints=asFootprints(display),vertices: HardeningVertex[]=[],triangles: PlanningTriangle[]=[];
  for (const footprint of footprints) {
    signal?.throwIfAborted();
    const rings=[footprint.outer,...footprint.holes??[]].map(r=>r.map(p=>new Vector2(p.x,p.y)));
    const points=rings.flat(),base=vertices.length;
    for (const p of points) {
      const surfaceHeight=hardeningHeightAt(parameters.plane,p),baseHeight=surfaceHeight-parameters.thickness;
      if (![surfaceHeight,baseHeight].every(Number.isFinite)) throw new Error('硬化设计标高超出有效范围。');
      vertices.push({x:p.x,y:p.y,surfaceHeight,baseHeight,formationHeight:baseHeight});
    }
    for (const face of ShapeUtils.triangulateShape(rings[0],rings.slice(1))) {
      const t=face as PlanningTriangle;
      if (Math.abs(cross(points[t[0]],points[t[1]],points[t[2]]))<1e-12) continue;
      if (cross(points[t[0]],points[t[1]],points[t[2]])<0) [t[1],t[2]]=[t[2],t[1]];
      triangles.push(t.map(i=>i+base) as PlanningTriangle);
    }
  }
  if (vertices.length>HARDENING_LIMITS.outputPoints || triangles.length>HARDENING_LIMITS.outputTriangles)
    throw new Error('硬化显示网格超出预算，请分区建模。');
  const sourceArea=geometryArea(sourceGeometry),visibleArea=geometryArea(display);
  const meshArea=triangles.reduce((s,[a,b,c])=>s+Math.abs(cross(vertices[a],vertices[b],vertices[c]))/2,0);
  if (Math.abs(meshArea-visibleArea)>Math.max(1e-6,visibleArea*1e-8)) throw new Error('硬化网格面积与有效轮廓不一致，未应用本次结果。');
  const sideEdges=makeSideEdges(footprints,parameters.plane,parameters.thickness,prepared);
  signal?.throwIfAborted();
  return {vertices,triangles,footprints,sideEdges,sourceArea,visibleArea,excludedArea:Math.max(0,sourceArea-visibleArea),
    conflicts,canSave:conflicts.every(c=>c.accepted),sampleCount:0,algorithmVersion:1};
}

export type PackedHardeningResult = {
  type:'result'; result:Omit<HardeningResult,'vertices'|'triangles'>; vertices:Float64Array; triangles:Uint32Array;
};
export function packHardening(result: HardeningResult): PackedHardeningResult {
  const vertices=new Float64Array(result.vertices.length*5),triangles=new Uint32Array(result.triangles.length*3);
  result.vertices.forEach((p,i)=>vertices.set([p.x,p.y,p.surfaceHeight,p.baseHeight,p.formationHeight],i*5));
  result.triangles.forEach((t,i)=>triangles.set(t,i*3));
  const {vertices:_vertices,triangles:_triangles,...rest}=result;
  return {type:'result',result:rest,vertices,triangles};
}
async function unpackHardening(packed: PackedHardeningResult,signal?: AbortSignal): Promise<HardeningResult> {
  const vertices:HardeningVertex[]=[],triangles:PlanningTriangle[]=[];
  for (let i=0;i<packed.vertices.length;i+=5) {
    if (i && i%10240===0) {await new Promise<void>(r=>setTimeout(r,0));signal?.throwIfAborted();}
    const [x,y,surfaceHeight,baseHeight,formationHeight]=packed.vertices.subarray(i,i+5);
    vertices.push({x,y,surfaceHeight,baseHeight,formationHeight});
  }
  for (let i=0;i<packed.triangles.length;i+=3) triangles.push([packed.triangles[i],packed.triangles[i+1],packed.triangles[i+2]]);
  signal?.throwIfAborted();
  return {...packed.result,vertices,triangles};
}

/** One cancellable worker per explicit generation. There is no persistent render/update loop. */
export async function solveHardening(parameters: HardeningParameters,{signal}:{signal?:AbortSignal}={}): Promise<HardeningResult> {
  signal?.throwIfAborted();
  const fallback=async()=>{
    // Browser fallback is deliberately small: a missing worker must not freeze an existing scene.
    if (typeof document!=='undefined' && (boundaryPointCount(parameters.footprints)>256 ||
        (parameters.blockers??[]).reduce((n,b)=>n+boundaryPointCount(b.footprints)+(b.surface?.triangles.length??0),0)>512))
      throw new Error('后台几何线程不可用，较复杂场地暂不能生成；现有场景保持不变。');
    await new Promise<void>(r=>setTimeout(r,0));signal?.throwIfAborted();
    return calculateHardening(parameters,signal);
  };
  if (typeof Worker==='undefined') return fallback();
  let worker:Worker;
  try {worker=new Worker(new URL('./temporaryWorksHardening.worker.ts',import.meta.url),{type:'module',name:'temporary-works-hardening'});}
  catch (error) {
    if (error instanceof DOMException && ['NotSupportedError','SecurityError'].includes(error.name)) return fallback();
    throw error;
  }
  let abort:(()=>void)|undefined;
  try {
    const packed=await new Promise<PackedHardeningResult>((resolve,reject)=>{
      abort=()=>reject(signal?.reason??new DOMException('已取消场地硬化生成','AbortError'));
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) {abort();return;}
      worker.onerror=e=>reject(new Error(e.message||'场地硬化后台计算失败。'));
      worker.onmessageerror=()=>reject(new Error('场地硬化结果传输失败。'));
      worker.onmessage=({data}:MessageEvent<PackedHardeningResult|{type:'error';message:string}>)=>{
        if (data.type==='error') reject(new Error(data.message));else resolve(data);
      };
      worker.postMessage(parameters);
    });
    return await unpackHardening(packed,signal);
  } finally {if (abort) signal?.removeEventListener('abort',abort);worker.terminate();}
}
