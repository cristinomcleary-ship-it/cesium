import {cleanPlanningBoundary, type PlanXY} from './temporaryWorksGeometry';

const EPS = 1e-6;
const cross = (ax:number,ay:number,bx:number,by:number) => ax*by-ay*bx;
function onSegment(p:PlanXY,a:PlanXY,b:PlanXY) {
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
  return Math.abs(cross(p.x-a.x,p.y-a.y,dx,dy)) <= EPS*Math.max(1,length)
    && p.x>=Math.min(a.x,b.x)-EPS && p.x<=Math.max(a.x,b.x)+EPS && p.y>=Math.min(a.y,b.y)-EPS && p.y<=Math.max(a.y,b.y)+EPS;
}
function inside(p:PlanXY,ring:readonly PlanXY[]) {
  let result=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[j],b=ring[i];
    if(onSegment(p,a,b)) return true;
    if((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) result=!result;
  }
  return result;
}

/** Tests complete footprint edges, including concave recesses between vertices. Units are local metres. */
export function glbFootprintsInsideSite(footprints:readonly (readonly PlanXY[])[],site:readonly PlanXY[]) {
  const boundary=cleanPlanningBoundary(site);
  for(const footprint of footprints) {
    if(footprint.length<3 || footprint.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))) return false;
    for(let i=0;i<footprint.length;i++) {
      const a=footprint[i],b=footprint[(i+1)%footprint.length],dx=b.x-a.x,dy=b.y-a.y;
      if(!inside(a,boundary)) return false;
      const cuts=[0,1];
      for(let j=0;j<boundary.length;j++) {
        const c=boundary[j],d=boundary[(j+1)%boundary.length],ex=d.x-c.x,ey=d.y-c.y;
        const den=cross(dx,dy,ex,ey);
        if(Math.abs(den)<1e-12) continue;
        const t=cross(c.x-a.x,c.y-a.y,ex,ey)/den,u=cross(c.x-a.x,c.y-a.y,dx,dy)/den;
        if(t>0 && t<1 && u>=-EPS && u<=1+EPS) cuts.push(t);
      }
      cuts.sort((x,y)=>x-y);
      for(let j=1;j<cuts.length;j++) {
        const t=(cuts[j-1]+cuts[j])/2;
        if(!inside({x:a.x+t*dx,y:a.y+t*dy},boundary)) return false;
      }
    }
  }
  return footprints.length>0;
}
