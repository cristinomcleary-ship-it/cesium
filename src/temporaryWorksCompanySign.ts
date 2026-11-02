import type { DisplayBatch, FacilityKind, FacilitySurface, XY, XYZ } from './temporaryWorksArchitecture';
import { title, titleHeight, titlePoints, titleTriangles, titleWidth } from './temporaryWorksCompanyArtwork';

export const COMPANY_NAME = title;

type Foot = {x:number; y:number; z:number};
type Wall = {a:XY; dx:number; dy:number; length:number};
type Span = {start:number; end:number; floor:number};

/** Join collinear CAD segments so extra CAD vertices do not arbitrarily shorten a fascia. */
function facadeWalls(source:XY[]): Wall[] {
  const outline = source.filter((p,i) => {
    const q = source[(i+1)%source.length];
    return Math.hypot(p[0]-q[0],p[1]-q[1]) > 1e-6;
  });
  if (outline.length < 3) return [];
  const clean = outline.filter((p,i) => {
    const a=outline[(i+outline.length-1)%outline.length], b=outline[(i+1)%outline.length];
    const ax=p[0]-a[0], ay=p[1]-a[1], bx=b[0]-p[0], by=b[1]-p[1];
    return ax*bx+ay*by <= 0 || Math.abs(ax*by-ay*bx) > 1e-7*Math.hypot(ax,ay)*Math.hypot(bx,by);
  });
  // Counterclockwise traversal makes the tangent point to the reader's right on every outside face.
  const area = clean.reduce((sum,a,i) => {
    const b=clean[(i+1)%clean.length], o=clean[0];
    return sum+(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  },0);
  if (area<0) clean.reverse();
  return clean.map((a,i) => {
    const b=clean[(i+1)%clean.length], dx=b[0]-a[0], dy=b[1]-a[1], length=Math.hypot(dx,dy);
    return {a,dx:dx/length,dy:dy/length,length};
  }).sort((a,b)=>b.length-a.length || b.dx-a.dx || b.dy-a.dy);
}

function measuredSpans(w:Wall, boundary:readonly (readonly [Foot,Foot])[]) {
  const tolerance=.0002, spans:Span[]=[];
  for (const [a,b] of boundary) {
    const ax=a.x-w.a[0], ay=a.y-w.a[1], bx=b.x-w.a[0], by=b.y-w.a[1];
    if (Math.abs(ax*w.dy-ay*w.dx)>tolerance || Math.abs(bx*w.dy-by*w.dx)>tolerance) continue;
    const s=ax*w.dx+ay*w.dy, t=bx*w.dx+by*w.dy;
    const start=Math.max(0,Math.min(s,t)), end=Math.min(w.length,Math.max(s,t));
    if (end-start>tolerance) spans.push({start,end,floor:Math.max(a.z,b.z)});
  }
  spans.sort((a,b)=>a.start-b.start);
  const merged:Span[]=[];
  for (const span of spans) {
    const prev=merged.at(-1);
    if (prev && span.start<=prev.end+tolerance) {
      prev.end=Math.max(prev.end,span.end); prev.floor=Math.max(prev.floor,span.floor);
    } else merged.push(span);
  }
  return merged;
}

/** Emit the finished inscription as opaque, indexed geometry, readable offline in both renderers. */
export function companySignGeometry(kind:FacilityKind, surface:FacilitySurface, exterior:Iterable<readonly [number,number]>,
  roofAt:(x:number,y:number)=>number):DisplayBatch[] {
  const boundary=Array.from(exterior,([a,b])=>[surface.vertices[a],surface.vertices[b]] as const);
  let chosen:{wall:Wall; span:Span; length:number} | undefined;
  for (const wall of facadeWalls(surface.outline)) {
    if (chosen && wall.length<chosen.length-.0002) break;
    for (const span of measuredSpans(wall,boundary)) {
      const length=span.end-span.start;
      if (length<3 || (chosen && length<chosen.length-.0002)) continue;
      // On otherwise equivalent walls, prefer the southern/eastern exterior for the normal site view.
      if (chosen && Math.abs(length-chosen.length)<.0002 &&
          (wall.dx<chosen.wall.dx-1e-7 || (Math.abs(wall.dx-chosen.wall.dx)<1e-7 && wall.dy<=chosen.wall.dy))) continue;
      const endRoof=Math.min(...[span.start,span.end].map(t=>roofAt(wall.a[0]+wall.dx*t,wall.a[1]+wall.dy*t)));
      if (endRoof-span.floor>=1.6) chosen={wall,span,length};
    }
  }
  if (!chosen) return [];
  const {wall,span,length}=chosen, mid=(span.start+span.end)/2;
  const cx=wall.a[0]+wall.dx*mid, cy=wall.a[1]+wall.dy*mid;
  const w=Math.min(kind==='steel'?48:28,length*(kind==='steel'?.91:.63));
  const eave=Math.min(...[-w/2,w/2].map(s=>roofAt(cx+wall.dx*s,cy+wall.dy*s)));
  const h=Math.min(w/12.4,kind==='steel'?2.22:1.24,(eave-span.floor)*(kind==='steel'?.39:.27));
  // The office plaque rests on a short sign rail at the eave, clear of the top window row.
  const top = kind==='camp' ? eave+h-.03 : eave-.13;
  if (h<.15) return [];

  const batch=(finish:DisplayBatch['finish']):DisplayBatch=>({finish,positions:[],uv:[],indices:[]});
  const face=batch('signFace'), letters=batch('signLetter'), edge=batch('signEdge');
  // z is up, world normal (dy,-dx) faces outside. The lettering occupies its own plane above the front skin.
  function add(b:DisplayBatch,x:number,z:number,normal:number) {
    b.positions.push(cx+wall.dx*x+wall.dy*normal, cy+wall.dy*x-wall.dx*normal, z);
    b.uv.push(x,z);
  }
  function quad(b:DisplayBatch,vertices:XYZ[]) {
    const base=b.positions.length/3;
    for (const [x,z,n] of vertices) add(b,x,z,n);
    b.indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  const bottom=top-h, rim=Math.min(.045,h*.035);
  const corners:XY[]=[[-w/2,bottom],[w/2,bottom],[w/2,top],[-w/2,top]];
  if (kind==='camp') {
    for (const x of [-w*.36,0,w*.36]) {
      const legWidth=Math.min(.10,h*.12);
      // Uprights lap onto the fascia and end behind the solid sign face.
      quad(edge,[[x-legWidth,eave-.20,.025],[x+legWidth,eave-.20,.025],
        [x+legWidth,bottom+h*.55,.025],[x-legWidth,bottom+h*.55,.025]]);
    }
  }
  quad(edge,corners.map(([x,z])=>[x,z,.076]));
  for (let i=0;i<4;i++) {
    const [a,b]=corners[i], [c,d]=corners[(i+1)%4];
    quad(edge,[[a,b,.012],[c,d,.012],[c,d,.076],[a,b,.076]]);
  }
  quad(face,[[-w/2+rim,bottom+rim,.081],[w/2-rim,bottom+rim,.081],
    [w/2-rim,top-rim,.081],[-w/2+rim,top-rim,.081]]);
  const scale=Math.min((w-2*rim)*.92/titleWidth,(h-2*rim)*.84/titleHeight);
  for (let i=0;i<titlePoints.length;i+=2)
    add(letters,(titlePoints[i]-titleWidth/2)*scale,(bottom+top)/2+(titlePoints[i+1]-titleHeight/2)*scale,.096);
  letters.indices=Array.from(titleTriangles);
  return [edge,face,letters];
}
