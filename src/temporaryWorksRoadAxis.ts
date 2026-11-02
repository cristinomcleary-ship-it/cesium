import type { PlanXY } from "./temporaryWorksGeometry";
import { RoadRouteConflict } from "./temporaryWorksRoadConflict";

export function measureRoadAxis(input: readonly PlanXY[], factors?: readonly number[]) {
  if (factors && factors.length !== input.length - 1) throw new Error("曲线里程系数与所选中心线不匹配");
  const points: PlanXY[] = [], stationFactors: number[] = [];
  let length = 0;
  for (const [i,p] of input.entries()) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("中心线含无效平面坐标");
    if (i === 0) { points.push(p); continue; }
    const factor = factors?.[i-1] ?? 1;
    if (!Number.isFinite(factor) || factor < 1 - 1e-12) throw new Error("中心线弧长系数无效");
    const last = points[points.length-1], chord = Math.hypot(p.x-last.x, p.y-last.y);
    if (chord <= 1e-7) continue;
    points.push(p); stationFactors.push(factor); length += chord * factor;
  }
  if (points.length < 2 || !Number.isFinite(length)) throw new Error("中心线须至少包含两个不同的有效端点");
  return { points, length, stationFactors };
}

// Compare orientation against multiplication roundoff, not an angle threshold.
// A sharp turn with two distinct legs must never be treated as a retrace.
function parallel(ax:number, ay:number, bx:number, by:number): boolean {
  return Math.abs(ax*by-ay*bx) <= 16*Number.EPSILON*(Math.abs(ax*by)+Math.abs(ay*bx));
}

/** Redundant straight CAD vertices do not introduce new transverse cuts at a bend. */
export function compactRoadTangents(points: readonly PlanXY[], factors: readonly number[]) {
  const path = [points[0]], stationFactors: number[] = [];
  for (let i=1;i<points.length;i++) {
    const a=path[path.length-2], b=path[path.length-1], c=points[i];
    if (a && stationFactors[stationFactors.length-1] === factors[i-1]) {
      const dx=b.x-a.x, dy=b.y-a.y, ex=c.x-b.x, ey=c.y-b.y;
      if (dx*ex+dy*ey>0 && parallel(dx,dy,ex,ey)) {
        path[path.length-1]=c;
        continue;
      }
    }
    path.push(c);
    stationFactors.push(factors[i-1]);
  }
  return {points:path, stationFactors};
}

type AxisEdge = {
  index:number; a:PlanXY; dx:number; dy:number; length:number; station:number; measured:number;
  xMin:number; xMax:number; yMin:number; yMax:number;
};
const clamp = (x:number) => Math.max(0,Math.min(1,x));

function checkIntersection(a:AxisEdge,b:AxisEdge,tol:number) {
  const adjacent=Math.abs(a.index-b.index)===1;
  const qx=b.a.x-a.a.x,qy=b.a.y-a.a.y;
  const det=a.dx*b.dy-a.dy*b.dx;
  let t:number, u:number, kind:"crossing"|"retrace"="crossing";
  if (parallel(a.dx,a.dy,b.dx,b.dy)) {
    if (Math.abs(qx*a.dy-qy*a.dx)>tol*a.length) return;
    // Intersect the two directed segments as scalar intervals on edge a.
    const len2=a.length*a.length;
    const start=(qx*a.dx+qy*a.dy)/len2, end=start+(b.dx*a.dx+b.dy*a.dy)/len2;
    const low=Math.max(0,Math.min(start,end)), high=Math.min(1,Math.max(start,end));
    if (low-high>tol/a.length) return;
    if ((high-low)*a.length>tol) kind="retrace";
    else if (adjacent) return;
    t=clamp((low+high)/2);
    u=clamp(((t*a.dx-qx)*b.dx+(t*a.dy-qy)*b.dy)/(b.length*b.length));
  } else {
    if (adjacent) return;
    t=(qx*b.dy-qy*b.dx)/det;
    u=(qx*a.dy-qy*a.dx)/det;
    if (t < -tol/a.length || t>1+tol/a.length || u < -tol/b.length || u>1+tol/b.length) return;
    t=clamp(t); u=clamp(u);
  }
  const p=a.station+t*a.measured, q=b.station+u*b.measured;
  throw new RoadRouteConflict(kind, p < q ? [p,q] : [q,p]);
}

/** A single road has a unique chainage on its own axis. Its *expanded* sides may overlap. */
export function checkRoadAxis(points:readonly PlanXY[], stationFactors:readonly number[]) {
  const edges:AxisEdge[]=[];
  let station=0,extent=1,minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    const measured=length*stationFactors[i-1];
    const e={index:i-1, a, dx, dy, length, station, measured,
      xMin:Math.min(a.x,b.x), xMax:Math.max(a.x,b.x), yMin:Math.min(a.y,b.y), yMax:Math.max(a.y,b.y)};
    edges.push(e); station+=measured;
    minX=Math.min(minX,e.xMin); maxX=Math.max(maxX,e.xMax);
    minY=Math.min(minY,e.yMin); maxY=Math.max(maxY,e.yMax);
    extent=Math.max(extent,Math.abs(a.x),Math.abs(a.y),Math.abs(b.x),Math.abs(b.y));
  }
  const tol=16*Number.EPSILON*extent;
  const sweepX=maxX-minX>=maxY-minY;
  const lo=sweepX?"xMin":"yMin", hi=sweepX?"xMax":"yMax";
  const otherLo=sweepX?"yMin":"xMin",otherHi=sweepX?"yMax":"xMax";
  edges.sort((a,b)=>a[lo]-b[lo]);
  for(let i=0;i<edges.length;i++) {
    const e=edges[i];
    for(let j=i+1;j<edges.length && edges[j][lo]<=e[hi]+tol;j++) {
      const f=edges[j];
      if (f[otherLo]>e[otherHi]+tol || e[otherLo]>f[otherHi]+tol) continue;
      checkIntersection(e,f,tol);
    }
  }
}
