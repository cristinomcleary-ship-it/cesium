import { flagPlatformGeometry, type CourtyardBatch } from './temporaryWorksCourtyard';
import type { XY } from './temporaryWorksArchitecture';

type Vertex = {x:number; y:number; z:number};
type Bounds = {left:number; right:number; bottom:number; top:number};
type Site = Bounds & {rotated:boolean};
const bay = 2.6, depth = 5.2, aisle = 5, clearance = .35;
const bounds = (xy:readonly XY[]):Bounds => xy.reduce((b,[x,y])=>({
  left:Math.min(b.left,x),right:Math.max(b.right,x),bottom:Math.min(b.bottom,y),top:Math.max(b.top,y),
}),{left:Infinity,right:-Infinity,bottom:Infinity,top:-Infinity});
const overlap = (a:Bounds,b:Bounds) => a.left<=b.right && b.left<=a.right && a.bottom<=b.top && b.bottom<=a.top;

function cutsBox(a:XY,b:XY,box:Bounds) {
  let lo=0,hi=1;
  for (const [p,d,min,max] of [[a[0],b[0]-a[0],box.left,box.right],[a[1],b[1]-a[1],box.bottom,box.top]]) {
    if (!d) {if (p<min || p>max) return false;continue;}
    const l=(min-p)/d,r=(max-p)/d;
    lo=Math.max(lo,Math.min(l,r));hi=Math.min(hi,Math.max(l,r));
    if (lo>hi) return false;
  }
  return true;
}
function insidePolygon(x:number,y:number,ring:readonly XY[]) {
  let inside=false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[i],b=ring[j];
    if ((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}

// Candidate points need only one indexed triangle for a height. The rectangle,
// including the reserved parking aisle, must also contain zero external edges.
export function yardSurface(vertices:readonly Vertex[],triangles:readonly (readonly number[])[],buildings:readonly (readonly XY[])[], siteBoundary?:readonly XY[]) {
  const xy=vertices.map(v=>[v.x,v.y] as XY), extent=bounds(xy);
  const cell=Math.max(4,(extent.right-extent.left)/60,(extent.top-extent.bottom)/60);
  const buckets=new Map<string,number[]>(), boundary=new Map<string,[number,number]>();
  const physical=new Map<string,number>(), ids=xy.map(([x,y],i)=>{
    const key=Math.round(x*1e6)+','+Math.round(y*1e6),prior=physical.get(key);
    if (prior!==undefined) return prior;
    physical.set(key,i);return i;
  });
  for (const [ti,t] of triangles.entries()) {
    const b=bounds(t.map(i=>xy[i]));
    // Include touching cells so roundoff in a rotated query at a bin edge does not lose a valid face.
    const eps=1e-7;
    for(let x=Math.floor((b.left-eps)/cell);x<=Math.floor((b.right+eps)/cell);x++)
      for(let y=Math.floor((b.bottom-eps)/cell);y<=Math.floor((b.top+eps)/cell);y++) {
        const k=x+','+y;
        let a=buckets.get(k);if(!a){a=[];buckets.set(k,a);}a.push(ti);
      }
    for(let j=0;j<3;j++){
      const a=ids[t[j]],b=ids[t[(j+1)%3]],k=Math.min(a,b)+','+Math.max(a,b);
      if(a!==b && !boundary.delete(k))boundary.set(k,[a,b]);
    }
  }
  const edges=[...boundary.values()].map(([a,b])=>[xy[a],xy[b]] as [XY,XY]);
  for(const ring of buildings)for(let i=0;i<ring.length;i++)edges.push([ring[i],ring[(i+1)%ring.length]]);
  if (siteBoundary) for (let i=0;i<siteBoundary.length;i++) edges.push([siteBoundary[i],siteBoundary[(i+1)%siteBoundary.length]]);
  const obstacles=edges.map(([a,b])=>({a,b,box:bounds([a,b])}));
  const footprints=buildings.map(ring=>({ring,box:bounds(ring)}));
  function altitude(x:number,y:number) {
    for (const ti of buckets.get(Math.floor(x/cell)+','+Math.floor(y/cell))??[]) {
      const t=triangles[ti], a=vertices[t[0]], b=vertices[t[1]], c=vertices[t[2]];
      const bx=b.x-a.x,by=b.y-a.y,cx=c.x-a.x,cy=c.y-a.y,px=x-a.x,py=y-a.y;
      const det=bx*cy-by*cx; if(Math.abs(det)<1e-12)continue;
      const u=(px*cy-py*cx)/det,v=(bx*py-by*px)/det;
      if(u>=-1e-8 && v>=-1e-8 && u+v<=1+1e-8)return a.z+u*(b.z-a.z)+v*(c.z-a.z);
    }
    return undefined;
  }
  const fits = (s:Site) => {
    const x=(s.left+s.right)/2,y=(s.bottom+s.top)/2;
    if (siteBoundary && !insidePolygon(x,y,siteBoundary))return false;
    if (footprints.some(f=>overlap(s,f.box)&&insidePolygon(x,y,f.ring)))return false;
    if (altitude(x,y)===undefined)return false;
    return !obstacles.some(e=>overlap(s,e.box)&&cutsBox(e.a,e.b,s));
  };
  return {extent,altitude,fits};
}

function candidates(width:number,height:number,e:Bounds,rotated=false) {
  const w=(rotated?height:width)+2*clearance,h=(rotated?width:height)+2*clearance;
  // The sampling grid proposes placements only. Acceptance uses the exact boundaries.
  const dx=e.right-e.left-w-.04,dy=e.top-e.bottom-h-.04;
  if (dx<0 || dy<0) return [];
  const nx=Math.max(1,Math.min(28,Math.ceil(dx))),ny=Math.max(1,Math.min(28,Math.ceil(dy)));
  const result:Site[]=[];
  for(let j=0;j<=ny;j++) for(let i=0;i<=nx;i++){
    const left=e.left+.02+i*dx/nx,bottom=e.bottom+.02+j*dy/ny;
    result.push({left,right:left+w,bottom,top:bottom+h,rotated});
  }
  return result;
}

export type CampYard = {flag:boolean;spaces:number; batches:CourtyardBatch[]};
/** Display-only plan in local horizontal metres; no work quantities are modified. */
export function buildCampYard(input:readonly Vertex[],triangles:readonly (readonly number[])[],outlines:readonly (readonly XY[])[]):CampYard {
  const absent:CampYard={flag:false,spaces:0,batches:[]};
  if (!triangles.length) return absent;

  // Align to the longest architectural facade. Without buildings, use the
  // longest boundary direction so rotated yards also admit usable parking.
  let ux=1,uy=0,longest=0;
  const consider=(ax:number,ay:number,bx:number,by:number)=>{
    const dx=bx-ax,dy=by-ay,l=Math.hypot(dx,dy);
    if(l>longest+1e-6){longest=l;ux=dx/l;uy=dy/l;}
  };
  for(const ring of outlines)for(let i=0;i<ring.length;i++)consider(...ring[i],...ring[(i+1)%ring.length]);
  if(!longest) {
    const perimeter = new Map<string,[number,number]>();
    for(const t of triangles)for(let j=0;j<3;j++){
      const a=t[j],b=t[(j+1)%3],k=Math.min(a,b)+','+Math.max(a,b);
      if(!perimeter.delete(k))perimeter.set(k,[a,b]);
    }
    for(const [a,b] of perimeter.values())consider(input[a].x,input[a].y,input[b].x,input[b].y);
  }
  if(ux<0 || (Math.abs(ux)<1e-8 && uy<0)){ux=-ux;uy=-uy;}
  const rotate=(x:number,y:number):XY=>[x*ux+y*uy,-x*uy+y*ux];
  const projected=input.map(p=>{const [x,y]=rotate(p.x,p.y);return {x,y,z:p.z};});
  const ground=yardSurface(projected,triangles,outlines.map(r=>r.map(p=>rotate(...p))));
  const {extent,fits,altitude}=ground;
  const flagShape=flagPlatformGeometry();
  const flagXY:XY[]=[];
  for(const part of flagShape)for(let i=0;i<part.positions.length;i+=3)flagXY.push([part.positions[i],part.positions[i+1]]);
  const fb=bounds(flagXY);
  const flags=candidates(fb.right-fb.left,fb.top-fb.bottom,extent).filter(fits);
  const cx=(extent.left+extent.right)/2,cy=(extent.bottom+extent.top)/2;
  const central=(s:Site)=>Math.hypot((s.left+s.right)/2-cx,(s.top+s.bottom)/2-cy);
  flags.sort((a,b)=>central(a)-central(b));
  let flagSite:Site|undefined=flags[0], parking:Site|undefined, spaces=0;
  // Prefer keeping both the flag and parking when the clear space is limited.
  for(let count=5;count>=1;count--) {
    const sites=[...candidates(count*bay,depth+aisle,extent),...candidates(count*bay,depth+aisle,extent,true)];
    for(const p of sites){
      if(!fits(p))continue;
      const f=flags.find(s=>!overlap(s,p));
      if(!parking){parking=p;spaces=count;}
      if(f || !flags.length){flagSite=f;parking=p;spaces=count;break;}
    }
    if (parking && (!flagSite || !overlap(parking,flagSite)))break;
  }
  if (flagSite && parking && overlap(flagSite,parking)) { parking=undefined;spaces=0; }

  const output=new Map<string,CourtyardBatch>();
  function batch(color:string){
    let b=output.get(color);if(!b){b={color,positions:[],indices:[]};output.set(color,b);}return b;
  }
  function point(b:CourtyardBatch,x:number,y:number,z:number) {b.positions.push(x*ux-y*uy,x*uy+y*ux,z);}
  if(flagSite){
    const fx=flagSite.left+clearance-fb.left,fy=flagSite.bottom+clearance-fb.bottom;
    // Keep the upper plinth level while the bottom meets the measured grade.
    const top=Math.max(...[fb.left,fb.right].flatMap(x=>[fb.bottom,fb.top].map(y=>altitude(fx+x,fy+y)!)));
    for(const part of flagShape){
      const target=batch(part.color),offset=target.positions.length/3;
      for(let i=0;i<part.positions.length;i+=3){
        const x=fx+part.positions[i],y=fy+part.positions[i+1],z=part.positions[i+2];
        point(target,x,y,z<=.001?altitude(x,y)!:top+z);
      }
      for(const index of part.indices)target.indices.push(offset+index);
    }
  }
  if(parking) {
    const p=parking;
    const paint=batch('#f2eed5'),stops=batch('#687278');
    function stripe(b:CourtyardBatch,x0:number,y0:number,x1:number,y1:number,z:number){
      const start=b.positions.length/3;
      for(const [x,y] of [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]){
        // The aisle occupies the remainder of the verified clear rectangle.
        const px=p.left+clearance+(p.rotated?y:x),py=p.bottom+clearance+(p.rotated?x:y);
        point(b,px,py,altitude(px,py)!+z);
      }
      b.indices.push(start,start+1,start+2,start,start+2,start+3);
      return start;
    }
    stripe(paint,0,0,spaces*bay,.10,.035);
    for(let i=0;i<=spaces;i++)stripe(paint,Math.max(0,i*bay-.05),0,Math.min(spaces*bay,i*bay+.05),depth,.035);
    for(let i=0;i<spaces;i++) {
      const x=i*bay+.45,r=(i+1)*bay-.45;
      const bottom=stripe(stops,x,.65,r,.88,.006);
      const top=stripe(stops,x+.04,.69,r-.04,.84,.105);
      for(let j=0;j<4;j++){
        const k=(j+1)%4;
        stops.indices.push(bottom+j,bottom+k,top+k,bottom+j,top+k,top+j);
      }
    }
  }
  return {flag:!!flagSite,spaces,batches:[...output.values()]};
}
