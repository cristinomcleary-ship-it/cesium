import type { PlanXY, PlanningMesh, PlanningTriangle } from "./temporaryWorksGeometry";

// The work target can trigger another geometric cut. Other errors, especially
// CAD intersections and level conflicts, must never be swallowed by a retry.
export class RoadMeshCapacity extends Error {
  constructor(readonly limit:number) { super(`便道网格需要超过 ${limit} 个采样点`); }
}

export type RoadCut={edge:number;t:number;station:number;point:PlanXY};

/** A candidate transverse cut must separate the complete design on its two
 * sides, including round joins and any valid miter extension. This rejects cuts
 * between the two arms of a hairpin or through another branch of the road. */
export function partitionRoad(points:readonly PlanXY[], factors:readonly number[], width:number, spacing:number) {
  const stations=[0], half=width/2;
  const directions=points.slice(1).map((p,i)=>{
    const dx=p.x-points[i].x,dy=p.y-points[i].y,len=Math.hypot(dx,dy);
    stations.push(stations[i]+len*factors[i]);
    return {x:dx/len,y:dy/len,len};
  });
  const joins=points.map((_,i)=>{
    const a=directions[Math.max(0,i-1)],b=directions[Math.min(i,directions.length-1)];
    const d=1+a.x*b.x+a.y*b.y;
    return {a,b,m:d>=0.125 ? {x:(a.y+b.y)/d,y:-(a.x+b.x)/d}:undefined};
  });
  function safe(p:PlanXY,i:number) {
    const u=directions[i];
    return points.every((q,j)=>{
      const at=(q.x-p.x)*u.x+(q.y-p.y)*u.y;
      if(j<=i?at>1e-8:at< -1e-8)return false;
      if(Math.abs(at)>4*half+1e-8)return true;
      const {a,b,m}=joins[j];
      let extent=Math.max(Math.abs(a.y*u.x-a.x*u.y),Math.abs(b.y*u.x-b.x*u.y),
        m ? Math.abs(u.x*m.x+u.y*m.y) : 1);
      // The normal can reach the cut direction between two tangent directions.
      if((a.x*u.x+a.y*u.y)*(b.x*u.x+b.y*u.y)<=0)extent=Math.max(extent,1);
      return Math.abs(at)+1e-8>=extent*half;
    });
  }
  const budgetLength=Math.min(450,Math.max(3*width,spacing,660*spacing*spacing/Math.max(1,width)));
  let previous=0, previousIndex=0;
  const cuts:RoadCut[]=[{edge:0,t:0,station:0,point:points[0]}];
  for(let i=0;i<directions.length;i++) {
    const s=directions[i],a=points[i],n=Math.ceil(s.len/(budgetLength/3));
    for(let j=0;j<n;j++) {
      const t=(j+.5)/n,station=stations[i]+t*s.len*factors[i];
      if(station-previous<budgetLength && i-previousIndex<72)continue;
      if(stations.at(-1)!-station < Math.min(budgetLength/4,2*width))continue;
      const b=points[i+1],p={x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)};
      if(!safe(p,i))continue;
      cuts.push({edge:i,t,station,point:p});previous=station;previousIndex=i;
    }
  }
  cuts.push({edge:directions.length-1,t:1,station:stations.at(-1)!,point:points.at(-1)!});
  function bisect(begin:RoadCut, end:RoadCut):RoadCut | undefined {
    const span=end.station-begin.station, target=(begin.station+end.station)/2;
    // Prevent degenerate retries on a single broad cross-section. If no fairly
    // balanced cut is geometrically safe, process this connected union intact.
    if (span < Math.max(width, 4*spacing, 1e-5)) return;
    const candidates:RoadCut[]=[];
    for (let i=begin.edge;i<=end.edge;i++) {
      const start=stations[i], d=stations[i+1]-start;
      const lo=Math.max(start,(begin.station+span/8));
      const hi=Math.min(stations[i+1],(end.station-span/8));
      if (lo>=hi) continue;
      // Stay strictly within the CAD segment so the boundary is a butt-ended
      // cross-section, never a miter replaced by a straight end.
      const margin=Math.min((hi-lo)/4, d/10);
      const at=Math.max(lo+margin, Math.min(hi-margin,target));
      const t=(at-start)/d, a=points[i], b=points[i+1];
      candidates.push({edge:i,t,station:at,point:{x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)}});
    }
    candidates.sort((a,b)=>Math.abs(a.station-target)-Math.abs(b.station-target));
    return candidates.find(c=>safe(c.point,c.edge));
  }
  return {cuts,bisect};
}

export function joinRoadSeam(mesh:PlanningMesh,next:PlanningMesh,s:number) {
  const tolerance=1e-7;
  function seam(m:PlanningMesh) {
    const cs=m.roadFrame!.coordinates;
    return cs.map((v,i)=>({at:v.station,offset:v.offset,i})).filter(p=>Math.abs(p.at-s)<tolerance)
      .sort((a,b)=>a.offset-b.offset);
  }
  const a=seam(mesh), b=seam(next);
  function insert(m:PlanningMesh,here:typeof a,neighbour:PlanningMesh,there:typeof a) {
    const cs=m.roadFrame!.coordinates,src=neighbour.roadFrame!.coordinates;
    const ids=new Set(here.map(p=>p.i));
    const added=there.filter(v=>!here.some(p=>Math.abs(p.offset-v.offset)<tolerance));
    if(!added.length)return;
    const additions=added.map(v=>{
      const id=m.points.length;
      m.points.push({...neighbour.points[v.i]});cs.push({...src[v.i]});return {offset:v.offset,id};
    });
    const triangles:PlanningTriangle[]=[];
    for(const face of m.triangles) {
      const i=face.findIndex((id,j)=>ids.has(id)&&ids.has(face[(j+1)%3]));
      if(i<0){triangles.push(face);continue;}
      const start=face[i],end=face[(i+1)%3],tip=face[(i+2)%3],l=cs[start].offset,r=cs[end].offset;
      const middle=additions.filter(p=>p.offset>Math.min(l,r)+tolerance && p.offset<Math.max(l,r)-tolerance);
      if(r<l)middle.reverse();
      let prev=start;
      for(const p of middle){triangles.push([prev,p.id,tip]);prev=p.id;}
      triangles.push([prev,end,tip]);
    }
    m.triangles=triangles;
  }
  insert(mesh,a,next,b);insert(next,b,mesh,a);
}
