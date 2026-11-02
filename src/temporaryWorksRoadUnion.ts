// Boundaries of a union of convex segment rectangles and convex round join sectors.
// Clip each source edge against its neighbours before sweeping. Interior edges
// and their (often quadratic) intersection events never enter the mesh.
import type { PlanXY } from "./temporaryWorksGeometry";

type Point = PlanXY;
export type OutlineEdge = { a: Point; b: Point; radius?: number };
export type StrokePiece = { edges: OutlineEdge[]; segment: number; at: number; end: number;
  stationAt: (p:Point)=>number };
const EPS=1e-9;
const lerp=(a:Point,b:Point,t:number)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const side=(a:Point,b:Point,p:Point)=>(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);

function clipPolygon(poly:Point[], edges:OutlineEdge[]) {
  for (const {a,b} of edges) {
    const out:Point[]=[];
    for(let j=0; j<poly.length; j++) {
      const p=poly[(j+poly.length-1)%poly.length], q=poly[j];
      const u=side(a,b,p),v=side(a,b,q);
      if ((u>=0)!==(v>=0)) out.push(lerp(p,q,u/(u-v)));
      if(v>=0)out.push(q);
    }
    poly=out;
    if(poly.length<3)break;
  }
  return poly;
}

/** Interior of a convex neighbour as an interval on an oriented boundary edge. */
function covered(edge:OutlineEdge, clip:OutlineEdge[], owner:number, neighbour:number):[number,number]|undefined {
  let lo=0,hi=1;
  for(const {a,b} of clip) {
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
    if(!len)continue;
    const snap=(v:number)=>Math.abs(v)<=EPS ? 0 : v;
    const u=snap(side(a,b,edge.a)/len), v=snap(side(a,b,edge.b)/len);
    if(u < 0 && v < 0)return;
    if(u===0 && v===0) {
      // Same-facing coincident edges: keep just one. Opposite-facing edges
      // inside the union disappear from both of the contributing polygons.
      if(dx*(edge.b.x-edge.a.x)+dy*(edge.b.y-edge.a.y)>0 && owner<neighbour)return;
    } else if(u<0 && v>=0)lo=Math.max(lo,u/(u-v));
    else if(v<0 && u>=0)hi=Math.min(hi,u/(u-v));
    if(hi<=lo)return;
  }
  return [lo,hi];
}

export function visibleStrokeEdges(pieces:StrokePiece[], emit:(e:OutlineEdge)=>void,
  conflict?:{ gap:number; breaks:readonly number[]; add:(lo:number,hi:number)=>void }) {
  const boxes=pieces.map((piece,id)=>{
    const xs=piece.edges.map(e=>e.a.x),ys=piece.edges.map(e=>e.a.y);
    return {piece,id,x0:Math.min(...xs),x1:Math.max(...xs),y0:Math.min(...ys),y1:Math.max(...ys), neighbours:[] as number[]};
  });
  const sorted=boxes.slice().sort((a,b)=>a.x0-b.x0);
  for(let i=0;i<sorted.length;i++) {
    const a=sorted[i];
    for(let j=i+1;j<sorted.length && sorted[j].x0<=a.x1+EPS;j++){
      const b=sorted[j];
      if(a.y1<b.y0-EPS || b.y1<a.y0-EPS)continue;
      a.neighbours.push(b.id);b.neighbours.push(a.id);
      if(!conflict)continue;
      let first=a.piece,second=b.piece;
      if(second.at<first.at)[first,second]=[second,first];
      if(second.segment-first.segment<2 || second.end-first.at<=conflict.gap)continue;
      const poly=clipPolygon(first.edges.map(e=>e.a),second.edges);
      if(poly.length<3 || Math.abs(poly.reduce((s,p,k)=>s+side(poly[0],p,poly[(k+1)%poly.length]),0))<1e-12)continue;
      const stations=poly.map(p=>[first.stationAt(p),second.stationAt(p)]);
      for(let k=0;k<stations.length;k++) {
        const a=stations[k], b=stations[(k+1)%stations.length];
        if(a[1]-a[0] > conflict.gap)conflict.add(a[0],a[1]);
        for(const s of conflict.breaks)for(const axis of [0,1]) {
          const t=(s-a[axis])/(b[axis]-a[axis]);
          if(t>0 && t<1) {
            const lo=a[0]+t*(b[0]-a[0]),hi=a[1]+t*(b[1]-a[1]);
            if(hi-lo>conflict.gap)conflict.add(lo,hi);
          }
        }
      }
    }
  }
  for(const {piece,id,neighbours} of boxes) for(const edge of piece.edges) {
    const x0=Math.min(edge.a.x,edge.b.x), x1=Math.max(edge.a.x,edge.b.x);
    const y0=Math.min(edge.a.y,edge.b.y), y1=Math.max(edge.a.y,edge.b.y);
    const intervals:[number,number][]=[];
    for(const j of neighbours) {
      const clip=boxes[j];
      if(x1<clip.x0-EPS || clip.x1<x0-EPS || y1<clip.y0-EPS || clip.y1<y0-EPS)continue;
      const range=covered(edge,clip.piece.edges,id,j);
      if(range)intervals.push(range);
    }
    intervals.sort((u,v)=>u[0]-v[0]);
    let end=0;
    function part(t:number,u:number) {
      const a=t===0?edge.a:lerp(edge.a,edge.b,t), b=u===1?edge.b:lerp(edge.a,edge.b,u);
      if(Math.hypot(b.x-a.x,b.y-a.y)>EPS)emit({a,b,radius:edge.radius});
    }
    for(const [a,b] of intervals) {
      if(a>end)part(end,a);
      end=Math.max(end,b);
    }
    if(end<1)part(end,1);
  }
}
