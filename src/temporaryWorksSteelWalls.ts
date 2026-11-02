import type { FacilitySurface, Finish, XY, XYZ } from './temporaryWorksArchitecture';

type Edge = { a: XY; b: XY; dx: number; dy: number; length: number };
type GroundPoint = FacilitySurface['vertices'][number];

const tolerance = .0002; // metres; footprint clipping and conversion roundoff

function facadeEdges(outline: XY[]): Edge[] {
  const ring = outline.filter((p,i) => {
    const q = outline[(i + outline.length - 1) % outline.length];
    return Math.hypot(q[0]-p[0], q[1]-p[1]) > tolerance;
  });
  // A CAD polyline often subdivides a perfectly straight wall. Treat it as one
  // facade so panel seams, windows and a gate continue across its vertices.
  const corners = ring.filter((p,i) => {
    const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i+1) % ring.length];
    const ax = p[0]-a[0], ay = p[1]-a[1], bx = b[0]-p[0], by = b[1]-p[1];
    return ax*bx+ay*by <= 0 || Math.abs(ax*by-ay*bx) > 1e-9*Math.hypot(ax,ay)*Math.hypot(bx,by);
  });
  return corners.map((a,i) => {
    const b = corners[(i+1)%corners.length], length = Math.hypot(b[0]-a[0], b[1]-a[1]);
    return {a,b,length,dx:(b[0]-a[0])/length,dy:(b[1]-a[1])/length};
  });
}

function distanceOnWall(e: Edge, p: GroundPoint) {
  return (p.x-e.a[0])*e.dx+(p.y-e.a[1])*e.dy;
}

function belongsToWall(e: Edge, p: GroundPoint) {
  const s = distanceOnWall(e,p);
  return s >= -tolerance && s <= e.length+tolerance &&
    Math.abs((p.y-e.a[1])*e.dx - (p.x-e.a[0])*e.dy) <= tolerance;
}

/** Emit opaque cladding only where the retained roof meets an original CAD
 * wall. A hole in the survey exposes a cut, never an invented exterior facade. */
export function steelWorkshopWalls(
  input: FacilitySurface, perimeter: Iterable<[number,number]>, axis: {ux:number;uy:number},
  across: (x:number,y:number)=>number, ridge: number, eave: (v:number)=>number, skin: number,
  polygon:(finish:Finish, face:XYZ[])=>void,
) {
  const facades = facadeEdges(input.outline);
  let gate: Edge | undefined;
  let gableWidth = 0;
  for (const facade of facades) {
    const transverse = Math.abs(axis.ux*facade.dy-axis.uy*facade.dx);
    const score = transverse*facade.length;
    if (transverse > .65 && score > gableWidth && facade.length >= 4 && input.height >= 3) {
      gate = facade; gableWidth = score;
    }
  }
  for (const [ai,bi] of perimeter) {
    const a=input.vertices[ai], b=input.vertices[bi];
    const va=across(a.x,a.y), vb=across(b.x,b.y);
    const wall=facades.find(e=>belongsToWall(e,a) && belongsToWall(e,b));
    const line=(t:number,f:number):XYZ=>{
      const floor=a.z+(b.z-a.z)*t;
      const head=eave(va+(vb-va)*t)-skin;
      return [a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,floor+(head-floor)*f];
    };
    const cuts=[0,1];
    if ((va-ridge)*(vb-ridge)<0) cuts.push((ridge-va)/(vb-va));
    const s0=wall?distanceOnWall(wall,a):0, s1=wall?distanceOnWall(wall,b):0;
    function cutAt(s:number) {
      const t=(s-s0)/(s1-s0);
      if(t>1e-9 && t<1-1e-9)cuts.push(t);
    }
    const bay=wall?wall.length/Math.max(1,Math.min(100,Math.round(wall.length/3.6))):1;
    // A panel joint and a framed, opaque glazing band repeat at measured bays.
    const windows=!!wall && input.height>=2.6 && bay>=1.8;
    if(wall && Math.abs(s1-s0)>tolerance) {
      const marks=windows?[0,.018,.13,.15,.49,.51,.85,.87]:[0,.018];
      for(let i=Math.floor(Math.min(s0,s1)/bay);i<=Math.floor(Math.max(s0,s1)/bay);i++)
        for(const f of marks)cutAt((i+f)*bay);
      if(wall===gate) {
        const half=Math.min(3.25,wall.length*.30);
        for(const d of [-half-.10,-half,half,half+.10])cutAt(wall.length/2+d);
      }
    }
    cuts.sort((s,t)=>s-t);
    for(let i=1;i<cuts.length;i++) {
      const l=cuts[i-1],r=cuts[i];
      if(r-l<1e-9)continue;
      const topL=line(l,1), topR=line(r,1);
      polygon('trim',[topL,topR,[topR[0],topR[1],topR[2]+skin],[topL[0],topL[1],topL[2]+skin]]);
      if(!wall)continue;
      const s=s0+(s1-s0)*(l+r)/2, module=s/bay-Math.floor(s/bay);
      function panel(finish:Finish,low:number,high:number) {
        polygon(finish,[line(l,low),line(r,low),line(r,high),line(l,high)]);
      }
      const doorHalf=Math.min(3.25,wall.length*.30), fromDoor=Math.abs(s-wall.length/2);
      const inDoor=wall===gate && fromDoor<doorHalf, jamb=wall===gate && fromDoor<doorHalf+.10;
      const sheet:Finish=module<.018?'panelRib':'cladding';
      if(inDoor) {
        // Adjoining faces form the closed leaf; no transparent aperture or overlapping decals.
        const rows=Math.max(4,Math.min(24,Math.round(input.height*.68/.26)));
        for(let j=0;j<rows;j++){
          const f=j*.68/rows, next=(j+1)*.68/rows, lip=next-.13*(next-f);
          panel('shutter',f,lip);panel('panelRib',lip,next);
        }
      } else if(jamb) {
        panel('frame',0,.68);
      } else {
        panel('skirting',0,.105);panel('steelBand',.105,.125);panel(sheet,.125,.37);
        if(windows && module>=.13 && module<.87) {
          panel('trim',.37,.39);
          panel(module<.15 || module>=.85 || (module>=.49 && module<.51)?'trim':'glass',.39,.53);
          panel('trim',.53,.55);
        } else panel(sheet,.37,.55);
        panel(sheet,.55,.68);
      }
      panel(jamb?'frame':sheet,.68,.705);
      panel(sheet,.705,.955);
      panel('steelBand',.955,1);
    }
  }
}
